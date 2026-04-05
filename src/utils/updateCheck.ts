import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { name: string; version: string };

const NPM_REGISTRY_URL = `https://registry.npmjs.org/${pkg.name}/latest`;

/**
 * Check npm registry for a newer version and print a notice if available.
 * Runs silently — never throws or blocks startup.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;

    const data = await res.json() as { version: string };
    const latest = data.version;
    const current = pkg.version;

    if (latest && latest !== current && isNewer(latest, current)) {
      console.log('');
      console.log(`  ╔══════════════════════════════════════════════════╗`);
      console.log(`  ║  Update available: ${current} → ${latest.padEnd(28)}║`);
      console.log(`  ║  Run: npx agent4discord@latest${' '.repeat(20)}║`);
      console.log(`  ╚══════════════════════════════════════════════════╝`);
      console.log('');
    }
  } catch {
    // Silently ignore — network errors, timeouts, etc.
  }
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}
