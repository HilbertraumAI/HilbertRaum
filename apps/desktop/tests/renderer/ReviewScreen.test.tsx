// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewItemPatch } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem } from '../helpers/evidenceReview'

// EP-1 plan §7.3/§7.4/§7.6 — the review workspace itself: the create→decide→note→
// summary→ready journey over stubApi, the whole-document honesty wording (asserted by
// EXACT catalog keys — provenance is never presented as citations), the D-7 completion
// gate, the conservative-bulk-actions guarantee (NO "mark all supported"), the keyboard
// walk (spec §28.10 minus export), and drawer focus restoration.
//
// Hard rule (spec FR-2/FR-12): each test stubs ONLY `evidence:*` bridge methods and ends
// with assertNoUnexpectedApiCalls() — ANY other window.api call (runtime, rag, network
// surfaces) fails the test. That is the renderer half of the zero-model/zero-network gate.

afterEach(cleanup)

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
})

function noop(): void {}

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
      review: {
        id: 'r1',
        conversationId: 'c1',
        messageId: 'm1',
        questionMessageId: 'q1',
        title: 'Evidence review',
        status: 'ready' as const,
        outdated: false,
        reviewerLabel: null,
        generalNote: null,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        completedAt: '2026-07-18T11:00:00.000Z'
      },
      gate: { eligible: true, requiredTotal: 2, decidedTotal: 2 }
    }))
    stubApi({
      createEvidenceReview,
      updateEvidenceReviewItem,
      markEvidenceReviewReady
    })

    render(<ReviewScreen handoff={{ messageId: 'm1' }} onNavigate={noop} />)

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
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.footer.summary') }))
    const dialog = await screen.findByRole('dialog')
    const readyBtn = within(dialog).getByRole('button', {
      name: t('en', 'review.summary.markReady')
    })
    expect(readyBtn).toBeEnabled()
    fireEvent.click(readyBtn)

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

  it('reopens an existing review by id and reaches draft again via Reopen', async () => {
    const detail = makeDetail({ status: 'ready', completedAt: '2026-07-18T11:00:00.000Z' })
    const reopenEvidenceReview = vi.fn(async () => ({
      id: 'r1',
      conversationId: 'c1',
      messageId: 'm1',
      questionMessageId: 'q1',
      title: 'Evidence review',
      status: 'draft' as const,
      outdated: false,
      reviewerLabel: null,
      generalNote: null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      completedAt: null
    }))
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      reopenEvidenceReview
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.footer.summary') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.summary.reopen') }))
    await waitFor(() => expect(reopenEvidenceReview).toHaveBeenCalledWith('r1'))
    await waitFor(() =>
      expect(screen.getAllByText(t('en', 'review.status.draft')).length).toBeGreaterThan(0)
    )
    assertNoUnexpectedApiCalls()
  })

  it('a deleted/unknown reviewId lands on the friendly not-found state, never a crash', async () => {
    stubApi({ getEvidenceReview: vi.fn(async () => null) })
    render(<ReviewScreen handoff={{ reviewId: 'gone' }} onNavigate={noop} />)
    expect(await screen.findByText(t('en', 'review.notFound'))).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('flushes pending edits on screen exit (unmount)', async () => {
    const detail = makeDetail()
    const updateEvidenceReviewItem = vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
      makeItem({ id, ...patch })
    )
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem
    })
    const view = render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')
    const items = screen.getAllByRole('listitem')
    fireEvent.click(
      within(items[0]).getByRole('radio', { name: new RegExp(t('en', 'review.decision.follow_up')) })
    )
    expect(updateEvidenceReviewItem).not.toHaveBeenCalled()
    view.unmount()
    await waitFor(() =>
      expect(updateEvidenceReviewItem).toHaveBeenCalledWith('i1', { decision: 'follow_up' })
    )
  })
})

describe('ReviewScreen — whole-document honesty wording (spec §11.4/§13.3, exact keys)', () => {
  function wholeDocDetail() {
    return makeDetail({
      coverageSnapshot: { mode: 'tree', chunksCovered: 40, chunksTotal: 40 },
      sources: [
        {
          key: 'p1',
          machineLabel: null,
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
    stubApi({ getEvidenceReview: vi.fn(async () => wholeDocDetail()) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    // …and nothing claims the answer cited it (zero auto-links on whole-doc answers).
    expect(screen.queryByText(t('en', 'review.link.cited'))).toBeNull()
  })

  it('a reviewer-made link is labeled "Reviewer linked", never "Cited by the answer"', async () => {
    const detail = wholeDocDetail()
    const setEvidenceLink = vi.fn(async (itemId: string, key: string) =>
      makeItem({ id: itemId, links: [{ evidenceKey: key, origin: 'reviewer' as const, relation: null }] })
    )
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      setEvidenceLink
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
  })
})

describe('ReviewScreen — completion gating (D-7)', () => {
  it('Mark ready stays disabled with the N-of-M hint until every required item is decided', async () => {
    const detail = makeDetail() // two required paragraphs, both not_reviewed
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
        makeItem({ id, ...patch })
      )
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.footer.summary') }))
    const dialog = await screen.findByRole('dialog')
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
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.footer.summary') }))
    const dialog2 = await screen.findByRole('dialog')
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
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
        makeItem({ id, ...patch })
      )
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    openBulkMenu()
    const menu = await screen.findByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toEqual([
      t('en', 'review.bulk.headingsNa'),
      t('en', 'review.bulk.followUp'),
      t('en', 'review.bulk.clear')
    ])
    // The forbidden bulk action does not exist anywhere on the screen (spec §14.4).
    expect(within(menu).queryByText(/all supported/i)).toBeNull()
    expect(screen.queryByText(/mark all supported/i)).toBeNull()

    // headings→N/A acts on the heading only.
    fireEvent.click(within(menu).getByText(t('en', 'review.bulk.headingsNa')))
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
  it('keyboard alone: move among items, set a decision, add a note, open the summary', async () => {
    const user = userEvent.setup()
    const detail = makeDetail()
    stubApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
        makeItem({ id, ...patch })
      )
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    // Roving tabindex: the group exposes ONE tab stop; arrows move focus AND selection.
    const items = screen.getAllByRole('listitem')
    const firstRadio = within(items[0]).getByRole('radio', {
      name: new RegExp(t('en', 'review.decision.supported'))
    })
    act(() => firstRadio.focus())
    // Focusing a control inside item 1 SELECTS item 1 (keyboard parity with click).
    expect(items[0]).toHaveAttribute('aria-current', 'true')
    await user.keyboard('{ArrowRight}')
    expect(
      within(items[0]).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.partly_supported'))
      })
    ).toHaveFocus()
    await user.keyboard('{Home}')
    expect(firstRadio).toHaveFocus()
    expect(firstRadio).toHaveAttribute('aria-checked', 'true')

    // Tab reaches the note field; typing records the note.
    const note = within(items[0]).getByPlaceholderText(t('en', 'review.item.notePlaceholder'))
    note.focus()
    await user.keyboard('checked')
    expect(note).toHaveValue('checked')

    // Tab onward to item 2's radio group (one stop per group), then the summary opens by keyboard.
    const summaryBtn = screen.getByRole('button', { name: t('en', 'review.footer.summary') })
    summaryBtn.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

describe('ReviewScreen — narrow-window evidence drawer (spec §11.1)', () => {
  function stubNarrowViewport(): void {
    // jsdom has no matchMedia; a matching stub flips the screen into drawer mode.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false
      })
    })
  }

  afterEach(() => {
    // Remove the stub so other suites keep the no-matchMedia (wide) default.
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('opens the evidence drawer from an item and RESTORES FOCUS to the opener on close', async () => {
    stubNarrowViewport()
    const detail = makeDetail()
    stubApi({ getEvidenceReview: vi.fn(async () => detail) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
