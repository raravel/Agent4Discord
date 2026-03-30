#!/usr/bin/env node

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    setup: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.version) {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  console.log('Usage: agent4discord [--setup] [--version] [--help]');
  process.exit(0);
}

if (values.setup) {
  const { runSetup } = await import('./setup.js');
  await runSetup();
} else {
  const { startBot } = await import('./bot.js');
  await startBot();
}
