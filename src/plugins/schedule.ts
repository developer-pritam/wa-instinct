import type { WAMessage } from 'baileys'
import { command, messageStore, registerScheduleRunner, schedules, to12h } from '../core/index.js'
import { reviveMessage } from './_shared.js'

/**
 * Scheduled messages: payload { text?, forwardId?, message?, once }.
 * `message` keeps a copy of the replied message so a daily forward still works after the store prunes it.
 */
registerScheduleRunner('message', async (s, sock) => {
  const { text, forwardId, message } = s.payload as { text?: string; forwardId?: string; message?: WAMessage }
  const stored = forwardId ? messageStore.get<WAMessage>(forwardId) : undefined
  const forward = reviveMessage(stored ?? message)
  if (forward) await sock.sendMessage(s.jid, { forward })
  else if (text) await sock.sendMessage(s.jid, { text })
})

const USAGE = [
  '_Usage:_',
  '_schedule 09:30 Good morning! — once, at 9:30_',
  '_schedule 09:30 daily Good morning! — every day_',
  '_schedule 21:00 (reply to a message) — forward it at 21:00_',
  '_schedule list · schedule del <id|all>_',
].join('\n')

const cronToTime = (cron: string) => {
  const [m, h] = cron.split(' ')
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

command(
  {
    name: 'schedule',
    desc: 'Send a text or forward the replied message at a time, once or daily',
    usage: '<HH:MM> [daily] <text|reply> | list | del <id|all>',
    category: 'schedule',
  },
  async (msg, args) => {
    const [sub, ...rest] = args.split(/\s+/)
    const lower = (sub ?? '').toLowerCase()

    if (lower === 'list') {
      const list = schedules.forChat(msg.chat).filter((s) => s.kind === 'message')
      if (!list.length) return msg.reply('_Nothing scheduled in this chat._')
      const lines = list.map((s) => {
        const p = s.payload as { text?: string; once?: boolean }
        const what = p.text ? p.text.slice(0, 40) + (p.text.length > 40 ? '…' : '') : '(forwarded message)'
        return `*#${s.id}* ${to12h(cronToTime(s.cron))} ${p.once ? 'once' : 'daily'} — ${what}`
      })
      return msg.reply(lines.join('\n'))
    }

    if (lower === 'del' || lower === 'delete') {
      const target = rest[0]?.toLowerCase()
      if (!target) return msg.reply('_Usage: schedule del <id|all>_')
      if (target === 'all') {
        const n = schedules.delForChat(msg.chat, 'message')
        return msg.reply(n ? `🗑️ _Removed ${n} schedule${n > 1 ? 's' : ''}._` : '_Nothing scheduled here._')
      }
      const id = Number(target)
      const own = schedules.forChat(msg.chat).find((s) => s.id === id && s.kind === 'message')
      if (!own) return msg.reply(`_No schedule #${target} in this chat._`)
      schedules.del(id)
      return msg.reply(`🗑️ _Schedule #${id} removed._`)
    }

    const time = (sub ?? '').match(/^(\d{1,2}):(\d{2})$/)
    if (!time) return msg.reply(USAGE)
    const [hh, mm] = [Number(time[1]), Number(time[2])]
    if (hh > 23 || mm > 59) return msg.reply('_Time must be HH:MM (24h)._')

    let daily = false
    if (rest[0]?.toLowerCase() === 'daily') {
      daily = true
      rest.shift()
    }
    const text = rest.join(' ').trim()
    if (!text && !msg.quoted) return msg.reply(USAGE)

    const cron = `${mm} ${hh} * * *`
    const payload: Record<string, unknown> = { once: !daily }
    if (msg.quoted) {
      payload.forwardId = msg.quoted.id
      payload.message = msg.quoted.raw
    } else payload.text = text

    const id = schedules.add(msg.chat, 'message', cron, payload)
    await msg.reply(`⏰ Scheduled *#${id}* for ${to12h(`${hh}:${mm}`)}${daily ? ' every day' : ''}.`)
  },
)
