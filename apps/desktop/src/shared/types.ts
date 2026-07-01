// Shared type contracts between the Electron main process, preload bridge, and
// the React renderer. This is the typed surface referenced by BUILD_STATE.md §4.
// Keep these in sync with the IPC handlers in src/main/ipc and the spec §9.1.

import { t, type UiLanguageSetting } from './i18n'
import type { SkillKind, SkillPermissions, SkillTrustedLevel } from './skill-manifest'

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
  // ---- Skills (skills-s13-plan.md §2.1 D4) ----
  /**
   * Whether the app may AUTO-FIRE an app skill on a turn the user left without one (S13b). The D4
   * opt-in gate: DEFAULT FALSE, so auto-fire is INERT in production until a user deliberately turns
   * it on (the Settings → Skills toggle is S13c). With this off, `resolveAutoFireSkill` is a no-op,
   * so S13b changes nothing observable. Even when on, only enabled + app + `triggers.autoFire` skills
   * are candidates and only when no skill is otherwise set (D5).
   */
  skillsAutoFireEnabled: boolean
  // ---- Conversation compaction (context-compaction plan §5.4) ----
  /**
   * Whether the chat history is COMPACTED as it approaches the model's context window —
   * older turns summarized once into a cached checkpoint and replayed as a compact note,
   * instead of silently dropped (the L1 trim floor). DEFAULT TRUE: a visible, auditable
   * summary is strictly better than silent forgetting, and every path fails safe to the L1
   * floor. When false, behaviour is byte-identical to the pre-feature app — no checkpoints are
   * created AND assembly ignores any existing checkpoint (pure L1, full-history replay).
   */
  chatCompactionEnabled: boolean
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
  // Auto-fire is OPT-IN: off by default so S13b ships inert (the toggle to flip it is S13c).
  skillsAutoFireEnabled: false,
  // Compaction is ON by default (D-a): silent drop-oldest is strictly worse than a visible,
  // auditable summary, and every new path fails safe to today's L1 trim.
  chatCompactionEnabled: true
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
  role: 'chat' | 'embeddings' | 'reranker' | 'transcriber' | 'vision'
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

// ---- Image understanding (vision) — image-understanding plan §9.3 ----
//
// A separate, lazily-started `llama-server --mmproj` sidecar answers a question about ONE
// image (PNG/JPEG). The bytes are base64-inlined into the loopback request (no disk write,
// V1-resolved). Nothing is persisted; the screen state and these DTOs are the whole surface.

/** Why image understanding is unavailable. NO `'locked'` reason (PROD-2): `getVisionStatus`
 *  is WORKSPACE-AGNOSTIC — vision weights aren't encrypted, so status doesn't fail on lock;
 *  the SCREEN owns the lock gate (it reads `workspaceReady`), and the sidecar is torn down on
 *  lock independently (§13). Status can read `available:true` while the screen shows locked. */
export type VisionUnavailableReason = 'no-model' | 'no-runtime' | 'incompatible'

export interface VisionStatus {
  available: boolean
  /** Present iff `!available`. */
  reason?: VisionUnavailableReason
  /** The installed + verified vision model, if any. */
  modelId?: string
  /** Human label for the screen (no jargon — never "mmproj"/quantization). */
  modelDisplayName?: string
}

export interface ImageAnalyzeRequest {
  /** The (possibly downscaled / EXIF-normalized) PNG or JPEG bytes. */
  imageBytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  question: string
  /** Original file name, stored as the history entry's title (older callers omit it). */
  name?: string
  /** Decoded pixel dimensions, persisted with the history session so a reopened entry can
   *  render the preview without re-decoding. Optional (older callers omit them). */
  width?: number
  height?: number
  /** History session this analyze belongs to. Absent ⇒ main CREATES a new session (storing
   *  the image, encrypted at rest) and returns its id on the job; present ⇒ the turn is
   *  APPENDED to that session (same loaded image — "try again" / a follow-up question). */
  sessionId?: string | null
}

/**
 * Lifecycle of one analyze job. `queued` is only the brief pre-`starting` state of the
 * SINGLE accepted job — never a backlog (a second analyze is busy-REJECTED, not queued,
 * IPC-3). Terminal: `done | failed | cancelled`.
 */
export type ImageJobState = 'queued' | 'starting' | 'analyzing' | 'done' | 'failed' | 'cancelled'

/**
 * A small enum the renderer maps to friendly localized copy — the technical reason stays in
 * the local log only (the chat `friendlyIpcError` precedent). `decodeFailed` is raised
 * CLIENT-side when `createImageBitmap` throws (corrupt / HEIC-as-jpg / animated-PNG / zero
 * byte). `busy` is a busy-REJECT (never a queue — §9.4).
 */
export type VisionErrorCode =
  | 'tooLarge'
  | 'unsupportedType'
  | 'decodeFailed'
  | 'runtimeFailed'
  | 'emptyResponse'
  | 'cancelled'
  | 'busy'

export interface ImageJob {
  jobId: string
  state: ImageJobState
  /** Populated on `done` (or accumulated live via the STREAM.img* channels). */
  answer?: string
  /** A CODE, never raw model/runtime text (mapped to friendly copy). */
  error?: VisionErrorCode | null
  /** The history session this job persists into. Set by main when a session is created or
   *  reused; the renderer captures it so follow-up turns reuse the same session/stored image. */
  sessionId?: string | null
}

/** One persisted history entry (no image bytes — kept light for the list; the row label
 *  uses the first question). The image is only decrypted when the entry is OPENED. */
export interface ImageSessionSummary {
  id: string
  title: string
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
  turnCount: number
  /** The first question asked of the image, for the list row subtitle (may be empty). */
  firstQuestion: string
  createdAt: string
  updatedAt: string
}

/** One persisted history turn (a completed question + answer). */
export interface ImageHistoryTurn {
  id: string
  question: string
  answer: string
  createdAt: string
}

/** A fully reopened history entry: metadata + the decrypted image bytes + all turns. */
export interface ImageSessionDetail {
  id: string
  title: string
  mimeType: string
  sizeBytes: number
  width: number | null
  height: number | null
  /** The decrypted image bytes (the renderer builds a Blob/data URL). */
  imageBytes: Uint8Array
  turns: ImageHistoryTurn[]
  createdAt: string
  updatedAt: string
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
  /**
   * FE-6 pagination (perf audit 2026-06-18, Wave P5). When the renderer-facing IPC returns a
   * BOUNDED page, `totalSegments` is the whole document's segment count and `nextOffset` is the
   * offset to request the next page (null on the last page). Both are ABSENT when `segments`
   * holds the whole document — i.e. the internal full-text reader (`extractDocumentPreview`,
   * consumed by skills + compare/translate) leaves them undefined, so those callers are
   * unaffected and a `nextOffset` of `undefined` simply means "no more pages".
   */
  totalSegments?: number
  nextOffset?: number | null
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
  /**
   * The sticky default skill for the next turn (skills plan §10.1) — the composer pre-fills it;
   * any turn can override or clear it, and past turns keep their own `messages.skill_id`. Null when
   * none. Persisted in `conversations.active_skill_id` (no FK — a deleted skill reads back as a
   * stale id, which the resolver skips gracefully). Optional so existing conversation fixtures
   * stay valid; `rowToConversation` always populates it (null when none).
   */
  activeSkillId?: string | null
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
  /**
   * The skill that shaped this assistant turn (skills plan §8.2/DS16) — the install_id stamped at
   * generation. RESOLVED at read time: a DELETED skill (no matching row) reads back NULL (no FK —
   * audit C3), so the per-message glyph never points at a vanished skill. Null on user turns and
   * on turns produced without a skill.
   */
  skillId?: string | null
  /** The shaping skill's title, for the per-message glyph label (null when none / deleted). */
  skillTitle?: string | null
  /**
   * S13c — true only when the app AUTO-FIRED `skillId` (the user set no skill; the resolver filled the
   * gap). Powers the per-turn "answer without it" undo, shown ONLY on an auto-fired turn. False on an
   * explicit pick, a no-skill turn, or a turn whose stamped skill was later deleted (glyph + undo drop
   * together). A boolean — never content.
   */
  autoFired?: boolean
  /**
   * The honest breadth behind this assistant answer (full-doc-skills plan §3.3/D48). Persisted as
   * `messages.coverage_json`; the renderer falls back to a `relevance` badge when absent, so a
   * pre-migration row (NULL) or a plain retrieval turn reads exactly as before. Counts/mode only —
   * never content. Undefined on user turns and turns that recorded no coverage.
   */
  coverage?: CoverageInfo
  /**
   * True when this assistant reply was CUT OFF because generation hit the token/context ceiling
   * (llama-server `finish_reason: 'length'`) — the answer is incomplete, not a clean EOS. Surfaced
   * so the transcript can honestly say "reply cut off at the context limit" instead of a silent
   * mid-word stop (D:\ testing report, 2026-07-01). Persisted as `messages.truncated` (1/NULL);
   * undefined on a complete reply, on user turns, and on a user-initiated Stop (which carries no
   * finish reason). Set by the plain-chat generation path (`generateAssistantMessage`); the grounded
   * document-answer path is out of scope for this signal.
   */
  truncated?: boolean
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
  /**
   * The skill for THIS turn (skills plan §10.1): `undefined` ⇒ use the conversation's sticky
   * default (`active_skill_id`); `null`/`''` ⇒ no skill this turn; a string ⇒ that skill. A
   * disabled/missing skill resolves to none (graceful — §10.3). Carried on BOTH chat channels.
   */
  skillInstallId?: string | null
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
 * (queue, cancel, polling IPC). `tree` (deep-index summary tree) and `extract` (the
 * per-chunk structured-extract pass, Phase 3) are the whole-document-analysis YIELDING
 * background jobs — they cede the model slot to chat between units and resume in-session;
 * the other kinds run to completion and refuse chat while active. `categorize` (Phase 33)
 * is the bank-statement LLM categorizer: it runs in the task lane purely for the chat↔task
 * one-job-at-a-time exclusion (D26), and is the ONE kind that does NOT require a runtime —
 * with no model loaded it degrades to the deterministic rule pass (services/skills/categorizer.ts). */
export type DocTaskKind = 'summary' | 'translation' | 'compare' | 'ocr' | 'tree' | 'extract' | 'categorize'

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
  /**
   * Which coverage tier produced this summary when it was served from a ready deep index
   * (whole-document-analysis plan §4.5): 1 = the stored root verbatim (0 model calls),
   * 2 = a section-by-section reduce, 3 = a detailed full-coverage reduce. Absent for the
   * capped map-reduce fallback (no deep index). Drives the depth line of the coverage meter.
   */
  tier?: CoverageTier
}

/**
 * Deep-index (summary-tree) build lifecycle, surfaced on `DocumentInfo.treeStatus`
 * (whole-document-analysis plan §3.2). NULL in the DB ⇒ no deep index yet. "Deeply indexed"
 * is the user-facing word for `'ready'`; the internal tree/node vocabulary never reaches UI.
 */
export type TreeBuildStatus = 'pending' | 'building' | 'ready' | 'stale' | 'failed'

/** A coverage tier (whole-document-analysis plan §4.5): how much precomputed depth to surface. */
export type CoverageTier = 1 | 2 | 3

/**
 * How a summary/answer covers the document(s) it is about (whole-document-analysis plan
 * §4.5/§5.1). The meter renders BREADTH ("covers the whole document" vs "the most relevant
 * passages") and DEPTH (the tier) as TWO separate honesty statements — breadth ≠ fidelity
 * [C1/L2]. "100%"/whole-document is claimed ONLY for `mode:'tree'` + `treeStatus:'ready'`
 * (where the stored chunks are provably the whole document — the `fully_chunked` invariant);
 * a `building`/`stale`/`pending` tree reports the partial fraction, never 100%.
 */
export type CoverageMode =
  /** Served from the ready deep-index tree — whole-document coverage at the chosen tier. */
  | 'tree'
  /** A relevance (RAG) answer — the most relevant passages, NOT exhaustive. */
  | 'relevance'
  /** The capped map-reduce summary — covers the beginning when `truncated`. */
  | 'capped'
  /** A structured-extract listing ("list every X") — exhaustive OVER INDEXED SECTIONS with
   *  per-item provenance, NOT guaranteed complete (per-chunk model recall, dedup, overlap).
   *  `chunksCovered`/`chunksTotal` are sections scanned/total; `unparsedChunks` is the count
   *  scanned but unparseable. Never rendered as "complete" (H7). */
  | 'extract'

export interface CoverageInfo {
  mode: CoverageMode
  /** The deep-index state when relevant (mode `tree`); absent for relevance/capped. */
  treeStatus?: Exclude<TreeBuildStatus, 'failed'>
  /** Document sections (chunks) reachable from the served material. */
  chunksCovered: number
  /** Total sections (chunks) in the document. */
  chunksTotal: number
  /** Levels in the deep-index tree (mode `tree`); display-internal, not shown verbatim. */
  treeLevels?: number
  /** The depth tier surfaced (mode `tree`). */
  tier?: CoverageTier
  /** Node ids behind the served summary (provenance plumbing); never `[Sn]` citations (M2). */
  nodeIds?: string[]
  /** True when the result honestly covers only the beginning (capped) — never shown as complete. */
  truncated?: boolean
  /**
   * Sections scanned but unparseable by the extract pass (mode `extract`, Phase 3). Surfaced
   * in the listing coverage line ("across N sections scanned (k unparsed)") so an item missed
   * in an unparsed section is never silently dropped from a "list every X" answer (H7).
   */
  unparsedChunks?: number
  /**
   * True when EVERY in-scope document is fully chunked (the `fully_chunked` invariant). Gates
   * the "whole document" wording of an extract listing — a legacy truncated doc says "sections
   * scanned", never "whole document" (mode `extract`; H7/C4).
   */
  fullyChunked?: boolean
}

/**
 * What `analysis:coverage` returns for one document (whole-document-analysis plan §5.1): the
 * coverage of its current summary plus the source-chunk provenance behind it. Node summaries
 * are NEVER citations (M2) — `provenance` is the underlying SOURCE chunks only.
 */
export interface DocumentCoverage {
  coverage: CoverageInfo
  /** The leaf source chunks behind a ready-tree summary, as `[Sn]` citations (M2-safe). */
  provenance: Citation[]
}

// ---- Structured extract-then-aggregate (whole-document-analysis plan §3.3/§4.2, Phase 3) ----

/**
 * The fixed v1 extraction type set (plan Q3). The per-chunk extract pass surfaces items of
 * these types; the router maps a user's "list every {X}" to one of them via a synonym table
 * (defaulting to `generic`). Widen deliberately — a new type costs a re-extract.
 */
export type ExtractRecordType = 'generic' | 'date' | 'amount' | 'party' | 'obligation'

/** The fixed v1 type set as a value (for the prompt + validation). */
export const EXTRACT_RECORD_TYPES: readonly ExtractRecordType[] = [
  'generic',
  'date',
  'amount',
  'party',
  'obligation'
]

/**
 * Per-document structured-extract pass lifecycle, surfaced on `DocumentInfo.extractStatus`
 * (plan §3.3). NULL in the DB ⇒ no extract pass yet. Mirrors `TreeBuildStatus`.
 */
export type ExtractStatus = 'pending' | 'extracting' | 'ready' | 'stale' | 'failed'

/** Request shape for `analysis:listAll` — the record type + the scope to aggregate over. */
export interface ExtractionListingRequest {
  recordType: ExtractRecordType
  /** Specific documents to scope to (null/absent = no id filter). */
  documentIds?: string[] | null
  /** Collections (projects/Library) to scope to (null/absent = no membership filter). */
  collectionIds?: string[] | null
  /** Include archived documents (default false). */
  includeArchived?: boolean
}

/** One aggregated item in a "list every X" listing (plan §4.2 step 2). */
export interface ExtractionListingItem {
  /** A representative surfaced value for this normalized key. */
  value: string
  /** How many extracted occurrences share this normalized value (across in-scope docs). */
  count: number
  /** The source section (chunk) ids this item came from — per-item provenance (H7). */
  sourceChunkIds: string[]
}

/**
 * What `analysis:listAll(scope, recordType)` returns (plan §4.2/§5.1): the aggregated,
 * provenance-backed list plus the honest coverage line inputs. Exhaustive OVER INDEXED
 * SECTIONS — `scannedChunks`/`totalChunks`/`unparsedChunks` make that honest, never "complete".
 * Zero query-time model calls (a pure GROUP BY over the precomputed `extraction_records`).
 */
export interface ExtractionListing {
  recordType: ExtractRecordType
  items: ExtractionListingItem[]
  /** Sections the extract pass scanned (parsed OK or marked unparsed) within scope. */
  scannedChunks: number
  /** Sections scanned but unparseable (their items may be missing — surfaced, never dropped). */
  unparsedChunks: number
  /** Total sections in scope (the coverage denominator). */
  totalChunks: number
  /** True when every in-scope document is fully chunked (gates "whole document" wording). */
  fullyChunked: boolean
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
  /**
   * Deep-index (summary-tree) build state (whole-document-analysis plan §3.2/§5.2). NULL/
   * undefined ⇒ no deep index yet ("Build deep index" offered); `'ready'` ⇒ "Deeply indexed"
   * — a whole-document summary is a cheap read. Drives the row's deep-index affordance + the
   * coverage meter. Read from `documents.tree_status`.
   */
  treeStatus?: TreeBuildStatus | null
  /**
   * True when the stored chunks are provably the WHOLE document (post-cap-honesty pipeline,
   * plan C4 — `documents.fully_chunked` is set). A legacy/truncated doc (`false`) must be
   * re-indexed before a deep index / 100%-coverage claim is allowed. Undefined ⇒ not read.
   */
  fullyChunked?: boolean
  /** Levels in the ready deep-index tree (from `tree_meta_json`); display-internal. */
  treeLevels?: number
  /**
   * Structured-extract pass state (whole-document-analysis plan §3.3/Phase 3). NULL/undefined
   * ⇒ no extract pass yet; `'ready'` ⇒ "list every X" answers from precomputed data at 0
   * query-time model calls. Read from `documents.extract_status`.
   */
  extractStatus?: ExtractStatus | null
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
  /**
   * D1 (vuln-scan-2026-06-21) — picker capability token. A PICKER import passes the one-time
   * token from `pickDocuments`; main resolves it to the exact paths it returned from the OS
   * dialog and IGNORES the renderer-supplied `paths`, so a code-exec'd renderer cannot forge a
   * picker-origin import of an arbitrary file (confused deputy, threat #1). Absent ⇒ the
   * drag-drop seam: main can't mint a token for an OS drop, so it hardens the raw paths
   * (canonicalize + reject symlinks) and the residual is documented in security-model.md.
   */
  pickerToken?: string
}

/** Result of `pickDocuments` (D1): the selected paths (renderer display only) + a one-time
 *  capability token to pass back to `importDocuments`. Empty selection ⇒ empty token+paths. */
export interface PickDocumentsResult {
  token: string
  paths: string[]
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
 * model ids, and counts — NEVER chat content, document text, passwords, OR user-chosen
 * names. Document titles/filenames and conversation/project names are CONTENT (S1,
 * full-audit-2026-06-30): a documentId, not its title, goes on record.
 */
/**
 * One installed skill over the IPC surface (skills plan §16) — a decoded `skills` row projected
 * for the renderer. NEW shared contract in S4; S5 (Settings list), S6 (composer picker) and S8
 * (selector) all consume it. STRUCTURAL fields only — `description`/`permissionSummary` come from
 * the skill's own (clamped) manifest, never from injected body text.
 */
export interface SkillInfo {
  /** Deterministic natural key `"<source>:<id>"` (the `skills` PK). */
  installId: string
  /** Declared skill id (kebab; non-unique across sources — DS12). */
  id: string
  title: string
  description: string
  /**
   * Optional per-locale DISPLAY overrides for `title`/`description` (additive; keyed by a short locale
   * tag e.g. 'de'). The renderer shows the running UI language's entry, falling back to
   * `title`/`description`. Display only — never the prompt/body language (D-L6).
   */
  localized?: Record<string, { title?: string; description?: string }>
  version: string
  kind: SkillKind
  author: string
  language: string
  /** Source folder = assigned trust ('app' read-only | 'user' read-write). */
  source: SkillTrustedLevel
  trustedLevel: SkillTrustedLevel
  enabled: boolean
  /** DS7: a view-imported user skill carries a persistent "review what it can do" warning
   *  (warningAck=false) until acknowledged. App skills are pre-acknowledged. */
  warningAck: boolean
  /** True once the on-disk folder has vanished (mark-unavailable; the row is kept). */
  unavailable: boolean
  /**
   * True when the skill declares a `compatibility.minAppVersion` NEWER than this app (§6.5): it is
   * listed but cannot be enabled/suggested/run until the app is updated. Optional/additive.
   */
  incompatible?: boolean
  /** The declared `compatibility.minAppVersion`, when present — shown alongside `incompatible`. */
  minAppVersion?: string | null
  /** Effective (already clamped) permissions (DS6). */
  permissions: SkillPermissions
  /** The calm human permission summary (structural; §9.2/§15). */
  permissionSummary: string
  /** True when another installed skill declares the same `id` (DS12 coexist-and-warn). */
  duplicateId: boolean
  /**
   * True when the skill RESERVES Tier-2 tools (a non-empty `allowedTools`). In v1 the tools do
   * not execute (the list is ignored with a note, §6.5), but the flag lets the detail view show
   * the honest "adds guidance only; tools arrive with Tier-2" note for a tool-reserved
   * instruction skill (the bank-statement stub — skills plan §13/§22-D1). Optional/additive.
   */
  reservesTools?: boolean
  installedAt: string
  updatedAt: string
}

/**
 * The result of validating an import source (a `.skill.zip` or a folder) FULLY in a transient
 * staging dir BEFORE the user confirms (OQ-2, lean-yes; skills plan §16). NOTHING is persisted to
 * produce this. On `ok: false`, `errors` carries friendly, STRUCTURAL-ONLY reasons (§22-M1: never
 * the attacker's member paths or content). NEW shared contract in S4; S5's import drawer renders it.
 */
export interface SkillPreview {
  ok: boolean
  /** 'zip' (a `.skill.zip`) or 'folder' (a picked directory). */
  sourceKind: 'zip' | 'folder'
  // ---- manifest summary (present only when ok) ----
  id?: string
  title?: string
  description?: string
  version?: string
  kind?: SkillKind
  author?: string
  permissions?: SkillPermissions
  /** The calm human permission summary (always present — the ceiling default when not ok). */
  permissionSummary: string
  // ---- lifecycle flags (present when ok) ----
  /** A user skill with this `id` is already installed (replace/upgrade/downgrade applies). */
  collision?: boolean
  /** Trust of the colliding installed skill, if any (an app skill shares this id). */
  collisionWith?: SkillTrustedLevel | null
  /** The currently-installed user-skill version for this id, if any. */
  installedVersion?: string | null
  /** Offered version is higher than the installed one. */
  isUpgrade?: boolean
  /** Offered version equals the installed one (a refresh/replace). */
  isReplace?: boolean
  /** Offered version is lower than the installed one. */
  isDowngrade?: boolean
  /** A downgrade the importer will REFUSE because developer mode is off (DS15). */
  downgradeBlocked?: boolean
  /** Friendly, structural-only validation problems (empty when ok). */
  errors: string[]
  /**
   * Stable, content-free reason CODES paralleling `errors` (e.g. 'pathTraversal' | 'tooLarge' |
   * 'invalidManifest'), which the renderer maps to localized copy so a German user never sees the
   * English structural string. Same length/order as `errors`; an unrecognized message → 'unknown'.
   */
  errorCodes?: string[]
  /** Non-fatal advisories (permission clamps, ignored fields). */
  notes: string[]
}

/**
 * A deterministic skill suggestion for the composer picker (skills plan §10.2 #2/DS14, S8). An
 * OFFER, never auto-applied: the picker pins it on top and the user taps to accept. STRUCTURAL only
 * (id + title) — never the matched keyword, the question, or any document text (§22-M1). Produced by
 * `suggestSkills(conversationId, question?)`; v1 returns at most one (the array keeps it future-proof).
 */
export interface SkillSuggestion {
  installId: string
  title: string
}

// ---- Tier-2 skill tools (skills plan §12 — DESIGNED here in S10; the bank-statement tools land
// in S11). A tool is an APP-AUTHORED, typed, app-orchestrated capability a skill may *declare* (via
// `allowedTools`) but can never register or alter (§4/DS8). The model never executes a tool: the
// app validates input → runs → validates output → the model only *explains* the structured result
// (DS4/§2 — no model-native `tool_calls`). These types are net-new in S10 and additive to the S2
// type spine (flagged in the S10 handoff). ----

/**
 * A tiny subset of JSON Schema (draft-07-ish) — enough to express AND validate a tool's I/O
 * contract (skills plan §12.1). Hand-rolled rather than pulling a validator dependency (CLAUDE.md
 * §0: no new native deps, offline). The gate validates input against `inputSchema` BEFORE `run`
 * and output against `outputSchema` AFTER it.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JsonSchema>
  required?: string[]
  /** When `false`, properties not named in `properties` are rejected (the posture we ship). */
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: unknown[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  /** Standard JSON-Schema "contains" semantics (anchor with `^…$` for a full match). */
  pattern?: string
  description?: string
}

/**
 * Enumerated capability tokens a tool may require (skills plan §12.2). There is DELIBERATELY no
 * `read_arbitrary_fs`, `network`, or `raw_sql` token — those capabilities are unreachable by
 * construction (the `SkillToolContext` carries no such handle), not merely undeclared (§14). A
 * token implying a WRITE/EXPORT/destructive action forces a user-confirmation gate
 * (`toolRequiresConfirmation`); `read-selected-docs` is read-only and runs without a per-call prompt.
 */
export type ToolPermission = 'read-selected-docs' | 'write-generated-doc' | 'export-file'

/**
 * The structured result of a tool run (skills plan §12.1). On success the `output` has ALREADY been
 * validated against the tool's `outputSchema` by the gate — no half-trusted shape reaches the model.
 * On failure the `error` is FRIENDLY and content-free (the technical reason goes to the local log
 * only — §12.2); a failed run never persists a partial result.
 */
export type ToolResult =
  | { ok: true; output: unknown; resultRef?: string }
  | { ok: false; error: string }

/**
 * The ids/counts-only audit sink handed to a tool (skills plan §12.1/§22-M1). Narrower than the
 * app's `AuditRecorder` — there is no free-text message argument, so a tool (or the gate) can only
 * ever record `{skillId, toolName, documentCount}`, never inputs, outputs, or content.
 */
export type SkillToolAudit = (type: AuditEventType, meta?: Record<string, unknown>) => void

/**
 * One page-addressable chunk of a selected document's stored text (skills plan §12 / S11a). It is
 * the unit a tool reads through `SkillToolContext.readDocumentChunks` — chunk `text` plus its
 * `page` provenance (fills `transaction.sourcePage`) and `index` (stable order). The `text` is
 * CONTENT: it must never reach the audit log or the renderer un-summarized (§22-M1).
 */
export interface DocumentChunkRead {
  /** The chunk's stored text (content). */
  text: string
  /** 1-based source page if known (the `chunks.page_number` provenance), else null. */
  page: number | null
  /** The chunk's `chunk_index` — stable read order within the document. */
  index: number
}

/**
 * The NARROW, app-built context a tool runs inside (skills plan §12.1/§14). It is the WHOLE of a
 * tool's reach: a FIXED, read-only `documentIds` scope it cannot widen (the gate hands it a frozen
 * copy), a scope-bounded content read, an `AbortSignal`, optional progress, and the ids/counts-only
 * audit sink. There is DELIBERATELY no `Db`/SQL handle, no filesystem handle, and no network handle —
 * confused-deputy and model-over-reach containment is structural (§14), not policy.
 */
export interface SkillToolContext {
  /** The selected-only document scope (ids only). Frozen by the gate; a tool cannot widen it. */
  documentIds: readonly string[]
  /**
   * The ONLY content reach a tool has (skills plan §12 / S11a): the page-addressable chunks of a
   * document IN the frozen `documentIds` scope. An id outside the scope is refused (returns `[]`) —
   * the read can never widen scope and is NOT a general `Db`/SQL/FS handle (§14). Supplied by the
   * app's orchestration seam as a closure over a narrow per-document SELECT.
   */
  readDocumentChunks(documentId: string): DocumentChunkRead[]
  /** Cooperative cancellation (the chat/doc-task `stopGeneration`/`cancelDocTask` precedent). */
  signal: AbortSignal
  /** Optional progress, merged into the polling status by the app (no new event channel). */
  onProgress?: (p: { done: number; total: number }) => void
  /** ids/counts-only audit sink — never inputs, outputs, or content. */
  audit: SkillToolAudit
}

/**
 * An app-owned tool descriptor (skills plan §12.1). Lives ONLY in the app's static
 * `services/skills/tool-registry.ts` map — a skill references a tool BY NAME via `allowedTools` and
 * can never add or alter one. The gate validates `input` against `inputSchema` before `run`, and the
 * returned `output` against `outputSchema` (if present) after.
 */
export interface SkillTool {
  /** Stable id referenced by SKILL.md `allowedTools`. */
  name: string
  /** Human- + model-facing summary — promises nothing beyond what the gate actually enforces. */
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  /** Capability tokens (§12.2). A write/export/destructive token ⇒ a user-confirmation gate. */
  permissions: ToolPermission[]
  run(input: unknown, ctx: SkillToolContext): Promise<ToolResult>
}

/**
 * A wired, runnable tool offered to the renderer for the active skill (skills plan §12.2/§16, S11b).
 * The renderer renders a calm "run" affordance per descriptor and never needs to know tool names or
 * bank specifics — main resolves WHICH tools apply (the run dispatch ∩ what the skill reserves) and
 * whether each needs a confirm modal. Carries NO content (no document ids, no figures).
 */
export interface RunnableTool {
  /** The registry tool name (e.g. `extract_transactions`). */
  name: string
  /** True for a write/export tool ⇒ the renderer raises the confirm modal before starting (S11c). */
  requiresConfirmation: boolean
}

/**
 * What `listRunnableTools` returns: the wired tools PLUS the in-scope target document IDS the run
 * would act on (skills audit U-1). The ids are content-free (the §6 ids/counts posture allows them
 * over IPC) and listed in main's resolution order — `documentIds[0]` is the default target a run
 * uses when the renderer passes none. Document TITLES/FILENAMES are CONTENT (S1) and NEVER cross
 * this boundary: the renderer maps these ids to NAMES from its own already-loaded document list, so
 * it can surface/choose the target without a title ever entering the IPC payload or the run state.
 */
export interface RunnableToolSet {
  /** Wired, runnable tools for the active skill in this conversation's scope (empty hides the offer). */
  tools: RunnableTool[]
  /** In-scope, indexed document ids in main's resolution order ([0] = the default single-doc target). */
  documentIds: string[]
}

/**
 * Start an app-orchestrated tool run from a USER action (skills plan §6/§16, DS4, S11b). The model
 * never emits this — a transcript/composer affordance does. The document scope is resolved MAIN-side
 * from `conversationId` (§22-C4); the renderer never assembles document ids.
 */
export interface StartSkillRunRequest {
  /** The active skill's install_id (`<source>:<id>`). */
  skillInstallId: string
  /** The registry tool to run (must be wired in the run dispatch). */
  toolName: string
  /** The conversation whose scope provides the target document(s). */
  conversationId: string
  /**
   * The chosen target document id for a multi-document scope (skills audit U-1). A content-free id
   * the renderer picks from `RunnableToolSet.documentIds`. UNTRUSTED: main re-resolves the in-scope
   * set and REFUSES an id not in it (never trusting a renderer id past the scope filter). Omitted ⇒
   * main targets the first in-scope document (the single-doc default, unchanged).
   */
  documentId?: string
  /** True once the user confirmed a write/export tool; read-only tools ignore it. */
  confirmed?: boolean
}

/**
 * The result of asking to start a run (skills plan §16, S11b). `needsConfirmation` means a
 * write/export tool was requested without `confirmed: true` — the renderer raises the confirm modal
 * and retries. Both `error` and the run are FRIENDLY + content-free (ids/counts only).
 */
export type StartSkillRunResult =
  | { started: true; run: SkillRunState }
  | { started: false; needsConfirmation: true }
  | { started: false; error: string }

/**
 * The ids/counts-only snapshot of one app-orchestrated tool run, polled by the renderer's busy row
 * (skills plan §12.2, S11b — the doc-task polling-status precedent, no new event channel). It is the
 * WHOLE of what the renderer learns about a run: state + progress + counts, NEVER the extracted rows
 * (those stay content-class in the workspace DB — §9.5). `error` is friendly + content-free.
 */
export interface SkillRunState {
  /** An opaque poll/cancel handle (NOT the `skill_runs.id`, which the renderer never sees). */
  runHandle: string
  skillInstallId: string
  toolName: string
  /** How many documents the run processes (the busy row's "on N documents"). */
  documentCount: number
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** Merged from the tool's `onProgress` (no new event channel). */
  progress: { done: number; total: number }
  /** A COUNT the run touched (rows extracted/categorized/summarized/saved, or rows not reconciling). */
  transactionCount?: number
  /**
   * A small, content-free outcome discriminator for tools whose result is more than a count (e.g.
   * `validate_statement_balances` → 'reconciled' | 'unreconciled' | 'unchecked'). The renderer maps
   * it to copy; it is NEVER a figure or row content. Unset for count-only outcomes.
   */
  resultKind?: string
  /**
   * A content-free reason CODE for a failure (e.g. 'unavailable' | 'needsExtraction' |
   * 'persistFailed' | 'exportWriteFailed'), which the renderer maps to localized copy — so a
   * German user never sees an English failure string (the seam/controller stay i18n-free). Unset
   * for a generic failure (the renderer falls back to the localized generic message).
   */
  errorCode?: string
  /** Friendly, content-free reason on failure (English; kept for logging/back-compat — the
   *  renderer prefers `errorCode`). */
  error?: string
}

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
  // A document's summary saved to a user-chosen file. Same privacy rule as
  // document_exported: metadata = { documentId } only.
  | 'summary_exported'
  | 'conversation_deleted'
  | 'conversation_exported'
  // Document-organization (plan §17): collection/membership/lifecycle changes. Metadata is
  // id + type + COUNT ONLY — never the collection/project NAME (a project name like
  // "Divorce" is content — exactly like a document title/filename, which S1 now withholds too).
  | 'collection_created'
  | 'collection_renamed'
  | 'collection_archived'
  | 'collection_deleted'
  | 'documents_added_to_collection'
  | 'documents_removed_from_collection'
  | 'document_lifecycle_changed'
  // Skills (skills plan §16/§22-M1): lifecycle events. Metadata is IDS/COUNTS ONLY — the
  // skill's declared id + source/trust + (for import) the file count — NEVER the package
  // content, the SKILL.md body, or member file names that could carry user data.
  | 'skill_imported'
  | 'skill_deleted'
  | 'skill_enabled'
  | 'skill_disabled'
  // Tier-2 tool runs (skills plan §12.2/§22-M1, S10): brackets one app-orchestrated tool run.
  // Metadata is { skillId, toolName, documentCount } ONLY — NEVER the tool's input, output, or any
  // document/chat content (the `SkillToolContext.audit` sink cannot carry a free-text message).
  | 'skill_run_started'
  | 'skill_run_done'
  | 'skill_run_failed'
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
  /** Human-readable summary (ids/counts only — never content, incl. titles/filenames; S1). */
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
  /**
   * The model's REAL context window — the token count the active runtime was launched
   * with as llama-server's `--ctx-size` (`manifest.recommendedContextTokens || settings.
   * contextTokens`, sidecar.ts). This is the authoritative budget the chat/RAG prompt
   * assembly trims against (context-compaction record §L0): `settings.contextTokens` can
   * diverge from the launched window, so trimming against it risks an over-window 400 or
   * wastes capacity. Reported by `ModelRuntime.contextWindow()`; absent when not running.
   */
  contextWindow?: number
}

/**
 * Context-window usage for the composer meter (context-compaction plan §5.1). `usedTokens` is the
 * assembled-prompt ESTIMATE (the word-based over-counting estimate, sum over the final assembled
 * message list — deliberately approximate, labelled as such in the UI); `window` is the real
 * launched context window (`effectiveContextWindow`). The renderer derives the % + calm/amber/
 * near-full tone from the two.
 */
export interface ContextUsage {
  usedTokens: number
  window: number
}

/**
 * The transcript summary marker (context-compaction plan §5.3, D-b): the latest checkpoint's
 * summary text plus `beforeMessageId` — the id of the first RENDERED turn the summary does not
 * subsume, i.e. where the "⌄ Earlier messages summarized" divider sits (the renderer places it
 * before that message). Null when no checkpoint has been cut. `beforeMessageId` is null only in the
 * degenerate case where the checkpoint covers every currently-rendered turn.
 */
export interface ConversationSummaryMarker {
  summary: string
  beforeMessageId: string | null
}
