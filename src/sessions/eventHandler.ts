import type { Client, TextChannel } from 'discord.js';
import type { SDKAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from './sessionManager.js';
import { chunkMessage } from '../formatters/chunker.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';
import { StreamHandler } from './streamHandler.js';
import { ToolProgressHandler } from './toolProgress.js';
import { formatThreadName, formatToolInput, sendToThread } from '../formatters/toolFormatter.js';

// Track active stream handlers per channel (keyed by "channelId:text" or "channelId:thinking")
const activeStreams = new Map<string, StreamHandler>();

// Track active tool progress handlers per channel
const activeToolProgress = new Map<string, ToolProgressHandler>();

// Channels where StreamHandler.finalize() just sent the final text,
// so the 'assistant' handler should skip re-sending it.
const recentlyFinalized = new Set<string>();

// Track tool-call threads per channel for the current turn
const turnThreads = new Map<string, string[]>();

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

          trackThread(channelId, thread.id);
        }
      }
    }
  });

  // --- Result events ---
  sessionManager.on('result', async (channelId: string, _msg: SDKResultMessage) => {
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

    // Update the pinned status embed with new cost
    try {
      const pinned = await textChannel.messages.fetchPins();
      const statusMsg = pinned.items.find(
        (p) => p.message.author.id === client.user?.id && p.message.embeds.length > 0,
      )?.message;
      if (statusMsg) {
        const embed = statusMsg.embeds[0];
        const updatedEmbed = buildStatusEmbed({
          status: 'Session Active',
          color: COLORS.IDLE,
          cwd: embed?.fields.find((f) => f.name === 'Directory')?.value ?? session.cwd,
          model: embed?.fields.find((f) => f.name === 'Model')?.value ?? 'opus',
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
  });

  sessionManager.on('error', async (channelId: string, _err: unknown) => {
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
