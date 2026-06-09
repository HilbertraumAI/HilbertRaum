import { describe, it, expect } from 'vitest'
import { chunkSegments, approxTokenCount, tokenize, CHUNK_DEFAULTS } from '../../src/main/services/ingestion/chunker'
import type { ExtractedSegment } from '../../src/main/services/ingestion/parsers'

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

describe('tokenize / approxTokenCount', () => {
  it('counts whitespace-delimited words, ignoring extra whitespace', () => {
    expect(tokenize('  hello   world\n\nfoo ')).toEqual(['hello', 'world', 'foo'])
    expect(approxTokenCount('one two three')).toBe(3)
    expect(approxTokenCount('   ')).toBe(0)
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
})
