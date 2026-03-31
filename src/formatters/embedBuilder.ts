import { EmbedBuilder } from 'discord.js';

// Embed color constants
export const COLORS = {
  STREAMING: 0xfee75c,    // Yellow -- active streaming
  THINKING: 0x9b59b6,     // Purple -- thinking in progress
  TOOL_PROGRESS: 0xe67e22, // Orange -- tool executing
  IDLE: 0x57f287,         // Green -- session idle
  RUNNING: 0xfee75c,      // Yellow -- session running
  PERMISSION: 0xe67e22,   // Orange -- awaiting permission
  STOPPED: 0xed4245,      // Red -- session stopped
  ARCHIVED: 0x95a5a6,     // Grey -- session archived
  ERROR: 0xed4245,        // Red -- error
} as const;

/**
 * Build a session status embed.
 */
export function buildStatusEmbed(opts: {
  status: string;
  color: number;
  cwd: string;
  model: string;
  sessionId: string;
  costUsd: number;
  startedAt: string;
  permissionMode?: string;
}): EmbedBuilder {
  const permLabels: Record<string, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    bypassPermissions: 'Bypass Permissions',
    plan: 'Plan Mode',
  };

  const fields = [
    { name: 'Directory', value: opts.cwd, inline: true },
    { name: 'Model', value: opts.model, inline: true },
    { name: 'Permissions', value: permLabels[opts.permissionMode ?? 'default'] ?? opts.permissionMode ?? 'Default', inline: true },
    { name: 'Session ID', value: opts.sessionId || 'pending', inline: false },
    { name: 'Cost', value: `$${opts.costUsd.toFixed(4)}`, inline: true },
    { name: 'Started', value: opts.startedAt, inline: true },
  ];

  return new EmbedBuilder()
    .setTitle(`${opts.status}`)
    .setColor(opts.color)
    .addFields(fields);
}

/**
 * Build an error embed.
 */
export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Error')
    .setDescription(message)
    .setColor(COLORS.ERROR);
}
