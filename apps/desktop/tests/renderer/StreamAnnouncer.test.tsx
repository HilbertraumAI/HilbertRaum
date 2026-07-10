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

  // F6 (full audit 2026-06-30, a11y): a long answer with no sentence terminator yet (a table, a
  // list, a run-on) would otherwise stay silent until completion. Past a soft cap the announcer
  // flushes complete words at the last word boundary, holding back the in-progress final word.
  it('falls back to a word boundary for a long answer with no sentence terminator (F6)', () => {
    function LongHarness(): JSX.Element {
      const [text, setText] = useState('')
      // ~210 chars of words, NO . ! ? … or newline, plus a trailing partial word.
      const longNoTerminator = 'word '.repeat(40) + 'tailpartial'
      return (
        <>
          <button onClick={() => setText(longNoTerminator)}>long</button>
          <StreamAnnouncer text={text} />
        </>
      )
    }
    render(<LongHarness />)
    const region = screen.getByRole('log')
    expect(region).toBeEmptyDOMElement()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'long' })))
    // It announced SOMETHING (the sentence-only path would have stayed silent — the teeth).
    expect((region.textContent ?? '').length).toBeGreaterThan(0)
    // The trailing partial word is held back (announced only up to a word boundary).
    expect(region.textContent).not.toContain('tailpartial')
  })

  // PF-1 (full audit 2026-07-10): the sentence-boundary scan now starts at the previous announce
  // point instead of re-scanning the whole growing buffer per ~40 ms flush (O(n²) per answer).
  // The announced output must be BYTE-IDENTICAL — this drives a long scripted stream (hundreds of
  // chunks, adversarial content: ellipsis runs, closing quotes after terminators, newline+quote
  // spans across the announce point, terminator-less F6 stretches, markdown, a mid-stream reset)
  // through the component and asserts the live region equals a test-local copy of the OLD
  // whole-buffer implementation after EVERY flush.
  it('announces byte-identically to the naive whole-buffer implementation over a long stream (PF-1)', () => {
    // --- test-local oracle: verbatim copy of the pre-PF-1 implementation ---
    const ORACLE_SOFT_CAP = 160
    function oracleLastSentenceBoundary(text: string): number {
      const re = /[.!?…\n]+["')\]]*(?=\s|$)/g
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) last = m.index + m[0].length
      return last
    }
    function oracleLastWordBoundary(text: string, from: number): number {
      for (let i = text.length - 1; i > from; i--) {
        if (/\s/.test(text[i]!)) return i + 1
      }
      return text.length
    }
    function oracleStripMarkdown(s: string): string {
      return s
        .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
        .replace(/[*_~`#>]+/g, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s*[-+*]\s+/gm, '')
        .replace(/\s+/g, ' ')
    }
    /** Replays the old effect body; returns the region's expected content after this flush. */
    function createOracle(): (text: string) => string {
      let len = 0
      let announced = ''
      return (text) => {
        if (text.length < len) {
          len = 0
          announced = ''
          return announced
        }
        let boundary = oracleLastSentenceBoundary(text)
        if (boundary <= len) {
          if (text.length - len < ORACLE_SOFT_CAP) return announced
          boundary = oracleLastWordBoundary(text, len)
          if (boundary <= len) return announced
        }
        const next = oracleStripMarkdown(text.slice(len, boundary)).trim()
        len = boundary
        if (next !== '') announced = next
        return announced
      }
    }

    // Adversarial content: every pattern that could make a from-the-tail scan diverge.
    const passage =
      'A plain sentence. Another one! A question? An ellipsis… then more.\n' +
      'Trailing dots.... "A quoted end." (Parenthesized end.) [Bracketed end.]\n' +
      'A terminator run crossing chunks..!?…\n\n"Quote right after a newline." ' +
      'Mixed close.")] and on. ' +
      // Terminator-less stretch well past the 160-char soft cap → exercises the F6 word-boundary
      // fallback (which sets an announce point that is NOT a regex match end).
      'word '.repeat(45) +
      '"quoted-token another stretch ' +
      'lang '.repeat(40) +
      '**bold markdown** with `code spans` and [a link](https://example.invalid) here.\n' +
      '- a bullet item. ' +
      'Sentence after markdown. Done…\n'
    const fullText = passage.repeat(4)

    // Deterministic LCG chunker (1..8 chars) — hundreds of chunks, boundaries land mid-run.
    let seed = 0x2f6e2b1
    const nextSize = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return 1 + (seed % 8)
    }

    const { rerender } = render(<StreamAnnouncer text="" />)
    const region = screen.getByRole('log')
    const oracle = createOracle()

    let buf = ''
    let chunks = 0
    while (buf.length < fullText.length) {
      buf = fullText.slice(0, Math.min(fullText.length, buf.length + nextSize()))
      chunks++
      act(() => rerender(<StreamAnnouncer text={buf} />))
      expect(region.textContent ?? '').toBe(oracle(buf))
    }
    expect(chunks).toBeGreaterThan(300) // "hundreds of chunks" — the teeth of the oracle sweep

    // Mid-run reset (a new, shorter stream) then a second streamed answer stays in lockstep.
    buf = ''
    act(() => rerender(<StreamAnnouncer text={buf} />))
    expect(region.textContent ?? '').toBe(oracle(buf))
    const second = 'Fresh answer after reset. It also ends…\n' + 'tail '.repeat(50) + 'end.'
    while (buf.length < second.length) {
      buf = second.slice(0, Math.min(second.length, buf.length + nextSize()))
      act(() => rerender(<StreamAnnouncer text={buf} />))
      expect(region.textContent ?? '').toBe(oracle(buf))
    }
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
