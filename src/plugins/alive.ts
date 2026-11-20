import { command, config, platform, ramUsage, uptime, vars } from '../core/index.js'

const DEFAULT = "I'm here and ready! 🚀\nUptime : &uptime"
const PLACEHOLDERS = '&user, &uptime, &ram, &version, &platform'

function render(template: string, user: string): string {
  return template
    .replace(/\\n/g, '\n')
    .replace(/&user/g, user)
    .replace(/&uptime/g, uptime())
    .replace(/&ram/g, ramUsage())
    .replace(/&version/g, config.version)
    .replace(/&platform/g, platform())
}

command(
  {
    name: 'alive',
    desc: 'Check the bot is up; sudo can set the message with alive <text>',
    usage: `[text | delete]  (placeholders: ${PLACEHOLDERS})`,
    category: 'misc',
    public: true,
  },
  async (msg, args) => {
    if (args && msg.isSudo) {
      if (args.toLowerCase() === 'delete') {
        vars.del('ALIVE_MESSAGE')
        return msg.reply('_Alive message reset to default._')
      }
      vars.set('ALIVE_MESSAGE', args)
      return msg.reply(`✅ Alive message updated.\n_Placeholders: ${PLACEHOLDERS}_`)
    }
    const template = vars.get('ALIVE_MESSAGE') || DEFAULT
    await msg.reply(render(template, msg.pushName || 'there'))
  },
)
