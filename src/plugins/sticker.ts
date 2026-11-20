import sharp from 'sharp'
import { command, media, type Message, type Quoted } from '../core/index.js'

/** "pack;author" → sticker meta (missing parts fall back to STICKER_PACK). */
function parseMeta(args: string): media.StickerMeta {
  if (!args) return {}
  const [pack, author] = args.split(';').map((s) => s.trim())
  return { ...(pack && { pack }), ...(author && { author }) }
}

/** A quoted image/video (documents count by their mimetype), else the usage line. */
function needsVisual(msg: Message, usage: string): Quoted | undefined {
  const q = msg.quoted
  const kind = q && (q.isDocument ? media.mediaKind(q.mimetype) : q.type)
  if (kind === 'image' || kind === 'video') return q
  void msg.reply(usage)
  return undefined
}

function needsSticker(msg: Message, usage: string): Quoted | undefined {
  if (msg.quoted?.isSticker) return msg.quoted
  void msg.reply(usage)
  return undefined
}

command(
  {
    name: 'sticker',
    aliases: ['s'],
    desc: 'Turn an image, video or gif into a sticker',
    usage: '[pack;author] | crop (reply to media)',
    category: 'sticker',
  },
  async (msg, args) => {
    const q = needsVisual(msg, '_Reply to an image or video. Usage: sticker [pack;author] | sticker crop_')
    if (!q) return
    const crop = args.toLowerCase() === 'crop'
    const meta = parseMeta(crop ? '' : args)
    const buffer = await q.download()
    let sticker: Buffer
    if (media.mediaKind(q.mimetype) === 'video' || q.isVideo) sticker = await media.videoToSticker(buffer, meta)
    else if (crop) {
      // cover-fit: fill the whole 512x512 square instead of padding
      const square = await sharp(buffer).rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 90 }).toBuffer()
      sticker = await media.addStickerExif(square, meta)
    } else sticker = await media.imageToSticker(buffer, meta)
    await msg.reply({ sticker })
  },
)

command(
  {
    name: 'circle',
    desc: 'Make a circular sticker from an image',
    usage: '[pack;author] (reply to an image)',
    category: 'sticker',
  },
  async (msg, args) => {
    const q = msg.quoted
    if (!q || !(q.isImage || (q.isDocument && media.mediaKind(q.mimetype) === 'image'))) return msg.reply('_Reply to an image._')
    const sticker = await media.imageToSticker(await q.download(), parseMeta(args), { circle: true })
    await msg.reply({ sticker })
  },
)

command(
  {
    name: 'take',
    desc: 'Re-stamp a sticker with your pack/author, or set title/artist on an audio',
    usage: '[pack;author] (reply to sticker) | <title,artist> (reply to audio)',
    category: 'sticker',
  },
  async (msg, args) => {
    const q = msg.quoted
    if (q?.isSticker) {
      const sticker = await media.addStickerExif(await q.download(), parseMeta(args))
      return msg.reply({ sticker })
    }
    if (q?.isAudio) {
      const [title, artist] = args.split(',').map((s) => s.trim())
      if (!title) return msg.reply('_Usage: take <title,artist> (reply to an audio)_')
      const audio = await media.convert(await q.download(), q.isVoiceNote ? 'ogg' : 'mp3', 'mp3', [
        '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3',
        '-metadata', `title=${title}`, '-metadata', `artist=${artist ?? ''}`,
      ])
      return msg.reply({ audio, mimetype: 'audio/mpeg', fileName: `${title}.mp3` })
    }
    await msg.reply('_Reply to a sticker or an audio. Usage: take [pack;author] | take <title,artist>_')
  },
)

command(
  {
    name: 'exif',
    desc: 'Show the pack/author metadata of a sticker',
    category: 'sticker',
  },
  async (msg) => {
    const q = needsSticker(msg, '_Reply to a sticker._')
    if (!q) return
    const exif = await media.readStickerExif(await q.download())
    if (!exif) return msg.reply('_No exif metadata found in this sticker._')
    await msg.reply('```' + JSON.stringify(exif, null, 2) + '```')
  },
)

command(
  {
    name: 'photo',
    aliases: ['toimg'],
    desc: 'Convert a static sticker into an image',
    category: 'sticker',
  },
  async (msg) => {
    const q = needsSticker(msg, '_Reply to a (non-animated) sticker._')
    if (!q) return
    if (q.isAnimatedSticker) return msg.reply('_That sticker is animated — use *mp4* instead._')
    await msg.reply({ image: await media.stickerToPng(await q.download()) })
  },
)

command(
  {
    name: 'mp4',
    aliases: ['tovideo'],
    desc: 'Convert an animated sticker into a video',
    category: 'sticker',
  },
  async (msg) => {
    const q = needsSticker(msg, '_Reply to an animated sticker._')
    if (!q) return
    if (!q.isAnimatedSticker) return msg.reply('_That sticker is not animated — use *photo* instead._')
    await msg.reply({ video: await media.stickerToMp4(await q.download()) })
  },
)
