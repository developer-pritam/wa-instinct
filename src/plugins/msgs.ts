import { command, formatDuration, jid, msgStats, padIndex, sleep, type MsgStat } from '../core/index.js'

const ago = (ts: number) => (ts ? `${formatDuration((Date.now() - ts) / 1000)} ago` : 'never')

function describe(stat: MsgStat): string {
  const types = Object.entries(stat.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `  ${type}: ${n}`)
    .join('\n')
  return `*@${jid.toNumber(stat.user)}*${stat.name ? ` (${stat.name})` : ''}\n*Total:* ${stat.total}\n${types}\n*Last seen:* ${ago(stat.last_at)}`
}

command(
  {
    name: 'msgs',
    desc: 'Message counts per member in this group, with a per-type breakdown and last seen',
    usage: '[@user|reply]',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg) => {
    const user = msg.targetUser
    if (user) {
      const stat = msgStats.get(msg.chat, await msg.jids.toPn(user))
      if (!stat) return msg.replyMention(`_No activity recorded for @${jid.toNumber(user)} yet._`, [user])
      return msg.replyMention(describe(stat), [stat.user])
    }
    const all = msgStats.all(msg.chat)
    if (!all.length) return msg.reply('_No activity recorded yet._')
    return msg.replyMention(all.map(describe).join('\n\n'), all.map((s) => s.user))
  },
)

command(
  {
    name: 'reset',
    desc: 'Reset message counts for a member or the whole group',
    usage: '@user|reply · all',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    if (args.trim().toLowerCase() === 'all') {
      msgStats.reset(msg.chat)
      return msg.reply("_Everyone's message counts deleted._")
    }
    const user = msg.targetUser
    if (!user) return msg.reply('_Usage: reset @user | reply · reset all_')
    const pn = await msg.jids.toPn(user)
    msgStats.reset(msg.chat, pn)
    return msg.replyMention(`_@${jid.toNumber(pn)} message counts deleted._`, [pn])
  },
)

command(
  {
    name: 'inactive',
    desc: 'List (or kick) members inactive for N days and/or with at most N messages; admins and the bot are skipped',
    usage: 'day <n> · total <n> · day <n> total <n> [kick]',
    category: 'moderation',
    groupOnly: true,
  },
  async (msg, args) => {
    const words = args.toLowerCase().split(/\s+/).filter(Boolean)
    const kick = words.includes('kick')
    let days: number | undefined
    let total: number | undefined
    for (let i = 0; i < words.length; i++) {
      const n = Number(words[i + 1])
      if (words[i] === 'day' && !Number.isNaN(n)) days = n
      if (words[i] === 'total' && !Number.isNaN(n)) total = n
    }
    if (days === undefined && total === undefined) {
      return msg.reply('_Usage: inactive day 10 · inactive total 100 · inactive day 7 total 150 kick_')
    }

    const meta = await msg.groupMetadata()
    const me = msg.socket.user
    const stats = msgStats.all(msg.chat)
    const now = Date.now()
    const DAY = 86_400_000
    const inactive: string[] = []

    for (const p of meta.participants) {
      if (jid.isParticipantAdmin(p)) continue
      if (jid.sameUser(p.id, me?.id) || jid.sameUser(p.id, me?.lid) || jid.sameUser(p.phoneNumber, me?.id)) continue
      const number = jid.participantNumber(p)
      // stats are keyed by the phone-number jid; match on the digits so LID/PN forms both work
      const stat = stats.find((s) => jid.toNumber(s.user) === number || jid.toNumber(s.user) === jid.toNumber(p.id))
      const lastAt = stat?.last_at ?? 0
      const count = stat?.total ?? 0
      const idle = days === undefined || (lastAt === 0 ? true : (now - lastAt) / DAY >= days)
      const quiet = total === undefined || count <= total
      if (idle && quiet) inactive.push(p.id)
    }

    if (!inactive.length) return msg.reply('_No inactive members found._')
    if (kick) {
      if (!(await msg.isBotAdmin())) return msg.reply("_I'm not an admin here, so I can't remove anyone._")
      await msg.reply(`_Removing ${inactive.length} inactive members in 7 seconds…_`)
      await sleep(7000)
      await msg.kick(inactive)
      return msg.reply(`_Removed ${inactive.length} inactive members._`)
    }
    const lines = inactive.map((id, i) => {
      const p = jid.findParticipant(meta, id)
      return `*${i + 1}.*${padIndex(i + 1, inactive.length)}@${p ? jid.participantNumber(p) : jid.toNumber(id)}`
    })
    return msg.replyMention(`_Total inactive: ${inactive.length}_\n${lines.join('\n')}`, inactive)
  },
)
