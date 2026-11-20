import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { TMP_DIR, command, formatBytes, media, type Message } from '../core/index.js'
import { MAX_DOC, MAX_MEDIA, MB, fileSize, pickUrl, safeName, ytError, ytdlp } from './_ytdlp.js'

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v', 'gif'])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'opus', 'ogg', 'aac', 'wav'])

/** A fresh, empty folder under tmp/dl for one job (caller removes it). */
async function jobDir(): Promise<string> {
  const dir = path.join(TMP_DIR, 'dl', `${Date.now()}-${randomBytes(3).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const isInstagram = (url: string) => /(^|\.)instagram\.com$/.test(new URL(url).hostname)

/**
 * Download every media item of a post with yt-dlp. Instagram keeps playlists on so
 * carousels come through whole; everything else is `--no-playlist`.
 * TikTok: yt-dlp ranks the watermarked formats lower by default, so `b` is the clean one.
 */
async function ytFetch(url: string, dir: string): Promise<{ file: string; title: string }[]> {
  const args = [
    '-o', path.join(dir, '%(autonumber)03d.%(ext)s'),
    '-S', 'res:1080,ext:mp4:m4a', '--merge-output-format', 'mp4',
    '--max-filesize', `${MAX_MEDIA / MB}M`, '--playlist-items', '1:10',
    '--no-simulate', '--print', 'after_move:%(filepath)s\t%(title)s',
    ...(isInstagram(url) ? [] : ['--no-playlist']),
    url,
  ]
  const { stdout } = await ytdlp(args)
  const items = stdout
    .split('\n')
    .filter((l) => l.includes('\t'))
    .map((l) => {
      const [file, ...title] = l.split('\t')
      return { file, title: title.join('\t').trim() }
    })
  if (!items.length && /larger than max-filesize/i.test(stdout)) throw new Error(`File is larger than ${MAX_MEDIA / MB}MB.`)
  return items
}

/** Fallback for image posts yt-dlp has no "format" for: pull the full-size image from the info JSON. */
async function ytImages(url: string): Promise<{ url: string; title: string }[]> {
  type Info = { title?: string; thumbnail?: string; url?: string; thumbnails?: { url: string }[]; entries?: Info[] }
  const args = ['-J', '--ignore-no-formats-error', '--playlist-items', '1:10', ...(isInstagram(url) ? [] : ['--no-playlist']), url]
  const { stdout } = await ytdlp(args, 60_000)
  const info = JSON.parse(stdout) as Info
  return (info.entries ?? [info])
    .map((e) => ({ url: e.thumbnails?.at(-1)?.url ?? e.thumbnail ?? e.url ?? '', title: e.title ?? info.title ?? '' }))
    .filter((e) => e.url)
}

/** Send a downloaded file as image / video / audio (converting odd containers to mp4). */
async function sendFile(msg: Message, file: string, caption: string) {
  const ext = path.extname(file).slice(1).toLowerCase()
  const size = await fileSize(file)
  if (size > MAX_MEDIA) throw new Error(`File is ${formatBytes(size)}, over the ${MAX_MEDIA / MB}MB limit.`)
  if (IMAGE_EXT.has(ext)) return msg.reply({ image: await fs.readFile(file), caption })
  if (AUDIO_EXT.has(ext)) {
    const mimetype = ext === 'mp3' ? 'audio/mpeg' : ext === 'opus' || ext === 'ogg' ? 'audio/ogg; codecs=opus' : 'audio/mp4'
    return msg.reply({ audio: await fs.readFile(file), mimetype })
  }
  if (VIDEO_EXT.has(ext)) {
    const video = ext === 'mp4' || ext === 'mov' ? await fs.readFile(file) : await media.toMp4(await fs.readFile(file), ext)
    return msg.reply({ video, caption, gifPlayback: ext === 'gif' }, { mediaUploadTimeoutMs: 10 * 60 * 1000 })
  }
  return msg.reply({ document: await fs.readFile(file), mimetype: 'application/octet-stream', fileName: path.basename(file), caption })
}

/** Skip captions that are just a post id ("99360735500167749", "tPEE9ZwTmy0"). */
const captionOf = (title: string) => (title && !(/^[\w-]{6,}$/.test(title) && /\d/.test(title)) ? title.slice(0, 300) : '')

command(
  {
    name: 'dl',
    aliases: ['insta', 'ig', 'fb', 'tiktok', 'tt', 'twitter', 'x', 'pinterest', 'pin'],
    desc: 'Download media from Instagram, Facebook, TikTok, Twitter/X, Reddit, Pinterest and 1000+ other sites',
    usage: '<url | reply to a link>',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    const url = pickUrl(msg, args)
    if (!url) return msg.reply('_Usage: dl <url> (or reply to a message with a link)_')
    await msg.react('⏳')
    const dir = await jobDir()
    try {
      let items: { file: string; title: string }[] = []
      let firstError: unknown
      try {
        items = await ytFetch(url, dir)
      } catch (err) {
        firstError = err
      }
      if (items.length) {
        for (const [i, item] of items.entries()) await sendFile(msg, item.file, i === 0 ? captionOf(item.title) : '')
      } else {
        // yt-dlp found no "formats" (image post on Instagram / Pinterest …) - grab the images instead
        const images = await ytImages(url).catch(() => [])
        if (!images.length) throw new Error(ytError(firstError ?? new Error('No downloadable media found in that post.')))
        for (const [i, img] of images.entries()) {
          const { buffer } = await media.fetchBuffer(img.url, { headers: UA, maxBytes: MAX_MEDIA })
          await msg.reply({ image: buffer, caption: i === 0 ? captionOf(img.title) : '' })
        }
      }
      await msg.react('✅')
    } catch (err) {
      await msg.react('❌')
      await msg.reply(`❌ ${(err as Error).message}`)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  },
)

command(
  {
    name: 'upload',
    aliases: ['get'],
    desc: 'Fetch a direct file URL and send it as the matching media type (add "doc" to force a document)',
    usage: '<url> [doc]',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    const url = pickUrl(msg, args)
    if (!url) return msg.reply('_Usage: upload <url> [doc]_')
    const asDoc = /\bdoc\b/i.test(args.replace(url, ''))
    await msg.react('⏳')
    try {
      const { buffer, mimetype } = await media.fetchBuffer(url, { headers: UA, maxBytes: MAX_MEDIA, timeoutMs: 5 * 60 * 1000 })
      const kind = asDoc ? 'document' : media.mediaKind(mimetype)
      const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')
      if (kind === 'image') await msg.reply({ image: buffer })
      else if (kind === 'video') await msg.reply({ video: buffer })
      else if (kind === 'audio') await msg.reply({ audio: buffer, mimetype })
      else await msg.reply({ document: buffer, mimetype, fileName })
      await msg.react('✅')
    } catch (err) {
      await msg.react('❌')
      await msg.reply(`❌ ${(err as Error).message}`)
    }
  },
)

/** Stream a URL straight to disk (for files too large to hold in memory). */
async function downloadToFile(url: string, file: string, maxBytes: number): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching the file`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > maxBytes) throw new Error(`File is ${formatBytes(len)}, over the ${formatBytes(maxBytes)} limit.`)
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(file))
  return res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
}

command(
  {
    name: 'mediafire',
    aliases: ['mf'],
    desc: 'Download a MediaFire file and send it as a document',
    usage: '<url>',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    const url = pickUrl(msg, args)
    if (!url || !/mediafire\.com/i.test(url)) return msg.reply('_Usage: mediafire <MediaFire url>_')
    await msg.react('⏳')
    let file: string | undefined
    try {
      const page = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) })
      const html = await page.text()
      // the page has either a plain download link or a base64 "scrambled" one
      let direct = /href="(https?:\/\/download[^"]+)"/.exec(html)?.[1]
      if (!direct) {
        const scrambled = /data-scrambled-url="([A-Za-z0-9+/=]+)"/.exec(html)?.[1]
        if (scrambled) direct = Buffer.from(scrambled, 'base64').toString('utf8')
      }
      if (!direct || !/^https?:\/\//.test(direct)) throw new Error('File not found. Check the link again!')
      const name = /class="filename">([^<]+)</.exec(html)?.[1]?.trim() || decodeURIComponent(direct.split('/').pop()?.split('?')[0] || 'file')
      file = media.tmpPath('bin', 'dl')
      const mimetype = await downloadToFile(direct, file, MAX_DOC)
      const size = await fileSize(file)
      await msg.reply(
        { document: { url: file }, mimetype, fileName: safeName(name, 150), caption: `📂 ${name} · ${formatBytes(size)}` },
        { mediaUploadTimeoutMs: 30 * 60 * 1000 },
      )
      await msg.react('✅')
    } catch (err) {
      await msg.react('❌')
      await msg.reply(`❌ ${(err as Error).message}`)
    } finally {
      await media.removeFile(file)
    }
  },
)
