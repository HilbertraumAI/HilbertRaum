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

// Deltas update the output PER TOKEN — deliberately unbatched. The TranslateGemma sidecar
// decodes at the measured ~4 tok/s, so this is ~4 store notifications/sec — no re-render pressure
// that a flush buffer would relieve (the ChatScreen's STREAM_FLUSH_MS batching — which
// visionSession adopted too at PF-7c — exists for the far faster chat/vision decodes). Keeping it
// per-token keeps the store authoritative + synchronous, which the `adoptActiveJob` seed and the
// renderer tests read directly.
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
  // A failed cancel stays SILENT on purpose (the renderer has no write-side diagnostics sink, and
  // breaking the UI because a cancel IPC rejected would be worse than the divergence): main can then
  // keep the job in `translating` while this store shows `cancelled` with the partial output. That
  // divergence is exactly why `adoptActiveJob` gates on the store being EMPTY — otherwise the next
  // mount re-adopts the still-"running" job over the result the user stopped to keep.
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
 * "This store holds NOTHING" — the precondition for the reload adopt below, and the one rule both
 * of its checks enforce. Deliberately NOT "no active job id": `activeJobId` is null in every
 * TERMINAL state (the done/error stream handlers and `stopActive` all clear it), and `output` can
 * outlive `state === 'idle'` because `acknowledgeError` parks there while KEEPING the partial text
 * the panel still renders. Only a store that died with a renderer reload is empty by this test —
 * which is exactly the situation the adopt exists for.
 */
function isEmptySession(): boolean {
  return (
    snapshot.state === 'idle' && snapshot.output === '' && !snapshot.activeJobId && !snapshot.translating
  )
}

/**
 * Remount recovery after a full renderer RELOAD (the module store died with it): if main still has
 * a running job, re-adopt it — seed its accumulated text and re-subscribe. A no-op when this store
 * already holds anything (navigate-away kept a live job + its listeners alive, or a terminal result
 * is still on screen) or nothing is running.
 *
 * The gate is EMPTINESS, not the job id. The old id-only guard misread every TERMINAL state as
 * "nothing here" — `activeJobId` is null in `done`, `failed` and `cancelled` alike — so this mount
 * effect, which runs on EVERY entry to the Translate screen and not only after a reload, could run
 * straight over a settled translation: the held text was replaced with `job.text ?? ''` and the
 * panel flipped back to "translating". The reachable path is Stop: `stopActive` parks the store at
 * `cancelled` (id cleared) and fires `translateCancel(...)` whose rejection is deliberately
 * swallowed, so a failed cancel leaves main's job in `translating` while the user reads the partial
 * output they chose to keep — and the next mount adopted it back. The DOCUMENT-path sibling
 * `adoptActiveFileTranslation` had the same weak-guard shape (it gated on `busy`, likewise false in
 * every terminal state) and gates on emptiness for the same reason.
 *
 * No FOREIGN-job check is needed here — its absence is deliberate, not an oversight. The document
 * path needs one because a Documents-row "Translate" can start a doc-task this panel would hijack;
 * the Translate screen is the ONLY place a TEXT job is ever started, so a running job main reports
 * can only ever be this store's own.
 *
 * The emptiness rule alone is NOT enough across the `getActiveTranslateJob` await, so a generation
 * token is captured at entry and re-checked after it — see the note at that re-check below.
 */
export async function adoptActiveJob(): Promise<void> {
  if (!isEmptySession()) return // a live or terminal session is already on screen
  // Take the generation BEFORE the await, not after it: emptiness answers "is anything on screen
  // right now?", and a workspace LOCK answers that with "no" for the wrong reason. The lock purge
  // (`clearTranslateSession`) resets this store to EMPTY, so a store that a lock legitimately
  // invalidated mid-read is indistinguishable — by emptiness — from the post-reload store this
  // adopt exists for. The generation tells them apart: every action that invalidates an in-flight
  // adopt (the lock purge, Stop, a fresh translate) bumps it.
  const myGen = startGen
  let job
  try {
    job = await window.api?.getActiveTranslateJob?.()
  } catch {
    return
  }
  // Re-check the token FIRST, before any other post-await work: if it moved, this read's result
  // belongs to a session that no longer exists. Bailing here is what keeps a job's accumulated
  // plaintext — and a live stream subscription for it — out of renderer memory after main aborted
  // the job and re-encrypted the vault.
  if (myGen !== startGen) return
  if (!job || (job.state !== 'queued' && job.state !== 'translating')) return
  // The SAME emptiness rule on the re-check, not just on entry: the two must enforce one invariant,
  // or the no-op is true at function entry and no longer true at the moment of the destructive `set`
  // below. Reachable: `translate()` flips the store to `translating` SYNCHRONOUSLY, before its own
  // round-trip resolves and sets `activeJobId`, so an id-only re-check sailed past a translation the
  // user had just started — seeding the older job's text over it AND bumping `startGen`, which made
  // that in-flight start treat itself as superseded and cancel the user's brand-new job as an
  // orphan. A `stopActive()` in the same window (terminal `cancelled`, id null) slipped through
  // identically.
  //
  // Kept ALONGSIDE the generation re-check above, not replaced by it: the two answer different
  // questions and neither subsumes the other. The token catches an invalidation that leaves the
  // store empty (the lock purge); this catches a store that holds something at the moment of the
  // destructive `set` without depending on whoever put it there having bumped the generation.
  if (!isEmptySession()) return // a session started (or settled) while we awaited
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
