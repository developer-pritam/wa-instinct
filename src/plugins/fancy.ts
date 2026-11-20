/**
 * Unicode "fonts": fancy <text> lists every style, fancy <n> <text> picks one.
 * Pure character mapping, nothing leaves the machine.
 */
import { command, smallcaps } from '../core/index.js'

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGIT = '0123456789'

type Style = { name: string; apply: (s: string) => string }

/** Build a mapper from Unicode block offsets, with per-character overrides for the gaps in the Math blocks. */
function block(upper?: number, lower?: number, digit?: number, fix: Record<string, string> = {}): (s: string) => string {
  const map: Record<string, string> = {}
  if (upper !== undefined) for (let i = 0; i < 26; i++) map[UPPER[i]] = String.fromCodePoint(upper + i)
  if (lower !== undefined) for (let i = 0; i < 26; i++) map[LOWER[i]] = String.fromCodePoint(lower + i)
  if (digit !== undefined) for (let i = 0; i < 10; i++) map[DIGIT[i]] = String.fromCodePoint(digit + i)
  Object.assign(map, fix)
  return (s) => [...s].map((c) => map[c] ?? c).join('')
}

/** Explicit table (for blocks that don't follow a-z order). */
function table(chars: string, replacements: string): (s: string) => string {
  const map: Record<string, string> = {}
  const out = [...replacements]
  ;[...chars].forEach((c, i) => (map[c] = out[i]))
  return (s) => [...s].map((c) => map[c] ?? c).join('')
}

/** Attach a combining mark to every visible character. */
const combining = (mark: string) => (s: string) => [...s].map((c) => (c === ' ' ? c : c + mark)).join('')

/** Lower-case letters go through the upper-case map (for blocks that only have capitals). */
const upperOnly = (fn: (s: string) => string) => (s: string) => fn(s.toUpperCase())

const flipped = table(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?\'"()[]{}<>&_',
  'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz∀qƆpƎℲפHIſʞ˥WNOԀQɹS┴∩ΛMX⅄Z0ƖᄅƐㄣϛ9ㄥ86˙\'¡¿,„)(][}{><⅋‾',
)

export const STYLES: Style[] = [
  { name: 'Bold', apply: block(0x1d400, 0x1d41a, 0x1d7ce) },
  { name: 'Italic', apply: block(0x1d434, 0x1d44e, undefined, { h: 'ℎ' }) },
  { name: 'Bold Italic', apply: block(0x1d468, 0x1d482) },
  { name: 'Script', apply: block(0x1d49c, 0x1d4b6, undefined, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' }) },
  { name: 'Bold Script', apply: block(0x1d4d0, 0x1d4ea) },
  { name: 'Fraktur', apply: block(0x1d504, 0x1d51e, undefined, { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }) },
  { name: 'Bold Fraktur', apply: block(0x1d56c, 0x1d586) },
  { name: 'Double-struck', apply: block(0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }) },
  { name: 'Sans', apply: block(0x1d5a0, 0x1d5ba, 0x1d7e2) },
  { name: 'Sans Bold', apply: block(0x1d5d4, 0x1d5ee, 0x1d7ec) },
  { name: 'Sans Italic', apply: block(0x1d608, 0x1d622) },
  { name: 'Sans Bold Italic', apply: block(0x1d63c, 0x1d656) },
  { name: 'Monospace', apply: block(0x1d670, 0x1d68a, 0x1d7f6) },
  { name: 'Small caps', apply: smallcaps },
  { name: 'Circled', apply: block(0x24b6, 0x24d0, undefined, { 0: '⓪', 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤', 6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨' }) },
  { name: 'Circled (filled)', apply: upperOnly(block(0x1f150, undefined, undefined, { 0: '⓿', 1: '❶', 2: '❷', 3: '❸', 4: '❹', 5: '❺', 6: '❻', 7: '❼', 8: '❽', 9: '❾' })) },
  { name: 'Squared', apply: upperOnly(block(0x1f130)) },
  { name: 'Squared (filled)', apply: upperOnly(block(0x1f170)) },
  { name: 'Parenthesized', apply: block(undefined, 0x249c, undefined, { 1: '⑴', 2: '⑵', 3: '⑶', 4: '⑷', 5: '⑸', 6: '⑹', 7: '⑺', 8: '⑻', 9: '⑼' }) },
  { name: 'Fullwidth', apply: block(0xff21, 0xff41, 0xff10, { ' ': '　', '!': '！', '?': '？', '.': '．', ',': '，' }) },
  { name: 'Superscript', apply: table('abcdefghijklmnoprstuvwxyz0123456789+-=()', 'ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾') },
  { name: 'Upside down', apply: (s) => [...flipped(s)].reverse().join('') },
  { name: 'Strikethrough', apply: combining('̶') },
  { name: 'Underline', apply: combining('̲') },
  { name: 'Double underline', apply: combining('̳') },
  { name: 'Slashed', apply: combining('̸') },
  { name: 'Spaced', apply: (s) => [...s.replace(/\s+/g, ' ')].join(' ') },
  { name: 'Hearts', apply: (s) => [...s].map((c) => (c === ' ' ? ' ' : c + '♥')).join('') },
]

command(
  {
    name: 'fancy',
    desc: 'Write text in fancy Unicode fonts',
    usage: '<text> | <n> <text> | <n> (reply)',
    category: 'fun',
    public: true,
  },
  async (msg, args) => {
    const m = /^(\d+)\s*([\s\S]*)$/.exec(args)
    const n = m ? parseInt(m[1], 10) : 0
    const text = (m ? m[2] : args).trim() || msg.quoted?.text?.trim() || ''
    if (!text) return msg.reply('_Usage: fancy <text> · fancy <n> <text> · fancy <n> (reply to a message)_')
    if (text.length > 500) return msg.reply('_Keep it under 500 characters._')

    if (n) {
      const style = STYLES[n - 1]
      if (!style) return msg.reply(`_Pick a style between 1 and ${STYLES.length}._`)
      return msg.reply(style.apply(text))
    }
    const sample = text.length > 40 ? text.slice(0, 40) + '…' : text
    const list = STYLES.map((s, i) => `${i + 1}. ${s.apply(sample)}`).join('\n')
    await msg.reply(`${list}\n\n_fancy <n> <text> for one style_`)
  },
)
