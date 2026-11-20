import type { WASocket, GroupMetadata, WACallEvent, ParticipantAction } from 'baileys'
import type { Message } from './message.js'

export type Category =
  | 'misc' | 'bot' | 'group' | 'whatsapp' | 'user' | 'sticker' | 'media' | 'audio' | 'video'
  | 'download' | 'search' | 'ai' | 'game' | 'schedule' | 'vars' | 'moderation' | 'fun' | 'document'

export interface CommandOptions {
  /** Primary trigger, e.g. "kick". */
  name: string
  aliases?: string[]
  desc?: string
  /** Short usage hint shown in help, e.g. "<@user|reply>". */
  usage?: string
  category: Category
  /** Only works inside groups. */
  groupOnly?: boolean
  /** Bot must be a group admin. Implies groupOnly. */
  botAdmin?: boolean
  /** Anyone can run it (default: only you / SUDO). */
  public?: boolean
  /** Hide from menus. */
  hidden?: boolean
}

export interface Context {
  sock: WASocket
  commands: Command[]
}

export type CommandHandler = (msg: Message, args: string, ctx: Context) => Promise<unknown> | unknown

export interface Command extends CommandOptions {
  handler: CommandHandler
  /** Set by the plugin loader. */
  plugin?: string
}

export interface GroupUpdate {
  jid: string
  participants: string[]
  action: ParticipantAction
  author?: string
  metadata: GroupMetadata
}

/** Events plugins can listen to. */
export interface EventMap {
  /** Every incoming message (including your own), after it has been wrapped. */
  message: (msg: Message, ctx: Context) => Promise<unknown> | unknown
  /** Only messages with text (not commands handled elsewhere). */
  text: (msg: Message, ctx: Context) => Promise<unknown> | unknown
  'group-update': (update: GroupUpdate, ctx: Context) => Promise<unknown> | unknown
  /** A message was revoked; `original` is the stored message if we have it. */
  'message-delete': (deleted: { key: Message['key']; original?: Message; by: string }, ctx: Context) => Promise<unknown> | unknown
  'message-edit': (edit: { original?: Message; newText: string; editKey: Message['key']; by: string }, ctx: Context) => Promise<unknown> | unknown
  call: (call: WACallEvent, ctx: Context) => Promise<unknown> | unknown
  connected: (ctx: Context) => Promise<unknown> | unknown
}

export interface EventOptions {
  /** Only fire for messages you sent (true) / others sent (false). Omit for both. */
  fromMe?: boolean
  /** Only fire in groups / only in private chats. */
  groupOnly?: boolean
  privateOnly?: boolean
  /** A label for logs. */
  name?: string
}

export interface EventListener<K extends keyof EventMap = keyof EventMap> {
  event: K
  handler: EventMap[K]
  options: EventOptions
  plugin?: string
}

export const commands: Command[] = []
export const listeners: EventListener[] = []

let currentPlugin: string | undefined
/** Called by the loader so registrations know which file they belong to. */
export const setCurrentPlugin = (name?: string) => (currentPlugin = name)

/** Register a command. Use this in every plugin file. */
export function command(opts: CommandOptions, handler: CommandHandler): void {
  if (opts.botAdmin) opts.groupOnly = true
  for (const trigger of [opts.name, ...(opts.aliases ?? [])]) {
    const exists = commands.find((c) => c.name === trigger || c.aliases?.includes(trigger))
    if (exists) throw new Error(`"${trigger}" in ${currentPlugin} clashes with command "${exists.name}" from ${exists.plugin}`)
  }
  commands.push({ ...opts, handler, plugin: currentPlugin })
}

/** Subscribe to an event. */
export function on<K extends keyof EventMap>(event: K, handler: EventMap[K], options: EventOptions = {}): void {
  listeners.push({ event, handler, options, plugin: currentPlugin } as EventListener)
}

/** Find a command by its name or alias. */
export function findCommand(name: string): Command | undefined {
  name = name.toLowerCase()
  return commands.find((c) => c.name === name || c.aliases?.includes(name))
}

export const listenersFor = <K extends keyof EventMap>(event: K) => listeners.filter((l) => l.event === event) as EventListener<K>[]
