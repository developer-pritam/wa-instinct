/**
 * `.agent <task>`: full Claude Code (shell, files, your skills like /reel and HyperFrames) driven
 * from WhatsApp, for long jobs such as making a reel or editing a video you replied to.
 *
 * How a job runs:
 *  - Replied-to (or attached) media is saved to data/agent/jobs/<id>/inbox/.
 *  - Claude Code starts *detached* (setsid) in AGENT_DIR (your plugin repo), so nodemon/pm2
 *    restarts of the bot don't kill it. Its stream-json log goes to the job folder.
 *  - The bot polls running jobs: posts a progress note now and then, and when Claude exits,
 *    sends its final message plus every file it put in outbox/.
 *  - `.agent <follow-up>` in the same chat continues the last conversation (--resume).
 *
 * This is effectively a shell on the VM: sudo-only (owner + sudo users, as chosen). Up to AGENT_MAX_JOBS (2) jobs
 * run at once, but never two turns of the same conversation.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AnyMessageContent, WASocket } from 'baileys'
import { DATA_DIR, chatSettings, command, config, db, formatDuration, jid, logger, on, sleep, vars, type Message } from '../core/index.js'
import { toWhatsApp } from './ai.js'

const JOBS_DIR = path.join(DATA_DIR, 'agent', 'jobs')
const POLL_MS = 10_000
const PROGRESS_EVERY = 4 * 60_000
const SESSION_TTL = 6 * 60 * 60_000
const MAX_FILES = 10
const VIDEO_MAX = 60 * 1024 * 1024 // bigger videos go as documents
const TOOLS = 'Bash Read Write Edit MultiEdit Glob Grep WebSearch WebFetch Skill Task Agent TodoWrite NotebookEdit'

mkdirSync(JOBS_DIR, { recursive: true })

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat       TEXT NOT NULL,
    requester  TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    dir        TEXT NOT NULL,
    pid        INTEGER,
    status     TEXT NOT NULL,          -- running | done | failed | stopped
    session_id TEXT,
    created_at INTEGER NOT NULL,
    ended_at   INTEGER
  )
`)

interface Job {
  id: number
  chat: string
  requester: string
  prompt: string
  dir: string
  pid: number | null
  status: 'running' | 'done' | 'failed' | 'stopped'
  session_id: string | null
  created_at: number
  ended_at: number | null
}

// ids of messages the agent posted, so a plain reply to one continues the conversation
db.exec('CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, chat TEXT NOT NULL, job_id INTEGER, at INTEGER NOT NULL)')

const q = {
  remember: db.prepare('INSERT OR IGNORE INTO agent_messages (id, chat, job_id, at) VALUES (?, ?, ?, ?)'),
  isAgentMessage: db.prepare('SELECT 1 FROM agent_messages WHERE id = ?'),
  sessionOfMessage: db.prepare('SELECT j.session_id FROM agent_messages m JOIN agent_jobs j ON j.id = m.job_id WHERE m.id = ?'),
  getJob: db.prepare('SELECT * FROM agent_jobs WHERE id = ?'),
  insert: db.prepare('INSERT INTO agent_jobs (chat, requester, prompt, dir, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  setPid: db.prepare('UPDATE agent_jobs SET pid = ? WHERE id = ?'),
  finish: db.prepare('UPDATE agent_jobs SET status = ?, session_id = COALESCE(?, session_id), ended_at = ? WHERE id = ?'),
  running: db.prepare("SELECT * FROM agent_jobs WHERE status = 'running'"),
  lastForChat: db.prepare('SELECT * FROM agent_jobs WHERE chat = ? ORDER BY id DESC LIMIT 1'),
  recentForChat: db.prepare('SELECT * FROM agent_jobs WHERE chat = ? ORDER BY id DESC LIMIT ?'),
  // one row per Claude Code session (conversation) in a chat, most recently used first
  conversations: db.prepare(`
    SELECT session_id, MIN(id) AS first_id, COUNT(*) AS turns, MAX(COALESCE(ended_at, created_at)) AS last_at,
           (SELECT prompt FROM agent_jobs j2 WHERE j2.session_id = j.session_id ORDER BY id LIMIT 1) AS first_prompt
    FROM agent_jobs j WHERE chat = ? AND session_id IS NOT NULL
    GROUP BY session_id ORDER BY last_at DESC`),
}

/** Folder .agent works in: AGENT_DIR from .env (no default, so it never guesses a path). */
const agentDir = () => vars.get('AGENT_DIR')
/** Max job runtime; 0 (the default) means no limit. */
const timeoutMs = () => vars.int('AGENT_TIMEOUT_MIN', 0) * 60_000

function claudeBin(): string {
  const configured = vars.get('CLAUDE_BIN')
  if (configured) return configured
  const local = path.join(os.homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

/** Instructions appended to Claude Code's system prompt for a WhatsApp turn. */
function systemPrompt(job: { dir: string }, requester: string, inputs: string[]): string {
  const inbox = path.join(job.dir, 'inbox')
  const outbox = path.join(job.dir, 'outbox')
  return `
You are talking to ${requester} over WhatsApp. They can't see your work as it happens; each turn ends when you finish,
and their reply comes back as the next message in this same conversation (with all your context).
- Questions and chat: just answer. You're working in this project folder with its memory, so use what you know about it.
- Tasks: do them. Make reasonable choices yourself; only stop to ask when a decision really needs them
  (e.g. approving a script before recording). Then end your turn with one clear question, and continue when they reply.
- Interactive tools (AskUserQuestion, plan approval) don't work here: ask in your final message instead.

Input files from the chat (this turn): ${inputs.length ? inputs.map((f) => path.join(inbox, f)).join(', ') : 'none'}.
Deliverables: copy every file the user should receive into ${outbox} (final videos, images, documents; at most ${MAX_FILES}).
Only files in that folder are sent back. Keep videos under 60 MB when you can (larger ones arrive as documents).

Your final message is sent to WhatsApp as-is: the answer, or a short summary of what you made (or your question).
Use WhatsApp formatting only (*bold*, _italic_); no markdown headings or tables.

Machine notes: 2 CPUs, so renders are slow; ffmpeg is 4.2. Use the skills you have (reel, hyperframes, and the others).
Voice and transcription go through ElevenLabs (ELEVENLABS_API_KEY in ${path.join(agentDir(), '.env')}). Whisper and Kokoro are NOT installed:
to transcribe audio or video, call the ElevenLabs speech-to-text API (POST https://api.elevenlabs.io/v1/speech-to-text,
multipart: file, model_id=scribe_v1, timestamps_granularity=word) instead of whisper / hyperframes transcribe.
Never print, log or send API keys or the contents of .env files.
`.trim()
}

// ---------- process helpers ----------

/** Alive and still Claude (guards against the pid being reused after a reboot). */
function isRunning(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude')
  } catch {
    return false
  }
}

/** Kill the job's whole process group (setsid made the pid its leader), including renders it started. */
function killJob(pid: number | null) {
  if (!pid) return
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/** Start Claude Code detached. Resolves with its pid once the wrapper has written it. */
async function launch(job: Job, args: string[]): Promise<number> {
  // setsid -f: new session and re-parented to init, so nodemon/pm2 restarts don't take it down
  const wrapper = 'echo $$ > "$JOB_DIR/pid"; exec "$CLAUDE_BIN" "$@" > "$JOB_DIR/log.jsonl" 2> "$JOB_DIR/stderr.log" < /dev/null'
  const child = spawn('setsid', ['-f', 'sh', '-c', wrapper, 'sh', ...args], {
    cwd: agentDir(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      JOB_DIR: job.dir,
      CLAUDE_BIN: claudeBin(),
      // scripts the skills run must use this Node 22, not an older system node
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    },
  })
  child.unref()
  const pidFile = path.join(job.dir, 'pid')
  for (let i = 0; i < 50; i++) {
    if (existsSync(pidFile)) return Number(readFileSync(pidFile, 'utf8').trim())
    await sleep(100)
  }
  throw new Error('Claude Code did not start')
}

// ---------- reading the stream-json log ----------

interface LogSummary {
  sessionId?: string
  result?: { text: string; isError: boolean; costUsd?: number }
  /** Recent human-readable activity, newest last. */
  activity: string[]
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return `running \`${String(input.description ?? input.command ?? '').slice(0, 80)}\``
  if (name === 'Skill') return `using skill ${String(input.skill ?? input.name ?? '')}`
  if (name === 'WebSearch') return `searching "${String(input.query ?? '').slice(0, 60)}"`
  if (name === 'WebFetch') return `reading ${String(input.url ?? '').slice(0, 60)}`
  if (name === 'Write' || name === 'Edit') return `writing ${path.basename(String(input.file_path ?? ''))}`
  if (name === 'Read') return `reading ${path.basename(String(input.file_path ?? ''))}`
  return name
}

function readLog(dir: string): LogSummary {
  const out: LogSummary = { activity: [] }
  let raw = ''
  try {
    raw = readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: Record<string, any>
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.session_id) out.sessionId = ev.session_id
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_use') out.activity.push(describeTool(block.name, block.input ?? {}))
        else if (block.type === 'text' && block.text?.trim()) out.activity.push(`💬 ${block.text.trim().split('\n')[0].slice(0, 160)}`)
      }
    } else if (ev.type === 'result') {
      out.result = { text: String(ev.result ?? ''), isError: !!ev.is_error || ev.subtype !== 'success', costUsd: ev.total_cost_usd }
    }
  }
  out.activity = out.activity.slice(-12)
  return out
}

// ---------- delivering results ----------

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(p))
    else if (!entry.name.startsWith('.')) files.push(p)
  }
  return files.sort()
}

function fileMessage(file: string): AnyMessageContent {
  const ext = path.extname(file).toLowerCase()
  const size = statSync(file).size
  const fileName = path.basename(file)
  if (['.mp4', '.mov', '.m4v'].includes(ext) && size <= VIDEO_MAX) return { video: { url: file }, mimetype: 'video/mp4' }
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && size <= 15 * 1024 * 1024) return { image: { url: file } }
  if (['.mp3', '.m4a', '.ogg', '.wav'].includes(ext)) return { document: { url: file }, mimetype: ext === '.mp3' ? 'audio/mpeg' : `audio/${ext.slice(1)}`, fileName }
  const mime: Record<string, string> = { '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip' }
  return { document: { url: file }, mimetype: mime[ext] ?? 'application/octet-stream', fileName }
}

/** Send as the agent and remember the message id (replies to it continue the conversation). */
async function sendAsAgent(sock: WASocket, job: Job, content: AnyMessageContent, opts: Parameters<WASocket['sendMessage']>[2] = {}) {
  const sent = await sock.sendMessage(job.chat, content, opts)
  if (sent?.key.id) q.remember.run(sent.key.id, job.chat, job.id, Date.now())
  return sent
}

async function deliver(sock: WASocket, job: Job, summary: LogSummary, status: Job['status']) {
  const seconds = (Date.now() - job.created_at) / 1000
  const elapsed = formatDuration(seconds)
  const who = jid.isGroup(job.chat) ? `@${jid.toNumber(job.requester)} ` : ''
  const mentions = jid.isGroup(job.chat) ? [job.requester] : []

  let text: string
  if (status === 'stopped') text = `${who}⏹️ Agent job #${job.id} stopped after ${elapsed}.`
  else if (summary.result && !summary.result.isError) {
    // quick answers read like chat; long jobs get a "done" header
    const header = seconds > 120 ? `✅ _Done in ${elapsed}_\n\n` : ''
    text = `${who}${header}${toWhatsApp(summary.result.text)}`
  } else {
    const stderr = (() => {
      try {
        return readFileSync(path.join(job.dir, 'stderr.log'), 'utf8').trim().split('\n').slice(-3).join('\n')
      } catch {
        return ''
      }
    })()
    const reason = summary.result?.text || stderr || 'it exited without a result'
    text = `${who}❌ *Agent #${job.id}* failed after ${elapsed}\n\`\`\`${reason.slice(0, 1500)}\`\`\``
  }
  await sendAsAgent(sock, job, { text, mentions }).catch((err) => logger.error({ err }, 'agent: result message failed'))

  const files = listFiles(path.join(job.dir, 'outbox')).slice(0, MAX_FILES)
  for (const file of files) {
    try {
      await sendAsAgent(sock, job, fileMessage(file), { mediaUploadTimeoutMs: 15 * 60_000 })
    } catch (err) {
      logger.error({ err, file }, 'agent: sending file failed')
      await sock.sendMessage(job.chat, { text: `⚠️ Couldn't send ${path.basename(file)}: ${(err as Error).message}` }).catch(() => {})
    }
  }
}

// ---------- watcher ----------

let currentSock: WASocket | undefined
const lastProgress = new Map<number, { at: number; count: number }>()

on('connected', ({ sock }) => {
  currentSock = sock
})

async function poll() {
  const sock = currentSock
  if (!sock) return
  for (const job of q.running.all() as unknown as Job[]) {
    const summary = readLog(job.dir)
    const age = Date.now() - job.created_at

    if (isRunning(job.pid)) {
      if (timeoutMs() > 0 && age > timeoutMs()) {
        killJob(job.pid)
        q.finish.run('failed', summary.sessionId ?? null, Date.now(), job.id)
        await sendAsAgent(sock, job, { text: `⌛ Agent #${job.id} hit the ${vars.int('AGENT_TIMEOUT_MIN', 0)} min limit and was stopped.` })
        continue
      }
      // a short progress note every few minutes, only when something new happened
      const prev = lastProgress.get(job.id) ?? { at: job.created_at, count: 0 }
      if (Date.now() - prev.at >= PROGRESS_EVERY && summary.activity.length && summary.activity.length !== prev.count) {
        lastProgress.set(job.id, { at: Date.now(), count: summary.activity.length })
        const latest = summary.activity[summary.activity.length - 1]
        await sendAsAgent(sock, job, { text: `⏳ Agent #${job.id} · ${formatDuration(age / 1000)}: ${latest}` }).catch(() => {})
      }
      continue
    }

    // process gone: finished, crashed, or stopped
    const status: Job['status'] = summary.result && !summary.result.isError ? 'done' : 'failed'
    q.finish.run(status, summary.sessionId ?? null, Date.now(), job.id)
    lastProgress.delete(job.id)
    const newest = q.lastForChat.get(job.chat) as unknown as Job | undefined
    if (summary.sessionId && newest?.id === job.id) chatSettings.set(job.chat, 'agent_session', { id: summary.sessionId, at: Date.now() })
    logger.info({ job: job.id, status, cost: summary.result?.costUsd }, 'agent job ended')
    await deliver(sock, job, summary, status)
  }
}

let polling = false
setInterval(() => {
  if (polling) return
  polling = true
  poll()
    .catch((err) => logger.error({ err }, 'agent poll failed'))
    .finally(() => (polling = false))
}, POLL_MS)

// ---------- command ----------

/** Save the replied-to media (or media the command was a caption on) into the job inbox. */
async function saveInputs(msg: Message, inbox: string): Promise<string[]> {
  const sources = [msg.hasMedia ? msg : undefined, msg.quoted?.hasMedia ? msg.quoted : undefined].filter(Boolean) as Message[]
  const saved: string[] = []
  for (const [i, m] of sources.entries()) {
    const docName = m.content.documentMessage?.fileName
    const ext = docName ? path.extname(docName).slice(1) : (m.mimetype.split('/')[1]?.split(';')[0] ?? 'bin').replace('jpeg', 'jpg').replace('quicktime', 'mov')
    const name = docName ? path.basename(docName) : `input-${i + 1}-${m.type}.${ext}`
    const file = path.join(inbox, name)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, await m.download())
    saved.push(name)
  }
  return saved
}

/** Conversation numbers as shown by `.agent chats` (most recent = 1), keyed by session id. */
function conversationNumbers(chat: string): Map<string, number> {
  const convs = q.conversations.all(chat) as unknown as { session_id: string }[]
  return new Map(convs.map((c, i) => [c.session_id, i + 1]))
}

function statusText(job: Job): string {
  const summary = readLog(job.dir)
  const recent = summary.activity.slice(-5).map((a) => `• ${a}`).join('\n') || '• starting…'
  return `⏳ *Agent #${job.id}* running for ${formatDuration((Date.now() - job.created_at) / 1000)}\n_${job.prompt.slice(0, 200)}_\n\n${recent}`
}

command(
  {
    name: 'agent',
    aliases: ['do'],
    desc: 'Give Claude Code a real task (make a reel, edit the replied video…); it works in the background and sends the result',
    usage: '<task> | status | stop [#] | new <task> | reset | list | chats | switch <no.>',
    category: 'ai',
  },
  async (msg, args) => {
    // off until the owner deliberately turns it on (AGENT_ENABLED=true in .env on the VM)
    if (process.env.AGENT_ENABLED !== 'true') return msg.reply('_.agent is disabled. Enable it on the VM: AGENT_ENABLED=true in .env._')
    const [sub = '', ...rest] = args.trim().split(/\s+/)
    const running = q.running.all() as unknown as Job[]

    if (sub === 'status') {
      if (!running.length) {
        const last = q.lastForChat.get(msg.chat) as unknown as Job | undefined
        return msg.reply(last ? `_No job running. Last here: #${last.id} (${last.status})._` : '_No agent job running._')
      }
      return msg.reply(running.map(statusText).join('\n\n'))
    }
    if (sub === 'stop') {
      const wanted = Number(String(rest[0] ?? '').replace('#', ''))
      const job = wanted ? running.find((j) => j.id === wanted) : (running.filter((j) => j.chat === msg.chat).pop() ?? running[running.length - 1])
      if (!job) return msg.reply(wanted ? `_Job #${wanted} isn't running._` : '_No agent job running._')
      killJob(job.pid)
      q.finish.run('stopped', readLog(job.dir).sessionId ?? null, Date.now(), job.id)
      return msg.reply(`⏹️ Stopped agent #${job.id}.`)
    }
    if (sub === 'list' || sub === 'tasks') {
      const jobs = q.recentForChat.all(msg.chat, 15) as unknown as Job[]
      if (!jobs.length) return msg.reply('_No agent tasks in this chat yet._')
      const convNo = conversationNumbers(msg.chat)
      const icon = { running: '⏳', done: '✅', failed: '❌', stopped: '⏹️' }
      const lines = jobs.map((j) => {
        const took = formatDuration(((j.ended_at ?? Date.now()) - j.created_at) / 1000)
        const conv = j.session_id ? ` · chat ${convNo.get(j.session_id)}` : ''
        return `${icon[j.status]} *#${j.id}* ${took}${conv}\n   _${j.prompt.split('\n')[0].slice(0, 70)}_`
      })
      return msg.reply(`*Agent tasks here* (newest first)\n${lines.join('\n')}\n\n_agent chats · agent switch <chat no.>_`)
    }
    if (sub === 'chats') {
      const convs = q.conversations.all(msg.chat) as unknown as { session_id: string; first_id: number; turns: number; last_at: number; first_prompt: string }[]
      if (!convs.length) return msg.reply('_No agent conversations in this chat yet._')
      const current = chatSettings.get<{ id: string; at: number } | null>(msg.chat, 'agent_session', null)
      const live = current && Date.now() - current.at < SESSION_TTL ? current.id : undefined
      const lines = convs.map((c, i) => {
        const mark = c.session_id === live ? ' ← current' : ''
        return `*${i + 1}.* ${c.turns} turn${c.turns === 1 ? '' : 's'} · ${formatDuration((Date.now() - c.last_at) / 1000)} ago${mark}\n   _${c.first_prompt.split('\n')[0].slice(0, 70)}_`
      })
      return msg.reply(`*Agent conversations here*\n${lines.join('\n')}\n\n_agent switch <no.> to continue one · agent new <task> for a fresh one_`)
    }
    if (sub === 'switch') {
      const convs = q.conversations.all(msg.chat) as unknown as { session_id: string; first_prompt: string }[]
      const pick = convs[Number(rest[0]) - 1]
      if (!pick) return msg.reply('_Usage: agent switch <no.> (see agent chats)_')
      chatSettings.set(msg.chat, 'agent_session', { id: pick.session_id, at: Date.now() })
      return msg.reply(`🔀 Switched to conversation ${rest[0]}: _${pick.first_prompt.split('\n')[0].slice(0, 70)}_\nYour next .agent message (or reply) continues it.`)
    }
    if (sub === 'reset') {
      chatSettings.del(msg.chat, 'agent_session')
      return msg.reply('_Next .agent task starts a fresh conversation._')
    }

    const fresh = sub === 'new'
    const task = (fresh ? rest.join(' ') : args).trim()
    if (!task && !msg.quoted && !msg.hasMedia) {
      return msg.reply('_Usage: agent <task or question> (reply to a video/photo to work on it) · agent status · agent stop · agent new <task>_')
    }
    await startTurn(msg, task, { fresh, quotedIsAgent: false })
  },
)

/**
 * Start one Claude Code turn for this chat: a new job, or the next message in the chat's
 * ongoing conversation (--resume) unless `fresh`.
 */
async function startTurn(msg: Message, task: string, opts: { fresh: boolean; quotedIsAgent: boolean; session?: string }) {
  if (!agentDir()) return msg.reply('_Set AGENT_DIR in .env to the folder .agent should work in, then restart the bot._')
  if (!existsSync(agentDir())) return msg.reply(`_AGENT_DIR not found: ${agentDir()}_`)

  // which conversation to continue: the one the user replied to, else the chat's current one
  const saved = chatSettings.get<{ id: string; at: number } | null>(msg.chat, 'agent_session', null)
  const current = saved && Date.now() - saved.at < SESSION_TTL ? saved.id : undefined
  const resume = opts.fresh ? undefined : (opts.session ?? current)

  const running = q.running.all() as unknown as Job[]
  const busy = resume && running.find((j) => (j.session_id ?? readLog(j.dir).sessionId) === resume)
  if (busy) return msg.reply(`_That conversation is still working on #${busy.id}. Wait for it, or start another with .agent new <task>._`)
  const max = vars.int('AGENT_MAX_JOBS', 2)
  if (running.length >= max) {
    return msg.reply(`_${running.length} agent jobs are already running (max ${max} on this VM): ${running.map((j) => `#${j.id}`).join(', ')}. Try again when one finishes, or .agent stop <#>._`)
  }

  const created = Date.now()
  const dir = path.join(JOBS_DIR, String(created))
  mkdirSync(path.join(dir, 'inbox'), { recursive: true })
  mkdirSync(path.join(dir, 'outbox'), { recursive: true })
  const inputs = await saveInputs(msg, path.join(dir, 'inbox'))

  // when replying to the agent inside a live conversation, it already has its own message in context
  const quoted = msg.quoted?.text
  const quotedText = quoted && !(opts.quotedIsAgent && resume) ? `\n\nThe message I replied to says:\n"""\n${quoted}\n"""` : ''
  const prompt = (task || 'Work on the attached file.') + quotedText

  const id = Number(q.insert.run(msg.chat, msg.sender, prompt, dir, 'running', created).lastInsertRowid)
  const job: Job = { id, chat: msg.chat, requester: msg.sender, prompt, dir, pid: null, status: 'running', session_id: null, created_at: created, ended_at: null }

  const claudeArgs = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', TOOLS,
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config', // no MCP connectors from your account
    '--add-dir', dir,
    '--append-system-prompt', systemPrompt(job, msg.pushName || jid.toNumber(msg.sender), inputs),
  ]
  const model = vars.get('AGENT_MODEL')
  if (model) claudeArgs.push('--model', model)
  if (resume) claudeArgs.push('--resume', resume)

  try {
    const pid = await launch(job, claudeArgs)
    q.setPid.run(pid, id)
    logger.info({ job: id, pid, resume: !!resume, inputs }, 'agent job started')
    await msg.react('⏳')
  } catch (err) {
    q.finish.run('failed', null, Date.now(), id)
    await msg.reply(`❌ ${(err as Error).message}`)
  }
}

// A plain reply (no command) to one of the agent's messages continues the conversation.
on('message', async (msg) => {
  if (process.env.AGENT_ENABLED !== 'true') return
  if (!msg.isSudo || !msg.quoted?.id || (!msg.text && !msg.hasMedia)) return
  if (msg.text && config.prefix && config.prefix.includes(msg.text.trim()[0])) return // commands go to the dispatcher
  if (!q.isAgentMessage.get(msg.quoted.id)) return
  const session = (q.sessionOfMessage.get(msg.quoted.id) as { session_id: string | null } | undefined)?.session_id ?? undefined
  await startTurn(msg, msg.text, { fresh: false, quotedIsAgent: true, session })
})
