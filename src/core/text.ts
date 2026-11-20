import os from 'node:os'

/** Replace `{0}`, `{1}`… placeholders. */
export function fmt(template: string, ...args: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : String(args[Number(i)])))
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pads a list index so numbers line up: addSpace(1, 100) → "   ". */
export function padIndex(i: number, total: number): string {
  return ' '.repeat(Math.max(0, String(total).length - String(i).length) + 1)
}

const MONO: Record<string, string> = Object.fromEntries(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [c, String.fromCodePoint(0x1d670 + i)]).concat(
    [...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, String.fromCodePoint(0x1d68a + i)]),
    [...'0123456789'].map((c, i) => [c, String.fromCodePoint(0x1d7f6 + i)]),
  ),
)
const SMALLCAPS: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ',
  n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
}

export const mono = (s: string) => [...s].map((c) => MONO[c] ?? c).join('')
export const smallcaps = (s: string) => [...s.toLowerCase()].map((c) => SMALLCAPS[c] ?? c).join('')

/** 93784 → "1d 2h 3m 4s" */
export function formatDuration(seconds: number): string {
  seconds = Math.floor(seconds)
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (s || !parts.length) parts.push(`${s}s`)
  return parts.join(' ')
}

export const uptime = () => formatDuration(process.uptime())

export function ramUsage(): string {
  const used = process.memoryUsage().rss / 1024 / 1024
  const total = os.totalmem() / 1024 / 1024
  return `${used.toFixed(0)}MB / ${(total / 1024).toFixed(1)}GB`
}

export const platform = () => `${os.type()} ${os.arch()}`

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let i = -1
  do {
    bytes /= 1024
    i++
  } while (bytes >= 1024 && i < units.length - 1)
  return `${bytes.toFixed(1)} ${units[i]}`
}

export function formatDate(ts: number | Date = Date.now()): string {
  return new Date(ts).toLocaleString('en-IN', { timeZone: process.env.TZ ?? 'Asia/Kolkata' })
}

/** "14:05" → "2:05 PM" */
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${suffix}`
}

export const bool = (v: string) => ['true', 'on', '1', 'yes'].includes(v.toLowerCase())
export const onOff = (v: boolean) => (v ? 'on' : 'off')
