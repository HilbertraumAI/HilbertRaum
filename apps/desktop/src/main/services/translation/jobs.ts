import { randomUUID } from 'node:crypto'
import type {
  TranslateJob,
  TranslateErrorCode,
  TranslateRequest,
  TranslationSourceLang,
  TranslationTargetLang
} from '../../../shared/types'
import { isTranslationLangCode } from '../../../shared/types'
import { planTranslationWindows } from '../doctasks/translation'
import { log } from '../logging'
import type { Translator } from './index'

// Translate-view job orchestration (TG wave, plan §2 D6). The Translate screen's live TEXT
// translation runs here as a per-job, streaming job on the SAME `ctx.translator` TranslateGemma
// sidecar the document-translation doc-task uses — NOT a second model. A single window is the
// fast path; longer pasted text is planned with the SHARED `planTranslationWindows` (the doc-task
// planner, imported not duplicated — it carries the D4 ≤2K-input clamp) and streamed
// window-by-window into ONE output. The contract mirrors the vision image-job service (jobs map,
// one-at-a-time, busy-REJECT, getActiveJob for remount recovery, stop() on lock/quit).
//
// Privacy (§12/§13, security-model.md): the source text and its translation are TRANSIENT — held
// only in this per-process job map for the life of the job and dropped on lock/quit. NOTHING
// content-bearing is logged or audited; the lifecycle logs and the renderer errors are ids/codes.
//
// D9 busy-gating (recorded): the view job takes the SAME one-at-a-time lane as the doc-task. It
// REFUSES to start while a document task is active (`docTaskBusy`) — the D9 RAM co-residency
// argument (12B translate + a resident chat model + embedder) applies whether the running task is
// a translation (same sidecar) or a summary/compare (chat model). A second view translate while
// one runs is `busy`. The doc-task manager is left unchanged (plan D9 "all other kinds
// unchanged"); the shared sidecar is `--parallel 1`, so the rare reverse race (a doc task started
// while a view translate runs) serializes safely at the server rather than crashing.

/** A per-job streaming sink, keyed by jobId (the IPC layer binds it to one renderer's sender). */
export interface TranslateStreamEmitter {
  token: (jobId: string, delta: string) => void
  done: (jobId: string, job: TranslateJob) => void
  error: (jobId: string, job: TranslateJob) => void
}

export interface TranslateJobServiceDeps {
  /** The composed translation sidecar handle, or null when no model is installed (O2). */
  getTranslator: () => Translator | null
  /** True while a document task holds the one-at-a-time lane (D9). */
  hasActiveDocTask: () => boolean
}

/** Cap on retained terminal jobs — the interactive view is one-at-a-time, so a tiny history
 *  is plenty (the renderer reads the answer from the streamed `done` event). */
const TRANSLATE_MAX_JOB_HISTORY = 8

/** A terminal failed job with a code, NOT tracked (validation / busy / no-model reject). */
function failedJob(error: TranslateErrorCode): TranslateJob {
  return { jobId: randomUUID(), state: 'failed', error }
}

export class TranslateJobService {
  private readonly jobs = new Map<string, TranslateJob>()
  private readonly controllers = new Map<string, AbortController>()
  /** The single in-flight job (the view's own one-at-a-time serialization). Null when idle. */
  private activeJobId: string | null = null
  /**
   * Set WHILE `stop()` (workspace LOCK / quit) purges the jobs, cleared in its `finally` — the
   * vision `tearingDown` analogue. A `run()` scheduled by a `start()` that interleaves the
   * teardown refuses to touch the (suspended) sidecar. The IPC `requireUnlocked` guard already
   * bars a fresh start during lock; this is defense-in-depth for an in-flight scheduling race.
   */
  private tearingDown = false

  constructor(private readonly deps: TranslateJobServiceDeps) {}

  /**
   * Start a view translation. Validates (a model is present, both languages are curated codes,
   * source ≠ target, non-empty text — mirroring the TG-3 server-side rules), enforces the D9
   * lane (busy-REJECT a second view job; refuse while a document task runs), and returns the
   * initial job IMMEDIATELY; the sidecar calls run in the background and stream via `emit`. A
   * refusal returns a terminal `failed` job with a code and is NOT tracked / takes no slot.
   */
  start(req: TranslateRequest | undefined, emit: TranslateStreamEmitter): TranslateJob {
    const translator = this.deps.getTranslator()
    if (!translator) return failedJob('noModel')
    const source = req?.sourceLang
    const target = req?.targetLang
    const text = typeof req?.text === 'string' ? req.text : ''
    if (!isTranslationLangCode(source) || !isTranslationLangCode(target) || source === target) {
      return failedJob('badRequest')
    }
    if (text.trim() === '') return failedJob('badRequest')
    // Busy-REJECT (never queue) then the doc-task lane guard (D9).
    if (this.activeJobId) return failedJob('busy')
    if (this.deps.hasActiveDocTask()) return failedJob('docTaskBusy')

    const jobId = randomUUID()
    const job: TranslateJob = { jobId, state: 'queued', text: '', windowsDone: 0 }
    this.jobs.set(jobId, job)
    this.activeJobId = jobId
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    // Content-free lifecycle log (§12/§13 — jobId + lang pair only, never the text).
    log.info('Translate job started', { jobId, source, target })
    void this.run(jobId, { sourceLang: source, targetLang: target, text }, translator, controller.signal, emit)
    return { ...job }
  }

  private async run(
    jobId: string,
    req: { sourceLang: TranslationSourceLang; targetLang: TranslationTargetLang; text: string },
    translator: Translator,
    signal: AbortSignal,
    emit: TranslateStreamEmitter
  ): Promise<void> {
    try {
      if (this.tearingDown || signal.aborted) {
        this.cancel(jobId)
        return
      }
      // Plan the windows against the SIDECAR's launched --ctx-size (+ the D4 ≤2K-input clamp
      // inside the shared planner). Split the paste on BLANK LINES into paragraph "segments"
      // first (mirroring the doc-task, which feeds real parser segments) so a multi-window paste
      // cuts on paragraph boundaries and the '\n\n' window joins fall on real breaks — passing the
      // whole blob would let the planner slice mid-sentence and insert a spurious blank line there.
      // A single over-budget paragraph still splits by token budget (packIntoWindows); a single
      // window round-trips the text verbatim.
      const segments = req.text.split(/\n\s*\n+/).map((s) => s.trim()).filter((s) => s.length > 0)
      const plan = planTranslationWindows(segments.length > 0 ? segments : [req.text], translator.contextWindow())
      if (plan.windows.length === 0) {
        // All-whitespace after normalization (start() already rejected empty) — nothing to do.
        this.fail(jobId, 'badRequest', emit)
        return
      }
      this.patch(jobId, { state: 'translating', windowsTotal: plan.windows.length, windowsDone: 0 })

      // Strictly SEQUENTIAL windows (the sidecar is --parallel 1; #25142). Each window streams
      // its deltas; a blank-line separator is emitted between windows so the live stream AND the
      // final text carry the same joins (the doc-task's '\n\n' framing).
      for (let i = 0; i < plan.windows.length; i++) {
        if (signal.aborted) {
          this.cancel(jobId)
          return
        }
        if (i > 0) this.emitDelta(jobId, '\n\n', emit)
        await translator.translate({
          sourceLang: req.sourceLang,
          targetLang: req.targetLang,
          text: plan.windows[i],
          maxTokens: plan.windowMaxTokens,
          signal,
          onToken: (delta) => this.emitDelta(jobId, delta, emit)
        })
        this.patch(jobId, { windowsDone: i + 1 })
      }

      if (signal.aborted) {
        this.cancel(jobId)
        return
      }
      const finalText = (this.jobs.get(jobId)?.text ?? '').trim()
      if (finalText === '') {
        this.fail(jobId, 'empty', emit)
        return
      }
      const done: TranslateJob = {
        jobId,
        state: 'done',
        text: finalText,
        windowsTotal: plan.windows.length,
        windowsDone: plan.windows.length
      }
      // Route through the cancelled-guarded set() so a cancel that landed mid-flight is not
      // overwritten by `done` (and emit.done not re-fired) — the vision F18 hardening.
      if (!this.set(jobId, done)) return
      this.evictOldJobs()
      log.info('Translate job done', { jobId })
      emit.done(jobId, done)
    } catch (err) {
      if (signal.aborted) {
        this.cancel(jobId)
        return
      }
      // The reason is for the local log only (stderr tails, never content); renderer gets a code.
      log.warn('Translate job failed', { jobId, error: String(err) })
      this.fail(jobId, 'runtimeFailed', emit)
    } finally {
      this.controllers.delete(jobId)
      if (this.activeJobId === jobId) this.activeJobId = null
    }
  }

  /** The active job's snapshot (accumulated text + progress) for remount recovery, or null. */
  getActiveJob(): TranslateJob | null {
    if (!this.activeJobId) return null
    const job = this.jobs.get(this.activeJobId)
    return job ? { ...job } : null
  }

  /** Poll one job (unknown jobId ⇒ terminal failed — the vision `getJob` precedent). */
  getJob(jobId: string): TranslateJob {
    const job = this.jobs.get(jobId)
    return job ? { ...job } : { jobId, state: 'failed', error: null }
  }

  /**
   * Cancel an in-flight job (AbortController). Marks it `cancelled` and aborts the sidecar
   * fetch. Unknown jobId ⇒ terminal failed (consistent with `getJob`). Idempotent: the
   * aborted `run()` also lands here.
   */
  cancel(jobId: string): TranslateJob {
    const controller = this.controllers.get(jobId)
    if (controller && !controller.signal.aborted) controller.abort()
    const existing = this.jobs.get(jobId)
    if (!existing) return { jobId, state: 'failed', error: null }
    if (existing.state !== 'done' && existing.state !== 'failed') {
      const cancelled: TranslateJob = { ...existing, state: 'cancelled', error: 'cancelled' }
      this.jobs.set(jobId, cancelled)
      if (this.activeJobId === jobId) this.activeJobId = null
      this.evictOldJobs()
      return cancelled
    }
    return { ...existing }
  }

  /**
   * Abort any in-flight job and purge the job map — wired to workspace LOCK
   * (registerWorkspaceIpc) and QUIT (will-quit / shutdown). The transient source/translation
   * text must not linger past a lock (parity with vision's job-map purge). The sidecar ITSELF is
   * suspended/stopped separately (`ctx.translator`); aborting here BEFORE that keeps the loop
   * from calling `translate()` for the next window and lazily RESPAWNING the just-suspended
   * ~10 GB server. A safe no-op when idle.
   */
  async stop(): Promise<void> {
    this.tearingDown = true
    try {
      for (const controller of this.controllers.values()) {
        if (!controller.signal.aborted) controller.abort()
      }
      this.jobs.clear()
      this.controllers.clear()
      this.activeJobId = null
    } finally {
      this.tearingDown = false
    }
  }

  /** Append a streamed delta to the job's accumulated text AND forward it to the renderer.
   *  A no-op once the job left `translating` (a late onToken must not resurrect a cancelled job). */
  private emitDelta(jobId: string, delta: string, emit: TranslateStreamEmitter): void {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'translating') return
    this.jobs.set(jobId, { ...job, text: (job.text ?? '') + delta })
    emit.token(jobId, delta)
  }

  /** Merge a patch into a job UNLESS it was cancelled (don't resurrect a cancelled job). */
  private patch(jobId: string, patch: Partial<TranslateJob>): void {
    const job = this.jobs.get(jobId)
    if (!job || job.state === 'cancelled') return
    this.jobs.set(jobId, { ...job, ...patch })
  }

  /**
   * Write a terminal job state UNLESS the user cancelled it mid-flight. Returns whether the
   * write was applied, so the `done` path can also skip `emit.done`/eviction on a cancelled job.
   */
  private set(jobId: string, job: TranslateJob): boolean {
    if (this.jobs.get(jobId)?.state === 'cancelled') return false
    this.jobs.set(jobId, job)
    return true
  }

  private fail(jobId: string, error: TranslateErrorCode, emit: TranslateStreamEmitter): void {
    if (this.jobs.get(jobId)?.state === 'cancelled') return
    const job: TranslateJob = { jobId, state: 'failed', error }
    this.jobs.set(jobId, job)
    this.evictOldJobs()
    emit.error(jobId, job)
  }

  /** Bound the job map: drop the oldest non-active entries past the history cap. */
  private evictOldJobs(): void {
    if (this.jobs.size <= TRANSLATE_MAX_JOB_HISTORY) return
    for (const id of this.jobs.keys()) {
      if (this.jobs.size <= TRANSLATE_MAX_JOB_HISTORY) break
      if (id === this.activeJobId) continue
      this.jobs.delete(id)
    }
  }
}
