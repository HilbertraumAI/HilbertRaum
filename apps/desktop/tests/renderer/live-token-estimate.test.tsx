// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  advanceWordTally,
  freshWordTally,
  type LiveWordTally
} from '../../src/renderer/screens/ChatScreen'

// PF-2 (full audit 2026-07-10): the live context-meter word count advances incrementally per
// flushed chunk instead of re-splitting the whole growing answer per ~40 ms flush. The meter is
// approximate by design, but the COUNT must be exactly equivalent to the old implementation —
// this suite pins that equivalence per flush over fixture and pseudo-random chunk streams.

/** The pre-PF-2 whole-buffer count, kept verbatim as the oracle. */
function oracleCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Feeds `chunks` cumulatively through one tally, asserting equality after EVERY flush. */
function assertStreamEquivalence(chunks: string[]): void {
  const tally: LiveWordTally = freshWordTally()
  let buf = ''
  for (const chunk of chunks) {
    buf += chunk
    expect(advanceWordTally(tally, buf)).toBe(oracleCount(buf))
  }
  // Final count once more via a fresh whole-text scan — same answer.
  expect(advanceWordTally(freshWordTally(), buf)).toBe(oracleCount(buf))
}

describe('advanceWordTally ≡ split-based word count (PF-2)', () => {
  it('matches on fixture chunk sequences: words split across chunks, whitespace runs, empty chunks', () => {
    assertStreamEquivalence([
      'Hel', // chunk boundary inside a word
      'lo wor',
      'ld', // word completed across three chunks
      '', // empty flush
      ' ', // chunk that is only whitespace
      '  multiple   spaces\t tabs ',
      '\n', // chunk boundary between whitespace runs
      '\n\nnew paragraph. ',
      'trailing space then word ',
      'end', // ends mid-word (endedInWord carried out of the stream)
      ' ', // whitespace directly after a chunk that ended in a word
      'x' // single-char word right after whitespace
    ])
  })

  it('matches on leading/trailing whitespace and whitespace-only streams', () => {
    assertStreamEquivalence(['   ', ' lead', 'ing', ' and trailing ', '  '])
    assertStreamEquivalence([' ', '\t', '\n', '   ']) // never a word — stays 0
    expect(advanceWordTally(freshWordTally(), '')).toBe(0)
    expect(oracleCount('')).toBe(0)
  })

  it('matches per flush over long pseudo-random chunk streams (deterministic LCG)', () => {
    // Character pool biased toward the nasty cases: multi-space runs, newlines, tabs,
    // punctuation-only "words", unicode whitespace (  is \s in JS).
    const pool = 'abc de  f\n\tg. h! … i- j'
    let seed = 0x51f15e
    const next = (mod: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % mod
    }
    for (let stream = 0; stream < 5; stream++) {
      const chunks: string[] = []
      for (let i = 0; i < 200; i++) {
        let chunk = ''
        const size = next(9) // 0..8 — includes empty chunks
        for (let c = 0; c < size; c++) chunk += pool[next(pool.length)]!
        chunks.push(chunk)
      }
      assertStreamEquivalence(chunks)
    }
  })

  it('resets when the text shrinks (a new turn) and is idempotent for an unchanged text', () => {
    const tally = freshWordTally()
    expect(advanceWordTally(tally, 'one two three')).toBe(3)
    expect(advanceWordTally(tally, 'one two three')).toBe(3) // unchanged text → no double count
    expect(advanceWordTally(tally, '')).toBe(0) // turn reset
    expect(advanceWordTally(tally, 'fresh answer')).toBe(2)
    expect(advanceWordTally(tally, 'fresh answer grew here')).toBe(4)
  })
})
