import type { GroupMetadata, WASocket } from 'baileys'
import { chatSettings, command, jid, logger, media, on, type Message } from '../core/index.js'

type Kind = 'welcome' | 'goodbye'
interface Greeting {
  enabled: boolean
  text: string
}
const DEFAULTS: Greeting = { enabled: false, text: '' }
const get = (chat: string, kind: Kind) => chatSettings.get<Greeting>(chat, kind, DEFAULTS)

const HELP = (kind: Kind, s: Greeting) =>
  `${kind[0].toUpperCase() + kind.slice(1)} is currently *${s.enabled ? 'on' : 'off'}*` +
  (s.text ? `\n\n_Message:_\n${s.text}` : '') +
  `\n\n> Usage:\n- ${kind} Hi &mention! ${kind === 'welcome' ? 'Welcome to' : 'Bye from'} &name - set the message\n- ${kind} on | off\n- ${kind} delete\n\n` +
  '> Placeholders:\n- &mention - the member\n- &name - group name\n- &desc - group description\n- &size - member count\n- &pp - send their profile picture'

/** Fill placeholders and send, as an image when `&pp` is used and the user has a picture. */
async function sendGreeting(sock: WASocket, meta: GroupMetadata, template: string, user: string, quoted?: Message) {
  const resolver = new jid.JidResolver(sock)
  const pn = await resolver.toPn(user)
  const mention = `@${jid.toNumber(pn)}`
  const wantPp = /&pp/.test(template)
  const text = template
    .replace(/&mention/g, mention)
    .replace(/&name/g, meta.subject ?? '')
    .replace(/&desc/g, meta.desc ?? '')
    .replace(/&size/g, String(meta.participants.length))
    .replace(/&pp/g, '')
    .trim()
  const mentions = [...new Set([user, pn])]

  if (wantPp) {
    try {
      const url = await sock.profilePictureUrl(pn, 'image').catch(() => sock.profilePictureUrl(user, 'image'))
      if (url) {
        const { buffer } = await media.fetchBuffer(url)
        if (quoted) return quoted.reply({ image: buffer, caption: text }, { mentions })
        return sock.sendMessage(meta.id, { image: buffer, caption: text, mentions })
      }
    } catch (err) {
      logger.debug({ err, user }, 'greeting: profile picture unavailable')
    }
  }
  if (quoted) return quoted.replyMention(text, mentions)
  return sock.sendMessage(meta.id, { text, mentions })
}

for (const kind of ['welcome', 'goodbye'] as Kind[]) {
  command(
    {
      name: kind,
      desc: kind === 'welcome' ? 'Greet members who join this group' : 'Say goodbye to members who leave this group',
      usage: 'on|off · delete · <message with &mention &name &size &desc &pp>',
      category: 'moderation',
      groupOnly: true,
    },
    async (msg, args) => {
      const s = get(msg.chat, kind)
      const lower = args.toLowerCase()
      if (!args) return msg.reply(HELP(kind, s))
      if (lower === 'on' || lower === 'off') {
        if (!s.text) return msg.reply(`_Set a ${kind} message first, e.g. ${kind} Hi &mention! Then: ${kind} on_`)
        chatSettings.update(msg.chat, kind, { enabled: lower === 'on' }, DEFAULTS)
        return msg.reply(`_${kind[0].toUpperCase() + kind.slice(1)} is now ${lower}_`)
      }
      if (lower === 'delete') {
        chatSettings.del(msg.chat, kind)
        return msg.reply(`_${kind[0].toUpperCase() + kind.slice(1)} message deleted_`)
      }
      chatSettings.set(msg.chat, kind, { enabled: true, text: args })
      // preview it with the sender as the member
      await sendGreeting(msg.socket, await msg.groupMetadata(), args, msg.sender, msg)
    },
  )
}

on('group-update', async (update, ctx) => {
  const kind: Kind | undefined = update.action === 'add' ? 'welcome' : update.action === 'remove' ? 'goodbye' : undefined
  if (!kind) return
  const s = get(update.jid, kind)
  if (!s.enabled || !s.text) return
  const me = ctx.sock.user
  for (const p of update.participants) {
    if (jid.sameUser(p, me?.id) || jid.sameUser(p, me?.lid)) continue // nothing to say when it's the bot itself
    await sendGreeting(ctx.sock, update.metadata, s.text, p).catch((err) => logger.warn({ err, p }, `${kind} failed`))
  }
})

// ---------- pdm: promote / demote announcements ----------

command(
  {
    name: 'pdm',
    desc: 'Announce who promoted or demoted whom in this group',
    usage: 'on|off',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const v = args.toLowerCase()
    if (v !== 'on' && v !== 'off') return msg.reply('_Usage: pdm on | off_')
    chatSettings.set(msg.chat, 'pdm', v === 'on')
    return msg.reply(v === 'on' ? '_Promote/demote alerts activated._' : '_Promote/demote alerts deactivated._')
  },
)

on('group-update', async (update, ctx) => {
  if (update.action !== 'promote' && update.action !== 'demote') return
  if (!chatSettings.get<boolean>(update.jid, 'pdm', false)) return
  const resolver = new jid.JidResolver(ctx.sock)
  const tag = async (u: string) => `@${jid.toNumber(await resolver.toPn(u))}`
  const verb = update.action === 'promote' ? 'promoted' : 'demoted'
  const by = update.author ? ` by ${await tag(update.author)}` : ''
  for (const p of update.participants) {
    const mentions = [p, update.author].filter((x): x is string => !!x)
    await ctx.sock.sendMessage(update.jid, { text: `${await tag(p)} was ${verb}${by}`, mentions: (await Promise.all(mentions.map((m) => resolver.bothForms(m)))).flat() })
  }
})
