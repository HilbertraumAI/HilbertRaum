import { attrValue, decodeEntities, tidyWhole } from './html'

// Table delivery (issue: deliver tables to the model instead of dropping them). html.ts used
// to drop every `<table>` subtree whole (`SKIP_SUBTREE`), so an infobox or data table never
// became a retrievable unit at all. This module parses a KEPT `<table>` subtree (html.ts's
// class-based classifier decides what still counts as layout/navbox noise, unchanged) into a
// bounded grid and serialises it into one or more `ExtractedSegment` texts.
//
// This is a small, self-contained tokenizer, not html.ts's main scanner: it only has to
// recognise a handful of table-related tag names, so it can stay simple and still keep the
// whole conversion linear -- html.ts's cursor hands it a start index once, the table's bytes
// are examined exactly once by *this* scanner, and the cursor never revisits them (see
// html.ts's header note, "the linear-scanner contract holds").
//
// Design choices bound by the brief, stated here since the code is where they are pinned:
//  - A NESTED table's content is DROPPED WHOLE (not inlined into the parent cell). Depth
//    counting on the `table` tag name alone finds the matching top-level `</table>` even
//    though the nested table's own rows/cells are never added to the grid, so nothing is ever
//    emitted twice.
//  - A header cell spanning multiple columns is never glued onto a data cell's text. Header
//    ROWS (every cell in the row is a `<th>`) are excluded from the emitted data lines
//    entirely; a data row's column key is the NEAREST header row above it that has non-empty
//    text for that column, falling back to `Column N`. This is what keeps a spanning header
//    from being repeated on every cell it covers: a narrower header below it always wins for
//    the columns it actually labels, and the group label is used only where nothing narrower
//    exists -- and either way it becomes a *key*, never text pasted onto the cell's value.
//  - Superscripts/subscripts are preserved as `^value` / `_value` (so `g/cm<sup>3</sup>` reads
//    `g/cm^3` and `10<sup>6</sup>` reads `10^6`), but only inside table-derived text -- prose
//    conversion is unchanged. `<sup class="mw-ref">` citation brackets are still dropped.

/** rowspan/colspan caps -- precedent from the research prototype, not a spec mandate. */
export const TABLE_MAX_ROWSPAN = 40
export const TABLE_MAX_COLSPAN = 24
/** Source `<tr>` rows parsed per table; further rows are ignored (the table's true end is
 *  still found by tracking nested-table depth on every `<table>` tag regardless of this cap). */
export const TABLE_MAX_SOURCE_ROWS = 400
/** Emitted characters per `ExtractedSegment` produced from one table. */
export const TABLE_SEGMENT_MAX_CHARS = 1500
/** `ExtractedSegment`s a single table may produce before the remainder is cut. */
export const TABLE_MAX_SEGMENTS = 4

/** Layout/decoration tables carry one of these classes and are still dropped, unchanged. */
const LAYOUT_TABLE_CLASS_RE = /\b(?:navbox|vertical-navbox|metadata|ambox|toc|sistersitebox)\b/i

/** Reference/citation superscripts: same predicate html.ts's prose path already uses. */
const REF_SUP_CLASS_RE = /\b(?:mw-ref|reference)\b/

export function isLayoutTableClass(classAttr: string | null): boolean {
  return classAttr !== null && LAYOUT_TABLE_CLASS_RE.test(classAttr)
}

interface TableCell {
  text: string
  header: boolean
  rows: number
  columns: number
}

export interface RetainedTable {
  caption: string
  rows: TableCell[][]
  /** Source `<tr>` rows actually parsed into `rows` (capped at TABLE_MAX_SOURCE_ROWS). */
  sourceRowCount: number
  /** Every top-level `<tr>` seen, capped or not — what the cut marker reports as "of N". */
  totalSourceRows: number
  /** True when more source rows existed than TABLE_MAX_SOURCE_ROWS parsed. */
  rowsTruncated: boolean
}

const CH_SLASH = 47

function isNameChar(cc: number): boolean {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45
}

function clampSpan(attrs: string, key: string, cap: number): number {
  const raw = attrValue(attrs, key)
  if (!raw) return 1
  const n = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(n) || n < 1) return 1
  return Math.min(n, cap)
}

/**
 * Parse one `<table ...>` subtree, cursor positioned just after the opening tag's `>`.
 * Returns the RetainedTable and the input index right after the matching top-level
 * `</table>` (or the end of input, for a never-closed table -- total on any junk input,
 * including `<table><tr><td>x` with no closing tag at all: it never throws).
 */
export function parseTableBody(input: string, start: number): { table: RetainedTable; end: number } {
  const n = input.length
  let i = start
  let depth = 1 // already inside the opening <table>
  const rows: TableCell[][] = []
  let caption = ''
  let inCaption = false
  let cell: TableCell | null = null
  let rowActive = false
  let refSkipDepth = 0
  let sourceRowCount = 0
  let totalSourceRows = 0

  // depth > 1 means we are inside a DROPPED nested table (see the `table` branch below): its
  // text runs must never reach the parent's caption/cell, or the nested content would leak
  // into whichever cell was open when the nested `<table>` started.
  const appendText = (raw: string): void => {
    if (raw.length === 0 || refSkipDepth > 0 || depth > 1) return
    const text = decodeEntities(raw)
    if (inCaption) caption += text
    else if (cell) cell.text += text
  }
  const appendLiteral = (literal: string): void => {
    if (refSkipDepth > 0 || depth > 1) return
    if (inCaption) caption += literal
    else if (cell) cell.text += literal
  }

  while (i < n) {
    const lt = input.indexOf('<', i)
    if (lt < 0) {
      appendText(input.slice(i, n))
      i = n
      break
    }
    if (lt > i) appendText(input.slice(i, lt))

    const isClose = input.charCodeAt(lt + 1) === CH_SLASH
    const nameStart = isClose ? lt + 2 : lt + 1
    let p = nameStart
    while (p < n && isNameChar(input.charCodeAt(p))) p += 1
    if (p === nameStart) {
      // Not a real tag (comment, declaration, bogus close, stray `<`): skip to the next `>`.
      const gt = input.indexOf('>', lt + 1)
      i = gt < 0 ? n : gt + 1
      continue
    }
    const name = input.slice(nameStart, p).toLowerCase()
    const attrStart = p
    const gt = input.indexOf('>', p)
    if (gt < 0) {
      // Unterminated tag at EOF: nothing more can be interpreted.
      i = n
      break
    }
    const attrs = input.slice(attrStart, gt)
    const selfClosing = attrs.endsWith('/')
    i = gt + 1

    if (name === 'table') {
      if (!isClose) {
        if (!selfClosing) depth += 1
        // A nested table's content is dropped whole: while depth > 1, its own tr/td tokens
        // never reach the branches below, so nothing from it is ever added to `rows`.
      } else if (depth > 0) {
        depth -= 1
        if (depth === 0) return { table: finish(), end: i }
      }
      continue
    }
    if (depth > 1) continue // inside a dropped nested table

    if (name === 'sup') {
      // <sup class="mw-ref"> citation brackets stay dropped, same as prose (html.ts's
      // supSkipDepth). An ordinary <sup> gets the table-scoped readable convention: a literal
      // `^` immediately before its own text, so `g/cm<sup>3</sup>` reads `g/cm^3` and
      // `10<sup>6</sup>` reads `10^6` -- never flattened to `g/cm3` / `106`. Prose keeps
      // today's flattening unchanged (out of scope — docs/known-limitations.md).
      if (!isClose && !selfClosing) {
        const cls = attrValue(attrs, 'class') ?? ''
        if (REF_SUP_CLASS_RE.test(cls)) refSkipDepth += 1
        else appendLiteral('^')
      } else if (isClose && refSkipDepth > 0) {
        refSkipDepth -= 1
      }
      continue
    }
    if (name === 'sub') {
      // Same convention, `_value` (e.g. `H<sub>2</sub>O` reads `H_2O`).
      if (!isClose && !selfClosing) appendLiteral('_')
      continue
    }
    if (name === 'caption') {
      inCaption = !isClose
      continue
    }
    if (name === 'tr') {
      if (!isClose) {
        cell = null
        totalSourceRows += 1
        if (sourceRowCount < TABLE_MAX_SOURCE_ROWS) {
          rows.push([])
          sourceRowCount += 1
          rowActive = true
        } else {
          rowActive = false
        }
      } else {
        rowActive = false
      }
      continue
    }
    if (name === 'td' || name === 'th') {
      if (isClose || selfClosing) {
        cell = null
        continue
      }
      if (!rowActive) continue
      cell = {
        text: '',
        header: name === 'th',
        rows: clampSpan(attrs, 'rowspan', TABLE_MAX_ROWSPAN),
        columns: clampSpan(attrs, 'colspan', TABLE_MAX_COLSPAN)
      }
      rows[rows.length - 1].push(cell)
      continue
    }
    if (!isClose && (name === 'br' || name === 'p' || name === 'div' || name === 'li')) {
      appendLiteral('\n')
    }
    // Everything else (thead/tbody/tfoot/span/a/b/i/small/…) is transparent: its own text runs
    // already flow through `appendText` between tags.
  }
  return { table: finish(), end: n }

  function finish(): RetainedTable {
    return {
      caption: tidyWhole(caption),
      rows: rows.map((row) => row.map((c) => ({ ...c, text: tidyWhole(c.text) }))),
      sourceRowCount,
      totalSourceRows,
      rowsTruncated: sourceRowCount < totalSourceRows
    }
  }
}

/** A header cell exists anywhere in the table. */
function hasHeaderCell(table: RetainedTable): boolean {
  return table.rows.some((row) => row.some((c) => c.header))
}

/** The structural drop test (brief §1): no header cell AND no real tabular content. */
export function hasDeliverableContent(table: RetainedTable): boolean {
  if (hasHeaderCell(table)) return true
  const numCols = table.rows.reduce((m, row) => Math.max(m, row.reduce((s, c) => s + c.columns, 0)), 0)
  const hasText = table.rows.some((row) => row.some((c) => c.text.trim().length > 0))
  return numCols >= 2 && hasText
}

/** A SOURCE row (pre-grid-expansion) whose cells are all headers -- the rebind predicate. */
function isAllHeaderRow(row: TableCell[] | undefined): boolean {
  return !!row && row.length > 0 && row.every((c) => c.header)
}

/**
 * Expand rowspan/colspan into a rectangular grid; a spanning cell's text/header flag is
 * repeated into every grid position it covers (same convention as the 2g research prototype).
 */
function buildGrid(table: RetainedTable): { grid: (TableCell | undefined)[][]; numCols: number } {
  const grid: (TableCell | undefined)[][] = []
  const ensureRow = (r: number): void => {
    while (grid.length <= r) grid.push([])
  }
  for (let r = 0; r < table.rows.length; r += 1) {
    ensureRow(r)
    let c = 0
    for (const src of table.rows[r]) {
      while (grid[r][c] !== undefined) c += 1
      for (let dr = 0; dr < src.rows; dr += 1) {
        ensureRow(r + dr)
        for (let dc = 0; dc < src.columns; dc += 1) grid[r + dr][c + dc] = src
      }
      c += src.columns
    }
  }
  const numCols = grid.reduce((m, row) => Math.max(m, row.length), 0)
  return { grid, numCols }
}

/** The nearest all-header row above `atRow` with non-empty text at column `c`, else `Column N`. */
function columnHeader(
  table: RetainedTable,
  grid: (TableCell | undefined)[][],
  atRow: number,
  c: number
): string {
  for (let r = atRow - 1; r >= 0; r -= 1) {
    if (!isAllHeaderRow(table.rows[r])) continue
    const text = grid[r]?.[c]?.text.trim()
    if (text) return text
  }
  return `Column ${c + 1}`
}

/**
 * One line per data row: `key: value; key: value`. Header rows never become a data line (that
 * is what keeps a spanning header from being repeated on every cell): they only seed the keys
 * used for the rows below them.
 */
export function tableToRecordLines(table: RetainedTable): string[] {
  const { grid, numCols } = buildGrid(table)
  const lines: string[] = []
  for (let r = 0; r < grid.length; r += 1) {
    if (isAllHeaderRow(table.rows[r])) continue
    const parts: string[] = []
    for (let c = 0; c < numCols; c += 1) {
      const value = grid[r][c]?.text ?? ''
      parts.push(`${columnHeader(table, grid, r, c)}: ${value}`)
    }
    if (parts.length > 0) lines.push(parts.join('; '))
  }
  return lines
}

/**
 * Render a RetainedTable into one or more segment texts, capped so a large table cannot
 * explode the unit count: at most TABLE_MAX_SEGMENTS segments of at most
 * TABLE_SEGMENT_MAX_CHARS characters each. A table cut by any cap says so in its own text
 * (`[Rows 1-k of N source rows shown]`, the research prototype's footer convention).
 */
export function serializeTable(table: RetainedTable): string[] {
  const lines = tableToRecordLines(table)
  const captionLine = table.caption ? `Caption: ${table.caption}` : null

  const segments: string[] = []
  let current: string[] = captionLine ? [captionLine] : []
  let currentChars = captionLine ? captionLine.length : 0
  let consumed = 0
  let cutForSegments = false

  for (const line of lines) {
    const extra = (current.length > 0 ? 1 : 0) + line.length
    if (currentChars + extra > TABLE_SEGMENT_MAX_CHARS && current.length > 0) {
      if (segments.length + 1 >= TABLE_MAX_SEGMENTS) {
        cutForSegments = true
        break
      }
      segments.push(current.join('\n'))
      current = []
      currentChars = 0
    }
    current.push(line)
    currentChars += line.length + 1
    consumed += 1
  }
  if (current.length > 0 && segments.length < TABLE_MAX_SEGMENTS) segments.push(current.join('\n'))

  const truncated = table.rowsTruncated || cutForSegments || consumed < lines.length
  if (truncated) {
    const marker = `[Rows 1-${consumed} of ${table.totalSourceRows} source rows shown]`
    if (segments.length === 0) segments.push(marker)
    else segments[segments.length - 1] += `\n${marker}`
  }
  // Canonical form (P1b's invariant, every segment the converter produces): an empty cell
  // value leaves a trailing space after its key's colon (`Column 2: `), which `tidyWhole`
  // collapses/trims exactly like the rest of html.ts's output does.
  return segments.map((s) => tidyWhole(s)).filter((s) => s.length > 0)
}
