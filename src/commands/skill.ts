import {
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { loadGuildConfig } from '../guild.js';
import { COLORS } from '../formatters/embedBuilder.js';
import { startTyping } from '../sessions/eventHandler.js';

/**
 * Handle `/a4d skill [command]` -- list or execute Claude Code slash commands.
 */
export async function handleSkill(interaction: ChatInputCommandInteraction): Promise<void> {
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

  const command = interaction.options.getString('command');

  if (!command) {
    // List available commands
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const commands = await session.query.supportedCommands();

      if (commands.length === 0) {
        await interaction.editReply({ content: 'No slash commands available.' });
        return;
      }

      // Build compact list — truncate descriptions to first line, max 80 chars
      const lines = commands.map((cmd) => {
        const args = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
        const desc = cmd.description.split('\n')[0].slice(0, 80);
        return `\`/${cmd.name}${args}\` — ${desc}`;
      });

      // Split into multiple embeds if needed (4096 char limit per description)
      const embeds: EmbedBuilder[] = [];
      let current = '';
      for (const line of lines) {
        if (current.length + line.length + 1 > 4000) {
          embeds.push(new EmbedBuilder().setColor(COLORS.IDLE).setDescription(current));
          current = '';
        }
        current += (current ? '\n' : '') + line;
      }
      if (current) {
        embeds.push(new EmbedBuilder().setColor(COLORS.IDLE).setDescription(current));
      }
      embeds[0].setTitle(`Available Commands (${commands.length})`);

      await interaction.editReply({ embeds });
    } catch (err) {
      console.error('[skill] Failed to get supported commands:', err);
      await interaction.editReply({ content: 'Failed to retrieve available commands.' });
    }
  } else {
    // Execute the command
    await interaction.reply({
      content: `Executing \`/${command}\`...`,
      flags: MessageFlags.Ephemeral,
    });

    try {
      startTyping(channel);
      sessionManager.sendMessage(channel.id, `/${command}`);
    } catch (err) {
      console.error('[skill] Failed to send command:', err);
      await interaction.editReply({ content: `Failed to execute \`/${command}\`: ${err}` });
    }
  }
}
