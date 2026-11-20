import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROOT_DIR, command, config, jid, logger, on, ramUsage, sudo, uptime, vars, type Message } from '../core/index.js'
import { restartProcess, stopProcess } from '../core/lifecycle.js'

const exec = promisify(execFile)
let announced = false

// Tell yourself the bot is up, once per process start.
on('connected', async ({ sock }) => {
  if (announced || !sock.user?.id) return
  announced = true
  if (vars.get('STARTUP_MESSAGE') === 'false') return
  await sock
    .sendMessage(jid.normalize(sock.user.id), { text: `✅ *${config.botName}* v${config.version} is online\nPrefix: ${config.prefix || '(none)'} · type ${config.prefix[0] ?? ''}menu` })
    .catch((err) => logger.warn({ err }, 'startup message failed'))
})

command(
  {
    name: 'restart',
    aliases: ['reboot'],
    desc: 'Restart the bot process',
    category: 'bot',
  },
  async (msg) => {
    await msg.reply('_Restarting…_')
    restartProcess()
  },
)

command(
  {
    name: 'shutdown',
    desc: 'Stop the bot process',
    category: 'bot',
  },
  async (msg) => {
    await msg.reply('_Shutting down. Start me again from the VM._')
    stopProcess()
  },
)

command(
  {
    name: 'update',
    desc: 'git pull + npm install, then restart (only when the bot folder is a git repo)',
    usage: '[now]',
    category: 'bot',
  },
  async (msg, args) => {
    const git = (...a: string[]) => exec('git', a, { cwd: ROOT_DIR }).then((r) => r.stdout.trim())
    try {
      await git('rev-parse', '--is-inside-work-tree')
    } catch {
      return msg.reply('_Not a git repository, nothing to update._')
    }
    await git('fetch')
    const behind = await git('log', '--oneline', 'HEAD..@{u}')
    if (!behind) return msg.reply('_Already up to date._')
    if (args.trim() !== 'now') return msg.reply(`*Updates available:*\n\`\`\`${behind}\`\`\`\n_Run ${config.prefix[0] ?? ''}update now to apply._`)
    await msg.reply('_Updating…_')
    await git('pull', '--ff-only')
    await exec('npm', ['install', '--omit=dev'], { cwd: ROOT_DIR })
    await msg.reply('_Updated. Restarting…_')
    restartProcess()
  },
)

command(
  {
    name: 'uptime',
    desc: 'Uptime and memory',
    category: 'bot',
    public: true,
  },
  async (msg) => {
    await msg.reply(`⏱️ ${uptime()}\n💾 ${ramUsage()}`)
  },
)

command(
  {
    name: 'sudo',
    aliases: ['getsudo'],
    desc: 'List who can run every command besides you',
    category: 'bot',
  },
  async (msg) => {
    const list = sudo.list()
    if (!list.length) return msg.reply('_No sudo users; only your own account. Add one with setsudo @user._')
    await msg.reply(`*Sudo users*\n${list.map((n, i) => `${i + 1}. @${n}`).join('\n')}`, {
      mentions: list.map((n) => `${n}@s.whatsapp.net`),
    })
  },
)

/** The user a sudo command is about: @mention, replied-to sender, or a number in the text. Phone-number form when known. */
async function sudoTarget(msg: Message, args: string): Promise<string | undefined> {
  const target = msg.targetUser ?? jid.parseJids(args)[0]
  return target ? jid.toNumber(await msg.jids.toPn(target)) : undefined
}

command(
  {
    name: 'setsudo',
    aliases: ['addsudo'],
    desc: 'Let someone run every command (works in any chat)',
    usage: '<@user | reply | number>',
    category: 'bot',
  },
  async (msg, args) => {
    const number = await sudoTarget(msg, args)
    if (!number) return msg.reply('_Usage: setsudo @user · or reply to their message · or setsudo 9198xxxxxxxx_')
    if (number === jid.toNumber(msg.socket.user?.id)) return msg.reply("_That's you; you always have full access._")
    if (sudo.has(number)) return msg.reply(`_@${number} is already sudo._`, { mentions: [`${number}@s.whatsapp.net`] })
    sudo.add(number)
    await msg.reply(`✅ @${number} is now sudo and can run every command, in every chat.`, { mentions: [`${number}@s.whatsapp.net`] })
  },
)

command(
  {
    name: 'delsudo',
    aliases: ['rmsudo'],
    desc: 'Remove someone from sudo',
    usage: '<@user | reply | number>',
    category: 'bot',
  },
  async (msg, args) => {
    const number = await sudoTarget(msg, args)
    if (!number) return msg.reply('_Usage: delsudo @user · or reply to their message · or delsudo 9198xxxxxxxx_')
    if (!sudo.remove(number)) return msg.reply(`_@${number} isn't sudo._`, { mentions: [`${number}@s.whatsapp.net`] })
    await msg.reply(`🗑️ @${number} is no longer sudo.`, { mentions: [`${number}@s.whatsapp.net`] })
  },
)
