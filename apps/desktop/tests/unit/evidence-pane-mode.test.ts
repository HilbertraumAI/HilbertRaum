import { describe, it, expect } from 'vitest'
import { evidencePaneMode } from '../../src/shared/evidence-review'
import type { CoverageInfo } from '../../src/shared/types'

// The honesty class an answer's evidence presents as (EP-1 record §4, rag-design §16.1): the ONE mapping the review's evidence pane and
// the pack's coverage section share (evidence-pack-model.test.ts pins pack ≡ pane). Moved from ReviewScreen.test.tsx (FIX-7c, #643).
const cov = (mode: CoverageInfo['mode'], over: Partial<CoverageInfo> = {}): CoverageInfo => ({ mode, chunksCovered: 1, chunksTotal: 1, ...over })
/** A PRESENT mode this build has never heard of: a workspace written by a newer app (`parseCoverage` accepts any string). */
const unknownMode = (over: Partial<CoverageInfo> = {}): CoverageInfo =>
  ({ mode: 'psychic', chunksCovered: 1, chunksTotal: 1, ...over }) as unknown as CoverageInfo

describe('evidencePaneMode — weak-degrade mapping (FIX-7c)', () => {
  it('relevance/absent → relevance; extract → structured; tree/capped AND unknown-PRESENT modes → whole_doc', () => {
    expect(evidencePaneMode(null)).toBe('relevance')
    expect(evidencePaneMode(cov('relevance'))).toBe('relevance')
    expect(evidencePaneMode(cov('extract'))).toBe('structured')
    expect(evidencePaneMode(cov('tree'))).toBe('whole_doc')
    expect(evidencePaneMode(cov('capped'))).toBe('whole_doc')
    // A PRESENT-but-unrecognized mode degrades to the WEAKEST claim — whole-document provenance, never citation framing.
    expect(evidencePaneMode(unknownMode())).toBe('whole_doc')
  })

  it('#643: a capped answer stamped labelledExcerpts reads as relevance — no other mode can claim it', () => {
    expect(evidencePaneMode(cov('capped', { chunksCovered: 3, chunksTotal: 3, labelledExcerpts: true }))).toBe('relevance')
    expect(evidencePaneMode(cov('tree', { chunksCovered: 3, chunksTotal: 3, labelledExcerpts: true }))).toBe('whole_doc')
    expect(evidencePaneMode(unknownMode({ chunksCovered: 3, chunksTotal: 3, labelledExcerpts: true }))).toBe('whole_doc')
  })
})
