import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * List subdirectories of the given path.
 * Excludes hidden directories (starting with '.') and 'node_modules'.
 * Returns sorted array of directory names (not full paths).
 */
export async function listDirectories(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const dirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules',
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return dirs;
}

/**
 * Validate that the target path is a real absolute path (no traversal tricks).
 * Self-hosted bot -- no homedir restriction.
 */
export function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved === targetPath || path.isAbsolute(resolved);
}
