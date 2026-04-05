import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EmbedBuilder, type Client, type TextChannel } from 'discord.js';
import { COLORS } from '../formatters/embedBuilder.js';
import { loadGuildConfig } from '../guild.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface RateLimit {
  utilization: number | null;
  resets_at: string | null;
}

interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

interface UsageResponse {
  five_hour?: RateLimit | null;
  seven_day?: RateLimit | null;
  seven_day_opus?: RateLimit | null;
  seven_day_sonnet?: RateLimit | null;
  extra_usage?: ExtraUsage | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

const MIN_POLL_INTERVAL = 60_000;      // 60s
const MAX_POLL_INTERVAL = 600_000;     // 10 min
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedUsage: UsageResponse | null = null;
let lastFetchedAt = 0;
let currentPollInterval = MIN_POLL_INTERVAL;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let trackerClient: Client | null = null;
let isOAuthAvailable = true;

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

function readCredentials(): OAuthCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

function writeCredentials(creds: OAuthCredentials): void {
  try {
    let data: any = {};
    try {
      data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    } catch { /* fresh file */ }

    data.claudeAiOauth = {
      ...data.claudeAiOauth,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data), 'utf-8');
  } catch (err) {
    console.error('[usage] Failed to write credentials:', err);
  }
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials | null> {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!res.ok) {
      console.error(`[usage] Token refresh failed: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const creds: OAuthCredentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };

    writeCredentials(creds);
    return creds;
  } catch (err) {
    console.error('[usage] Token refresh error:', err);
    return null;
  }
}

async function getValidToken(): Promise<string | null> {
  let creds = readCredentials();
  if (!creds) return null;

  // Refresh if expired or expiring within 5 minutes
  if (creds.expiresAt < Date.now() + 300_000) {
    creds = await refreshAccessToken(creds.refreshToken);
    if (!creds) return null;
  }

  return creds.accessToken;
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

async function fetchUsage(): Promise<UsageResponse | null> {
  const token = await getValidToken();
  if (!token) {
    isOAuthAvailable = false;
    return null;
  }

  try {
    const res = await fetch(USAGE_API_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 429) {
      // Rate limited — back off
      currentPollInterval = Math.min(currentPollInterval * BACKOFF_MULTIPLIER, MAX_POLL_INTERVAL);
      console.log(`[usage] Rate limited, backing off to ${currentPollInterval / 1000}s`);
      return cachedUsage;
    }

    if (!res.ok) {
      console.error(`[usage] API error: ${res.status}`);
      return cachedUsage;
    }

    // Success — reset interval
    currentPollInterval = MIN_POLL_INTERVAL;
    const data = await res.json() as UsageResponse;
    cachedUsage = data;
    lastFetchedAt = Date.now();
    return data;
  } catch (err) {
    console.error('[usage] Fetch error:', err);
    return cachedUsage;
  }
}

// ---------------------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------------------

function progressBar(utilization: number, length = 20): string {
  const clamped = Math.max(0, Math.min(1, utilization));
  const filled = Math.round(clamped * length);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(length - filled);
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const ts = Math.floor(new Date(resetsAt).getTime() / 1000);
  return `Resets <t:${ts}:R>`;
}

function utilizationColor(usage: UsageResponse | null): number {
  if (!usage) return COLORS.ARCHIVED;
  // API returns utilization as 0-100 percentage
  const fiveHour = usage.five_hour?.utilization ?? 0;
  const sevenDay = usage.seven_day?.utilization ?? 0;
  const maxUtil = Math.max(fiveHour, sevenDay);
  if (maxUtil >= 90) return COLORS.STOPPED;          // red
  if (maxUtil >= 70) return COLORS.STREAMING;         // yellow
  return COLORS.IDLE;                                 // green
}

function formatLimit(label: string, limit: RateLimit | null | undefined): string | null {
  if (!limit || limit.utilization == null) return null;
  // API returns utilization as 0-100 percentage
  const pct = Math.round(limit.utilization);
  const bar = progressBar(limit.utilization / 100);
  const reset = formatResetTime(limit.resets_at);
  return `${bar} **${pct}%**${reset ? `\n${reset}` : ''}`;
}

export function buildUsageEmbed(): EmbedBuilder {
  if (!isOAuthAvailable) {
    return new EmbedBuilder()
      .setTitle('\ud83d\udcca Claude Usage')
      .setColor(COLORS.ARCHIVED)
      .setDescription('Usage tracking is only available for Claude.ai subscribers (Pro/Max).\nPlease authenticate with `claude login`.');
  }

  if (!cachedUsage) {
    return new EmbedBuilder()
      .setTitle('\ud83d\udcca Claude Usage')
      .setColor(COLORS.ARCHIVED)
      .setDescription('Waiting for usage data...');
  }

  const embed = new EmbedBuilder()
    .setTitle('\ud83d\udcca Claude Usage')
    .setColor(utilizationColor(cachedUsage));

  // 5-hour limit
  const fiveHourText = formatLimit('5-Hour', cachedUsage.five_hour);
  if (fiveHourText) {
    embed.addFields({ name: '\u23f0 Session (5h)', value: fiveHourText });
  }

  // 7-day limit
  const sevenDayText = formatLimit('Weekly', cachedUsage.seven_day);
  if (sevenDayText) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly (7d)', value: sevenDayText });
  }

  // Model-specific limits (inline)
  const opusText = formatLimit('Opus', cachedUsage.seven_day_opus);
  const sonnetText = formatLimit('Sonnet', cachedUsage.seven_day_sonnet);
  if (opusText) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly Opus', value: opusText, inline: true });
  }
  if (sonnetText) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly Sonnet', value: sonnetText, inline: true });
  }

  // Extra usage
  if (cachedUsage.extra_usage?.is_enabled) {
    const extra = cachedUsage.extra_usage;
    const parts: string[] = [];
    if (extra.utilization != null) {
      parts.push(`${progressBar(extra.utilization / 100)} **${Math.round(extra.utilization)}%**`);
    }
    if (extra.used_credits != null && extra.monthly_limit != null) {
      parts.push(`$${(extra.used_credits / 100).toFixed(2)} / $${(extra.monthly_limit / 100).toFixed(2)}`);
    }
    if (parts.length > 0) {
      embed.addFields({ name: '\ud83d\udcb3 Extra Usage', value: parts.join('\n') });
    }
  }

  // No data at all
  if (!cachedUsage.five_hour && !cachedUsage.seven_day && !cachedUsage.seven_day_opus && !cachedUsage.seven_day_sonnet) {
    embed.setDescription('No rate limit data available.');
  }

  // Footer with last updated
  if (lastFetchedAt > 0) {
    embed.setFooter({ text: `Polling every ${currentPollInterval / 1000}s` });
    embed.setTimestamp(lastFetchedAt);
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Embed update
// ---------------------------------------------------------------------------

async function updateAllGuilds(): Promise<void> {
  if (!trackerClient) return;

  for (const guild of trackerClient.guilds.cache.values()) {
    const config = loadGuildConfig(guild.id);
    if (!config?.usageChannelId || !config?.usageMessageId) continue;

    const channel = trackerClient.channels.cache.get(config.usageChannelId);
    if (!channel?.isTextBased()) continue;

    try {
      const textChannel = channel as TextChannel;
      const msg = await textChannel.messages.fetch(config.usageMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [buildUsageEmbed()] });
      }
    } catch (err) {
      console.error(`[usage] Failed to update embed for guild ${guild.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function poll(): Promise<void> {
  await fetchUsage();
  await updateAllGuilds();
  schedulePoll();
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll(), currentPollInterval);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setupUsageTracker(client: Client): void {
  trackerClient = client;

  // Check if OAuth is available
  const creds = readCredentials();
  if (!creds) {
    isOAuthAvailable = false;
    console.log('[usage] No OAuth credentials found. Usage tracking disabled.');
    // Still update embeds once to show the "not available" message
    void updateAllGuilds();
    return;
  }

  console.log('[usage] OAuth credentials found. Starting usage polling.');
  // Initial fetch + start polling
  void poll();
}
