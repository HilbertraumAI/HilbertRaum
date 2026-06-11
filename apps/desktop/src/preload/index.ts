import { contextBridge, ipcRenderer } from 'electron'
import { EVENTS, IPC, STREAM } from '../shared/ipc'
import type {
  AppSettings,
  AppStatus,
  AuditEvent,
  BenchmarkResult,
  ChatOptions,
  Conversation,
  ConversationSearchResult,
  DocumentInfo,
  DocumentPreview,
  DownloadJob,
  DriveStatus,
  ImportJob,
  ImportJobStatus,
  Message,
  ModelInfo,
  ModelState,
  PolicyStatus,
  PreflightResult,
  RuntimeInstallInfo,
  RuntimeStatus,
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

  // ---- Privacy / offline policy (Phase 8) ----
  /** Effective privacy policy + derived network flags (policy ∧ setting). */
  getPolicy: (): Promise<PolicyStatus> => ipcRenderer.invoke(IPC.getPolicy),

  // ---- Encrypted workspace lifecycle (Phase 9) ----
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
  /** Change the vault password (Phase 32; unlocked only). Wrong current password is a
   *  normal failure result, like unlockWorkspace. */
  changeWorkspacePassword: (
    currentPassword: string,
    nextPassword: string
  ): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.changeWorkspacePassword, currentPassword, nextPassword),

  // ---- Models + runtime (Phase 2) ----
  listModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.listModels),
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
  /** The drive's installed sidecar build (.paid-runtime.json), or null (Phase 16). */
  getRuntimeInstall: (): Promise<RuntimeInstallInfo | null> =>
    ipcRenderer.invoke(IPC.getRuntimeInstall),

  // ---- In-app model downloader (Phase 18) ----
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

  // ---- Hardware benchmark (Phase 7) ----
  /** Detect hardware + measure drive speed, persist + return the result. Strictly local. */
  runBenchmark: (): Promise<BenchmarkResult> => ipcRenderer.invoke(IPC.runBenchmark),
  /** "Try GPU again": clears the compatibility-mode flag, re-probes, returns fresh settings. */
  tryGpuAgain: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.tryGpuAgain),

  // ---- Launch preflight (Phase 13) ----
  /** Friendly, non-blocking first-run drive check (writable / free space / slow drive). */
  runPreflight: (): Promise<PreflightResult> => ipcRenderer.invoke(IPC.runPreflight),

  // ---- Chat (Phase 3) ----
  createConversation: (opts?: {
    title?: string
    mode?: 'chat' | 'documents'
    /** "Ask selected documents" scope (Phase 17); only meaningful for documents mode. */
    scopeDocumentIds?: string[] | null
  }): Promise<Conversation> => ipcRenderer.invoke(IPC.createConversation, opts),
  /** Replace a conversation's "ask selected documents" scope; null = whole corpus. */
  updateConversationScope: (
    conversationId: string,
    documentIds: string[] | null
  ): Promise<Conversation> =>
    ipcRenderer.invoke(IPC.updateConversationScope, conversationId, documentIds),
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
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteConversation, conversationId),
  /** Save a transcript to a user-chosen file; resolves with the path, or null on cancel. */
  exportConversation: (conversationId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.exportConversation, conversationId),
  /** Full-text search across all conversations (Phase 31). Results group hits per
   *  conversation, best match first; snippets carry SEARCH_MARK_* highlight markers. */
  searchConversations: (query: string): Promise<ConversationSearchResult[]> =>
    ipcRenderer.invoke(IPC.searchConversations, query),
  /** Tail of the local log file (Diagnostics, spec §7.11). Local-only. */
  getLogTail: (): Promise<string[]> => ipcRenderer.invoke(IPC.getLogTail),

  // ---- Audit log (Phase 19) ----
  /** Page through the local activity log, newest-first (`beforeId` = "load more" cursor). */
  getAuditEvents: (limit?: number, beforeId?: string | null): Promise<AuditEvent[]> =>
    ipcRenderer.invoke(IPC.getAuditEvents, limit, beforeId),
  /** Save the activity log to a user-chosen file; resolves with the path, or null on cancel. */
  exportAuditLog: (): Promise<string | null> => ipcRenderer.invoke(IPC.exportAuditLog),

  // ---- RAG / document Q&A (Phase 6) ----
  /** Stream a document-grounded answer; resolves with the final assistant message
   *  (which carries `citations`). Tokens arrive via onToken, like sendChatMessage. */
  askDocuments: (conversationId: string, question: string): Promise<Message> =>
    ipcRenderer.invoke(IPC.askDocuments, conversationId, question),

  // ---- Documents (Phase 4) ----
  /** Open the OS picker for files (default) or a folder; returns selected paths. */
  pickDocuments: (mode?: 'files' | 'folder'): Promise<string[]> =>
    ipcRenderer.invoke(IPC.pickDocuments, mode),
  importDocuments: (paths: string[]): Promise<ImportJob> =>
    ipcRenderer.invoke(IPC.importDocuments, paths),
  getImportJob: (jobId: string): Promise<ImportJobStatus> =>
    ipcRenderer.invoke(IPC.getImportJob, jobId),
  listDocuments: (): Promise<DocumentInfo[]> => ipcRenderer.invoke(IPC.listDocuments),
  deleteDocument: (documentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteDocument, documentId),
  reindexDocument: (documentId: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.reindexDocument, documentId),
  /** Read-only in-app preview: the document's extracted text segments. */
  previewDocument: (documentId: string): Promise<DocumentPreview> =>
    ipcRenderer.invoke(IPC.previewDocument, documentId),

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
  /** Subscribe to Deep-mode reasoning deltas (Phase 20) — separate from answer tokens,
   *  shown live as the collapsed "Thinking…" block and never persisted. */
  onReasoning: (requestId: string, cb: (delta: string) => void): (() => void) => {
    const ch = STREAM.reasoning(requestId)
    const handler = (_e: unknown, delta: string) => cb(delta)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
  /** Subscribe to one-line runtime notices (Phase 15: compatibility-mode fallback). */
  onRuntimeNotice: (cb: (message: string) => void): (() => void) => {
    const handler = (_e: unknown, message: string) => cb(message)
    ipcRenderer.on(EVENTS.runtimeNotice, handler)
    return () => ipcRenderer.removeListener(EVENTS.runtimeNotice, handler)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
