const MAX_LENGTH = 2000;

/**
 * Split a long text into chunks that respect Discord's 2000 char limit.
 * Tries to break at code block boundaries, then newlines, then hard-cut.
 */
export function chunkMessage(text: string, maxLength = MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakIdx = findBreakPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx);
  }

  return chunks;
}

/**
 * Find the best break point within maxLength characters.
 * Priority: code block boundary > double newline > single newline > hard cut.
 */
function findBreakPoint(text: string, maxLength: number): number {
  const segment = text.slice(0, maxLength);

  // Try to break at code block end (```)
  const codeBlockEnd = segment.lastIndexOf('\n```\n');
  if (codeBlockEnd > maxLength * 0.3) {
    return codeBlockEnd + 4; // include the closing ``` and newline
  }

  // Try to break at double newline
  const doubleNewline = segment.lastIndexOf('\n\n');
  if (doubleNewline > maxLength * 0.3) {
    return doubleNewline + 1;
  }

  // Try to break at single newline
  const newline = segment.lastIndexOf('\n');
  if (newline > maxLength * 0.3) {
    return newline + 1;
  }

  // Hard cut at maxLength
  return maxLength;
}
