// Shared type contracts between the Electron main process, preload bridge, and
// the React renderer. This is the typed surface referenced by BUILD_STATE.md §4.
// Keep these in sync with the IPC handlers in src/main/ipc and the spec §9.1.

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
}

// ---- Privacy / offline policy (Phase 8, spec §6 config/policy.json + §3.5/§3.6) ----

/** Network permissions (spec §6 policy.json `network` block). Deny-by-default. */
export interface NetworkPolicy {
  allowModelDownloads: boolean
  allowUpdateChecks: boolean
  /** Always treated as off; the app has no telemetry and no toggle for it. */
  allowTelemetry: boolean
}

/** Workspace policy (spec §6 `workspace` block). Encryption itself lands in Phase 9. */
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

// ---- Workspace vault / encryption (Phase 9, spec §3.5/§7.9) ----

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
 * Launch preflight (Phase 13, spec §11.4). A friendly, NON-BLOCKING first-run check on a
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
  /** Default false — no network in the core path (spec §3.6). */
  allowNetwork: boolean
  workspaceMode: WorkspaceMode
  activeModelId: string | null
  activeEmbeddingModelId: string | null
  developerMode: boolean
  /** Retrieval + chat tuning, with safe defaults. */
  contextTokens: number
  // ---- RAG retrieval knobs (Phase 6, spec §7.8 defaults) ----
  /** How many chunks to pull from the vector index before dedup/trim. */
  ragTopKInitial: number
  /** How many chunks to keep in the grounded prompt after dedup + budget. */
  ragTopKFinal: number
  /** Token budget for the packed source excerpts (approximate token counter). */
  ragMaxContextTokens: number
  /** Drop hits below this cosine similarity (0 = keep all non-negative hits). */
  ragMinSimilarity: number
  // ---- Benchmark (Phase 7) ----
  /**
   * Last hardware benchmark result, or null if never run. The persisted profile
   * (`lastBenchmark.profile`) drives model recommendation + `AppStatus.hardwareProfile`.
   */
  lastBenchmark: BenchmarkResult | null
  // ---- GPU acceleration (Phase 15, docs/gpu-support-plan.md §5.4) ----
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
}

/** One persisted weight-file hash (see `AppSettings.checksumCache`). */
export interface ChecksumCacheEntry {
  size: number
  mtimeMs: number
  sha256: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  allowNetwork: false,
  workspaceMode: 'plaintext_dev',
  activeModelId: null,
  activeEmbeddingModelId: null,
  // Default OFF (M10): developer affordances (unverified models, plaintext) must be an
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
  // toggle moves a machine to CPU (gpu-support-plan review decision Q2 — FINAL).
  gpuMode: 'auto',
  gpuAutoDisabled: false,
  gpuLastError: null,
  gpuProbe: null,
  autoStartActiveModel: true,
  checksumCache: {}
}

// ---- GPU probe (Phase 15) ----
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
 * Which sidecar build this drive carries — the `.paid-runtime.json` install marker
 * written by `fetch-runtime` (Phase 14). Surfaced on Diagnostics ("runtime build").
 */
export interface RuntimeInstallInfo {
  version: string
  backend: string
  os: string
  arch: string
}

// ---- Models (Phase 2) ----
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
  role: 'chat' | 'embeddings' | 'reranker'
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
   * process from developer mode AND the drive policy (H6/M10).
   */
  startableAsMock?: boolean
  /**
   * True when this machine's RAM is below the model's `recommendedMinRamGb` — the
   * model cannot run usefully here. The UI disables Select/Start and shows a flag;
   * the main process refuses to start installed weights that don't fit (post-MVP).
   */
  insufficientRam?: boolean
  /**
   * Upstream download metadata (the manifest's optional `download` block), present when
   * the model CAN be fetched by the in-app downloader (Phase 18). The renderer needs it
   * for the per-download confirmation (size, license link, URL, license acknowledgement).
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

// ---- In-app model downloader (Phase 18, post-mvp-functionality-plan §6) ----

export type DownloadJobStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * One in-app model download (async-with-polling, the Phase-4 import precedent): the
 * renderer polls `getDownloadJob` to drive progress UI. One download runs at a time.
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

// ---- Chat (Phase 3) ----
export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  modelId: string | null
  mode: 'chat' | 'documents'
  /**
   * "Ask selected documents" scope (spec §10.4, Phase 17): when non-null, document
   * answers in this conversation retrieve ONLY from these documents. Null = whole
   * corpus. Only meaningful for `mode: 'documents'`.
   */
  scopeDocumentIds: string[] | null
}

export interface Citation {
  label: string // e.g. "S1"
  sourceTitle: string
  pageNumber?: number | null
  section?: string | null
  /**
   * The cited chunk text (Phase 6), truncated for storage, so the renderer's
   * source-snippet panel can show what was cited without a second lookup.
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

export interface ChatOptions {
  mode?: 'fast' | 'balanced' | 'deep'
  useDocuments?: boolean
  /** Re-answer the last user turn: drop the previous assistant reply, then stream a fresh one. */
  regenerate?: boolean
}

// ---- Documents (Phase 4) ----
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
  createdAt: string
  updatedAt: string
}

export interface ImportJob {
  jobId: string
  documentIds: string[]
}

export interface ImportJobStatus {
  jobId: string
  total: number
  completed: number
  failed: number
  done: boolean
}

// ---- Benchmark (Phase 7) ----
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

export interface RuntimeStatus {
  running: boolean
  modelId: string | null
  port: number | null
  healthy: boolean
  message: string
  /**
   * Which backend the active runtime landed on (Phase 15 fallback ladder): 'gpu' (the
   * default build with a usable GPU), 'cpu' (the same build GPU-less or forced via
   * `--device none`, or the safety-net build), 'mock'. Absent when not running.
   */
  backend?: 'gpu' | 'cpu' | 'mock'
  /** The probed GPU name when backend === 'gpu' (e.g. for the Diagnostics line). */
  gpuName?: string | null
}
