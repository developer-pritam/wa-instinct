import { command, commands, config, findCommand, mono, padIndex, platform, ramUsage, smallcaps, uptime, vars, type Command } from '../core/index.js'

const visible = () => commands.filter((c) => !c.hidden).sort((a, b) => a.name.localeCompare(b.name))
const disabled = () => new Set(vars.get('DISABLED_COMMANDS').split(',').map((s) => s.trim()).filter(Boolean))

function header(user: string): string {
  const now = new Date()
  const tz = process.env.TZ ?? 'Asia/Kolkata'
  const rows: [string, string][] = [
    ['Prefix', config.prefix || '(none)'],
    ['User', user],
    ['Time', now.toLocaleTimeString('en-IN', { timeZone: tz })],
    ['Date', now.toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })],
    ['Version', config.version],
    ['Commands', String(visible().length)],
    ['RAM', ramUsage()],
    ['Uptime', uptime()],
    ['Platform', platform()],
  ]
  return ['```╭───── ' + config.botName.toUpperCase() + ' ─────', ...rows.map(([k, v]) => `│ ${k.padEnd(9)}: ${v}`), '╰' + '─'.repeat(24) + '```'].join('\n')
}

command(
  {
    name: 'menu',
    aliases: ['help'],
    desc: 'List all commands grouped by category, or one category',
    usage: '[category]',
    category: 'bot',
    public: true,
  },
  async (msg, args) => {
    const off = disabled()
    const groups = new Map<string, Command[]>()
    for (const c of visible()) {
      const list = groups.get(c.category) ?? []
      list.push(c)
      groups.set(c.category, list)
    }

    const want = args.trim().toLowerCase()
    const categories = [...groups.keys()].sort().filter((cat) => !want || cat === want)
    if (!categories.length) return msg.reply(`No category *${want}*. Try: ${[...groups.keys()].sort().join(', ')}`)

    let out = header(msg.pushName || 'you') + '\n\n'
    for (const cat of categories) {
      out += ` ╭─❏ ${smallcaps(cat)} ❏\n`
      for (const c of groups.get(cat)!) out += ` │ ${mono(c.name.toUpperCase())}${off.has(c.name) ? ' [off]' : ''}\n`
      out += ' ╰─────────────────\n'
    }
    await msg.reply(out.trimEnd())
  },
)

command(
  {
    name: 'list',
    desc: 'Every command with its description',
    category: 'bot',
    public: true,
  },
  async (msg) => {
    const lines = visible().map((c, i) => {
      const usage = c.usage ? ` ${c.usage}` : ''
      const aliases = c.aliases?.length ? ` _(${c.aliases.join(', ')})_` : ''
      return `${i + 1}.${padIndex(i + 1, commands.length)}*${config.prefix[0] ?? ''}${c.name}*${usage}${aliases}\n${c.desc ?? ''}`
    })
    await msg.reply(lines.join('\n\n'))
  },
)

command(
  {
    name: 'cmd',
    desc: 'Describe a single command',
    usage: '<name>',
    category: 'bot',
    public: true,
  },
  async (msg, args) => {
    const c = findCommand(args.trim())
    if (!c) return msg.reply('_Unknown command._')
    const flags = [c.groupOnly && 'group only', c.botAdmin && 'needs bot admin', c.public ? 'public' : 'sudo only'].filter(Boolean)
    await msg.reply(
      `*${config.prefix[0] ?? ''}${c.name}* ${c.usage ?? ''}\n${c.desc ?? ''}\n\n` +
        `Category: ${c.category}\nAliases: ${c.aliases?.join(', ') || '-'}\n${flags.join(' · ')}\nPlugin: ${c.plugin}`,
    )
  },
)
