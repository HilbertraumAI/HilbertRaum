// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { ReviewScreen } from '../../src/renderer/screens/ReviewScreen'
import { resetReviewSessionForTests } from '../../src/renderer/lib/reviewSession'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'
import type { EvidenceSelectionInput } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makeDetail, makeItem, stubReviewApi } from '../helpers/evidenceReview'

// EP-1 P5 (plan §10, spec §12.1) — the reviewer text-selection UI. Offset-mapping strategy
// under test: the selection surface is a READ-ONLY <textarea> whose value IS the block's
// `textSnapshot` (the string the stored offsets index into), so its native selectionStart/
// selectionEnd are the UTF-16 code-unit offsets EXACTLY — never a mapping through the
// rendered markdown DOM (which drops syntax, localizes markers, and rewrites math). The
// service refuses misaligned offsets with null; the UI surfaces that as a friendly retry
// hint, never a crash. Selections are D-7-exempt and refuse while READY (P4 watch-out:
// the ready-guard refuses selection creation — the UI must hide the affordance).
//
// Structural no-call tripwire (P2 convention): stubReviewApi + file-wide afterEach.

beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

beforeEach(() => {
  resetReviewSessionForTests()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear() // the DE-surface leg seeds the language mirror
  assertNoUnexpectedApiCalls()
})

function noop(): void {}

/** A block whose snapshot carries markdown syntax + a marker — the raw string the
 *  selection surface must show VERBATIM (the rendered DOM would drop the asterisks). */
const RAW_BLOCK = 'Alpha **bold** [S1]'

function detailWithRawBlock() {
  return makeDetail({
    items: [
      makeItem({ id: 'i1', ordinal: 0, blockKey: 'b0-paragraph-abc', textSnapshot: RAW_BLOCK }),
      makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' })
    ]
  })
}

/** Drive the composer open on review item `n` (1-based) and return its surface textarea. */
async function openComposer(n: number): Promise<HTMLTextAreaElement> {
  const item = screen.getByRole('listitem', { name: t('en', 'review.item.aria', { n }) })
  fireEvent.click(
    within(item).getByRole('button', { name: t('en', 'review.selection.start') })
  )
  return (await within(item).findByRole('textbox', {
    name: t('en', 'review.selection.surfaceAria', { n })
  })) as HTMLTextAreaElement
}

function selectRange(surface: HTMLTextAreaElement, start: number, end: number): void {
  surface.setSelectionRange(start, end)
  fireEvent.select(surface)
}

describe('ReviewScreen — reviewer text selections (P5, spec §12.1)', () => {
  it('surface shows the RAW snapshot; offsets go to main verbatim; the created item renders', async () => {
    const created = makeItem({
      id: 'sel1',
      ordinal: 2,
      kind: 'selection',
      blockKey: 'b0-paragraph-abc',
      startOffset: 0,
      endOffset: 5,
      textSnapshot: RAW_BLOCK.slice(0, 5)
    })
    const createEvidenceSelection = vi.fn(
      async (_reviewId: string, _input: EvidenceSelectionInput) => created
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detailWithRawBlock()),
      createEvidenceSelection
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    const surface = await openComposer(1)
    // The surface is the SOURCE text — markdown asterisks and the machine marker intact
    // (the rendered item text above it shows neither).
    expect(surface.value).toBe(RAW_BLOCK)
    expect(surface.readOnly).toBe(true)

    // Nothing selected yet → the add action refuses.
    const addBtn = screen.getByRole('button', { name: t('en', 'review.selection.add') })
    expect(addBtn).toBeDisabled()

    selectRange(surface, 0, 5)
    expect(addBtn).toBeEnabled()
    fireEvent.click(addBtn)

    await waitFor(() =>
      expect(createEvidenceSelection).toHaveBeenCalledWith('r1', {
        blockKey: 'b0-paragraph-abc',
        startOffset: 0,
        endOffset: 5
      })
    )
    // The selection item appears with its tag, the exact slice, its own decision group,
    // and a remove action; the composer stays open (focus never lands in a removed tree).
    const selRow = await screen.findByRole('listitem', {
      name: t('en', 'review.item.aria', { n: 3 })
    })
    expect(within(selRow).getByText(t('en', 'review.item.selectionTag'))).toBeInTheDocument()
    expect(within(selRow).getByText('Alpha')).toBeInTheDocument()
    expect(
      within(selRow).getByRole('radio', {
        name: new RegExp(t('en', 'review.decision.supported'))
      })
    ).toBeInTheDocument()
    expect(
      within(selRow).getByRole('button', {
        name: new RegExp(t('en', 'review.selection.remove'))
      })
    ).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('offsets are UTF-16 code units — an astral-plane prefix counts as two units per char', async () => {
    // '😀😀 x' — each emoji is 2 UTF-16 units; selecting the 'x' = offsets 5..6.
    const astral = '😀😀 x'
    const createEvidenceSelection = vi.fn(async () =>
      makeItem({
        id: 'sel1',
        ordinal: 2,
        kind: 'selection',
        blockKey: 'b0-paragraph-abc',
        startOffset: 5,
        endOffset: 6,
        textSnapshot: 'x'
      })
    )
    stubReviewApi({
      getEvidenceReview: vi.fn(async () =>
        makeDetail({
          items: [
            makeItem({ id: 'i1', ordinal: 0, blockKey: 'b0-paragraph-abc', textSnapshot: astral }),
            makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' })
          ]
        })
      ),
      createEvidenceSelection
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    const surface = await openComposer(1)
    selectRange(surface, 5, 6)
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.selection.add') }))
    await waitFor(() =>
      expect(createEvidenceSelection).toHaveBeenCalledWith('r1', {
        blockKey: 'b0-paragraph-abc',
        startOffset: 5,
        endOffset: 6
      })
    )
    assertNoUnexpectedApiCalls()
  })

  it('a REFUSED selection (null from main) surfaces the friendly hint — no crash, no item', async () => {
    const createEvidenceSelection = vi.fn(async () => null)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () => detailWithRawBlock()),
      createEvidenceSelection
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText('Beta')

    const surface = await openComposer(1)
    selectRange(surface, 0, 5)
    fireEvent.click(screen.getByRole('button', { name: t('en', 'review.selection.add') }))

    expect(await screen.findByText(t('en', 'review.selection.refused'))).toBeInTheDocument()
    // Still two review items — nothing was added, and the screen kept working.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    // Never rendered as a save failure (the hint is a retry nudge, not an error state).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('deletes a selection via its remove action; block items offer no remove', async () => {
    const selection = makeItem({
      id: 'sel1',
      ordinal: 2,
      kind: 'selection',
      blockKey: 'b0-paragraph-abc',
      startOffset: 0,
      endOffset: 5,
      textSnapshot: 'Alpha'
    })
    const deleteEvidenceSelection = vi.fn(async () => true)
    stubReviewApi({
      getEvidenceReview: vi.fn(async () =>
        makeDetail({
          items: [
            makeItem({ id: 'i1', ordinal: 0 }),
            makeItem({ id: 'i2', ordinal: 1, blockKey: 'b1-paragraph-def', textSnapshot: 'Beta' }),
            selection
          ]
        })
      ),
      deleteEvidenceSelection
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText(t('en', 'review.item.selectionTag'))

    // Exactly ONE remove action on the whole screen — the selection's.
    const removes = screen.getAllByRole('button', {
      name: new RegExp(t('en', 'review.selection.remove'))
    })
    expect(removes).toHaveLength(1)
    fireEvent.click(removes[0])

    await waitFor(() => expect(deleteEvidenceSelection).toHaveBeenCalledWith('sel1'))
    await waitFor(() =>
      expect(screen.queryByText(t('en', 'review.item.selectionTag'))).not.toBeInTheDocument()
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    assertNoUnexpectedApiCalls()
  })

  it('READY review: no selection affordance anywhere, remove disabled (P4 watch-out)', async () => {
    const selection = makeItem({
      id: 'sel1',
      ordinal: 2,
      kind: 'selection',
      blockKey: 'b0-paragraph-abc',
      startOffset: 0,
      endOffset: 5,
      textSnapshot: 'Alpha'
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () =>
        makeDetail({
          status: 'ready',
          completedAt: '2026-07-18T11:00:00.000Z',
          items: [
            makeItem({ id: 'i1', ordinal: 0, decision: 'supported' }),
            makeItem({
              id: 'i2',
              ordinal: 1,
              blockKey: 'b1-paragraph-def',
              textSnapshot: 'Beta',
              decision: 'supported'
            }),
            selection
          ]
        })
      )
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText(t('en', 'review.item.selectionTag'))

    expect(
      screen.queryByRole('button', { name: t('en', 'review.selection.start') })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: new RegExp(t('en', 'review.selection.remove')) })
    ).toBeDisabled()
    assertNoUnexpectedApiCalls()
  })

  it('selections never gate D-7: progress and Mark-ready stay driven by block items only', async () => {
    const selection = makeItem({
      id: 'sel1',
      ordinal: 2,
      kind: 'selection',
      blockKey: 'b0-paragraph-abc',
      startOffset: 0,
      endOffset: 5,
      textSnapshot: 'Alpha',
      decision: 'not_reviewed' // undecided — must NOT block anything
    })
    stubReviewApi({
      getEvidenceReview: vi.fn(async () =>
        makeDetail({
          items: [
            makeItem({ id: 'i1', ordinal: 0, decision: 'supported' }),
            makeItem({
              id: 'i2',
              ordinal: 1,
              blockKey: 'b1-paragraph-def',
              textSnapshot: 'Beta',
              decision: 'supported'
            }),
            selection
          ]
        })
      )
    })
    render(<ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />)
    await screen.findByText(t('en', 'review.item.selectionTag'))

    // 2 of 2 — the undecided selection is exempt (fixture gate comes from MAIN's derive).
    expect(
      screen.getByText(t('en', 'review.progress', { decided: 2, required: 2 }))
    ).toBeInTheDocument()
    assertNoUnexpectedApiCalls()
  })

  it('DE: the surface stays the RAW snapshot even where the display transform rewrites it (FIX-5c)', async () => {
    // The rendered DE item shows [Q1] (localizeServerCopy → marker localization) — the
    // EN fixture can't see that divergence (the transform is ≈ identity there). The
    // textarea must carry the RAW stored [S1] string: the offsets index into IT.
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detailWithRawBlock()) })
    render(
      <I18nProvider>
        <ReviewScreen handoff={{ reviewId: 'r1' }} onNavigate={noop} />
      </I18nProvider>
    )
    await screen.findByText('Beta')

    const item = screen.getByRole('listitem', { name: t('de', 'review.item.aria', { n: 1 }) })
    fireEvent.click(
      within(item).getByRole('button', { name: t('de', 'review.selection.start') })
    )
    const surface = (await within(item).findByRole('textbox', {
      name: t('de', 'review.selection.surfaceAria', { n: 1 })
    })) as HTMLTextAreaElement
    // Raw machine marker + raw markdown — NOT the [Q1] the rendered block above shows.
    expect(surface.value).toBe(RAW_BLOCK)
    expect(surface.value).toContain('[S1]')
    expect(surface.value).not.toContain('[Q1]')
    assertNoUnexpectedApiCalls()
  })

  it('back button returns to the ORIGINATING conversation when wired (P5 back-nav)', async () => {
    const onBackToConversation = vi.fn()
    const onNavigate = vi.fn()
    stubReviewApi({ getEvidenceReview: vi.fn(async () => detailWithRawBlock()) })
    render(
      <ReviewScreen
        handoff={{ reviewId: 'r1' }}
        onNavigate={onNavigate}
        onBackToConversation={onBackToConversation}
      />
    )
    await screen.findByText('Beta')

    fireEvent.click(screen.getByRole('button', { name: `‹ ${t('en', 'review.back')}` }))
    // The review's conversationId (fixture 'c1') — never plain chat-home navigation.
    expect(onBackToConversation).toHaveBeenCalledWith('c1')
    expect(onNavigate).not.toHaveBeenCalled()
    assertNoUnexpectedApiCalls()
  })
})
