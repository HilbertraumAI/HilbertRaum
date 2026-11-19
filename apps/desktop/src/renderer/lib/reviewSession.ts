import type {
  EvidencePackExportRequest,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewBulkAction,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  ReviewDecision
} from '@shared/types'
import { deriveReadyGate } from '@shared/evidence-review'
import { registerBeforeClose } from './beforeClose'
import { friendlyIpcError } from './errors'

// Evidence-review session store (EP-1 plan §7.5) — the doctasks idiom (module store +
// `useSyncExternalStore` + snapshot-stability) EXTENDED with the repo's first debounced
// auto-save. Module-level so a review keeps its pending edits while the summary modal or
// the narrow-window evidence drawer re-renders the screen, and so the LOCK seam
// (`App.lockNow` → flush, then `purgeSessionStores()` → purge) can reach it without any
// screen mounted.
//
// Save model (spec §26 "Auto-save should debounce note edits and batch related writes"):
//  - Edits apply OPTIMISTICALLY to the in-memory detail (the UI reads its own writes) and
//    accumulate as per-item / head PATCHES (`EvidenceReviewItemPatch` / `EvidenceReviewPatch`).
//  - A debounce timer flushes the accumulated patches over the Phase-1 IPC surface.
//  - The flush is LOSS-FREE under rapid edits: it drains the pending maps into a local
//    snapshot BEFORE awaiting, so edits landing mid-flight repopulate the maps and are
//    flushed by the follow-up pass; a FAILED write re-merges its patch UNDER any newer
//    pending fields (newest edit wins) so nothing is dropped and nothing old overwrites new.
//  - `flushReviewSession()` is the one-pass flush (debounce timer, screen exit). Whatever must
//    run only once EVERYTHING is saved drains instead (`drainReviewSaves`: passes until nothing
//    is queued or a write fails, #889): mark ready, export, reopen, a review switch, Try again,
//    the pre-lock seam and the save before the window closes (#888, the same bounded call).
//
// Null-result contract (plan §14 P1 handoff): every mutation returns null/false for unknown
// ids and refused inputs — treated here as a stale-handle refusal (`saveState: 'error'`),
// never an exception and never a silent retry loop.
//
// Race hardening (Phase-2 review FIX-2): EVERY post-await state/pending mutation is guarded
// by `openToken`, captured at entry — `purgeReviewSession` (the lock seam) and
// `openReviewSession` (a review switch) bump the token, so a resolution landing AFTER a
// purge can never re-insert decrypted snapshot/note content into the store, and one landing
// after a switch can never corrupt the next review's detail. Item-level edits additionally
// refuse while the review is `ready` (FIX-1 — main refuses them too; the store guard keeps
// the UI from ever showing an optimistic value main would reject).
//
// A failed save is never run over (#837): a failed write leaves its patch queued and the
// save-error line showing, and every action that runs after its save checks for that. Mark
// ready, export and reopen refuse; a sweep refuses; a switch to ANOTHER review is refused
// with a choice (`openError.kind === 'unsaved'`: Try again / Discard changes and open / Back)
// and re-opening the SAME review keeps the edit on screen. Only the lock still drops a failed
// patch without asking (`App.lockNow` — the user's security action wins; known-limitations);
// closing the window asks first (#888: Try again / Keep open / Close anyway, main's dialog).
//
// ONE write lane (#837, widened by #889/#901): at most one of {an item/head flush, a lane
// holder} writes at a time. Lane holders: a bulk sweep (its call through its merge), a selection
// delete (its call), a link or unlink (until its call is sent: every write to an existing item —
// an edit save, a delete, a link or unlink — takes the lane, so a link waits for a delete of its
// row and is dropped with the row), mark ready and reopen (their drain through their call and
// merge), Try again (its drain and re-read), and every drain while it saves. Adding a selection
// does not take the lane: it creates a row, and nothing queued can target it. A holder takes
// the lane through `acquireLane`, at once when it is free, so its first IPC still goes out in
// the caller's own task.
// Main's answer to a lane holder is merged with nothing written meanwhile, so the merge keeps
// exactly the fields still queued (they are written after it).

export type ReviewHandoffTarget = { reviewId: string } | { messageId: string }

export type ReviewSaveState = 'idle' | 'pending' | 'saved' | 'error'

export interface ReviewSessionState {
  /** The open review read-model with local optimistic edits applied; null = none open. */
  detail: EvidenceReviewDetail | null
  loading: boolean
  /**
   * Open failure: 'notFound' = a reviewId handoff resolved null (deleted/stale);
   * 'failed' = the friendly (main-localized) message text; 'unsaved' (#837) = the switch to
   * `target` was REFUSED because the review still in `detail` (titled `title`) has edits a
   * failed write left queued — `detail` and those edits are kept untouched, and the screen
   * offers `retryBlockedSwitch` / `discardAndSwitch` / Back.
   */
  openError:
    | { kind: 'notFound' }
    | { kind: 'failed'; message: string }
    | { kind: 'unsaved'; title: string; target: ReviewHandoffTarget }
    | null
  saveState: ReviewSaveState
  /** Friendly copy for a failed flush (shown beside the retry action); null otherwise. */
  saveError: string | null
  /**
   * P4 (spec §21.2): the freshness verdict for the OPEN review, refreshed automatically on
   * every successful open (fire-and-forget — the workspace never waits on it) and after an
   * acknowledge. Null while none has landed (or a refresh failed — the honest "not known
   * to be outdated" absence; a failed check must never invent a warning OR a verification).
   * The freshness UI (banner, badges, export gate, chips) renders from THIS object only —
   * `detail.outdated` is not consumed (write-path returns carry a constant-false overlay).
   */
  freshness: EvidenceReviewFreshness | null
  /**
   * #837 (review round 4): a bulk sweep is running, from the click until its merge is done. A
   * second sweep meanwhile is ignored, and the screen disables Bulk actions — two overlapping
   * sweeps would merge over each other's optimistic values.
   */
  bulkRunning: boolean
  /**
   * #889 (G-4): Mark ready's call is with main — from the end of its save until main answers.
   * Item-level editing (decisions, notes, links, selections) is refused meanwhile and the screen
   * renders it read-only: main decides from the rows saved now, and an item write sent during
   * the call would reach a review that is ready by then and be refused.
   */
  finishing: boolean
}

const INITIAL: ReviewSessionState = {
  detail: null,
  loading: false,
  openError: null,
  saveState: 'idle',
  saveError: null,
  freshness: null,
  bulkRunning: false,
  finishing: false
}

/** Debounce between an edit and its IPC flush (spec §26 — batch related writes). */
export const REVIEW_SAVE_DEBOUNCE_MS = 600

let state: ReviewSessionState = INITIAL
const listeners = new Set<() => void>()
let pendingItems = new Map<string, EvidenceReviewItemPatch>()
let pendingHead: EvidenceReviewPatch | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let flushInFlight: Promise<void> | null = null
/** Guards stale async opens (switching reviews mid-load) and post-purge resolutions. */
let openToken = 0
/**
 * Bumped by `purgeReviewSession` (the lock) only — not by an open: the switch's flush loop
 * checks it so a lock landing mid-write ends the switch, without one open cancelling another.
 */
let purgeEpoch = 0
/**
 * #837 (review round 4) — ONE write lane: set while a lane holder runs (a bulk sweep's call until
 * its merge is done; since #889/#901 also a drain, a selection delete, a link or unlink until its call
 * is sent, mark ready / reopen through their merge, Try again's re-read — see the module header). `flushReviewSession` waits on it
 * like on `flushInFlight`, so no item write (debounce timer, screen exit) runs concurrently with
 * a holder; a holder waits out any item flush and any other holder before it starts
 * (`acquireLane`).
 */
let sweepLane: Promise<void> | null = null

/** A gate that opens once. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
/**
 * #837 (review round 5): opened (and replaced) by every purge. Every wait in this store — on an
 * item flush, on the sweep lane, on a sweep's own call — is raced against it, so a call that
 * never answers cannot keep anything pending after the lock: each wait then re-checks and finds
 * the purged, empty store.
 */
let purgeGate = gate()
function orPurge<T>(work: Promise<T>): Promise<T | undefined> {
  return Promise.race([work, purgeGate.promise.then(() => undefined)])
}

/**
 * How long `App.lockNow` lets the pre-lock flush run (review round 5): enough for one write that
 * waits out the database's 5 s busy timeout. The flush waits for a running sweep (the one write
 * lane), so a hung call must not hold the lock — the user's security action always wins.
 * If a flush the lock gave up on still writes (a hung sweep answering while `lockWorkspace`
 * runs), main's AUD-02 locking latch refuses evidence writes while locking: nothing lands.
 */
export const REVIEW_LOCK_FLUSH_BOUND_MS = 6_000

/**
 * The pre-lock save, bounded: it drains (#889 — an edit made while its first write is out is
 * written too), never rejects, and gives up after `REVIEW_LOCK_FLUSH_BOUND_MS`. A drain the bound
 * gave up on ends at the purge that follows (it releases every wait).
 */
export async function flushReviewSessionBeforeLock(): Promise<void> {
  let bound: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      drainReviewSaves().then(
        (drained) => drained?.release(),
        () => {}
      ),
      new Promise<void>((resolve) => {
        bound = setTimeout(resolve, REVIEW_LOCK_FLUSH_BOUND_MS)
      })
    ])
  } finally {
    if (bound) clearTimeout(bound)
  }
}

/**
 * #837 (review round 5): a FAILED sweep is shown until the user acts. Its error line stays
 * through a later automatic save (an edit queued during the sweep's call is still written after
 * it); a new edit, Try again, or a switch/lock clears it.
 */
let sweepFailed = false

function notify(): void {
  for (const fn of listeners) fn()
}

function setState(next: Partial<ReviewSessionState>): void {
  state = { ...state, ...next }
  notify()
}

export function subscribeReviewSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — a fresh object per change, stable between. */
export function getReviewSessionSnapshot(): ReviewSessionState {
  return state
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function armTimer(): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    void flushReviewSession()
  }, REVIEW_SAVE_DEBOUNCE_MS)
}

/** True while any edit is queued and not yet written (debounced, mid-flight, or left by a failed write). */
function hasUnsavedEdits(): boolean {
  return pendingItems.size > 0 || pendingHead != null
}

/**
 * #888: is any review change not yet known to be written — queued, in a write still out on the
 * lane (an item flush, or a holder's call: a bulk sweep, a delete, a link or unlink, Mark ready or
 * Reopen; one the close-time save's bound gave up on may yet fail), or a bulk sweep that failed
 * (it persisted nothing)? What the window answers main before it closes.
 */
export function hasUnsavedReviewEdits(): boolean {
  return hasUnsavedEdits() || laneBusy() || sweepFailed
}

// #888: closing or quitting the app saves first — the same bounded drain Lock now runs, then the
// window tells main whether anything is still unsaved (main then asks the user before closing).
registerBeforeClose(async () => {
  await flushReviewSessionBeforeLock()
  return { unsaved: hasUnsavedReviewEdits() }
})

/**
 * #837: an edit a FAILED write left unsaved is waiting for the user's Try again — the one
 * state a switch to another review or a bulk sweep must not run over. (Any other error —
 * a failed acknowledge, link or selection, an earlier sweep — leaves nothing queued and
 * blocks neither; edits that are merely pending are flushed first.) The screen disables
 * Bulk actions on the same condition.
 */
export function hasEditsAfterFailedSave(): boolean {
  return state.saveState === 'error' && hasUnsavedEdits()
}

/** Flush passes a drain runs at most (the first + up to three more): the valve against edits
 *  that never stop arriving. Edits past it are newer than the click and stay queued; Mark ready
 *  and Export then refuse (review round 3), the switch keeps the review open, and the timer
 *  writes them once the lane is free. */
const DRAIN_MAX_PASSES = 4

/** Is anything on the write lane right now (an item flush, or a lane holder)? */
function laneBusy(): boolean {
  return flushInFlight != null || sweepLane != null
}

/**
 * Take the write lane — the ONE way a holder takes it. When the lane is free it is taken NOW
 * and the release comes back synchronously: the caller uses it without an await
 * (`typeof lane === 'function' ? lane : await lane`), so it goes on in its own task and its
 * first IPC goes out before any await (rows pin that the lock's and the export's save reach the
 * IPC before any await, and that a delete's IPC goes out before a purge in the same task).
 * Otherwise a promise of the release once every item flush and every other holder is done; null
 * when a lock (purge) ended the wait. The release is idempotent: a purge already dropped the
 * lane, so a late release never frees a lane a newer holder took.
 */
function acquireLane(): (() => void) | Promise<(() => void) | null> {
  return laneBusy() ? takeWriteLane() : laneNow()
}

/** Set the lane (only when `laneBusy()` is false; `acquireLane` checked, synchronously). */
function laneNow(): () => void {
  let open: () => void = () => {}
  const lane = new Promise<void>((resolve) => {
    open = resolve
  })
  sweepLane = lane
  return () => {
    if (sweepLane === lane) sweepLane = null
    open()
  }
}

/** `acquireLane`'s wait: every item flush and every lane holder, then the lane. Null on a purge. */
async function takeWriteLane(): Promise<(() => void) | null> {
  const epoch = purgeEpoch
  while (laneBusy()) await orPurge((flushInFlight ?? sweepLane) as Promise<void>)
  return epoch === purgeEpoch ? laneNow() : null
}

/**
 * One flush pass — the item-flush half of the lane, shared by `flushReviewSession` and the drain:
 * write everything queued now (`doFlush`, whose first IPC goes out synchronously, in the caller's
 * task), registered as `flushInFlight` so every holder waits it out, raced against the purge.
 */
async function flushPass(): Promise<void> {
  const run = doFlush()
  flushInFlight = run
  try {
    await orPurge(run)
  } finally {
    if (flushInFlight === run) flushInFlight = null
  }
}

/**
 * #889: the ONE drain. Takes the write lane, then saves in passes INSIDE it until nothing is
 * queued or a write fails (at most `DRAIN_MAX_PASSES`). Resolves HOLDING the lane: the last
 * write has answered and no other write starts until `release()` — so `failed` (and whether an
 * edit is still queued) is read after the last write, and a waiting timer flush can neither take
 * the queue first nor fail after the caller went ahead. Null when a lock (purge) ended it. Shared
 * by mark ready, export, reopen, a review switch, Try again and the pre-lock save; `runSweep`
 * keeps its single pre-sweep flush (a decision made during it is newer than the sweep and is
 * written after it).
 */
async function drainReviewSaves(): Promise<{ failed: boolean; release: () => void } | null> {
  const epoch = purgeEpoch
  const lane = acquireLane()
  const release = typeof lane === 'function' ? lane : await lane
  if (!release) return null
  try {
    for (let pass = 0; pass < DRAIN_MAX_PASSES && hasUnsavedEdits(); pass++) {
      await flushPass()
      if (epoch !== purgeEpoch) {
        release()
        return null
      }
      if (state.saveState === 'error') break
    }
  } catch (e) {
    release()
    throw e
  }
  return { failed: state.saveState === 'error', release }
}

/** Does `target` name the review already in the store? */
function isOpenReview(target: ReviewHandoffTarget): boolean {
  const detail = state.detail
  if (!detail) return false
  return 'reviewId' in target ? target.reviewId === detail.id : target.messageId === detail.messageId
}

/** Open (or create — the idempotent Phase-1 create) a review for the handoff target. */
export async function openReviewSession(target: ReviewHandoffTarget): Promise<void> {
  // A previous review's unsaved edits are saved first so switching reviews loses nothing: the
  // drain writes in passes (edits that landed WHILE a pass was writing go in the next one) until
  // nothing is queued or a write FAILS (a failure is not retried here — it stands, with its error
  // line, until the user's Try again). It first waits out a flush ANOTHER caller started (a
  // screen's exit flush; React StrictMode runs that cleanup once more on mount): that flush holds
  // its patches OFF the queue while it writes, a failed write puts its patch back, and the reset
  // below would otherwise leave that failure to land under the new token and be dropped. A lock
  // (purge) landing during any of these waits ends the switch: nothing is opened into the purged
  // store.
  const drained = await drainReviewSaves()
  if (!drained) return
  drained.release()
  // #837: edits still queued now are ones a write FAILED to save (or, past the safety valve,
  // ones still arriving). The reset below used to drop them without a word.
  if (hasUnsavedEdits() && state.detail) {
    if (isOpenReview(target)) {
      // The same review: no reset and no re-read over the edit — it stays on screen with its
      // save-error line and Try again. A refused switch away from it is over.
      if (state.openError) setState({ openError: null })
      return
    }
    // Another review: keep this one (detail + queued edits) and refuse, naming it. No token
    // bump and no read: nothing is written on behalf of a review that is not open.
    setState({ openError: { kind: 'unsaved', title: state.detail.title, target } })
    return
  }
  const token = ++openToken
  clearTimer()
  pendingItems = new Map()
  pendingHead = null
  sweepFailed = false
  state = { ...INITIAL, loading: true }
  notify()
  try {
    const detail =
      'reviewId' in target
        ? await window.api.getEvidenceReview(target.reviewId)
        : await window.api.createEvidenceReview(target.messageId)
    if (token !== openToken) return
    if (!detail) {
      setState({ loading: false, openError: { kind: 'notFound' } })
      return
    }
    setState({ detail, loading: false, openError: null, saveState: 'idle', saveError: null })
    // P4 (plan §9.1 "on review open"): kick the freshness check — fire-and-forget so the
    // workspace renders immediately (spec §26 ≤1 s open); the banner/badges appear when
    // the verdict lands. Guarded by the SAME token inside.
    void refreshReviewFreshness()
  } catch (e) {
    if (token !== openToken) return
    setState({ loading: false, openError: { kind: 'failed', message: friendlyIpcError(e) } })
  }
}

/**
 * P4: fetch the open review's freshness verdict (spec §21.2 — a cheap stored-fact
 * comparison main-side; no hashing, no model, no network). Runs automatically after every
 * successful open (module-internal). A failure leaves `freshness`
 * untouched — the UI simply keeps its last honest state (absence, never an invented
 * verdict). Every post-await write is `openToken`-guarded (the store convention).
 */
async function refreshReviewFreshness(): Promise<void> {
  const reviewId = state.detail?.id
  if (!reviewId) return
  const token = openToken
  try {
    const fresh = await window.api.refreshEvidenceReviewState(reviewId)
    if (token !== openToken) return // purge/switch landed mid-flight — never write
    if (!state.detail || state.detail.id !== reviewId) return
    if (fresh) setState({ freshness: fresh })
  } catch {
    if (token !== openToken) return
    // Keep the last state — a failed check is not a verdict in either direction.
  }
}

/**
 * P4: acknowledge the CURRENT drift of an outdated review (spec §15.5/§28.6). Merges the
 * refreshed verdict (now carrying `acknowledgedAt`) into the store; false on refusal or
 * failure. Not blocked by the READY state — acknowledging is lifecycle metadata, not a
 * decision edit (main enforces the same).
 */
export async function acknowledgeReviewFreshness(): Promise<boolean> {
  const reviewId = state.detail?.id
  if (!reviewId) return false
  const token = openToken
  try {
    const fresh = await window.api.acknowledgeEvidenceReviewFreshness(reviewId)
    if (token !== openToken) return fresh != null
    if (!fresh) return false
    if (state.detail && state.detail.id === reviewId) setState({ freshness: fresh })
    return true
  } catch (e) {
    if (token !== openToken) return false
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
    return false
  }
}

/** Merge `patch` over `base`, field-wise (undefined = leave unchanged). */
function mergeItemPatch(
  base: EvidenceReviewItemPatch | undefined,
  patch: EvidenceReviewItemPatch
): EvidenceReviewItemPatch {
  return { ...base, ...patch }
}

/** `item` with what an item patch sets (decision, note; undefined = leave unchanged). The one
 *  place a patch is spread over a row: the optimistic apply and Try again's re-read. */
function applyItemPatch(item: EvidenceReviewItem, patch: EvidenceReviewItemPatch): EvidenceReviewItem {
  return {
    ...item,
    ...(patch.decision !== undefined ? { decision: patch.decision } : null),
    ...(patch.reviewerNote !== undefined ? { reviewerNote: patch.reviewerNote } : null)
  }
}

/** `detail` with what a head patch sets (title, reviewer label, general note; undefined = leave
 *  unchanged). The one place a head patch is spread: a head edit, Try again's re-read, and the
 *  merge of Mark ready's / Reopen's answer (which keeps the fields still queued). */
function applyHeadPatch(detail: EvidenceReviewDetail, patch: EvidenceReviewPatch): EvidenceReviewDetail {
  return {
    ...detail,
    ...(patch.title !== undefined ? { title: patch.title } : null),
    ...(patch.reviewerLabel !== undefined ? { reviewerLabel: patch.reviewerLabel } : null),
    ...(patch.generalNote !== undefined ? { generalNote: patch.generalNote } : null)
  }
}

/** Optimistically apply an item patch to the in-memory detail. */
function applyItemLocally(itemId: string, patch: EvidenceReviewItemPatch): void {
  const detail = state.detail
  if (!detail) return
  const items = detail.items.map((item) => (item.id === itemId ? applyItemPatch(item, patch) : item))
  setState({ detail: { ...detail, items, gate: deriveReadyGate(items) } })
}

/**
 * Item-level editing (decisions, notes, links, selections) is closed: no review, a READY one
 * (FIX-1 — reopen first; main refuses these writes too), or Mark ready's call is with main
 * (`finishing`, #889 G-4 — the screen is read-only for it).
 */
function itemEditingClosed(): boolean {
  return !state.detail || state.detail.status === 'ready' || state.finishing
}

/** Record an item edit: optimistic apply + pending patch + debounce. Refused while item
 *  editing is closed (`itemEditingClosed`). */
export function editReviewItem(itemId: string, patch: EvidenceReviewItemPatch): void {
  if (itemEditingClosed()) return
  applyItemLocally(itemId, patch)
  pendingItems.set(itemId, mergeItemPatch(pendingItems.get(itemId), patch))
  sweepFailed = false // the user acted after a failed sweep
  setState({ saveState: 'pending', saveError: null })
  armTimer()
}

/** Record a head edit (title D-6 / reviewer label D-3 / general note). */
export function editReviewHead(patch: EvidenceReviewPatch): void {
  const detail = state.detail
  if (!detail) return
  // The service ignores empty-title renames (a review is never unnamed) — mirror that
  // here so the optimistic title never shows a value that will not persist.
  const safe: EvidenceReviewPatch = { ...patch }
  if (safe.title !== undefined && safe.title.trim().length === 0) delete safe.title
  if (Object.keys(safe).length === 0) return
  sweepFailed = false // the user acted after a failed sweep
  setState({ detail: applyHeadPatch(detail, safe), saveState: 'pending', saveError: null })
  pendingHead = { ...pendingHead, ...safe }
  armTimer()
}

/**
 * Flush all pending patches now. Waits until NO flush is in flight (a loop, not a single
 * await — a timer-started run replacing `flushInFlight` mid-wait must also be awaited,
 * FIX-2b) and no lane holder runs (`sweepLane`, the one write lane), then drains whatever
 * is pending at that point — ONE pass: an edit made while it writes is left for the next
 * (`drainReviewSaves` runs passes). Loss-free: see the module header.
 */
export async function flushReviewSession(): Promise<void> {
  while (laneBusy()) await orPurge((flushInFlight ?? sweepLane) as Promise<void>)
  if (!hasUnsavedEdits()) return
  await flushPass()
}

async function doFlush(): Promise<void> {
  const token = openToken
  const reviewId = state.detail?.id
  // Drain BEFORE awaiting — edits landing mid-flight repopulate the maps for the next pass.
  const items = pendingItems
  const head = pendingHead
  pendingItems = new Map()
  pendingHead = null
  clearTimer()
  let failed = false
  let staleHandle = false
  for (const [itemId, patch] of items) {
    try {
      const updated = await window.api.updateEvidenceReviewItem(itemId, patch)
      if (token !== openToken) return // purged/switched mid-write — never touch state again
      if (updated == null) {
        // Unknown id — the item (or review) is gone underneath us. The patch is
        // unsaveable; dropping it is the honest outcome (retrying forever would not
        // resurrect the row). Surfaced as a save error.
        staleHandle = true
      }
    } catch (e) {
      if (token !== openToken) return // a post-purge re-merge would resurrect note plaintext
      failed = true
      // Re-merge UNDER newer pending fields: a field edited again mid-flight keeps its
      // newer pending value; only fields with no newer edit return to pending.
      pendingItems.set(itemId, { ...patch, ...pendingItems.get(itemId) })
      if (state.saveError == null) setState({ saveError: friendlyIpcError(e) })
    }
  }
  if (head != null && reviewId != null) {
    try {
      const updated = await window.api.updateEvidenceReview(reviewId, head)
      if (token !== openToken) return
      if (updated == null) staleHandle = true
    } catch (e) {
      if (token !== openToken) return
      failed = true
      pendingHead = { ...head, ...(pendingHead ?? {}) }
      if (state.saveError == null) setState({ saveError: friendlyIpcError(e) })
    }
  }
  if (token !== openToken) return
  if (failed || staleHandle) {
    setState({ saveState: 'error' })
    return
  }
  if (pendingItems.size > 0 || pendingHead != null) {
    // Edits landed while we were writing — keep saving.
    setState({ saveState: 'pending' })
    armTimer()
    return
  }
  // A failed sweep's error line stays until the user acts (review round 5): this save
  // succeeding does not undo that the sweep failed.
  setState(sweepFailed ? { saveState: 'error' } : { saveState: 'saved', saveError: null })
}

/**
 * The save-error retry action (FIX-2d). A retry with pending edits simply re-saves (drains).
 * A retry with NOTHING pending is the stale-handle case (the failed patch was dropped as
 * unsaveable) — re-saving would no-op and leave the UI showing a never-persisted value
 * forever, so instead the store RECONCILES with the DB: re-fetch the detail; a vanished
 * review lands on the friendly not-found state.
 */
export async function retryReviewSave(): Promise<void> {
  // #837 (review round 6): another flush or a sweep (a second Try again, the debounce, the
  // screen's exit flush) may have drained the queue into a write still in flight — the drain
  // waits it out, so "nothing pending" below means nothing unsaved, not "being written right
  // now". Otherwise the stale-handle branch re-read the database over a queued edit.
  const drained = await drainReviewSaves()
  if (!drained) return
  try {
    if (state.saveState !== 'error') return
    if (hasUnsavedEdits()) return // the save failed again — the error stands
    const reviewId = state.detail?.id
    if (!reviewId) return
    const token = openToken
    try {
      // The lane is held through the read (S-2): no write runs meanwhile, so an edit typed
      // during it is still queued when the read lands, and is put back over it below.
      const fresh = await window.api.getEvidenceReview(reviewId)
      if (token !== openToken) return
      if (fresh) {
        sweepFailed = false // Try again reconciled the screen with the database
        setState({
          detail: withQueuedEdits(fresh),
          saveState: hasUnsavedEdits() ? 'pending' : 'idle',
          saveError: null
        })
      } else {
        setState({ detail: null, openError: { kind: 'notFound' }, saveState: 'idle', saveError: null })
      }
    } catch {
      /* still unreachable — keep the error state for another retry */
    }
  } finally {
    drained.release()
  }
}

/** `detail` as main read it, with every edit still queued applied over it (they are written
 *  after the read, so they are the newer values). */
function withQueuedEdits(detail: EvidenceReviewDetail): EvidenceReviewDetail {
  if (!hasUnsavedEdits()) return detail
  const items = detail.items.map((item) => {
    const patch = pendingItems.get(item.id)
    return patch ? applyItemPatch(item, patch) : item
  })
  return { ...applyHeadPatch(detail, pendingHead ?? {}), items, gate: deriveReadyGate(items) }
}

/**
 * #837, the refused switch's "Try again": re-flush, and switch only when nothing is left
 * unsaved (`openReviewSession` re-checks; while the write keeps failing the refusal stands).
 */
export async function retryBlockedSwitch(): Promise<void> {
  const blocked = state.openError
  if (blocked?.kind !== 'unsaved') return
  await openReviewSession(blocked.target)
}

/**
 * #837, the refused switch's "Discard changes and open": drop the unsaved edits of the review
 * on screen — the user's explicit choice, the only way they are lost before a lock — then
 * switch. A write still in flight settles first, so a late failure cannot re-queue a patch the
 * user just discarded.
 */
export async function discardAndSwitch(): Promise<void> {
  if (state.openError?.kind !== 'unsaved') return
  while (flushInFlight) await orPurge(flushInFlight)
  // Re-read after the wait: a lock (purge), a switch that went ahead, or the same review opened
  // again all end the refusal, and then there is nothing left to discard. (This is the post-await
  // guard here: every `openToken` bump also resets `openError`, so a token check would add
  // nothing, and it would miss the same-review case, which clears the refusal without a bump.)
  const blocked = state.openError
  if (blocked?.kind !== 'unsaved') return
  clearTimer()
  pendingItems = new Map()
  pendingHead = null
  await openReviewSession(blocked.target)
}

/**
 * The D-7 gate for LIVE progress while edits are still optimistic: main's own function
 * (`shared/evidence-review.ts`), run over the store's items. The AUTHORITATIVE gate for the
 * ready transition comes back from `markEvidenceReviewReady` (main recomputes from persisted
 * rows); a main-sourced `detail.gate` is kept as-is on open. Exported under this name for open
 * PR #511, whose preview harness imports it from here (#839, gate G-17).
 */
export { deriveReadyGate as computeReadyGate }

/**
 * Merge a returned head (markReady/reopen) into the open detail. Called with the write lane
 * held, so no head write is in flight: a head field still QUEUED was typed during the call, is
 * newer than main's answer and is written after it — it stays on screen (#889). (The screen
 * shows every queued head field's value: a head edit applies it to both.)
 */
function mergeHead(review: EvidenceReview, gate?: EvidenceReadyGate): void {
  const detail = state.detail
  if (!detail || detail.id !== review.id) return
  setState({ detail: { ...applyHeadPatch({ ...detail, ...review }, pendingHead ?? {}), gate: gate ?? detail.gate } })
}

/**
 * Mark the open review ready (D-7 gated). Drains pending edits FIRST — the gate is derived
 * main-side from persisted rows, so every unsaved decision must land before the check (#889:
 * also one made while the save was writing; it refuses while one is still queued). The write
 * lane is held through main's call and the merge, and item editing is closed meanwhile
 * (`finishing`, G-4). Returns the outcome;
 * 'ineligible' carries main's authoritative gate ("N of M decided"), rendered as guidance,
 * never as a failure (P1 handoff).
 */
export async function markReviewReady(): Promise<
  | { outcome: 'ready' }
  | { outcome: 'ineligible'; gate: EvidenceReadyGate }
  | { outcome: 'failed' }
> {
  const reviewId = state.detail?.id
  if (!reviewId) return { outcome: 'failed' }
  const token = openToken
  const drained = await drainReviewSaves()
  if (!drained) return { outcome: 'failed' }
  try {
    // Review round 3: past the drain's passes (typing that never stopped) an edit can still be
    // queued. Main would decide without it and then refuse its write once ready, so Mark ready
    // refuses as after a failed save — with no error: the line still says "Saving…", and the
    // timer writes the edit once the lane is free.
    if (token !== openToken || drained.failed || hasUnsavedEdits()) return { outcome: 'failed' }
    setState({ finishing: true })
    try {
      const result = await window.api.markEvidenceReviewReady(reviewId)
      if (token !== openToken) return { outcome: 'failed' }
      if (!result) {
        setState({ saveState: 'error', saveError: null })
        return { outcome: 'failed' }
      }
      mergeHead(result.review, result.gate)
      return result.review.status === 'ready'
        ? { outcome: 'ready' }
        : { outcome: 'ineligible', gate: result.gate }
    } catch (e) {
      if (token !== openToken) return { outcome: 'failed' }
      setState({ saveState: 'error', saveError: friendlyIpcError(e) })
      return { outcome: 'failed' }
    }
  } finally {
    if (token === openToken && state.finishing) setState({ finishing: false })
    drained.release()
  }
}

/** Outcome of `exportReviewPack`: cancelled = the user closed the save dialog (no file, no
 *  row — not an error); failed carries friendly copy when main sent any. */
export type ReviewExportOutcome =
  | { outcome: 'exported' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; message: string | null }

/**
 * Export the open review as an evidence pack (Phase 3, plan §8.3/§8.4). Drains pending
 * edits FIRST — the pack renders PERSISTED review data, so unsaved decisions/notes must
 * land before the render (the markReviewReady idiom; #889: also one made while the save was
 * writing); a failed save, or an edit still queued past the drain's passes, refuses the export
 * rather than shipping a pack that silently misses on-screen edits. The write lane is released
 * BEFORE main's call, with no await in between: the call reaches main first, and a save that
 * comes due during the save dialog or a PDF print
 * (minutes, possibly) is not held behind it, nor is the lock's pre-lock save. On success the
 * returned record is MERGED into `detail.exports` (newest-first — the store has no other
 * export-aware mutation; P2 handoff), behind the `openToken` staleness guard like every
 * post-await write. Export works on draft AND ready reviews — the ready-state write-guard
 * covers item/link mutations only.
 */
export async function exportReviewPack(
  options: EvidencePackExportRequest
): Promise<ReviewExportOutcome> {
  const reviewId = state.detail?.id
  if (!reviewId) return { outcome: 'failed', message: null }
  const token = openToken
  const drained = await drainReviewSaves()
  if (!drained) return { outcome: 'failed', message: null }
  // Read with the lane still held (review round 3): an edit still queued past the drain's passes
  // would be missing from the pack, so it refuses as after a failed save.
  const unsaved = drained.failed || hasUnsavedEdits()
  drained.release()
  if (token !== openToken) return { outcome: 'failed', message: null }
  if (unsaved) return { outcome: 'failed', message: null }
  try {
    const record = await window.api.exportEvidencePack(reviewId, options)
    if (!record) return { outcome: 'cancelled' }
    if (token !== openToken) {
      // The export COMPLETED (file + row exist) but the session moved on mid-dialog
      // (lock purge / review switch). Never touch the purged/foreign store — and never
      // report a real export as a failure: 'exported' is the truthful outcome (the
      // history row surfaces on the next detail read).
      return { outcome: 'exported' }
    }
    const detail = state.detail
    if (detail && detail.id === reviewId) {
      setState({ detail: { ...detail, exports: [record, ...detail.exports] } })
    }
    return { outcome: 'exported' }
  } catch (e) {
    // Post-token-change throws stay 'failed' too: the export genuinely did not complete
    // (main rejected), and failed-with-no-copy renders nothing if the panel is gone.
    return { outcome: 'failed', message: token === openToken ? friendlyIpcError(e) : null }
  }
}

/** Reopen a ready review to draft (spec §18.4). Drains pending HEAD edits first (FIX-2c —
 *  symmetry with markReviewReady: a <debounce-old title/note edit must not be visually
 *  reverted by the merge of main's returned head; #889: nor one typed while the save was
 *  writing), and holds the write lane through main's call and the merge, which keeps a head
 *  field typed during the call. */
export async function reopenReview(): Promise<boolean> {
  const reviewId = state.detail?.id
  if (!reviewId) return false
  const token = openToken
  const drained = await drainReviewSaves()
  if (!drained) return false
  try {
    if (token !== openToken || drained.failed) return false
    try {
      const review = await window.api.reopenEvidenceReview(reviewId)
      if (token !== openToken) return false
      if (!review) return false
      mergeHead(review)
      return true
    } catch (e) {
      if (token !== openToken) return false
      setState({ saveState: 'error', saveError: friendlyIpcError(e) })
      return false
    }
  } finally {
    drained.release()
  }
}

/**
 * Send one link or unlink call inside the write lane (follow-ups wave 2 S-W2-1 — every write
 * to an existing item takes the lane). It waits out a write or a selection delete in flight (at
 * once when the lane is free, so the call still goes out in the click's own task), and is sent
 * only while the row is still there: a delete that succeeded meanwhile removed it, and a call
 * for that id would get main's null (a false save error) — there is nothing left to link. The
 * lane is released as soon as the call is SENT (no await between): nothing written after a
 * link conflicts with it, and its answer brings links only. Null = not sent (a lock, a switch,
 * Mark ready, or the row is gone).
 */
async function sendLinkCall<T>(itemId: string, token: number, send: () => Promise<T>): Promise<{ answer: Promise<T> } | null> {
  const lane = acquireLane()
  const release = typeof lane === 'function' ? lane : await lane
  if (!release) return null
  try {
    if (token !== openToken || itemEditingClosed()) return null
    if (!state.detail?.items.some((i) => i.id === itemId)) return null
    return { answer: send() }
  } finally {
    release()
  }
}

/**
 * Link one evidence source to an item (always `origin: 'reviewer'` — main forces it; the
 * "Cited by the answer" origin is minted only by the snapshot builder). Immediate IPC —
 * links are structural, not debounced — sent through the write lane (`sendLinkCall`). Null
 * result = stale handle → surfaced, not thrown. Only the LINKS are taken from main's returned
 * row: a decision or note still queued (or being written) is newer than that row, so the
 * screen keeps it (follow-ups wave 2 S-1 — the sweep's "merge what the call changed" rule).
 */
export async function linkEvidence(
  itemId: string,
  evidenceKey: string,
  relation: 'supports' | 'qualifies' | 'contradicts' | 'context' | null
): Promise<void> {
  if (itemEditingClosed()) return // FIX-1: reopen first; #889 G-4: not during Mark ready
  const token = openToken
  try {
    const call = await sendLinkCall(itemId, token, () =>
      window.api.setEvidenceLink(itemId, evidenceKey, { origin: 'reviewer', relation })
    )
    if (!call) return
    const updated = await call.answer
    // FIX-2a: never write into a purged or switched store — the resolution may land
    // after App.lockNow's purge (re-inserting decrypted content) or after a review
    // switch (spreading a stale detail over the new one).
    if (token !== openToken) return
    const detail = state.detail
    if (!detail) return
    if (updated == null) {
      setState({ saveState: 'error', saveError: null })
      return
    }
    const items = detail.items.map((i) => (i.id === itemId ? { ...i, links: updated.links } : i))
    setState({ detail: { ...detail, items } })
  } catch (e) {
    if (token !== openToken) return
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  }
}

/** Remove one item→source link, sent through the write lane (`sendLinkCall`). A false result
 *  (already gone) still clears it locally. */
export async function unlinkEvidence(itemId: string, evidenceKey: string): Promise<void> {
  if (itemEditingClosed()) return // FIX-1: reopen first; #889 G-4: not during Mark ready
  const token = openToken
  try {
    const call = await sendLinkCall(itemId, token, () => window.api.removeEvidenceLink(itemId, evidenceKey))
    if (!call) return
    await call.answer
    if (token !== openToken) return // FIX-2a: purge/switch landed mid-flight
    const detail = state.detail
    if (!detail) return
    const items = detail.items.map((i) =>
      i.id === itemId ? { ...i, links: i.links.filter((l) => l.evidenceKey !== evidenceKey) } : i
    )
    setState({ detail: { ...detail, items } })
  } catch (e) {
    if (token !== openToken) return
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  }
}

// ---- Reviewer text selections (P5, spec §12.1) -----------------------------------------
// Structural like links: immediate IPC, never debounced. The offsets are UTF-16 code units
// into the parent block's `textSnapshot` (exclusive end) — produced EXACTLY by the
// selection surface (a read-only textarea whose value IS the snapshot, so its native
// selectionStart/End are the offsets; no DOM→source mapping can drift). Main REFUSES
// out-of-range or surrogate-splitting boundaries with a null (never clamps) — surfaced as
// 'refused' for the friendly retry hint, never as a save error and never a crash.

export type AddSelectionOutcome = 'added' | 'refused' | 'failed'

/** Create a reviewer selection carved from one block item. Refused while item editing is
 *  closed (READY, FIX-1 — the UI hides the affordance too; main refuses the write as well; or
 *  Mark ready's call is with main, #889 G-4). */
export async function addReviewSelection(
  blockKey: string,
  startOffset: number,
  endOffset: number
): Promise<AddSelectionOutcome> {
  if (!state.detail || itemEditingClosed()) return 'failed'
  const token = openToken
  try {
    const created = await window.api.createEvidenceSelection(state.detail.id, {
      blockKey,
      startOffset,
      endOffset
    })
    // Post-purge/switch resolutions never touch the store (FIX-2a) — but the outcome is
    // still reported truthfully (the row exists; it surfaces on the next detail read).
    if (token !== openToken) return created ? 'added' : 'refused'
    const detail = state.detail
    if (!detail) return 'failed'
    if (created == null) return 'refused'
    // Append — the service assigns the next ordinal, so local order matches the next read.
    const items = [...detail.items, created]
    setState({ detail: { ...detail, items, gate: deriveReadyGate(items) } })
    return 'added'
  } catch (e) {
    if (token !== openToken) return 'failed'
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
    return 'failed'
  }
}

/**
 * Delete a reviewer SELECTION (block items are structural — the UI never offers this for
 * them; main refuses too). A false result (already gone) still clears it locally — the
 * unlinkEvidence posture.
 *
 * #901: the delete takes the one write lane, so no write of this selection is in flight, or
 * starts, while main deletes it (a write sent after the delete would get main's null for the
 * unknown id, which reads as a stale handle: a false save error that blocked Mark ready and
 * Export). Once main deleted it, its queued edit can never land and is dropped; with nothing
 * else queued, "Saving…" ends here (no timer would end it). A delete that fails keeps the edit,
 * and it is written after.
 */
export async function deleteReviewSelection(itemId: string): Promise<void> {
  if (itemEditingClosed()) return
  const token = openToken
  // At once when the lane is free: the delete still goes out in the click's own task (FIX-5d).
  const lane = acquireLane()
  const release = typeof lane === 'function' ? lane : await lane
  if (!release) return
  try {
    // Re-checked after a wait for the lane: a lock, a switch, or Mark ready may have ended it.
    if (token !== openToken || itemEditingClosed()) return
    await window.api.deleteEvidenceSelection(itemId)
    if (token !== openToken) return
    pendingItems.delete(itemId)
    if (!hasUnsavedEdits()) {
      clearTimer()
      if (state.saveState === 'pending') {
        setState(sweepFailed ? { saveState: 'error' } : { saveState: 'saved', saveError: null })
      }
    }
    const detail = state.detail
    if (!detail) return
    const items = detail.items.filter((i) => i.id !== itemId)
    setState({ detail: { ...detail, items, gate: deriveReadyGate(items) } })
  } catch (e) {
    if (token !== openToken) return
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  } finally {
    release()
  }
}

// ---- Conservative bulk actions (spec §14.4) --------------------------------------------
// Exactly the three sanctioned actions. There is deliberately NO "mark all supported" —
// a blanket supported-claim is the one bulk action the spec forbids (tested).
//
// AUD-13: each action is ONE named command over ONE IPC call that main applies in ONE
// transaction. It used to walk the item list and queue a per-item patch, which flushed as N
// individual writes — N redundant ready-guard re-reads, N head stamps, N item re-reads, and
// (the user-visible half) a crash or failure part-way through leaving the review HALF-swept:
// a state no user action can produce and none can explain. Per-item edits queued when the
// sweep is asked for are flushed FIRST (the markReviewReady idiom), so the sweep overrides
// them; while the sweep's call is in flight no item write runs (the one write lane, #837 —
// `runSweep`), so a decision still queued at its merge is written after it and kept on
// screen, and every other item shows what main swept: the screen never disagrees with main.

/** Which items a bulk action targets locally — the mirror of main's SQL predicates, used
 *  for the optimistic apply only (main re-derives from persisted rows and its returned
 *  items are what the store finally trusts). */
function bulkTargets(
  items: readonly EvidenceReviewItem[],
  action: EvidenceReviewBulkAction
): { ids: Set<string>; decision: ReviewDecision } {
  switch (action) {
    case 'headings_not_applicable':
      return {
        decision: 'not_applicable',
        ids: new Set(
          items
            .filter(
              (i) => i.kind === 'block' && i.blockKind === 'heading' && i.decision !== 'not_applicable'
            )
            .map((i) => i.id)
        )
      }
    case 'clear_decisions':
      return {
        decision: 'not_reviewed',
        ids: new Set(items.filter((i) => i.decision !== 'not_reviewed').map((i) => i.id))
      }
    case 'undecided_follow_up':
      return {
        decision: 'follow_up',
        ids: new Set(items.filter((i) => i.decision === 'not_reviewed').map((i) => i.id))
      }
    default: {
      // Compile-time: exhaustive over the union — a new bulk action fails this assignment.
      // Runtime: an unknown name targets nothing (an empty set is a no-op sweep, no IPC).
      const unknown: never = action
      void unknown
      return { decision: 'not_reviewed', ids: new Set() }
    }
  }
}

/**
 * Run one bulk action end to end. Refused while the review is READY (FIX-1 — reopen first;
 * main refuses it too) and when nothing matches (a no-op sweep issues no write at all).
 * Every post-await write is `openToken`-guarded, the store convention.
 */
async function applyBulkAction(action: EvidenceReviewBulkAction): Promise<void> {
  const opened = state.detail
  if (!opened || opened.status === 'ready') return
  // #837 (review round 4): one sweep at a time — a second one while a sweep runs does nothing
  // (the screen disables Bulk actions meanwhile).
  if (state.bulkRunning) return
  const reviewId = opened.id
  const token = openToken
  setState({ bulkRunning: true })
  try {
    await runSweep(action, reviewId, token)
  } finally {
    if (token === openToken && state.bulkRunning) setState({ bulkRunning: false })
  }
}

/**
 * The sweep itself (#837). What was queued when the sweep was asked for is written FIRST (the
 * flush below), so the sweep overrides it. Then ONE write lane: from the sweep's call until its
 * merge is done, no item flush starts (`flushReviewSession` waits on `sweepLane`), so at the
 * merge no item write is in flight and the merge rule is exact: an item keeps its local
 * decision iff a decision patch for it is still QUEUED — it is written after the sweep, so it
 * is the last word — and otherwise takes the sweep's returned value, which is what main holds.
 * The optimistic apply follows the same rule.
 */
async function runSweep(action: EvidenceReviewBulkAction, reviewId: string, token: number): Promise<void> {
  // ONE pre-sweep flush, not a drain: a decision made while it writes is newer than the sweep and
  // must be written AFTER it (a drain would write it first, and the sweep would override it).
  await flushReviewSession()
  // Then the lane, through the shared helper: it also waits out another holder (a delete, a
  // mark ready or reopen through its merge, Try again's re-read).
  const lane = acquireLane()
  const releaseLane = typeof lane === 'function' ? lane : await lane
  if (!releaseLane) return
  try {
    await sweepInLane(action, reviewId, token)
  } finally {
    releaseLane()
  }
}

/** The sweep's checks, optimistic apply, call and merge, with the write lane held. */
async function sweepInLane(action: EvidenceReviewBulkAction, reviewId: string, token: number): Promise<void> {
  if (token !== openToken) return
  // #837: never sweep over an edit a FAILED write left unsaved (the markReviewReady /
  // exportReviewPack / reopenReview idiom, narrowed to what actually conflicts): the optimistic
  // apply would clear its error line and the failed patch would be written after the sweep.
  // Any other error (nothing queued) does not block it.
  if (hasEditsAfterFailedSave()) return
  const detail = state.detail
  if (!detail || detail.id !== reviewId || detail.status === 'ready') return
  const { ids, decision } = bulkTargets(detail.items, action)
  if (ids.size === 0) return
  const queuedDecision = (itemId: string): boolean => pendingItems.get(itemId)?.decision !== undefined
  // The decisions the optimistic apply replaces (review round 5): a FAILED sweep persisted
  // nothing, so these come back on screen — the mirror of the success rule.
  const before = new Map<string, ReviewDecision>()
  for (const i of detail.items) if (ids.has(i.id) && !queuedDecision(i.id)) before.set(i.id, i.decision)
  // Optimistic apply — ONE state commit for the whole sweep, never one per item. An error
  // already showing stays (review round 5): only a later successful save or Try again clears it.
  const optimistic = detail.items.map((i) => (before.has(i.id) ? { ...i, decision } : i))
  setState({
    detail: { ...detail, items: optimistic, gate: deriveReadyGate(optimistic) },
    ...(state.saveState === 'error' ? null : { saveState: 'pending', saveError: null })
  })
  // A failed or refused sweep: every swept item with nothing queued goes back to its pre-sweep
  // decision (under the one lane nothing is being written meanwhile); a decision queued during
  // the call keeps its value and is written after. The error line stays until the user acts.
  const undo = (saveError: string | null): void => {
    const current = state.detail
    if (current && current.id === reviewId) {
      const items = current.items.map((i) =>
        before.has(i.id) && !queuedDecision(i.id) ? { ...i, decision: before.get(i.id)! } : i
      )
      setState({ detail: { ...current, items, gate: deriveReadyGate(items) } })
    }
    sweepFailed = true
    setState({ saveState: 'error', saveError })
    if (hasUnsavedEdits()) armTimer()
  }
  try {
    // Raced against the purge gate: a call that never answers cannot outlive the lock.
    const updated = await orPurge(window.api.applyEvidenceReviewBulkAction(reviewId, action))
    if (token !== openToken) return // purge/switch landed mid-flight — never write
    const current = state.detail
    if (!current || current.id !== reviewId) return
    if (updated == null) {
      // Stale handle or a refusal (deleted / reopened-to-ready underneath us) — surfaced,
      // never retried in a loop.
      undo(null)
      return
    }
    // Merge the persisted DECISIONS only: a note typed while the sweep was in flight is still
    // queued and must not be reverted by the returned rows; a DECISION still queued is newer
    // than the sweep and is written after it, so the screen keeps it.
    const byId = new Map(updated.map((i) => [i.id, i]))
    const items = current.items.map((i) => {
      const fresh = byId.get(i.id)
      if (!fresh || queuedDecision(i.id)) return i
      return { ...i, decision: fresh.decision }
    })
    const queued = hasUnsavedEdits()
    // Never clear an error that landed meanwhile (under the one lane no item write can fail
    // during the sweep, but an acknowledge or a link can); otherwise "Saving…" while anything is
    // queued, "Saved" when nothing is.
    const failed = state.saveState === 'error'
    setState({
      detail: { ...current, items, gate: deriveReadyGate(items) },
      ...(failed ? null : { saveState: queued ? 'pending' : 'saved', saveError: null })
    })
    // Anything queued gets a scheduled write, so the line never stands on "Saving…" with
    // nothing to end it; a failure of that write then shows the error line + Try again.
    if (queued) armTimer()
  } catch (e) {
    if (token !== openToken) return
    undo(friendlyIpcError(e))
  }
}

/** Set every heading block whose decision differs to Not applicable. */
export function bulkMarkHeadingsNotApplicable(): Promise<void> {
  return applyBulkAction('headings_not_applicable')
}

/** Reset EVERY decision to Not reviewed (notes are kept). */
export function bulkClearDecisions(): Promise<void> {
  return applyBulkAction('clear_decisions')
}

/** Move every still-undecided item to Needs follow-up. */
export function bulkMarkUndecidedFollowUp(): Promise<void> {
  return applyBulkAction('undecided_follow_up')
}

/**
 * Drop the resident review content at the workspace-lock seam (lockPurge.ts). Does NOT
 * save — `App.lockNow` awaits `flushReviewSessionBeforeLock()` (a bounded drain) BEFORE
 * `lockWorkspace()` (while the vault is still writable); by purge time main has already
 * re-encrypted.
 */
export function purgeReviewSession(): void {
  openToken += 1
  purgeEpoch += 1
  clearTimer()
  pendingItems = new Map()
  pendingHead = null
  flushInFlight = null
  sweepLane = null
  sweepFailed = false
  // Release every wait (review round 5): a flush, an open or a sweep waiting on a call that
  // never answers settles now and finds the purged store — nothing outlives the lock.
  purgeGate.open()
  purgeGate = gate()
  state = INITIAL
  notify()
}
