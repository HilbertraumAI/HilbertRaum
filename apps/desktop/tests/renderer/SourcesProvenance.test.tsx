// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { t, tCount } from '../../src/shared/i18n'
import type { Citation, CoverageInfo, CoverageMode } from '../../src/shared/types'
import { makeCitations, makeMessage } from '../helpers/chat-fixtures'
import { renderTranscript } from '../helpers/transcript'

// Phase 5 (full-audit-2026-06-29 follow-up) — FE-B / F11 renderer half + FE-D a11y.
//
// A whole-document answer (mode tree/capped/extract) returns LEAF PROVENANCE — one "citation"
// per reachable section, up to ~1000, with no inline [Sn] grounding. The disclosure must NOT
// present that as "Sources (1000)" + 1000 cards (reads as "the model cited 1000 passages" and
// janks). It relabels to whole-document provenance, drops the [Sn] excerpt framing, and caps
// the rendered cards. A RELEVANCE answer (or a pre-migration NULL-coverage one) is unchanged:
// "Sources (N)", 1:1, every card, with [Sn] labels.
//
// FE-D: the disclosure toggle carries aria-controls naming the expanded region.

afterEach(cleanup)

function treeCoverage(covered: number): CoverageInfo {
  return { mode: 'tree', treeStatus: 'ready', chunksCovered: covered, chunksTotal: covered, tier: 1 }
}

// A persisted answer carrying `citations`, and `coverage` only when given (no key at all is the
// pre-migration NULL-coverage row).
const show = (citations: Citation[], coverage?: CoverageInfo): HTMLElement =>
  renderTranscript({ messages: [makeMessage({ citations, ...(coverage ? { coverage } : {}) })] }).container

const PROVENANCE_MODES: CoverageMode[] = ['tree', 'capped', 'extract']

describe('SourcesDisclosure — whole-document provenance vs inline citations (FE-B / F11)', () => {
  for (const mode of PROVENANCE_MODES) {
    it(`a ${mode}-mode answer relabels to whole-document provenance, NOT "Sources (N)"`, () => {
      const n = 1000
      show(makeCitations(n), { ...treeCoverage(n), mode })
      // The provenance label is shown; the literal "Sources (1000)" inline-citation label is NOT.
      expect(
        screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', n) })
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) })
      ).not.toBeInTheDocument()
    })
  }

  it('caps the rendered provenance cards (~24) and offers an "and N more" reveal', () => {
    const n = 1000
    const container = show(makeCitations(n), treeCoverage(n))
    fireEvent.click(
      screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', n) })
    )
    // Only the first 24 of 1000 sections render — not a 1000-card wall.
    expect(container.querySelectorAll('.source-card').length).toBe(24)
    // The cards are marked as sections covered, not cited excerpts: no [Sn] label.
    expect(container.querySelector('.cite-label')).toBeNull()
    expect(screen.getByText(t('en', 'chat.sources.wholeDocCaption'))).toBeInTheDocument()
    // The held-back tail is reachable via the reveal affordance.
    const more = screen.getByRole('button', { name: tCount('en', 'chat.sources.more', 976) })
    fireEvent.click(more)
    expect(container.querySelectorAll('.source-card').length).toBe(n)
  })

  // full-audit 2026-07-11 CODE-8: both provenance labels ride tCount — a one-section document
  // used to read "— 1 sections", a one-section reveal tail "and 1 more sections".
  it('CODE-8: the provenance label is singular at 1 section and plural at 2', () => {
    show(makeCitations(1), treeCoverage(1))
    expect(
      screen.getByRole('button', { name: 'Drawn from the document — 1 section' })
    ).toBeInTheDocument()
    cleanup()
    show(makeCitations(2), treeCoverage(2))
    expect(
      screen.getByRole('button', { name: 'Drawn from the document — 2 sections' })
    ).toBeInTheDocument()
  })

  it('CODE-8: the reveal tail is singular at exactly one held-back section and plural at two', () => {
    // 25 sections = 24 rendered + 1 held back; 26 = 24 + 2.
    show(makeCitations(25), treeCoverage(25))
    fireEvent.click(screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 25) }))
    expect(screen.getByRole('button', { name: 'and 1 more section' })).toBeInTheDocument()
    cleanup()
    show(makeCitations(26), treeCoverage(26))
    fireEvent.click(screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 26) }))
    expect(screen.getByRole('button', { name: 'and 2 more sections' })).toBeInTheDocument()
  })

  it('does not cap a small provenance list (under the cap renders every section)', () => {
    const container = show(makeCitations(5), treeCoverage(5))
    fireEvent.click(
      screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 5) })
    )
    expect(container.querySelectorAll('.source-card').length).toBe(5)
    expect(
      screen.queryByRole('button', { name: /more section/i })
    ).not.toBeInTheDocument()
  })

  it('a RELEVANCE answer is unchanged: "Sources (N)", every card 1:1, with [Sn] labels', () => {
    const n = 30
    const container = show(makeCitations(n), { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 })
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) }))
    expect(container.querySelectorAll('.source-card').length).toBe(n) // 1:1, NOT capped
    expect(container.querySelector('.cite-label')?.textContent).toBe('[S1]')
    expect(
      screen.queryByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', n) })
    ).not.toBeInTheDocument()
  })

  // #643: a document read whole in ONE grounded turn showed the model every section under its [Sn]
  // label, and the answer cites them inline — so its cards keep [Sn] and the "Sources (N)" framing.
  // A long read is still capped like provenance; the flag means nothing on any other mode.
  it('#643: a labelled whole read keeps "Sources (N)" and [Sn] on every card, capped at 24', () => {
    const n = 30
    const labelled: CoverageInfo = { mode: 'capped', chunksCovered: n, chunksTotal: n, truncated: false, labelledExcerpts: true }
    const container = show(makeCitations(n), labelled)
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) }))
    expect(container.querySelectorAll('.source-card').length).toBe(24)
    expect(container.querySelectorAll('.cite-label').length).toBe(24)
    expect(container.querySelector('.cite-label')?.textContent).toBe('[S1]')
    expect(screen.queryByText(t('en', 'chat.sources.wholeDocCaption'))).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: tCount('en', 'chat.sources.more', n - 24) }))
    expect(container.querySelectorAll('.cite-label').length).toBe(n)
    cleanup()
    show(makeCitations(3), { ...treeCoverage(3), labelledExcerpts: true })
    expect(screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 3) })).toBeInTheDocument()
  })

  it('a NULL-coverage citation-bearing answer (pre-migration) stays "Sources (N)" 1:1', () => {
    const n = 40
    const container = show(makeCitations(n)) // no coverage at all → undefined mode
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) }))
    expect(container.querySelectorAll('.source-card').length).toBe(n)
    expect(container.querySelector('.cite-label')).not.toBeNull()
  })
})

describe('SourcesDisclosure a11y — toggle aria-controls names the region (FE-D)', () => {
  // One toggle and one region element serve both framings (no mode branch in the ids or the role).
  it.each([
    ['provenance', treeCoverage(3), () => tCount('en', 'chat.sources.wholeDoc', 3)],
    [
      'relevance',
      { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 } as CoverageInfo,
      () => t('en', 'chat.sources.toggle', { count: 3 })
    ]
  ] as const)('aria-controls resolves to the rendered region id when expanded (%s)', (_kind, coverage, name) => {
    show(makeCitations(3), coverage)
    const toggle = screen.getByRole('button', { name: name() })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    // The sources region is named by the toggle and only present once expanded. (CH-12/#148
    // made the transcript scroller itself a labeled region, so the queries key on the
    // aria-controls id rather than "the only region".)
    expect(document.getElementById(controls!)).toBeNull()
    fireEvent.click(toggle)
    const region = document.getElementById(controls!)
    expect(region?.getAttribute('role')).toBe('region')
    expect(region?.getAttribute('aria-labelledby')).toBe(toggle.id)
    expect(region?.querySelectorAll('.source-card')).toHaveLength(3) // the region IS the cards panel
  })
})
