import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { input, confirm } from '@inquirer/prompts';
import open from 'open';
import {
  type AppConfig,
  configExists,
  loadConfig,
  saveConfig,
} from './config.js';

/** Permission bits required by the bot. */
const PERMISSION_BITS: bigint =
  BigInt(0x10) |          // Manage Channels
  BigInt(0x800) |         // Send Messages
  BigInt(0x4000) |        // Embed Links
  BigInt(0x8000) |        // Attach Files
  BigInt(0x10000) |       // Read Message History
  BigInt(0x40000) |       // Use External Emojis
  BigInt(0x40) |          // Add Reactions
  BigInt(0x400000000) |   // Manage Threads
  BigInt(0x800000000) |   // Create Public Threads
  BigInt(0x2000) |        // Manage Messages
  (1n << 51n);            // Pin Messages (separated from Manage Messages since 2026-01-12)

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

export async function runSetup(): Promise<void> {
  console.log('\n=== Agent4Discord Setup ===\n');

  // Check for existing config
  if (configExists()) {
    let existing: AppConfig;
    try {
      existing = loadConfig();
    } catch {
      console.log('Existing config is invalid. Starting fresh.\n');
      existing = undefined as unknown as AppConfig;
    }

    if (existing) {
      console.log(`Existing config found. Token: ${maskToken(existing.discordToken)}`);
      const reconfigure = await confirm({
        message: 'Do you want to reconfigure?',
        default: false,
      });
      if (!reconfigure) {
        // Still offer to open the invite URL with current config
        const reinvite = await confirm({
          message: 'Open the bot invite URL to update permissions?',
          default: true,
        });
        if (reinvite) {
          const permissions = PERMISSION_BITS.toString();
          const inviteUrl =
            `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(existing.discordClientId)}` +
            `&permissions=${permissions}&scope=bot%20applications.commands`;
          console.log(`\nOpening invite URL...\n  ${inviteUrl}\n`);
          try {
            await open(inviteUrl);
          } catch {
            console.log('  Could not open browser. Please visit the URL above manually.');
          }
        }
        return;
      }
      console.log('');
    }
  }

  // Step 1: Bot token
  console.log('Step 1: Discord Bot Token');
  console.log('  Create a bot at https://discord.com/developers/applications');
  console.log('  Go to Bot tab -> Copy the token\n');

  const discordToken = await input({
    message: 'Enter your bot token:',
    validate: (val) => (val.trim().length > 0 ? true : 'Token is required'),
  });

  // Step 2: Client ID
  console.log('\nStep 2: Application Client ID');
  console.log('  Found on the General Information tab of your application\n');

  const discordClientId = await input({
    message: 'Enter your Client ID:',
    validate: (val) => (val.trim().length > 0 ? true : 'Client ID is required'),
  });

  // Step 3: Message Content Intent
  console.log('\nStep 3: Message Content Intent');
  console.log('  In the Bot tab, enable "Message Content Intent" under Privileged Gateway Intents\n');

  await confirm({
    message: 'Have you enabled Message Content Intent?',
    default: true,
  });

  // Check Claude Code auth
  const claudeDir = path.join(os.homedir(), '.claude');
  if (fs.existsSync(claudeDir)) {
    console.log('\n[OK] Claude Code directory found (~/.claude/)');
  } else {
    console.log('\n[INFO] Claude Code directory not found (~/.claude/).');
    console.log('  Make sure Claude Code is installed and authenticated (run: claude login)');
  }

  // Generate invite URL and open
  const permissions = PERMISSION_BITS.toString();
  const inviteUrl =
    `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(discordClientId.trim())}` +
    `&permissions=${permissions}&scope=bot%20applications.commands`;

  console.log(`\nOpening invite URL in your browser...\n  ${inviteUrl}\n`);
  try {
    await open(inviteUrl);
  } catch {
    console.log('  Could not open browser. Please visit the URL above manually.');
  }

  // Save config
  const config: AppConfig = {
    discordToken: discordToken.trim(),
    discordClientId: discordClientId.trim(),
    claudeModel: 'opus',
    permissionMode: 'default',
    logLevel: 'info',
  };

  saveConfig(config);
  console.log('\nConfig saved. Run "agent4discord" to start the bot.');
}
