import { command, jid, on, vars, type Message } from '../core/index.js'
import { isExempt, warnUser } from './warn.js'

// Global settings (one bot-wide switch, like the original), kept in vars so `allvar` shows them.
const enabled = () => vars.bool('ANTIGM')
const action = () => vars.get('ANTIGM_ACTION') || 'delete'
const ignored = () => vars.get('ANTIGM_IGNORE').split(/[\s,]+/).filter(Boolean)

/** A message that @mentions the group itself (status mention or an inline group mention). */
const mentionsGroup = (msg: Message) => !!msg.content.groupStatusMentionMessage || !!msg.contextInfo?.groupMentions?.length

command(
  {
    name: 'antigm',
    desc: 'Delete, warn or kick for @group mentions (bot-wide); ignore specific groups',
    usage: 'on|off · delete|warn|kick · ignore <group jids>',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const [sub = '', ...rest] = args.split(/\s+/)
    const cmd = sub.toLowerCase()
    if (cmd === 'on' || cmd === 'off') {
      vars.set('ANTIGM', cmd)
      return msg.reply(cmd === 'on' ? '_Anti group mention is now active._ 👀' : '_Anti group mention is off._')
    }
    if (cmd === 'delete' || cmd === 'warn' || cmd === 'kick') {
      vars.set('ANTIGM_ACTION', cmd)
      return msg.reply(`Group mentions will now result in *${cmd}*.`)
    }
    if (cmd === 'ignore') {
      const jids = jid.parseJids(rest.join(' ')).filter(jid.isGroup)
      if (!jids.length) return msg.reply('_Usage: antigm ignore 1234567890-123@g.us,…_')
      vars.set('ANTIGM_IGNORE', [...new Set([...ignored(), ...jids])].join(','))
      return msg.reply(`_Ignoring group mentions in: ${jids.join(', ')}_`)
    }
    return msg.reply(
      `Antigm is *${enabled() ? 'on' : 'off'}* · action: *${action()}*\nIgnored: ${ignored().join(', ') || '-'}\n\n> Usage:\n- antigm on | off\n- antigm delete | warn | kick\n- antigm ignore <group jid,…>`,
    )
  },
)

on(
  'message',
  async (msg) => {
    if (!enabled() || !mentionsGroup(msg) || ignored().includes(msg.chat)) return
    if (await isExempt(msg)) return

    const botAdmin = await msg.isBotAdmin()
    if (botAdmin) await msg.delete().catch(() => {})

    const act = action()
    const mention = `@${jid.toNumber(msg.sender)}`
    if (act === 'warn') return warnUser(msg, msg.sender, 'Group mentions are not allowed')
    if (act === 'kick') {
      if (!botAdmin) return msg.replyMention(`_${mention} mentioned the group but I'm not an admin, so I can't remove them._`, [msg.sender])
      await msg.send(`_${mention} removed for mentioning the group._`, { mentions: [msg.sender] })
      await msg.kick(msg.sender)
    }
  },
  { fromMe: false, groupOnly: true, name: 'antigm' },
)
