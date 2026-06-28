// Per-page PNG byte cap for the OCR rasterizer (REL-4, backend-audit-2026-06-27).
//
// Kept in its own electron-free module so the cap logic is unit-testable under plain vitest
// (the rasterizer itself imports `electron`). The hidden window caps render DIMENSIONS at
// MAX_RENDER_PIXELS (4096/side, `renderer/ocr/main.ts`), but the ENCODED PNG it returns over
// IPC was previously unbounded — unlike the vision path, which enforces `VISION_MAX_IMAGE_BYTES`.
// With the 1-deep look-ahead holding up to TWO page PNGs resident, a crafted PDF rasterising
// near the worst case across many pages could drive main-process memory.

/**
 * Max accepted bytes for a single rendered page PNG. Sized to the WORST CASE of a LEGITIMATE
 * page, NOT VISION's 20 MiB (which would reject real dense scans): a 4096×4096 RGBA bitmap is
 * 64 MiB raw, and a near-incompressible scan PNG-encodes to about that size (deflate's
 * stored-block overhead is <1%). 96 MiB leaves generous headroom for per-row filter bytes + PNG
 * chunk overhead so a real dense color scan is never rejected, while still bounding the
 * two-resident-PNG footprint to well under 200 MiB. Env-overridable for an outlier DPI/page size
 * (`HILBERTRAUM_MAX_OCR_PAGE_BYTES`).
 */
export const OCR_MAX_PAGE_PNG_BYTES = readPageByteCap()

function readPageByteCap(): number {
  const raw = process.env.HILBERTRAUM_MAX_OCR_PAGE_BYTES?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 96 * 1024 * 1024
}

/**
 * Reject a rendered page PNG that exceeds the per-page byte cap (REL-4). Throws so the OCR
 * task's try/catch downgrades to a friendly failure instead of feeding an oversized buffer to
 * recognition (and holding it resident behind the look-ahead). Pure — no I/O.
 */
export function assertPageWithinByteCap(
  png: Uint8Array,
  maxBytes: number = OCR_MAX_PAGE_PNG_BYTES
): void {
  if (png.byteLength > maxBytes) throw new Error('The rendered page was too large')
}
