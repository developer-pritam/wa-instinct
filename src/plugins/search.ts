import { command, config, media, type Message } from '../core/index.js'

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Report an error to the chat instead of letting it bubble up (these are public commands). */
async function safely(msg: Message, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    await msg.reply(`❌ ${(err as Error).message}`)
  }
}

// ---------- weather ----------

const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]
const clock = (unix: number, offset: number) => new Date((unix + offset) * 1000).toISOString().slice(11, 16)

command(
  {
    name: 'weather',
    desc: 'Current weather for a city (OpenWeather)',
    usage: '<city>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: weather <city>_')
    if (!config.keys.openWeather) return msg.reply('_Set OPENWEATHER_KEY in .env (free key from openweathermap.org) to use weather._')
    type W = {
      cod: number | string; message?: string; name: string; timezone: number
      sys: { country: string; sunrise: number; sunset: number }
      weather: { description: string }[]
      main: { temp: number; feels_like: number; humidity: number }
      visibility: number; wind: { speed: number; deg: number }
    }
    await safely(msg, async () => {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(args)}&units=metric&appid=${config.keys.openWeather}`
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      const w = (await res.json()) as W
      if (String(w.cod) !== '200') return msg.reply(w.cod === '404' || w.cod === 404 ? `_${args} not found_` : `❌ ${w.message ?? 'weather lookup failed'}`)
      await msg.reply(
        `*Name :* ${w.name}\n*Country :* ${w.sys.country}\n*Weather :* ${w.weather[0]?.description ?? '-'}\n` +
          `*Temp :* ${w.main.temp.toFixed(1)}°C\n*Feels Like :* ${w.main.feels_like.toFixed(1)}°C\n*Humidity :* ${w.main.humidity}%\n` +
          `*Visibility :* ${w.visibility}m\n*Wind :* ${w.wind.speed}m/s ${compass(w.wind.deg)}\n` +
          `*Sunrise :* ${clock(w.sys.sunrise, w.timezone)}\n*Sunset :* ${clock(w.sys.sunset, w.timezone)}`,
      )
    })
  },
)

// ---------- movie ----------

command(
  {
    name: 'movie',
    aliases: ['imdb'],
    desc: 'Movie / series details with the full plot (OMDb)',
    usage: '<title>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: movie <title>_')
    if (!config.keys.omdb) return msg.reply('_Set OMDB_KEY in .env (free key from omdbapi.com) to use movie._')
    await safely(msg, async () => {
      const m = await getJson<Record<string, string>>(`https://www.omdbapi.com/?apikey=${config.keys.omdb}&t=${encodeURIComponent(args)}&plot=full`)
      if (m.Response !== 'True') return msg.reply('_Movie not found. Please verify the title and try again._')
      const skip = new Set(['Poster', 'Response', 'Ratings'])
      const text = Object.entries(m)
        .filter(([k, v]) => !skip.has(k) && v && v !== 'N/A')
        .map(([k, v]) => `*${k} :* ${v}`)
        .join('\n')
      if (!m.Poster || m.Poster === 'N/A') return msg.reply(text)
      await msg.sendFromUrl(m.Poster, { caption: text, quoted: msg.raw }).catch(() => msg.reply(text))
    })
  },
)

// ---------- wikipedia ----------

command(
  {
    name: 'wiki',
    aliases: ['wikipedia'],
    desc: 'Wikipedia summary of a topic',
    usage: '<topic>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: wiki <topic>_')
    type Summary = { type: string; title: string; extract: string; thumbnail?: { source: string }; content_urls?: { desktop?: { page: string } } }
    await safely(msg, async () => {
      // resolve the exact article title through search first (handles typos / casing)
      const [, hits] = await getJson<[string, string[]]>(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search=${encodeURIComponent(args)}`)
      const title = hits?.[0] ?? args
      const s = await getJson<Summary>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`).catch(() => undefined)
      if (!s || s.type === 'disambiguation' && !s.extract) return msg.reply(`_No Wikipedia article for_ *${args}*`)
      const text = `*${s.title}*\n\n${s.extract}\n\n${s.content_urls?.desktop?.page ?? ''}`.trim()
      if (s.thumbnail?.source) await msg.sendFromUrl(s.thumbnail.source, { caption: text, quoted: msg.raw }).catch(() => msg.reply(text))
      else await msg.reply(text)
    })
  },
)

// ---------- dictionary ----------

command(
  {
    name: 'define',
    aliases: ['dict'],
    desc: 'Dictionary definition of an English word',
    usage: '<word>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const word = args.split(/\s+/)[0]
    if (!word) return msg.reply('_Usage: define <word>_')
    type Entry = { word: string; phonetic?: string; meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[] }
    await safely(msg, async () => {
      const entries = await getJson<Entry[]>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`).catch(() => [])
      const e = entries[0]
      if (!e) return msg.reply(`_No definition found for_ *${word}*`)
      let text = `*${e.word}*${e.phonetic ? ` _${e.phonetic}_` : ''}\n`
      for (const m of e.meanings.slice(0, 4)) {
        text += `\n_${m.partOfSpeech}_\n`
        m.definitions.slice(0, 2).forEach((d, i) => {
          text += `${i + 1}. ${d.definition}\n`
          if (d.example) text += `   _"${d.example}"_\n`
        })
      }
      await msg.reply(text.trim())
    })
  },
)

// ---------- lyrics ----------

command(
  {
    name: 'lyrics',
    aliases: ['lyric'],
    desc: 'Find the lyrics of a song',
    usage: '<song> [- artist]',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: lyrics <song name>_')
    type Track = { trackName: string; artistName: string; plainLyrics?: string }
    await safely(msg, async () => {
      const tracks = await getJson<Track[]>(`https://lrclib.net/api/search?q=${encodeURIComponent(args)}`)
      const t = tracks.find((x) => x.plainLyrics)
      if (!t) return msg.reply("_Couldn't find those lyrics. Typing error?_ 🧐")
      await msg.reply(`🎤 *${t.trackName}* — ${t.artistName}\n\n${t.plainLyrics}`)
    })
  },
)

// ---------- image search ----------

command(
  {
    name: 'img',
    aliases: ['image'],
    desc: 'Image search (Bing); "img 5 cats" for more results',
    usage: '[count] <query>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const m = /^(\d{1,2})\s+(.+)$/.exec(args)
    const query = (m ? m[2] : args).trim()
    const count = Math.min(Math.max(m ? Number(m[1]) : 3, 1), 10)
    if (!query) return msg.reply('_Usage: img <query> · img 5 <query>_')
    await safely(msg, async () => {
      const res = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`, { headers: UA, signal: AbortSignal.timeout(20_000) })
      const html = await res.text()
      const urls = [...new Set([...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g)].map((x) => x[1]))]
      if (!urls.length) return msg.reply(`_No images found for_ *${query}*`)
      let sent = 0
      for (const url of urls) {
        if (sent >= count) break
        const img = await media.fetchBuffer(url, { headers: UA, maxBytes: 15 * 1024 * 1024, timeoutMs: 15_000 }).catch(() => undefined)
        if (!img || media.mediaKind(img.mimetype) !== 'image') continue
        await msg.send({ image: img.buffer })
        sent++
      }
      if (!sent) await msg.reply(`_Couldn't fetch any images for_ *${query}*`)
    })
  },
)

// ---------- translate / tts ----------

const LANG_RE = /^([a-z]{2,3}(?:-[a-zA-Z]{2,4})?)(?:\s+|$)/

/** "hi some text" → { lang: 'hi', text: 'some text' }; text falls back to the quoted message. */
function langAndText(msg: Message, args: string, fallbackLang = 'en'): { lang: string; text: string } {
  const m = LANG_RE.exec(args)
  const lang = m?.[1] ?? fallbackLang
  const text = (m ? args.slice(m[0].length) : args).trim() || msg.quoted?.text || ''
  return { lang, text }
}

async function translate(text: string, to: string): Promise<{ text: string; from: string }> {
  const q = encodeURIComponent(text)
  try {
    type Gtx = [[string, string][], string | null, string]
    const r = await getJson<Gtx>(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${q}`)
    return { text: r[0].map((p) => p[0]).join(''), from: r[2] }
  } catch {
    // gtx is rate-limited on some IPs; this older endpoint usually still answers
    const r = await getJson<[string, string][] | [string, string]>(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${to}&q=${q}`)
    const first = Array.isArray(r[0]) ? (r as [string, string][])[0] : (r as [string, string])
    return { text: first[0], from: first[1] }
  }
}

command(
  {
    name: 'trt',
    aliases: ['translate'],
    desc: 'Translate text (Google Translate); reply to a message or pass the text',
    usage: '<lang> [text | reply]',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const { lang, text } = langAndText(msg, args)
    if (!text) return msg.reply('_Usage: trt hi <text> · trt hi (reply to a message)_')
    await safely(msg, async () => {
      const r = await translate(text, lang)
      await msg.reply(r.text, { quoted: msg.quoted?.raw ?? msg.raw })
    })
  },
)

/** Google TTS only speaks ~200 chars per request, so split on sentence/word boundaries. */
function chunks(text: string, max = 190): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > max && cur) {
      out.push(cur.trim())
      cur = ''
    }
    cur += ' ' + word
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

command(
  {
    name: 'tts',
    desc: 'Text to speech as a voice note (Google TTS)',
    usage: '<lang> <text | reply>',
    category: 'search',
    public: true,
  },
  async (msg, args) => {
    const { lang, text } = langAndText(msg, args)
    if (!text) return msg.reply('_Usage: tts en <text> · tts hi (reply to a message)_')
    if (text.length > 2000) return msg.reply('_Too long - keep it under 2000 characters._')
    await safely(msg, async () => {
      const parts: Buffer[] = []
      for (const part of chunks(text)) {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(part)}`
        const { buffer } = await media.fetchBuffer(url, { headers: { ...UA, referer: 'https://translate.google.com/' }, timeoutMs: 20_000 })
        parts.push(buffer)
      }
      const voice = await media.toOpusVoice(Buffer.concat(parts), 'mp3')
      await msg.reply({ audio: voice, mimetype: 'audio/ogg; codecs=opus', ptt: true })
    })
  },
)
