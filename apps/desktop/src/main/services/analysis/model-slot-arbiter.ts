// The single in-process owner of "who holds the one chat runtime slot" for a YIELDING
// summary-tree build (whole-document-analysis plan §4.1, H9/H10). It exists to make the
// builder and an interactive chat answer hand the model slot back and forth WITHOUT ever
// both calling `chatStream` on the one `llama-server` (the hard one-job-at-a-time rule).
//
// Why an arbiter and not the two legacy boolean guards: the chat↔task exclusion was two
// independent synchronous check-then-claim guards (`hasActiveTask()` in chat-stream,
// `isChatStreaming()` in the manager). Turning "chat refuses a build" into "chat PAUSES a
// build" reintroduces a TOCTOU at the node→node boundary — both sides could read "slot
// free" and call `chatStream`. So a single object holds the handshake:
//
//   - The builder commits one node at a time. At each node boundary (synchronous, before
//     the next `generate`) it calls `shouldYield()`; if true it parks on `reacquire(jobId)`
//     — a Promise the arbiter resolves once chat releases the slot (rejects on abort). It
//     does NOT return (a returning DocTask is marked done and never resumes — H10).
//   - A chat IPC, before it registers its in-flight stream + calls `chatStream`, calls
//     `acquireForChat()`: it flags `pauseRequested` and AWAITS the builder's handoff (the
//     builder reaching its yield point and parking). Only then does chat hold the slot.
//   - When chat's stream ends it calls the release fn `acquireForChat()` returned, which
//     resumes the parked builder (when the last concurrent chat is done) — after a DELAY,
//     see RESUME_AFTER_CHAT_DELAY_MS below.
//
// There is exactly one yielding build at a time (DocTaskManager runs one task), so the
// arbiter tracks a single active build + a single parked reacquire.

/** Thrown into a parked `reacquire()` when the slot is torn down (cancel/lock/quit/switch). */
export class SlotAbortedError extends Error {
  constructor(message = 'Model slot build aborted') {
    super(message)
    this.name = 'SlotAbortedError'
  }
}

/**
 * How long a parked build waits after the LAST chat stream ends before it takes the slot back
 * (issue #399, owner decision D3(a), 2026-09-09). Until this landed the builder resumed the
 * instant `chatHolders` hit 0 — i.e. inside the few seconds between one reply finishing and the
 * user typing the next one — so an ordinary conversation handed the slot away and took it back on
 * EVERY turn.
 *
 * Why that is expensive, and why "not evicting" is the only available lever: on 11 of our 14 chat
 * models an evicted chat prefix is **re-prefilled from scratch, not restored**. llama-server saves
 * the conversation to its host-RAM prompt cache and then silently re-processes the whole prompt
 * anyway — recurrent state (the whole `qwen3.5`/`qwen3.8` line) and a sliding window (all four
 * `gemma4` manifests) both close the restore path, measured across fourteen models with three
 * positive controls that DID restore. No slot arrangement fixes it (`-np 2` re-prefilled token for
 * token, even into a slot nothing had ever touched), so the eviction itself is the only thing we
 * control. Record + evidence: `docs/model-benchmarks.md` §6.6 "2026-09-09 correction (#399)".
 *
 * Why 90 s. The owner's range was 60–120 s; 90 s is its midpoint and the thing being covered is a
 * conversation's own turn gap — reading a long answer and typing a follow-up sits comfortably
 * inside it, while 120 s buys little more and delays the index for that much longer on every park.
 *
 * WHERE THE DELAY IS NOT: never on `acquireForChat()`. The chat path AWAITS that call, so a delay
 * there would slow down every chat turn — a far worse bug than the one this fixes. A chat arriving
 * while the resume timer is pending finds the builder still parked, cancels the timer and takes the
 * slot immediately, exactly as before.
 */
export const RESUME_AFTER_CHAT_DELAY_MS = 90_000

/**
 * The starvation guarantee (#399 D3(a)). A naive "wait 90 s after every chat turn" lets a user who
 * chats steadily every 30 s prevent the deep-index build from EVER resuming, and a document that
 * silently never gets its deep index is a worse outcome than one slow reply.
 *
 * The guarantee, stated so a test can pin it: **the arbiter adds at most `MAX_PARK_DEFERRAL_MS` of
 * delay to any single park.** The clock starts when the builder parks in `reacquire()`. While the
 * park is younger than this cap, a release schedules the resume `RESUME_AFTER_CHAT_DELAY_MS` later
 * and a new chat cancels it. Once the park is older, the very next release resumes the build
 * IMMEDIATELY — exactly the pre-#399 behaviour — no matter how many deferrals preceded it.
 *
 * 10 minutes is ~6 consecutive deferrals at 90 s. Past that the user is in a sustained conversation
 * rather than an ordinary turn gap, and the build's progress is worth one slow reply. So a steady
 * chat pays a re-prefill roughly every 10 minutes instead of on every turn. Note the cap bounds the
 * delay the ARBITER adds, not the wall clock: a chat that simply never releases the slot holds it
 * for its own reasons, and the build physically cannot run while it does.
 */
export const MAX_PARK_DEFERRAL_MS = 600_000

/** Opaque timer handle — the seam is injected so tests drive the delay without real sleeps. */
type TimerHandle = unknown

/** Test seams (#399): fake time in, no `setTimeout` in the unit tests. All optional. */
export interface ModelSlotArbiterDeps {
  resumeDelayMs?: number
  maxParkDeferralMs?: number
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  now?: () => number
}

export class ModelSlotArbiter {
  /** The jobId of the running yielding build, or null when no build holds the slot. */
  private activeBuild: string | null = null
  /** Set by chat to ask the builder to yield at its next node boundary. */
  private pauseRequested = false
  /** Chat callers waiting for the builder to relinquish the slot. */
  private handoffWaiters: Array<() => void> = []
  /** The parked builder's continuation: resolve to resume, reject to abort. */
  private reacquireResolve: (() => void) | null = null
  private reacquireReject: ((err: Error) => void) | null = null
  /** How many chat streams currently hold the slot (resume the builder when this hits 0). */
  private chatHolders = 0
  /** The pending post-chat resume timer, or null when none is armed (#399 D3(a)). */
  private resumeTimer: TimerHandle | null = null
  /** When the builder parked (`now()`), or null when it is not parked — the starvation clock. */
  private parkedAt: number | null = null

  private readonly resumeDelayMs: number
  private readonly maxParkDeferralMs: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly now: () => number

  constructor(deps: ModelSlotArbiterDeps = {}) {
    this.resumeDelayMs = deps.resumeDelayMs ?? RESUME_AFTER_CHAT_DELAY_MS
    this.maxParkDeferralMs = deps.maxParkDeferralMs ?? MAX_PARK_DEFERRAL_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.now = deps.now ?? (() => Date.now())
  }

  /** True while a yielding build owns the slot — chat branches on this to pause vs refuse. */
  isBuildActive(): boolean {
    return this.activeBuild !== null
  }

  /**
   * The builder declares itself the slot owner when its run starts. Resets ALL transient
   * handshake state — a prior build that ended while a chat still (briefly) held the slot
   * could otherwise leave `chatHolders` > 0, which would make this build's first
   * `reacquire` never resume (chatHolders never reaches 0). Each build starts clean.
   */
  registerBuild(jobId: string): void {
    this.activeBuild = jobId
    this.pauseRequested = false
    this.chatHolders = 0
    this.handoffWaiters = []
    this.reacquireResolve = null
    this.reacquireReject = null
    this.cancelPendingResume()
    this.parkedAt = null
  }

  /**
   * The builder is leaving (done / failed / cancelled). Clears the slot and wakes any chat
   * still waiting on a handoff (the slot is free now that the build is gone) so an
   * acquire that raced the build's completion never hangs.
   */
  unregisterBuild(jobId: string): void {
    if (this.activeBuild !== jobId) return
    this.activeBuild = null
    this.pauseRequested = false
    this.reacquireResolve = null
    this.reacquireReject = null
    // The build is gone; a resume timer aimed at it must not fire into a dead handshake.
    this.cancelPendingResume()
    this.parkedAt = null
    this.wakeHandoffWaiters()
  }

  /** The builder's synchronous check at each node boundary. */
  shouldYield(): boolean {
    return this.pauseRequested
  }

  /**
   * The builder parks here when `shouldYield()` is true: it hands the slot to the waiting
   * chat (resolving the handoff) and returns a Promise that resolves when chat releases
   * the slot — after `RESUME_AFTER_CHAT_DELAY_MS` (#399 D3(a)) — or rejects with
   * `SlotAbortedError` on cancel/lock/quit/model-switch. `parkedAt` is stamped here: it is the
   * start of the `MAX_PARK_DEFERRAL_MS` starvation clock, so the cap measures how long THIS park
   * has been deferred, not how long the process has been running.
   */
  reacquire(jobId: string): Promise<void> {
    if (this.activeBuild !== jobId) {
      // Defensive: a stale jobId should not park forever.
      return Promise.resolve()
    }
    this.pauseRequested = false
    this.cancelPendingResume()
    this.parkedAt = this.now()
    this.wakeHandoffWaiters()
    return new Promise<void>((resolve, reject) => {
      this.reacquireResolve = resolve
      this.reacquireReject = reject
    })
  }

  /**
   * Chat side: claim the slot. If no yielding build holds it, returns a no-op release
   * immediately. Otherwise it requests a pause and AWAITS the builder parking, then returns
   * a release fn the caller MUST call when its stream ends (idempotent).
   *
   * REL-3: an optional `signal` (the chat turn's `AbortController.signal`) lets a user "Stop"
   * that lands while parked unwind THIS turn at once — instead of waiting up to one full
   * multi-second tree-node summarization for the builder to reach its boundary. The wait
   * rejects with `SlotAbortedError` on abort, cleaning up so the gone chat leaves no trace.
   */
  async acquireForChat(signal?: AbortSignal): Promise<() => void> {
    if (!this.activeBuild) {
      return () => {}
    }
    // Already stopped before we even ask — don't request a pause or take a holder slot.
    if (signal?.aborted) throw new SlotAbortedError('Chat slot acquire aborted')
    this.chatHolders += 1
    // #399 D3(a): a new chat turn inside the post-chat window cancels the pending resume — this is
    // the whole point of the delay, and it is why the conversation stops handing the slot away turn
    // after turn. It costs this call NOTHING: the builder is still parked, so the fast path below
    // hands the slot over synchronously. The delay is never on chat's own acquisition.
    this.cancelPendingResume()
    // If the builder is ALREADY parked (a prior chat handed the slot off and the build is
    // waiting to resume), the slot is free RIGHT NOW — a second concurrent chat must NOT
    // wait for another handoff that will never come (the builder won't reach a new node
    // boundary while parked). Proceed immediately. Only the chat(s) that arrive BEFORE the
    // builder parks wait on the handoff (the builder wakes all of them at once when it parks).
    if (this.reacquireReject === null) {
      this.pauseRequested = true
      // waitForHandoff handles an abort that lands WHILE PARKED (removes the waiter, gives the
      // holder slot back, drops the pause if last, rejects) and throws before the lines below —
      // so on that path no holding-phase listener is installed and chatHolders is already balanced.
      await this.waitForHandoff(signal)
    }
    // We hold the slot now — via the slow path above OR the fast path (builder already parked).
    // R2 (full-audit-2026-06-30, Phase C): install the release-on-abort here so it covers BOTH
    // paths uniformly. The fast path previously installed NO abort listener (it skipped
    // waitForHandoff), so an aborted fast-path holder kept its `chatHolders` slot until
    // withChatStream's `finally` unwound — a transient stall in which the build resumed only when
    // the OTHER chat released. The listener and the returned release fn share ONE `released` latch,
    // so the slot is given back EXACTLY once (whichever of abort / explicit-release fires first;
    // the other is a no-op) and the build can't resume prematurely from a double-decrement.
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', release)
      this.releaseOneChat()
    }
    signal?.addEventListener('abort', release, { once: true })
    return release
  }

  /**
   * Park a chat caller until the builder reaches its node boundary and hands off the slot
   * (resolve), or — if `signal` aborts first — reject with `SlotAbortedError` (REL-3). On
   * abort it cleans up so the gone chat leaves NO trace: its waiter is removed from the queue
   * (not leaked), the holder slot it took is given back via `releaseOneChat`, and — when it
   * was the last waiter — the pause is dropped so the builder doesn't needlessly park for a
   * chat that's gone (which, with no chat left to release it, would hang the build).
   * Single-shot: whichever of wake/abort happens first wins; the loser is a no-op.
   */
  private waitForHandoff(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const onWake = (): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        this.handoffWaiters = this.handoffWaiters.filter((w) => w !== onWake)
        this.releaseOneChat()
        if (this.handoffWaiters.length === 0) this.pauseRequested = false
        reject(new SlotAbortedError('Chat slot acquire aborted'))
      }
      this.handoffWaiters.push(onWake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Abort a parked builder (cancel / lock / quit / model-switch): reject its `reacquire`
   * so it unwinds into its cancelled/failed handler instead of resuming into a stopped
   * runtime. No-op when the builder is not currently parked (its own abort signal then
   * stops it at the next node).
   */
  abort(err: Error = new SlotAbortedError()): void {
    const reject = this.reacquireReject
    this.reacquireResolve = null
    this.reacquireReject = null
    // A build being torn down must not be woken by an in-flight resume timer.
    this.cancelPendingResume()
    this.parkedAt = null
    if (reject) reject(err)
  }

  /**
   * The last chat holder letting go is what used to resume the builder immediately. Since #399
   * D3(a) it instead ARMS the resume for `RESUME_AFTER_CHAT_DELAY_MS`, unless this park has
   * already been deferred past `MAX_PARK_DEFERRAL_MS` — the starvation guarantee — in which case
   * the build resumes right now, exactly as it did before.
   */
  private releaseOneChat(): void {
    if (this.chatHolders > 0) this.chatHolders -= 1
    if (this.chatHolders !== 0 || !this.reacquireResolve) return
    const deferredFor = this.parkedAt === null ? 0 : this.now() - this.parkedAt
    if (deferredFor >= this.maxParkDeferralMs) {
      this.resumeParkedBuild()
      return
    }
    this.cancelPendingResume()
    this.resumeTimer = this.setTimer(() => {
      this.resumeTimer = null
      this.resumeParkedBuild()
    }, this.resumeDelayMs)
  }

  /** Wake the parked builder, if one is still parked and the slot is still free. */
  private resumeParkedBuild(): void {
    if (this.chatHolders !== 0 || !this.reacquireResolve) return
    const resolve = this.reacquireResolve
    this.reacquireResolve = null
    this.reacquireReject = null
    this.parkedAt = null
    resolve()
  }

  private cancelPendingResume(): void {
    if (this.resumeTimer === null) return
    this.clearTimer(this.resumeTimer)
    this.resumeTimer = null
  }

  private wakeHandoffWaiters(): void {
    if (this.handoffWaiters.length === 0) return
    const waiters = this.handoffWaiters
    this.handoffWaiters = []
    for (const w of waiters) w()
  }
}
