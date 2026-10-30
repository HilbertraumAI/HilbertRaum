// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Transcript } from '../../src/renderer/chat/Transcript'
import { makeMessage } from '../helpers/chat-fixtures'
import { renderTranscript, transcriptProps } from '../helpers/transcript'

// Transcript a11y: L15 — the live "Thinking…" disclosure is a <button aria-expanded>, not a
// <details> driven by preventDefault; FE-D — it and the compaction SummaryMarker name their regions via
// aria-controls. Also the message-level Export CSV gate. (The L1 link whitelist is pinned in
// assistant-markdown.test.tsx; the skill undo placement in SkillChat.test.tsx.)

afterEach(cleanup)

describe('Transcript Thinking disclosure (L15)', () => {
  function ThinkingHarness(): JSX.Element {
    const [open, setOpen] = useState(false)
    return (
      <Transcript
        {...transcriptProps({
          streamingHere: true,
          streamThinking: 'reasoning about the question',
          thinkingOpen: open,
          onThinkingOpenChange: setOpen
        })}
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
  it('names its region via aria-controls when expanded', () => {
    renderTranscript({
      messages: [makeMessage({ content: 'reply' })],
      summaryMarker: { beforeMessageId: 'a1', summary: 'Earlier context condensed.' }
    })
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

describe('message-level Export CSV action (result-tables §4, Phase 2)', () => {
  it('shows the button ONLY on answers carrying a result table, wired to that message id', () => {
    const seen: string[] = []
    renderTranscript({
      messages: [makeMessage({ id: 'with-table', hasResultTable: true }), makeMessage({ id: 'plain' })],
      onExportTable: (id) => seen.push(id)
    })
    const buttons = screen.getAllByRole('button', { name: 'Export CSV' })
    expect(buttons).toHaveLength(1) // the plain answer renders no export action
    fireEvent.click(buttons[0])
    expect(seen).toEqual(['with-table'])
  })

  it('renders no export button at all when the handler prop is absent', () => {
    renderTranscript({ messages: [makeMessage({ id: 'with-table', hasResultTable: true })] })
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })
})
