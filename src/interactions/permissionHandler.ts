import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from 'discord.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { COLORS } from '../formatters/embedBuilder.js';
import { formatToolInput, getToolEmoji } from '../formatters/toolFormatter.js';

// Auto-allow these safe tools
const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP']);

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  channelId: string;
  messageId: string;
  userId: string; // session owner
  toolName: string;
  toolInput: Record<string, unknown>;
}

const pendingPermissions = new Map<string, PendingPermission>();

// Per-channel set of tool names that the user has "Always Allowed"
const alwaysAllowedTools = new Map<string, Set<string>>();

export function isToolAlwaysAllowed(channelId: string, toolName: string): boolean {
  return alwaysAllowedTools.get(channelId)?.has(toolName) ?? false;
}

export function clearAlwaysAllowed(channelId: string): void {
  alwaysAllowedTools.delete(channelId);
}

/**
 * Request tool permission via Discord buttons.
 * Returns a promise that resolves when the user clicks Allow/Deny or times out.
 */
export async function requestPermission(
  channel: TextChannel,
  userId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<PermissionResult> {
  // Auto-allow safe tools
  if (AUTO_ALLOW_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: {} };
  }

  // Check if user has "Always Allowed" this tool for this session
  if (isToolAlwaysAllowed(channel.id, toolName)) {
    return { behavior: 'allow', updatedInput: {} };
  }

  const requestId = randomUUID().slice(0, 8); // short ID for customId limit

  // Build permission embed
  const emoji = getToolEmoji(toolName);
  const inputPreview = formatToolInput(toolName, toolInput as Record<string, any>);
  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Permission Request`)
    .setDescription(`**Tool:** ${toolName}\n\n${inputPreview.slice(0, 3000)}`)
    .setColor(COLORS.PERMISSION)
    .setFooter({ text: `Expires in 60 seconds` });

  // Build buttons
  const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`a4d:perm:${requestId}:allow`)
      .setLabel('Allow')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`a4d:perm:${requestId}:always`)
      .setLabel('Always Allow')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`a4d:perm:${requestId}:deny`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`a4d:perm:${requestId}:details`)
      .setLabel('Details')
      .setStyle(ButtonStyle.Secondary),
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingPermissions.delete(requestId);
      const timedOutEmbed = EmbedBuilder.from(embed)
        .setTitle(`${emoji} Permission Request (Timed Out)`)
        .setColor(COLORS.STOPPED);
      const disabledRow = buildDisabledRow();
      msg.edit({ embeds: [timedOutEmbed], components: [disabledRow] }).catch(() => {});
      resolve({ behavior: 'deny', message: 'Permission request timed out' });
    }, 60_000);

    pendingPermissions.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout);
        pendingPermissions.delete(requestId);
        resolve(result);
      },
      channelId: channel.id,
      messageId: msg.id,
      userId,
      toolName,
      toolInput,
    });
  });
}

/**
 * Handle permission button interactions.
 */
export async function handlePermission(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  // a4d:perm:{requestId}:{action}
  const requestId = parts[2];
  const action = parts[3];

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    await interaction.reply({ content: 'This permission request has expired.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Only session owner can approve/deny
  if (interaction.user.id !== pending.userId) {
    await interaction.reply({ content: 'Only the session owner can approve or deny this.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'details') {
    // Show full input as ephemeral (don't resolve/delete)
    const fullInput = JSON.stringify(pending.toolInput, null, 2);
    const truncated = fullInput.length > 1900 ? fullInput.slice(0, 1900) + '\n...' : fullInput;
    await interaction.reply({
      content: `\`\`\`json\n${truncated}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'allow') {
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setTitle('Permission Granted')
      .setColor(COLORS.IDLE);
    await interaction.update({ embeds: [embed], components: [buildDisabledRow()] });
    pending.resolve({ behavior: 'allow', updatedInput: {} });
  } else if (action === 'always') {
    // Add to always-allowed set for this channel/session
    if (!alwaysAllowedTools.has(pending.channelId)) {
      alwaysAllowedTools.set(pending.channelId, new Set());
    }
    alwaysAllowedTools.get(pending.channelId)!.add(pending.toolName);

    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setTitle(`Permission Granted (Always: ${pending.toolName})`)
      .setColor(COLORS.IDLE);
    await interaction.update({ embeds: [embed], components: [buildDisabledRow()] });
    pending.resolve({ behavior: 'allow', updatedInput: {} });
  } else if (action === 'deny') {
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
      .setTitle('Permission Denied')
      .setColor(COLORS.STOPPED);
    await interaction.update({ embeds: [embed], components: [buildDisabledRow()] });
    pending.resolve({ behavior: 'deny', message: 'User denied via Discord' });
  }
}

function buildDisabledRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('a4d:perm:x:allow').setLabel('Allow').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId('a4d:perm:x:always').setLabel('Always Allow').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('a4d:perm:x:deny').setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId('a4d:perm:x:details').setLabel('Details').setStyle(ButtonStyle.Secondary).setDisabled(true),
  );
}
