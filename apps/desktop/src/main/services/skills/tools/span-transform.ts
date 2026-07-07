// Span-transform engine (beta-feedback-2026-07 Phase 6, decision D74; architecture.md "Skills —
// design record" §20). The reusable, replacement-strategy-aware substrate the C-wave phases splice
// through: Phase 7 (LLM-located redaction, #22) and Phase 8 (targeted edits, #23) will LOCATE spans
// (regex floor + a grammar-constrained model pass) and hand them here to be replaced MECHANICALLY —
// the model never generates output text (D73). This module is the generalization of the
// already-correct splice core in `redaction.ts` (`maskStep`), lifted out so both tools share one
// verified splice + one occurrence-anchored find.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). It knows nothing about
// redaction categories, the detection shadow, or the DB — it splices offsets in a string and reports
// which spans it applied. The SKA-3 shadow discipline stays a REDACTION concern (redaction.ts applies
// the SAME span list to both the text and its same-length shadow — the engine has no shadow concept),
// because the shadow is a detector-input artifact, not a property of the transform.
//
// Two invariants the whole C-wave rests on:
//   - BYTE-IDENTITY OUTSIDE SPANS by construction: `applySpans` copies every non-span byte through
//     verbatim (the D58 posture). The output differs from the input ONLY inside the spans it applied.
//   - NON-OVERLAPPING, VALIDATED, SINGLE-PASS: overlapping / out-of-bounds / zero-length spans are
//     dropped and reported as skipped rather than silently corrupting the splice.

// ---- Replacement strategies (D74) ----

/**
 * How a located span's replacement string is produced:
 *   - `token`   — a fixed label (the existing `[EMAIL]`-style redaction tokens). Length changes.
 *   - `perChar` — one `█` (U+2588) per code unit of the span, so the replacement is the SAME length as
 *     what it replaces. Line lengths (and the extracted-text layout) survive, and because `█` carries
 *     no digit / `@` / scheme and is not a shadow-mapped separator, masking stays idempotent AND keeps
 *     the SKA-3 same-length shadow invariant (D74).
 */
export type ReplacementStrategy = 'token' | 'perChar'

/** The full-block glyph a per-char mask is built from — one BMP code unit (see ReplacementStrategy). */
export const PER_CHAR_MASK = '█' // █

/**
 * The replacement string for a span of `spanLength` UTF-16 code units under `strategy`. For `token`
 * it is the caller's fixed `token`; for `perChar` it is `PER_CHAR_MASK` repeated to the span's exact
 * length (same-length by construction). `spanLength` is the UTF-16 length of the sliced span, so a
 * per-char mask preserves the string's code-unit length — the property the shadow invariant needs.
 */
export function replacementText(strategy: ReplacementStrategy, token: string, spanLength: number): string {
  return strategy === 'perChar' ? PER_CHAR_MASK.repeat(Math.max(0, spanLength)) : token
}

// ---- applySpans: the generalized splice core (from redaction's maskStep) ----

/** A range of `text` to replace, in UTF-16 code-unit offsets, plus the string to splice in. */
export interface TransformSpan {
  /** Start offset (inclusive), 0-based, in UTF-16 code units. */
  start: number
  /** Length in UTF-16 code units. Must be > 0 (a zero-length span is skipped, not an insertion point). */
  length: number
  /** The exact string spliced in place of `text.slice(start, start + length)`. */
  replacement: string
}

export interface ApplySpansResult {
  /** The transformed text: every non-span byte copied through verbatim (byte-identity outside spans). */
  text: string
  /** The spans that were spliced, in applied (ascending-start) order. */
  applied: TransformSpan[]
  /** The spans dropped as invalid (out of bounds, non-positive length) or OVERLAPPING an earlier one. */
  skipped: TransformSpan[]
}

/**
 * Splice `spans` into `text` in a single left-to-right pass. Spans are processed in ascending `start`
 * order (the input order is not assumed). A span is APPLIED only when it is in-bounds, has a positive
 * length, and does not overlap an already-applied span; otherwise it is SKIPPED and reported. Every
 * byte outside an applied span is copied through unchanged — so the result is byte-identical to `text`
 * except inside the applied spans (D58 verbatim posture, by construction).
 *
 * Overlap handling is deterministic: with spans sorted by start, a span whose start falls before the
 * running cursor (the end of the last applied span) overlaps it and is skipped. Equal-start spans thus
 * keep the first and skip the rest — the caller decides ordering by the span list it builds.
 */
export function applySpans(text: string, spans: readonly TransformSpan[]): ApplySpansResult {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const applied: TransformSpan[] = []
  const skipped: TransformSpan[] = []
  let out = ''
  let cursor = 0 // the next unconsumed offset in `text` (== end of the last applied span)
  for (const span of sorted) {
    const validShape =
      Number.isInteger(span.start) &&
      Number.isInteger(span.length) &&
      span.length > 0 &&
      span.start >= 0 &&
      span.start + span.length <= text.length
    if (!validShape || span.start < cursor) {
      // Out of bounds / non-positive length, OR it overlaps an already-applied span.
      skipped.push(span)
      continue
    }
    out += text.slice(cursor, span.start) + span.replacement
    cursor = span.start + span.length
    applied.push(span)
  }
  out += text.slice(cursor)
  return { text: out, applied, skipped }
}

// ---- locateOccurrences: verbatim, occurrence-anchored find (D75/D76) ----

/** A verbatim match of a needle in the text, with its 1-based line + 1-based global occurrence index. */
export interface Occurrence {
  /** Start offset (0-based, UTF-16 code units). */
  start: number
  /** Length in UTF-16 code units (== the needle's length). */
  length: number
  /** 1-based number of the line the match STARTS on (lines split on `\n`). */
  line: number
  /** 1-based index of this match among ALL verbatim, non-overlapping occurrences in the whole text. */
  index: number
}

export interface LocateOptions {
  /** Restrict to occurrences whose start is on this 1-based line (lines split on `\n`). */
  line?: number
  /**
   * Select the nth (1-based) occurrence of the (line-filtered) set — the D75/D76 anchor. Out of range
   * ⇒ an empty result (the caller drops the unverifiable span). Omitted ⇒ every (filtered) occurrence.
   */
  nth?: number
}

/**
 * Find the VERBATIM, non-overlapping occurrences of `needle` in `text`, optionally anchored to a line
 * and/or the nth occurrence. This is the deterministic verify half of the "locate → verify → splice"
 * discipline (D75): a model- or instruction-proposed span is confirmed only when its exact string is
 * found at its anchored location; a miss returns `[]` and the caller drops (and counts) it. No model,
 * no fuzzy match — a single wrong byte is a miss.
 *
 * Matching is non-overlapping (each match advances past its own end), so `locateOccurrences('aaa',
 * 'aa')` finds ONE occurrence — the semantics find→replace needs. An empty `needle` finds nothing.
 */
export function locateOccurrences(text: string, needle: string, opts: LocateOptions = {}): Occurrence[] {
  if (needle.length === 0) return []
  // 1-based line for each start offset, computed by a single scan of newline positions.
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1)
  }
  const lineOf = (offset: number): number => {
    // Largest lineStarts entry <= offset ⇒ its 1-based index. Linear walk (line counts stay small
    // relative to the linear scan already done; a binary search buys nothing at these sizes).
    let line = 1
    for (let i = 1; i < lineStarts.length; i++) {
      if (lineStarts[i] <= offset) line = i + 1
      else break
    }
    return line
  }

  const all: Occurrence[] = []
  let from = 0
  let index = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    index++
    all.push({ start: at, length: needle.length, line: lineOf(at), index })
    from = at + needle.length // non-overlapping
  }

  const filtered = opts.line === undefined ? all : all.filter((o) => o.line === opts.line)
  if (opts.nth === undefined) return filtered
  const picked = filtered[opts.nth - 1]
  return picked ? [picked] : []
}
