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
}

export const DEFAULT_SETTINGS: AppSettings = {
  allowNetwork: false,
  workspaceMode: 'plaintext_dev',
  activeModelId: null,
  activeEmbeddingModelId: null,
  developerMode: true,
  contextTokens: 4096,
  ragTopKInitial: 12,
  ragTopKFinal: 6,
  ragMaxContextTokens: 2500,
  ragMinSimilarity: 0,
  lastBenchmark: null
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
}

// ---- Chat (Phase 3) ----
export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  modelId: string | null
  mode: 'chat' | 'documents'
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
}
