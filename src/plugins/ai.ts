/**
 * `.ai <request>` handled by Claude Code (the `claude` CLI logged in on this machine), so it
 * runs on your existing Claude login with no API key. It can answer questions (with web search)
 * and *do things* by running the bot's own commands through the `run_command` tool (_ai-tools.ts):
 * ".ai make this a sticker", ".ai kick @x and tell the group why".
 *
 * Safety: a WhatsApp message must not become a shell on the VM. Claude Code runs with only
 * WebSearch/WebFetch plus our MCP tool (no Bash, no file edits, no other MCP servers), in its own
 * empty folder (data/ai). The command is sudo-only, and process/permission commands are blocked
 * for the assistant (see AI_BLOCKED). Each chat keeps one conversation (resumed with --resume)
 * until `.ai reset` or 30 minutes of silence.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, chatSettings, command, config, jid, logger, vars, type Message } from '../core/index.js'
import { AI_BLOCKED, TOOL_RULE, commandCatalog, openToolSession } from './_ai-tools.js'

const WORK_DIR = path.join(DATA_DIR, 'ai')
const TOOLS = 'WebSearch,WebFetch'
const SESSION_TTL = 30 * 60 * 1000
const TIMEOUT = 5 * 60 * 1000
const MAX_REPLY = 4000

const STYLE = [
  'You are the assistant inside a WhatsApp bot, talking to the account owner (or someone they trust).',
  'Be concise: a few short paragraphs at most. Use WhatsApp formatting only: *bold*, _italic_, ~strike~, ```code```.',
  'No markdown headings, tables or [links](url): write plain URLs.',
  'Use web search when the question needs current information.',
].join(' ')

const TOOLS_GUIDE = `
You can act in this chat with the run_command tool: it runs one bot command exactly as if the user typed it.
- Commands work on the message the user replied to (its media or text) and on the users they @mentioned; pass extra text as \`args\`, as the user would type after the command name.
- When the user asks you to do something a command can do, run it. Don't explain how to use commands unless asked.
- Commands post their own output to the chat. A file one command produces can't be fed into another command.
- If a command fails, say why in one line. Don't retry the same thing more than once.
- Destructive actions (kick, demote, delete, block, leave a group, clear) only when the user clearly asked for them.
- When the commands you ran already did everything, reply with exactly DONE. Otherwise reply normally.
- These commands exist but only the user may run them (tell them to type it, e.g. ".restart"): ${[...AI_BLOCKED].filter((c) => c !== 'ai').join(', ')}.

Bot commands (name usage [category] description):
`

/** What Claude needs to know about where it is and what the user pointed at. */
async function situation(msg: Message): Promise<string> {
  const lines: string[] = []
  if (msg.isGroup) {
    const meta = await msg.groupMetadata().catch(() => undefined)
    lines.push(`Chat: group "${meta?.subject ?? msg.chat}" (${meta?.participants.length ?? '?'} members). Bot is admin: ${await msg.isBotAdmin().catch(() => false)}.`)
  } else {
    lines.push(`Chat: private chat with ${jid.toNumber(msg.chat)}.`)
  }
  lines.push(`Asked by: ${msg.pushName || jid.toNumber(msg.sender)} (+${jid.toNumber(msg.sender)}).`)
  const q = msg.quoted
  if (q) {
    const what = q.type === 'text' ? 'a text message' : `a ${q.isAnimatedSticker ? 'animated ' : ''}${q.type}${q.isVoiceNote ? ' (voice note)' : ''}`
    lines.push(`They replied to ${what} from +${jid.toNumber(q.sender)}${q.text ? `: "${q.text.slice(0, 1500)}"` : '.'}`)
  }
  if (msg.mentions.length) {
    const nums = await Promise.all(msg.mentions.map(async (m) => `+${jid.toNumber(await msg.jids.toPn(m))}`))
    lines.push(`They @mentioned: ${nums.join(', ')}.`)
  }
  lines.push(`Command prefix: "${config.prefix[0] ?? ''}".`)
  return lines.join('\n')
}

mkdirSync(WORK_DIR, { recursive: true })

function claudeBin(): string {
  const configured = vars.get('CLAUDE_BIN')
  if (configured) return configured
  const local = path.join(os.homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

interface ClaudeResult {
  result?: string
  session_id?: string
  is_error?: boolean
  subtype?: string
}

/** Run one headless Claude Code turn. Resolves with the parsed JSON result. */
function runClaude(prompt: string, opts: { system: string; mcpConfig: string; sessionId?: string }): Promise<ClaudeResult> {
  const { system, mcpConfig, sessionId } = opts
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--tools', TOOLS, // built-in tools; our MCP tool comes from --mcp-config
    '--allowedTools', `${TOOLS},${TOOL_RULE}`,
    '--permission-mode', 'dontAsk',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--append-system-prompt', system,
  ]
  const model = vars.get('AI_MODEL')
  if (model) args.push('--model', model)
  if (sessionId) args.push('--resume', sessionId)

  return new Promise((resolve, reject) => {
    // stdin must be closed, or `claude -p` waits for piped input
    const child = spawn(claudeBin(), args, {
      cwd: WORK_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      // downloads and video edits can take minutes
      env: { ...process.env, MCP_TOOL_TIMEOUT: String(TIMEOUT) },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`can't start Claude Code (${e.message}); set CLAUDE_BIN with .setvar`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (signal) return reject(new Error('Claude Code took too long'))
      try {
        resolve(JSON.parse(out) as ClaudeResult)
      } catch {
        reject(new Error((err || out).trim().split('\n').pop() || `Claude Code exited with ${code}`))
      }
    })
  })
}

/** Convert stray markdown into WhatsApp formatting and keep it under the message limit. */
export function toWhatsApp(text: string): string {
  let t = text
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .trim()
  if (t.length > MAX_REPLY) t = `${t.slice(0, MAX_REPLY)}…`
  return t
}

interface Session {
  id: string
  at: number
}
const busy = new Set<string>()

command(
  {
    name: 'ai',
    aliases: ['ask', 'claude'],
    desc: 'Ask Claude anything, or tell it what to do; it can run the bot commands for you',
    usage: '<request> | reset',
    category: 'ai',
  },
  async (msg, args, ctx) => {
    const { sock } = ctx
    const question = args.trim()
    if (question.toLowerCase() === 'reset') {
      chatSettings.del(msg.chat, 'ai_session')
      return msg.reply('_New conversation started._')
    }
    if (!question && !msg.quoted) return msg.reply('_Usage: ai <request> · reply to a message with .ai to ask about or act on it · ai reset_')
    if (busy.has(msg.chat)) return msg.reply('_Still thinking about the last one…_')

    // the replied-to message and mentions are described in the system prompt (situation())
    const prompt = question || 'Explain the message I replied to.'
    const saved = chatSettings.get<Session | null>(msg.chat, 'ai_session', null)
    const sessionId = saved && Date.now() - saved.at < SESSION_TTL ? saved.id : undefined

    busy.add(msg.chat)
    await sock.sendPresenceUpdate('composing', msg.chat).catch(() => {})
    const tools = await openToolSession(msg, ctx)
    try {
      const system = `${STYLE}\n\n${await situation(msg)}\n${TOOLS_GUIDE}${commandCatalog()}`
      const res = await runClaude(prompt, { system, mcpConfig: tools.mcpConfig, sessionId }).catch(async (err) => {
        // a resumed session can vanish (e.g. cleaned up); start fresh once
        if (!sessionId) throw err
        logger.warn({ err }, 'ai resume failed, starting a new session')
        return runClaude(prompt, { system, mcpConfig: tools.mcpConfig })
      })
      if (res.is_error || !res.result) throw new Error(res.result || res.subtype || 'no answer')
      if (res.session_id) chatSettings.set(msg.chat, 'ai_session', { id: res.session_id, at: Date.now() } satisfies Session)
      // commands already posted their results; skip a redundant "done" message
      if (/^\s*DONE[.!]?\s*$/i.test(res.result)) await msg.react('✅')
      else await msg.reply(toWhatsApp(res.result))
    } catch (err) {
      logger.error({ err }, 'ai failed')
      await msg.reply(`❌ ${(err as Error).message}`)
    } finally {
      tools.close()
      busy.delete(msg.chat)
      await sock.sendPresenceUpdate('paused', msg.chat).catch(() => {})
    }
  },
)

const MODEL_VARS = { ai: 'AI_MODEL', agent: 'AGENT_MODEL' } as const
// aliases Claude Code understands, or a full model id like claude-opus-5-5
const VALID_MODEL = /^(sonnet|opus|haiku|claude-[a-z0-9.-]+)(\[1m\])?$/i

command(
  {
    name: 'model',
    desc: 'Show or change the Claude model for .ai and .agent (saved, survives restarts)',
    usage: '[ai|agent <sonnet|opus|haiku|model-id>]',
    category: 'ai',
  },
  async (msg, args) => {
    const [target = '', name = ''] = args.trim().toLowerCase().split(/\s+/)
    if (!target) {
      return msg.reply(
        `*Claude models*\n.ai → ${vars.get('AI_MODEL')}\n.agent → ${vars.get('AGENT_MODEL')}\n\n_Change: model ai haiku · model agent claude-opus-5-5_`,
      )
    }
    if (!(target in MODEL_VARS) || !name) return msg.reply('_Usage: model ai <name> · model agent <name> (sonnet, opus, haiku, or an id like claude-opus-5-5)_')
    if (!VALID_MODEL.test(name)) return msg.reply(`_"${name}" doesn't look like a Claude model. Use sonnet, opus, haiku, or an id like claude-sonnet-5-5._`)
    vars.set(MODEL_VARS[target as keyof typeof MODEL_VARS], name)
    await msg.reply(`✅ .${target} now uses *${name}* (applies to the next request).`)
  },
)
