import { EmbedBuilder, type TextChannel } from 'discord.js';
import { COLORS } from '../formatters/embedBuilder.js';

export class StreamHandler {
  private channel: TextChannel;
  private buffer = '';
  private tokenCount = 0;
  private startTime = Date.now();
  private messageId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private type: 'text' | 'thinking';
  private finalized = false;

  constructor(channel: TextChannel, type: 'text' | 'thinking', debounceMs?: number) {
    this.channel = channel;
    this.type = type;
    this.debounceMs = debounceMs ?? (type === 'text' ? 1000 : 2000);
  }

  push(text: string): void {
    this.buffer += text;
    this.tokenCount++;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    if (this.type === 'text') {
      // Streaming text: yellow embed with accumulated text
      const description =
        this.buffer.length > 4090 ? this.buffer.slice(-4090) + '...' : this.buffer;
      const embed = new EmbedBuilder()
        .setTitle('Responding...')
        .setDescription(description)
        .setColor(COLORS.STREAMING)
        .setFooter({ text: `${elapsed}s \u00b7 ${this.tokenCount} tokens` });

      await this.sendOrEdit(embed);
    } else {
      // Thinking: purple embed with only token count and time
      const embed = new EmbedBuilder()
        .setTitle('Thinking...')
        .setColor(COLORS.THINKING)
        .setFooter({ text: `${elapsed}s \u00b7 ${this.tokenCount} tokens` });

      await this.sendOrEdit(embed);
    }
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
      console.error('[stream] Failed to update embed:', err);
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    // Clear any pending timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    if (this.type === 'text') {
      // Replace streaming embed with plain message(s)
      if (this.messageId) {
        try {
          const msg = await this.channel.messages.fetch(this.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        } catch {
          /* best-effort */
        }
      }
      // Send as plain text, chunked if needed
      if (this.buffer.length > 0) {
        const { chunkMessage } = await import('../formatters/chunker.js');
        const chunks = chunkMessage(this.buffer);
        for (const chunk of chunks) {
          await this.channel.send(chunk);
        }
      }
    } else {
      // Thinking: finalize embed with "Thought for Xs"
      const embed = new EmbedBuilder()
        .setTitle(`Thought for ${elapsed}s`)
        .setColor(COLORS.THINKING)
        .setFooter({ text: `${this.tokenCount} tokens` });

      if (this.messageId) {
        try {
          const msg = await this.channel.messages.fetch(this.messageId).catch(() => null);
          if (msg) {
            await msg.edit({ embeds: [embed] });
            return;
          }
        } catch {
          /* best-effort */
        }
      }
      await this.channel.send({ embeds: [embed] });
    }
  }

  getMessageId(): string | null {
    return this.messageId;
  }
}
