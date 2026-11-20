# wa-instinct

A readable, plugin-based **WhatsApp userbot** built on [Baileys 7](https://github.com/WhiskeySockets/Baileys) and written in TypeScript.

You link it to your own WhatsApp account as a *linked device* (like WhatsApp Web), then control it from any chat with commands such as `.sticker`, `.song`, `.kick` or `.ai`.

- 40+ plugins, 200+ commands: group admin, moderation, stickers, media tools, downloads, search, games
- Optional AI commands (`.ai`, `.agent`) powered by Claude Code
- One file per feature: adding a command is a few lines of TypeScript
- No native modules to compile: uses Node's built-in `node:sqlite`

> **Disclaimer:** this is an unofficial client. Automating a personal WhatsApp account is against WhatsApp's Terms of Service and **can get the number banned**. Use a number you can afford to lose, and use it responsibly.

---

## Requirements

| What | Why |
|---|---|
| **Node.js 22.13 or newer** | Baileys 7 and the built-in `node:sqlite` |
| **ffmpeg** and **ffprobe** on `PATH` | Audio, video and sticker tools |
| **yt-dlp** binary in `bin/` | Downloads (YouTube, Instagram, TikTok, X …) |
| A WhatsApp account | Linked as a device; the phone keeps working as usual |
| *(optional)* [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, logged in | Only for `.ai` and `.agent` |
| *(optional)* pm2 | Keep the bot running in the background |

Ubuntu / Debian:

```bash
sudo apt update && sudo apt install -y ffmpeg
# Node 22+ (e.g. via NodeSource or nvm), then:
sudo npm install -g pm2   # optional
```

macOS: `brew install node ffmpeg`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/developer-pritam/wa-instinct.git
cd wa-instinct
npm install
```

### 2. Download yt-dlp

The binary is not in git (it is ~40 MB):

```bash
mkdir -p bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o bin/yt-dlp
chmod +x bin/yt-dlp
```

On macOS use `yt-dlp_macos` instead of `yt-dlp_linux`. Update it later with `bin/yt-dlp -U`.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`. The important ones:

| Variable | What to set |
|---|---|
| `PHONE_NUMBER` | Your number with country code, digits only (e.g. `919876543210`) to log in with a **pairing code**. Leave empty to log in with a **QR code**. |
| `PREFIX` | Character(s) that start a command. `.` means `.ping`; `.,!` accepts `.ping`, `,ping` and `!ping`. |
| `SUDO` | Extra numbers (comma separated) allowed to run every command besides your own account. |
| `BOT_NAME`, `STICKER_PACK` | Name shown in replies and on stickers. |

Everything else has a sensible default. See [Configuration](#configuration) for the full list.

### 4. Start and link your WhatsApp

```bash
npm start
```

- **Pairing code** (easiest on a server): with `PHONE_NUMBER` set, the terminal prints an 8-character code. On your phone open *WhatsApp → Linked devices → Link a device → Link with phone number instead* and type it in.
- **QR code**: with `PHONE_NUMBER` empty, scan the QR printed in the terminal from *WhatsApp → Linked devices → Link a device*.

Once it says `connected as …`, send `.menu` to any chat (for example your own "Message yourself" chat).

The login session is stored in `auth/`. **Keep that folder private** (it is your WhatsApp login) and delete it to link again from scratch.

### 5. Keep it running (optional)

pm2 keeps nodemon alive, and nodemon restarts the bot when `src/` or `.env` change:

```bash
npm run pm2               # pm2 start ecosystem.config.cjs && pm2 save
pm2 logs wa-instinct
pm2 restart wa-instinct
pm2 startup               # follow the printed command so it starts after a reboot
```

`npm run dev` runs the same nodemon setup in the foreground without pm2.

- pm2 starts the bot with the Node that pm2 itself runs on. If pm2 runs on an older Node, set `NODE_BIN` to the folder of a Node 22+ binary (e.g. `NODE_BIN=$HOME/.nvm/versions/node/v22.18.0/bin pm2 start ecosystem.config.cjs`).
- `.restart` from WhatsApp, a crash, or `.update` restart the bot through nodemon's `.restart.json` trigger. After a crash it comes back in 10 s.
- `.shutdown` stops the bot and leaves nodemon waiting; `pm2 restart wa-instinct` brings it back.

---

## Using it

Send `.menu` in any chat, or `.menu <category>` for one category.

Commands are **only accepted from your own account** and the numbers in `SUDO`, unless a command is marked public or you allow it in a chat with `.allow <cmd>`.

| Category | Examples |
|---|---|
| `group` | kick, add, promote, demote, mute, invite link, tag all |
| `moderation` | antilink, antiword, antifake, antispam, warn, welcome / goodbye, filters, msgs, amute |
| `sticker` | image / video → sticker, sticker → image, custom pack names |
| `audio` / `video` / `media` / `document` | ffmpeg and sharp tools: convert, trim, compress, effects |
| `download` | song, video, `dl` for Instagram / TikTok / X / Pinterest …, spotify, mediafire |
| `search` | weather, movie, wiki, define, lyrics, news, reddit, hn, translate, tts |
| `whatsapp` / `user` | dlt, react, poll, forward, antidelete, archive, status, profile |
| `game` | tictactoe, word chain (wcg), word games |
| `misc` | afk, alive, budget, qr, screenshot, url shortener, ip |
| `bot` / `vars` | restart, update, shutdown, settings |

Process control from WhatsApp: `.restart`, `.update` (runs `git pull`) and `.shutdown`.

---

## Configuration

Settings that can change while running are **vars**. Their defaults come from `.env`; change them from WhatsApp:

```
.setvar ALWAYS_ONLINE=true
.getvar AUTO_READ
.allvar
```

| Variable | Values | Meaning |
|---|---|---|
| `ALWAYS_ONLINE` | `true` / `false` | Show as online all the time |
| `AUTO_READ` | `true` / `false` / `p` / `g` | Mark messages as read (all, personal only, groups only) |
| `AUTO_STATUS_VIEW` | `true` / `false` | Automatically view statuses |
| `REJECT_CALL` | `true` / `false` | Reject incoming calls |
| `ANTI_DELETE` | `false` / `p` / `g` / a chat id | Re-send deleted messages (to yourself, same chat, or a chat) |
| `ANTI_EDIT` | `true` / `false` | Show the original of edited messages |
| `CMD_REACT` | an emoji / `false` | Reaction added when a command is received |
| `WARN_LIMIT` and `*_MESSAGE` | number / text | Warn system and moderation messages (`&mention`, `&remaining`, `&reason` are filled in) |

Optional API keys (features that need them stay off without them):

| Variable | Used for |
|---|---|
| `RMBG_KEY` | Background removal (remove.bg) |
| `OPENWEATHER_KEY` | `.weather` |
| `OMDB_KEY` | `.movie` |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` | AI helpers in some plugins |

Logging: `LOG_LEVEL` (`trace` … `error`) and `BAILEYS_LOG_LEVEL` (default `silent`).

Per-group features (antilink, welcome, filters …) are stored per chat in `data/bot.db` (SQLite).

---

## AI

- **`.ai <request>`**: quick answers with web search. It can also run the bot's own commands for you (`.ai make this a sticker`, `.ai kick @x`). No shell or file access. Needs the `claude` CLI logged in on the machine.
- **`.agent <task>`**: full Claude Code (shell, files, skills) working inside `AGENT_DIR`. Long jobs run in the background, survive bot restarts, post progress every few minutes and send finished files back. **Reply to an agent message** to continue the same conversation. Also `.agent status`, `.agent stop`, `.agent new <task>`; reply to a photo or video with `.agent …` to hand it that file.

> `.agent` is effectively a remote shell on your machine for you and your `SUDO` users. It is **off** unless `AGENT_ENABLED=true` is set in `.env`, and it cannot be switched on from WhatsApp. Set `AGENT_DIR` to the folder it should work in.

---

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

The loader imports every file in `src/plugins/` on start (files starting with `_` are shared helpers). See [`src/core/message.ts`](src/core/message.ts) for what `msg` can do and [`src/core/registry.ts`](src/core/registry.ts) for command options and events.

Type-check with `npm run typecheck`.

---

## Project layout

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
    scheduler.ts      scheduled messages
  plugins/            one file per feature
assets/fonts/         fonts for logo / text effects (OFL licensed)
bin/                  yt-dlp binary (not in git)
auth/                 WhatsApp login session (not in git, keep private)
data/                 SQLite database and agent job output (not in git)
```

### Notes on Baileys 7

WhatsApp now addresses many users by a *LID* (`…@lid`) instead of a phone number. The core resolves senders to phone numbers where it can (`msg.sender`) and keeps the raw form in `msg.senderRaw`. Use the helpers in `core/jid.ts` rather than comparing jids as strings.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `connection closed` / logged out right after linking | Delete `auth/` and link again. Make sure only **one** copy of the bot uses the same `auth/` folder. |
| No pairing code shown | Check `PHONE_NUMBER` has the country code and digits only. |
| Download commands fail | `bin/yt-dlp` missing or outdated: run `bin/yt-dlp -U`. |
| Sticker / audio / video commands fail | `ffmpeg` / `ffprobe` not installed or not on `PATH`. |
| `node:sqlite` error on start | Node is older than 22.13. |
| Test whether WhatsApp is reachable from the server | `node wstest.mjs` |

---

## License

MIT
