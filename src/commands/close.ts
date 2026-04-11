import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { loadGuildConfig } from '../guild.js';
import { archiveChannel } from '../sessions/archiveUtils.js';

/**
 * Handle /a4d close — stop the session and archive the channel.
 */
export async function handleClose(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel as TextChannel | null;
  const guild = interaction.guild;

  if (!guild || !channel) {
    await interaction.reply({ content: 'This command can only be used in a server channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Check this is a session channel (under the Sessions category)
  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({ content: 'A4D is not set up in this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (channel.parentId !== guildConfig.sessionsCategoryId) {
    await interaction.reply({ content: 'This command can only be used in an A4D session channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content: 'Archiving session...' });

  // Archive the channel (stop session, move to archive category, make read-only)
  await archiveChannel(channel, guildConfig, 'A4D session closed by user');
}
