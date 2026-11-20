/**
 * Shared helpers for the downloader plugins (youtube.ts, download.ts).
 * Files starting with "_" are skipped by the plugin loader, so nothing registers here.
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR, media, type Message } from '../core/index.js'

const exec = promisify(execFile)

export const URL_RE = /https?:\/\/[^\s<>"'`]+/i
export const YT_RE = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?.*?v=|shorts\/|embed\/|v\/|live\/)|youtu\.be\/)([-_0-9A-Za-z]{11})/

export const MB = 1024 * 1024
/** WhatsApp media messages (image/video/audio) get flaky above this. */
export const MAX_MEDIA = 100 * MB
/** WhatsApp's document limit. */
export const MAX_DOC = 2 * 1024 * MB

/** First URL in `args`, else the first URL in the message being replied to. */
export function pickUrl(msg: Message, args: string): string | undefined {
  return URL_RE.exec(args)?.[0] ?? URL_RE.exec(msg.quoted?.text ?? '')?.[0]
}

/**
 * Optional Netscape cookie jar at data/cookies.txt. Lets yt-dlp fetch posts that need a
 * login (Instagram, Facebook, Vimeo …) and gets YouTube past its "sign in to confirm you're
 * not a bot" wall on cloud IPs. Export it from a browser extension like "Get cookies.txt".
 */
export const COOKIES = path.join(DATA_DIR, 'cookies.txt')
export const cookieArgs = (): string[] => (existsSync(COOKIES) ? ['--cookies', COOKIES] : [])

/** Run yt-dlp directly (for flags the core wrapper doesn't expose). */
export function ytdlp(args: string[], timeoutMs = 10 * 60 * 1000): Promise<{ stdout: string; stderr: string }> {
  return exec(media.YTDLP, ['--no-warnings', ...cookieArgs(), ...args], { maxBuffer: 1 << 26, timeout: timeoutMs })
}

/** Turn yt-dlp's stderr into one short, human-readable line. */
export function ytError(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean; signal?: string }
  const t = `${e.stderr ?? ''}\n${e.message ?? ''}`.toLowerCase()
  if (e.killed || e.signal === 'SIGTERM' || t.includes('timed out')) return 'Timed out while downloading.'
  if (t.includes('unsupported url')) return 'Unsupported link.'
  if (t.includes('private')) return 'This post is private.'
  if (t.includes('login required') || t.includes('sign in') || t.includes('cookies') || t.includes('log in') || t.includes('rate-limit'))
    return 'Login required - this site only serves that post to logged-in accounts.'
  if (/age[- ]restrict|confirm your age/.test(t)) return 'Age-restricted content cannot be downloaded.'
  if (t.includes('no video') || t.includes('no media') || t.includes('no formats') || t.includes('requested format is not available'))
    return 'No downloadable media found in that post.'
  if (t.includes('404') || t.includes('not found') || t.includes('unavailable') || t.includes('does not exist') || t.includes('removed') || t.includes('deleted'))
    return 'Post not found - it may have been removed.'
  if (t.includes('file too large') || t.includes('larger than max')) return 'File is too large.'
  const last = (e.stderr ?? '')
    .split('\n')
    .filter((l) => l.startsWith('ERROR'))
    .pop()
    ?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '')
  return last ? last.slice(0, 200) : (e.message?.slice(0, 200) ?? 'Download failed.')
}

export async function fileSize(file: string): Promise<number> {
  return (await fs.stat(file)).size
}

/** "My Song / Remix?" → "My Song  Remix" (safe for fileName). */
export const safeName = (s: string, max = 80) => s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'file'

export const hms = (seconds?: number) => {
  if (!seconds) return '?'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(sec).padStart(2, '0')}`
}
