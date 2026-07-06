// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t, type UiLanguage } from '../../src/shared/i18n'
import type { Citation, Message } from '../../src/shared/types'

// Beta-feedback plan Phase 1 (#28, D68) — German citation labels.
//
// The `[S{n}]` marker is a machine contract (baked into GROUNDING_RULES, persisted in
// citations_json). It is relabelled at DISPLAY time only: a German UI shows `Q{n}` ("Quelle",
// source) because "S" reads as "Seite" (page); an English UI keeps `S{n}` byte-identically. The
// rename lives in the source-card label (SourcesDisclosure) and the inline-body rewrite
// (displayMap.localizeServerCopy, called from Transcript for streaming AND persisted turns). A
// literal `[S1]` inside code stays verbatim (mirrors the math-delimiter guard).

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

// jsdom does not implement Element.scrollTo (Transcript scrolls to newest content).
beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

function cites(n: number): Citation[] {
  return Array.from({ length: n }, (_, i) => ({
    label: `S${i + 1}`, // machine-stable stored label, regardless of UI language
    sourceTitle: `section ${i + 1}`,
    pageNumber: i + 1,
    snippet: `body of section ${i + 1}`
  }))
}

function assistantMsg(content: string, citations: Citation[]): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:00Z',
    citations,
    coverage: { mode: 'relevance', chunksCovered: 0, chunksTotal: 0 }
  }
}

function renderTranscript(
  lang: UiLanguage,
  opts: { message?: Message; streamText?: string }
): HTMLElement {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
  const streaming = opts.streamText != null
  const { container } = render(
    <I18nProvider>
      <Transcript
        messages={opts.message ? [opts.message] : []}
        streamingHere={streaming}
        streamText={opts.streamText ?? ''}
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

describe('citation labels — display-time rename (#28, D68)', () => {
  it('a persisted turn in German shows [Q{n}] on the card AND in the answer body', () => {
    const container = renderTranscript('de', {
      message: assistantMsg('Der Vertrag bindet die Parteien [S1] und [S2].', cites(2))
    })
    // Body markers relabelled.
    expect(container.querySelector('.msg-content')?.textContent).toContain('[Q1]')
    expect(container.querySelector('.msg-content')?.textContent).toContain('[Q2]')
    expect(container.querySelector('.msg-content')?.textContent).not.toContain('[S1]')
    // Source-card label relabelled (expand the disclosure first).
    fireEvent.click(screen.getByRole('button', { name: t('de', 'chat.sources.toggle', { count: 2 }) }))
    const labels = [...container.querySelectorAll('.cite-label')].map((el) => el.textContent)
    expect(labels).toEqual(['[Q1]', '[Q2]'])
  })

  it('a persisted turn in English is byte-identical: [S{n}] on the card and in the body', () => {
    const container = renderTranscript('en', {
      message: assistantMsg('The contract binds the parties [S1] and [S2].', cites(2))
    })
    expect(container.querySelector('.msg-content')?.textContent).toContain('[S1]')
    expect(container.querySelector('.msg-content')?.textContent).toContain('[S2]')
    expect(container.querySelector('.msg-content')?.textContent).not.toContain('[Q')
    fireEvent.click(screen.getByRole('button', { name: t('en', 'chat.sources.toggle', { count: 2 }) }))
    const labels = [...container.querySelectorAll('.cite-label')].map((el) => el.textContent)
    expect(labels).toEqual(['[S1]', '[S2]'])
  })

  it('a streaming turn in German relabels the live body marker to [Q{n}]', () => {
    const container = renderTranscript('de', { streamText: 'Laut Dokument gilt [S2].' })
    const live = container.querySelector('.msg.assistant .msg-content')
    expect(live?.textContent).toContain('[Q2]')
    expect(live?.textContent).not.toContain('[S2]')
  })

  it('a streaming turn in English leaves the live body marker byte-identical', () => {
    const container = renderTranscript('en', { streamText: 'Per the document [S2].' })
    const live = container.querySelector('.msg.assistant .msg-content')
    expect(live?.textContent).toContain('[S2]')
    expect(live?.textContent).not.toContain('[Q')
  })

  it('keeps a literal [S1] inside a code span verbatim in a German UI (prose still relabels)', () => {
    const container = renderTranscript('de', {
      message: assistantMsg('Zitat [S1]; der Token `[S1]` im Code bleibt wörtlich.', cites(1))
    })
    const content = container.querySelector('.msg-content')
    // The code span keeps the literal S-marker…
    expect(within(content as HTMLElement).getByText('[S1]').tagName).toBe('CODE')
    // …while the prose citation is relabelled.
    expect(content?.textContent).toContain('[Q1]')
  })
})
