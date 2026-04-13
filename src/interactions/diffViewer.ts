import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  getDiffs,
  clearDiffs,
  type FileDiff,
} from '../sessions/changeTracker.js';
import { displayPath } from './directoryBrowser.js';

const MAX_EMBED_DESC = 4096;
const SAFETY_MARGIN = 100;
const MAX_LABEL_LENGTH = 95;

// ---------------------------------------------------------------------------
// State  (encoded in embed footer: "f{fileIndex} | p{page}")
// ---------------------------------------------------------------------------

interface DiffState {
  fileIndex: number;
  page: number;
}

function parseState(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): DiffState {
  const text = interaction.message.embeds[0]?.footer?.text ?? '';
  const fMatch = text.match(/f(\d+)/);
  const pMatch = text.match(/p(\d+)/);
  return {
    fileIndex: fMatch ? parseInt(fMatch[1], 10) : 0,
    page: pMatch ? parseInt(pMatch[1], 10) : 0,
  };
}

// ---------------------------------------------------------------------------
// Build diff lines for a file (all changes flattened to individual lines)
// ---------------------------------------------------------------------------

function buildDiffLines(fileDiff: FileDiff): string[] {
  const lines: string[] = [];

  for (let i = 0; i < fileDiff.changes.length; i++) {
    const change = fileDiff.changes[i];

    // Separator between changes
    if (lines.length > 0) lines.push('');

    // Hunk header
    lines.push(
      change.type === 'edit'
        ? `@@ Edit ${i + 1} @@`
        : '@@ File Written @@',
    );

    if (change.type === 'edit') {
      for (const line of change.oldString.split('\n')) {
        lines.push(`- ${line}`);
      }
      for (const line of change.newString.split('\n')) {
        lines.push(`+ ${line}`);
      }
    } else {
      for (const line of change.content.split('\n')) {
        lines.push(`+ ${line}`);
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Compute line-level page boundaries
// ---------------------------------------------------------------------------

function computePageBoundaries(lines: string[], budget: number): number[] {
  const boundaries: number[] = [0];
  let used = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1; // +1 for \n

    if (used + lineLen > budget && used > 0) {
      boundaries.push(i);
      used = lineLen;
    } else {
      used += lineLen;
    }
  }

  return boundaries;
}

// ---------------------------------------------------------------------------
// Build the diff viewer message
// ---------------------------------------------------------------------------

export function buildDiffMessage(
  diffs: FileDiff[],
  fileIndex: number,
  page: number,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const safeFileIdx = Math.max(0, Math.min(fileIndex, diffs.length - 1));
  const fileDiff = diffs[safeFileIdx];

  // Totals
  let totalEdits = 0;
  let totalWrites = 0;
  for (const d of diffs) {
    for (const c of d.changes) {
      if (c.type === 'edit') totalEdits++;
      else totalWrites++;
    }
  }

  // --- Select menu (file list) ---
  const select = new StringSelectMenuBuilder()
    .setCustomId('a4d:diff:file')
    .setPlaceholder('Select a file...');

  for (let i = 0; i < Math.min(diffs.length, 25); i++) {
    const d = diffs[i];
    const edits = d.changes.filter((c) => c.type === 'edit').length;
    const writes = d.changes.filter((c) => c.type === 'write').length;
    const parts: string[] = [];
    if (edits > 0) parts.push(`${edits} edit${edits > 1 ? 's' : ''}`);
    if (writes > 0) parts.push('written');

    const icon = writes > 0 && edits === 0 ? '\uD83D\uDCDD' : '\u270F\uFE0F';
    select.addOptions({
      label: `${icon} ${path.basename(d.filePath)}`.slice(0, MAX_LABEL_LENGTH),
      description: parts.join(', '),
      value: String(i),
      default: i === safeFileIdx,
    });
  }

  const selectRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      select,
    );

  // --- Diff content for the selected file (line-level pagination) ---
  const fileName = path.basename(fileDiff.filePath);
  const dirName = displayPath(path.dirname(fileDiff.filePath));
  const prefix = `**${fileName}** \`${dirName}\`\n\`\`\`diff\n`;
  const suffix = '\n```';
  const budget = MAX_EMBED_DESC - SAFETY_MARGIN - prefix.length - suffix.length;

  const allLines = buildDiffLines(fileDiff);
  const boundaries = computePageBoundaries(allLines, budget);
  const totalPages = boundaries.length;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const startLine = boundaries[safePage];
  const endLine =
    safePage + 1 < totalPages ? boundaries[safePage + 1] : allLines.length;

  const diffContent = allLines.slice(startLine, endLine).join('\n');
  const description = `${prefix}${diffContent}${suffix}`;

  // Title
  const titleParts: string[] = [];
  if (totalEdits > 0)
    titleParts.push(`${totalEdits} edit${totalEdits > 1 ? 's' : ''}`);
  if (totalWrites > 0)
    titleParts.push(`${totalWrites} write${totalWrites > 1 ? 's' : ''}`);

  const embed = new EmbedBuilder()
    .setTitle(
      `\uD83D\uDCCA Changes \u2014 ${diffs.length} file${diffs.length > 1 ? 's' : ''}, ${titleParts.join(', ')}`,
    )
    .setDescription(description)
    .setColor(0xf39c12)
    .setFooter({ text: `f${safeFileIdx} | p${safePage}` });

  // --- Buttons ---
  const buttonRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('a4d:diff:prev')
        .setLabel('\u25C0')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId('a4d:diff:pageinfo')
        .setLabel(`${safePage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('a4d:diff:next')
        .setLabel('\u25B6')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId('a4d:diff:close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger),
    );

  return { embeds: [embed], components: [selectRow, buttonRow] };
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

/** File select menu — switch to a different file's diff. */
export async function handleDiffFileSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const threadId = interaction.channel?.id;
  if (!threadId) return;

  const diffs = getDiffs(threadId);
  if (!diffs) {
    await interaction.reply({ content: 'Diff data expired.', ephemeral: true });
    return;
  }

  const fileIndex = parseInt(interaction.values[0], 10);
  const message = buildDiffMessage(diffs, fileIndex, 0);
  await interaction.update(message);
}

/** Previous page of diff content. */
export async function handleDiffPrev(
  interaction: ButtonInteraction,
): Promise<void> {
  const threadId = interaction.channel?.id;
  if (!threadId) return;

  const diffs = getDiffs(threadId);
  if (!diffs) {
    await interaction.reply({ content: 'Diff data expired.', ephemeral: true });
    return;
  }

  const state = parseState(interaction);
  const message = buildDiffMessage(diffs, state.fileIndex, state.page - 1);
  await interaction.update(message);
}

/** Next page of diff content. */
export async function handleDiffNext(
  interaction: ButtonInteraction,
): Promise<void> {
  const threadId = interaction.channel?.id;
  if (!threadId) return;

  const diffs = getDiffs(threadId);
  if (!diffs) {
    await interaction.reply({ content: 'Diff data expired.', ephemeral: true });
    return;
  }

  const state = parseState(interaction);
  const message = buildDiffMessage(diffs, state.fileIndex, state.page + 1);
  await interaction.update(message);
}

/** Close the diff viewer thread. */
export async function handleDiffClose(
  interaction: ButtonInteraction,
): Promise<void> {
  const thread = interaction.channel;
  if (thread?.isThread()) {
    clearDiffs(thread.id);
    await interaction.deferUpdate();
    await thread.delete().catch(() => {});
  } else {
    await interaction.reply({
      content: 'Cannot close \u2014 not in a thread.',
      ephemeral: true,
    });
  }
}
