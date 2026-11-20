import type { WASocket } from 'baileys'
import { schedules, type Schedule } from './db.js'
import { logger } from './logger.js'

/**
 * Minimal 5-field cron matcher: "min hour day month weekday".
 * Supports "*", numbers, lists "1,2", ranges "1-5" and steps "* /5".
 */
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepStr] = part.split('/')
    const step = stepStr ? Number(stepStr) : 1
    let lo: number, hi: number
    if (range === '*') [lo, hi] = [min, max]
    else if (range.includes('-')) [lo, hi] = range.split('-').map(Number)
    else [lo, hi] = [Number(range), stepStr ? max : Number(range)]
    return value >= lo && value <= hi && (value - lo) % step === 0
  })
}

export function cronMatches(cron: string, date = new Date()): boolean {
  const [min, hour, day, month, weekday] = cron.trim().split(/\s+/)
  if (!min || !hour || !day || !month || !weekday) return false
  return (
    fieldMatches(min, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(day, date.getDate(), 1, 31) &&
    fieldMatches(month, date.getMonth() + 1, 1, 12) &&
    fieldMatches(weekday.replace(/\b7\b/g, '0'), date.getDay(), 0, 6) // 7 = Sunday alias
  )
}

export type ScheduleRunner = (schedule: Schedule, sock: WASocket) => Promise<void>
const runners = new Map<Schedule['kind'], ScheduleRunner>()

/** Plugins register how to execute each schedule kind. */
export const registerScheduleRunner = (kind: Schedule['kind'], runner: ScheduleRunner) => runners.set(kind, runner)

let timer: NodeJS.Timeout | undefined
let lastMinute = -1

/** Tick once a minute and run every enabled schedule whose cron matches. */
export function startScheduler(getSock: () => WASocket | undefined) {
  if (timer) clearInterval(timer)
  timer = setInterval(async () => {
    const now = new Date()
    const minuteKey = Math.floor(now.getTime() / 60_000)
    if (minuteKey === lastMinute) return
    lastMinute = minuteKey
    const sock = getSock()
    if (!sock) return
    for (const s of schedules.all()) {
      if (!s.enabled || !cronMatches(s.cron, now)) continue
      const run = runners.get(s.kind)
      if (!run) continue
      try {
        await run(s, sock)
        if (s.payload.once) schedules.del(s.id)
      } catch (err) {
        logger.error({ err, schedule: s }, 'schedule failed')
      }
    }
  }, 15_000)
}
