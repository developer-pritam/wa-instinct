import sharp from 'sharp'
import { command, formatDate, jid, padIndex, vars, type Message } from '../core/index.js'

/** @mention → quoted sender → (private chat) the chat partner. */
const targetUser = (msg: Message): string | undefined => msg.targetUser ?? (!msg.isGroup ? msg.chat : undefined)

const myJid = (msg: Message) => jid.normalize(msg.socket.user?.id)

command(
  {
    name: 'jid',
    desc: 'Show the jid of a mentioned user, the quoted sender, or this chat (with the LID when known)',
    usage: '[@user | reply]',
    category: 'user',
  },
  async (msg) => {
    const target = msg.targetUser ?? msg.chat
    if (!jid.isUser(target)) return msg.reply(`\`\`\`${target}\`\`\``)
    const [pn, lid] = await Promise.all([msg.jids.toPn(target), msg.jids.toLid(target)])
    const lines = [`\`\`\`${pn}\`\`\``]
    if (lid && lid !== pn && jid.isLid(lid)) lines.push(`LID: \`\`\`${lid}\`\`\``)
    await msg.reply(lines.join('\n'))
  },
)

command(
  {
    name: 'whois',
    desc: 'Profile picture and details of a user or group',
    usage: '[number | jid | @user | reply]',
    category: 'whatsapp',
  },
  async (msg, args, ctx) => {
    const parsed = jid.parseJids(args)[0]
    const gid = jid.isGroup(parsed) ? parsed : undefined
    const user = !gid ? (jid.isUser(parsed) ? parsed : targetUser(msg)) : undefined
    const target = user ?? gid ?? (msg.isGroup ? msg.chat : undefined)
    if (!target) return msg.reply('_Usage: whois <number | jid> · @user · reply_')

    let caption: string
    if (jid.isUser(target)) {
      const pn = await msg.jids.toPn(target)
      caption = `*Number :* +${jid.toNumber(pn)}`
      // the only name source we have is the push name on messages we've just seen
      const name = (await msg.jids.same(pn, msg.sender)) ? msg.pushName : msg.quoted && (await msg.jids.same(pn, msg.quoted.sender)) ? msg.quoted.pushName : ''
      if (name) caption += `\n*Name :* ${name}`
      const about = await fetchAbout(ctx.sock, pn)
      if (about?.status) {
        caption += `\n*About :* ${about.status}`
        if (about.setAt) caption += `\n*Set at :* ${formatDate(about.setAt)}`
      }
    } else {
      const meta = await msg.groupMetadata(target, true).catch(() => undefined)
      if (!meta) return msg.reply("_I searched everywhere, but couldn't find that group! 🔍_")
      const owner = meta.ownerPn ?? meta.owner
      caption = [
        `*Name :* ${meta.subject}`,
        `*Owner :* ${owner ? '+' + jid.toNumber(await msg.jids.toPn(owner)) : '-'}`,
        `*Members :* ${meta.size ?? meta.participants.length}`,
        `*Created :* ${meta.creation ? formatDate(meta.creation * 1000) : '-'}`,
        `*Description :* ${meta.desc || '-'}`,
      ].join('\n')
    }

    const pp = await ctx.sock.profilePictureUrl(target, 'image').catch(() => undefined)
    if (pp) return msg.sendFromUrl(pp, { caption, quoted: msg.raw }).catch(() => msg.reply(caption))
    await msg.reply(caption)
  },
)

/** `fetchStatus` returns a USync list whose `status` entry is `{ status, setAt }` — be defensive about the shape. */
async function fetchAbout(sock: Message['socket'], pn: string): Promise<{ status?: string; setAt?: Date } | undefined> {
  const res = await sock.fetchStatus(pn).catch(() => undefined)
  const entry = res?.[0]?.status as { status?: string | null; setAt?: Date } | string | undefined
  if (!entry) return undefined
  if (typeof entry === 'string') return { status: entry }
  return { status: entry.status ?? undefined, setAt: entry.setAt instanceof Date && entry.setAt.getTime() > 0 ? entry.setAt : undefined }
}

command(
  {
    name: 'gjid',
    desc: 'List every group the bot is in, with its jid',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    const groups = Object.values(await ctx.sock.groupFetchAllParticipating()).sort((a, b) => a.subject.localeCompare(b.subject))
    if (!groups.length) return msg.reply('_Not in any group._')
    const lines = groups.map((g, i) => `${i + 1}.${padIndex(i + 1, groups.length)}*${g.subject}* — ${g.id}`)
    await msg.reply(lines.join('\n'))
  },
)

command(
  {
    name: 'block',
    desc: 'Block a user',
    usage: '@user | reply | (in their chat)',
    category: 'user',
  },
  async (msg, _args, ctx) => {
    const target = targetUser(msg)
    if (!target) return msg.reply('_Usage: block @user · reply · or run it in their chat_')
    const pn = await msg.jids.toPn(target)
    await ctx.sock.updateBlockStatus(pn, 'block')
    await msg.replyMention(`🚫 Blocked @${jid.toNumber(pn)}`, [pn])
  },
)

command(
  {
    name: 'unblock',
    desc: 'Unblock a user',
    usage: '@user | reply | (in their chat)',
    category: 'user',
  },
  async (msg, _args, ctx) => {
    const target = targetUser(msg)
    if (!target) return msg.reply('_Usage: unblock @user · reply · or run it in their chat_')
    const pn = await msg.jids.toPn(target)
    await ctx.sock.updateBlockStatus(pn, 'unblock')
    await msg.replyMention(`✅ Unblocked @${jid.toNumber(pn)}`, [pn])
  },
)

command(
  {
    name: 'pp',
    desc: 'Set your profile picture from the replied image (WhatsApp crops it to a centred square)',
    usage: 'reply to an image',
    category: 'user',
  },
  async (msg, _args, ctx) => {
    if (!msg.quoted?.isImage) return msg.reply('_Reply to an image to set it as your profile picture. 📸_')
    const buffer = await msg.quoted.download()
    await ctx.sock.updateProfilePicture(myJid(msg), buffer)
    await msg.reply('_Profile picture updated._')
  },
)

command(
  {
    name: 'fullpp',
    desc: 'Set your profile picture keeping the whole image (padded to a square instead of cropped)',
    usage: 'reply to an image',
    category: 'user',
  },
  async (msg, _args, ctx) => {
    if (!msg.quoted?.isImage) return msg.reply('_Reply to an image to set it as your full profile picture. 📸_')
    const buffer = await msg.quoted.download()
    // Baileys always resizes to 640x640 (centre crop), so pad to a square first with a blurred copy as background
    const base = sharp(buffer).rotate()
    const { width = 640, height = 640 } = await base.metadata()
    const side = Math.max(width, height)
    const background = await sharp(buffer).rotate().resize(side, side, { fit: 'cover' }).blur(30).toBuffer()
    const foreground = await base.resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    const padded = await sharp(background).composite([{ input: foreground }]).jpeg({ quality: 90 }).toBuffer()
    await ctx.sock.updateProfilePicture(myJid(msg), padded)
    await msg.reply('_Profile picture updated (full image)._')
  },
)

command(
  {
    name: 'setname',
    desc: 'Change your WhatsApp display name',
    usage: '<text>',
    category: 'user',
  },
  async (msg, args, ctx) => {
    if (!args) return msg.reply('_Usage: setname <new name>_')
    if (args.length > 25) return msg.reply('_Names can be at most 25 characters._')
    await ctx.sock.updateProfileName(args)
    await msg.reply(`✅ Name updated to *${args}*`)
  },
)

command(
  {
    name: 'setbio',
    desc: 'Change your WhatsApp about / bio',
    usage: '<text>',
    category: 'user',
  },
  async (msg, args, ctx) => {
    const bio = args || msg.quoted?.text || ''
    if (!bio) return msg.reply('_Usage: setbio <text>_')
    if (bio.length > 139) return msg.reply('_About text can be at most 139 characters._')
    await ctx.sock.updateProfileStatus(bio)
    await msg.reply('✅ About updated')
  },
)

command(
  {
    name: 'online',
    desc: 'Keep your account always online (or not)',
    usage: 'on | off',
    category: 'whatsapp',
  },
  async (msg, args, ctx) => {
    const value = args.toLowerCase()
    if (!['on', 'off'].includes(value)) return msg.reply(`_Usage: online on | off (currently ${vars.bool('ALWAYS_ONLINE') ? 'on' : 'off'})_`)
    const on = value === 'on'
    vars.set('ALWAYS_ONLINE', String(on))
    await ctx.sock.sendPresenceUpdate(on ? 'available' : 'unavailable').catch(() => {})
    await msg.reply(`✅ Always online is now *${value}*`)
  },
)
