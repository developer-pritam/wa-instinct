/**
 * Personal money tracker: log income / expenses, see summaries, export CSV.
 * Entries live in their own `budget` table; amounts accept "1,200", "1.2k", "2.5m", "3l"/"1cr".
 */
import { command, db, vars, type Message } from '../core/index.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS budget (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    kind     TEXT    NOT NULL,            -- 'income' | 'expense'
    amount   REAL    NOT NULL,
    category TEXT    NOT NULL DEFAULT 'general',
    note     TEXT
  );
  CREATE INDEX IF NOT EXISTS budget_ts ON budget (ts);
`)

type Kind = 'income' | 'expense'
interface Entry {
  id: number
  ts: number
  kind: Kind
  amount: number
  category: string
  note: string | null
}

const insert = db.prepare('INSERT INTO budget (ts, kind, amount, category, note) VALUES (?, ?, ?, ?, ?)')
const since = db.prepare('SELECT * FROM budget WHERE ts >= ? ORDER BY ts ASC, id ASC')
const recent = db.prepare('SELECT * FROM budget ORDER BY ts DESC, id DESC LIMIT ?')
const remove = db.prepare('DELETE FROM budget WHERE id = ?')
const clearSince = db.prepare('DELETE FROM budget WHERE ts >= ?')
const clearAll = db.prepare('DELETE FROM budget')

const rowsSince = (ts: number) => since.all(ts) as unknown as Entry[]

// ---------- parsing & formatting ----------

const MULT: Record<string, number> = { k: 1e3, m: 1e6, l: 1e5, lakh: 1e5, lac: 1e5, cr: 1e7, crore: 1e7 }

/** "1,200" → 1200, "1.2k" → 1200, "₹3l" → 300000. Undefined when it isn't a number. */
export function parseAmount(raw: string): number | undefined {
  const m = /^[^\d.-]*(-?[\d,]*\.?\d+)\s*(k|m|l|lakh|lac|cr|crore)?$/i.exec(raw.trim())
  if (!m) return undefined
  const n = parseFloat(m[1].replace(/,/g, '')) * (m[2] ? MULT[m[2].toLowerCase()] : 1)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined
}

const currency = () => vars.get('CURRENCY') || '₹'
const money = (n: number) => {
  const locale = currency() === '₹' ? 'en-IN' : 'en-US'
  return `${currency()}${n.toLocaleString(locale, { maximumFractionDigits: 2 })}`
}
const day = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: process.env.TZ ?? 'Asia/Kolkata' })

type Period = 'week' | 'month' | 'year' | 'all'
const PERIODS: Period[] = ['week', 'month', 'year', 'all']

/** Start timestamp + a label for a period, using the local calendar. */
function periodStart(p: Period): { from: number; label: string } {
  const now = new Date()
  if (p === 'all') return { from: 0, label: 'All time' }
  if (p === 'year') return { from: new Date(now.getFullYear(), 0, 1).getTime(), label: String(now.getFullYear()) }
  if (p === 'week') {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
    return { from: monday.getTime(), label: `Week of ${day(monday.getTime())}` }
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  }
}

function summary(p: Period): string {
  const { from, label } = periodStart(p)
  const rows = rowsSince(from)
  if (!rows.length) return `📊 *Budget — ${label}*\n_No entries yet. Try: income 500 salary · expense 120 food lunch_`
  const total = (kind: Kind) => rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount, 0)
  const income = total('income')
  const expense = total('expense')
  const byCat = new Map<string, number>()
  for (const r of rows) if (r.kind === 'expense') byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount)
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const lines = [
    `📊 *Budget — ${label}*`,
    `💰 Income: ${money(income)}`,
    `💸 Expense: ${money(expense)}`,
    `${income - expense >= 0 ? '✅' : '🔻'} Balance: ${money(income - expense)}`,
    `_${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}_`,
  ]
  if (top.length) {
    lines.push('', '*Top expense categories*')
    top.forEach(([cat, amt], i) => lines.push(`${i + 1}. ${cat} — ${money(amt)} (${Math.round((amt / expense) * 100)}%)`))
  }
  return lines.join('\n')
}

const line = (e: Entry) =>
  `${e.kind === 'income' ? '💰' : '💸'} #${e.id} · ${day(e.ts)} · ${money(e.amount)} · ${e.category}${e.note ? ` — ${e.note}` : ''}`

// ---------- commands ----------

async function record(kind: Kind, args: string, usage: string, msg: Message) {
  const [rawAmount, category = 'general', ...rest] = args.split(/\s+/).filter(Boolean)
  const amount = rawAmount ? parseAmount(rawAmount) : undefined
  if (!amount) return msg.reply(usage)
  const note = rest.join(' ') || null
  const id = Number(insert.run(Date.now(), kind, amount, category.toLowerCase(), note).lastInsertRowid)
  const monthRows = rowsSince(periodStart('month').from)
  const monthTotal = monthRows.filter((r) => r.kind === kind).reduce((a, r) => a + r.amount, 0)
  const balance = monthRows.reduce((a, r) => a + (r.kind === 'income' ? r.amount : -r.amount), 0)
  await msg.reply(
    `${kind === 'income' ? '💰 Income' : '💸 Expense'} recorded (#${id}): *${money(amount)}* · ${category.toLowerCase()}${note ? ` — ${note}` : ''}\n` +
      `_${kind === 'income' ? 'Income' : 'Spent'} this month: ${money(monthTotal)} · Balance: ${money(balance)}_`,
  )
}

command(
  { name: 'income', desc: 'Record income', usage: '<amount> [category] [note]', category: 'misc' },
  (msg, args) => record('income', args, '_Usage: income <amount> [category] [note] · e.g. income 50k salary october_', msg),
)

command(
  { name: 'expense', aliases: ['spend'], desc: 'Record an expense', usage: '<amount> [category] [note]', category: 'misc' },
  (msg, args) => record('expense', args, '_Usage: expense <amount> [category] [note] · e.g. expense 120 food lunch_', msg),
)

command(
  {
    name: 'budget',
    desc: 'Money tracker: summary, list, delete, clear, export',
    usage: '[week|month|year|all] | list [n] | del <id> | clear month|all | export',
    category: 'misc',
  },
  async (msg, args) => {
    const [sub = 'month', arg = ''] = args.toLowerCase().split(/\s+/).filter(Boolean)

    if (PERIODS.includes(sub as Period)) return msg.reply(summary(sub as Period))

    if (sub === 'list') {
      const n = Math.min(Math.max(parseInt(arg, 10) || 10, 1), 50)
      const rows = recent.all(n) as unknown as Entry[]
      if (!rows.length) return msg.reply('_No entries yet._')
      return msg.reply(`🧾 *Last ${rows.length} entries*\n${rows.map(line).join('\n')}\n\n_budget del <id> to remove one_`)
    }

    if (sub === 'del' || sub === 'delete' || sub === 'rm') {
      const id = parseInt(arg.replace('#', ''), 10)
      if (!id) return msg.reply('_Usage: budget del <id> (ids from budget list)_')
      return msg.reply(remove.run(id).changes ? `🗑️ Entry #${id} removed.` : `_#${id} not in list._`)
    }

    if (sub === 'clear') {
      if (arg === 'month') return msg.reply(`🗑️ Cleared ${clearSince.run(periodStart('month').from).changes} entries from this month.`)
      if (arg === 'all') return msg.reply(`🗑️ Cleared ${clearAll.run().changes} entries.`)
      return msg.reply('_Usage: budget clear month|all_')
    }

    if (sub === 'export' || sub === 'csv') {
      const rows = rowsSince(0)
      if (!rows.length) return msg.reply('_Nothing to export._')
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const csv = ['id,date,kind,amount,category,note']
        .concat(rows.map((r) => [r.id, new Date(r.ts).toISOString(), r.kind, r.amount, q(r.category), q(r.note)].join(',')))
        .join('\n')
      const stamp = new Date().toISOString().slice(0, 10)
      return msg.reply({ document: Buffer.from(csv, 'utf8'), mimetype: 'text/csv', fileName: `budget-${stamp}.csv`, caption: `📄 ${rows.length} entries` })
    }

    return msg.reply('_Usage: budget [week|month|year|all] · budget list [n] · budget del <id> · budget clear month|all · budget export_')
  },
)
