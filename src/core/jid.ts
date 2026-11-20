import { isJidGroup, isLidUser, isPnUser, jidDecode, jidNormalizedUser, type GroupMetadata, type GroupParticipant } from 'baileys'
import type { WASocket } from 'baileys'

export const isGroup = (jid?: string | null): boolean => !!jid && !!isJidGroup(jid)
export const isUser = (jid?: string | null): boolean => !!jid && (!!isPnUser(jid) || !!isLidUser(jid))
export const isLid = (jid?: string | null): boolean => !!jid && !!isLidUser(jid)

/** Strip the device part and server: "9198xxx:12@s.whatsapp.net" → "9198xxx". */
export const jidUser = (jid?: string | null): string => (jid ? jidDecode(jid)?.user ?? jid.split('@')[0] : '')

/** Normalized jid without the device suffix. */
export const normalize = (jid?: string | null): string => (jid ? jidNormalizedUser(jid) : '')

/** Two jids refer to the same user (ignoring device), *within the same addressing mode*. */
export const sameUser = (a?: string | null, b?: string | null): boolean => !!a && !!b && jidUser(a) === jidUser(b)

/**
 * Extract jids from free text. Accepts phone numbers ("91 98765 43210", "+91..."),
 * full user jids and group jids. Returns normalized jids, de-duplicated.
 */
export function parseJids(text: string): string[] {
  const found = new Set<string>()
  const jidRe = /\b(\d{5,20})(?:[:.]\d+)?@(?:s\.whatsapp\.net|lid|g\.us)\b|(\d{10,}-\d+@g\.us)/g
  for (const m of text.matchAll(jidRe)) found.add(normalize(m[0]))

  const stripped = text.replace(jidRe, ' ')
  const numberRe = /\+?\d[\d\s-]{7,}\d/g
  for (const m of stripped.matchAll(numberRe)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 8 && digits.length <= 15) found.add(`${digits}@s.whatsapp.net`)
  }
  return [...found]
}

/** "91xxx@s.whatsapp.net" → "91xxx". For LIDs returns the LID number. */
export const toNumber = (jid?: string | null): string => jidUser(jid)

/**
 * Resolves between phone-number jids and LIDs using Baileys' mapping store.
 * WhatsApp now addresses many groups by LID, so a sender may show up either way.
 */
export class JidResolver {
  constructor(private readonly sock: WASocket) {}

  /** Phone-number jid for any user jid (LID or PN). Falls back to the input. */
  async toPn(jid?: string | null): Promise<string> {
    if (!jid) return ''
    const n = normalize(jid)
    if (!isLid(n)) return n
    const pn = await this.sock.signalRepository.lidMapping.getPNForLID(n).catch(() => null)
    return pn ? normalize(pn) : n
  }

  /** LID for any user jid (LID or PN). Falls back to the input. */
  async toLid(jid?: string | null): Promise<string> {
    if (!jid) return ''
    const n = normalize(jid)
    if (isLid(n)) return n
    const lid = await this.sock.signalRepository.lidMapping.getLIDForPN(n).catch(() => null)
    return lid ? normalize(lid) : n
  }

  /** Both forms when known, for mention lists. */
  async bothForms(jid: string): Promise<string[]> {
    const [pn, lid] = await Promise.all([this.toPn(jid), this.toLid(jid)])
    return [...new Set([pn, lid].filter(Boolean))]
  }

  /** True when both jids refer to the same person, across addressing modes. */
  async same(a?: string | null, b?: string | null): Promise<boolean> {
    if (!a || !b) return false
    if (sameUser(a, b)) return true
    const [pa, pb] = await Promise.all([this.toPn(a), this.toPn(b)])
    return sameUser(pa, pb)
  }
}

/** Participant whose id / phoneNumber / lid matches `jid`. */
export function findParticipant(meta: GroupMetadata, jid: string): GroupParticipant | undefined {
  const user = jidUser(jid)
  return meta.participants.find(
    (p) => jidUser(p.id) === user || jidUser(p.phoneNumber) === user || jidUser(p.lid) === user,
  )
}

export const isParticipantAdmin = (p?: GroupParticipant): boolean => !!p && (!!p.admin || !!p.isAdmin || !!p.isSuperAdmin)

export function isAdminIn(meta: GroupMetadata, jid: string): boolean {
  return isParticipantAdmin(findParticipant(meta, jid))
}

/** Phone number of a participant if known, else the LID digits. */
export const participantNumber = (p: GroupParticipant): string => jidUser(p.phoneNumber ?? (isLid(p.id) ? p.lid ?? p.id : p.id))

/** Map arbitrary user jids to the ids the group actually uses (needed for kick/promote). */
export function toParticipantIds(meta: GroupMetadata, jids: string[]): string[] {
  const ids = new Set<string>()
  for (const jid of jids) {
    const p = findParticipant(meta, jid)
    ids.add(p ? p.id : normalize(jid))
  }
  return [...ids]
}
