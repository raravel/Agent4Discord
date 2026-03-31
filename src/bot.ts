import {
  Client,
  GatewayIntentBits,
  Events,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { loadConfig } from './config.js';
import { commands, registerCommands } from './commands/index.js';
import { routeInteraction, routeModalSubmit } from './interactions/index.js';
import { sessionManager } from './sessions/sessionManager.js';
import { setupEventHandlers, getAndClearTurnThreads } from './sessions/eventHandler.js';
import { removeSessionFromGuild } from './sessions/sessionStore.js';
import { setupUsageTracker } from './sessions/usageTracker.js';
import { processAttachments } from './utils/attachments.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export async function startBot(): Promise<void> {
  const config = loadConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // --- Ready ---
  client.on(Events.ClientReady, async (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag} (${readyClient.guilds.cache.size} guilds)`);

    // Auto-register slash commands for all guilds
    for (const [guildId] of readyClient.guilds.cache) {
      try {
        await registerCommands(config.discordClientId, config.discordToken, guildId);
      } catch (err) {
        console.error(`Failed to register commands for guild ${guildId}:`, err);
      }
    }
  });

  // --- Guild join ---
  client.on(Events.GuildCreate, async (guild) => {
    console.log(`Joined guild: ${guild.name} (${guild.id})`);
    try {
      await registerCommands(config.discordClientId, config.discordToken, guild.id);
    } catch (err) {
      console.error(`Failed to register commands for guild ${guild.id}:`, err);
    }
  });

  // --- Interaction handling ---
  client.on(Events.InteractionCreate, async (interaction) => {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const handler = commands.get(interaction.commandName);
      if (handler) {
        try {
          await handler(interaction as ChatInputCommandInteraction);
        } catch (err) {
          console.error(`Error handling command "${interaction.commandName}":`, err);
          const reply = { content: 'An error occurred while processing the command.', ephemeral: true } as const;
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
          } else {
            await interaction.reply(reply);
          }
        }
      }
      return;
    }

    // Buttons and select menus
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      try {
        await routeInteraction(interaction);
      } catch (err) {
        console.error(`Error handling interaction "${interaction.customId}":`, err);
      }
      return;
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      try {
        await routeModalSubmit(interaction);
      } catch (err) {
        console.error(`Error handling modal "${interaction.customId}":`, err);
      }
      return;
    }
  });

  // --- Message handling ---
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const session = sessionManager.getSession(message.channelId);
    if (!session) return;

    // Archive previous turn's tool threads
    const prevThreadIds = getAndClearTurnThreads(message.channelId);
    for (const threadId of prevThreadIds) {
      const thread = message.guild?.channels.cache.get(threadId);
      if (thread?.isThread()) {
        thread.setArchived(true).catch(() => {});
      }
    }

    // Add hourglass reaction to indicate processing
    await message.react('\u23f3').catch(() => {});

    try {
      // Process attachments if present
      if (message.attachments.size > 0) {
        const attachmentResults = await processAttachments(message.attachments, session.cwd);

        if (attachmentResults.length > 0) {
          const contentBlocks: ContentBlockParam[] = [];

          if (message.content) {
            contentBlocks.push({ type: 'text', text: message.content });
          }

          for (const result of attachmentResults) {
            contentBlocks.push(...result.contentBlocks);
            contentBlocks.push({ type: 'text', text: `[File saved to: ${result.savedPath}]` });
          }

          if (contentBlocks.length === 0) {
            contentBlocks.push({ type: 'text', text: 'User attached file(s).' });
          }

          sessionManager.sendMessage(message.channelId, contentBlocks);
        } else {
          // All attachments failed to process — send text only
          sessionManager.sendMessage(message.channelId, message.content || 'User sent attachments that could not be processed.');
        }
      } else {
        sessionManager.sendMessage(message.channelId, message.content);
      }
    } catch (err) {
      console.error(`[message] Failed to relay message to session:`, err);
      await message.reply('Could not send message to Claude Code session.').catch(() => {});
    }
  });

  // --- Channel delete ---
  client.on(Events.ChannelDelete, async (channel) => {
    const session = sessionManager.getSession(channel.id);
    if (!session) return;

    console.log(
      `[cleanup] Channel ${channel.id} deleted, cleaning up session ${session.sessionId} (guild: ${session.guildId})`,
    );

    sessionManager.removeSession(channel.id);
    removeSessionFromGuild(session.guildId, channel.id);
  });

  // Wire up SDK event -> Discord message handlers
  setupEventHandlers(client);
  setupUsageTracker(client);

  // Start
  await client.login(config.discordToken);
}
