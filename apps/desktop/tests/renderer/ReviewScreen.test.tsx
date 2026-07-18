// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { evidencePaneMode } from '../../src/renderer/review/EvidencePane'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { t } from '../../src/shared/i18n'
import type { EvidenceReviewItemPatch } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeFreshness, makeItem, stubReviewApi } from '../helpers/evidenceReview'

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

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
})

afterEach(() => {
  // Unmount first: the flush-on-exit path runs against the SAME stub set, so a flush
  // hitting an unstubbed method is caught too.
  cleanup()
  assertNoUnexpectedApiCalls()
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
    stubReviewApi({
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
    stubReviewApi({
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
    stubReviewApi({
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => wholeDocDetail()) })
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
    stubReviewApi({
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => readyDetail()) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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

  it('Reopen restores editability (hint gone, controls live again)', async () => {
    const detail = readyDetail()
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail), reopenEvidenceReview })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.footer.summary') }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'review.summary.reopen') }))
    await waitFor(() => expect(reopenEvidenceReview).toHaveBeenCalledWith('r1'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('en', 'common.close') }))

    await waitFor(() =>
      expect(screen.queryByText(t('en', 'review.readonlyHint'))).toBeNull()
    )
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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

describe('evidencePaneMode — weak-degrade mapping (FIX-7c)', () => {
  it('relevance/absent → relevance; extract → structured; tree/capped AND unknown-PRESENT modes → whole_doc', () => {
    const cov = (mode: string) =>
      ({ mode, chunksCovered: 1, chunksTotal: 1 }) as unknown as NonNullable<
        Parameters<typeof evidencePaneMode>[0]
      >
    expect(evidencePaneMode(null)).toBe('relevance')
    expect(evidencePaneMode(cov('relevance'))).toBe('relevance')
    expect(evidencePaneMode(cov('extract'))).toBe('structured')
    expect(evidencePaneMode(cov('tree'))).toBe('whole_doc')
    expect(evidencePaneMode(cov('capped'))).toBe('whole_doc')
    // A PRESENT-but-unrecognized mode (workspace written by a newer app) degrades to the
    // WEAKEST claim — whole-document provenance, never citation framing (P1 FIX-1 mirror).
    expect(evidencePaneMode(cov('psychic'))).toBe('whole_doc')
  })
})

describe('ReviewScreen — completion gating (D-7)', () => {
  it('Mark ready stays disabled with the N-of-M hint until every required item is decided', async () => {
    const detail = makeDetail() // two required paragraphs, both not_reviewed
    stubReviewApi({
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
    stubReviewApi({
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
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detail),
      updateEvidenceReviewItem: vi.fn(async (id: string, patch: EvidenceReviewItemPatch) =>
        makeItem({ id, ...patch })
      ),
      setEvidenceLink,
      markEvidenceReviewReady
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detail) })
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

describe('ReviewScreen — P4 freshness overlay (plan §9, spec §15.4–15.5/§21.3/§28.6)', () => {
  it('calls refreshEvidenceReviewState ON OPEN; a fresh review shows NO banner and NO Outdated chip', async () => {
    const { refresh } = stubReviewApi({ getEvidenceReview: vi.fn(async () => makeDetail()) })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('r1'))
    expect(screen.queryByText(t('en', 'review.outdated.title'))).toBeNull()
    expect(screen.queryByText(t('en', 'review.status.outdated'))).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('an outdated verdict shows the banner (facts + §21.3 options), the ADDITIONAL chip, and the changed badge', async () => {
    stubReviewApi(
      { getEvidenceReview: vi.fn(async () => makeDetail()) },
      makeFreshness({
        outdated: true,
        answerState: 'changed',
        sources: [{ key: 's1', state: 'changed' }]
      })
    )
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    stubReviewApi(
      {
        getEvidenceReview: vi.fn(async () => makeDetail()),
        acknowledgeEvidenceReviewFreshness
      },
      makeFreshness({ outdated: true, sources: [{ key: 's1', state: 'changed' }] })
    )
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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

  it('a NEWLY-missing source shows the §15.4 badge WITHOUT the outdated banner (spec §25.2/§28.7)', async () => {
    stubReviewApi(
      { getEvidenceReview: vi.fn(async () => makeDetail()) },
      makeFreshness({ outdated: false, sources: [{ key: 's1', state: 'missing' }] })
    )
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    stubReviewApi(
      { getEvidenceReview: vi.fn(async () => detail) },
      makeFreshness({ outdated: false, sources: [{ key: 's1', state: 'unverifiable' }] })
    )
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => makeDetail()),
      getEvidenceSourceContext
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => makeDetail()),
      getEvidenceSourceContext
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
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
