import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { loadGuildConfig } from '../guild.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';

/**
 * Handle `/a4d model <model>` -- change the model for the current session.
 */
export async function handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
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

  // Must be in a session channel
  const channel = interaction.channel as TextChannel;
  if (channel.parentId !== guildConfig.sessionsCategoryId) {
    await interaction.reply({
      content: 'This command can only be used in a session channel under "A4D - Sessions".',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSession(channel.id);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  const model = interaction.options.getString('model', true);

  try {
    await session.query.setModel(model);
  } catch (err) {
    console.error('[model] Failed to set model:', err);
    await interaction.reply({ content: `Failed to change model: ${err}`, flags: MessageFlags.Ephemeral });
    return;
  }

  // Update the pinned status embed
  try {
    const pinned = await channel.messages.fetchPinned();
    const statusMsg = pinned.find(
      (m) => m.author.id === interaction.client.user?.id && m.embeds.length > 0,
    );
    if (statusMsg) {
      const embed = statusMsg.embeds[0];
      const updatedEmbed = buildStatusEmbed({
        status: 'Session Active',
        color: COLORS.IDLE,
        cwd: embed.fields.find((f) => f.name === 'Directory')?.value ?? session.cwd,
        model,
        sessionId: session.sessionId || 'pending',
        costUsd: session.totalCostUsd,
        startedAt: session.createdAt,
      });
      await statusMsg.edit({ embeds: [updatedEmbed] });
    }
  } catch {
    // Status embed update is best-effort
  }

  await interaction.reply({ content: `Model changed to **${model}**.`, flags: MessageFlags.Ephemeral });
}
