import type { Db } from './db'
import type { ResolvedPaths } from './workspace'
import type { WorkspaceController } from './workspace-vault'
import type { RuntimeManager } from './runtime'
import type { Embedder } from './embeddings'
import type { Reranker } from './reranker'
import type { Transcriber } from './transcriber'
import type { OcrEngine } from './ocr'
import type { Translator } from './translation'
import type { CachedGpuProbe } from './runtime/gpu'
import type { AuditRecorder } from './audit'
import type { DocTaskManager } from './doctasks'
import type { SkillRegistry } from './skills/registry'
import type { VisionService } from './vision'
import type { TranslateJobService } from './translation/jobs'

// Shared application context assembled at startup and passed to IPC handlers.
export interface AppContext {
  paths: ResolvedPaths
  /**
   * The live workspace database. Backed by a getter over `workspace`: in
   * `plaintext_dev` mode it is open from startup; in `encrypted` mode it throws until
   * the vault is unlocked. Handlers read it at call time, so it tracks unlock/lock.
   */
  db: Db
  /** Owns the workspace lock/unlock lifecycle. */
  workspace: WorkspaceController
  runtime: RuntimeManager
  /** Embedder used for document ingestion + retrieval. */
  embedder: Embedder
  /**
   * Retrieval reranker: a third loopback sidecar, selected only when the
   * binary + the reranker GGUF exist. Null/absent = retrieval keeps today's ordering
   * (graceful-fallback rule — there is deliberately no mock reranker).
   */
  reranker?: Reranker | null
  /**
   * Audio transcriber: the whisper.cpp CLI behind the `Transcriber`
   * interface, selected only when the binary + the GGML weights exist. Null/absent =
   * audio imports fail per-file with friendly copy (graceful-fallback rule — there is
   * deliberately no mock transcriber).
   */
  transcriber?: Transcriber | null
  /**
   * Local OCR engine: tesseract.js over the drive's vendored language
   * files, selected only when those exist. Null/absent = photo imports fail per-file
   * with friendly copy and detected scans show no "Make searchable" offer
   * (graceful-fallback rule — there is deliberately no mock OCR engine).
   */
  ocrEngine?: OcrEngine | null
  /**
   * TranslateGemma translation sidecar (TG wave, plan §2 D1): a SEPARATE lazy llama-server serving
   * the raw `/completion` endpoint (no `--jinja` — the #20305 regression). Selected only when the
   * binary + GGUF are present; null/absent = translation refuses with a friendly install path
   * (TG-3, O2 — deliberately no mock translator). Held for the session: `stop()` on quit,
   * `suspend()` on lock (it lazily restarts on the next translate), plus its own idle teardown.
   * MUTABLE (issue #40): starts as the startup composition's selection and is RE-ASSIGNED by
   * `onModelInstalled` when a mid-session download makes the role available — consumers must read
   * it off ctx per call (`ctx.translator`), never capture the value at wiring time.
   */
  translator?: Translator | null
  /** Directory holding model-manifests, or null if it could not be located. */
  manifestsDir: string | null
  /**
   * Session-cached GPU probe: `--list-devices` on a drive-local binary,
   * shared between the start ladder, Diagnostics, and the benchmark so they never
   * disagree within a session. `invalidate()` is wired to "Try GPU again" so an
   * explicit retry re-probes. Optional — absent in most test contexts.
   */
  probeGpu?: CachedGpuProbe
  /**
   * True for a dev build (`!app.isPackaged`). Treated as "developer" alongside the
   * user-toggleable `developerMode` setting (which defaults OFF on shipped builds).
   */
  isDev: boolean
  /**
   * Audit-log recorder: fire-and-forget, NEVER throws — an audit failure
   * (incl. a locked workspace) must never break the operation it records. Optional so
   * partial test contexts stay valid; call sites use `ctx.audit?.(…)`.
   */
  audit?: AuditRecorder
  /**
   * Document task engine: summary/translation/compare jobs, strictly
   * one-at-a-time. Optional so partial test contexts stay valid; the chat/RAG
   * handlers guard with `ctx.docTasks?.hasActiveTask()`.
   */
  docTasks?: DocTaskManager
  /**
   * In-flight skill-run probe (GAP-5, full-audit 2026-07-11): true while the SkillRunController —
   * module-local to registerSkillsIpc, which assigns this at registration time — has a
   * non-terminal run on the document. The docs IPC delete/re-index guards consult it exactly like
   * `docTasks?.isDocumentBusy`: a delete or chunk rebuild under a suspended extraction would
   * interleave with the run (and, with FK enforcement off, orphan its bank/invoice rows).
   * Optional so partial test contexts stay valid.
   */
  skillRunActive?: (documentId: string) => boolean
  /**
   * In-flight ingestion probe (BE-1, ocr-audit 2026-07-18): true while the docs IPC import
   * loop or a re-index — the module-local `processing` set in registerDocsIpc, which assigns
   * this at registration time — is actively driving the document's row. The doc-task
   * manager's admission guard consults it (`DocTaskDeps.isDocumentProcessing`), the mirror
   * of `requireNoActiveTask`: a task admitted mid-re-index would interleave two ingestions
   * of the same document. Optional so partial test contexts stay valid.
   */
  docIngestionActive?: (documentId: string) => boolean
  /**
   * Skill registry (skills plan §8): the uniform disk-reconcile + state cache over the plain
   * app-skills/ + user-skills/ folders. Optional so partial test contexts stay valid. `reconcile`
   * needs an unlocked DB, so the live wiring reconciles best-effort at startup (plaintext_dev) and
   * later phases re-run it post-unlock; tests drive `reconcileSkills`/the handle directly.
   */
  skills?: SkillRegistry
  /**
   * Image-understanding (vision) sidecar orchestrator: a SEPARATE lazy llama-server with the
   * mmproj projector (image-understanding plan §10). Optional so partial test contexts stay
   * valid. Owns its own idle teardown; the lock/quit handlers also call `stop()` so its
   * in-memory image/prompt context never outlives a lock and no child orphans on quit.
   */
  vision?: VisionService
  /**
   * Translate-view job orchestrator (TG-4, plan §2 D6): the Translate screen's live TEXT
   * translation, streamed on the SHARED `translator` sidecar (a per-job service, NOT a second
   * model). Optional so partial test contexts stay valid. Owns only transient job state; the
   * lock/quit handlers call `stop()` so an in-flight job is aborted before the sidecar is
   * suspended (its next window would otherwise lazily respawn the just-killed server).
   */
  translateJobs?: TranslateJobService
  /**
   * Fired by the in-app download manager when a model download completes (issue #40, all files in
   * place). The live wiring (main/index.ts) re-runs the availability selectors that composed to
   * null at startup — the translation sidecar today — so a downloaded model activates without an
   * app restart. The transcriber/reranker/embedder still need a restart: their handles are
   * captured at IPC-registration/ingestion-wiring time (see the known-limitations doc). Optional
   * so partial test contexts stay valid; must never throw (the manager guards regardless).
   */
  onModelInstalled?: (modelId: string) => void
}
