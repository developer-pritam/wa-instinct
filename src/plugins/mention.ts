import { command, jid, on, onOff, vars } from '../core/index.js'

/** MENTION_REPLY = "on"/"off", MENTION_MESSAGE = reply text (placeholder: &name). */

command(
  {
    name: 'mention',
    desc: 'Auto-reply when someone @mentions you in a group',
    usage: 'on | off | get | <reply text>  (placeholder: &name)',
    category: 'misc',
  },
  async (msg, args) => {
    const sub = args.trim().toLowerCase()
    if (!sub) return msg.reply(`*Mention reply* is ${onOff(vars.bool('MENTION_REPLY'))}\n_Usage: mention on | off | get | <text>_`)
    if (sub === 'get') {
      const text = vars.get('MENTION_MESSAGE')
      return msg.reply(text ? `*Mention reply:*\n${text}` : '_No mention reply set. Use mention <text>._')
    }
    if (sub === 'on' || sub === 'off') {
      if (sub === 'on' && !vars.get('MENTION_MESSAGE')) return msg.reply('_Set a reply first: mention <text>_')
      vars.set('MENTION_REPLY', sub === 'on' ? 'true' : 'false')
      return msg.reply(sub === 'on' ? '✅ _Mention reply activated._' : '_Mention reply deactivated._')
    }
    vars.set('MENTION_MESSAGE', args.trim())
    vars.set('MENTION_REPLY', 'true')
    await msg.reply('✅ _Mention reply updated and activated._')
  },
)

on(
  'message',
  async (msg, ctx) => {
    if (!vars.bool('MENTION_REPLY')) return
    const text = vars.get('MENTION_MESSAGE')
    if (!text || !msg.mentions.length) return
    const me = ctx.sock.user
    const mentioned = msg.mentions.some((m) => jid.sameUser(m, me?.id) || jid.sameUser(m, me?.lid))
    if (!mentioned) return
    await msg.reply(text.replace(/\\n/g, '\n').replace(/&name/g, msg.pushName || jid.toNumber(msg.sender)))
  },
  { fromMe: false, groupOnly: true, name: 'mention-reply' },
)
