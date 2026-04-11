import type { TextChannel } from 'discord.js';
import type { GuildConfig } from '../guild.js';
import { sessionManager } from './sessionManager.js';
import { removeSessionFromGuild } from './sessionStore.js';
import { clearAlwaysAllowed } from '../interactions/permissionHandler.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';

/**
 * Archive a session channel: stop session, move to archive category, make read-only.
 * Returns true on success, false on failure.
 */
export async function archiveChannel(
  channel: TextChannel,
  guildConfig: GuildConfig,
  reason: string,
): Promise<boolean> {
  const channelId = channel.id;

  try {
    // 1. Stop session if active
    const session = sessionManager.getSession(channelId);
    if (session) {
      sessionManager.stopSession(channelId);
      removeSessionFromGuild(session.guildId, channelId);
    }

    // 2. Clear always-allowed permissions
    clearAlwaysAllowed(channelId);

    // 3. Move channel to archive category (inherits read-only permissions from category)
    await channel.setParent(guildConfig.archiveCategoryId, {
      reason,
      lockPermissions: true,
    });

    // 4. Update pinned status embed to "Session Archived"
    await updateStatusEmbedToArchived(channel);

    return true;
  } catch (err) {
    console.error(`[archive] Failed to archive channel ${channelId}:`, err);
    return false;
  }
}

/**
 * Find and update the pinned status embed to show "Session Archived".
 */
async function updateStatusEmbedToArchived(channel: TextChannel): Promise<void> {
  try {
    const pinned = await channel.messages.fetchPins();
    const statusMsg = pinned.items.find(
      (p) => p.message.embeds.length > 0 &&
        p.message.embeds[0].fields.some((f) => f.name === 'Session ID'),
    )?.message;

    if (!statusMsg || statusMsg.embeds.length === 0) return;

    const embed = statusMsg.embeds[0];
    const cwd = embed.fields.find((f) => f.name === 'Directory')?.value ?? '~';
    const model = embed.fields.find((f) => f.name === 'Model')?.value ?? 'unknown';
    const sessionId = embed.fields.find((f) => f.name === 'Session ID')?.value ?? '';
    const costStr = embed.fields.find((f) => f.name === 'Cost')?.value ?? '$0.0000';
    const costUsd = parseFloat(costStr.replace('$', '')) || 0;
    const startedAt = embed.fields.find((f) => f.name === 'Started')?.value ?? new Date().toISOString();
    const permissionMode = embed.fields.find((f) => f.name === 'Permissions')?.value;

    const updatedEmbed = buildStatusEmbed({
      status: 'Session Archived',
      color: COLORS.ARCHIVED,
      cwd,
      model,
      sessionId,
      costUsd,
      startedAt,
      permissionMode,
    });

    await statusMsg.edit({ embeds: [updatedEmbed] });
  } catch (err) {
    console.error(`[archive] Failed to update status embed:`, err);
  }
}
