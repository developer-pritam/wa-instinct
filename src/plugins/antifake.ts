import { chatSettings, command, jid, logger, on, sudo } from '../core/index.js'

interface AntiFake {
  enabled: boolean
  /** whitelist: only `codes` may join · blacklist: `codes` may not join */
  mode: 'whitelist' | 'blacklist' | null
  codes: string[]
}
const KEY = 'antifake'
const DEFAULTS: AntiFake = { enabled: false, mode: null, codes: [] }
const get = (chat: string) => chatSettings.get<AntiFake>(chat, KEY, DEFAULTS)

const parseCodes = (text: string) => [...new Set(text.split(',').map((c) => c.replace(/\D/g, '')).filter(Boolean))]

function status(s: AntiFake): string {
  const list = s.codes.map((c, i) => `${i + 1}. ${s.mode === 'whitelist' ? '✅' : '🚫'} +${c}`).join('\n')
  const mode = s.mode === 'whitelist' ? '🟢 Whitelist mode (allow only these)' : s.mode === 'blacklist' ? '🔴 Blacklist mode (block only these)' : 'No country codes configured.'
  return (
    `Antifake is *${s.enabled ? 'on' : 'off'}*\n*${mode}*\n${list}\n\n` +
    '> Usage:\n- antifake allow 1,91 - whitelist mode\n- antifake disallow 92,93 - blacklist mode\n- antifake remove 91\n- antifake list\n- antifake clear - clear codes and disable\n- antifake on | off\n\n' +
    '_Whitelist and blacklist can\'t be mixed; use `antifake clear` to switch._'
  )
}

command(
  {
    name: 'antifake',
    desc: 'Remove joining members by phone country code (whitelist or blacklist)',
    usage: 'on|off · allow <codes> · disallow <codes> · remove <codes> · list · clear',
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
      if (cmd === 'on' && !s.codes.length) return msg.reply('_Add country codes first: antifake allow 91 or antifake disallow 92_')
      chatSettings.update(msg.chat, KEY, { enabled: cmd === 'on' }, DEFAULTS)
      return msg.reply(`Antifake is now *${cmd}*.`)
    }
    if (cmd === 'allow' || cmd === 'disallow') {
      const mode = cmd === 'allow' ? 'whitelist' : 'blacklist'
      if (!value) return msg.reply(`_Usage: antifake ${cmd} 1,91_`)
      if (s.mode && s.codes.length && s.mode !== mode) {
        return msg.reply(`*⚠️ Can't mix modes!*\n_You are in ${s.mode} mode. Use antifake clear first to switch._`)
      }
      const codes = parseCodes(value)
      if (!codes.length) return msg.reply('_No valid country codes given._')
      chatSettings.update(msg.chat, KEY, { enabled: true, mode, codes: [...new Set([...s.codes, ...codes])] }, DEFAULTS)
      return msg.reply(
        mode === 'whitelist'
          ? `*✅ Allowed country codes (whitelist):*\n${codes.join(', ')}\n\n_These are allowed; all others will be removed._`
          : `*🚫 Disallowed country codes (blacklist):*\n${codes.join(', ')}\n\n_These will be removed; all others are allowed._`,
      )
    }
    if (cmd === 'remove') {
      if (!value) return msg.reply('_Usage: antifake remove 91_')
      const codes = parseCodes(value)
      const left = s.codes.filter((c) => !codes.includes(c))
      chatSettings.update(msg.chat, KEY, { codes: left, mode: left.length ? s.mode : null }, DEFAULTS)
      return msg.reply(`*Removed country codes:*\n${codes.join(', ')}`)
    }
    if (cmd === 'clear') {
      chatSettings.del(msg.chat, KEY)
      return msg.reply('_🗑️ Antifake list cleared and disabled._')
    }
    return msg.reply(status(s))
  },
)

const isBlocked = (number: string, s: AntiFake) => {
  const hit = s.codes.some((c) => number.startsWith(c))
  return s.mode === 'whitelist' ? !hit : hit
}

on('group-update', async (update, ctx) => {
  if (update.action !== 'add') return
  const s = get(update.jid)
  if (!s.enabled || !s.mode || !s.codes.length) return

  const meta = update.metadata
  const me = ctx.sock.user
  const botAdmin = jid.isAdminIn(meta, me?.id ?? '') || jid.isAdminIn(meta, me?.lid ?? '')
  const resolver = new jid.JidResolver(ctx.sock)

  for (const p of update.participants) {
    const part = jid.findParticipant(meta, p)
    // prefer the group's own phone-number record; fall back to the LID mapping store
    const pn = await resolver.toPn(part?.phoneNumber ?? part?.id ?? p)
    if (!pn || jid.isLid(pn)) continue // can't tell the country without a phone number
    const number = jid.toNumber(pn)
    if (sudo.has(number) || jid.isAdminIn(meta, p)) continue
    if (!isBlocked(number, s)) continue

    const mention = `@${number}`
    const mentions = [...new Set([p, `${number}@s.whatsapp.net`])]
    if (!botAdmin) {
      await ctx.sock.sendMessage(update.jid, { text: `_${mention} joined with a blocked country code but I'm not an admin, so I can't remove them._`, mentions })
      continue
    }
    try {
      await ctx.sock.groupParticipantsUpdate(update.jid, [part?.id ?? p], 'remove')
      await ctx.sock.sendMessage(update.jid, { text: `_${mention} removed: numbers starting with +${number.slice(0, 3)}… aren't allowed here (antifake)._`, mentions })
    } catch (err) {
      logger.warn({ err, jid: update.jid, p }, 'antifake remove failed')
    }
  }
})
