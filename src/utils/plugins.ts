import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PLUGINS_PATH = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');

interface InstalledPluginEntry {
  scope: string;
  installPath: string;
  version: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Resolve enabled plugins from ~/.claude/ config files.
 * Returns an array of SdkPluginConfig for passing to query() options.
 */
export function resolvePlugins(): SdkPluginConfig[] {
  // Read settings.json for enabled plugins
  let settings: SettingsFile;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw) as SettingsFile;
  } catch {
    return [];
  }

  const enabledPlugins = settings.enabledPlugins;
  if (!enabledPlugins || typeof enabledPlugins !== 'object') {
    return [];
  }

  const enabledNames = Object.entries(enabledPlugins)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);

  if (enabledNames.length === 0) return [];

  // Read installed_plugins.json for install paths
  let installed: InstalledPluginsFile;
  try {
    const raw = fs.readFileSync(INSTALLED_PLUGINS_PATH, 'utf-8');
    installed = JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return [];
  }

  if (!installed.plugins || typeof installed.plugins !== 'object') {
    return [];
  }

  // Cross-reference: enabled + installed + directory exists
  const result: SdkPluginConfig[] = [];

  for (const name of enabledNames) {
    const entries = installed.plugins[name];
    if (!entries || entries.length === 0) {
      console.warn(`[plugins] Enabled plugin "${name}" not found in installed_plugins.json, skipping`);
      continue;
    }

    const installPath = entries[0].installPath;
    if (!installPath) {
      console.warn(`[plugins] Enabled plugin "${name}" has no installPath, skipping`);
      continue;
    }

    if (!fs.existsSync(installPath)) {
      console.warn(`[plugins] Plugin "${name}" install path does not exist: ${installPath}, skipping`);
      continue;
    }

    result.push({ type: 'local', path: installPath });
  }

  if (result.length > 0) {
    console.log(`[plugins] Loaded ${result.length} plugin(s): ${enabledNames.filter((n) => result.some((r) => installed.plugins[n]?.[0]?.installPath === r.path)).join(', ')}`);
  }

  return result;
}
