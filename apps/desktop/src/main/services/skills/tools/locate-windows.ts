// The line-numbered, overlapping windows both LLM locate passes walk — the redaction locate
// (architecture.md "Skills — design record" §21) and the document-edit locate (§22). One builder so
// the two passes cannot drift apart (#583). Pure: no runtime, no fs.
//
// #622: a window is sized to the model's context, not only to 40 lines. Before, 40 dense paragraphs
// (a DOCX paragraph is one line here) overflowed a 4,096-token model on every run. The walk that asks
// the model (`locate-walk.ts`) derives the token budget; this module packs lines into it and splits a
// line that alone exceeds it into overlapping pieces.
import { approxTokenCount } from '../../ingestion/chunker'
import { REAL_TOKENS_PER_APPROX_TOKEN } from '../../runtime/context-budget'

/** Window sizing: line-numbered windows with overlap so a span straddling a window edge is seen whole
 *  in at least one window. Lines-based (not char-based) so line numbers stay stable + reportable. */
const WINDOW_LINES = 40
const WINDOW_OVERLAP_LINES = 8
/** #622: the overlap shrinks with a budget-shortened window — a fifth of its lines, at most 8 (so a full
 *  40-line window keeps exactly the old 8). A short window of long paragraphs needs no line overlap: a
 *  span never crosses a paragraph. */
const OVERLAP_SHARE = 5

/**
 * #622: the overlap between two pieces of one over-long line, in characters. Longer than the longest
 * span either pass may propose (redaction 160, edits 200 — `MAX_LOCATED_ENTITY_CHARS` /
 * `MAX_LOCATED_EDIT_CHARS`), so any span appears whole in at least one piece.
 */
export const LOCATE_PIECE_OVERLAP_CHARS = 240

/**
 * #622: the locate pass's conservative token estimate. Every digit is one token — Qwen3, Qwen3.5,
 * Gemma and Mistral split numbers digit by digit — and every other word costs `approxTokenCount` ×
 * the app-wide worst-case factor. Measured 2026-10-06 against llama-server `/tokenize` (Qwen3 4B and
 * Qwen3.5 9B; a client register, English and German paragraphs, bank-statement lines): it never
 * under-counted a line (worst real/estimate 0.95). The plain word estimate under-counted the
 * bank-statement lines 2× and register lines 1.1×. It over-counts English prose ~1.8×; the cost is
 * smaller windows, never an overflow.
 */
export function estimateLocateTokens(text: string): number {
  const digits = text.match(/[0-9]/g)?.length ?? 0
  return Math.ceil(digits + approxTokenCount(text.replace(/[0-9]+/g, ' ')) * REAL_TOKENS_PER_APPROX_TOKEN)
}

/** #622: one run of a document line inside a window — the whole line, or a piece of a line too long for
 *  any window. `offset` is where `text` starts within its line (0 for a whole line). */
export interface LocateSegment {
  /** The GLOBAL 1-based line number the model sees and reports. */
  line: number
  offset: number
  text: string
}

/** One overlapping window over the document's lines: the global start/end line (1-based, inclusive),
 *  its segments, and the line-numbered text to feed the model. */
export interface LocateWindow {
  startLine: number
  endLine: number
  segments: LocateSegment[]
  numbered: string
}

/** Number each segment with its GLOBAL 1-based line, tab-separated (`12\ttext`). The global numbering
 *  lets the model's reported line map to the whole document across windows. */
function windowOf(segments: LocateSegment[]): LocateWindow {
  return {
    startLine: segments[0].line,
    endLine: segments[segments.length - 1].line,
    segments,
    numbered: segments.map((s) => `${s.line}\t${s.text}`).join('\n')
  }
}

/** The estimated cost of one segment as the model sees it: its number, the tab, the text, the newline. */
function segmentCost(s: LocateSegment): number {
  return estimateLocateTokens(`${s.line}\t${s.text}`) + 1
}

/**
 * #622: split one line whose cost exceeds `maxTokens` into pieces that each fit, overlapping by
 * `LOCATE_PIECE_OVERLAP_CHARS`. Pieces end at whitespace where possible; a single word longer than the
 * budget is cut by characters. Each piece keeps the line number and records its offset.
 */
function splitLine(line: number, text: string, maxTokens: number): LocateSegment[] {
  const pieces: LocateSegment[] = []
  const prefix = estimateLocateTokens(`${line}\t`) + 1
  let start = 0
  while (start < text.length) {
    // Grow the piece word by word (the estimate is additive over whitespace-separated words).
    let end = start
    let cost = prefix
    const word = /\S+\s*/g
    word.lastIndex = start
    for (let m = word.exec(text); m !== null; m = word.exec(text)) {
      const next = cost + estimateLocateTokens(m[0])
      if (next > maxTokens && end > start) break
      if (next > maxTokens) {
        // One word alone exceeds the budget (a run with no whitespace): cut it by characters at the
        // estimate's rate — the only cut that can fall inside a word.
        const chars = Math.max(1, Math.floor((m[0].length * (maxTokens - prefix)) / Math.max(1, next - prefix)))
        end = m.index + chars
        break
      }
      cost = next
      end = m.index + m[0].length
    }
    if (end <= start) end = text.length // nothing but whitespace remained
    pieces.push({ line, offset: start, text: text.slice(start, end) })
    if (end >= text.length) break
    // The next piece starts LOCATE_PIECE_OVERLAP_CHARS earlier, at a word start — but at least halfway
    // through this piece, so a budget too small for the overlap still moves on.
    const earliest = start + Math.ceil((end - start) / 2)
    start = wordStart(text, Math.max(earliest, end - LOCATE_PIECE_OVERLAP_CHARS), earliest, end)
  }
  return pieces
}

/**
 * #622: where a piece may start — never inside a word. A piece starting at "…Bil|der Text" shows the
 * model "der Text": its edit "der → die, occurrence 1" then lands on the "der" inside "Bilder" (it
 * verifies verbatim), and a redaction sweeps a fragment like "ohn Smith". The nearest word start at or
 * before `pos` (not before `min`), else the next one before `max`, else `pos` (a run with no whitespace).
 */
function wordStart(text: string, pos: number, min: number, max: number): number {
  const startsWord = (i: number): boolean => i === 0 || /\s/.test(text[i - 1])
  for (let i = pos; i >= min; i--) if (startsWord(i)) return i
  for (let i = pos + 1; i < max; i++) if (startsWord(i)) return i
  return pos
}

/**
 * Split `text` into overlapping, line-numbered windows. Without a budget: WINDOW_LINES per window,
 * stepping by WINDOW_LINES - WINDOW_OVERLAP_LINES (the overlap means a span that would straddle a plain
 * window boundary appears WHOLE in at least one window). With `budget.maxTokens` (#622): a window also
 * stops before its estimated tokens exceed the budget, its overlap shrinks with it, a line over the
 * budget becomes pieces, and two pieces of one line never share a window (an edit's occurrence is then
 * remapped unambiguously). A short-line document builds exactly the same windows either way. Empty text
 * ⇒ no windows.
 */
export function buildLocateWindows(text: string, budget?: { maxTokens: number }): LocateWindow[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  const max = budget?.maxTokens ?? Infinity
  const segments: LocateSegment[] = []
  const costs: number[] = []
  lines.forEach((t, i) => {
    const whole: LocateSegment = { line: i + 1, offset: 0, text: t }
    const cost = Number.isFinite(max) ? segmentCost(whole) : 0
    const parts = cost > max ? splitLine(i + 1, t, max) : [whole]
    for (const p of parts) {
      segments.push(p)
      costs.push(Number.isFinite(max) ? segmentCost(p) : 0)
    }
  })

  /** The end (exclusive) of the window that starts at `from`: up to 40 segments within the budget. */
  const pack = (from: number): number => {
    let end = from
    let used = 0
    while (end < segments.length && end - from < WINDOW_LINES) {
      if (end > from && (used + costs[end] > max || segments[end].line === segments[end - 1].line)) break
      used += costs[end]
      end++
    }
    return end
  }
  const windows: LocateWindow[] = []
  let start = 0
  let previousEnd = 0
  for (;;) {
    let end = pack(start)
    // An overlap that cannot reach past the previous window would only ask about its tail again (short
    // lines before a piece that fills the budget): start where the previous window ended instead.
    if (end <= previousEnd) {
      start = previousEnd
      end = pack(start)
    }
    windows.push(windowOf(segments.slice(start, end)))
    if (end >= segments.length) break // the last window reached the end
    previousEnd = end
    const overlap = Math.min(WINDOW_OVERLAP_LINES, Math.floor((end - start) / OVERLAP_SHARE))
    start = Math.max(start + 1, end - overlap)
  }
  return windows
}

/**
 * #622: halve a window whose reply was cut short or whose prompt overflowed the context. Several
 * segments split into two halves (sharing one segment when there are three or more); a single segment
 * splits into two overlapping pieces of its text. Null when the window cannot get smaller — a single
 * piece no longer than twice the piece overlap.
 */
export function splitLocateWindow(w: LocateWindow): [LocateWindow, LocateWindow] | null {
  const segs = w.segments
  if (segs.length >= 2) {
    const mid = Math.ceil(segs.length / 2)
    const shared = segs.length >= 3 ? 1 : 0
    return [windowOf(segs.slice(0, mid)), windowOf(segs.slice(mid - shared))]
  }
  const s = segs[0]
  if (s.text.length <= 2 * LOCATE_PIECE_OVERLAP_CHARS) return null
  // Both boundaries at word starts (see `wordStart`); each half is strictly shorter than the piece.
  const cut = wordStart(s.text, Math.floor(s.text.length / 2), LOCATE_PIECE_OVERLAP_CHARS + 1, s.text.length - 1)
  const from = wordStart(s.text, cut - LOCATE_PIECE_OVERLAP_CHARS, 1, cut)
  return [
    windowOf([{ line: s.line, offset: s.offset, text: s.text.slice(0, cut) }]),
    windowOf([{ line: s.line, offset: s.offset + from, text: s.text.slice(from) }])
  ]
}
