import type {
  EvidencePackOptions,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  ReviewDecision
} from '@shared/types'
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
//  - `flushReviewSession()` is the hard flush for screen exit and the pre-lock seam.
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

export type ReviewHandoffTarget = { reviewId: string } | { messageId: string }

export type ReviewSaveState = 'idle' | 'pending' | 'saved' | 'error'

export interface ReviewSessionState {
  /** The open review read-model with local optimistic edits applied; null = none open. */
  detail: EvidenceReviewDetail | null
  loading: boolean
  /**
   * Open failure: 'notFound' = a reviewId handoff resolved null (deleted/stale);
   * otherwise the friendly (main-localized) message text.
   */
  openError: { kind: 'notFound' } | { kind: 'failed'; message: string } | null
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
}

const INITIAL: ReviewSessionState = {
  detail: null,
  loading: false,
  openError: null,
  saveState: 'idle',
  saveError: null,
  freshness: null
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

/** Open (or create — the idempotent Phase-1 create) a review for the handoff target. */
export async function openReviewSession(target: ReviewHandoffTarget): Promise<void> {
  // A previous review's unsaved edits are flushed first so switching reviews loses nothing.
  await flushReviewSession().catch(() => {})
  const token = ++openToken
  clearTimer()
  pendingItems = new Map()
  pendingHead = null
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
 * successful open; callable again for an explicit re-check. A failure leaves `freshness`
 * untouched — the UI simply keeps its last honest state (absence, never an invented
 * verdict). Every post-await write is `openToken`-guarded (the store convention).
 */
export async function refreshReviewFreshness(): Promise<void> {
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

/** Optimistically apply an item patch to the in-memory detail. */
function applyItemLocally(itemId: string, patch: EvidenceReviewItemPatch): void {
  const detail = state.detail
  if (!detail) return
  const items = detail.items.map((item) =>
    item.id === itemId
      ? {
          ...item,
          ...(patch.decision !== undefined ? { decision: patch.decision } : null),
          ...(patch.reviewerNote !== undefined ? { reviewerNote: patch.reviewerNote } : null)
        }
      : item
  )
  setState({ detail: { ...detail, items, gate: computeReadyGate(items) } })
}

/** Record an item edit: optimistic apply + pending patch + debounce. Refused while the
 *  review is READY (FIX-1 — reopen first; main refuses these writes anyway). */
export function editReviewItem(itemId: string, patch: EvidenceReviewItemPatch): void {
  if (!state.detail || state.detail.status === 'ready') return
  applyItemLocally(itemId, patch)
  pendingItems.set(itemId, mergeItemPatch(pendingItems.get(itemId), patch))
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
  setState({
    detail: {
      ...detail,
      ...(safe.title !== undefined ? { title: safe.title } : null),
      ...(safe.reviewerLabel !== undefined ? { reviewerLabel: safe.reviewerLabel } : null),
      ...(safe.generalNote !== undefined ? { generalNote: safe.generalNote } : null)
    },
    saveState: 'pending',
    saveError: null
  })
  pendingHead = { ...pendingHead, ...safe }
  armTimer()
}

/**
 * Flush all pending patches now. Waits until NO flush is in flight (a loop, not a single
 * await — a timer-started run replacing `flushInFlight` mid-wait must also be awaited,
 * FIX-2b), then drains whatever is pending at that point. Loss-free: see the module header.
 */
export async function flushReviewSession(): Promise<void> {
  while (flushInFlight) await flushInFlight
  if (pendingItems.size === 0 && pendingHead == null) return
  const run = doFlush()
  flushInFlight = run
  try {
    await run
  } finally {
    if (flushInFlight === run) flushInFlight = null
  }
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
  setState({ saveState: 'saved', saveError: null })
}

/**
 * The save-error retry action (FIX-2d). A retry with pending edits simply re-flushes. A
 * retry with NOTHING pending is the stale-handle case (the failed patch was dropped as
 * unsaveable) — re-flushing would no-op and leave the UI showing a never-persisted value
 * forever, so instead the store RECONCILES with the DB: re-fetch the detail; a vanished
 * review lands on the friendly not-found state.
 */
export async function retryReviewSave(): Promise<void> {
  await flushReviewSession()
  if (state.saveState !== 'error') return
  if (pendingItems.size > 0 || pendingHead != null) return // flush failed again — error stands
  const reviewId = state.detail?.id
  if (!reviewId) return
  const token = openToken
  try {
    const fresh = await window.api.getEvidenceReview(reviewId)
    if (token !== openToken) return
    if (fresh) {
      setState({ detail: fresh, saveState: 'idle', saveError: null })
    } else {
      setState({ detail: null, openError: { kind: 'notFound' }, saveState: 'idle', saveError: null })
    }
  } catch {
    /* still unreachable — keep the error state for another retry */
  }
}

/**
 * Mirror of the main-side D-7 ready gate (`deriveReadyGate`) for LIVE progress while edits
 * are still optimistic: required = non-heading BLOCK items (NULL/unknown kind counts as
 * required — the safe direction), decided = any decision other than 'not_reviewed'
 * ('not_applicable' counts as decided). Selections never gate. The AUTHORITATIVE gate for
 * the ready transition itself comes back from `markEvidenceReviewReady` (main recomputes
 * from persisted rows); a main-sourced `detail.gate` is kept as-is on open — this mirror
 * runs only on optimistic in-between edits. Equivalence with main's `deriveReadyGate` is
 * PINNED by a matrix test (review FIX-4 — `tests/unit/evidence-review-gate.test.ts`).
 */
export function computeReadyGate(items: readonly EvidenceReviewItem[]): EvidenceReadyGate {
  let requiredTotal = 0
  let decidedTotal = 0
  for (const item of items) {
    if (item.kind !== 'block' || item.blockKind === 'heading') continue
    requiredTotal += 1
    if (item.decision !== 'not_reviewed') decidedTotal += 1
  }
  return { eligible: decidedTotal === requiredTotal, requiredTotal, decidedTotal }
}

/** Merge a returned head (markReady/reopen) into the open detail. */
function mergeHead(review: EvidenceReview, gate?: EvidenceReadyGate): void {
  const detail = state.detail
  if (!detail || detail.id !== review.id) return
  setState({ detail: { ...detail, ...review, gate: gate ?? detail.gate } })
}

/**
 * Mark the open review ready (D-7 gated). Flushes pending edits FIRST — the gate is
 * derived main-side from persisted rows, so unsaved decisions must land before the check.
 * Returns the outcome; 'ineligible' carries main's authoritative gate ("N of M decided"),
 * rendered as guidance, never as a failure (P1 handoff).
 */
export async function markReviewReady(): Promise<
  | { outcome: 'ready' }
  | { outcome: 'ineligible'; gate: EvidenceReadyGate }
  | { outcome: 'failed' }
> {
  const reviewId = state.detail?.id
  if (!reviewId) return { outcome: 'failed' }
  const token = openToken
  await flushReviewSession()
  if (token !== openToken) return { outcome: 'failed' }
  if (state.saveState === 'error') return { outcome: 'failed' }
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
}

/** Outcome of `exportReviewPack`: cancelled = the user closed the save dialog (no file, no
 *  row — not an error); failed carries friendly copy when main sent any. */
export type ReviewExportOutcome =
  | { outcome: 'exported' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; message: string | null }

/**
 * Export the open review as an evidence pack (Phase 3, plan §8.3/§8.4). Flushes pending
 * edits FIRST — the pack renders PERSISTED review data, so unsaved decisions/notes must
 * land before the render (the markReviewReady idiom); a failed flush refuses the export
 * rather than shipping a pack that silently misses on-screen edits. On success the
 * returned record is MERGED into `detail.exports` (newest-first — the store has no other
 * export-aware mutation; P2 handoff), behind the `openToken` staleness guard like every
 * post-await write. Export works on draft AND ready reviews — the ready-state write-guard
 * covers item/link mutations only.
 */
export async function exportReviewPack(
  options: Partial<EvidencePackOptions>
): Promise<ReviewExportOutcome> {
  const reviewId = state.detail?.id
  if (!reviewId) return { outcome: 'failed', message: null }
  const token = openToken
  await flushReviewSession()
  if (token !== openToken) return { outcome: 'failed', message: null }
  if (state.saveState === 'error') return { outcome: 'failed', message: null }
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

/** Reopen a ready review to draft (spec §18.4). Flushes pending HEAD edits first (FIX-2c —
 *  symmetry with markReviewReady: a <debounce-old title/note edit must not be visually
 *  reverted by the merge of main's returned head). */
export async function reopenReview(): Promise<boolean> {
  const reviewId = state.detail?.id
  if (!reviewId) return false
  const token = openToken
  await flushReviewSession()
  if (token !== openToken) return false
  if (state.saveState === 'error') return false
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
}

/**
 * Link one evidence source to an item (always `origin: 'reviewer'` — main forces it; the
 * "Cited by the answer" origin is minted only by the snapshot builder). Immediate IPC —
 * links are structural, not debounced. Null result = stale handle → surfaced, not thrown.
 */
export async function linkEvidence(
  itemId: string,
  evidenceKey: string,
  relation: 'supports' | 'qualifies' | 'contradicts' | 'context' | null
): Promise<void> {
  if (!state.detail || state.detail.status === 'ready') return // FIX-1: reopen first
  const token = openToken
  try {
    const updated = await window.api.setEvidenceLink(itemId, evidenceKey, {
      origin: 'reviewer',
      relation
    })
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
    const items = detail.items.map((i) => (i.id === itemId ? updated : i))
    setState({ detail: { ...detail, items } })
  } catch (e) {
    if (token !== openToken) return
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  }
}

/** Remove one item→source link. A false result (already gone) still clears it locally. */
export async function unlinkEvidence(itemId: string, evidenceKey: string): Promise<void> {
  if (!state.detail || state.detail.status === 'ready') return // FIX-1: reopen first
  const token = openToken
  try {
    await window.api.removeEvidenceLink(itemId, evidenceKey)
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

/** Create a reviewer selection carved from one block item. Refused while READY (FIX-1 —
 *  the UI hides the affordance too; main refuses the write as well). */
export async function addReviewSelection(
  blockKey: string,
  startOffset: number,
  endOffset: number
): Promise<AddSelectionOutcome> {
  if (!state.detail || state.detail.status === 'ready') return 'failed'
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
    setState({ detail: { ...detail, items, gate: computeReadyGate(items) } })
    return 'added'
  } catch (e) {
    if (token !== openToken) return 'failed'
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
    return 'failed'
  }
}

/** Delete a reviewer SELECTION (block items are structural — the UI never offers this for
 *  them; main refuses too). A false result (already gone) still clears it locally — the
 *  unlinkEvidence posture. */
export async function deleteReviewSelection(itemId: string): Promise<void> {
  if (!state.detail || state.detail.status === 'ready') return
  const token = openToken
  try {
    await window.api.deleteEvidenceSelection(itemId)
    if (token !== openToken) return
    const detail = state.detail
    if (!detail) return
    const items = detail.items.filter((i) => i.id !== itemId)
    setState({ detail: { ...detail, items, gate: computeReadyGate(items) } })
  } catch (e) {
    if (token !== openToken) return
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  }
}

// ---- Conservative bulk actions (spec §14.4) --------------------------------------------
// Exactly the three sanctioned actions. There is deliberately NO "mark all supported" —
// a blanket supported-claim is the one bulk action the spec forbids (tested).

/** Set every heading block whose decision differs to Not applicable. */
export function bulkMarkHeadingsNotApplicable(): void {
  const detail = state.detail
  if (!detail) return
  for (const item of detail.items) {
    if (item.kind === 'block' && item.blockKind === 'heading' && item.decision !== 'not_applicable') {
      editReviewItem(item.id, { decision: 'not_applicable' })
    }
  }
}

/** Reset EVERY decision to Not reviewed (notes are kept). */
export function bulkClearDecisions(): void {
  const detail = state.detail
  if (!detail) return
  for (const item of detail.items) {
    if (item.decision !== 'not_reviewed') {
      editReviewItem(item.id, { decision: 'not_reviewed' })
    }
  }
}

/** Move every still-undecided item to Needs follow-up. */
export function bulkMarkUndecidedFollowUp(): void {
  const detail = state.detail
  if (!detail) return
  for (const item of detail.items) {
    if (item.decision === 'not_reviewed') {
      editReviewItem(item.id, { decision: 'follow_up' })
    }
  }
}

/** The decisions a bulk action may WRITE (guard rail mirrored by tests): never 'supported'. */
export const BULK_WRITABLE_DECISIONS: readonly ReviewDecision[] = [
  'not_applicable',
  'not_reviewed',
  'follow_up'
]

/**
 * Drop the resident review content at the workspace-lock seam (lockPurge.ts). Does NOT
 * flush — `App.lockNow` awaits `flushReviewSession()` BEFORE `lockWorkspace()` (while the
 * vault is still writable); by purge time main has already re-encrypted.
 */
export function purgeReviewSession(): void {
  openToken += 1
  clearTimer()
  pendingItems = new Map()
  pendingHead = null
  flushInFlight = null
  state = INITIAL
  notify()
}

/** Test-only: drop module state AND listeners between renderer tests. */
export function resetReviewSessionForTests(): void {
  purgeReviewSession()
  listeners.clear()
}
