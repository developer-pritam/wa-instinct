/**
 * Local image tools (sharp) on a replied image or sticker. Each command is a tiny op;
 * `onImage` validates the reply, downloads, converts stickers, runs the op and replies.
 */
import sharp, { type Metadata, type Sharp } from 'sharp'
import { command, config, formatBytes, media, type Message } from '../core/index.js'

/** An op gets an auto-oriented pipeline and returns a pipeline (encoded by the helper), a ready buffer, or text. */
type Op = (img: Sharp, args: string, meta: Metadata) => Sharp | Buffer | string | Promise<Sharp | Buffer | string>

/** Width/height of the image once EXIF orientation is applied. */
const dims = (meta: Metadata) => ((meta.orientation ?? 1) >= 5 ? { w: meta.height ?? 0, h: meta.width ?? 0 } : { w: meta.width ?? 0, h: meta.height ?? 0 })

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const num = (s: string, fallback: number) => (Number.isFinite(parseFloat(s)) ? parseFloat(s) : fallback)
const isHex = (s: string) => /^#?[0-9a-f]{3,8}$/i.test(s)
const asHex = (s: string) => (s.startsWith('#') ? s : `#${s}`)

interface ImgOptions {
  /** Send the result as a document with this file name instead of an image. */
  document?: string
}

/** Shared wrapper: find a replied image/sticker, run `op`, reply with the result. */
async function onImage(msg: Message, args: string, op: Op, opts: ImgOptions = {}) {
  const q = msg.quoted
  const ok = q && (q.isImage || q.isSticker || (q.isDocument && q.mimetype.startsWith('image/')))
  if (!ok) return msg.reply('_Reply to an image or sticker._')
  try {
    let buf = await q.download()
    if (q.isSticker) buf = await media.stickerToPng(buf)
    const meta = await sharp(buf).metadata()
    const result = await op(sharp(buf).rotate(), args.trim(), meta)
    if (typeof result === 'string') return msg.reply(result)
    // Pipelines get encoded here: png keeps transparency, jpeg keeps photos small.
    const out = Buffer.isBuffer(result) ? result : await (meta.hasAlpha ? result.png() : result.jpeg({ quality: 92 })).toBuffer()
    if (opts.document) return msg.reply({ document: out, mimetype: `image/${opts.document.split('.').pop()}`, fileName: opts.document })
    await msg.reply({ image: out })
  } catch (err) {
    await msg.reply(`❌ ${(err as Error).message}`)
  }
}

/** Register an image command in one line. */
function img(name: string, desc: string, op: Op, extra: { aliases?: string[]; usage?: string } & ImgOptions = {}) {
  const { aliases, usage, ...opts } = extra
  command({ name, aliases, desc, usage: usage ? `${usage} (reply to image)` : '(reply to image)', category: 'media' }, (msg, args) => onImage(msg, args, op, opts))
}

// ---------- filters ----------

img('gray', 'Make an image black & white', (i) => i.grayscale())
img('blur', 'Blur an image', (i, a) => i.blur(clamp(num(a, 5), 0.3, 100)), { usage: '[sigma]' })
img('sharpen', 'Sharpen an image', (i) => i.sharpen({ sigma: 1.5 }))
img('invert', 'Invert the colours', (i) => i.negate({ alpha: false }), { aliases: ['negate'] })
img('sepia', 'Give an image a sepia tone', (i) =>
  i.recomb([
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131],
  ]),
)
img('enhance', 'Auto-enhance contrast and colours', (i) => i.normalize().modulate({ brightness: 1.05, saturation: 1.2 }).sharpen())

img('pixelate', 'Pixelate an image', async (i, a, meta) => {
  const { w, h } = dims(meta)
  const size = clamp(Math.round(num(a, 12)), 2, 200)
  const small = await i.resize(Math.max(1, Math.round(w / size)), Math.max(1, Math.round(h / size)), { kernel: 'nearest' }).png().toBuffer()
  return sharp(small).resize(w, h, { kernel: 'nearest' })
}, { usage: '[block size]' })

// ---------- geometry ----------

img('flip', 'Flip an image vertically', (i) => i.flip())
img('flop', 'Mirror an image horizontally', (i) => i.flop())

img('rotateimg', 'Rotate an image by degrees', (i, a) => {
  const deg = num(a, 90)
  // a non-right-angle rotation exposes corners; fill them with black
  return i.rotate(deg, { background: '#000' })
}, { usage: '<degrees>' })

img('resize', 'Resize an image', (i, a, meta) => {
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(a)
  if (pct) {
    const f = clamp(parseFloat(pct[1]), 1, 400) / 100
    const { w, h } = dims(meta)
    return i.resize(Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f)))
  }
  const wh = /^(\d+)?\s*x\s*(\d+)?$/i.exec(a) ?? /^(\d+)$/.exec(a)
  if (!wh || (!wh[1] && !wh[2])) throw new Error('Usage: resize <w>x<h> | <w>x | x<h> | <percent>%')
  const w = wh[1] ? clamp(parseInt(wh[1], 10), 1, 8000) : undefined
  const h = wh[2] ? clamp(parseInt(wh[2], 10), 1, 8000) : undefined
  return i.resize(w, h, { fit: w && h ? 'fill' : 'inside' })
}, { usage: '<w>x<h> | <percent>%' })

img('round', 'Round the corners of an image', async (i, a, meta) => {
  const { w, h } = dims(meta)
  const r = clamp(Math.round(num(a, Math.min(w, h) / 8)), 1, Math.min(w, h) / 2)
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`)
  return i.ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
}, { usage: '[radius]' })

img('border', 'Add a solid border', (i, a) => {
  const [px = '20', color = '#ffffff'] = a.split(/\s+/)
  const n = clamp(Math.round(num(px, 20)), 1, 1000)
  if (!isHex(color)) throw new Error('Colour must be hex, e.g. border 20 #ff0000')
  return i.extend({ top: n, bottom: n, left: n, right: n, background: asHex(color) })
}, { usage: '<px> [#hex]' })

// ---------- meme ----------

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

/** Greedy word wrap by estimated glyph width (condensed bold ≈ 0.5em per char). */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > maxChars) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

img('meme', 'Put Impact-style captions on an image', async (i, a, meta) => {
  const [top = '', bottom = ''] = a.split(';').map((s) => s.trim().toUpperCase())
  if (!top && !bottom) throw new Error('Usage: meme <top text>;<bottom text>')
  const { w, h } = dims(meta)
  const size = Math.round(Math.max(w, h) / 12)
  const lineH = size * 1.1
  const maxChars = Math.max(6, Math.floor((w * 0.94) / (size * 0.5)))
  const style = `font-family="'Nimbus Sans Narrow','Nimbus Sans','DejaVu Sans',sans-serif" font-weight="bold" font-size="${size}" fill="#fff" stroke="#000" stroke-width="${Math.max(2, size / 14)}" paint-order="stroke" stroke-linejoin="round" text-anchor="middle"`
  const text = (lines: string[], y0: number) =>
    lines.map((l, n) => `<text x="${w / 2}" y="${y0 + n * lineH}" ${style}>${escapeXml(l)}</text>`).join('')
  const topLines = wrap(top, maxChars)
  const bottomLines = wrap(bottom, maxChars)
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${text(topLines, size * 1.05)}${text(
    bottomLines,
    h - size * 0.35 - (bottomLines.length - 1) * lineH,
  )}</svg>`
  return i.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
}, { usage: '<top>;<bottom>' })

// ---------- info & formats ----------

img('imginfo', 'Show image dimensions, format and size', async (i, _a, meta) => {
  const { w, h } = dims(meta)
  const buf = await i.toBuffer()
  const lines = [
    `🖼️ *Image info*`,
    `Format: ${meta.format ?? '?'}${meta.pages && meta.pages > 1 ? ` (animated, ${meta.pages} frames)` : ''}`,
    `Size: ${w} × ${h}px`,
    `Channels: ${meta.channels ?? '?'}${meta.hasAlpha ? ' (with alpha)' : ''}`,
    `Colour space: ${meta.space ?? '?'}`,
    meta.density ? `Density: ${meta.density} dpi` : '',
    `Bytes: ${formatBytes(buf.length)}`,
  ]
  return lines.filter(Boolean).join('\n')
})

img('jpg', 'Convert an image to JPEG', (i) => i.flatten({ background: '#fff' }).jpeg({ quality: 92 }).toBuffer(), { aliases: ['jpeg'] })
img('png', 'Convert an image to PNG (sent as a document)', (i) => i.png().toBuffer(), { document: 'image.png' })
img('webp', 'Convert an image to WebP (sent as a document)', (i) => i.webp({ quality: 90 }).toBuffer(), { document: 'image.webp' })

// ---------- remove.bg ----------

img('rmbg', 'Remove the background (remove.bg API)', async (i) => {
  if (!config.keys.rmbg) return '_Set RMBG_KEY in .env (free key at remove.bg/api) to use rmbg._'
  const form = new FormData()
  form.append('image_file', new Blob([new Uint8Array(await i.png().toBuffer())], { type: 'image/png' }), 'image.png')
  form.append('size', 'auto')
  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': config.keys.rmbg },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { errors?: { title?: string }[] }
    throw new Error(err.errors?.[0]?.title ?? `remove.bg HTTP ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}, { document: 'rmbg.png' })
