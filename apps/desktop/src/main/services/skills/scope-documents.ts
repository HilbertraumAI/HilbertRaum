import type { Db } from '../db'
import type { RetrievalScope } from '../../../shared/types'
import { buildScopeFilter } from '../retrieval-scope'

// The ONE definition of "the indexed documents in a conversation's resolved scope" (audit X-1). Before
// Phase 10 this query was hand-copied across FIVE sites — the run-path id resolver
// (`tool-runs.ts` resolveInScopeDocumentIds), the suggestion/auto-fire signals (`scope-signals.ts`
// inScopeDocSignals), and the three analysis handlers' `inScopeDocuments` (bank/invoice/whole-doc) —
// with TWO subtly different predicates (the run/suggest paths omitted the `EXISTS chunks` check the
// analysis handlers require) and three column projections. That drift is now impossible: all five route
// through here and pick the predicate DELIBERATELY via `requireChunks`.
//
// LOGS NOTHING and stays MAIN-SIDE: a `title` is content-adjacent (§22-C4 / the §6 posture) and never
// crosses the IPC boundary from here — callers project only what they need (the run path takes ids; the
// suggest path takes titles+MIME main-side; the analysis handlers take id+title main-side). The
// deterministic `ORDER BY created_at, id` is LOAD-BEARING for the run path
// (`resolveInScopeDocumentIds[0]` is the default single-document run target, U-1/U-2) and harmlessly
// stable for everyone else.

/** One in-scope document. `title`/`mimeType` are content-adjacent — callers project only what they use. */
export interface ScopeDocument {
  id: string
  title: string
  mimeType: string | null
}

export interface ScopeDocumentOptions {
  /**
   * Require the document to have at least one chunk (`EXISTS chunks`). The CHAT ANALYSIS handlers pass
   * `true` — they read the stored `chunks`, so an `indexed` document not yet chunked is not answerable
   * there. The RUN path (the SkillRunBar button) and the SUGGEST / auto-fire path pass `false`: the run
   * re-extracts FAITHFULLY from the stored copy (chunks aren't needed), and the suggestion is just
   * keyword/MIME signals — so an `indexed` document is in scope even before it has been chunked.
   */
  requireChunks: boolean
}

/** The indexed documents in a resolved scope, deterministically ordered (empty-tolerant). */
export function documentsInScope(
  db: Db,
  scope: RetrievalScope,
  opts: ScopeDocumentOptions
): ScopeDocument[] {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  const chunks = opts.requireChunks
    ? ' AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)'
    : ''
  return db
    .prepare(
      `SELECT d.id AS id, d.title AS title, d.mime_type AS mimeType FROM documents d
       WHERE d.status = 'indexed'${chunks}${where} ORDER BY d.created_at, d.id`
    )
    .all(...params) as Array<{ id: string; title: string; mimeType: string | null }>
}
