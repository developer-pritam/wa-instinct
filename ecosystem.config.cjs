// pm2 keeps nodemon alive; nodemon restarts the bot when src/ or .env change.
//   pm2 start ecosystem.config.cjs && pm2 save
// Bot restarts (`.restart`, crashes) go through nodemon's `.restart` trigger file, see nodemon.json.
const path = require('node:path')
const os = require('node:os')

// Baileys 7 needs Node 22; pm2 itself may run on an older system node, so pin it here.
const NODE_BIN = "/usr/bin" // new VM: system Node 24

module.exports = {
  apps: [
    {
      name: 'wa-instinct',
      cwd: __dirname,
      script: 'node_modules/nodemon/bin/nodemon.js',
      interpreter: path.join(NODE_BIN, 'node'),
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 8000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        // nodemon.json runs tsx with this exact binary (PATH can be replaced by `pm2 restart --update-env`)
        WA_NODE: path.join(NODE_BIN, 'node'),
      },
    },
  ],
}
