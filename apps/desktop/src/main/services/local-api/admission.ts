// External-request admission for the local API (D8: in-app wins, one external at a time).
//
// The RuntimeManager's generation gate is the ground truth for "is the model busy" — it
// counts every lane that reaches `active().chatStream` (chat/RAG, doc tasks, skill runs,
// the benchmark, compaction, classification). This module sits in front of it and decides
// whether an external request may occupy the single external slot at all:
//
//   - `runtimeBusy` must be bound to `RuntimeManager.isExternallyBusy` — the ONE
//     manager-owned predicate that is fail-closed (no active runtime ⇒ busy, covering
//     the whole start window incl. the hidden #109 warm-up generation, which streams
//     against the inner rung runtime while `active()` is still null).
//   - Queue depth is 0–1 BY DESIGN: on ~2 tok/s CPU hardware one generation is minutes,
//     so a deeper queue is a silent multi-minute hang; beyond the single waiter the
//     caller answers 429 (Retry-After derived at the HTTP layer) immediately.
//   - Admission is advisory, not permission to stream: the gate re-checks "no in-app
//     lane active, no second external" in the same synchronous frame that starts the
//     external stream, so the admit→stream await gap can never overlap generations.
//   - Lock/teardown: `admitsWork()` must be the workspaceAdmitsWork(workspace) class of
//     predicate (unlocked ∧ not locking) — never a bare isUnlocked() — combined with the
//     server's own stop latch.
//
// Kin: `analysis/model-slot-arbiter.ts` coordinates the same physical model slot between
// in-app chat and yielding builders (cooperative pause/resume); this module's protocol is
// refuse/queue/abort for OUTSIDE callers, so the two deliberately stay separate.

export interface LocalApiAdmissionDeps {
  /** Bind to `RuntimeManager.isExternallyBusy` (fail-closed; see header). */
  runtimeBusy(): boolean
  /** Doc tasks hold the model across generate-parse gaps the gate can't see. */
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
  /** Abort surface for the request's whole lifetime: caller disconnect, pre-emption by
   *  an in-app turn, teardown, and a refused/expired wait all abort here. Pass it to
   *  `chatStream` as `signal`. Invariant: `ready` resolving false ⇒ this is aborted. */
  readonly signal: AbortSignal
  /**
   * Resolves `true` once the slot is HELD (immediately for an idle admission; on
   * promotion for the queued one) and `false` when the wait ends without a slot
   * (pre-empted, aborted, timed out, or the world changed at promotion time — the
   * caller answers 429/abort). Never rejects.
   */
  readonly ready: Promise<boolean>
  /**
   * Free the slot / leave the queue. Idempotent; MUST run on every exit path — and for
   * a held slot, only AFTER the stream generator has fully settled (drained, thrown, or
   * `return()`ed): releasing mid-teardown makes the promotion re-check see the dying
   * stream as busy and spuriously refuse the patient waiter.
   */
  release(): void
}

export type AdmitOutcome = Admission | 'busy' | 'locked' | 'aborted'

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

  /** The model is free for an external generation RIGHT NOW. */
  private idleNow(): boolean {
    return !this.deps.runtimeBusy() && !this.deps.hasActiveDocTask()
  }

  /**
   * Try to occupy the external slot. 'locked' = the workspace refuses work (lock/quit
   * in progress — answer as if the API were down); 'aborted' = the caller was already
   * gone (drop the connection, no busy accounting); 'busy' = the model is occupied or
   * the shallow queue is full (429 + Retry-After at the HTTP layer).
   */
  tryAdmit(id: string, callerSignal?: AbortSignal): AdmitOutcome {
    if (!this.deps.admitsWork()) return 'locked'
    if (callerSignal?.aborted) return 'aborted'

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
      this.refuse(record, 'queue wait timed out')
    }, this.queueWaitMs)
    // Node-only: don't let a parked waiter keep the process alive.
    ;(record.queueTimer as { unref?: () => void })?.unref?.()
    return this.toAdmission(record)
  }

  /**
   * Abort everything external: the active stream AND the admitted-but-unstarted waiter.
   * Two callers, same semantics: the manager gate's pre-emption hook (an in-app
   * generation entered, D8) and lock/quit/server-stop teardown. The active record's
   * SLOT is not freed here — its holder releases after the stream's real teardown
   * (releasing in the abort frame would run the promotion re-check while the dying
   * stream still counts as busy).
   */
  abortAll(reason: string): void {
    const abortReason = new DOMException(reason, 'AbortError')
    if (this.queued) this.refuse(this.queued, reason)
    this.active?.controller.abort(abortReason)
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
        // A vanished QUEUED caller frees its place immediately. The ACTIVE record's slot
        // stays with its holder — the stream is still draining, and an abort-frame
        // release would spuriously refuse the patient waiter (promotion re-check runs
        // before the gate count drops).
        if (this.queued === record) this.releaseRecord(record)
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

  /** Refuse a QUEUED record: abort its signal (the `ready:false ⇒ aborted` invariant)
   *  and route through the single release path (detaches listeners, clears the timer). */
  private refuse(record: AdmissionRecord, reason: string): void {
    if (!record.controller.signal.aborted) {
      record.controller.abort(new DOMException(reason, 'AbortError'))
    }
    this.releaseRecord(record)
  }

  /** Resolve `ready` (idempotently — Promise resolution is first-wins) + clear the timer. */
  private settle(record: AdmissionRecord, held: boolean): void {
    if (record.queueTimer != null) {
      this.clearTimeoutFn(record.queueTimer)
      record.queueTimer = null
    }
    record.resolveReady(held)
  }

  /** The ONE exit path for every record (idempotent): detach, settle, vacate, promote. */
  private releaseRecord(record: AdmissionRecord): void {
    if (record.released) return
    record.released = true
    record.detachCallerAbort?.()
    record.detachCallerAbort = null
    this.settle(record, false) // no-op if ready already resolved true

    if (this.queued === record) {
      this.queued = null
      return
    }
    if (this.active !== record) return
    this.active = null

    // Promote the waiter — but only into a world that still admits it. There is no
    // "in-app generation ended" event to keep waiting on, so a failed re-check answers
    // false NOW (an honest 429 + Retry-After instead of a silent hang). NOTE the release
    // contract above: holders release AFTER stream settle, so the freed gate count is
    // visible here and an external→external handoff promotes cleanly.
    const next = this.queued
    if (!next) return
    this.queued = null
    if (this.deps.admitsWork() && !next.controller.signal.aborted && this.idleNow()) {
      this.active = next
      this.settle(next, true)
    } else {
      this.refuse(next, 'slot no longer available')
    }
  }
}
