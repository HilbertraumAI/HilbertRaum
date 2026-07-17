import type { Db } from '../db'
import { prepareCached } from '../db'
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
// never crosses workspaces or leaks between tests) keyed by the resolved SCOPE plus a cheap corpus
// SIGNATURE returns the identical projected signals on a hit. The signature is re-checked each call and
// changes on the events that change the set: `(COUNT, MAX(rowid))` over the `indexed` documents catches
// import / delete / index-status transitions, and `(COUNT, MAX(rowid))` over `document_collections`
// catches membership add/remove (so a project- or Library-scoped conversation invalidates when a doc is
// moved in/out). What it does NOT catch — a title rename or archive toggle of an EXISTING in-set doc —
// serves a brief stale title in an inert, user-chosen offer until the next real change, which is
// harmless. The AUTO-FIRE path (`explicitDocumentsOnly`) is NEVER cached — it is narrowed to explicit
// ids (already cheap) and must read live. The cache sits STRICTLY ABOVE `documentsInScope`; that shared
// helper's semantics are untouched (audit caution: never memoize inside it — ~13 call sites across
// three layers depend on its live, deterministic result).
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

/** Cheap corpus signature (F-29): `indexed`-documents `(COUNT, MAX(rowid))` ∥ `document_collections`
 *  `(COUNT, MAX(rowid))` ∥ `includeArchived` — changes on every import/delete/index/membership move. */
function corpusSignature(db: Db, includeArchived: boolean): string {
  const docs = prepareCached(
    db,
    `SELECT COUNT(*) AS n, MAX(rowid) AS m FROM documents WHERE status = 'indexed'`
  ).get() as { n: number; m: number | null }
  const mem = prepareCached(
    db,
    `SELECT COUNT(*) AS n, MAX(rowid) AS m FROM document_collections`
  ).get() as { n: number; m: number | null }
  return `${includeArchived ? 1 : 0}|${docs.n}|${docs.m ?? 0}|${mem.n}|${mem.m ?? 0}`
}

/** Deterministic fingerprint of a resolved scope's id-union (order-independent). */
function scopeFingerprint(scope: RetrievalScope): string {
  const c = [...(scope.collectionIds ?? [])].sort().join(',')
  const d = [...(scope.documentIds ?? [])].sort().join(',')
  return `c:${c}|d:${d}`
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
  // F-29: the SUGGESTION path re-runs per keystroke pause over an unchanged corpus — memoize it keyed by
  // the resolved scope + a cheap corpus signature (the resident-cache idiom). See the header note.
  const key = `${scopeFingerprint(scope)}|${corpusSignature(db, scope.includeArchived ?? false)}`
  const hit = residentByDb.get(db)
  if (hit && hit.key === key) return { titles: hit.titles, mimeTypes: hit.mimeTypes }
  const signals = projectSignals(db, scope)
  residentByDb.set(db, { key, ...signals })
  materializationsByDb.set(db, (materializationsByDb.get(db) ?? 0) + 1)
  return signals
}
