// Shared type contracts between the Electron main process, preload bridge, and
// the React renderer. This is the typed surface referenced by BUILD_STATE.md §4.
// Keep these in sync with the IPC handlers in src/main/ipc and the spec §9.1.

import { t, type MessageKey, type UiLanguageSetting } from './i18n'

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
  // ---- Filing suggestions (document-organization plan §20 Phase F) ----
  /**
   * Document ids whose rule-based filing suggestions the user has DISMISSED. Persisted in
   * this AppSettings JSON blob (NOT a new `documents` column — additive, tolerant) so a
   * dismiss sticks across a restart. A suggestion is otherwise inert; this only hides the
   * quiet per-row chip — nothing is ever filed without an explicit Apply (plan §5).
   */
  dismissedFilingSuggestions: string[]
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
  uiLanguage: 'system',
  dismissedFilingSuggestions: []
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

/**
 * First-run / first-cold-visit checksum-verification progress (architecture.md
 * "Model verification progress"). Emitted from the `listModels` handler over
 * `EVENTS.modelVerifyProgress` while the multi-GB GGUF weights are hashed for the first
 * time (the two-tier cache makes this a first-run-only cost). Drives a determinate bar:
 * the byte-weighted `overallBytesHashed / overallBytesTotal` is the primary indicator,
 * `modelIndex / modelCount` the "how many steps left" label.
 */
export interface ModelVerifyProgress {
  /**
   * Identifies one verification pass. `listModels` can run as overlapping passes (a screen
   * remount, a concurrent poll), each with its own `modelCount` as the cache warms — the
   * renderer locks onto the first `runId` it sees and ignores the others until that pass's
   * `done`, so the bar can't flip between interleaved passes.
   */
  runId: string
  /** 1-based index of the model currently being hashed. */
  modelIndex: number
  /** How many models will be hashed this pass (the denominator of the step label). */
  modelCount: number
  modelId: string
  displayName: string
  /** Bytes hashed so far across ALL to-be-hashed files this pass. */
  overallBytesHashed: number
  /**
   * Total bytes that will be hashed this pass — the sum of only the weight files that
   * actually need hashing (cached / missing / placeholder-hash files are excluded).
   * `0` ⇒ nothing to hash (everything already cached) ⇒ the renderer skips the bar.
   */
  overallBytesTotal: number
  /** True on the final event of the pass, so the bar can settle to 100%. */
  done: boolean
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

/** Whether the engine binaries are installed and (if not) whether they can be fetched. */
export interface EngineStatus {
  /** Every fetchable engine family's binary is present on the drive (real runtimes ready). */
  installed: boolean
  /** At least one engine family has a build for this host (os/arch) → fetchable. */
  available: boolean
  /** Pinned release tag of the chat engine (llama.cpp), when available. */
  version: string | null
  /** Backend label of the chat engine (vulkan/metal/cpu), when available. */
  backend: string | null
  /** Engine families with a host build but no binary yet (e.g. `llama_cpp`, `whisper_cpp`). */
  missingFamilies: string[]
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
   * meaningful for `mode: 'documents'`. Legacy single-list scope; the composite `scope`
   * below supersedes it when present (document-organization plan §8.3/D1).
   */
  scopeDocumentIds: string[] | null
  /**
   * Creation-anchor collection (document-organization plan §13.4): the project a chat was
   * started inside, or null for an unscoped/Library chat. Used for conversation-list
   * grouping (N8) and as the legacy single-project scope fallback. Persisted in
   * `conversations.collection_id`.
   */
  collectionId: string | null
  /**
   * The persisted composite source scope (document-organization plan §8.3/D1): the UNION
   * of whole collections (Library / projects) and specific documents the user composed in
   * the multi-select picker. Null ⇒ no composite scope stored (the legacy
   * `scopeDocumentIds`/`collectionId` interpretation applies). An empty scope
   * (`collectionIds:[]`, `documentIds:[]`) is the explicit "All documents" choice.
   * Persisted in `conversations.scope_v2_json`.
   */
  scope: DocumentScope | null
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

/** The kind of generation a `GeneratedProvenance` records. */
export type GeneratedKind = 'summary' | 'translation' | 'compare' | 'transcript' | 'other'

/**
 * Structured provenance for a document the app GENERATED from other documents
 * (document-organization plan §15.1). This is the shape NEW generations write into
 * `documents.origin_json`; the legacy `TranslationOrigin`/`CompareOrigin` shapes still
 * parse (back-compat — the `parseOrigin` precedent). Like the legacy shapes this is
 * PROVENANCE, not sync: re-indexing or re-importing a source never updates this row.
 *
 * `createdAt` + `sourceDocumentIds` are kept so a later phase can compute a staleness
 * indicator (a source re-indexed/deleted after the output was made); v1 ships no
 * staleness UI (plan §15.3).
 */
export interface GeneratedProvenance {
  kind: GeneratedKind
  /** The source document id(s) this output was derived from (any may be deleted since). */
  sourceDocumentIds: string[]
  /** The source(s)' collection memberships captured at creation time (display/forward-use). */
  sourceCollectionIds?: string[]
  /** The model that produced the output, when cheaply known at creation. */
  modelId?: string
  createdAt: string
}

export type DocumentOrigin = TranslationOrigin | CompareOrigin | GeneratedProvenance

/**
 * Normalize any stored provenance into the uniform view the UI renders: the generation
 * KIND plus the ordered source document ids. Reads either the structured
 * `GeneratedProvenance` (new) or a legacy `TranslationOrigin`/`CompareOrigin` (old rows),
 * so the provenance label is one code path regardless of when the row was written
 * (plan §15.3). Compare preserves A/B order.
 */
export function provenanceView(origin: DocumentOrigin): {
  kind: GeneratedKind
  sourceDocumentIds: string[]
} {
  if ('kind' in origin) {
    return { kind: origin.kind, sourceDocumentIds: origin.sourceDocumentIds }
  }
  if (origin.type === 'compare') {
    return { kind: 'compare', sourceDocumentIds: [...origin.comparedFrom] }
  }
  return { kind: 'translation', sourceDocumentIds: [origin.translatedFrom] }
}

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
  /**
   * Collection memberships of this document (document-organization plan §16): the
   * Library/project/Temporary collections it belongs to, for the Documents-screen chips.
   * Empty array when filed nowhere. Built by `listDocuments` from `document_collections`.
   */
  collections?: DocumentCollectionMembership[]
  /**
   * Retention lifecycle (NULL in the DB ⇒ 'permanent'; document-organization plan §8.2).
   * `archived` documents are globally excluded from default retrieval (C1).
   */
  lifecycle?: DocumentLifecycle
  /**
   * Top-level folder name captured on a folder import (display-only metadata; plan §11.2).
   * Null/undefined for a file import. (`lastUsedAt` is deferred — L2.)
   */
  sourceFolderLabel?: string | null
  createdAt: string
  updatedAt: string
}

/** A document's membership in one collection, as surfaced on `DocumentInfo.collections`. */
export interface DocumentCollectionMembership {
  id: string
  /** Canonical stored name; the renderer localizes built-ins by `type`, never the name. */
  name: string
  type: CollectionType
  role: DocumentCollectionRole
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

// ---- Document organization (architecture.md "Document organization — design record";
//      retrieval/scope half in rag-design.md §13) ----
//
// A collection-membership layer over the existing ingestion/retrieval pipeline: one
// stored file, one chunk set, one vector set per document; organization is metadata
// (`collections` + `document_collections`) plus a `lifecycle` attribute on documents.
// Five user-facing containers — Library, Projects, Temporary, Generated (a role/view),
// Archive — built on these primitives. Everything stays local + offline.

/**
 * Collection kind. `library`/`temporary` are the seeded built-ins (one each, `builtin`);
 * `project` is user-created. `archive`/`smart` are reserved in the domain but NOT stored
 * as rows in v1 (archive is a doc/project lifecycle; smart views are query-time filters).
 */
export type CollectionType = 'library' | 'project' | 'temporary' | 'archive' | 'smart'

/**
 * How a document belongs to a collection. `'generated'` is RESERVED (unused in v1):
 * generated documents get NO membership at all and are reached only via explicit
 * selection (plan §15.2 / N1).
 */
export type DocumentCollectionRole = 'source' | 'reference' | 'attachment' | 'generated'

/** A document's retention lifecycle. NULL in the DB is coalesced to `'permanent'`. */
export type DocumentLifecycle = 'permanent' | 'temporary' | 'archived'

/**
 * Size (bytes) at or above which a document counts as a "large file" in the
 * `large` smart view (document-organization plan §7.6/§12.1, Phase E). 10 MB is well
 * above an ordinary text/PDF document but below most recordings, so the view surfaces
 * the files that actually cost drive space — without a new column. Shared so the
 * renderer predicate (`inSection`) and the `docs:list` filter stay byte-for-byte equal.
 */
export const LARGE_FILE_BYTES = 10 * 1024 * 1024

/**
 * The query-time smart views (plan §7.6/§12.1). These are predicates/orderings over
 * `documents` metadata — NEVER stored collections (`CollectionType` keeps `'smart'`
 * reserved-unused). `'all'` (everything) and `'recent'` (a createdAt ordering, not a
 * membership predicate) are handled by the caller; `matchesSmartView` covers the rest.
 */
export type SmartListView =
  | 'generated'
  | 'archived'
  | 'all'
  | 'recent'
  | 'unfiled'
  | 'needsReindex'
  | 'large'
  | 'failed'
  | 'audio'
  | 'ocr'

/** The smart views that are a pure per-document predicate (excludes `all`/`recent`). */
export type SmartViewPredicate = Exclude<SmartListView, 'all' | 'recent'>

/**
 * Whether a document belongs in a predicate smart view (plan §7.6/§12.1). The single
 * source of truth so the renderer rail (`inSection`) and the `docs:list` filter never
 * drift apart. Tolerant: missing optional fields coalesce to a safe default, never throws.
 * - `generated`    — app-generated provenance (`origin != null`).
 * - `archived`     — `lifecycle === 'archived'`.
 * - `unfiled`      — not filed into any *project* (Library/Temporary builtins don't count).
 * - `needsReindex` — vectors produced by a different search model (`staleEmbeddings`).
 * - `large`        — `sizeBytes >= LARGE_FILE_BYTES`.
 * - `failed`       — import `status === 'failed'`.
 * - `audio`        — an audio file, or a generated transcript of one.
 * - `ocr`          — text came from OCR, or a scan was detected.
 */
export function matchesSmartView(d: DocumentInfo, view: SmartViewPredicate): boolean {
  switch (view) {
    case 'generated':
      return d.origin != null
    case 'archived':
      return (d.lifecycle ?? 'permanent') === 'archived'
    case 'unfiled':
      return !(d.collections ?? []).some((c) => c.type === 'project')
    case 'needsReindex':
      return d.staleEmbeddings === true
    case 'large':
      return d.sizeBytes != null && d.sizeBytes >= LARGE_FILE_BYTES
    case 'failed':
      return d.status === 'failed'
    case 'audio':
      return (
        (d.mimeType?.startsWith('audio/') ?? false) ||
        (d.origin != null && provenanceView(d.origin).kind === 'transcript')
      )
    case 'ocr':
      return d.ocr != null || d.scanDetected === true
  }
}

/** Why a generated document is flagged stale (plan §15.3). */
export type GeneratedStaleReason = 'source-changed' | 'source-removed'

export interface GeneratedStaleness {
  stale: boolean
  reason: GeneratedStaleReason | null
}

/**
 * Whether a GENERATED document is out of date relative to its sources (plan §15.3).
 * Pure + tolerant — a derivation over already-listed `DocumentInfo` fields, NOT a
 * hot-path write. Flags stale when a source was updated (e.g. re-indexed) after this
 * output's `createdAt`, or a source was deleted/archived. Snapshot semantics are
 * unchanged: the only fix is re-running the task (this never auto-updates anything).
 *
 * Rules:
 * - A non-generated document (`origin == null`) is never evaluated ⇒ not stale.
 * - Only the structured `GeneratedProvenance` shape carries `createdAt`; a legacy
 *   `Translation/CompareOrigin` (or a malformed/empty `createdAt`) ⇒ no flag, never throws.
 * - A missing (deleted) or archived source ⇒ `source-removed`.
 * - Else a source whose `updatedAt` is after `createdAt` ⇒ `source-changed`.
 *
 * @param sources lookup of source documents by id (the renderer's already-listed docs).
 */
export function generatedStaleness(
  doc: Pick<DocumentInfo, 'origin'>,
  sources: ReadonlyMap<string, Pick<DocumentInfo, 'updatedAt' | 'lifecycle'>>
): GeneratedStaleness {
  const NOT_STALE: GeneratedStaleness = { stale: false, reason: null }
  const origin = doc.origin
  if (!origin) return NOT_STALE
  // `createdAt` exists only on the structured shape; legacy rows have none → no flag.
  const createdAt = 'kind' in origin ? origin.createdAt : ''
  const createdMs = Date.parse(createdAt)
  if (!createdAt || Number.isNaN(createdMs)) return NOT_STALE
  let changed = false
  for (const id of provenanceView(origin).sourceDocumentIds) {
    const src = sources.get(id)
    if (!src || (src.lifecycle ?? 'permanent') === 'archived') {
      return { stale: true, reason: 'source-removed' }
    }
    const updatedMs = Date.parse(src.updatedAt)
    if (!Number.isNaN(updatedMs) && updatedMs > createdMs) changed = true
  }
  return changed ? { stale: true, reason: 'source-changed' } : NOT_STALE
}

/** A collection as surfaced over IPC (a `collections` row). */
export interface Collection {
  id: string
  /** Stable canonical name; the UI localizes built-ins by `type`, never the stored name. */
  name: string
  type: CollectionType
  description: string | null
  /** True for the seeded Library/Temporary built-ins (undeletable). */
  builtin: boolean
  /** Optional UI accent; null = neutral. */
  color: string | null
  createdAt: string
  updatedAt: string
  /** Project-level archive timestamp (null = active). A scope-target change, not a global exclusion. */
  archivedAt: string | null
}

/**
 * The composite chat scope the user composes (plan §0.1 D1): a UNION of whole
 * collections (Library / projects) and specific documents. Persisted per conversation in
 * `conversations.scope_v2_json`. An empty scope (both arrays empty) means the explicit
 * "All documents" choice (whole corpus, archived excluded unless `includeArchived`).
 */
export interface DocumentScope {
  /** Any mix of library id, project ids (and later smart-view ids). */
  collectionIds: string[]
  /** Specific documents added to the union. */
  documentIds: string[]
  /** Include `lifecycle='archived'` documents. Default false. */
  includeArchived?: boolean
}

/**
 * The resolved, internal retrieval filter (plan §10.2). Produced by `resolveScope` from a
 * conversation's stored `DocumentScope` + chat attachments, and threaded into the vector /
 * keyword search. A document is in scope when it is a member of any `collectionIds` entry
 * OR its id is in `documentIds` (a UNION — plan D1). Empty/null both ⇒ whole corpus.
 * Re-exported from `services/rag` for callers that import it alongside `retrieve`.
 */
export interface RetrievalScope {
  /** Explicit selected docs ∪ chat attachments after `resolveScope` merges them. */
  documentIds?: string[] | null
  /** Membership filter: collections whose members are in scope. */
  collectionIds?: string[] | null
  /** Include `lifecycle='archived'` documents. Default false. */
  includeArchived?: boolean
  /**
   * True iff the user hand-picked specific documents (set BEFORE attachments/expansion are
   * merged into `documentIds`). Gates the filename auto-scope skip (plan §10.1 rule 5 / N2).
   */
  hasExplicitDocSelection?: boolean
}

/**
 * Where an import should land (document-organization plan §11.3, Phase C). Resolved
 * renderer-side per entry point (Documents screen ⇒ Library; inside a project ⇒ that
 * project; chat attach/drop ⇒ that conversation), persisted into
 * `documents.pending_destination_json` at queue time (M1) and applied on indexing success.
 * A `conversation` destination links the doc to its chat via `conversation_documents`
 * (C3) and makes it a Temporary doc — NEVER a `scope_json` mutation (N5/H4).
 */
export type ImportDestination =
  | { kind: 'library' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'temporary' }
  | { kind: 'conversation'; conversationId: string }

/**
 * Options for `importDocuments(paths, options?)` (plan §11.3). Entirely optional and
 * backward-compatible: an old no-options caller defaults to Library, byte-for-byte.
 */
export interface ImportOptions {
  /** Destination for every file in this import. Default `{ kind: 'library' }`. */
  destination?: ImportDestination
  /**
   * Capture `source_relative_path` / `source_folder_label` display metadata for a folder
   * import (N12). Default true for a folder import, false otherwise; display-only.
   */
  preserveRelativePaths?: boolean
}

// ---- Filing suggestions (rule-based, non-silent — document-organization plan §20 Phase F) ----
//
// A LOCAL, deterministic rule engine proposes which project an UNFILED document might belong
// to (folder-name match, same-source-folder cohort, bilingual filename pattern). Rule-based
// ONLY in v1 — no model, no network, no telemetry (local-AI classification is a LATER,
// owner-gated step). A suggestion is INERT: surfaced as a quiet, dismissible chip and acted on
// ONLY when the user clicks Apply (existing project ⇒ addToCollection; new project ⇒
// createCollection + addToCollection). Never silent, never auto-file (plan §5).

/** Which rule produced a suggestion (stable id, for de-dup + tests; never shown to the user). */
export type FilingRuleId = 'folder-name-match' | 'same-source-folder-cohort' | 'filename-pattern'

/** What a suggestion proposes: filing into an existing project, or creating a new one. */
export type FilingTarget =
  | { kind: 'existingProject'; collectionId: string }
  | { kind: 'newProject'; suggestedName: string }

/**
 * One ranked filing suggestion for a document. The reason is an i18n KEY + params (never
 * concatenated free text), so the renderer localizes it; `ruleId` is stable for de-dup/tests.
 */
export interface FilingSuggestion {
  ruleId: FilingRuleId
  target: FilingTarget
  /** i18n key for the human reason line (e.g. `docs.suggest.reason.folder`). */
  reasonKey: MessageKey
  /** Interpolation params for `reasonKey` (display-only; never logged/audited). */
  reasonParams?: Record<string, string>
}

/** The suggestions for one document (ranked, highest-confidence first, de-duped, always ≥1). */
export interface FilingSuggestionResult {
  documentId: string
  suggestions: FilingSuggestion[]
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
  // Document-organization (plan §17): collection/membership/lifecycle changes. Metadata is
  // id + type + COUNT ONLY — never the collection/project NAME (a project name like
  // "Divorce" is content-ish; the filename allowance does NOT extend to it).
  | 'collection_created'
  | 'collection_renamed'
  | 'collection_archived'
  | 'collection_deleted'
  | 'documents_added_to_collection'
  | 'documents_removed_from_collection'
  | 'document_lifecycle_changed'
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

/**
 * Live snapshot of a still-streaming generation (the `getActiveStream` IPC). Lets a Chat
 * screen that was unmounted mid-stream (the user navigated away and back) recover the
 * in-progress reply on remount — the token events it missed while gone are not replayed.
 */
export interface ActiveStreamSnapshot {
  /** Answer tokens accumulated so far. */
  content: string
  /** Deep-mode reasoning deltas accumulated so far (may be empty). */
  reasoning: string
}

export interface RuntimeStatus {
  running: boolean
  modelId: string | null
  port: number | null
  healthy: boolean
  message: string
  /**
   * The model whose runtime is currently being brought up (loading a large GGUF + the
   * health wait can take tens of seconds), or null when no start is in flight. Lets the
   * UI show a disabled "Starting…" state that survives leaving and re-entering a screen —
   * the per-component `busy` flag is lost on remount, this is server truth. While a start
   * is in flight `running` is still false (or reflects the previously-running model during
   * a switch).
   */
  startingModelId?: string | null
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
