// Shared type contracts between the Electron main process, preload bridge, and
// the React renderer. This is the typed surface referenced by BUILD_STATE.md §4.
// Keep these in sync with the IPC handlers in src/main/ipc and the spec §9.1.

export type HardwareProfile = 'TINY' | 'LITE' | 'BALANCED' | 'PRO' | 'UNKNOWN'

export type WorkspaceMode = 'encrypted' | 'plaintext_dev'

export interface AppStatus {
  appName: string
  appVersion: string
  /** True until any opt-in network feature is enabled by the user. */
  offlineMode: boolean
  activeModelId: string | null
  hardwareProfile: HardwareProfile
  workspaceMode: WorkspaceMode
  workspaceReady: boolean
}

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  allowNetwork: false,
  workspaceMode: 'plaintext_dev',
  activeModelId: null,
  activeEmbeddingModelId: null,
  developerMode: true,
  contextTokens: 4096
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
