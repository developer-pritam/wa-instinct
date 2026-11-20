/**
 * Text → stylised image. Each style renders through its ephoto360 effect (photo-composited, the
 * look people expect from "text maker" bots); if the site is unreachable we fall back to a local
 * SVG → PNG render through sharp/librsvg so the command still answers.
 *
 * `logo <style> <text>`, `logo list`, or a direct alias like `neon <text>`; append `sticker`
 * to get a sticker instead of an image; `top|bottom` fills two-line effects.
 * `ephoto <keywords>` searches every ephoto360 text effect, `ephoto <id> <text>` renders one.
 * Fonts for the local renderer live in assets/fonts and are made visible to
 * librsvg through a private fontconfig file (FONTCONFIG_FILE must be set before the first text
 * render — fontconfig initialises lazily, so doing it at module load is early enough).
 */
import path from 'node:path'
import { ROOT_DIR } from '../config.js'
process.env.FONTCONFIG_FILE = path.join(ROOT_DIR, 'assets', 'fonts', 'fonts.conf')
// eslint-disable-next-line import/first -- the env var above must be set before sharp touches fonts
import sharp from 'sharp'
import { command, logger, media, type Message } from '../core/index.js'
import { ephoto, searchEffects } from './_ephoto.js'

const W = 1280
const H = 720
const MAX_CHARS = 30

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

/** Bundled display fonts (assets/fonts) with a rough average glyph width in em, used to size text. */
const FONTS = {
  bangers: { family: "'Bangers'", width: 0.42 },
  marker: { family: "'Permanent Marker'", width: 0.58 },
  orbitron: { family: "'Orbitron'", width: 0.82 },
  pacifico: { family: "'Pacifico'", width: 0.52 },
  bungee: { family: "'Bungee'", width: 0.78 },
  pixel: { family: "'Press Start 2P'", width: 1.0 },
  blackops: { family: "'Black Ops One'", width: 0.62 },
  monoton: { family: "'Monoton'", width: 0.72 },
  mono: { family: "'DejaVu Sans Mono'", width: 0.62 },
} as const
type Font = (typeof FONTS)[keyof typeof FONTS]

/** Small deterministic PRNG so backgrounds (stars, rain) are stable for the same text. */
function rng(seed: string) {
  let s = 2166136261
  for (const c of seed) s = Math.imul(s ^ c.charCodeAt(0), 16777619)
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507)
    s = Math.imul(s ^ (s >>> 13), 3266489909)
    return ((s ^= s >>> 16) >>> 0) / 4294967296
  }
}

// ---------- layout ----------

interface Layout {
  lines: string[]
  size: number
  /** Baseline y for each line. */
  ys: number[]
  font: Font
  weight: string
  rand: () => number
}

/** Split words into the two most balanced lines. */
function splitTwo(text: string): string[] {
  const words = text.split(/\s+/)
  if (words.length < 2) return [text]
  let best = [text]
  let bestDiff = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const diff = Math.abs(a.length - b.length)
    if (diff < bestDiff) (bestDiff = diff), (best = [a, b])
  }
  return best
}

interface Metrics {
  width: number
  /** Ink above / below the baseline. */
  ascent: number
  descent: number
}

/**
 * Measure a line's real ink box at 100px by rendering it alone and trimming the transparent
 * margins. Char-count estimates are far off for display fonts; this is exact and costs ~20ms.
 */
async function measure(line: string, font: Font, weight: string): Promise<Metrics> {
  const base = 100
  const pad = 160 // room above/below the baseline for ascenders, swashes and descenders
  const cw = Math.ceil(line.length * font.width * base * 1.4) + pad * 2
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${pad * 2}"><text x="${pad}" y="${pad}" font-family="${font.family}" font-size="${base}" font-weight="${weight}" fill="#000">${escapeXml(line)}</text></svg>`
  const { info } = await sharp(Buffer.from(svgText)).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true })
  const top = -(info.trimOffsetTop ?? 0)
  return { width: info.width / base, ascent: (pad - top) / base, descent: (top + info.height - pad) / base }
}

/** Pick a font size (and 1 or 2 lines) so the text's real ink box fits the canvas with a margin. */
async function layout(text: string, font: Font, opts: { upper?: boolean; weight?: string } = {}): Promise<Layout> {
  if (opts.upper) text = text.toUpperCase()
  const weight = opts.weight ?? 'normal'
  const maxW = W * 0.86
  const maxH = H * 0.66
  const gap = 0.12 // line gap in em
  const fit = async (lines: string[]) => {
    const m = await Promise.all(lines.map((l) => measure(l, font, weight)))
    const widest = Math.max(...m.map((x) => x.width))
    const height = m.reduce((a, x) => a + x.ascent + x.descent, 0) + gap * (lines.length - 1)
    return { lines, m, size: Math.min(maxW / widest, maxH / height, 420) }
  }
  const one = await fit([text])
  const two = splitTwo(text)
  // Wrap only when it buys a clearly bigger font.
  let best = one
  if (two.length === 2) {
    const alt = await fit(two)
    if (alt.size > one.size * 1.25) best = alt
  }
  const size = Math.floor(best.size)
  const block = best.m.reduce((a, x) => a + (x.ascent + x.descent) * size, 0) + gap * size * (best.lines.length - 1)
  let y = H / 2 - block / 2
  const ys = best.m.map((x) => {
    const baseline = Math.round(y + x.ascent * size)
    y += (x.ascent + x.descent + gap) * size
    return baseline
  })
  return { lines: best.lines, size, ys, font, weight, rand: rng(text) }
}

/** Stacked centred <text> elements, one per line, with the given attributes. */
function textEls(l: Layout, attrs: string, dx = 0, dy = 0): string {
  return l.lines
    .map((line, i) => `<text x="${W / 2 + dx}" y="${l.ys[i] + dy}" text-anchor="middle" font-family="${l.font.family}" font-size="${l.size}" font-weight="${l.weight}" ${attrs}>${escapeXml(line)}</text>`)
    .join('')
}

const svg = (defs: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`

/** A blur-and-merge glow filter. Wide region so the glow is never clipped. */
const glow = (id: string, std: number, extra = '') =>
  `<filter id="${id}" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="${std}" result="b"/>${extra}<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`

/** Pure blur (for soft shadows / halos behind the text). */
const blur = (id: string, std: number) => `<filter id="${id}" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="${std}"/></filter>`

const stops = (...s: [number, string][]) => s.map(([o, c]) => `<stop offset="${o}%" stop-color="${c}"/>`).join('')
const vgrad = (id: string, ...s: [number, string][]) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops(...s)}</linearGradient>`
const hgrad = (id: string, ...s: [number, string][]) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stops(...s)}</linearGradient>`

// ---------- styles ----------

interface Style {
  desc: string
  font: Font
  upper?: boolean
  weight?: string
  render: (l: Layout) => string
}

const STYLES: Record<string, Style> = {
  neon: {
    desc: 'Glowing neon tube sign',
    font: FONTS.monoton,
    render: (l) =>
      svg(
        `<radialGradient id="bg" cx="0.5" cy="0.5" r="0.7">${stops([0, '#1a0b2e'], [100, '#050308'])}</radialGradient>${blur('halo', 18)}${glow('g', 12)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#ff2d95" stroke-width="6" rx="30" opacity="0.7" filter="url(#g)"/>
        ${textEls(l, 'fill="#ff2d95" opacity="0.8" filter="url(#halo)"')}
        ${textEls(l, 'fill="none" stroke="#ff2d95" stroke-width="3" filter="url(#g)"')}
        ${textEls(l, 'fill="#fff0f8"')}`,
      ),
  },

  glitch: {
    desc: 'Broken-signal RGB glitch',
    font: FONTS.orbitron,
    upper: true,
    weight: '900',
    render: (l) => {
      const r = l.rand
      const slices = Array.from({ length: 6 }, (_, i) => ({ y: Math.floor(r() * H), h: 10 + r() * 50, dx: (r() - 0.5) * 60, id: `c${i}` }))
      const clips = slices.map((s) => `<clipPath id="${s.id}"><rect x="0" y="${s.y}" width="${W}" height="${s.h}"/></clipPath>`).join('')
      const scan = Array.from({ length: H / 4 }, (_, i) => `<rect y="${i * 4}" width="${W}" height="2" fill="#000" opacity="0.25"/>`).join('')
      const base = ''
      return svg(
        clips,
        `<rect width="${W}" height="${H}" fill="#0b0b12"/>
        ${textEls(l, `${base} fill="#ff0040" opacity="0.9"`, -14, 0)}
        ${textEls(l, `${base} fill="#00f0ff" opacity="0.9"`, 14, 0)}
        ${textEls(l, `${base} fill="#f2f2f2"`)}
        ${slices.map((s) => `<g clip-path="url(#${s.id})">${textEls(l, `${base} fill="${r() > 0.5 ? '#ff0040' : '#00f0ff'}"`, s.dx, 0)}</g>`).join('')}
        ${scan}`,
      )
    },
  },

  '3d': {
    desc: 'Extruded 3D block letters',
    font: FONTS.bungee,
    render: (l) => {
      const depth = Math.max(8, Math.round(l.size / 9))
      const layers = Array.from({ length: depth }, (_, i) => {
        const t = i / depth
        const c = Math.round(120 - t * 90)
        return textEls(l, `fill="rgb(${c},${Math.round(c * 0.5)},0)"`, depth - i, depth - i)
      }).join('')
      return svg(
        `${vgrad('face', [0, '#ffe259'], [55, '#ffa751'], [100, '#ff7b00'])}${vgrad('bg', [0, '#2b5876'], [100, '#4e4376'])}${blur('sh', 14)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        ${textEls(l, 'fill="#000" opacity="0.45" filter="url(#sh)"', depth + 10, depth + 24)}
        ${layers}
        ${textEls(l, 'fill="url(#face)" stroke="#5a2d00" stroke-width="2"')}`,
      )
    },
  },

  fire: {
    desc: 'Burning flame letters',
    font: FONTS.blackops,
    upper: true,
    render: (l) =>
      svg(
        `${vgrad('flame', [0, '#fff6a0'], [35, '#ffb300'], [70, '#ff3d00'], [100, '#7a0000'])}
        <radialGradient id="bg" cx="0.5" cy="0.9" r="0.9">${stops([0, '#4a1200'], [60, '#1a0500'], [100, '#000'])}</radialGradient>
        <filter id="heat" x="-20%" y="-60%" width="140%" height="220%"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.06" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="${l.size / 4}" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="8"/></filter>
        ${glow('g', 10)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        ${textEls(l, 'fill="#ff7a00" opacity="0.85" filter="url(#heat)"', 0, -l.size * 0.15)}
        ${textEls(l, 'fill="url(#flame)" stroke="#3a0a00" stroke-width="3" paint-order="stroke" filter="url(#g)"')}`,
      ),
  },

  gold: {
    desc: 'Polished golden metal',
    font: FONTS.bungee,
    render: (l) =>
      svg(
        `${vgrad('gold', [0, '#fff3b0'], [25, '#f9d976'], [50, '#b8860b'], [55, '#f6e27a'], [80, '#c9a227'], [100, '#5c3d00'])}
        <radialGradient id="bg" cx="0.5" cy="0.5" r="0.75">${stops([0, '#3b2a10'], [100, '#0a0704'])}</radialGradient>
        ${blur('sh', 10)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        ${textEls(l, 'fill="#000" opacity="0.7" filter="url(#sh)"', 8, 16)}
        ${textEls(l, 'fill="url(#gold)" stroke="#4a3000" stroke-width="3" paint-order="stroke"')}
        ${textEls(l, 'fill="none" stroke="#fff8d0" stroke-width="1.5" opacity="0.6"', -2, -2)}`,
      ),
  },

  ice: {
    desc: 'Frozen crystal letters',
    font: FONTS.orbitron,
    upper: true,
    weight: '800',
    render: (l) =>
      svg(
        `${vgrad('ice', [0, '#ffffff'], [45, '#bfefff'], [70, '#5fc9f8'], [100, '#1c6fb0'])}
        ${vgrad('bg', [0, '#031a33'], [100, '#0b3b63'])}
        <filter id="frost" x="-20%" y="-30%" width="140%" height="180%"><feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="3"/><feDisplacementMap in="SourceGraphic" scale="${l.size / 12}"/></filter>
        ${glow('g', 14)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        ${textEls(l, 'fill="#9be7ff" opacity="0.8" filter="url(#g)"')}
        ${textEls(l, 'fill="url(#ice)" stroke="#e8fbff" stroke-width="3" paint-order="stroke" filter="url(#frost)"')}
        ${textEls(l, 'fill="none" stroke="#fff" stroke-width="1.5" opacity="0.7"', 0, -3)}`,
      ),
  },

  rainbow: {
    desc: 'Bold rainbow gradient',
    font: FONTS.bangers,
    render: (l) =>
      svg(
        `${hgrad('rb', [0, '#ff004c'], [20, '#ff8a00'], [40, '#ffe600'], [60, '#00d26a'], [80, '#00a2ff'], [100, '#9b4dff'])}${blur('sh', 8)}`,
        `<rect width="${W}" height="${H}" fill="#111"/>
        ${textEls(l, 'fill="#000" opacity="0.8" filter="url(#sh)"', 8, 12)}
        ${textEls(l, 'fill="url(#rb)" stroke="#fff" stroke-width="5" paint-order="stroke" stroke-linejoin="round"')}`,
      ),
  },

  retro: {
    desc: '80s synthwave sunset',
    font: FONTS.bungee,
    upper: true,
    render: (l) => {
      const horizon = H * 0.62
      const grid = [
        ...Array.from({ length: 13 }, (_, i) => `<line x1="${W / 2}" y1="${horizon}" x2="${(i - 6) * 260 + W / 2}" y2="${H}" stroke="#ff2bd6" stroke-width="2" opacity="0.6"/>`),
        ...Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${horizon + (i * i * (H - horizon)) / 36}" x2="${W}" y2="${horizon + (i * i * (H - horizon)) / 36}" stroke="#ff2bd6" stroke-width="2" opacity="0.6"/>`),
      ].join('')
      return svg(
        `${vgrad('sky', [0, '#120024'], [60, '#4a0c6b'], [100, '#ff5e7e'])}${vgrad('sun', [0, '#ffe26e'], [100, '#ff2d95'])}${vgrad('txt', [0, '#fff6a0'], [48, '#ffb347'], [52, '#ff2bd6'], [100, '#7b2ff7'])}${glow('g', 10)}`,
        `<rect width="${W}" height="${H}" fill="url(#sky)"/>
        <circle cx="${W / 2}" cy="${horizon - 40}" r="200" fill="url(#sun)"/>
        ${Array.from({ length: 5 }, (_, i) => `<rect x="0" y="${horizon - 40 + i * 32}" width="${W}" height="${8 + i * 3}" fill="#120024"/>`).join('')}
        <rect y="${horizon}" width="${W}" height="${H - horizon}" fill="#120024"/>${grid}
        ${textEls(l, 'fill="url(#txt)" stroke="#fff" stroke-width="2" paint-order="stroke" filter="url(#g)"')}`,
      )
    },
  },

  graffiti: {
    desc: 'Spray-paint street tag',
    font: FONTS.marker,
    render: (l) => {
      const r = l.rand
      const bricks = Array.from({ length: Math.ceil(H / 60) }, (_, row) =>
        Array.from({ length: Math.ceil(W / 160) + 1 }, (_, col) => `<rect x="${col * 160 - (row % 2) * 80}" y="${row * 60}" width="156" height="56" fill="#3a3a3a" stroke="#2a2a2a"/>`).join(''),
      ).join('')
      const drips = l.lines
        .flatMap((line, i) => Array.from({ length: 5 }, () => {
          const x = W / 2 + (r() - 0.5) * line.length * l.font.width * l.size * 0.9
          return `<rect x="${x}" y="${l.ys[i] - l.size * 0.2}" width="${6 + r() * 6}" height="${l.size * (0.3 + r() * 0.5)}" rx="4" fill="#ff2bd6" opacity="0.9"/>`
        }))
        .join('')
      return svg(
        `${vgrad('paint', [0, '#ffe600'], [50, '#ff2bd6'], [100, '#7b2ff7'])}${blur('spray', 18)}`,
        `<rect width="${W}" height="${H}" fill="#2a2a2a"/>${bricks}
        ${textEls(l, 'fill="#7b2ff7" opacity="0.9" filter="url(#spray)"', 0, 8)}
        ${drips}
        ${textEls(l, 'fill="#000" stroke="#000" stroke-width="22" stroke-linejoin="round"', 10, 12)}
        ${textEls(l, 'fill="url(#paint)" stroke="#fff" stroke-width="12" paint-order="stroke" stroke-linejoin="round"')}`,
      )
    },
  },

  matrix: {
    desc: 'Green digital rain',
    font: FONTS.mono,
    weight: 'bold',
    render: (l) => {
      const r = l.rand
      const chars = 'ｱｲｳｴｵｶｷｸｹｺ0123456789ABCXYZ'
      const rain = Array.from({ length: 48 }, (_, c) => {
        const x = c * 27 + 6
        const start = r() * H
        const len = 8 + Math.floor(r() * 18)
        return Array.from({ length: len }, (_, i) => {
          const y = (start + i * 26) % (H + 26)
          const op = i === len - 1 ? 1 : 0.15 + (i / len) * 0.5
          return `<text x="${x}" y="${y}" font-family="${FONTS.mono.family}" font-size="22" fill="${i === len - 1 ? '#d6ffd6' : '#00ff41'}" opacity="${op.toFixed(2)}">${chars[Math.floor(r() * chars.length)]}</text>`
        }).join('')
      }).join('')
      return svg(
        glow('g', 16),
        `<rect width="${W}" height="${H}" fill="#000"/>${rain}
        <rect x="${W * 0.05}" y="${l.ys[0] - l.size}" width="${W * 0.9}" height="${l.ys[l.ys.length - 1] - l.ys[0] + l.size * 1.4}" fill="#000" opacity="0.55" rx="20"/>
        ${textEls(l, 'fill="#00ff41" filter="url(#g)"')}
        ${textEls(l, 'fill="#c8ffc8"', 0, 0)}`,
      )
    },
  },

  blackpink: {
    desc: 'Black & pink K-pop style',
    font: FONTS.bungee,
    upper: true,
    render: (l) =>
      svg(
        `${glow('g', 18)}`,
        `<rect width="${W}" height="${H}" fill="#000"/>
        <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="#ff69b4" stroke-width="8"/>
        <rect x="52" y="52" width="${W - 104}" height="${H - 104}" fill="none" stroke="#ff69b4" stroke-width="2" opacity="0.7"/>
        ${textEls(l, 'fill="#ff69b4" filter="url(#g)"')}
        ${textEls(l, 'fill="#000" stroke="#ff69b4" stroke-width="5" paint-order="stroke"', 0, 0)}
        ${textEls(l, 'fill="#ff69b4"', 6, -6)}`,
      ),
  },

  thunder: {
    desc: 'Electric storm lightning',
    font: FONTS.orbitron,
    upper: true,
    weight: '900',
    render: (l) => {
      const r = l.rand
      const bolt = (x0: number, y0: number, y1: number, width: number) => {
        const pts: string[] = []
        let x = x0
        for (let y = y0; y <= y1; y += 30 + r() * 30) {
          x += (r() - 0.5) * 70
          pts.push(`${x.toFixed(0)},${y.toFixed(0)}`)
        }
        const p = pts.join(' ')
        return `<polyline points="${p}" fill="none" stroke="#7fd4ff" stroke-width="${width * 3}" opacity="0.35" stroke-linejoin="round" filter="url(#g)"/><polyline points="${p}" fill="none" stroke="#fff" stroke-width="${width}" stroke-linejoin="round"/>`
      }
      const bolts = Array.from({ length: 6 }, () => bolt(r() * W, -10, H * (0.3 + r() * 0.7), 2 + r() * 3)).join('')
      return svg(
        `<radialGradient id="bg" cx="0.5" cy="0.3" r="0.8">${stops([0, '#1b2a4a'], [100, '#02050d'])}</radialGradient>${vgrad('txt', [0, '#ffffff'], [50, '#9fe0ff'], [100, '#2b7fff'])}${glow('g', 14)}${glow('tg', 24)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>${bolts}
        ${textEls(l, 'fill="#49b6ff" filter="url(#tg)"')}
        ${textEls(l, 'fill="url(#txt)" stroke="#0b3d91" stroke-width="3" paint-order="stroke"')}`,
      )
    },
  },

  chrome: {
    desc: 'Shiny chrome metal',
    font: FONTS.bungee,
    upper: true,
    render: (l) =>
      svg(
        `${vgrad('chrome', [0, '#ffffff'], [30, '#d9e4f0'], [49, '#6d7f94'], [51, '#2a3443'], [65, '#8ea3bb'], [100, '#f4f9ff'])}
        ${vgrad('bg', [0, '#0f1c2e'], [100, '#2c3e50'])}${blur('sh', 10)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        ${textEls(l, 'fill="#000" opacity="0.6" filter="url(#sh)"', 6, 14)}
        ${textEls(l, 'fill="url(#chrome)" stroke="#111" stroke-width="4" paint-order="stroke"')}
        ${textEls(l, 'fill="none" stroke="#fff" stroke-width="1.5" opacity="0.8"', -1, -2)}`,
      ),
  },

  candy: {
    desc: 'Sweet striped candy',
    font: FONTS.pacifico,
    render: (l) =>
      svg(
        `<pattern id="stripes" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="20" height="40" fill="#ff4f8b"/><rect x="20" width="20" height="40" fill="#fff"/></pattern>
        <pattern id="dots" width="60" height="60" patternUnits="userSpaceOnUse"><circle cx="30" cy="30" r="8" fill="#ffd1e3"/></pattern>
        ${blur('sh', 8)}`,
        `<rect width="${W}" height="${H}" fill="#ffe6f0"/><rect width="${W}" height="${H}" fill="url(#dots)"/>
        ${textEls(l, 'fill="#c2185b" opacity="0.5" filter="url(#sh)"', 10, 14)}
        ${textEls(l, 'fill="#c2185b" stroke="#c2185b" stroke-width="18" stroke-linejoin="round"', 4, 6)}
        ${textEls(l, 'fill="url(#stripes)" stroke="#fff" stroke-width="10" paint-order="stroke" stroke-linejoin="round"')}`,
      ),
  },

  shadow: {
    desc: 'Flat colour with a long shadow',
    font: FONTS.bangers,
    render: (l) => {
      // one copy per 2px keeps the layer count sane for big text
      const steps = Math.round(l.size * 0.3)
      const long = Array.from({ length: steps }, (_, i) => textEls(l, 'fill="#c0392b"', i * 2, i * 2)).join('')
      return svg(
        '',
        `<rect width="${W}" height="${H}" fill="#e74c3c"/>${long}
        ${textEls(l, 'fill="#fff"')}`,
      )
    },
  },

  comic: {
    desc: 'Comic-book burst with halftone',
    font: FONTS.bangers,
    upper: true,
    render: (l) => {
      const r = l.rand
      const pts: string[] = []
      const n = 28
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const rad = i % 2 ? 300 + r() * 40 : 420 + r() * 60
        pts.push(`${(W / 2 + Math.cos(a) * rad * 1.55).toFixed(0)},${(H / 2 + Math.sin(a) * rad).toFixed(0)}`)
      }
      return svg(
        `<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="11" cy="11" r="5" fill="#d32f2f"/></pattern>`,
        `<rect width="${W}" height="${H}" fill="#ffeb3b"/><rect width="${W}" height="${H}" fill="url(#dots)" opacity="0.8"/>
        <polygon points="${pts.join(' ')}" fill="#fff" stroke="#000" stroke-width="10" stroke-linejoin="round"/>
        ${textEls(l, 'fill="#000"', 10, 10)}
        ${textEls(l, 'fill="#ff3d00" stroke="#000" stroke-width="10" paint-order="stroke" stroke-linejoin="round"')}`,
      )
    },
  },

  pixel: {
    desc: '8-bit arcade pixels',
    font: FONTS.pixel,
    upper: true,
    render: (l) => {
      const step = Math.max(4, Math.round(l.size / 10))
      const scan = Array.from({ length: H / 6 }, (_, i) => `<rect y="${i * 6}" width="${W}" height="2" fill="#000" opacity="0.35"/>`).join('')
      return svg(
        '',
        `<rect width="${W}" height="${H}" fill="#1a1a2e"/>
        <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#e94560" stroke-width="12"/>
        <rect x="48" y="48" width="${W - 96}" height="${H - 96}" fill="none" stroke="#0f3460" stroke-width="12"/>
        ${Array.from({ length: 4 }, (_, i) => textEls(l, 'fill="#8b1e3f"', (4 - i) * step, (4 - i) * step)).join('')}
        ${textEls(l, 'fill="#ffd700"')}${scan}`,
      )
    },
  },

  space: {
    desc: 'Starry galaxy',
    font: FONTS.orbitron,
    upper: true,
    weight: '800',
    render: (l) => {
      const r = l.rand
      const stars = Array.from({ length: 260 }, () => `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * H).toFixed(0)}" r="${(0.5 + r() * 2).toFixed(1)}" fill="#fff" opacity="${(0.3 + r() * 0.7).toFixed(2)}"/>`).join('')
      return svg(
        `<radialGradient id="bg" cx="0.5" cy="0.5" r="0.8">${stops([0, '#1c1b4b'], [100, '#02010a'])}</radialGradient>
        <radialGradient id="neb1" cx="0.3" cy="0.35" r="0.4">${stops([0, '#7b2ff7'], [100, 'rgba(123,47,247,0)'])}</radialGradient>
        <radialGradient id="neb2" cx="0.72" cy="0.65" r="0.4">${stops([0, '#ff2bd6'], [100, 'rgba(255,43,214,0)'])}</radialGradient>
        ${vgrad('txt', [0, '#ffffff'], [60, '#c7d2fe'], [100, '#7aa2ff'])}${glow('g', 20)}`,
        `<rect width="${W}" height="${H}" fill="url(#bg)"/>
        <rect width="${W}" height="${H}" fill="url(#neb1)" opacity="0.6"/><rect width="${W}" height="${H}" fill="url(#neb2)" opacity="0.5"/>${stars}
        ${textEls(l, 'fill="#8ab4ff" filter="url(#g)"')}
        ${textEls(l, 'fill="url(#txt)" stroke="#1a237e" stroke-width="2" paint-order="stroke"')}`,
      )
    },
  },
}

// ---------- rendering ----------

/** Render one style to a PNG buffer. Exported for the sample script / other plugins. */
export async function renderLogo(style: string, text: string): Promise<Buffer> {
  const s = STYLES[style]
  if (!s) throw new Error(`Unknown style "${style}"`)
  const l = await layout(text, s.font, { upper: s.upper, weight: s.weight })
  return sharp(Buffer.from(s.render(l))).png().toBuffer()
}

export const logoStyles = () => Object.keys(STYLES)

// ---------- ephoto360-backed styles ----------

/**
 * Style → ephoto360 effect id (picked by rendering each candidate and comparing), plus the local
 * style used when the site can't be reached. Find more ids with `ephoto <keyword>`.
 */
const EFFECTS: Record<string, { id: number; desc: string; local: string }> = {
  neon: { id: 68, desc: 'Neon sign on a dark brick wall', local: 'neon' },
  neon2: { id: 171, desc: 'Cyan neon tubes on brick', local: 'neon' },
  neonrgb: { id: 797, desc: 'Multicolour neon light', local: 'neon' },
  glitch: { id: 767, desc: 'Digital RGB glitch', local: 'glitch' },
  pixel: { id: 769, desc: 'Pixel glitch, retro purple', local: 'pixel' },
  '3d': { id: 274, desc: 'Gold-edged 3D letters', local: '3d' },
  fire: { id: 111, desc: 'Fire dragon shield', local: 'fire' },
  flame: { id: 372, desc: 'Flaming wings', local: 'fire' },
  gold: { id: 594, desc: 'Luxury gold', local: 'gold' },
  glitter: { id: 794, desc: 'Glittering golden script', local: 'gold' },
  ice: { id: 101, desc: 'Frozen ice letters in space', local: 'ice' },
  snow: { id: 621, desc: 'Letters pressed into snow', local: 'ice' },
  rainbow: { id: 801, desc: 'Colourful 3D paint', local: 'rainbow' },
  retro: { id: 67, desc: 'Synthwave retro', local: 'retro' },
  sunset: { id: 807, desc: 'Sunset over the sea with reflection', local: 'retro' },
  graffiti: { id: 665, desc: 'Graffiti on a brick wall (top|bottom)', local: 'graffiti' },
  cartoon: { id: 668, desc: 'Cartoon graffiti with spray cans', local: 'graffiti' },
  matrix: { id: 154, desc: 'Matrix code rain', local: 'matrix' },
  blackpink: { id: 607, desc: 'Blackpink logo', local: 'blackpink' },
  bpneon: { id: 710, desc: 'Blackpink pink neon with petals', local: 'blackpink' },
  thunder: { id: 97, desc: 'Electric thunder storm', local: 'thunder' },
  chrome: { id: 91, desc: 'Brushed chrome', local: 'chrome' },
  glossy: { id: 424, desc: 'Glossy chrome with ornaments', local: 'chrome' },
  metal: { id: 685, desc: 'Shiny 3D metal on leather', local: 'chrome' },
  silver: { id: 802, desc: 'Glossy iridescent silver', local: 'chrome' },
  candy: { id: 94, desc: 'Candy-cane stripes', local: 'candy' },
  shadow: { id: 155, desc: 'Long shadow with light rays', local: 'shadow' },
  comic: { id: 817, desc: '3D comic burst', local: 'comic' },
  dragonball: { id: 809, desc: 'Dragon Ball title with Shenron', local: 'comic' },
  space: { id: 438, desc: 'Galaxy badge logo', local: 'space' },
  wood: { id: 104, desc: 'Carved 3D wood', local: 'shadow' },
  sand: { id: 580, desc: 'Written in beach sand', local: 'shadow' },
  underwater: { id: 682, desc: '3D letters half under water', local: 'ice' },
  watercolor: { id: 655, desc: 'Watercolour brush script', local: 'rainbow' },
}

/** Parse "<text>[|<text2>] [sticker]". */
function parseText(args: string): { texts: string[]; asSticker: boolean } {
  let text = args.trim()
  const asSticker = /(^|\s)sticker$/i.test(text)
  if (asSticker) text = text.replace(/(^|\s)sticker$/i, '').trim()
  const texts = text.split('|').map((t) => t.trim()).filter(Boolean)
  return { texts, asSticker }
}

async function send(msg: Message, img: Buffer, caption: string, asSticker: boolean) {
  if (asSticker) return msg.reply({ sticker: await media.imageToSticker(img) })
  return msg.reply({ image: img, caption })
}

async function run(msg: Message, style: string, args: string) {
  const { texts, asSticker } = parseText(args)
  if (!texts.length) return msg.reply(`_Usage: ${style} <text> [sticker]_`)
  if (texts.join(' ').length > MAX_CHARS) return msg.reply(`_Text too long (max ${MAX_CHARS} characters)._`)
  const caption = `*${style}* · ${texts.join(' ')}`

  const effect = EFFECTS[style]
  if (effect) {
    try {
      return await send(msg, await ephoto(effect.id, texts), caption, asSticker)
    } catch (err) {
      logger.warn({ err, style, id: effect.id }, 'ephoto360 failed, using local render')
    }
  }
  try {
    const local = effect?.local ?? style
    await send(msg, await renderLogo(local, texts.join(' ')), caption, asSticker)
  } catch (err) {
    await msg.reply(`❌ ${(err as Error).message}`)
  }
}

const listText = () =>
  [
    '*Logo styles*',
    ...Object.entries(EFFECTS).map(([k, e]) => `• *${k}* — ${e.desc}`),
    '',
    '_logo <style> <text> [sticker] · two-line styles take top|bottom_',
    '_More: ephoto <keyword> to search all ephoto360 effects_',
  ].join('\n')

command(
  {
    name: 'logo',
    aliases: ['tm'],
    desc: 'Turn text into a stylised logo image (logo list for styles)',
    usage: '<style> <text> [sticker] | list',
    category: 'fun',
    public: true,
  },
  async (msg, args) => {
    const [style = '', ...rest] = args.trim().split(/\s+/)
    const key = style.toLowerCase()
    if (!key || key === 'list') return msg.reply(listText())
    if (!EFFECTS[key] && !STYLES[key]) return msg.reply(`_Unknown style "${style}". Try: logo list_`)
    await run(msg, key, rest.join(' '))
  },
)

// One direct alias per style, e.g. `neon hello world`.
for (const [name, e] of Object.entries(EFFECTS)) {
  command({ name, desc: `${e.desc} text logo`, usage: '<text> [sticker]', category: 'fun', public: true }, (msg, args) => run(msg, name, args))
}

command(
  {
    name: 'ephoto',
    desc: 'Search ephoto360 text effects, or render one by id',
    usage: '<keyword> | <id> <text>[|text2] [sticker]',
    category: 'fun',
    public: true,
  },
  async (msg, args) => {
    const [first = '', ...rest] = args.trim().split(/\s+/)
    if (!first) return msg.reply('_Usage: ephoto <keyword>  ·  ephoto <id> <text> [sticker]_')

    if (/^\d+$/.test(first)) {
      const { texts, asSticker } = parseText(rest.join(' '))
      if (!texts.length) return msg.reply('_Usage: ephoto <id> <text>[|text2] [sticker]_')
      try {
        return await send(msg, await ephoto(Number(first), texts), `*ephoto ${first}* · ${texts.join(' ')}`, asSticker)
      } catch (err) {
        return msg.reply(`❌ ${(err as Error).message}`)
      }
    }

    const query = args.trim()
    const hits = await searchEffects(query)
    if (hits.length) {
      const lines = hits.map((h) => `• *${h.id}* — ${h.title}`)
      return msg.reply(`*ephoto360: ${query}*\n${lines.join('\n')}\n\n_ephoto <id> <text>_`)
    }

    // "ephoto dragon Joethsah": keyword + text → render the best match for the keyword
    const { texts, asSticker } = parseText(rest.join(' '))
    const byKeyword = texts.length ? await searchEffects(first) : []
    if (!byKeyword.length) return msg.reply('_No text effects found. Try one word, e.g. ephoto dragon_')
    const [best, ...others] = byKeyword
    const more = others.length ? `\n_Other ${first} effects: ${others.slice(0, 6).map((h) => h.id).join(', ')} (ephoto <id> <text>)_` : ''
    try {
      await send(msg, await ephoto(best.id, texts), `*${best.title}* (${best.id})${more}`, asSticker)
    } catch (err) {
      await msg.reply(`❌ ${(err as Error).message}`)
    }
  },
)
