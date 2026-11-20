import { command, getGroupMetadata, jid, on, vars, type Message, type Context } from '../core/index.js'
import { reviveBuffers } from './_shared.js'

/**
 * ANTI_DELETE / ANTI_EDIT value: "<dest> [scope]" where
 *   dest  = off | on | g (same chat) | p (your own chat) | <jid>
 *   scope = pm | gm | no-pm | no-gm
 */
interface Setting {
  dest: string
  scope: string
}

const SCOPES = ['pm', 'gm', 'no-pm', 'no-gm']

function parseSetting(raw: string): Setting | undefined {
  const value = raw.trim().toLowerCase()
  if (!value || ['off', 'false'].includes(value)) return undefined
  const [dest = '', scope = ''] = value.split(/\s+/)
  return { dest, scope }
}

function scopeAllows(scope: string, isGroup: boolean): boolean {
  if (scope === 'pm') return !isGroup
  if (scope === 'gm') return isGroup
  if (scope === 'no-pm') return isGroup
  if (scope === 'no-gm') return !isGroup
  return true
}

/** Where to send the recovered message. */
function destination(setting: Setting, original: Message, ctx: Context): string {
  if (setting.dest === 'p') return jid.normalize(ctx.sock.user?.id)
  if (['g', 'on', 'true'].includes(setting.dest)) return original.chat
  return setting.dest
}

async function chatName(original: Message, ctx: Context): Promise<string> {
  if (!original.isGroup) return original.pushName || jid.toNumber(original.sender)
  try {
    return (await getGroupMetadata(ctx.sock, original.chat)).subject
  } catch {
    return original.chat
  }
}

const isMe = (ctx: Context, who: string) => jid.sameUser(who, ctx.sock.user?.id) || jid.sameUser(who, ctx.sock.user?.lid)

/** True when the revoke/edit came from this account (in private chats `by` is the partner, so rely on fromMe). */
const byUs = (ctx: Context, original: Message, by: string) => (original.isGroup ? isMe(ctx, by) : original.fromMe)

function settingCommand(name: string, key: string, desc: string, what: string) {
  const usage = [
    `_Usage: ${name} on | off | p | g | <jid> [pm|gm|no-pm|no-gm]_`,
    `_g = in the same chat, p = to your own chat, <jid> = to that chat_`,
    `_pm/gm = only personal/group chats, no-pm/no-gm = exclude them_`,
  ].join('\n')

  command({ name, desc, usage: 'on|off|p|g|<jid> [pm|gm|no-pm|no-gm]', category: 'whatsapp' }, async (msg, args, ctx) => {
    if (!args) return msg.reply(`*${key}* = ${vars.get(key) || 'off'}\n${usage}`)
    const [destRaw = '', scope = ''] = args.trim().toLowerCase().split(/\s+/)
    if (scope && !SCOPES.includes(scope)) return msg.reply(usage)

    let dest = destRaw
    if (!['on', 'off', 'false', 'p', 'g'].includes(dest)) {
      const [target] = jid.parseJids(destRaw)
      if (!target) return msg.reply(usage)
      if (jid.isGroup(target)) {
        try {
          await getGroupMetadata(ctx.sock, target)
        } catch {
          return msg.reply('_Invalid group jid._')
        }
      } else {
        const [hit] = (await ctx.sock.onWhatsApp(jid.toNumber(target))) ?? []
        if (!hit?.exists) return msg.reply('_That number is not on WhatsApp._')
      }
      dest = target
    }
    if (dest === 'false') dest = 'off'
    vars.set(key, dest === 'off' ? 'off' : [dest, scope].filter(Boolean).join(' '))

    if (dest === 'off') return msg.reply(`_${what} disabled._`)
    const where = dest === 'p' ? 'to your own chat' : dest === 'g' || dest === 'on' ? 'in the same chat' : `to ${dest}`
    const scopeText =
      scope === 'pm' ? '\n📌 _Only personal chats_'
      : scope === 'gm' ? '\n📌 _Only group chats_'
      : scope === 'no-pm' ? '\n📌 _Excluding personal chats_'
      : scope === 'no-gm' ? '\n📌 _Excluding group chats_'
      : ''
    await msg.reply(`✅ _${what} will be sent ${where}._${scopeText}`)
  })
}

settingCommand('delete', 'ANTI_DELETE', 'Anti-delete: recover deleted messages', 'Deleted messages')
settingCommand('antiedit', 'ANTI_EDIT', 'Anti-edit: show the previous text of edited messages', 'Edit history')

on(
  'message-delete',
  async ({ original, by }, ctx) => {
    const setting = parseSetting(vars.get('ANTI_DELETE'))
    if (!setting || !original) return
    if (!scopeAllows(setting.scope, original.isGroup)) return
    if (byUs(ctx, original, by)) return

    const dest = destination(setting, original, ctx)
    // `by` may be a LID while `original.sender` is a phone number, so compare across forms
    const who = original.isGroup && !(await original.jids.same(by, original.sender)) ? `@${jid.toNumber(await original.jids.toPn(by))} (admin)` : original.mentionTag
    const where = dest === original.chat ? '' : ` in *${await chatName(original, ctx)}*`
    await original.send(`🗑️ Deleted by ${who}${where}`, { mentions: [original.sender, by] }, dest)
    await original.send({ forward: reviveBuffers(original.raw) }, {}, dest)
  },
  { name: 'antidelete' },
)

on(
  'message-edit',
  async ({ original, newText, by }, ctx) => {
    const setting = parseSetting(vars.get('ANTI_EDIT'))
    if (!setting || !original) return
    if (!scopeAllows(setting.scope, original.isGroup)) return
    if (byUs(ctx, original, by)) return

    const dest = destination(setting, original, ctx)
    const where = dest === original.chat ? '' : ` in *${await chatName(original, ctx)}*`
    const oldText = original.text || `(${original.type})`
    await original.send(
      `✏️ ${original.mentionTag} edited a message${where}\n\n*Old:* ${oldText}\n*New:* ${newText || '(empty)'}`,
      { mentions: [original.sender] },
      dest,
    )
  },
  { name: 'antiedit' },
)
