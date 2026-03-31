import os from 'node:os';
import {
  ChannelType,
  GuildDefaultMessageNotifications,
  MessageFlags,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type CategoryChannel,
} from 'discord.js';
import { loadGuildConfig, saveGuildConfig, type GuildConfig } from '../guild.js';
import { buildBrowserMessage } from '../interactions/directoryBrowser.js';

/**
 * Handle `/a4d init` -- create the A4D category and channel structure.
 */
export async function handleInit(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Check bot permissions
  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has([PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageGuild])) {
    await interaction.reply({
      content: 'I need the "Manage Channels" and "Manage Server" permissions to set up A4D. Please check my role permissions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if already initialized
  const existing = loadGuildConfig(guild.id);
  if (existing) {
    const channelsValid = await validateChannels(guild, existing);
    if (channelsValid) {
      await interaction.reply({
        content: 'A4D is already set up in this server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Channels were deleted -- re-create
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const config = await createGuildStructure(guild, interaction.user.id, existing);
    saveGuildConfig(config);

    const sessionChannel = guild.channels.cache.get(config.sessionChannelId);
    const mention = sessionChannel ? `<#${config.sessionChannelId}>` : '#a4d-session';

    await interaction.editReply({
      content: `Setup complete! Head to ${mention} to start a session.`,
    });
  } catch (err) {
    console.error(`[init] Failed to set up guild ${guild.id}:`, err);
    await interaction.editReply({
      content: 'Failed to set up A4D. Make sure I have the "Manage Channels" permission.',
    });
  }
}

async function validateChannels(guild: Guild, config: GuildConfig): Promise<boolean> {
  try {
    const channels = guild.channels.cache;
    return (
      channels.has(config.generalCategoryId) &&
      channels.has(config.sessionsCategoryId) &&
      channels.has(config.generalChannelId) &&
      channels.has(config.sessionChannelId)
    );
  } catch {
    return false;
  }
}

async function createGuildStructure(
  guild: Guild,
  userId: string,
  existing: GuildConfig | null,
): Promise<GuildConfig> {
  // Create or reuse "A4D - General" category
  let generalCategory: CategoryChannel;
  if (existing?.generalCategoryId && guild.channels.cache.has(existing.generalCategoryId)) {
    generalCategory = guild.channels.cache.get(existing.generalCategoryId) as CategoryChannel;
  } else {
    generalCategory = await guild.channels.create({
      name: 'A4D - General',
      type: ChannelType.GuildCategory,
    });
  }

  // Create or reuse #a4d-general
  let generalChannelId: string;
  if (existing?.generalChannelId && guild.channels.cache.has(existing.generalChannelId)) {
    generalChannelId = existing.generalChannelId;
  } else {
    const ch = await guild.channels.create({
      name: 'a4d-general',
      type: ChannelType.GuildText,
      parent: generalCategory.id,
    });
    generalChannelId = ch.id;
  }

  // Create or reuse #a4d-session
  let sessionChannelId: string;
  if (existing?.sessionChannelId && guild.channels.cache.has(existing.sessionChannelId)) {
    sessionChannelId = existing.sessionChannelId;
  } else {
    const ch = await guild.channels.create({
      name: 'a4d-session',
      type: ChannelType.GuildText,
      parent: generalCategory.id,
    });
    sessionChannelId = ch.id;
  }

  // Create or reuse #a4d-usage
  let usageChannelId: string | undefined;
  let usageMessageId: string | undefined;
  if (existing?.usageChannelId && guild.channels.cache.has(existing.usageChannelId)) {
    usageChannelId = existing.usageChannelId;
    usageMessageId = existing.usageMessageId;
  } else {
    const ch = await guild.channels.create({
      name: 'a4d-usage',
      type: ChannelType.GuildText,
      parent: generalCategory.id,
    });
    usageChannelId = ch.id;

    // Send initial usage embed
    const { buildUsageEmbed } = await import('../sessions/usageTracker.js');
    const usageMsg = await ch.send({ embeds: [buildUsageEmbed()] });
    usageMessageId = usageMsg.id;
  }

  // Create or reuse "A4D - Sessions" category
  let sessionsCategory: CategoryChannel;
  if (existing?.sessionsCategoryId && guild.channels.cache.has(existing.sessionsCategoryId)) {
    sessionsCategory = guild.channels.cache.get(existing.sessionsCategoryId) as CategoryChannel;
  } else {
    sessionsCategory = await guild.channels.create({
      name: 'A4D - Sessions',
      type: ChannelType.GuildCategory,
    });
  }

  // Set default notifications to @mentions only
  await guild.setDefaultMessageNotifications(GuildDefaultMessageNotifications.OnlyMentions);

  // Send directory browser in #a4d-session
  const sessionChannel = guild.channels.cache.get(sessionChannelId);
  if (sessionChannel?.isTextBased()) {
    const browserMsg = await buildBrowserMessage(os.homedir());
    await sessionChannel.send(browserMsg);
  }

  return {
    guildId: guild.id,
    generalCategoryId: generalCategory.id,
    sessionsCategoryId: sessionsCategory.id,
    generalChannelId,
    sessionChannelId,
    usageChannelId,
    usageMessageId,
    initializedAt: new Date().toISOString(),
    initializedBy: userId,
    activeSessions: existing?.activeSessions ?? {},
  };
}
