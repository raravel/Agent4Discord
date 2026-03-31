import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { REST, Routes } from 'discord.js';
import { handleInit } from './init.js';
import { handleResume } from './resume.js';
import { handleModel } from './model.js';
import { handleClose } from './close.js';

/** Handler function type for slash commands. */
export type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

/** The /a4d slash command definition. */
const a4dCommand = new SlashCommandBuilder()
  .setName('a4d')
  .setDescription('Agent4Discord commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName('init').setDescription('Initialize Agent4Discord in this server')
  )
  .addSubcommand((sub) =>
    sub.setName('resume').setDescription('Resume a stopped session in this channel')
  )
  .addSubcommand((sub) =>
    sub.setName('model')
      .setDescription('Change the model for this session')
      .addStringOption((opt) =>
        opt.setName('model')
          .setDescription('Model to use')
          .setRequired(true)
          .addChoices(
            { name: 'Opus 4.6 (most capable)', value: 'opus' },
            { name: 'Sonnet 4.6 (fast)', value: 'sonnet' },
            { name: 'Haiku 4.5 (fastest)', value: 'haiku' },
          )
      )
  )
  .addSubcommand((sub) =>
    sub.setName('close').setDescription('Stop the session and delete this channel')
  );

/** Map of command names to their handler functions. */
export const commands = new Map<string, CommandHandler>();

// Register the /a4d command handler with subcommand routing
commands.set('a4d', async (interaction: ChatInputCommandInteraction) => {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'init') {
    await handleInit(interaction);
  } else if (subcommand === 'resume') {
    await handleResume(interaction);
  } else if (subcommand === 'model') {
    await handleModel(interaction);
  } else if (subcommand === 'close') {
    await handleClose(interaction);
  }
});

/**
 * Register slash commands for a specific guild using the Discord REST API.
 */
export async function registerCommands(
  clientId: string,
  token: string,
  guildId: string
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandData = [a4dCommand.toJSON()];

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commandData,
  });
}
