<p align="center">
  <img src="https://raw.githubusercontent.com/raravel/Agent4Discord/main/docs/images/banner.png" alt="Agent4Discord" width="640">
</p>

<p align="center">
  <strong>Remote Claude Code sessions through Discord</strong>
</p>

<p align="center">
  <a href="README.ko.md">한국어</a>
</p>

---

Agent4Discord (A4D) is a self-hosted Discord bot that lets you interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through Discord channels. Each session maps to a dedicated channel, tool calls appear in threads, and permission requests show as interactive buttons.

**Your PC. Your bot. Your Claude Code sessions.**

## How It Works

<p align="center">
  <img src="https://raw.githubusercontent.com/raravel/Agent4Discord/main/docs/images/architecture.png" alt="Architecture" width="640">
</p>

1. You run the bot on your PC with your own Discord bot token
2. `/a4d init` sets up channels in your Discord server
3. Pick a working directory and start a Claude Code session
4. Chat with Claude through Discord — streaming, tool calls, and permissions all work

## Features

- **Directory Browser** — Navigate your filesystem with select menus and buttons
- **Model Selection** — Choose opus/sonnet/haiku when starting a session (default: opus)
- **Real-time Streaming** — Live-updating embeds for text output, thinking, and tool progress
- **Tool Call Threads** — Each tool execution gets its own thread with formatted input/output
- **Permission Control** — Allow/Deny buttons for dangerous operations (auto-allow for safe tools)
- **Session Resume** — Resume CLI-created sessions or stopped sessions with `/a4d resume`
- **Usage Tracker** — `#a4d-usage` channel shows session costs, tokens, and rate limits
- **Plugin Support** — Auto-loads your installed Claude Code plugins (skills, hooks)
- **CLI Interop** — Sessions share the same JSONL storage as the CLI

### Directory Browser
![Directory Browser](https://raw.githubusercontent.com/raravel/Agent4Discord/main/docs/images/screenshot-browser.png)

### Session with Streaming
![Session](https://raw.githubusercontent.com/raravel/Agent4Discord/main/docs/images/screenshot-session.png)

### Permission Request
![Permission](https://raw.githubusercontent.com/raravel/Agent4Discord/main/docs/images/screenshot-permission.png)

## Quick Start

### Prerequisites

- **Node.js** >= 20.x
- **Claude Code** authenticated (`claude login` or `ANTHROPIC_API_KEY`)
- **Discord bot token** ([create one here](https://discord.com/developers/applications))

### Setup

```bash
npx agent4discord@latest --setup
```

The setup wizard will:
1. Ask for your Discord bot token
2. Ask for your Client ID
3. Verify Message Content Intent is enabled
4. Generate an invite URL and open it in your browser

### Run

```bash
npx agent4discord@latest
```

### In Discord

1. Run `/a4d init` in your server
2. Go to `#a4d-session` and browse to a directory
3. Click **Session Start**, pick a model, and start chatting

## Commands

| Command | Description |
|---|---|
| `/a4d init` | Set up A4D channels in your server |
| `/a4d resume` | Resume a stopped session in the current channel |
| `/a4d model <opus\|sonnet\|haiku>` | Change model mid-session |

## Channel Structure

```
A4D - General
├── #a4d-general      — Status messages
├── #a4d-session      — Directory browser & session start
└── #a4d-usage        — Usage & rate limit tracker

A4D - Sessions
├── #a4d-myproject    — Active session channel
└── #a4d-another      — Another session
```

## Configuration

Config is stored at `~/.agent4discord/config.json`:

```json
{
  "discordToken": "your-bot-token",
  "discordClientId": "your-client-id",
  "claudeModel": "opus",
  "permissionMode": "default",
  "logLevel": "info"
}
```

## Development

```bash
git clone https://github.com/raravel/Agent4Discord.git
cd Agent4Discord
npm install

# Dev mode with auto-reload
npx tsx watch src/cli.ts

# Type check
npx tsc --noEmit
```

## Project Structure

```
src/
├── cli.ts                    # Entry point
├── setup.ts                  # Interactive setup wizard
├── config.ts                 # Config loading (~/.agent4discord/)
├── bot.ts                    # Discord client & event handlers
├── guild.ts                  # Guild config persistence
├── commands/
│   ├── index.ts              # Slash command registry
│   ├── init.ts               # /a4d init
│   ├── resume.ts             # /a4d resume
│   └── model.ts              # /a4d model
├── interactions/
│   ├── index.ts              # Interaction router
│   ├── directoryBrowser.ts   # Directory browser UI
│   ├── sessionControls.ts    # Stop/Archive buttons
│   └── permissionHandler.ts  # Allow/Deny/Details buttons
├── sessions/
│   ├── sessionManager.ts     # SDK query() lifecycle
│   ├── sessionStore.ts       # Session persistence
│   ├── eventHandler.ts       # SDK events → Discord
│   ├── streamHandler.ts      # Streaming text/thinking embeds
│   ├── toolProgress.ts       # Tool execution progress
│   └── usageTracker.ts       # Rate limit & cost tracking
├── formatters/
│   ├── embedBuilder.ts       # Discord embeds
│   ├── chunker.ts            # Message chunking
│   └── toolFormatter.ts      # Tool-specific formatting
└── utils/
    ├── filesystem.ts         # Directory listing
    ├── plugins.ts            # Plugin auto-loader
    └── logger.ts             # Logging
```

## License

MIT
