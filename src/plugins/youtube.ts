import { promises as fs } from 'node:fs'
import { command, formatBytes, media, type Message } from '../core/index.js'
import { MAX_DOC, MAX_MEDIA, MB, YT_RE, cookieArgs, fileSize, hms, safeName } from './_ytdlp.js'

const MAX_SONG_SECONDS = 60 * 60
const DEFAULT_HEIGHT = 720

type Entry = media.YtInfo & { url?: string; channel?: string }
const ytUrl = (e: Entry) => e.webpage_url ?? e.url ?? `https://www.youtube.com/watch?v=${e.id}`
const by = (e: Entry) => e.uploader ?? e.channel ?? 'unknown'

/** A YouTube URL for a query: direct link → canonical URL, otherwise the first search hit. */
async function resolve(query: string): Promise<string> {
  const id = YT_RE.exec(query)?.[1]
  if (id) return `https://www.youtube.com/watch?v=${id}`
  const [first] = await media.ytSearch(query, 1)
  if (!first) throw new Error(`No results for *${query}*`)
  return ytUrl(first)
}

/** Shared wrapper: react ⏳ / ✅ / ❌ and report errors to the chat. */
async function job(msg: Message, work: () => Promise<unknown>) {
  await msg.react('⏳')
  try {
    await work()
    await msg.react('✅')
  } catch (err) {
    await msg.react('❌')
    await msg.reply(`❌ ${(err as Error).message}`)
  }
}

/** "video <url> 480" → { query: url, height: 480 } */
function splitHeight(args: string): { query: string; height: number } {
  const H = '(144|240|360|480|720|1080|1440|2160)p?'
  const m = new RegExp(`^(.*?)\\s+${H}$`, 'i').exec(args) ?? new RegExp(`^${H}\\s+(.*)$`, 'i').exec(args)
  if (!m) return { query: args, height: DEFAULT_HEIGHT }
  const [a, b] = [m[1], m[2]]
  return /^\d+$/.test(b) ? { query: a, height: Number(b) } : { query: b, height: Number(a) }
}

command(
  {
    name: 'yts',
    desc: 'Search YouTube',
    usage: '<query>',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: yts <query>_')
    const results = (await media.ytSearch(args, 8)) as Entry[]
    if (!results.length) return msg.reply(`_No results for_ *${args}*`)
    const text = results.map((r, i) => `${i + 1}. *${r.title}*\n⏱ ${hms(r.duration)} · 👤 ${by(r)}\n🔗 ${ytUrl(r)}`).join('\n\n')
    await msg.reply(text)
  },
)

command(
  {
    name: 'song',
    aliases: ['yta', 'play'],
    desc: 'Download a song from YouTube as mp3',
    usage: '<name | url>',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    const query = args || msg.quoted?.text || ''
    if (!query) return msg.reply('_Usage: song <name | YouTube url>_')
    let file: string | undefined
    await job(msg, async () => {
      const url = await resolve(query)
      const info = await media.ytInfo(url, cookieArgs())
      if ((info.duration ?? 0) > MAX_SONG_SECONDS) throw new Error(`Too long (${hms(info.duration)}). Songs are capped at 60 minutes.`)
      file = await media.ytDownload(url, 'audio', { extra: cookieArgs() })
      const size = await fileSize(file)
      if (size > MAX_MEDIA) throw new Error(`Audio is ${formatBytes(size)}, over the ${MAX_MEDIA / MB}MB limit.`)
      await msg.reply(`🎵 *${info.title}*\n👤 ${by(info)} · ⏱ ${hms(info.duration)}`)
      await msg.reply({
        audio: await fs.readFile(file),
        mimetype: 'audio/mpeg',
        seconds: info.duration ? Math.round(info.duration) : undefined,
        fileName: `${safeName(info.title)}.mp3`,
      } as Parameters<Message['reply']>[0])
    })
    await media.removeFile(file)
  },
)

/** Shared by `video` and `ytdoc`. */
async function sendVideo(msg: Message, args: string, asDocument: boolean) {
  const { query, height } = splitHeight(args || msg.quoted?.text || '')
  if (!query) return msg.reply(`_Usage: ${asDocument ? 'ytdoc' : 'video'} <name | YouTube url> [480]_`)
  const limit = asDocument ? MAX_DOC : MAX_MEDIA
  let file: string | undefined
  await job(msg, async () => {
    const url = await resolve(query)
    const info = await media.ytInfo(url, cookieArgs())
    const tooBig = (bytes: number) =>
      new Error(`Video is ~${formatBytes(bytes)}, over the ${formatBytes(limit)} limit.${asDocument ? '' : ' Try a lower quality (e.g. `video <url> 360`) or `ytdoc`.'}`)
    if (info.filesize_approx && info.filesize_approx > limit * 1.2) throw tooBig(info.filesize_approx)
    file = await media.ytDownload(url, 'video', { maxHeight: height, extra: cookieArgs() })
    const size = await fileSize(file)
    if (size > limit) throw tooBig(size)
    const caption = `🎬 *${info.title}*\n👤 ${by(info)} · ⏱ ${hms(info.duration)} · ${height}p · ${formatBytes(size)}`
    const opts = { mediaUploadTimeoutMs: 30 * 60 * 1000 }
    if (asDocument) await msg.reply({ document: { url: file }, mimetype: 'video/mp4', fileName: `${safeName(info.title)}.mp4`, caption }, opts)
    else await msg.reply({ video: { url: file }, caption }, opts)
  })
  await media.removeFile(file)
}

command(
  {
    name: 'video',
    aliases: ['ytv'],
    desc: 'Download a YouTube video (720p by default, add 480/360 for smaller)',
    usage: '<name | url> [height]',
    category: 'download',
    public: true,
  },
  (msg, args) => sendVideo(msg, args, false),
)

command(
  {
    name: 'ytdoc',
    desc: 'Download a YouTube video and send it as a document (larger files allowed)',
    usage: '<name | url> [height]',
    category: 'download',
    public: true,
  },
  (msg, args) => sendVideo(msg, args, true),
)
