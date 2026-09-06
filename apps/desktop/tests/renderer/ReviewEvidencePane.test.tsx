// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EvidencePane } from '../../src/renderer/review/EvidencePane'
import { PROVENANCE_CARD_CAP } from '../../src/renderer/chat/SourcesDisclosure'
import {
  t,
  tCount,
  type CountMessageKey,
  type MessageKey,
  type MessageParams
} from '../../src/shared/i18n'
import type { EvidenceSourceSnapshot } from '../../src/shared/types'
import { makeDetail } from '../helpers/evidenceReview'

// EP-1 P5 (plan §10, spec §25.6/§26) — the evidence pane's large-set navigation: filter +
// STEPPED reveal over the PROVENANCE_CARD_CAP'd list. The measurement backing the
// no-virtualization decision is structural and pinned here: the mounted card count never
// exceeds `revealed` (cap-sized batches), so a 200-source set mounts 24 cards until the
// user asks for more — the spec's 24-card open-time norm is the initial render's ceiling
// by construction. (EvidencePane is pure — no window.api surface, so no stub set; the
// screen-level flows keep their structural tripwire in the ReviewScreen/Selections files.)

afterEach(cleanup)

const tEn = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
const tCountEn = (key: CountMessageKey, count: number, params?: MessageParams): string =>
  tCount('en', key, count, params)

function makeSources(n: number): EvidenceSourceSnapshot[] {
  const base = makeDetail().sources[0]
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    key: `s${i + 1}`,
    machineLabel: `S${i + 1}`,
    documentTitle: `doc-${i + 1}.pdf`,
    snippet: `Snippet number ${i + 1}`
  }))
}

function renderPane(sources: EvidenceSourceSnapshot[]): void {
  render(
    <EvidencePane
      sources={sources}
      coverage={{ mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }}
      selectedItem={null}
      readOnly={false}
      freshness={null}
      onLink={vi.fn()}
      onUnlink={vi.fn()}
      onSetRelation={vi.fn()}
      t={tEn}
      tCount={tCountEn}
    />
  )
}

const cardTitles = (): string[] =>
  Array.from(document.querySelectorAll('.source-card-title')).map((el) => el.textContent ?? '')

describe('EvidencePane — filter + stepped reveal (P5, spec §25.6)', () => {
  it('small sets: every card mounts, no filter input, no reveal button', () => {
    renderPane(makeSources(5))
    expect(cardTitles()).toHaveLength(5)
    expect(
      screen.queryByLabelText(tEn('review.evidence.filterLabel'))
    ).not.toBeInTheDocument()
    expect(document.querySelector('.sources-more')).not.toBeInTheDocument()
  })

  it('large sets: initial mount is CAPPED; reveal adds one cap-sized batch per click', () => {
    renderPane(makeSources(60))
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
    renderPane(sources)
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

  it('no match → honest empty state, zero cards', () => {
    renderPane(makeSources(30))
    fireEvent.change(screen.getByLabelText(tEn('review.evidence.filterLabel')), {
      target: { value: 'zzz-no-such-source' }
    })
    expect(screen.getByText(tEn('review.evidence.filterNone'))).toBeInTheDocument()
    expect(cardTitles()).toHaveLength(0)
  })

  it('selected item: visible context line IS the region\'s programmatic description (spec §23, FIX-3)', () => {
    const detail = makeDetail()
    render(
      <EvidencePane
        sources={detail.sources}
        coverage={detail.coverageSnapshot}
        selectedItem={detail.items[1]}
        selectedItemNumber={2}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        t={tEn}
        tCount={tCountEn}
      />
    )
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
    renderPane(makeSources(3))
    const region = screen.getByRole('region', { name: tEn('review.evidence.title') })
    expect(region).not.toHaveAttribute('aria-describedby')
  })

  it('DE: the filter matches the DISPLAYED [Qn] marker, not only the machine label (FIX-2)', () => {
    const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)
    const tCountDe = (key: CountMessageKey, count: number, params?: MessageParams): string =>
      tCount('de', key, count, params)
    render(
      <EvidencePane
        sources={makeSources(30)}
        coverage={{ mode: 'relevance', chunksCovered: 2, chunksTotal: 9 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        t={tDe}
        tCount={tCountDe}
      />
    )
    const input = screen.getByLabelText(tDe('review.evidence.filterLabel'))
    // The DE card displays [Q3]; typing what the card SHOWS must match source S3.
    fireEvent.change(input, { target: { value: 'Q3' } })
    expect(cardTitles()).toContain('doc-3.pdf')
    // The raw machine label keeps matching too (both facets honest).
    fireEvent.change(input, { target: { value: 'S3' } })
    expect(cardTitles()).toContain('doc-3.pdf')
  })

  it('ZIM wave (#294 review M11): archive card shows its own badge + where-line, no unresolved badge and no "Open source in context" button (EN + DE)', () => {
    const archiveSource: EvidenceSourceSnapshot = {
      ...makeDetail().sources[0]!,
      key: 'sArchive',
      machineLabel: 'S2',
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      mimeType: null,
      documentTitle: 'Klimawandel',
      sectionLabel: 'Übersicht',
      pageNumber: null,
      sourceKind: 'archive',
      archiveTitle: 'Wikipedia (DE)',
      packId: 'pack-uuid-1',
      articlePath: 'A/Klimawandel'
    }
    render(
      <EvidencePane
        sources={[archiveSource]}
        coverage={{ mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        onOpenContext={vi.fn()}
        t={tEn}
        tCount={tCountEn}
      />
    )
    expect(screen.getByText(tEn('review.source.archive'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.source.unresolved'))).not.toBeInTheDocument()
    expect(screen.getByText('Wikipedia (DE) · Übersicht')).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.sourceContext.open'))).not.toBeInTheDocument()

    cleanup()
    const tDe = (key: MessageKey, params?: MessageParams): string => t('de', key, params)
    const tCountDe = (key: CountMessageKey, count: number, params?: MessageParams): string =>
      tCount('de', key, count, params)
    render(
      <EvidencePane
        sources={[archiveSource]}
        coverage={{ mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        onOpenContext={vi.fn()}
        t={tDe}
        tCount={tCountDe}
      />
    )
    expect(screen.getByText(tDe('review.source.archive'))).toBeInTheDocument()
    expect(screen.queryByText(tDe('review.source.unresolved'))).not.toBeInTheDocument()
    expect(screen.queryByText(tDe('review.sourceContext.open'))).not.toBeInTheDocument()
  })

  // ---- "Open article" from an archive review row (#301 P6, plan §9.23 (c)2) ---------------
  // The §9.13 residual: P2 deliberately left an archive row with NO way to read the article
  // (the viewer bridge waited on P3b's locator contract). It exists now, and the row opens it
  // from its OWN frozen snapshot — never a live registry lookup.

  const archiveSnapshot = (over: Partial<EvidenceSourceSnapshot> = {}): EvidenceSourceSnapshot => ({
    ...makeDetail().sources[0]!,
    key: 'sArchive',
    machineLabel: 'S2',
    identity: 'unresolved',
    documentId: null,
    documentSha256: null,
    mimeType: null,
    documentTitle: 'Treibhausgas',
    sectionLabel: 'Landwirtschaft',
    pageNumber: null,
    sourceKind: 'archive',
    archiveTitle: 'Klimawandel von Wikipedia',
    packId: 'pack-uuid-1',
    articlePath: 'A/Treibhausgas',
    ...over
  })

  function renderArchive(
    source: EvidenceSourceSnapshot,
    onOpenArticle?: (s: EvidenceSourceSnapshot) => void
  ): void {
    render(
      <EvidencePane
        sources={[source]}
        coverage={{ mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        onOpenContext={vi.fn()}
        onOpenArticle={onOpenArticle}
        t={tEn}
        tCount={tCountEn}
      />
    )
  }

  it('#301 P6: an archive row offers a NAMED "Open article" and hands back its own frozen snapshot', () => {
    const onOpenArticle = vi.fn()
    const source = archiveSnapshot()
    renderArchive(source, onOpenArticle)
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
    // Unchanged by this phase: an archive is still never offered "Open source in context"
    // (there is no workspace document behind it).
    expect(screen.queryByText(tEn('review.sourceContext.open'))).not.toBeInTheDocument()
  })

  it('#301 P6: a pre-P2 archive row without a locator renders NO "Open article" button', () => {
    // A snapshot frozen before the locator fields existed cannot be opened — offering a
    // control that can only fail is worse than not offering it.
    const onOpenArticle = vi.fn()
    renderArchive(archiveSnapshot({ packId: null, articlePath: 'A/Treibhausgas' }), onOpenArticle)
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    cleanup()
    renderArchive(archiveSnapshot({ packId: 'pack-uuid-1', articlePath: null }), onOpenArticle)
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    // …and a caller that passes no handler at all gets no button either (callback gating).
    cleanup()
    renderArchive(archiveSnapshot())
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
    expect(onOpenArticle).not.toHaveBeenCalled()
  })

  it('#301 P6: a DOCUMENT row never offers "Open article" (it keeps "Open source in context")', () => {
    const onOpenArticle = vi.fn()
    render(
      <EvidencePane
        sources={[makeDetail().sources[0]!]}
        coverage={{ mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }}
        selectedItem={null}
        readOnly={false}
        freshness={null}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
        onSetRelation={vi.fn()}
        onOpenContext={vi.fn()}
        onOpenArticle={onOpenArticle}
        t={tEn}
        tCount={tCountEn}
      />
    )
    expect(screen.getByText(tEn('review.sourceContext.open'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('chat.sources.openArticle'))).not.toBeInTheDocument()
  })

  it('ZIM wave (#294 review M11): the filter matches the archive title too', () => {
    const sources = makeSources(30)
    const archived: EvidenceSourceSnapshot = {
      ...sources[5]!,
      sourceKind: 'archive',
      archiveTitle: 'UNIQUE_PACK_TITLE',
      packId: 'p1',
      articlePath: 'A/x'
    }
    renderPane([...sources.slice(0, 5), archived, ...sources.slice(6)])
    const input = screen.getByLabelText(tEn('review.evidence.filterLabel'))
    fireEvent.change(input, { target: { value: 'unique_pack_title' } })
    expect(cardTitles()).toEqual([archived.documentTitle])
  })

  it('ZIM wave (#294 review M11): a document card is unchanged — unresolved badge stays, no archive badge', () => {
    const documentSource: EvidenceSourceSnapshot = {
      ...makeDetail().sources[0]!,
      key: 'sDoc',
      identity: 'unresolved',
      documentId: null
    }
    renderPane([documentSource])
    expect(screen.getByText(tEn('review.source.unresolved'))).toBeInTheDocument()
    expect(screen.queryByText(tEn('review.source.archive'))).not.toBeInTheDocument()
  })

  it('matcher covers section label and page number; filter change RESETS the reveal (FIX-5b)', () => {
    const sources = makeSources(60).map((s, i) =>
      i === 40 ? { ...s, sectionLabel: 'Anhang B', pageNumber: 77 } : s
    )
    renderPane(sources)
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
