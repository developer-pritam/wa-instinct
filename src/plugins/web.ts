/**
 * Web utilities: screenshots, uploads, URL shortening, site/IP/domain lookups and APK downloads.
 *
 * No browser is installed on the host, so everything goes through small HTTP services.
 * Each service was checked with curl from the deployment VM on 2026-10-16 — see the comments
 * above each helper for what was (and wasn't) confirmed.
 */
import { command, formatBytes, media, sleep, type Message } from '../core/index.js'

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
const MAX_UPLOAD = 100 * 1024 * 1024

/** First http(s) URL in a text, or the text itself with https:// prepended when it looks like a bare domain. */
function pickUrl(text: string): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  const m = t.match(/https?:\/\/[^\s<>"']+/i)
  if (m) return m[0]
  const bare = t.split(/\s+/)[0]
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(bare)) return `https://${bare}`
  return undefined
}

/** URL from args, falling back to the replied message's text. */
const urlFrom = (msg: Message, args: string) => pickUrl(args) ?? pickUrl(msg.quoted?.text ?? '')

const host = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Report an error in the chat instead of letting it bubble up. */
async function safely(msg: Message, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    await msg.reply(`_${(err as Error).message}_`)
  }
}

// ---------- screenshots ----------

/**
 * thum.io: free, no key, returns a PNG. Verified from the VM (200 image/png for both the normal
 * and the /fullpage/ variants). mshots (WordPress) is the fallback: it answers 403 without a
 * browser User-Agent and returns a tiny placeholder GIF while it renders, so we poll until a JPEG
 * comes back. Verified 200 image/jpeg with the desktop UA.
 */
async function screenshot(url: string, full: boolean): Promise<Buffer> {
  const thum = `https://image.thum.io/get/${full ? 'fullpage/' : ''}width/1280/${url}`
  const first = await media.fetchBuffer(thum, { headers: UA, timeoutMs: 60_000, maxBytes: 20 * 1024 * 1024 }).catch(() => undefined)
  if (first && first.mimetype.startsWith('image/') && first.buffer.length > 2000) return first.buffer

  const mshots = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1280${full ? '&h=4000' : ''}`
  for (let i = 0; i < 8; i++) {
    const res = await media.fetchBuffer(mshots, { headers: UA, timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 })
    // the "please wait" placeholder is a small GIF; the real capture is a JPEG
    if (res.mimetype !== 'image/gif') return res.buffer
    await sleep(3000)
  }
  throw new Error('Screenshot service timed out, try again in a bit.')
}

command(
  {
    name: 'ss',
    aliases: ['screenshot'],
    desc: 'Screenshot a web page (add "full" for the whole page)',
    usage: '<url> [full]',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const url = urlFrom(msg, args)
    if (!url) return msg.reply('_Usage: ss <url> [full]_')
    const full = /\bfull\b/i.test(args)
    await safely(msg, async () => {
      await msg.react('⏳')
      const image = await screenshot(url, full)
      await msg.reply({ image, caption: `🌐 ${host(url)}${full ? ' (full page)' : ''}` })
      await msg.react('')
    })
  },
)

// ---------- uploads ----------

interface Uploader {
  name: string
  note: string
  upload: (file: Blob, name: string) => Promise<string>
}

/** POST a multipart form and return the trimmed text body (must be a URL). */
async function postForm(endpoint: string, form: FormData): Promise<string> {
  const res = await fetch(endpoint, { method: 'POST', body: form, headers: UA, signal: AbortSignal.timeout(5 * 60_000) })
  const text = (await res.text()).trim()
  if (!res.ok || !/^https?:\/\/\S+$/.test(text)) throw new Error(text.slice(0, 80) || `HTTP ${res.status}`)
  return text
}

/**
 * Tried in order; the first that returns a link wins.
 * - catbox.moe (permanent): the VM gets "Invalid uploader" (catbox refuses this IP range), but it
 *   works from most networks so it stays first.
 * - litterbox (catbox's temp service, 72h): verified working from the VM.
 * - x0.at (temp, expiry depends on size): verified working from the VM.
 * - 0x0.st, which the original plan named, has anonymous uploads disabled (checked); not used.
 */
const UPLOADERS: Uploader[] = [
  {
    name: 'catbox.moe',
    note: 'permanent',
    upload: (file, name) => {
      const form = new FormData()
      form.set('reqtype', 'fileupload')
      form.set('fileToUpload', file, name)
      return postForm('https://catbox.moe/user/api.php', form)
    },
  },
  {
    name: 'litterbox',
    note: 'expires in 72h',
    upload: (file, name) => {
      const form = new FormData()
      form.set('reqtype', 'fileupload')
      form.set('time', '72h')
      form.set('fileToUpload', file, name)
      return postForm('https://litterbox.catbox.moe/resources/internals/api.php', form)
    },
  },
  {
    name: 'x0.at',
    note: 'temporary',
    upload: (file, name) => {
      const form = new FormData()
      form.set('file', file, name)
      return postForm('https://x0.at', form)
    },
  },
]

function extFor(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4',
    'audio/mpeg': 'mp3', 'audio/ogg; codecs=opus': 'ogg', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'application/pdf': 'pdf',
  }
  return map[mime] ?? mime.split('/')[1]?.split(';')[0] ?? 'bin'
}

command(
  {
    name: 'url',
    aliases: ['tourl'],
    desc: 'Upload the replied media and get a direct link',
    usage: '(reply to media)',
    category: 'misc',
  },
  async (msg) => {
    const q = msg.quoted
    if (!q?.hasMedia) return msg.reply('_Usage: url (reply to an image, video, audio, sticker or document)_')
    const rawLen = q.media?.fileLength
    const size = typeof rawLen === 'number' ? rawLen : Number(rawLen?.toString() ?? 0) // may be a protobuf Long
    if (size > MAX_UPLOAD) return msg.reply(`_File is ${formatBytes(size)}; the limit is 100 MB._`)
    await safely(msg, async () => {
      await msg.react('⏳')
      const buffer = await q.download()
      if (buffer.length > MAX_UPLOAD) throw new Error(`File is ${formatBytes(buffer.length)}; the limit is 100 MB.`)
      const mime = q.mimetype.split(';')[0] || 'application/octet-stream'
      const docName = q.content.documentMessage?.fileName ?? q.content.documentWithCaptionMessage?.message?.documentMessage?.fileName
      const name = docName || `${Date.now()}.${extFor(q.mimetype)}`
      const file = new Blob([new Uint8Array(buffer)], { type: mime })

      const errors: string[] = []
      for (const u of UPLOADERS) {
        try {
          const link = await u.upload(file, name)
          await msg.react('')
          return msg.reply(`🔗 ${link}\n\n_${formatBytes(buffer.length)} · ${u.name} (${u.note})_`)
        } catch (err) {
          errors.push(`${u.name}: ${(err as Error).message}`)
        }
      }
      throw new Error(`Upload failed.\n${errors.join('\n')}`)
    })
  },
)

// ---------- shortening ----------

/** is.gd verified from the VM; tinyurl verified as the fallback. Both are plain-text APIs. */
async function shorten(url: string): Promise<string> {
  const attempts = [
    `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`,
    `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
  ]
  let lastError = 'unknown error'
  for (const api of attempts) {
    try {
      const res = await fetch(api, { headers: UA, signal: AbortSignal.timeout(15_000) })
      const text = (await res.text()).trim()
      if (res.ok && /^https?:\/\/\S+$/.test(text)) return text
      lastError = text.slice(0, 100) || `HTTP ${res.status}`
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  throw new Error(`Couldn't shorten that link: ${lastError}`)
}

command(
  {
    name: 'short',
    aliases: ['shorten'],
    desc: 'Shorten a link (is.gd, falls back to tinyurl)',
    usage: '<url>',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const url = urlFrom(msg, args)
    if (!url) return msg.reply('_Usage: short <url>_')
    await safely(msg, async () => msg.reply(`🔗 ${await shorten(url)}`))
  },
)

/** Follow redirects by hand so we can show every hop. */
async function unshorten(url: string, maxHops = 10): Promise<string[]> {
  const hops = [url]
  let current = url
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(15_000) })
    await res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return hops
    current = new URL(location, current).toString()
    hops.push(current)
  }
  return hops
}

command(
  {
    name: 'unshort',
    desc: 'Expand a shortened link and show where it really goes',
    usage: '<url>',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const url = urlFrom(msg, args)
    if (!url) return msg.reply('_Usage: unshort <url>_')
    await safely(msg, async () => {
      const hops = await unshorten(url)
      if (hops.length === 1) return msg.reply(`_That link doesn't redirect anywhere._\n${url}`)
      const final = hops[hops.length - 1]
      const chain = hops.length > 2 ? `\n\n_${hops.length - 1} hops:_\n${hops.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : ''
      await msg.reply(`🔗 *Final URL*\n${final}${chain}`)
    })
  },
)

// ---------- site check ----------

command(
  {
    name: 'site',
    desc: 'Check a website: HTTP status, server, content type, response time',
    usage: '<url>',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const url = urlFrom(msg, args)
    if (!url) return msg.reply('_Usage: site <url>_')
    const started = Date.now()
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
      const ms = Date.now() - started
      await res.body?.cancel().catch(() => {})
      const h = (name: string) => res.headers.get(name)
      const len = Number(h('content-length') ?? 0)
      const rows: [string, string | null][] = [
        ['Status', `${res.status} ${res.statusText}`.trim()],
        ['Time', `${ms} ms`],
        ['Server', h('server')],
        ['Powered by', h('x-powered-by')],
        ['Type', h('content-type')],
        ['Size', len ? formatBytes(len) : null],
        ['Last modified', h('last-modified')],
        ['Final URL', res.redirected ? res.url : null],
      ]
      const icon = res.ok ? '🟢' : res.status >= 500 ? '🔴' : '🟡'
      const lines = rows.filter(([, v]) => v).map(([k, v]) => `*${k}:* ${v}`)
      await msg.reply(`${icon} *${host(url)}*\n${lines.join('\n')}`)
    } catch (err) {
      await msg.reply(`🔴 *${host(url)}* is unreachable\n_${(err as Error).cause ? String((err as Error).cause) : (err as Error).message}_ (${Date.now() - started} ms)`)
    }
  },
)

// ---------- ip lookup ----------

interface IpApi {
  status: 'success' | 'fail'
  message?: string
  query: string
  country?: string
  regionName?: string
  city?: string
  zip?: string
  timezone?: string
  isp?: string
  org?: string
  as?: string
  lat?: number
  lon?: number
  proxy?: boolean
  hosting?: boolean
}

command(
  {
    name: 'ip',
    desc: 'Look up an IP address or domain (location, ISP, org)',
    usage: '<ip|domain>',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const target = args.trim() ? host(pickUrl(args) ?? args.trim()) : ''
    if (!target) return msg.reply('_Usage: ip <ip or domain>_')
    await safely(msg, async () => {
      // ip-api.com free tier is http only (https needs a key). Verified from the VM.
      const fields = 'status,message,query,country,regionName,city,zip,timezone,isp,org,as,lat,lon,proxy,hosting'
      const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(target)}?fields=${fields}`, { signal: AbortSignal.timeout(15_000) })
      const data = (await res.json()) as IpApi
      if (data.status !== 'success') throw new Error(`Lookup failed: ${data.message ?? 'unknown error'}`)
      const rows: [string, string | undefined][] = [
        ['IP', data.query],
        ['Location', [data.city, data.regionName, data.country].filter(Boolean).join(', ')],
        ['Zip', data.zip],
        ['Timezone', data.timezone],
        ['ISP', data.isp],
        ['Org', data.org],
        ['AS', data.as],
        ['Coords', data.lat !== undefined ? `${data.lat}, ${data.lon}` : undefined],
        ['Flags', [data.proxy && 'proxy/VPN', data.hosting && 'hosting/datacenter'].filter(Boolean).join(', ')],
      ]
      await msg.reply(`📡 *${target}*\n${rows.filter(([, v]) => v).map(([k, v]) => `*${k}:* ${v}`).join('\n')}`)
    })
  },
)

// ---------- domain whois (RDAP) ----------

interface Rdap {
  ldhName?: string
  status?: string[]
  events?: { eventAction: string; eventDate: string }[]
  nameservers?: { ldhName?: string }[]
  entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[]
  errorCode?: number
  title?: string
}

command(
  {
    name: 'whoisdomain',
    desc: 'Domain registration info: registrar, dates, nameservers',
    usage: '<domain>',
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    const domain = args.trim() ? host(pickUrl(args) ?? args.trim()).replace(/^www\./, '') : ''
    if (!domain || !domain.includes('.')) return msg.reply('_Usage: whoisdomain <domain>_')
    await safely(msg, async () => {
      // rdap.org redirects to the registry's RDAP server (fetch follows it). Verified from the VM.
      const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { ...UA, accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(20_000) })
      if (res.status === 404) throw new Error(`No registration found for ${domain} (not registered, or the TLD has no RDAP).`)
      if (!res.ok) throw new Error(`RDAP lookup failed (HTTP ${res.status}).`)
      const data = (await res.json()) as Rdap
      const registrar = data.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3]
      const date = (action: string) => {
        const ev = data.events?.find((e) => e.eventAction === action)
        return ev ? ev.eventDate.slice(0, 10) : undefined
      }
      const expires = date('expiration')
      const daysLeft = expires ? Math.round((new Date(expires).getTime() - Date.now()) / 86_400_000) : undefined
      const rows: [string, string | undefined][] = [
        ['Domain', (data.ldhName ?? domain).toLowerCase()],
        ['Registrar', registrar],
        ['Created', date('registration')],
        ['Updated', date('last changed')],
        ['Expires', expires ? `${expires}${daysLeft !== undefined ? ` (${daysLeft} days)` : ''}` : undefined],
        ['Status', data.status?.slice(0, 4).join(', ')],
        ['Nameservers', data.nameservers?.map((n) => n.ldhName?.toLowerCase()).filter(Boolean).join('\n  ')],
      ]
      await msg.reply(`🌐 *Whois*\n${rows.filter(([, v]) => v).map(([k, v]) => `*${k}:* ${v}`).join('\n')}`)
    })
  },
)

// ---------- apk ----------

/**
 * How it works (all verified from the VM on 2026-10-16):
 * - Package id: scraped from the Play Store search page (first /store/apps/details?id=…). Works
 *   without a key; the page is ~1 MB of HTML but we only regex it.
 * - Download: d.apkpure.com is behind a Cloudflare challenge here (403), but APKPure's CDN alias
 *   d.cdnpure.com/b/APK/<pkg>?version=latest answers with a 302 to the real file (a genuine zip,
 *   content-type application/vnd.android.package-archive). The Location carries filename= and
 *   full_size=, so we can refuse oversize files before downloading anything.
 * - If the CDN has nothing for the package (no redirect), we fall back to the Play Store link.
 */
const PLAY_SEARCH = (q: string) => `https://play.google.com/store/search?q=${encodeURIComponent(q)}&c=apps&hl=en`
const PLAY_APP = (pkg: string) => `https://play.google.com/store/apps/details?id=${pkg}`
const APK_CDN = (pkg: string) => `https://d.cdnpure.com/b/APK/${encodeURIComponent(pkg)}?version=latest`
const MAX_APK = 100 * 1024 * 1024

async function resolvePackage(query: string): Promise<{ pkg: string; title?: string } | undefined> {
  if (/^[a-z][\w]*(\.[a-z_][\w]*)+$/i.test(query)) return { pkg: query }
  const res = await fetch(PLAY_SEARCH(query), { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Play Store search failed (HTTP ${res.status}).`)
  const html = await res.text()
  const pkg = html.match(/\/store\/apps\/details\?id=([\w.]+)/)?.[1]
  if (!pkg) return undefined
  // the app's name sits in an aria-label / title near its link; cheap best-effort grab
  const title = html.match(new RegExp(`details\\?id=${pkg.replace(/\./g, '\\.')}[^>]*>(?:<[^>]+>)*([^<]{2,60})<`))?.[1]?.trim()
  return { pkg, title }
}

async function apkLocation(pkg: string): Promise<{ url: string; name: string; size: number } | undefined> {
  const res = await fetch(APK_CDN(pkg), { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(20_000) })
  await res.body?.cancel().catch(() => {})
  const location = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !location) return undefined
  const u = new URL(location, APK_CDN(pkg))
  const name = (u.searchParams.get('filename') ?? `${pkg}.apk`).replace(/\+/g, ' ')
  return { url: u.toString(), name, size: Number(u.searchParams.get('full_size') ?? 0) }
}

command(
  {
    name: 'apk',
    desc: 'Download an Android app (APK) by name or package id',
    usage: '<app name | package id>',
    category: 'misc',
  },
  async (msg, args) => {
    const query = args.trim()
    if (!query) return msg.reply('_Usage: apk <app name or package id>_')
    await safely(msg, async () => {
      await msg.react('🔍')
      const app = await resolvePackage(query)
      if (!app) {
        await msg.react('')
        return msg.reply("_Couldn't find that app on the Play Store._")
      }
      const label = app.title ? `${app.title} (${app.pkg})` : app.pkg
      const store = PLAY_APP(app.pkg)
      const file = await apkLocation(app.pkg).catch(() => undefined)
      if (!file) {
        await msg.react('')
        return msg.reply(`📱 *${label}*\n${store}\n\n_No APK download available for this package (it may be paid, region-locked or XAPK-only)._`)
      }
      if (file.size > MAX_APK) {
        await msg.react('')
        return msg.reply(`📱 *${label}*\n${store}\n\n_The APK is ${formatBytes(file.size)}, over the 100 MB send limit. Direct download:_\n${file.url}`)
      }
      await msg.react('⬇️')
      const { buffer } = await media.fetchBuffer(file.url, { headers: UA, maxBytes: MAX_APK, timeoutMs: 10 * 60_000 })
      await msg.reply({
        document: buffer,
        mimetype: 'application/vnd.android.package-archive',
        fileName: file.name.endsWith('.apk') ? file.name : `${file.name}.apk`,
        caption: `📱 *${label}*\n${formatBytes(buffer.length)} · ${store}`,
      })
      await msg.react('')
    })
  },
)
