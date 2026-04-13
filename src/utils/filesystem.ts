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

// ---------------------------------------------------------------------------
// File browser utilities
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * List files and directories. Excludes hidden entries and node_modules.
 * Returns directories first, then files, alphabetically within each group.
 */
export async function listEntries(dirPath: string): Promise<DirEntry[]> {
  const raw = await fs.readdir(dirPath, { withFileTypes: true });

  const result: DirEntry[] = [];
  for (const entry of raw) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;

    let size = 0;
    if (entry.isFile()) {
      try {
        const stats = await fs.stat(path.join(dirPath, entry.name));
        size = stats.size;
      } catch { /* ignore */ }
    }

    result.push({ name: entry.name, isDirectory: entry.isDirectory(), size });
  }

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

/**
 * Read a text file with safety limits.
 * Returns an error string for binary or oversized files.
 */
export async function readFileContent(
  filePath: string,
): Promise<{ content: string; sizeBytes: number } | { error: string }> {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    return { error: `File too large (${formatFileSize(stats.size)}). Max 500 KB.` };
  }

  const buffer = Buffer.from(await fs.readFile(filePath));
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return { error: 'Binary file — cannot display.' };
  }

  return { content: buffer.toString('utf-8'), sizeBytes: stats.size };
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.py': 'py', '.rs': 'rust', '.go': 'go',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'md', '.html': 'html', '.css': 'css',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql', '.java': 'java', '.rb': 'ruby',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.xml': 'xml', '.toml': 'toml', '.ini': 'ini',
  '.swift': 'swift', '.kt': 'kotlin', '.php': 'php',
  '.lua': 'lua', '.r': 'r', '.scss': 'scss', '.less': 'less',
  '.graphql': 'graphql', '.gql': 'graphql', '.env': 'bash',
};

/** Map file extension to a Discord code block language tag. */
export function getLanguageTag(filePath: string): string {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  if (basename === 'makefile') return 'makefile';
  return LANG_MAP[path.extname(filePath).toLowerCase()] ?? '';
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
