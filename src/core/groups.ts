import NodeCache from 'node-cache'
import type { GroupMetadata, WASocket } from 'baileys'

/** Group metadata cache so every command doesn't hit WhatsApp again. */
const cache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

export async function getGroupMetadata(sock: WASocket, jid: string, fresh = false): Promise<GroupMetadata> {
  if (!fresh) {
    const hit = cache.get<GroupMetadata>(jid)
    if (hit) return hit
  }
  const meta = await sock.groupMetadata(jid)
  cache.set(jid, meta)
  return meta
}

export const cachedGroupMetadata = (jid: string) => cache.get<GroupMetadata>(jid)
export const setGroupMetadata = (meta: GroupMetadata) => cache.set(meta.id, meta)
export const invalidateGroup = (jid: string) => cache.del(jid)
