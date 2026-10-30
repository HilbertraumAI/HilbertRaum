// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { t } from '../../src/shared/i18n'
import { makeCitations, makeMessage } from '../helpers/chat-fixtures'
import { renderTranscript } from '../helpers/transcript'

// Beta-feedback plan Phase 1 (#28, D68) — German citation labels.
//
// The `[S{n}]` marker is a machine contract (baked into GROUNDING_RULES, persisted in
// citations_json). It is relabelled at DISPLAY time only: a German UI shows `Q{n}` ("Quelle",
// source) because "S" reads as "Seite" (page); an English UI keeps `S{n}` byte-identically. The
// rename lives in the source-card label (SourcesDisclosure) and the inline-body rewrite
// (displayMap.localizeServerCopy, called from Transcript for streaming AND persisted turns). A
// literal `[S1]` inside code stays verbatim (mirrors the math-delimiter guard). The relabel rule
// itself is the pure helper's (tests/unit/display-map.test.ts); this suite pins Transcript's wiring.

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('citation labels — display-time rename (#28, D68)', () => {
  it.each([
    ['de', 'Der Vertrag bindet die Parteien [S1] und [S2]; `[S1]` im Code bleibt wörtlich.', ['[Q1]', '[Q2]']],
    ['en', 'The contract binds the parties [S1] and [S2]; `[S1]` in code stays literal.', ['[S1]', '[S2]']]
  ] as const)(
    'a persisted turn in %s shows its markers on the card and in the prose; a code span keeps [S1]',
    (lang, content, labels) => {
      const { container } = renderTranscript({ messages: [makeMessage({ content, citations: makeCitations(2) })] }, lang)
      const body = container.querySelector('.msg-content') as HTMLElement
      // Prose markers in the UI language (D68); the code span is a literal, never relabelled.
      expect(body.textContent?.match(/\[[SQ]\d\]/g)).toEqual([...labels, '[S1]'])
      expect(body.querySelector('code')?.textContent).toBe('[S1]')
      // Source-card labels (expand the disclosure first).
      fireEvent.click(screen.getByRole('button', { name: t(lang, 'chat.sources.toggle', { count: 2 }) }))
      expect([...container.querySelectorAll('.cite-label')].map((el) => el.textContent)).toEqual(labels)
    }
  )

  it.each([
    ['de', 'Laut Dokument gilt [S2].', '[Q2]', '[S2]'],
    ['en', 'Per the document [S2].', '[S2]', '[Q']
  ] as const)('a streaming turn in %s shows the live body marker in the UI language', (lang, streamText, shown, hidden) => {
    const { container } = renderTranscript({ streamingHere: true, streamText }, lang)
    const live = container.querySelector('.msg.assistant .msg-content')
    expect(live?.textContent).toContain(shown)
    expect(live?.textContent).not.toContain(hidden)
  })
})
