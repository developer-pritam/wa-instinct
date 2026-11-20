import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const ROOT_DIR = path.resolve(__dirname, '..')
export const AUTH_DIR = path.join(ROOT_DIR, 'auth')
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const TMP_DIR = path.join(ROOT_DIR, 'tmp')
export const BIN_DIR = path.join(ROOT_DIR, 'bin')
export const PLUGINS_DIR = path.join(__dirname, 'plugins')

const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version: string }

const env = (key: string, fallback = '') => (process.env[key] ?? fallback).trim()
const numberList = (value: string) =>
  value
    .split(/[,\s]+/)
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean)

/**
 * Static configuration read once from the environment.
 * Runtime-changeable settings live in `vars` (see core/db.ts) and fall back to these.
 */
export const config = {
  version: pkg.version,
  botName: env('BOT_NAME', 'wa-instinct'),
  phoneNumber: env('PHONE_NUMBER').replace(/\D/g, ''),
  /** Every character in this string is a valid command prefix. Empty = no prefix needed. */
  prefix: env('PREFIX', '.'),
  sudo: numberList(env('SUDO')),
  stickerPack: env('STICKER_PACK', 'wa-instinct;me'),
  logLevel: env('LOG_LEVEL', 'info'),
  baileysLogLevel: env('BAILEYS_LOG_LEVEL', 'silent'),
  keys: {
    rmbg: env('RMBG_KEY'),
    openWeather: env('OPENWEATHER_KEY'),
    omdb: env('OMDB_KEY'),
    gemini: env('GEMINI_API_KEY'),
    groq: env('GROQ_API_KEY'),
    openRouter: env('OPENROUTER_API_KEY'),
  },
}

/** Default values for runtime vars (overridable with `.setvar KEY=value`). */
export const VAR_DEFAULTS: Record<string, string> = {
  ALWAYS_ONLINE: env('ALWAYS_ONLINE', 'false'),
  AUTO_READ: env('AUTO_READ', 'false'),
  AUTO_STATUS_VIEW: env('AUTO_STATUS_VIEW', 'false'),
  REJECT_CALL: env('REJECT_CALL', 'false'),
  ANTI_DELETE: env('ANTI_DELETE', 'false'),
  ANTI_EDIT: env('ANTI_EDIT', 'false'),
  WARN_LIMIT: env('WARN_LIMIT', '3'),
  WARN_MESSAGE: env('WARN_MESSAGE', '⚠️ &mention warned (&remaining left)\\n&reason'),
  WARN_KICK_MESSAGE: env('WARN_KICK_MESSAGE', '🚫 &mention exceeded the warn limit and was removed'),
  WARN_RESET_MESSAGE: env('WARN_RESET_MESSAGE', '✅ warnings for &mention reset'),
  ANTILINK_MESSAGE: env('ANTILINK_MESSAGE', '_Antilink detected: &mention removed_'),
  ANTISPAM_MESSAGE: env('ANTISPAM_MESSAGE', '_Antispam detected: &mention removed_'),
  DISABLED_COMMANDS: '',
  CMD_REACT: env('CMD_REACT', '🪄'),
  // Claude models; change from WhatsApp with `.model ai <name>` / `.model agent <name>`
  AI_MODEL: env('AI_MODEL', 'sonnet'),
  AGENT_MODEL: env('AGENT_MODEL', 'claude-opus-5-5'),
  AFK: '',
}
