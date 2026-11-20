import { isJidStatusBroadcast, type WAMessage, type WASocket, proto } from 'baileys'
import { config } from '../config.js'
import { chatSettings, messageStore, msgStats, stickerCommands, vars } from './db.js'
import { getGroupMetadata, invalidateGroup, setGroupMetadata } from './groups.js'
import { isGroup, normalize } from './jid.js'
import { logger } from './logger.js'
import { Message } from './message.js'
import { commands, findCommand, listenersFor, type Command, type Context, type EventListener, type EventMap } from './registry.js'

const PREFIX_CHARS = new Set([...config.prefix])

/** Parse "<prefix>name rest" from text. Returns undefined if it's not a command. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const t = text.trim()
  if (!t) return undefined
  let body = t
  if (PREFIX_CHARS.size) {
    if (!PREFIX_CHARS.has(t[0])) return undefined
    body = t.slice(1).trimStart()
  }
  const m = body.match(/^([^\s]+)\s*([\s\S]*)$/)
  if (!m) return undefined
  return { name: m[1].toLowerCase(), args: m[2].trim() }
}

function listenerApplies(l: EventListener, msg: Message): boolean {
  const o = l.options
  if (o.fromMe !== undefined && o.fromMe !== msg.fromMe) return false
  if (o.groupOnly && !msg.isGroup) return false
  if (o.privateOnly && msg.isGroup) return false
  return true
}

async function runListeners<K extends keyof EventMap>(event: K, filter: (l: EventListener<K>) => boolean, ...args: Parameters<EventMap[K]>) {
  for (const l of listenersFor(event)) {
    if (!filter(l)) continue
    try {
      await (l.handler as (...a: Parameters<EventMap[K]>) => unknown)(...args)
    } catch (err) {
      logger.error({ err, plugin: l.plugin, event }, 'event listener failed')
    }
  }
}

/** AUTO_READ: "true" | "false" | "p,g,<jid>… [ignore <jid>…]" */
function shouldAutoRead(msg: Message): boolean {
  const raw = vars.get('AUTO_READ').toLowerCase().trim()
  if (!raw || raw === 'false' || raw === 'off') return false
  if (raw === 'true' || raw === 'on') return true
  const [includePart, ignorePart = ''] = raw.split(/\bignore\b/)
  const ignored = ignorePart.split(/[\s,]+/).filter(Boolean)
  if (ignored.some((j) => msg.chat.startsWith(j))) return false
  const include = includePart.split(/[\s,]+/).filter(Boolean)
  if (!include.length) return true // "ignore x" alone means read everything else
  return include.some((tok) => (tok === 'p' && !msg.isGroup) || (tok === 'g' && msg.isGroup) || msg.chat.startsWith(tok))
}

export function attachDispatcher(sock: WASocket): Context {
  const ctx: Context = { sock, commands }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'append' = history / offline backlog / our own sends; only live messages are dispatched
    if (type !== 'notify') return
    for (const raw of messages) {
      try {
        await handleIncoming(sock, ctx, raw)
      } catch (err) {
        logger.error({ err, id: raw.key.id }, 'failed handling message')
      }
    }
  })

  sock.ev.on('group-participants.update', async (update) => {
    invalidateGroup(update.id)
    try {
      const metadata = await getGroupMetadata(sock, update.id, true)
      await runListeners('group-update', () => true, {
        jid: update.id,
        // prefer phone-number jids; fall back to whatever form WhatsApp gave us (often a LID)
        participants: update.participants.map((p) => normalize(p.phoneNumber ?? p.id)),
        action: update.action,
        author: normalize(update.authorPn ?? update.author) || undefined,
        metadata,
      }, ctx)
    } catch (err) {
      logger.error({ err, update }, 'group update failed')
    }
  })

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) if (u.id) invalidateGroup(u.id)
  })
  sock.ev.on('groups.upsert', (groups) => {
    for (const g of groups) setGroupMetadata(g)
  })

  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer' && vars.bool('REJECT_CALL')) {
        await sock.rejectCall(call.id, call.from).catch((err) => logger.warn({ err }, 'reject call failed'))
      }
      await runListeners('call', () => true, call, ctx)
    }
  })

  return ctx
}

async function handleIncoming(sock: WASocket, ctx: Context, raw: WAMessage) {
  if (!raw.message || !raw.key.remoteJid) return

  // status updates: optionally auto-view, never dispatch
  if (isJidStatusBroadcast(raw.key.remoteJid)) {
    if (vars.bool('AUTO_STATUS_VIEW') && !raw.key.fromMe) await sock.readMessages([raw.key])
    return
  }

  // revokes & edits arrive as protocol messages
  const protocol = raw.message.protocolMessage
  if (protocol) return handleProtocol(sock, ctx, raw, protocol)

  const msg = await Message.from(sock, raw)

  if (msg.type !== 'reaction') messageStore.put(msg.id, msg.chat, msg.sender, raw)
  if (msg.isGroup && msg.type !== 'reaction') msgStats.record(msg.chat, msg.sender, msg.pushName || undefined, msg.type)
  if (!msg.fromMe && shouldAutoRead(msg)) await sock.readMessages([msg.key]).catch(() => {})

  await runListeners('message', (l) => listenerApplies(l, msg), msg, ctx)

  // anything that isn't a known command is ordinary text (so "..." or ".5" still reach filters/games)
  const cmd = resolveCommand(msg)
  const command = cmd && findCommand(cmd.name)
  if (!cmd || !command) {
    if (msg.text) await runListeners('text', (l) => listenerApplies(l, msg), msg, ctx)
    return
  }

  if (!isAllowed(msg, command.name, command.public)) return
  await executeCommand(msg, command, cmd.args, ctx)
}

export type CommandOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Run a command with the same checks and error handling as a typed one.
 * Used by the dispatcher and by the AI's run_command tool. Permission (sudo/allow) is the caller's job.
 */
export async function executeCommand(msg: Message, command: Command, args: string, ctx: Context, opts: { react?: boolean } = {}): Promise<CommandOutcome> {
  if (isDisabled(command.name)) return { ok: false, reason: 'command is disabled (tog)' }
  if (command.groupOnly && !msg.isGroup) {
    await msg.reply('_This command only works in groups._')
    return { ok: false, reason: 'only works in groups' }
  }
  if (command.botAdmin && !(await msg.isBotAdmin())) {
    await msg.reply("_I'm not an admin here._")
    return { ok: false, reason: 'the bot is not an admin in this group' }
  }

  logger.info({ cmd: command.name, args, chat: msg.chat, from: msg.sender }, 'command')
  // acknowledge the command with a reaction (CMD_REACT=false turns it off, or set another emoji)
  const ack = vars.get('CMD_REACT')
  if (opts.react !== false && ack && ack !== 'false') void msg.react(ack).catch(() => {})
  try {
    await command.handler(msg, args, ctx)
    return { ok: true }
  } catch (err) {
    const e = err as Error
    logger.error({ err, cmd: command.name }, 'command failed')
    if (msg.isSudo) await msg.reply(`❌ *${command.name}* failed:\n\`\`\`${e.message ?? String(err)}\`\`\``).catch(() => {})
    return { ok: false, reason: e.message ?? String(err) }
  }
}

/** A command can come from text or from a sticker bound with `.setcmd`. */
function resolveCommand(msg: Message): { name: string; args: string } | undefined {
  if (msg.text) return parseCommand(msg.text)
  if (msg.isSticker && msg.mediaHash) {
    const bound = stickerCommands.get(msg.mediaHash)
    if (bound) return parseCommand((config.prefix[0] ?? '') + bound)
  }
  return undefined
}

const isDisabled = (name: string) => vars.get('DISABLED_COMMANDS').split(',').map((s) => s.trim()).includes(name)

/** Sudo can run anything; others only public commands or ones allowed in this chat (`.allow`). */
function isAllowed(msg: Message, name: string, isPublic?: boolean): boolean {
  if (msg.isSudo || isPublic) return true
  const allowed = chatSettings.get<string[]>(msg.chat, 'allowed_commands', [])
  return allowed.includes(name)
}

async function handleProtocol(sock: WASocket, ctx: Context, raw: WAMessage, protocol: proto.Message.IProtocolMessage) {
  // prefer the phone-number form of whoever deleted/edited
  const by = normalize(raw.key.participantAlt ?? raw.key.participant ?? raw.key.remoteJidAlt ?? raw.key.remoteJid ?? '')
  const targetId = protocol.key?.id
  const stored = targetId ? messageStore.get<WAMessage>(targetId) : undefined
  const original = stored ? await Message.from(sock, stored) : undefined

  if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE && protocol.key) {
    await runListeners('message-delete', () => true, { key: protocol.key, original, by }, ctx)
  } else if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.key) {
    const edited = protocol.editedMessage
    const newText = edited?.conversation ?? edited?.extendedTextMessage?.text ?? edited?.imageMessage?.caption ?? edited?.videoMessage?.caption ?? ''
    await runListeners('message-edit', () => true, { original, newText, editKey: protocol.key, by }, ctx)
    // keep the store current so a later delete shows the edited text
    if (stored && edited && targetId) {
      messageStore.put(targetId, normalize(stored.key.remoteJid), original?.sender, { ...stored, message: edited })
    }
  }
}

export const isGroupJid = isGroup
