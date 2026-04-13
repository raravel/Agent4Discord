import path from 'node:path';
import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { saveSessionToGuild } from '../sessions/sessionStore.js';
import { loadGuildConfig } from '../guild.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';
import { createPermissionCallback } from '../interactions/permissionHandler.js';
import { displayPath } from '../interactions/directoryBrowser.js';

const MAX_SESSIONS_PER_USER = 3;

/**
 * Handle `/a4d fork` — fork the current session into a new channel.
 * Both the original and the fork share the same history up to this point,
 * then diverge independently.
 */
export async function handleFork(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
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

  const channel = interaction.channel as TextChannel;
  if (channel.parentId !== guildConfig.sessionsCategoryId) {
    await interaction.reply({
      content: 'This command can only be used in a session channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSession(channel.id);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!session.sessionId || session.sessionId === 'pending') {
    await interaction.reply({ content: 'Session is still initializing. Try again in a moment.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Enforce concurrent session limit
  const userSessions = sessionManager.getAllSessions().filter(
    (s) => s.userId === interaction.user.id && s.guildId === guild.id,
  );
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    await interaction.reply({
      content: `You already have ${MAX_SESSIONS_PER_USER} active sessions. Close one before forking.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const dirName = path.basename(session.cwd) || 'home';
    const forkChannel = await guild.channels.create({
      name: `a4d-${dirName}-fork`.slice(0, 100).toLowerCase(),
      type: ChannelType.GuildText,
      parent: guildConfig.sessionsCategoryId,
    });

    // Resume with the same sessionId — SDK creates a fork point
    const forkedSession = sessionManager.resumeSession(
      guild.id,
      interaction.user.id,
      forkChannel.id,
      session.sessionId,
      session.cwd,
      undefined, // inherit model from session history
      createPermissionCallback(forkChannel as TextChannel, interaction.user.id),
      interaction.client,
      session.permissionMode,
    );

    saveSessionToGuild(guild.id, forkChannel.id, session.sessionId, session.cwd, interaction.user.id);

    const statusEmbed = buildStatusEmbed({
      status: 'Session Active (Fork)',
      color: COLORS.IDLE,
      cwd: displayPath(session.cwd),
      model: 'opus',
      sessionId: forkedSession.sessionId || session.sessionId,
      costUsd: 0,
      startedAt: new Date().toISOString(),
      permissionMode: session.permissionMode,
    });

    const statusMsg = await forkChannel.send({ embeds: [statusEmbed] });
    await statusMsg.pin().catch((err) => console.warn('[fork] Failed to pin status embed:', err.message));

    await forkChannel.send(
      `Forked from <#${channel.id}>. This session shares the same history up to this point and will now diverge independently.`,
    );

    await interaction.editReply({
      content: `Session forked to <#${forkChannel.id}>`,
    });

    setTimeout(async () => {
      try { await interaction.deleteReply(); } catch { /* already deleted */ }
    }, 60_000);
  } catch (err) {
    console.error('[fork] Failed to fork session:', err);
    await interaction.editReply({
      content: 'Failed to fork session. Make sure the bot has permission to create channels.',
    });
  }
}
