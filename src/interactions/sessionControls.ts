// Session control handlers (Stop / Archive) -- AGE-018
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { removeSessionFromGuild } from '../sessions/sessionStore.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';

/**
 * Find the pinned status embed message in a channel.
 */
async function findStatusMessage(channel: TextChannel) {
  const pinned = await channel.messages.fetchPinned();
  return pinned.find(
    (m) => m.author.id === channel.client.user?.id && m.embeds.length > 0,
  ) ?? null;
}

/**
 * Build disabled control row (used after stop/archive).
 */
function buildDisabledControlRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('a4d:session:stop')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('a4d:session:archive')
      .setLabel('Archive')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

/**
 * Handle the Stop button for a session channel.
 */
export async function handleSessionStop(interaction: ButtonInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const session = sessionManager.getSession(channelId);

  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  sessionManager.stopSession(channelId);
  removeSessionFromGuild(session.guildId, channelId);

  // Update the pinned status embed
  const textChannel = interaction.channel as TextChannel;
  const statusMsg = await findStatusMessage(textChannel);
  if (statusMsg) {
    const updatedEmbed = buildStatusEmbed({
      status: 'Session Stopped',
      color: COLORS.STOPPED,
      cwd: statusMsg.embeds[0]?.fields.find((f) => f.name === 'Directory')?.value ?? session.cwd,
      model: statusMsg.embeds[0]?.fields.find((f) => f.name === 'Model')?.value ?? 'opus',
      sessionId: session.sessionId || 'pending',
      costUsd: session.totalCostUsd,
      startedAt: session.createdAt,
    });
    await statusMsg.edit({ embeds: [updatedEmbed], components: [buildDisabledControlRow()] });
  }

  await textChannel.send('Session stopped by user.');
}

/**
 * Handle the Archive button for a session channel.
 */
export async function handleSessionArchive(interaction: ButtonInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const session = sessionManager.getSession(channelId);

  await interaction.deferUpdate();

  // Stop session if it is still running
  if (session) {
    if (session.state !== 'stopped' && session.state !== 'archived') {
      sessionManager.stopSession(channelId);
    }
    removeSessionFromGuild(session.guildId, channelId);
  }

  const textChannel = interaction.channel as TextChannel;

  // Update the pinned status embed
  const statusMsg = await findStatusMessage(textChannel);
  if (statusMsg) {
    const updatedEmbed = buildStatusEmbed({
      status: 'Session Archived',
      color: COLORS.ARCHIVED,
      cwd: statusMsg.embeds[0]?.fields.find((f) => f.name === 'Directory')?.value ?? session?.cwd ?? 'unknown',
      model: statusMsg.embeds[0]?.fields.find((f) => f.name === 'Model')?.value ?? 'opus',
      sessionId: session?.sessionId || statusMsg.embeds[0]?.fields.find((f) => f.name === 'Session ID')?.value || 'unknown',
      costUsd: session?.totalCostUsd ?? 0,
      startedAt: session?.createdAt ?? statusMsg.embeds[0]?.fields.find((f) => f.name === 'Started')?.value ?? 'unknown',
    });
    await statusMsg.edit({ embeds: [updatedEmbed], components: [buildDisabledControlRow()] });
  }

  // Set channel to read-only: deny SendMessages for @everyone
  const guild = interaction.guild;
  if (guild) {
    await textChannel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false,
    });
  }

  await textChannel.send('Session archived. This channel is now read-only.');
}
