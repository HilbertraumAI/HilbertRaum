import type { OcrEngine, OcrResult } from './index'
import type { OcrTurn } from './orientation'

// Read a page the right way up (#538) — the policy, kept apart from the engine so it is testable
// with a fake one. Measured on rendered pages (deu+eng, `best_int`): an upright clean page reads at
// mean confidence 92–94, the same page sideways or upside down at 34–62 with 0 words right, and a
// degraded but UPRIGHT photocopy also at ~53 — so a low confidence cannot by itself tell a sideways
// page from a poor one, and the orientation check is asked only below the acceptance line. Tesseract
// OSD (`detectOrientation`) found the right turn on every clean and moderately degraded page in
// 0.15–0.7 s; on a very degraded or near-blank page it declines ("too few characters"). Its own
// confidence is unreliable (often < 3 when right), so its answer is never trusted blindly: the page
// is read at the suggested turn too and the more confident READING wins.

/** A reading at or above this mean confidence (0–100) is accepted without an orientation check. */
export const OCR_ACCEPT_CONFIDENCE = 75

export interface UprightReading extends OcrResult {
  /** The clockwise turn the kept reading was made at. */
  turn: OcrTurn
}

export interface ReadUprightOptions {
  signal?: AbortSignal
  /**
   * The turn to try first — the previous page's, when a scan is read page by page: a scan that is
   * sideways is usually sideways throughout, so its later pages then cost one reading each.
   */
  first?: OcrTurn
}

function score(r: OcrResult): number {
  return typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0
}

/**
 * Read `image` at `first` (default upright). A confident reading is kept as is: clean upright
 * scans pay nothing extra. Otherwise, when the engine can detect orientation, ask it; if it names
 * another turn (or declines while `first` was not upright), read at that turn as well and keep the
 * more confident reading — ties keep the first.
 */
export async function readUpright(
  engine: OcrEngine,
  image: Buffer,
  opts: ReadUprightOptions = {}
): Promise<UprightReading> {
  const first = opts.first ?? 0
  const a: UprightReading = { ...(await engine.recognize(image, { signal: opts.signal, turn: first })), turn: first }
  if (!engine.detectOrientation || score(a) >= OCR_ACCEPT_CONFIDENCE) return a
  const detected = await engine.detectOrientation(image, { signal: opts.signal })
  const other: OcrTurn | null = detected ? detected.turn : first !== 0 ? 0 : null
  if (other === null || other === first) return a
  const b: UprightReading = { ...(await engine.recognize(image, { signal: opts.signal, turn: other })), turn: other }
  return score(b) > score(a) ? b : a
}
