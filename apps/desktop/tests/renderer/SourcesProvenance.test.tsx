// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider } from '../../src/renderer/i18n'
import { t, tCount } from '../../src/shared/i18n'
import type { Citation, CoverageInfo, CoverageMode, Message } from '../../src/shared/types'

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

// jsdom does not implement Element.scrollTo (Transcript scrolls to newest content).
beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

function cites(n: number): Citation[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `S${i + 1}`,
    sourceTitle: `section ${i + 1}`,
    pageNumber: i + 1,
    snippet: `body of section ${i + 1}`
  }))
}

function message(citations: Citation[], coverage?: CoverageInfo): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: 'An answer.',
    createdAt: '2026-01-01T00:00:00Z',
    citations,
    ...(coverage ? { coverage } : {})
  }
}

function treeCoverage(covered: number): CoverageInfo {
  return { mode: 'tree', treeStatus: 'ready', chunksCovered: covered, chunksTotal: covered, tier: 1 }
}

function renderTranscript(m: Message): HTMLElement {
  const { container } = render(
    <I18nProvider>
      <Transcript
        messages={[m]}
        streamingHere={false}
        streamText=""
        streamThinking=""
        thinkingOpen={false}
        onThinkingOpenChange={() => {}}
        emptyState={null}
        onCopy={() => {}}
        onSave={() => {}}
        actionsDisabled={false}
      />
    </I18nProvider>
  )
  return container
}

const PROVENANCE_MODES: CoverageMode[] = ['tree', 'capped', 'extract']

describe('SourcesDisclosure — whole-document provenance vs inline citations (FE-B / F11)', () => {
  for (const mode of PROVENANCE_MODES) {
    it(`a ${mode}-mode answer relabels to whole-document provenance, NOT "Sources (N)"`, () => {
      const n = 1000
      renderTranscript(message(cites(n), { ...treeCoverage(n), mode }))
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
    const container = renderTranscript(message(cites(n), treeCoverage(n)))
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
    renderTranscript(message(cites(1), treeCoverage(1)))
    expect(
      screen.getByRole('button', { name: 'Drawn from the document — 1 section' })
    ).toBeInTheDocument()
    cleanup()
    renderTranscript(message(cites(2), treeCoverage(2)))
    expect(
      screen.getByRole('button', { name: 'Drawn from the document — 2 sections' })
    ).toBeInTheDocument()
  })

  it('CODE-8: the reveal tail is singular at exactly one held-back section and plural at two', () => {
    // 25 sections = 24 rendered + 1 held back; 26 = 24 + 2.
    renderTranscript(message(cites(25), treeCoverage(25)))
    fireEvent.click(screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 25) }))
    expect(screen.getByRole('button', { name: 'and 1 more section' })).toBeInTheDocument()
    cleanup()
    renderTranscript(message(cites(26), treeCoverage(26)))
    fireEvent.click(screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 26) }))
    expect(screen.getByRole('button', { name: 'and 2 more sections' })).toBeInTheDocument()
  })

  it('does not cap a small provenance list (under the cap renders every section)', () => {
    const container = renderTranscript(message(cites(5), treeCoverage(5)))
    fireEvent.click(
      screen.getByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', 5) })
    )
    expect(container.querySelectorAll('.source-card').length).toBe(5)
    expect(
      screen.queryByRole('button', { name: /more sections/i })
    ).not.toBeInTheDocument()
  })

  it('a RELEVANCE answer is unchanged: "Sources (N)", every card 1:1, with [Sn] labels', () => {
    const n = 30
    const container = renderTranscript(
      message(cites(n), { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 })
    )
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) }))
    expect(container.querySelectorAll('.source-card').length).toBe(n) // 1:1, NOT capped
    expect(container.querySelector('.cite-label')?.textContent).toBe('[S1]')
    expect(
      screen.queryByRole('button', { name: tCount('en', 'chat.sources.wholeDoc', n) })
    ).not.toBeInTheDocument()
  })

  it('a NULL-coverage citation-bearing answer (pre-migration) stays "Sources (N)" 1:1', () => {
    const n = 40
    const container = renderTranscript(message(cites(n))) // no coverage at all → undefined mode
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: n }) }))
    expect(container.querySelectorAll('.source-card').length).toBe(n)
    expect(container.querySelector('.cite-label')).not.toBeNull()
  })
})

describe('SourcesDisclosure a11y — toggle aria-controls names the region (FE-D)', () => {
  it('aria-controls resolves to the rendered region id when expanded (provenance)', () => {
    renderTranscript(message(cites(3), treeCoverage(3)))
    const toggle = screen.getByRole('button', {
      name: tCount('en', 'chat.sources.wholeDoc', 3)
    })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    // Region is named by the toggle and only present once expanded.
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(toggle)
    const region = screen.getByRole('region')
    expect(region.id).toBe(controls)
    expect(within(region).getByText(t('en', 'chat.sources.wholeDocCaption'))).toBeInTheDocument()
  })

  it('aria-controls resolves on a relevance disclosure too', () => {
    renderTranscript(message(cites(2), { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }))
    const toggle = screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: 2 }) })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.getByRole('region').id).toBe(controls)
  })
})
