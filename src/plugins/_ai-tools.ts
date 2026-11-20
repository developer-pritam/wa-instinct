/**
 * Lets Claude Code (spawned by `.ai`) run the bot's own commands, via a tiny MCP server inside
 * the bot process. Not a plugin; the loader skips `_` files.
 *
 * Each `.ai` call opens a "job": a one-time bearer token tied to that WhatsApp message. Claude's
 * `run_command` tool runs a command as if the user had typed it in that chat: same replied-to
 * message, same @mentions, same chat. Whatever the command sends is recorded and returned to Claude.
 * The server listens on 127.0.0.1 only and rejects requests without a live token.
 */
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AnyMessageContent } from 'baileys'
import { z } from 'zod'
import { executeCommand } from '../core/dispatcher.js'
import { commands, findCommand, logger, type Context, type Message, type Sendable } from '../core/index.js'

/** Commands the AI may not run: process control, permissions, and itself. */
export const AI_BLOCKED = new Set(['ai', 'shutdown', 'restart', 'update', 'setsudo', 'delsudo', 'setvar', 'delvar', 'tog', 'allow', 'model'])

export const SERVER_NAME = 'wa'
/** Permission rule that allows every tool from our server (`mcp__<server>`). */
export const TOOL_RULE = `mcp__${SERVER_NAME}`

interface Job {
  msg: Message
  ctx: Context
  /** What commands sent to the chat during this job, for the final summary. */
  sent: string[]
}

const jobs = new Map<string, Job>()
let port: number | undefined

/** Short description of an outgoing message for Claude. */
function describe(content: Sendable): string {
  if (typeof content === 'string') return content
  const c = content as Record<string, unknown>
  for (const kind of ['image', 'video', 'audio', 'sticker', 'document']) {
    if (c[kind]) return `[${kind}${c.caption ? `: ${String(c.caption)}` : ''}]`
  }
  if (c.text) return String(c.text)
  if (c.react) return '[reaction]'
  if (c.poll) return '[poll]'
  if (c.delete) return '[deleted a message]'
  return '[message]'
}

/** A view of `msg` that records everything a command sends through it. */
function recording(msg: Message, sent: string[]): Message {
  const view = Object.create(msg) as Message
  view.send = (content: Sendable | AnyMessageContent, opts = {}, jid?: string) => {
    sent.push(describe(content as Sendable).slice(0, 500))
    return Object.getPrototypeOf(msg).send.call(view, content, opts, jid)
  }
  return view
}

function buildServer(job: Job): McpServer {
  const server = new McpServer({ name: 'wa-instinct', version: '1.0.0' })

  server.registerTool(
    'run_command',
    {
      description:
        'Run one of the WhatsApp bot commands in the current chat, exactly as if the user typed `.<command> <args>`. ' +
        'It uses the message the user replied to (media, text) and the users they @mentioned. ' +
        'Its output is sent straight to the chat; this returns what was sent.',
      inputSchema: {
        command: z.string().describe('Command name without the prefix, e.g. "sticker", "kick", "song"'),
        args: z.string().optional().describe('Text after the command, as the user would type it'),
      },
    },
    async ({ command: name, args = '' }) => {
      const command = findCommand(name.replace(/^[.!,]/, ''))
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
      if (!command) return fail(`No command "${name}". Check the command list.`)
      if (AI_BLOCKED.has(command.name)) return fail(`"${command.name}" can't be run by the assistant; ask the user to run it themselves.`)

      const sent: string[] = []
      const outcome = await executeCommand(recording(job.msg, sent), command, args.trim(), job.ctx, { react: false })
      job.sent.push(...sent)
      const output = sent.length ? `Sent to the chat:\n${sent.map((s) => `- ${s}`).join('\n')}` : 'Nothing was sent to the chat.'
      if (!outcome.ok) return fail(`${command.name} failed: ${outcome.reason}\n${output}`)
      return { content: [{ type: 'text' as const, text: `${command.name} ran.\n${output}` }] }
    },
  )

  return server
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const job = token ? jobs.get(token) : undefined
  if (!job) {
    res.writeHead(401).end()
    return
  }
  if (req.method !== 'POST') {
    // stateless server: no SSE stream or session to resume
    res.writeHead(405, { allow: 'POST' }).end()
    return
  }
  const server = buildServer(job)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}

async function ensureServer(): Promise<number> {
  if (port) return port
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err }, 'ai tools request failed')
      if (!res.headersSent) res.writeHead(500).end()
    })
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  port = (srv.address() as AddressInfo).port
  return port
}

/**
 * Open a tool session for one `.ai` call. Pass `mcpConfig` to `claude --mcp-config`,
 * and call `close()` when the call ends so the token stops working.
 */
export async function openToolSession(msg: Message, ctx: Context) {
  const p = await ensureServer()
  const token = randomBytes(24).toString('hex')
  const job: Job = { msg, ctx, sent: [] }
  jobs.set(token, job)
  const mcpConfig = JSON.stringify({
    mcpServers: { [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${p}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
  })
  return { mcpConfig, job, close: () => jobs.delete(token) }
}

/** One line per command the assistant may run, for its system prompt. */
export function commandCatalog(): string {
  return commands
    .filter((c) => !c.hidden && !AI_BLOCKED.has(c.name))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((c) => {
      const flags = [c.groupOnly && 'groups only', c.botAdmin && 'bot must be admin'].filter(Boolean).join(', ')
      return `${c.name}${c.usage ? ` ${c.usage}` : ''} [${c.category}] ${c.desc ?? ''}${flags ? ` (${flags})` : ''}`
    })
    .join('\n')
}
