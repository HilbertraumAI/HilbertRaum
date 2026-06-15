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
//     resumes the parked builder (when the last concurrent chat is done).
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

  /** True while a yielding build owns the slot — chat branches on this to pause vs refuse. */
  isBuildActive(): boolean {
    return this.activeBuild !== null
  }

  /** The builder declares itself the slot owner when its run starts. */
  registerBuild(jobId: string): void {
    this.activeBuild = jobId
    this.pauseRequested = false
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
    this.wakeHandoffWaiters()
  }

  /** The builder's synchronous check at each node boundary. */
  shouldYield(): boolean {
    return this.pauseRequested
  }

  /**
   * The builder parks here when `shouldYield()` is true: it hands the slot to the waiting
   * chat (resolving the handoff) and returns a Promise that resolves when chat releases
   * the slot, or rejects with `SlotAbortedError` on cancel/lock/quit/model-switch.
   */
  reacquire(jobId: string): Promise<void> {
    if (this.activeBuild !== jobId) {
      // Defensive: a stale jobId should not park forever.
      return Promise.resolve()
    }
    this.pauseRequested = false
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
   */
  async acquireForChat(): Promise<() => void> {
    if (!this.activeBuild) {
      return () => {}
    }
    this.chatHolders += 1
    this.pauseRequested = true
    await new Promise<void>((resolve) => {
      this.handoffWaiters.push(resolve)
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseOneChat()
    }
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
    if (reject) reject(err)
  }

  private releaseOneChat(): void {
    if (this.chatHolders > 0) this.chatHolders -= 1
    if (this.chatHolders === 0 && this.reacquireResolve) {
      const resolve = this.reacquireResolve
      this.reacquireResolve = null
      this.reacquireReject = null
      resolve()
    }
  }

  private wakeHandoffWaiters(): void {
    if (this.handoffWaiters.length === 0) return
    const waiters = this.handoffWaiters
    this.handoffWaiters = []
    for (const w of waiters) w()
  }
}
