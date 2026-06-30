// Shared doc-task vocabulary for the manager + the per-kind handler modules (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). A leaf module (types only, no I/O, no cycle):
// `DocTaskDeps` (the injected seams) and `InternalTask` (the in-flight job) were module-scope
// in `manager.ts`; `DocTaskCtx` is the orchestration handle the manager hands each handler so
// the run<Kind> bodies can call the shared model loop without a `this` reference. Relocation
// only — behavior is unchanged. `DocTaskDeps` is re-exported from `manager.ts` so every
// existing `from '../services/doctasks'` importer is byte-for-byte unaffected.

import type { Db } from '../db'
import type { CoverageTier, DocTaskStatus, TranslationTargetLang } from '../../../shared/types'
import type { ModelRuntime } from '../runtime'
import type { IngestionDeps } from '../ingestion'
import type { OcrEngine } from '../ocr'
import type { RasterizePdf } from '../ocr/rasterizer'
import type { AuditRecorder } from '../audit'
import type { ModelSlotArbiter } from '../analysis/model-slot-arbiter'

/** Injected seams so the engine is testable without Electron and the IPC layer. */
export interface DocTaskDeps {
  /** The live workspace DB (the `ctx.db` getter — throws while locked). */
  getDb: () => Db
  /** The active chat runtime, or null when none is running. */
  getRuntime: () => ModelRuntime | null
  /** True while any chat/RAG answer is streaming (the in-flight registry). */
  isChatStreaming: () => boolean
  /** The user's `contextTokens` setting (drives the window budget). */
  getContextTokens: () => number
  /** `workspace/documents/` — where materialized documents (and their transients) live. */
  getStoreDir: () => string
  /** Ingestion deps (embedder + document cipher) for the materialize/import step. */
  getIngestionDeps: () => IngestionDeps
  /**
   * The vault lease (`WorkspaceController.beginDocumentWork`). Held ONLY around the
   * materialize step (it writes `.enc` sidecars); throws the friendly
   * `VaultBusyError` while a password change runs.
   */
  beginDocumentWork: () => () => void
  /**
   * The local OCR engine, or null when the drive carries no language files. The
   * 'ocr' kind refuses to start without it (friendly copy) — every other kind
   * ignores it. Read per task (the assets can appear mid-session).
   */
  getOcrEngine?: () => OcrEngine | null
  /**
   * PDF → page-PNG rasterizer: the hidden-window renderer in the app, a fake in
   * tests. Only the 'ocr' kind uses it.
   */
  rasterizePdf?: RasterizePdf
  audit?: AuditRecorder
}

export interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
  /** Validated translation target (kind === 'translation' only). */
  targetLang?: TranslationTargetLang
  /**
   * Coverage tier for a `summary` task over a ready deep index (whole-document-analysis plan
   * §4.5). 1 (default) = the stored root verbatim, 0 model calls; 2 = one section-by-section
   * reduce; 3 = a detailed full-coverage reduce in budget batches. Ignored without a tree.
   */
  summaryTier?: CoverageTier
}

/**
 * The orchestration handle the manager passes to every per-kind handler. It exposes ONLY the
 * shared seams a handler needs: the injected `deps`, the model-slot `arbiter` (for the yielding
 * tree/extract builds), and the manager-owned model loop (`generate` / `generateWithRetry` — the
 * retry orchestration the manager keeps). The handlers own everything kind-specific; this is the
 * single, narrow surface between them and the orchestrator.
 */
export interface DocTaskCtx {
  readonly deps: DocTaskDeps
  readonly arbiter: ModelSlotArbiter
  /**
   * One model call over the LOCKED `chatStream` contract: explicit maxTokens/temperature, NO
   * depth mode, the task's own abort signal. An abort throws (tasks never persist a partial).
   */
  generate(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string>
  /** One window with a single retry; a second failure returns null (the caller marks it). */
  generateWithRetry(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ): Promise<string | null>
}

/** The signature every runtime-requiring per-kind handler shares (keyed by the registry). */
export type ModelTaskHandler = (
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
) => Promise<string>
