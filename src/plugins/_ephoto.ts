/**
 * Minimal client for en.ephoto360.com text effects (not a plugin; the loader skips `_` files).
 *
 * The site's flow, as used by its own page:
 *   1. GET the effect page → hidden `token`, `build_server`, `build_server_id` + session cookie
 *   2. POST the form (text[] + those fields) to the same URL → HTML with a JSON blob in #form_value_input
 *   3. POST that JSON (form-encoded) to /effect/create-image → { success, image: "/images/..." }
 *   4. GET build_server + image → the JPEG
 * Any effect can be addressed by id alone: the slug before "-<id>.html" is ignored.
 */
import { media } from '../core/index.js'

const BASE = 'https://en.ephoto360.com'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const TIMEOUT = 30_000

/** Tiny cookie jar: the PHP session cookie must carry across the three requests. */
class Session {
  private cookies = new Map<string, string>()

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('user-agent', UA)
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT) })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
    if (!res.ok) throw new Error(`ephoto360 HTTP ${res.status}`)
    return res
  }
}

const decodeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}" value="([^"]*)"`))?.[1] ?? ''

export const effectUrl = (id: number) => `${BASE}/effect-${id}.html`

/** How many text boxes an effect has (1 or 2 in practice). */
export async function inputCount(id: number): Promise<number> {
  const html = await (await new Session().fetch(effectUrl(id))).text()
  return Math.max(1, (html.match(/name="text\[\]"/g) ?? []).length)
}

/**
 * Render `texts` with effect `id`. Extra texts are joined into the last box; a missing
 * second text repeats the first. Returns the JPEG bytes.
 */
export async function ephoto(id: number, texts: string[]): Promise<Buffer> {
  const s = new Session()
  const url = effectUrl(id)
  const page = await (await s.fetch(url)).text()
  const token = hidden(page, 'token')
  if (!token) throw new Error('ephoto360 page has no form (effect needs a photo, or the site changed)')

  const boxes = Math.max(1, (page.match(/name="text\[\]"/g) ?? []).length)
  const values = texts.slice(0, boxes)
  if (texts.length > boxes) values[boxes - 1] = texts.slice(boxes - 1).join(' ')
  // every box must be filled: split "two words" across two boxes, otherwise repeat the text
  if (boxes === 2 && values.length === 1 && values[0].includes(' ')) {
    const words = values[0].split(/\s+/)
    const mid = Math.ceil(words.length / 2)
    values.splice(0, 1, words.slice(0, mid).join(' '), words.slice(mid).join(' '))
  }
  while (values.length < boxes) values.push(values[0])

  const form = new FormData()
  for (const v of values) form.append('text[]', v)
  // some effects have a style picker; the site's default is the first option
  const radio = page.match(/name="radio0\[radio\]" value="([^"]+)"/)?.[1]
  if (radio) form.append('radio0[radio]', radio)
  form.append('token', token)
  form.append('build_server', hidden(page, 'build_server'))
  form.append('build_server_id', hidden(page, 'build_server_id'))
  form.append('submit', 'GO')

  const step2 = await (await s.fetch(url, { method: 'POST', body: form, headers: { referer: url } })).text()
  const raw = step2.match(/form_value_input" value="([^"]+)"/)?.[1]
  if (!raw) throw new Error('ephoto360 did not accept the text')
  const value = JSON.parse(decodeHtml(raw)) as Record<string, string | string[]>

  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) v.forEach((x) => body.append(`${k}[]`, x))
    else body.append(k, String(v))
  }
  const res = (await (
    await s.fetch(`${BASE}/effect/create-image`, {
      method: 'POST',
      body,
      headers: { referer: url, 'x-requested-with': 'XMLHttpRequest' },
    })
  ).json()) as { success?: boolean; image?: string; info?: string }
  if (!res.success || !res.image) throw new Error(`ephoto360 failed to render${res.info ? `: ${res.info}` : ''}`)

  const { buffer } = await media.fetchBuffer(String(value.build_server) + res.image, { timeoutMs: TIMEOUT })
  return buffer
}

export interface EffectHit {
  id: number
  title: string
}

/** Search effects by keyword. Photo/avatar effects (which need an uploaded image) are filtered out. */
export async function searchEffects(query: string, limit = 15): Promise<EffectHit[]> {
  const html = await (await new Session().fetch(`${BASE}/index/search?q=${encodeURIComponent(query)}`)).text()
  const hits = new Map<number, string>()
  const re = /<a href="\/[a-z0-9-]*?-(\d+)\.html">\s*<img[^>]*alt="([^"]+)"/g
  for (const m of html.matchAll(re)) {
    const title = decodeHtml(m[2]).trim()
    if (/avatar|photo|frame|collage|cover|banner|card|wallpaper/i.test(title)) continue
    if (!hits.has(Number(m[1]))) hits.set(Number(m[1]), title)
  }
  return [...hits].slice(0, limit).map(([id, title]) => ({ id, title }))
}
