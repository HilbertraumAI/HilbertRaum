import type { Db } from '../db'
import { resolveScope } from '../collections'
import { buildScopeFilter } from '../retrieval-scope'

// The conversation's in-scope DOCUMENT signals (filename + MIME), resolved MAIN-side from the
// conversationId (§22-C4 — the renderer holds the draft question, NOT the doc scope). Shared by the
// suggestion path (suggest.ts) and the S13b auto-fire decision (autofire.ts) so the two read the
// SAME signals from one definition. LOGS NOTHING — titles are content-adjacent (the §6 posture).

/** Filename + MIME signals of the indexed documents in a conversation's scope (empty-tolerant). */
export function inScopeDocSignals(db: Db, conversationId: string): { titles: string[]; mimeTypes: string[] } {
  if (!conversationId) return { titles: [], mimeTypes: [] }
  let scope
  try {
    scope = resolveScope(db, conversationId)
  } catch {
    // Unknown/locked conversation → keyword-only (no doc signals).
    return { titles: [], mimeTypes: [] }
  }
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  const rows = db
    .prepare(
      `SELECT d.title AS title, d.mime_type AS mime FROM documents d
       WHERE d.status = 'indexed'${where}`
    )
    .all(...params) as Array<{ title: string; mime: string | null }>
  const titles = rows.map((r) => r.title)
  const mimeTypes = rows.map((r) => r.mime).filter((m): m is string => typeof m === 'string' && m.length > 0)
  return { titles, mimeTypes }
}
