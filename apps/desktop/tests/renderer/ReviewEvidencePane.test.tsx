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

    fireEvent.click(screen.getByRole('button', { name: tCountEn('chat.sources.more', 24) }))
    expect(cardTitles()).toHaveLength(48)

    // Final batch is the remainder (12) — then the button disappears.
    fireEvent.click(screen.getByRole('button', { name: tCountEn('chat.sources.more', 12) }))
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

  it('selected item renders the visible "linking evidence for item N" context line (spec §23)', () => {
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
  })
})
