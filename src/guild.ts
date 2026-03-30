import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from './config.js';

export interface GuildConfig {
  guildId: string;
  generalCategoryId: string;
  sessionsCategoryId: string;
  generalChannelId: string;
  sessionChannelId: string;
  usageChannelId?: string;
  usageMessageId?: string;
  initializedAt: string;
  initializedBy: string;
  activeSessions: Record<string, SessionEntry>;
}

export interface SessionEntry {
  sessionId: string;
  cwd: string;
  createdAt: string;
  userId: string;
}

const GUILDS_DIR = path.join(CONFIG_DIR, 'guilds');

function guildPath(guildId: string): string {
  return path.join(GUILDS_DIR, `${guildId}.json`);
}

export function loadGuildConfig(guildId: string): GuildConfig | null {
  const filePath = guildPath(guildId);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as GuildConfig;
}

export function saveGuildConfig(config: GuildConfig): void {
  if (!fs.existsSync(GUILDS_DIR)) {
    fs.mkdirSync(GUILDS_DIR, { recursive: true });
  }

  const data = JSON.stringify(config, null, 2) + '\n';
  const target = guildPath(config.guildId);
  const tmp = target + '.tmp';

  // Atomic write: write to temp file, then rename
  fs.writeFileSync(tmp, data, { encoding: 'utf-8' });
  fs.renameSync(tmp, target);
}

export function updateGuildConfig(
  guildId: string,
  partial: Partial<Omit<GuildConfig, 'guildId'>>,
): GuildConfig | null {
  const config = loadGuildConfig(guildId);
  if (!config) return null;

  const updated = { ...config, ...partial, guildId: config.guildId };
  saveGuildConfig(updated);
  return updated;
}

export function deleteGuildSession(guildId: string, channelId: string): void {
  const config = loadGuildConfig(guildId);
  if (!config) return;

  delete config.activeSessions[channelId];
  saveGuildConfig(config);
}
