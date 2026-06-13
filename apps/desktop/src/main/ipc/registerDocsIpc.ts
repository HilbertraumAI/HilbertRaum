import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  DocumentInfo,
  DocumentPreview,
  ImportJob,
  ImportJobStatus,
  ImportPreflight
} from '../../shared/types'
import {
  createQueuedDocument,
  deleteDocument,
  documentsDir,
  expandPaths,
  extractDocumentPreview,
  listDocuments,
  processDocument,
  readStoredDocumentText,
  reconcileStuckDocuments,
  reindexDocument,
  summarizeImportPaths,
  type IngestionDeps
} from '../services/ingestion'
import { supportedExtensions } from '../services/ingestion/parsers'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { saveTextExport } from './save-export'

// IPC for document import + ingestion status (spec §9.1, §7.7).
//
// Import model: async with polling.
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
  // against racing an in-flight ingestion of the SAME document: interleaving used to
  // produce FK violations, duplicate chunk sets, and EBUSY on the stored copy.
  const processing = new Set<string>()

  // DB-backed handlers require an unlocked workspace; surface a clean message instead of
  // the raw "Workspace is locked" the `ctx.db` getter would throw mid-operation.
  // Guard throws are ephemeral IPC emissions — localized via tMain (i18n-plan §3.3).
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) {
      throw new Error(tMain('main.docs.locked'))
    }
  }

  const requireNotProcessing = (documentId: string): void => {
    if (processing.has(documentId)) {
      throw new Error(tMain('main.docs.processing'))
    }
  }

  // A running/queued document task reads this document's chunks and then
  // writes its summary — re-indexing (which rebuilds the chunks and clears the summary)
  // or deleting the row underneath it would persist a stale result or lose the race.
  const requireNoActiveTask = (documentId: string): void => {
    if (ctx.docTasks?.isDocumentBusy(documentId)) {
      throw new Error(tMain('main.docs.taskRunning'))
    }
  }

  // Ingestion dependencies. Vectors are tagged with the id of the embedder that
  // ACTUALLY produced them (`embedder.id`, the embedChunks fallback) — never the
  // settings selection: with the E5 manifest selected but the mock embedder active
  // (no binary), a settings-based tag stamps mock vectors with the E5 id, hiding
  // them from search now AND poisoning the E5-scoped search later. Search scopes by
  // `ctx.embedder.id`, so tag and scope must come from the same place. The document cipher
  // (non-null only for an UNLOCKED encrypted workspace) keeps stored copies encrypted at
  // rest, per spec §3.5.
  // Transcription progress per document: fed by the whisper CLI's `-pp`
  // output through the parse context, merged into `listDocuments` responses so the
  // polling UI can show "Transcribing… N%" on import AND re-index. In-memory only —
  // cleared when the document leaves the processing set.
  const transcribing = new Map<string, number>()

  const ingestionDeps = (): IngestionDeps => ({
    embedder: ctx.embedder,
    cipher: ctx.workspace.documentCipher(),
    transcriber: ctx.transcriber,
    ocrEngine: ctx.ocrEngine,
    onTranscribeProgress: (documentId, percent) => transcribing.set(documentId, percent)
  })

  // Open the OS file/folder picker in the main process (renderer has no dialog access).
  // Windows cannot mix file + directory selection in one dialog, so the caller chooses a
  // mode: 'files' (default) or 'folder'.
  ipcMain.handle(IPC.pickDocuments, async (_e, mode?: 'files' | 'folder'): Promise<string[]> => {
    const exts = supportedExtensions().map((e) => e.replace(/^\./, ''))
    const options =
      mode === 'folder'
        ? {
            title: tMain('main.dialog.importFolder'),
            properties: ['openDirectory'] as Array<'openDirectory'>
          }
        : {
            title: tMain('main.dialog.importDocuments'),
            properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
            filters: [
              { name: tMain('main.dialog.filterDocuments'), extensions: exts },
              { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
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
    // Race guard: the whole import job holds a document-work lease so a vault
    // password change (which re-encrypts `.enc` sidecars) refuses to start while we
    // write them — and vice versa, this throws a friendly VaultBusyError mid-change.
    const releaseDocWork = ctx.workspace.beginDocumentWork()
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
      try {
        for (const id of documentIds) {
          // Lock-while-importing: the vault can close mid-job ("Lock now"). Stop the
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
            // Audit: filename + counts only — never the document's text.
            ctx.audit?.('document_imported', `Document imported: ${info.title}`, {
              documentId: id,
              status: info.status,
              chunkCount: info.chunkCount
            })
          } catch (err) {
            status.failed += 1
            log.error('Document ingestion crashed', { id, error: String(err) })
          } finally {
            processing.delete(id)
            transcribing.delete(id)
          }
        }
      } finally {
        releaseDocWork()
        status.done = true
      }
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
    // Reconcile stuck rows whenever NOTHING is actually running: a row left in an
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
    // Merge in-memory transcription progress so the polling UI can show
    // "Transcribing… N%" without any new channel.
    return listDocuments(ctx.db, ctx.embedder.id).map((d) => {
      const percent = transcribing.get(d.id)
      return percent !== undefined && d.status === 'extracting'
        ? { ...d, transcriptionProgress: percent }
        : d
    })
  })

  // Size-aware audio preflight: the renderer asks what a picked
  // selection contains BEFORE importing, so large audio (stored copy + a full
  // transcription are real costs) gets an explicit confirmation. Read-only.
  ipcMain.handle(IPC.importPreflight, (_e, paths: string[]): ImportPreflight => {
    return summarizeImportPaths(paths ?? [])
  })

  ipcMain.handle(IPC.deleteDocument, (_e, documentId: string): void => {
    requireUnlocked()
    requireNotProcessing(documentId)
    requireNoActiveTask(documentId)
    log.info('Delete document', { documentId })
    deleteDocument(ctx.db, documentId)
    ctx.audit?.('document_deleted', 'Document deleted', { documentId })
  })

  // Read-only in-app preview: re-extracts the stored copy's text. Guarded
  // against racing an in-flight ingestion of the same document (it rewrites the stored
  // copy); in an encrypted workspace the transient decrypted file is shredded inside
  // the service. Nothing is written to the DB and no external viewer ever sees bytes.
  ipcMain.handle(IPC.previewDocument, async (_e, documentId: string): Promise<DocumentPreview> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    log.info('Preview document', { documentId })
    return extractDocumentPreview(ctx.db, storeDir, documentId, {
      cipher: ctx.workspace.documentCipher(),
      // Photos re-recognize on preview; OCR'd PDFs read their stored pages.
      ocrEngine: ctx.ocrEngine
    })
  })

  // Save a TEXT document's stored content to a user-chosen file (the
  // exportConversation pattern: dialog + fs in MAIN, never the renderer). Built for
  // materialized translations (always Markdown); any plain-text document qualifies.
  // Resolves with the saved path, or null when the user cancelled.
  ipcMain.handle(IPC.exportDocument, async (_e, documentId: string): Promise<string | null> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    const { title, text } = readStoredDocumentText(ctx.db, storeDir, documentId, {
      cipher: ctx.workspace.documentCipher()
    })
    const dot = title.lastIndexOf('.')
    const baseName = (dot > 0 ? title.slice(0, dot) : title)
      .replace(/[^\p{L}\p{N} ()_-]/gu, '')
      .trim()
      .slice(0, 60)
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportDocument'),
        defaultPath: `${baseName || 'document'}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      },
      text
    )
    if (!filePath) return null
    log.info('Document exported', { documentId })
    // Audit privacy rule: the id only — the chosen path is user-private
    // and the text is content.
    ctx.audit?.('document_exported', 'Document exported to a file', { documentId })
    return filePath
  })

  ipcMain.handle(IPC.reindexDocument, async (_e, documentId: string): Promise<DocumentInfo> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    requireNoActiveTask(documentId)
    // Race guard: re-index rewrites the `.enc` sidecar — mutually exclusive
    // with a password change (see importDocuments).
    const releaseDocWork = ctx.workspace.beginDocumentWork()
    log.info('Re-index document', { documentId })
    processing.add(documentId)
    try {
      const info = await reindexDocument(ctx.db, storeDir, documentId, ingestionDeps())
      ctx.audit?.('document_reindexed', `Document re-indexed: ${info.title}`, {
        documentId,
        status: info.status
      })
      return info
    } finally {
      processing.delete(documentId)
      transcribing.delete(documentId)
      releaseDocWork()
    }
  })
}
