import type { Db } from './db'
import type { ResolvedPaths } from './workspace'
import type { WorkspaceController } from './workspace-vault'
import type { RuntimeManager } from './runtime'
import type { Embedder } from './embeddings'
import type { Reranker } from './reranker'
import type { Transcriber } from './transcriber'
import type { OcrEngine } from './ocr'
import type { CachedGpuProbe } from './runtime/gpu'
import type { AuditRecorder } from './audit'
import type { DocTaskManager } from './doctasks'

// Shared application context assembled at startup and passed to IPC handlers.
// As later phases land, add: models registry, ingestion queue, etc.
export interface AppContext {
  paths: ResolvedPaths
  /**
   * The live workspace database. Backed by a getter over `workspace` (Phase 9): in
   * `plaintext_dev` mode it is open from startup; in `encrypted` mode it throws until
   * the vault is unlocked. Handlers read it at call time, so it tracks unlock/lock.
   */
  db: Db
  /** Owns the workspace lock/unlock lifecycle (Phase 9). */
  workspace: WorkspaceController
  runtime: RuntimeManager
  /** Embedder used for document ingestion + retrieval (mock now, real in Phase 10). */
  embedder: Embedder
  /**
   * Retrieval reranker (Phase 21): a third loopback sidecar, selected only when the
   * binary + the reranker GGUF exist. Null/absent = retrieval keeps today's ordering
   * (graceful-fallback rule — there is deliberately no mock reranker).
   */
  reranker?: Reranker | null
  /**
   * Audio transcriber (Phase 36): the whisper.cpp CLI behind the `Transcriber`
   * interface, selected only when the binary + the GGML weights exist. Null/absent =
   * audio imports fail per-file with friendly copy (graceful-fallback rule — there is
   * deliberately no mock transcriber).
   */
  transcriber?: Transcriber | null
  /**
   * Local OCR engine (Phase 38): tesseract.js over the drive's vendored language
   * files, selected only when those exist. Null/absent = photo imports fail per-file
   * with friendly copy and detected scans show no "Make searchable" offer
   * (graceful-fallback rule — there is deliberately no mock OCR engine).
   */
  ocrEngine?: OcrEngine | null
  /** Directory holding model-manifests, or null if it could not be located. */
  manifestsDir: string | null
  /**
   * Session-cached GPU probe (Phase 16): `--list-devices` on a drive-local binary,
   * shared between the start ladder, Diagnostics, and the benchmark so they never
   * disagree within a session. `invalidate()` is wired to "Try GPU again" so an
   * explicit retry re-probes. Optional — absent in most test contexts.
   */
  probeGpu?: CachedGpuProbe
  /**
   * True for a dev build (`!app.isPackaged`). Treated as "developer" alongside the
   * user-toggleable `developerMode` setting (which defaults OFF on shipped builds, M10).
   */
  isDev: boolean
  /**
   * Audit-log recorder (Phase 19): fire-and-forget, NEVER throws — an audit failure
   * (incl. a locked workspace) must never break the operation it records. Optional so
   * partial test contexts stay valid; call sites use `ctx.audit?.(…)`.
   */
  audit?: AuditRecorder
  /**
   * Document task engine (Phase 33): summary/translation/compare jobs, strictly
   * one-at-a-time (D26). Optional so partial test contexts stay valid; the chat/RAG
   * handlers guard with `ctx.docTasks?.hasActiveTask()`.
   */
  docTasks?: DocTaskManager
}
