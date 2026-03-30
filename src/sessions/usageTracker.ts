import { EmbedBuilder, type Client, type TextChannel } from 'discord.js';
import type { SDKRateLimitInfo, SDKResultMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import { COLORS } from '../formatters/embedBuilder.js';
import { loadGuildConfig } from '../guild.js';
import { sessionManager } from './sessionManager.js';

// ---------------------------------------------------------------------------
// Rate limit state (from SDK rate_limit_event)
// ---------------------------------------------------------------------------

interface RateLimitState {
  fiveHour?: SDKRateLimitInfo;
  sevenDayOpus?: SDKRateLimitInfo;
  sevenDaySonnet?: SDKRateLimitInfo;
  sevenDay?: SDKRateLimitInfo;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Usage accumulator (from SDK result + assistant events)
// ---------------------------------------------------------------------------

interface UsageAccumulator {
  // Per-session (resets when session changes)
  currentSessionId: string;
  sessionCostUsd: number;
  sessionInputTokens: number;
  sessionOutputTokens: number;

  // All-time accumulator (since bot start)
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  // Per-model breakdown
  modelUsage: Record<string, { costUSD: number; inputTokens: number; outputTokens: number }>;
}

const rateLimitState: RateLimitState = { lastUpdated: 0 };
const usageAccum: UsageAccumulator = {
  currentSessionId: '',
  sessionCostUsd: 0,
  sessionInputTokens: 0,
  sessionOutputTokens: 0,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  modelUsage: {},
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let trackerClient: Client | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function progressBar(utilization: number, length = 20): string {
  const clamped = Math.max(0, Math.min(1, utilization));
  const filled = Math.round(clamped * length);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(length - filled);
}

function statusEmoji(status?: string): string {
  switch (status) {
    case 'allowed': return '\u2705';
    case 'allowed_warning': return '\u26a0\ufe0f';
    case 'rejected': return '\u274c';
    default: return '\u2753';
  }
}

function statusColor(status?: string): number {
  switch (status) {
    case 'allowed': return COLORS.IDLE;
    case 'allowed_warning': return COLORS.STREAMING;
    case 'rejected': return COLORS.STOPPED;
    default: return COLORS.ARCHIVED;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------------------

function formatRateLimit(label: string, info: SDKRateLimitInfo): string {
  const parts: string[] = [];

  if (info.utilization != null) {
    const pct = Math.round(info.utilization * 100);
    parts.push(`${progressBar(info.utilization)} ${pct}%`);
  }

  parts.push(`${statusEmoji(info.status)} ${info.status}`);

  if (info.resetsAt) {
    parts.push(`Resets <t:${info.resetsAt}:R>`);
  }

  return parts.join('\n');
}

export function buildUsageEmbed(state?: RateLimitState): EmbedBuilder {
  const s = state ?? rateLimitState;
  const u = usageAccum;
  const overall = s.fiveHour ?? s.sevenDay ?? s.sevenDayOpus ?? s.sevenDaySonnet;
  const color = statusColor(overall?.status);

  const embed = new EmbedBuilder()
    .setTitle('\ud83d\udcca Claude Usage')
    .setColor(color);

  // --- Current Session ---
  const sessionLines: string[] = [];
  if (u.sessionCostUsd > 0 || u.sessionInputTokens > 0) {
    sessionLines.push(`Cost: **${formatCost(u.sessionCostUsd)}**`);
    sessionLines.push(`Tokens: ${formatTokens(u.sessionInputTokens)} in / ${formatTokens(u.sessionOutputTokens)} out`);
  } else {
    sessionLines.push('No activity yet');
  }
  embed.addFields({ name: '\ud83d\udcac Current Session', value: sessionLines.join('\n') });

  // --- Total (all sessions since bot start) ---
  if (u.totalCostUsd > 0) {
    const totalLines: string[] = [];
    totalLines.push(`Cost: **${formatCost(u.totalCostUsd)}**`);
    totalLines.push(`Tokens: ${formatTokens(u.totalInputTokens)} in / ${formatTokens(u.totalOutputTokens)} out`);

    // Per-model breakdown
    const models = Object.entries(u.modelUsage);
    if (models.length > 0) {
      for (const [model, mu] of models) {
        const shortName = model.replace('claude-', '').replace(/-\d+$/, '');
        totalLines.push(`\u2022 ${shortName}: ${formatCost(mu.costUSD)} (${formatTokens(mu.inputTokens + mu.outputTokens)} tokens)`);
      }
    }

    embed.addFields({ name: '\ud83d\udcc8 All Sessions (since bot start)', value: totalLines.join('\n') });
  }

  // --- Rate Limits ---
  if (s.fiveHour) {
    embed.addFields({ name: '\u23f0 5-Hour Limit', value: formatRateLimit('5-Hour', s.fiveHour), inline: true });
  }

  if (s.sevenDay) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly Limit', value: formatRateLimit('Weekly', s.sevenDay), inline: true });
  }
  if (s.sevenDayOpus) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly (Opus)', value: formatRateLimit('Weekly Opus', s.sevenDayOpus), inline: true });
  }
  if (s.sevenDaySonnet) {
    embed.addFields({ name: '\ud83d\udcc5 Weekly (Sonnet)', value: formatRateLimit('Weekly Sonnet', s.sevenDaySonnet), inline: true });
  }

  if (!s.fiveHour && !s.sevenDay && !s.sevenDayOpus && !s.sevenDaySonnet) {
    embed.addFields({ name: 'Rate Limits', value: 'Waiting for data... Start a session to see limits.' });
  }

  // --- Last Updated ---
  if (s.lastUpdated > 0) {
    embed.setFooter({ text: `Last updated` });
    embed.setTimestamp(s.lastUpdated);
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Update logic
// ---------------------------------------------------------------------------

async function updateUsageEmbed(guildId: string): Promise<void> {
  if (!trackerClient) return;

  const config = loadGuildConfig(guildId);
  if (!config?.usageChannelId || !config?.usageMessageId) return;

  const channel = trackerClient.channels.cache.get(config.usageChannelId);
  if (!channel?.isTextBased()) return;

  try {
    const textChannel = channel as TextChannel;
    const msg = await textChannel.messages.fetch(config.usageMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [buildUsageEmbed()] });
    }
  } catch (err) {
    console.error('[usage] Failed to update usage embed:', err);
  }
}

function scheduleUpdate(guildId: string): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void updateUsageEmbed(guildId);
  }, 5000);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

let trackerRegistered = false;

export function setupUsageTracker(client: Client): void {
  if (trackerRegistered) return;
  trackerRegistered = true;
  trackerClient = client;

  // Rate limit events
  sessionManager.on('rate_limit', (guildId: string, info: SDKRateLimitInfo) => {
    rateLimitState.lastUpdated = Date.now();

    switch (info.rateLimitType) {
      case 'five_hour':
        rateLimitState.fiveHour = info;
        break;
      case 'seven_day_opus':
        rateLimitState.sevenDayOpus = info;
        break;
      case 'seven_day_sonnet':
        rateLimitState.sevenDaySonnet = info;
        break;
      case 'seven_day':
        rateLimitState.sevenDay = info;
        break;
      default:
        rateLimitState.fiveHour = info;
        break;
    }

    scheduleUpdate(guildId);
  });

  // Result events -- accumulate cost and token usage
  sessionManager.on('result', (channelId: string, msg: SDKResultMessage) => {
    const session = sessionManager.getSession(channelId);
    if (!session) return;

    // Track current session
    if (usageAccum.currentSessionId !== session.sessionId) {
      // New session -- reset session counters
      usageAccum.currentSessionId = session.sessionId;
      usageAccum.sessionCostUsd = 0;
      usageAccum.sessionInputTokens = 0;
      usageAccum.sessionOutputTokens = 0;
    }

    usageAccum.sessionCostUsd = msg.total_cost_usd ?? usageAccum.sessionCostUsd;
    if (msg.usage) {
      usageAccum.sessionInputTokens += msg.usage.input_tokens ?? 0;
      usageAccum.sessionOutputTokens += msg.usage.output_tokens ?? 0;

      usageAccum.totalInputTokens += msg.usage.input_tokens ?? 0;
      usageAccum.totalOutputTokens += msg.usage.output_tokens ?? 0;
    }

    usageAccum.totalCostUsd += msg.total_cost_usd ?? 0;

    // Per-model breakdown from modelUsage
    if (msg.modelUsage) {
      for (const [model, mu] of Object.entries(msg.modelUsage)) {
        const existing = usageAccum.modelUsage[model] ?? { costUSD: 0, inputTokens: 0, outputTokens: 0 };
        existing.costUSD += (mu as ModelUsage).costUSD ?? 0;
        existing.inputTokens += (mu as ModelUsage).inputTokens ?? 0;
        existing.outputTokens += (mu as ModelUsage).outputTokens ?? 0;
        usageAccum.modelUsage[model] = existing;
      }
    }

    rateLimitState.lastUpdated = Date.now();
    scheduleUpdate(session.guildId);
  });
}
