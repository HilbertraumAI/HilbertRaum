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
  /**
   * The Models screen's one primary action per installed chat card (beta #27, D70): make a
   * model the active selection AND start its runtime, MAIN-side, so the install/RAM gates run
   * once and the audit trail is one event chain (`model_selected` then `runtime_started`). A
   * non-chat role is rejected before anything is persisted; a start failure leaves the fresh
   * selection standing (auto-start + a retry cover it — same posture as the old Select button).
   */
  useModel: 'runtime:use',
  stopRuntime: 'runtime:stop',
  /** Read-only runtime health/state for Diagnostics (spec §7.11). */
  getRuntimeStatus: 'runtime:status',
  /** The drive's installed sidecar build (the .hilbertraum-runtime.json marker). */
  getRuntimeInstall: 'runtime:install',
  // Chat
  createConversation: 'chat:createConversation',
  listConversations: 'chat:listConversations',
  listMessages: 'chat:listMessages',
  sendChatMessage: 'chat:send',
  stopGeneration: 'chat:stop',
  /** Persist a conversation's sticky default skill (skills plan §10.1; null clears). */
  setConversationDefaultSkill: 'chat:setDefaultSkill',
  /** Deterministic skill suggestion for the composer picker (skills plan §10.2/S8; logs nothing). */
  suggestSkills: 'skills:suggest',
  /**
   * Snapshot of an in-flight generation for a conversation (accumulated answer +
   * reasoning), or null if none — lets a remounted Chat screen recover a reply that is
   * still streaming after the user navigated away and back.
   */
  getActiveStream: 'chat:activeStream',
  /**
   * The conversation ids that currently have a generation IN FLIGHT (in-memory only). A Chat
   * screen that mounts fresh (the user navigated away and back) has forgotten which conversation
   * it was streaming — this lets it re-select the still-generating one and re-attach via
   * getActiveStream, instead of showing an empty new chat while the reply streams invisibly.
   */
  listActiveStreamConversations: 'chat:activeStreamConversations',
  /** Delete a conversation (chat or document Q&A) and all of its messages. */
  deleteConversation: 'chat:deleteConversation',
  /** Replace a documents-conversation's "ask selected documents" scope. */
  updateConversationScope: 'chat:updateScope',
  /** Persist a conversation's composite source scope (`scope_v2_json`, plan D1). */
  setConversationScope: 'chat:setScope',
  /** Persist a conversation's creation-anchor project (`collection_id`, plan §13.4). */
  setConversationCollection: 'chat:setCollection',
  /** A conversation's temporary chat attachments (`conversation_documents`, plan C3/§16). */
  listAttachments: 'chat:listAttachments',
  /** Save a conversation transcript to a user-chosen file (spec §7.6). */
  exportConversation: 'chat:export',
  /** Save one message's attached RESULT TABLE as CSV to a user-chosen file (result-tables §4). */
  exportMessageTable: 'chat:exportMessageTable',
  /** Full-text search across conversations. Queries are content: never logged/audited. */
  searchConversations: 'chat:search',
  /**
   * Resting-state context-window usage for a conversation (context-compaction plan §5.1): the
   * assembled-prompt token ESTIMATE over the model's launched window. Read-only, no model call;
   * recomputed on conversation load + after each turn (live is not required). Returns null for an
   * unknown conversation.
   */
  getConversationContextUsage: 'chat:contextUsage',
  /**
   * The latest compaction checkpoint's summary + where its marker sits in the rendered transcript
   * (context-compaction plan §5.3, D-b): `{ summary, beforeMessageId }` — the id of the first
   * rendered turn the summary does NOT subsume (the marker renders before it), or null when no
   * checkpoint has been cut. Read-only; the summary is local context, never leaves the device.
   */
  getConversationSummary: 'chat:conversationSummary',
  /** Tail of the local log for Diagnostics (spec §7.11). Never uploaded. */
  getLogTail: 'logs:tail',
  /** Save the full local log to a user-chosen file (plaintext, a deliberate user action). */
  exportLog: 'logs:export',
  /** Write text to the OS clipboard from MAIN — the sandboxed preload has no `clipboard`. */
  writeClipboard: 'clipboard:write',
  // Documents
  pickDocuments: 'docs:pick',
  importDocuments: 'docs:import',
  /** What a picked selection contains (file/audio counts + audio bytes) — the
   *  renderer's size-aware audio import confirmation. Read-only. */
  importPreflight: 'docs:importPreflight',
  getImportJob: 'docs:getImportJob',
  listDocuments: 'docs:list',
  /** Add documents to a collection (membership; idempotent). "Move" = add + remove. */
  addToCollection: 'docs:addToCollection',
  /** Remove documents from a collection (membership only; documents untouched). */
  removeFromCollection: 'docs:removeFromCollection',
  /** Set documents' retention lifecycle ('permanent'|'temporary'|'archived'). */
  setDocumentLifecycle: 'docs:setLifecycle',
  deleteDocument: 'docs:delete',
  reindexDocument: 'docs:reindex',
  /** Start a bulk re-index ("Re-index all" stale / "Retry all" failed). Main owns the job so its
   *  progress survives navigation; returns the initial ReindexJobStatus. Idempotent while running. */
  startReindexAll: 'docs:startReindexAll',
  /** Current bulk re-index job (or null) — parameterless so the renderer recovers the progress
   *  bar on mount without holding the job id across an unmount. */
  getReindexAllJob: 'docs:getReindexAllJob',
  /** Stop the in-flight bulk re-index. The current document finishes; the rest are skipped and the
   *  job ends with `cancelled: true`. No-op when nothing is running. */
  cancelReindexAll: 'docs:cancelReindexAll',
  /** Read-only in-app preview: re-extract the stored copy's text (FE-6: the BOUNDED first page). */
  previewDocument: 'docs:preview',
  /** FE-6: a subsequent bounded page of a document preview (offset/limit + cursor). */
  previewDocumentPage: 'docs:preview-page',
  /** Save a text document's stored content to a user-chosen file (the
   *  exportConversation pattern; enables exporting materialized translations). */
  exportDocument: 'docs:export',
  /** Save a document's persisted summary (Markdown) to a user-chosen file
   *  (the exportDocument pattern: dialog + fs in MAIN). */
  exportSummary: 'docs:exportSummary',
  // Document tasks (async with polling, like imports/downloads)
  /** Start a document task (summary, translation; compare rides the same machine). */
  startDocTask: 'doctasks:start',
  /** Poll one task's state/progress. */
  getDocTask: 'doctasks:get',
  /** The currently RUNNING task's status (a copy), or null when idle — reload adoption for the
   *  file/document translation path (the `translateGetActive` precedent for the text path). */
  getActiveDocTask: 'doctasks:getActive',
  /**
   * Cancel a task. With NO jobId, cancels the currently active one (the chat busy banner). With a
   * PRESENT jobId it is a TARGETED cancel (FA-3 / F-6): it cancels ONLY when that id is the active
   * task, so a stale Stop carrying a since-superseded jobId never kills the task that took the lane.
   */
  cancelDocTask: 'doctasks:cancel',
  /**
   * Read-only coverage + provenance of a document's current summary (whole-document-analysis
   * plan §5.1): how much of the document it covers (breadth) at what depth (tier), and the
   * source-chunk lineage behind a deep-index summary. No model call. Content stays in the DB.
   */
  documentCoverage: 'analysis:coverage',
  /**
   * Read-only "list every X" aggregation (whole-document-analysis plan §4.2/§5.1, Phase 3):
   * a pure GROUP BY over the precomputed `extraction_records` for one record type within a
   * scope — ZERO model calls. Returns the provenance-backed list + the honest coverage line
   * inputs (sections scanned/total/unparsed). Content stays in the DB (never logged/audited).
   */
  listAllExtractions: 'analysis:listAll',
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
  // In-app engine (llama.cpp sidecar) downloader — fetches the real runtime so models
  // stop falling back to the built-in demo runtime. Same gates as model downloads.
  /** Is the llama.cpp engine installed, and can it be fetched for this host? */
  getEngineStatus: 'engine:status',
  /** Start fetching + extracting the host's llama-server build (gated: policy ∧ setting). */
  downloadEngine: 'engine:download',
  /** Poll the engine-download job's progress/status. */
  getEngineJob: 'engine:getJob',
  /** Cancel an in-flight engine download. */
  cancelEngineDownload: 'engine:cancel',
  // Image understanding (vision) — image-understanding plan §9.1. A separate lazy
  // `llama-server --mmproj` sidecar answers a question about ONE image. Async-with-streaming
  // (the STREAM.img* channels below); `getStatus` is workspace-agnostic, the file/runtime
  // handlers requireUnlocked. No image/prompt/answer content is logged or audited.
  /** Is image understanding available (runtime + a verified vision model + projector)? */
  imageGetStatus: 'images:getStatus',
  /** Open the OS picker filtered to png/jpg/jpeg; returns `{ path, name, sizeBytes }` or null. */
  imageChooseImage: 'images:chooseImage',
  /** Read a picked image's bytes (main owns file I/O); re-validates extension + byte cap. */
  imageReadBytes: 'images:readBytes',
  /** Start a one-at-a-time analyze (validates extension/cap/question); a second one is busy. */
  imageAnalyze: 'images:analyze',
  /** Cancel an in-flight analyze (AbortController). */
  imageCancel: 'images:cancel',
  /** Poll one analyze job's state (unknown jobId ⇒ terminal failed). */
  imageGetJob: 'images:getJob',
  /** List saved image-analysis history entries (newest first; no image bytes). */
  imageListSessions: 'images:listSessions',
  /** Open one history entry: metadata + DECRYPTED image bytes + all turns. */
  imageGetSession: 'images:getSession',
  /** Delete one history entry: shred the stored image + cascade-remove its turns. */
  imageDeleteSession: 'images:deleteSession',
  // Translate view (TG-4) — the Translate screen's live TEXT translation on the TranslateGemma
  // sidecar. Async-with-streaming (the STREAM.tr* channels below), keyed by jobId, mirroring the
  // image job contract. No source/translation CONTENT is logged or audited (ids/kinds only).
  /** Start a one-at-a-time text translation (validates langs + source≠target + a model present);
   *  a second one while one runs is busy, a document task holds the lane returns docTaskBusy. */
  translateStart: 'translate:start',
  /** Cancel an in-flight text translation (AbortController). */
  translateCancel: 'translate:cancel',
  /** The active view-translation job (accumulated text + progress) for remount recovery, or null. */
  translateGetActive: 'translate:getActive',
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
  // Document organization — collections (projects + built-ins). Handlers in
  // registerCollectionsIpc.ts; membership/lifecycle live on the docs: namespace above.
  /** All collections (built-ins first, then projects by name). */
  listCollections: 'collections:list',
  /** Create a project. */
  createCollection: 'collections:create',
  /** Rename a collection (built-ins included, but the UI never offers it for built-ins). */
  renameCollection: 'collections:rename',
  /** Archive / unarchive a project (a scope-target change, not a global exclusion — C1). */
  setCollectionArchived: 'collections:setArchived',
  /** Delete a project: 'membershipOnly' (keep docs) or 'withDocuments' (delete project-only docs — C2). */
  deleteCollection: 'collections:delete',
  // Skills (instruction packages; skills plan §16). Handlers in registerSkillsIpc.ts; all
  // DB-backed handlers requireUnlocked and resolve validation MAIN-side. Audit metadata is
  // ids/counts only (§22-M1).
  /** All installed skills (app first, then by title) — `SkillInfo[]`. */
  listSkills: 'skills:list',
  /** One skill by install id — `SkillInfo | null`. */
  getSkill: 'skills:get',
  /** Open the OS picker for a `.skill.zip` file or a skill folder; returns the chosen path or null. */
  pickSkillPackage: 'skills:pick',
  /** Validate an import source FULLY in a transient dir, WITHOUT writing — `SkillPreview` (§9.2/OQ-2). */
  previewSkillPackage: 'skills:preview',
  /** Validate → unzip/copy into user-skills/<id>/ → install enabled-with-warning (DS7) — `SkillInfo`. */
  importSkill: 'skills:import',
  /** Export a skill as a `.skill.zip` via the save dialog (package tree only — §9.5). */
  exportSkill: 'skills:export',
  /** Delete a user skill: rm folder + row + clear refs in one txn (C3). App skills refuse. */
  deleteSkill: 'skills:delete',
  /** Enable a skill (one-active-per-id: disables same-id siblings — DS12). */
  enableSkill: 'skills:enable',
  /** Disable a skill (invisible to the picker, never injected). */
  disableSkill: 'skills:disable',
  /** Acknowledge a user skill's import warning (DS7 — clears the persistent warning state). */
  acknowledgeSkillWarning: 'skills:acknowledgeWarning',
  /**
   * Structural summary of the last disk reconcile's discovery errors — `SkillReconcileStatus`
   * (SKA-32, skills audit 2026-07-03, U7). Counts + fixed reason codes ONLY (never folder names or
   * package content — §22-M1); drives the Settings → Skills "N folders could not be read" notice.
   */
  skillReconcileStatus: 'skills:reconcileStatus',
  // Tier-2 app-orchestrated tool runs (skills plan §12.2/§16, S11b). Generic `skills:*` shape (NOT
  // bank-named) so S11c's tools slot in with no renderer/IPC change; bank specifics stay in the
  // `tool-runs.ts` dispatch + `run.ts` seam (§13). All requireUnlocked; the document scope is
  // resolved MAIN-side from the conversation (§22-C4) and NOTHING content-bearing is logged.
  /** Wired, runnable tools for the active skill in this conversation's scope (empty when none apply). */
  listRunnableTools: 'skills:listRunnableTools',
  /** Start a run from a user action; returns the initial state or a needs-confirmation/error signal. */
  startSkillRun: 'skills:startToolRun',
  /** Poll one run's ids/counts-only state/progress (the doc-task polling precedent). */
  getSkillRun: 'skills:getToolRun',
  /**
   * All runs the controller currently holds (running + terminal-but-unacknowledged), ids/counts only
   * (SKA-17, skills audit 2026-07-03, U6). Lets a freshly-reloaded renderer re-adopt in-flight runs
   * (its module-level store died with the reload; main kept them) — the `listActiveStreamConversations`
   * precedent, for skill runs. Content-free: each entry is a `SkillRunState` (state/progress/counts +
   * the content-free conversation/document ids), never the extracted rows. */
  listSkillRuns: 'skills:listToolRuns',
  /** Cancel a run (aborts its `AbortSignal`); with no handle, the active run. */
  cancelSkillRun: 'skills:cancelToolRun',
  /** Drop a terminal run main-side once the renderer has shown its outcome (the acknowledge handshake). */
  clearSkillRun: 'skills:clearToolRun',
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
  scope: (requestId: string) => `chat:scope:${requestId}`,
  // ADDITIVE: a one-shot ephemeral notice fired the moment the context-compaction pre-pass
  // starts summarizing the older history for THIS turn (it adds latency before the first answer
  // token — context-compaction plan §5.2). Never persisted, not in `streamBuffers` (R14 — a
  // transient hint, fine to miss on remount); cleared in the renderer when answer tokens begin.
  compaction: (requestId: string) => `chat:compaction:${requestId}`,
  // ADDITIVE: the REAL assembled-prompt context usage for the in-flight turn (a ContextUsage
  // payload), fired once right after prompt assembly. A document answer injects the retrieved
  // excerpts / whole-document block into the prompt — content the renderer cannot see in the
  // persisted history, so its word-count estimate under-reads a doc turn by the entire document
  // ("meter says 7% while the window is full"). Ephemeral like `compaction` (R14): never
  // buffered, fine to miss on remount — the meter then falls back to the resting estimate.
  usage: (requestId: string) => `chat:usage:${requestId}`,
  // Image understanding (vision) per-job streaming (image-understanding plan §9.1). Mirrors the
  // chat token/done/error contract, keyed by analyze jobId: the vision sidecar emits SSE
  // byte-identical to chat (V1-confirmed), so `readChatSSE` forwards the deltas as imgToken.
  // imgDone carries the terminal ImageJob; imgError the failed ImageJob (a code, never content).
  imgToken: (jobId: string) => `images:token:${jobId}`,
  imgDone: (jobId: string) => `images:done:${jobId}`,
  imgError: (jobId: string) => `images:error:${jobId}`,
  // Translate view (TG-4) per-job streaming. Same token/done/error contract as chat/vision,
  // keyed by the translate jobId: trToken carries one translation-delta string; trDone the
  // terminal TranslateJob (with the COMPLETE `text`, so a mid-stream dropped token self-heals on
  // completion); trError the failed TranslateJob (a code, never source/translation content).
  trToken: (jobId: string) => `translate:token:${jobId}`,
  trDone: (jobId: string) => `translate:done:${jobId}`,
  trError: (jobId: string) => `translate:error:${jobId}`
} as const

/** Payload of the `scope` channel — the filenames retrieval was auto-restricted to. */
export interface ScopeNotice {
  titles: string[]
}

/**
 * Payload of the `compaction` channel (context-compaction plan §5.2). One-shot; `'start'` is the
 * only phase today (`'done'` is implicit when answer tokens begin), but the object shape leaves
 * room to grow without breaking the additive streaming contract.
 *
 * `kind` (U5 / audit §3.6) reuses this EPHEMERAL channel for a second kind of "working on it" notice:
 * `'analysis'` is fired when an exhaustive skill handler starts a potentially long, silent extraction
 * (the "one-blob answer reads as a hang" gap), so the renderer can show honest "reading the document…"
 * copy instead of the compaction "summarizing earlier messages…" line. Absent ⇒ `'compaction'` (the
 * original behaviour, byte-unchanged).
 */
export interface CompactionNotice {
  phase: 'start'
  kind?: 'compaction' | 'analysis'
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
  runtimeNotice: 'runtime:notice',
  /**
   * Checksum-verification progress during `listModels` (`ModelVerifyProgress`). Emitted
   * to the calling renderer (`event.sender`) while first-run weight hashing runs, so the
   * first-run gate + first cold Models visit can show a determinate bar instead of an
   * opaque spinner. First-run-only in practice (the hash cache makes later passes a no-op).
   */
  modelVerifyProgress: 'models:verifyProgress'
} as const
