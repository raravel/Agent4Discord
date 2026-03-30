import type { ButtonInteraction, MessageComponentInteraction, StringSelectMenuInteraction } from 'discord.js';
import {
  handleDirectoryBrowse,
  handleDirectoryCancel,
  handleDirectoryNext,
  handleDirectoryParent,
  handleDirectoryPrev,
  handleModelCancel,
  handleModelConfirm,
  handleModelSelect,
  handleResumeBack,
  handleResumeBrowse,
  handleResumeSession,
  handleResumeStart,
  handleSessionStart,
} from './directoryBrowser.js';
import { handlePermission } from './permissionHandler.js';
import { handleSessionStop, handleSessionArchive } from './sessionControls.js';

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

  if (customId.startsWith('a4d:session:')) {
    switch (customId) {
      case 'a4d:session:stop':
        await handleSessionStop(interaction as ButtonInteraction);
        return;
      case 'a4d:session:archive':
        await handleSessionArchive(interaction as ButtonInteraction);
        return;
      default:
        await interaction.reply({ content: 'Unknown session control action.', ephemeral: true });
        return;
    }
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
