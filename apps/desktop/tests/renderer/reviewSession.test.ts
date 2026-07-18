// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  EvidenceReviewDetail,
  EvidenceReviewItem,
  EvidenceReviewItemPatch
} from '../../src/shared/types'
import {
  REVIEW_SAVE_DEBOUNCE_MS,
  bulkClearDecisions,
  bulkMarkHeadingsNotApplicable,
  bulkMarkUndecidedFollowUp,
  computeReadyGate,
  editReviewHead,
  editReviewItem,
  flushReviewSession,
  getReviewSessionSnapshot,
  linkEvidence,
  markReviewReady,
  openReviewSession,
  purgeReviewSession,
  reopenReview,
  resetReviewSessionForTests,
  retryReviewSave
} from '../../src/renderer/lib/reviewSession'
import { stubApi } from '../helpers/renderer'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 plan §7.5 — the reviewSession module store: the repo's FIRST debounced auto-save.
// Pins the contract the plan demands: debounce batches related writes (spec §26), the
// flush is loss-free under rapid edits (edits landing mid-flight are never dropped and a
// failed write re-merges UNDER newer values), a hard flush runs on demand (screen exit /
// pre-lock), and the D-7 gate mirror counts exactly like main's deriveReadyGate.

async function openWith(detail: EvidenceReviewDetail): Promise<void> {
  await openReviewSession({ reviewId: detail.id })
  expect(getReviewSessionSnapshot().detail?.id).toBe(detail.id)
}

beforeEach(() => {
  resetReviewSessionForTests()
})

afterEach(() => {
  vi.useRealTimers()
  resetReviewSessionForTests()
})

describe('reviewSession — open', () => {
  it('opens by reviewId via getEvidenceReview; null → notFound (never a throw)', async () => {
    const detail = makeDetail()
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r1' ? detail : null))
    stubApi({ getEvidenceReview })
    await openWith(detail)
    expect(getEvidenceReview).toHaveBeenCalledWith('r1')

    await openReviewSession({ reviewId: 'gone' })
    const s = getReviewSessionSnapshot()
    expect(s.detail).toBeNull()
    expect(s.openError).toEqual({ kind: 'notFound' })
  })

  it('opens by messageId via the IDEMPOTENT create; a create rejection surfaces friendly copy', async () => {
    const detail = makeDetail()
    stubApi({ createEvidenceReview: vi.fn(async () => detail) })
    await openReviewSession({ messageId: 'm1' })
    expect(getReviewSessionSnapshot().detail?.id).toBe('r1')

    stubApi({
      createEvidenceReview: vi.fn(async () => {
        throw new Error("Error invoking remote method 'evidence:create': Error: This review request is not valid.")
      })
    })
    resetReviewSessionForTests()
    await openReviewSession({ messageId: 'nope' })
    const s = getReviewSessionSnapshot()
    expect(s.openError).toEqual({ kind: 'failed', message: 'This review request is not valid.' })
  })
})

describe('reviewSession — debounced auto-save', () => {
  it('debounces: no IPC before the window, ONE merged write after it', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubApi({
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

    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
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
    stubApi({
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
    stubApi({
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

  it('a NULL mutation result (stale handle) surfaces a save error, never a throw', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async () => null)
    })
    await openWith(detail)
    editReviewItem('i1', { decision: 'supported' })
    await flushReviewSession()
    expect(getReviewSessionSnapshot().saveState).toBe('error')
  })

  it('head edits (title/reviewer/general note) flush through updateEvidenceReview; empty titles never leave', async () => {
    vi.useFakeTimers()
    const detail = makeDetail()
    const updateEvidenceReview = vi.fn(async () => ({ ...detail }))
    stubApi({
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

describe('reviewSession — mark ready + gate mirror', () => {
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
        review: {
          id: detail.id,
          conversationId: detail.conversationId,
          messageId: detail.messageId,
          questionMessageId: detail.questionMessageId,
          title: detail.title,
          status: 'ready' as const,
          outdated: false,
          reviewerLabel: null,
          generalNote: null,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          completedAt: '2026-07-18T11:00:00.000Z'
        },
        gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
      }
    })
    stubApi({
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
    stubApi({
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

  it('computeReadyGate mirrors main: non-heading BLOCKS required (NULL kind required), N/A counts, selections never gate', () => {
    const items = [
      makeItem({ id: 'p', blockKind: 'paragraph', decision: 'supported' }),
      makeItem({ id: 'h', blockKind: 'heading', decision: 'not_reviewed' }), // exempt
      makeItem({ id: 'u', blockKind: null, decision: 'not_applicable' }), // unknown kind → required; N/A decides
      makeItem({ id: 's', kind: 'selection', decision: 'not_reviewed' }), // never gates
      makeItem({ id: 'x', blockKind: 'list_item', decision: 'not_reviewed' })
    ]
    expect(computeReadyGate(items)).toEqual({ eligible: false, requiredTotal: 3, decidedTotal: 2 })
    items[4] = { ...items[4], decision: 'follow_up' }
    expect(computeReadyGate(items)).toEqual({ eligible: true, requiredTotal: 3, decidedTotal: 3 })
  })
})

describe('reviewSession — conservative bulk actions (spec §14.4)', () => {
  it('headings→N/A, undecided→follow-up, clear-all — and NOTHING can bulk-write "supported"', async () => {
    vi.useFakeTimers()
    const items = [
      makeItem({ id: 'h1', blockKind: 'heading', decision: 'not_reviewed' }),
      makeItem({ id: 'p1', blockKind: 'paragraph', decision: 'not_reviewed' }),
      makeItem({ id: 'p2', blockKind: 'paragraph', decision: 'supported' })
    ]
    const detail = makeDetail({ items })
    const written: string[] = []
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
        if (patch.decision) written.push(patch.decision)
        return makeItem({ id, ...patch })
      })
    })
    await openWith(detail)

    bulkMarkHeadingsNotApplicable()
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'h1')!.decision).toBe(
      'not_applicable'
    )
    bulkMarkUndecidedFollowUp()
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p1')!.decision).toBe(
      'follow_up'
    )
    // p2 was already decided — follow-up must not touch it (conservative).
    expect(getReviewSessionSnapshot().detail!.items.find((i) => i.id === 'p2')!.decision).toBe(
      'supported'
    )
    bulkClearDecisions()
    for (const i of getReviewSessionSnapshot().detail!.items) {
      expect(i.decision).toBe('not_reviewed')
    }
    await flushReviewSession()
    // No bulk pathway ever WRITES 'supported' (or partly/not supported): the spec's one
    // forbidden bulk action can not exist by construction.
    expect(written).not.toContain('supported')
    expect(written).not.toContain('partly_supported')
    expect(written).not.toContain('not_supported')
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
    stubApi({ getEvidenceReview: vi.fn(async () => detail), setEvidenceLink })
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
    stubApi({
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
    // r2's detail is intact (id + gate present, no stale-spread malformation), and the
    // stale link write from r1's flight never landed.
    const s = getReviewSessionSnapshot()
    expect(s.detail?.id).toBe('r2')
    expect(s.detail?.gate).toBeDefined()
    expect(s.detail?.items.every((i) => i.links.length === 0)).toBe(true)
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
    stubApi({ getEvidenceReview: vi.fn(async () => detail), updateEvidenceReviewItem })
    await openWith(detail)
    editReviewItem('i1', { reviewerNote: 'secret note' })
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)

    purgeReviewSession()
    rejectWrite!()
    await Promise.resolve() // let the rejection propagate through doFlush
    await vi.advanceTimersByTimeAsync(REVIEW_SAVE_DEBOUNCE_MS + 10)
    // The failure re-merge is token-guarded: no pending resurrection → no retry write.
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
    expect(getReviewSessionSnapshot()).toMatchObject({ detail: null, saveState: 'idle' })
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
    stubApi({
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
    stubApi({
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

  it('retryReviewSave on a VANISHED review lands on the friendly not-found state (2d)', async () => {
    const detail = makeDetail()
    let present = true
    stubApi({
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
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem,
      setEvidenceLink,
      updateEvidenceReview
    })
    await openWith(detail)

    editReviewItem('i1', { decision: 'not_reviewed' })
    await linkEvidence('i1', 's1', null)
    bulkClearDecisions()
    bulkMarkHeadingsNotApplicable()
    bulkMarkUndecidedFollowUp()
    await flushReviewSession()
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    expect(setEvidenceLink).not.toHaveBeenCalled()
    // The optimistic detail never moved either.
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
    stubApi({
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
})
