import { chatSettings, command, findCommand, vars } from '../core/index.js'

command(
  {
    name: 'setvar',
    desc: 'Set a runtime variable',
    usage: 'KEY=value',
    category: 'vars',
  },
  async (msg, args) => {
    const [key, ...rest] = args.split('=')
    if (!key || !rest.length) return msg.reply('_Usage: setvar KEY=value_')
    const value = rest.join('=').trim()
    vars.set(key.trim(), value)
    await msg.reply(`✅ *${key.trim().toUpperCase()}* = ${value}`)
  },
)

command(
  {
    name: 'getvar',
    desc: 'Show a runtime variable',
    usage: 'KEY',
    category: 'vars',
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: getvar KEY_')
    const value = vars.get(args)
    await msg.reply(value ? `*${args.toUpperCase()}* = ${value}` : `_${args.toUpperCase()} is not set._`)
  },
)

command(
  {
    name: 'delvar',
    desc: 'Delete a runtime variable (falls back to the .env default)',
    usage: 'KEY',
    category: 'vars',
  },
  async (msg, args) => {
    if (!args) return msg.reply('_Usage: delvar KEY_')
    vars.del(args)
    await msg.reply(`🗑️ *${args.toUpperCase()}* removed`)
  },
)

command(
  {
    name: 'allvar',
    desc: 'List every runtime variable',
    category: 'vars',
  },
  async (msg) => {
    const all = vars.all()
    const lines = Object.keys(all)
      .sort()
      .map((k) => `*${k}* = ${all[k] || '_(empty)_'}`)
    await msg.reply(lines.join('\n'))
  },
)

command(
  {
    name: 'tog',
    desc: 'Turn a command on or off',
    usage: '<command> on|off',
    category: 'bot',
  },
  async (msg, args) => {
    const [name, state] = args.toLowerCase().split(/\s+/)
    if (!name || !['on', 'off'].includes(state ?? '')) return msg.reply('_Usage: tog <command> on|off_')
    if (name === 'tog') return msg.reply("_Can't toggle tog itself._")
    if (!findCommand(name)) return msg.reply(`_No command named ${name}._`)
    const set = new Set(vars.get('DISABLED_COMMANDS').split(',').map((s) => s.trim()).filter(Boolean))
    if (state === 'off') set.add(name)
    else set.delete(name)
    vars.set('DISABLED_COMMANDS', [...set].join(','))
    await msg.reply(`*${name}* is now ${state}`)
  },
)

command(
  {
    name: 'allow',
    desc: 'Let everyone in this chat use specific commands',
    usage: '<command,...> | list | remove <command,...> | clear',
    category: 'bot',
  },
  async (msg, args) => {
    const key = 'allowed_commands'
    const current = chatSettings.get<string[]>(msg.chat, key, [])
    const [sub, ...rest] = args.toLowerCase().split(/\s+/)
    if (!sub) return msg.reply('_Usage: allow <cmd,cmd> · allow list · allow remove <cmd> · allow clear_')
    if (sub === 'list') return msg.reply(current.length ? `Allowed here: ${current.join(', ')}` : '_Nothing allowed for non-sudo users here._')
    if (sub === 'clear') {
      chatSettings.del(msg.chat, key)
      return msg.reply('_Cleared._')
    }
    if (sub === 'remove') {
      const remove = rest.join(' ').split(',').map((s) => s.trim())
      chatSettings.set(msg.chat, key, current.filter((c) => !remove.includes(c)))
      return msg.reply(`_Removed: ${remove.join(', ')}_`)
    }
    const names = args.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = names.filter((n) => !findCommand(n))
    if (unknown.length) return msg.reply(`_Unknown: ${unknown.join(', ')}_`)
    chatSettings.set(msg.chat, key, [...new Set([...current, ...names])])
    await msg.reply(`✅ Everyone here can now use: ${names.join(', ')}`)
  },
)
