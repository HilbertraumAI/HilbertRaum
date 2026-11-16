// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { PROVENANCE_CARD_CAP } from '../../src/renderer/chat/SourcesDisclosure'
import {
  t,
  tCount,
  type CountMessageKey,
  type MessageKey,
  type MessageParams
} from '../../src/shared/i18n'
import type { EvidenceSourceSnapshot } from '../../src/shared/types'
import { assertNoUnexpectedApiCalls, stubApi } from '../helpers/renderer'
import { archiveSource, makeDetail, makeSourceSnapshots } from '../helpers/evidenceReview'
import { renderEvidencePane } from '../helpers/review-screen'

// EP-1 P5 (plan §10, spec §25.6/§26) — the evidence pane's large-set navigation: filter +
// STEPPED reveal over the PROVENANCE_CARD_CAP'd list. The measurement backing the
// no-virtualization decision is structural and pinned here: the mounted card count never
// exceeds `revealed` (cap-sized batches), so a 200-source set mounts 24 cards until the
// user asks for more — the spec's 24-card open-time norm is the initial render's ceiling
// by construction. (EvidencePane is pure; an empty stub set plus the check makes that
// structural: an optional-chained `window.api?.x?.()` would otherwise pass silently. The
// screen-level flows keep their structural tripwire in the ReviewScreen/Selections files.)

beforeEach(() => {
  stubApi({})
})

afterEach(() => {
  try {
    cleanup()
  } finally {
    assertNoUnexpectedApiCalls()
  }
})

const tEn = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
const tCountEn = (key: CountMessageKey, count: number, params?: MessageParams): string =>
  tCount('en', key, count, params)

// The rows read these exact titles and snippets; every page is 12 and no source has a section label
// (the single matches below depend on that).
const makeSources = (n: number): EvidenceSourceSnapshot[] =>
  makeSourceSnapshots(n, (i) => ({
    key: `s${i + 1}`,
    machineLabel: `S${i + 1}`,
    documentTitle: `doc-${i + 1}.pdf`,
    snippet: `Snippet number ${i + 1}`,
    pageNumber: 12,
    sectionLabel: null
  }))

const cardTitles = (): string[] =>
  Array.from(document.querySelectorAll('.source-card-title')).map((el) => el.textContent ?? '')

describe('EvidencePane — filter + stepped reveal (P5, spec §25.6)', () => {
  it('small sets: every card mounts, no filter input, no reveal button', () => {
    renderEvidencePane({ sources: makeSources(5) })
    expect(cardTitles()).toHaveLength(5)
    expect(
      screen.queryByLabelText(tEn('review.evidence.filterLabel'))
    ).not.toBeInTheDocument()
    expect(document.querySelector('.sources-more')).not.toBeInTheDocument()
  })

  it('large sets: initial mount is CAPPED; reveal adds one cap-sized batch per click', () => {
    renderEvidencePane({ sources: makeSources(60) })
    // The no-virtualization measurement: 60 persisted sources, exactly 24 mounted cards.
    expect(cardTitles()).toHaveLength(PROVENANCE_CARD_CAP)
    expect(
      screen.getByText(
        tEn('review.evidence.shownCount', { shown: PROVENANCE_CARD_CAP, total: 60 })
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: tCountEn('review.evidence.more', 24) }))
    expect(cardTitles()).toHaveLength(48)

    // Final batch is the remainder (12) — then the button disappears.
    fireEvent.click(screen.getByRole('button', { name: tCountEn('review.evidence.more', 12) }))
    expect(cardTitles()).toHaveLength(60)
    expect(document.querySelector('.sources-more')).not.toBeInTheDocument()
  })

  it('filter matches title/snippet case-insensitively — including sources beyond the cap', () => {
    const sources = makeSources(30)
    renderEvidencePane({ sources })
    // 'doc-29' sits past the 24-card cap; the filter must still find it.
    const input = screen.getByLabelText(tEn('review.evidence.filterLabel'))
    fireEvent.change(input, { target: { value: 'DOC-29' } })
    expect(cardTitles()).toEqual(['doc-29.pdf'])

    // Snippet text matches too.
    fireEvent.change(input, { target: { value: 'snippet number 3' } })
    expect(cardTitles()).toEqual(['doc-3.pdf', 'doc-30.pdf'])

    // Clearing restores the capped view.
    fireEvent.click(screen.getByRole('button', { name: tEn('review.evidence.filterClear') }))
    expect(cardTitles()).toHaveLength(PROVENANCE_CARD_CAP)
  })

  // Second UI-languages wave owner call G-5 (2026-11-13): the filter folds with the shared `foldCase`
  // (`text-fold.test.ts` owns the letters). Plain toLowerCase() kept "ı" dotless and lowered "İ"
  // to "i" + U+0307, so neither search below found its card. Each side has its own failure: the
  // title's "İ" fails without the title-side fold; the typed «ısı» fails without the query-side
  // fold, and the snippet's own lower-case «ısı» fails without the snippet-side fold.
  it('the filter folds Turkish I letters: «istanbul» finds the «İSTANBUL» title, a typed «ısı» the «ısı» snippet', () => {
    const dotless = String.fromCharCode(0x0131)
    const istanbul = `${String.fromCharCode(0x0130)}STANBUL kira.pdf`
    const sources = makeSources(30)
    sources[25] = { ...sources[25]!, documentTitle: istanbul }
    sources[27] = { ...sources[27]!, snippet: `${dotless}s${dotless} yal${dotless}t${dotless}m${dotless}` }
    renderEvidencePane({ sources })
    const input = screen.getByLabelText(tEn('review.evidence.filterLabel'))
    fireEvent.change(input, { target: { value: 'istanbul' } })
    expect(cardTitles()).toEqual([istanbul])
    fireEvent.change(input, { target: { value: `${dotless}s${dotless}` } })
    expect(cardTitles()).toEqual(['doc-28.pdf'])
  })

  // The same owner call (G-5) for the two other card facts that hold a document's or a pack's own
  // text: each has its own fold, so a «İ» in it must match a plain-i query too (plain
  // toLowerCase() turns «İ» into "i" + U+0307, and "istanbul" is then no substring).
  const dottedI = String.fromCharCode(0x0130)
  it.each<[string, Partial<EvidenceSourceSnapshot>]>([
    ['section label', { sectionLabel: `${dottedI}STANBUL OF${dottedI}S${dottedI}` }],
    [
      'knowledge-pack title',
      {
        sourceKind: 'archive',
        archiveTitle: `${dottedI}stanbul rehberi`,
        packId: 'p1',
        articlePath: 'A/x'
      }
    ]
  ])('the filter folds a «İ» in the %s: «istanbul» finds its card', (_field, facts) => {
    const sources = makeSources(30)
    sources[26] = { ...sources[26]!, ...facts }
    renderEvidencePane({ sources })
    fireEvent.change(screen.getByLabelText(tEn('review.evidence.filterLabel')), {
      target: { value: 'istanbul' }
    })
    expect(cardTitles()).toEqual(['doc-27.pdf'])
  })

  it('no match → honest empty state, zero cards', () => {
    renderEvidencePane({ sources: makeSources(30) })
    fireEvent.change(screen.getByLabelText(tEn('review.evidence.filterLabel')), {
      target: { value: 'zzz-no-such-source' }
    })
    expect(screen.getByText(tEn('review.evidence.filterNone'))).toBeInTheDocument()
    expect(cardTitles()).toHaveLength(0)
  })

  it('selected item: visible context line IS the region\'s programmatic description (spec §23, FIX-3)', () => {
    const detail = makeDetail()
    renderEvidencePane({
      sources: detail.sources,
      coverage: detail.coverageSnapshot,
      selectedItem: detail.items[1],
      selectedItemNumber: 2
    })
    expect(
      screen.getByText(tEn('review.evidence.linkingItem', { n: 2 }))
    ).toBeInTheDocument()
    // The unselected-state hint is gone while an item is selected.
    expect(screen.queryByText(tEn('review.link.selectHint'))).not.toBeInTheDocument()
    // FIX-3: the region's aria-describedby points AT the linking line — the association
    // is programmatic, not just visual (same component mounts in aside AND drawer).
    const region = screen.getByRole('region', { name: tEn('review.evidence.title') })
    const descId = region.getAttribute('aria-describedby')
    expect(descId).toBeTruthy()
    expect(document.getElementById(descId!)).toHaveTextContent(
      tEn('review.evidence.linkingItem', { n: 2 })
    )
  })

  it('no selected item → no dangling aria-describedby on the region (FIX-3)', () => {
    renderEvidencePane({ sources: makeSources(3) })
    const region = screen.getByRole('region', { name: tEn('review.evidence.title') })
    expect(region).not.toHaveAttribute('aria-describedby')
  })

  it('DE: the filter matches the DISPLAYED [Qn] marker, not only the machine label (FIX-2)', () => {
    renderEvidencePane({ sources: makeSources(30) }, 'de')
    const input = screen.getByLabelText(t('de', 'review.evidence.filterLabel'))
    // The DE card displays [Q3]; typing what the card SHOWS must match source S3.
    fireEvent.change(input, { target: { value: 'Q3' } })
    expect(cardTitles()).toContain('doc-3.pdf')
    // The raw machine label keeps matching too (both facets honest).
    fireEvent.change(input, { target: { value: 'S3' } })
    expect(cardTitles()).toContain('doc-3.pdf')
  })

  it('ZIM wave (#294 review M11): archive card shows its own badge + where-line, no unresolved badge and no "Open source in context" button (EN + DE)', () => {
    const archiveCard = archiveSource({
      key: 'sArchive',
      machineLabel: 'S2',
      documentTitle: 'Klimawandel',
      sectionLabel: 'Übersicht',
      pageNumber: null,
      archiveTitle: 'Wikipedia (DE)',
      packId: 'pack-uuid-1',
      articlePath: 'A/Klimawandel'
    })
    const archivePane = {
      sources: [archiveCard],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 } as const,
      onOpenContext: vi.fn()
    }
    renderEvidencePane(archivePane)
    expect(screen.getByText(tEn('review.source.archive'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.source.unresolved'))).not.toBeInTheDocument()
    expect(screen.getByText('Wikipedia (DE) · Übersicht')).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.sourceContext.open'))).not.toBeInTheDocument()

    cleanup()
    renderEvidencePane(archivePane, 'de')
    expect(screen.getByText(t('de', 'review.source.archive'))).toBeInTheDocument()
    expect(screen.queryByText(t('de', 'review.source.unresolved'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('de', 'review.sourceContext.open'))).not.toBeInTheDocument()
  })

  // ---- "Open article" from an archive review row (#301 P6, plan §9.23 (c)2) ---------------
  // The §9.13 residual: P2 deliberately left an archive row with NO way to read the article
  // (the viewer bridge waited on P3b's locator contract). It exists now, and the row opens it
  // from its OWN frozen snapshot — never a live registry lookup.

  const archiveSnapshot = (over: Partial<EvidenceSourceSnapshot> = {}): EvidenceSourceSnapshot =>
    archiveSource({
      key: 'sArchive',
      machineLabel: 'S2',
      documentTitle: 'Treibhausgas',
      sectionLabel: 'Landwirtschaft',
      pageNumber: null,
      archiveTitle: 'Klimawandel von Wikipedia',
      packId: 'pack-uuid-1',
      articlePath: 'A/Treibhausgas',
      ...over
    })
  /** One card with the context handler wired (so a missing context button is the row's own guard), plus
   *  `onOpenArticle` when given: the props these rows rendered EvidencePane with before the shared helper. */
  const oneCard = (
    source: EvidenceSourceSnapshot,
    onOpenArticle?: (s: EvidenceSourceSnapshot) => void
  ) => ({
    sources: [source],
    coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 } as const,
    onOpenContext: vi.fn(),
    onOpenArticle
  })

  it('#301 P6: an archive row offers a NAMED "Open article" and hands back its own frozen snapshot', () => {
    const onOpenArticle = vi.fn()
    const source = archiveSnapshot()
    renderEvidencePane(oneCard(source, onOpenArticle))
    // The accessible name carries the article title (§9.23 (b)6); the visible word pair does not.
    const button = screen.getByRole('button', {
      name: tEn('chat.sources.openArticleNamed', { title: 'Treibhausgas' })
    })
    expect(button).toHaveTextContent(tEn('chat.sources.openArticle'))
    fireEvent.click(button)
    // The SNAPSHOT itself — the caller reads packId/articlePath off it, so a renamed pack in the
    // live registry can never redirect this row to a different archive.
    expect(onOpenArticle).toHaveBeenCalledTimes(1)
    expect(onOpenArticle.mock.calls[0][0]).toBe(source)
    // #418: the review's source cards are NOT the chat's citation cards — EvidencePane renders
    // its own, so the card-level save shortcut cannot reach a read-only review even by accident.
    // (The viewer opened from here is separately pinned read-only via canSave={false}.)
    expect(screen.queryByRole('button', { name: /Save to my documents/ })).not.toBeInTheDocument()
    // Unchanged by this phase: an archive is still never offered "Open source in context"
    // (there is no workspace document behind it).
    expect(screen.queryByText(tEn('review.sourceContext.open'))).not.toBeInTheDocument()
  })

  it('#301 P6: a pre-P2 archive row without a locator renders NO "Open article" button', () => {
    // A snapshot frozen before the locator fields existed cannot be opened — offering a
    // control that can only fail is worse than not offering it.
    const onOpenArticle = vi.fn()
    renderEvidencePane(
      oneCard(archiveSnapshot({ packId: null, articlePath: 'A/Treibhausgas' }), onOpenArticle)
    )
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    cleanup()
    renderEvidencePane(
      oneCard(archiveSnapshot({ packId: 'pack-uuid-1', articlePath: null }), onOpenArticle)
    )
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    // …and a caller that passes no handler at all gets no button either (callback gating).
    cleanup()
    renderEvidencePane(oneCard(archiveSnapshot()))
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    expect(onOpenArticle).not.toHaveBeenCalled()
  })

  it('#301 P6: a DOCUMENT row never offers "Open article" (it keeps "Open source in context")', () => {
    const onOpenArticle = vi.fn()
    renderEvidencePane(oneCard(makeDetail().sources[0]!, onOpenArticle))
    expect(screen.getByText(tEn('review.sourceContext.open'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
  })

  it('ZIM wave (#294 review M11): a document card is unchanged — unresolved badge stays, no archive badge', () => {
    const documentSource: EvidenceSourceSnapshot = {
      ...makeDetail().sources[0]!,
      key: 'sDoc',
      identity: 'unresolved',
      documentId: null
    }
    renderEvidencePane({ sources: [documentSource] })
    expect(screen.getByText(tEn('review.source.unresolved'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.source.archive'))).not.toBeInTheDocument()
  })

  it('matcher covers section label and page number; filter change RESETS the reveal (FIX-5b)', () => {
    const sources = makeSources(60).map((s, i) =>
      i === 40 ? { ...s, sectionLabel: 'Anhang B', pageNumber: 77 } : s
    )
    renderEvidencePane({ sources })
    // Reveal out to 48 first…
    fireEvent.click(screen.getByRole('button', { name: tCountEn('review.evidence.more', 24) }))
    expect(cardTitles()).toHaveLength(48)

    const input = screen.getByLabelText(tEn('review.evidence.filterLabel'))
    // …section-label facet (a source PAST the original cap)…
    fireEvent.change(input, { target: { value: 'anhang b' } })
    expect(cardTitles()).toEqual(['doc-41.pdf'])
    // …page-number facet…
    fireEvent.change(input, { target: { value: '77' } })
    expect(cardTitles()).toContain('doc-41.pdf')
    // …and clearing the filter RESTARTS the reveal at the cap (not the previous 48).
    fireEvent.click(screen.getByRole('button', { name: tEn('review.evidence.filterClear') }))
    expect(cardTitles()).toHaveLength(PROVENANCE_CARD_CAP)
  })
})
