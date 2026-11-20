import { command, db, jid, vars, warns, sleep, type Message } from '../core/index.js'

/** WARN_LIMIT from vars, never below 1. */
export const warnLimit = () => Math.max(1, vars.int('WARN_LIMIT', 3))

/** Fill `&mention &remaining &reason &warn` in a template; `\n` written literally in .env becomes a newline. */
function render(template: string, values: { mention: string; remaining: number; reason: string; warn: number }): string {
  return template
    .replace(/\\n/g, '\n')
    .replace(/&mention/g, values.mention)
    .replace(/&remaining/g, String(values.remaining))
    .replace(/&reason/g, values.reason)
    .replace(/&warn/g, String(values.warn))
    .trim()
}

/** True for people moderation listeners must leave alone: sudo, the bot itself, and group admins. */
export async function isExempt(msg: Message): Promise<boolean> {
  if (msg.isSudo || msg.fromMe) return true
  if (!msg.isGroup) return false
  return (await msg.isAdmin(msg.sender)) || (await msg.isAdmin(msg.senderRaw))
}

/**
 * Add one warning to `user` in the chat of `msg`, announce it, and kick when the
 * count goes past WARN_LIMIT. Admins are never kicked. Shared by antilink/antiword/antispam/antigm.
 */
export async function warnUser(msg: Message, user: string, reason = ''): Promise<{ count: number; kicked: boolean }> {
  const pn = await msg.jids.toPn(user)
  const limit = warnLimit()
  const count = warns.add(msg.chat, pn)
  const mention = `@${jid.toNumber(pn)}`
  const values = { mention, remaining: Math.max(0, limit - count), reason: reason || '-', warn: limit }

  if (count >= limit) { // WARN_LIMIT=3 → removed on the 3rd warn
    if (await msg.isAdmin(pn)) {
      warns.reset(msg.chat, pn)
      await msg.replyMention(`_${mention} is an admin, I can't remove them. Warnings reset._`, [pn])
      return { count, kicked: false }
    }
    if (!(await msg.isBotAdmin())) {
      await msg.replyMention(`_${mention} exceeded the warn limit but I'm not an admin here._`, [pn])
      return { count, kicked: false }
    }
    await msg.replyMention(render(vars.get('WARN_KICK_MESSAGE'), values), [pn])
    warns.reset(msg.chat, pn)
    await msg.kick(pn)
    return { count, kicked: true }
  }

  await msg.replyMention(render(vars.get('WARN_MESSAGE'), values), [pn])
  return { count, kicked: false }
}

const warnRows = db.prepare('SELECT user, count FROM warns WHERE jid = ? ORDER BY count DESC')

command(
  {
    name: 'warn',
    desc: 'Warn a member (kicked past WARN_LIMIT), reset their warnings, or list warnings',
    usage: '[@user|reply] [reason] · reset @user · list',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const [sub, ...rest] = args.split(/\s+/)
    const limit = warnLimit()

    if (sub?.toLowerCase() === 'list') {
      const rows = warnRows.all(msg.chat) as { user: string; count: number }[]
      if (!rows.length) return msg.reply('_No warnings in this group._')
      const lines = rows.map((r, i) => `${i + 1}. @${jid.toNumber(r.user)} — ${r.count}/${limit}`)
      return msg.replyMention(`*Warnings*\n${lines.join('\n')}`, rows.map((r) => r.user))
    }

    if (sub?.toLowerCase() === 'reset') {
      const user = msg.targetUser ?? jid.parseJids(rest.join(' '))[0]
      if (!user) return msg.reply('_Usage: warn reset @user | reply_')
      const pn = await msg.jids.toPn(user)
      warns.reset(msg.chat, pn)
      const text = render(vars.get('WARN_RESET_MESSAGE'), { mention: `@${jid.toNumber(pn)}`, remaining: limit, reason: '', warn: limit })
      return msg.replyMention(text, [pn])
    }

    const user = msg.targetUser
    if (!user) return msg.reply('_Usage: warn @user | reply [reason] · warn reset @user · warn list_')
    // the reason is whatever is left once @mentions are stripped
    const reason = args.replace(/@\d+/g, '').trim()
    const { kicked } = await warnUser(msg, user, reason)

    // tidy up the offending message when we can
    if (!kicked && msg.quoted && (await msg.isBotAdmin())) {
      await sleep(2000)
      await msg.delete(msg.quoted.key).catch(() => {})
    }
  },
)
