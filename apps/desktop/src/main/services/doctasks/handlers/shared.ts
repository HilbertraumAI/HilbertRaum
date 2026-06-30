// Cross-domain doc-task helpers shared by the translation + compare handlers (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). Relocated VERBATIM from `manager.ts`; each method's
// `this.deps` became `ctx.deps`. Behavior unchanged.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { tMain } from '../../i18n'
import type { GeneratedProvenance } from '../../../../shared/types'
import {
  createQueuedDocument,
  deleteDocument,
  extractDocumentPreview,
  processDocument,
  setDocumentOrigin
} from '../../ingestion'
import { shredFile } from '../../workspace-vault'
import { collectionIdsForDocument } from '../../collections'
import { log } from '../../logging'
import type { DocTaskCtx, InternalTask } from '../context'

/**
 * Re-extract a document's ordered, non-overlapping segment texts from its stored
 * copy (never the ~80-token-overlapping chunks). Encrypted copies decrypt to a
 * `.parse*` transient inside and are shredded on the way out.
 */
export async function extractSegmentTexts(documentId: string, ctx: DocTaskCtx): Promise<string[]> {
  let texts: string[]
  try {
    const preview = await extractDocumentPreview(
      ctx.deps.getDb(),
      ctx.deps.getStoreDir(),
      documentId,
      { cipher: ctx.deps.getIngestionDeps().cipher ?? null }
    )
    texts = preview.segments.map((s) => s.text).filter((t) => t.trim().length > 0)
  } catch (err) {
    log.warn('Document task source re-extraction failed', {
      documentId,
      error: err instanceof Error ? err.message : String(err)
    })
    throw new Error(tMain('main.task.sourceUnreadable'))
  }
  if (texts.length === 0) throw new Error(tMain('main.task.documentNotReady'))
  return texts
}

/**
 * Build the structured provenance (plan §15.1) a materialized output carries: the
 * generation kind, its source ids, the model that produced it, and a snapshot of the
 * source(s)' collection memberships at creation time. NEW generations write this
 * `GeneratedProvenance`; the legacy `Translation/CompareOrigin` shapes still parse on
 * read (back-compat). A generated row is given NO `document_collections` membership of
 * its own (N1/D3 — handled by NOT filing it); `sourceCollectionIds` is provenance only.
 */
export function buildProvenance(
  kind: GeneratedProvenance['kind'],
  sourceDocumentIds: string[],
  modelId: string,
  ctx: DocTaskCtx
): GeneratedProvenance {
  const db = ctx.deps.getDb()
  const sourceCollectionIds = [
    ...new Set(sourceDocumentIds.flatMap((id) => collectionIdsForDocument(db, id)))
  ]
  const prov: GeneratedProvenance = {
    kind,
    sourceDocumentIds,
    modelId,
    createdAt: new Date().toISOString()
  }
  if (sourceCollectionIds.length > 0) prov.sourceCollectionIds = sourceCollectionIds
  return prov
}

/**
 * Write the generated Markdown to a transient file and run it through the NORMAL
 * import path (`createQueuedDocument` + `processDocument`) so the new document is
 * chunked, embedded, searchable, citable, and `.enc`-encrypted automatically.
 * Holds the vault lease for exactly this step — it writes `.enc` sidecars
 * (`VaultBusyError` from a concurrent password change propagates as a friendly task
 * failure). The transient uses the `.parse` infix so the startup crash sweep shreds
 * it if we die mid-step; otherwise it is shredded here, success or failure.
 */
export async function materializeDocument(
  task: InternalTask,
  markdown: string,
  title: string,
  origin: GeneratedProvenance,
  ctx: DocTaskCtx
): Promise<string> {
  const release = ctx.deps.beginDocumentWork()
  const db = ctx.deps.getDb()
  const storeDir = ctx.deps.getStoreDir()
  const tempPath = join(storeDir, `${task.status.jobId}.parse.md`)
  let newDocId: string | null = null
  try {
    // ING-6 (perf audit 2026-06-18): the in-RAM `markdown` is written to a temp `.parse.md`
    // and re-read/re-parsed/re-chunked by the canonical import path below. This disk round-trip
    // + redundant parse is DELIBERATE, not an oversight: routing the generated output through
    // the SAME `createQueuedDocument` → `processDocument` pipeline gets encryption-at-rest, the
    // FTS trigger, citations, and the crash-safe queue-time provenance stamp (DM-2) for free,
    // and keeps ONE import code path. An in-memory ingestion entry would duplicate all of that;
    // add it only if profiling shows this round-trip matters (the embed pass dominates anyway).
    writeFileSync(tempPath, markdown, 'utf8')
    // Stamp the generated provenance AT QUEUE TIME, before processDocument can flip the
    // row to `indexed`. A process kill between `indexed` and a later origin-write would
    // otherwise satisfy the Library backfill (`origin_json IS NULL` + no membership) and
    // wrongly file this work-product into Library, violating D3/N1 (DM-2).
    const info = createQueuedDocument(db, tempPath, { displayTitle: title, origin })
    newDocId = info.id
    // The output document is born inside the task — OUTSIDE registerDocsIpc's
    // `processing` set — so list it on the task: `isDocumentBusy` then covers it
    // and it cannot be deleted/re-indexed mid-materialize.
    task.status.documentIds.push(info.id)
    const result = await processDocument(db, storeDir, info.id, ctx.deps.getIngestionDeps())
    if (result.status !== 'indexed') {
      // processDocument never throws — but a materialized output must fully succeed
      // or persist nothing, so a failed import removes the half-born row again.
      log.error(`Materialized ${origin.kind} output failed to import`, {
        jobId: task.status.jobId,
        status: result.status,
        error: result.errorMessage
      })
      throw new Error(tMain('main.task.genericFailure'))
    }
    // origin_json was already stamped at queue time (DM-2); re-assert it post-success to
    // also clear original_path (the transient source is shredded in `finally`). Idempotent.
    setDocumentOrigin(db, info.id, origin)
    // A new corpus document must never appear without an audit trail (filename +
    // id only — the translated text is content, never audit-logged).
    ctx.deps.audit?.('document_imported', `Document imported: ${result.title}`, {
      documentId: info.id,
      status: result.status,
      chunkCount: result.chunkCount
    })
    return info.id
  } catch (err) {
    if (newDocId) deleteDocument(db, newDocId)
    throw err
  } finally {
    shredFile(tempPath)
    release()
  }
}
