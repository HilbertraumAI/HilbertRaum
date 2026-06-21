import { contextBridge, ipcRenderer } from 'electron'
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
  ExtractionListing,
  ExtractionListingRequest,
  ImageAnalyzeRequest,
  ImageJob,
  ImageSessionDetail,
  ImageSessionSummary,
  ImportJob,
  ImportJobStatus,
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
  RunnableTool,
  RuntimeStatus,
  VisionStatus,
  SkillInfo,
  SkillPreview,
  SkillRunState,
  SkillSuggestion,
  StartDocTaskRequest,
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
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteConversation, conversationId),
  /** Save a transcript to a user-chosen file; resolves with the path, or null on cancel. */
  exportConversation: (conversationId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportConversation, conversationId),
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
    regenerate?: boolean
  ): Promise<Message> =>
    ipcRenderer.invoke(IPC.askDocuments, conversationId, question, skillInstallId, regenerate),

  // ---- Documents ----
  /** Open the OS picker for files (default) or a folder; returns the selected paths (display)
   *  + a one-time capability token to pass back as `importDocuments`' `options.pickerToken`. */
  pickDocuments: (mode?: 'files' | 'folder'): Promise<PickDocumentsResult> =>
    ipcRenderer.invoke(IPC.pickDocuments, mode),
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
    smart?: 'generated' | 'archived' | 'all'
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
  /** Start a document task (summary; translation with `params.targetLang`; compare
   *  with exactly two documentIds). Strictly one at a time; refused while a chat
   *  answer is streaming. */
  startDocTask: (req: StartDocTaskRequest): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(IPC.startDocTask, req),
  /** Poll one task's state/progress (async-with-polling, like imports/downloads). */
  getDocTask: (jobId: string): Promise<DocTaskStatus> =>
    ipcRenderer.invoke(IPC.getDocTask, jobId),
  /** Cancel a task; with no jobId, cancels the currently active one. */
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

  /** Deterministic skill suggestion for the composer picker (skills plan §10.2/S8). The draft
   *  question is content — the main handler scores it and logs nothing. Returns at most one. */
  suggestSkills: (conversationId: string, question?: string): Promise<SkillSuggestion[]> =>
    ipcRenderer.invoke(IPC.suggestSkills, conversationId, question),

  /** Wired, runnable Tier-2 tools for the active skill in this conversation's scope (skills plan
   *  §12.2/§16, S11b). Empty when none apply. Logs nothing — the scope is content (§22-C4). */
  listRunnableTools: (skillInstallId: string, conversationId: string): Promise<RunnableTool[]> =>
    ipcRenderer.invoke(IPC.listRunnableTools, skillInstallId, conversationId),
  /** Start an app-orchestrated tool run from a user action (DS4). Returns ids/counts only. */
  startSkillRun: (req: StartSkillRunRequest): Promise<StartSkillRunResult> =>
    ipcRenderer.invoke(IPC.startSkillRun, req),
  /** Poll one run's ids/counts-only state/progress (the doc-task polling precedent). */
  getSkillRun: (runHandle: string): Promise<SkillRunState | null> =>
    ipcRenderer.invoke(IPC.getSkillRun, runHandle),
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
