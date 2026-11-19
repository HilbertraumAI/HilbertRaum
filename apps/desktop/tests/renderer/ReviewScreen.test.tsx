// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { flushReviewSession, purgeReviewSession } from '../../src/renderer/lib/reviewSession'
import { t, type MessageKey } from '../../src/shared/i18n'
import type {
  EvidenceLinkInput,
  EvidenceReviewFreshness,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  EvidenceSourceContext
} from '../../src/shared/types'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { deferred } from '../helpers/deferred'
import {
  archiveSource,
  bulkBackend,
  makeDetail,
  makeFreshness,
  makeItem,
  makeReviewHead,
  stubReviewApi
} from '../helpers/evidenceReview'
import { fakeMatchMedia, removeMatchMedia } from '../helpers/match-media'
import { openSummary, renderReview } from '../helpers/review-screen'

// EP-1 plan §7.3/§7.4/§7.6 — the review workspace itself: the create→decide→note→
// summary→ready journey over stubApi, the whole-document honesty wording (asserted by
// EXACT catalog keys — provenance is never presented as citations), the D-7 completion
// gate, ready-state read-only behavior (FIX-1), the conservative-bulk-actions guarantee
// (NO "mark all supported"), the keyboard walk (spec §28.10 minus export), and drawer
// focus restoration.
//
// Hard rule (spec FR-2/FR-12): every test stubs ONLY `evidence:*` bridge methods, and a
// file-wide afterEach runs assertNoUnexpectedApiCalls() (review FIX-5 — structural, not
// per-test opt-in) — ANY other window.api call (runtime, rag, network surfaces) in ANY
// test fails the suite. That is the renderer half of the zero-model/zero-network gate.
// ONE documented exception since #301 P6: the archive row's "Open article" calls
// `packs:getArticle` — a local offline-archive read on the main process, still zero model and
// zero network. The tests that need it stub it EXPLICITLY (last describe in this file), so the
// structural teeth keep biting on every other surface.

beforeEach(() => {
  purgeReviewSession()
})

afterEach(() => {
  // Unmount first: the flush-on-exit path runs against the SAME stub set, so a flush
  // hitting an unstubbed method is caught too.
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

function noop(): void {}

/** `text` as a literal regular-expression source. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Radix DropdownMenu triggers open on POINTERDOWN, not click — drive it the way Radix
 *  listens (a bare fireEvent.click never opens the menu in jsdom). */
function openBulkMenu(): void {
  const trigger = screen.getByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

describe('ReviewScreen — create → decide → note → summary → ready (spec §10)', () => {
  it('runs the full journey with zero non-evidence api calls', async () => {
    const detail = makeDetail()
    const createEvidenceReview = vi.fn(async () => detail)
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    const markEvidenceReviewReady = vi.fn(async () => ({
      review: makeReviewHead({ id: 'r1', status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' }),
      gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
    }))
    await renderReview({
      handoff: { messageId: 'm1' },
      detail,
      api: { createEvidenceReview, updateEvidenceReviewItem, markEvidenceReviewReady }
    })

    // Opened from a message id → the IDEMPOTENT create (no model, no network).
    await screen.findByText('Beta')
    expect(createEvidenceReview).toHaveBeenCalledWith('m1')
    // The title renders localized from the persist-canonical default (D-L4 display map).
    expect(
      screen.getByRole('heading', { name: t('en', 'main.evidenceReviews.defaultTitle') })
    ).toBeInTheDocument()

    // Decide both items via the radio chips.
    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.supported')) })
    )
    fireEvent.click(
      within(items[1]).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.not_applicable'))
      })
    )
    // Note on item 1.
    fireEvent.change(within(items[0]).getByPlaceholderText(t('en', 'review.item.notePlaceholder')), {
      target: { value: 'verified against page 12' }
    })
    // Footer progress reflects the optimistic gate.
    expect(
      screen.getByText(t('en', 'review.progress', { decided: 2, required: 2 }))
    ).toBeInTheDocument()

    // Open the summary → counts + Mark ready.
    const dialog = await openSummary()
    const readyBtn = within(dialog).getByRole('button', {
      name: t('en', 'review.summary.markReady')
    })
    expect(readyBtn).toBeEnabled()
    // Guard: the 600 ms autosave the edits armed has not fired yet, so the write below can only come from markReviewReady's own flush.
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    fireEvent.click(readyBtn)
    // markReviewReady flushes before its first await (reviewSession.ts:401 → :264-289): the first pending patch (i1: decision + note,
    // merged) is written inside the click, and the ready call is not made yet.
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', { decision: 'supported', reviewerNote: 'verified against page 12' })
    expect(markEvidenceReviewReady).not.toHaveBeenCalled()

    await waitFor(() => expect(markEvidenceReviewReady).toHaveBeenCalledWith('r1'))
    // Auto-save flushed BEFORE the gate check (decisions + note must be persisted first).
    expect(updateEvidenceReviewItem).toHaveBeenCalled()
    const firstReadyCall = markEvidenceReviewReady.mock.invocationCallOrder[0]
    for (const order of updateEvidenceReviewItem.mock.invocationCallOrder) {
      expect(order).toBeLessThan(firstReadyCall)
    }
    // Status chip flips to Ready.
    await waitFor(() =>
      expect(screen.getAllByText(t('en', 'review.status.ready')).length).toBeGreaterThan(0)
    )
    assertNoUnexpectedApiCalls()
  })

  // #839 U1f (D-6): a rename edits the stored title through the debounced head patch; Escape drops the draft.
  it('rename: Enter saves the trimmed title through the head patch, Escape drops the draft', async () => {
    const updateEvidenceReview = vi.fn(async (id: string, patch: EvidenceReviewPatch) => makeReviewHead({ id, ...patch }))
    await renderReview({ api: { updateEvidenceReview } })
    await screen.findByText('Beta')

    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.rename') }))
    const input = screen.getByRole('textbox', { name: t('en', 'review.rename.label') })
    fireEvent.change(input, { target: { value: '  Lease terms  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Lease terms' })).toBeInTheDocument()
    await act(async () => {
      await flushReviewSession()
    })
    expect(updateEvidenceReview).toHaveBeenCalledWith('r1', { title: 'Lease terms' })

    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.rename') }))
    const again = screen.getByRole('textbox', { name: t('en', 'review.rename.label') })
    fireEvent.change(again, { target: { value: 'Not this one' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(screen.getByRole('heading', { name: 'Lease terms' })).toBeInTheDocument()
    await act(async () => {
      await flushReviewSession()
    })
    expect(updateEvidenceReview).toHaveBeenCalledTimes(1)
  })

  it('a deleted/unknown reviewId lands on the friendly not-found state, never a crash', async () => {
    // Mounted directly: renderReview waits for a loaded review's footer, which the not-found state never renders.
    stubReviewApi({ getEvidenceReview: vi.fn(async () => null) })
    render(<ReviewScreen handoff={{ reviewId: 'gone' }} onNavigate={noop} />)
    expect(await screen.findByText(t('en', 'review.notFound'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('flushes pending edits on screen exit (unmount)', async () => {
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    const { view } = await renderReview({ detail, api: { updateEvidenceReviewItem } })
    await screen.findByText('Beta')
    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.follow_up')) })
    )
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    view.unmount()
    // The unmount effect (ReviewScreen.tsx:115-119) reaches the IPC call before its first await (reviewSession.ts:264-289), so the write is
    // asserted before any macrotask: the 600 ms autosave timer the click armed cannot stand in for the exit flush.
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(1)
    expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', { decision: 'follow_up' })
  })
})

describe('ReviewScreen — whole-document honesty wording (spec §11.4/§13.3, exact keys)', () => {
  function wholeDocDetail() {
    return makeDetail({
      coverageSnapshot: { mode: 'tree', chunksCovered: 40, chunksTotal: 40 },
      sources: [
        {
          key: 'p1',
          // A label on a provenance source is a state main sends: a newer app's unknown kind is repaired to
          // whole_document_provenance with its machine label kept (evidence-reviews.ts:169-173). So only the
          // kind guard can keep the [S1] marker off this card.
          machineLabel: 'S1',
          kind: 'whole_document_provenance',
          identity: 'resolved',
          documentId: 'd1',
          documentTitle: 'contract.pdf',
          documentSha256: 'ab'.repeat(32),
          mimeType: 'application/pdf',
          pageNumber: null,
          sectionLabel: 'Section 3.1',
          snippet: 'Termination requires…',
          sourceChunkId: null,
          availabilityAtCreation: 'available'
        }
      ]
    })
  }

  it('renders the whole-document caption + per-item derivation note — NEVER citation framing', async () => {
    await renderReview({ detail: wholeDocDetail() })
    await screen.findByText('Beta')

    // EXACT KEY assertions: the pane says provenance, not citations…
    expect(screen.getByText(t('en', 'review.evidence.captionWholeDoc'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'review.evidence.captionRelevance'))).toBeNull()
    // …every non-heading item carries the DERIVED note (not "no marker", not a citation),
    expect(screen.getAllByText(t('en', 'review.item.wholeDocDerived'))).toHaveLength(2)
    expect(screen.queryByText(t('en', 'review.item.noMarker'))).toBeNull()
    // …the provenance card shows kind + NO [S1] marker label,
    expect(
      screen.getByText(t('en', 'review.source.kind.whole_document_provenance'))
    ).toBeInTheDocument()
    expect(document.querySelector('.review-evidence .cite-label')).toBeNull()
  })

  it('a reviewer-made link is labeled "Reviewer linked", never "Cited by the answer"; its relation choice is saved', async () => {
    const detail = wholeDocDetail()
    const setEvidenceLink = vi.fn(async (itemId: string, key: string, input: EvidenceLinkInput) =>
      makeItem({ id: itemId, links: [{ evidenceKey: key, origin: 'reviewer' as const, relation: input.relation ?? null }] })
    )
    await renderReview({ detail, api: { setEvidenceLink } })
    await screen.findByText('Beta')

    // Select item 1, then link the provenance card to it.
    const items = screen.getAllByRole('listitem')
    fireEvent.click(items[0])
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.link.add') }))
    await waitFor(() =>
      expect(setEvidenceLink).toHaveBeenCalledWith('i1', 'p1', {
        origin: 'reviewer',
        relation: null
      })
    )
    // Both the evidence card and the item chip say Reviewer linked; citation wording stays absent.
    await waitFor(() =>
      expect(screen.getAllByText(new RegExp(t('en', 'review.link.reviewer'))).length).toBeGreaterThan(0)
    )
    expect(screen.queryByText(t('en', 'review.link.cited'))).toBeNull()
    // #839 U1h: the item's link chip carries no [S1] marker either: a provenance source has no citation label.
    const chip = document.querySelector('.review-item-link')
    expect(chip?.textContent).toContain('contract.pdf')
    expect(chip?.textContent).not.toContain('[S1]')

    // #839 U1d: the relation the reviewer picks is what main stores (the pack's relation register reads it).
    fireEvent.change(screen.getByLabelText(t('en', 'review.relation.label')), { target: { value: 'contradicts' } })
    await waitFor(() =>
      expect(setEvidenceLink).toHaveBeenLastCalledWith('i1', 'p1', { origin: 'reviewer', relation: 'contradicts' })
    )
  })

  // #839 U1i: an extract answer's evidence is structured records; the pane must not caption it as a whole-document read.
  it('an extract answer captions its evidence as structured records, never as a whole-document read', async () => {
    const detail = wholeDocDetail()
    detail.coverageSnapshot = { mode: 'extract', chunksCovered: 40, chunksTotal: 40 }
    detail.sources[0]!.kind = 'structured_record'
    await renderReview({ detail })
    await screen.findByText('Beta')
    expect(screen.getByText(t('en', 'review.evidence.captionStructured'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'review.evidence.captionWholeDoc'))).toBeNull()
  })
})

// #839 U1b/U1c: the generation facts the journey never reaches. A missing record reads "Unavailable", and an answer
// that did not finish says why on the screen's footer, not only in the pack.
describe('ReviewScreen — generation honesty (#839)', () => {
  it('a review with no generation record shows "Unavailable" for every generation fact', async () => {
    await renderReview({ detail: makeDetail({ generationSnapshot: null }) })
    const dialog = await openSummary()
    for (const label of ['review.summary.model', 'review.summary.generatedAt', 'review.summary.appVersion'] as const) {
      expect(within(dialog).getByText(t('en', label)).nextElementSibling?.textContent).toBe(
        t('en', 'review.summary.unavailable')
      )
    }
  })

  it.each([
    ['was cut off (truncated)', { answerTruncated: true }, 'review.summary.truncated'],
    ['was stopped by the user', { answerEndedEarly: 'user' as const }, 'review.summary.stopped.user']
  ] as const)('an answer that %s says so on the footer', async (_what, gen, shown) => {
    const detail = makeDetail()
    Object.assign(detail.generationSnapshot!, gen)
    await renderReview({ detail })
    await screen.findByText('Beta')
    expect(document.querySelector('.review-screen footer')?.textContent).toContain(t('en', shown))
  })
})

describe('ReviewScreen — ready review is read-only until reopened (FIX-1)', () => {
  function readyDetail() {
    return makeDetail({
      status: 'ready',
      completedAt: '2026-07-18T11:00:00.000Z',
      items: [
        makeItem({ id: 'i1', decision: 'supported' }),
        makeItem({
          id: 'i2',
          ordinal: 1,
          blockKey: 'b1-paragraph-def',
          textSnapshot: 'Beta',
          decision: 'not_applicable',
          links: [{ evidenceKey: 's1', origin: 'reviewer', relation: null }]
        })
      ]
    })
  }

  it('disables decisions, notes, links and hides bulk — with the quiet reopen hint', async () => {
    await renderReview({ detail: readyDetail() })
    await screen.findByText('Beta')

    // The quiet "why is everything disabled" line sits next to the Ready chip.
    expect(screen.getByText(t('en', 'review.readonlyHint'))).toBeInTheDocument()
    // Every decision chip and note field is disabled…
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    for (const note of screen.getAllByPlaceholderText(t('en', 'review.item.notePlaceholder'))) {
      expect(note).toBeDisabled()
    }
    // …the item's unlink ✕ is disabled…
    expect(
      screen.getByRole('button', { name: new RegExp(t('en', 'review.link.remove')) })
    ).toBeDisabled()
    // …the bulk menu is GONE entirely (every bulk action is an item-level write)…
    expect(
      screen.queryByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })
    ).toBeNull()
    // …and the evidence pane's link/relation controls are disabled for the selected item.
    fireEvent.click(screen.getAllByRole('listitem')[0])
    expect(screen.getByRole('button', { name: t('en', 'review.link.add') })).toBeDisabled()
  })

  // #889 (G-4): from the end of Mark ready's save until main answers, item editing is closed in the store, and the
  // screen shows it before the review reads Ready — without the "Marked ready" hint, since main may still say "not yet".
  it('while Mark ready is with main, decisions and notes are read-only before the review shows Ready', async () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'i1', decision: 'supported' }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta', decision: 'supported' })
      ]
    })
    const answer = deferred<{
      review: ReturnType<typeof makeReviewHead>
      gate: { eligible: boolean; requiredTotal: number; decidedTotal: number }
    }>()
    const markEvidenceReviewReady = vi.fn(() => answer.promise)
    await renderReview({ detail, api: { markEvidenceReviewReady } })
    const notes = (): HTMLElement[] => screen.getAllByPlaceholderText(t('en', 'review.item.notePlaceholder'))
    expect(notes()[0]).toBeEnabled()

    const dialog = await openSummary()
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.summary.markReady') }))
    await waitFor(() => expect(markEvidenceReviewReady).toHaveBeenCalledWith('r1'))
    const head = within(document.querySelector('.review-head') as HTMLElement)
    expect(head.getByText(t('en', 'review.status.draft'))).toBeInTheDocument() // not ready yet…
    for (const note of notes()) expect(note).toBeDisabled() // …and already read-only
    for (const radio of screen.getAllByRole('radio', { hidden: true })) expect(radio).toBeDisabled()
    expect(screen.queryByText(t('en', 'review.readonlyHint'))).toBeNull()

    answer.resolve({
      review: makeReviewHead({ status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' }),
      gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
    })
    expect(await head.findByText(t('en', 'review.status.ready'))).toBeInTheDocument()
  })

  it('Reopen restores editability (hint gone, controls live again)', async () => {
    const detail = readyDetail()
    const reopenEvidenceReview = vi.fn(async () => makeReviewHead({ id: 'r1', status: 'draft', completedAt: null }))
    await renderReview({ detail, api: { reopenEvidenceReview } })
    await screen.findByText('Beta')

    const dialog = await openSummary()
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.summary.reopen') }))
    await waitFor(() => expect(reopenEvidenceReview).toHaveBeenCalledWith('r1'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'common.close') }))

    await waitFor(() =>
      expect(screen.queryByText(t('en', 'review.readonlyHint'))).toBeNull()
    )
    // The header's status chip reads Draft again (carried from the retired "reaches draft again via Reopen" row).
    expect(
      within(document.querySelector('.review-head') as HTMLElement).getByText(t('en', 'review.status.draft'))
    ).toBeInTheDocument()
    const items = screen.getAllByRole('listitem')
    expect(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.supported')) })
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })
    ).toBeInTheDocument()
  })
})

describe('ReviewScreen — answer_marker links render as "Cited by the answer" (FIX-7b)', () => {
  it('the citation origin renders on the item chip AND the evidence card — read-only relation', async () => {
    const detail = makeDetail({
      items: [
        makeItem({
          id: 'i1',
          links: [{ evidenceKey: 's1', origin: 'answer_marker', relation: null }]
        }),
        makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' })
      ]
    })
    await renderReview({ detail })
    await screen.findByText('Beta')

    // Item chip: the auto-link carries the citation claim.
    expect(screen.getAllByText(new RegExp(t('en', 'review.link.cited'))).length).toBeGreaterThan(0)
    // Select item 1 → the card labels the link "Cited by the answer" with NO relation
    // editor (a relation write would silently rewrite the origin to 'reviewer').
    fireEvent.click(screen.getAllByRole('listitem')[0])
    const card = document.querySelector('.review-source-card') as HTMLElement
    expect(within(card).getByText(t('en', 'review.link.cited'))).toBeInTheDocument()
    expect(within(card).queryByText(t('en', 'review.link.reviewer'))).toBeNull()
    expect(within(card).queryByRole('combobox')).toBeNull()
    // Remove link stays offered (spec §10.2 — removal is a reviewer act on the working set).
    expect(within(card).getByRole('button', { name: t('en', 'review.link.remove') })).toBeEnabled()
  })
})

describe('ReviewScreen — completion gating (D-7)', () => {
  it('Mark ready stays disabled with the N-of-M hint until every required item is decided', async () => {
    const detail = makeDetail() // two required paragraphs, both not_reviewed
    await renderReview({
      detail,
      api: {
        updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
          makeItem({ id, ...patch })
        )
      }
    })
    await screen.findByText('Beta')

    const dialog = await openSummary()
    expect(
      within(dialog).getByRole('button', { name: t('en', 'review.summary.markReady') })
    ).toBeDisabled()
    expect(
      within(dialog).getByText(t('en', 'review.summary.gateHint', { decided: 0, required: 2 }))
    ).toBeInTheDocument()

    // Close, decide both (Not applicable COUNTS as decided — D-7), reopen the summary.
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'common.close') }))
    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.supported')) })
    )
    fireEvent.click(
      within(items[1]).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.not_applicable'))
      })
    )
    const dialog2 = await openSummary()
    expect(
      within(dialog2).getByRole('button', { name: t('en', 'review.summary.markReady') })
    ).toBeEnabled()
  })
})

describe('ReviewScreen — conservative bulk actions (spec §14.4)', () => {
  it('offers exactly headings→N/A, undecided→follow-up, clear — and NO "mark all supported"', async () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'h1', blockKind: 'heading', textSnapshot: '## Heading', decision: 'not_reviewed' }),
        makeItem({ id: 'p1', textSnapshot: 'Alpha [S1]' }),
        makeItem({ id: 'p2', blockKey: 'b2-paragraph-x', textSnapshot: 'Beta' })
      ]
    })
    // AUD-13: a bulk action is ONE main-side transaction over the whole review, so the
    // shared stand-in applies the named sweep with main's predicates to its own copy in one
    // step and returns the whole refreshed item set — the screen never sees a per-item drip.
    const bulk = bulkBackend(detail.items)
    await renderReview({
      detail,
      api: {
        updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
          makeItem({ id, ...patch })
        ),
        applyEvidenceReviewBulkAction: bulk.spy
      }
    })
    await screen.findByText('Beta')

    openBulkMenu()
    const menu = await screen.findByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    // The EXACT list is the absence pin: no fourth item, so no "mark all supported" (spec §14.4).
    expect(labels).toEqual([
      t('en', 'review.bulk.headingsNa'),
      t('en', 'review.bulk.followUp'),
      t('en', 'review.bulk.clear')
    ])

    // headings→N/A acts on the heading only.
    fireEvent.click(within(menu).getByText(t('en', 'review.bulk.headingsNa')))
    await waitFor(() => {
      const items = screen.getAllByRole('listitem')
      expect(
        within(items[0]).getByRole('radio', {
          name: new RegExp(t('en', 'review.decision.not_applicable'))
        })
      ).toHaveAttribute('aria-checked', 'true')
      expect(
        within(items[1]).getByRole('radio', {
          name: new RegExp(t('en', 'review.decision.not_reviewed'))
        })
      ).toHaveAttribute('aria-checked', 'true')
    })

    // undecided→follow-up marks every paragraph still undecided, through its own sweep (#839 U1g).
    openBulkMenu()
    fireEvent.click(await screen.findByText(t('en', 'review.bulk.followUp')))
    await waitFor(() => expect(bulk.spy).toHaveBeenLastCalledWith('r1', 'undecided_follow_up'))
    await waitFor(() => {
      for (const row of screen.getAllByRole('listitem').slice(1)) {
        expect(
          within(row).getByRole('radio', { name: new RegExp(t('en', 'review.decision.follow_up')) })
        ).toHaveAttribute('aria-checked', 'true')
      }
    })

    // Clear-all asks for confirmation first (destructive breadth), then resets.
    openBulkMenu()
    fireEvent.click(await screen.findByText(t('en', 'review.bulk.clear')))
    const confirm = await screen.findByRole('dialog')
    fireEvent.click(
      within(confirm).getByRole('button', { name: t('en', 'review.bulk.clearConfirm') })
    )
    await waitFor(() => {
      const rows = screen.getAllByRole('listitem')
      expect(
        within(rows[0]).getByRole('radio', {
          name: new RegExp(t('en', 'review.decision.not_reviewed'))
        })
      ).toHaveAttribute('aria-checked', 'true')
    })
  })
})

describe('ReviewScreen — keyboard-only walk (spec §28.10, export lands P3)', () => {
  /** Press Tab (keyboard only — FIX-7a) until the active element satisfies `match`. */
  async function tabUntil(
    user: ReturnType<typeof userEvent.setup>,
    match: (el: Element) => boolean,
    max = 25
  ): Promise<HTMLElement> {
    for (let i = 0; i < max; i++) {
      const active = document.activeElement
      if (active && active !== document.body && match(active)) return active as HTMLElement
      await user.tab()
    }
    throw new Error('tabUntil: never reached the expected tab stop')
  }

  it('keyboard ALONE: reach both items, decide them, note, link evidence, open summary, mark ready', async () => {
    const user = userEvent.setup()
    const detail = makeDetail()
    const setEvidenceLink = vi.fn(async (id: string) =>
      makeItem({ id, links: [{ evidenceKey: 's1', origin: 'reviewer' as const, relation: null }] })
    )
    const markEvidenceReviewReady = vi.fn(async () => ({
      review: makeReviewHead({ id: 'r1', status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' }),
      gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
    }))
    await renderReview({
      detail,
      api: {
        updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
          makeItem({ id, ...patch })
        ),
        setEvidenceLink,
        markEvidenceReviewReady
      }
    })
    await screen.findByText('Beta')
    const items = screen.getAllByRole('listitem')

    // Tab (from the document root) to item 1's decision group — ONE stop, roving tabindex:
    // the tab stop is the SELECTED chip, here the initial "Not reviewed".
    const stop = await tabUntil(
      user,
      (el) => el.getAttribute('role') === 'radio' && items[0].contains(el)
    )
    expect(stop.textContent).toContain(t('en', 'review.decision.not_reviewed'))
    // Focusing a control inside item 1 SELECTS item 1 (keyboard parity with click)…
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    // …arrows move focus AND selection (wrap from "Not reviewed" to "Not applicable")…
    await user.keyboard('{ArrowRight}')
    expect(
      within(items[0]).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.not_applicable'))
      })
    ).toHaveFocus()
    // …and Home jumps to "supported", DECIDING item 1.
    await user.keyboard('{Home}')
    expect(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.supported')) })
    ).toHaveAttribute('aria-checked', 'true')

    // Tab to item 1's note and type it.
    await tabUntil(user, (el) => el.tagName === 'TEXTAREA' && items[0].contains(el))
    await user.keyboard('checked against the excerpt')
    expect(
      within(items[0]).getByPlaceholderText(t('en', 'review.item.notePlaceholder'))
    ).toHaveValue('checked against the excerpt')

    // Tab ONWARD to item 2's decision group and decide it (selection follows focus).
    await tabUntil(user, (el) => el.getAttribute('role') === 'radio' && items[1].contains(el))
    expect(items[1]).toHaveAttribute('aria-current', 'true')
    await user.keyboard('{Home}')

    // Tab to the evidence pane's "Link to item" and link by keyboard (item 2 selected).
    const linkBtn = await tabUntil(
      user,
      (el) => el.textContent === t('en', 'review.link.add') && el.tagName === 'BUTTON'
    )
    expect(linkBtn).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(setEvidenceLink).toHaveBeenCalledWith('i2', 's1', { origin: 'reviewer', relation: null })
    )

    // Tab to the footer's Review summary and open it.
    await tabUntil(user, (el) => el.textContent === t('en', 'review.footer.summary'))
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog')

    // Inside the (focus-trapped) summary: tab to Mark review ready and fire it.
    await tabUntil(
      user,
      (el) => el.textContent === t('en', 'review.summary.markReady') && dialog.contains(el),
      40
    )
    await user.keyboard('{Enter}')
    await waitFor(() => expect(markEvidenceReviewReady).toHaveBeenCalledWith('r1'))
  })
})

describe('ReviewScreen — narrow-window evidence drawer (spec §11.1)', () => {
  afterEach(() => {
    // Remove the fake so other tests keep the no-matchMedia (wide) default.
    removeMatchMedia()
  })

  it('opens the evidence drawer from an item and RESTORES FOCUS to the opener on close', async () => {
    fakeMatchMedia(true) // a narrow window flips the screen into drawer mode
    const detail = makeDetail()
    await renderReview({ detail })
    await screen.findByText('Beta')

    // Narrow: no inline evidence pane; each item offers "View evidence".
    expect(document.querySelector('.review-evidence-pane')).toBeNull()
    const items = screen.getAllByRole('listitem')
    const opener = within(items[0]).getByRole('button', {
      name: t('en', 'review.item.viewEvidence')
    })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    // The drawer carries the evidence pane (caption + card + disclaimer).
    expect(
      within(dialog).getByText(t('en', 'review.evidence.captionRelevance'))
    ).toBeInTheDocument()
    expect(within(dialog).getByText(t('en', 'review.disclaimer'))).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'common.close') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Focus returns to the opening "View evidence" button (Modal's useReturnFocus).
    await waitFor(() => expect(opener).toHaveFocus())
  })
})

describe('ReviewScreen — P4 freshness overlay (plan §9, spec §15.4–15.5/§21.3/§28.6)', () => {
  it('calls refreshEvidenceReviewState ON OPEN; a fresh review shows NO banner and NO Outdated chip', async () => {
    const { refresh } = await renderReview({ detail: makeDetail() })
    await screen.findByText('Beta')
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('r1'))
    expect(screen.queryByText(t('en', 'review.outdated.title'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.status.outdated'))).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('an outdated verdict shows the banner (facts + §21.3 options), the ADDITIONAL chip, and the changed badge', async () => {
    await renderReview({
      detail: makeDetail(),
      fresh: makeFreshness({
        outdated: true,
        answerState: 'changed',
        sources: [{ key: 's1', state: 'changed' }]
      })
    })
    await screen.findByText(t('en', 'review.outdated.title'))
    // Drift facts, by exact copy.
    expect(screen.getByText(t('en', 'review.outdated.answerChanged'))).toBeInTheDocument()
    expect(
      screen.getByText(t('en', 'review.outdated.sourcesChanged.one', { count: 1 }))
    ).toBeInTheDocument()
    // §21.3 options stay visible; decisions untouched.
    expect(screen.getByText(t('en', 'review.outdated.keepNote'))).toBeInTheDocument()
    // The Outdated chip JOINS the status chip — Draft stays visible (spec §18.4).
    expect(screen.getByText(t('en', 'review.status.outdated'))).toBeInTheDocument()
    expect(screen.getByText(t('en', 'review.status.draft'))).toBeInTheDocument()
    // Per-card §15.5 badge (text + icon, never color-only).
    expect(screen.getByText(t('en', 'review.source.changed'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('acknowledge flows through the API and swaps the button for the acknowledged line', async () => {
    const acknowledgeEvidenceReviewFreshness = vi.fn(async () =>
      makeFreshness({
        outdated: true,
        sources: [{ key: 's1', state: 'changed' }],
        acknowledgedAt: '2026-07-18T12:00:00.000Z'
      })
    )
    await renderReview({
      detail: makeDetail(),
      api: { acknowledgeEvidenceReviewFreshness },
      fresh: makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    })
    const ack = await screen.findByRole('button', { name: t('en', 'review.outdated.acknowledge') })
    fireEvent.click(ack)
    await waitFor(() => expect(acknowledgeEvidenceReviewFreshness).toHaveBeenCalledWith('r1'))
    // The banner STAYS (the review is still outdated) but now records the acknowledge.
    await screen.findByText(/Change acknowledged/)
    expect(
      screen.queryByRole('button', { name: t('en', 'review.outdated.acknowledge') })
    ).toBeNull()
    expect(screen.getByText(t('en', 'review.status.outdated'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('FIX-5: the banner names NEWLY-missing sources in its drift list (a new deletion lapses the acknowledge — the re-demand must say why)', async () => {
    const base = makeDetail()
    const detail = makeDetail({
      sources: [
        base.sources[0]!,
        {
          ...base.sources[0]!,
          key: 's2',
          machineLabel: 'S2',
          documentId: 'd2',
          documentTitle: 'appendix.pdf',
          availabilityAtCreation: 'available'
        }
      ]
    })
    await renderReview({
      detail,
      fresh: makeFreshness({
        outdated: true,
        sources: [
          { key: 's1', state: 'changed' },
          { key: 's2', state: 'missing' }
        ]
      })
    })
    // The banner is the status region that holds its title (the save line is a status region too, #837).
    const banner = (await screen.findByText(t('en', 'review.outdated.title'))).closest('[role="status"]') as HTMLElement
    expect(
      within(banner).getByText(t('en', 'review.outdated.sourcesChanged.one', { count: 1 }))
    ).toBeInTheDocument()
    expect(
      within(banner).getByText(t('en', 'review.summary.sourcesMissingNow.one', { count: 1 }))
    ).toBeInTheDocument()
    // The deleted source's card carries the §15.4 badge too.
    expect(screen.getByText(t('en', 'review.source.missingNow'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('a NEWLY-missing source shows the §15.4 badge WITHOUT the outdated banner (spec §25.2/§28.7)', async () => {
    await renderReview({
      detail: makeDetail(),
      fresh: makeFreshness({ outdated: false, sources: [{ key: 's1', state: 'missing' }] })
    })
    await screen.findByText(t('en', 'review.source.missingNow'))
    expect(screen.queryByText(t('en', 'review.outdated.title'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.status.outdated'))).toBeNull()
    // The persisted snippet stays visible on the card (spec §25.2).
    expect(screen.getByText('Either party may terminate…')).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('an UNRESOLVED source keeps its identity badge only — never a changed/missing freshness badge', async () => {
    const detail = makeDetail({
      sources: [
        {
          key: 's1',
          machineLabel: null,
          kind: 'whole_document_provenance',
          identity: 'unresolved',
          documentId: null,
          documentTitle: 'ambiguous.pdf',
          documentSha256: null,
          mimeType: null,
          pageNumber: null,
          sectionLabel: null,
          snippet: 'Old excerpt.',
          sourceChunkId: null,
          availabilityAtCreation: null
        }
      ]
    })
    await renderReview({
      detail,
      fresh: makeFreshness({ outdated: false, sources: [{ key: 's1', state: 'unverifiable' }] })
    })
    await screen.findByText(t('en', 'review.source.unresolved'))
    expect(screen.queryByText(t('en', 'review.source.changed'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.source.missingNow'))).toBeNull()
    // cannotVerify is reserved for RESOLVED-but-hashless sources; unresolved keeps ONE badge.
    expect(screen.queryByText(t('en', 'review.source.cannotVerify'))).toBeNull()
    // And no context action — there is no document to read (D-5 refuses main-side too).
    expect(
      screen.queryByRole('button', { name: t('en', 'review.sourceContext.open') })
    ).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('a RESOLVED source whose current state cannot be compared shows the cannot-verify badge, never changed or missing', async () => {
    await renderReview({
      detail: makeDetail(),
      fresh: makeFreshness({ outdated: false, sources: [{ key: 's1', state: 'unverifiable' }] })
    })
    expect(await screen.findByText(t('en', 'review.source.cannotVerify'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'review.source.changed'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.source.missingNow'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.outdated.title'))).toBeNull()
    // Resolved, so it keeps the context action (the unresolved source above has none).
    expect(screen.getByRole('button', { name: t('en', 'review.sourceContext.open') })).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('a source already missing at creation keeps its creation badge only: no missing-now badge and no missing-now count in the banner or the summary', async () => {
    const base = makeDetail().sources[0]!
    const detail = makeDetail({
      sources: [
        { ...base, key: 's1', availabilityAtCreation: 'missing' },
        {
          ...base,
          key: 's2',
          machineLabel: 'S2',
          documentId: 'd2',
          documentTitle: 'appendix.pdf',
          availabilityAtCreation: 'available'
        }
      ]
    })
    await renderReview({
      detail,
      fresh: makeFreshness({
        outdated: true,
        sources: [
          { key: 's1', state: 'missing' },
          { key: 's2', state: 'changed' }
        ]
      })
    })
    const title = await screen.findByText(t('en', 'review.outdated.title'))
    // The card: the creation fact, never a second "no longer present" badge (EvidencePane.tsx:269).
    expect(screen.getByText(t('en', 'review.source.missingAtCreation'))).toBeInTheDocument()
    expect(screen.queryByText(t('en', 'review.source.missingNow'))).toBeNull()
    // The banner: the changed source is drift; the creation-missing one is not (ReviewScreen.tsx `countMissingNow`).
    const banner = title.closest('[role="status"]') as HTMLElement
    expect(
      within(banner).getByText(t('en', 'review.outdated.sourcesChanged.one', { count: 1 }))
    ).toBeInTheDocument()
    expect(
      within(banner).queryByText(t('en', 'review.summary.sourcesMissingNow.one', { count: 1 }))
    ).toBeNull()
    // The summary: one source missing (at creation), one changed now, none missing now (ReviewSummaryView.tsx:73-82).
    const dialog = await openSummary()
    expect(
      within(dialog).getByText(t('en', 'review.summary.sourcesMissing.one', { count: 1 }))
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(t('en', 'review.summary.sourcesChangedNow.one', { count: 1 }))
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByText(t('en', 'review.summary.sourcesMissingNow.one', { count: 1 }))
    ).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('source-in-context: opens the modal, fetches by (reviewId, key), highlights the excerpt + hash line', async () => {
    const getEvidenceSourceContext = vi.fn(async () => ({
      reviewId: 'r1',
      key: 's1',
      documentTitle: 'contract.pdf',
      availability: 'available' as const,
      hashState: 'match' as const,
      snippet: 'Either party may terminate…',
      located: true,
      before: 'Clause 4 ends here. ',
      match: 'Either party may terminate…',
      after: ' Clause 6 begins.',
      pageNumber: 12,
      sectionLabel: null
    }))
    await renderReview({ detail: makeDetail(), api: { getEvidenceSourceContext } })
    fireEvent.click(
      await screen.findByRole('button', { name: t('en', 'review.sourceContext.open') })
    )
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(getEvidenceSourceContext).toHaveBeenCalledWith('r1', 's1'))
    expect(within(dialog).getByText(t('en', 'review.sourceContext.hashMatch'))).toBeInTheDocument()
    expect(within(dialog).getByText('Clause 4 ends here.', { exact: false })).toBeInTheDocument()
    // The excerpt is HIGHLIGHTED (a <mark>), not merely present.
    const mark = dialog.querySelector('mark')
    expect(mark?.textContent).toBe('Either party may terminate…')
    expect(within(dialog).getByText(t('en', 'review.sourceContext.storedNote'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  // #839 U1a: the modal's other three states. Each says what is true: a moved excerpt is not shown as context, a
  // changed file is not "unchanged", and a failed read is not an empty context.
  const located: EvidenceSourceContext = {
    reviewId: 'r1',
    key: 's1',
    documentTitle: 'contract.pdf',
    availability: 'available',
    hashState: 'match',
    snippet: 'Either party may terminate…',
    located: true,
    before: 'Clause 4 ends here. ',
    match: 'Either party may terminate…',
    after: ' Clause 6 begins.',
    pageNumber: 12,
    sectionLabel: null
  }
  it.each<[string, EvidenceSourceContext | null, MessageKey, MessageKey]>([
    [
      'the excerpt is no longer in the stored text',
      { ...located, located: false, before: null, match: null, after: null },
      'review.sourceContext.notLocated',
      'review.sourceContext.storedNote'
    ],
    ['the file changed since the answer', { ...located, hashState: 'mismatch' }, 'review.sourceContext.hashMismatch', 'review.sourceContext.hashMatch'],
    ['main could not read the context', null, 'review.sourceContext.failed', 'review.sourceContext.storedNote']
  ])('source-in-context when %s says so', async (_state, answer, shown, absent) => {
    const getEvidenceSourceContext = vi.fn(async () => answer)
    await renderReview({ detail: makeDetail(), api: { getEvidenceSourceContext } })
    fireEvent.click(await screen.findByRole('button', { name: t('en', 'review.sourceContext.open') }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(t('en', shown))).toBeInTheDocument()
    expect(within(dialog).queryByText(t('en', absent))).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('source-in-context: a missing document shows the §15.4 copy + the persisted excerpt', async () => {
    const getEvidenceSourceContext = vi.fn(async () => ({
      reviewId: 'r1',
      key: 's1',
      documentTitle: 'contract.pdf',
      availability: 'missing' as const,
      hashState: 'unknown' as const,
      snippet: 'Either party may terminate…',
      located: false,
      before: null,
      match: null,
      after: null,
      pageNumber: 12,
      sectionLabel: null
    }))
    await renderReview({ detail: makeDetail(), api: { getEvidenceSourceContext } })
    fireEvent.click(
      await screen.findByRole('button', { name: t('en', 'review.sourceContext.open') })
    )
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(t('en', 'review.sourceContext.missing'))
    expect(
      within(dialog).getByText(t('en', 'review.sourceContext.hashUnknown'))
    ).toBeInTheDocument()
    // The persisted excerpt remains readable (spec §15.4) — quoted, not highlighted.
    expect(
      within(dialog).getByText(t('en', 'review.sourceContext.excerptHeading'))
    ).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })
})

// #837: a review write that fails (a disk or SQLite I/O failure in practice) must stay visible and retryable, and a
// switch to another review must never drop the unsaved edit silently.
describe('ReviewScreen — a failed save is never dropped silently (#837)', () => {
  const DISK_FULL = "Error invoking remote method 'evidence:updateItem': Error: database or disk is full"

  /** Decide item 1 as Supported, then wait out the 600 ms debounce for the write to fail and Try again to show. */
  async function decideFirstItemAndWaitForFailure(): Promise<HTMLElement> {
    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.supported')) })
    )
    return screen.findByRole('button', { name: t('en', 'review.autosave.retry') }, { timeout: 3000 })
  }

  // #839 U1e.
  it('a failed write shows the save-error line, and Try again saves the edit and clears it', async () => {
    let fail = true
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (fail) throw new Error(DISK_FULL)
      return makeItem({ id, ...patch })
    })
    await renderReview({ api: { updateEvidenceReviewItem } })
    const retry = await decideFirstItemAndWaitForFailure()
    expect(screen.getByText(/database or disk is full/)).toBeInTheDocument()

    fail = false
    fireEvent.click(retry)
    expect(await screen.findByText(t('en', 'review.autosave.saved'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('en', 'review.autosave.retry') })).toBeNull()
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(2)
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i1', { decision: 'supported' })
  })

  // Review round 4: one sweep at a time — while a sweep's call is in flight the trigger is disabled (the store ignores a
  // second sweep too), and it comes back when the sweep settles.
  it('while a sweep is in flight, the Bulk actions trigger is disabled; it comes back when the sweep settles', async () => {
    const detail = makeDetail({
      items: [
        makeItem({ id: 'h1', blockKind: 'heading', textSnapshot: '## Heading', decision: 'not_reviewed' }),
        makeItem({ id: 'p1', textSnapshot: 'Alpha [S1]', decision: 'supported' }),
        makeItem({ id: 'p2', blockKey: 'b2-paragraph-x', textSnapshot: 'Beta' })
      ]
    })
    const bulk = bulkBackend(detail.items)
    const sweep = deferred()
    const applyEvidenceReviewBulkAction = vi.fn(async (reviewId: string, action: Parameters<typeof bulk.spy>[1]) => {
      await sweep.promise
      return bulk.spy(reviewId, action)
    })
    await renderReview({ detail, api: { applyEvidenceReviewBulkAction } })
    const trigger = screen.getByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })

    openBulkMenu()
    fireEvent.click(await screen.findByText(t('en', 'review.bulk.headingsNa')))
    await waitFor(() => expect(applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1))
    expect(trigger).toBeDisabled()
    sweep.resolve()
    await waitFor(() => expect(trigger).toBeEnabled())
    expect(applyEvidenceReviewBulkAction).toHaveBeenCalledTimes(1)
  })

  // Review round 2: only an edit a failed write left unsaved disables the trigger (the store's own refusal condition).
  it('after a failed acknowledge (nothing queued), the Bulk actions trigger stays enabled', async () => {
    await renderReview({
      api: {
        acknowledgeEvidenceReviewFreshness: vi.fn(async () => {
          throw new Error("Error invoking remote method 'evidence:acknowledgeFreshness': Error: db gone")
        })
      },
      fresh: makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    })
    fireEvent.click(await screen.findByRole('button', { name: t('en', 'review.outdated.acknowledge') }))
    expect(await screen.findByText(/db gone/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })).toBeEnabled()
  })

  // Review round 6: the save line's Try again is disabled while its retry runs, so a double click cannot start a second
  // retry over the first one's write (the store waits out a write in flight too).
  it('the save line’s Try again is disabled while its retry writes, and comes back when the write fails again', async () => {
    const hold: { gate?: Promise<void> } = {}
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (hold.gate) await hold.gate
      throw new Error(DISK_FULL)
    })
    await renderReview({ api: { updateEvidenceReviewItem } })
    const retry = await decideFirstItemAndWaitForFailure()
    const write = deferred()
    hold.gate = write.promise

    fireEvent.click(retry)
    await waitFor(() => expect(retry).toBeDisabled())
    fireEvent.click(retry) // the second click of a double click: ignored
    write.resolve() // the retry's write goes ahead, and fails again
    await waitFor(() => expect(retry).toBeEnabled())
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(2) // the debounce write + ONE retry
    expect(screen.getByText(/database or disk is full/)).toBeInTheDocument()
  })

  it('while a save error shows, the Bulk actions trigger is disabled, and it comes back once the edit is saved', async () => {
    let fail = true
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (fail) throw new Error(DISK_FULL)
      return makeItem({ id, ...patch })
    })
    await renderReview({ api: { updateEvidenceReviewItem } })
    const bulk = screen.getByRole('button', { name: new RegExp(t('en', 'review.bulk.menu')) })
    expect(bulk).toBeEnabled()
    const retry = await decideFirstItemAndWaitForFailure()
    expect(bulk).toBeDisabled()

    fail = false
    fireEvent.click(retry)
    await waitFor(() => expect(bulk).toBeEnabled())
  })

  /** Review r1 ("Lease check") with a failed edit, then the real switch path: the screen unmounts (its exit flush fails
   *  again) and mounts for r2 ("Gamma"). Returns the stubs once that mount shows the refusal card naming r1. */
  async function switchAfterFailedEdit(fail: { on: boolean; hold?: Promise<void> }): Promise<{
    onNavigate: ReturnType<typeof vi.fn>
    getEvidenceReview: ReturnType<typeof vi.fn>
    updateEvidenceReviewItem: ReturnType<typeof vi.fn>
  }> {
    const first = makeDetail({ title: 'Lease check' })
    const second = makeDetail({
      id: 'r2',
      messageId: 'm2',
      items: [makeItem({ id: 'j1', reviewId: 'r2', textSnapshot: 'Gamma' })]
    })
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) => {
      if (fail.hold) await fail.hold // a test can hold a write in flight
      if (fail.on) throw new Error(DISK_FULL)
      return makeItem({ id, ...patch })
    })
    const getEvidenceReview = vi.fn(async (id: string) => (id === 'r2' ? second : first))
    const onNavigate = vi.fn()
    const { view } = await renderReview({
      detail: first,
      api: { getEvidenceReview, updateEvidenceReviewItem },
      props: { onNavigate }
    })
    await decideFirstItemAndWaitForFailure()
    view.unmount()
    render(<ReviewScreen handoff={{ reviewId: 'r2' }} onNavigate={onNavigate} />)
    // Wait at once: the failed exit flush settles after the mount, inside this wait.
    await screen.findByText(t('en', 'review.unsaved.body', { title: 'Lease check' }))
    return { onNavigate, getEvidenceReview, updateEvidenceReviewItem }
  }

  it('switching to another review shows a card naming the unsaved review; Try again saves first, then opens it', async () => {
    const fail = { on: true }
    const { getEvidenceReview, updateEvidenceReviewItem } = await switchAfterFailedEdit(fail)
    expect(screen.getByText(t('en', 'review.unsaved.body', { title: 'Lease check' }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('en', 'review.unsaved.discard') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: new RegExp(t('en', 'review.back')) })).toBeInTheDocument()
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')

    // Try again while the disk is still full: one more write, and the card stays.
    const writes = updateEvidenceReviewItem.mock.calls.length
    const retry = screen.getByRole('button', { name: t('en', 'review.autosave.retry') })
    fireEvent.click(retry)
    await waitFor(() => expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(writes + 1))
    await waitFor(() => expect(retry).toBeEnabled()) // the retry has run its course
    expect(screen.getByText(t('en', 'review.unsaved.body', { title: 'Lease check' }))).toBeInTheDocument()
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')

    // The disk recovers: Try again writes the edit, then opens r2.
    fail.on = false
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.autosave.retry') }))
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    const lastWrite = updateEvidenceReviewItem.mock.invocationCallOrder.at(-1)!
    const r2Read = getEvidenceReview.mock.invocationCallOrder[getEvidenceReview.mock.calls.findIndex((c) => c[0] === 'r2')]!
    expect(lastWrite).toBeLessThan(r2Read)
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i1', { decision: 'supported' })
  })

  // Review round 1 (design-guidelines §6, WCAG 2.4.3): the card replaces the review seconds after the click that led
  // here, and that click's button left with the chat. Try again takes focus when the card appears, and the card's
  // sentence is its description, so a screen reader reads both (the WorkspaceGate step-focus precedent).
  it('the card puts focus on Try again when it appears, described by the card’s sentence', async () => {
    await switchAfterFailedEdit({ on: true })
    const retry = screen.getByRole('button', { name: t('en', 'review.autosave.retry') })
    await waitFor(() => expect(retry).toHaveFocus())
    expect(retry).toHaveAccessibleDescription(
      new RegExp(`^${escapeRe(t('en', 'review.unsaved.body', { title: 'Lease check' }))}`)
    )
  })

  // Review round 2: a Try again that fails again must not look like nothing happened — the card shows the save error
  // (the text of the review's own error line), and it is part of Try again's description.
  it('the card shows the save error, and Try again’s description carries it', async () => {
    await switchAfterFailedEdit({ on: true })
    const card = document.querySelector('.review-screen .card') as HTMLElement
    expect(within(card).getByText('database or disk is full')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('en', 'review.autosave.retry') })).toHaveAccessibleDescription(
      `${t('en', 'review.unsaved.body', { title: 'Lease check' })} database or disk is full`
    )
  })

  // Review round 2: the card names a failure. If a later save succeeds while it shows (the old screen's exit flush, a
  // timer), that failure is gone, so the card goes ahead with the switch it was shown for instead of claiming it.
  // Review round 3: the go-ahead is for the switch THIS screen was opened for. A refusal left over from an earlier
  // switch (the user went Back, a save then succeeded, and they opened a third review) must not open the old target.
  it('a card left over from an earlier switch never opens that switch’s target when the screen opens another review', async () => {
    const fail = { on: true }
    const { getEvidenceReview } = await switchAfterFailedEdit(fail)
    fail.on = false
    cleanup() // Back to chat: the card's screen unmounts; its exit flush now succeeds
    await act(async () => {
      await flushReviewSession()
    })
    render(<ReviewScreen handoff={{ reviewId: 'r3' }} onNavigate={noop} />)
    await waitFor(() => expect(getEvidenceReview).toHaveBeenCalledWith('r3'))
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  // Review round 3: while the card's own Try again runs, its save succeeding must not start a second open.
  it('when Try again’s save succeeds, the card opens the other review once, not twice', async () => {
    const fail = { on: true }
    const { getEvidenceReview } = await switchAfterFailedEdit(fail)
    fail.on = false
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.autosave.retry') }))
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)) // let any second open run
    })
    expect(getEvidenceReview.mock.calls.filter((c) => c[0] === 'r2')).toHaveLength(1)
  })

  it('if a later save succeeds while the card shows, the card goes ahead and opens the other review', async () => {
    const fail = { on: true }
    const { getEvidenceReview, updateEvidenceReviewItem } = await switchAfterFailedEdit(fail)
    fail.on = false
    await act(async () => {
      await flushReviewSession() // a save from elsewhere succeeds
    })
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(updateEvidenceReviewItem).toHaveBeenLastCalledWith('i1', { decision: 'supported' })
    expect(getEvidenceReview).toHaveBeenCalledWith('r2')
  })

  it('Try again and Discard are disabled while the retry writes, and focus returns to Try again when it fails again', async () => {
    const fail: { on: boolean; hold?: Promise<void> } = { on: true }
    const { getEvidenceReview } = await switchAfterFailedEdit(fail)
    const retry = screen.getByRole('button', { name: t('en', 'review.autosave.retry') })
    const discard = screen.getByRole('button', { name: t('en', 'review.unsaved.discard') })
    const write = deferred()
    fail.hold = write.promise

    fireEvent.click(retry)
    await waitFor(() => expect(retry).toBeDisabled())
    expect(discard).toBeDisabled()
    // Focus leaves Try again while the retry runs (a browser moves it off the disabled button; jsdom cannot blur a
    // disabled element, so it goes to the still-live Back here). When the retry fails, it comes back to Try again.
    const back = screen.getByRole('button', { name: new RegExp(t('en', 'review.back')) })
    back.focus()
    expect(back).toHaveFocus()
    write.resolve() // the held write goes ahead, and fails again
    await waitFor(() => expect(retry).toBeEnabled())
    expect(discard).toBeEnabled()
    await waitFor(() => expect(retry).toHaveFocus())
    expect(getEvidenceReview).not.toHaveBeenCalledWith('r2')
  })

  it('on that card, Back returns to chat and Discard changes and open opens the other review without the edit', async () => {
    const { onNavigate, updateEvidenceReviewItem } = await switchAfterFailedEdit({ on: true })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('en', 'review.back')) }))
    expect(onNavigate).toHaveBeenCalledWith('chat')

    const writes = updateEvidenceReviewItem.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.unsaved.discard') }))
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(updateEvidenceReviewItem).toHaveBeenCalledTimes(writes)
  })
})

// #837 part 3 (design-guidelines §6, M-U1): a live region that first appears already holding its text is missed by some
// screen readers. Both of this screen's late-arriving lines (the Outdated banner, the auto-save line) are announced from
// regions mounted EMPTY with the review; these rows pin that the text lands inside a node that existed before it.
// Whether Narrator then speaks it is a by-ear check (live-region-nesting.test.ts states the same limit).
describe('ReviewScreen — live regions exist before their text arrives (#837)', () => {
  it('the Outdated banner lands inside a status region that was mounted before the verdict', async () => {
    const verdict = deferred<EvidenceReviewFreshness | null>()
    await renderReview({ api: { refreshEvidenceReviewState: vi.fn(() => verdict.promise) } })
    const statusBefore = screen.getAllByRole('status')

    verdict.resolve(makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] }))
    const title = await screen.findByText(t('en', 'review.outdated.title'))
    expect(statusBefore).toContain(title.closest('[role="status"]'))
  })

  it('the auto-save line’s regions are mounted before the first edit: Saving… and a failure land inside them', async () => {
    const updateEvidenceReviewItem = vi.fn(async () => {
      throw new Error("Error invoking remote method 'evidence:updateItem': Error: database or disk is full")
    })
    await renderReview({ api: { updateEvidenceReviewItem } })
    const statusBefore = screen.getAllByRole('status')
    const alertBefore = screen.getAllByRole('alert')

    fireEvent.click(
      within(screen.getAllByRole('listitem')[0]).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.supported'))
      })
    )
    const saving = screen.getByText(t('en', 'review.autosave.saving'))
    expect(statusBefore).toContain(saving.closest('[role="status"]'))
    const failure = await screen.findByText(/database or disk is full/, {}, { timeout: 3000 })
    expect(alertBefore).toContain(failure.closest('[role="alert"]'))
  })
})

// #301 P6 (plan §9.23 (c)2) — "Open article" from an archive review row, end to end through
// the screen. This closes the §9.13 residual (BUILD_STATE §5 item 21(c)): P2 left an archive
// row honestly unavailable because the viewer bridge depended on P3b's locator contract.
//
// The load-bearing property is that the review reads its OWN FROZEN snapshot: `packs:getArticle`
// is called with the snapshot's packId + articlePath, and the header names the snapshot's
// archive title — whatever the live registry has since been renamed to, and whether or not the
// pack still exists. These two tests are the rename leg and the null leg: a deleted, disabled or
// unplugged pack all reach the renderer as the same `null` (main tells them apart, not the screen).
//
// `getPackArticle` is the ONE non-`evidence:*` bridge this screen may call (the file rule at the
// top): a local ZIM read through the main process — no model, no network — supplied explicitly
// so the structural `assertNoUnexpectedApiCalls()` teeth still bite on everything else.
describe('ReviewScreen — "Open article" from an archive evidence row (#301 P6, §9.23 (c)2)', () => {
  /** A review whose single source is a frozen archive citation. */
  function archiveDetail() {
    return makeDetail({
      sources: [
        archiveSource({
          key: 's1',
          kind: 'direct_excerpt',
          machineLabel: 'S1',
          documentTitle: 'Treibhausgas',
          sectionLabel: 'Landwirtschaft',
          pageNumber: null,
          snippet: 'Methan entsteht in der Landwirtschaft.',
          archiveTitle: 'Klimawandel von Wikipedia',
          packId: 'uuid-climate',
          articlePath: 'A/Treibhausgas'
        })
      ]
    })
  }

  const openArticleName = t('en', 'chat.sources.openArticleNamed', { title: 'Treibhausgas' })

  it('renamed pack: the bridge gets the SNAPSHOT locator and the header names the SNAPSHOT archive', async () => {
    // The live registry has since renamed this pack ("Wikipedia DE 2027"). `packs:getArticle`
    // resolves by archive UUID, so the article still opens — and the review keeps saying what it
    // recorded, never what the registry says today.
    const getPackArticle = vi.fn(async () => ({
      title: 'Treibhausgas',
      sections: [{ label: null, text: 'Treibhausgase sind Spurengase.' }],
      partial: false,
      notice: null
    }))
    await renderReview({ detail: archiveDetail(), api: { getPackArticle } })
    fireEvent.click(await screen.findByRole('button', { name: openArticleName }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Treibhausgase sind Spurengase.')).toBeInTheDocument()
    // EXACT call args — the frozen locator, not a live lookup.
    expect(getPackArticle).toHaveBeenCalledTimes(1)
    expect(getPackArticle).toHaveBeenCalledWith('uuid-climate', 'A/Treibhausgas')
    // #340 Tier-2: the review's viewer is read-only — no "Save to my documents" here, so the
    // evidence-only bridge rule above stays whole (`packs:saveArticle` is never reachable).
    expect(
      within(dialog).queryByRole('button', { name: new RegExp(t('en', 'chat.article.save')) })
    ).not.toBeInTheDocument()
    // The attribution names the snapshot's archive title…
    expect(
      within(dialog).getByText(
        t('en', 'chat.article.from', { archive: 'Klimawandel von Wikipedia' })
      )
    ).toBeInTheDocument()
    // …and IS the dialog's accessible description, with the article title as its name.
    const descId = dialog.getAttribute('aria-describedby')
    expect(descId).toBeTruthy()
    expect(document.getElementById(descId!)).toHaveTextContent(
      t('en', 'chat.article.from', { archive: 'Klimawandel von Wikipedia' })
    )
    expect(dialog).toHaveAccessibleName('Treibhausgas')
    assertNoUnexpectedApiCalls()
  })

  it('deleted or unavailable pack: the bridge resolves null, the viewer says so, the row still offers the article and the card is untouched', async () => {
    // The pack row is gone from the registry, disabled or unplugged: the bridge says `null` for all three.
    // Nothing about the frozen review changes — the locator, the archive title and the excerpt are all
    // still recorded facts.
    const getPackArticle = vi.fn(async () => null)
    await renderReview({ detail: archiveDetail(), api: { getPackArticle } })
    const button = await screen.findByRole('button', { name: openArticleName })
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(t('en', 'chat.article.unavailable'))).toBeInTheDocument()
    expect(getPackArticle).toHaveBeenCalledWith('uuid-climate', 'A/Treibhausgas')
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'common.close') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Still there, still named, still openable — a deleted pack does not erase the row.
    expect(screen.getByRole('button', { name: openArticleName })).toBeInTheDocument()
    expect(screen.getByText('Klimawandel von Wikipedia · Landwirtschaft')).toBeInTheDocument()
    // No invented content, and the frozen card is exactly as it was (carried from the retired "unavailable" row).
    expect(screen.getByText('Methan entsteht in der Landwirtschaft.')).toBeInTheDocument()
    expect(screen.getByText(t('en', 'review.source.archive'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })
})
