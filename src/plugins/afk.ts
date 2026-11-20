import { command, config, formatDuration, jid, on, vars } from '../core/index.js'

/** AFK var: JSON { reason, since } (ms). Empty = not AFK. */
interface Afk {
  reason: string
  since: number
}

function getAfk(): Afk | undefined {
  const raw = vars.get('AFK')
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<Afk>
    return typeof parsed.since === 'number' ? { reason: parsed.reason ?? '', since: parsed.since } : undefined
  } catch {
    return undefined
  }
}

const clearAfk = () => vars.set('AFK', '')
const afkText = (afk: Afk) => `${afk.reason || "I'm AFK right now."}\n_since ${formatDuration((Date.now() - afk.since) / 1000)} ago_`

/** Last auto-reply time per chat, so we don't spam. */
const lastReply = new Map<string, number>()
const REPLY_EVERY = 10 * 60 * 1000

const isAfkCommand = (text: string) => {
  const t = text.trim()
  const body = config.prefix && config.prefix.includes(t[0] ?? '') ? t.slice(1).trimStart() : config.prefix ? '' : t
  return /^afk(\s|$)/i.test(body)
}

command(
  {
    name: 'afk',
    desc: 'Set yourself as away; auto-replies when you are messaged or mentioned',
    usage: '[reason] | off',
    category: 'misc',
  },
  async (msg, args) => {
    if (args.toLowerCase() === 'off') {
      if (!getAfk()) return msg.reply('_You are not AFK._')
      clearAfk()
      return msg.reply("👋 Welcome back! You're no longer AFK.")
    }
    const current = getAfk()
    if (!args && current) return msg.reply(`*You are AFK*\n${afkText(current)}\n\n_Use afk off to come back._`)
    vars.set('AFK', JSON.stringify({ reason: args, since: Date.now() } satisfies Afk))
    await msg.reply(`😴 AFK set${args ? `: ${args}` : ''}\n_Sending any message removes it._`)
  },
)

// any message from us (other than the afk command) ends the AFK state
on(
  'message',
  async (msg) => {
    if (!vars.get('AFK')) return
    if (isAfkCommand(msg.text)) return
    clearAfk()
    lastReply.clear()
  },
  { fromMe: true, name: 'afk-clear' },
)

on(
  'message',
  async (msg, ctx) => {
    const afk = getAfk()
    if (!afk || msg.type === 'reaction') return
    const me = ctx.sock.user
    let relevant = !msg.isGroup
    if (!relevant && msg.mentions.length) relevant = msg.mentions.some((m) => jid.sameUser(m, me?.id) || jid.sameUser(m, me?.lid))
    if (!relevant && msg.quoted) relevant = msg.quoted.fromMe
    if (!relevant) return

    const last = lastReply.get(msg.chat) ?? 0
    if (Date.now() - last < REPLY_EVERY) return
    lastReply.set(msg.chat, Date.now())
    await msg.reply(afkText(afk))
  },
  { fromMe: false, name: 'afk-reply' },
)
