import type { WASocket } from 'baileys'
import { config } from './config.js'
import { runConnection } from './core/connection.js'
import { messageStore } from './core/db.js'
import { attachDispatcher } from './core/dispatcher.js'
import { clearShutdownMarker } from './core/lifecycle.js'
import { loadPlugins } from './core/loader.js'
import { logger } from './core/logger.js'
import { listenersFor } from './core/registry.js'
import { startScheduler } from './core/scheduler.js'

let currentSock: WASocket | undefined

async function main() {
  logger.info(`${config.botName} v${config.version} starting (node ${process.version})`)
  clearShutdownMarker()
  await loadPlugins()

  startScheduler(() => currentSock)
  setInterval(() => messageStore.prune(), 60 * 60 * 1000)

  await runConnection({
    onSocket(sock) {
      currentSock = sock
      attachDispatcher(sock)
    },
    async onOpen(sock) {
      for (const l of listenersFor('connected')) {
        try {
          await l.handler({ sock, commands: (await import('./core/registry.js')).commands })
        } catch (err) {
          logger.error({ err, plugin: l.plugin }, 'connected listener failed')
        }
      }
    },
  })
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'))

main().catch((err) => {
  logger.fatal({ err }, 'fatal error')
  process.exit(1)
})
