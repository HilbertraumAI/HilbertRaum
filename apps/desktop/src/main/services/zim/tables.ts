import { attrValue, decodeEntities, tidyWhole } from './html'

// Table delivery (issue #478: deliver tables to the model instead of dropping them). html.ts
// used to drop every `<table>` subtree whole (`SKIP_SUBTREE`), so an infobox or data table
// never became a retrievable unit at all. This module parses a KEPT `<table>` subtree (html.ts's
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
//  - A NESTED table is INLINED into the parent cell it sits in, as one compact string, emitted
//    exactly once (the brief's other allowed choice, "drop the inner table", was tried first
//    and reverted: Wikipedia's own chemical-element infobox nests the actual property table one
//    level inside a layout wrapper table, so dropping every nested table drops exactly the
//    content this feature exists to deliver -- verified against the live "Gold" article, whose
//    density/melting-point row is a nested table). Nesting is a real stack of build contexts,
//    capped at `MAX_NESTING_DEPTH` as a safety valve; past the cap a table is dropped, unchanged
//    from the module's first design. A wrapper table that carries no header cell of its own and
//    fewer than two columns is still DELIVERED when a nested table it absorbed is itself real
//    tabular content (`absorbedDeliverableNested`, #478 review finding B4) -- the wrapper is
//    layout, but the data one level inside it is not, and the two must not be judged as one.
//  - A header cell spanning multiple columns is never glued onto a data cell's text. Header
//    ROWS (every cell in the row is a `<th>`) are excluded from the emitted data lines
//    entirely; a data row's column key is the NEAREST header row above it that has non-empty
//    text for that column (looked up in O(1) amortised per cell -- one forward pass keeps a
//    running per-column key, never an upward rescan, #478 review finding B2), falling back to
//    that row's OWN leading header cell when it has one (an infobox's `<th>Dichte</th><td>19,32
//    g/cm³</td>` shape -- #478 review finding B1), and to `Column N` only when neither exists.
//    A row's own leading header cell wins over a header row further above when both could
//    apply: it is the more specific label, exactly the "narrower wins" rule multi-row headers
//    already use, just realised along the row axis instead of the column axis -- required for
//    the real infobox shape a section-grouping header row (e.g. "Physikalisch") sits above a
//    run of `<th>label</th><td>value</td>` rows: the section label must not overwrite every
//    row's own, more specific label.
//  - Superscripts/subscripts are preserved as `^value` / `_value` (so `g/cm<sup>3</sup>` reads
//    `g/cm^3` and `10<sup>6</sup>` reads `10^6`), but only inside table-derived text -- prose
//    conversion is unchanged. `<sup class="mw-ref">` citation brackets are still dropped, and an
//    ordinary `<sup>` nested INSIDE one keeps the skip depth balanced (#478 review finding N4:
//    html.ts's own prose path already counts every `<sup>` while skipping, for the same reason).
//  - A grid, once rowspan/colspan is expanded, is capped on three independent axes -- columns,
//    total placed cells, and total emitted characters (`TABLE_MAX_COLUMNS`,
//    `TABLE_MAX_GRID_CELLS`, `TABLE_MAX_RAW_CHARS`) -- so a table with an enormous span product,
//    an enormous column count, or a few enormous cell values replicated across many spanned
//    positions cannot cost more than a fixed, input-independent ceiling (#478 review finding B2).
//    A `rowspan` can likewise never manufacture a grid row past the table's own last SOURCE row
//    (finding B5): a rowspan that overhangs the end of the table is clamped to the rows that
//    actually exist, not padded with phantom empty rows.

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
/** Grid columns a table's expanded grid may have; a cell placed beyond this column is dropped
 *  (the cut marked), and no further source cell in that row is examined once it is reached. */
export const TABLE_MAX_COLUMNS = 60
/** Total grid cells (post rowspan/colspan expansion) a table's grid may hold -- independent of
 *  `TABLE_MAX_COLUMNS` and the row cap, so raising either alone can never reopen the O(cells)
 *  blow-up the caps exist to close. */
export const TABLE_MAX_GRID_CELLS = 6_000
/** Total characters `tableToRecordLines` may build across every emitted `key: value` pair,
 *  before packing into segments. Independent of `TABLE_SEGMENT_MAX_CHARS × TABLE_MAX_SEGMENTS`
 *  (which bounds the OUTPUT after packing): this bounds the RAW computation, so a handful of
 *  very long cell values repeated across many spanned grid positions -- legitimate colspan
 *  semantics, exercised at the column/grid caps above -- cannot multiply into an unbounded
 *  amount of work before packing ever gets a chance to cut it down. */
export const TABLE_MAX_RAW_CHARS = 50_000

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
  /** True when a table nested somewhere inside this one (at any depth, inlined into its
   *  parent cell) was itself real tabular content -- #478 review finding B4: a headerless,
   *  single-column OUTER wrapper must still be delivered when the table it wraps is data. */
  absorbedDeliverableNested: boolean
  /** True when any cell's `rowspan`/`colspan` attribute exceeded its cap and was clamped
   *  (#478 review finding N6) -- folded into the same "some content was capped" report as the
   *  column/grid-cell caps, so a clamped span is never silently invisible in the output. */
  spanClamped: boolean
}

const CH_SLASH = 47

function isNameChar(cc: number): boolean {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45
}

function clampSpan(attrs: string, key: string, cap: number): { value: number; clamped: boolean } {
  const raw = attrValue(attrs, key)
  if (!raw) return { value: 1, clamped: false }
  const n = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(n) || n < 1) return { value: 1, clamped: false }
  return { value: Math.min(n, cap), clamped: n > cap }
}

/** One table's in-progress build state -- the unit `parseTableBody`'s stack holds one per
 *  currently-open `<table>` (outermost plus any nested ones still being parsed). */
interface TableContext {
  rows: TableCell[][]
  caption: string
  inCaption: boolean
  cell: TableCell | null
  rowActive: boolean
  sourceRowCount: number
  totalSourceRows: number
  absorbedDeliverableNested: boolean
}

function makeContext(): TableContext {
  return {
    rows: [],
    caption: '',
    inCaption: false,
    cell: null,
    rowActive: false,
    sourceRowCount: 0,
    totalSourceRows: 0,
    absorbedDeliverableNested: false
  }
}

function finishContext(ctx: TableContext, spanClamped: boolean): RetainedTable {
  return {
    caption: tidyWhole(ctx.caption),
    rows: ctx.rows.map((row) => row.map((c) => ({ ...c, text: tidyWhole(c.text) }))),
    sourceRowCount: ctx.sourceRowCount,
    totalSourceRows: ctx.totalSourceRows,
    rowsTruncated: ctx.sourceRowCount < ctx.totalSourceRows,
    absorbedDeliverableNested: ctx.absorbedDeliverableNested,
    spanClamped
  }
}

/**
 * Flatten a nested table into ONE compact inline string, appended into whichever cell/caption
 * of the PARENT table was open when the nested `<table>` started -- rather than dropping it.
 * Wikipedia commonly nests the actual data table one level inside a layout wrapper `<table>`
 * (a chemical-element infobox's "physical properties" section is exactly this shape: an outer
 * single-column wrapper table whose one cell contains the real, multi-row property table), so
 * dropping every nested table outright would drop the very content table delivery exists to
 * reach. Depth is capped (`MAX_NESTING_DEPTH`) as a safety valve against pathological input; a
 * table nested deeper than the cap is dropped, unchanged from this module's original design.
 */
function inlineNestedTable(table: RetainedTable): string {
  const parts: string[] = []
  if (table.caption) parts.push(table.caption)
  parts.push(...tableToRecordLines(table).lines)
  return parts.join('; ')
}

/** Safety valve for pathological nesting (each level is a real stack frame's worth of state,
 *  bounded so a crafted `<table><table><table>...` cannot grow it unboundedly). A table nested
 *  deeper than this is dropped, exactly as EVERY nested table was in this module's first cut. */
const MAX_NESTING_DEPTH = 8

/**
 * Parse one `<table ...>` subtree, cursor positioned just after the opening tag's `>`.
 * Returns the RetainedTable and the input index right after the matching top-level
 * `</table>` (or the end of input, for a never-closed table -- total on any junk input,
 * including `<table><tr><td>x` with no closing tag at all: it never throws).
 */
export function parseTableBody(input: string, start: number): { table: RetainedTable; end: number } {
  const n = input.length
  let i = start
  const stack: TableContext[] = [makeContext()] // stack[0] is the OUTERMOST (kept) table
  let refSkipDepth = 0
  // > 0 while inside a nested table past MAX_NESTING_DEPTH: dropped whole, unchanged design.
  let droppedDepth = 0
  // Shared across every table on the stack (outer and nested): whether ANY cell's span
  // attribute was clamped (#478 review N6), folded into the OUTERMOST table's report only.
  let spanClamped = false

  const active = (): TableContext => stack[stack.length - 1]

  const appendText = (raw: string): void => {
    if (raw.length === 0 || refSkipDepth > 0 || droppedDepth > 0) return
    const ctx = active()
    const text = decodeEntities(raw)
    if (ctx.inCaption) ctx.caption += text
    else if (ctx.cell) ctx.cell.text += text
  }
  const appendLiteral = (literal: string): void => {
    if (refSkipDepth > 0 || droppedDepth > 0) return
    const ctx = active()
    if (ctx.inCaption) ctx.caption += literal
    else if (ctx.cell) ctx.cell.text += literal
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
        if (!selfClosing) {
          if (stack.length >= MAX_NESTING_DEPTH) droppedDepth += 1
          else stack.push(makeContext())
        }
      } else if (droppedDepth > 0) {
        droppedDepth -= 1
      } else if (stack.length > 1) {
        // A nested table just closed: inline it into whatever cell/caption of the PARENT was
        // open when it started, then pop back to the parent context. If the nested table was
        // itself real tabular content, that fact propagates to the parent (finding B4) so a
        // headerless single-column wrapper around it is still judged deliverable.
        const nested = stack.pop() as TableContext
        const nestedTable = finishContext(nested, false)
        const inline = inlineNestedTable(nestedTable)
        if (inline) appendLiteral(inline)
        if (hasDeliverableContent(nestedTable) || nestedTable.absorbedDeliverableNested) {
          active().absorbedDeliverableNested = true
        }
      } else {
        // The OUTERMOST table just closed.
        return { table: finishContext(stack[0], spanClamped), end: i }
      }
      continue
    }
    if (droppedDepth > 0) continue // inside a too-deeply-nested (dropped) table

    if (name === 'sup') {
      // <sup class="mw-ref"> citation brackets stay dropped, same as prose (html.ts's
      // supSkipDepth). An ordinary <sup> gets the table-scoped readable convention: a literal
      // `^` immediately before its own text, so `g/cm<sup>3</sup>` reads `g/cm^3` and
      // `10<sup>6</sup>` reads `10^6` -- never flattened to `g/cm3` / `106`. Prose keeps
      // today's flattening unchanged (out of scope — docs/known-limitations.md). While already
      // skipping a ref bracket, EVERY nested `<sup>` (ref or not) is counted symmetrically on
      // open/close, exactly like html.ts's own prose `supSkipDepth` -- a plain `<sup>` nested
      // inside a `<sup class="mw-ref">` must not decrement the depth and leak the rest of the
      // citation (#478 review finding N4).
      if (refSkipDepth > 0) {
        if (!selfClosing) refSkipDepth += isClose ? -1 : 1
        continue
      }
      if (!isClose && !selfClosing) {
        const cls = attrValue(attrs, 'class') ?? ''
        if (REF_SUP_CLASS_RE.test(cls)) refSkipDepth = 1
        else appendLiteral('^')
      }
      continue
    }
    if (name === 'sub') {
      // Same convention, `_value` (e.g. `H<sub>2</sub>O` reads `H_2O`).
      if (!isClose && !selfClosing) appendLiteral('_')
      continue
    }
    if (name === 'caption') {
      active().inCaption = !isClose
      continue
    }
    if (name === 'tr') {
      const ctx = active()
      if (!isClose) {
        ctx.cell = null
        ctx.totalSourceRows += 1
        if (ctx.sourceRowCount < TABLE_MAX_SOURCE_ROWS) {
          ctx.rows.push([])
          ctx.sourceRowCount += 1
          ctx.rowActive = true
        } else {
          ctx.rowActive = false
        }
      } else {
        ctx.rowActive = false
      }
      continue
    }
    if (name === 'td' || name === 'th') {
      const ctx = active()
      if (isClose || selfClosing) {
        ctx.cell = null
        continue
      }
      if (!ctx.rowActive) continue
      const rowSpan = clampSpan(attrs, 'rowspan', TABLE_MAX_ROWSPAN)
      const colSpan = clampSpan(attrs, 'colspan', TABLE_MAX_COLSPAN)
      if (rowSpan.clamped || colSpan.clamped) spanClamped = true
      ctx.cell = { text: '', header: name === 'th', rows: rowSpan.value, columns: colSpan.value }
      ctx.rows[ctx.rows.length - 1].push(ctx.cell)
      continue
    }
    if (!isClose && (name === 'br' || name === 'p' || name === 'div' || name === 'li')) {
      // A SPACE, not a newline (#478 review finding N3): table-derived text is one line per
      // data row by contract, and an intra-cell break must not split that line in two.
      appendLiteral(' ')
    }
    // Everything else (thead/tbody/tfoot/span/a/b/i/small/…) is transparent: its own text runs
    // already flow through `appendText` between tags.
  }
  // EOF without a matching close for every open <table>: total on malformed input (never
  // throws). Only the OUTERMOST context is returned -- an unterminated nested table's partial
  // content is not inlined, an acceptable degradation for input that never closes at all.
  return { table: finishContext(stack[0], spanClamped), end: n }
}

/** A header cell exists anywhere in the table. */
function hasHeaderCell(table: RetainedTable): boolean {
  return table.rows.some((row) => row.some((c) => c.header))
}

/** The structural drop test (brief §1): no header cell AND no real tabular content, UNLESS a
 *  nested table this one absorbed was itself real tabular content (finding B4) -- the wrapper's
 *  own shape is layout, but the data one level inside it is not, and the two are judged apart. */
export function hasDeliverableContent(table: RetainedTable): boolean {
  if (hasHeaderCell(table)) return true
  if (table.absorbedDeliverableNested) return true
  const numCols = table.rows.reduce((m, row) => Math.max(m, row.reduce((s, c) => s + c.columns, 0)), 0)
  const hasText = table.rows.some((row) => row.some((c) => c.text.trim().length > 0))
  return numCols >= 2 && hasText
}

/** A SOURCE row (pre-grid-expansion) whose cells are all headers -- the column-header-row
 *  rebind predicate (a mid-table header row seeds new keys for the columns below it). */
function isAllHeaderRow(row: TableCell[] | undefined): boolean {
  return !!row && row.length > 0 && row.every((c) => c.header)
}

/** A MIXED row (some but not all cells are headers) whose leading cell(s) are headers -- an
 *  infobox's `<th>Dichte</th><td>19,32</td>` shape (#478 review finding B1). Multiple leading
 *  header cells (rare: "Country | Capital" both headers, then data) join with ' / ', the same
 *  convention 2g's research prototype uses for multi-row headers. `null` when the row has no
 *  leading header cell at all (an ordinary data row, keyed by a header ROW above instead). */
function rowHeaderText(row: TableCell[] | undefined): string | null {
  if (!row || row.length === 0 || !row[0]!.header || row.every((c) => c.header)) return null
  const leading: string[] = []
  for (const cell of row) {
    if (!cell.header) break
    if (cell.text.trim()) leading.push(cell.text.trim())
  }
  return leading.length > 0 ? leading.join(' / ') : null
}

/** How many leading GRID columns of a row-header row are covered by its own header cell(s) --
 *  skipped when emitting the row's data pairs (the header cell keys the row, it is not itself a
 *  `Column N` value, #478 review finding B1). */
function leadingHeaderSpan(gridRow: ReadonlyArray<TableCell | undefined>): number {
  let c = 0
  while (c < gridRow.length && gridRow[c]?.header) c += 1
  return c
}

/**
 * Expand rowspan/colspan into a rectangular grid; a spanning cell's text/header flag is
 * repeated into every grid position it covers (same convention as the 2g research prototype),
 * bounded on three independent axes so no crafted span/column/cell combination can cost more
 * than a fixed ceiling (#478 review finding B2):
 *  - a cell placed at or past `TABLE_MAX_COLUMNS` is dropped and no further source cell in that
 *    row is examined (a row's iteration cost is therefore bounded by the column cap, never by
 *    how many source cells the row actually contains);
 *  - a `rowspan` is clamped to the rows that actually exist in THIS table (#478 review finding
 *    B5) -- it can never manufacture a grid row past the table's last real source row, so a
 *    single source row cannot fake a tall grid the way an unclamped rowspan could;
 *  - total placed grid cells are capped independently of the above (`TABLE_MAX_GRID_CELLS`), a
 *    backstop against a legitimately-shaped but very large table.
 */
function buildGrid(table: RetainedTable): { grid: (TableCell | undefined)[][]; numCols: number; gridTruncated: boolean; cellsPlaced: number } {
  const grid: (TableCell | undefined)[][] = []
  const ensureRow = (r: number): void => {
    while (grid.length <= r) grid.push([])
  }
  const totalRows = table.rows.length
  let placed = 0
  let gridTruncated = false
  for (let r = 0; r < totalRows; r += 1) {
    ensureRow(r)
    let c = 0
    for (const src of table.rows[r]!) {
      while (grid[r]![c] !== undefined) c += 1
      if (c >= TABLE_MAX_COLUMNS) {
        gridTruncated = true
        break
      }
      const colSpan = Math.min(src.columns, TABLE_MAX_COLUMNS - c)
      if (colSpan < src.columns) gridTruncated = true
      const rowSpan = Math.min(src.rows, totalRows - r) // B5: never past the last real row
      for (let dr = 0; dr < rowSpan; dr += 1) {
        ensureRow(r + dr)
        for (let dc = 0; dc < colSpan; dc += 1) {
          if (placed >= TABLE_MAX_GRID_CELLS) {
            gridTruncated = true
            break
          }
          grid[r + dr]![c + dc] = src
          placed += 1
        }
        if (placed >= TABLE_MAX_GRID_CELLS) break
      }
      c += colSpan
      if (placed >= TABLE_MAX_GRID_CELLS) break
    }
    if (placed >= TABLE_MAX_GRID_CELLS) break
  }
  const numCols = grid.reduce((m, row) => Math.max(m, row.length), 0)
  return { grid, numCols, gridTruncated, cellsPlaced: placed }
}

/**
 * One line per data row: `key: value; key: value`. Header rows never become a data line (that
 * is what keeps a spanning header from being repeated on every cell): they only seed the keys
 * used for the rows below them. Column keys are resolved in a single forward pass -- a running
 * `columnKeys[c]` cache updated whenever an all-header row is crossed -- so the lookup is O(1)
 * amortised per data cell, never an upward rescan of every row above it (#478 review finding
 * B2). A row's own leading header cell (finding B1) wins over that cache when both could
 * supply a key for the same column: it is the more specific label (see the module header note
 * on why this order, not the reviewer's literal suggestion, is required for a real infobox that
 * mixes a section-grouping header row with per-row `<th>` labels).
 */
export function tableToRecordLines(table: RetainedTable): { lines: string[]; gridTruncated: boolean; cellsPlaced: number } {
  const { grid, numCols, gridTruncated: capTruncated, cellsPlaced } = buildGrid(table)
  const lines: string[] = []
  const columnKeys: (string | null)[] = new Array(numCols).fill(null)
  let totalChars = 0
  let contentCapped = false

  for (let r = 0; r < grid.length; r += 1) {
    if (contentCapped) break
    const sourceRow = table.rows[r]
    if (isAllHeaderRow(sourceRow)) {
      for (let c = 0; c < numCols; c += 1) {
        const text = grid[r]?.[c]?.text.trim()
        if (text) columnKeys[c] = text
      }
      continue
    }
    const rowHeader = rowHeaderText(sourceRow)
    const skipCols = rowHeader !== null ? leadingHeaderSpan(grid[r]!) : 0
    const parts: string[] = []
    for (let c = skipCols; c < numCols; c += 1) {
      const value = grid[r]![c]?.text ?? ''
      if (!value.trim()) continue // N2: a ragged row's empty trailing pair carries no information
      const key = rowHeader ?? columnKeys[c] ?? `Column ${c + 1}`
      const pair = `${key}: ${value}`
      if (totalChars + pair.length > TABLE_MAX_RAW_CHARS) {
        contentCapped = true
        break
      }
      parts.push(pair)
      totalChars += pair.length
    }
    if (parts.length > 0) lines.push(parts.join('; '))
  }
  return { lines, gridTruncated: capTruncated || contentCapped, cellsPlaced }
}

/** Hard-splits a line longer than `maxChars`, preferring a `'; '` pair boundary within budget
 *  and falling back to a raw character cut -- #478 review finding B3: the segment cap must hold
 *  even for a single record line whose value alone exceeds it. */
const LONG_LINE_CUT = ' [cut]'
function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line]
  const budget = Math.max(1, maxChars - LONG_LINE_CUT.length)
  const pieces: string[] = []
  let rest = line
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('; ', budget)
    if (cut <= 0) cut = budget
    pieces.push(`${rest.slice(0, cut)}${LONG_LINE_CUT}`)
    rest = rest.slice(cut).replace(/^; /, '')
  }
  pieces.push(rest)
  return pieces
}

export interface TableSerialisation {
  segments: string[]
  /** Grid cells placed plus characters emitted -- the real cost of delivering this table,
   *  charged into html.ts's `work` counter alongside the existing per-byte sub-scan charge
   *  (#478 review finding B2: previously only the table's SOURCE BYTES were charged, so the
   *  pinned work/n bound never saw the grid-expansion/serialisation cost at all). */
  workUnits: number
}

/**
 * Render a RetainedTable into one or more segment texts, capped so a large table cannot
 * explode the unit count: at most TABLE_MAX_SEGMENTS segments of at most
 * TABLE_SEGMENT_MAX_CHARS characters each, with any single over-long line hard-split first
 * (finding B3). A table cut by any cap says so in its own text.
 */
export function serializeTable(table: RetainedTable): TableSerialisation {
  const { lines, gridTruncated, cellsPlaced } = tableToRecordLines(table)
  const captionLine = table.caption ? `Caption: ${table.caption}` : null

  const segments: string[] = []
  let current: string[] = captionLine ? [captionLine] : []
  let currentChars = captionLine ? captionLine.length : 0
  let charsUsed = currentChars
  let consumed = 0
  let cutForSegments = false

  outer: for (const rawLine of lines) {
    charsUsed += rawLine.length
    for (const piece of splitLongLine(rawLine, TABLE_SEGMENT_MAX_CHARS)) {
      const extra = (current.length > 0 ? 1 : 0) + piece.length
      if (currentChars + extra > TABLE_SEGMENT_MAX_CHARS && current.length > 0) {
        if (segments.length + 1 >= TABLE_MAX_SEGMENTS) {
          cutForSegments = true
          break outer
        }
        segments.push(current.join('\n'))
        current = []
        currentChars = 0
      }
      current.push(piece)
      currentChars += piece.length + 1
    }
    consumed += 1
  }
  if (current.length > 0 && segments.length < TABLE_MAX_SEGMENTS) segments.push(current.join('\n'))

  // Two independent reasons a table's own text says it was cut, joined when both apply: rows
  // dropped by the row/segment caps (D3: "data rows", since that is what `consumed` counts, not
  // every source row -- a header row is parsed but never becomes a data line), and cells or
  // content dropped by the column/grid/char/span caps (B2, N6).
  const markers: string[] = []
  if (table.rowsTruncated || cutForSegments || consumed < lines.length) {
    markers.push(`[Rows 1-${consumed} of ${table.totalSourceRows} data rows shown]`)
  }
  if (gridTruncated || table.spanClamped) {
    markers.push("[Some cells beyond the table's size caps were omitted]")
  }
  if (markers.length > 0) {
    const marker = markers.join('\n')
    if (segments.length === 0) segments.push(marker)
    else segments[segments.length - 1] += `\n${marker}`
  }

  // Canonical form (P1b's invariant, every segment the converter produces): an empty cell
  // value leaves a trailing space after its key's colon (`Column 2: `), which `tidyWhole`
  // collapses/trims exactly like the rest of html.ts's output does.
  const texts = segments.map((s) => tidyWhole(s)).filter((s) => s.length > 0)
  return { segments: texts, workUnits: cellsPlaced + charsUsed }
}
