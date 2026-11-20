/**
 * spotify <track url | query>: Spotify streams can't be downloaded directly, so we resolve the
 * track's title (oEmbed + og: tags), find it on YouTube and send the mp3 — same path as `song`.
 * Album / playlist links list their first tracks so the user can pick one.
 */
import { promises as fs } from 'node:fs'
import { command, formatBytes, media, type Message } from '../core/index.js'
import { MAX_MEDIA, MB, cookieArgs, fileSize, hms, safeName } from './_ytdlp.js'

const MAX_SECONDS = 60 * 60
const LIST_LIMIT = 10
const SPOTIFY_RE = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(track|album|playlist|episode)[/:]([A-Za-z0-9]+)/i
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' }

interface Track {
  title: string
  artist?: string
}

const fetchText = async (url: string) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Spotify returned HTTP ${res.status}`)
  return res.text()
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

/** `<meta property="og:title" content="…">` → value (property or name attribute, either order). */
function metaTag(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i')
  const m = re.exec(html)
  return m ? decode(m[1] ?? m[2]) : undefined
}

const metaTags = (html: string, key: string): string[] =>
  [...html.matchAll(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'gi'))].map((m) => decode(m[1]))

interface Entity {
  name?: string
  title?: string
  artists?: { name?: string }[]
  trackList?: { title?: string; subtitle?: string }[]
}

/** Find the first value stored under `key` anywhere in parsed JSON. */
function findKey<T>(node: unknown, key: string, depth = 0): T | undefined {
  if (!node || typeof node !== 'object' || depth > 12) return undefined
  const obj = node as Record<string, unknown>
  if (key in obj) return obj[key] as T
  for (const v of Object.values(obj)) {
    const found = findKey<T>(v, key, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The public pages are a JS shell, but open.spotify.com/embed/... ships the entity as JSON
 * in __NEXT_DATA__ (name, artists, trackList). Undefined when it can't be read.
 */
async function embedEntity(kind: string, id: string): Promise<Entity | undefined> {
  const html = await fetchText(`https://open.spotify.com/embed/${kind}/${id}`).catch(() => '')
  const json = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!json) return undefined
  try {
    return findKey<Entity>(JSON.parse(json) as unknown, 'entity')
  } catch {
    return undefined
  }
}

/** Title / artist of a track: embed JSON first, Spotify's oEmbed title as the fallback. */
export async function trackInfo(kind: string, id: string): Promise<Track> {
  const url = `https://open.spotify.com/${kind}/${id}`
  const [entity, oembed] = await Promise.all([
    embedEntity(kind, id),
    fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { headers: UA, signal: AbortSignal.timeout(20_000) })
      .then((r): Promise<{ title?: string }> => (r.ok ? (r.json() as Promise<{ title?: string }>) : Promise.resolve({})))
      .catch((): { title?: string } => ({})),
  ])
  const title = entity?.name ?? entity?.title ?? oembed.title
  if (!title) throw new Error('Could not read that Spotify link.')
  const artist = entity?.artists?.map((a) => a.name).filter(Boolean).join(', ')
  return { title, artist: artist || undefined }
}

/** Name + first tracks of an album / playlist. */
export async function collectionInfo(kind: string, id: string): Promise<{ name: string; tracks: Track[] }> {
  const entity = await embedEntity(kind, id)
  let name = entity?.name ?? ''
  let tracks: Track[] = (entity?.trackList ?? []).filter((t) => t.title).map((t) => ({ title: t.title!, artist: t.subtitle }))
  if (!tracks.length) {
    // fallback: the public page lists one <meta name="music:song"> per track; resolve each via oEmbed
    const html = await fetchText(`https://open.spotify.com/${kind}/${id}`)
    name = name || metaTag(html, 'og:title') || ''
    const urls = metaTags(html, 'music:song').slice(0, LIST_LIMIT)
    tracks = await Promise.all(urls.map((u) => trackInfo('track', u.split('/').pop() ?? '').catch(() => ({ title: u }))))
  }
  return { name: name || kind, tracks }
}

/** Search YouTube for the track and send the mp3 — mirrors `song` in youtube.ts. */
async function sendTrack(msg: Message, query: string, label?: string) {
  const [hit] = await media.ytSearch(query, 1)
  if (!hit) throw new Error(`Nothing found on YouTube for *${query}*`)
  const url = hit.webpage_url ?? (hit as { url?: string }).url ?? `https://www.youtube.com/watch?v=${hit.id}`
  const info = await media.ytInfo(url, cookieArgs())
  if ((info.duration ?? 0) > MAX_SECONDS) throw new Error(`Too long (${hms(info.duration)}). Tracks are capped at 60 minutes.`)
  const file = await media.ytDownload(url, 'audio', { extra: cookieArgs() })
  try {
    const size = await fileSize(file)
    if (size > MAX_MEDIA) throw new Error(`Audio is ${formatBytes(size)}, over the ${MAX_MEDIA / MB}MB limit.`)
    await msg.reply(`🎧 *${label ?? info.title}*\n▶️ ${info.title} · ⏱ ${hms(info.duration)}`)
    await msg.reply({
      audio: await fs.readFile(file),
      mimetype: 'audio/mpeg',
      seconds: info.duration ? Math.round(info.duration) : undefined,
      fileName: `${safeName(label ?? info.title)}.mp3`,
    } as Parameters<Message['reply']>[0])
  } finally {
    await media.removeFile(file)
  }
}

command(
  {
    name: 'spotify',
    desc: 'Get a Spotify track as mp3 (via YouTube); album/playlist links list their tracks',
    usage: '<track url | query>',
    category: 'download',
    public: true,
  },
  async (msg, args) => {
    const input = args || msg.quoted?.text || ''
    if (!input) return msg.reply('_Usage: spotify <track url | song name>_')
    await msg.react('⏳')
    try {
      const m = SPOTIFY_RE.exec(input)
      if (!m) {
        await sendTrack(msg, input)
      } else if (m[1].toLowerCase() === 'track' || m[1].toLowerCase() === 'episode') {
        const { title, artist } = await trackInfo(m[1].toLowerCase(), m[2])
        await sendTrack(msg, artist ? `${artist} ${title}` : title, artist ? `${title} — ${artist}` : title)
      } else {
        const { name, tracks } = await collectionInfo(m[1].toLowerCase(), m[2])
        if (!tracks.length) throw new Error('Could not read the track list from that link.')
        const shown = tracks.slice(0, LIST_LIMIT)
        const list = shown.map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`).join('\n')
        const more = tracks.length > shown.length ? `\n_…and ${tracks.length - shown.length} more_` : ''
        await msg.reply(`🎧 *${name}*\n${list}${more}\n\n_Pick one: spotify <track name>_`)
      }
      await msg.react('✅')
    } catch (err) {
      await msg.react('❌')
      await msg.reply(`❌ ${(err as Error).message}`)
    }
  },
)
