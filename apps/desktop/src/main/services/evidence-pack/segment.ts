import { createHash } from 'node:crypto'
import type { AnswerBlockKind } from '../../../shared/types'
import { extractCitationMarkers } from '../../../shared/citation-markers'

// Evidence Pack / Review Mode — deterministic answer-block segmenter (EP-1 plan §6.1).
//
// PURE: string in → blocks out. No DB, no model, no I/O, no locale — the same persisted
// answer snapshot ALWAYS segments into the same blocks with the same keys (spec Risk 7:
// block keys bind to the SNAPSHOT, never to live rendering, so a renderer/markdown-library
// upgrade can never orphan a recorded decision).
//
// This is NOT a markdown parser. It is a line scanner with exactly the block classes the
// review needs (spec §12.1: paragraph / list item / heading / fence / table / blockquote),
// resolved by deterministic, documented rules. Where CommonMark is amBIGuous or richer, the
// scanner picks the simpler reading and the unit tests pin it:
//  - A fence opens at /^ {0,3}(```+|~~~+)/ and closes on a matching-or-longer fence of the
//    SAME character; an unclosed fence swallows to end-of-text (the CITE_CODE_SPLIT_RE
//    idiom — a fence block never yields citation markers).
//  - A heading is a single ATX line (`#` ×1–6). Setext headings are read as paragraphs.
//  - A blockquote is a run of consecutive `>` lines (no lazy continuation).
//  - A table is a run of ≥2 consecutive lines whose first non-space character is `|`;
//    a lone pipe line reads as a paragraph. The whole table is ONE coherent unit (§12.2).
//  - A list item starts at a TOP-LEVEL marker line (`-`/`*`/`+`/`1.`/`1)` indented ≤1);
//    deeper-indented marker lines and indented continuations attach to the current item,
//    so a tight nested list stays with its parent point (§12.2 "coherent units").
//  - Everything else accumulates into paragraphs. A blank line ends any non-fence block.
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
   * Machine citation labels (`"S1"`, …) in this block's PROSE — code spans/fences excluded
   * via the SHARED regex source (`shared/citation-markers.ts`), so extraction can never
   * disagree with the chat display's marker rewrite. Deduplicated, first-appearance order.
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

function makeBlock(kind: AnswerBlockKind, lines: string[], ordinal: number): AnswerBlock {
  const text = lines.join('\n')
  return {
    blockKey: `b${ordinal}-${kind}-${hashOf(text)}`,
    blockKind: kind,
    ordinal,
    text,
    markers: kind === 'fence' ? [] : extractCitationMarkers(text)
  }
}

/**
 * Split a persisted answer's markdown into deterministic review blocks. An empty or
 * whitespace-only answer yields ZERO blocks (an item-less review — nothing to decide).
 */
export function segmentAnswerBlocks(markdown: string): AnswerBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const raw: Array<{ kind: AnswerBlockKind; lines: string[] }> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim().length === 0) {
      i += 1
      continue
    }

    const fence = FENCE_OPEN_RE.exec(line)
    if (fence) {
      // Fence: swallow to the matching close (same char, ≥ length) or to end-of-text.
      const marker = fence[1]!
      const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
      const block = [line]
      i += 1
      while (i < lines.length) {
        block.push(lines[i]!)
        i += 1
        if (closeRe.test(block[block.length - 1]!)) break
      }
      raw.push({ kind: 'fence', lines: block })
      continue
    }

    if (HEADING_RE.test(line)) {
      raw.push({ kind: 'heading', lines: [line] })
      i += 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const block = [line]
      i += 1
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) {
        block.push(lines[i]!)
        i += 1
      }
      raw.push({ kind: 'blockquote', lines: block })
      continue
    }

    if (TABLE_ROW_RE.test(line)) {
      const block = [line]
      i += 1
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) {
        block.push(lines[i]!)
        i += 1
      }
      if (block.length >= 2) {
        raw.push({ kind: 'table', lines: block })
        continue
      }
      // A lone pipe line is not a table — fall through as a paragraph line.
      raw.push({ kind: 'paragraph', lines: block })
      continue
    }

    if (LIST_ITEM_RE.test(line)) {
      // One TOP-LEVEL item + its indented children/continuations = one coherent block.
      const block = [line]
      i += 1
      while (i < lines.length) {
        const next = lines[i]!
        if (next.trim().length === 0) break
        if (
          LIST_ITEM_RE.test(next) ||
          FENCE_OPEN_RE.test(next) ||
          HEADING_RE.test(next) ||
          BLOCKQUOTE_RE.test(next) ||
          TABLE_ROW_RE.test(next)
        ) {
          break
        }
        block.push(next)
        i += 1
      }
      raw.push({ kind: 'list_item', lines: block })
      continue
    }

    // Paragraph: accumulate until a blank line or a structural starter.
    const block = [line]
    i += 1
    while (i < lines.length) {
      const next = lines[i]!
      if (next.trim().length === 0) break
      if (
        LIST_ITEM_RE.test(next) ||
        FENCE_OPEN_RE.test(next) ||
        HEADING_RE.test(next) ||
        BLOCKQUOTE_RE.test(next) ||
        TABLE_ROW_RE.test(next)
      ) {
        break
      }
      block.push(next)
      i += 1
    }
    raw.push({ kind: 'paragraph', lines: block })
  }

  return raw.map((b, ordinal) => makeBlock(b.kind, b.lines, ordinal))
}
