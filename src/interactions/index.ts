import type { ButtonInteraction, MessageComponentInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import {
  handleCreateDir,
  handleCreateDirSubmit,
  handleDirectoryBrowse,
  handleDirectoryCancel,
  handleDirectoryNext,
  handleDirectoryParent,
  handleDirectoryPrev,
  handleModelCancel,
  handleModelConfirm,
  handleModelSelect,
  handlePermModeSelect,
  handleResumeBack,
  handleResumeBrowse,
  handleResumeSession,
  handleResumeStart,
  handleSessionStart,
} from './directoryBrowser.js';
import { handlePermission } from './permissionHandler.js';
import {
  handleFbBrowse,
  handleFbClose,
  handleFbBack,
  handleFbDownload,
  handleFbFilePrev,
  handleFbFileNext,
  handleFbNext,
  handleFbParent,
  handleFbPrev,
} from './fileBrowser.js';
import {
  handleDiffFileSelect,
  handleDiffPrev,
  handleDiffNext,
  handleDiffClose,
} from './diffViewer.js';
import { handlePermissionModeChange } from '../commands/permission.js';
import { handleUsageRefresh } from '../sessions/usageTracker.js';

/**
 * Route component interactions (buttons, select menus) based on customId prefix.
 */
export async function routeInteraction(
  interaction: MessageComponentInteraction
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('a4d:dir:')) {
    switch (customId) {
      case 'a4d:dir:browse':
        await handleDirectoryBrowse(interaction as StringSelectMenuInteraction);
        return;
      case 'a4d:dir:parent':
        await handleDirectoryParent(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:start':
        await handleSessionStart(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:resume':
        await handleResumeSession(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:cancel':
        await handleDirectoryCancel(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:prev':
        await handleDirectoryPrev(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:next':
        await handleDirectoryNext(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:create':
        await handleCreateDir(interaction as ButtonInteraction);
        return;
      case 'a4d:dir:pageinfo':
        await interaction.deferUpdate();
        return;
      default:
        await interaction.reply({ content: 'Unknown directory browser action.', ephemeral: true });
        return;
    }
  }

  if (customId.startsWith('a4d:model:')) {
    switch (customId) {
      case 'a4d:model:select':
        await handleModelSelect(interaction as StringSelectMenuInteraction);
        return;
      case 'a4d:model:confirm':
        await handleModelConfirm(interaction as ButtonInteraction);
        return;
      case 'a4d:model:cancel':
        await handleModelCancel(interaction as ButtonInteraction);
        return;
      default:
        await interaction.reply({ content: 'Unknown model selection action.', ephemeral: true });
        return;
    }
  }

  if (customId === 'a4d:perm-mode:select') {
    await handlePermModeSelect(interaction as StringSelectMenuInteraction);
    return;
  }

  if (customId === 'a4d:permc:select') {
    await handlePermissionModeChange(interaction as StringSelectMenuInteraction);
    return;
  }

  if (customId.startsWith('a4d:fb:')) {
    switch (customId) {
      case 'a4d:fb:browse':
        await handleFbBrowse(interaction as StringSelectMenuInteraction);
        return;
      case 'a4d:fb:parent':
        await handleFbParent(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:prev':
        await handleFbPrev(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:next':
        await handleFbNext(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:back':
        await handleFbBack(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:fprev':
        await handleFbFilePrev(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:fnext':
        await handleFbFileNext(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:download':
        await handleFbDownload(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:close':
        await handleFbClose(interaction as ButtonInteraction);
        return;
      case 'a4d:fb:pageinfo':
      case 'a4d:fb:fpageinfo':
        await interaction.deferUpdate();
        return;
      default:
        await interaction.reply({ content: 'Unknown file browser action.', ephemeral: true });
        return;
    }
  }

  if (customId.startsWith('a4d:diff:')) {
    switch (customId) {
      case 'a4d:diff:file':
        await handleDiffFileSelect(interaction as StringSelectMenuInteraction);
        return;
      case 'a4d:diff:prev':
        await handleDiffPrev(interaction as ButtonInteraction);
        return;
      case 'a4d:diff:next':
        await handleDiffNext(interaction as ButtonInteraction);
        return;
      case 'a4d:diff:close':
        await handleDiffClose(interaction as ButtonInteraction);
        return;
      case 'a4d:diff:pageinfo':
        await interaction.deferUpdate();
        return;
      default:
        await interaction.reply({ content: 'Unknown diff action.', ephemeral: true });
        return;
    }
  }

  if (customId === 'a4d:usage:refresh') {
    await handleUsageRefresh(interaction as ButtonInteraction);
    return;
  }

  if (customId.startsWith('a4d:perm:')) {
    await handlePermission(interaction as ButtonInteraction);
    return;
  }

  if (customId.startsWith('a4d:resume:')) {
    switch (customId) {
      case 'a4d:resume:browse':
        await handleResumeBrowse(interaction as StringSelectMenuInteraction);
        return;
      case 'a4d:resume:back':
        await handleResumeBack(interaction as ButtonInteraction);
        return;
      case 'a4d:resume:start':
        await handleResumeStart(interaction as ButtonInteraction);
        return;
      default:
        await interaction.reply({ content: 'Unknown resume action.', ephemeral: true });
        return;
    }
  }

  console.warn(`[interactions] Unknown customId: ${customId}`);
  await interaction.reply({ content: 'Unknown interaction.', ephemeral: true });
}

/**
 * Route modal submit interactions based on customId prefix.
 */
export async function routeModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;

  if (customId.startsWith('a4d:dir:create-modal')) {
    await handleCreateDirSubmit(interaction);
    return;
  }

  console.warn(`[interactions] Unknown modal customId: ${customId}`);
  await interaction.reply({ content: 'Unknown modal submission.', ephemeral: true });
}
