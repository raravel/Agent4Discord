import type { Client, TextChannel, ThreadChannel } from 'discord.js';
import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from './sessionManager.js';
import { chunkMessage } from '../formatters/chunker.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';
import { StreamHandler } from './streamHandler.js';
import { ToolProgressHandler } from './toolProgress.js';
import { formatThreadName, formatToolInput, formatToolResult, sendToThread } from '../formatters/toolFormatter.js';

// Track typing indicator intervals per channel
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

export function startTyping(channel: TextChannel): void {
  const id = channel.id;
  if (typingIntervals.has(id)) return;
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 9000);
  typingIntervals.set(id, interval);
}

export function stopTyping(channelId: string): void {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
}

// Track active stream handlers per channel (keyed by "channelId:text" or "channelId:thinking")
const activeStreams = new Map<string, StreamHandler>();

// Track active tool progress handlers per channel
const activeToolProgress = new Map<string, ToolProgressHandler>();

// Channels where StreamHandler.finalize() just sent the final text,
// so the 'assistant' handler should skip re-sending it.
const recentlyFinalized = new Set<string>();

// Track tool-call threads per channel for the current turn
const turnThreads = new Map<string, string[]>();

// Map tool_use_id → { thread, toolName } so we can send results back
const toolUseThreads = new Map<string, { thread: ThreadChannel; toolName: string }>();

// Pending tool results that arrived before their thread was created (async race)
interface PendingResult { block: any; resolve: () => void }
const pendingResults = new Map<string, PendingResult[]>();

/** Register a thread and flush any pending results that were waiting for it. */
async function registerToolThread(
  toolUseId: string,
  thread: ThreadChannel,
  toolName: string,
): Promise<void> {
  toolUseThreads.set(toolUseId, { thread, toolName });

  const pending = pendingResults.get(toolUseId);
  if (pending) {
    pendingResults.delete(toolUseId);
    for (const p of pending) {
      await sendToolResult(toolUseId, p.block);
      p.resolve();
    }
  }
}

/** Send a tool result block to its matching thread. */
async function sendToolResult(toolUseId: string, block: any): Promise<void> {
  const entry = toolUseThreads.get(toolUseId);
  if (!entry) return;

  const { thread, toolName } = entry;

  let resultText = '';
  if (typeof block.content === 'string') {
    resultText = block.content;
  } else if (Array.isArray(block.content)) {
    resultText = block.content
      .filter((b: any) => b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('\n');
  }

  if (!resultText) return;

  const prefix = block.is_error ? '**Error:**\n' : '**Result:**\n';
  const formatted = prefix + formatToolResult(toolName, resultText);

  let attachName: string | undefined;
  if (toolName === 'Bash') {
    attachName = 'output.txt';
  } else if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    attachName = 'result.txt';
  } else if (toolName === 'Agent') {
    attachName = 'agent-output.txt';
  }

  await sendToThread(thread, formatted, attachName);
  toolUseThreads.delete(toolUseId);
}

function trackThread(channelId: string, threadId: string): void {
  const threads = turnThreads.get(channelId) || [];
  threads.push(threadId);
  turnThreads.set(channelId, threads);
}

export function getAndClearTurnThreads(channelId: string): string[] {
  const threads = turnThreads.get(channelId) || [];
  turnThreads.delete(channelId);
  return threads;
}

/**
 * Finalize and clean up all active stream handlers for a given channel.
 */
async function finalizeStreamsForChannel(channelId: string): Promise<boolean> {
  // Collect and remove from map FIRST to prevent re-entrant double-finalize
  const toFinalize: { key: string; handler: StreamHandler }[] = [];
  for (const [key, handler] of activeStreams) {
    if (key.startsWith(channelId + ':')) {
      toFinalize.push({ key, handler });
    }
  }
  for (const { key } of toFinalize) {
    activeStreams.delete(key);
  }

  let hadTextStream = false;
  for (const { key, handler } of toFinalize) {
    if (key.endsWith(':text')) hadTextStream = true;
    await handler.finalize();
  }

  if (hadTextStream) {
    recentlyFinalized.add(channelId);
    setTimeout(() => recentlyFinalized.delete(channelId), 5000);
  }
  return hadTextStream;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}

let handlersRegistered = false;

export function setupEventHandlers(client: Client): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  // --- Stream events (text / thinking deltas) ---
  sessionManager.on('stream_event', async (channelId: string, msg: any) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;

    // msg may wrap the event in different shapes depending on SDK version
    const event = msg.event || msg;

    if (event.type === 'content_block_start') {
      const blockType = event.content_block?.type;
      if (blockType === 'text' || blockType === 'thinking') {
        const handler = new StreamHandler(textChannel, blockType);
        activeStreams.set(`${channelId}:${blockType}`, handler);
      }
    }

    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        const handler = activeStreams.get(`${channelId}:text`);
        handler?.push(event.delta.text);
      }
      if (event.delta?.type === 'thinking_delta') {
        const handler = activeStreams.get(`${channelId}:thinking`);
        handler?.push(event.delta.thinking);
      }
    }

    if (event.type === 'content_block_stop') {
      // Finalize all handlers for this channel whose block just stopped
      await finalizeStreamsForChannel(channelId);
    }
  });

  // --- Tool progress events ---
  sessionManager.on('tool_progress', async (channelId: string, msg: any) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;

    const toolName: string = msg.tool_name || msg.name || 'tool';

    if (!activeToolProgress.has(channelId)) {
      const handler = new ToolProgressHandler(textChannel, toolName);
      activeToolProgress.set(channelId, handler);
    }
    activeToolProgress.get(channelId)!.update();
  });

  // --- Assistant messages ---
  sessionManager.on('assistant', async (channelId: string, msg: SDKAssistantMessage) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;

    if (msg.message?.content) {
      const contentBlocks = msg.message.content as Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, any>;
        [key: string]: any;
      }>;

      // Text blocks are handled by StreamHandler via stream_event.
      // Only send text here as a fallback if NO stream handler was active.
      const hadStream = recentlyFinalized.has(channelId) ||
        activeStreams.has(`${channelId}:text`);

      if (!hadStream) {
        for (const block of contentBlocks) {
          if (block.type === 'text' && block.text) {
            const chunks = chunkMessage(block.text);
            for (const chunk of chunks) {
              await textChannel.send(chunk);
            }
          }
        }
      }

      // Handle tool_use blocks -- create threads for each
      const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');

      if (toolUseBlocks.length > 0) {
        if (toolUseBlocks.length > 1) {
          await textChannel.send(
            `\uD83D\uDD27 Executing ${toolUseBlocks.length} tool calls...`,
          );
        }

        for (const block of toolUseBlocks) {
          const threadName = formatThreadName(block.name || 'unknown', block.input || {});
          const thread = await textChannel.threads.create({
            name: threadName,
            autoArchiveDuration: 60,
            reason: `A4D tool call: ${block.name || 'unknown'}`,
          });

          const toolName = block.name || 'unknown';
          const inputText = formatToolInput(toolName, block.input || {});

          // Determine a good filename for attachment if content is long
          let attachName: string | undefined;
          if (toolName === 'Write' || toolName === 'Edit') {
            const filePath = (block.input as Record<string, any>)?.file_path || '';
            const basename = filePath.split(/[/\\]/).pop() || 'content.txt';
            attachName = basename;
          } else if (toolName === 'Bash') {
            attachName = 'command-output.txt';
          }

          await sendToThread(thread, inputText, attachName);

          // Track tool_use_id → thread and flush any pending results
          const toolUseId = block.id || (block as any).tool_use_id;
          if (toolUseId) {
            await registerToolThread(toolUseId, thread, toolName);
          }

          trackThread(channelId, thread.id);
        }
      }
    }
  });

  // --- User messages (tool results) ---
  sessionManager.on('user', async (_channelId: string, msg: SDKUserMessage) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if ((block as any).type !== 'tool_result') continue;

      const toolUseId = (block as any).tool_use_id;
      if (!toolUseId) continue;

      if (toolUseThreads.has(toolUseId)) {
        // Thread already exists — send immediately
        await sendToolResult(toolUseId, block);
      } else {
        // Thread not created yet (async race) — queue for later
        const pending = pendingResults.get(toolUseId) || [];
        pending.push({ block, resolve: () => {} });
        pendingResults.set(toolUseId, pending);
      }
    }
  });

  // --- Local command output (slash command results) ---
  sessionManager.on('local_command_output', async (channelId: string, content: string) => {
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;

    if (content.length <= 2000) {
      await textChannel.send(content);
    } else {
      const { AttachmentBuilder } = await import('discord.js');
      const preview = content.slice(0, 1500) + `\n\n*... truncated (${content.length.toLocaleString()} chars — full output attached)*`;
      const attachment = new AttachmentBuilder(Buffer.from(content, 'utf-8'), { name: 'command-output.txt' });
      await textChannel.send({ content: preview, files: [attachment] });
    }
  });

  // --- Result events ---
  sessionManager.on('result', async (channelId: string, msg: SDKResultMessage) => {
    stopTyping(channelId);

    // Clean up any lingering stream handlers
    await finalizeStreamsForChannel(channelId);

    // Clean up any lingering tool progress handlers
    const toolHandler = activeToolProgress.get(channelId);
    if (toolHandler) {
      await toolHandler.finalize();
      activeToolProgress.delete(channelId);
    }

    // Remove hourglass, add checkmark on the last user message
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const session = sessionManager.getSession(channelId);
    if (!session) return;

    const textChannel = channel as TextChannel;

    // Update the pinned status embed with new cost and extract model name
    let modelName = 'opus';
    try {
      const pinned = await textChannel.messages.fetchPins();
      const statusMsg = pinned.items.find(
        (p) => p.message.author.id === client.user?.id && p.message.embeds.length > 0,
      )?.message;
      if (statusMsg) {
        const embed = statusMsg.embeds[0];
        modelName = embed?.fields.find((f) => f.name === 'Model')?.value ?? 'opus';
        const updatedEmbed = buildStatusEmbed({
          status: 'Session Active',
          color: COLORS.IDLE,
          cwd: embed?.fields.find((f) => f.name === 'Directory')?.value ?? session.cwd,
          model: modelName,
          sessionId: session.sessionId || 'pending',
          costUsd: session.totalCostUsd,
          startedAt: session.createdAt,
        });
        await statusMsg.edit({ embeds: [updatedEmbed] });
      }
    } catch {
      // Status embed update is best-effort
    }

    // Find the most recent user message to update reactions
    try {
      const messages = await textChannel.messages.fetch({ limit: 20 });
      const userMsg = messages.find(
        (m) => !m.author.bot && m.reactions.cache.has('\u23f3'),
      );
      if (userMsg) {
        await userMsg.reactions.cache.get('\u23f3')?.users.remove(client.user!.id).catch(() => {});
        await userMsg.react('\u2705').catch(() => {});
      }
    } catch {
      // Reaction cleanup is best-effort
    }

    // Mention user with statusline info
    if (session.userId) {
      const resultAny = msg as any;
      const durationMs: number = resultAny.duration_ms ?? 0;
      const costUsd: number = resultAny.total_cost_usd ?? session.totalCostUsd;

      // usage (NonNullableUsage) uses snake_case from BetaUsage;
      // modelUsage (Record<string, ModelUsage>) uses camelCase.
      // Try both conventions to be safe.
      const usage = resultAny.usage ?? {};
      const inputTokens: number = usage.input_tokens ?? usage.inputTokens ?? 0;
      const outputTokens: number = usage.output_tokens ?? usage.outputTokens ?? 0;
      const cacheRead: number = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;

      // Calculate context usage percentage
      const cacheCreate: number = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
      const contextUsed = inputTokens + cacheRead + cacheCreate;

      // Get context window from modelUsage, fall back to model defaults
      let contextWindow = 0;
      const modelUsage: Record<string, any> = resultAny.modelUsage ?? {};
      const modelKeys = Object.keys(modelUsage);
      if (modelKeys.length > 0) {
        contextWindow = modelUsage[modelKeys[0]]?.contextWindow ?? 0;
      }
      if (contextWindow === 0) {
        // Default context windows by model
        const defaults: Record<string, number> = {
          opus: 1_000_000, sonnet: 200_000, haiku: 200_000,
        };
        contextWindow = defaults[modelName] ?? 200_000;
      }

      const contextPct = contextUsed > 0
        ? `ctx ${((contextUsed / contextWindow) * 100).toFixed(1)}%`
        : null;

      const durationStr = durationMs >= 60_000
        ? `${(durationMs / 60_000).toFixed(1)}m`
        : `${(durationMs / 1000).toFixed(1)}s`;

      const parts = [
        modelName,
        `${formatTokens(inputTokens)}↓ ${formatTokens(outputTokens)}↑`,
        cacheRead > 0 ? `${formatTokens(cacheRead)} cache` : null,
        contextPct,
        `$${costUsd.toFixed(4)}`,
        durationStr,
      ].filter(Boolean);

      const statusLine = parts.join(' · ');
      await textChannel.send(`<@${session.userId}> Done. │ ${statusLine}`).catch(() => {});
    }
  });

  sessionManager.on('error', async (channelId: string, _err: unknown) => {
    stopTyping(channelId);

    // Clean up any active handlers on error
    await finalizeStreamsForChannel(channelId);
    const toolHandler = activeToolProgress.get(channelId);
    if (toolHandler) {
      await toolHandler.finalize();
      activeToolProgress.delete(channelId);
    }

    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;
    const textChannel = channel as TextChannel;
    await textChannel.send('An error occurred in this session. The session may have stopped.');
  });
}
