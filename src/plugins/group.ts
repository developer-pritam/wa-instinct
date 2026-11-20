import type { GroupMetadata, GroupParticipant } from 'baileys'
import { command, formatDate, invalidateGroup, jid, padIndex, sleep, type Message } from '../core/index.js'

const INVITE_RE = /chat\.whatsapp\.com\/(?:invite\/)?([0-9A-Za-z]{20,24})/i
const inviteCode = (text: string) => text.match(INVITE_RE)?.[1]

/** Users a command targets: every @mention, else the quoted sender. */
const targets = (msg: Message): string[] => (msg.mentions.length ? msg.mentions : msg.quoted ? [msg.quoted.sender] : [])

/** "@91xxx" for any jid form, resolving LIDs to phone numbers when known. */
const tag = async (msg: Message, user: string) => `@${jid.toNumber(await msg.jids.toPn(user))}`
const tags = (msg: Message, users: string[]) => Promise.all(users.map((u) => tag(msg, u)))

const isMe = (msg: Message, p: GroupParticipant) => {
  const me = msg.socket.user
  return jid.sameUser(p.id, me?.id) || jid.sameUser(p.id, me?.lid) || jid.sameUser(p.phoneNumber, me?.id) || jid.sameUser(p.lid, me?.lid)
}

const nonAdmins = (meta: GroupMetadata) => meta.participants.filter((p) => !jid.isParticipantAdmin(p))

/** Numbered "@number" list with mentions for every participant given. */
async function mentionList(msg: Message, parts: GroupParticipant[], numbered: boolean, mono = false) {
  const lines = parts.map((p, i) => `${numbered ? `${i + 1}.${padIndex(i + 1, parts.length)}` : ''}@${jid.participantNumber(p)}`)
  const text = lines.join('\n')
  return msg.send(mono ? '```' + text + '```' : text, { mentions: parts.map((p) => p.id) })
}

// ---------- members ----------

command(
  {
    name: 'kick',
    desc: 'Kick someone out of the group 🚪 ("kick all" removes every non-admin)',
    usage: '@user | reply | all',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args) => {
    const meta = await msg.groupMetadata(msg.chat, true)

    if (args.toLowerCase() === 'all') {
      const victims = nonAdmins(meta).filter((p) => !isMe(msg, p))
      if (!victims.length) return msg.reply('_No non-admin members to kick._')
      await msg.reply(`🧹 Cleaning house! Kicking all non-admins (${victims.length} members) in 10 seconds. Restart the bot to stop.`)
      await sleep(10_000)
      await msg.kick(victims.map((p) => p.id))
      return msg.reply(`_Removed ${victims.length} members._`)
    }

    const wanted = targets(msg)
    if (!wanted.length) return msg.reply("_Who's the target? Mention them or reply to their message. 🎯_")
    const users = wanted.filter((u) => !jid.isAdminIn(meta, u))
    if (!users.length) return msg.reply("_Can't touch this! They're an admin. 🛡️_")

    await msg.kick(users)
    await msg.replyMention(`🚪 Removed ${(await tags(msg, users)).join(', ')}`, users)
    if (msg.quoted) {
      // clean up the offending message too
      await sleep(3000)
      await msg.delete(msg.quoted.key).catch(() => {})
    }
  },
)

command(
  {
    name: 'add',
    desc: 'Add someone new to the group ➕ (sends an invite link privately when direct add is not allowed)',
    usage: '<number(s)> | reply',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args, ctx) => {
    const users = args ? jid.parseJids(args).filter((j) => jid.isUser(j)) : msg.quoted ? [msg.quoted.sender] : []
    if (!users.length) return msg.reply("_That number doesn't look right. Example: add 919876543210_")
    await msg.reply('> Heads up: adding unknown numbers might get the bot banned. Stay safe!')

    const results = await msg.add(users)
    const lines: string[] = []
    let inviteSent = false
    for (const r of results) {
      const user = jid.normalize(r.jid ?? '')
      const num = jid.toNumber(await msg.jids.toPn(user)) || '?'
      switch (r.status) {
        case '200':
          lines.push(`✅ ${num} added`)
          break
        case '403': {
          // privacy settings block direct adds → DM them the invite link instead
          const code = await ctx.sock.groupInviteCode(msg.chat).catch(() => undefined)
          const meta = await msg.groupMetadata()
          if (code && user) {
            await msg.send(`You're invited to *${meta.subject}* 📩\nhttps://chat.whatsapp.com/${code}`, {}, user).catch(() => {})
            inviteSent = true
            lines.push(`📩 ${num} couldn't be added directly, sent an invite link instead`)
          } else lines.push(`❌ ${num} couldn't be added (privacy settings)`)
          break
        }
        case '408':
          lines.push(`⏳ ${num} left recently, can't re-add yet`)
          break
        case '409':
          lines.push(`ℹ️ ${num} is already in the group`)
          break
        default:
          lines.push(`❌ ${num} failed (status ${r.status})`)
      }
    }
    if (results.some((r) => r.status === '200') || inviteSent) invalidateGroup(msg.chat)
    await msg.reply(lines.join('\n'))
  },
)

command(
  {
    name: 'promote',
    desc: 'Give someone the crown (admin) 👑',
    usage: '@user | reply',
    category: 'group',
    botAdmin: true,
  },
  async (msg) => {
    const wanted = targets(msg)
    if (!wanted.length) return msg.reply("_Who's getting the promotion? Mention them or reply. 👑_")
    const meta = await msg.groupMetadata(msg.chat, true)
    const users = wanted.filter((u) => !jid.isAdminIn(meta, u))
    if (!users.length) return msg.reply("_They're already a king/queen! (Already an admin) ✨_")
    await msg.promote(users)
    invalidateGroup(msg.chat)
    await msg.replyMention(`👑 ${(await tags(msg, users)).join(', ')} promoted to admin`, users)
  },
)

command(
  {
    name: 'demote',
    desc: 'Take away the crown (admin) 📉',
    usage: '@user | reply',
    category: 'group',
    botAdmin: true,
  },
  async (msg) => {
    const wanted = targets(msg)
    if (!wanted.length) return msg.reply("_Who's losing the crown? Mention them or reply. 📉_")
    const meta = await msg.groupMetadata(msg.chat, true)
    const users = wanted.filter((u) => jid.isAdminIn(meta, u))
    if (!users.length) return msg.reply("_Wait, they aren't even an admin! 😂_")
    await msg.demote(users)
    invalidateGroup(msg.chat)
    await msg.replyMention(`📉 ${(await tags(msg, users)).join(', ')} demoted`, users)
  },
)

// ---------- invite links ----------

command(
  {
    name: 'invite',
    desc: "Get the group's invite link 🔗",
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    const code = await ctx.sock.groupInviteCode(msg.chat)
    if (!code) return msg.reply("_Couldn't fetch the invite link._")
    await msg.reply(`Here's the group invite link: 🔗\nhttps://chat.whatsapp.com/${code}`)
  },
)

command(
  {
    name: 'revoke',
    desc: 'Reset the group invite link 🔄',
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    const code = await ctx.sock.groupRevokeInvite(msg.chat)
    await msg.reply(code ? `🔄 Invite link reset. New link:\nhttps://chat.whatsapp.com/${code}` : '🔄 Invite link reset.')
  },
)

command(
  {
    name: 'join',
    desc: 'Join a group with its invite link',
    usage: '<invite link> | reply',
    category: 'group',
  },
  async (msg, args, ctx) => {
    const code = inviteCode(args || msg.quoted?.text || '')
    if (!code) return msg.reply('_Please provide a valid WhatsApp group invite link._')
    const info = await ctx.sock.groupGetInviteInfo(code).catch(() => undefined)
    if (!info) return msg.reply('_Invalid or expired invite link._')
    if ((info.size ?? 0) >= 1024) return msg.reply('_The group is full and cannot accept new members._')
    const joined = await ctx.sock.groupAcceptInvite(code)
    await msg.reply(joined ? `✅ Joined *${info.subject}*` : `📨 Join request sent to *${info.subject}* (admin approval needed).`)
  },
)

command(
  {
    name: 'ginfo',
    desc: 'Show info about a group from its invite link',
    usage: '<invite link> | reply',
    category: 'group',
  },
  async (msg, args, ctx) => {
    const code = inviteCode(args || msg.quoted?.text || '')
    if (!code) return msg.reply('_Usage: ginfo <group invite link>_')
    const info = await ctx.sock.groupGetInviteInfo(code).catch(() => undefined)
    if (!info) return msg.reply('_Please provide a valid WhatsApp invite link._')
    const owner = info.ownerPn ?? info.owner
    const caption = [
      `*Name:* ${info.subject}`,
      `*Group ID:* ${info.id}`,
      `*Owner:* ${owner ? '+' + jid.toNumber(await msg.jids.toPn(owner)) : '-'}`,
      `*Members:* ${info.size ?? info.participants?.length ?? '?'}`,
      `*Created on:* ${info.creation ? formatDate(info.creation * 1000) : '-'}`,
      `*Description:* ${info.desc || '-'}`,
    ].join('\n')
    const pp = await ctx.sock.profilePictureUrl(info.id, 'image').catch(() => undefined)
    if (pp) return msg.sendFromUrl(pp, { caption, quoted: msg.raw }).catch(() => msg.reply(caption))
    await msg.reply(caption)
  },
)

// ---------- settings ----------

command(
  {
    name: 'mute',
    desc: 'Only admins can send messages 🤐 (optionally for N minutes)',
    usage: '[minutes]',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args, ctx) => {
    await ctx.sock.groupSettingUpdate(msg.chat, 'announcement')
    invalidateGroup(msg.chat)
    const minutes = parseFloat(args)
    if (!args || Number.isNaN(minutes) || minutes <= 0) return msg.reply('🤐 Group muted. Only admins can send messages now.')
    // setTimeout overflows past ~24.8 days and fires immediately; cap at a week
    if (minutes > 7 * 24 * 60) return msg.reply('_Muted. Timed mutes are capped at 7 days (10080 minutes) — run unmute manually._')
    await msg.reply(`🤫 Group muted for ${minutes} minute${minutes === 1 ? '' : 's'}.`)
    // auto-unmute without blocking the command pipeline
    setTimeout(() => {
      ctx.sock
        .groupSettingUpdate(msg.chat, 'not_announcement')
        .then(() => {
          invalidateGroup(msg.chat)
          return msg.send('🔓 Group unmuted. Everyone can send messages again.')
        })
        .catch(() => {})
    }, minutes * 60_000)
  },
)

command(
  {
    name: 'unmute',
    desc: 'Everyone can send messages again 🔓',
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    await ctx.sock.groupSettingUpdate(msg.chat, 'not_announcement')
    invalidateGroup(msg.chat)
    await msg.reply('🔓 Group unmuted. Everyone can send messages again.')
  },
)

command(
  {
    name: 'lock',
    desc: 'Only admins can edit the group info 🔒',
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    await ctx.sock.groupSettingUpdate(msg.chat, 'locked')
    invalidateGroup(msg.chat)
    await msg.reply('🔒 Group info locked. Only admins can edit it now.')
  },
)

command(
  {
    name: 'unlock',
    desc: 'Everyone can edit the group info 🔓',
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    await ctx.sock.groupSettingUpdate(msg.chat, 'unlocked')
    invalidateGroup(msg.chat)
    await msg.reply('🔓 Group info unlocked. Everyone can edit it now.')
  },
)

command(
  {
    name: 'gname',
    desc: 'Change the group name',
    usage: '<text>',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args, ctx) => {
    if (!args) return msg.reply('_Usage: gname <new name>_')
    await ctx.sock.groupUpdateSubject(msg.chat, args)
    invalidateGroup(msg.chat)
    await msg.reply(`✅ Group name updated to *${args}*`)
  },
)

command(
  {
    name: 'gdesc',
    desc: 'Change the group description',
    usage: '<text> | reply',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args, ctx) => {
    const desc = args || msg.quoted?.text || ''
    if (!desc) return msg.reply('_Usage: gdesc <new description>_')
    await ctx.sock.groupUpdateDescription(msg.chat, desc)
    invalidateGroup(msg.chat)
    await msg.reply('✅ Group description updated')
  },
)

command(
  {
    name: 'gpp',
    desc: 'Change the group icon from the replied image',
    usage: 'reply to an image',
    category: 'group',
    botAdmin: true,
  },
  async (msg, _args, ctx) => {
    if (!msg.quoted?.isImage) return msg.reply('_Reply to an image to set it as the group icon. 📸_')
    const buffer = await msg.quoted.download()
    await ctx.sock.updateProfilePicture(msg.chat, buffer)
    await msg.reply('_Group icon updated_')
  },
)

// ---------- mentions ----------

command(
  {
    name: 'tag',
    desc: 'Mention members: everyone, admins, non-admins, or a custom message / replied message',
    usage: 'all | admins | notadmins | <text> | reply',
    category: 'group',
    groupOnly: true,
  },
  async (msg, args) => {
    const meta = await msg.groupMetadata()
    const all = meta.participants
    const mode = args.toLowerCase().replace(/\s+/g, '')

    if (mode === 'all') return mentionList(msg, all, true, true)
    if (mode === 'admin' || mode === 'admins') return mentionList(msg, all.filter((p) => jid.isParticipantAdmin(p)), false)
    if (mode === 'notadmin' || mode === 'notadmins') return mentionList(msg, nonAdmins(meta), false)

    const mentions = all.map((p) => p.id)
    const text = args || msg.quoted?.text
    if (text) return msg.send(text, { mentions })
    if (!msg.quoted) return msg.reply('_Usage: tag all | admins | notadmins | <text> | reply to a message_')
    // media/other message without text: forward it with everyone mentioned
    return msg.send({ forward: msg.quoted.raw }, { mentions })
  },
)

command(
  {
    name: 'common',
    desc: 'List (or kick from this group) the non-admin members who are also in the given groups',
    usage: '<group jid(s)> [kick]',
    category: 'group',
    groupOnly: true,
  },
  async (msg, args) => {
    const kick = /\bkick\b/i.test(args)
    const others = jid.parseJids(args).filter((j) => jid.isGroup(j) && j !== msg.chat)
    if (!others.length) return msg.reply('_Usage: common <group jid> [jid2 ...] [kick]\nFind the jid of a group with gjid._')

    const here = await msg.groupMetadata(msg.chat, true)
    const metas: GroupMetadata[] = []
    for (const g of others) {
      const m = await msg.groupMetadata(g).catch(() => undefined)
      if (!m) return msg.reply(`_I'm not in ${g} (or couldn't fetch it)._`)
      metas.push(m)
    }

    const common = nonAdmins(here).filter(
      (p) => !isMe(msg, p) && metas.every((m) => jid.findParticipant(m, p.id) || (p.phoneNumber && jid.findParticipant(m, p.phoneNumber))),
    )
    if (!common.length) return msg.reply('_Found 0 common members._')

    if (kick) {
      if (!(await msg.isBotAdmin())) return msg.reply("_Oops! I'm not an admin here, so I can't kick anyone. 😅_")
      await msg.kick(common.map((p) => p.id))
      return msg.reply(`_Removed ${common.length} common member${common.length === 1 ? '' : 's'}._`)
    }
    await msg.reply(`*${common.length} common member${common.length === 1 ? '' : 's'}:*`)
    return mentionList(msg, common, true)
  },
)

command(
  {
    name: 'requests',
    desc: 'List pending join requests, or approve / reject them',
    usage: '[approve|reject all|@user|number]',
    category: 'group',
    botAdmin: true,
  },
  async (msg, args, ctx) => {
    const pending = await ctx.sock.groupRequestParticipantsList(msg.chat)
    const requesters = pending.map((r) => jid.normalize(r.jid ?? r.pn ?? r.lid ?? '')).filter(Boolean)
    const [action, ...rest] = args.toLowerCase().split(/\s+/)

    if (!action) {
      if (!requesters.length) return msg.reply('_No pending join requests._')
      const lines = await Promise.all(requesters.map(async (u, i) => `${i + 1}.${padIndex(i + 1, requesters.length)}${await tag(msg, u)}`))
      return msg.replyMention(`*Pending join requests (${requesters.length}):*\n${lines.join('\n')}`, requesters)
    }
    if (action !== 'approve' && action !== 'reject') return msg.reply('_Usage: requests [approve|reject all|@user|number]_')
    if (!requesters.length) return msg.reply('_No pending join requests._')

    let users: string[]
    if (rest[0] === 'all') users = requesters
    else {
      const wanted = [...msg.mentions, ...jid.parseJids(rest.join(' ')).filter((j) => jid.isUser(j))]
      if (!wanted.length) return msg.reply(`_Usage: requests ${action} all | @user | number_`)
      // match against the pending list across LID / phone-number forms
      const matched = await Promise.all(requesters.map(async (r) => ((await Promise.all(wanted.map((w) => msg.jids.same(r, w)))).some(Boolean) ? r : '')))
      users = matched.filter(Boolean)
      if (!users.length) return msg.reply('_None of those users have a pending request._')
    }

    const results = await ctx.sock.groupRequestParticipantsUpdate(msg.chat, users, action)
    const ok = results.filter((r) => r.status === '200').length
    if (ok) invalidateGroup(msg.chat)
    await msg.replyMention(`${action === 'approve' ? '✅ Approved' : '❌ Rejected'} ${ok}/${users.length}: ${(await tags(msg, users)).join(', ')}`, users)
  },
)

command(
  {
    name: 'left',
    desc: 'Leave this group (optional farewell text is sent first)',
    usage: '[text]',
    category: 'group',
    groupOnly: true,
  },
  async (msg, args, ctx) => {
    if (args) await msg.send(args)
    await ctx.sock.groupLeave(msg.chat)
    invalidateGroup(msg.chat)
  },
)
