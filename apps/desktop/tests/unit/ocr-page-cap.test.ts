import { describe, it, expect } from 'vitest'
import { assertPageWithinByteCap, OCR_MAX_PAGE_PNG_BYTES } from '../../src/main/services/ocr/page-cap'

// REL-4 (backend-audit-2026-06-27): the OCR rasterizer caps render DIMENSIONS but previously
// returned the encoded page PNG to main with no BYTE cap — unlike the vision path. With the
// 1-deep look-ahead holding two page PNGs resident, a crafted PDF rasterising near the cap across
// many pages could drive main-process memory. `assertPageWithinByteCap` rejects an over-cap page
// before it is fed to recognition / held resident.

describe('assertPageWithinByteCap (OCR page byte cap, REL-4)', () => {
  it('accepts a page at or under the cap, rejects one over it (explicit cap — no huge alloc)', () => {
    expect(() => assertPageWithinByteCap(new Uint8Array(10), 10)).not.toThrow() // exactly at cap
    expect(() => assertPageWithinByteCap(new Uint8Array(9), 10)).not.toThrow() // under
    expect(() => assertPageWithinByteCap(new Uint8Array(11), 10)).toThrow(/too large/i) // over
  })

  it('uses the default cap when none is passed', () => {
    expect(() => assertPageWithinByteCap(new Uint8Array(1024))).not.toThrow()
  })

  it('the default cap is sized for a real dense scan, not arbitrarily small', () => {
    // A worst-case LEGITIMATE page is 4096×4096 RGBA ≈ 64 MiB raw and PNG-encodes to about that
    // for a near-incompressible scan. The cap must clear that so real dense color scans aren't
    // rejected — guards against a future "just mirror VISION's 20 MiB" regression.
    expect(OCR_MAX_PAGE_PNG_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024)
  })
})
