/**
 * Headlines: Google News, Reddit and Hacker News.
 * All three sources were checked with curl from the deployment VM on 2026-10-16.
 */
import { XMLParser } from 'fast-xml-parser'
import { command, type Message } from '../core/index.js'

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' })

async function safely(msg: Message, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    await msg.reply(`_${(err as Error).message}_`)
  }
}

/** "3h ago" style relative time. */
function ago(date: string | number | undefined): string {
  if (!date) return ''
  const ts = typeof date === 'number' ? date * 1000 : Date.parse(date)
  if (Number.isNaN(ts)) return ''
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

const text = (v: unknown): string => (typeof v === 'object' && v !== null ? String((v as { '#text'?: unknown })['#text'] ?? '') : String(v ?? '')).trim()
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

// ---------- google news ----------

interface RssItem {
  title?: unknown
  link?: unknown
  pubDate?: unknown
  source?: unknown
}

/**
 * Google News RSS: `/rss/search?q=` for a topic, `/rss` for top stories. Returns ~100 items with
 * a `<source>` tag per item; titles end with " - Source", which we strip. Verified from the VM.
 */
command(
  {
    name: 'news',
    desc: 'Top headlines from Google News, optionally about a topic',
    usage: '[topic]',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const topic = args.trim()
    const locale = 'hl=en-IN&gl=IN&ceid=IN:en'
    const url = topic ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&${locale}` : `https://news.google.com/rss?${locale}`
    await safely(msg, async () => {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`Google News returned HTTP ${res.status}.`)
      const feed = xml.parse(await res.text()) as { rss?: { channel?: { item?: RssItem | RssItem[] } } }
      const items = asArray(feed.rss?.channel?.item).slice(0, 8)
      if (!items.length) return msg.reply(topic ? `_No news found for_ *${topic}*` : '_No headlines right now._')
      const lines = items.map((it, i) => {
        const source = text(it.source)
        let title = text(it.title)
        if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3)
        const meta = [source, ago(text(it.pubDate))].filter(Boolean).join(' · ')
        return `${i + 1}. *${title}*${meta ? `\n   _${meta}_` : ''}\n   ${text(it.link)}`
      })
      await msg.reply(`📰 *${topic ? `News: ${topic}` : 'Top headlines'}*\n\n${lines.join('\n\n')}`)
    })
  },
)

// ---------- reddit ----------

interface RedditPost {
  title: string
  score?: number
  num_comments?: number
  permalink: string
  url?: string
  author?: string
  created_utc?: number
  over_18?: boolean
  stickied?: boolean
}

interface AtomEntry {
  title?: unknown
  link?: { '@_href'?: string } | { '@_href'?: string }[]
  author?: { name?: unknown }
  published?: unknown
}

/**
 * Reddit's JSON API answers 403 to this VM's IP (datacenter range) no matter the User-Agent, but
 * the Atom feed (`/r/<sub>/<sort>.rss`) works, so JSON is tried first (it has scores and comment
 * counts) and the feed is the fallback. Reddit also rate-limits bursts with 429, which we report
 * instead of retrying.
 */
async function redditPosts(sub: string, sort: string, limit: number): Promise<{ posts: RedditPost[]; via: 'json' | 'rss' }> {
  const base = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}`
  const jsonRes = await fetch(`${base}.json?limit=${limit + 2}&raw_json=1`, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
  if (jsonRes?.ok) {
    const data = (await jsonRes.json()) as { data?: { children?: { data: RedditPost }[] } }
    const posts = (data.data?.children ?? []).map((c) => c.data).filter((p) => !p.stickied)
    return { posts, via: 'json' }
  }
  if (jsonRes?.status === 404) throw new Error(`r/${sub} doesn't exist.`)
  await jsonRes?.body?.cancel().catch(() => {})

  const rssRes = await fetch(`${base}.rss?limit=${limit}`, { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (rssRes.status === 429) throw new Error('Reddit is rate-limiting this server. Try again in a minute.')
  if (rssRes.status === 404) throw new Error(`r/${sub} doesn't exist.`)
  if (!rssRes.ok) throw new Error(`Reddit is blocking this server (HTTP ${rssRes.status}).`)
  const feed = xml.parse(await rssRes.text()) as { feed?: { entry?: AtomEntry | AtomEntry[] } }
  const posts = asArray(feed.feed?.entry).map((e) => {
    const link = asArray(e.link)[0]?.['@_href'] ?? ''
    return { title: text(e.title), permalink: link.replace(/^https:\/\/www\.reddit\.com/, ''), author: text(e.author?.name).replace(/^\/u\//, ''), created_utc: Date.parse(text(e.published)) / 1000 || undefined }
  })
  return { posts, via: 'rss' }
}

command(
  {
    name: 'reddit',
    desc: 'Top posts from a subreddit',
    usage: '<subreddit> [hot|new|top]',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const [subRaw, sortRaw] = args.trim().split(/\s+/)
    const sub = (subRaw ?? '').replace(/^\/?r\//i, '').replace(/\/$/, '')
    if (!sub || !/^[\w]+$/.test(sub)) return msg.reply('_Usage: reddit <subreddit> [hot|new|top]_')
    const sort = ['hot', 'new', 'top', 'rising'].includes((sortRaw ?? '').toLowerCase()) ? sortRaw!.toLowerCase() : 'hot'
    await safely(msg, async () => {
      const { posts, via } = await redditPosts(sub, sort, 8)
      const shown = posts.slice(0, 8)
      if (!shown.length) return msg.reply(`_No posts in r/${sub} right now._`)
      const lines = shown.map((p, i) => {
        const stats = via === 'json' ? `⬆️ ${p.score ?? 0} · 💬 ${p.num_comments ?? 0}` : ''
        const meta = [p.over_18 && 'NSFW', stats, p.author && `u/${p.author}`, ago(p.created_utc)].filter(Boolean).join(' · ')
        return `${i + 1}. *${p.title}*\n   _${meta}_\n   https://www.reddit.com${p.permalink}`
      })
      await msg.reply(`👽 *r/${sub}* · ${sort}\n\n${lines.join('\n\n')}`)
    })
  },
)

// ---------- hacker news ----------

interface HnItem {
  id: number
  title?: string
  url?: string
  score?: number
  by?: string
  descendants?: number
  time?: number
}

/** Official Firebase API; verified from the VM. */
command(
  {
    name: 'hn',
    desc: 'Hacker News front page (top 10)',
    category: 'search',
    public: true,
  },
  async (msg) => {
    await safely(msg, async () => {
      const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(15_000) })
      if (!idsRes.ok) throw new Error(`Hacker News returned HTTP ${idsRes.status}.`)
      const ids = ((await idsRes.json()) as number[]).slice(0, 10)
      const items = await Promise.all(
        ids.map(async (id) => {
          const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(15_000) })
          return (r.ok ? await r.json() : undefined) as HnItem | undefined
        }),
      )
      const lines = items
        .filter((it): it is HnItem => !!it?.title)
        .map((it, i) => {
          const hn = `https://news.ycombinator.com/item?id=${it.id}`
          const meta = [`⬆️ ${it.score ?? 0}`, `💬 ${it.descendants ?? 0}`, it.by && `by ${it.by}`, ago(it.time)].filter(Boolean).join(' · ')
          return `${i + 1}. *${it.title}*\n   _${meta}_\n   ${it.url ?? hn}${it.url ? `\n   💬 ${hn}` : ''}`
        })
      await msg.reply(`🟠 *Hacker News* · top ${lines.length}\n\n${lines.join('\n\n')}`)
    })
  },
)
