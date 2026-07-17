// Shared code-point-safe string cutting (audit 2026-07-16 F-15; the RAG-2 defect class).
//
// A raw `String.slice(0, n)` counts UTF-16 CODE UNITS and can cut inside a surrogate pair (emoji,
// CJK ext-B, math symbols), leaving the string ending in a lone surrogate that renders as `�` and
// is mangled by every downstream UTF-8 conversion (SQLite, JSON/IPC well-formed-unicode passes).
// These helpers count and slice by CODE POINT, so the cut always lands on a code-point boundary.
// (Code points, not graphemes — a combining mark can still be split, but that never produces an
// invalid string; the goal is only "never end mid-code-point".)
//
// A LEAF module by design: it is shared by rag/index.ts (truncateSnippet), analysis/coverage.ts and
// skills/analysis/common.ts (persisted citation snippets), and doctasks/handlers/compare.ts — some
// of which rag/index.ts itself imports, so this must not import from any of them.

/**
 * The leading `maxCodePoints` code points of `text` (never cutting a surrogate pair). Returns
 * `text` unchanged when it already fits.
 */
export function codePointSlice(text: string, maxCodePoints: number): string {
  const codePoints = [...text] // spreading iterates whole code points
  if (codePoints.length <= maxCodePoints) return text
  return codePoints.slice(0, maxCodePoints).join('')
}

/**
 * Cap `text` at `maxCodePoints` code points, appending `…` when it was cut — the shared
 * citation-snippet truncation shape (`length > cap ? head + '…' : text`), pair-safe.
 */
export function truncateByCodePoints(text: string, maxCodePoints: number): string {
  const cut = codePointSlice(text, maxCodePoints)
  return cut === text ? text : `${cut}…`
}
