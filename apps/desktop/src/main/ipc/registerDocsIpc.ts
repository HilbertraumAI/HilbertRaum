import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { statSync } from 'node:fs'
import type {
  DocumentInfo,
  DocumentLifecycle,
  DocumentPreview,
  FilingSuggestionResult,
  ImportDestination,
  ImportJob,
  ImportJobStatus,
  ImportOptions,
  ImportPreflight,
  SmartListView
} from '../../shared/types'
import { matchesSmartView } from '../../shared/types'
import {
  createQueuedDocument,
  deleteDocument,
  documentsDir,
  expandPathsWithSource,
  extractDocumentPreview,
  listDocuments,
  processDocument,
  readStoredDocumentText,
  reconcileStuckDocuments,
  reindexDocument,
  summarizeImportPaths,
  type IngestionDeps
} from '../services/ingestion'
import {
  addToCollection,
  fileFromPendingDestination,
  listCollections,
  removeFromCollection,
  setDocumentsLifecycle
} from '../services/collections'
import { suggestFilingForDocuments } from '../services/filing-suggestions'
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

/**
 * Optional `docs:list` filter (plan §16) for the Documents section rail. `collectionId`
 * narrows to that collection's members; `lifecycle` to that retention state; `smart` to a
 * query-time view (plan §7.6/§12.1). The smart views are predicates/orderings over
 * `documents` metadata, never stored collections; they stay in lockstep with the
 * renderer rail via the shared `matchesSmartView`. All omitted ⇒ every non-deleted document.
 */
export interface DocumentListFilter {
  collectionId?: string
  lifecycle?: DocumentLifecycle
  smart?: SmartListView
}

/** Untrusted-boundary guard: keep only non-empty string ids. */
function safeIdArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

/**
 * Untrusted-boundary guard for an `ImportDestination` (the renderer is untrusted). An
 * unknown/malformed shape falls back to the Library default — never throws, never trusts a
 * non-string id. (Whether the referenced collection/conversation actually exists is the
 * filing step's concern — `linkConversationDocument` is FK-guarded; an unknown collection id
 * simply yields a dangling membership row, harmless and ignored.)
 */
function sanitizeDestination(value: unknown): ImportDestination {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (v.kind === 'temporary') return { kind: 'temporary' }
    if (v.kind === 'collection' && typeof v.collectionId === 'string' && v.collectionId.length > 0) {
      return { kind: 'collection', collectionId: v.collectionId }
    }
    if (v.kind === 'conversation' && typeof v.conversationId === 'string' && v.conversationId.length > 0) {
      return { kind: 'conversation', conversationId: v.conversationId }
    }
  }
  return { kind: 'library' }
}

/** Apply a `DocumentListFilter` to an already-built DocumentInfo list. */
function filterDocuments(docs: DocumentInfo[], filter?: DocumentListFilter): DocumentInfo[] {
  if (!filter) return docs
  let out = docs
  if (filter.smart && filter.smart !== 'all') {
    if (filter.smart === 'recent') {
      // Recently added: order by createdAt desc (no new column). Copy before sorting —
      // the input is the caller's list.
      out = [...out].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    } else {
      out = out.filter((d) => matchesSmartView(d, filter.smart as Exclude<SmartListView, 'all' | 'recent'>))
    }
  }
  if (filter.lifecycle) out = out.filter((d) => (d.lifecycle ?? 'permanent') === filter.lifecycle)
  if (filter.collectionId) {
    out = out.filter((d) => (d.collections ?? []).some((c) => c.id === filter.collectionId))
  }
  return out
}

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
  // Guard throws are ephemeral IPC emissions — localized via tMain (i18n record §3.3).
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

  ipcMain.handle(IPC.importDocuments, (_e, paths: string[], options?: ImportOptions): ImportJob => {
    requireUnlocked()
    // Race guard: the whole import job holds a document-work lease so a vault
    // password change (which re-encrypts `.enc` sidecars) refuses to start while we
    // write them — and vice versa, this throws a friendly VaultBusyError mid-change.
    const releaseDocWork = ctx.workspace.beginDocumentWork()
    // The lease is held until the background loop's `finally`. Anything that can throw
    // synchronously between here and that loop (a failed INSERT, a path expansion error)
    // must release the lease first, or a vault password change is wedged for the whole
    // session with no import in flight to explain it.
    let documentIds: string[]
    try {
      // M-S2: the renderer is the untrusted boundary — accept only an array of strings.
      // A non-array (or non-string elements) would otherwise crash expandPaths with the
      // lease held. Element strings are still server-validated downstream (expandPathsWithSource
      // filters to existing, supported files).
      const safePaths = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
      // Destination (plan §11.3): persisted per queued doc and applied on indexing success.
      // No options ⇒ Library default, byte-for-byte with the pre-Phase-C behaviour.
      const destination: ImportDestination = sanitizeDestination(options?.destination)
      // preserveRelativePaths (N12): explicit when given, else default true for a folder
      // import (any picked path is a directory), false otherwise. Display-only metadata.
      const hasDir = safePaths.some((p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })
      const preserve = options?.preserveRelativePaths ?? hasDir
      const files = expandPathsWithSource(safePaths)
      documentIds = files.map(
        (f) =>
          createQueuedDocument(ctx.db, f.path, {
            destination,
            sourceRelativePath: preserve ? f.sourceRelativePath : null,
            sourceFolderLabel: preserve ? f.sourceFolderLabel : null
          }).id
      )
    } catch (err) {
      releaseDocWork()
      throw err
    }

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
            else {
              status.completed += 1
              // File the freshly-indexed doc by its persisted destination (plan §11.3):
              // Library ⇒ Library; collection ⇒ that project; temporary/conversation ⇒
              // Temporary (+ the FK-guarded chat link). No recorded destination ⇒ the
              // Library default, so old options-less imports stay byte-for-byte. This is the
              // in-session filing path; the crash-resume path (M1) files the same way from
              // `reindexDocument` (whoever drives a doc to `indexed` files it).
              fileFromPendingDestination(ctx.db, id)
            }
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

  ipcMain.handle(IPC.listDocuments, (_e, filter?: DocumentListFilter): DocumentInfo[] => {
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
    const docs = listDocuments(ctx.db, ctx.embedder.id).map((d) => {
      const percent = transcribing.get(d.id)
      return percent !== undefined && d.status === 'extracting'
        ? { ...d, transcriptionProgress: percent }
        : d
    })
    return filterDocuments(docs, filter)
  })

  // Size-aware audio preflight: the renderer asks what a picked
  // selection contains BEFORE importing, so large audio (stored copy + a full
  // transcription are real costs) gets an explicit confirmation. Read-only.
  // L-3: gate + type-filter exactly like importDocuments — a compromised renderer must
  // not drive a recursive statSync/readdirSync walk of arbitrary directories while the
  // workspace is locked, nor pass non-string elements that would crash expandPaths.
  ipcMain.handle(IPC.importPreflight, (_e, paths: string[]): ImportPreflight => {
    requireUnlocked()
    const safePaths = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    return summarizeImportPaths(safePaths)
  })

  ipcMain.handle(IPC.deleteDocument, (_e, documentId: string): void => {
    requireUnlocked()
    requireNotProcessing(documentId)
    requireNoActiveTask(documentId)
    log.info('Delete document', { documentId })
    deleteDocument(ctx.db, documentId)
    ctx.audit?.('document_deleted', 'Document deleted', { documentId })
  })

  // ---- Document-organization membership + lifecycle (plan §16) ----------------------
  // "Move" is composed renderer-side as add + remove (no separate channel). Audit records
  // ids + counts ONLY — never the collection/project name (plan §17).

  ipcMain.handle(
    IPC.addToCollection,
    (_e, documentIds: string[], collectionId: string): void => {
      requireUnlocked()
      const ids = safeIdArray(documentIds)
      if (ids.length === 0 || typeof collectionId !== 'string') return
      addToCollection(ctx.db, ids, collectionId, 'source')
      ctx.audit?.('documents_added_to_collection', 'Documents added to a collection', {
        collectionId,
        documentCount: ids.length
      })
    }
  )

  ipcMain.handle(
    IPC.removeFromCollection,
    (_e, documentIds: string[], collectionId: string): void => {
      requireUnlocked()
      const ids = safeIdArray(documentIds)
      if (ids.length === 0 || typeof collectionId !== 'string') return
      removeFromCollection(ctx.db, ids, collectionId)
      ctx.audit?.('documents_removed_from_collection', 'Documents removed from a collection', {
        collectionId,
        documentCount: ids.length
      })
    }
  )

  ipcMain.handle(
    IPC.setDocumentLifecycle,
    (_e, documentIds: string[], lifecycle: DocumentLifecycle): DocumentInfo[] => {
      requireUnlocked()
      const ids = safeIdArray(documentIds)
      const lc: DocumentLifecycle =
        lifecycle === 'temporary' || lifecycle === 'archived' ? lifecycle : 'permanent'
      if (ids.length > 0) {
        setDocumentsLifecycle(ctx.db, ids, lc)
        ctx.audit?.('document_lifecycle_changed', 'Document lifecycle changed', {
          lifecycle: lc,
          documentCount: ids.length
        })
      }
      // Return the affected documents, fully populated (collections come from listDocuments).
      const byId = new Map(listDocuments(ctx.db, ctx.embedder.id).map((d) => [d.id, d]))
      return ids.map((id) => byId.get(id)).filter((d): d is DocumentInfo => d != null)
    }
  )

  // Rule-based filing suggestions (plan §20 Phase F): read-only + LOCAL — the pure engine
  // proposes a project for each unfiled document (folder name, source-folder cohort, bilingual
  // filename pattern). NO model, NO network, NO new audit event (a suggestion is inert — the
  // renderer files it via the existing addToCollection/createCollection channels on Apply, so
  // only those record ids/counts; the suggestion REASON is never logged). Dismissals persist
  // in AppSettings, filtered renderer-side.
  ipcMain.handle(IPC.filingSuggestions, (): FilingSuggestionResult[] => {
    requireUnlocked()
    const docs = listDocuments(ctx.db, ctx.embedder.id)
    return suggestFilingForDocuments(docs, listCollections(ctx.db))
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
