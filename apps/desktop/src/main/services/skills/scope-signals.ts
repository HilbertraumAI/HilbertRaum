import type { Db } from '../db'
import { resolveScope } from '../collections'
import { documentsInScope } from './scope-documents'

// The conversation's in-scope DOCUMENT signals (filename + MIME), resolved MAIN-side from the
// conversationId (§22-C4 — the renderer holds the draft question, NOT the doc scope). Shared by the
// suggestion path (suggest.ts) and the S13b auto-fire decision (autofire.ts) so the two read the
// SAME signals from one definition. LOGS NOTHING — titles are content-adjacent (the §6 posture); they
// are projected MAIN-side from the shared `documentsInScope` query and never cross the IPC boundary.

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
  // `requireChunks: false`: the suggestion is keyword/MIME signal only, so an `indexed` document counts
  // even before it is chunked (it matches the run path, not the analysis handlers — X-1).
  const rows = documentsInScope(db, scope, { requireChunks: false })
  const titles = rows.map((r) => r.title)
  const mimeTypes = rows
    .map((r) => r.mimeType)
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
  return { titles, mimeTypes }
}
