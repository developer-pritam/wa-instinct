import type { WAMessage } from 'baileys'
import { command, jid, onOff, sleep, vars } from '../core/index.js'

const lastMessages = (m: WAMessage) => [{ key: m.key, messageTimestamp: m.messageTimestamp }]

// ---------- messages ----------

command(
  {
    name: 'dlt',
    aliases: ['del'],
    desc: 'Delete the message you replied to',
    usage: '<reply>',
    category: 'whatsapp',
  },
  async (msg) => {
    if (!msg.quoted) return msg.reply('_Reply to a message._')
    if (!msg.quoted.fromMe && msg.isGroup && !(await msg.isBotAdmin())) return msg.reply("_I'm not an admin here._")
    await msg.delete(msg.quoted.key)
  },
)

command(
  {
    name: 'react',
    desc: 'React to the message you replied to',
    usage: '<emoji> <reply>',
    category: 'whatsapp',
  },
  async (msg, args) => {
    if (!args || !msg.quoted) return msg.reply('_Usage: react ❤️ (reply to a message)_')
    await msg.react(args.trim(), msg.quoted.key)
  },
)

command(
  {
    name: 'unreact',
    desc: 'Remove your reaction from the message you replied to',
    usage: '<reply>',
    category: 'whatsapp',
  },
  async (msg) => {
    if (!msg.quoted) return msg.reply('_Reply to a message._')
    await msg.react('', msg.quoted.key)
  },
)

command(
  {
    name: 'poll',
    desc: 'Create a poll',
    usage: '<question>,<option1>,<option2>[,...] [multi]',
    category: 'whatsapp',
  },
  async (msg, args) => {
    let multi = false
    let text = args
    if (/\bmulti\s*$/i.test(text)) {
      multi = true
      text = text.replace(/\bmulti\s*$/i, '')
    }
    const [name, ...values] = text.split(',').map((s) => s.trim()).filter(Boolean)
    if (!name || values.length < 2) return msg.reply('_Usage: poll question,option1,option2,... [multi]_')
    // selectableCount 0 lets voters pick more than one option
    await msg.send({ poll: { name, values, selectableCount: multi ? 0 : 1 } })
  },
)

command(
  {
    name: 'forward',
    aliases: ['fwd'],
    desc: 'Forward the replied message to one or more chats',
    usage: '<jid|number,...> <reply>',
    category: 'whatsapp',
  },
  async (msg, args) => {
    if (!msg.quoted) return msg.reply('_Reply to a message._')
    const targets = jid.parseJids(args)
    if (!targets.length) return msg.reply('_Usage: forward 919876543210, 1234-5678@g.us (reply to a message)_')
    for (const [i, target] of targets.entries()) {
      await msg.forward(target)
      if (i < targets.length - 1) await sleep(1000)
    }
    await msg.reply(`✅ Forwarded to ${targets.length} chat${targets.length > 1 ? 's' : ''}`)
  },
)

command(
  {
    name: 'save',
    desc: 'Save the replied message to your own chat',
    usage: '<reply>',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    if (!msg.quoted) return msg.reply('_Reply to a message._')
    await msg.forward(jid.normalize(ctx.sock.user?.id))
    await msg.reply('💾 _Saved._')
  },
)

command(
  {
    name: 'edit',
    desc: 'Edit a message you sent',
    usage: '<new text> <reply>',
    category: 'whatsapp',
  },
  async (msg, args) => {
    if (!args || !msg.quoted) return msg.reply('_Usage: edit new text (reply to your message)_')
    if (!msg.quoted.fromMe) return msg.reply('_I can only edit my own messages._')
    await msg.edit(args, msg.quoted.key)
  },
)

// ---------- chat actions (app-state sync) ----------

command(
  {
    name: 'clear',
    desc: 'Clear all messages in this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ clear: true, lastMessages: lastMessages(msg.raw) }, msg.chat)
    await msg.send('_Chat cleared._')
  },
)

command(
  {
    name: 'archive',
    desc: 'Archive this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ archive: true, lastMessages: lastMessages(msg.raw) }, msg.chat)
    await msg.reply('_Archived._')
  },
)

command(
  {
    name: 'unarchive',
    desc: 'Unarchive this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ archive: false, lastMessages: lastMessages(msg.raw) }, msg.chat)
    await msg.reply('_Unarchived._')
  },
)

command(
  {
    // not "pin": download.ts already uses that as a pinterest alias
    name: 'pinchat',
    desc: 'Pin this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ pin: true }, msg.chat)
    await msg.reply('📌 _Pinned._')
  },
)

command(
  {
    name: 'unpinchat',
    desc: 'Unpin this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ pin: false }, msg.chat)
    await msg.reply('_Unpinned._')
  },
)

command(
  {
    name: 'mutechat',
    desc: 'Mute this chat for some hours (default 8)',
    usage: '[hours]',
    category: 'whatsapp',
  },
  async (msg, args, ctx) => {
    const hours = args ? Number(args) : 8
    if (!Number.isFinite(hours) || hours <= 0) return msg.reply('_Usage: mutechat <hours>_')
    await ctx.sock.chatModify({ mute: Date.now() + hours * 60 * 60 * 1000 }, msg.chat)
    await msg.reply(`🔇 _Muted for ${hours}h._`)
  },
)

command(
  {
    name: 'unmutechat',
    desc: 'Unmute this chat',
    category: 'whatsapp',
  },
  async (msg, _args, ctx) => {
    await ctx.sock.chatModify({ mute: null }, msg.chat)
    await msg.reply('🔊 _Unmuted._')
  },
)

// ---------- auto behaviours (vars only; enforced by the dispatcher) ----------

const READ_USAGE = [
  '_Usage: read on | off | p | g | <jid,...> [ignore <jid,...>]_',
  '_p = personal chats, g = groups. e.g. `read g ignore 123@g.us`_',
].join('\n')

/** "p g 123@g.us ignore 456@g.us" → the normalized AUTO_READ value, or undefined if invalid. */
function parseReadValue(input: string): string | undefined {
  const text = input.trim().toLowerCase()
  if (['on', 'true'].includes(text)) return 'true'
  if (['off', 'false'].includes(text)) return 'false'
  const [includePart, ...ignoreParts] = text.split(/\bignore\b/)
  const hasIgnore = ignoreParts.length > 0
  const ignored = hasIgnore ? jid.parseJids(ignoreParts.join(' ')) : []
  if (hasIgnore && !ignored.length) return undefined
  const include: string[] = []
  for (const token of includePart.split(/[\s,]+/).filter(Boolean)) {
    if (token === 'p' || token === 'g') include.push(token)
    else {
      const [j] = jid.parseJids(token)
      if (!j) return undefined
      include.push(j)
    }
  }
  if (!include.length && !hasIgnore) return undefined
  return [include.join(','), hasIgnore ? `ignore ${ignored.join(',')}` : ''].filter(Boolean).join(' ')
}

command(
  {
    name: 'read',
    desc: 'Auto-read incoming messages: all, personal (p), groups (g), specific jids, or ignore some',
    usage: 'on|off|p|g|<jids> [ignore <jids>]',
    category: 'whatsapp',
  },
  async (msg, args) => {
    if (!args) return msg.reply(`*AUTO_READ* = ${vars.get('AUTO_READ') || 'off'}\n${READ_USAGE}`)
    const value = parseReadValue(args)
    if (value === undefined) return msg.reply(READ_USAGE)
    vars.set('AUTO_READ', value)
    await msg.reply(`✅ *AUTO_READ* = ${value}`)
  },
)

function onOffCommand(name: string, key: string, desc: string) {
  command({ name, desc, usage: 'on|off', category: 'whatsapp' }, async (msg, args) => {
    const state = args.trim().toLowerCase()
    if (!['on', 'off'].includes(state)) return msg.reply(`*${key}* is ${onOff(vars.bool(key))}\n_Usage: ${name} on|off_`)
    vars.set(key, state === 'on' ? 'true' : 'false')
    await msg.reply(`✅ *${key}* = ${state}`)
  })
}
onOffCommand('status', 'AUTO_STATUS_VIEW', 'Automatically view status updates')
onOffCommand('call', 'REJECT_CALL', 'Automatically reject incoming calls')

// ---------- status ----------

command(
  {
    name: 'setstatus',
    desc: 'Post a WhatsApp status from text or a replied image/video',
    usage: '<text> | <reply to image/video> [all]',
    category: 'whatsapp',
  },
  async (msg, args, ctx) => {
    const toAll = /\ball\s*$/i.test(args)
    const text = args.replace(/\ball\s*$/i, '').trim()
    const q = msg.quoted

    let content: Parameters<typeof msg.send>[0]
    if (q?.isImage) content = { image: await q.download(), caption: text || q.text || undefined }
    else if (q?.isVideo) content = { video: await q.download(), caption: text || q.text || undefined }
    else if (text) content = { text }
    else if (q?.text) content = { text: q.text }
    else return msg.reply('_Usage: setstatus <text> | reply to an image/video. Add `all` to share with everyone in your groups._')

    // WhatsApp needs the list of recipients for a status; without contact sync the best we have are our groups' members
    let statusJidList: string[] = []
    if (toAll) {
      const groups = await ctx.sock.groupFetchAllParticipating()
      const set = new Set<string>()
      for (const g of Object.values(groups)) for (const p of g.participants) set.add(p.id)
      statusJidList = [...set]
    }
    await msg.send(content, { statusJidList, broadcast: true }, 'status@broadcast')
    await msg.reply(
      toAll
        ? `✅ _Status posted to ${statusJidList.length} contacts._`
        : '✅ _Status posted._\n_Note: without a recipient list it may be visible to few people — use `setstatus ... all` to share with everyone in your groups._',
    )
  },
)

// ---------- contact / location / lookup ----------

command(
  {
    name: 'vcard',
    aliases: ['contact'],
    desc: 'Send a contact card',
    usage: '<number>,<name>',
    category: 'whatsapp',
  },
  async (msg, args) => {
    const [numberPart, ...nameParts] = args.split(',')
    const number = (numberPart ?? '').replace(/\D/g, '')
    const name = nameParts.join(',').trim()
    if (!number || !name) return msg.reply('_Usage: vcard 919876543210,John Doe_')
    const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `TEL;type=CELL;type=VOICE;waid=${number}:+${number}`, 'END:VCARD'].join('\n')
    await msg.reply({ contacts: { displayName: name, contacts: [{ displayName: name, vcard }] } })
  },
)

command(
  {
    name: 'location',
    aliases: ['loc'],
    desc: 'Send a location',
    usage: '<lat>,<long>',
    category: 'whatsapp',
  },
  async (msg, args) => {
    const [lat, long] = args.split(',').map((s) => Number(s.trim()))
    if (!Number.isFinite(lat) || !Number.isFinite(long)) return msg.reply('_Usage: location 12.9716,77.5946_')
    await msg.reply({ location: { degreesLatitude: lat, degreesLongitude: long } })
  },
)

command(
  {
    name: 'ison',
    desc: 'Check whether a number is on WhatsApp',
    usage: '<number,...>',
    category: 'whatsapp',
  },
  async (msg, args, ctx) => {
    const numbers = jid.parseJids(args).filter((j) => jid.isUser(j)).map((j) => jid.toNumber(j))
    if (!numbers.length) return msg.reply('_Usage: ison 919876543210_')
    const results = (await ctx.sock.onWhatsApp(...numbers)) ?? []
    const lines = numbers.map((n) => {
      const hit = results.find((r) => jid.toNumber(r.jid) === n)
      return hit?.exists ? `✅ +${n} is on WhatsApp` : `❌ +${n} is not on WhatsApp`
    })
    await msg.reply(lines.join('\n'))
  },
)
