import { describe, it, expect } from 'vitest'
import {
  alignNodes,
  comparePairOutputCap,
  COMPARE_OUTPUT_TOKENS,
  SYMMETRIC_COMPARE_CALL_CEILING,
  SYMMETRIC_MATCH_MIN_SCORE,
  type AlignNode
} from '../../src/main/services/doctasks/compare'

// Phase 4 (whole-document-analysis plan §4.3, H4/H8): the PURE symmetric-compare alignment.
// The mock embedder is deterministic + hash-based, so node alignment is meaningful only for
// STRUCTURE (M11): identical sections → cosine 1.0 → a mutual-best-match pair; unrelated
// sections → ~orthogonal → unmatched. The point of these tests is the MIRROR property —
// swapping A and B yields the mirror-image alignment (Only-A ↔ Only-B) — which is the
// honesty guarantee the asymmetric mode (b) cannot give.

/** A unit-length axis vector in `dim` dimensions (one-hot ⇒ orthogonal axes). */
function axis(dim: number, i: number): Float32Array {
  const v = new Float32Array(dim)
  v[i] = 1
  return v
}

function node(id: string, vec: Float32Array): AlignNode {
  return { id, vec }
}

/** Compare alignments as UNORDERED sets so a mirror can be asserted directly. */
function pairSet(pairs: Array<{ aId: string; bId: string }>): Set<string> {
  return new Set(pairs.map((p) => (p.aId < p.bId ? `${p.aId}|${p.bId}` : `${p.bId}|${p.aId}`)))
}

describe('alignNodes — greedy mutual-best-match', () => {
  it('matches identical sections and leaves orthogonal ones unmatched', () => {
    const a = [node('a1', axis(4, 0)), node('a2', axis(4, 1)), node('a3', axis(4, 2))]
    const b = [node('b1', axis(4, 0)), node('b2', axis(4, 1)), node('b3', axis(4, 3))]
    // a1≡b1, a2≡b2 (cos 1.0); a3 (axis 2) and b3 (axis 3) are orthogonal to everything.
    const r = alignNodes(a, b)
    expect(pairSet(r.pairs)).toEqual(new Set(['a1|b1', 'a2|b2']))
    expect(r.pairs.every((p) => p.score >= 0.99)).toBe(true)
    expect(r.unmatchedA).toEqual(['a3'])
    expect(r.unmatchedB).toEqual(['b3'])
  })

  it('is mirror-symmetric: swapping A and B swaps Only-A ↔ Only-B, pairs stable', () => {
    const a = [node('a1', axis(4, 0)), node('a2', axis(4, 1)), node('a3', axis(4, 2))]
    const b = [node('b1', axis(4, 0)), node('b2', axis(4, 3))]
    // a1≡b1; a2,a3,b2 unmatched.
    const fwd = alignNodes(a, b)
    const rev = alignNodes(b, a)
    // Same matched SET (as unordered id pairs).
    expect(pairSet(rev.pairs)).toEqual(pairSet(fwd.pairs))
    // Only-A and Only-B swap roles.
    expect(new Set(rev.unmatchedA)).toEqual(new Set(fwd.unmatchedB))
    expect(new Set(rev.unmatchedB)).toEqual(new Set(fwd.unmatchedA))
  })

  it('mirror holds even with tied scores (swap-invariant tie-break)', () => {
    // Two identical A sections compete for one identical B section (cos 1.0 tie).
    const a = [node('a1', axis(3, 0)), node('a2', axis(3, 0))]
    const b = [node('b1', axis(3, 0))]
    const fwd = alignNodes(a, b)
    const rev = alignNodes(b, a)
    expect(fwd.pairs).toHaveLength(1) // greedy: only one of a1/a2 pairs with b1
    expect(pairSet(rev.pairs)).toEqual(pairSet(fwd.pairs))
    expect(new Set(rev.unmatchedA)).toEqual(new Set(fwd.unmatchedB))
    expect(new Set(rev.unmatchedB)).toEqual(new Set(fwd.unmatchedA))
  })

  it('drops candidate pairs below the match floor', () => {
    // Partial overlap: a unit vector vs a 45° vector scores ~0.707 (above) ; a near-orthogonal
    // pair scores below the 0.5 floor and is NOT matched.
    const related = new Float32Array([1, 1, 0])
    const r = alignNodes([node('a1', axis(3, 0))], [node('b1', related)])
    expect(r.pairs).toHaveLength(1) // ~0.707 >= 0.5
    const r2 = alignNodes([node('a1', axis(3, 0))], [node('b1', axis(3, 1))], SYMMETRIC_MATCH_MIN_SCORE)
    expect(r2.pairs).toHaveLength(0) // orthogonal → below floor
    expect(r2.unmatchedA).toEqual(['a1'])
    expect(r2.unmatchedB).toEqual(['b1'])
  })

  it('skips dimension-mismatched candidates without throwing', () => {
    const r = alignNodes([node('a1', axis(4, 0))], [node('b1', axis(3, 0))])
    expect(r.pairs).toHaveLength(0)
    expect(r.unmatchedA).toEqual(['a1'])
    expect(r.unmatchedB).toEqual(['b1'])
  })
})

describe('comparePairOutputCap', () => {
  it('stays within the floor and the per-call output ceiling, shrinking as pairs grow', () => {
    const few = comparePairOutputCap(4096, 2)
    const many = comparePairOutputCap(4096, 40)
    expect(few).toBeLessThanOrEqual(COMPARE_OUTPUT_TOKENS)
    expect(many).toBeGreaterThanOrEqual(128) // never below the floor
    expect(many).toBeLessThanOrEqual(few)
  })

  it('exposes a CPU ceiling for the symmetric path', () => {
    expect(SYMMETRIC_COMPARE_CALL_CEILING).toBeGreaterThan(0)
  })
})
