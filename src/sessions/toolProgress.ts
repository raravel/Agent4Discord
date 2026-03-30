import { EmbedBuilder, type TextChannel } from 'discord.js';
import { COLORS } from '../formatters/embedBuilder.js';

export class ToolProgressHandler {
  private channel: TextChannel;
  private messageId: string | null = null;
  private startTime = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private toolName: string;

  constructor(channel: TextChannel, toolName: string) {
    this.channel = channel;
    this.toolName = toolName;
  }

  update(): void {
    // Debounce at ~3s
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 3000);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const embed = new EmbedBuilder()
      .setTitle(`Executing: ${this.toolName}`)
      .setColor(COLORS.TOOL_PROGRESS)
      .setFooter({ text: `${elapsed}s` });
    await this.sendOrEdit(embed);
  }

  private async sendOrEdit(embed: EmbedBuilder): Promise<void> {
    try {
      if (this.messageId) {
        const msg = await this.channel.messages.fetch(this.messageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          return;
        }
      }
      const msg = await this.channel.send({ embeds: [embed] });
      this.messageId = msg.id;
    } catch (err) {
      console.error('[tool-progress] Failed to update embed:', err);
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Delete the progress embed (tool result will replace it)
    if (this.messageId) {
      try {
        const msg = await this.channel.messages.fetch(this.messageId).catch(() => null);
        if (msg) await msg.delete().catch(() => {});
      } catch {
        /* best-effort */
      }
    }
  }

  getMessageId(): string | null {
    return this.messageId;
  }
}
