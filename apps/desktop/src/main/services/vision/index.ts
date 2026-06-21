import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context'
import type { ImageAnalyzeRequest, ImageJob, VisionErrorCode, VisionStatus } from '../../../shared/types'
import { discoverManifests, mmprojPath, weightPath } from '../models'
import { resolveLlamaServerPath } from '../runtime/sidecar'
import { log } from '../logging'
import { getVisionStatus } from './status'
import { VisionRuntime } from './runtime'
import { validateAnalyzeRequest, VISION_MAX_IMAGE_BYTES } from './limits'

// Vision job orchestration (image-understanding plan §9.4 / §10 `index.ts`). Owns the
// per-process ephemeral job map, vision's OWN one-job-at-a-time serialization (NET-NEW — the
// chat slot arbiter does NOT govern this separate sidecar, RUNTIME-3), and the busy-REJECT
// policy (a second analyze returns `busy`, never queued — IPC-3). No image/prompt/answer
// content is logged or audited (§12/§13).
//
// V2 SCOPE: the orchestration (jobs, serialization, busy-reject, cancel, getJob) is REAL.
// `createRuntime` is injected so tests can drive analyze without a real binary; production
// builds a `VisionRuntime` only when a model is actually available (no fabricated answers).

export { getVisionStatus } from './status'
export { VisionRuntime } from './runtime'

/** A per-job streaming sink, keyed by jobId (the IPC layer binds it to one renderer's sender). */
export interface VisionStreamEmitter {
  token: (jobId: string, delta: string) => void
  done: (jobId: string, job: ImageJob) => void
  error: (jobId: string, job: ImageJob) => void
}

/** What the runtime the service drives must do — `VisionRuntime` satisfies it (and tests fake it). */
export interface VisionAnalyzer {
  analyze(opts: {
    imageBytes: Uint8Array
    mimeType: string
    question: string
    signal?: AbortSignal
    onToken?: (delta: string) => void
  }): Promise<string>
  /** Optional teardown (the real `VisionRuntime` has one; test fakes may omit it). */
  stop?(): Promise<void>
}

export interface VisionServiceDeps {
  /** Current availability (the real `getVisionStatus`, injectable for tests). */
  getStatus: () => Promise<VisionStatus>
  /** Build/return the runtime for an available model. Called lazily, only when available. */
  createRuntime: (status: VisionStatus) => VisionAnalyzer
  /** Max accepted image bytes (default `VISION_MAX_IMAGE_BYTES`). */
  maxImageBytes?: number
}

export class VisionService {
  private readonly jobs = new Map<string, ImageJob>()
  private readonly controllers = new Map<string, AbortController>()
  /** The single in-flight job (vision's own serialization). Null when idle. */
  private activeJobId: string | null = null
  /** Lazily built once a model is available; reused across analyses. */
  private runtime: VisionAnalyzer | null = null

  constructor(private readonly deps: VisionServiceDeps) {}

  private get maxBytes(): number {
    return this.deps.maxImageBytes ?? VISION_MAX_IMAGE_BYTES
  }

  /**
   * Start an analyze. Validates main-side (extension/MIME, byte cap, question), enforces
   * one-at-a-time (busy-REJECT), and returns the initial job IMMEDIATELY; the sidecar call
   * runs in the background and streams via `emit`. A validation failure or a busy reject
   * returns a terminal `failed` job with a code and is NOT tracked / does NOT take the slot.
   */
  analyze(req: ImageAnalyzeRequest | undefined, emit: VisionStreamEmitter): ImageJob {
    const bytes = req?.imageBytes
    const code = validateAnalyzeRequest(bytes, req?.mimeType, req?.question, this.maxBytes)
    if (code) return failedJob(code)
    // Busy-REJECT (IPC-3): a second analyze while one runs is rejected, never queued.
    if (this.activeJobId) return failedJob('busy')

    const jobId = randomUUID()
    const job: ImageJob = { jobId, state: 'queued' }
    this.jobs.set(jobId, job)
    this.activeJobId = jobId
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    // Content-free lifecycle log (§12/§13 — jobId only, never image/prompt/answer). A started
    // analysis was previously invisible in the log; the run() terminal-state logs below close it.
    log.info('Vision analyze started', { jobId })
    // `req` is validated above — narrow for the background closure.
    void this.run(jobId, req as ImageAnalyzeRequest, controller.signal, emit)
    return { ...job }
  }

  private async run(
    jobId: string,
    req: ImageAnalyzeRequest,
    signal: AbortSignal,
    emit: VisionStreamEmitter
  ): Promise<void> {
    try {
      const status = await this.deps.getStatus()
      if (!status.available) {
        this.fail(jobId, 'runtimeFailed', emit)
        return
      }
      if (signal.aborted) {
        this.cancel(jobId)
        return
      }

      this.set(jobId, { jobId, state: 'starting' })
      const runtime = (this.runtime ??= this.deps.createRuntime(status))

      this.set(jobId, { jobId, state: 'analyzing' })
      const answer = await runtime.analyze({
        imageBytes: req.imageBytes,
        mimeType: req.mimeType,
        question: req.question,
        signal,
        onToken: (delta) => emit.token(jobId, delta)
      })

      if (signal.aborted) {
        this.cancel(jobId)
        return
      }
      if (answer.trim() === '') {
        this.fail(jobId, 'emptyResponse', emit)
        return
      }
      const done: ImageJob = { jobId, state: 'done', answer }
      this.jobs.set(jobId, done)
      this.evictOldJobs()
      log.info('Vision analyze done', { jobId })
      emit.done(jobId, done)
    } catch (err) {
      if (signal.aborted) {
        this.cancel(jobId)
        return
      }
      // The reason is for the local log only (stderr tails, never content); the renderer
      // gets a friendly code.
      log.warn('Vision analyze failed', { jobId, error: String(err) })
      this.fail(jobId, 'runtimeFailed', emit)
    } finally {
      this.controllers.delete(jobId)
      if (this.activeJobId === jobId) this.activeJobId = null
    }
  }

  /** Poll one job (unknown jobId ⇒ terminal failed — the DownloadManager `get` precedent). */
  getJob(jobId: string): ImageJob {
    const job = this.jobs.get(jobId)
    return job ? { ...job } : { jobId, state: 'failed', error: null }
  }

  /**
   * Cancel an in-flight job (AbortController). Marks it `cancelled` and aborts the sidecar
   * fetch. Unknown jobId ⇒ terminal failed (consistent with `getJob`).
   */
  cancel(jobId: string): ImageJob {
    const controller = this.controllers.get(jobId)
    if (controller && !controller.signal.aborted) controller.abort()
    const existing = this.jobs.get(jobId)
    if (!existing) return { jobId, state: 'failed', error: null }
    if (existing.state !== 'done' && existing.state !== 'failed') {
      const cancelled: ImageJob = { jobId, state: 'cancelled', error: 'cancelled' }
      this.jobs.set(jobId, cancelled)
      if (this.activeJobId === jobId) this.activeJobId = null
      this.evictOldJobs()
      return cancelled
    }
    return { ...existing }
  }

  /**
   * Tear down the lazily-built runtime — wired to workspace LOCK (registerWorkspaceIpc) and
   * QUIT (will-quit), and a safe no-op when nothing was ever built. Any in-flight job is
   * aborted FIRST so its sidecar fetch unwinds as `cancelled` (not a scary `runtimeFailed`)
   * before the child is killed; the next analyze rebuilds a fresh runtime (cold start).
   */
  async stop(): Promise<void> {
    for (const controller of this.controllers.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
    const runtime = this.runtime
    this.runtime = null
    await runtime?.stop?.()
    // Purge per-process residue at lock/quit (MEDIUM vuln-scan-2026-06-21). Completed-answer
    // text — content derived from the user's private image — must not survive the vault
    // re-encrypt, consistent with the lock path purging resident RAG vectors and zeroing the
    // vault key. Done AFTER the teardown await so an aborting in-flight run() that resumes mid-
    // await can't repopulate the map (and even then it re-records only a content-free terminal
    // job). The orchestrator rebuilds a fresh runtime on the next analyze.
    this.jobs.clear()
    this.controllers.clear()
    this.activeJobId = null
  }

  private set(jobId: string, job: ImageJob): void {
    // Don't resurrect a job the user cancelled mid-flight.
    if (this.jobs.get(jobId)?.state === 'cancelled') return
    this.jobs.set(jobId, job)
  }

  private fail(jobId: string, error: VisionErrorCode, emit: VisionStreamEmitter): void {
    if (this.jobs.get(jobId)?.state === 'cancelled') return
    const job: ImageJob = { jobId, state: 'failed', error }
    this.jobs.set(jobId, job)
    this.evictOldJobs()
    emit.error(jobId, job)
  }

  /** Bound the job map: drop the oldest non-active entries past `VISION_MAX_JOB_HISTORY`
   *  (insertion order; the active job is never evicted). */
  private evictOldJobs(): void {
    if (this.jobs.size <= VISION_MAX_JOB_HISTORY) return
    for (const id of this.jobs.keys()) {
      if (this.jobs.size <= VISION_MAX_JOB_HISTORY) break
      if (id === this.activeJobId) continue
      this.jobs.delete(id)
    }
  }
}

/**
 * Cap on retained jobs (BUG vuln-scan-2026-06-21). Vision is one-at-a-time, so terminal jobs
 * (each holding its full answer string) accumulated unbounded for the process lifetime. The
 * renderer reads a completed answer from the streamed `done` event, then polls `getJob` a few
 * times — a small history is plenty; older terminal entries are evicted.
 */
const VISION_MAX_JOB_HISTORY = 16

/** A terminal failed job with a code, NOT tracked (validation reject / busy reject). */
function failedJob(error: VisionErrorCode): ImageJob {
  return { jobId: randomUUID(), state: 'failed', error }
}

/**
 * Production runtime factory: resolve the binary + the available model's GGUF + mmproj from
 * the AppContext and build a real `VisionRuntime`. Throws if the assets can't be resolved
 * (the orchestrator already gated on `status.available`, so this is a defensive backstop).
 */
export function createVisionRuntimeFromContext(ctx: AppContext, status: VisionStatus): VisionRuntime {
  const binPath = resolveLlamaServerPath(ctx.paths.rootPath, process.platform, process.env, {
    isDev: ctx.isDev
  })
  if (!binPath) throw new Error('No llama-server binary for the vision sidecar')
  if (!ctx.manifestsDir || !status.modelId) throw new Error('No vision model resolved')
  const found = discoverManifests(ctx.manifestsDir).manifests.find(
    (m) => m.manifest.id === status.modelId
  )
  if (!found) throw new Error(`Vision model "${status.modelId}" not found`)
  return new VisionRuntime({
    modelId: found.manifest.id,
    binPath,
    modelPath: weightPath(ctx.paths.rootPath, found.manifest),
    projectorPath: mmprojPath(ctx.paths.rootPath, found.manifest),
    contextTokens: found.manifest.recommendedContextTokens
  })
}
