import pino from 'pino'
import { config } from '../config.js'

const transport = pino.transport({
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
})

/** Application logger. */
export const logger = pino({ level: config.logLevel }, transport)

/** Separate (usually silent) logger handed to Baileys. */
export const baileysLogger = pino({ level: config.baileysLogLevel }, transport)

// libsignal (Baileys' crypto dependency) prints session-rotation noise with console.info/warn
// and there's no logger hook for it. Drop just those messages.
const NOISE = [
  /^Closing (open )?session/,
  /^Decrypted message with closed session/,
  /^Removing old closed session/,
  // a peer sent something for a session we don't have (common right after linking);
  // Baileys requests a retry and the sender re-encrypts, so this is recoverable noise
  /^Failed to decrypt message with any known session/,
  /^Session error:/,
]
for (const level of ['info', 'warn', 'log', 'error'] as const) {
  const original = console[level]
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && NOISE.some((re) => re.test(args[0] as string))) return
    original(...args)
  }
}
