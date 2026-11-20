# wa-instinct

A readable, plugin-based WhatsApp bot built on [Baileys 7](https://github.com/WhiskeySockets/Baileys), written in TypeScript. It runs on your own account (a "userbot"): you link it as a WhatsApp Web device and then control it from any chat with commands like `.kick`, `.sticker`, `.song`.

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`; no native modules to compile)
- `ffmpeg` / `ffprobe` on PATH (audio, video and sticker tools)
- `bin/yt-dlp` (standalone binary, not in git; download with `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o bin/yt-dlp && chmod +x bin/yt-dlp`, refresh with `bin/yt-dlp -U`)

## Setup

```bash
cp .env.example .env     # edit: PHONE_NUMBER for pairing-code login, PREFIX, SUDO
npm install
npm start                # or: npm run dev (auto-reload on changes)
```

### Linking your WhatsApp

- **Pairing code** (best over SSH): set `PHONE_NUMBER=91xxxxxxxxxx` in `.env`. On start the terminal prints an 8-character code. On your phone: *WhatsApp → Linked devices → Link a device → Link with phone number instead* and enter it.
- **QR**: leave `PHONE_NUMBER` empty and scan the QR printed in the terminal.

The session is saved in `auth/`. Delete that folder to link again from scratch.

### Keeping it running

pm2 runs nodemon, which runs the bot and restarts it whenever `src/` or `.env` changes.

```bash
pm2 start ecosystem.config.cjs     # or: npm run pm2 (also runs pm2 save)
pm2 logs wa-instinct
pm2 restart wa-instinct
npm run dev                        # same nodemon setup in the foreground, without pm2
```

- `ecosystem.config.cjs` pins Node 22 (`WA_NODE`) so the bot never starts on the system's older node.
- `.restart` from WhatsApp, a crash, or `.update` all restart through nodemon's `.restart.json` trigger (nodemon alone won't restart a process that exits). Crashes come back after 10 s.
- `.shutdown` stops the bot and leaves nodemon waiting; `pm2 restart wa-instinct` brings it back.

## Using it

Send `.menu` in any chat. Commands are **only accepted from your own account** and numbers listed in `SUDO` unless a command is marked public or you allow it in a chat with `.allow <cmd>`.

Categories (`.menu <category>`): `group` admin tools · `moderation` (antilink, antiword, antifake, antispam, warn, welcome/goodbye, filters, msgs, amute) · `sticker` · `audio` / `video` / `media` / `document` (ffmpeg + sharp tools) · `download` (yt-dlp: song, video, dl for Instagram/TikTok/X/Pinterest…, spotify, upload, mediafire) · `search` (weather, movie, wiki, define, lyrics, news, reddit, hn, translate, tts) · `whatsapp` / `user` (dlt, react, poll, forward, antidelete, archive, status, profile…) · `game` (tictactoe, wcg, wrg) · `misc` (afk, alive, budget, qr, ss, url, short, ip…) · `bot` / `vars`.

`.restart`, `.update` (git pull) and `.shutdown` manage the process from WhatsApp.

Settings that change at runtime are *vars*: `.setvar ALWAYS_ONLINE=true`, `.getvar AUTO_READ`, `.allvar`. Their defaults come from `.env`. Per-group features (antilink, welcome, filters…) are stored per chat in `data/bot.db`.

## AI

- **`.ai <request>`**: quick answers with web search, and it can run the bot's own commands for you (`.ai make this a sticker`, `.ai kick @x`). No shell or file access. Runs on the `claude` CLI logged in on the VM.
- **`.agent <task>`**: full Claude Code (shell, files, your skills) working inside `AGENT_DIR` (default `~/Pritam/brag-plugin-decode`) with that project's memory. Long jobs run in the background, survive bot restarts, post progress every few minutes, and send finished files back. **Reply to any agent message** to continue the same conversation (that's how you answer its questions). `.agent status`, `.agent stop`, `.agent new <task>` (fresh conversation). Reply to a video/photo with `.agent …` to give it that file.
  - It is effectively a shell on the VM for you and your sudo users. Off unless `AGENT_ENABLED=true` in `.env` (can't be switched on from WhatsApp).

## Writing a plugin

Create `src/plugins/anything.ts`:

```ts
import { command, on } from '../core/index.js'

command(
  { name: 'hello', desc: 'Say hi', category: 'misc', public: true },
  async (msg, args) => {
    await msg.reply(`Hello ${msg.pushName || 'there'}! ${args}`)
  },
)

// react to every incoming group message that isn't yours
on('message', async (msg) => {
  if (msg.text.includes('🍕')) await msg.react('🍕')
}, { fromMe: false, groupOnly: true })
```

That's it — the loader imports every file in `src/plugins/` on start. See [src/core/message.ts](src/core/message.ts) for what `msg` can do and [src/core/registry.ts](src/core/registry.ts) for command options and events.

## Layout

```
src/
  index.ts            start-up: load plugins, connect, keep alive
  config.ts           .env → typed config and var defaults
  core/
    connection.ts     Baileys socket, QR / pairing code, reconnect loop
    dispatcher.ts     incoming events → Message → command / listeners
    message.ts        the Message wrapper plugins use
    registry.ts       command() and on()
    db.ts             node:sqlite tables (vars, chat settings, warns, …)
    media.ts          ffmpeg, sharp, stickers, yt-dlp helpers
    jid.ts            jid / LID helpers
  plugins/            one file per feature
```

## Notes on Baileys 7

WhatsApp now addresses many users by a *LID* (`…@lid`) instead of a phone number. The core resolves senders to phone numbers where it can (`msg.sender`) and keeps the raw form in `msg.senderRaw`; use the helpers in `core/jid.ts` rather than comparing jids as strings.
