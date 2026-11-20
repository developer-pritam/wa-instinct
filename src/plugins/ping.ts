import { command } from '../core/index.js'

command(
  {
    name: 'ping',
    desc: 'Check the bot response time',
    category: 'misc',
    public: true,
  },
  async (msg) => {
    const start = Date.now()
    const sent = await msg.reply('_Pinging..._')
    const latency = Date.now() - start
    if (sent?.key) await msg.edit(`*Pong!* ${latency}ms`, sent.key)
    else await msg.reply(`*Pong!* ${latency}ms`)
  },
)
