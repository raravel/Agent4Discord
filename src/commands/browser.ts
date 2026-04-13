import {
  ChannelType,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { loadGuildConfig } from '../guild.js';
import { buildDirMessage } from '../interactions/fileBrowser.js';

/**
 * Handle `/a4d browser` — open a read-only file browser in a thread.
 */
export async function handleBrowser(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({
      content: 'A4D is not set up. Run `/a4d init` first.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.channel as TextChannel;
  if (channel.parentId !== guildConfig.sessionsCategoryId) {
    await interaction.reply({
      content:
        'This command can only be used in a session channel under "A4D - Sessions".',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSession(channel.id);
  if (!session) {
    await interaction.reply({
      content: 'No active session in this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const thread = await channel.threads.create({
      name: '\uD83D\uDCC2 File Browser',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      type: ChannelType.PublicThread,
      reason: 'A4D file browser',
    });

    const message = await buildDirMessage(session.cwd, 0);
    await thread.send(message);

    await interaction.editReply({
      content: `File browser opened in <#${thread.id}>`,
    });
  } catch (err) {
    console.error('[browser] Failed to create file browser thread:', err);
    await interaction.editReply({
      content: 'Failed to create file browser thread.',
    });
  }
}
