import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { sessionManager } from '../sessions/sessionManager.js';
import { loadGuildConfig } from '../guild.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';

const PERM_OPTIONS: { label: string; value: PermissionMode; description: string }[] = [
  { label: 'Default (ask for everything)', value: 'default', description: 'Show permission prompt for every tool call' },
  { label: 'Accept Edits (auto-approve file changes)', value: 'acceptEdits', description: 'Auto-allow Edit/Write, ask for others' },
  { label: 'Bypass Permissions (allow all)', value: 'bypassPermissions', description: 'Auto-approve all tool calls' },
  { label: 'Plan Mode (read-only)', value: 'plan', description: 'Deny all write operations' },
];

/**
 * Handle `/a4d permission` — change the permission mode for the current session.
 */
export async function handlePermission(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
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
      content: 'This command can only be used in a session channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const session = sessionManager.getSession(channel.id);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', flags: MessageFlags.Ephemeral });
    return;
  }

  const currentMode = session.permissionMode;

  const select = new StringSelectMenuBuilder()
    .setCustomId('a4d:permc:select')
    .setPlaceholder('Select permission mode...')
    .addOptions(
      PERM_OPTIONS.map((opt) => ({
        ...opt,
        default: opt.value === currentMode,
      })),
    );

  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);

  const embed = new EmbedBuilder()
    .setTitle('Permission Mode')
    .setDescription(`Current mode: **${PERM_OPTIONS.find((o) => o.value === currentMode)?.label ?? currentMode}**`)
    .setColor(0x5865f2);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handle permission mode select menu interaction.
 */
export async function handlePermissionModeChange(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const selected = interaction.values[0] as PermissionMode;
  if (!selected) return;

  const channel = interaction.channel as TextChannel;
  const session = sessionManager.getSession(channel.id);
  if (!session) {
    await interaction.reply({ content: 'Session no longer active.', flags: MessageFlags.Ephemeral });
    return;
  }

  session.permissionMode = selected;

  // Update the pinned status embed
  try {
    const pinned = await channel.messages.fetchPins();
    const statusMsg = pinned.items.find(
      (p) => p.message.author.id === interaction.client.user?.id &&
        p.message.embeds.length > 0 &&
        p.message.embeds[0].fields.some((f) => f.name === 'Session ID'),
    )?.message;

    if (statusMsg) {
      const embed = statusMsg.embeds[0];
      const updatedEmbed = buildStatusEmbed({
        status: embed.title ?? 'Session Active',
        color: embed.color ?? COLORS.IDLE,
        cwd: embed.fields.find((f) => f.name === 'Directory')?.value ?? session.cwd,
        model: embed.fields.find((f) => f.name === 'Model')?.value ?? 'opus',
        sessionId: session.sessionId || 'pending',
        costUsd: session.totalCostUsd,
        startedAt: embed.fields.find((f) => f.name === 'Started')?.value ?? session.createdAt,
        permissionMode: selected,
      });
      await statusMsg.edit({ embeds: [updatedEmbed] });
    }
  } catch {
    // Status embed update is best-effort
  }

  const label = PERM_OPTIONS.find((o) => o.value === selected)?.label ?? selected;
  await interaction.update({
    content: `Permission mode changed to **${label}**.`,
    embeds: [],
    components: [],
  });
}
