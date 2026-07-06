import type {
  TranslateErrorCode,
  TranslateRequest,
  TranslationSourceLang,
  TranslationTargetLang
} from '@shared/types'
import { getActiveDocTask, isDocTaskTerminal } from './doctasks'
import { getFileTranslate } from './fileTranslateSession'

// Renderer-side store for the SINGLE active view translation (TG-4, plan §2 D6 — the
// `visionSession.ts` / `doctasks.ts` precedent). Module-level — NOT inside the Translate screen —
// so a running translation (its streamed output) SURVIVES a screen unmount: the user can start a
// translation, navigate elsewhere, and come back to find it still streaming with the partial
// output intact. The screen subscribes via `useSyncExternalStore(subscribeTranslateSession,
// getTranslateSession)` and renders whatever the store holds.
//
// Recovery is two-layer: (1) navigate-away keeps THIS store + its stream listeners alive, so no
// token is missed (lossless, like vision); (2) a full renderer RELOAD drops the module store, so
// the screen calls `adoptActiveJob()` on mount to re-adopt a still-running job from main
// (`getActiveTranslateJob` — the chat `getActiveStream` precedent), seeding its accumulated text
// and re-subscribing. A tiny seed↔subscribe gap self-heals because `trDone` carries the full text.
//
// Privacy: the source text and its translation live in renderer memory only (nothing persisted).
// On workspace LOCK `App.lockNow` calls `clearTranslateSession()` (via `lib/lockPurge`'s
// `purgeSessionStores`) so this resident content is dropped in lockstep with main aborting the job
// + purging its map + re-encrypting the vault. It is NOT a screen effect: lock unmounts the screen
// before any effect could observe it (TA-2 / H3 — the old screen-gated purge was dead code).

/**
 * Result of a `translate()` call: `started` once a job is created (the output streams into it, or
 * a code surfaces as an error), `busy` when one is already in flight (the caller may surface it),
 * `noop` when there is nothing to translate (empty text — no feedback owed).
 */
export type TranslateOutcome = 'started' | 'busy' | 'noop'

/** The store snapshot the Translate screen renders. A fresh object per change, stable between. */
export interface TranslateSessionSnapshot {
  /** The in-flight job, or null when idle/terminal. */
  activeJobId: string | null
  /** The translation so far (streams in live; the complete text on done). */
  output: string
  /** Lifecycle for the output panel. `idle` = nothing run yet this session. */
  state: 'idle' | 'translating' | 'done' | 'failed' | 'cancelled'
  /** A CODE the screen maps to friendly copy (never raw model/runtime text). */
  error: TranslateErrorCode | null
  /** True from send until the job settles (drives the busy composer + Stop). */
  translating: boolean
}

const EMPTY: TranslateSessionSnapshot = {
  activeJobId: null,
  output: '',
  state: 'idle',
  error: null,
  translating: false
}

let snapshot: TranslateSessionSnapshot = EMPTY
/** Live stream unsubscribers for the active job; emptied on teardown. */
let unsubs: Array<(() => void) | undefined> = []
/**
 * Generation guard (the visionSession F8 pattern): a session-replacing action (a new translate, a
 * clear/lock) bumps this, so a slower `translateStart` round-trip that resolves after the user
 * moved on detects it is superseded and bails (cancelling its orphan job) instead of wiring a
 * zombie stream a stale done/error would tear down over the newer job.
 */
let startGen = 0
const listeners = new Set<() => void>()

/** Session-local last language choice (the DocumentsScreen `lastTranslateChoice` precedent):
 *  module-level so it persists across screen mounts within the session (never persisted to disk). */
let lastChoice: { sourceLang: TranslationSourceLang; targetLang: TranslationTargetLang } | null = null

export function getLastTranslateChoice(): {
  sourceLang: TranslationSourceLang
  targetLang: TranslationTargetLang
} | null {
  return lastChoice
}
export function setLastTranslateChoice(sourceLang: TranslationSourceLang, targetLang: TranslationTargetLang): void {
  lastChoice = { sourceLang, targetLang }
}

function notify(): void {
  for (const fn of listeners) fn()
}

function set(next: Partial<TranslateSessionSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  notify()
}

/** Drop the live stream listeners (does NOT touch the job main-side). */
function teardownStream(): void {
  for (const u of unsubs) u?.()
  unsubs = []
}

export function subscribeTranslateSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — stable identity between changes. */
export function getTranslateSession(): TranslateSessionSnapshot {
  return snapshot
}

// Deltas update the output PER TOKEN (the visionSession precedent). The TranslateGemma sidecar
// decodes at the measured ~4 tok/s, so this is ~4 store notifications/sec — no re-render pressure
// that a flush buffer would relieve (the ChatScreen's STREAM_FLUSH_MS batching exists for the far
// faster chat decode). Keeping it per-token keeps the store authoritative + synchronous, which the
// `adoptActiveJob` seed and the renderer tests read directly.
/** Wire the three per-job stream channels for `jobId` into the store. */
function wireStream(jobId: string): void {
  teardownStream()
  unsubs = []
  unsubs.push(
    window.api?.onTranslateToken?.(jobId, (delta: string) => {
      if (jobId !== snapshot.activeJobId) return // stale/late event for a superseded job
      set({ output: snapshot.output + delta, state: 'translating' })
    })
  )
  unsubs.push(
    window.api?.onTranslateDone?.(jobId, (job) => {
      if (jobId !== snapshot.activeJobId) return
      teardownStream()
      // The done event carries the COMPLETE text — replace the accumulated stream with it so any
      // mid-stream dropped token (adopt seed gap) self-heals.
      set({ output: job.text ?? snapshot.output, state: 'done', error: null, activeJobId: null, translating: false })
    })
  )
  unsubs.push(
    window.api?.onTranslateError?.(jobId, (job) => {
      if (jobId !== snapshot.activeJobId) return
      teardownStream()
      const code = job.error ?? 'runtimeFailed'
      set({
        state: code === 'cancelled' ? 'cancelled' : 'failed',
        error: code,
        activeJobId: null,
        translating: false
      })
    })
  )
}

/**
 * Start one translation, streaming the output into the panel. A second translate while one runs is
 * busy-rejected by the backend and guarded here. The stream listeners stay alive until the job
 * settles even if the screen unmounts (navigate-away), so the output keeps accumulating.
 */
export async function translate(req: TranslateRequest): Promise<TranslateOutcome> {
  if (req.text.trim() === '') return 'noop'
  // Cross-session start guard (TA-3 / L6a — parity with fileTranslateSession's `guardStart`): refuse
  // while THIS store is mid-flight (`activeJobId` set OR `translating` during the start round-trip,
  // before `activeJobId` lands), while a file document translation is busy, or while a foreign doc
  // task actually holds the one-at-a-time lane. The old guard checked only `activeJobId`, so a second
  // click during the start round-trip (translating, no id yet) or while the file path ran slipped
  // through and started a second job. The screen's `busy` prop disables the trigger; this defends the
  // invariant at the store level too.
  if (snapshot.activeJobId || snapshot.translating) return 'busy'
  if (getFileTranslate().busy) return 'busy'
  const foreign = getActiveDocTask()
  if (foreign && !isDocTaskTerminal(foreign.status)) return 'busy'

  const myGen = ++startGen
  // Fresh output panel for this run; remember the language choice for the next session mount.
  setLastTranslateChoice(req.sourceLang, req.targetLang)
  set({ output: '', state: 'translating', error: null, translating: true })

  let job
  try {
    job = await window.api.translateStart(req)
  } catch {
    if (myGen === startGen) set({ state: 'failed', error: 'runtimeFailed', translating: false })
    return 'started'
  }

  // Superseded while the create round-trip was in flight (a new translate / clear / lock / Stop) —
  // bail and cancel this now-orphan job so a stale done/error can't tear down over the newer one (and
  // so a Stop during the start round-trip, which bumps startGen, actually cancels the job — L5).
  if (myGen !== startGen) {
    if (job?.jobId) void window.api?.translateCancel?.(job.jobId)?.catch?.(() => {})
    return 'started'
  }

  // Handle the resolve DEFENSIVELY (TA-3 / L6b): `job.error` was dereferenced outside any try, so a
  // malformed/undefined bridge resolve threw OUT of `translate()` — and TranslateScreen's `.then`
  // chain has no `.catch`, so the store wedged stuck `translating` with a dead Stop. Guard `job` and
  // treat any bad shape as a runtime failure; every path here resets `translating`.
  try {
    if (!job || job.error || job.state === 'failed' || job.state === 'cancelled') {
      set({ state: 'failed', error: job?.error ?? 'runtimeFailed', translating: false })
      return 'started'
    }
    set({ activeJobId: job.jobId, output: job.text ?? '' })
    wireStream(job.jobId)
    return 'started'
  } catch {
    set({ state: 'failed', error: 'runtimeFailed', translating: false })
    return 'started'
  }
}

/**
 * Acknowledge (dismiss) a terminal FAILED error so it doesn't reappear when the screen remounts.
 * The failed state lives in this persistent store, so a component-local "dismissed" flag would
 * reset on remount and the banner would come back; clearing the store state to idle fixes that.
 * Keeps any partial output. No-op unless currently failed.
 */
export function acknowledgeError(): void {
  if (snapshot.state !== 'failed') return
  set({ state: 'idle', error: null })
}

/** Stop the in-flight translation (the Stop button): cancel main-side, keep the partial output. */
export function stopActive(): void {
  if (!snapshot.activeJobId) {
    // Stop is shown as soon as `translating` is true — BEFORE `translateStart` resolves and sets
    // `activeJobId` (TA-3 / L5). In that window there is no job to cancel yet, but the in-flight
    // start must be SUPERSEDED so its post-await branch cancels the just-started job (the same
    // supersede-cancel `clear`/`cancel` already use). Otherwise Stop is silently swallowed here and
    // the job runs on to completion.
    if (snapshot.translating) {
      startGen += 1
      set({ state: 'cancelled', translating: false })
    }
    return
  }
  void window.api?.translateCancel?.(snapshot.activeJobId)?.catch?.(() => {})
  startGen += 1 // invalidate any translate still inside its start round-trip
  teardownStream()
  set({ state: 'cancelled', activeJobId: null, translating: false })
}

/**
 * Drop ALL resident state WITHOUT an IPC cancel — for workspace LOCK, where main has already
 * aborted the job and re-encrypted the vault, so the source/translation content must not linger.
 */
export function clearTranslateSession(): void {
  startGen += 1 // invalidate any in-flight translate so a post-lock resolve can't wire content
  teardownStream()
  snapshot = { ...EMPTY }
  notify()
}

/**
 * Remount recovery after a full renderer RELOAD (the module store died with it): if main still has
 * a running job, re-adopt it — seed its accumulated text and re-subscribe. A no-op when this store
 * already holds a job (navigate-away kept it + its listeners alive) or nothing is running.
 */
export async function adoptActiveJob(): Promise<void> {
  if (snapshot.activeJobId) return
  let job
  try {
    job = await window.api?.getActiveTranslateJob?.()
  } catch {
    return
  }
  if (!job || (job.state !== 'queued' && job.state !== 'translating')) return
  if (snapshot.activeJobId) return // a translate started while we awaited
  startGen += 1
  set({ activeJobId: job.jobId, output: job.text ?? '', state: 'translating', error: null, translating: true })
  // Residual (accepted): a trDone/trError emitted in the ~1ms window between the getActiveTranslateJob
  // read above and this subscribe would be missed, leaving the store 'translating'. At the sidecar's
  // ~4 tok/s decode this window essentially never coincides with completion; and it is NOT a dead end —
  // the Stop button (stopActive) is shown while 'translating', so the user can always reset.
  wireStream(job.jobId)
}

/** Test-only: drop module-level state between renderer tests. */
export function resetTranslateSessionForTests(): void {
  teardownStream()
  snapshot = EMPTY
  startGen = 0
  lastChoice = null
  listeners.clear()
}
