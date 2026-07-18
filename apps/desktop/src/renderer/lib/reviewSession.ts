import type {
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewDetail,
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
}

const INITIAL: ReviewSessionState = {
  detail: null,
  loading: false,
  openError: null,
  saveState: 'idle',
  saveError: null
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
  } catch (e) {
    if (token !== openToken) return
    setState({ loading: false, openError: { kind: 'failed', message: friendlyIpcError(e) } })
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

/** Record an item edit: optimistic apply + pending patch + debounce. */
export function editReviewItem(itemId: string, patch: EvidenceReviewItemPatch): void {
  if (!state.detail) return
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
 * Flush all pending patches now. Awaits an in-flight flush first (stable write order),
 * then drains whatever is pending at that point. Loss-free: see the module header.
 */
export async function flushReviewSession(): Promise<void> {
  if (flushInFlight) await flushInFlight
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
      if (updated == null) {
        // Unknown id — the item (or review) is gone underneath us. The patch is
        // unsaveable; dropping it is the honest outcome (retrying forever would not
        // resurrect the row). Surfaced as a save error.
        staleHandle = true
      }
    } catch (e) {
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
      if (updated == null) staleHandle = true
    } catch (e) {
      failed = true
      pendingHead = { ...head, ...(pendingHead ?? {}) }
      if (state.saveError == null) setState({ saveError: friendlyIpcError(e) })
    }
  }
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
 * Mirror of the main-side D-7 ready gate (`deriveReadyGate`) for LIVE progress while edits
 * are still optimistic: required = non-heading BLOCK items (NULL/unknown kind counts as
 * required — the safe direction), decided = any decision other than 'not_reviewed'
 * ('not_applicable' counts as decided). Selections never gate. The AUTHORITATIVE gate for
 * the ready transition itself comes back from `markEvidenceReviewReady` (main recomputes
 * from persisted rows).
 */
export function computeReadyGate(items: readonly EvidenceReviewItem[]): EvidenceReadyGate {
  let requiredTotal = 0
  let decidedTotal = 0
  for (const item of items) {
    if (item.kind !== 'block' || item.blockKind === 'heading') continue
    requiredTotal += 1
    if (item.decision !== 'not_reviewed') decidedTotal += 1
  }
  return { eligible: decidedTotal >= requiredTotal, requiredTotal, decidedTotal }
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
  await flushReviewSession()
  if (state.saveState === 'error') return { outcome: 'failed' }
  try {
    const result = await window.api.markEvidenceReviewReady(reviewId)
    if (!result) {
      setState({ saveState: 'error', saveError: null })
      return { outcome: 'failed' }
    }
    mergeHead(result.review, result.gate)
    return result.review.status === 'ready'
      ? { outcome: 'ready' }
      : { outcome: 'ineligible', gate: result.gate }
  } catch (e) {
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
    return { outcome: 'failed' }
  }
}

/** Reopen a ready review to draft (spec §18.4). */
export async function reopenReview(): Promise<boolean> {
  const reviewId = state.detail?.id
  if (!reviewId) return false
  try {
    const review = await window.api.reopenEvidenceReview(reviewId)
    if (!review) return false
    mergeHead(review)
    return true
  } catch (e) {
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
  const detail = state.detail
  if (!detail) return
  try {
    const updated = await window.api.setEvidenceLink(itemId, evidenceKey, {
      origin: 'reviewer',
      relation
    })
    if (updated == null) {
      setState({ saveState: 'error', saveError: null })
      return
    }
    const items = detail.items.map((i) => (i.id === itemId ? updated : i))
    setState({ detail: { ...detail, items } })
  } catch (e) {
    setState({ saveState: 'error', saveError: friendlyIpcError(e) })
  }
}

/** Remove one item→source link. A false result (already gone) still clears it locally. */
export async function unlinkEvidence(itemId: string, evidenceKey: string): Promise<void> {
  const detail = state.detail
  if (!detail) return
  try {
    await window.api.removeEvidenceLink(itemId, evidenceKey)
    const items = detail.items.map((i) =>
      i.id === itemId ? { ...i, links: i.links.filter((l) => l.evidenceKey !== evidenceKey) } : i
    )
    setState({ detail: { ...state.detail!, items } })
  } catch (e) {
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
