import type { Db } from '../db'
import { corpusGeneration } from '../db'
import type { RetrievalScope } from '../../../shared/types'
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

// F-29 (audit 2026-07-16) — resident cache for the SUGGESTION path's doc signals.
// `suggestSkills` fires on every debounced composer pause (ChatScreen 400 ms) plus every picker open,
// and a default install ships doc-signal skills (bank/invoice declare filenamePatterns/mimeTypes), so
// the SUGGESTION path re-materializes the in-scope `indexed` title+MIME set — for the common Library
// scope a scan of every indexed row + an unindexed `created_at` sort + a JS marshal of every row — on
// each keystroke pause even though the corpus is unchanged between imports. A tiny resident cache
// (single entry per Db — the resident-cache idiom, WeakMap-scoped so it GCs with the connection and
// never crosses workspaces or leaks between tests) keyed by the resolved SCOPE plus the connection's
// corpus GENERATION (`corpusGeneration` in db.ts) returns the identical projected signals on a hit. The
// generation is read each call and moves on every write that can change the set or its signals — an
// import, a delete, an index-status change, an archive toggle, a membership add/remove — because TEMP
// triggers on `documents` and `document_collections` count them, whichever code path wrote. #581: the key
// was a `(COUNT, MAX(rowid))` signature over the `indexed` documents and over `document_collections`. Both
// are rowid tables, so deleting the newest row and adding another reused the freed rowid and the signature
// repeated (a Library chat kept the deleted document's title and missed the new one); an archive toggle or
// a status swap below the highest row never moved it at all. The AUTO-FIRE path (`explicitDocumentsOnly`)
// is NEVER cached — it is narrowed to explicit ids (already cheap) and must read live. The cache sits
// STRICTLY ABOVE `documentsInScope`; that shared helper's semantics are untouched (audit caution: never
// memoize inside it — ~13 call sites across three layers depend on its live, deterministic result).
interface ResidentSignals {
  key: string
  titles: string[]
  mimeTypes: string[]
}
const residentByDb = new WeakMap<Db, ResidentSignals>()
const materializationsByDb = new WeakMap<Db, number>()

/** Test probe (F-29): how many times the suggestion signals were actually MATERIALIZED (cache misses)
 *  for this db — a stable, in-suite render-count analogue. See the header note. */
export function __suggestSignalMaterializations(db: Db): number {
  return materializationsByDb.get(db) ?? 0
}

/** Deterministic fingerprint of a resolved scope's id-union (order-independent) and its archive bit.
 *  Carries the #301 P4 deny-all bit too: a documents-off scope resolves to the same null ids as the
 *  explicit whole-corpus scope, and without the bit the per-Db memo would hand a documents-off chat the
 *  whole-corpus title/MIME signals (retrieval itself is fail-closed through `buildScopeFilter`). */
function scopeFingerprint(scope: RetrievalScope): string {
  const c = [...(scope.collectionIds ?? [])].sort().join(',')
  const d = [...(scope.documentIds ?? [])].sort().join(',')
  return `c:${c}|d:${d}|a:${scope.includeArchived ? 1 : 0}|n:${scope.noDocuments ? 1 : 0}`
}

/** Project the in-scope indexed documents to their filename + MIME signals (empty-tolerant). */
function projectSignals(db: Db, scope: RetrievalScope): { titles: string[]; mimeTypes: string[] } {
  // `requireChunks: false`: the suggestion is keyword/MIME signal only, so an `indexed` document counts
  // even before it is chunked (it matches the run path, not the analysis handlers — X-1).
  const rows = documentsInScope(db, scope, { requireChunks: false })
  const titles = rows.map((r) => r.title)
  const mimeTypes = rows
    .map((r) => r.mimeType)
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
  return { titles, mimeTypes }
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
    return projectSignals(db, scope)
  }
  // A rollback rewinds the generation with the data, so a later write could land on the same number with
  // different content: a read inside an open transaction is answered live and never memoized. (No
  // transaction spans an await today, so no IPC read can land inside one; this keeps it true by construction.)
  if (db.isTransaction) return projectSignals(db, scope)
  // F-29: the SUGGESTION path re-runs per keystroke pause over an unchanged corpus — memoize it keyed by
  // the resolved scope + the corpus generation (the resident-cache idiom). See the header note.
  const key = `${scopeFingerprint(scope)}|g:${corpusGeneration(db)}`
  const hit = residentByDb.get(db)
  if (hit && hit.key === key) return { titles: hit.titles, mimeTypes: hit.mimeTypes }
  const signals = projectSignals(db, scope)
  residentByDb.set(db, { key, ...signals })
  materializationsByDb.set(db, (materializationsByDb.get(db) ?? 0) + 1)
  return signals
}
