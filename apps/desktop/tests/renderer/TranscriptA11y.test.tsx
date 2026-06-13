// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AssistantMarkdown, Transcript } from '../../src/renderer/chat/Transcript'

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
    // Collapsed → the reasoning text is not in the DOM.
    expect(screen.queryByText('reasoning about the question')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('reasoning about the question')).toBeInTheDocument()
  })
})
