// Shared type contracts between the Electron main process, preload bridge, and
// the React renderer. This is the typed surface referenced by BUILD_STATE.md §4.
// Keep these in sync with the IPC handlers in src/main/ipc and the spec §9.1.

import { t, type UiLanguageSetting } from './i18n'

export type HardwareProfile = 'TINY' | 'LITE' | 'BALANCED' | 'PRO' | 'UNKNOWN'

export type WorkspaceMode = 'encrypted' | 'plaintext_dev'

export interface AppStatus {
  appName: string
  appVersion: string
  /**
   * Effective offline state: true unless policy permits network AND the user has
   * opted in (`offlineMode = !networkAllowed`). See `PolicyStatus` (spec §3.6).
   */
  offlineMode: boolean
  /** Effective network permission = policy ceiling ∧ user setting. */
  networkAllowed: boolean
  activeModelId: string | null
  hardwareProfile: HardwareProfile
  workspaceMode: WorkspaceMode
  workspaceReady: boolean
  /** Total RAM of THIS machine, rounded to whole GB (drives the Models RAM gate copy). */
  machineRamGb: number
  /**
   * A speech transcriber is available (whisper binary + weights present). Gates the
   * composer mic — availability-driven, no settings key.
   */
  dictationAvailable: boolean
  /**
   * Local text recognition (OCR) is available: the language files exist in the
   * drive's `ocr/` dir. Gates the "Make searchable (OCR)" offer and photo imports —
   * availability-driven, no settings key.
   */
  ocrAvailable: boolean
}

// ---- Privacy / offline policy (spec §6 config/policy.json + §3.5/§3.6) ----

/** Network permissions (spec §6 policy.json `network` block). Deny-by-default. */
export interface NetworkPolicy {
  allowModelDownloads: boolean
  allowUpdateChecks: boolean
  /** Always treated as off; the app has no telemetry and no toggle for it. */
  allowTelemetry: boolean
}

/** Workspace policy (spec §6 `workspace` block). */
export interface WorkspacePolicy {
  encryptionRequired: boolean
  allowPlaintextDevMode: boolean
}

/** Model-verification policy (spec §6 `models` block). */
export interface ModelsPolicy {
  allowUnverifiedModels: boolean
  requireManifest: boolean
  requireSha256Match: boolean
}

/** The merged, effective privacy policy (spec §6). */
export interface PrivacyPolicy {
  network: NetworkPolicy
  workspace: WorkspacePolicy
  models: ModelsPolicy
}

/**
 * What `getPolicy()` returns: the effective policy plus the derived network flags
 * the UI needs to distinguish "off by choice" from "disabled by policy" (spec §3.6).
 */
export interface PolicyStatus {
  policy: PrivacyPolicy
  /** A `config/policy.json` was found + parsed. */
  policyFilePresent: boolean
  /** A `config/drive.json` was found + parsed. */
  driveFilePresent: boolean
  /** The user's `allowNetwork` setting (the Settings toggle). */
  allowNetworkSetting: boolean
  /** Policy ceiling: does the policy permit any network at all? */
  networkAllowedByPolicy: boolean
  /** Effective permission = policy ceiling ∧ user setting. */
  networkAllowed: boolean
  /** `!networkAllowed`. */
  offlineMode: boolean
  /** Always false — telemetry is never enabled and has no toggle. */
  telemetryAllowed: boolean
}

// ---- Workspace vault / encryption (spec §3.5/§7.9) ----

/** Lifecycle state of the workspace as seen by the app shell / unlock gate. */
export type WorkspaceStateName = 'uninitialized' | 'locked' | 'unlocked'

/** What `getWorkspaceState()` returns — drives the onboarding/unlock gate. */
export interface WorkspaceStateInfo {
  state: WorkspaceStateName
  /** Active/declared mode; null only when uninitialized with no choice yet made. */
  mode: WorkspaceMode | null
  /** Whether choosing a plaintext (developer) workspace is permitted by policy + env. */
  plaintextAllowed: boolean
  /** Policy requires encryption — onboarding may not offer plaintext. */
  encryptionRequired: boolean
}

/** Result of an unlock/create action (a wrong password is a normal, non-throwing result). */
export type WorkspaceActionResult =
  | { ok: true; state: WorkspaceStateInfo }
  | { ok: false; reason: 'wrong_password' | 'refused' | 'error'; message: string }

export interface DriveStatus {
  /** Root directory that holds models + workspace (drive root or app-data fallback). */
  rootPath: string
  workspacePath: string
  modelsPath: string
  logsPath: string
  /** True when the app is running from a prepared external drive layout. */
  isPreparedDrive: boolean
  writable: boolean
  freeBytes: number | null
  platform: string
  arch: string
}

/**
 * Launch preflight (spec §11.4). A friendly, NON-BLOCKING first-run check on a
 * (commercial) drive: writable? free space? known-slow drive? Surfaced on Home; never blocks.
 */
export interface PreflightResult {
  rootPath: string
  writable: boolean
  freeBytes: number | null
  /** Friendly slow-drive note (spec §11.4 tone), or null. */
  slowDriveWarning: string | null
  /** Issues worth showing (read-only / very low space). Empty on a healthy drive. */
  problems: string[]
}

export interface AppSettings {
  /**
   * Whether the user permits network access for model/engine downloads. Default TRUE so
   * a fresh install can download new AI models out of the box (the policy ceiling is still
   * authoritative — a commercial `policy.json` with `allow_model_downloads: false` keeps the
   * app offline regardless). Telemetry is never gated by this and is always off.
   */
  allowNetwork: boolean
  workspaceMode: WorkspaceMode
  activeModelId: string | null
  activeEmbeddingModelId: string | null
  developerMode: boolean
  /** Retrieval + chat tuning, with safe defaults. */
  contextTokens: number
  // ---- RAG retrieval knobs (spec §7.8 defaults) ----
  /** How many chunks to pull from the vector index before dedup/trim. */
  ragTopKInitial: number
  /** How many chunks to keep in the grounded prompt after dedup + budget. */
  ragTopKFinal: number
  /** Token budget for the packed source excerpts (approximate token counter). */
  ragMaxContextTokens: number
  /** Drop hits below this cosine similarity (0 = keep all non-negative hits). */
  ragMinSimilarity: number
  /**
   * Last hardware benchmark result, or null if never run. The persisted profile
   * (`lastBenchmark.profile`) drives model recommendation + `AppStatus.hardwareProfile`.
   */
  lastBenchmark: BenchmarkResult | null
  // ---- GPU acceleration (architecture.md GPU record §5.4) ----
  /**
   * User intent: 'auto' (default — GPU when it works, the fallback ladder handles the
   * rest) or 'off' (the Settings "Use GPU acceleration" toggle, an explicit choice).
   */
  gpuMode: 'auto' | 'off'
  /**
   * Set by the fallback ladder after a failed GPU start or a mid-generation crash so
   * subsequent starts skip straight to CPU (no repeated health timeouts). Cleared by
   * Diagnostics' "Try GPU again" (e.g. after a driver update). Never a shipped default.
   */
  gpuAutoDisabled: boolean
  /** Timestamped reason (stderr tail) for the last GPU failure, for Diagnostics. */
  gpuLastError: string | null
  /** Cached `--list-devices` probe result (feeds Diagnostics + classifyProfile). */
  gpuProbe: GpuProbeResult | null
  // ---- Startup & verification polish (post-MVP) ----
  /**
   * Start the runtime for the selected (active) chat model automatically when the
   * workspace becomes usable (app launch / unlock). Default ON — a restarted app
   * showing an "active" model that silently was not running confused users.
   */
  autoStartActiveModel: boolean
  /**
   * Persisted SHA-256 cache for model weight files, keyed by absolute path. An entry
   * is trusted only while the file's size AND mtime still match; a replaced/changed
   * file is re-hashed. Lives in settings (like `lastBenchmark` — spec §8 defines no
   * extra table), so on an encrypted workspace it is encrypted at rest with the DB.
   */
  checksumCache: Record<string, ChecksumCacheEntry>
  // ---- Appearance (design-guidelines §5) ----
  /**
   * Theme preference. 'system' (default) follows the OS via
   * `prefers-color-scheme` and resolves to light when the OS reports nothing.
   * The pre-unlock gate cannot read settings (encrypted DB) — it always follows
   * the OS theme.
   */
  theme: ThemeSetting
  // ---- Language (i18n record §3.2, D-L2/D-L3) ----
  /**
   * UI language preference. 'system' (default) follows the OS locale: a `de*`
   * locale resolves to German, everything else to English. The pre-unlock gate
   * cannot read settings (encrypted DB) — it resolves from the renderer's
   * localStorage mirror of the last RESOLVED language, falling back to
   * `navigator.language`.
   */
  uiLanguage: UiLanguageSetting
}

/** Appearance setting (see `AppSettings.theme`). */
export type ThemeSetting = 'system' | 'light' | 'dark'

/** One persisted weight-file hash (see `AppSettings.checksumCache`). */
export interface ChecksumCacheEntry {
  size: number
  mtimeMs: number
  sha256: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  // Network is PERMITTED by default so model/engine downloads work on a fresh install
  // (the policy ceiling still wins — a commercial policy.json can force this back off).
  allowNetwork: true,
  workspaceMode: 'plaintext_dev',
  activeModelId: null,
  activeEmbeddingModelId: null,
  // Default OFF: developer affordances (unverified models, plaintext) must be an
  // explicit opt-in on a shipped build. A dev build (`!app.isPackaged`) is treated as a
  // developer regardless of this setting (`AppContext.isDev`).
  developerMode: false,
  contextTokens: 4096,
  ragTopKInitial: 12,
  ragTopKFinal: 6,
  ragMaxContextTokens: 2500,
  ragMinSimilarity: 0,
  lastBenchmark: null,
  // GPU is ALWAYS the default ('auto'); only a detected problem or the explicit Settings
  // toggle moves a machine to CPU.
  gpuMode: 'auto',
  gpuAutoDisabled: false,
  gpuLastError: null,
  gpuProbe: null,
  autoStartActiveModel: true,
  checksumCache: {},
  theme: 'system',
  uiLanguage: 'system'
}

// ---- GPU probe ----
/** One device as enumerated by `llama-server --list-devices` (e.g. "Vulkan0"). */
export interface GpuDevice {
  id: string
  name: string
  totalMb: number
  freeMb: number
}

export interface GpuProbeResult {
  devices: GpuDevice[]
  probedAt: string
}

/**
 * Which sidecar build this drive carries — the `.hilbertraum-runtime.json` install marker
 * written by `fetch-runtime`. Surfaced on Diagnostics ("runtime build").
 */
export interface RuntimeInstallInfo {
  version: string
  backend: string
  os: string
  arch: string
}

// ---- Models ----
export type ModelState =
  | 'installed'
  | 'missing'
  | 'checksum_failed'
  | 'unsupported'
  | 'not_recommended'
  | 'ready'
  | 'running'

export interface ModelInfo {
  id: string
  displayName: string
  family: string
  role: 'chat' | 'embeddings' | 'reranker' | 'transcriber'
  format: string
  runtime: string
  license: string
  sizeOnDiskGb: number
  recommendedMinRamGb: number
  recommendedRamGb: number
  recommendedContextTokens: number
  localPath: string
  state: ModelState
  recommended: boolean
  /**
   * True when this (missing, chat) model may be started anyway, falling back to the
   * built-in mock runtime — the zero-weights first-run journey. Computed in the main
   * process from developer mode AND the drive policy.
   */
  startableAsMock?: boolean
  /**
   * True when this machine's RAM is below the model's `recommendedMinRamGb` — the
   * model cannot run usefully here. The UI disables Select/Start and shows a flag;
   * the main process refuses to start installed weights that don't fit.
   */
  insufficientRam?: boolean
  /**
   * Upstream download metadata (the manifest's optional `download` block), present when
   * the model CAN be fetched by the in-app downloader. The renderer needs it for the
   * per-download confirmation (size, license link, URL, license acknowledgement).
   */
  download?: ModelDownloadInfo
}

/** What the per-download confirmation shows (from the manifest `download` block). */
export interface ModelDownloadInfo {
  url: string
  sizeBytes: number | null
  licenseUrl: string | null
  /**
   * `license_review.status === 'approved'`. When false, the confirmation dialog must
   * collect an explicit license acknowledgement before the download may start (the
   * in-app mirror of the fetch scripts' `--accept-license`).
   */
  licenseApproved: boolean
}

// ---- In-app model downloader (architecture.md "In-app model downloader") ----

export type DownloadJobStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * One in-app model download (async-with-polling, like imports): the renderer polls
 * `getDownloadJob` to drive progress UI. One download runs at a time.
 */
export interface DownloadJob {
  jobId: string
  modelId: string
  status: DownloadJobStatus
  /** Bytes on disk so far (includes a resumed `.part` prefix). */
  receivedBytes: number
  /** Expected total bytes (manifest `size_bytes` or the server's Content-Length), or null. */
  totalBytes: number | null
  /**
   * True when the job finished but the manifest hash is still a placeholder — the file
   * is in place but the model stays UNVERIFIED (checksum honesty, R5): capture the real
   * hash with `verify-models --generate`.
   */
  unverified: boolean
  /** Friendly failure reason when status === 'failed'. */
  error: string | null
}

// ---- In-app engine (llama.cpp sidecar) downloader -----------------------------------
//
// The in-app model downloader fetches model WEIGHTS; without the llama.cpp engine binary
// a started model falls back to the built-in demo runtime (services/runtime/factory.ts).
// This job fetches + verifies + extracts the host's prebuilt `llama-server` build from
// model-manifests/runtime-sources.yaml into runtime/llama.cpp/<os>/ so real models run.
// Same async-with-polling shape as DownloadJob; `extracting` is the extra archive step.

export type EngineDownloadStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface EngineDownloadJob {
  jobId: string
  status: EngineDownloadStatus
  /** Bytes of the release archive downloaded so far. */
  receivedBytes: number
  /** Expected archive size (server Content-Length), or null. */
  totalBytes: number | null
  /** True when finished but the runtime-sources hash was a placeholder (cannot verify). */
  unverified: boolean
  /** Absolute path of the installed binary when status === 'done'. */
  binaryPath: string | null
  /** Friendly failure reason when status === 'failed'. */
  error: string | null
}

/** Whether the llama.cpp engine is installed and (if not) whether it can be fetched. */
export interface EngineStatus {
  /** The host's `llama-server` binary is present on the drive (real runtime available). */
  installed: boolean
  /** A build matching this host (os/arch) exists in runtime-sources.yaml → fetchable. */
  available: boolean
  /** Pinned release tag of the host build, when available. */
  version: string | null
  /** Backend label of the host build (vulkan/metal/cpu), when available. */
  backend: string | null
}

// ---- Document preview (post-MVP) ----
/**
 * Read-only, in-app preview of an imported document: the parser's extracted text
 * segments (with page/section labels), re-extracted on demand from the stored copy.
 * Deliberately NOT the original bytes — in an encrypted workspace the stored copy
 * rests encrypted and must never be handed to an external viewer in plaintext.
 */
export interface DocumentPreview {
  id: string
  title: string
  mimeType: string | null
  segments: DocumentPreviewSegment[]
}

export interface DocumentPreviewSegment {
  text: string
  /** 1-based page number when the format has pages (PDF); null otherwise. */
  pageNumber: number | null
  /** Section/heading label when the format exposes one (Markdown); null otherwise. */
  sectionLabel: string | null
}

// ---- Chat ----
export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  modelId: string | null
  mode: 'chat' | 'documents'
  /**
   * "Ask selected documents" scope (spec §10.4): when non-null, document answers in
   * this conversation retrieve ONLY from these documents. Null = whole corpus. Only
   * meaningful for `mode: 'documents'`.
   */
  scopeDocumentIds: string[] | null
}

export interface Citation {
  label: string // e.g. "S1"
  sourceTitle: string
  pageNumber?: number | null
  section?: string | null
  /**
   * The cited chunk text, truncated for storage, so the renderer's source-snippet
   * panel can show what was cited without a second lookup.
   */
  snippet?: string | null
}

export interface Message {
  id: string
  conversationId: string
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt: string
  tokenCount?: number | null
  citations?: Citation[]
}

/**
 * Answer-depth mode (spec §10.3): how much work the model puts into one
 * answer. 'fast' = direct + capped, 'balanced' = direct with the model's defaults
 * (the default everywhere, including document answers), 'deep' = the model's native
 * thinking mode (only offered when the active manifest has `supports_thinking_mode`).
 */
export type ChatDepthMode = 'fast' | 'balanced' | 'deep'

export interface ChatOptions {
  mode?: ChatDepthMode
  useDocuments?: boolean
  /** Re-answer the last user turn: drop the previous assistant reply, then stream a fresh one. */
  regenerate?: boolean
}

// ---- Conversation search ----

/**
 * Markers FTS5's snippet() wraps around matched terms in `ConversationSearchHit.snippet`
 * (control characters, so they cannot collide with real message text). The renderer
 * splits on them to highlight matches; they never reach the DOM as text.
 */
export const SEARCH_MARK_START = '\u0001'
export const SEARCH_MARK_END = '\u0002'

/** One matching message inside a conversation (snippet around the matched terms). */
export interface ConversationSearchHit {
  messageId: string
  role: 'user' | 'assistant'
  /** Extract of the message around the match, matched terms wrapped in SEARCH_MARK_*. */
  snippet: string
  createdAt: string
}

/**
 * Search results for one conversation, best match first. The result list itself is
 * ordered by each conversation's best hit (bm25, newest-first tie-break).
 */
export interface ConversationSearchResult {
  conversationId: string
  conversationTitle: string
  hits: ConversationSearchHit[]
}

// ---- Document tasks (wave-3 plan §6) ----

/** What a document task runs over stored documents — all kinds share one engine
 * (queue, cancel, polling IPC). */
export type DocTaskKind = 'summary' | 'translation' | 'compare' | 'ocr'

/**
 * Translation targets, v1: the two eval-set languages only. A free-text language
 * field invites silent quality failures — widen deliberately, with evidence, never
 * by loosening this type.
 */
export type TranslationTargetLang = 'de' | 'en'

/**
 * Provenance of a document the app GENERATED from other documents (translation,
 * comparison). Persisted in the additive `documents.origin_json` column. Provenance,
 * NOT sync: re-importing or re-indexing a source does not update this document — the
 * user re-runs the task.
 *
 * Rows persisted before the `type` discriminator existed parse as `'translation'`
 * (the only earlier shape).
 */
export interface TranslationOrigin {
  type: 'translation'
  /** The source document's id (it may have been deleted since). */
  translatedFrom: string
  targetLang: TranslationTargetLang
}

export interface CompareOrigin {
  type: 'compare'
  /** The two compared documents' ids, in A/B order (either may be deleted since). */
  comparedFrom: [string, string]
}

export type DocumentOrigin = TranslationOrigin | CompareOrigin

export type DocTaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** Coarse step progress: model calls done / planned (map windows + reduce). */
export interface DocTaskProgress {
  stepsDone: number
  stepsTotal: number
}

export interface StartDocTaskRequest {
  kind: DocTaskKind
  documentIds: string[]
  /** Kind-specific parameters (e.g. the translation target language). */
  params?: Record<string, unknown>
}

/**
 * One document task as the renderer polls it (async-with-polling, like imports and
 * downloads). Terminal states: done | failed | cancelled.
 */
export interface DocTaskStatus {
  jobId: string
  kind: DocTaskKind
  documentIds: string[]
  state: DocTaskState
  progress: DocTaskProgress
  /** Friendly failure reason when state === 'failed' (spec §11.4 — never raw errors). */
  error?: string | null
  /**
   * Where the result landed (summary: the document whose summary was written;
   * translation: the NEW materialized document).
   */
  resultRef?: { documentId: string } | null
}

/**
 * A persisted document summary (`documents.summary_json`). Summaries are CONTENT:
 * they live only in the (possibly encrypted) workspace DB, never in the audit log.
 * Cleared by re-index (content may have changed); gone with document delete.
 */
export interface DocumentSummary {
  text: string
  /** The model that generated it (the attribution line). */
  modelId: string
  createdAt: string
  /**
   * True when the document was longer than the map-call ceiling allows: the summary
   * honestly covers only the beginning, and the UI says so.
   */
  truncated: boolean
}

/**
 * Friendly copy thrown by chat/document-answer handlers while a document task runs
 * (strict one-at-a-time). Shared so the renderer can recognize it and offer the
 * cancel option next to the message. Canonical ENGLISH on the wire (i18n record §3.3):
 * the renderer recognizes it by exact match (`error.includes`), so it is never
 * localized at emission — the renderer display map translates it at display (D-L4).
 */
export const DOC_TASK_BUSY_MESSAGE = t('en', 'main.chat.docTaskBusy')

// ---- Documents ----
export type IngestionStatus =
  | 'queued'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed'
  | 'deleted'

export interface DocumentInfo {
  id: string
  title: string
  originalPath: string | null
  mimeType: string | null
  sizeBytes: number | null
  status: IngestionStatus
  errorMessage: string | null
  chunkCount: number
  /**
   * True when the document is indexed but its vectors were produced by a DIFFERENT
   * embedding model than the active one, so document search (scoped to the active model)
   * can no longer find it. Re-indexing re-embeds it with the active model. Undefined when
   * not evaluated (no active embedder context).
   */
  staleEmbeddings?: boolean
  /**
   * The persisted one-click summary, or null/undefined when none exists.
   * Parsed from `documents.summary_json`; re-index clears it.
   */
  summary?: DocumentSummary | null
  /**
   * Provenance when this document was GENERATED by the app (e.g. a translation),
   * or null/undefined for a normal import. Parsed from `documents.origin_json`;
   * survives re-index (provenance, not sync — the source may have changed since).
   */
  origin?: DocumentOrigin | null
  /**
   * Transcription progress (0–100) while an AUDIO document is being read.
   * In-memory only (merged in by the docs IPC layer during import/re-index polling);
   * undefined for text documents and outside an active transcription.
   */
  transcriptionProgress?: number
  /**
   * True when this PDF was detected as an image-only scan: it failed import with the
   * friendly scan notice and is the OCR candidate the row's "Make searchable (OCR)"
   * action targets. Derived (status + the exact notice), not stored.
   */
  scanDetected?: boolean
  /**
   * Recognition METADATA when this document's text came from local OCR, or
   * null/undefined otherwise. Parsed from `documents.ocr_json` — ids/counts only;
   * the recognized text itself is content and stays in the (possibly encrypted) DB.
   * Survives re-index like `origin` (it states where the text came from); re-running
   * the OCR task overwrites it.
   */
  ocr?: DocumentOcrInfo | null
  createdAt: string
  updatedAt: string
}

/** Surface metadata of a stored OCR result (never the recognized text). */
export interface DocumentOcrInfo {
  /** Pages the recognition covered (photos: 1). */
  pageCount: number
  /** Traineddata languages used, e.g. ['deu', 'eng']. */
  languages: string[]
  /** The OCR engine id, e.g. 'tesseract.js-7.0.0'. */
  engineId: string
  createdAt: string
}

export interface ImportJob {
  jobId: string
  documentIds: string[]
}

/** What a picked selection contains — drives the size-aware audio import confirm. */
export interface ImportPreflight {
  fileCount: number
  audioFileCount: number
  audioBytes: number
}

export interface ImportJobStatus {
  jobId: string
  total: number
  completed: number
  failed: number
  done: boolean
}

// ---- Benchmark ----
export interface BenchmarkResult {
  os: string
  arch: string
  cpuModel: string
  cpuCores: number
  ramGb: number
  gpu: string | null
  driveReadMbps: number | null
  driveWriteMbps: number | null
  tokensPerSecond: number | null
  profile: HardwareProfile
  recommendedModelId: string | null
  warnings: string[]
  ranAt: string
}

// ---- Audit log (architecture.md "Audit log") ----
/**
 * What the app records to the `runtime_events` audit log — FOR THE USER, local only
 * (spec §7.11): the log lives in the workspace DB (encrypted at rest on encrypted
 * workspaces) and is never uploaded anywhere. Privacy rule (hard): events carry ids,
 * model ids, filenames, and counts — NEVER chat content, document text, or passwords.
 */
export type AuditEventType =
  | 'runtime_started'
  | 'runtime_stopped'
  | 'runtime_crashed'
  | 'runtime_fallback'
  | 'model_selected'
  | 'model_verified'
  | 'model_download_started'
  | 'model_download_verified'
  | 'model_download_failed'
  | 'document_imported'
  | 'document_reindexed'
  | 'document_deleted'
  // Document tasks: metadata = { kind, documentId } ONLY — the produced
  // summary/translation/report is content and never reaches the audit log.
  | 'document_task_completed'
  | 'document_task_failed'
  // A document's stored text saved to a user-chosen file. Metadata = { documentId }
  // only — never the path (user-chosen, content-adjacent) and never the text.
  | 'document_exported'
  | 'conversation_deleted'
  | 'conversation_exported'
  | 'workspace_created'
  | 'workspace_unlocked'
  | 'workspace_locked'
  | 'workspace_unlock_failed'
  | 'workspace_password_changed'
  | 'settings_changed'
  | 'policy_warning'
  | 'offline_guard_violation'

/** One audit-log entry (a `runtime_events` row), newest-first over the IPC surface. */
export interface AuditEvent {
  id: string
  type: AuditEventType
  /** Human-readable summary (ids/filenames/counts only — never content). */
  message: string
  /** Structured details (parsed `metadata_json`), or null. */
  metadata: Record<string, unknown> | null
  createdAt: string
}

export interface RuntimeStatus {
  running: boolean
  modelId: string | null
  port: number | null
  healthy: boolean
  message: string
  /**
   * Which backend the active runtime landed on (the start ladder): 'gpu' (the
   * default build with a usable GPU), 'cpu' (the same build GPU-less or forced via
   * `--device none`, or the safety-net build), 'mock'. Absent when not running.
   */
  backend?: 'gpu' | 'cpu' | 'mock'
  /** The probed GPU name when backend === 'gpu' (e.g. for the Diagnostics line). */
  gpuName?: string | null
  /**
   * Whether the ACTIVE model's manifest declares `supports_thinking_mode`:
   * the renderer offers the Deep answer mode only when true. Enriched by the
   * `getRuntimeStatus` IPC handler from the manifest; absent when not running.
   */
  supportsThinkingMode?: boolean
}
