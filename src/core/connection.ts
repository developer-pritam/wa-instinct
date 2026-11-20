import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys'
import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import qrcode from 'qrcode-terminal'
import { rm } from 'node:fs/promises'
import { AUTH_DIR, config } from '../config.js'
import { messageStore, vars } from './db.js'
import { cachedGroupMetadata } from './groups.js'
import { baileysLogger, logger } from './logger.js'
import { stopProcess } from './lifecycle.js'
import { sleep } from './text.js'

export interface ConnectionHooks {
  /** A new socket was created (attach your event handlers here). */
  onSocket: (sock: WASocket) => void
  /** The socket is open and authenticated. */
  onOpen: (sock: WASocket) => Promise<void> | void
}

const msgRetryCounterCache = new NodeCache()

async function createSocket(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: vars.bool('ALWAYS_ONLINE'),
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache,
    cachedGroupMetadata: async (jid) => cachedGroupMetadata(jid),
    getMessage: async (key) => messageStore.get<WAMessage>(key.id ?? '')?.message ?? undefined,
  })

  sock.ev.on('creds.update', saveCreds)
  return sock
}

/**
 * Keeps the bot connected forever: creates a socket, waits for it to close,
 * decides whether to reconnect, and repeats. Handles QR / pairing-code login.
 */
export async function runConnection(hooks: ConnectionHooks): Promise<never> {
  let attempt = 0

  for (;;) {
    const sock = await createSocket()
    hooks.onSocket(sock)
    let pairingRequested = false

    const closed = new Promise<{ reconnect: boolean; reason?: number }>((resolve) => {
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && !sock.authState.creds.registered) {
          if (config.phoneNumber && !pairingRequested) {
            pairingRequested = true
            try {
              const code = await sock.requestPairingCode(config.phoneNumber)
              const pretty = code.match(/.{1,4}/g)?.join('-') ?? code
              logger.info(`\n\n   Pairing code: ${pretty}\n   WhatsApp → Linked devices → Link a device → Link with phone number instead\n`)
            } catch (err) {
              logger.error({ err }, 'pairing code request failed; falling back to QR')
              qrcode.generate(qr, { small: true })
            }
          } else if (!config.phoneNumber) {
            logger.info('Scan this QR with WhatsApp → Linked devices → Link a device')
            qrcode.generate(qr, { small: true })
          }
        }

        if (connection === 'open') {
          attempt = 0
          logger.info({ user: sock.user?.id, name: sock.user?.name }, `connected as ${sock.user?.name ?? sock.user?.id}`)
          try {
            await hooks.onOpen(sock)
          } catch (err) {
            logger.error({ err }, 'onOpen hook failed')
          }
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
          const label = Object.entries(DisconnectReason).find(([, v]) => v === reason)?.[0] ?? String(reason)
          logger.warn({ reason: label }, 'connection closed')

          if (reason === DisconnectReason.loggedOut) {
            logger.error('Logged out. Clearing auth; you will need to link again.')
            await rm(AUTH_DIR, { recursive: true, force: true })
            resolve({ reconnect: true, reason })
          } else {
            resolve({ reconnect: true, reason })
          }
        }
      })
    })

    const { reason } = await closed
    sock.ev.removeAllListeners('connection.update')
    sock.ws?.close?.()

    if (reason === DisconnectReason.restartRequired) {
      logger.info('restart required, reconnecting now')
      continue
    }
    if (reason === DisconnectReason.forbidden) {
      logger.fatal('WhatsApp refused this connection (403). Stopping.')
      stopProcess(1, 0)
      return new Promise<never>(() => {})
    }
    if (reason === DisconnectReason.connectionReplaced) {
      // another instance with the same session took over; don't fight it every few seconds
      logger.warn('connection replaced by another session; retrying in 5 minutes')
      await sleep(5 * 60_000)
      continue
    }
    attempt++
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5))
    logger.info(`reconnecting in ${delay / 1000}s (attempt ${attempt})`)
    await sleep(delay)
  }
}
