import fs from 'node:fs';
import path from 'node:path';
import { ChannelType, SnowflakeUtil, type Client, type TextChannel } from 'discord.js';
import { CONFIG_DIR } from '../config.js';
import { loadGuildConfig } from '../guild.js';
import { archiveChannel } from './archiveUtils.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INACTIVITY_THRESHOLD_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Start periodic auto-archive checks for inactive session channels.
 */
export function setupAutoArchive(client: Client): void {
  setInterval(() => void checkInactiveSessions(client), CHECK_INTERVAL_MS);
}

async function checkInactiveSessions(client: Client): Promise<void> {
  const guildsDir = path.join(CONFIG_DIR, 'guilds');
  if (!fs.existsSync(guildsDir)) return;

  const files = fs.readdirSync(guildsDir).filter((f) => f.endsWith('.json'));

  for (const file of files) {
    const guildId = file.replace('.json', '');
    try {
      await checkGuildSessions(client, guildId);
    } catch (err) {
      console.error(`[auto-archive] Error checking guild ${guildId}:`, err);
    }
  }
}

async function checkGuildSessions(client: Client, guildId: string): Promise<void> {
  const guildConfig = loadGuildConfig(guildId);
  if (!guildConfig) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  // Get all channels in the Sessions category
  const sessionsCategory = guild.channels.cache.get(guildConfig.sessionsCategoryId);
  if (!sessionsCategory || sessionsCategory.type !== ChannelType.GuildCategory) return;

  const sessionChannels = guild.channels.cache.filter(
    (ch) => ch.parentId === guildConfig.sessionsCategoryId && ch.type === ChannelType.GuildText,
  );

  const now = Date.now();

  for (const [channelId, channel] of sessionChannels) {
    // Only archive channels that have an active session
    if (!guildConfig.activeSessions[channelId]) continue;

    try {
      const lastActivity = getLastActivityTimestamp(channel as TextChannel);
      const inactiveMs = now - lastActivity;

      if (inactiveMs >= INACTIVITY_THRESHOLD_MS) {
        console.log(
          `[auto-archive] Channel ${channel.name} (${channelId}) inactive for ${Math.round(inactiveMs / 3600000)}h, archiving`,
        );

        const textChannel = channel as TextChannel;

        // Post notification before archiving
        await textChannel.send(
          'This session was automatically archived due to 72 hours of inactivity. Use `/a4d resume` to restore it.',
        );

        await archiveChannel(textChannel, guildConfig, 'Auto-archived after 72 hours of inactivity');
      }
    } catch (err) {
      console.error(`[auto-archive] Error checking channel ${channelId}:`, err);
    }
  }
}

/**
 * Get the timestamp of the last activity in a channel.
 * Uses the lastMessageId snowflake for efficient timestamp extraction.
 */
function getLastActivityTimestamp(channel: TextChannel): number {
  if (channel.lastMessageId) {
    const decoded = SnowflakeUtil.decode(channel.lastMessageId);
    return Number(decoded.timestamp);
  }
  // No messages: use channel creation time
  return channel.createdTimestamp;
}
