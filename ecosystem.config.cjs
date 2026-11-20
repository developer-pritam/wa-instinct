// pm2 keeps nodemon alive; nodemon restarts the bot when src/ or .env change.
//   pm2 start ecosystem.config.cjs && pm2 save
// Bot restarts (`.restart`, crashes) go through nodemon's `.restart` trigger file, see nodemon.json.
const path = require('node:path')
const os = require('node:os')

// Baileys 7 needs Node 22+. Uses the Node that pm2 runs on; if pm2 runs on an older
// Node, set NODE_BIN to the folder of a Node 22+ binary when starting pm2.
const NODE_BIN = process.env.NODE_BIN || path.dirname(process.execPath)

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
