// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { StreamAnnouncer } from '../../src/renderer/chat/Transcript'

// Streaming live region (audit L7): the visible markdown bubble re-rendered the whole
// localized buffer every ~40 ms flush, so a role="log" on it either re-read the entire
// answer or went silent. The announcer is a separate visually-hidden plain-text region
// that only ever holds the newest COMPLETED sentence, stripped of markdown markup.

afterEach(cleanup)

function Harness({ initial = '' }: { initial?: string }): JSX.Element {
  const [text, setText] = useState(initial)
  return (
    <>
      <button onClick={() => setText('First sentence. Second senten')}>partial</button>
      <button onClick={() => setText('First sentence. Second sentence! Third…')}>more</button>
      <button onClick={() => setText('Reset')}>reset</button>
      <StreamAnnouncer text={text} />
    </>
  )
}

describe('StreamAnnouncer (L7)', () => {
  it('is an sr-only polite live region', () => {
    render(<StreamAnnouncer text="" />)
    const region = screen.getByRole('log')
    expect(region).toHaveClass('sr-only')
    expect(region).toHaveAttribute('aria-live', 'polite')
    // F23: additive log — must NOT be aria-atomic="true" (that re-reads the whole region on
    // every change, re-announcing prior sentences and defeating the slicing below).
    expect(region).not.toHaveAttribute('aria-atomic', 'true')
    expect(region).toBeEmptyDOMElement()
  })

  it('announces only completed sentences, holding back the in-progress tail', () => {
    render(<Harness />)
    const region = screen.getByRole('log')

    // A buffer whose last sentence is unfinished announces only the completed prefix.
    act(() => fireEvent.click(screen.getByRole('button', { name: 'partial' })))
    expect(region).toHaveTextContent('First sentence.')
    expect(region).not.toHaveTextContent('Second senten')

    // As more completes, the NEW completed sentences are announced (not the whole buffer:
    // "First sentence." is not repeated).
    act(() => fireEvent.click(screen.getByRole('button', { name: 'more' })))
    expect(region.textContent).toBe('Second sentence! Third…')
  })

  it('strips markdown markup from the announced text', () => {
    function MdHarness(): JSX.Element {
      const [text, setText] = useState('')
      return (
        <>
          <button onClick={() => setText('Use **bold** and `code` here. ')}>md</button>
          <StreamAnnouncer text={text} />
        </>
      )
    }
    render(<MdHarness />)
    act(() => fireEvent.click(screen.getByRole('button', { name: 'md' })))
    expect(screen.getByRole('log').textContent).toBe('Use bold and here.')
  })

  it('resets when a new, shorter stream replaces the old one', () => {
    render(<Harness initial="A long first answer. Done." />)
    const region = screen.getByRole('log')
    // Initial mount announces the completed prefix of the seeded buffer at once.
    expect(region.textContent).toBe('A long first answer. Done.')

    act(() => fireEvent.click(screen.getByRole('button', { name: 'reset' })))
    // Shorter buffer with no terminator → nothing new announced, prior text cleared.
    expect(region).toBeEmptyDOMElement()
  })
})
