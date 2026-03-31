import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { removeSessionFromGuild } from '../sessions/sessionStore.js';
import { loadGuildConfig } from '../guild.js';
import { clearAlwaysAllowed } from '../interactions/permissionHandler.js';

/**
 * Handle /a4d close — stop the session and delete the channel.
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

  // Stop session if active
  const session = sessionManager.getSession(channel.id);
  if (session) {
    sessionManager.stopSession(channel.id);
    removeSessionFromGuild(session.guildId, channel.id);
  }
  clearAlwaysAllowed(channel.id);

  await interaction.reply({ content: 'Closing session and deleting channel...' });

  // Delete the channel
  try {
    await channel.delete('A4D session closed by user');
  } catch (err) {
    console.error('[close] Failed to delete channel:', err);
    // Channel might already be deleted or bot lacks permission
  }
}
