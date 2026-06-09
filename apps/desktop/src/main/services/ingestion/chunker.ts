import type { ExtractedSegment } from './parsers'

// Chunker (spec §7.7). Splits a document's extracted segments into overlapping,
// fixed-size chunks ready for embedding (Phase 5) and retrieval (Phase 6).
//
// Token counting is an APPROXIMATION for the mock phase: we treat each whitespace-
// delimited word as one token. This is deterministic, dependency-free, and good
// enough to size chunks; a real tokenizer can replace `tokenize`/`approxTokenCount`
// later without changing the chunk metadata shape. The real model's context budget is
// generous relative to the 500-token target, so the approximation is safe.
//
// Chunking is done WITHIN each segment, so a chunk never straddles a page or section
// boundary — every chunk inherits exactly one `pageNumber`/`sectionLabel` from its
// source segment (spec §7.7 chunk metadata). Overlap is applied within a segment only.

export interface ChunkDefaults {
  chunkSizeTokens: number
  chunkOverlapTokens: number
  maxChunks: number
}

/** Spec §7.7 chunking defaults. */
export const CHUNK_DEFAULTS: ChunkDefaults = {
  chunkSizeTokens: 500,
  chunkOverlapTokens: 80,
  maxChunks: 1000
}

export type ChunkOptions = Partial<ChunkDefaults>

/** One produced chunk; maps directly onto the `chunks` table columns (spec §8). */
export interface DocumentChunk {
  chunkIndex: number
  text: string
  pageNumber: number | null
  sectionLabel: string | null
  tokenCount: number
}

/** Split text into approximate tokens (whitespace-delimited words). */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0)
}

/** Approximate token count for a string (see module note on the approximation). */
export function approxTokenCount(text: string): number {
  return tokenize(text).length
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/**
 * Chunk extracted segments into overlapping windows. Each window is at most
 * `chunkSizeTokens` tokens; consecutive windows overlap by `chunkOverlapTokens`.
 * The global chunk count is capped at `maxChunks` (spec §7.7 MVP guard) — once the
 * cap is hit, remaining text is dropped (the document still reaches `indexed`).
 */
export function chunkSegments(
  segments: ExtractedSegment[],
  options: ChunkOptions = {}
): DocumentChunk[] {
  const size = Math.max(1, Math.floor(options.chunkSizeTokens ?? CHUNK_DEFAULTS.chunkSizeTokens))
  // Overlap must be < size, otherwise the window never advances.
  const overlap = clampInt(options.chunkOverlapTokens ?? CHUNK_DEFAULTS.chunkOverlapTokens, 0, size - 1)
  const maxChunks = Math.max(0, Math.floor(options.maxChunks ?? CHUNK_DEFAULTS.maxChunks))
  const step = size - overlap

  const chunks: DocumentChunk[] = []
  let index = 0

  for (const segment of segments) {
    const tokens = tokenize(segment.text)
    if (tokens.length === 0) continue
    const pageNumber = segment.pageNumber ?? null
    const sectionLabel = segment.sectionLabel ?? null

    for (let start = 0; start < tokens.length; start += step) {
      if (index >= maxChunks) return chunks
      const slice = tokens.slice(start, start + size)
      chunks.push({
        chunkIndex: index,
        text: slice.join(' '),
        pageNumber,
        sectionLabel,
        tokenCount: slice.length
      })
      index += 1
      // This window already reached the end of the segment — stop before producing a
      // redundant tail chunk that begins inside the region we just covered.
      if (start + size >= tokens.length) break
    }
  }

  return chunks
}
