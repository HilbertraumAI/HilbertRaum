// Central registry of IPC channel names so main + preload never drift.
export const IPC = {
  getAppStatus: 'app:getAppStatus',
  getDriveStatus: 'app:getDriveStatus',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  // Phase 8 — privacy/offline policy
  getPolicy: 'policy:get',
  // Phase 2+
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
  /** Read-only runtime health/state for Diagnostics (spec §7.11 — audit M14). */
  getRuntimeStatus: 'runtime:status',
  /** The drive's installed sidecar build (.paid-runtime.json marker — Phase 16). */
  getRuntimeInstall: 'runtime:install',
  // Phase 3+
  createConversation: 'chat:createConversation',
  listConversations: 'chat:listConversations',
  listMessages: 'chat:listMessages',
  sendChatMessage: 'chat:send',
  stopGeneration: 'chat:stop',
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: 'chat:deleteConversation',
  /** Replace a documents-conversation's "ask selected documents" scope (Phase 17). */
  updateConversationScope: 'chat:updateScope',
  /** Save a conversation transcript to a user-chosen file (spec §7.6 — audit M13). */
  exportConversation: 'chat:export',
  /** Full-text search across conversations (Phase 31). Queries are content: never logged/audited. */
  searchConversations: 'chat:search',
  /** Tail of the local log for Diagnostics (spec §7.11 — audit M14). Never uploaded. */
  getLogTail: 'logs:tail',
  // Phase 4+
  pickDocuments: 'docs:pick',
  importDocuments: 'docs:import',
  getImportJob: 'docs:getImportJob',
  listDocuments: 'docs:list',
  deleteDocument: 'docs:delete',
  reindexDocument: 'docs:reindex',
  /** Read-only in-app preview: re-extract the stored copy's text (post-MVP). */
  previewDocument: 'docs:preview',
  askDocuments: 'rag:ask',
  // Phase 18 — in-app model downloader (async with polling, the Phase-4 import precedent)
  /** Start downloading one model's weights (gated: policy ∧ setting ∧ confirmation). */
  downloadModel: 'downloads:start',
  /** Poll one download job's progress/status. */
  getDownloadJob: 'downloads:get',
  /** Cancel an in-flight download (the `.part` file is kept for a future resume). */
  cancelDownload: 'downloads:cancel',
  // Phase 7
  runBenchmark: 'benchmark:run',
  /**
   * "Try GPU again" (Phase 16 + audit fix): clears `gpuAutoDisabled`/`gpuLastError`,
   * invalidates the session probe cache, re-probes + persists, returns fresh settings.
   */
  tryGpuAgain: 'gpu:try-again',
  // Phase 13 — non-technical first-run launch preflight
  runPreflight: 'preflight:run',
  // Phase 19 — audit log (the Diagnostics Activity panel; spec §7.11, local-only)
  /** Page through audit events, newest-first (`limit`, optional `beforeId` cursor). */
  getAuditEvents: 'audit:list',
  /** Save the activity log to a user-chosen file (the exportConversation pattern). */
  exportAuditLog: 'audit:export',
  // Phase 9 — encrypted workspace lifecycle
  getWorkspaceState: 'workspace:getState',
  unlockWorkspace: 'workspace:unlock',
  createWorkspace: 'workspace:create',
  lockWorkspace: 'workspace:lock',
  /** Change the encrypted vault's password (Phase 32). Runs unlocked only. */
  changeWorkspacePassword: 'workspace:changePassword'
} as const

// Renderer-bound streaming event channels (main -> renderer).
// token/done/error are the LOCKED Phase-3 contract (one answer-token string per
// event); `reasoning` is the ADDITIVE Phase-20 channel carrying the model's thinking
// deltas for Deep mode — answer tokens never travel on it and vice versa.
export const STREAM = {
  token: (requestId: string) => `chat:token:${requestId}`,
  done: (requestId: string) => `chat:done:${requestId}`,
  error: (requestId: string) => `chat:error:${requestId}`,
  reasoning: (requestId: string) => `chat:reasoning:${requestId}`
} as const

// One-off main -> renderer notices (not tied to a request).
export const EVENTS = {
  /**
   * A friendly one-line runtime notice (Phase 15: the GPU crash auto-fallback's
   * "switched to compatibility mode" message — spec §11.4 tone, never alarming).
   */
  runtimeNotice: 'runtime:notice'
} as const
