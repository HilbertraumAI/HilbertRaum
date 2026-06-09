import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { DocumentInfo, ImportJob, ImportJobStatus } from '../../shared/types'
import {
  createQueuedDocument,
  deleteDocument,
  documentsDir,
  expandPaths,
  listDocuments,
  processDocument,
  reconcileStuckDocuments,
  reindexDocument,
  type IngestionDeps
} from '../services/ingestion'
import { supportedExtensions } from '../services/ingestion/parsers'
import { getSettings } from '../services/settings'
import { log } from '../services/logging'

// Phase 4 IPC: document import + ingestion status (spec §9.1, §7.7).
//
// Import model (DECISION — documented in BUILD_STATE): async with polling.
// `importDocuments` expands the selection, persists a `queued` row per file, returns the
// document ids immediately, then processes the files sequentially in the background. The
// `documents` table is the source of truth for per-file status (it survives restarts);
// the per-job aggregate (ImportJobStatus) is kept in memory and read via `getImportJob`.
// The renderer polls `listDocuments` + `getImportJob` to drive the UI. This reuses no
// streaming channel — ingestion progress is coarse-grained and polling is simpler/robust.

export function registerDocsIpc(ctx: AppContext): void {
  const storeDir = documentsDir(ctx.paths.workspacePath)
  // Ephemeral per-import aggregates, keyed by job id.
  const jobs = new Map<string, ImportJobStatus>()
  // Documents currently being processed (import loop or re-index). Guards delete/re-index
  // against racing an in-flight ingestion of the SAME document (M3): interleaving used to
  // produce FK violations, duplicate chunk sets, and EBUSY on the stored copy.
  const processing = new Set<string>()

  // DB-backed handlers require an unlocked workspace; surface a clean message instead of
  // the raw "Workspace is locked" the `ctx.db` getter would throw mid-operation.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) {
      throw new Error('Workspace is locked. Unlock it to manage documents.')
    }
  }

  const requireNotProcessing = (documentId: string): void => {
    if (processing.has(documentId)) {
      throw new Error('This document is still being processed. Wait for the import to finish.')
    }
  }

  // Ingestion dependencies (Phase 5 + H1). The active embedding model id (settings) tags
  // each vector; the document cipher (non-null only for an UNLOCKED encrypted workspace)
  // makes the stored document copies rest encrypted, per spec §3.5.
  const ingestionDeps = (): IngestionDeps => ({
    embedder: ctx.embedder,
    embeddingModelId: getSettings(ctx.db).activeEmbeddingModelId,
    cipher: ctx.workspace.documentCipher()
  })

  // Open the OS file/folder picker in the main process (renderer has no dialog access).
  // Windows cannot mix file + directory selection in one dialog, so the caller chooses a
  // mode: 'files' (default) or 'folder'.
  ipcMain.handle(IPC.pickDocuments, async (_e, mode?: 'files' | 'folder'): Promise<string[]> => {
    const exts = supportedExtensions().map((e) => e.replace(/^\./, ''))
    const options =
      mode === 'folder'
        ? {
            title: 'Import a folder of documents',
            properties: ['openDirectory'] as Array<'openDirectory'>
          }
        : {
            title: 'Import documents',
            properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
            filters: [
              { name: 'Documents', extensions: exts },
              { name: 'All files', extensions: ['*'] }
            ]
          }
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.importDocuments, (_e, paths: string[]): ImportJob => {
    requireUnlocked()
    const files = expandPaths(paths ?? [])
    const documentIds = files.map((f) => createQueuedDocument(ctx.db, f).id)

    const jobId = randomUUID()
    const status: ImportJobStatus = {
      jobId,
      total: documentIds.length,
      completed: 0,
      failed: 0,
      done: documentIds.length === 0
    }
    jobs.set(jobId, status)
    log.info('Import started', { jobId, files: documentIds.length })

    // Process sequentially in the background; do not block the invoke return.
    void (async () => {
      for (const id of documentIds) {
        // Lock-while-importing (M4): the vault can close mid-job ("Lock now"). Stop the
        // loop cleanly — the remaining rows stay non-terminal inside the encrypted
        // snapshot and are reconciled to `failed` (re-indexable) after the next unlock.
        if (!ctx.workspace.isUnlocked()) {
          log.warn('Import stopped: workspace locked mid-job', { jobId })
          break
        }
        processing.add(id)
        try {
          const info = await processDocument(ctx.db, storeDir, id, ingestionDeps())
          if (info.status === 'failed') status.failed += 1
          else status.completed += 1
        } catch (err) {
          status.failed += 1
          log.error('Document ingestion crashed', { id, error: String(err) })
        } finally {
          processing.delete(id)
        }
      }
      status.done = true
      log.info('Import finished', { jobId, completed: status.completed, failed: status.failed })
    })()

    return { jobId, documentIds }
  })

  ipcMain.handle(IPC.getImportJob, (_e, jobId: string): ImportJobStatus => {
    const status = jobs.get(jobId)
    if (status) return status
    // Unknown/expired job — report it as done so pollers stop gracefully.
    return { jobId, total: 0, completed: 0, failed: 0, done: true }
  })

  ipcMain.handle(IPC.listDocuments, (): DocumentInfo[] => {
    requireUnlocked()
    // Reconcile stuck rows whenever NOTHING is actually running (M4): a row left in an
    // active status (queued/extracting/…) with no live job/re-index belongs to a killed
    // run or a lock-interrupted import — reset it to `failed` so the UI offers Re-index
    // instead of a perpetual, button-disabling "in progress". The previous one-shot flag
    // never re-ran after a mid-session lock → unlock, wedging those documents.
    const importActive = [...jobs.values()].some((j) => !j.done)
    if (!importActive && processing.size === 0) {
      const n = reconcileStuckDocuments(ctx.db, new Date().toISOString())
      if (n > 0) log.warn('Reconciled interrupted document ingestions', { count: n })
    }
    // Flag docs whose vectors were produced by a different embedder than the active one
    // (search is scoped to `ctx.embedder.id`), so the UI can prompt a re-index.
    return listDocuments(ctx.db, ctx.embedder.id)
  })

  ipcMain.handle(IPC.deleteDocument, (_e, documentId: string): void => {
    requireUnlocked()
    requireNotProcessing(documentId)
    log.info('Delete document', { documentId })
    deleteDocument(ctx.db, documentId)
  })

  ipcMain.handle(IPC.reindexDocument, async (_e, documentId: string): Promise<DocumentInfo> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    log.info('Re-index document', { documentId })
    processing.add(documentId)
    try {
      return await reindexDocument(ctx.db, storeDir, documentId, ingestionDeps())
    } finally {
      processing.delete(documentId)
    }
  })
}
