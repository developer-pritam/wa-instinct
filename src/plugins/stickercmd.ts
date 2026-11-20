import { command, config, findCommand, stickerCommands } from '../core/index.js'

/** Bound stickers are resolved by the dispatcher: sending the sticker runs the command. */

command(
  {
    name: 'setcmd',
    desc: 'Bind a command to a sticker (send the sticker to run it)',
    usage: '<command> <reply to sticker>',
    category: 'misc',
  },
  async (msg, args) => {
    if (!msg.quoted?.isSticker) return msg.reply('_Reply to a sticker._')
    if (!args) return msg.reply('_Usage: setcmd ping (reply to a sticker)_')
    const name = args.replace(/^[^\w]/, '').trim()
    const [cmdName] = name.split(/\s+/)
    if (!findCommand(cmdName)) return msg.reply(`_No command named ${cmdName}._`)
    const hash = msg.quoted.mediaHash
    if (!hash) return msg.reply("_Couldn't read that sticker's id._")
    stickerCommands.set(hash, name)
    await msg.reply(`✅ Sticker now runs *${config.prefix[0] ?? ''}${name}*`)
  },
)

command(
  {
    name: 'delcmd',
    desc: 'Unbind a sticker command by name or by replying to the sticker',
    usage: '<command> | <reply to sticker>',
    category: 'misc',
  },
  async (msg, args) => {
    if (msg.quoted?.isSticker && msg.quoted.mediaHash) {
      const ok = stickerCommands.delByHash(msg.quoted.mediaHash)
      return msg.reply(ok ? '🗑️ _Sticker command removed._' : '_That sticker has no command bound._')
    }
    if (!args) return msg.reply('_Usage: delcmd <command> | reply to a sticker_')
    const name = args.replace(/^[^\w]/, '').trim()
    const ok = stickerCommands.delByCmd(name)
    await msg.reply(ok ? `🗑️ _Removed sticker binding for ${name}._` : `_No sticker is bound to ${name}._`)
  },
)

command(
  {
    name: 'getcmd',
    desc: 'List sticker-bound commands',
    category: 'misc',
  },
  async (msg) => {
    const all = stickerCommands.all()
    if (!all.length) return msg.reply('_No sticker commands set._')
    const lines = all.map((s, i) => `${i + 1}. ${s.cmd}  _(${s.hash.slice(0, 8)}…)_`)
    await msg.reply(`*Sticker commands*\n${lines.join('\n')}`)
  },
)
