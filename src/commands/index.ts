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
import { handleSkill } from './skill.js';
import { handleSh } from './sh.js';
import { handleBrowser } from './browser.js';
import { handlePermission as handlePermissionCmd } from './permission.js';
import { handleFork } from './fork.js';

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
    sub.setName('close').setDescription('Stop the session and archive this channel')
  )
  .addSubcommand((sub) =>
    sub.setName('skill')
      .setDescription('List or execute Claude Code slash commands')
      .addStringOption((opt) =>
        opt.setName('command')
          .setDescription('Command to execute (omit to list all)')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('sh')
      .setDescription('Run a shell command in the session working directory')
      .addStringOption((opt) =>
        opt.setName('command')
          .setDescription('Shell command to execute')
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('browser').setDescription('Open a read-only file browser in a thread')
  )
  .addSubcommand((sub) =>
    sub.setName('permission').setDescription('Change the permission mode for this session')
  )
  .addSubcommand((sub) =>
    sub.setName('fork').setDescription('Fork this session into a new channel')
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
  } else if (subcommand === 'skill') {
    await handleSkill(interaction);
  } else if (subcommand === 'sh') {
    await handleSh(interaction);
  } else if (subcommand === 'browser') {
    await handleBrowser(interaction);
  } else if (subcommand === 'permission') {
    await handlePermissionCmd(interaction);
  } else if (subcommand === 'fork') {
    await handleFork(interaction);
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
