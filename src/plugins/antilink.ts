import { chatSettings, command, jid, on, vars } from '../core/index.js'
import { isExempt, warnUser } from './warn.js'

type Action = 'kick' | 'warn' | 'null'
interface AntiLink {
  enabled: boolean
  /** kick | warn | null (delete only) */
  action: Action
  /** hostnames that are always fine */
  allowed: string[]
  /** hostnames that are always blocked; when only this list is set, everything else is fine */
  disallowed: string[]
}
const KEY = 'antilink'
const DEFAULTS: AntiLink = { enabled: false, action: 'null', allowed: [], disallowed: [] }
const get = (chat: string) => chatSettings.get<AntiLink>(chat, KEY, DEFAULTS)

// http(s)://…, www.…, or a bare domain with a common TLD (chat.whatsapp.com, t.me, bit.ly …)
const TLDS = 'com|net|org|io|me|co|in|us|uk|info|biz|xyz|link|site|online|app|dev|gg|tv|ly|to|gl|be|cc|ru|de|fr|es|it|nl|br|id|pk|ng|za|ke|ae|sa|eg|tk|ml|ga|cf|top|club|store|shop|live|chat|group|page|pro|cloud|zone|ai|tech|wiki|news|blog|fun|vip|one|mobi|asia|eu|ca|au|jp|cn|kr|tr|ir|iq|bd|lk|np|my|sg|ph|vn|th'
const URL_RE = new RegExp(`(?:https?:\\/\\/|www\\.)[^\\s<>"']+|(?<![\\w@.-])(?:[a-z0-9-]+\\.)+(?:${TLDS})(?![\\w-])(?:\\/[^\\s<>"']*)?`, 'gi')

/** "https://www.Example.com/x?y" → "example.com". Also used to normalise user-supplied entries. */
export function hostnameOf(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/^!/, '')
}

export const findUrls = (text: string): string[] => text.match(URL_RE) ?? []

const hostMatches = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`))

/** Which of these URLs break the rules for this chat. */
function violations(urls: string[], s: AntiLink): string[] {
  return urls.filter((u) => {
    const host = hostnameOf(u)
    if (hostMatches(host, s.disallowed)) return true
    if (hostMatches(host, s.allowed)) return false
    // blacklist-only mode: anything not disallowed is fine
    if (s.disallowed.length && !s.allowed.length) return false
    return true
  })
}

const parseList = (text: string) => [...new Set(text.split(',').map(hostnameOf).filter(Boolean))]

function status(s: AntiLink): string {
  return (
    `Antilink is *${s.enabled ? 'on' : 'off'}* · action: *${s.action}*\n` +
    `Allowed: ${s.allowed.join(', ') || '-'}\nDisallowed: ${s.disallowed.join(', ') || '-'}\n\n` +
    '> Usage:\n- antilink on | off\n- antilink kick | warn | null (delete only)\n- antilink allow whatsapp.com,youtube.com\n' +
    '- antilink disallow facebook.com\n- antilink list\n- antilink clear [allow|disallow]\n\n' +
    '_With only a disallow list, just those domains are blocked; otherwise every link not allowed is blocked._'
  )
}

command(
  {
    name: 'antilink',
    desc: 'Delete, warn or kick for links in this group, with allow/disallow domain lists',
    usage: 'on|off · kick|warn|null · allow <domains> · disallow <domains> · list · clear',
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
      const enabled = cmd === 'on'
      if (!enabled && !s.enabled) return msg.reply('_Antilink is already off._')
      chatSettings.update(msg.chat, KEY, { enabled }, DEFAULTS)
      return msg.reply(`Antilink is now *${cmd}*.`)
    }
    if (cmd === 'kick' || cmd === 'warn' || cmd === 'null') {
      chatSettings.update(msg.chat, KEY, { action: cmd }, DEFAULTS)
      return msg.reply(`Antilink action updated to: *${cmd}*`)
    }
    if (cmd === 'allow' || cmd === 'disallow') {
      if (!value) return msg.reply(`_Usage: antilink ${cmd} domain.com,other.com_`)
      const hosts = parseList(value)
      const mine = cmd === 'allow' ? 'allowed' : 'disallowed'
      const other = cmd === 'allow' ? 'disallowed' : 'allowed'
      const added = hosts.filter((h) => !s[mine].includes(h))
      if (!added.length) return msg.reply('_Nothing new to add._')
      chatSettings.update<AntiLink>(msg.chat, KEY, {
        [mine]: [...s[mine], ...added],
        [other]: s[other].filter((h) => !hosts.includes(h)), // a host can't be in both lists
      }, DEFAULTS)
      return msg.reply(`*${cmd === 'allow' ? 'Allowed' : 'Disallowed'} domains updated*\nAdded: ${added.join(', ')}\nTotal: ${s[mine].length + added.length}`)
    }
    if (cmd === 'clear') {
      const which = value.toLowerCase()
      if (which.startsWith('allow')) chatSettings.update(msg.chat, KEY, { allowed: [] }, DEFAULTS)
      else if (which.startsWith('disallow')) chatSettings.update(msg.chat, KEY, { disallowed: [] }, DEFAULTS)
      else chatSettings.update(msg.chat, KEY, { allowed: [], disallowed: [] }, DEFAULTS)
      return msg.reply(`_Antilink ${which ? which + ' list' : 'lists'} cleared._`)
    }
    return msg.reply(status(s))
  },
)

on(
  'message',
  async (msg) => {
    const s = get(msg.chat)
    if (!s.enabled || !msg.text) return
    const urls = findUrls(msg.text)
    if (!urls.length || !violations(urls, s).length) return
    if (await isExempt(msg)) return

    const botAdmin = await msg.isBotAdmin()
    if (botAdmin) await msg.delete().catch(() => {})

    if (s.action === 'warn') return warnUser(msg, msg.sender, 'Links are not allowed here')
    if (s.action === 'kick') {
      const mention = `@${jid.toNumber(msg.sender)}`
      if (!botAdmin) return msg.replyMention(`_${mention} posted a link but I'm not an admin, so I can't remove them._`, [msg.sender])
      const text = vars.get('ANTILINK_MESSAGE').replace(/\\n/g, '\n').replace(/&mention/g, mention)
      await msg.send(text, { mentions: [msg.sender] })
      await msg.kick(msg.sender)
    }
  },
  { fromMe: false, groupOnly: true, name: 'antilink' },
)
