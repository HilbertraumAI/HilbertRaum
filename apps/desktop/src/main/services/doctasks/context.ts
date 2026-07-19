// Shared doc-task vocabulary for the manager + the per-kind handler modules (DX-1 split,
// full-audit-2026-06-29 follow-up Phase 8). A leaf module (types only, no I/O, no cycle):
// `DocTaskDeps` (the injected seams) and `InternalTask` (the in-flight job) were module-scope
// in `manager.ts`; `DocTaskCtx` is the orchestration handle the manager hands each handler so
// the run<Kind> bodies can call the shared model loop without a `this` reference. Relocation
// only — behavior is unchanged. `DocTaskDeps` is re-exported from `manager.ts` so every
// existing `from '../services/doctasks'` importer is byte-for-byte unaffected.

import type { Db } from '../db'
import type {
  CoverageTier,
  DocTaskStatus,
  TranslationSourceLang,
  TranslationTargetLang
} from '../../../shared/types'
import type { ModelRuntime, RuntimeChatOptions } from '../runtime'
import type { Translator } from '../translation'
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
  /**
   * The TranslateGemma translation sidecar, or null when its binary/weights are absent
   * (TG-3, plan D3/O2). `kind:'translation'` requires THIS — never the chat runtime —
   * and refuses with the friendly install path when null. Read per task, like the
   * runtime (a suspended translator lazily restarts on the next translate()).
   */
  getTranslator: () => Translator | null
  /** True while any chat/RAG answer is streaming (the in-flight registry). */
  isChatStreaming: () => boolean
  /** The REAL launched context window (§L0) — NOT bare `settings.contextTokens`; with no
   *  runtime up, the override-aware value the next start would use (see main/index.ts).
   *  Drives every doc-task window budget (issue #41: budgets must follow the launched
   *  `--ctx-size`, or a fixed context-size pick makes the build argue with the server). */
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
   * ignores it. Read per task, but fixed at startup: engine composition never
   * re-runs, so OCR files installed mid-session need an app restart before this
   * starts returning non-null (ocr-audit 2026-07-18 DOC-5/BE-4). A mid-session
   * refresh is a deliberately deferred follow-up, not shipped here.
   */
  getOcrEngine?: () => OcrEngine | null
  /**
   * PDF → page-PNG rasterizer: the hidden-window renderer in the app, a fake in
   * tests. Only the 'ocr' kind uses it.
   */
  rasterizePdf?: RasterizePdf
  /**
   * True while the ingestion layer (import loop / re-index) is actively driving this
   * document's row — the mirror of the docs IPC `requireNoActiveTask` guard (BE-1,
   * ocr-audit 2026-07-18). `startDocTask` refuses EVERY kind against a mid-ingestion
   * target: an OCR re-run admitted mid-re-index would interleave two chunk
   * DELETE/INSERT transactions + two embed phases on one document (the other kinds are
   * shielded only incidentally by their `status === 'indexed'` check). Late-bound off
   * the module-local `processing` set in `registerDocsIpc` (via `ctx.docIngestionActive`);
   * absent/unwired ⇒ never busy, so partial test deps stay valid.
   */
  isDocumentProcessing?: (documentId: string) => boolean
  audit?: AuditRecorder
}

export interface InternalTask {
  status: DocTaskStatus
  controller: AbortController
  /** Validated translation source (kind === 'translation' only) — TranslateGemma's
   *  trained prompt requires an explicit source language; there is no auto-detect. */
  sourceLang?: TranslationSourceLang
  /** Validated translation target (kind === 'translation' only). */
  targetLang?: TranslationTargetLang
  /**
   * Coverage tier for a `summary` task over a ready deep index (whole-document-analysis plan
   * §4.5). 1 (default) = the stored root verbatim, 0 model calls; 2 = one section-by-section
   * reduce; 3 = a detailed full-coverage reduce in budget batches. Ignored without a tree.
   */
  summaryTier?: CoverageTier
  /**
   * Chain the structured-extract pass after a SUCCESSFUL `tree` build (issue #38 — "Build deep
   * index" is one user concept covering both yielding passes). Set only from the explicit UI
   * action (`params.withExtract`), never by the import-time auto-enqueue — the extract pass
   * stays out of ingestion (rag-design §14.5: no surprise CPU spend at import). Best-effort:
   * a refused chain start (chat streaming, runtime gone) is logged and dropped; the deep-index
   * row action stays visible until `extract_status='ready'`, so the user can finish it later.
   */
  withExtract?: boolean
}

/**
 * The orchestration handle the manager passes to every per-kind handler. It exposes ONLY the
 * shared seams a handler needs: the injected `deps`, the model-slot `arbiter` (for the yielding
 * tree/extract builds), and the manager-owned model loop (`generate`). The handlers own
 * everything kind-specific; this is the single, narrow surface between them and the
 * orchestrator. (The former `generateWithRetry` went with the chat-model translation path at
 * TG-3 — the sidecar-shaped retry now lives in `handlers/translation.ts`.)
 */
export interface DocTaskCtx {
  readonly deps: DocTaskDeps
  readonly arbiter: ModelSlotArbiter
  /**
   * One model call over the LOCKED `chatStream` contract: explicit maxTokens/temperature, NO
   * depth mode, the task's own abort signal. An abort throws (tasks never persist a partial).
   * The optional trailing `schema` threads a D55 grammar constraint (`responseSchema`) to the
   * runtime — the extract pass constrains its wire format with it (STR-1 §5.1); callers that
   * omit it are byte-unchanged.
   */
  generate(
    runtime: ModelRuntime,
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal,
    schema?: Pick<RuntimeChatOptions, 'responseSchema' | 'responseSchemaName'>
  ): Promise<string>
}

/** The signature every runtime-requiring per-kind handler shares (keyed by the registry). */
export type ModelTaskHandler = (
  task: InternalTask,
  runtime: ModelRuntime,
  ctx: DocTaskCtx
) => Promise<string>
