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
      return truncate(text, 4000);
    }
    case 'Write':
      return truncate(
        `**File:** \`${input.file_path || 'unknown'}\`\n\n\`\`\`\n${input.content || ''}\n\`\`\``,
        4000,
      );
    case 'Read':
      return `**File:** \`${input.file_path || 'unknown'}\``;
    case 'Bash':
      return truncate(`**Command:**\n\`\`\`bash\n${input.command || ''}\n\`\`\``, 4000);
    case 'Glob':
      return `**Pattern:** \`${input.pattern || ''}\``;
    case 'Grep':
      return `**Pattern:** \`${input.pattern || ''}\`${input.path ? `\n**Path:** \`${input.path}\`` : ''}`;
    default:
      return truncate(`\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``, 4000);
  }
}

export function formatToolResult(toolName: string, result: unknown): string {
  if (typeof result === 'string') {
    if (toolName === 'Bash') {
      return truncate(`\`\`\`\n${result}\n\`\`\``, 4000);
    }
    return truncate(result, 4000);
  }
  return truncate(JSON.stringify(result, null, 2), 4000);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 20) + '\n... (truncated)';
}
