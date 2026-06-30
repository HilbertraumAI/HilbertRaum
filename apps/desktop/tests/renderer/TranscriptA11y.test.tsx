// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AssistantMarkdown, Transcript } from '../../src/renderer/chat/Transcript'
import { I18nProvider } from '../../src/renderer/i18n'
import type { Message } from '../../src/shared/types'

// Two a11y/safety fixes in Transcript:
// L1 — the markdown `a` renderer whitelists http(s); a model-emitted javascript:/data:
//      link renders as inert text, not a clickable href.
// L15 — the live "Thinking…" disclosure is a <button aria-expanded>, not a <details>
//       driven by preventDefault, so the implicit expanded state cannot desync.

afterEach(cleanup)

// jsdom does not implement Element.scrollTo (Transcript scrolls to newest content).
beforeAll(() => {
  Element.prototype.scrollTo = (() => undefined) as Element['scrollTo']
})

function noop(): void {}

describe('AssistantMarkdown link scheme whitelist (L1)', () => {
  it('renders an http(s) link as an anchor', () => {
    render(<AssistantMarkdown text="see [docs](https://example.com)" />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders a javascript: link as inert text, not an anchor', () => {
    render(<AssistantMarkdown text="click [here](javascript:alert(1))" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('here')).toBeInTheDocument()
  })

  it('renders a data: link as inert text, not an anchor', () => {
    render(<AssistantMarkdown text="[x](data:text/html,<script>1</script>)" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('Transcript Thinking disclosure (L15)', () => {
  function ThinkingHarness(): JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <Transcript
        messages={[]}
        streamingHere
        streamText=""
        streamThinking="reasoning about the question"
        thinkingOpen={open}
        onThinkingOpenChange={setOpen}
        emptyState={null}
        onCopy={noop}
        onSave={noop}
        actionsDisabled={false}
      />
    )
  }

  it('exposes the toggle as a button whose aria-expanded tracks open state', () => {
    render(<ThinkingHarness />)
    const toggle = screen.getByRole('button', { name: /thinking/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Collapsed → the reasoning text is mounted (it keeps buffering) but hidden from view.
    expect(screen.getByText('reasoning about the question')).not.toBeVisible()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('reasoning about the question')).toBeVisible()
  })

  // FE-D (Phase 5): the toggle names its region via aria-controls; the region is labelled
  // by the toggle. The reasoning text region stays mounted, so aria-controls always resolves.
  it('wires the toggle to its region via aria-controls (FE-D)', () => {
    render(<ThinkingHarness />)
    const toggle = screen.getByRole('button', { name: /thinking/i })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    const region = document.getElementById(controls as string)
    expect(region).not.toBeNull()
    expect(region).toHaveTextContent('reasoning about the question')
    expect(region?.getAttribute('aria-labelledby')).toBe(toggle.id)
  })
})

// FE-D (Phase 5): the compaction summary marker disclosure carries aria-controls/region too.
describe('Transcript SummaryMarker disclosure a11y (FE-D)', () => {
  function renderWithMarker(): void {
    render(
      <I18nProvider>
        <Transcript
          messages={[
            { id: 'a1', conversationId: 'c1', role: 'assistant', content: 'reply', createdAt: '2026-06-17T00:00:00.000Z' }
          ]}
          streamingHere={false}
          streamText=""
          streamThinking=""
          thinkingOpen={false}
          onThinkingOpenChange={noop}
          emptyState={null}
          onCopy={noop}
          onSave={noop}
          actionsDisabled={false}
          summaryMarker={{ beforeMessageId: 'a1', summary: 'Earlier context condensed.' }}
        />
      </I18nProvider>
    )
  }

  it('names its region via aria-controls when expanded', () => {
    renderWithMarker()
    const toggle = screen.getByRole('button', { name: /earlier messages summarized/i })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls as string)).toBeNull() // collapsed: region absent
    fireEvent.click(toggle)
    const region = document.getElementById(controls as string)
    expect(region).not.toBeNull()
    expect(region).toHaveTextContent('Earlier context condensed.')
  })
})

// S13c (D3): the per-turn "answer without it" undo shows ONLY on an auto-fired turn — and only on the
// LAST assistant turn (re-running drops it). An explicitly-picked skill keeps the plain glyph, no undo.
describe('Transcript auto-fire undo (S13c/D3)', () => {
  function msg(over: Partial<Message>): Message {
    return {
      id: 'a1',
      conversationId: 'c1',
      role: 'assistant',
      content: 'an answer',
      createdAt: '2026-06-17T00:00:00.000Z',
      ...over
    }
  }

  function renderTranscript(messages: Message[], onAnswerWithoutSkill?: () => void): void {
    render(
      <I18nProvider>
        <Transcript
          messages={messages}
          streamingHere={false}
          streamText=""
          streamThinking=""
          thinkingOpen={false}
          onThinkingOpenChange={noop}
          emptyState={null}
          onAnswerWithoutSkill={onAnswerWithoutSkill}
          onCopy={noop}
          onSave={noop}
          actionsDisabled={false}
        />
      </I18nProvider>
    )
  }

  it('shows "Answered with …" + a working undo on an auto-fired last turn', () => {
    const undo = vi.fn()
    renderTranscript(
      [msg({ skillId: 'app:bank', skillTitle: 'Bank statement helper', autoFired: true })],
      undo
    )
    expect(screen.getByText('Answered with Bank statement helper')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Answer without it' })
    fireEvent.click(button)
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('shows the plain glyph and NO undo on an explicitly-picked turn', () => {
    renderTranscript(
      [msg({ skillId: 'app:bank', skillTitle: 'Bank statement helper', autoFired: false })],
      vi.fn()
    )
    expect(screen.getByText('Skill: Bank statement helper')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Answer without it' })).not.toBeInTheDocument()
  })

  it('shows no undo on an auto-fired turn that is not the last assistant turn', () => {
    renderTranscript(
      [
        msg({ id: 'a1', skillId: 'app:bank', skillTitle: 'Bank statement helper', autoFired: true }),
        msg({ id: 'u1', role: 'user', content: 'another question' }),
        msg({ id: 'a2', content: 'a later answer' })
      ],
      vi.fn()
    )
    // The auto-fire glyph stays visible (provenance), but the undo only rides the LAST assistant turn.
    expect(screen.getByText('Answered with Bank statement helper')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Answer without it' })).not.toBeInTheDocument()
  })
})
