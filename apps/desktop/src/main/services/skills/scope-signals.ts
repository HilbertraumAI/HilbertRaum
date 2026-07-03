import type { Db } from '../db'
import { resolveScope } from '../collections'
import { documentsInScope } from './scope-documents'

// The conversation's in-scope DOCUMENT signals (filename + MIME), resolved MAIN-side from the
// conversationId (§22-C4 — the renderer holds the draft question, NOT the doc scope). Shared by the
// suggestion path (suggest.ts) and the S13b auto-fire decision (autofire.ts) so the two read the
// SAME signals from one definition. LOGS NOTHING — titles are content-adjacent (the §6 posture); they
// are projected MAIN-side from the shared `documentsInScope` query and never cross the IPC boundary.

/** Options for `inScopeDocSignals`. */
export interface DocSignalOptions {
  /**
   * U4 (audit §4.4): count a document as a signal ONLY when it is EXPLICITLY in scope — a chat
   * attachment or a hand-picked selection (`scope.documentIds`) — and drop the collection membership
   * (the whole Library / a project). Without this, "keyword + ≥1 doc signal" degrades to "keyword +
   * any matching PDF anywhere in the library", which makes auto-fire's corroboration nearly vacuous at
   * whole-corpus scope. The AUTO-FIRE decision passes `true` (silently shaping a turn demands the
   * narrowed, deliberately-scoped signal); the inert SUGGESTION offer leaves it false and keeps reading
   * the full scope (an offer on a matching library doc is harmless — the user still chooses).
   */
  explicitDocumentsOnly?: boolean
}

/** Filename + MIME signals of the indexed documents in a conversation's scope (empty-tolerant). */
export function inScopeDocSignals(
  db: Db,
  conversationId: string,
  opts: DocSignalOptions = {}
): { titles: string[]; mimeTypes: string[] } {
  if (!conversationId) return { titles: [], mimeTypes: [] }
  let scope
  try {
    scope = resolveScope(db, conversationId)
  } catch {
    // Unknown/locked conversation → keyword-only (no doc signals).
    return { titles: [], mimeTypes: [] }
  }
  if (opts.explicitDocumentsOnly) {
    // U4/§4.4: a whole-corpus (Library / collection) scope contributes NO doc signal. Narrow to the
    // EXPLICIT documents only (`resolveScope` already unions attachments into `documentIds`), and drop
    // the collection membership. With no explicit documents there is nothing to corroborate — return
    // empty directly rather than passing a documentId-less scope to `documentsInScope`, which would
    // (correctly, for retrieval) treat "no id/collection filter" as the whole unfiltered corpus.
    if (!scope.documentIds || scope.documentIds.length === 0) return { titles: [], mimeTypes: [] }
    scope = { ...scope, collectionIds: null }
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
