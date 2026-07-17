import type { DecodedImage, ImageTurn } from '../images'

// Renderer-side store for the SINGLE active image analysis (the `doctasks.ts` / `skillruns.ts`
// precedent). Module-level — NOT inside the Images screen — so a running analysis (the loaded
// image, the Q&A thread, and the live streaming answer) survives a screen unmount: the user can
// start an analysis, navigate to another screen, and come back to find it still running with its
// partial answer intact. The screen subscribes via `useSyncExternalStore(subscribeVisionSession,
// getVisionSession)` and renders whatever the store holds.
//
// Why a store and not main-side recovery (the Chat `getActiveStream` route): vision keeps the
// decoded image bytes only in renderer memory (persisted to history just-in-time on the first
// completed answer — privacy §12), so the image itself must live somewhere that outlives the
// component. Keeping the stream listeners alive here too makes recovery LOSSLESS — no token is
// missed while the screen is gone, so no main-side snapshot/poll is needed.
//
// Privacy: the image/prompt/answer live in renderer memory only. On workspace LOCK `App.lockNow`
// calls `clearVisionSession()` (via `lib/lockPurge`'s `purgeSessionStores`) so this resident
// content is dropped in lockstep with main purging the vision job map and re-encrypting the vault.
// It is NOT a screen effect: lock unmounts the screen before any effect could observe it (TA-2/H3).

/**
 * Result of an `analyze()` call: `started` once a turn is created (the answer streams into it, or
 * the turn shows its own failure), `busy` when one is already in flight (the caller surfaces
 * `images.err.busy`), `noop` when there is no image or an empty question (no feedback owed). F4.
 */
export type AnalyzeOutcome = 'started' | 'busy' | 'noop'

/** The loaded image plus its display metadata (held across navigation by this store). */
export interface SelectedImage {
  decoded: DecodedImage
  name: string
  sizeBytes: number
}

/** The store snapshot the Images screen renders. A fresh object per change, stable between. */
export interface VisionSessionSnapshot {
  /** The loaded image, or null on the landing view. */
  selected: SelectedImage | null
  /** The Q&A thread (the in-flight turn streams its `answer` live). */
  turns: ImageTurn[]
  /** The history session this loaded image persists into (null ⇒ a fresh image). */
  sessionId: string | null
  /** The in-flight analyze job, or null when idle. */
  activeJobId: string | null
  /** True from send until the turn settles (drives the locked composer + Stop). */
  analyzing: boolean
}

const EMPTY: VisionSessionSnapshot = {
  selected: null,
  turns: [],
  sessionId: null,
  activeJobId: null,
  analyzing: false
}

let snapshot: VisionSessionSnapshot = EMPTY
/** The turn the live stream patches (token/done/error). Not part of the rendered snapshot. */
let activeTurnId: string | null = null
/** Live stream unsubscribers for the active job; emptied on teardown. */
let unsubs: Array<(() => void) | undefined> = []
let turnCounter = 0
// F8: the busy guard rejects a second analyze only once `activeJobId` is set — but that isn't set
// until AFTER the `imageAnalyze` create round-trip resolves. In the window before it, a session
// change (a new image, Remove, a lock) followed by a fresh analyze can leave two analyzes both
// awaiting `imageAnalyze`; the slower one would then wire a ZOMBIE stream that its own late
// done/error tears down over the newer job. Each analyze captures this generation; a session change
// bumps it, so a superseded call detects it after the await and bails (cancelling its orphan job)
// instead of wiring. The per-handler `job.jobId === snapshot.activeJobId` checks are belt-and-braces.
let analyzeGen = 0
const listeners = new Set<() => void>()
/** Fired when a turn completes + persists, so a mounted screen can refresh its history list. */
const persistListeners = new Set<() => void>()

// PF-7c (full-audit 2026-07-10, closes carried-forward PERF-5): token deltas are BATCHED through
// a small flush buffer (the ChatScreen STREAM_FLUSH_MS precedent) instead of notifying per token.
// Each per-token notify re-mapped the whole `turns` array and re-rendered the Images screen; a
// vision decode is fast enough for that to be real churn. translateSession documents when
// per-token IS justified (~4 tok/s decode); vision has no such justification. The buffer is
// applied by `flushPending` — settle paths (done/error/stop) flush FIRST so no token is lost;
// teardown paths that discard the turn anyway (new image / Remove / lock purge) drop it unsent.
const STREAM_FLUSH_MS = 40
let pendingAnswer = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Apply the buffered token chunk to the active turn — ONE notify per flush window. */
function flushPending(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingAnswer === '' || activeTurnId == null) {
    pendingAnswer = ''
    return
  }
  const chunk = pendingAnswer
  pendingAnswer = ''
  patchTurn(activeTurnId, (tn) => ({ answer: tn.answer + chunk, state: 'analyzing' }))
}

function scheduleFlush(): void {
  if (flushTimer == null) flushTimer = setTimeout(flushPending, STREAM_FLUSH_MS)
}

function notify(): void {
  for (const fn of listeners) fn()
}

function set(next: Partial<VisionSessionSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  notify()
}

function patchTurn(
  id: string,
  patch: Partial<ImageTurn> | ((t: ImageTurn) => Partial<ImageTurn>)
): void {
  set({
    turns: snapshot.turns.map((t) =>
      t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t
    )
  })
}

function nextTurnId(): string {
  turnCounter += 1
  return `img-turn-${turnCounter}`
}

/** Drop the live stream listeners (does NOT touch the job main-side). */
function teardownStream(): void {
  // PF-7c: drop any un-flushed token chunk with the stream — settle paths that keep the
  // partial answer (done/error/stop) call `flushPending()` BEFORE tearing down; every other
  // caller is discarding the turn (or purging on lock), where flushing would be wrong.
  if (flushTimer != null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingAnswer = ''
  for (const u of unsubs) u?.()
  unsubs = []
  activeTurnId = null
}

/** Abort the in-flight job main-side and drop our listeners. */
function abortActive(): void {
  if (snapshot.activeJobId) {
    void window.api?.imageCancel?.(snapshot.activeJobId)?.catch?.(() => {})
  }
  // F8: a session-replacing action invalidates any analyze still inside its `imageAnalyze` await,
  // so the orphan can't wire after the snapshot reset below.
  analyzeGen += 1
  teardownStream()
}

export function subscribeVisionSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — stable identity between changes. */
export function getVisionSession(): VisionSessionSnapshot {
  return snapshot
}

/** Subscribe to "a turn was persisted" so a mounted screen can refresh its history list. */
export function subscribeVisionPersisted(fn: () => void): () => void {
  persistListeners.add(fn)
  return () => persistListeners.delete(fn)
}

/**
 * Load a freshly decoded image. Cancels any in-flight job and resets the thread (§5.6) — a new
 * image starts a NEW history session on its first analyze.
 */
export function selectImage(sel: SelectedImage): void {
  abortActive()
  snapshot = { selected: sel, turns: [], sessionId: null, activeJobId: null, analyzing: false }
  notify()
}

/** Open a saved history entry: its image + replayed turns, bound to its session id. */
export function loadSession(sel: SelectedImage, turns: ImageTurn[], sessionId: string): void {
  abortActive()
  snapshot = { selected: sel, turns, sessionId, activeJobId: null, analyzing: false }
  notify()
}

/** Clear back to the landing view (Remove, or a deleted open entry). Cancels any in-flight job. */
export function removeImage(): void {
  abortActive()
  snapshot = { ...EMPTY }
  notify()
}

/**
 * Drop ALL resident state WITHOUT an IPC cancel — for workspace LOCK, where main has already
 * aborted the job and re-encrypted the vault, so the image/answer content must not linger here.
 */
export function clearVisionSession(): void {
  analyzeGen += 1 // F8: invalidate any in-flight analyze so a post-lock resolve can't wire content.
  teardownStream()
  snapshot = { ...EMPTY }
  notify()
}

/** Stop the in-flight analyze (the answer's Stop button): cancel main-side, mark the turn stopped. */
export function stopActive(): void {
  const turnId = activeTurnId
  if (!snapshot.activeJobId) return
  flushPending() // PF-7c: tokens already received land in the stopped turn (pre-batching behavior)
  abortActive()
  if (turnId) patchTurn(turnId, { state: 'cancelled' })
  set({ activeJobId: null, analyzing: false })
}

/**
 * Run one analyze, streaming the answer into a fresh turn. A second analyze while one runs is
 * busy-rejected by the backend (IPC-3) and never enqueued; we also guard here. The stream
 * listeners stay alive until the turn settles even if the screen unmounts (navigate-away), so
 * the answer keeps accumulating in the store and is intact on remount.
 */
export async function analyze(question: string): Promise<AnalyzeOutcome> {
  const sel = snapshot.selected
  const q = question.trim()
  // No image / empty question → nothing to do, no feedback owed. A second analyze while one is
  // in flight is BUSY — report it so the caller can surface `images.err.busy` instead of letting
  // the click vanish silently (F4). `analyzing` flips true the moment a turn is created (before
  // `activeJobId` is set on the imageAnalyze round-trip), so the UI disables the trigger across the
  // whole window; this guard is the belt-and-suspenders for a click that still reaches here.
  if (!sel || !q) return 'noop'
  // F-26 (L6a, parity with translateSession.ts:163): the old guard checked only `activeJobId`, which
  // isn't set until AFTER the imageAnalyze create round-trip resolves. A second analyze entering that
  // window slipped through; main busy-rejected it, and its busy branch's `set({ analyzing:false })`
  // clobbered the still-live first job's flag. Also gate on `analyzing` (flipped true at :240 before
  // the awaited round-trip) so a second click during the start round-trip is refused at the store.
  if (snapshot.activeJobId || snapshot.analyzing) return 'busy'

  const turnId = nextTurnId()
  // F8: claim this generation. A session change (abortActive / clearVisionSession) bumps it, so a
  // slower create round-trip that resolves after the user moved on is detected as superseded below.
  const myGen = ++analyzeGen
  set({
    turns: [...snapshot.turns, { id: turnId, question: q, answer: '', state: 'starting' }],
    analyzing: true
  })

  let job
  try {
    job = await window.api.imageAnalyze({
      imageBytes: sel.decoded.bytes,
      mimeType: sel.decoded.mimeType,
      question: q,
      name: sel.name,
      width: sel.decoded.width,
      height: sel.decoded.height,
      sessionId: snapshot.sessionId
    })
  } catch {
    // Only touch the turn/flag if we still own the session — a superseding call already reset it.
    if (myGen === analyzeGen) {
      patchTurn(turnId, { state: 'failed', error: 'runtimeFailed' })
      set({ analyzing: false })
    }
    return 'started'
  }

  // F8: superseded while the create round-trip was in flight (new image / Remove / lock, then this
  // resolved). The snapshot was reset, so its turn is gone and `analyzing` belongs to the newer
  // call — do NOT wire a zombie stream a stale done/error could tear down over the new job. Cancel
  // this now-orphan job main-side and bail.
  if (myGen !== analyzeGen) {
    if (job?.jobId) void window.api?.imageCancel?.(job.jobId)?.catch?.(() => {})
    return 'started'
  }

  if (job.error === 'busy' || job.state === 'failed' || job.state === 'cancelled') {
    patchTurn(turnId, { state: 'failed', error: job.error ?? 'runtimeFailed' })
    set({ analyzing: false })
    return 'started'
  }

  // Main creates the history session on first analyze and returns its id; reuse it for follow-ups.
  activeTurnId = turnId
  set({ activeJobId: job.jobId, sessionId: job.sessionId ?? snapshot.sessionId })

  const jobId = job.jobId
  unsubs = []
  unsubs.push(
    window.api?.onImageToken?.(jobId, (token: string) => {
      if (jobId !== snapshot.activeJobId) return // stale/late event for a superseded job (F8)
      // PF-7c: buffer + flush on a timer — one snapshot rebuild + notify per window, not per token.
      pendingAnswer += token
      scheduleFlush()
    })
  )
  unsubs.push(
    window.api?.onImageDone?.(jobId, (doneJob) => {
      if (jobId !== snapshot.activeJobId) return // F8 belt-and-braces (gen guard already prevents wiring)
      flushPending() // PF-7c: the `tn.answer` fallback below must see the complete streamed text
      let saved = false
      patchTurn(turnId, (tn) => {
        const answer = doneJob.answer ?? tn.answer
        if (answer.trim()) {
          saved = true
          return { answer, state: 'done', error: null }
        }
        return { state: 'failed', error: 'emptyResponse' }
      })
      teardownStream()
      set({ activeJobId: null, analyzing: false, sessionId: doneJob.sessionId ?? snapshot.sessionId })
      // A completed turn was persisted in main — let a mounted screen refresh its history list.
      if (saved) for (const fn of persistListeners) fn()
    })
  )
  unsubs.push(
    window.api?.onImageError?.(jobId, (errJob) => {
      if (jobId !== snapshot.activeJobId) return // F8 belt-and-braces (gen guard already prevents wiring)
      flushPending() // PF-7c: the partial answer stays on the failed/cancelled turn (pre-batching behavior)
      const code = errJob.error ?? 'runtimeFailed'
      patchTurn(turnId, code === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', error: code })
      teardownStream()
      set({ activeJobId: null, analyzing: false })
    })
  )
  return 'started'
}

/** Test-only: drop module-level state between renderer tests. */
export function resetVisionSessionForTests(): void {
  teardownStream()
  snapshot = EMPTY
  turnCounter = 0
  analyzeGen = 0
  listeners.clear()
  persistListeners.clear()
}
