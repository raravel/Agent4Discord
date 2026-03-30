import { AttachmentBuilder } from 'discord.js';
import type { ThreadChannel } from 'discord.js';

const DISCORD_MSG_LIMIT = 2000;
const PREVIEW_LIMIT = 1500;

const TOOL_EMOJIS: Record<string, string> = {
  Edit: '\u270F\uFE0F',
  Write: '\uD83D\uDCDD',
  Read: '\uD83D\uDCD6',
  Bash: '\uD83D\uDCBB',
  Glob: '\uD83D\uDD0D',
  Grep: '\uD83D\uDD0E',
  Agent: '\uD83E\uDD16',
  WebSearch: '\uD83C\uDF10',
  WebFetch: '\uD83C\uDF10',
};

export function getToolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] || '\uD83D\uDD27';
}

export function formatThreadName(toolName: string, input: Record<string, any>): string {
  const emoji = getToolEmoji(toolName);
  let summary = '';

  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
      summary = input.file_path || input.path || 'unknown';
      break;
    case 'Bash':
      summary = input.command?.slice(0, 60) || 'command';
      break;
    case 'Glob':
      summary = input.pattern || 'pattern';
      break;
    case 'Grep':
      summary = input.pattern || 'search';
      break;
    case 'Agent':
      summary = input.description || input.prompt?.slice(0, 40) || 'task';
      break;
    case 'WebSearch':
    case 'WebFetch':
      summary = input.query || input.url || 'search';
      break;
    default:
      summary = JSON.stringify(input).slice(0, 60);
  }

  const name = `${emoji} ${toolName}: ${summary}`;
  return name.slice(0, 100);
}

export function formatToolInput(toolName: string, input: Record<string, any>): string {
  // NOTE: Do NOT truncate here. The caller (sendToThread) handles
  // Discord's 2000-char limit by showing a preview + file attachment.
  switch (toolName) {
    case 'Edit': {
      let text = `**File:** \`${input.file_path || 'unknown'}\`\n`;
      if (input.old_string && input.new_string) {
        text += '\n```diff\n';
        for (const line of String(input.old_string).split('\n')) {
          text += `- ${line}\n`;
        }
        for (const line of String(input.new_string).split('\n')) {
          text += `+ ${line}\n`;
        }
        text += '```';
      }
      return text;
    }
    case 'Write':
      return `**File:** \`${input.file_path || 'unknown'}\`\n\n\`\`\`\n${input.content || ''}\n\`\`\``;
    case 'Read':
      return `**File:** \`${input.file_path || 'unknown'}\``;
    case 'Bash':
      return `**Command:**\n\`\`\`bash\n${input.command || ''}\n\`\`\``;
    case 'Glob':
      return `**Pattern:** \`${input.pattern || ''}\``;
    case 'Grep':
      return `**Pattern:** \`${input.pattern || ''}\`${input.path ? `\n**Path:** \`${input.path}\`` : ''}`;
    default:
      return `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  }
}

export function formatToolResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') {
    if (toolName === 'Bash') {
      return `\`\`\`\n${result}\n\`\`\``;
    }
    return result;
  }
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

/**
 * Send a potentially long message to a thread.
 * If the text exceeds Discord's 2000-char limit, it truncates with a preview
 * and attaches the full content as a file.
 */
export async function sendToThread(
  thread: ThreadChannel,
  text: string,
  attachFilename?: string,
): Promise<void> {
  if (text.length <= DISCORD_MSG_LIMIT) {
    await thread.send(text);
    return;
  }

  // Truncate for preview
  const totalLen = text.length;
  let preview = text.slice(0, PREVIEW_LIMIT);

  // Try to cut at a newline boundary to avoid breaking mid-line
  const lastNewline = preview.lastIndexOf('\n');
  if (lastNewline > PREVIEW_LIMIT * 0.5) {
    preview = preview.slice(0, lastNewline);
  }

  preview += `\n\n*... truncated (${totalLen.toLocaleString()} chars total — full content attached)*`;

  // Determine file extension from the content
  const filename = attachFilename || 'content.txt';
  const attachment = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: filename });

  await thread.send({ content: preview, files: [attachment] });
}
