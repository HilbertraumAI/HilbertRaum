import type { RetrievalScope } from '../../shared/types'

// Collection-aware retrieval filtering (document-organization plan §10.2). A single,
// neutral SQL builder shared by the vector search (`embeddings`), the keyword search
// (`rag/hybrid`), and the scoped re-index check (`rag/corpusNeedsReindex`) so the
// membership / id-union / archived rules live in exactly one place and cannot drift.
//
// Lives here (not in rag/ or embeddings/) deliberately: embeddings is imported BY rag, so
// it must not import from rag; this module imports only the shared type, breaking any
// cycle. Placeholders only — ids are never interpolated into the SQL.

/** A composed WHERE fragment + its bound parameters (in placeholder order). */
export interface ScopeFilter {
  /** SQL boolean expression (ANDed conditions); never empty when returned. */
  sql: string
  params: (string | number)[]
}

/**
 * Build the membership/id/archived predicate for a `RetrievalScope`, targeting a candidate
 * row's document id given as `docIdExpr` (e.g. `'c.document_id'` for a `chunks c` alias, or
 * `'d.id'` for a `documents d` alias).
 *
 * Semantics (plan §10.1/§10.2):
 *  - When `collectionIds` and/or `documentIds` are non-empty, a document is in scope when it
 *    is a member of any `collectionIds` entry **OR** its id is in `documentIds` (a UNION —
 *    plan D1), pushed into SQL as an `EXISTS`/`IN` disjunction (index-friendly, never a
 *    materialized `IN (…thousands…)`).
 *  - Unless `includeArchived` is true, document-level `lifecycle='archived'` is excluded
 *    from the whole result — the only GLOBAL exclusion (plan C1). A project being archived
 *    is NOT expressed here (it is only dropped as a selectable source).
 *
 * Returns `null` when the scope imposes no filter at all (empty union AND archived
 * included) — i.e. the explicit "All documents" / legacy whole-corpus path stays unfiltered.
 */
export function buildScopeFilter(
  scope: RetrievalScope | null | undefined,
  docIdExpr: string
): ScopeFilter | null {
  const conditions: string[] = []
  const params: (string | number)[] = []

  const collectionIds = scope?.collectionIds && scope.collectionIds.length > 0 ? scope.collectionIds : null
  const documentIds = scope?.documentIds && scope.documentIds.length > 0 ? scope.documentIds : null

  if (collectionIds || documentIds) {
    const union: string[] = []
    if (collectionIds) {
      union.push(
        `EXISTS (SELECT 1 FROM document_collections dc WHERE dc.document_id = ${docIdExpr} ` +
          `AND dc.collection_id IN (${collectionIds.map(() => '?').join(', ')}))`
      )
      params.push(...collectionIds)
    }
    if (documentIds) {
      union.push(`${docIdExpr} IN (${documentIds.map(() => '?').join(', ')})`)
      params.push(...documentIds)
    }
    conditions.push(`(${union.join(' OR ')})`)
  }

  if (!scope?.includeArchived) {
    // Document-level archive only (plan C1). NOT EXISTS is satisfied (chunk kept) when no
    // documents row matches, so candidate rows without a documents row are never dropped.
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM documents da WHERE da.id = ${docIdExpr} AND da.lifecycle = 'archived')`
    )
  }

  if (conditions.length === 0) return null
  return { sql: conditions.join(' AND '), params }
}
