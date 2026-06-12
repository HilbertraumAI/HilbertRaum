// Central registry of IPC channel names so main + preload never drift.
export const IPC = {
  getAppStatus: 'app:getAppStatus',
  getDriveStatus: 'app:getDriveStatus',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  // Privacy/offline policy
  getPolicy: 'policy:get',
  // Models + runtime
  listModels: 'models:list',
  selectModel: 'models:select',
  /**
   * Force a REAL re-hash of one model's weight file (drops the persisted checksum
   * cache entry first) — the Models screen's "Verify checksum" button. `listModels`
   * itself reads through the cache and never re-hashes an unchanged file.
   */
  verifyModel: 'models:verify',
  startRuntime: 'runtime:start',
  stopRuntime: 'runtime:stop',
  /** Read-only runtime health/state for Diagnostics (spec §7.11). */
  getRuntimeStatus: 'runtime:status',
  /** The drive's installed sidecar build (the .paid-runtime.json marker). */
  getRuntimeInstall: 'runtime:install',
  // Chat
  createConversation: 'chat:createConversation',
  listConversations: 'chat:listConversations',
  listMessages: 'chat:listMessages',
  sendChatMessage: 'chat:send',
  stopGeneration: 'chat:stop',
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: 'chat:deleteConversation',
  /** Replace a documents-conversation's "ask selected documents" scope. */
  updateConversationScope: 'chat:updateScope',
  /** Save a conversation transcript to a user-chosen file (spec §7.6). */
  exportConversation: 'chat:export',
  /** Full-text search across conversations. Queries are content: never logged/audited. */
  searchConversations: 'chat:search',
  /** Tail of the local log for Diagnostics (spec §7.11). Never uploaded. */
  getLogTail: 'logs:tail',
  // Documents
  pickDocuments: 'docs:pick',
  importDocuments: 'docs:import',
  /** What a picked selection contains (file/audio counts + audio bytes) — the
   *  renderer's size-aware audio import confirmation. Read-only. */
  importPreflight: 'docs:importPreflight',
  getImportJob: 'docs:getImportJob',
  listDocuments: 'docs:list',
  deleteDocument: 'docs:delete',
  reindexDocument: 'docs:reindex',
  /** Read-only in-app preview: re-extract the stored copy's text. */
  previewDocument: 'docs:preview',
  /** Save a text document's stored content to a user-chosen file (the
   *  exportConversation pattern; enables exporting materialized translations). */
  exportDocument: 'docs:export',
  // Document tasks (async with polling, like imports/downloads)
  /** Start a document task (summary, translation; compare rides the same machine). */
  startDocTask: 'doctasks:start',
  /** Poll one task's state/progress. */
  getDocTask: 'doctasks:get',
  /** Cancel a task; with no jobId, cancels the currently active one. */
  cancelDocTask: 'doctasks:cancel',
  askDocuments: 'rag:ask',
  // Voice dictation (request/response; bytes in, text out, nothing stored)
  /** Transcribe recorded composer audio (16 kHz mono WAV bytes) into plain text. The
   *  recording is content: never logged, never audited, shredded after transcription. */
  transcribeDictation: 'dictation:transcribe',
  // In-app model downloader (async with polling, like imports)
  /** Start downloading one model's weights (gated: policy ∧ setting ∧ confirmation). */
  downloadModel: 'downloads:start',
  /** Poll one download job's progress/status. */
  getDownloadJob: 'downloads:get',
  /** Cancel an in-flight download (the `.part` file is kept for a future resume). */
  cancelDownload: 'downloads:cancel',
  // Benchmark
  runBenchmark: 'benchmark:run',
  /**
   * "Try GPU again": clears `gpuAutoDisabled`/`gpuLastError`,
   * invalidates the session probe cache, re-probes + persists, returns fresh settings.
   */
  tryGpuAgain: 'gpu:try-again',
  // Non-technical first-run launch preflight
  runPreflight: 'preflight:run',
  // Audit log (the Diagnostics Activity panel; spec §7.11, local-only)
  /** Page through audit events, newest-first (`limit`, optional `beforeId` cursor). */
  getAuditEvents: 'audit:list',
  /** Save the activity log to a user-chosen file (the exportConversation pattern). */
  exportAuditLog: 'audit:export',
  // Encrypted workspace lifecycle
  getWorkspaceState: 'workspace:getState',
  unlockWorkspace: 'workspace:unlock',
  createWorkspace: 'workspace:create',
  lockWorkspace: 'workspace:lock',
  /** Change the encrypted vault's password. Runs unlocked only. */
  changeWorkspacePassword: 'workspace:changePassword'
} as const

// Renderer-bound streaming event channels (main -> renderer).
// token/done/error are the LOCKED contract (one answer-token string per event;
// changes must be additive); `reasoning` is the ADDITIVE channel carrying the
// model's thinking deltas for Deep mode — answer tokens never travel on it and
// vice versa.
export const STREAM = {
  token: (requestId: string) => `chat:token:${requestId}`,
  done: (requestId: string) => `chat:done:${requestId}`,
  error: (requestId: string) => `chat:error:${requestId}`,
  reasoning: (requestId: string) => `chat:reasoning:${requestId}`,
  // ADDITIVE: a one-shot ephemeral notice fired before a document answer when retrieval
  // was auto-scoped to the file(s) the question named (never persisted — a live hint).
  scope: (requestId: string) => `chat:scope:${requestId}`
} as const

/** Payload of the `scope` channel — the filenames retrieval was auto-restricted to. */
export interface ScopeNotice {
  titles: string[]
}

/**
 * Channels between the main process and the HIDDEN OCR rasterizer window: the
 * window's whole job is rendering PDF pages to PNG bytes — the only step of
 * OCR that needs a canvas (recognition itself runs main-side). Pull-based: main
 * requests ONE page at a time, so a long scan never queues unbounded page images.
 * These channels are never exposed on the main window's bridge.
 */
export const OCR_RASTER = {
  /** main → ocr window: open this PDF — `{ pdf: Uint8Array }`. */
  open: 'ocr-raster:open',
  /** ocr window → main: the document opened — `{ pageCount }`. */
  opened: 'ocr-raster:opened',
  /** main → ocr window: render one page — `{ pageNumber }` (1-based). */
  render: 'ocr-raster:render',
  /** ocr window → main: one rendered page — `{ pageNumber, png: Uint8Array }`. */
  page: 'ocr-raster:page',
  /** ocr window → main: `{ message }` — the OCR task fails friendly. */
  error: 'ocr-raster:error'
} as const

// One-off main -> renderer notices (not tied to a request).
export const EVENTS = {
  /**
   * A friendly one-line runtime notice (the GPU crash auto-fallback's
   * "switched to compatibility mode" message — spec §11.4 tone, never alarming).
   */
  runtimeNotice: 'runtime:notice'
} as const
