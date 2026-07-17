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
import { isCleanStop } from './completion'
import type { CompletionFinal } from './completion'
import { isTranslationStartError } from './runtime'
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
  /** F-25: purge observers. `stop()` (the lock/quit terminal) emits neither trDone nor trError and
   *  does NOT destroy the window, so it is the THIRD terminal the F-4 IPC detach missed — the IPC
   *  layer subscribes here to run its per-job `destroyed`-listener detach on a purge. */
  private readonly stopListeners = new Set<() => void>()

  constructor(private readonly deps: TranslateJobServiceDeps) {}

  /** Subscribe to `stop()` purges (lock/quit). Returns an unsubscribe. */
  onStop(listener: () => void): () => void {
    this.stopListeners.add(listener)
    return () => this.stopListeners.delete(listener)
  }

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
      // The real defense against a start that interleaves a lock/quit teardown is `signal.aborted`:
      // `stop()` aborts every controller BEFORE the vault re-encrypts, so a run() scheduled just
      // before then sees its signal already aborted and bails without touching the suspended sidecar.
      // (The IPC `requireUnlocked` guard bars a fresh start during lock; this covers the in-flight race.)
      if (signal.aborted) {
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
        // TA-5 M7: the view must not silently drop a paragraph. A window that comes back empty,
        // TRUNCATED (no clean stop — M6), or throwing a runtime error is a failed attempt; if it
        // still fails, fail the WHOLE job visibly (runtimeFailed) — an interactive user is better
        // served by an honest failure than by a finished translation with a missing paragraph.
        // (A user cancel aborts `signal` and is handled as `cancelled`, never a failed window.)
        //
        // FA-2 F-2: classify the failure before retrying. A THROW or an EMPTY reply is TRANSIENT
        // (a server-side close, a per-request timeout, an M1 crash-recovery) — retry once. A
        // NON-EMPTY window that did NOT stop cleanly is a deterministic temperature-0 LIMIT stop
        // (a greedy-decode repetition loop / a token-dense clip at the cap): the sidecar decodes
        // greedily with `cache_prompt`, so a retry reproduces the identical truncation and burns
        // another full ~30-min decode for the same outcome. So a limit-stop skips the retry and
        // fails the job now (`limitStop` breaks the attempt loop).
        //
        // FA-1 F-1: checkpoint the accumulated text HERE — after the '\n\n' window separator (i>0),
        // before the attempt loop. A transiently-failed attempt has ALREADY streamed its deltas
        // through emitDelta into job.text; without rollback the retry appends the window a SECOND
        // time and that duplication survives into the terminal `done` text (the silent-output-
        // corruption class the TA wave closed). Restoring the checkpoint before each retry attempt
        // drops the failed attempt's deltas. (The live view may briefly flash the duplicate, but
        // trDone carries the full text and the renderer replaces its output with it.)
        const checkpoint = this.jobs.get(jobId)?.text ?? ''
        let clean = false
        let limitStop = false
        let startFailed = false
        for (let attempt = 1; attempt <= 2 && !clean && !limitStop && !startFailed; attempt++) {
          // Roll back a prior failed attempt's streamed deltas. patch-level, so the cancelled
          // guard in patch() holds — a job cancelled mid-flight is never resurrected by the restore.
          if (attempt > 1) this.patch(jobId, { text: checkpoint })
          let final: CompletionFinal | undefined
          try {
            const out = await translator.translate({
              sourceLang: req.sourceLang,
              targetLang: req.targetLang,
              text: plan.windows[i],
              maxTokens: plan.windowMaxTokens,
              signal,
              onToken: (delta) => this.emitDelta(jobId, delta, emit),
              onFinal: (info) => {
                final = info
              }
            })
            if (signal.aborted) {
              this.cancel(jobId)
              return
            }
            clean = out.trim() !== '' && isCleanStop(final)
            if (!clean) {
              // F-2: a non-empty reply that did not stop cleanly is the deterministic limit-stop —
              // do not retry it. An empty reply is the transient class → the loop retries once.
              limitStop = out.trim() !== ''
              log.warn('Translate view window incomplete', { jobId, window: i + 1, attempt, limitStop })
            }
          } catch (err) {
            if (signal.aborted) {
              this.cancel(jobId)
              return
            }
            // A LATCHED sidecar start failure (F-7 / FA-4): the latch re-throws, so a retry is
            // futile, and the user needs the actionable "restart / free memory" copy rather than
            // "runtime failed" — surface the DISTINCT code and stop the attempt loop. Log
            // content-free (the runtime/stderr string, never source/translation text — §Translate
            // view content-free logs).
            if (isTranslationStartError(err)) {
              log.warn('Translate view start failed', { jobId, window: i + 1, error: String(err) })
              startFailed = true
              break
            }
            // A per-request timeout / runtime error — never a user cancel (that aborts `signal`).
            // A throw is TRANSIENT (F-2): log content-free and let the retry run; a second failure
            // fails the job below.
            log.warn('Translate view window failed', { jobId, window: i + 1, attempt, error: String(err) })
          }
        }
        if (startFailed) {
          this.fail(jobId, 'startFailed', emit)
          return
        }
        if (!clean) {
          this.fail(jobId, 'runtimeFailed', emit)
          return
        }
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
    for (const controller of this.controllers.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
    this.jobs.clear()
    this.controllers.clear()
    this.activeJobId = null
    // F-25: notify the IPC layer so it detaches each job's `destroyed` once-listener + detachers
    // entry — this terminal fires no trDone/trError and lock does not destroy the window, so without
    // this each lock-during-in-flight cycle leaks one listener (MaxListenersExceededWarning at ~11).
    for (const listener of [...this.stopListeners]) listener()
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
