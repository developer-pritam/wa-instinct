import { command, registerScheduleRunner, schedules, to12h, type Schedule } from '../core/index.js'

type Kind = 'mute' | 'unmute'

/** "<MM> <HH> * * *" → "HH:MM" */
const timeOf = (cron: string) => {
  const [m, h] = cron.split(/\s+/)
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function define(kind: Kind) {
  const name = kind === 'mute' ? 'amute' : 'aunmute'
  const label = kind === 'mute' ? 'AutoMute' : 'AutoUnmute'
  const usage = `_Usage: ${name} HH MM [text] · ${name} on | off · ${name} info_`

  command(
    {
      name,
      desc: `Schedule a daily ${kind} of this group (24h time), with an optional message`,
      usage: 'HH MM [text] · on|off · info',
      category: 'moderation',
      groupOnly: true,
    },
    async (msg, args) => {
      const [first = '', second = '', ...rest] = args.split(/\s+/)
      const sub = first.toLowerCase()
      const mine = () => schedules.forChat(msg.chat).filter((s) => s.kind === kind)

      if (sub === 'info') {
        const list = mine()
        if (!list.length) return msg.reply(`_${label} is not set here._`)
        return msg.reply(
          list.map((s) => `*${label}* at ${to12h(timeOf(s.cron))} (${timeOf(s.cron)}) · ${s.enabled ? 'on' : 'off'}\nMessage: ${(s.payload.text as string) || '-'}`).join('\n\n'),
        )
      }
      if (sub === 'on' || sub === 'off') {
        const list = mine()
        if (!list.length) return msg.reply(`_${label} is not set here. Use ${name} HH MM first._`)
        for (const s of list) schedules.enable(s.id, sub === 'on')
        return msg.reply(`_${label} ${sub === 'on' ? 'enabled' : 'disabled'}._`)
      }

      const hour = Number(first)
      const minute = Number(second)
      if (!/^\d{1,2}$/.test(first) || !/^\d{1,2}$/.test(second) || hour > 23 || minute > 59) return msg.reply(usage)
      if (!(await msg.isBotAdmin())) return msg.reply("_I'm not an admin here, so I can't change group settings._")

      // text after the time, or the quoted message, is what gets posted when it fires
      const text = rest.join(' ').trim() || msg.quoted?.text || ''
      schedules.delForChat(msg.chat, kind) // one daily schedule per kind
      schedules.add(msg.chat, kind, `${minute} ${hour} * * *`, { text })
      const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      return msg.reply(`Group will ${kind} daily at *${to12h(hhmm)}*${text ? `\n*Message:* ${text}` : ''}`)
    },
  )

  registerScheduleRunner(kind, async (s: Schedule, sock) => {
    await sock.groupSettingUpdate(s.jid, kind === 'mute' ? 'announcement' : 'not_announcement')
    const text = (s.payload.text as string) || (kind === 'mute' ? '_🔇 Group muted: only admins can send messages now._' : '_🔊 Group unmuted: everyone can send messages again._')
    await sock.sendMessage(s.jid, { text })
  })
}

define('mute')
define('unmute')
