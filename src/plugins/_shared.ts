/**
 * Helpers shared by a few plugins. The leading underscore keeps the loader from importing it as a plugin.
 */
import type { WAMessage } from 'baileys'

/**
 * Messages stored as JSON lose their Buffers (`{ type: 'Buffer', data: [...] }`), which breaks
 * forwarding media (empty mediaKey). Walk the object and turn them back into Buffers in place.
 */
export function reviveBuffers<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const v = obj[key] as { type?: string; data?: number[] } | null
    if (v && typeof v === 'object') {
      if (v.type === 'Buffer' && Array.isArray(v.data)) obj[key] = Buffer.from(v.data)
      else reviveBuffers(v)
    }
  }
  return value
}

/** A stored WAMessage, ready to be forwarded. */
export const reviveMessage = (m: WAMessage | undefined): WAMessage | undefined => (m ? reviveBuffers(m) : undefined)
