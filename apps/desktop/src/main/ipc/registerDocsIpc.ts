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
  reindexDocument
} from '../services/ingestion'
import { supportedExtensions } from '../services/ingestion/parsers'
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
        try {
          const info = await processDocument(ctx.db, storeDir, id)
          if (info.status === 'failed') status.failed += 1
          else status.completed += 1
        } catch (err) {
          status.failed += 1
          log.error('Document ingestion crashed', { id, error: String(err) })
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

  ipcMain.handle(IPC.listDocuments, (): DocumentInfo[] => listDocuments(ctx.db))

  ipcMain.handle(IPC.deleteDocument, (_e, documentId: string): void => {
    log.info('Delete document', { documentId })
    deleteDocument(ctx.db, documentId)
  })

  ipcMain.handle(IPC.reindexDocument, (_e, documentId: string): Promise<DocumentInfo> => {
    log.info('Re-index document', { documentId })
    return reindexDocument(ctx.db, storeDir, documentId)
  })
}
