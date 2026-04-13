import os from 'node:os';
import path from 'node:path';
import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from '../sessions/sessionManager.js';
import { saveSessionToGuild } from '../sessions/sessionStore.js';
import { loadGuildConfig } from '../guild.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';
import { createPermissionCallback } from '../interactions/permissionHandler.js';

/**
 * Handle `/a4d resume` -- resume a stopped/archived session in the current channel.
 * Reads the sessionId and cwd from the pinned status embed.
 */
export async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({ content: 'A4D is not set up. Run `/a4d init` first.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Check if this channel is under the Sessions or Archive category
  const channel = interaction.channel as TextChannel;
  const isInSessions = channel.parentId === guildConfig.sessionsCategoryId;
  const isInArchive = channel.parentId === guildConfig.archiveCategoryId;

  if (!isInSessions && !isInArchive) {
    await interaction.reply({
      content: 'This command can only be used in a session channel under "A4D - Sessions" or "A4D - Archive".',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if there's already an active session in this channel
  const existing = sessionManager.getSession(channel.id);
  if (existing && existing.state !== 'stopped' && existing.state !== 'archived') {
    await interaction.reply({ content: 'This session is already active.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Find the status embed -- try pinned first, then search recent messages
  const pinned = await channel.messages.fetchPins();
  let statusMsg = pinned.items.find(
    (p) => p.message.author.id === interaction.client.user?.id &&
      p.message.embeds.length > 0 &&
      p.message.embeds[0].fields.some((f) => f.name === 'Session ID'),
  )?.message ?? null;

  if (!statusMsg) {
    const recent = await channel.messages.fetch({ limit: 50 });
    statusMsg = recent.find(
      (m) => m.author.id === interaction.client.user?.id &&
        m.embeds.length > 0 &&
        m.embeds[0].fields.some((f) => f.name === 'Session ID'),
    ) ?? null;
  }

  if (!statusMsg || statusMsg.embeds.length === 0) {
    await interaction.reply({ content: 'No session status embed found in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  const embed = statusMsg.embeds[0];
  const rawCwd = embed.fields.find((f) => f.name === 'Directory')?.value;
  let sessionId = embed.fields.find((f) => f.name === 'Session ID')?.value;
  const model = embed.fields.find((f) => f.name === 'Model')?.value || 'opus';

  if (!rawCwd) {
    await interaction.reply({ content: 'Could not find directory info in the status embed.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Resolve ~ back to absolute path
  const cwd = rawCwd.startsWith('~')
    ? path.join(os.homedir(), rawCwd.slice(1))
    : rawCwd;

  // If sessionId is missing or pending, find the most recent session for this directory
  if (!sessionId || sessionId === 'pending') {
    try {
      const sessions = await listSessions({ dir: cwd, limit: 1 });
      if (sessions.length > 0) {
        sessionId = sessions[0].sessionId;
      }
    } catch {
      // listSessions may not be available
    }
  }

  if (!sessionId || sessionId === 'pending') {
    await interaction.reply({ content: 'No session found for this directory. Try starting a new session instead.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // If channel was archived, move it back to Sessions category (inherits writable permissions)
    if (isInArchive) {
      await channel.setParent(guildConfig.sessionsCategoryId, {
        reason: 'A4D session resumed from archive',
        lockPermissions: true,
      }).catch((err) => {
        console.error('[resume] Failed to move channel to Sessions category:', err);
      });
    }

    // Resume the session
    const session = sessionManager.resumeSession(
      guild.id,
      interaction.user.id,
      channel.id,
      sessionId,
      cwd,
      model,
      createPermissionCallback(channel, interaction.user.id),
      interaction.client,
    );

    // Persist to guild config
    saveSessionToGuild(guild.id, channel.id, sessionId, cwd, interaction.user.id);

    // Update the status embed to active
    const updatedEmbed = buildStatusEmbed({
      status: 'Session Active',
      color: COLORS.IDLE,
      cwd,
      model,
      sessionId,
      costUsd: session.totalCostUsd,
      startedAt: new Date().toISOString(),
    });

    await statusMsg.edit({ embeds: [updatedEmbed] });

    await interaction.editReply({ content: 'Session resumed! You can start chatting again.' });

    // Auto-delete after 60 seconds
    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch { /* already deleted */ }
    }, 60_000);
  } catch (err) {
    console.error('[resume] Failed to resume session:', err);
    await interaction.editReply({ content: 'Failed to resume session. Check the bot console for details.' });
  }
}
