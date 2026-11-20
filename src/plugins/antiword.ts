import { chatSettings, command, escapeRegExp, jid, on } from '../core/index.js'
import { isExempt, warnUser } from './warn.js'

type Action = 'kick' | 'warn' | 'null'
interface AntiWord {
  enabled: boolean
  action: Action
  words: string[]
}
const KEY = 'antiword'
const DEFAULTS: AntiWord = { enabled: false, action: 'null', words: [] }
const get = (chat: string) => chatSettings.get<AntiWord>(chat, KEY, DEFAULTS)

const parseWords = (text: string) => [...new Set(text.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean))]

/** Whole-word, case-insensitive match of any blocked word (unicode aware, so `\b` isn't used). */
function findWord(text: string, words: string[]): string | undefined {
  if (!words.length) return undefined
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${words.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
  return text.match(re)?.[1]
}

function status(s: AntiWord): string {
  return (
    `AntiWord is *${s.enabled ? 'on' : 'off'}* · action: *${s.action}*\nWords: ${s.words.join(', ') || '-'}\n\n` +
    '> Usage:\n- antiword on | off\n- antiword kick | warn | null (delete only)\n- antiword add word1,word2\n- antiword remove word1,word2\n- antiword list\n- antiword clear'
  )
}

command(
  {
    name: 'antiword',
    desc: 'Delete, warn or kick for blocked words in this group',
    usage: 'on|off · kick|warn|null · add <w,w> · remove <w,w> · list · clear',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const s = get(msg.chat)
    const [sub = '', ...rest] = args.split(/\s+/)
    const cmd = sub.toLowerCase()
    const value = rest.join(' ').trim()

    if (!cmd || cmd === 'list' || cmd === 'info') return msg.reply(status(s))
    if (cmd === 'on' || cmd === 'off') {
      chatSettings.update(msg.chat, KEY, { enabled: cmd === 'on' }, DEFAULTS)
      return msg.reply(`AntiWord is now *${cmd}*.`)
    }
    if (cmd === 'kick' || cmd === 'warn' || cmd === 'null') {
      chatSettings.update(msg.chat, KEY, { action: cmd }, DEFAULTS)
      return msg.reply(`AntiWord action updated to: *${cmd}*`)
    }
    if (cmd === 'add') {
      if (!value) return msg.reply('_Usage: antiword add word1,word2_')
      const words = parseWords(value).filter((w) => !s.words.includes(w))
      if (!words.length) return msg.reply('_Those words are already blocked._')
      chatSettings.update(msg.chat, KEY, { words: [...s.words, ...words] }, DEFAULTS)
      return msg.reply(`*Words added:*\n${words.join(', ')}`)
    }
    if (cmd === 'remove') {
      if (!value) return msg.reply('_Usage: antiword remove word1,word2_')
      const words = parseWords(value)
      chatSettings.update(msg.chat, KEY, { words: s.words.filter((w) => !words.includes(w)) }, DEFAULTS)
      return msg.reply(`*Words removed:*\n${words.join(', ')}`)
    }
    if (cmd === 'clear') {
      chatSettings.update(msg.chat, KEY, { words: [] }, DEFAULTS)
      return msg.reply('_AntiWord list cleared._')
    }
    return msg.reply(status(s))
  },
)

on(
  'message',
  async (msg) => {
    const s = get(msg.chat)
    if (!s.enabled || !s.words.length || !msg.text) return
    const hit = findWord(msg.text, s.words)
    if (!hit) return
    if (await isExempt(msg)) return

    const botAdmin = await msg.isBotAdmin()
    if (botAdmin) await msg.delete().catch(() => {})

    const mention = `@${jid.toNumber(msg.sender)}`
    if (s.action === 'warn') return warnUser(msg, msg.sender, `Blocked word: ${hit}`)
    if (s.action === 'kick') {
      if (!botAdmin) return msg.replyMention(`_${mention} used a blocked word but I'm not an admin, so I can't remove them._`, [msg.sender])
      await msg.send(`_${mention} removed for using a blocked word._`, { mentions: [msg.sender] })
      await msg.kick(msg.sender)
    }
  },
  { fromMe: false, groupOnly: true, name: 'antiword' },
)
