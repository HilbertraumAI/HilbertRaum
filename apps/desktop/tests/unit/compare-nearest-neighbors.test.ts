import { describe, it, expect } from 'vitest'
import { compareNearestNeighbors, type CompareCandidate } from '../../src/main/services/doctasks/compare'
import { cosineSimilarity, dotProduct } from '../../src/main/services/embeddings'

// P1 (full-audit-2026-06-30) — `compareNearestNeighbors` replaced the mode-(b) per-A-chunk
// `cosineSimilarity` scan + full `hits.sort().slice(topK)` with the `dotProduct` fast path + a
// running top-K. This proves the swap is BEHAVIOR-PRESERVING, in two exact links:
//
//   Test A (algorithm, EXACT — no float luck): the running top-K returns byte-identically what a
//           stable descending dot-sort + slice returns. This pins the selection algorithm.
//   Test B (cosine→dot ranking on L2-normalized vectors): a full dot-sort-slice selects the same
//           ids as the old full cosine-sort-slice. This is the RAG-1 invariant the swap rests on
//           (cosine == dot for unit vectors), and the teeth-check shows it depends on normalization.
//
// Chained, A∘B = "new dotProduct+running-topK == old cosineSimilarity+sort+slice". Pure + offline.

const DIM = 16

/** Deterministic L2-normalized vector for `seed` (distinct per seed → distinct scores). */
function unitVec(seed: number): Float32Array {
  const v = new Float32Array(DIM)
  let norm = 0
  for (let i = 0; i < DIM; i++) {
    v[i] = Math.sin(seed * 7.13 + i * 1.97)
    norm += v[i] * v[i]
  }
  const inv = 1 / Math.sqrt(norm)
  for (let i = 0; i < DIM; i++) v[i] *= inv
  return v
}

/** The PRE-P1 reference: cosineSimilarity over all candidates, full descending sort, slice topK. */
function oldCosineSortSlice(
  bChunks: readonly CompareCandidate[],
  vec: Float32Array,
  topK: number
): string[] {
  const hits: Array<{ chunkId: string; score: number }> = []
  for (const b of bChunks) {
    if (b.vec.length !== vec.length) continue
    hits.push({ chunkId: b.id, score: cosineSimilarity(vec, b.vec) })
  }
  hits.sort((x, y) => y.score - x.score) // V8 stable sort (insertion order on ties), like before
  return hits.slice(0, topK).map((h) => h.chunkId)
}

/** A full dot-product sort+slice — the SAME scoring fn as the new code, naive selection. */
function dotSortSlice(
  bChunks: readonly CompareCandidate[],
  vec: Float32Array,
  topK: number
): string[] {
  const hits: Array<{ chunkId: string; score: number }> = []
  for (const b of bChunks) {
    if (b.vec.length !== vec.length) continue
    hits.push({ chunkId: b.id, score: dotProduct(vec, b.vec) })
  }
  hits.sort((x, y) => y.score - x.score)
  return hits.slice(0, topK).map((h) => h.chunkId)
}

const corpus: CompareCandidate[] = Array.from({ length: 60 }, (_, i) => ({
  id: `b${String(i).padStart(2, '0')}`,
  vec: unitVec(i + 100)
}))

describe('compareNearestNeighbors (P1) — running top-K is byte-identical to dot-sort-slice', () => {
  it('matches a full dotProduct sort+slice for every topK across many queries (EXACT)', () => {
    for (const topK of [1, 3, 5, 12, 60, 100]) {
      for (let q = 0; q < 50; q++) {
        const vec = unitVec(q)
        const got = compareNearestNeighbors(corpus, vec, topK).map((h) => h.chunkId)
        expect(got).toEqual(dotSortSlice(corpus, vec, topK))
      }
    }
  })

  it('preserves the stable tie-break (equal scores keep doc-B insertion order), like sort+slice', () => {
    // Several candidates share the SAME vector ⇒ an exact score tie; one distinct lower one.
    const shared = unitVec(7)
    const bChunks: CompareCandidate[] = [
      { id: 'b0', vec: shared },
      { id: 'b1', vec: shared },
      { id: 'b2', vec: unitVec(999) }, // distinct, lower score for the `shared` query
      { id: 'b3', vec: shared },
      { id: 'b4', vec: shared }
    ]
    const got = compareNearestNeighbors(bChunks, shared, 3).map((h) => h.chunkId)
    expect(got).toEqual(dotSortSlice(bChunks, shared, 3))
    expect(got).toEqual(['b0', 'b1', 'b3']) // earliest three of the four tied, insertion order
  })

  it('skips length-mismatched candidates (never reaches dotProduct)', () => {
    const bChunks: CompareCandidate[] = [
      { id: 'ok', vec: unitVec(2) },
      { id: 'short', vec: new Float32Array(DIM - 1) }
    ]
    expect(compareNearestNeighbors(bChunks, unitVec(1), 5).map((h) => h.chunkId)).toEqual(['ok'])
  })
})

describe('compareNearestNeighbors (P1) — dotProduct ranks like cosine on L2-normalized vectors', () => {
  it('the dot-sort-slice selection equals the old cosine-sort-slice for every topK across many queries', () => {
    for (const topK of [1, 3, 5, 12]) {
      for (let q = 0; q < 50; q++) {
        const vec = unitVec(q)
        expect(dotSortSlice(corpus, vec, topK)).toEqual(oldCosineSortSlice(corpus, vec, topK))
      }
    }
  })

  it('… and so the full new helper equals the full old cosine path (the chained guarantee)', () => {
    for (const topK of [1, 3, 5, 12]) {
      for (let q = 0; q < 50; q++) {
        const vec = unitVec(q)
        const got = compareNearestNeighbors(corpus, vec, topK).map((h) => h.chunkId)
        expect(got).toEqual(oldCosineSortSlice(corpus, vec, topK))
      }
    }
  })
})
