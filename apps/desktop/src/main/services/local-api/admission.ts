// External-request admission for the local API (D8: in-app wins, one external at a time).
//
// The RuntimeManager's generation gate is the ground truth for "is the model busy" — it
// counts every lane that reaches `active().chatStream` (chat/RAG, doc tasks, skill runs,
// the benchmark, compaction, classification). This module sits in front of it and decides
// whether an external request may occupy the single external slot at all:
//
//   - FAIL CLOSED: no active runtime means "busy", never "idle" — that denial covers the
//     whole start window, including the hidden #109 warm-up generation, which talks to the
//     inner rung runtime while `active()` is still null and is invisible to the gate.
//   - Queue depth is 0–1 BY DESIGN: on ~2 tok/s CPU hardware one generation is minutes,
//     so a deeper queue is a silent multi-minute hang; beyond the single waiter the caller
//     answers 429 (with Retry-After derived at the HTTP layer) immediately.
//   - Admission is advisory, not permission to stream: the gate re-checks "no in-app lane
//     active" in the same synchronous frame that starts the external stream, so the
//     admit→stream await gap can never run an external generation beside an in-app turn.
//   - Lock/teardown: `admitsWork()` must be the workspaceAdmitsWork(workspace) class of
//     predicate (unlocked ∧ not locking) — never a bare isUnlocked() — combined with the
//     server's own stop latch. `preemptExternal` / `abortAll` abort the active stream AND
//     the admitted-but-unstarted waiter, and the manager gate additionally awaits the
//     active stream's real teardown before an in-app generation issues.

export interface LocalApiAdmissionDeps {
  /** The RuntimeManager gate: true while ANY lane has an in-flight generation. */
  isGenerating(): boolean
  /** False during starts/warm-up/stops — admission then refuses (fail closed). */
  hasActiveRuntime(): boolean
  /** Doc tasks hold the model for long windows; external requests never interleave. */
  hasActiveDocTask(): boolean
  /** workspaceAdmitsWork(workspace) ∧ the owning server is not stopping. */
  admitsWork(): boolean
  /** Cap on how long the single queued waiter may park (default 30 s). */
  queueWaitMs?: number
  // Test seams (fake timers):
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (t: ReturnType<typeof setTimeout>) => void
}

export interface Admission {
  readonly id: string
  /** Abort surface for the request's whole lifetime: caller disconnect, pre-emption by an
   *  in-app turn, and teardown all abort here. Pass it to `chatStream` as `signal`. */
  readonly signal: AbortSignal
  /**
   * Resolves `true` once the slot is HELD (immediately for an idle admission; on
   * promotion for the queued one) and `false` when the wait ends without a slot
   * (pre-empted, aborted, timed out, or the world changed at promotion time — the
   * caller answers 429/abort). Never rejects.
   */
  readonly ready: Promise<boolean>
  /** Free the slot / leave the queue. Idempotent; MUST run on every exit path. */
  release(): void
}

export type AdmitOutcome = Admission | 'busy' | 'locked'

const DEFAULT_QUEUE_WAIT_MS = 30_000

interface AdmissionRecord {
  id: string
  controller: AbortController
  resolveReady: (held: boolean) => void
  ready: Promise<boolean>
  released: boolean
  detachCallerAbort: (() => void) | null
  queueTimer: ReturnType<typeof setTimeout> | null
}

export class LocalApiAdmission {
  private active: AdmissionRecord | null = null
  private queued: AdmissionRecord | null = null
  private readonly queueWaitMs: number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (t: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: LocalApiAdmissionDeps) {
    this.queueWaitMs = deps.queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((t) => clearTimeout(t))
  }

  /** The model is free for an external generation RIGHT NOW. Fail closed on no runtime. */
  private idleNow(): boolean {
    return this.deps.hasActiveRuntime() && !this.deps.isGenerating() && !this.deps.hasActiveDocTask()
  }

  /**
   * Try to occupy the external slot. 'locked' = the workspace refuses work (lock/quit in
   * progress — the caller answers as if the API were down); 'busy' = the model is
   * occupied or the shallow queue is full (the caller answers 429 + Retry-After).
   */
  tryAdmit(id: string, callerSignal?: AbortSignal): AdmitOutcome {
    if (!this.deps.admitsWork()) return 'locked'
    if (callerSignal?.aborted) return 'busy'

    if (this.active == null) {
      if (!this.idleNow()) return 'busy'
      const record = this.makeRecord(id, callerSignal)
      this.active = record
      record.resolveReady(true)
      return this.toAdmission(record)
    }

    if (this.queued != null) return 'busy'

    // The single queued waiter: parks until the active request releases, bounded.
    const record = this.makeRecord(id, callerSignal)
    this.queued = record
    record.queueTimer = this.setTimeoutFn(() => {
      if (this.queued === record) this.queued = null
      this.settle(record, false)
    }, this.queueWaitMs)
    // Node-only: don't let a parked waiter keep the process alive.
    ;(record.queueTimer as { unref?: () => void })?.unref?.()
    return this.toAdmission(record)
  }

  /**
   * In-app pre-emption (fired by the manager gate the moment an in-app generation
   * enters) and teardown both land here: abort the active stream, and cancel the
   * admitted-but-unstarted waiter so it can never start into the in-app turn.
   */
  preemptExternal(reason: string): void {
    const abortReason = new DOMException(reason, 'AbortError')
    if (this.queued) {
      const q = this.queued
      this.queued = null
      q.controller.abort(abortReason)
      this.settle(q, false)
    }
    if (this.active) {
      // The active record stays "active" until its holder releases — the manager gate
      // awaits the stream's REAL teardown (lane count → 0), not this abort.
      this.active.controller.abort(abortReason)
    }
  }

  /** Teardown (lock/quit/server stop): identical to pre-emption — abort everything. */
  abortAll(reason: string): void {
    this.preemptExternal(reason)
  }

  private makeRecord(id: string, callerSignal?: AbortSignal): AdmissionRecord {
    const controller = new AbortController()
    let resolveReady!: (held: boolean) => void
    const ready = new Promise<boolean>((resolve) => (resolveReady = resolve))
    const record: AdmissionRecord = {
      id,
      controller,
      resolveReady,
      ready,
      released: false,
      detachCallerAbort: null,
      queueTimer: null
    }
    if (callerSignal) {
      const onAbort = (): void => {
        controller.abort(callerSignal.reason ?? new DOMException('client disconnected', 'AbortError'))
        // A vanished caller frees its place immediately (a queued waiter must not hold
        // the queue slot for a request nobody is waiting on).
        this.releaseRecord(record)
      }
      callerSignal.addEventListener('abort', onAbort, { once: true })
      record.detachCallerAbort = () => callerSignal.removeEventListener('abort', onAbort)
    }
    return record
  }

  private toAdmission(record: AdmissionRecord): Admission {
    return {
      id: record.id,
      signal: record.controller.signal,
      ready: record.ready,
      release: () => this.releaseRecord(record)
    }
  }

  /** Resolve `ready` (idempotently) and clear the record's timer/listener. */
  private settle(record: AdmissionRecord, held: boolean): void {
    if (record.queueTimer != null) {
      this.clearTimeoutFn(record.queueTimer)
      record.queueTimer = null
    }
    record.resolveReady(held)
  }

  private releaseRecord(record: AdmissionRecord): void {
    if (record.released) return
    record.released = true
    record.detachCallerAbort?.()
    this.settle(record, false) // no-op if ready already resolved true

    if (this.queued === record) {
      this.queued = null
      return
    }
    if (this.active !== record) return
    this.active = null

    // Promote the waiter — but only into a world that still admits it. There is no
    // "in-app generation ended" event to keep waiting on, so a failed re-check answers
    // false NOW (the client gets an honest 429 + Retry-After instead of a silent hang).
    const next = this.queued
    if (!next) return
    this.queued = null
    if (this.deps.admitsWork() && !next.controller.signal.aborted && this.idleNow()) {
      this.active = next
      this.settle(next, true)
    } else {
      this.settle(next, false)
    }
  }
}
