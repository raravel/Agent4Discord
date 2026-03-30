import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { GuildPremiumTier } from 'discord.js';

export type SendFileCallback = (filePath: string, filename?: string) => Promise<string>;

export function getUploadLimit(premiumTier: GuildPremiumTier): number {
  switch (premiumTier) {
    case GuildPremiumTier.Tier1: return 25 * 1024 * 1024;
    case GuildPremiumTier.Tier2: return 50 * 1024 * 1024;
    case GuildPremiumTier.Tier3: return 100 * 1024 * 1024;
    default: return 25 * 1024 * 1024;
  }
}

export function createDiscordToolServer(sendFile: SendFileCallback) {
  const attachFile = tool(
    'attach_file',
    'Send a file to the current Discord channel where this session is running. Use this tool whenever the user asks you to attach, send, share, or upload a file or image to Discord. The file must exist on the local filesystem — create it first with Write or Bash if needed, then call this tool. This is the ONLY way to send files to the user in this Discord session.',
    {
      path: z.string().describe('Absolute path to the file to send'),
      filename: z.string().optional().describe('Override the display filename (defaults to basename of path)'),
    },
    async (args) => {
      try {
        const result = await sendFile(args.path, args.filename);
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to attach file: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: false } }
  );

  return createSdkMcpServer({
    name: 'discord',
    version: '1.0.0',
    tools: [attachFile],
  });
}
