import { chatSettings, command, jid, on, vars } from '../core/index.js'
import { isExempt, warnUser } from './warn.js'

type Level = 'low' | 'medium' | 'high'
type Action = 'warn' | 'delete' | 'kick'
interface AntiSpam {
  enabled: boolean
  level: Level
  action: Action
}

/** Messages allowed per window; more than `max` inside `windowMs` counts as spam. */
const LEVELS: Record<Level, { max: number; windowMs: number; description: string }> = {
  low: { max: 10, windowMs: 15_000, description: 'relaxed: 10 msgs / 15s, for active groups' },
  medium: { max: 7, windowMs: 10_000, description: 'balanced: 7 msgs / 10s, recommended' },
  high: { max: 5, windowMs: 8_000, description: 'strict: 5 msgs / 8s, for problem groups' },
}
const ACTIONS: Record<Action, string> = { warn: 'warned (not kicked)', delete: 'messages deleted only', kick: 'kicked from the group' }
const isLevel = (s: string): s is Level => s in LEVELS
const isAction = (s: string): s is Action => s in ACTIONS

const KEY = 'antispam'
const DEFAULTS: AntiSpam = { enabled: false, level: 'medium', action: 'kick' }
const get = (chat: string) => chatSettings.get<AntiSpam>(chat, KEY, DEFAULTS)
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

const HELP =
  '📖 *Antispam*\n\n• antispam on [low|medium|high] - enable (default: medium)\n• antispam off\n• antispam low|medium|high - change sensitivity\n' +
  '• antispam warn|delete|kick - change action\n• antispam info\n\n*Levels:*\n' +
  Object.entries(LEVELS).map(([k, v]) => `• ${cap(k)} - ${v.description}`).join('\n')

command(
  {
    name: 'antispam',
    desc: 'Detect message floods and warn, delete or kick the sender',
    usage: 'on [low|medium|high] · off · low|medium|high · warn|delete|kick · info',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const s = get(msg.chat)
    const [sub = '', arg = ''] = args.toLowerCase().split(/\s+/)

    if (sub === 'info') {
      if (!s.enabled) return msg.reply('📊 *Antispam Status*\n\n🔴 Disabled\n\nUse `antispam on` to enable protection')
      return msg.reply(`📊 *Antispam Status*\n\n🟢 *Enabled*\nLevel: ${cap(s.level)} (${LEVELS[s.level].description})\nAction: ${cap(s.action)}`)
    }
    if (sub === 'off') {
      chatSettings.update(msg.chat, KEY, { enabled: false }, DEFAULTS)
      return msg.reply('⚠️ *Antispam Protection Disabled*')
    }
    if (sub === 'on') {
      const level = arg || s.level
      if (!isLevel(level)) return msg.reply('❌ Invalid level. Use: low, medium, high')
      chatSettings.update(msg.chat, KEY, { enabled: true, level }, DEFAULTS)
      return msg.reply(`✅ *Antispam Protection Enabled*\n\nLevel: ${cap(level)} (${LEVELS[level].description})\nAction: ${cap(s.action)}`)
    }
    if (isLevel(sub)) {
      chatSettings.update(msg.chat, KEY, { level: sub }, DEFAULTS)
      return msg.reply(`✅ *Level Changed*\n\nNew level: ${cap(sub)} (${LEVELS[sub].description})`)
    }
    if (isAction(sub)) {
      chatSettings.update(msg.chat, KEY, { action: sub }, DEFAULTS)
      return msg.reply(`✅ *Action Changed*\n\nSpammers will be: ${ACTIONS[sub]}`)
    }
    return msg.reply(HELP)
  },
)

/** chat:sender → timestamps of recent messages */
const recent = new Map<string, number[]>()

function sweep(now: number) {
  if (recent.size < 2000) return
  for (const [k, ts] of recent) if (!ts.length || now - ts[ts.length - 1] > 60_000) recent.delete(k)
}

on(
  'message',
  async (msg) => {
    if (msg.type === 'reaction') return // reactions aren't messages; don't count them as a flood
    const s = get(msg.chat)
    if (!s.enabled) return
    const { max, windowMs } = LEVELS[s.level] ?? LEVELS.medium
    const now = Date.now()
    const key = `${msg.chat}:${jid.toNumber(msg.sender)}`
    const ts = (recent.get(key) ?? []).filter((t) => now - t < windowMs)
    ts.push(now)
    recent.set(key, ts)
    sweep(now)
    if (ts.length <= max) return
    if (await isExempt(msg)) return
    recent.delete(key) // act once per burst

    const botAdmin = await msg.isBotAdmin()
    if (botAdmin) await msg.delete().catch(() => {})

    const mention = `@${jid.toNumber(msg.sender)}`
    if (s.action === 'warn') return warnUser(msg, msg.sender, 'Stop spamming')
    if (s.action === 'kick') {
      if (!botAdmin) return msg.replyMention(`_${mention} is spamming but I'm not an admin, so I can't remove them._`, [msg.sender])
      const text = vars.get('ANTISPAM_MESSAGE').replace(/\\n/g, '\n').replace(/&mention/g, mention)
      await msg.send(text, { mentions: [msg.sender] })
      await msg.kick(msg.sender)
    }
  },
  { fromMe: false, groupOnly: true, name: 'antispam' },
)
