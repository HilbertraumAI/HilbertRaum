import { createHash } from 'node:crypto'
import type { AnswerBlockKind } from '../../../shared/types'
import { extractCitationMarkerOffsets } from '../../../shared/citation-markers'

// Evidence Pack / Review Mode — deterministic answer-block segmenter (EP-1 plan §6.1).
//
// PURE: string in → blocks out. No DB, no model, no I/O, no locale — the same persisted
// answer snapshot ALWAYS segments into the same blocks with the same keys (spec Risk 7:
// block keys bind to the SNAPSHOT, never to live rendering, so a renderer/markdown-library
// upgrade can never orphan a recorded decision).
//
// This is NOT a markdown parser. It is a line scanner with exactly the block classes the
// review needs (spec §12.1: paragraph / list item / heading / fence / table / blockquote),
// resolved by deterministic, documented rules. Where CommonMark is ambiguous or richer, the
// scanner picks the simpler reading and the unit tests pin it:
//  - A fence opens at /^ {0,3}(```+|~~~+)/ and closes on a matching-or-longer fence of the
//    SAME character; an unclosed fence swallows to end-of-text.
//  - A heading is a single ATX line (`#` ×1–6). Setext headings are read as paragraphs.
//  - A blockquote is a run of consecutive `>` lines (no lazy continuation).
//  - A table is a run of ≥2 consecutive lines whose first non-space character is `|`;
//    a lone pipe line reads as a paragraph. The whole table is ONE coherent unit (§12.2).
//  - A list item starts at a TOP-LEVEL marker line (`-`/`*`/`+`/`1.`/`1)` indented ≤1);
//    deeper-indented marker lines and indented continuations attach to the current item,
//    so a tight nested list stays with its parent point (§12.2 "coherent units").
//  - Everything else accumulates into paragraphs. A blank line ends any non-fence block.
//
// MARKERS are NOT computed per block: they are extracted ONCE over the whole normalized
// snapshot (`extractCitationMarkerOffsets` — the same regex source AND the same whole-text
// pass shape as the renderer's display rewrite) and assigned to blocks by offset range.
// This is load-bearing: the display's prose/code split runs over the WHOLE message, so a
// code region can span BLOCK boundaries (a mid-line ``` swallows to end-of-text; a code
// region can close mid-line). Per-block extraction would then disagree with what the chat
// UI renders as literal code vs citation; offset assignment makes each block's markers
// byte-derivable from the display semantics (two-sided repro tests pin both directions).
//
// Headings are the only kind the D-7 ready gate exempts — the segmenter CLASSIFIES only;
// the snapshot builder assigns the 'not_applicable' default decision (spec §12.2) and
// persists `block_kind` on every item (NULL/unknown = required — over-require, never exempt).

/** One deterministic answer block (the unit an `evidence_review_items` row snapshots). */
export interface AnswerBlock {
  /**
   * Stable key: `b{ordinal}-{kind}-{sha256/12}` over the block's exact text. The ordinal
   * keeps two byte-identical blocks distinct; the hash pins the key to the content so a
   * key can never silently point at different text.
   */
  blockKey: string
  blockKind: AnswerBlockKind
  /** 0-based position in the segmented answer (also the item's default ordinal). */
  ordinal: number
  /** The block's exact text (LF-normalized source lines, blank edges trimmed). */
  text: string
  /**
   * Machine citation labels (`"S1"`, …) whose PROSE markers fall inside this block's text
   * range, per the ONE whole-snapshot extraction described in the module header (code
   * regions resolved exactly as the chat display resolves them). Deduplicated,
   * first-appearance order.
   */
  markers: string[]
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/
const BLOCKQUOTE_RE = /^ {0,3}>/
const TABLE_ROW_RE = /^\s*\|/
/** A TOP-LEVEL list marker (indent ≤1): bullet or ordered (`.`/`)` delimiters). */
const LIST_ITEM_RE = /^ {0,1}(?:[-*+]|\d{1,9}[.)])\s+/

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

function isStructuralStarter(line: string): boolean {
  return (
    LIST_ITEM_RE.test(line) ||
    FENCE_OPEN_RE.test(line) ||
    HEADING_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    TABLE_ROW_RE.test(line)
  )
}

interface RawBlock {
  kind: AnswerBlockKind
  /** First line index (into the normalized line array). */
  startLine: number
  /** Number of consecutive lines the block spans. */
  lineCount: number
}

/**
 * Split a persisted answer's markdown into deterministic review blocks. An empty or
 * whitespace-only answer yields ZERO blocks (an item-less review — nothing to decide).
 */
export function segmentAnswerBlocks(markdown: string): AnswerBlock[] {
  const normalized = markdown.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  // Absolute start offset of each line in `normalized` (lines are '\n'-joined).
  const lineStart: number[] = new Array(lines.length)
  let acc = 0
  for (let k = 0; k < lines.length; k++) {
    lineStart[k] = acc
    acc += lines[k]!.length + 1
  }
  // ONE whole-snapshot marker pass — identical code-region semantics to the display
  // rewrite (see module header); each block picks its markers from it by offset below.
  const markerOffsets = extractCitationMarkerOffsets(normalized)

  const raw: RawBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim().length === 0) {
      i += 1
      continue
    }
    const startLine = i

    const fence = FENCE_OPEN_RE.exec(line)
    if (fence) {
      // Fence: swallow to the matching close (same char, ≥ length) or to end-of-text.
      const marker = fence[1]!
      const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
      i += 1
      while (i < lines.length) {
        const consumed = lines[i]!
        i += 1
        if (closeRe.test(consumed)) break
      }
      raw.push({ kind: 'fence', startLine, lineCount: i - startLine })
      continue
    }

    if (HEADING_RE.test(line)) {
      raw.push({ kind: 'heading', startLine, lineCount: 1 })
      i += 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      i += 1
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) i += 1
      raw.push({ kind: 'blockquote', startLine, lineCount: i - startLine })
      continue
    }

    if (TABLE_ROW_RE.test(line)) {
      i += 1
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) i += 1
      // ≥2 pipe lines form one table; a lone pipe line is not a table — a paragraph.
      raw.push({
        kind: i - startLine >= 2 ? 'table' : 'paragraph',
        startLine,
        lineCount: i - startLine
      })
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      // One TOP-LEVEL item + its indented children/continuations = one coherent block.
      i += 1
      while (i < lines.length) {
        const next = lines[i]!
        if (next.trim().length === 0 || isStructuralStarter(next)) break
        i += 1
      }
      raw.push({ kind: 'list_item', startLine, lineCount: i - startLine })
      continue
    }

    // Paragraph: accumulate until a blank line or a structural starter.
    i += 1
    while (i < lines.length) {
      const next = lines[i]!
      if (next.trim().length === 0 || isStructuralStarter(next)) break
      i += 1
    }
    raw.push({ kind: 'paragraph', startLine, lineCount: i - startLine })
  }

  return raw.map((b, ordinal) => {
    const text = lines.slice(b.startLine, b.startLine + b.lineCount).join('\n')
    const start = lineStart[b.startLine]!
    const end = start + text.length
    const seen = new Set<string>()
    const markers: string[] = []
    for (const m of markerOffsets) {
      if (m.index >= start && m.index < end && !seen.has(m.label)) {
        seen.add(m.label)
        markers.push(m.label)
      }
    }
    return {
      blockKey: `b${ordinal}-${b.kind}-${hashOf(text)}`,
      blockKind: b.kind,
      ordinal,
      text,
      markers
    }
  })
}
