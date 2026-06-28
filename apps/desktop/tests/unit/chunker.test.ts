import { describe, it, expect } from 'vitest'
import {
  chunkSegments,
  approxTokenCount,
  tokenize,
  truncateToApproxTokens,
  windowByTokens,
  CHUNK_DEFAULTS
} from '../../src/main/services/ingestion/chunker'
import type { ExtractedSegment } from '../../src/main/services/ingestion/parsers'

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('tokenize / approxTokenCount', () => {
  it('counts whitespace-delimited words, ignoring extra whitespace', () => {
    expect(tokenize('  hello   world\n\nfoo ')).toEqual(['hello', 'world', 'foo'])
    expect(approxTokenCount('one two three')).toBe(3)
    expect(approxTokenCount('   ')).toBe(0)
  })

  // The bug fix: a whitespace-word count collapses space-less or glued text to ~1 token,
  // which let document prompts overflow the model context (HTTP 400). The estimate must
  // NOT under-count these — it counts CJK per character and charges long no-space runs.
  it('counts space-less scripts (CJK/Thai) per character, not as one word', () => {
    expect(approxTokenCount('情報情報情報')).toBe(6) // 6 chars, no spaces → 6, not 1
    expect(approxTokenCount('你好世界')).toBe(4)
    expect(approxTokenCount('สวัสดีครับ')).toBeGreaterThanOrEqual(8)
  })

  it('charges an over-long no-space run by length instead of as a single token', () => {
    const blob = 'x'.repeat(4000) // one "word", no whitespace (e.g. base64 / glued PDF)
    expect(approxTokenCount(blob)).toBeGreaterThanOrEqual(1000)
  })

  it('still treats ordinary prose words as ~1 token each (no regression)', () => {
    expect(approxTokenCount(words(500))).toBe(500)
    // Normal-length words (incl. German compounds up to the threshold) stay 1 token.
    expect(approxTokenCount('the quick brown fox')).toBe(4)
  })
})

describe('windowByTokens (content-preserving, space-less safe)', () => {
  it('splits a space-less run into windows that each fit the budget', () => {
    const cjk = '情'.repeat(5000) // 5000 tokens, no whitespace
    const wins = windowByTokens(cjk, 500, 0)
    expect(wins.length).toBeGreaterThan(1)
    for (const w of wins) expect(approxTokenCount(w)).toBeLessThanOrEqual(500)
    // No characters inserted/dropped: the pieces concatenate back to the original.
    expect(wins.join('')).toBe(cjk)
  })

  it('keeps ordinary word windows within budget with overlap', () => {
    const wins = windowByTokens(words(110), 40, 10)
    for (const w of wins) expect(approxTokenCount(w)).toBeLessThanOrEqual(40)
    expect(wins.length).toBeGreaterThan(1)
  })

  // RAG-N2: a space-less run is hard-cut into window-sized character slices; the overlap
  // step-back can only re-include a WHOLE atom that is ≤ overlap, so a single 500-token slice
  // was never stepped back into → consecutive CJK windows shared ZERO tokens. Now the slices are
  // gcd(size, overlap) chars, so consecutive windows overlap by ~`overlap` tokens, like Latin.
  it('overlaps consecutive windows of a space-less (CJK) run by ~overlap tokens', () => {
    const cjk = '情'.repeat(1100) // one space-less run, 1100 approx-tokens
    const wins = windowByTokens(cjk, 500, 80)
    expect(wins.length).toBeGreaterThan(1)
    for (const w of wins) expect(approxTokenCount(w)).toBeLessThanOrEqual(500)
    // Each adjacent pair shares ~80 tokens: the tail of window k equals the head of window k+1.
    for (let k = 0; k < wins.length - 1; k += 1) {
      const ov = 80 // pure CJK ⇒ 1 token/char ⇒ 80 shared characters
      expect(wins[k].slice(-ov)).toBe(wins[k + 1].slice(0, ov))
    }
    // No content lost: stitching the windows on their overlap reproduces the original run.
    let stitched = wins[0]
    for (let k = 1; k < wins.length; k += 1) stitched += wins[k].slice(80)
    expect(stitched).toBe(cjk)
  })

  // Don't-regress: with overlap 0 a space-less run is still a lossless partition (the prior
  // behavior the audio split and `truncateToApproxTokens` rely on — no characters inserted).
  it('partitions a space-less run losslessly when overlap is 0', () => {
    const cjk = '報'.repeat(1234)
    const wins = windowByTokens(cjk, 500, 0)
    for (const w of wins) expect(approxTokenCount(w)).toBeLessThanOrEqual(500)
    expect(wins.join('')).toBe(cjk)
  })

  // RAG-N2 applies to an over-long no-space LATIN run too (base64 / a giant URL / a glued
  // PDF-extraction run) — those ARE space-less runs. The `glued` join reproduces them verbatim
  // (NO injected spaces), which also fixes a latent bug: the old char-slice path space-joined the
  // pieces, corrupting the run and breaking lossless reconstruction. Ordinary prose (words ≤ size)
  // is untouched — pinned byte-exact by the overlap tests above.
  it('glues an over-long no-space Latin run (no injected spaces) and gives it overlap', () => {
    const run = Array.from({ length: 2400 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('') // no spaces
    // overlap 0: a lossless partition with NO injected spaces (old code space-joined the slices).
    const w0 = windowByTokens(run, 500, 0)
    expect(w0.join('')).toBe(run)
    for (const w of w0) expect(w.includes(' ')).toBe(false)
    // overlap 80: still verbatim (no spaces), each ≤ budget, and consecutive windows now overlap
    // by ~80 tokens (= 320 Latin chars at ~4 chars/token) — previously the run got zero overlap.
    const w80 = windowByTokens(run, 500, 80)
    expect(w80.length).toBeGreaterThan(1)
    for (const w of w80) {
      expect(w.includes(' ')).toBe(false)
      expect(approxTokenCount(w)).toBeLessThanOrEqual(500)
    }
    expect(w80[0].slice(-320)).toBe(w80[1].slice(0, 320))
  })

  it('truncateToApproxTokens keeps a leading prefix within budget', () => {
    expect(approxTokenCount(truncateToApproxTokens(words(1000), 50))).toBeLessThanOrEqual(50)
    expect(truncateToApproxTokens('', 50)).toBe('')
  })
})

describe('chunkSegments — space-less documents (the HTTP 400 fix)', () => {
  it('bounds every chunk of a space-less document to the configured size', () => {
    // A 6000-char CJK paragraph with NO whitespace previously became ONE giant chunk
    // (~1 "word"); its prompt then overflowed the model context. It must window now.
    const cjk = '情報'.repeat(3000) // 6000 chars, zero spaces
    const chunks = chunkSegments([{ text: cjk }], { chunkSizeTokens: 500, chunkOverlapTokens: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500)
    // Content preserved across the chunk set.
    expect(chunks.map((c) => c.text).join('')).toBe(cjk)
  })
})

describe('chunkSegments boundaries + overlap', () => {
  it('produces a single chunk when the segment fits in one window', () => {
    const chunks = chunkSegments([{ text: words(100) }], { chunkSizeTokens: 500 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].tokenCount).toBe(100)
    expect(chunks[0].chunkIndex).toBe(0)
  })

  it('splits with the configured size and overlap', () => {
    // 110 tokens, size 40, overlap 10 → step 30 → windows at 0,30,60,90 (last is partial)
    const chunks = chunkSegments([{ text: words(110) }], {
      chunkSizeTokens: 40,
      chunkOverlapTokens: 10
    })
    expect(chunks.map((c) => c.tokenCount)).toEqual([40, 40, 40, 20])
    // chunk indices are sequential and global
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3])

    // Verify the overlap: last 10 tokens of chunk 0 equal first 10 of chunk 1.
    const c0 = chunks[0].text.split(' ')
    const c1 = chunks[1].text.split(' ')
    expect(c0.slice(30)).toEqual(c1.slice(0, 10))
  })

  it('does not emit a redundant tail chunk when a window reaches the end exactly', () => {
    // 60 tokens, size 40, overlap 10 → step 30 → starts 0,30; the 30..70 window covers
    // the tail, so there is no extra chunk starting at 60.
    const chunks = chunkSegments([{ text: words(60) }], {
      chunkSizeTokens: 40,
      chunkOverlapTokens: 10
    })
    expect(chunks.map((c) => c.tokenCount)).toEqual([40, 30])
  })

  it('keeps page/section metadata on every chunk and never crosses segments', () => {
    const segments: ExtractedSegment[] = [
      { text: words(50), pageNumber: 1, sectionLabel: 'Intro' },
      { text: words(50), pageNumber: 2, sectionLabel: 'Body' }
    ]
    const chunks = chunkSegments(segments, { chunkSizeTokens: 30, chunkOverlapTokens: 5 })
    // Each segment (50 tokens, step 25) → windows at 0,25 → 2 chunks per segment.
    const page1 = chunks.filter((c) => c.pageNumber === 1)
    const page2 = chunks.filter((c) => c.pageNumber === 2)
    expect(page1.every((c) => c.sectionLabel === 'Intro')).toBe(true)
    expect(page2.every((c) => c.sectionLabel === 'Body')).toBe(true)
    expect(page1.length + page2.length).toBe(chunks.length)
    // Global, contiguous indices across segment boundaries.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
  })

  it('skips empty/whitespace-only segments', () => {
    const chunks = chunkSegments([{ text: '   ' }, { text: words(5) }, { text: '' }])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].tokenCount).toBe(5)
  })

  it('caps the total number of chunks at maxChunks', () => {
    // 1000 tokens, size 10, no overlap → 100 windows, but capped at 5.
    const chunks = chunkSegments([{ text: words(1000) }], {
      chunkSizeTokens: 10,
      chunkOverlapTokens: 0,
      maxChunks: 5
    })
    expect(chunks).toHaveLength(5)
    expect(chunks.at(-1)?.chunkIndex).toBe(4)
  })

  it('clamps overlap below size so the window always advances', () => {
    // overlap >= size would stall; it must be clamped to size-1 (step 1). With 3 tokens
    // and size 2, the window at start=1 ([1,3)) already covers the tail → 2 chunks.
    const chunks = chunkSegments([{ text: words(3) }], {
      chunkSizeTokens: 2,
      chunkOverlapTokens: 5
    })
    expect(chunks.map((c) => c.tokenCount)).toEqual([2, 2])
  })

  it('exposes the spec §7.7 defaults', () => {
    expect(CHUNK_DEFAULTS).toEqual({ chunkSizeTokens: 500, chunkOverlapTokens: 80, maxChunks: 1000 })
  })

  // M6 (audit round 4): DOCX emits one segment per paragraph (no labels). Without
  // packing, every paragraph became its own tiny chunk — and a >maxChunks-paragraph
  // document silently lost its tail. Same-label neighbours must merge into full windows.
  it('packs consecutive same-label segments into full-size windows (DOCX paragraphs)', () => {
    // 60 paragraphs × 10 words = 600 tokens, all label-less → one logical stream.
    const paragraphs: ExtractedSegment[] = Array.from({ length: 60 }, () => ({ text: words(10) }))
    const chunks = chunkSegments(paragraphs, { chunkSizeTokens: 100, chunkOverlapTokens: 0 })
    // Packed: 600/100 = 6 chunks — NOT 60 one-paragraph confetti chunks.
    expect(chunks).toHaveLength(6)
    expect(chunks.every((c) => c.tokenCount === 100)).toBe(true)
  })

  it('never merges segments with different page/section labels', () => {
    const segments: ExtractedSegment[] = [
      { text: words(10), pageNumber: 1 },
      { text: words(10), pageNumber: 2 }, // different page → own chunk
      { text: words(10), sectionLabel: 'A' },
      { text: words(10), sectionLabel: 'B' } // different section → own chunk
    ]
    const chunks = chunkSegments(segments, { chunkSizeTokens: 100, chunkOverlapTokens: 0 })
    expect(chunks).toHaveLength(4)
    expect(chunks.map((c) => [c.pageNumber, c.sectionLabel])).toEqual([
      [1, null],
      [2, null],
      [null, 'A'],
      [null, 'B']
    ])
  })
})
