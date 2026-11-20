import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { BufferJSON } from 'baileys'
import { DATA_DIR, VAR_DEFAULTS } from '../config.js'

mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'bot.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS vars (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_settings (
    jid   TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,          -- JSON
    PRIMARY KEY (jid, key)
  );
  CREATE TABLE IF NOT EXISTS warns (
    jid   TEXT NOT NULL,
    user  TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (jid, user)
  );
  CREATE TABLE IF NOT EXISTS filters (
    scope   TEXT NOT NULL,        -- group jid | 'global' | 'personal'
    pattern TEXT NOT NULL,
    reply   TEXT NOT NULL,
    PRIMARY KEY (scope, pattern)
  );
  CREATE TABLE IF NOT EXISTS msg_stats (
    jid     TEXT NOT NULL,
    user    TEXT NOT NULL,
    name    TEXT,
    total   INTEGER NOT NULL DEFAULT 0,
    counts  TEXT NOT NULL DEFAULT '{}',   -- JSON: { text: n, image: n, ... }
    last_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (jid, user)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id     TEXT PRIMARY KEY,
    jid    TEXT NOT NULL,
    sender TEXT,
    ts     INTEGER NOT NULL,
    data   TEXT NOT NULL          -- JSON WAMessage
  );
  CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
  CREATE TABLE IF NOT EXISTS sticker_commands (
    hash TEXT PRIMARY KEY,
    cmd  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    jid     TEXT NOT NULL,
    kind    TEXT NOT NULL,        -- 'message' | 'mute' | 'unmute'
    cron    TEXT NOT NULL,
    payload TEXT NOT NULL,        -- JSON
    enabled INTEGER NOT NULL DEFAULT 1
  );
`)

// ---------- runtime vars (setvar / getvar) ----------

const varGet = db.prepare('SELECT value FROM vars WHERE key = ?')
const varSet = db.prepare('INSERT INTO vars (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
const varDel = db.prepare('DELETE FROM vars WHERE key = ?')
const varAll = db.prepare('SELECT key, value FROM vars')

export const vars = {
  /** Value from DB, else env default, else ''. Keys are upper-cased. */
  get(key: string): string {
    key = key.toUpperCase()
    const row = varGet.get(key) as { value: string } | undefined
    return row?.value ?? VAR_DEFAULTS[key] ?? process.env[key] ?? ''
  },
  /** `true` when the var is "true"/"on"/"1". */
  bool(key: string): boolean {
    return ['true', 'on', '1', 'yes'].includes(vars.get(key).toLowerCase())
  },
  int(key: string, fallback = 0): number {
    const n = parseInt(vars.get(key), 10)
    return Number.isNaN(n) ? fallback : n
  },
  set(key: string, value: string) {
    varSet.run(key.toUpperCase(), value)
  },
  del(key: string) {
    varDel.run(key.toUpperCase())
  },
  /** Every known var: defaults merged with DB overrides. */
  all(): Record<string, string> {
    const out: Record<string, string> = { ...VAR_DEFAULTS }
    for (const row of varAll.all() as { key: string; value: string }[]) out[row.key] = row.value
    return out
  },
}

// ---------- sudo list (var SUDO, seeded from .env) ----------

/** Numbers (digits only) allowed to run every command, besides your own account. */
export const sudo = {
  list(): string[] {
    return [...new Set(vars.get('SUDO').split(/[,\s]+/).map((n) => n.replace(/\D/g, '')).filter(Boolean))]
  },
  has(number: string): boolean {
    return sudo.list().includes(number)
  },
  add(number: string) {
    vars.set('SUDO', [...new Set([...sudo.list(), number])].join(','))
  },
  /** Returns false if the number wasn't in the list. */
  remove(number: string): boolean {
    const list = sudo.list()
    if (!list.includes(number)) return false
    vars.set('SUDO', list.filter((n) => n !== number).join(','))
    return true
  },
}

// ---------- per-chat JSON settings ----------

const csGet = db.prepare('SELECT value FROM chat_settings WHERE jid = ? AND key = ?')
const csSet = db.prepare(
  'INSERT INTO chat_settings (jid, key, value) VALUES (?, ?, ?) ON CONFLICT(jid, key) DO UPDATE SET value = excluded.value',
)
const csDel = db.prepare('DELETE FROM chat_settings WHERE jid = ? AND key = ?')
const csAllForKey = db.prepare('SELECT jid, value FROM chat_settings WHERE key = ?')

export const chatSettings = {
  get<T>(jid: string, key: string, fallback: T): T {
    const row = csGet.get(jid, key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  },
  set(jid: string, key: string, value: unknown) {
    csSet.run(jid, key, JSON.stringify(value))
  },
  /** Shallow-merge `patch` into the existing object value. */
  update<T extends object>(jid: string, key: string, patch: Partial<T>, fallback: T): T {
    const next = { ...chatSettings.get<T>(jid, key, fallback), ...patch }
    chatSettings.set(jid, key, next)
    return next
  },
  del(jid: string, key: string) {
    csDel.run(jid, key)
  },
  allForKey<T>(key: string): { jid: string; value: T }[] {
    return (csAllForKey.all(key) as { jid: string; value: string }[]).map((r) => ({
      jid: r.jid,
      value: JSON.parse(r.value) as T,
    }))
  },
}

// ---------- warns ----------

const warnGet = db.prepare('SELECT count FROM warns WHERE jid = ? AND user = ?')
const warnSet = db.prepare(
  'INSERT INTO warns (jid, user, count) VALUES (?, ?, ?) ON CONFLICT(jid, user) DO UPDATE SET count = excluded.count',
)
const warnDel = db.prepare('DELETE FROM warns WHERE jid = ? AND user = ?')

export const warns = {
  get(jid: string, user: string): number {
    return (warnGet.get(jid, user) as { count: number } | undefined)?.count ?? 0
  },
  /** Increments and returns the new count. */
  add(jid: string, user: string): number {
    const next = warns.get(jid, user) + 1
    warnSet.run(jid, user, next)
    return next
  },
  set(jid: string, user: string, count: number) {
    if (count <= 0) warnDel.run(jid, user)
    else warnSet.run(jid, user, count)
  },
  reset(jid: string, user: string) {
    warnDel.run(jid, user)
  },
}

// ---------- filters (auto replies) ----------

const filterList = db.prepare('SELECT pattern, reply FROM filters WHERE scope = ?')
const filterSet = db.prepare(
  'INSERT INTO filters (scope, pattern, reply) VALUES (?, ?, ?) ON CONFLICT(scope, pattern) DO UPDATE SET reply = excluded.reply',
)
const filterDel = db.prepare('DELETE FROM filters WHERE scope = ? AND pattern = ?')

export const filters = {
  list(scope: string): { pattern: string; reply: string }[] {
    return filterList.all(scope) as { pattern: string; reply: string }[]
  },
  set(scope: string, pattern: string, reply: string) {
    filterSet.run(scope, pattern, reply)
  },
  /** Returns true if something was deleted. */
  del(scope: string, pattern: string): boolean {
    return filterDel.run(scope, pattern).changes > 0
  },
}

// ---------- message statistics (msgs / inactive) ----------

const statGet = db.prepare('SELECT * FROM msg_stats WHERE jid = ? AND user = ?')
const statAll = db.prepare('SELECT * FROM msg_stats WHERE jid = ? ORDER BY total DESC')
const statUpsert = db.prepare(`
  INSERT INTO msg_stats (jid, user, name, total, counts, last_at) VALUES (?, ?, ?, 1, ?, ?)
  ON CONFLICT(jid, user) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    total = total + 1,
    counts = excluded.counts,
    last_at = excluded.last_at
`)
const statDelUser = db.prepare('DELETE FROM msg_stats WHERE jid = ? AND user = ?')
const statDelChat = db.prepare('DELETE FROM msg_stats WHERE jid = ?')

export interface MsgStat {
  jid: string
  user: string
  name: string | null
  total: number
  counts: Record<string, number>
  last_at: number
}

const parseStat = (row: Record<string, unknown>): MsgStat => ({
  ...(row as Omit<MsgStat, 'counts'>),
  counts: JSON.parse(row.counts as string) as Record<string, number>,
})

export const msgStats = {
  record(jid: string, user: string, name: string | undefined, type: string) {
    const current = statGet.get(jid, user) as Record<string, unknown> | undefined
    const counts = current ? (JSON.parse(current.counts as string) as Record<string, number>) : {}
    counts[type] = (counts[type] ?? 0) + 1
    statUpsert.run(jid, user, name ?? null, JSON.stringify(counts), Date.now())
  },
  get(jid: string, user: string): MsgStat | undefined {
    const row = statGet.get(jid, user) as Record<string, unknown> | undefined
    return row ? parseStat(row) : undefined
  },
  all(jid: string): MsgStat[] {
    return (statAll.all(jid) as Record<string, unknown>[]).map(parseStat)
  },
  reset(jid: string, user?: string) {
    if (user) statDelUser.run(jid, user)
    else statDelChat.run(jid)
  },
}

// ---------- recent message store (anti-delete, anti-edit, retries) ----------

const msgPut = db.prepare('INSERT OR REPLACE INTO messages (id, jid, sender, ts, data) VALUES (?, ?, ?, ?, ?)')
const msgGet = db.prepare('SELECT data FROM messages WHERE id = ?')
const msgPrune = db.prepare('DELETE FROM messages WHERE ts < ?')

export const messageStore = {
  put(id: string, jid: string, sender: string | undefined, data: unknown) {
    // BufferJSON keeps media keys etc. as real Buffers across the JSON round-trip
    msgPut.run(id, jid, sender ?? null, Date.now(), JSON.stringify(data, BufferJSON.replacer))
  },
  get<T>(id: string): T | undefined {
    const row = msgGet.get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data, BufferJSON.reviver) as T) : undefined
  },
  /** Drop anything older than `maxAgeMs` (default 48h). */
  prune(maxAgeMs = 48 * 60 * 60 * 1000) {
    msgPrune.run(Date.now() - maxAgeMs)
  },
}

// ---------- sticker commands ----------

const scGet = db.prepare('SELECT cmd FROM sticker_commands WHERE hash = ?')
const scSet = db.prepare('INSERT OR REPLACE INTO sticker_commands (hash, cmd) VALUES (?, ?)')
const scDelHash = db.prepare('DELETE FROM sticker_commands WHERE hash = ?')
const scDelCmd = db.prepare('DELETE FROM sticker_commands WHERE cmd = ?')
const scAll = db.prepare('SELECT hash, cmd FROM sticker_commands')

export const stickerCommands = {
  get(hash: string): string | undefined {
    return (scGet.get(hash) as { cmd: string } | undefined)?.cmd
  },
  set(hash: string, cmd: string) {
    scSet.run(hash, cmd)
  },
  delByHash(hash: string): boolean {
    return scDelHash.run(hash).changes > 0
  },
  delByCmd(cmd: string): boolean {
    return scDelCmd.run(cmd).changes > 0
  },
  all(): { hash: string; cmd: string }[] {
    return scAll.all() as { hash: string; cmd: string }[]
  },
}

// ---------- schedules ----------

export interface Schedule {
  id: number
  jid: string
  kind: 'message' | 'mute' | 'unmute'
  cron: string
  payload: Record<string, unknown>
  enabled: boolean
}

const schAll = db.prepare('SELECT * FROM schedules')
const schForChat = db.prepare('SELECT * FROM schedules WHERE jid = ?')
const schInsert = db.prepare('INSERT INTO schedules (jid, kind, cron, payload, enabled) VALUES (?, ?, ?, ?, 1)')
const schDel = db.prepare('DELETE FROM schedules WHERE id = ?')
const schDelChat = db.prepare('DELETE FROM schedules WHERE jid = ?')
const schDelKind = db.prepare('DELETE FROM schedules WHERE jid = ? AND kind = ?')
const schEnable = db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?')

const parseSchedule = (row: Record<string, unknown>): Schedule => ({
  id: row.id as number,
  jid: row.jid as string,
  kind: row.kind as Schedule['kind'],
  cron: row.cron as string,
  payload: JSON.parse(row.payload as string) as Record<string, unknown>,
  enabled: !!row.enabled,
})

export const schedules = {
  all: () => (schAll.all() as Record<string, unknown>[]).map(parseSchedule),
  forChat: (jid: string) => (schForChat.all(jid) as Record<string, unknown>[]).map(parseSchedule),
  add(jid: string, kind: Schedule['kind'], cron: string, payload: Record<string, unknown>): number {
    return Number(schInsert.run(jid, kind, cron, JSON.stringify(payload)).lastInsertRowid)
  },
  del: (id: number) => schDel.run(id).changes > 0,
  delForChat: (jid: string, kind?: Schedule['kind']) =>
    (kind ? schDelKind.run(jid, kind) : schDelChat.run(jid)).changes,
  enable: (id: number, enabled: boolean) => schEnable.run(enabled ? 1 : 0, id).changes > 0,
}
