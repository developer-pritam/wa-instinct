import { command, config, jid, on } from '../core/index.js'

interface Vote {
  question: string
  options: string[]
  /** voter (phone-number jid) → option index */
  votes: Map<string, number>
  startedBy: string
}

const votes = new Map<string, Vote>()

const tag = (user: string) => `@${jid.toNumber(user)}`
const isCommandText = (text: string) => {
  const first = text.trim()[0]
  return !!first && config.prefix.includes(first)
}

function render(vote: Vote, final = false): string {
  const counts = vote.options.map(() => 0)
  for (const i of vote.votes.values()) counts[i]++
  const total = vote.votes.size
  const lines = vote.options.map((opt, i) => {
    const n = counts[i]
    const bar = total ? '▰'.repeat(Math.round((n / total) * 10)).padEnd(10, '▱') : '▱'.repeat(10)
    return `${i + 1}. ${opt}\n   ${bar} ${n}`
  })
  return [
    `📊 *${vote.question}*${final ? ' _(closed)_' : ''}`,
    '',
    ...lines,
    '',
    `Total votes: *${total}*`,
    final ? '' : '_Send the option number to vote._',
  ]
    .join('\n')
    .trimEnd()
}

command(
  {
    name: 'vote',
    desc: 'Start a vote in this group; members vote by sending the option number',
    usage: '<question>|<option1>|<option2>... | results | end',
    category: 'group',
    groupOnly: true,
  },
  async (msg, args) => {
    const sub = args.trim().toLowerCase()
    const current = votes.get(msg.chat)

    if (sub === 'results') {
      if (!current) return msg.reply('_No vote is running here._')
      return msg.reply(render(current))
    }
    if (sub === 'end') {
      if (!current) return msg.reply('_No vote is running here._')
      votes.delete(msg.chat)
      return msg.reply(render(current, true))
    }

    const parts = args.split('|').map((s) => s.trim()).filter(Boolean)
    if (parts.length < 3) return msg.reply('_Usage: vote <question>|<option1>|<option2>... · vote results · vote end_')
    if (current) return msg.reply('_A vote is already running here. Use *vote end* to close it first._')

    const [question, ...options] = parts
    if (options.length > 20) return msg.reply('_At most 20 options._')
    const vote: Vote = { question, options, votes: new Map(), startedBy: msg.sender }
    votes.set(msg.chat, vote)
    await msg.send(render(vote))
  },
)

// Votes come in as a bare option number. No fromMe filter so the bot owner can vote too.
on(
  'text',
  async (msg) => {
    const vote = votes.get(msg.chat)
    if (!vote) return
    const text = msg.text.trim()
    if (!/^\d{1,2}$/.test(text) || isCommandText(text)) return
    const index = Number(text) - 1
    if (index < 0 || index >= vote.options.length) return

    const voter = msg.sender
    if (vote.votes.has(voter)) return msg.reply('_You have already voted._')
    vote.votes.set(voter, index)
    await msg.reply(`${tag(voter)} voted for *${vote.options[index]}*\n\n${render(vote)}`, { mentions: [voter] })
  },
  { groupOnly: true, name: 'vote' },
)
