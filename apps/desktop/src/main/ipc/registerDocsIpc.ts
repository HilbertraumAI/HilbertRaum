import { randomUUID } from 'node:crypto'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import type {
  DocumentInfo,
  DocumentLifecycle,
  DocumentPreview,
  ImportDestination,
  ImportJob,
  ImportJobStatus,
  ImportOptions,
  ImportPreflight,
  PickDocumentsResult,
  ReindexJobStatus,
  SmartListView
} from '../../shared/types'
import { matchesSmartView } from '../../shared/types'
import {
  createQueuedDocument,
  deleteDocument,
  documentsDir,
  expandPathsWithSource,
  extractDocumentPreviewPage,
  DEFAULT_PREVIEW_PAGE_SIZE,
  forceReindexEnabled,
  getDocument,
  getDocumentSummary,
  listDocuments,
  prepareDocument,
  finalizeDocument,
  type PreparedDocument,
  readStoredDocumentText,
  reconcileStuckDocuments,
  reconcileStuckTrees,
  reconcileStuckExtracts,
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
import { supportedExtensions } from '../services/ingestion/parsers'
import { reconcileStuckSkillRuns } from '../services/skills/run'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { saveTextExport } from './save-export'

// Process-start watermark (captured once at module load ≈ app boot). `skill_runs` rows created before
// this belong to a PREVIOUS, killed session; current-session rows are protected regardless of status.
// Used by the `reconcileStuckSkillRuns` sweep below — unlike `documents`, `skill_runs` bumps no
// `updated_at`, so a live-run's protection is the watermark, not an activity timestamp (IA-6 P-7).
const PROCESS_START_ISO = new Date().toISOString()

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
 * non-string id. (Whether the referenced collection/conversation actually EXISTS is the
 * filing step's concern: both `linkConversationDocument` and the collection case of
 * `fileDocumentByDestination` are FK-guarded — an unknown/deleted id degrades to the Library
 * default rather than throwing a `FOREIGN KEY constraint failed` (DB-1). `foreign_keys` is ON,
 * so a raw membership INSERT against a missing collection would NOT be "harmless and ignored".)
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
  // Surface the dev force-reindex escape hatch once at startup so it's obvious WHY every document
  // suddenly reports "needs re-index" (listDocuments forces `staleEmbeddings` while it's set).
  if (forceReindexEnabled()) {
    log.warn('HR_FORCE_REINDEX active — every indexed document is reported outdated (re-index to re-chunk + re-embed)')
  }
  // Ephemeral per-import aggregates, keyed by job id. Bounded (DB-6): without a cap every import in
  // a long session is retained forever and the `importActive` list-poll iterates all of them. Capped
  // like `pickerTokens` (PICKER_TOKEN_CAP), but eviction removes only DONE jobs — an in-flight job is
  // load-bearing (the loop mutates its `status`, the renderer polls it) and must never be dropped. A
  // late poll on an evicted (done) id still gets the synthetic `done:true` from `getImportJob`.
  const IMPORT_JOB_CAP = 16
  const jobs = new Map<string, ImportJobStatus>()
  // The single in-flight (or most recent) bulk re-index aggregate. Main-owned so the renderer can
  // recover the progress bar after navigating away and back via the parameterless getReindexAllJob.
  // Only one runs at a time — beginDocumentWork serialises it against imports/password changes.
  let reindexJob: ReindexJobStatus | null = null
  // Abort handle for the in-flight reindex loop (Cancel button); null when nothing is running.
  let reindexAbort: AbortController | null = null
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

  // D1 (vuln-scan-2026-06-21) — picker capability tokens. The renderer is the untrusted
  // boundary (M-S2) and threat #1 is a code-exec'd renderer using main as a confused deputy to
  // read arbitrary supported-type files via `importDocuments(paths)`. The OS picker is owned by
  // MAIN, so we bind each `pickDocuments` dialog to a one-time token and have `importDocuments`
  // resolve picker imports from it — the renderer can't name a path it didn't pick. (Drag-drop
  // can't be tokenized — the OS hands the drop to the renderer — so that seam is hardened
  // instead; see `hardenDroppedPaths`. Residual documented in security-model.md.)
  const PICKER_TOKEN_CAP = 16
  const pickerTokens = new Map<string, string[]>()
  const mintPickerToken = (paths: string[]): string => {
    const token = randomUUID()
    pickerTokens.set(token, paths)
    while (pickerTokens.size > PICKER_TOKEN_CAP) {
      const oldest = pickerTokens.keys().next().value
      if (oldest === undefined) break
      pickerTokens.delete(oldest)
    }
    return token
  }
  /** Resolve+consume a picker token to the exact paths main returned; [] for unknown/stale. */
  const consumePickerToken = (token: unknown): string[] => {
    if (typeof token !== 'string' || token === '') return []
    const paths = pickerTokens.get(token)
    if (paths === undefined) return []
    pickerTokens.delete(token)
    return paths
  }
  /**
   * Harden the DRAG-DROP seam (D1): the OS delivers a native drop to the renderer, so main can't
   * vouch for these paths via a token. Keep only existing, non-symlink entries and canonicalize
   * them — a renderer can't use a `.pdf`-named symlink to read a sensitive target through the
   * importer, and a deleted/garbage entry simply drops. (A directory is still walked downstream
   * by `expandPaths`, whose internal link-following is intentional per audit L3/L5.)
   */
  const hardenDroppedPaths = (paths: unknown): string[] => {
    const arr = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    const out: string[] = []
    for (const p of arr) {
      try {
        // lstat (does NOT follow links): reject a symlinked top-level entry outright.
        if (lstatSync(p).isSymbolicLink()) continue
        out.push(realpathSync(p))
      } catch {
        // Missing/unreadable — drop it (it would fail to import anyway).
      }
    }
    return out
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

  // GAP-5 (full-audit 2026-07-11) — the requireNoActiveTask mirror for SKILL runs: an in-flight
  // run (extraction/redaction/edit, possibly suspended at a seam await) reads this document's
  // chunks/segments and persists rows against it. Deleting or re-indexing underneath it would
  // interleave with the run — a confusing persistFailed for the user, and (with FK enforcement
  // off) orphaned bank/invoice rows surviving the purge. `ctx.skillRunActive` is assigned by
  // registerSkillsIpc (the controller is module-local there); absent in partial test contexts.
  const requireNoActiveSkillRun = (documentId: string): void => {
    if (ctx.skillRunActive?.(documentId)) {
      throw new Error(tMain('main.docs.skillRunning'))
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

  // `signal` (REL-1): threaded to the parse phase so cancelling an import KILLS an
  // in-flight audio transcription mid-flight. The import job below aborts it on a mid-job
  // workspace lock; the other entry points (re-index) pass none and rely on the
  // transcriber's own inactivity watchdog to bound a wedged child.
  const ingestionDeps = (signal?: AbortSignal): IngestionDeps => ({
    embedder: ctx.embedder,
    cipher: ctx.workspace.documentCipher(),
    transcriber: ctx.transcriber,
    ocrEngine: ctx.ocrEngine,
    onTranscribeProgress: (documentId, percent) => transcribing.set(documentId, percent),
    signal
  })

  // Offer a deep-index (tree) build for a freshly-(re)indexed document. This is fire-and-forget
  // and MUST NOT throw into the import/reindex path (the document is already indexed — only the
  // optional deep-index offer is at stake). The `?.` guards a missing manager, but a throw from
  // the call itself (e.g. a stale running build whose DocTaskManager lacks the method, or a DB
  // hiccup) would otherwise be miscounted as a failed import / reject a successful reindex. Swallow
  // and log so a successfully-indexed doc is never marked failed for a side-effect's sake.
  const offerDeepIndex = (documentId: string): void => {
    try {
      ctx.docTasks?.maybeEnqueueTreeBuild(documentId)
    } catch (err) {
      log.warn('Deep-index offer skipped (non-fatal)', { documentId, error: String(err) })
    }
  }

  // Open the OS file/folder picker in the main process (renderer has no dialog access).
  // Windows cannot mix file + directory selection in one dialog, so the caller chooses a
  // mode: 'files' (default) or 'folder'.
  ipcMain.handle(
    IPC.pickDocuments,
    async (_e, mode?: 'files' | 'folder'): Promise<PickDocumentsResult> => {
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
      const paths = result.canceled ? [] : result.filePaths
      // D1: bind these exact main-vetted paths to a one-time token. The renderer gets `paths`
      // for display/preflight, but `importDocuments` only trusts the token (not the paths).
      return { token: paths.length > 0 ? mintPickerToken(paths) : '', paths }
    }
  )

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
      // M-S2 / D1: the renderer is the untrusted boundary. A PICKER import carries
      // `options.pickerToken`; main resolves it to the exact paths the OS dialog returned and
      // IGNORES the renderer-supplied `paths`, so a code-exec'd renderer can't forge a
      // picker-origin import of an arbitrary file. With NO token this is the drag-drop seam
      // (the OS hands the drop to the renderer, untokenizable) — keep only existing, non-symlink
      // canonicalized paths. Either way, strings are still server-validated downstream
      // (expandPathsWithSource filters to existing, supported files).
      const safePaths =
        typeof options?.pickerToken === 'string' && options.pickerToken
          ? consumePickerToken(options.pickerToken)
          : hardenDroppedPaths(paths)
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
    // DB-6: evict the oldest DONE jobs (insertion order) once over the cap. Never evict an
    // in-flight job — it may be older than the cap on a slow import while newer ones finish, and the
    // background loop + renderer still reference it. The just-set job is in-flight (or done:true only
    // for an empty import), so it survives; a completed job survives ≥16 newer imports — ample for
    // the renderer's final poll.
    if (jobs.size > IMPORT_JOB_CAP) {
      for (const [id, s] of jobs) {
        if (jobs.size <= IMPORT_JOB_CAP) break
        if (s.done) jobs.delete(id)
      }
    }
    log.info('Import started', { jobId, files: documentIds.length })

    // Process in the background; do not block the invoke return.
    //
    // ING-3 — 1-deep parse/embed pipeline. Import was fully serialized (parse → chunk →
    // embed → write, awaited per file), so file N+1's parse (CPU) never overlapped file N's
    // embed (sidecar I/O wait). Now `prepareDocument` (parse+chunk, CPU/disk) of file N+1
    // runs WHILE `finalizeDocument` (embed+mark, sidecar) of file N runs. The embed sidecar
    // is the single contended resource, so embeds are NEVER parallelized — only prepare(N+1)
    // overlaps finalize(N). Per-file statuses, ordering, per-file error isolation, the DB-1
    // per-phase transactions, and the lock-mid-job behavior are all preserved: prepare/
    // finalize are just `processDocument` split at the already-DB-mediated chunk↔embed
    // boundary, and each captures its own failure on the row.
    // Per-job cancellation (REL-1): aborted when the workspace locks mid-job, so an
    // in-flight audio transcription (the unbounded parse) is killed at once rather than
    // waited out. Belt-and-suspenders with the lock's `transcriber.suspend()`.
    const jobAbort = new AbortController()
    void (async () => {
      type Pending = { id: string; promise: Promise<PreparedDocument> }
      // Start the parse+chunk of `documentIds[idx]` (the look-ahead). Skipped (null) past the
      // end or once the workspace is locked. Adds the id to `processing` so reconciliation and
      // the busy gate see it from the moment its parse begins; the consumer removes it.
      const startPrepare = (idx: number): Pending | null => {
        if (idx >= documentIds.length || !ctx.workspace.isUnlocked()) return null
        const id = documentIds[idx]
        processing.add(id)
        return { id, promise: prepareDocument(ctx.db, storeDir, id, ingestionDeps(jobAbort.signal)) }
      }
      let pending = startPrepare(0)
      try {
        for (let i = 0; i < documentIds.length; i++) {
          // Lock-while-importing: the vault can close mid-job ("Lock now"). Stop the loop
          // cleanly — the remaining rows stay non-terminal inside the encrypted snapshot and
          // are reconciled to `failed` (re-indexable) after the next unlock.
          if (!ctx.workspace.isUnlocked()) {
            log.warn('Import stopped: workspace locked mid-job', { jobId })
            // Kill any in-flight audio transcription (the look-ahead prepare) at once.
            jobAbort.abort()
            break
          }
          const id = documentIds[i]
          // `pending` holds prepare(i): kicked off as the prior iteration's look-ahead, or
          // pre-loop for i=0. It is always prepare(i) (the loop never skips an index); if a
          // transient lock left it null, start it inline now.
          const current = pending ?? startPrepare(i)
          // Look ahead: start file i+1's parse so it overlaps file i's embed below.
          pending = startPrepare(i + 1)
          try {
            const prepared = current
              ? await current.promise
              : await prepareDocument(ctx.db, storeDir, id, ingestionDeps(jobAbort.signal))
            const info = await finalizeDocument(ctx.db, id, ingestionDeps(jobAbort.signal), prepared)
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
              // Offer a deep index for documents the cheap capped summary can't fully cover
              // (whole-document-analysis Q1/Q4). Gated + fire-and-forget — never throws here.
              offerDeepIndex(id)
            }
            // Audit: ids + counts only — the filename/title is CONTENT (S1,
            // full-audit-2026-06-30). A user-chosen document name (`biopsy-results.pdf`,
            // `divorce-settlement.pdf`) can be as sensitive as a conversation title, which
            // the chat channel already withholds; and the whole log is exfiltrated verbatim
            // by the plaintext activity-log.json export. documentId resolves the title via
            // the encrypted DB when the user actually needs it.
            ctx.audit?.('document_imported', 'Document imported', {
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
        // A look-ahead prepare may be in flight when the loop broke early (mid-job lock).
        // Drain it so its row settles and its `processing` entry is cleaned up before the job
        // is marked done — otherwise the post-job reconcile (gated on `processing.size === 0`)
        // would never fire. The drained doc is left non-terminal and reconciled after unlock.
        if (pending) {
          try {
            await pending.promise
          } catch {
            /* prepareDocument self-captures failures on the row */
          }
          processing.delete(pending.id)
          transcribing.delete(pending.id)
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
    // DB-3: doc-task ingestions (translation-materialize, OCR re-ingest) drive `documents` rows
    // OUTSIDE this module's `processing` set, so a `listDocuments` poll during their long
    // chunk/embed window would flip a live row to `failed` (the `now` watermark can't protect it —
    // `updated_at` is bumped only at phase transitions, so it is strictly `< now` mid-phase). Gate
    // the docs sweep on `hasActiveTask()` too, matching the tree/extract sweeps below. We keep the
    // `now` watermark deliberately (NOT `PROCESS_START_ISO`): a mid-session lock→unlock strands an
    // import whose `updated_at` is AFTER process start, and only a `now` watermark reconciles it —
    // a `PROCESS_START_ISO` watermark would wedge it forever. The task gate closes the live-flip
    // hole; the `now` watermark keeps recovery working.
    const taskActive = ctx.docTasks?.hasActiveTask() ?? false
    if (!importActive && processing.size === 0) {
      if (!taskActive) {
        const n = reconcileStuckDocuments(ctx.db, new Date().toISOString())
        if (n > 0) log.warn('Reconciled interrupted document ingestions', { count: n })
      }
      // Same treatment for skill runs stranded at 'started' by a killed session (IA-6 P-7). Gated on the
      // process-start watermark (NOT `now`): `skill_runs` bumps no timestamp, so a live in-session run is
      // protected only by its current-session `created_at`, never by this idle-poll firing mid-run.
      const nr = reconcileStuckSkillRuns(ctx.db, PROCESS_START_ISO)
      if (nr > 0) log.warn('Reconciled interrupted skill runs', { count: nr })
      // Reset deep-index builds left `building` by a killed/locked session to `pending`
      // (resumable) — but only when no doc task is live (a running build legitimately holds
      // `building`); the `updated_at < now` clause additionally protects a live build.
      if (!taskActive) {
        const nt = reconcileStuckTrees(ctx.db, new Date().toISOString())
        if (nt > 0) log.warn('Reconciled interrupted deep-index builds', { count: nt })
        // Same treatment for structured-extract passes left `extracting` (Phase 3, resumable).
        const ne = reconcileStuckExtracts(ctx.db, new Date().toISOString())
        if (ne > 0) log.warn('Reconciled interrupted extract passes', { count: ne })
      }
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
    requireNoActiveSkillRun(documentId)
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

  // Read-only in-app preview: re-extracts the stored copy's text. Guarded
  // against racing an in-flight ingestion of the same document (it rewrites the stored
  // copy); in an encrypted workspace the transient decrypted file is shredded inside
  // the service. Nothing is written to the DB and no external viewer ever sees bytes.
  ipcMain.handle(IPC.previewDocument, async (_e, documentId: string): Promise<DocumentPreview> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    log.info('Preview document', { documentId })
    // FE-6: return the BOUNDED first page (+ cursor), never the whole document in one payload.
    return extractDocumentPreviewPage(ctx.db, storeDir, documentId, 0, DEFAULT_PREVIEW_PAGE_SIZE, {
      cipher: ctx.workspace.documentCipher(),
      // Photos re-recognize on preview; OCR'd PDFs read their stored pages.
      ocrEngine: ctx.ocrEngine
    })
  })

  // FE-6: a subsequent bounded page of a preview (the modal's "Show more"). Same guards as the
  // first page; returns the slice at [offset, offset+limit) plus the next cursor.
  ipcMain.handle(
    IPC.previewDocumentPage,
    async (_e, documentId: string, offset: number, limit: number): Promise<DocumentPreview> => {
      requireUnlocked()
      requireNotProcessing(documentId)
      return extractDocumentPreviewPage(
        ctx.db,
        storeDir,
        documentId,
        offset ?? 0,
        limit ?? DEFAULT_PREVIEW_PAGE_SIZE,
        {
          cipher: ctx.workspace.documentCipher(),
          ocrEngine: ctx.ocrEngine
        }
      )
    }
  )

  // Save a TEXT document's stored content to a user-chosen file (the
  // exportConversation pattern: dialog + fs in MAIN, never the renderer). Built for
  // materialized translations (always Markdown); any plain-text document qualifies.
  // Resolves with the saved path, or null when the user cancelled.
  ipcMain.handle(IPC.exportDocument, async (_e, documentId: string): Promise<string | null> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    const { title, text } = await readStoredDocumentText(ctx.db, storeDir, documentId, {
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

  // Save a document's persisted summary to a user-chosen Markdown file (the
  // exportDocument pattern: dialog + fs in MAIN, never the renderer). The summary is
  // CONTENT — only the id is audited, never the text or the chosen path. Resolves with
  // the saved path, or null when the user cancelled or there is no summary.
  ipcMain.handle(IPC.exportSummary, async (_e, documentId: string): Promise<string | null> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    const summary = getDocumentSummary(ctx.db, documentId)
    if (!summary) return null
    const title = getDocument(ctx.db, documentId)?.title ?? 'document'
    const dot = title.lastIndexOf('.')
    const baseName = (dot > 0 ? title.slice(0, dot) : title)
      .replace(/[^\p{L}\p{N} ()_-]/gu, '')
      .trim()
      .slice(0, 60)
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportSummary'),
        defaultPath: `${baseName || 'document'}-summary.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      },
      summary.text
    )
    if (!filePath) return null
    log.info('Summary exported', { documentId })
    // Audit privacy rule: the id only — the chosen path is user-private and the text is content.
    ctx.audit?.('summary_exported', 'Document summary exported to a file', { documentId })
    return filePath
  })

  // The core of a single re-index, shared by the one-shot IPC and the bulk loop: re-embed the
  // document, audit it, and offer a fresh deep index. The `processing` add/delete guard wraps it
  // (the sidecar rewrite must not race a concurrent ingestion of the same doc). Callers hold the
  // `beginDocumentWork` lease and decide how to count the result.
  const reindexOne = async (documentId: string): Promise<DocumentInfo> => {
    processing.add(documentId)
    try {
      const info = await reindexDocument(ctx.db, storeDir, documentId, ingestionDeps())
      // Audit: ids + counts only — the title is CONTENT (S1, full-audit-2026-06-30;
      // same reasoning as document_imported above).
      ctx.audit?.('document_reindexed', 'Document re-indexed', {
        documentId,
        status: info.status,
        chunkCount: info.chunkCount
      })
      // Re-index tore down any prior tree (→ stale); offer a fresh deep index where it
      // helps. The warm summary_cache makes the rebuild cheap despite chunk-id churn.
      if (info.status === 'indexed') offerDeepIndex(documentId)
      return info
    } finally {
      processing.delete(documentId)
      transcribing.delete(documentId)
    }
  }

  ipcMain.handle(IPC.reindexDocument, async (_e, documentId: string): Promise<DocumentInfo> => {
    requireUnlocked()
    requireNotProcessing(documentId)
    requireNoActiveTask(documentId)
    requireNoActiveSkillRun(documentId)
    // Race guard: re-index rewrites the `.enc` sidecar — mutually exclusive
    // with a password change (see importDocuments).
    const releaseDocWork = ctx.workspace.beginDocumentWork()
    log.info('Re-index document', { documentId })
    try {
      return await reindexOne(documentId)
    } finally {
      releaseDocWork()
    }
  })

  // ---- Bulk re-index ("Re-index all" stale / "Retry all" failed) --------------------
  // Main owns the job (like an import) so its determinate progress bar survives navigating away
  // from the Documents screen: the renderer recovers it with the parameterless getReindexAllJob on
  // mount and polls until done. One run at a time — a start while one is in flight returns the
  // running job rather than launching a second loop. The work is sequential (multi-document
  // re-embedding contends on the single embedder), so it reuses the same one-at-a-time discipline
  // as the import loop, holding ONE beginDocumentWork lease for the whole batch.
  ipcMain.handle(IPC.startReindexAll, (_e, documentIds: string[]): ReindexJobStatus => {
    requireUnlocked()
    if (reindexJob && !reindexJob.done) return reindexJob // idempotent while running
    const ids = safeIdArray(documentIds)
    const jobId = randomUUID()
    reindexJob = { jobId, total: ids.length, completed: 0, failed: 0, done: ids.length === 0, cancelled: false }
    if (ids.length === 0) return reindexJob
    const job = reindexJob
    // User-cancel (Cancel button) — checked at each iteration boundary, so the in-flight document
    // finishes and the rest are skipped, exactly like the workspace-lock break above.
    reindexAbort = new AbortController()
    const signal = reindexAbort.signal
    const releaseDocWork = ctx.workspace.beginDocumentWork()
    log.info('Re-index all started', { jobId, total: ids.length })
    void (async () => {
      try {
        for (const id of ids) {
          if (signal.aborted) break // user pressed Cancel
          // Workspace can lock mid-batch ("Lock now"): stop cleanly — the remaining docs keep
          // their current status and the user can retry after unlock.
          if (!ctx.workspace.isUnlocked()) {
            log.warn('Re-index all stopped: workspace locked mid-batch', { jobId })
            break
          }
          // Skip a doc already being processed, held by a live doc task (summary/deep-index), or
          // worked on by a live SKILL run (GAP-5): re-indexing under either would lose the race
          // (see requireNoActiveTask / requireNoActiveSkillRun). Count as failed so total still
          // adds up and the user sees it didn't complete.
          if (processing.has(id) || ctx.docTasks?.isDocumentBusy(id) || ctx.skillRunActive?.(id)) {
            job.failed += 1
            continue
          }
          try {
            const info = await reindexOne(id)
            if (info.status === 'indexed') job.completed += 1
            else job.failed += 1
          } catch (err) {
            job.failed += 1
            log.error('Re-index (batch) crashed', { id, error: String(err) })
          }
        }
      } finally {
        releaseDocWork()
        job.cancelled = signal.aborted
        job.done = true
        reindexAbort = null
        log.info('Re-index all finished', {
          jobId,
          completed: job.completed,
          failed: job.failed,
          cancelled: job.cancelled
        })
      }
    })()
    return reindexJob
  })

  ipcMain.handle(IPC.getReindexAllJob, (): ReindexJobStatus | null => reindexJob)

  // Stop the in-flight bulk re-index. Aborts at the next iteration boundary (the current document
  // finishes); no-op when nothing is running. The job then settles with `cancelled: true`.
  ipcMain.handle(IPC.cancelReindexAll, (): void => {
    if (reindexJob && !reindexJob.done) {
      log.info('Re-index all cancel requested', { jobId: reindexJob.jobId })
      reindexAbort?.abort()
    }
  })
}
