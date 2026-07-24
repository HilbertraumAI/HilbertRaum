import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { tMain } from '../services/i18n'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import {
  EXTRACT_RECORD_TYPES,
  type DocTaskStatus,
  type DocumentCoverage,
  type ExtractionListing,
  type ExtractionListingRequest,
  type RetrievalScope,
  type StartDocTaskRequest
} from '../../shared/types'
import { getDocument } from '../services/ingestion'
import { documentCoverage, documentLeafProvenance } from '../services/analysis/coverage'
import { aggregateExtractions } from '../services/analysis/extract'

// IPC for document tasks (wave-3 plan §6). Async with polling, like imports and
// downloads: `startDocTask` validates + enqueues and returns a job id immediately;
// the renderer polls `getDocTask` to drive progress UI; `cancelDocTask` aborts (no
// jobId = the active task, for the chat screen's busy banner). All guards
// (one-at-a-time, refuse-while-chat-streams, runtime-required) live in the
// DocTaskManager itself so non-IPC callers get them too.
//
// Privacy: task results (summaries) are content — these handlers never log or audit
// them. The manager records the ids-only `document_task_*` audit events itself.

export function registerDocTasksIpc(ctx: AppContext): void {
  // Guard throws are ephemeral IPC emissions — localized via tMain (i18n record §3.3).
  const requireTasks = () => {
    if (!ctx.docTasks) throw new Error(tMain('main.task.unavailable'))
    return ctx.docTasks
  }

  const requireUnlocked = (): void => {
    // AUD-02: `workspaceAdmitsWork`, never a bare `isUnlocked()` — the workspace DB stays
    // OPEN for the whole multi-second lock teardown, so a bare check admits work that then
    // lazily respawns the sidecars that teardown just killed. This module's copy is unchanged.
    if (!workspaceAdmitsWork(ctx.workspace)) {
      throw new Error(tMain('main.task.workspaceLocked'))
    }
  }

  ipcMain.handle(IPC.startDocTask, (_e, req: StartDocTaskRequest): { jobId: string } => {
    requireUnlocked()
    return requireTasks().startDocTask(req)
  })

  ipcMain.handle(IPC.getDocTask, (_e, jobId: string): DocTaskStatus =>
    requireTasks().getDocTask(typeof jobId === 'string' ? jobId : '')
  )

  // Reload adoption for the file/document translation path (FA-3 / F-3): the running task's
  // status (a copy) or null. A safe read — never starts anything.
  ipcMain.handle(IPC.getActiveDocTask, (): DocTaskStatus | null => requireTasks().getActiveDocTask())

  ipcMain.handle(IPC.cancelDocTask, (_e, jobId?: string | null): void => {
    const manager = requireTasks()
    const id = typeof jobId === 'string' && jobId.length > 0 ? jobId : null
    // A PRESENT id is a TARGETED cancel (FA-3 / F-6): cancel ONLY when it is the active task, so a
    // stale Stop carrying a since-superseded jobId can never kill the task that took the lane after
    // it. An ABSENT id keeps the active-task fallback (the chat busy banner) — old callers unchanged.
    if (id) manager.cancelActiveDocTask(id)
    else manager.cancelDocTask(null)
  })

  // Read-only coverage + provenance of a document's CURRENT summary (whole-document-analysis
  // plan §5.1, Phase 2). No model call — pure DB reads. Coverage/provenance are CONTENT-derived
  // (counts + source-chunk lineage), so this handler never logs or audits them.
  ipcMain.handle(
    IPC.documentCoverage,
    (_e, documentId: string): DocumentCoverage | null => {
      requireUnlocked()
      if (typeof documentId !== 'string' || documentId.length === 0) return null
      const doc = getDocument(ctx.db, documentId)
      if (!doc) return null
      const coverage = documentCoverage(ctx.db, documentId, doc.summary ?? null)
      // M2: provenance is the SOURCE chunks behind a ready-tree summary only — never node
      // summaries, never the capped/relevance paths (those have no leaf lineage to show).
      const provenance =
        coverage.mode === 'tree' && coverage.treeStatus === 'ready'
          ? documentLeafProvenance(ctx.db, documentId, doc.title)
          : []
      return { coverage, provenance }
    }
  )

  // Read-only "list every X" aggregation (whole-document-analysis plan §4.2/§5.1, Phase 3): a
  // pure GROUP BY over the precomputed `extraction_records` for one record type, scoped via the
  // shared buildScopeFilter (M3). ZERO model calls. The aggregated values are CONTENT — never
  // logged or audited (only the ids/counts of the precompute pass are).
  ipcMain.handle(
    IPC.listAllExtractions,
    (_e, req: ExtractionListingRequest): ExtractionListing | null => {
      requireUnlocked()
      const recordType = req?.recordType
      if (!recordType || !(EXTRACT_RECORD_TYPES as readonly string[]).includes(recordType)) {
        return null
      }
      const sanitizeIds = (v: unknown): string[] | null =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : null
      const ids = sanitizeIds(req.documentIds)
      const collIds = sanitizeIds(req.collectionIds)
      const scope: RetrievalScope = {
        documentIds: ids && ids.length > 0 ? ids : null,
        collectionIds: collIds && collIds.length > 0 ? collIds : null,
        includeArchived: req.includeArchived === true
      }
      return aggregateExtractions(ctx.db, scope, recordType)
    }
  )
}
