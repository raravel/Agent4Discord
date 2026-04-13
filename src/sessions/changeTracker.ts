/**
 * Tracks file changes (Edit / Write tool calls) during a turn.
 * On result, the accumulated changes are consumed and shown in a diff thread.
 */

export interface EditRecord {
  type: 'edit';
  filePath: string;
  oldString: string;
  newString: string;
}

export interface WriteRecord {
  type: 'write';
  filePath: string;
  content: string; // truncated preview
}

export type ChangeRecord = EditRecord | WriteRecord;

export interface FileDiff {
  filePath: string;
  changes: ChangeRecord[];
}

// Per-channel pending changes (accumulated during a single turn)
const pendingChanges = new Map<string, ChangeRecord[]>();

// Per-thread stored diffs (for the interactive diff viewer)
const diffStore = new Map<string, FileDiff[]>();

/** Track an Edit or Write change for the current turn. */
export function trackChange(channelId: string, record: ChangeRecord): void {
  if (!pendingChanges.has(channelId)) {
    pendingChanges.set(channelId, []);
  }
  pendingChanges.get(channelId)!.push(record);
}

/**
 * Consume all pending changes for a channel, grouped by file.
 * Returns empty array if no changes. Clears the pending state.
 */
export function consumeChanges(channelId: string): FileDiff[] {
  const records = pendingChanges.get(channelId) || [];
  pendingChanges.delete(channelId);
  if (records.length === 0) return [];

  const byFile = new Map<string, ChangeRecord[]>();
  for (const r of records) {
    if (!byFile.has(r.filePath)) byFile.set(r.filePath, []);
    byFile.get(r.filePath)!.push(r);
  }

  return [...byFile.entries()].map(([filePath, changes]) => ({
    filePath,
    changes,
  }));
}

/** Store diffs for an interactive diff viewer thread. */
export function storeDiffs(threadId: string, diffs: FileDiff[]): void {
  diffStore.set(threadId, diffs);
  setTimeout(() => diffStore.delete(threadId), 60 * 60 * 1000);
}

/** Retrieve stored diffs by thread ID. */
export function getDiffs(threadId: string): FileDiff[] | undefined {
  return diffStore.get(threadId);
}

/** Remove stored diffs (e.g. when thread is deleted). */
export function clearDiffs(threadId: string): void {
  diffStore.delete(threadId);
}
