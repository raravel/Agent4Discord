// Session lifecycle -- AGE-016
import { EventEmitter } from 'node:events';
import {
  query,
  type CanUseTool,
  type Query,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { resolvePlugins } from '../utils/plugins.js';

export type SessionState = 'idle' | 'running' | 'stopped' | 'archived';

export interface ActiveSession {
  query: Query;
  channelId: string;
  guildId: string;
  userId: string;
  sessionId: string;
  cwd: string;
  state: SessionState;
  totalCostUsd: number;
  createdAt: string;
  resolveNext: ((msg: SDKUserMessage) => void) | null;
  abortController: AbortController;
}

class SessionManager extends EventEmitter {
  private sessions = new Map<string, ActiveSession>();

  createSession(
    guildId: string,
    userId: string,
    channelId: string,
    cwd: string,
    model?: string,
    canUseTool?: CanUseTool,
  ): ActiveSession {
    const controller = new AbortController();

    let resolveNext: ((msg: SDKUserMessage) => void) | null = null;

    async function* messageStream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const msg = await new Promise<SDKUserMessage>((resolve) => {
          resolveNext = resolve;
        });
        yield msg;
      }
    }

    const plugins = resolvePlugins();

    const q = query({
      prompt: messageStream(),
      options: {
        cwd,
        model: model || 'opus',
        permissionMode: 'default',
        includePartialMessages: true,
        abortController: controller,
        canUseTool,
        plugins,
      },
    });

    const session: ActiveSession = {
      query: q,
      channelId,
      guildId,
      userId,
      sessionId: '',
      cwd,
      state: 'running',
      totalCostUsd: 0,
      createdAt: new Date().toISOString(),
      resolveNext: null,
      abortController: controller,
    };

    // Wire up resolveNext -- the generator captures the outer variable,
    // but ActiveSession needs its own reference so sendMessage can call it.
    // Because the generator closure mutates the local `resolveNext`, we
    // need a proxy that always reads the latest value.
    Object.defineProperty(session, 'resolveNext', {
      get: () => resolveNext,
      set: (v: ((msg: SDKUserMessage) => void) | null) => {
        resolveNext = v;
      },
      enumerable: true,
      configurable: true,
    });

    this.sessions.set(channelId, session);
    void this._processEvents(session);
    return session;
  }

  resumeSession(
    guildId: string,
    userId: string,
    channelId: string,
    sessionId: string,
    cwd: string,
    model?: string,
    canUseTool?: CanUseTool,
  ): ActiveSession {
    const controller = new AbortController();

    let resolveNext: ((msg: SDKUserMessage) => void) | null = null;

    async function* messageStream(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const msg = await new Promise<SDKUserMessage>((resolve) => {
          resolveNext = resolve;
        });
        yield msg;
      }
    }

    const plugins = resolvePlugins();

    const q = query({
      prompt: messageStream(),
      options: {
        cwd,
        model: model || 'opus',
        permissionMode: 'default',
        includePartialMessages: true,
        abortController: controller,
        resume: sessionId,
        canUseTool,
        plugins,
      },
    });

    const session: ActiveSession = {
      query: q,
      channelId,
      guildId,
      userId,
      sessionId,
      cwd,
      state: 'running',
      totalCostUsd: 0,
      createdAt: new Date().toISOString(),
      resolveNext: null,
      abortController: controller,
    };

    Object.defineProperty(session, 'resolveNext', {
      get: () => resolveNext,
      set: (v: ((msg: SDKUserMessage) => void) | null) => {
        resolveNext = v;
      },
      enumerable: true,
      configurable: true,
    });

    this.sessions.set(channelId, session);
    void this._processEvents(session);
    return session;
  }

  sendMessage(channelId: string, content: string): void {
    const session = this.sessions.get(channelId);
    if (!session) {
      throw new Error(`No session found for channel ${channelId}`);
    }
    if (session.state === 'stopped' || session.state === 'archived') {
      throw new Error(`Session for channel ${channelId} is ${session.state}`);
    }
    session.state = 'running';
    if (session.resolveNext) {
      session.resolveNext({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    }
  }

  getSession(channelId: string): ActiveSession | null {
    return this.sessions.get(channelId) ?? null;
  }

  stopSession(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.query.close();
    session.state = 'stopped';
  }

  removeSession(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    if (session.state !== 'stopped' && session.state !== 'archived') {
      this.stopSession(channelId);
    }
    this.sessions.delete(channelId);
  }

  getAllSessions(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  private async _processEvents(session: ActiveSession): Promise<void> {
    try {
      for await (const msg of session.query) {
        // Log all non-stream messages for debugging
        if (msg.type !== 'stream_event' && msg.type !== 'tool_progress') {
          console.log(`[sdk:${msg.type}]`, JSON.stringify(msg, null, 2).slice(0, 500));
        }

        switch (msg.type) {
          case 'system': {
            const sysMsg = msg as SDKSystemMessage;
            if (sysMsg.subtype === 'init' && sysMsg.session_id) {
              session.sessionId = sysMsg.session_id;
            }
            session.state = 'idle';
            break;
          }
          case 'assistant': {
            this.emit('assistant', session.channelId, msg as SDKAssistantMessage);
            break;
          }
          case 'result': {
            const resultMsg = msg as SDKResultMessage;
            console.log(`[sdk:result] subtype=${resultMsg.subtype}, cost=$${resultMsg.total_cost_usd}`);
            session.totalCostUsd = resultMsg.total_cost_usd ?? session.totalCostUsd;
            session.state = 'idle';
            this.emit('result', session.channelId, resultMsg);
            break;
          }
          case 'stream_event':
            this.emit('stream_event', session.channelId, msg);
            break;
          case 'tool_progress':
            this.emit('tool_progress', session.channelId, msg);
            break;
          default: {
            // Handle rate_limit_event
            const anyMsg = msg as any;
            if (anyMsg.type === 'rate_limit_event' && anyMsg.rate_limit_info) {
              console.log('[sdk:rate_limit]', JSON.stringify(anyMsg.rate_limit_info));
              this.emit('rate_limit', session.guildId, anyMsg.rate_limit_info);
            }
            break;
          }
        }
      }
    } catch (err) {
      console.error(
        `[session] Event processing error for channel ${session.channelId}:`,
        err,
      );
      session.state = 'stopped';
      this.emit('error', session.channelId, err);
    }
  }
}

export const sessionManager = new SessionManager();
