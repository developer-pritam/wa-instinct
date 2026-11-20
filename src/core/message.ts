import {
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  type AnyMessageContent,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type ParticipantAction,
  proto,
} from 'baileys'
import { sudo } from './db.js'
import { getGroupMetadata } from './groups.js'
import { JidResolver, findParticipant, isGroup, isLid, isParticipantAdmin, normalize, sameUser, toNumber, toParticipantIds } from './jid.js'
import { baileysLogger } from './logger.js'
import { writeTmp } from './media.js'

export type MessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'sticker' | 'document' | 'contact' | 'location'
  | 'poll' | 'reaction' | 'protocol' | 'other'

const TYPE_BY_CONTENT: Partial<Record<keyof proto.IMessage, MessageType>> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  reactionMessage: 'reaction',
  protocolMessage: 'protocol',
}

type MediaProto =
  | proto.Message.IImageMessage | proto.Message.IVideoMessage | proto.Message.IAudioMessage
  | proto.Message.IStickerMessage | proto.Message.IDocumentMessage

/** What you can pass to `reply()` / `send()`: plain text or any Baileys content. */
export type Sendable = string | AnyMessageContent

export interface SendOptions extends Omit<MiscMessageGenerationOptions, 'quoted'> {
  /** Users to @mention (any jid form). */
  mentions?: string[]
  /** Quote this message (default for `reply`). Pass `false` to not quote. */
  quoted?: WAMessage | false
}

/**
 * Shared shape for an incoming message and for the message it quotes.
 * Everything here is synchronous and derived from the raw WAMessage.
 */
export class BaseMessage {
  readonly key: WAMessageKey
  readonly id: string
  readonly chat: string
  readonly isGroup: boolean
  readonly fromMe: boolean
  readonly content: proto.IMessage
  readonly contentType?: keyof proto.IMessage
  readonly type: MessageType
  /** Who sent it. Resolved to the phone-number jid when possible (see `Message.from`). */
  sender: string
  /** Sender's jid exactly as WhatsApp delivered it (may be a @lid). */
  readonly senderRaw: string
  readonly pushName: string
  readonly timestamp: number

  constructor(
    protected readonly sock: WASocket,
    readonly raw: WAMessage,
  ) {
    this.key = raw.key
    this.id = raw.key.id ?? ''
    this.isGroup = isGroup(raw.key.remoteJid)
    // private chats may arrive addressed by LID; keep one identity per person by preferring the phone-number form
    const pnChat = !this.isGroup && raw.key.remoteJidAlt && !isLid(raw.key.remoteJidAlt) ? raw.key.remoteJidAlt : undefined
    this.chat = normalize(pnChat ?? raw.key.remoteJid)
    this.fromMe = !!raw.key.fromMe
    this.content = normalizeMessageContent(raw.message) ?? {}
    this.contentType = getContentType(this.content)
    this.type = (this.contentType && TYPE_BY_CONTENT[this.contentType]) ?? (this.contentType ? 'other' : 'text')
    this.senderRaw = normalize(this.isGroup ? raw.key.participant ?? '' : raw.key.remoteJid ?? '')
    // participantAlt / remoteJidAlt carry the phone-number form when the main one is a LID
    const alt = this.isGroup ? raw.key.participantAlt : raw.key.remoteJidAlt
    this.sender = this.fromMe ? normalize(sock.user?.id) : normalize(alt ?? this.senderRaw)
    this.pushName = raw.pushName ?? ''
    this.timestamp = Number(raw.messageTimestamp ?? 0) * 1000
  }

  /** Message body or media caption. */
  get text(): string {
    const c = this.content
    return (
      c.conversation ??
      c.extendedTextMessage?.text ??
      c.imageMessage?.caption ??
      c.videoMessage?.caption ??
      c.documentMessage?.caption ??
      c.documentWithCaptionMessage?.message?.documentMessage?.caption ??
      ''
    )
  }

  get contextInfo(): proto.IContextInfo | undefined {
    const inner = this.contentType ? (this.content[this.contentType] as { contextInfo?: proto.IContextInfo } | undefined) : undefined
    return inner?.contextInfo ?? undefined
  }

  /** Jids @mentioned in the message. */
  get mentions(): string[] {
    return (this.contextInfo?.mentionedJid ?? []).map((j) => normalize(j))
  }

  get media(): MediaProto | undefined {
    const c = this.content
    return c.imageMessage ?? c.videoMessage ?? c.ptvMessage ?? c.audioMessage ?? c.stickerMessage ?? c.documentMessage ?? c.documentWithCaptionMessage?.message?.documentMessage ?? undefined
  }

  get mimetype(): string {
    return this.media?.mimetype ?? ''
  }
  get hasMedia(): boolean {
    return !!this.media
  }
  get isImage(): boolean {
    return this.type === 'image'
  }
  get isVideo(): boolean {
    return this.type === 'video'
  }
  get isAudio(): boolean {
    return this.type === 'audio'
  }
  get isSticker(): boolean {
    return this.type === 'sticker'
  }
  get isDocument(): boolean {
    return this.type === 'document'
  }
  get isAnimatedSticker(): boolean {
    return !!this.content.stickerMessage?.isAnimated
  }
  get isVoiceNote(): boolean {
    return !!this.content.audioMessage?.ptt
  }
  get isViewOnce(): boolean {
    return !!(this.content.imageMessage?.viewOnce || this.content.videoMessage?.viewOnce || this.content.audioMessage?.viewOnce)
  }
  get isGif(): boolean {
    return !!this.content.videoMessage?.gifPlayback
  }
  /** Hex sha256 of the media file (stable id for stickers). */
  get mediaHash(): string {
    const sha = this.media?.fileSha256
    return sha ? Buffer.from(sha).toString('hex') : ''
  }

  /** Download the media as a buffer. */
  async download(): Promise<Buffer> {
    if (!this.media) throw new Error('message has no media')
    return downloadMediaMessage(this.raw, 'buffer', {}, { logger: baileysLogger, reuploadRequest: this.sock.updateMediaMessage })
  }

  /** Download to tmp/ and return the file path. */
  async downloadToFile(ext?: string, sub = ''): Promise<string> {
    const buffer = await this.download()
    return writeTmp(buffer, ext ?? extFromMime(this.mimetype), sub)
  }

  /** "@919876543210" style text for mentioning this sender. */
  get mentionTag(): string {
    return `@${toNumber(this.sender)}`
  }
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg; codecs=opus': 'ogg', 'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'application/pdf': 'pdf',
  }
  return map[mime] ?? mime.split('/')[1]?.split(';')[0] ?? 'bin'
}

/** The message a message replies to. Built from contextInfo. */
export class Quoted extends BaseMessage {
  constructor(sock: WASocket, parent: Message, ctx: proto.IContextInfo) {
    const participant = normalize(ctx.participant ?? parent.chat)
    const me = sock.user
    const fromMe = sameUser(participant, me?.id) || sameUser(participant, me?.lid)
    const raw: WAMessage = {
      key: {
        remoteJid: parent.chat,
        id: ctx.stanzaId ?? undefined,
        fromMe,
        participant: parent.isGroup ? participant : undefined,
      },
      message: ctx.quotedMessage ?? undefined,
      messageTimestamp: parent.raw.messageTimestamp,
    }
    super(sock, raw)
    // for quoted messages in a private chat, the "sender" is the chat partner unless it's ours
    if (!parent.isGroup) this.sender = fromMe ? normalize(me?.id) : parent.chat
    else this.sender = participant
  }
}

/** A received message with everything a plugin needs to act on it. */
export class Message extends BaseMessage {
  readonly quoted?: Quoted
  /** True when the message came from you or a SUDO number. */
  isSudo = false
  readonly jids: JidResolver

  private constructor(sock: WASocket, raw: WAMessage) {
    super(sock, raw)
    this.jids = new JidResolver(sock)
    const ctx = this.contextInfo
    if (ctx?.quotedMessage) this.quoted = new Quoted(sock, this, ctx)
  }

  /** Build a Message, resolving the sender's phone number and sudo status. */
  static async from(sock: WASocket, raw: WAMessage): Promise<Message> {
    const msg = new Message(sock, raw)
    msg.sender = await msg.jids.toPn(msg.sender)
    if (msg.quoted) msg.quoted.sender = await msg.jids.toPn(msg.quoted.sender)
    const myNumber = toNumber(sock.user?.id)
    msg.isSudo = msg.fromMe || toNumber(msg.sender) === myNumber || sudo.has(toNumber(msg.sender))
    return msg
  }

  get socket(): WASocket {
    return this.sock
  }

  /** The user this command targets: first @mention, else the quoted sender, else undefined. */
  get targetUser(): string | undefined {
    return this.mentions[0] ?? this.quoted?.sender
  }

  // ---------- sending ----------

  /** Send to the current chat, quoting this message by default. */
  reply(content: Sendable, opts: SendOptions = {}): Promise<WAMessage | undefined> {
    return this.send(content, { quoted: this.raw, ...opts })
  }

  /** Send to `jid` (defaults to the current chat) without quoting. */
  async send(content: Sendable, opts: SendOptions = {}, jid = this.chat): Promise<WAMessage | undefined> {
    const { mentions, quoted, ...misc } = opts
    let body: AnyMessageContent = typeof content === 'string' ? { text: content } : content
    if (mentions?.length) {
      const all = (await Promise.all(mentions.map((m) => this.jids.bothForms(m)))).flat()
      body = { ...body, mentions: [...new Set(all)] } as AnyMessageContent
    }
    return this.sock.sendMessage(jid, body, { ...misc, quoted: quoted === false ? undefined : quoted })
  }

  /** Reply with text that @mentions the given users (text should contain their @numbers). */
  replyMention(text: string, jids: string[], opts: SendOptions = {}) {
    return this.reply(text, { ...opts, mentions: jids })
  }

  react(emoji: string, key: WAMessageKey = this.key) {
    return this.sock.sendMessage(this.chat, { react: { text: emoji, key } })
  }

  /** Delete a message (yours, or anyone's if you are a group admin). Defaults to this one. */
  delete(key: WAMessageKey = this.key) {
    return this.sock.sendMessage(key.remoteJid ?? this.chat, { delete: key })
  }

  edit(text: string, key: WAMessageKey) {
    return this.sock.sendMessage(key.remoteJid ?? this.chat, { text, edit: key })
  }

  /** Forward any message (defaults to the quoted one) to `jid`. */
  forward(jid: string, message: WAMessage | undefined = this.quoted?.raw, opts: SendOptions = {}) {
    if (!message) throw new Error('nothing to forward')
    return this.send({ forward: message }, opts, jid)
  }

  /** Send a file fetched from a URL as the right media type. */
  async sendFromUrl(url: string, opts: SendOptions & { caption?: string; asDocument?: boolean; fileName?: string } = {}, jid = this.chat) {
    const { caption, asDocument, fileName, ...rest } = opts
    const { fetchBuffer, mediaKind } = await import('./media.js')
    const { buffer, mimetype } = await fetchBuffer(url)
    const kind = asDocument ? 'document' : mediaKind(mimetype)
    const content: AnyMessageContent =
      kind === 'image' ? { image: buffer, caption }
      : kind === 'video' ? { video: buffer, caption }
      : kind === 'audio' ? { audio: buffer, mimetype }
      : { document: buffer, mimetype, fileName: fileName ?? url.split('/').pop()?.split('?')[0] ?? 'file', caption }
    return this.send(content, rest, jid)
  }

  // ---------- groups ----------

  groupMetadata(jid = this.chat, fresh = false): Promise<GroupMetadata> {
    return getGroupMetadata(this.sock, jid, fresh)
  }

  async isBotAdmin(jid = this.chat): Promise<boolean> {
    const meta = await this.groupMetadata(jid)
    const me = this.sock.user
    return isParticipantAdmin(findParticipant(meta, me?.id ?? '')) || isParticipantAdmin(findParticipant(meta, me?.lid ?? ''))
  }

  async isAdmin(user: string, jid = this.chat): Promise<boolean> {
    const meta = await this.groupMetadata(jid)
    return isParticipantAdmin(findParticipant(meta, user))
  }

  private async participantsUpdate(users: string | string[], action: ParticipantAction, jid = this.chat) {
    const list = Array.isArray(users) ? users : [users]
    let meta = await this.groupMetadata(jid)
    // someone who joined after the cache was filled won't be found; refetch so we use the id form the group expects
    if (action !== 'add' && list.some((u) => !findParticipant(meta, u))) meta = await this.groupMetadata(jid, true)
    const ids = toParticipantIds(meta, list)
    return this.sock.groupParticipantsUpdate(jid, ids, action)
  }
  kick(users: string | string[], jid = this.chat) {
    return this.participantsUpdate(users, 'remove', jid)
  }
  add(users: string | string[], jid = this.chat) {
    return this.participantsUpdate(users, 'add', jid)
  }
  promote(users: string | string[], jid = this.chat) {
    return this.participantsUpdate(users, 'promote', jid)
  }
  demote(users: string | string[], jid = this.chat) {
    return this.participantsUpdate(users, 'demote', jid)
  }
}
