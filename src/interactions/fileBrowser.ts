import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  listEntries,
  readFileContent,
  getLanguageTag,
  formatFileSize,
  type DirEntry,
} from '../utils/filesystem.js';
import { displayPath } from './directoryBrowser.js';

const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL_LENGTH = 95;
const MAX_EMBED_DESC = 4096;
const SAFETY_MARGIN = 150;

// ---------------------------------------------------------------------------
// State (encoded in embed footer)
// ---------------------------------------------------------------------------
//   Dir  mode: "{absolutePath} | p{page}"
//   File mode: "{absoluteFilePath} | fp{page} | {parentDir}"

interface BrowserState {
  mode: 'dir' | 'file';
  path: string;
  page: number;
  parentDir?: string;
}

function parseState(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): BrowserState {
  const text = interaction.message.embeds[0]?.footer?.text ?? '';

  // File mode — look for " | fp"
  const fpIdx = text.lastIndexOf(' | fp');
  if (fpIdx !== -1) {
    const filePath = text.slice(0, fpIdx);
    const rest = text.slice(fpIdx + 5); // after " | fp"
    const pipeIdx = rest.indexOf(' | ');
    const page = parseInt(pipeIdx !== -1 ? rest.slice(0, pipeIdx) : rest, 10) || 0;
    const parentDir = pipeIdx !== -1 ? rest.slice(pipeIdx + 3) : path.dirname(filePath);
    return { mode: 'file', path: filePath, page, parentDir };
  }

  // Dir mode — look for " | p"
  const pIdx = text.lastIndexOf(' | p');
  if (pIdx !== -1) {
    const dirPath = text.slice(0, pIdx);
    const page = parseInt(text.slice(pIdx + 4), 10) || 0;
    return { mode: 'dir', path: dirPath, page };
  }

  return { mode: 'dir', path: os.homedir(), page: 0 };
}

// ---------------------------------------------------------------------------
// Directory listing view
// ---------------------------------------------------------------------------

export async function buildDirMessage(
  dirPath: string,
  page = 0,
): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const resolved = path.resolve(dirPath);

  let entries: DirEntry[];
  try {
    entries = await listEntries(resolved);
  } catch {
    entries = [];
  }

  const embed = new EmbedBuilder()
    .setTitle(`\uD83D\uDCC2 ${displayPath(resolved)}`)
    .setColor(0x5865f2)
    .setFooter({ text: `${resolved} | p${page}` });

  const select = new StringSelectMenuBuilder()
    .setCustomId('a4d:fb:browse')
    .setPlaceholder('Select a file or directory...');

  if (entries.length === 0) {
    select.addOptions({ label: 'Empty directory', value: '_none', default: true });
    select.setDisabled(true);
    embed.setDescription('No files or directories found.');
  } else {
    const paged = entries.slice(
      page * MAX_SELECT_OPTIONS,
      (page + 1) * MAX_SELECT_OPTIONS,
    );

    for (let i = 0; i < paged.length; i++) {
      const e = paged[i];
      const icon = e.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
      select.addOptions({
        label: `${icon} ${e.name}`.slice(0, MAX_LABEL_LENGTH),
        description: e.isDirectory ? 'Directory' : formatFileSize(e.size),
        value: String(i),
      });
    }

    const totalDirs = entries.filter((e) => e.isDirectory).length;
    const totalFiles = entries.filter((e) => !e.isDirectory).length;
    embed.setDescription(`${totalDirs} directories, ${totalFiles} files`);
  }

  const selectRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);

  const atRoot = path.dirname(resolved) === resolved;
  const buttonRow =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('a4d:fb:parent')
        .setLabel('Parent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(atRoot),
      new ButtonBuilder()
        .setCustomId('a4d:fb:close')
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger),
    );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    selectRow,
    buttonRow,
  ];

  const totalPages = Math.max(1, Math.ceil(entries.length / MAX_SELECT_OPTIONS));
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('a4d:fb:prev')
          .setLabel('\u25C0')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId('a4d:fb:pageinfo')
          .setLabel(`${page + 1}/${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('a4d:fb:next')
          .setLabel('\u25B6')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      ),
    );
  }

  return { embeds: [embed], components };
}

// ---------------------------------------------------------------------------
// File content view  (paginated code blocks)
// ---------------------------------------------------------------------------

interface PageInfo {
  boundaries: number[]; // start line index for each page
  lines: string[];
  lang: string;
  header: string;
  gutterWidth: number;
}

const pageCache = new Map<string, PageInfo>();

function computePageInfo(
  filePath: string,
  content: string,
  sizeBytes: number,
): PageInfo {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const lang = getLanguageTag(filePath);
  const fileName = path.basename(filePath);
  const header = `**${fileName}** (${lines.length} lines, ${formatFileSize(sizeBytes)})`;

  const codeBlockOverhead = 3 + lang.length + 1 + 4; // ```lang\n + \n```
  const budget =
    MAX_EMBED_DESC - SAFETY_MARGIN - header.length - 1 - codeBlockOverhead;

  const gutterWidth = Math.max(String(lines.length).length, 1);

  const boundaries: number[] = [0];
  let used = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(i + 1).padStart(gutterWidth, ' ');
    const rendered = `${lineNum} \u2502 ${lines[i]}\n`;

    if (used + rendered.length > budget && used > 0) {
      boundaries.push(i);
      used = rendered.length;
    } else {
      used += rendered.length;
    }
  }

  return { boundaries, lines, lang, header, gutterWidth };
}

export async function buildFileMessage(
  filePath: string,
  page: number,
  parentDir: string,
): Promise<{
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}> {
  const resolved = path.resolve(filePath);

  // Read file
  let result: Awaited<ReturnType<typeof readFileContent>>;
  try {
    result = await readFileContent(resolved);
  } catch {
    result = { error: 'Failed to read file.' };
  }

  if ('error' in result) {
    const embed = new EmbedBuilder()
      .setTitle(`\uD83D\uDCC4 ${path.basename(resolved)}`)
      .setDescription(result.error)
      .setColor(0xe74c3c)
      .setFooter({ text: `${resolved} | fp0 | ${parentDir}` });

    const row =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('a4d:fb:back')
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('a4d:fb:close')
          .setLabel('Close')
          .setStyle(ButtonStyle.Danger),
      );

    return { embeds: [embed], components: [row] };
  }

  const { content, sizeBytes } = result;

  // Empty file
  if (!content.trim()) {
    const embed = new EmbedBuilder()
      .setTitle(`\uD83D\uDCC4 ${path.basename(resolved)}`)
      .setDescription('*Empty file*')
      .setColor(0x95a5a6)
      .setFooter({ text: `${resolved} | fp0 | ${parentDir}` });

    const row =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('a4d:fb:back')
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('a4d:fb:close')
          .setLabel('Close')
          .setStyle(ButtonStyle.Danger),
      );

    return { embeds: [embed], components: [row] };
  }

  // Compute or retrieve page info
  let info = pageCache.get(resolved);
  if (!info) {
    info = computePageInfo(resolved, content, sizeBytes);
    pageCache.set(resolved, info);
  }

  const { boundaries, lines, lang, header, gutterWidth } = info;
  const totalPages = boundaries.length;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const startLine = boundaries[safePage];
  const endLine =
    safePage + 1 < totalPages ? boundaries[safePage + 1] : lines.length;

  // Build code block content with truncation safety
  const codeStart = `\`\`\`${lang}\n`;
  const codeEnd = '\n```';
  const descBudget = MAX_EMBED_DESC - SAFETY_MARGIN;
  const preamble = `${header}\n${codeStart}`;
  const available = descBudget - preamble.length - codeEnd.length;

  let codeContent = '';
  for (let i = startLine; i < endLine; i++) {
    const lineNum = String(i + 1).padStart(gutterWidth, ' ');
    const rendered = `${lineNum} \u2502 ${lines[i]}\n`;

    if (codeContent.length + rendered.length > available) {
      if (codeContent.length === 0) {
        // Single oversized line — truncate it
        codeContent = rendered.slice(0, available - 2) + '\u2026\n';
      }
      break;
    }
    codeContent += rendered;
  }

  const description = `${preamble}${codeContent}${codeEnd}`;

  const embed = new EmbedBuilder()
    .setTitle(
      `\uD83D\uDCC4 ${path.basename(resolved)} (${startLine + 1}-${endLine}/${lines.length})`,
    )
    .setDescription(description)
    .setColor(0x2ecc71)
    .setFooter({ text: `${resolved} | fp${safePage} | ${parentDir}` });

  const row =
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('a4d:fb:back')
        .setLabel('Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('a4d:fb:fprev')
        .setLabel('\u25C0')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId('a4d:fb:fpageinfo')
        .setLabel(`${safePage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('a4d:fb:fnext')
        .setLabel('\u25B6')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId('a4d:fb:download')
        .setLabel('\uD83D\uDCCE')
        .setStyle(ButtonStyle.Primary),
    );

  return { embeds: [embed], components: [row] };
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

/** Select menu — navigate into directory or open file. */
export async function handleFbBrowse(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const selected = interaction.values[0];
  if (!selected || selected === '_none') {
    await interaction.deferUpdate();
    return;
  }

  const idx = parseInt(selected, 10);

  let entries: DirEntry[];
  try {
    entries = await listEntries(state.path);
  } catch {
    await interaction.reply({
      content: 'Cannot read directory.',
      ephemeral: true,
    });
    return;
  }

  const actualIdx = state.page * MAX_SELECT_OPTIONS + idx;
  if (actualIdx >= entries.length) {
    await interaction.reply({ content: 'Entry not found.', ephemeral: true });
    return;
  }

  const entry = entries[actualIdx];
  const fullPath = path.join(state.path, entry.name);

  if (entry.isDirectory) {
    const message = await buildDirMessage(fullPath, 0);
    await interaction.update(message);
  } else {
    const message = await buildFileMessage(fullPath, 0, state.path);
    await interaction.update(message);
  }
}

/** Navigate to parent directory. */
export async function handleFbParent(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const parent = path.dirname(state.path);
  if (parent === state.path) {
    await interaction.deferUpdate();
    return;
  }
  const message = await buildDirMessage(parent, 0);
  await interaction.update(message);
}

/** Previous page of directory entries. */
export async function handleFbPrev(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const message = await buildDirMessage(state.path, Math.max(0, state.page - 1));
  await interaction.update(message);
}

/** Next page of directory entries. */
export async function handleFbNext(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const message = await buildDirMessage(state.path, state.page + 1);
  await interaction.update(message);
}

/** Return from file view to directory listing. */
export async function handleFbBack(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const dir = state.parentDir || path.dirname(state.path);
  pageCache.delete(state.path);
  const message = await buildDirMessage(dir, 0);
  await interaction.update(message);
}

/** Previous page of file content. */
export async function handleFbFilePrev(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const parentDir = state.parentDir || path.dirname(state.path);
  const message = await buildFileMessage(state.path, state.page - 1, parentDir);
  await interaction.update(message);
}

/** Next page of file content. */
export async function handleFbFileNext(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  const parentDir = state.parentDir || path.dirname(state.path);
  const message = await buildFileMessage(state.path, state.page + 1, parentDir);
  await interaction.update(message);
}

/** Download the current file as a Discord attachment. */
export async function handleFbDownload(
  interaction: ButtonInteraction,
): Promise<void> {
  const state = parseState(interaction);
  try {
    const buffer = await fsPromises.readFile(state.path);
    const attachment = new AttachmentBuilder(buffer, {
      name: path.basename(state.path),
    });
    await interaction.reply({ files: [attachment], ephemeral: true });
  } catch {
    await interaction.reply({
      content: 'Failed to read file.',
      ephemeral: true,
    });
  }
}

/** Close the file browser thread. */
export async function handleFbClose(
  interaction: ButtonInteraction,
): Promise<void> {
  const thread = interaction.channel;
  if (thread?.isThread()) {
    await interaction.deferUpdate();
    await thread.delete().catch(() => {});
  } else {
    await interaction.reply({
      content: 'Cannot close — not in a thread.',
      ephemeral: true,
    });
  }
}
