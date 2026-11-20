import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT_DIR } from '../config.js'

/**
 * Process restarts that work the same under nodemon, pm2 or a plain `npm start`.
 *
 * nodemon doesn't restart a child that exits by itself (it "waits for changes"), so we touch
 * `.restart.json`, a file nodemon watches. Exiting as well covers running without nodemon.
 * `.shutdown` tells nodemon's crash hook (nodemon.json) not to bring us back.
 */
const RESTART_FILE = path.join(ROOT_DIR, '.restart.json')
const SHUTDOWN_FILE = path.join(ROOT_DIR, '.shutdown')

/** Call once at start-up: a fresh start clears any earlier shutdown marker. */
export function clearShutdownMarker() {
  rmSync(SHUTDOWN_FILE, { force: true })
}

export function restartProcess(delayMs = 500) {
  writeFileSync(RESTART_FILE, String(Date.now()))
  setTimeout(() => process.exit(0), delayMs)
}

/** Stop and stay stopped until someone starts the bot again. */
export function stopProcess(code = 2, delayMs = 500) {
  writeFileSync(SHUTDOWN_FILE, String(Date.now()))
  setTimeout(() => process.exit(code), delayMs)
}
