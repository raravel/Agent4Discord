import os from 'node:os';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { listSessions, getSessionMessages, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { isPathSafe, listDirectories } from '../utils/filesystem.js';
import { chunkMessage } from '../formatters/chunker.js';
import { loadGuildConfig } from '../guild.js';
import { sessionManager } from '../sessions/sessionManager.js';
import { saveSessionToGuild } from '../sessions/sessionStore.js';
import { buildStatusEmbed, COLORS } from '../formatters/embedBuilder.js';
import { requestPermission } from './permissionHandler.js';

const HOMEDIR = os.homedir();
const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL_LENGTH = 95;
const MAX_VALUE_LENGTH = 100;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

interface FooterState {
  path: string;
  page: number;
  mode?: 'browse' | 'resume';
  selectedSessionId?: string;
}

function parseFooterState(interaction: ButtonInteraction | StringSelectMenuInteraction): FooterState {
  const text = interaction.message.embeds[0]?.footer?.text ?? '';

  // New format: "path | pN" or "path | pN | mode:resume | sid:xxx"
  const pipeIdx = text.lastIndexOf(' | p');
  if (pipeIdx !== -1) {
    const pathPart = text.slice(0, pipeIdx);
    const rest = text.slice(pipeIdx + 4); // after " | p"
    const segments = rest.split(' | ');
    const page = parseInt(segments[0], 10) || 0;
    let mode: 'browse' | 'resume' | undefined;
    let selectedSessionId: string | undefined;
    for (const seg of segments) {
      if (seg.startsWith('mode:')) mode = seg.slice(5) as 'browse' | 'resume';
      if (seg.startsWith('sid:')) selectedSessionId = seg.slice(4);
    }
    return { path: pathPart, page, mode, selectedSessionId };
  }

  // Legacy JSON format
  try {
    const parsed = JSON.parse(text) as FooterState;
    if (typeof parsed.path === 'string') {
      return {
        path: parsed.path,
        page: typeof parsed.page === 'number' ? parsed.page : 0,
        mode: parsed.mode,
        selectedSessionId: parsed.selectedSessionId,
      };
    }
  } catch {
    // ignore
  }

  return { path: HOMEDIR, page: 0 };
}

export function displayPath(fullPath: string): string {
  if (fullPath === HOMEDIR) return '~';
  if (fullPath.startsWith(HOMEDIR + path.sep)) {
    return '~' + fullPath.slice(HOMEDIR.length).replaceAll('\\', '/');
  }
  return fullPath;
}

// ---------------------------------------------------------------------------
// Build browser message
// ---------------------------------------------------------------------------

/**
 * Build the directory browser message with embed, select menu, and buttons.
 */
export async function buildBrowserMessage(
  dirPath: string,
  page = 0,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] }> {
  const resolvedPath = path.resolve(dirPath);

  // Embed -- footer encodes state as "path | pN"
  const embed = new EmbedBuilder()
    .setTitle('Select Working Directory')
    .setDescription(resolvedPath)
    .setFooter({ text: `${resolvedPath} | p${page}` })
    .setColor(0x5865f2);

  // Fetch subdirectories
  let dirs: string[];
  try {
    dirs = await listDirectories(resolvedPath);
  } catch {
    dirs = [];
  }

  // Build select menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('a4d:dir:browse')
    .setPlaceholder('Select a directory...');

  if (dirs.length === 0) {
    selectMenu.addOptions({
      label: 'No subdirectories',
      value: '_none',
      default: true,
    });
    selectMenu.setDisabled(true);
  } else {
    const pagedDirs = dirs.slice(page * MAX_SELECT_OPTIONS, (page + 1) * MAX_SELECT_OPTIONS);
    for (const dir of pagedDirs) {
      const fullPath = path.join(resolvedPath, dir);
      const label = dir.length > MAX_LABEL_LENGTH ? dir.slice(0, MAX_LABEL_LENGTH) : dir;
      const value = fullPath.length > MAX_VALUE_LENGTH ? fullPath.slice(0, MAX_VALUE_LENGTH) : fullPath;
      selectMenu.addOptions({ label, value });
    }
  }

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(selectMenu);

  // Buttons
  const atRoot = path.dirname(resolvedPath) === resolvedPath;

  const parentButton = new ButtonBuilder()
    .setCustomId('a4d:dir:parent')
    .setLabel('Parent')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(atRoot);

  const startButton = new ButtonBuilder()
    .setCustomId('a4d:dir:start')
    .setLabel('Session Start')
    .setStyle(ButtonStyle.Success);

  const resumeButton = new ButtonBuilder()
    .setCustomId('a4d:dir:resume')
    .setLabel('Resume Session')
    .setStyle(ButtonStyle.Primary);

  const cancelButton = new ButtonBuilder()
    .setCustomId('a4d:dir:cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);

  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    parentButton,
    startButton,
    resumeButton,
    cancelButton,
  );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [selectRow, buttonRow];

  // Pagination row (only when >25 directories)
  const totalPages = Math.max(1, Math.ceil(dirs.length / MAX_SELECT_OPTIONS));
  if (totalPages > 1) {
    const prevButton = new ButtonBuilder()
      .setCustomId('a4d:dir:prev')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0);

    const pageInfo = new ButtonBuilder()
      .setCustomId('a4d:dir:pageinfo')
      .setLabel(`Page ${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextButton = new ButtonBuilder()
      .setCustomId('a4d:dir:next')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1);

    const paginationRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      prevButton,
      pageInfo,
      nextButton,
    );

    components.push(paginationRow);
  }

  return { embeds: [embed], components };
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

/**
 * Handle directory selection from the StringSelectMenu.
 */
export async function handleDirectoryBrowse(interaction: StringSelectMenuInteraction): Promise<void> {
  const selected = interaction.values[0];
  if (!selected || selected === '_none') return;

  if (!isPathSafe(selected)) {
    await interaction.reply({ content: 'Invalid directory path.', ephemeral: true });
    return;
  }

  const message = await buildBrowserMessage(selected);
  await interaction.update(message);
}

/**
 * Handle the "Parent" button -- navigate to the parent directory.
 */
export async function handleDirectoryParent(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const parent = path.dirname(state.path);

  if (parent === state.path) {
    // Already at filesystem root
    await interaction.deferUpdate();
    return;
  }

  const message = await buildBrowserMessage(parent);
  await interaction.update(message);
}

/**
 * Handle the "Cancel" button -- reset to home directory.
 */
export async function handleDirectoryCancel(interaction: ButtonInteraction): Promise<void> {
  const message = await buildBrowserMessage(HOMEDIR);
  await interaction.update(message);
}

/**
 * Handle the "Previous" pagination button.
 */
export async function handleDirectoryPrev(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const newPage = Math.max(0, state.page - 1);
  const message = await buildBrowserMessage(state.path, newPage);
  await interaction.update(message);
}

/**
 * Handle the "Next" pagination button.
 */
export async function handleDirectoryNext(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const message = await buildBrowserMessage(state.path, state.page + 1);
  await interaction.update(message);
}

const MAX_SESSIONS_PER_USER = 3;

/**
 * Handle the "Session Start" button -- show ephemeral model selection message.
 */
export async function handleSessionStart(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
    return;
  }

  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({ content: 'A4D is not set up in this server. Run `/a4d init` first.', ephemeral: true });
    return;
  }

  // Enforce concurrent session limit
  const userSessions = sessionManager.getAllSessions().filter(
    (s) => s.userId === interaction.user.id && s.guildId === guild.id,
  );
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    await interaction.reply({
      content: `You already have ${MAX_SESSIONS_PER_USER} active sessions. Stop one before starting a new one.`,
      ephemeral: true,
    });
    return;
  }

  // Show ephemeral model picker instead of immediately creating the session
  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId('a4d:model:select')
    .setPlaceholder('Select a model...')
    .addOptions(
      { label: 'Opus 4.6 (most capable)', value: 'opus', default: true },
      { label: 'Sonnet 4.6 (fast)', value: 'sonnet' },
      { label: 'Haiku 4.5 (fastest)', value: 'haiku' },
    );

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(modelSelect);

  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('a4d:model:confirm').setLabel('Start Session').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('a4d:model:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle('Select Model')
    .setDescription('Choose the Claude model for this session.')
    .setFooter({ text: `${state.path} | model:opus` })
    .setColor(0x5865f2);

  await interaction.reply({
    embeds: [embed],
    components: [selectRow, buttonRow],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// Model footer parser
// ---------------------------------------------------------------------------

function parseModelFooter(interaction: ButtonInteraction | StringSelectMenuInteraction): { path: string; model: string } {
  const text = interaction.message.embeds[0]?.footer?.text ?? '';
  const parts = text.split(' | ');
  const pathValue = parts[0] || os.homedir();
  let model = 'opus';
  for (const part of parts) {
    if (part.startsWith('model:')) model = part.slice(6);
  }
  return { path: pathValue, model };
}

// ---------------------------------------------------------------------------
// Model selection handlers
// ---------------------------------------------------------------------------

/**
 * Handle model select menu -- update the embed footer with the chosen model.
 */
export async function handleModelSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const selected = interaction.values[0];
  if (!selected) return;

  const { path: cwdPath } = parseModelFooter(interaction);

  const modelLabels: Record<string, string> = {
    opus: 'Opus 4.6 (most capable)',
    sonnet: 'Sonnet 4.6 (fast)',
    haiku: 'Haiku 4.5 (fastest)',
  };

  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId('a4d:model:select')
    .setPlaceholder('Select a model...')
    .addOptions(
      { label: 'Opus 4.6 (most capable)', value: 'opus', default: selected === 'opus' },
      { label: 'Sonnet 4.6 (fast)', value: 'sonnet', default: selected === 'sonnet' },
      { label: 'Haiku 4.5 (fastest)', value: 'haiku', default: selected === 'haiku' },
    );

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(modelSelect);

  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('a4d:model:confirm').setLabel('Start Session').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('a4d:model:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle('Select Model')
    .setDescription(`Choose the Claude model for this session.\nSelected: **${modelLabels[selected] ?? selected}**`)
    .setFooter({ text: `${cwdPath} | model:${selected}` })
    .setColor(0x5865f2);

  await interaction.update({
    embeds: [embed],
    components: [selectRow, buttonRow],
  });
}

/**
 * Handle model confirm button -- create session channel and start a Claude Code session.
 */
export async function handleModelConfirm(interaction: ButtonInteraction): Promise<void> {
  const { path: cwdPath, model } = parseModelFooter(interaction);
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
    return;
  }

  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({ content: 'A4D is not set up in this server. Run `/a4d init` first.', ephemeral: true });
    return;
  }

  // Re-check concurrent session limit
  const userSessions = sessionManager.getAllSessions().filter(
    (s) => s.userId === interaction.user.id && s.guildId === guild.id,
  );
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    await interaction.update({
      content: `You already have ${MAX_SESSIONS_PER_USER} active sessions. Stop one before starting a new one.`,
      embeds: [],
      components: [],
    });
    return;
  }

  // Acknowledge -- channel creation + session start may take >3s
  await interaction.update({
    content: 'Creating session...',
    embeds: [],
    components: [],
  });

  try {
    // Create session channel under Sessions category
    const dirName = path.basename(cwdPath) || 'home';
    const channel = await guild.channels.create({
      name: `a4d-${dirName}`.slice(0, 100).toLowerCase(),
      type: ChannelType.GuildText,
      parent: guildConfig.sessionsCategoryId,
    });

    // Start Claude Code session with selected model
    const session = sessionManager.createSession(
      guild.id,
      interaction.user.id,
      channel.id,
      cwdPath,
      model,
      async (toolName, input, options) => {
        console.log(`[canUseTool] Called: tool=${toolName}, toolUseID=${options?.toolUseID}`);
        const result = await requestPermission(channel as TextChannel, interaction.user.id, toolName, input);
        console.log(`[canUseTool] Resolved: tool=${toolName}, behavior=${result.behavior}`);
        return result;
      },
      interaction.client,
    );

    // Persist to guild config
    saveSessionToGuild(guild.id, channel.id, session.sessionId || '', cwdPath, interaction.user.id);

    // Post and pin status embed with controls
    const statusEmbed = buildStatusEmbed({
      status: 'Session Active',
      color: COLORS.IDLE,
      cwd: displayPath(cwdPath),
      model,
      sessionId: session.sessionId || 'pending',
      costUsd: 0,
      startedAt: new Date().toISOString(),
    });

    const controlRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('a4d:session:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('a4d:session:archive').setLabel('Archive').setStyle(ButtonStyle.Secondary),
    );

    const statusMsg = await channel.send({ embeds: [statusEmbed], components: [controlRow] });
    await statusMsg.pin().catch((err) => console.warn('[session] Failed to pin status embed:', err.message));

    // Update the ephemeral message with a link to the new channel
    await interaction.editReply({
      content: `Session started in <#${channel.id}>`,
    });
  } catch (err) {
    console.error('[session-start] Failed to create session:', err);
    await interaction.editReply({
      content: 'Failed to create session. Make sure the bot has permission to create channels.',
    });
  }
}

/**
 * Handle model cancel button -- dismiss the ephemeral model picker.
 */
export async function handleModelCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Build resume picker message
// ---------------------------------------------------------------------------

function buildResumePickerMessage(
  dirPath: string,
  sessions: SDKSessionInfo[],
  selectedSessionId?: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] } {
  const footerState: FooterState = {
    path: dirPath,
    page: 0,
    mode: 'resume',
    selectedSessionId,
  };

  const footerText = selectedSessionId
    ? `${dirPath} | p0 | mode:resume | sid:${selectedSessionId}`
    : `${dirPath} | p0 | mode:resume`;

  const embed = new EmbedBuilder()
    .setTitle('Resume Existing Session')
    .setDescription(`Directory: ${displayPath(dirPath)}`)
    .setFooter({ text: footerText })
    .setColor(0x57f287);

  // Sort by most recent first, limit to 25
  const sorted = [...sessions]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, MAX_SELECT_OPTIONS);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('a4d:resume:browse')
    .setPlaceholder('Select a session to resume...');

  for (const sess of sorted) {
    const label = (sess.summary || sess.sessionId).slice(0, MAX_LABEL_LENGTH);
    const description = relativeTime(new Date(sess.lastModified));
    selectMenu.addOptions({
      label,
      description,
      value: sess.sessionId,
      default: sess.sessionId === selectedSessionId,
    });
  }

  const selectRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(selectMenu);

  const backButton = new ButtonBuilder()
    .setCustomId('a4d:resume:back')
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary);

  const resumeStartButton = new ButtonBuilder()
    .setCustomId('a4d:resume:start')
    .setLabel('Resume')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!selectedSessionId);

  const buttonRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    backButton,
    resumeStartButton,
  );

  return { embeds: [embed], components: [selectRow, buttonRow] };
}

// ---------------------------------------------------------------------------
// Resume interaction handlers
// ---------------------------------------------------------------------------

/**
 * Handle the "Resume Session" button -- switch to session picker mode.
 */
export async function handleResumeSession(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);

  let sessions: SDKSessionInfo[];
  try {
    sessions = await listSessions({ dir: state.path, limit: MAX_SELECT_OPTIONS });
  } catch (err) {
    console.error('[resume-session] Failed to list sessions:', err);
    sessions = [];
  }

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No existing sessions for this directory.', ephemeral: true });
    return;
  }

  const message = buildResumePickerMessage(state.path, sessions);
  await interaction.update(message);
}

/**
 * Handle session selection from the resume picker StringSelectMenu.
 */
export async function handleResumeBrowse(interaction: StringSelectMenuInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const selectedId = interaction.values[0];
  if (!selectedId) return;

  // Re-list sessions to rebuild the picker with the selection stored in footer
  let sessions: SDKSessionInfo[];
  try {
    sessions = await listSessions({ dir: state.path, limit: MAX_SELECT_OPTIONS });
  } catch (err) {
    console.error('[resume-browse] Failed to list sessions:', err);
    sessions = [];
  }

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No existing sessions for this directory.', ephemeral: true });
    return;
  }

  const message = buildResumePickerMessage(state.path, sessions, selectedId);
  await interaction.update(message);
}

/**
 * Handle the "Back" button in the resume picker -- return to directory browser.
 */
export async function handleResumeBack(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const message = await buildBrowserMessage(state.path);
  await interaction.update(message);
}

/**
 * Handle the "Resume" button in the resume picker -- resume the selected session.
 */
export async function handleResumeStart(interaction: ButtonInteraction): Promise<void> {
  const state = parseFooterState(interaction);
  const guild = interaction.guild;

  if (!state.selectedSessionId) {
    await interaction.reply({ content: 'No session selected. Please select a session first.', ephemeral: true });
    return;
  }

  if (!guild) {
    await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
    return;
  }

  const guildConfig = loadGuildConfig(guild.id);
  if (!guildConfig) {
    await interaction.reply({ content: 'A4D is not set up in this server. Run `/a4d init` first.', ephemeral: true });
    return;
  }

  // Enforce concurrent session limit
  const userSessions = sessionManager.getAllSessions().filter(
    (s) => s.userId === interaction.user.id && s.guildId === guild.id,
  );
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    await interaction.reply({
      content: `You already have ${MAX_SESSIONS_PER_USER} active sessions. Stop one before resuming another.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    // Create session channel under Sessions category
    const dirName = path.basename(state.path) || 'home';
    const channel = await guild.channels.create({
      name: `a4d-${dirName}`.slice(0, 100).toLowerCase(),
      type: ChannelType.GuildText,
      parent: guildConfig.sessionsCategoryId,
    });

    // Resume Claude Code session
    const session = sessionManager.resumeSession(
      guild.id,
      interaction.user.id,
      channel.id,
      state.selectedSessionId,
      state.path,
      undefined, // model
      async (toolName, input, options) => {
        console.log(`[canUseTool] Called: tool=${toolName}, toolUseID=${options?.toolUseID}`);
        const result = await requestPermission(channel as TextChannel, interaction.user.id, toolName, input);
        console.log(`[canUseTool] Resolved: tool=${toolName}, behavior=${result.behavior}`);
        return result;
      },
      interaction.client,
    );

    // Persist to guild config
    saveSessionToGuild(guild.id, channel.id, session.sessionId, state.path, interaction.user.id);

    // Post and pin status embed with controls
    const statusEmbed = buildStatusEmbed({
      status: 'Session Active',
      color: COLORS.IDLE,
      cwd: displayPath(state.path),
      model: 'opus',
      sessionId: session.sessionId || 'pending',
      costUsd: 0,
      startedAt: new Date().toISOString(),
    });

    const controlRow = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('a4d:session:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('a4d:session:archive').setLabel('Archive').setStyle(ButtonStyle.Secondary),
    );

    const statusMsg = await channel.send({ embeds: [statusEmbed], components: [controlRow] });
    await statusMsg.pin().catch((err) => console.warn('[session] Failed to pin status embed:', err.message));

    // Post previous conversation history
    await postSessionHistory(channel as TextChannel, state.selectedSessionId, state.path);

    // Reset directory browser to home
    const browserMsg = await buildBrowserMessage(HOMEDIR);
    await interaction.editReply(browserMsg);

    // Send followup linking to the new channel
    await interaction.followUp({
      content: `Session resumed in <#${channel.id}>`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('[resume-start] Failed to resume session:', err);
    await interaction.followUp({
      content: 'Failed to resume session. Make sure the bot has permission to create channels.',
      ephemeral: true,
    });
  }
}

/**
 * Load and post previous conversation history into a session channel.
 */
async function postSessionHistory(
  channel: TextChannel,
  sessionId: string,
  cwd: string,
): Promise<void> {
  try {
    const messages = await getSessionMessages(sessionId, { dir: cwd, limit: 50 });
    if (messages.length === 0) return;

    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('Previous Conversation')
        .setDescription(`Showing last ${messages.length} messages from this session.`)
        .setColor(0x95a5a6)],
    });

    for (const msg of messages) {
      const content = msg.message as { role: string; content: unknown };
      let text = '';

      if (typeof content.content === 'string') {
        text = content.content;
      } else if (Array.isArray(content.content)) {
        text = (content.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
      }

      if (!text) continue;

      const prefix = msg.type === 'user' ? '**You:**' : '**Claude:**';
      const full = `${prefix}\n${text}`;
      const chunks = chunkMessage(full);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }

    await channel.send('---\n*Session resumed. You can continue chatting.*');
  } catch (err) {
    console.error('[history] Failed to load session history:', err);
    await channel.send('*Could not load previous conversation history.*').catch(() => {});
  }
}
