import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import PDFDocument from 'pdfkit'
import { TMP_DIR, command, media, type Message, type Quoted } from '../core/index.js'

type Kind = 'audio' | 'video' | 'image' | 'sticker'

/** What a quoted message holds; documents are classified by their mimetype. */
const kindOf = (q?: Quoted): Kind | undefined => {
  if (!q) return undefined
  if (q.isDocument) return media.mediaKind(q.mimetype) as Kind
  return q.isAudio || q.isVideo || q.isImage || q.isSticker ? (q.type as Kind) : undefined
}

/** The quoted media if it is one of `kinds`; otherwise replies the usage line and returns undefined. */
function needs(msg: Message, kinds: Kind | Kind[], usage: string): Quoted | undefined {
  const want = Array.isArray(kinds) ? kinds : [kinds]
  const kind = kindOf(msg.quoted)
  if (kind && want.includes(kind)) return msg.quoted
  void msg.reply(usage)
  return undefined
}

/** File extension to feed ffmpeg for a quoted message. */
function extOf(q: Quoted): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/webm': 'webm', 'image/gif': 'gif',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  }
  const mime = q.mimetype.split(';')[0].trim()
  return map[mime] ?? mime.split('/')[1] ?? 'bin'
}

/** Per-chat scratch folder under tmp/<sub>/ (jid made filesystem-safe). */
const chatDir = (sub: string, chat: string) => path.join(TMP_DIR, sub, chat.replace(/[^\w.-]/g, '_'))

const listDir = (dir: string) => fs.readdir(dir).catch(() => [] as string[])
const byNumber = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10)

const AUDIO_OUT = ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k']
const VIDEO_OUT = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac']
const AUDIO_OR_VIDEO: Kind[] = ['audio', 'video']

const replyAudio = (msg: Message, audio: Buffer, name = 'audio') => msg.reply({ audio, mimetype: 'audio/mpeg', fileName: `${name}.mp3` })
const replyVoice = (msg: Message, audio: Buffer) => msg.reply({ audio, mimetype: 'audio/ogg; codecs=opus', ptt: true })

/** Register an audio command that just applies an `-af` filter and returns an mp3. */
function audioFilter(name: string, desc: string, filter: (args: string) => string, aliases?: string[]) {
  command({ name, aliases, desc, usage: '(reply to audio/video)', category: 'audio' }, async (msg, args) => {
    const q = needs(msg, AUDIO_OR_VIDEO, `_Reply to an audio or video. Usage: ${name}_`)
    if (!q) return
    const out = await media.convert(await q.download(), extOf(q), 'mp3', ['-af', filter(args), ...AUDIO_OUT])
    await replyAudio(msg, out, name)
  })
}

/** Register a command that turns audio into a visualisation video via filter_complex. */
function audioVisual(name: string, desc: string, graph: string) {
  command({ name, desc, usage: '(reply to audio/video)', category: 'audio' }, async (msg) => {
    const q = needs(msg, AUDIO_OR_VIDEO, `_Reply to an audio or video. Usage: ${name}_`)
    if (!q) return
    const video = await media.convert(await q.download(), extOf(q), 'mp4', [
      '-filter_complex', `[0:a]${graph}[v]`, '-map', '[v]', '-map', '0:a', ...VIDEO_OUT, '-b:a', '128k', '-shortest',
    ])
    await msg.reply({ video })
  })
}

// ---------- audio ----------

command(
  {
    name: 'mp3',
    desc: 'Extract audio as mp3 (add "ptt" for a voice note)',
    usage: '[ptt] (reply to audio/video)',
    category: 'audio',
  },
  async (msg, args) => {
    const q = needs(msg, AUDIO_OR_VIDEO, '_Reply to an audio or video. Usage: mp3 [ptt]_')
    if (!q) return
    const buffer = await q.download()
    if (['ptt', 'voice'].includes(args.toLowerCase())) return replyVoice(msg, await media.toOpusVoice(buffer, extOf(q)))
    await replyAudio(msg, await media.toMp3(buffer, extOf(q)))
  },
)

command(
  {
    name: 'voice',
    aliases: ['ptt'],
    desc: 'Turn any audio or video into a voice note',
    category: 'audio',
  },
  async (msg) => {
    const q = needs(msg, AUDIO_OR_VIDEO, '_Reply to an audio or video._')
    if (!q) return
    await replyVoice(msg, await media.toOpusVoice(await q.download(), extOf(q)))
  },
)

command(
  {
    name: 'reverse',
    desc: 'Reverse an audio or video',
    category: 'audio',
  },
  async (msg) => {
    const q = needs(msg, AUDIO_OR_VIDEO, '_Reply to an audio or video._')
    if (!q) return
    const buffer = await q.download()
    if (kindOf(q) === 'video') {
      const video = await media.convert(buffer, extOf(q), 'mp4', ['-vf', 'reverse', '-af', 'areverse', ...VIDEO_OUT])
      return msg.reply({ video })
    }
    await replyAudio(msg, await media.convert(buffer, extOf(q), 'mp3', ['-af', 'areverse', ...AUDIO_OUT]), 'reversed')
  },
)

/** "start;duration" in seconds, or undefined when malformed. */
function parseRange(args: string): { start: number; duration: number } | undefined {
  const [start, duration] = args.split(';').map((s) => Number(s.trim()))
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0) return undefined
  return { start, duration }
}

command(
  {
    name: 'cut',
    desc: 'Cut a segment out of an audio or video as mp3',
    usage: '<start>;<duration> (seconds)',
    category: 'audio',
  },
  async (msg, args) => {
    const q = needs(msg, AUDIO_OR_VIDEO, '_Reply to an audio or video. Usage: cut 10;30 (start;duration)_')
    if (!q) return
    const range = parseRange(args)
    if (!range) return msg.reply('_Usage: cut <start>;<duration> e.g. cut 10;30_')
    const out = await media.convert(await q.download(), extOf(q), 'mp3', ['-ss', String(range.start), '-t', String(range.duration), ...AUDIO_OUT])
    await replyAudio(msg, out, 'cut')
  },
)

command(
  {
    name: 'trim',
    desc: 'Trim a video to a segment',
    usage: '<start>;<duration> (seconds)',
    category: 'video',
  },
  async (msg, args) => {
    const q = needs(msg, 'video', '_Reply to a video. Usage: trim 10;30 (start;duration)_')
    if (!q) return
    const range = parseRange(args)
    if (!range) return msg.reply('_Usage: trim <start>;<duration> e.g. trim 10;30_')
    const video = await media.convert(await q.download(), extOf(q), 'mp4', ['-ss', String(range.start), '-t', String(range.duration), ...VIDEO_OUT])
    await msg.reply({ video })
  },
)

const gain = (args: string, fallback: number) => {
  const n = Number(args)
  return Number.isFinite(n) && args ? Math.max(-20, Math.min(20, n)) : fallback
}

audioFilter('bass', 'Boost (or cut) the bass; gain in dB, default 10', (a) => `bass=g=${gain(a, 10)}`)
audioFilter('treble', 'Boost (or cut) the treble; gain in dB, default 10', (a) => `treble=g=${gain(a, 10)}`)
audioFilter('pitch', 'Raise the pitch without changing the speed', () => 'asetrate=44100*1.25,aresample=44100,atempo=0.8', ['high'])
audioFilter('low', 'Lower the pitch without changing the speed', () => 'asetrate=44100*0.8,aresample=44100,atempo=1.25', ['deep'])
audioFilter('nightcore', 'Faster and higher, nightcore style', () => 'asetrate=44100*1.25,aresample=44100')
audioFilter('slow', 'Slow the audio down (slowed + reverb feel)', () => 'atempo=0.8,aecho=0.8:0.88:60:0.4', ['slowed'])
audioFilter('fast', 'Speed the audio up', () => 'atempo=1.5')
audioFilter('robot', 'Robot voice effect', () => "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75")

audioVisual('histo', 'Audio → spectrum histogram video', 'showspectrum=s=640x480:mode=combined:slide=scroll:color=channel:scale=cbrt,format=yuv420p')
audioVisual('vector', 'Audio → vectorscope visualisation video', 'avectorscope=s=640x480:zoom=1.5:rc=2:gc=200:bc=10:rf=1:gf=8:bf=7,format=yuv420p')
audioVisual('avec', 'Audio → waveform video on a black background', 'showwaves=s=640x480:mode=line:colors=white,format=yuv420p')

command(
  {
    name: 'black',
    desc: 'Audio → video with a black screen (for platforms that want video)',
    category: 'audio',
  },
  async (msg) => {
    const q = needs(msg, AUDIO_OR_VIDEO, '_Reply to an audio or video._')
    if (!q) return
    const video = await media.convert(await q.download(), extOf(q), 'mp4', [
      '-f', 'lavfi', '-i', 'color=c=black:s=640x480:r=10', '-map', '1:v', '-map', '0:a',
      ...VIDEO_OUT, '-tune', 'stillimage', '-b:a', '128k', '-shortest',
    ])
    await msg.reply({ video })
  },
)

// ---------- video ----------

command(
  {
    name: 'rotate',
    desc: 'Rotate a video right/left or flip it upside down',
    usage: 'right|left|flip (reply to a video)',
    category: 'video',
  },
  async (msg, args) => {
    const q = needs(msg, 'video', '_Reply to a video. Usage: rotate right|left|flip_')
    if (!q) return
    const filters: Record<string, string> = { right: 'transpose=1', left: 'transpose=2', flip: 'transpose=1,transpose=1' }
    const vf = filters[args.toLowerCase()]
    if (!vf) return msg.reply('_Usage: rotate right|left|flip_')
    const video = await media.convert(await q.download(), extOf(q), 'mp4', ['-vf', vf, ...VIDEO_OUT])
    await msg.reply({ video })
  },
)

command(
  {
    name: 'compress',
    desc: 'Shrink a video (≤720p, higher compression)',
    category: 'video',
  },
  async (msg) => {
    const q = needs(msg, 'video', '_Reply to a video._')
    if (!q) return
    const video = await media.convert(await q.download(), extOf(q), 'mp4', [
      '-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '64k',
    ])
    await msg.reply({ video })
  },
)

command(
  {
    name: 'crop',
    desc: 'Crop a video: output width,height and the x,y offset',
    usage: '<w>,<h>,<x>,<y> (reply to a video)',
    category: 'video',
  },
  async (msg, args) => {
    const q = needs(msg, 'video', '_Reply to a video. Usage: crop 512,512,0,0 (w,h,x,y)_')
    if (!q) return
    const [w, h, x, y] = args.split(',').map((s) => parseInt(s.trim(), 10))
    if ([w, h, x, y].some((n) => !Number.isInteger(n) || n < 0) || !w || !h) return msg.reply('_Usage: crop <w>,<h>,<x>,<y> e.g. crop 512,512,0,0_')
    const file = await q.downloadToFile(extOf(q))
    const out = media.tmpPath('mp4')
    try {
      const { width = 0, height = 0 } = await media.ffprobe(file)
      if (w + x > width || h + y > height) return msg.reply(`_Video is *${width}x${height}* — the crop box must fit inside it._`)
      // libx264 needs even dimensions, so round the crop box down after cutting
      await media.ffmpeg(['-i', file, '-vf', `crop=${w}:${h}:${x}:${y},scale=trunc(iw/2)*2:trunc(ih/2)*2`, ...VIDEO_OUT, out])
      await msg.reply({ video: await fs.readFile(out) })
    } finally {
      await Promise.all([media.removeFile(file), media.removeFile(out)])
    }
  },
)

command(
  {
    name: 'avm',
    desc: 'Merge an audio onto a video: reply to the audio with avm, then to the video with avm',
    usage: '(reply to audio, then to video)',
    category: 'video',
  },
  async (msg) => {
    const dir = chatDir('avm', msg.chat)
    const kind = kindOf(msg.quoted)
    const stored = (await listDir(dir)).find((f) => f.startsWith('audio.'))
    if (kind === 'audio' && msg.quoted) {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `audio.${extOf(msg.quoted)}`), await msg.quoted.download())
      return msg.reply('_Audio added! Now reply to a video with *avm* to merge._')
    }
    if (kind !== 'video' || !msg.quoted) return msg.reply('_Reply to an audio with avm first, then to a video with avm._')
    if (!stored) return msg.reply('_No audio stored yet — reply to an audio with *avm* first._')
    const videoFile = await msg.quoted.downloadToFile(extOf(msg.quoted))
    const out = media.tmpPath('mp4')
    try {
      await media.ffmpeg(['-i', videoFile, '-i', path.join(dir, stored), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out])
      await msg.reply({ video: await fs.readFile(out) })
      await fs.rm(dir, { recursive: true, force: true })
    } finally {
      await Promise.all([media.removeFile(videoFile), media.removeFile(out)])
    }
  },
)

// every part is normalised to the same size/fps/codecs so the concat demuxer can stream-copy them
const MERGE_NORMALISE = [
  '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1,setsar=1,fps=30',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
]

command(
  {
    name: 'merge',
    desc: 'Join videos: reply to each with "merge <n>" in order, then send "merge"',
    usage: '<n> (reply to a video) | merge | merge clear',
    category: 'video',
  },
  async (msg, args) => {
    const dir = chatDir('merge', msg.chat)
    if (args.toLowerCase() === 'clear') {
      await fs.rm(dir, { recursive: true, force: true })
      return msg.reply('_Merge queue cleared._')
    }
    if (kindOf(msg.quoted) === 'video' && msg.quoted) {
      const n = parseInt(args, 10)
      if (!Number.isInteger(n) || n < 1) return msg.reply('_Usage: merge <n> (reply to a video with its order number)_')
      await fs.mkdir(dir, { recursive: true })
      const part = await media.convert(await msg.quoted.download(), extOf(msg.quoted), 'mp4', MERGE_NORMALISE)
      await fs.writeFile(path.join(dir, `${n}.mp4`), part)
      return msg.reply(`_Video ${n} added_`)
    }
    const parts = (await listDir(dir)).filter((f) => f.endsWith('.mp4')).sort(byNumber)
    if (parts.length < 2) return msg.reply('_Add at least two videos first: reply to each with merge 1, merge 2, …_')
    await msg.reply(`_Merging ${parts.length} videos…_`)
    const list = path.join(dir, 'list.txt')
    const out = media.tmpPath('mp4')
    try {
      await fs.writeFile(list, parts.map((f) => `file '${path.join(dir, f)}'`).join('\n'))
      await media.ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out])
      await msg.reply({ video: await fs.readFile(out) })
      await fs.rm(dir, { recursive: true, force: true })
    } finally {
      await media.removeFile(out)
    }
  },
)

/** Any video-ish buffer → a playable mp4 (even dimensions, h264/aac). */
const toPlayableMp4 = (buffer: Buffer, ext: string) =>
  ext === 'mp4' ? Promise.resolve(buffer) : media.convert(buffer, ext, 'mp4', ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...VIDEO_OUT])

command(
  {
    name: 'gif',
    desc: 'Send a video back as a gif',
    category: 'video',
  },
  async (msg) => {
    const q = needs(msg, ['video', 'image'], '_Reply to a video or gif._')
    if (!q) return
    const ext = extOf(q)
    if (kindOf(q) === 'image' && ext !== 'gif') return msg.reply('_Reply to a video or gif._')
    await msg.reply({ video: await toPlayableMp4(await q.download(), ext), gifPlayback: true })
  },
)

command(
  {
    name: 'tomp4',
    desc: 'Turn a gif or video document into a normal video',
    category: 'video',
  },
  async (msg) => {
    const q = needs(msg, ['video', 'image'], '_Reply to a gif or a video sent as a document._')
    if (!q) return
    const ext = extOf(q)
    if (kindOf(q) === 'image' && ext !== 'gif') return msg.reply('_Reply to a gif or a video sent as a document._')
    await msg.reply({ video: await toPlayableMp4(await q.download(), ext) })
  },
)

// ---------- document ----------

command(
  {
    name: 'page',
    desc: 'Add an image as page <n> of a PDF (then run pdf <name>)',
    usage: '<n> (reply to an image)',
    category: 'document',
  },
  async (msg, args) => {
    const q = needs(msg, 'image', '_Reply to an image. Usage: page <n>_')
    if (!q) return
    const n = parseInt(args, 10)
    if (!Number.isInteger(n) || n < 1) return msg.reply('_Usage: page <n> (reply to an image with its page number)_')
    const dir = chatDir('pdf', msg.chat)
    await fs.mkdir(dir, { recursive: true })
    // pdfkit only reads JPEG/PNG, so normalise everything to JPEG
    await fs.writeFile(path.join(dir, `${n}.jpg`), await sharp(await q.download()).rotate().jpeg({ quality: 90 }).toBuffer())
    await msg.reply(`_Page ${n} added!_`)
  },
)

command(
  {
    name: 'pdf',
    desc: 'Build a PDF from the pages added with "page"',
    usage: '<name> | clear',
    category: 'document',
  },
  async (msg, args) => {
    const dir = chatDir('pdf', msg.chat)
    if (args.toLowerCase() === 'clear') {
      await fs.rm(dir, { recursive: true, force: true })
      return msg.reply('_Pages cleared._')
    }
    const name = args.replace(/[\\/:*?"<>|]/g, '').trim()
    if (!name) return msg.reply('_Usage: pdf <name> (after adding pages with page <n>)_')
    const pages = (await listDir(dir)).filter((f) => f.endsWith('.jpg')).sort(byNumber)
    if (!pages.length) return msg.reply('_No pages yet — reply to images with page 1, page 2, …_')

    const doc = new PDFDocument({ autoFirstPage: false, info: { Title: name } })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<Buffer>((resolve, reject) => doc.on('end', () => resolve(Buffer.concat(chunks))).on('error', reject))
    for (const file of pages) {
      const img = path.join(dir, file)
      const { width = 595, height = 842 } = await sharp(img).metadata()
      doc.addPage({ size: [width, height], margin: 0 }).image(img, 0, 0, { width, height })
    }
    doc.end()
    await msg.reply({ document: await done, mimetype: 'application/pdf', fileName: `${name}.pdf` })
    await fs.rm(dir, { recursive: true, force: true })
  },
)

// ---------- misc ----------

command(
  {
    name: 'vv',
    aliases: ['viewonce'],
    desc: 'Resend a view-once image/video/audio as a normal message',
    category: 'media',
  },
  async (msg) => {
    const q = needs(msg, ['image', 'video', 'audio'], '_Reply to a view-once image, video or audio._')
    if (!q) return
    const buffer = await q.download()
    const caption = q.text || undefined
    if (q.isImage) return msg.reply({ image: buffer, caption })
    if (q.isVideo) return msg.reply({ video: buffer, caption })
    await msg.reply({ audio: buffer, mimetype: q.mimetype || 'audio/ogg; codecs=opus', ptt: q.isVoiceNote })
  },
)
