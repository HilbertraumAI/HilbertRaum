// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  EvidenceExportRecord,
  EvidenceReviewBulkAction,
  EvidenceReviewDetail,
  EvidenceReviewFreshness,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  ReviewDecision
} from '../../src/shared/types'
import {
  REVIEW_SAVE_DEBOUNCE_MS,
  acknowledgeReviewFreshness,
  addReviewSelection,
  bulkClearDecisions,
  bulkMarkHeadingsNotApplicable,
  bulkMarkUndecidedFollowUp,
  deleteReviewSelection,
  discardAndSwitch,
  editReviewHead,
  editReviewItem,
  exportReviewPack,
  flushReviewSession,
  getReviewSessionSnapshot,
  linkEvidence,
  markReviewReady,
  openReviewSession,
  purgeReviewSession,
  reopenReview,
  retryBlockedSwitch,
  retryReviewSave,
  type ReviewExportOutcome,
  type ReviewHandoffTarget
} from '../../src/renderer/lib/reviewSession'

import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { deferred, type Deferred } from '../helpers/deferred'
import {
  bulkBackend,
  makeDetail,
  makeFreshness,
  makeItem,
  makeReviewHead,
  stubReviewApi
} from '../helpers/evidenceReview'

// EP-1 plan §7.5 — the reviewSession module store: the repo's FIRST debounced auto-save.
// Pins the contract the plan demands: debounce batches related writes (spec §26), the
// flush is loss-free under rapid edits (edits landing mid-flight are never dropped and a
// failed write re-merges UNDER newer values), a hard flush runs on demand (screen exit /
// pre-lock). The D-7 gate mirror's equivalence with main's deriveReadyGate is pinned in
// tests/unit/evidence-review-gate.test.ts (FIX-4).

async function openWith(detail: EvidenceReviewDetail): Promise<void> {
  await openReviewSession({ reviewId: detail.id })
  expect(getReviewSessionSnapshot().detail?.id).toBe(detail.id)
}

/** A recorded export, as `evidence:export` returns it (data-contracts "Evidence Pack" P3). */
const EXPORT_RECORD: EvidenceExportRecord = {
  id: 'x1',
  reviewId: 'r1',
  format: 'html',
  schemaVersion: 1,
  fileName: 'pack.html',
  fileSha256: 'aa'.repeat(32),
  options: null,
  createdAt: '2026-07-18T12:00:00.000Z'
}

beforeEach(() => {
  purgeReviewSession()
  // #832: a fresh stub set (and fresh bookkeeping) per test; every row then installs its own.
  stubReviewApi()
})

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    vi.useRealTimers()
    purgeReviewSession()
  }
})

describe('reviewSession — open', () => {
  it('opens by reviewId via getEvidenceReview; null → notFound (never a throw)', async () => {
    const detail = makeDetail()
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r1' ? detail : null))
    stubReviewApi({ getEvidenceReview })
    await openWith(detail)
    expect(getEvidenceReview).toHaveBeenCalledWith('r1')

    await openReviewSession({ reviewId: 'gone' })
    const s = getReviewSessionSnapshot()
    expect(s.detail).toBeNull()
    expect(s.openError).toEqual({ kind: 'notFound' })
  })

  it('opens by messageId via the IDEMPOTENT create; a create rejection surfaces friendly copy', async () => {
    const detail = makeDetail()
    stubReviewApi({ createEvidenceReview: vi.fn(async () => detail) })
    await openReviewSession({ messageId: 'm1' })
    expect(getReviewSessionSnapshot().detail?.id).toBe('r1')

    // The re-install below resets the unmocked-call record: check the first leg before it.
    assertNoUnexpectedApiCalls()
    stubReviewApi({
      createEvidenceReview: vi.fn(async () => {
        throw new Error("Error invoking remote method 'evidence:create': Error: This review request is not valid.")
      })
    })
    purgeReviewSession()
    await openReviewSession({ messageId: 'nope' })
    const s = getReviewSessionSnapshot()
    expect(s.openError).toEqual({ kind: 'failed', message: 'This review request is not valid.' })
  })

  // #839 U2a: the switch path lands the previous review's queued edit before it reads the next one.
  it('a switch writes the open review’s queued edit BEFORE it reads the next review', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const order: string[] = []
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async (id: string) => {
      order.push(`get:${id}`)
      return id === 'r2' ? second : first
    })
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    order.length = 0

    editReviewItem('i1', { decision: 'supported' }) // still inside the debounce window
    await openReviewSession({ reviewId: 'r2' })
    expect(order).toEqual(['item:i1', 'get:r2'])
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', { decision: 'supported' })
    expect(getReviewSessionSnapshot().detail).toEqual(second)
  })

  // #839 U2i: the open path's own token guard (a slow read of r1 must not replace r2).
  it('an open of r1 that resolves AFTER r2 was opened never replaces r2', async () => {
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const read1 = deferred<EvidenceReviewDetail | null>()
    const getEvidenceReview = vi.fn((id: string) => (id === 'r1' ? read1.promise : Promise.resolve(second)))
    stubReviewApi({ getEvidenceReview })
    const opening1 = openReviewSession({ reviewId: 'r1' })
    await vi.waitFor(() => expect(getEvidenceReview).toHaveBeenCalledWith('r1'))
    await openReviewSession({ reviewId: 'r2' })
    expect(getReviewSessionSnapshot().detail).toEqual(second)

    read1.resolve(makeDetail())
    await opening1
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: second, loading: false, openError: null })
  })
})

// #837: a write that fails (in practice a disk or SQLite I/O failure) leaves its patch queued with the save-error line
// showing. Nothing that runs after a flush may then drop that patch or hide the error: a switch to ANOTHER review is
// refused with a choice (Try again / Discard changes and open / Back), re-opening the SAME review keeps the edit on
// screen, and a bulk sweep is refused (see the bulk describe below).
describe('reviewSession — a switch never runs over a failed save (#837)', () => {
  /** r1 (titled, so the refusal can name it) and r2, a decision edit on r1 whose write fails while `fail.on`. */
  async function failedEditOnR1(): Promise<{
    second: EvidenceReviewDetail
    order: string[]
    fail: { on: boolean }
    getEvidenceReview: ReturnType<typeof vi.fn>
    updateEvidenceReviewItem: ReturnType<typeof vi.fn>
  }> {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const order: string[] = []
    const fail = { on: true }
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      if (fail.on) throw new Error("Error invoking remote method 'evidence:updateItem': Error: disk I/O error")
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async (id: string) => {
      order.push(`get:${id}`)
      return id === 'r2' ? second : first
    })
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot()).toMatchObject({ saveState: 'error', saveError: 'disk I/O error' })
    return { second, order, fail, getEvidenceReview, updateEvidenceReviewItem }
  }

  it('a switch to another review is refused: r1 stays open with its edit and its error, r2 is not read', async () => {
    const { getEvidenceReview, updateEvidenceReviewItem } = await failedEditOnR1()
    const writes = updateEvidenceReviewItem.mock.calls.length
    await openReviewSession({ reviewId: 'r2' })
    // ONE retry by the switch's flush, then the failure stands until the user acts: the further flush passes are only
    // for edits that landed mid-write (each failed write can hold the app for the database's 5 s busy wait).
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(writes + 1)
    const s = getReviewSessionSnapshot()
    expect(s.openError).toEqual({ kind: 'unsaved', title: 'Lease check', target: { reviewId: 'r2' } })
    expect(s.detail?.id).toBe('r1')
    expect(s.detail?.items[0]?.decision).toBe('supported')
    expect(s).toMatchObject({ loading: false, saveState: 'error', saveError: 'disk I/O error' })
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  it('Try again keeps refusing while the write fails, then saves the edit BEFORE it reads r2', async () => {
    const { second, order, fail, getEvidenceReview } = await failedEditOnR1()
    await openReviewSession({ reviewId: 'r2' })

    await retryBlockedSwitch()
    expect(getReviewSessionSnapshot().openError).toMatchObject({ kind: 'unsaved', target: { reviewId: 'r2' } })
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')

    fail.on = false
    order.length = 0
    await retryBlockedSwitch()
    expect(order).toEqual(['item:i1', 'get:r2'])
    expect(getReviewSessionSnapshot()).toMatchObject({
      detail: second,
      openError: null,
      saveState: 'idle',
      saveError: null
    })
  })

  it('Discard changes and open drops the unsaved edit and opens r2 without writing it again', async () => {
    const { second, updateEvidenceReviewItem } = await failedEditOnR1()
    await openReviewSession({ reviewId: 'r2' })
    const writes = updateEvidenceReviewItem.mock.calls.length

    await discardAndSwitch()
    expect(getReviewSessionSnapshot()).toMatchObject({
      detail: second,
      openError: null,
      saveState: 'idle',
      saveError: null
    })
    await flushReviewSession()
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(writes)
  })

  // Found in the real dev app (React StrictMode runs the screen's exit-flush cleanup once more on mount): a flush started
  // by ANOTHER caller while the switch waits takes the failed patch off the queue while it writes. The switch must wait
  // that write out before it decides, or it resets, and the late failure is then dropped under the new token.
  it('a second flush running when the switch decides still holds the failed edit: the switch waits for it and refuses', async () => {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const held: Array<Deferred<EvidenceReviewItem>> = []
    const updateEvidenceReviewItem = vi.fn(() => {
      const write = deferred<EvidenceReviewItem>()
      held.push(write)
      return write.promise
    })
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    editReviewItem('i1', { decision: 'supported' })

    const exitFlush = flushReviewSession() // the old screen's exit flush: write 1
    const switching = openReviewSession({ reviewId: 'r2' }) // waits for write 1
    const secondFlush = flushReviewSession() // another flush caller, also waiting
    held[0]!.reject(new Error('disk I/O error'))
    await vi.waitFor(() => expect(held).toHaveLength(2)) // the switch's own retry
    held[1]!.reject(new Error('disk I/O error'))
    await vi.waitFor(() => expect(held).toHaveLength(3)) // the other caller's retry, in flight as the switch decides
    held[2]!.reject(new Error('disk I/O error'))
    await Promise.all([exitFlush, switching, secondFlush])

    const s = getReviewSessionSnapshot()
    expect(s.openError).toMatchObject({ kind: 'unsaved', target: { reviewId: 'r2' } })
    expect(s.detail?.id).toBe('r1')
    expect(s.detail?.items[0]?.decision).toBe('supported')
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  // Review round 1: a failed HEAD edit (title, reviewer label, general note) is as unsaved as an item edit.
  it('a failed HEAD edit (general note) blocks the switch like an item edit, and stays on screen', async () => {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    stubReviewApi({
      getEvidenceReview,
      updateEvidenceReview: vi.fn(async () => {
        throw new Error('disk I/O error')
      })
    })
    await openWith(first)
    editReviewHead({ generalNote: 'Checked with the landlord.' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot().saveState).toBe('error')

    await openReviewSession({ reviewId: 'r2' })
    const s = getReviewSessionSnapshot()
    expect(s.openError).toEqual({ kind: 'unsaved', title: 'Lease check', target: { reviewId: 'r2' } })
    expect(s.detail).toMatchObject({ id: 'r1', generalNote: 'Checked with the landlord.' })
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  // Review round 1: Discard waits for a write in flight; a lock (purge) landing during that wait ends the refusal, and
  // Discard must then open nothing — the switch it was asked for belongs to a workspace that is now locked.
  // Review round 3 (verified by probe): the switch's flush loop awaits writes; a lock (purge) landing during one of them
  // must end the switch — it used to go on and load the target into the purged store.
  it('a lock landing while the switch’s flush is writing loads nothing: the purged store stays empty', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const write = deferred<EvidenceReviewItem>()
    const updateEvidenceReviewItem = vi.fn(() => write.promise)
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    editReviewItem('i1', { decision: 'supported' })

    const switching = openReviewSession({ reviewId: 'r2' })
    await vi.waitFor(() => expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)) // the switch's flush writes i1…
    purgeReviewSession() // …when the lock lands
    write.resolve(makeItem({ id: 'i1', decision: 'supported' }))
    await switching
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, loading: false, openError: null, saveState: 'idle' })
  })

  it('a lock landing while Discard waits for a write leaves the purged store empty and reads nothing', async () => {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const held: Array<Deferred<EvidenceReviewItem>> = []
    const updateEvidenceReviewItem = vi.fn(() => {
      const write = deferred<EvidenceReviewItem>()
      held.push(write)
      return write.promise
    })
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    editReviewItem('i1', { decision: 'supported' })
    const failing = flushReviewSession()
    held[0]!.reject(new Error('disk I/O error'))
    await failing
    const refusing = openReviewSession({ reviewId: 'r2' })
    await vi.waitFor(() => expect(held).toHaveLength(2))
    held[1]!.reject(new Error('disk I/O error'))
    await refusing
    expect(getReviewSessionSnapshot().openError?.kind).toBe('unsaved')

    const writing = flushReviewSession() // a write in flight (e.g. the old screen's exit flush)…
    await vi.waitFor(() => expect(held).toHaveLength(3))
    const discarding = discardAndSwitch() // …which Discard waits for…
    purgeReviewSession() // …when the lock lands
    held[2]!.reject(new Error('vault sealed'))
    await Promise.all([writing, discarding])
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, openError: null, saveState: 'idle', loading: false })
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  it('Discard pressed while Try again is still writing opens r2: the late failure cannot re-queue the discarded edit', async () => {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const held: Array<Deferred<EvidenceReviewItem>> = []
    const updateEvidenceReviewItem = vi.fn(() => {
      const write = deferred<EvidenceReviewItem>()
      held.push(write)
      return write.promise
    })
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    editReviewItem('i1', { decision: 'supported' })
    const flushing = flushReviewSession()
    held[0]!.reject(new Error('disk I/O error'))
    await flushing
    const refusing = openReviewSession({ reviewId: 'r2' })
    await vi.waitFor(() => expect(held).toHaveLength(2))
    held[1]!.reject(new Error('disk I/O error'))
    await refusing
    expect(getReviewSessionSnapshot().openError?.kind).toBe('unsaved')

    const retrying = retryBlockedSwitch() // its write is now in flight…
    await vi.waitFor(() => expect(held).toHaveLength(3))
    const discarding = discardAndSwitch() // …when the user discards instead
    held[2]!.reject(new Error('disk I/O error')) // the retry's write fails AFTER the discard was asked for
    await Promise.all([retrying, discarding])
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: second, openError: null })
    await flushReviewSession()
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(3)
  })

  it('after a refused switch, opening the edited review again clears the refusal and shows the edit', async () => {
    const { getEvidenceReview } = await failedEditOnR1()
    await openReviewSession({ reviewId: 'r2' })
    await openReviewSession({ reviewId: 'r1' })
    const s = getReviewSessionSnapshot()
    expect(s.openError).toBeNull()
    expect(s.detail?.items[0]?.decision).toBe('supported')
    expect(s.saveState).toBe('error')
    expect(getEvidenceReview).toHaveBeenCalledTimes(1) // the first open only: no re-read over the edit
  })

  // Not a failure: an edit made while the switch's OWN flush is writing re-arms the debounce. It is saved by one more
  // pass before the next review is read, never refused as "could not be saved" and never dropped by the reset.
  it('an edit made while the switch’s own flush is writing is saved before the next review is read', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const order: string[] = []
    const firstWrite = deferred()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      if (order.length === 1) await firstWrite.promise
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async (id: string) => {
      order.push(`get:${id}`)
      return id === 'r2' ? second : first
    })
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    order.length = 0

    editReviewItem('i1', { decision: 'supported' })
    const switching = openReviewSession({ reviewId: 'r2' })
    await vi.waitFor(() => expect(order).toEqual(['item:i1'])) // the switch's flush is writing i1
    editReviewItem('i2', { decision: 'not_supported' })
    firstWrite.resolve()
    await switching
    expect(order).toEqual(['item:i1', 'item:i2', 'get:r2'])
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: second, openError: null })
  })

  // Review round 2: the switch refuses only when a write FAILED. Edits that keep landing while its flushes write are
  // written by further passes and the switch goes ahead — never the "could not be saved" card when nothing failed.
  it('edits landing through two flush passes are all written, then the switch goes ahead with no refusal', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    const order: string[] = []
    const held: Array<Deferred<void>> = []
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      if (held.length < 2) {
        const write = deferred()
        held.push(write)
        await write.promise
      }
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async (id: string) => {
      order.push(`get:${id}`)
      return id === 'r2' ? second : first
    })
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(first)
    order.length = 0

    editReviewItem('i1', { decision: 'supported' })
    const switching = openReviewSession({ reviewId: 'r2' })
    await vi.waitFor(() => expect(held).toHaveLength(1)) // pass 1 writes i1…
    editReviewItem('i2', { decision: 'not_supported' }) // …while i2 is decided
    held[0]!.resolve()
    await vi.waitFor(() => expect(held).toHaveLength(2)) // pass 2 writes i2…
    editReviewItem('i1', { reviewerNote: 'late note' }) // …while a note lands
    held[1]!.resolve()
    await switching
    expect(order).toEqual(['item:i1', 'item:i2', 'item:i1', 'get:r2'])
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: second, openError: null })
  })

  it.each<[string, ReviewHandoffTarget]>([
    ['its review id', { reviewId: 'r1' }],
    ['its message id', { messageId: 'm1' }]
  ])('re-opening the same review by %s keeps the edit on screen with its error, and reads nothing', async (_how, target) => {
    const detail = makeDetail()
    const getEvidenceReview = vi.fn(async () => detail)
    const createEvidenceReview = vi.fn(async () => detail)
    stubReviewApi({
      getEvidenceReview,
      createEvidenceReview,
      updateEvidenceReviewItem: vi.fn(async () => {
        throw new Error('disk I/O error')
      })
    })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()

    await openReviewSession(target)
    const s = getReviewSessionSnapshot()
    expect(s.detail?.items[0]?.decision).toBe('supported')
    expect(s).toMatchObject({ loading: false, openError: null, saveState: 'error', saveError: 'disk I/O error' })
    expect(getEvidenceReview).toHaveBeenCalledTimes(1)
    expect(createEvidenceReview).not.toHaveBeenCalled()
  })
})

describe('reviewSession — debounced auto-save', () => {
  it('debounces: no IPC before the window, ONE merged write after it', async () => {
    expect(REVIEW_SAVE_DEBOUNCE_MS).toBe(600) // the shipped bound (EP-1 record §3, design-guidelines §11.12), pinned once
    vi.useFakeTimers()
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem
    })
    await openWith(detail)

    editReviewItem('i1', { decision: 'supported' })
    editReviewItem('i1', { reviewerNote: 'checked page 12' })
    // Optimistic read-your-writes, still unsaved:
    const item = getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'i1')!
    expect(item.decision).toBe('supported')
    expect(item.reviewerNote).toBe('checked page 12')
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS - 1)
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled() // just short of the window
    await vi.advanceTimersByTimeAsync(1)
    // ONE call carrying the MERGED patch — related writes batched (spec §26).
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', {
      decision: 'supported',
      reviewerNote: 'checked page 12'
    })
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
  })

  it('is loss-free on rapid edits: an edit landing mid-flush is flushed by the follow-up pass', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    let releaseFirst: (() => void) | null = null
    const updateEvidenceReviewItem = vi.fn(
      (id: string, patch: EvidenceReviewItemPatch) =>
        new Promise<EvidenceReviewItem>((resolve) => {
          const finish = (): void => resolve(makeItem({ id, ...patch }))
          if (releaseFirst == null) releaseFirst = finish
          else finish()
        })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem
    })
    await openWith(detail)

    editReviewItem('i1', { decision: 'supported' })
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)

    // The first write is still awaiting; a NEW edit lands mid-flight.
    editReviewItem('i2', { decision: 'follow_up' })
    releaseFirst!()
    // Await the write the store awaits: its continuation was queued first, so it has run once this resolves.
    await updateEvidenceReviewItem.mock.results[0]!.value
    // i1 is written, i2 is not: the follow-up pass keeps the store "Saving…", never "Saved" over an unwritten edit.
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(2)
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i2', { decision: 'follow_up' })
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
  })

  it('a FAILED write re-merges UNDER newer pending edits (newest wins, nothing lost)', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    let fail = true
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (fail) throw new Error('Error: Workspace is locked.')
      return makeItem({ id, ...patch })
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem
    })
    await openWith(detail)

    editReviewItem('i1', { decision: 'supported', reviewerNote: 'v1' })
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(getReviewSessionSnapshot().saveState).toBe('error')
    expect(getReviewSessionSnapshot().saveError).toBe('Workspace is locked.')

    // A newer note lands AFTER the failure; the failed decision must survive the merge,
    // the older failed note must NOT clobber the newer one.
    editReviewItem('i1', { reviewerNote: 'v2' })
    fail = false
    await flushReviewSession()
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i1', {
      decision: 'supported',
      reviewerNote: 'v2'
    })
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
    expect(getReviewSessionSnapshot().saveError).toBeNull()
  })

  it('head edits (title/reviewer/general note) flush through updateEvidenceReview; empty titles never leave', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    const updateEvidenceReview = vi.fn(async () => ({ ...detail }))
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReview
    })
    await openWith(detail)

    editReviewHead({ title: '   ' }) // ignored — the service refuses empty renames too
    editReviewHead({ reviewerLabel: 'QA', generalNote: 'looks fine' })
    expect(getReviewSessionSnapshot().detail?.title).toBe('Evidence review')
    await flushReviewSession()
    expect(updateEvidenceReview).toHaveBeenCalledTimes(1)
    expect(updateEvidenceReview).toHaveBeenCalledWith('r1', {
      reviewerLabel: 'QA',
      generalNote: 'looks fine'
    })
  })
})

describe('reviewSession — mark ready', () => {
  it('markReviewReady FLUSHES first, then maps the {review, gate} result honestly', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    const order: string[] = []
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push('update')
      return makeItem({ id, ...patch })
    })
    const markEvidenceReviewReady = vi.fn(async () => {
      order.push('markReady')
      return {
        review: makeReviewHead({ id: detail.id, status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' }),
        gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
      }
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      markEvidenceReviewReady
    })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    editReviewItem('i2', { decision: 'not_applicable' })
    const result = await markReviewReady()
    expect(order).toEqual(['update', 'update', 'markReady'])
    expect(result.outcome).toBe('ready')
    expect(getReviewSessionSnapshot().detail?.status).toBe('ready')
  })

  it('an ineligible markReady returns the AUTHORITATIVE gate as guidance, not a failure', async () => {
    const detail = makeDetail()
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      markEvidenceReviewReady: vi.fn(async () => ({
        review: { ...detail, status: 'draft' as const },
        gate: { eligible: false, requiredTotal: 2, decidedTotal: 1 }
      }))
    })
    await openWith(detail)
    const result = await markReviewReady()
    expect(result).toEqual({
      outcome: 'ineligible',
      gate: { eligible: false, requiredTotal: 2, decidedTotal: 1 }
    })
    expect(getReviewSessionSnapshot().detail?.status).toBe('draft')
    expect(getReviewSessionSnapshot().detail?.gate.decidedTotal).toBe(1)
  })
})

describe('reviewSession — conservative bulk actions (spec §14.4)', () => {
  /** The three-item fixture every bulk case runs against: a heading, an undecided claim and
   *  an already-decided claim (so "conservative" has something to spare). */
  function bulkItems(): EvidenceReviewItem[] {
    return [
      makeItem({ id: 'h1', blockKind: 'heading', decision: 'not_reviewed' }),
      makeItem({ id: 'p1', blockKind: 'paragraph', decision: 'not_reviewed' }),
      makeItem({ id: 'p2', blockKind: 'paragraph', decision: 'supported' })
    ]
  }

  it('headings→N/A, undecided→follow-up, clear-all — one IPC call per command, never a per-item write', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: backend.spy
    })
    await openWith(detail)
    // These decisions are bulkBackend's (main's predicates): the row proves the store MERGES what main returns. The
    // predicates and the refusal of any other action name belong to evidence-review-batch-ops.

    await bulkMarkHeadingsNotApplicable()
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'h1')!.decision).toBe(
      'not_applicable'
    )
    expect(getReviewSessionSnapshot().saveState).toBe('saved') // carried from the retired 60-item row (AUD-13)
    await bulkMarkUndecidedFollowUp()
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p1')!.decision).toBe(
      'follow_up'
    )
    // p2 was already decided — follow-up must not touch it (conservative).
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe(
      'supported'
    )
    await bulkClearDecisions()
    for (const i of getReviewSessionSnapshot().detail!.items) {
      expect(i.decision).toBe('not_reviewed')
    }
    await flushReviewSession()

    // AUD-13: THREE sweeps over a 3-item review = THREE IPC calls, one per user command —
    // never one per item, and never a per-item write behind the sweep's back.
    expect(backend.spy).toHaveBeenCalledTimes(3)
    expect(backend.spy.mock.calls.map((c) => c[1])).toEqual([
      'headings_not_applicable',
      'undecided_follow_up',
      'clear_decisions'
    ])
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
  })

  it('flushes pending per-item edits BEFORE the sweep, so a queued decision cannot undo it', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const order: string[] = []
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      return makeItem({ id, ...patch })
    })
    const bulkSpy = vi.fn(async (reviewId: string, action: EvidenceReviewBulkAction) => {
      order.push(`bulk:${action}`)
      return backend.spy(reviewId, action)
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: bulkSpy
    })
    await openWith(detail)

    // A still-debounced per-item decision, then the sweep: the queued write must land FIRST
    // (otherwise it would flush later and silently revert part of the sweep).
    editReviewItem('p1', { decision: 'supported' })
    await bulkClearDecisions()
    expect(order).toEqual(['item:p1', 'bulk:clear_decisions'])
    for (const i of getReviewSessionSnapshot().detail!.items) {
      expect(i.decision).toBe('not_reviewed')
    }
  })

  it('a REFUSED sweep (null) surfaces a save error and never claims "saved"', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      applyEvidenceReviewBulkAction: vi.fn(async () => null)
    })
    await openWith(detail)
    await bulkClearDecisions()
    expect(getReviewSessionSnapshot().saveState).toBe('error')
  })

  // #837 part 2: the sweep used to run over a failed save: it cleared the error, showed "Saving…" for good, and the failed
  // decision was written AFTER the sweep, so the database got back what the screen showed as cleared.
  it.each<[string, EvidenceReviewItemPatch]>([
    ['a decision', { decision: 'not_supported' }],
    ['a note', { reviewerNote: 'checked against page 4' }]
  ])('a bulk action after a failed save of %s is refused: the error stays, no sweep is sent, nothing lands after one (#837)', async (_what, patch) => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const order: string[] = []
    let fail = true
    const updateEvidenceReviewItem = vi.fn(async (id: string, written: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      if (fail) throw new Error('disk I/O error')
      return makeItem({ id, ...written })
    })
    const bulkSpy = vi.fn(async (reviewId: string, action: EvidenceReviewBulkAction) => {
      order.push(`bulk:${action}`)
      return backend.spy(reviewId, action)
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: bulkSpy
    })
    await openWith(detail)
    editReviewItem('p1', patch)
    await flushReviewSession()

    await bulkClearDecisions()
    expect(bulkSpy).not.toHaveBeenCalled()
    const s = getReviewSessionSnapshot()
    expect(s).toMatchObject({ saveState: 'error', saveError: 'disk I/O error' })
    expect(s.detail!.items.find((i) => i.id === 'p1')).toMatchObject(patch)

    // The disk recovers: Try again saves the edit, and a sweep run now is the last word.
    fail = false
    await retryReviewSave()
    await bulkClearDecisions()
    await flushReviewSession()
    expect(order.filter((step) => step.startsWith('bulk:'))).toEqual(['bulk:clear_decisions'])
    expect(order.at(-1)).toBe('bulk:clear_decisions')
    for (const i of getReviewSessionSnapshot().detail!.items) {
      expect(i.decision).toBe('not_reviewed')
    }
  })

  // #837 (B §1.1 finding 4; review round 2): a decision made while the pre-sweep flush is still writing re-arms the
  // debounce. The rule: what was queued when the sweep was asked for is written FIRST and swept; a decision made after
  // that is newer than the sweep, so it is neither swept on screen nor refused silently — the sweep runs, the decision
  // stays on screen, and its queued write is the last word (screen and database agree).
  it('a decision made while the pre-sweep flush is writing does not stop the sweep: it stays on screen and is written after it', async () => {
    vi.useFakeTimers()
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const order: string[] = []
    const firstWrite = deferred()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      if (order.length === 1) await firstWrite.promise
      return makeItem({ id, ...patch })
    })
    const bulkSpy = vi.fn(async (reviewId: string, action: EvidenceReviewBulkAction) => {
      order.push(`bulk:${action}`)
      return backend.spy(reviewId, action)
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: bulkSpy
    })
    await openWith(detail)

    editReviewItem('p1', { decision: 'supported' })
    const sweeping = bulkClearDecisions() // its flush is now writing p1
    expect(order).toEqual(['item:p1'])
    editReviewItem('p2', { decision: 'not_supported' }) // lands mid-write
    firstWrite.resolve()
    await sweeping
    expect(order).toEqual(['item:p1', 'bulk:clear_decisions']) // the sweep ran
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe('not_supported')
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10) // the debounced write of p2
    expect(order).toEqual(['item:p1', 'bulk:clear_decisions', 'item:p2'])
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('p2', { decision: 'not_supported' })
    const decisions = Object.fromEntries(getReviewSessionSnapshot().detail!.items.map((i) => [i.id, i.decision]))
    expect(decisions).toEqual({ h1: 'not_reviewed', p1: 'not_reviewed', p2: 'not_supported' })
  })

  // Review round 2: the sweep, like the switch, waits out a flush another caller has in flight before it decides — that
  // write holds its patch off the queue, so without the wait a failure landing after it would be swept over.
  it('a second flush running when the sweep decides still holds the failed edit: the sweep waits for it and refuses', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const held: Array<Deferred<EvidenceReviewItem>> = []
    const updateEvidenceReviewItem = vi.fn(() => {
      const write = deferred<EvidenceReviewItem>()
      held.push(write)
      return write.promise
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: backend.spy
    })
    await openWith(detail)
    editReviewItem('p1', { decision: 'not_supported' })

    const exitFlush = flushReviewSession() // write 1
    const sweeping = bulkClearDecisions() // waits for write 1
    const secondFlush = flushReviewSession() // another flush caller, also waiting
    held[0]!.reject(new Error('disk I/O error'))
    await vi.waitFor(() => expect(held).toHaveLength(2)) // the sweep's own flush
    held[1]!.reject(new Error('disk I/O error'))
    await vi.waitFor(() => expect(held).toHaveLength(3)) // the other caller's retry, in flight as the sweep decides
    held[2]!.reject(new Error('disk I/O error'))
    await Promise.all([exitFlush, sweeping, secondFlush])

    expect(backend.spy).not.toHaveBeenCalled()
    expect(getReviewSessionSnapshot().saveState).toBe('error')
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p1')!.decision).toBe('not_supported')
  })

  // Review round 2: only an edit a failed write left unsaved blocks a sweep — not any error (a failed acknowledge,
  // link, selection or an earlier sweep leaves nothing queued).
  it('a failed acknowledge with nothing queued does not block a bulk action', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      acknowledgeEvidenceReviewFreshness: vi.fn(async () => {
        throw new Error('db gone')
      }),
      applyEvidenceReviewBulkAction: backend.spy
    })
    await openWith(detail)
    expect(await acknowledgeReviewFreshness()).toBe(false)
    expect(getReviewSessionSnapshot().saveState).toBe('error')

    await bulkClearDecisions()
    expect(backend.spy).toHaveBeenCalledTimes(1)
    for (const i of getReviewSessionSnapshot().detail!.items) {
      expect(i.decision).toBe('not_reviewed')
    }
  })

  // ---- Review round 4: ONE write lane ----
  // Item writes used to run CONCURRENTLY with a sweep, and every rule that tried to reconcile them afterwards missed a
  // case. Now no item flush starts while a sweep's call is in flight (it waits for the sweep to settle), so at the
  // merge no item write is in flight, and the merge rule is exact: an item keeps its local decision iff a decision patch
  // for it is still QUEUED (it will be written after the sweep); otherwise the sweep's value is the truth. These rows
  // run against a main stand-in that PERSISTS both write paths in arrival order, and end by checking the screen against
  // it: equal, or a visible error — and never a save line stuck on "Saving…".

  /** Main's persisted decisions, item writes and sweeps applied in arrival order. `holdNext*` parks the next call of
   *  that kind until the returned gate resolves; `failNextItemWrite` makes the next item write reject. */
  function persistingMain(items: readonly EvidenceReviewItem[]) {
    const db = new Map(items.map((i) => [i.id, i.decision]))
    const order: string[] = []
    let holdItem: Deferred<void> | null = null
    let holdBulk: Deferred<void> | null = null
    let failItem = false
    let failBulk: 'throw' | 'null' | null = null
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}`)
      const gate = holdItem
      holdItem = null
      if (gate) await gate.promise
      if (failItem) {
        failItem = false
        throw new Error('disk I/O error')
      }
      if (patch.decision !== undefined) db.set(id, patch.decision)
      return makeItem({ id, decision: db.get(id)! })
    })
    const applyEvidenceReviewBulkAction = vi.fn(async (_reviewId: string, action: EvidenceReviewBulkAction) => {
      order.push(`bulk:${action}`)
      const gate = holdBulk
      holdBulk = null
      if (gate) await gate.promise
      const fail = failBulk
      failBulk = null
      if (fail === 'throw') throw new Error('disk I/O error')
      if (fail === 'null') return null // refused: nothing persisted
      for (const item of items) {
        const now = db.get(item.id)!
        if (action === 'clear_decisions' && now !== 'not_reviewed') db.set(item.id, 'not_reviewed')
        if (action === 'headings_not_applicable' && item.blockKind === 'heading') db.set(item.id, 'not_applicable')
        if (action === 'undecided_follow_up' && now === 'not_reviewed') db.set(item.id, 'follow_up')
      }
      return items.map((i) => ({ ...i, decision: db.get(i.id)! }))
    })
    return {
      db,
      order,
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction,
      holdNextItem(): Deferred<void> {
        holdItem = deferred()
        return holdItem
      },
      holdNextBulk(): Deferred<void> {
        holdBulk = deferred()
        return holdBulk
      },
      failNextItemWrite(): void {
        failItem = true
      },
      /** The next sweep persists NOTHING and rejects ('throw') or is refused ('null'). */
      failNextBulk(kind: 'throw' | 'null'): void {
        failBulk = kind
      }
    }
  }

  /** The screen tells the truth: not stuck on "Saving…", and every decision equals the persisted one unless a save
   *  error is showing (the error line + Try again). */
  function expectTruthful(db: Map<string, ReviewDecision>): void {
    const s = getReviewSessionSnapshot()
    expect(s.saveState).not.toBe('pending')
    if (s.saveState === 'error') return
    expect(Object.fromEntries(s.detail!.items.map((i) => [i.id, i.decision]))).toEqual(Object.fromEntries(db))
  }

  // Review round 4 (1): a timer flush already writing at the click; a decision made after the click is drained by the
  // sweep's own pre-sweep flush and written BEFORE the sweep, so main sweeps over it. The screen must show that.
  it('a decision written before the sweep (order item:p1, item:h1, bulk) shows the swept value, as main has it', async () => {
    vi.useFakeTimers()
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)

    editReviewItem('p1', { decision: 'supported' })
    const p1Write = main.holdNextItem()
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10) // the timer's flush is writing p1…
    expect(main.order).toEqual(['item:p1'])
    const sweeping = bulkClearDecisions() // …when the user clicks Clear all decisions
    editReviewItem('h1', { decision: 'not_applicable' }) // decided after the click
    p1Write.resolve()
    await sweeping
    expect(main.order).toEqual(['item:p1', 'item:h1', 'bulk:clear_decisions'])
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(main.db.get('h1')).toBe('not_reviewed')
    expectTruthful(main.db)
  })

  // Review round 4 (round-3 probe): a decision made during the pre-sweep flush waits for its debounce; that timer
  // fires while the sweep's call is in flight. Its write now waits for the sweep, so it lands after it.
  it('a debounce that fires while the sweep is in flight writes after the sweep: the decision wins on screen and in main', async () => {
    vi.useFakeTimers()
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)

    editReviewItem('p1', { decision: 'supported' })
    const p1Write = main.holdNextItem()
    const sweep = main.holdNextBulk()
    const sweeping = bulkClearDecisions() // its flush is writing p1
    editReviewItem('p2', { decision: 'not_supported' }) // decided after the click
    p1Write.resolve()
    await vi.advanceTimersByTimeAsync(0) // the sweep's call goes out and waits
    expect(main.order).toEqual(['item:p1', 'bulk:clear_decisions'])
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10) // p2's debounce fires mid-sweep…
    expect(main.order).toEqual(['item:p1', 'bulk:clear_decisions']) // …and its write waits for the sweep
    sweep.resolve()
    await sweeping
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(main.order).toEqual(['item:p1', 'bulk:clear_decisions', 'item:p2'])
    expect(main.db.get('p2')).toBe('not_supported')
    expectTruthful(main.db)
  })

  // Review round 4 (2): that after-click decision's write FAILS. It used to fail during the sweep, and the sweep's merge
  // then cleared the error and left "Saving…" with nothing scheduled. Now the failure lands after the sweep: the error
  // line and Try again show, the screen keeps the local decision, and nothing claims "saved".
  it('an after-click decision whose write fails after the sweep shows the error and Try again, never "Saving…" for good', async () => {
    vi.useFakeTimers()
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)

    editReviewItem('p1', { decision: 'supported' })
    const p1Write = main.holdNextItem()
    const sweep = main.holdNextBulk()
    const sweeping = bulkClearDecisions()
    editReviewItem('p2', { decision: 'not_supported' }) // decided after the click
    p1Write.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(main.order).toEqual(['item:p1', 'bulk:clear_decisions'])
    main.failNextItemWrite() // p2's write will fail
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    sweep.resolve()
    await sweeping
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    const s = getReviewSessionSnapshot()
    expect(s).toMatchObject({ saveState: 'error', saveError: 'disk I/O error' })
    expect(s.detail!.items.find((i) => i.id === 'p2')!.decision).toBe('not_supported')
    expect(main.db.get('p2')).toBe('not_reviewed') // swept; the failed write never landed
    expectTruthful(main.db)

    await retryReviewSave() // Try again, with the disk back
    expect(main.db.get('p2')).toBe('not_supported')
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
    expectTruthful(main.db)
  })

  // Review round 4 (B, the other half of the rule): an item with nothing queued takes what main's sweep returned, even
  // where the screen's optimistic guess was different (here the screen was stale: main already had p1 decided).
  it('an item with nothing queued shows what main swept, even where the screen guessed differently', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items }) // the screen shows p1 undecided…
    const main = persistingMain(items)
    main.db.set('p1', 'supported') // …but main has it decided
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)
    await bulkMarkUndecidedFollowUp()
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p1')!.decision).toBe('supported')
    expectTruthful(main.db)
  })

  // Review round 4 (C): the sweep's merge never clears an error that landed while it ran. Under the one write lane no
  // item write can fail meanwhile, but an acknowledge can: its error line must survive the sweep's success.
  it('an error that lands while the sweep runs is still showing after the sweep succeeds', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction,
      acknowledgeEvidenceReviewFreshness: vi.fn(async () => {
        throw new Error('db gone')
      })
    })
    await openWith(detail)

    const sweep = main.holdNextBulk()
    const sweeping = bulkClearDecisions()
    await vi.waitFor(() => expect(main.applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
    expect(await acknowledgeReviewFreshness()).toBe(false) // fails while the sweep is in flight
    sweep.resolve()
    await sweeping
    expect(getReviewSessionSnapshot()).toMatchObject({ saveState: 'error', saveError: 'db gone' })
    expect(Object.fromEntries(getReviewSessionSnapshot().detail!.items.map((i) => [i.id, i.decision]))).toEqual(
      Object.fromEntries(main.db)
    )
  })

  // Review round 5 (1, verified by running): a sweep that FAILS (rejects, or main refuses it with null) persisted
  // nothing, but its optimistic apply stayed on screen; a later item save then reported "Saved" over swept values the
  // database never got. Now the swept items with nothing queued go back to their pre-sweep decisions, an item decided
  // during the call keeps it (its write lands after), and the error line stays until the user acts.
  it.each<['throw' | 'null']>([['throw'], ['null']])(
    'a sweep that fails (%s) is undone on screen: with an edit during the call and one after, the screen ends equal to main',
    async (kind) => {
      vi.useFakeTimers()
      // Two decided paragraphs, so the sweep replaces both: one is changed again during the call, one is not.
      const items = [
        makeItem({ id: 'h1', blockKind: 'heading', decision: 'not_reviewed' }),
        makeItem({ id: 'p1', blockKind: 'paragraph', decision: 'supported' }),
        makeItem({ id: 'p2', blockKind: 'paragraph', decision: 'supported' })
      ]
      const detail = makeDetail({ items })
      const main = persistingMain(items)
      stubReviewApi({
        getEvidenceReview: vi.fn(async () => detail),
        updateEvidenceReviewItem: main.updateEvidenceReviewItem,
        applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
      })
      await openWith(detail)

      const sweep = main.holdNextBulk()
      main.failNextBulk(kind)
      const sweeping = bulkClearDecisions() // optimistic: p1, p2 → not_reviewed
      await vi.advanceTimersByTimeAsync(0)
      expect(main.order).toEqual(['bulk:clear_decisions'])
      editReviewItem('p2', { decision: 'not_supported' }) // decided again during the call
      sweep.resolve()
      await sweeping
      const failed = getReviewSessionSnapshot()
      expect(failed.saveState).toBe('error')
      const shown = Object.fromEntries(failed.detail!.items.map((i) => [i.id, i.decision]))
      expect(shown).toEqual({ h1: 'not_reviewed', p1: 'supported', p2: 'not_supported' }) // p1 back; p2 kept

      await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10) // p2's write lands after the failed sweep…
      expect(main.db.get('p2')).toBe('not_supported')
      expect(getReviewSessionSnapshot().saveState).toBe('error') // …and the sweep's error line stays
      expectTruthful(main.db)

      editReviewItem('h1', { decision: 'not_applicable' }) // the user acts after the failure
      await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
      expect(getReviewSessionSnapshot().saveState).toBe('saved')
      expectTruthful(main.db)
      expect(main.db.get('p1')).toBe('supported') // the failed sweep never touched it
    }
  )

  // Review round 5 (3): a sweep's optimistic apply used to clear an error that was already showing with nothing queued
  // (here a stale-handle drop). That error stays through the sweep; only a later successful save or Try again clears it.
  it('an error already showing with nothing queued (a stale handle) is not cleared by a sweep', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    const sweep = main.holdNextBulk()
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async () => null), // unknown id: the patch is dropped as unsaveable
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)
    editReviewItem('h1', { reviewerNote: 'lost to a stale handle' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot().saveState).toBe('error')

    const sweeping = bulkClearDecisions() // nothing queued, so it runs…
    await vi.waitFor(() => expect(main.applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
    expect(getReviewSessionSnapshot().saveState).toBe('error') // …without clearing the error at its start
    sweep.resolve()
    await sweeping
    expect(getReviewSessionSnapshot().saveState).toBe('error') // nor at its end
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe('not_reviewed')
    expect(main.db.get('p2')).toBe('not_reviewed')
  })

  // Review round 5 (2): the lane had no bound — a sweep (or an item write) whose call never answered kept every
  // waiting flush and open pending forever, so even the lock could not finish. A purge (the lock seam) now releases
  // every wait: nothing pending outlives it, and nothing opens into the purged store.
  it.each<['sweep' | 'item write']>([['sweep'], ['item write']])(
    'after a lock purge, every flush and open that was waiting on a hung %s settles, and nothing loads',
    async (hung) => {
      const items = bulkItems()
      const detail = makeDetail({ items })
      const never = new Promise<never>(() => {})
      const getEvidenceReview = vi.fn(async () => detail)
      const applyEvidenceReviewBulkAction = vi.fn(() => never)
      const updateEvidenceReviewItem = vi.fn(() => never)
      stubReviewApi({ getEvidenceReview, applyEvidenceReviewBulkAction, updateEvidenceReviewItem })
      await openWith(detail)

      const started: Array<Promise<unknown>> = []
      if (hung === 'sweep') {
        started.push(bulkClearDecisions())
        await vi.waitFor(() => expect(applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
        editReviewItem('p1', { decision: 'supported' })
      } else {
        editReviewItem('p1', { decision: 'supported' })
        started.push(flushReviewSession())
        await vi.waitFor(() => expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1))
      }
      started.push(flushReviewSession(), openReviewSession({ reviewId: 'r2' }))
      purgeReviewSession() // the lock
      const outcome = await Promise.race([
        Promise.all(started).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 1000))
      ])
      expect(outcome).toBe('settled')
      expect(getEvidenceReview).toHaveBeenCalledTimes(1) // the first open only: r2 never loaded
      expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, loading: false, saveState: 'idle' })
    }
  )

  // Review round 4 (3): two sweeps must never overlap (the first's merge used to overwrite the second's optimistic
  // values and could claim "saved" while the second was still in flight): a second bulk action while one runs does
  // nothing (the screen disables the trigger meanwhile).
  it('a second bulk action while one is in flight is ignored: one sweep call, a truthful screen', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const main = persistingMain(items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: main.updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: main.applyEvidenceReviewBulkAction
    })
    await openWith(detail)

    const sweep = main.holdNextBulk()
    const first = bulkClearDecisions()
    await vi.waitFor(() => expect(main.applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
    await bulkMarkHeadingsNotApplicable() // the second click
    expect(main.applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1)
    expect(getReviewSessionSnapshot().bulkRunning).toBe(true)
    sweep.resolve()
    await first
    expect(main.applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1)
    expect(main.order).toEqual(['bulk:clear_decisions'])
    expect(getReviewSessionSnapshot().bulkRunning).toBe(false)
    expectTruthful(main.db)
  })

  // #837 review round 1: a DECISION made while the sweep's IPC is in flight is newer than the sweep. The merge of the
  // returned rows used to overwrite it on screen while its queued write still landed after the sweep (screen
  // `not_reviewed`, database `not_supported`). The screen now keeps it, and it is the last write.
  it('a decision made while the sweep is in flight stays on screen and is written after the sweep', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const sweep = deferred()
    const order: string[] = []
    const bulkSpy = vi.fn(async (reviewId: string, action: EvidenceReviewBulkAction) => {
      order.push(`bulk:${action}`)
      await sweep.promise
      return backend.spy(reviewId, action)
    })
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      order.push(`item:${id}:${patch.decision}`)
      return makeItem({ id, ...patch })
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: bulkSpy
    })
    await openWith(detail)

    const sweeping = bulkClearDecisions()
    await vi.waitFor(() => expect(bulkSpy).toHaveBeenCalled())
    editReviewItem('p2', { decision: 'not_supported' })
    sweep.resolve()
    await sweeping
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe('not_supported')
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    await flushReviewSession()
    expect(order).toEqual(['bulk:clear_decisions', 'item:p2:not_supported'])
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe('not_supported')
  })

  // #839 U2b: the merge after a sweep takes main's DECISIONS only, so a note typed meanwhile is neither reverted nor lost.
  it('a note typed while the sweep is in flight is kept on screen and saved after it', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    const backend = bulkBackend(items)
    const sweep = deferred()
    const bulkSpy = vi.fn(async (reviewId: string, action: EvidenceReviewBulkAction) => {
      await sweep.promise
      return backend.spy(reviewId, action)
    })
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      applyEvidenceReviewBulkAction: bulkSpy
    })
    await openWith(detail)

    const sweeping = bulkClearDecisions()
    await vi.waitFor(() => expect(bulkSpy).toHaveBeenCalled())
    editReviewItem('p2', { reviewerNote: 'typed mid-sweep' })
    sweep.resolve()
    await sweeping
    const p2 = getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!
    expect(p2).toMatchObject({ decision: 'not_reviewed', reviewerNote: 'typed mid-sweep' })
    expect(getReviewSessionSnapshot().saveState).toBe('pending')
    await flushReviewSession()
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('p2', { reviewerNote: 'typed mid-sweep' })
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
  })

  it('a sweep resolving AFTER a purge never re-inserts review content into the store', async () => {
    const items = bulkItems()
    const detail = makeDetail({ items })
    let release: (() => void) | null = null
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      applyEvidenceReviewBulkAction: vi.fn(
        () =>
          new Promise<EvidenceReviewItem[]>((resolve) => {
            release = () => resolve(items.map((i) => ({ ...i, decision: 'not_reviewed' as const })))
          })
      )
    })
    await openWith(detail)
    const pending = bulkClearDecisions()
    await Promise.resolve()
    purgeReviewSession()
    release!()
    await pending
    expect(getReviewSessionSnapshot().detail).toBeNull()
  })
})

describe('reviewSession — race hardening (FIX-2)', () => {
  it('a link resolution landing AFTER purge never re-inserts content into the store (2a)', async () => {
    const detail = makeDetail()
    let releaseLink: (() => void) | null = null
    const setEvidenceLink = vi.fn(
      (itemId: string) =>
        new Promise<EvidenceReviewItem>((resolve) => {
          releaseLink = () =>
            resolve(
              makeItem({
                id: itemId,
                links: [{ evidenceKey: 's1', origin: 'reviewer', relation: null }]
              })
            )
        })
    )
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), setEvidenceLink })
    await openWith(detail)

    const pending = linkEvidence('i1', 's1', null)
    purgeReviewSession() // the lock seam
    releaseLink!()
    await pending
    // The purge guarantee holds: NOTHING decrypted came back, no crash, no error state.
    expect(getReviewSessionSnapshot()).toMatchObject({
      detail: null,
      saveState: 'idle',
      saveError: null,
      openError: null
    })
  })

  it('a link resolution landing after a REVIEW SWITCH never corrupts the new detail (2a)', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    let releaseLink: (() => void) | null = null
    stubReviewApi({
      getEvidenceReview: vi.fn(async (id: string) => (id === 'r2' ? second : first)),
      setEvidenceLink: vi.fn(
        (itemId: string) =>
          new Promise<EvidenceReviewItem>((resolve) => {
            releaseLink = () =>
              resolve(
                makeItem({
                  id: itemId,
                  links: [{ evidenceKey: 's1', origin: 'reviewer', relation: null }]
                })
              )
          })
      )
    })
    await openWith(first)
    const pending = linkEvidence('i1', 's1', null)
    await openReviewSession({ reviewId: 'r2' })
    releaseLink!()
    await pending
    // r2's detail is exactly what main returned for r2: no stale spread, no stale link from r1's flight.
    expect(getReviewSessionSnapshot().detail).toEqual(second)
  })

  it('a selection CREATE resolving AFTER purge never re-inserts content (P5 review FIX-5d)', async () => {
    const detail = makeDetail()
    let releaseCreate: (() => void) | null = null
    const createEvidenceSelection = vi.fn(
      () =>
        new Promise<EvidenceReviewItem>((resolve) => {
          releaseCreate = () =>
            resolve(
              makeItem({
                id: 'sel1',
                ordinal: 2,
                kind: 'selection',
                startOffset: 0,
                endOffset: 5,
                textSnapshot: 'Alpha'
              })
            )
        })
    )
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), createEvidenceSelection })
    await openWith(detail)

    const pending = addReviewSelection('b0-paragraph-abc', 0, 5)
    purgeReviewSession() // the lock seam
    releaseCreate!()
    // Truthful outcome (the row exists main-side) but the purged store stays EMPTY —
    // no decrypted snapshot slice comes back after the lock.
    expect(await pending).toBe('added')
    expect(getReviewSessionSnapshot()).toMatchObject({
      detail: null,
      saveState: 'idle',
      saveError: null,
      openError: null
    })
  })

  it('a selection CREATE resolving after a REVIEW SWITCH never lands in the new detail (FIX-5d)', async () => {
    const first = makeDetail()
    const second = makeDetail({ id: 'r2', messageId: 'm2' })
    let releaseCreate: (() => void) | null = null
    stubReviewApi({
      getEvidenceReview: vi.fn(async (id: string) => (id === 'r2' ? second : first)),
      createEvidenceSelection: vi.fn(
        () =>
          new Promise<EvidenceReviewItem>((resolve) => {
            releaseCreate = () =>
              resolve(
                makeItem({
                  id: 'sel1',
                  ordinal: 2,
                  kind: 'selection',
                  startOffset: 0,
                  endOffset: 5,
                  textSnapshot: 'Alpha'
                })
              )
          })
      )
    })
    await openWith(first)
    const pending = addReviewSelection('b0-paragraph-abc', 0, 5)
    await openReviewSession({ reviewId: 'r2' })
    releaseCreate!()
    expect(await pending).toBe('added')
    // r2's items are untouched — r1's stale selection never appended.
    const s = getReviewSessionSnapshot()
    expect(s.detail?.id).toBe('r2')
    expect(s.detail?.items.map((i) => i.id)).toEqual(['i1', 'i2'])
  })

  it('a selection DELETE resolving AFTER purge never touches the store (FIX-5d)', async () => {
    const selection = makeItem({
      id: 'sel1',
      ordinal: 2,
      kind: 'selection',
      startOffset: 0,
      endOffset: 5,
      textSnapshot: 'Alpha'
    })
    const detail = makeDetail({
      items: [makeItem({ id: 'i1' }), makeItem({ id: 'i2', ordinal: 1 }), selection]
    })
    let releaseDelete: (() => void) | null = null
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      deleteEvidenceSelection: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseDelete = () => resolve(true)
          })
      )
    })
    await openWith(detail)
    const pending = deleteReviewSelection('sel1')
    purgeReviewSession()
    releaseDelete!()
    await pending
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, saveState: 'idle' })
  })

  it('a FAILED item write resolving after purge never repopulates pending (2a — note plaintext)', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    let rejectWrite: (() => void) | null = null
    const updateEvidenceReviewItem = vi.fn(
      () =>
        new Promise<EvidenceReviewItem>((_resolve, reject) => {
          rejectWrite = () => reject(new Error('vault sealed mid-write'))
        })
    )
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), updateEvidenceReviewItem })
    await openWith(detail)
    editReviewItem('i1', { reviewerNote: 'secret note' })
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)

    purgeReviewSession()
    rejectWrite!()
    await Promise.resolve() // let the rejection propagate through doFlush
    // The failure re-merge is token-guarded: no error copy lands on the purged store…
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, saveState: 'idle', saveError: null })
    // …and nothing is pending again: a resurrected patch would go out synchronously on the very next flush.
    void flushReviewSession()
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
  })

  it('reopenReview flushes pending HEAD edits FIRST — a fresh rename is never reverted (2c)', async () => {
    const detail = makeDetail({ status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' })
    const order: string[] = []
    const updateEvidenceReview = vi.fn(async (_id: string, patch: { title?: string }) => {
      order.push('update')
      return { ...detail, title: patch.title ?? detail.title }
    })
    const reopenEvidenceReview = vi.fn(async () => {
      order.push('reopen')
      return { ...detail, title: 'Renamed just before reopen', status: 'draft' as const, completedAt: null }
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReview,
      reopenEvidenceReview
    })
    await openWith(detail)
    editReviewHead({ title: 'Renamed just before reopen' }) // still inside the debounce window
    expect(await reopenReview()).toBe(true)
    expect(order).toEqual(['update', 'reopen'])
    expect(getReviewSessionSnapshot().detail?.title).toBe('Renamed just before reopen')
    expect(getReviewSessionSnapshot().detail?.status).toBe('draft')
  })

  it('retryReviewSave with NOTHING pending reconciles the stale-handle error against the DB (2d)', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    // The write is refused (null = stale handle) — the optimistic value never persisted.
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async () => null)
    })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot().saveState).toBe('error')
    // UI currently shows the never-persisted optimistic decision:
    expect(getReviewSessionSnapshot().detail?.items[0]?.decision).toBe('supported')

    await retryReviewSave()
    // Reconciled with the DB truth (the fixture detail): error cleared, decision back.
    expect(getReviewSessionSnapshot().saveState).toBe('idle')
    expect(getReviewSessionSnapshot().detail?.items[0]?.decision).toBe('not_reviewed')
  })

  // #837 review round 6 (verified, fixed-order repro): a double-click on Try again while the write still fails. The
  // second retry's flush drained the queue into a write still in flight when the first retry looked; the first then
  // saw "nothing pending", took the stale-handle branch, re-read the database over the queued edit and set idle — the
  // next save then wrote `supported` and said "Saved" over a screen showing `not_reviewed`.
  it('a double-click on Try again while the write still fails keeps the edit on screen and never re-reads over it', async () => {
    const detail = makeDetail()
    let fail = true
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (fail) throw new Error('disk I/O error')
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async () => detail)
    stubReviewApi({ getEvidenceReview, updateEvidenceReviewItem })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot().saveState).toBe('error')

    await Promise.all([retryReviewSave(), retryReviewSave()]) // the double click, the disk still failing
    const s = getReviewSessionSnapshot()
    expect(s).toMatchObject({ saveState: 'error', saveError: 'disk I/O error' })
    expect(s.detail?.items[0]?.decision).toBe('supported')
    expect(getEvidenceReview).toHaveBeenCalledTimes(1) // the open only: no re-read over a queued edit

    fail = false
    await retryReviewSave()
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i1', { decision: 'supported' })
    expect(getReviewSessionSnapshot().saveState).toBe('saved')
    expect(getReviewSessionSnapshot().detail?.items[0]?.decision).toBe('supported')
  })

  it('retryReviewSave on a VANISHED review lands on the friendly not-found state (2d)', async () => {
    const detail = makeDetail()
    let present = true
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => (present ? detail : null)),
      updateEvidenceReviewItem: vi.fn(async () => null)
    })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()
    present = false
    await retryReviewSave()
    expect(getReviewSessionSnapshot().detail).toBeNull()
    expect(getReviewSessionSnapshot().openError).toEqual({ kind: 'notFound' })
  })
})

describe('reviewSession — ready-state guard (FIX-1)', () => {
  it('item edits, links and bulk actions refuse while status is ready; head edits still save', async () => {
    const detail = makeDetail({ status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' })
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    const setEvidenceLink = vi.fn(async () => makeItem({ id: 'i1' }))
    const updateEvidenceReview = vi.fn(async () => ({ ...detail, reviewerLabel: 'QA' }))
    const applyEvidenceReviewBulkAction = vi.fn(async () => detail.items)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      setEvidenceLink,
      updateEvidenceReview,
      applyEvidenceReviewBulkAction
    })
    await openWith(detail)

    editReviewItem('i1', { decision: 'supported' })
    await linkEvidence('i1', 's1', null)
    await bulkClearDecisions()
    await bulkMarkHeadingsNotApplicable()
    await bulkMarkUndecidedFollowUp()
    await flushReviewSession()
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    expect(setEvidenceLink).not.toHaveBeenCalled()
    expect(applyEvidenceReviewBulkAction).not.toHaveBeenCalled()
    // The optimistic detail never moved either (i1 keeps the fixture's not_reviewed).
    expect(getReviewSessionSnapshot().detail?.items[0]?.decision).toBe('not_reviewed')

    // HEAD edits (rename / reviewer label / general note) stay allowed while ready.
    editReviewHead({ reviewerLabel: 'QA' })
    await flushReviewSession()
    expect(updateEvidenceReview).toHaveBeenCalledWith('r1', { reviewerLabel: 'QA' })
  })
})

describe('reviewSession — lock purge', () => {
  it('purgeReviewSession drops detail AND pending edits (post-flush lock seam)', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem
    })
    await openWith(detail)
    editReviewItem('i1', { reviewerNote: 'resident plaintext' })
    purgeReviewSession()
    expect(getReviewSessionSnapshot().detail).toBeNull()
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    await flushReviewSession()
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
  })

  it('an open still in flight when the lock purges never re-inserts the decrypted detail', async () => {
    const read = deferred<EvidenceReviewDetail | null>()
    const getEvidenceReview = vi.fn(() => read.promise)
    const { refresh } = stubReviewApi({ getEvidenceReview })
    const opening = openReviewSession({ reviewId: 'r1' })
    await vi.waitFor(() => expect(getEvidenceReview).toHaveBeenCalledWith('r1'))
    purgeReviewSession() // App.lockNow's purge lands while the read is in flight
    read.resolve(makeDetail())
    await opening
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, loading: false, openError: null, saveState: 'idle' })
    expect(refresh).not.toHaveBeenCalled()
  })

  // data-contracts.md "Evidence Pack" P3: a token change (lock/switch) landing AFTER the export started still reports what
  // main did — 'exported' for a real export, 'failed' (no copy) for a genuine rejection — and never touches the purged store.
  it.each<[string, (d: Deferred<EvidenceExportRecord | null>) => void, ReviewExportOutcome]>([
    ['completes', (d) => d.resolve(EXPORT_RECORD), { outcome: 'exported' }],
    ['is rejected by main', (d) => d.reject(new Error('disk full')), { outcome: 'failed', message: null }]
  ])(
    'an export that %s after the lock purge reports the truthful outcome and leaves the purged store empty',
    async (_how, settle, expected) => {
      const detail = makeDetail()
      const exported = deferred<EvidenceExportRecord | null>()
      const exportEvidencePack = vi.fn(() => exported.promise)
      stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), exportEvidencePack })
      await openWith(detail)
      const pending = exportReviewPack({ format: 'html' })
      await vi.waitFor(() => expect(exportEvidencePack).toHaveBeenCalledWith('r1', { format: 'html' }))
      purgeReviewSession() // the lock lands while the dialog / write is in flight
      settle(exported)
      expect(await pending).toEqual(expected)
      expect(getReviewSessionSnapshot().detail).toBeNull()
    }
  )
})

describe('reviewSession — P4 freshness (plan §9.1: refresh on open, acknowledge)', () => {
  it('a successful open fires refreshEvidenceReviewState and stores the verdict', async () => {
    const detail = makeDetail()
    const fresh = makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    const { refresh } = stubReviewApi({ getEvidenceReview: vi.fn(async () => detail) }, fresh)
    await openWith(detail)
    await vi.waitFor(() => expect(getReviewSessionSnapshot().freshness).toEqual(fresh))
    expect(refresh).toHaveBeenCalledWith('r1')
  })

  it('a FAILED open never fires the refresh (nothing to refresh)', async () => {
    const { refresh } = stubReviewApi({ getEvidenceReview: vi.fn(async () => null) })
    await openReviewSession({ reviewId: 'gone' })
    expect(getReviewSessionSnapshot().openError).toEqual({ kind: 'notFound' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('openToken guard: a refresh landing AFTER a purge never re-populates the store', async () => {
    const detail = makeDetail()
    const refreshes: Array<Deferred<EvidenceReviewFreshness | null>> = []
    const refreshEvidenceReviewState = vi.fn(() => {
      const d = deferred<EvidenceReviewFreshness | null>()
      refreshes.push(d)
      return d.promise
    })
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), refreshEvidenceReviewState })
    await openWith(detail) // refresh #1 in flight
    purgeReviewSession() // the lock seam
    await openWith(detail) // unlock: the SAME review reopens, refresh #2 in flight
    expect(refreshEvidenceReviewState).toHaveBeenCalledTimes(2)
    const current = makeFreshness()
    refreshes[1]!.resolve(current)
    await vi.waitFor(() => expect(getReviewSessionSnapshot().freshness).toEqual(current))
    // The pre-lock verdict lands LAST. Same review id, so only the openToken guard can drop it.
    refreshes[0]!.resolve(makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] }))
    await refreshes[0]!.promise // the store's continuation was queued first, so it has run now
    expect(getReviewSessionSnapshot().freshness).toEqual(current)
  })

  it('acknowledge merges the refreshed verdict (acknowledgedAt) into the store', async () => {
    const detail = makeDetail()
    const acked = makeFreshness({
      outdated: true,
      sources: [{ key: 's1', state: 'changed' }],
      acknowledgedAt: '2026-07-18T12:00:00.000Z'
    })
    const acknowledgeEvidenceReviewFreshness = vi.fn(async () => acked)
    stubReviewApi(
      {
        getEvidenceReview: vi.fn(async () => detail),
        acknowledgeEvidenceReviewFreshness
      },
      makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    )
    await openWith(detail)
    const { acknowledgeReviewFreshness } = await import('../../src/renderer/lib/reviewSession')
    expect(await acknowledgeReviewFreshness()).toBe(true)
    expect(acknowledgeEvidenceReviewFreshness).toHaveBeenCalledWith('r1')
    expect(getReviewSessionSnapshot().freshness?.acknowledgedAt).toBe('2026-07-18T12:00:00.000Z')
  })

  it('an acknowledge failure surfaces as a save error, never a crash', async () => {
    const detail = makeDetail()
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      acknowledgeEvidenceReviewFreshness: vi.fn(async () => {
        throw new Error('db gone')
      })
    })
    await openWith(detail)
    const { acknowledgeReviewFreshness } = await import('../../src/renderer/lib/reviewSession')
    expect(await acknowledgeReviewFreshness()).toBe(false)
    expect(getReviewSessionSnapshot().saveState).toBe('error')
  })
})
