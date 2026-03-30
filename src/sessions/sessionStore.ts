// Persist session metadata to guild config -- AGE-016
import {
  loadGuildConfig,
  saveGuildConfig,
  type SessionEntry,
} from '../guild.js';

export function saveSessionToGuild(
  guildId: string,
  channelId: string,
  sessionId: string,
  cwd: string,
  userId: string,
): void {
  const config = loadGuildConfig(guildId);
  if (!config) {
    throw new Error(`Guild config not found for guild ${guildId}`);
  }

  config.activeSessions[channelId] = {
    sessionId,
    cwd,
    createdAt: new Date().toISOString(),
    userId,
  };

  saveGuildConfig(config);
}

export function removeSessionFromGuild(
  guildId: string,
  channelId: string,
): void {
  const config = loadGuildConfig(guildId);
  if (!config) return;

  delete config.activeSessions[channelId];
  saveGuildConfig(config);
}

export function getSessionsForGuild(
  guildId: string,
): Record<string, SessionEntry> {
  const config = loadGuildConfig(guildId);
  if (!config) return {};
  return config.activeSessions;
}
