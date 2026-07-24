import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENTS, IPC, STREAM, type CompactionNotice, type ScopeNotice } from '../shared/ipc'
import type {
  ActiveStreamSnapshot,
  AppSettings,
  AppStatus,
  AuditEvent,
  BenchmarkResult,
  ChatOptions,
  Collection,
  ContextUsage,
  Conversation,
  ConversationSearchResult,
  ConversationSummaryMarker,
  DocTaskStatus,
  DocumentCoverage,
  DocumentInfo,
  DocumentLifecycle,
  DocumentPreview,
  DocumentScope,
  DownloadJob,
  DriveStatus,
  EngineDownloadJob,
  EngineStatus,
  EvidenceExportRecord,
  EvidenceLinkInput,
  EvidencePackExportRequest,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewBulkAction,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  EvidenceReviewSummary,
  EvidenceSelectionInput,
  EvidenceSourceContext,
  ExtractionListing,
  ExtractionListingRequest,
  ImageAnalyzeRequest,
  ImageJob,
  ImageSessionDetail,
  ImageSessionSummary,
  ImportJob,
  ImportJobStatus,
  ReindexJobStatus,
  ImportOptions,
  ImportPreflight,
  Message,
  ModelInfo,
  ModelState,
  ModelVerifyProgress,
  PickDocumentsResult,
  PolicyStatus,
  PreflightResult,
  RuntimeInstallInfo,
  RunnableToolSet,
  RuntimeStatus,
  VisionStatus,
  SkillInfo,
  SkillPreview,
  SkillReconcileStatus,
  SkillRunState,
  SkillSuggestion,
  SmartListView,
  StartDocTaskRequest,
  TranslateJob,
  TranslateRequest,
  StartSkillRunRequest,
  StartSkillRunResult,
  WorkspaceActionResult,
  WorkspaceMode,
  WorkspaceStateInfo
} from '../shared/types'

// The single, typed bridge between renderer and main. The renderer has no
// direct Node or network access — it can only call what is exposed here.
const api = {
  getAppStatus: (): Promise<AppStatus> => ipcRenderer.invoke(IPC.getAppStatus),
  getDriveStatus: (): Promise<DriveStatus> => ipcRenderer.invoke(IPC.getDriveStatus),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.updateSettings, patch),

  // ---- Privacy / offline policy ----
  /** Effective privacy policy + derived network flags (policy ∧ setting). */
  getPolicy: (): Promise<PolicyStatus> => ipcRenderer.invoke(IPC.getPolicy),

  // ---- Encrypted workspace lifecycle ----
  /** Current workspace state (uninitialized | locked | unlocked) for the unlock gate. */
  getWorkspaceState: (): Promise<WorkspaceStateInfo> =>
    ipcRenderer.invoke(IPC.getWorkspaceState),
  /** Unlock an existing encrypted workspace; a wrong password is a normal failure result. */
  unlockWorkspace: (password: string): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.unlockWorkspace, password),
  /** First-run create of an encrypted (or gated plaintext) workspace. */
  createWorkspace: (password: string, mode: WorkspaceMode): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.createWorkspace, password, mode),
  /** Re-encrypt + shred the working DB and return to the locked state. */
  lockWorkspace: (): Promise<WorkspaceStateInfo> => ipcRenderer.invoke(IPC.lockWorkspace),
  /** Change the vault password (unlocked only). Wrong current password is a
   *  normal failure result, like unlockWorkspace. */
  changeWorkspacePassword: (
    currentPassword: string,
    nextPassword: string
  ): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.changeWorkspacePassword, currentPassword, nextPassword),

  // ---- Models + runtime ----
  // `lazyVerify` (RT-3): the chat path (workspace gate) passes true so only the active
  // model is hashed on a cold cache; the Models screen omits it to hash the full set.
  listModels: (lazyVerify?: boolean): Promise<ModelInfo[]> =>
    ipcRenderer.invoke(IPC.listModels, lazyVerify),
  selectModel: (
    modelId: string
  ): Promise<{ activeModelId: string | null; activeEmbeddingModelId: string | null }> =>
    ipcRenderer.invoke(IPC.selectModel, modelId),
  /** Force a real re-hash of one model's weight file; resolves with the fresh state. */
  verifyModel: (modelId: string): Promise<ModelState> =>
    ipcRenderer.invoke(IPC.verifyModel, modelId),
  startRuntime: (modelId: string): Promise<RuntimeStatus> =>
    ipcRenderer.invoke(IPC.startRuntime, modelId),
  /** Beta #27 (D70): select this model AND start its runtime in one MAIN-side action. */
  useModel: (modelId: string): Promise<RuntimeStatus> =>
    ipcRenderer.invoke(IPC.useModel, modelId),
  stopRuntime: (): Promise<void> => ipcRenderer.invoke(IPC.stopRuntime),
  /** Read-only runtime health/state (Diagnostics, spec §7.11). */
  getRuntimeStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke(IPC.getRuntimeStatus),
  /** The drive's installed sidecar build (.hilbertraum-runtime.json), or null. */
  getRuntimeInstall: (): Promise<RuntimeInstallInfo | null> =>
    ipcRenderer.invoke(IPC.getRuntimeInstall),

  // ---- In-app model downloader ----
  /** Start downloading one model's weights. Gated in the main process (policy ∧ setting);
   *  `licenseAccepted` carries the confirmation dialog's explicit license acknowledgement. */
  downloadModel: (modelId: string, opts?: { licenseAccepted?: boolean }): Promise<DownloadJob> =>
    ipcRenderer.invoke(IPC.downloadModel, modelId, opts),
  /** Poll one download job's progress/status (async-with-polling, like imports). */
  getDownloadJob: (jobId: string): Promise<DownloadJob> =>
    ipcRenderer.invoke(IPC.getDownloadJob, jobId),
  /** Cancel an in-flight download; the partial file is kept for a future resume. */
  cancelDownload: (jobId: string): Promise<DownloadJob> =>
    ipcRenderer.invoke(IPC.cancelDownload, jobId),

  // ---- In-app engine (llama.cpp sidecar) downloader ----
  /** Is the real AI engine installed, and (if not) can it be fetched for this host? */
  getEngineStatus: (): Promise<EngineStatus> => ipcRenderer.invoke(IPC.getEngineStatus),
  /** Start fetching + extracting the host's llama-server build. Gated like model downloads. */
  downloadEngine: (): Promise<EngineDownloadJob> => ipcRenderer.invoke(IPC.downloadEngine),
  /** Poll the engine-download job's progress/status. */
  getEngineJob: (jobId: string): Promise<EngineDownloadJob> =>
    ipcRenderer.invoke(IPC.getEngineJob, jobId),
  /** Cancel an in-flight engine download. */
  cancelEngineDownload: (jobId: string): Promise<EngineDownloadJob> =>
    ipcRenderer.invoke(IPC.cancelEngineDownload, jobId),

  // ---- Image understanding (vision) ----
  /** Is image understanding available (runtime + a verified vision model + projector)? */
  imageGetStatus: (): Promise<VisionStatus> => ipcRenderer.invoke(IPC.imageGetStatus),
  /** Open the OS picker filtered to png/jpg/jpeg; returns an opaque token + name + sizeBytes,
   *  or null. The absolute path stays in MAIN (D2) — readBytes takes only the token. */
  imageChooseImage: (): Promise<{ token: string; name: string; sizeBytes: number } | null> =>
    ipcRenderer.invoke(IPC.imageChooseImage),
  /** Read a PICKED image's bytes by the one-time token from chooseImage (main owns the path +
   *  re-validates extension/cap on the open fd). Drag-drop reads bytes from the File directly
   *  and never calls this (IPC-1). */
  imageReadBytes: (token: string): Promise<Uint8Array> =>
    ipcRenderer.invoke(IPC.imageReadBytes, token),
  /** Start a one-at-a-time analyze; resolves with the initial job (a second one returns busy). */
  imageAnalyze: (req: ImageAnalyzeRequest): Promise<ImageJob> =>
    ipcRenderer.invoke(IPC.imageAnalyze, req),
  /** Poll one analyze job's state (unknown jobId ⇒ terminal failed). */
  imageGetJob: (jobId: string): Promise<ImageJob> => ipcRenderer.invoke(IPC.imageGetJob, jobId),
  /** Cancel an in-flight analyze. */
  imageCancel: (jobId: string): Promise<ImageJob> => ipcRenderer.invoke(IPC.imageCancel, jobId),
  /** Subscribe to streamed answer tokens for an analyze job; returns an unsubscribe fn. */
  onImageToken: (jobId: string, cb: (token: string) => void): (() => void) => {
    const ch = STREAM.imgToken(jobId)
    const handler = (_e: unknown, token: string) => cb(token)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to analyze completion; the terminal ImageJob (with `answer`) is delivered. */
  onImageDone: (jobId: string, cb: (job: ImageJob) => void): (() => void) => {
    const ch = STREAM.imgDone(jobId)
    const handler = (_e: unknown, job: ImageJob) => cb(job)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to analyze failure; the failed ImageJob (a code, never content) is delivered. */
  onImageError: (jobId: string, cb: (job: ImageJob) => void): (() => void) => {
    const ch = STREAM.imgError(jobId)
    const handler = (_e: unknown, job: ImageJob) => cb(job)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** List saved image-analysis history entries (newest first; no image bytes). */
  listImageSessions: (): Promise<ImageSessionSummary[]> =>
    ipcRenderer.invoke(IPC.imageListSessions),
  /** Open one history entry: metadata + DECRYPTED image bytes + all turns (null if missing). */
  getImageSession: (id: string): Promise<ImageSessionDetail | null> =>
    ipcRenderer.invoke(IPC.imageGetSession, id),
  /** Delete one history entry: shred the stored image + cascade-remove its turns. */
  deleteImageSession: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.imageDeleteSession, id),

  // ---- Translate view (TG-4) ----
  /** Start a one-at-a-time text translation on the TranslateGemma sidecar; resolves with the
   *  initial job (a second one while one runs returns busy; a document task holds the lane
   *  returns docTaskBusy; no model installed returns noModel). Tokens stream via onTranslateToken. */
  translateStart: (req: TranslateRequest): Promise<TranslateJob> =>
    ipcRenderer.invoke(IPC.translateStart, req),
  /** Cancel an in-flight text translation. */
  translateCancel: (jobId: string): Promise<TranslateJob> =>
    ipcRenderer.invoke(IPC.translateCancel, jobId),
  /** The active view-translation job (accumulated text + progress), or null — remount recovery
   *  after a full renderer reload (the module store died with it). */
  getActiveTranslateJob: (): Promise<TranslateJob | null> =>
    ipcRenderer.invoke(IPC.translateGetActive),
  /** Subscribe to streamed translation-delta tokens for a job; returns an unsubscribe fn. */
  onTranslateToken: (jobId: string, cb: (token: string) => void): (() => void) => {
    const ch = STREAM.trToken(jobId)
    const handler = (_e: unknown, token: string) => cb(token)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to translation completion; the terminal TranslateJob (with the full `text`). */
  onTranslateDone: (jobId: string, cb: (job: TranslateJob) => void): (() => void) => {
    const ch = STREAM.trDone(jobId)
    const handler = (_e: unknown, job: TranslateJob) => cb(job)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to translation failure; the failed TranslateJob (a code, never content). */
  onTranslateError: (jobId: string, cb: (job: TranslateJob) => void): (() => void) => {
    const ch = STREAM.trError(jobId)
    const handler = (_e: unknown, job: TranslateJob) => cb(job)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },

  // ---- Hardware benchmark ----
  /** Detect hardware + measure drive speed, persist + return the result. Strictly local. */
  runBenchmark: (): Promise<BenchmarkResult> => ipcRenderer.invoke(IPC.runBenchmark),
  /** "Try GPU again": clears the compatibility-mode flag, re-probes, returns fresh settings. */
  tryGpuAgain: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.tryGpuAgain),

  // ---- Launch preflight ----
  /** Friendly, non-blocking first-run drive check (writable / free space / slow drive). */
  runPreflight: (): Promise<PreflightResult> => ipcRenderer.invoke(IPC.runPreflight),

  // ---- Chat ----
  createConversation: (opts?: {
    title?: string
    mode?: 'chat' | 'documents'
    /** "Ask selected documents" scope; only meaningful for documents mode. */
    scopeDocumentIds?: string[] | null
    /** Creation-anchor project (plan §13.4). */
    collectionId?: string | null
    /** Initial composite source scope (plan D1). */
    scope?: DocumentScope | null
  }): Promise<Conversation> => ipcRenderer.invoke(IPC.createConversation, opts),
  /** Replace a conversation's "ask selected documents" scope; null = whole corpus. */
  updateConversationScope: (
    conversationId: string,
    documentIds: string[] | null
  ): Promise<Conversation> =>
    ipcRenderer.invoke(IPC.updateConversationScope, conversationId, documentIds),
  /** Persist a conversation's composite source scope (plan D1); null clears it. */
  setConversationScope: (
    conversationId: string,
    scope: DocumentScope | null
  ): Promise<Conversation> =>
    ipcRenderer.invoke(IPC.setConversationScope, conversationId, scope),
  /** Persist a conversation's creation-anchor project (plan §13.4); null clears it. */
  setConversationCollection: (
    conversationId: string,
    collectionId: string | null
  ): Promise<Conversation> =>
    ipcRenderer.invoke(IPC.setConversationCollection, conversationId, collectionId),
  /** The conversation's temporary chat attachments (plan C3 — for the "Files in this chat"
   *  footer affordance). Only indexed+linked docs; a still-processing one shows as pending. */
  listAttachments: (conversationId: string): Promise<DocumentInfo[]> =>
    ipcRenderer.invoke(IPC.listAttachments, conversationId),
  listConversations: (): Promise<Conversation[]> => ipcRenderer.invoke(IPC.listConversations),
  listMessages: (conversationId: string): Promise<Message[]> =>
    ipcRenderer.invoke(IPC.listMessages, conversationId),
  /** Stream a reply; resolves with the final assistant message. Tokens arrive via onToken. */
  sendChatMessage: (
    conversationId: string,
    content: string,
    options?: ChatOptions
  ): Promise<Message> => ipcRenderer.invoke(IPC.sendChatMessage, conversationId, content, options),
  stopGeneration: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.stopGeneration, conversationId),
  /** Persist a conversation's sticky default skill (skills plan §10.1). Null clears it. */
  setConversationDefaultSkill: (
    conversationId: string,
    installId: string | null
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.setConversationDefaultSkill, conversationId, installId),
  /** Snapshot of an in-flight generation (accumulated answer + reasoning), or null. Lets a
   *  remounted Chat screen recover a reply still streaming after navigating away + back. */
  getActiveStream: (conversationId: string): Promise<ActiveStreamSnapshot | null> =>
    ipcRenderer.invoke(IPC.getActiveStream, conversationId),
  /** Conversation ids with a generation in flight (last = most recent). Lets a freshly-mounted
   *  Chat screen re-select the still-streaming conversation instead of showing an empty new chat. */
  listActiveStreamConversations: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC.listActiveStreamConversations),
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteConversation, conversationId),
  /** Save a transcript to a user-chosen file; resolves with the path, or null on cancel. */
  exportConversation: (conversationId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportConversation, conversationId),
  /** Save one message's attached result table as CSV (result-tables §4); path, or null on cancel. */
  exportMessageTable: (messageId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportMessageTable, messageId),
  /** Full-text search across all conversations. Results group hits per
   *  conversation, best match first; snippets carry SEARCH_MARK_* highlight markers. */
  searchConversations: (query: string): Promise<ConversationSearchResult[]> =>
    ipcRenderer.invoke(IPC.searchConversations, query),
  /** Resting-state context-window usage for the composer meter (context-compaction §5.1). The
   *  assembled-prompt estimate over the launched window; null for an unknown conversation. */
  getConversationContextUsage: (conversationId: string): Promise<ContextUsage | null> =>
    ipcRenderer.invoke(IPC.getConversationContextUsage, conversationId),
  /** The latest compaction summary + where its transcript marker sits (context-compaction §5.3),
   *  or null when no checkpoint has been cut / compaction is disabled. */
  getConversationSummary: (conversationId: string): Promise<ConversationSummaryMarker | null> =>
    ipcRenderer.invoke(IPC.getConversationSummary, conversationId),
  /** Tail of the local log file (Diagnostics, spec §7.11). Local-only. */
  getLogTail: (): Promise<string[]> => ipcRenderer.invoke(IPC.getLogTail),
  /** Save the full local log to a user-chosen file (plaintext); path, or null on cancel. */
  exportLog: (): Promise<string | null> => ipcRenderer.invoke(IPC.exportLog),
  /** Copy text to the OS clipboard. The write happens in MAIN (`clipboard:write`) — the
   *  sandboxed preload has no access to Electron's `clipboard` module, and
   *  `navigator.clipboard` needs a secure context + focused document and is unreliable in a
   *  file://-loaded renderer (it threw the "Zwischenablage" copy error). Resolves to whether
   *  the write succeeded. */
  copyToClipboard: (text: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.writeClipboard, text),

  // ---- Audit log ----
  /** Page through the local activity log, newest-first (`beforeId` = "load more" cursor). */
  getAuditEvents: (limit?: number, beforeId?: string | null): Promise<AuditEvent[]> =>
    ipcRenderer.invoke(IPC.getAuditEvents, limit, beforeId),
  /** Save the activity log to a user-chosen file; resolves with the path, or null on cancel. */
  exportAuditLog: (): Promise<string | null> => ipcRenderer.invoke(IPC.exportAuditLog),

  // ---- Voice dictation ----
  /** Transcribe recorded composer audio (16 kHz mono WAV bytes) into plain text, fully
   *  locally. The audio exists in main only as a shredded transient; nothing is stored,
   *  logged, or audited, and the text is only ever inserted for review — never sent. */
  transcribeDictation: (audio: Uint8Array): Promise<string> =>
    ipcRenderer.invoke(IPC.transcribeDictation, audio),

  // ---- RAG / document Q&A ----
  /** Stream a document-grounded answer; resolves with the final assistant message
   *  (which carries `citations`). Tokens arrive via onToken, like sendChatMessage. */
  askDocuments: (
    conversationId: string,
    question: string,
    skillInstallId?: string | null,
    regenerate?: boolean,
    /** U3 (audit ux-6): pin retrieval to ONE document (the routed-run relay passes the run's target),
     *  narrowing within the resolved scope. UNTRUSTED — main re-validates it against the in-scope set
     *  and ignores an out-of-scope id. Absent ⇒ the ordinary conversation scope applies. */
    pinnedDocumentId?: string | null
  ): Promise<Message> =>
    ipcRenderer.invoke(IPC.askDocuments, conversationId, question, skillInstallId, regenerate, pinnedDocumentId),

  // ---- Documents ----
  /** Open the OS picker for files (default) or a folder; returns the selected paths (display)
   *  + a one-time capability token to pass back as `importDocuments`' `options.pickerToken`. */
  pickDocuments: (mode?: 'files' | 'folder'): Promise<PickDocumentsResult> =>
    ipcRenderer.invoke(IPC.pickDocuments, mode),
  /** Resolve a DROPPED file's absolute path. Electron removed the non-standard `File.path` in
   *  v32 (FE-A); `webUtils.getPathForFile` is the replacement and is only callable from the
   *  (sandboxed) preload — never the renderer. NOT an IPC round-trip: webUtils is synchronous
   *  and in-process here, so this is a plain bridge function (no new IPC channel). Returns ''
   *  for a File with no on-disk path (a browser-origin drag); main re-validates every path
   *  (existence + supported extension) on import, so a spoofed value simply fails to import. */
  getDroppedFilePath: (file: File): string => webUtils.getPathForFile(file),
  /** Import files. `options.destination` routes them (Library / a project / Temporary / a
   *  chat attachment, plan §11.3); omitted ⇒ Library, byte-for-byte with old callers. For a
   *  PICKER import pass `options.pickerToken` from `pickDocuments` (D1) — main then ignores
   *  `paths` and imports exactly what was picked. Drag-drop omits the token (hardened in main). */
  importDocuments: (paths: string[], options?: ImportOptions): Promise<ImportJob> =>
    ipcRenderer.invoke(IPC.importDocuments, paths, options),
  /** What a picked selection contains — drives the audio size confirm. */
  importPreflight: (paths: string[]): Promise<ImportPreflight> =>
    ipcRenderer.invoke(IPC.importPreflight, paths),
  getImportJob: (jobId: string): Promise<ImportJobStatus> =>
    ipcRenderer.invoke(IPC.getImportJob, jobId),
  /** List documents, optionally filtered to a collection / lifecycle / smart view (plan §16). */
  listDocuments: (filter?: {
    collectionId?: string
    lifecycle?: DocumentLifecycle
    // F-28: was narrowed to 'generated'|'archived'|'all', but main's DocumentListFilter accepts the
    // full shared SmartListView (registerDocsIpc filterDocuments implements 'recent' + matchesSmartView
    // covers the rest); the bridge type must not forbid values main supports. Type-only — the value
    // rides ipcRenderer.invoke unchanged.
    smart?: SmartListView
  }): Promise<DocumentInfo[]> => ipcRenderer.invoke(IPC.listDocuments, filter),
  /** Add documents to a collection (membership; idempotent). "Move" = add then remove. */
  addToCollection: (documentIds: string[], collectionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.addToCollection, documentIds, collectionId),
  /** Remove documents from a collection (membership only; the documents are untouched). */
  removeFromCollection: (documentIds: string[], collectionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.removeFromCollection, documentIds, collectionId),
  /** Set documents' retention lifecycle; resolves with the updated documents. */
  setDocumentLifecycle: (
    documentIds: string[],
    lifecycle: DocumentLifecycle
  ): Promise<DocumentInfo[]> =>
    ipcRenderer.invoke(IPC.setDocumentLifecycle, documentIds, lifecycle),
  deleteDocument: (documentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteDocument, documentId),
  reindexDocument: (documentId: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.reindexDocument, documentId),
  /** Start a bulk re-index of the given documents (stale "Re-index all" / failed "Retry all").
   *  Main owns the job so the progress bar survives navigation. Idempotent while one is running. */
  startReindexAll: (documentIds: string[]): Promise<ReindexJobStatus> =>
    ipcRenderer.invoke(IPC.startReindexAll, documentIds),
  /** The current/last bulk re-index job, or null. Parameterless so the renderer re-attaches the
   *  progress bar on mount. */
  getReindexAllJob: (): Promise<ReindexJobStatus | null> =>
    ipcRenderer.invoke(IPC.getReindexAllJob),
  /** Stop the in-flight bulk re-index (the current document finishes; the rest are skipped). */
  cancelReindexAll: (): Promise<void> => ipcRenderer.invoke(IPC.cancelReindexAll),
  /** Read-only in-app preview: the document's extracted text — FE-6 returns the BOUNDED first
   *  page (+ a `nextOffset` cursor when there is more). */
  previewDocument: (documentId: string): Promise<DocumentPreview> =>
    ipcRenderer.invoke(IPC.previewDocument, documentId),
  /** FE-6: fetch a subsequent preview page (the modal's "Show more"). */
  previewDocumentPage: (
    documentId: string,
    offset: number,
    limit: number
  ): Promise<DocumentPreview> =>
    ipcRenderer.invoke(IPC.previewDocumentPage, documentId, offset, limit),
  /** Save a text document's stored content (e.g. a translation) to a user-chosen
   *  file; resolves with the path, or null on cancel. */
  exportDocument: (documentId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportDocument, documentId),
  /** Save a document's persisted summary (Markdown) to a user-chosen file;
   *  resolves with the path, or null on cancel / when there is no summary. */
  exportSummary: (documentId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportSummary, documentId),

  // ---- Document tasks ----
  /** Start a document task (summary; translation with `params.sourceLang` +
   *  `params.targetLang` — both from the closed 51-code WMT24++ set
   *  (`TRANSLATION_LANGUAGE_CODES`, widened at issue #31), source ≠ target, TranslateGemma
   *  required (TG-3); compare with exactly two documentIds). Strictly one at a time;
   *  refused while a chat answer is streaming. */
  startDocTask: (req: StartDocTaskRequest): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(IPC.startDocTask, req),
  /** Poll one task's state/progress (async-with-polling, like imports/downloads). */
  getDocTask: (jobId: string): Promise<DocTaskStatus> =>
    ipcRenderer.invoke(IPC.getDocTask, jobId),
  /** The currently running document task's status (a copy), or null when idle — reload adoption
   *  for the file/document translation path (the `getActiveTranslateJob` precedent for text). */
  getActiveDocTask: (): Promise<DocTaskStatus | null> =>
    ipcRenderer.invoke(IPC.getActiveDocTask),
  /** Cancel a task. With no jobId, cancels the currently active one; with a jobId it is a TARGETED
   *  cancel — it cancels ONLY when that id is the active task (FA-3 / F-6), so a stale Stop can
   *  never kill a task that took the lane after the caller's own task settled. */
  cancelDocTask: (jobId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.cancelDocTask, jobId),
  /** Read-only coverage + source provenance of a document's current summary (whole-document
   *  -analysis plan §5.1). No model call; null when the document is gone. */
  documentCoverage: (documentId: string): Promise<DocumentCoverage | null> =>
    ipcRenderer.invoke(IPC.documentCoverage, documentId),
  /** Read-only "list every X" aggregation over precomputed structured extractions
   *  (whole-document-analysis plan §4.2/§5.1). Zero model calls; null for an invalid type. */
  listAllExtractions: (req: ExtractionListingRequest): Promise<ExtractionListing | null> =>
    ipcRenderer.invoke(IPC.listAllExtractions, req),

  // ---- Document organization — collections (projects + built-ins, plan §16) ----
  /** All collections (built-ins first, then projects by name). */
  listCollections: (): Promise<Collection[]> => ipcRenderer.invoke(IPC.listCollections),
  /** Create a project. */
  createCollection: (
    name: string,
    opts?: { description?: string | null; color?: string | null }
  ): Promise<Collection> => ipcRenderer.invoke(IPC.createCollection, name, opts),
  /** Rename a collection. */
  renameCollection: (id: string, name: string): Promise<Collection> =>
    ipcRenderer.invoke(IPC.renameCollection, id, name),
  /** Archive / unarchive a project (a scope-target change, not a global exclusion — C1). */
  setCollectionArchived: (id: string, archived: boolean): Promise<Collection> =>
    ipcRenderer.invoke(IPC.setCollectionArchived, id, archived),
  /** Delete a project — 'membershipOnly' keeps docs; 'withDocuments' deletes project-only docs (C2). */
  deleteCollection: (id: string, mode: 'membershipOnly' | 'withDocuments'): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteCollection, id, mode),

  // ---- Evidence Pack / Review Mode (EP-1 plan §6.4, spec §19) ----
  // All handlers are DB-backed (unlock-gated) and touch NO model runtime and NO network.
  // The renderer sends ids + user-entered review text only; snapshots and source
  // resolution stay main-side.
  /** Create the draft review for one assistant message from PERSISTED data (idempotent:
   *  an existing review is returned, never duplicated; no model call ever). */
  createEvidenceReview: (messageId: string): Promise<EvidenceReviewDetail> =>
    ipcRenderer.invoke(IPC.createEvidenceReview, messageId),
  /** The full review read-model, or null on an unknown id. */
  getEvidenceReview: (reviewId: string): Promise<EvidenceReviewDetail | null> =>
    ipcRenderer.invoke(IPC.getEvidenceReview, reviewId),
  /** The message's review as a light summary (the entry-point/action-row state), or null. */
  getEvidenceReviewForMessage: (messageId: string): Promise<EvidenceReviewSummary | null> =>
    ipcRenderer.invoke(IPC.getEvidenceReviewForMessage, messageId),
  /** EVERY review in one conversation as light summaries — the transcript's whole chip state
   *  in ONE round trip (AUD-12), keyed by `messageId` on the renderer side. Empty array for
   *  an unknown conversation. */
  getEvidenceReviewSummariesForConversation: (
    conversationId: string
  ): Promise<EvidenceReviewSummary[]> =>
    ipcRenderer.invoke(IPC.getEvidenceReviewSummariesForConversation, conversationId),
  /** Patch head fields (title D-6, reviewer label D-3, general note); null on unknown id. */
  updateEvidenceReview: (
    reviewId: string,
    patch: EvidenceReviewPatch
  ): Promise<EvidenceReview | null> =>
    ipcRenderer.invoke(IPC.updateEvidenceReview, reviewId, patch),
  /** Patch one item's decision/note; null on unknown id. */
  updateEvidenceReviewItem: (
    itemId: string,
    patch: EvidenceReviewItemPatch
  ): Promise<EvidenceReviewItem | null> =>
    ipcRenderer.invoke(IPC.updateEvidenceReviewItem, itemId, patch),
  /** Apply one conservative bulk decision action to the whole review in a SINGLE main-side
   *  transaction (AUD-13) — all of it lands or none of it does. Returns the refreshed items,
   *  or null on an unknown id, an unrecognized action, or a READY review (reopen first). */
  applyEvidenceReviewBulkAction: (
    reviewId: string,
    action: EvidenceReviewBulkAction
  ): Promise<EvidenceReviewItem[] | null> =>
    ipcRenderer.invoke(IPC.applyEvidenceReviewBulkAction, reviewId, action),
  /** Carve a reviewer selection from one block (UTF-16 offsets into its `textSnapshot`,
   *  exclusive end). Null = refused (unknown block, out-of-range or surrogate-splitting
   *  offsets — never clamped). */
  createEvidenceSelection: (
    reviewId: string,
    input: EvidenceSelectionInput
  ): Promise<EvidenceReviewItem | null> =>
    ipcRenderer.invoke(IPC.createEvidenceSelection, reviewId, input),
  /** Delete a reviewer SELECTION (block items are structural and refuse — false). */
  deleteEvidenceSelection: (itemId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deleteEvidenceSelection, itemId),
  /** Upsert one item→source link. Reviewer-made links are ALWAYS `origin: 'reviewer'`
   *  ("Reviewer linked" — main forces it; only the snapshot builder mints 'answer_marker').
   *  Returns the refreshed item, or null on an unknown item/source key. */
  setEvidenceLink: (
    itemId: string,
    evidenceKey: string,
    input: EvidenceLinkInput
  ): Promise<EvidenceReviewItem | null> =>
    ipcRenderer.invoke(IPC.setEvidenceLink, itemId, evidenceKey, input),
  /** Remove one item→source link; true when a link was removed. */
  removeEvidenceLink: (itemId: string, evidenceKey: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.removeEvidenceLink, itemId, evidenceKey),
  /** Mark a review ready (D-7 gated): `{ review, gate }` — while ineligible the review is
   *  returned UNCHANGED with the gate saying why. Null on unknown id. */
  markEvidenceReviewReady: (
    reviewId: string
  ): Promise<{ review: EvidenceReview; gate: EvidenceReadyGate } | null> =>
    ipcRenderer.invoke(IPC.markEvidenceReviewReady, reviewId),
  /** Reopen a ready review to draft (spec §18.4); null on unknown id. */
  reopenEvidenceReview: (reviewId: string): Promise<EvidenceReview | null> =>
    ipcRenderer.invoke(IPC.reopenEvidenceReview, reviewId),
  /** Freshness check (spec §21.2, real since Phase 4): snapshot vs workspace from STORED
   *  facts only (stored hashes — never re-hashed; answer text; coverage). Null on unknown
   *  id. Unresolved identities report 'unverifiable', never 'changed'. */
  refreshEvidenceReviewState: (reviewId: string): Promise<EvidenceReviewFreshness | null> =>
    ipcRenderer.invoke(IPC.refreshEvidenceReviewState, reviewId),
  /** Acknowledge the CURRENT drift of an outdated review (spec §15.5/§28.6) — persists the
   *  drift fingerprint + stamp (a later change re-demands one) and unlocks export. No-op
   *  on a non-outdated review; null on unknown id. Never rewrites status/completed_at. */
  acknowledgeEvidenceReviewFreshness: (reviewId: string): Promise<EvidenceReviewFreshness | null> =>
    ipcRenderer.invoke(IPC.acknowledgeEvidenceReviewFreshness, reviewId),
  /** Source-in-context (D-5): the STORED extracted text around one source's persisted
   *  excerpt, resolved main-side from the review's own snapshot (review id + source KEY —
   *  never a document id or path from the renderer). Null on unknown review/key and on
   *  unresolved-identity sources. */
  getEvidenceSourceContext: (
    reviewId: string,
    sourceKey: string
  ): Promise<EvidenceSourceContext | null> =>
    ipcRenderer.invoke(IPC.getEvidenceSourceContext, reviewId, sourceKey),
  /** Delete a review (items/links/export records CASCADE); true when a row was deleted. */
  deleteEvidenceReview: (reviewId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.deleteEvidenceReview, reviewId),
  /** How many reviews this conversation's messages carry — the D-2 delete-confirm count. */
  countEvidenceReviewsForConversation: (conversationId: string): Promise<number> =>
    ipcRenderer.invoke(IPC.countEvidenceReviewsForConversation, conversationId),
  /** Export the review as an evidence pack — self-contained HTML or PDF (Phase 3 plan
   *  §8.3; PDF Phase 6 plan §11 via a hidden-window print of the same HTML): save dialog
   *  (both format filters, requested first; the chosen extension wins) → deterministic
   *  render → ATOMIC write → export record. Null on cancel or an unknown id; a failure up
   *  to the rename — including a failed PDF print — leaves no file and no row (spec
   *  §28.9), and a post-rename record failure removes the file and REJECTS with honest
   *  localized copy (a distinct message when even the removal failed and the file exists
   *  unrecorded) — null never means "exported". Partial options resolve against
   *  `EVIDENCE_PACK_OPTION_DEFAULTS` main-side; an absent/unknown `format` reads 'html'.
   *  No model call, no network. */
  exportEvidencePack: (
    reviewId: string,
    options: EvidencePackExportRequest
  ): Promise<EvidenceExportRecord | null> =>
    ipcRenderer.invoke(IPC.exportEvidencePack, reviewId, options),

  // Skills (instruction packages; skills plan §16).
  /** All installed skills (app first, then by title). */
  listSkills: (): Promise<SkillInfo[]> => ipcRenderer.invoke(IPC.listSkills),
  /** One skill by install id, or null. */
  getSkill: (installId: string): Promise<SkillInfo | null> => ipcRenderer.invoke(IPC.getSkill, installId),
  /** Open the OS picker for a `.skill.zip` file or a skill folder; returns the path or null. */
  pickSkillPackage: (mode?: 'file' | 'folder'): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickSkillPackage, mode),
  /** Validate an import source fully, without writing — the permission-summary preview (§9.2). */
  previewSkillPackage: (source: string): Promise<SkillPreview> =>
    ipcRenderer.invoke(IPC.previewSkillPackage, source),
  /** Install a validated skill (enabled-with-warning, DS7); rejects friendly on a bad package. */
  importSkill: (source: string): Promise<SkillInfo> => ipcRenderer.invoke(IPC.importSkill, source),
  /** Export a skill to a user-chosen `.skill.zip` (package tree only); null if cancelled. */
  exportSkill: (installId: string): Promise<string | null> => ipcRenderer.invoke(IPC.exportSkill, installId),
  /** Delete a user skill (app skills refuse). */
  deleteSkill: (installId: string): Promise<void> => ipcRenderer.invoke(IPC.deleteSkill, installId),
  /** Enable a skill (one-active-per-id). */
  enableSkill: (installId: string): Promise<SkillInfo> => ipcRenderer.invoke(IPC.enableSkill, installId),
  /** Disable a skill. */
  disableSkill: (installId: string): Promise<SkillInfo> => ipcRenderer.invoke(IPC.disableSkill, installId),
  /** Acknowledge a user skill's import warning (DS7). */
  acknowledgeSkillWarning: (installId: string): Promise<SkillInfo> =>
    ipcRenderer.invoke(IPC.acknowledgeSkillWarning, installId),
  /** Counts + fixed reason codes of skill folders the last reconcile could not read (SKA-32). */
  getSkillReconcileStatus: (): Promise<SkillReconcileStatus> =>
    ipcRenderer.invoke(IPC.skillReconcileStatus),

  /** Deterministic skill suggestion for the composer picker (skills plan §10.2/S8). The draft
   *  question is content — the main handler scores it and logs nothing. Returns at most one. */
  suggestSkills: (conversationId: string, question?: string): Promise<SkillSuggestion[]> =>
    ipcRenderer.invoke(IPC.suggestSkills, conversationId, question),

  /** Wired, runnable Tier-2 tools for the active skill in this conversation's scope, plus the
   *  in-scope target document IDS (skills plan §12.2/§16, S11b; audit U-1). Empty when none apply.
   *  Logs nothing; carries ids only — the renderer maps ids→names, so no title crosses the IPC. */
  listRunnableTools: (skillInstallId: string, conversationId: string): Promise<RunnableToolSet> =>
    ipcRenderer.invoke(IPC.listRunnableTools, skillInstallId, conversationId),
  /** Start an app-orchestrated tool run from a user action (DS4). Returns ids/counts only. */
  startSkillRun: (req: StartSkillRunRequest): Promise<StartSkillRunResult> =>
    ipcRenderer.invoke(IPC.startSkillRun, req),
  /** Poll one run's ids/counts-only state/progress (the doc-task polling precedent). */
  getSkillRun: (runHandle: string): Promise<SkillRunState | null> =>
    ipcRenderer.invoke(IPC.getSkillRun, runHandle),
  /** All runs main currently holds (running + terminal-but-unacknowledged), ids/counts only — the
   *  renderer re-adopts them on a fresh mount after a reload (SKA-17). */
  listSkillRuns: (): Promise<SkillRunState[]> => ipcRenderer.invoke(IPC.listSkillRuns),
  /** Cancel a run; with no handle, the active run. */
  cancelSkillRun: (runHandle?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.cancelSkillRun, runHandle),
  /** Drop a terminal run main-side once its outcome has been shown (the acknowledge handshake). */
  clearSkillRun: (runHandle?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.clearSkillRun, runHandle),

  /** Subscribe to streamed tokens for a request (= conversation id); returns an unsubscribe fn. */
  onToken: (requestId: string, cb: (token: string) => void): (() => void) => {
    const ch = STREAM.token(requestId)
    const handler = (_e: unknown, token: string) => cb(token)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to stream completion; the final assistant Message is delivered. */
  onDone: (requestId: string, cb: (message: Message) => void): (() => void) => {
    const ch = STREAM.done(requestId)
    const handler = (_e: unknown, message: Message) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to stream errors. */
  onError: (requestId: string, cb: (message: string) => void): (() => void) => {
    const ch = STREAM.error(requestId)
    const handler = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to Deep-mode reasoning deltas — separate from answer tokens,
   *  shown live as the collapsed "Thinking…" block and never persisted. */
  onReasoning: (requestId: string, cb: (delta: string) => void): (() => void) => {
    const ch = STREAM.reasoning(requestId)
    const handler = (_e: unknown, delta: string) => cb(delta)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to the one-shot "answering from this file only" auto-scope notice for a
   *  document answer (fired once before tokens; ephemeral, never persisted). */
  onScopeNotice: (requestId: string, cb: (notice: ScopeNotice) => void): (() => void) => {
    const ch = STREAM.scope(requestId)
    const handler = (_e: unknown, notice: ScopeNotice) => cb(notice)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to the one-shot "summarizing earlier messages…" notice fired when the context
   *  -compaction pre-pass starts for this turn (ephemeral, never persisted; §5.2). */
  onCompaction: (requestId: string, cb: (notice: CompactionNotice) => void): (() => void) => {
    const ch = STREAM.compaction(requestId)
    const handler = (_e: unknown, notice: CompactionNotice) => cb(notice)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to the one-shot REAL assembled-prompt context usage of an in-flight turn (fired
   *  once after prompt assembly; ephemeral, never persisted). It carries what the renderer's
   *  word estimate cannot see — a document turn's injected excerpt/whole-document block — so the
   *  composer meter reads true while the answer streams. */
  onContextUsage: (requestId: string, cb: (usage: ContextUsage) => void): (() => void) => {
    const ch = STREAM.usage(requestId)
    const handler = (_e: unknown, usage: ContextUsage) => cb(usage)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to one-line runtime notices (e.g. the compatibility-mode fallback). */
  onRuntimeNotice: (cb: (message: string) => void): (() => void) => {
    const handler = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on(EVENTS.runtimeNotice, handler)
    return () => ipcRenderer.removeListener(EVENTS.runtimeNotice, handler)
  },
  /** Subscribe to first-run checksum-verification progress (the gate + Models bar).
   *  Broadcast while a `listModels` call hashes weights; returns an unsubscribe fn. */
  onModelVerifyProgress: (cb: (p: ModelVerifyProgress) => void): (() => void) => {
    const handler = (_e: unknown, p: ModelVerifyProgress) => cb(p)
    ipcRenderer.on(EVENTS.modelVerifyProgress, handler)
    return () => ipcRenderer.removeListener(EVENTS.modelVerifyProgress, handler)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
