import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import webp from 'node-webpmux'
import { BIN_DIR, TMP_DIR, config } from '../config.js'
import { logger } from './logger.js'

const exec = promisify(execFile)
mkdirSync(TMP_DIR, { recursive: true })

export const YTDLP = path.join(BIN_DIR, 'yt-dlp')

/** A unique path inside tmp/, optionally under a sub-folder. */
export function tmpPath(ext: string, sub = ''): string {
  const dir = sub ? path.join(TMP_DIR, sub) : TMP_DIR
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.${ext.replace(/^\./, '')}`)
}

export async function writeTmp(data: Buffer, ext: string, sub = ''): Promise<string> {
  const p = tmpPath(ext, sub)
  await fs.writeFile(p, data)
  return p
}

export const removeFile = (p?: string) => (p ? fs.rm(p, { force: true }).catch(() => {}) : Promise.resolve())

/** Run ffmpeg with the given args; resolves when done. */
export async function ffmpeg(args: string[], timeoutMs = 10 * 60 * 1000): Promise<void> {
  try {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs, maxBuffer: 1 << 26 })
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    logger.error({ args, stderr: e.stderr }, 'ffmpeg failed')
    throw new Error(e.stderr?.trim().split('\n').pop() ?? e.message)
  }
}

export async function ffprobe(file: string): Promise<{ width?: number; height?: number; duration?: number; codec?: string }> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file,
  ])
  const info = JSON.parse(stdout) as { streams?: { width?: number; height?: number; codec_name?: string }[]; format?: { duration?: string } }
  const s = info.streams?.[0]
  return { width: s?.width, height: s?.height, codec: s?.codec_name, duration: Number(info.format?.duration) || undefined }
}

/** Run an ffmpeg conversion from a buffer and get the output back as a buffer. */
export async function convert(input: Buffer, inExt: string, outExt: string, args: string[]): Promise<Buffer> {
  const inFile = await writeTmp(input, inExt)
  const outFile = tmpPath(outExt)
  try {
    await ffmpeg(['-i', inFile, ...args, outFile])
    return await fs.readFile(outFile)
  } finally {
    await Promise.all([removeFile(inFile), removeFile(outFile)])
  }
}

// ---------- stickers ----------

export interface StickerMeta {
  pack?: string
  author?: string
  /** Pass to keep the sticker's existing exif instead of overriding it. */
  keepExif?: boolean
}

function parsePack(): { pack: string; author: string } {
  const [pack = 'wa-instinct', author = ''] = config.stickerPack.split(';')
  return { pack: pack.trim(), author: author.trim() }
}

/** Builds the exif blob WhatsApp reads for sticker pack/author. */
export function buildStickerExif(meta: StickerMeta = {}): Buffer {
  const defaults = parsePack()
  const json = {
    'sticker-pack-id': `wa-instinct-${randomBytes(8).toString('hex')}`,
    'sticker-pack-name': meta.pack ?? defaults.pack,
    'sticker-pack-publisher': meta.author ?? defaults.author,
    emojis: ['🤖'],
  }
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
  const body = Buffer.from(JSON.stringify(json), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(body.length, 0)
  len.copy(header, 14)
  return Buffer.concat([header, body])
}

/** Stamp pack/author exif onto a webp buffer. */
export async function addStickerExif(webpBuffer: Buffer, meta: StickerMeta = {}): Promise<Buffer> {
  const img = new webp.Image()
  await img.load(webpBuffer)
  img.exif = buildStickerExif(meta)
  return Buffer.from((await img.save(null)) as Buffer)
}

/** Read pack/author from a sticker's exif, if any. */
export async function readStickerExif(webpBuffer: Buffer): Promise<Record<string, unknown> | undefined> {
  try {
    const img = new webp.Image()
    await img.load(webpBuffer)
    if (!img.exif) return undefined
    const start = img.exif.indexOf('{')
    const end = img.exif.lastIndexOf('}')
    if (start < 0 || end < 0) return undefined
    return JSON.parse(img.exif.subarray(start, end + 1).toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Image → 512x512 webp sticker (padded, transparent background). */
export async function imageToSticker(image: Buffer, meta: StickerMeta = {}, opts: { circle?: boolean } = {}): Promise<Buffer> {
  let pipeline = sharp(image).rotate().resize(512, 512, { fit: opts.circle ? 'cover' : 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  if (opts.circle) {
    const mask = Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="256" fill="#fff"/></svg>')
    pipeline = pipeline.composite([{ input: mask, blend: 'dest-in' }])
  }
  const out = await pipeline.webp({ quality: 90 }).toBuffer()
  return addStickerExif(out, meta)
}

/** Video/GIF → animated webp sticker (first ~8s, 512px, 15fps). */
export async function videoToSticker(video: Buffer, meta: StickerMeta = {}): Promise<Buffer> {
  const out = await convert(video, 'mp4', 'webp', [
    '-t', '8', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=0x00000000',
    '-c:v', 'libwebp', '-lossless', '0', '-q:v', '60', '-preset', 'default', '-loop', '0', '-an', '-vsync', '0',
  ])
  return addStickerExif(out, meta)
}

export const stickerToPng = (webpBuffer: Buffer) => sharp(webpBuffer).png().toBuffer()

/** Animated webp → mp4 (via frame extraction with ffmpeg). */
export async function stickerToMp4(webpBuffer: Buffer): Promise<Buffer> {
  // ffmpeg 4.x cannot decode animated webp; expand frames with webpmux-style decoding through sharp.
  const img = new webp.Image()
  await img.load(webpBuffer)
  const frames = img.frames?.length ?? 0
  if (!frames) throw new Error('not an animated sticker')
  const dir = tmpPath('frames')
  mkdirSync(dir, { recursive: true })
  try {
    const delays: number[] = []
    for (let i = 0; i < frames; i++) {
      const frame = await img.demux({ frame: i, buffers: true })
      const png = await sharp(frame[0]).png().toBuffer()
      await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.png`), png)
      delays.push(img.frames[i].delay || 100)
    }
    const fps = Math.max(1, Math.min(30, Math.round(1000 / (delays.reduce((a, b) => a + b, 0) / delays.length))))
    const outFile = tmpPath('mp4')
    await ffmpeg([
      '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', outFile,
    ])
    const out = await fs.readFile(outFile)
    await removeFile(outFile)
    return out
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// ---------- audio / video ----------

export const toMp3 = (input: Buffer, ext = 'mp4') => convert(input, ext, 'mp3', ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k'])
export const toOpusVoice = (input: Buffer, ext = 'mp4') => convert(input, ext, 'opus', ['-vn', '-c:a', 'libopus', '-b:a', '64k', '-ac', '1'])
export const toMp4 = (input: Buffer, ext = 'webm') =>
  convert(input, ext, 'mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac'])

// ---------- yt-dlp ----------

export interface YtInfo {
  id: string
  title: string
  duration?: number
  uploader?: string
  thumbnail?: string
  webpage_url?: string
  extractor?: string
  filesize_approx?: number
  entries?: YtInfo[]
}

export async function ytInfo(urlOrSearch: string, extra: string[] = []): Promise<YtInfo> {
  const { stdout } = await exec(YTDLP, ['-J', '--no-warnings', '--no-playlist', ...extra, urlOrSearch], { maxBuffer: 1 << 26, timeout: 60_000 })
  return JSON.parse(stdout) as YtInfo
}

export async function ytSearch(query: string, count = 5): Promise<YtInfo[]> {
  const info = await ytInfo(`ytsearch${count}:${query}`, ['--flat-playlist'])
  return info.entries ?? []
}

/**
 * Download with yt-dlp into tmp/. Returns the output file path (caller removes it).
 * `kind` picks a format: audio → best audio as mp3, video → mp4 ≤720p by default.
 */
export async function ytDownload(url: string, kind: 'audio' | 'video', opts: { maxHeight?: number; extra?: string[] } = {}): Promise<string> {
  const out = tmpPath(kind === 'audio' ? 'mp3' : 'mp4', 'dl')
  const args =
    kind === 'audio'
      ? ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '5']
      : ['-f', `bv*[height<=${opts.maxHeight ?? 720}][ext=mp4]+ba[ext=m4a]/b[height<=${opts.maxHeight ?? 720}][ext=mp4]/b`, '--merge-output-format', 'mp4']
  await exec(YTDLP, ['--no-warnings', '--no-playlist', '-o', out, ...args, ...(opts.extra ?? []), url], { maxBuffer: 1 << 24, timeout: 15 * 60 * 1000 })
  return out
}

/** Fetch a URL into a buffer with a sane timeout and size cap. */
export async function fetchBuffer(url: string, opts: { maxBytes?: number; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ buffer: Buffer; mimetype: string }> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', ...opts.headers }, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  const max = opts.maxBytes ?? 100 * 1024 * 1024
  if (len > max) throw new Error(`file too large (${len} bytes)`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > max) throw new Error(`file too large (${buffer.length} bytes)`)
  return { buffer, mimetype: res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' }
}

/** Guess a media kind from a mimetype. */
export function mediaKind(mimetype: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  return 'document'
}
