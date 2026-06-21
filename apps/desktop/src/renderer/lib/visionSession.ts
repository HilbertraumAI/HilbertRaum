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
// Privacy: the image/prompt/answer live in renderer memory only. On workspace LOCK the screen
// calls `clearVisionSession()` so this resident content is dropped in lockstep with main purging
// the vision job map and re-encrypting the vault.

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
const listeners = new Set<() => void>()
/** Fired when a turn completes + persists, so a mounted screen can refresh its history list. */
const persistListeners = new Set<() => void>()

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
  for (const u of unsubs) u?.()
  unsubs = []
  activeTurnId = null
}

/** Abort the in-flight job main-side and drop our listeners. */
function abortActive(): void {
  if (snapshot.activeJobId) {
    void window.api?.imageCancel?.(snapshot.activeJobId)?.catch?.(() => {})
  }
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
  teardownStream()
  snapshot = { ...EMPTY }
  notify()
}

/** Stop the in-flight analyze (the answer's Stop button): cancel main-side, mark the turn stopped. */
export function stopActive(): void {
  const turnId = activeTurnId
  if (!snapshot.activeJobId) return
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
export async function analyze(question: string): Promise<void> {
  const sel = snapshot.selected
  const q = question.trim()
  if (!sel || !q || snapshot.activeJobId) return

  const turnId = nextTurnId()
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
    patchTurn(turnId, { state: 'failed', error: 'runtimeFailed' })
    set({ analyzing: false })
    return
  }

  if (job.error === 'busy' || job.state === 'failed' || job.state === 'cancelled') {
    patchTurn(turnId, { state: 'failed', error: job.error ?? 'runtimeFailed' })
    set({ analyzing: false })
    return
  }

  // Main creates the history session on first analyze and returns its id; reuse it for follow-ups.
  activeTurnId = turnId
  set({ activeJobId: job.jobId, sessionId: job.sessionId ?? snapshot.sessionId })

  unsubs = []
  unsubs.push(
    window.api?.onImageToken?.(job.jobId, (token: string) => {
      patchTurn(turnId, (tn) => ({ answer: tn.answer + token, state: 'analyzing' }))
    })
  )
  unsubs.push(
    window.api?.onImageDone?.(job.jobId, (doneJob) => {
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
    window.api?.onImageError?.(job.jobId, (errJob) => {
      const code = errJob.error ?? 'runtimeFailed'
      patchTurn(turnId, code === 'cancelled' ? { state: 'cancelled' } : { state: 'failed', error: code })
      teardownStream()
      set({ activeJobId: null, analyzing: false })
    })
  )
}

/** Test-only: drop module-level state between renderer tests. */
export function resetVisionSessionForTests(): void {
  teardownStream()
  snapshot = EMPTY
  turnCounter = 0
  listeners.clear()
  persistListeners.clear()
}
