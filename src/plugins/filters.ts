import { command, escapeRegExp, filters, on, type Message } from '../core/index.js'

/** Scopes: a group jid (this chat), 'global' (every group) or 'personal' (private chats). */
type Scope = 'chat' | 'global' | 'personal'
const scopeOf = (msg: Message, scope: Scope) => (scope === 'chat' ? msg.chat : scope)
const LABEL: Record<Scope, string> = { chat: 'Filter', global: 'Global filter', personal: 'Personal filter' }

const whole = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(pattern)}(?![\\p{L}\\p{N}_])`, 'iu')

function defineFilter(name: string, stop: string, scope: Scope, desc: string, groupOnly: boolean) {
  command(
    {
      name,
      desc,
      usage: '<keyword> (reply to the message to send) · list',
      category: 'moderation',
      groupOnly,
    },
    async (msg, args) => {
      const keyword = args.trim().toLowerCase()
      if (!keyword) return msg.reply(`_Usage: ${name} <keyword> (while replying to a message) · ${name} list_`)
      if (keyword === 'list' && !msg.quoted) {
        const all = filters.list(scopeOf(msg, scope))
        if (!all.length) return msg.reply(`_No ${LABEL[scope].toLowerCase()}s set._`)
        return msg.reply(`> *${LABEL[scope]}s:*\n${all.map((f) => `- ${f.pattern}`).join('\n')}`)
      }
      const reply = msg.quoted?.text
      if (!reply) return msg.reply('_Reply to a text message to use it as the auto-reply._')
      filters.set(scopeOf(msg, scope), keyword, reply)
      return msg.reply(`✅ ${LABEL[scope]} *${keyword}* is now active${scope === 'global' ? ' in every group' : ''}.`)
    },
  )

  command(
    {
      name: stop,
      desc: `Remove a ${LABEL[scope].toLowerCase()}`,
      usage: '<keyword>',
      category: 'moderation',
      groupOnly,
    },
    async (msg, args) => {
      const keyword = args.trim().toLowerCase()
      if (!keyword) return msg.reply(`_Usage: ${stop} <keyword>_`)
      const deleted = filters.del(scopeOf(msg, scope), keyword)
      return msg.reply(deleted ? `_${LABEL[scope]} *${keyword}* stopped._` : `_${keyword} isn't in the ${LABEL[scope].toLowerCase()} list._`)
    },
  )
}

defineFilter('filter', 'stop', 'chat', 'Auto-reply to a keyword in this group', true)
defineFilter('gfilter', 'gstop', 'global', 'Auto-reply to a keyword in every group', false)
defineFilter('pfilter', 'pstop', 'personal', 'Auto-reply to a keyword in personal chats', false)

on(
  'text',
  async (msg) => {
    const scopes = msg.isGroup ? [msg.chat, 'global'] : ['personal']
    for (const scope of scopes) {
      for (const { pattern, reply } of filters.list(scope)) {
        if (whole(pattern).test(msg.text)) return msg.reply(reply)
      }
    }
  },
  { fromMe: false, name: 'filters' },
)
