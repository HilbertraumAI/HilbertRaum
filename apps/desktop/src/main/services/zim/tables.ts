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
//    tabular content (`absorbedDeliverableNested`) -- the wrapper is layout, but the data one
//    level inside it is not, and the two must not be judged as one. A nested table's OWN class
//    is still checked against the same layout/navbox classifier as the outermost table (#478):
//    a `navbox`/`ambox` nested inside an otherwise-kept table is dropped, not inlined. A nested
//    table's grid expansion and line-building is its own cost, so it is charged into the
//    outermost table's `workUnits` and bounded by a GLOBAL budget shared across every nested
//    table one outer table absorbs (`TABLE_MAX_RAW_CHARS`, tracked as `nestedWorkUsed` in
//    `parseTableBody`): once spent, further nested tables are dropped without even building
//    their grid, so a pathological input with thousands of small nested tables cannot multiply
//    real work by table count (#478). A cap firing inside a nested table (its row cap or its
//    own grid/column/char cap) is folded into the outermost table's own cut markers exactly the
//    way a clamped span already is, so a cut inside a nested table is never silently invisible.
//  - A header cell spanning multiple columns is never glued onto a data cell's text. Header
//    ROWS (every cell in the row is a `<th>`) are excluded from the emitted data lines
//    entirely; a data row's column key is the NEAREST header row above it that has non-empty
//    text for that column (looked up in O(1) amortised per cell -- one forward pass keeps a
//    running per-column key, never an upward rescan), falling back to that row's OWN leading
//    header cell only when none of the row's own covered columns already has a genuine
//    (non-group) column key of its own (an infobox's `<th>Dichte</th><td>19,32 g/cm³</td>` row,
//    with no column headers above it, keys on "Dichte"; an ordinary `<th scope="row">` label
//    column sitting under real `<th>Country</th><th>Capital</th>` column headers keys on
//    "Country"/"Capital" instead, never repeats the row's own label as every cell's key), and to
//    `Column N` only when neither exists.
//  - A `colspan > 1` header cell keys AT MOST ONE LINE PER ROW, never one per covered cell: it
//    is a GROUP LABEL. The German-Wikipedia "Gold" infobox labels its rows with plain `<td>`
//    cells (not `<th>`) under a `<th colspan="2">Physikalisch</th>` group heading, so a row's
//    own leading cell is never a header and the group text used to become the literal per-cell
//    key of BOTH covered columns on every row (issue #478). When a data row has no narrower
//    header of its own and none of its covered columns has a genuine (non-group) key either, it
//    is rendered as a group record instead: a 2-column table reads its first cell as the row's
//    own label ("Physikalisch — Dichte: 19,32 g/cm³ …"); any other column count joins the cells
//    un-keyed under the one group label, never inventing `Column N` names for columns that were
//    never headed (see `tableToRecordLines`). A row that resolves to a SINGLE source cell
//    spanning every one of its covered columns (a full-width note or sub-heading row) is
//    likewise emitted once, un-keyed, never once per covered column and never as `X: X`.
//  - Superscripts/subscripts are preserved as `^value` / `_value` (so `g/cm<sup>3</sup>` reads
//    `g/cm^3` and `10<sup>6</sup>` reads `10^6`), but only inside table-derived text -- prose
//    conversion is unchanged. `<sup class="mw-ref">` citation brackets are still dropped, and an
//    ordinary `<sup>` nested INSIDE one keeps the skip depth balanced (html.ts's own prose path
//    already counts every `<sup>` while skipping, for the same reason).
//  - A grid, once rowspan/colspan is expanded, is capped on three independent axes -- columns,
//    total placed cells, and total emitted characters (`TABLE_MAX_COLUMNS`,
//    `TABLE_MAX_GRID_CELLS`, `TABLE_MAX_RAW_CHARS`) -- so a table with an enormous span product,
//    an enormous column count, or a few enormous cell values replicated across many spanned
//    positions cannot cost more than a fixed, input-independent ceiling. A `rowspan` can
//    likewise never manufacture a grid row past the table's own last SOURCE row: a rowspan that
//    overhangs the end of the table is clamped to the rows that actually exist, not padded with
//    phantom empty rows. A record line longer than one segment's character cap is hard-split at
//    a `'; '` pair boundary where one is in budget, never inside a UTF-16 surrogate pair.

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
   *  parent cell) was itself real tabular content -- a headerless, single-column OUTER wrapper
   *  must still be delivered when the table it wraps is data (issue #478). */
  absorbedDeliverableNested: boolean
  /** True when any cell's `rowspan`/`colspan` attribute exceeded its cap and was clamped --
   *  folded into the same "some content was capped" report as the column/grid-cell caps, so a
   *  clamped span is never silently invisible in the output. */
  spanClamped: boolean
  /** Total `cellsPlaced + charsUsed` charged across every NESTED table's own grid expansion and
   *  line-building (issue #478), folded into this table's `workUnits` in `serializeTable` so a
   *  table with many small nested tables cannot cost more real work than it is charged for.
   *  Meaningful only on the OUTERMOST `RetainedTable` `parseTableBody` returns; 0 otherwise. */
  nestedWork: number
  /** True when a NESTED table's own row cap fired -- folded into the outermost table's
   *  "[Rows … shown]" marker so a cap hit inside a nested table is disclosed the same way one
   *  at top level is (issue #478). Meaningful only on the OUTERMOST `RetainedTable`. */
  nestedRowsTruncated: boolean
  /** True when a NESTED table's own column/grid/char cap fired -- folded into the outermost
   *  table's "[Some cells … omitted]" marker, same reasoning. Meaningful only on the OUTERMOST
   *  `RetainedTable`. */
  nestedGridTruncated: boolean
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
  /** Issue #478: true while everything appended into the CURRENT cell/caption (since it last
   *  started) came only from nested-table inlines, never from ordinary text -- decides whether
   *  the next nested-table inline joins with '; ' (a run of record-shaped siblings) or ' ' (one
   *  is sitting inside running prose). Reset whenever a new cell/caption starts. */
  nestedOnly: boolean
  /** Issue #478: true right after a nested-table inline was appended into the CURRENT
   *  cell/caption; the next append of any kind inserts a single space first, so prose that
   *  follows a nested table's inline text does not run straight into it. */
  pendingSep: boolean
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
    absorbedDeliverableNested: false,
    nestedOnly: true,
    pendingSep: false
  }
}

function finishContext(
  ctx: TableContext,
  extra: { spanClamped: boolean; nestedWork?: number; nestedRowsTruncated?: boolean; nestedGridTruncated?: boolean }
): RetainedTable {
  return {
    caption: tidyWhole(ctx.caption),
    rows: ctx.rows.map((row) => row.map((c) => ({ ...c, text: tidyWhole(c.text) }))),
    sourceRowCount: ctx.sourceRowCount,
    totalSourceRows: ctx.totalSourceRows,
    rowsTruncated: ctx.sourceRowCount < ctx.totalSourceRows,
    absorbedDeliverableNested: ctx.absorbedDeliverableNested,
    spanClamped: extra.spanClamped,
    nestedWork: extra.nestedWork ?? 0,
    nestedRowsTruncated: extra.nestedRowsTruncated ?? false,
    nestedGridTruncated: extra.nestedGridTruncated ?? false
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
 * Returns the nested table's own grid/line-building cost (`workUnits`, issue #478) and whether
 * its own row or column/grid/char cap fired, so the caller can fold both into the outermost
 * table's charged work and cut markers.
 */
function inlineNestedTable(table: RetainedTable): { text: string; workUnits: number; gridTruncated: boolean } {
  const { lines, gridTruncated, cellsPlaced } = tableToRecordLines(table)
  const parts: string[] = []
  if (table.caption) parts.push(table.caption)
  parts.push(...lines)
  let charsUsed = table.caption.length
  for (const line of lines) charsUsed += line.length
  return { text: parts.join('; '), workUnits: cellsPlaced + charsUsed, gridTruncated }
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
  // > 0 while inside a too-deeply-nested OR layout/navbox-classed nested table: dropped whole
  // (issue #478 -- a nested table's own class is checked against the same classifier as the
  // outermost table, not merely its depth).
  let droppedDepth = 0
  // Shared across every table on the stack (outer and nested): whether ANY cell's span
  // attribute was clamped, folded into the OUTERMOST table's report only.
  let spanClamped = false
  // Issue #478 (NB2/NB3): total cellsPlaced+chars charged by every nested table's own grid
  // expansion and line-building, and whether any nested table's own row or grid/column/char cap
  // fired -- all three flat across the WHOLE call (every nesting depth updates the same
  // variables), then folded into the outermost table's `nestedWork`/`nestedRowsTruncated`/
  // `nestedGridTruncated` at the final return.
  let nestedWorkUsed = 0
  let nestedRowsTruncated = false
  let nestedGridTruncated = false

  const active = (): TableContext => stack[stack.length - 1]

  const appendText = (raw: string): void => {
    if (raw.length === 0 || refSkipDepth > 0 || droppedDepth > 0) return
    const ctx = active()
    const text = decodeEntities(raw)
    if (ctx.inCaption) {
      if (ctx.pendingSep) { ctx.caption += ' '; ctx.pendingSep = false }
      ctx.caption += text
      ctx.nestedOnly = false
    } else if (ctx.cell) {
      if (ctx.pendingSep) { ctx.cell.text += ' '; ctx.pendingSep = false }
      ctx.cell.text += text
      ctx.nestedOnly = false
    }
  }
  const appendLiteral = (literal: string): void => {
    if (refSkipDepth > 0 || droppedDepth > 0) return
    const ctx = active()
    if (ctx.inCaption) {
      if (ctx.pendingSep) { ctx.caption += ' '; ctx.pendingSep = false }
      ctx.caption += literal
      ctx.nestedOnly = false
    } else if (ctx.cell) {
      if (ctx.pendingSep) { ctx.cell.text += ' '; ctx.pendingSep = false }
      ctx.cell.text += literal
      ctx.nestedOnly = false
    }
  }
  // Issue #478 (NB6): a nested table's inline text is structurally its own clause, not running
  // prose -- it never glues directly onto whatever text already sits in the same cell/caption.
  // A run of sibling nested tables (nothing but nested-table inlines appended so far) joins
  // with '; ', the same separator `inlineNestedTable` uses for its own parts; a nested table
  // sitting inside real prose joins with a single space on both sides instead, so it reads as
  // an inserted clause rather than a second field in a list.
  const appendNestedInline = (inline: string): void => {
    if (inline.length === 0 || refSkipDepth > 0 || droppedDepth > 0) return
    const ctx = active()
    if (ctx.inCaption) {
      if (ctx.caption.length > 0) ctx.caption += ctx.nestedOnly ? '; ' : ' '
      ctx.caption += inline
    } else if (ctx.cell) {
      if (ctx.cell.text.length > 0) ctx.cell.text += ctx.nestedOnly ? '; ' : ' '
      ctx.cell.text += inline
    }
    ctx.pendingSep = true
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
          // Issue #478 (NB4): a nested table's OWN class is checked against the same
          // layout/navbox classifier the outermost table already uses -- a `navbox`/`ambox`
          // nested inside an otherwise-kept table is dropped, not inlined, exactly one
          // condition reusing the existing drop machinery (droppedDepth).
          const cls = attrValue(attrs, 'class')
          if (isLayoutTableClass(cls) || stack.length >= MAX_NESTING_DEPTH) droppedDepth += 1
          else stack.push(makeContext())
        }
      } else if (droppedDepth > 0) {
        droppedDepth -= 1
      } else if (stack.length > 1) {
        // A nested table just closed: inline it into whatever cell/caption of the PARENT was
        // open when it started, then pop back to the parent context. If the nested table was
        // itself real tabular content, that fact propagates to the parent so a headerless
        // single-column wrapper around it is still judged deliverable.
        const nested = stack.pop() as TableContext
        if (nestedWorkUsed >= TABLE_MAX_RAW_CHARS) {
          // Issue #478 (NB2): the global nested-work budget for this outermost table is
          // already spent -- drop this nested table's content entirely, WITHOUT building its
          // grid at all, rather than charging it its own local TABLE_MAX_RAW_CHARS budget. A
          // pathological input with thousands of small nested tables must not multiply real
          // work by table count: only the first TABLE_MAX_RAW_CHARS worth of nested content
          // is ever inlined, and the drop is disclosed the same way a clamped span is.
          spanClamped = true
        } else {
          const nestedTable = finishContext(nested, { spanClamped: false })
          if (nestedTable.rowsTruncated) nestedRowsTruncated = true
          const { text: inline, workUnits: nestedOwnWork, gridTruncated: nestedOwnGridTruncated } =
            inlineNestedTable(nestedTable)
          if (nestedOwnGridTruncated) nestedGridTruncated = true
          nestedWorkUsed += nestedOwnWork
          appendNestedInline(inline)
          if (hasDeliverableContent(nestedTable) || nestedTable.absorbedDeliverableNested) {
            active().absorbedDeliverableNested = true
          }
        }
      } else {
        // The OUTERMOST table just closed.
        return {
          table: finishContext(stack[0], { spanClamped, nestedWork: nestedWorkUsed, nestedRowsTruncated, nestedGridTruncated }),
          end: i
        }
      }
      continue
    }
    if (droppedDepth > 0) continue // inside a dropped (too-deep or layout-classed) nested table

    if (name === 'sup') {
      // <sup class="mw-ref"> citation brackets stay dropped, same as prose (html.ts's
      // supSkipDepth). An ordinary <sup> gets the table-scoped readable convention: a literal
      // `^` immediately before its own text, so `g/cm<sup>3</sup>` reads `g/cm^3` and
      // `10<sup>6</sup>` reads `10^6` -- never flattened to `g/cm3` / `106`. Prose keeps
      // today's flattening unchanged (out of scope — docs/known-limitations.md). While already
      // skipping a ref bracket, EVERY nested `<sup>` (ref or not) is counted symmetrically on
      // open/close, exactly like html.ts's own prose `supSkipDepth` -- a plain `<sup>` nested
      // inside a `<sup class="mw-ref">` must not decrement the depth and leak the rest of the
      // citation (issue #478).
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
      const ctx = active()
      ctx.inCaption = !isClose
      if (!isClose) {
        ctx.pendingSep = false
        ctx.nestedOnly = true
      }
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
      ctx.pendingSep = false
      ctx.nestedOnly = true
      continue
    }
    if (!isClose && (name === 'br' || name === 'p' || name === 'div' || name === 'li')) {
      // A SPACE, not a newline (issue #478): table-derived text is one line per data row by
      // contract, and an intra-cell break must not split that line in two.
      appendLiteral(' ')
    }
    // Everything else (thead/tbody/tfoot/span/a/b/i/small/…) is transparent: its own text runs
    // already flow through `appendText` between tags.
  }
  // EOF without a matching close for every open <table>: total on malformed input (never
  // throws). Only the OUTERMOST context is returned -- an unterminated nested table's partial
  // content is not inlined, an acceptable degradation for input that never closes at all.
  return {
    table: finishContext(stack[0], { spanClamped, nestedWork: nestedWorkUsed, nestedRowsTruncated, nestedGridTruncated }),
    end: n
  }
}

/** A header cell exists anywhere in the table. */
function hasHeaderCell(table: RetainedTable): boolean {
  return table.rows.some((row) => row.some((c) => c.header))
}

/** The structural drop test (brief §1): no header cell AND no real tabular content, UNLESS a
 *  nested table this one absorbed was itself real tabular content -- the wrapper's own shape is
 *  layout, but the data one level inside it is not, and the two are judged apart. */
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
 *  infobox's `<th>Dichte</th><td>19,32</td>` shape (issue #478). Multiple leading header cells
 *  (rare: "Country | Capital" both headers, then data) join with ' / ', the same convention
 *  used for multi-row headers below. `null` when the row has no leading header cell at all (an
 *  ordinary data row, keyed by a header ROW above instead). */
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
 *  `Column N` value, issue #478). */
function leadingHeaderSpan(gridRow: ReadonlyArray<TableCell | undefined>): number {
  let c = 0
  while (c < gridRow.length && gridRow[c]?.header) c += 1
  return c
}

/**
 * Expand rowspan/colspan into a rectangular grid; a spanning cell's text/header flag is
 * repeated into every grid position it covers, bounded on three independent axes so no crafted
 * span/column/cell combination can cost more than a fixed ceiling (issue #478):
 *  - a cell placed at or past `TABLE_MAX_COLUMNS` is dropped and no further source cell in that
 *    row is examined (a row's iteration cost is therefore bounded by the column cap, never by
 *    how many source cells the row actually contains);
 *  - a `rowspan` is clamped to the rows that actually exist in THIS table -- it can never
 *    manufacture a grid row past the table's last real source row, so a single source row
 *    cannot fake a tall grid the way an unclamped rowspan could;
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

/** A resolved column key, tagged with whether it came from a header cell spanning more than
 *  one column. `isGroup` cells never become a per-cell key (issue #478): a spanning header is a
 *  GROUP LABEL, not the name of each column it happens to cover. */
interface ColumnKey {
  text: string
  isGroup: boolean
}

/**
 * One line per data row: `key: value; key: value`. Header rows never become a data line (that
 * is what keeps a spanning header from being repeated on every cell): they only seed the keys
 * used for the rows below them. Column keys are resolved in a single forward pass -- a running
 * `columnKeys[c]` cache updated whenever an all-header row is crossed -- so the lookup is O(1)
 * amortised per data cell, never an upward rescan of every row above it.
 *
 * A row's own leading header cell wins over that cache ONLY when none of the row's own covered
 * (non-leading-header) columns already has a genuine, non-group column key: an infobox row
 * shaped `<th>Dichte</th><td>19,32 g/cm³</td>` with no column headers above it keys on "Dichte";
 * an ordinary `<th scope="row">France</th><td>Paris</td><td>68</td>` row sitting under real
 * `<th>Country</th><th>Capital</th><th>Population</th>` column headers keys on "Capital"/
 * "Population" instead, never repeats "France" as every cell's key (issue #478). When the row's
 * own header is set aside this way, `skipCols` returns to 0 so the leading cell is itself keyed
 * by its own column header, same as any other covered cell.
 *
 * A `colspan > 1` header cell (`isGroup`, above) is never glued onto a covered column as its own
 * per-cell key -- that is the exact defect it replaces (a real German-Wikipedia infobox labels
 * its rows with plain `<td>` cells under a `<th colspan="2">` group heading, so the group text
 * used to become BOTH columns' key, on every row: "Physikalisch: Dichte; Physikalisch: 19,32
 * g/cm3 …", issue #478). When a row has no narrower header of its own (`rowHeaderText` is null)
 * and none of its covered columns has a genuine (non-group) key either, the row is rendered as a
 * GROUP RECORD instead: for a table shaped as exactly two columns, the first cell is the row's
 * own label ("Physikalisch — Dichte: 19,32 g/cm³ …"); for any other column count the cells are
 * joined un-keyed under the one group label, rather than inventing `Column N` names for columns
 * that were never headed at all ("Physikalisch: A; B; C"). The group label is looked up once per
 * row (never once per cell), and is omitted from the line entirely when no group header covers
 * the row (a plain headerless table degrades to the same label/value or unkeyed-join form, with
 * no label prefix). A row that resolves to a SINGLE source cell spanning every one of its
 * covered columns (a full-width note or sub-heading row) is emitted once, un-keyed, before any
 * of the above -- never once per covered column and never as `X: X` (issue #478).
 */
export function tableToRecordLines(table: RetainedTable): { lines: string[]; gridTruncated: boolean; cellsPlaced: number } {
  const { grid, numCols, gridTruncated: capTruncated, cellsPlaced } = buildGrid(table)
  const lines: string[] = []
  const columnKeys: (ColumnKey | null)[] = new Array(numCols).fill(null)
  let totalChars = 0
  let contentCapped = false

  const chargeLine = (line: string): boolean => {
    if (totalChars + line.length > TABLE_MAX_RAW_CHARS) {
      contentCapped = true
      return false
    }
    lines.push(line)
    totalChars += line.length
    return true
  }

  for (let r = 0; r < grid.length; r += 1) {
    if (contentCapped) break
    const sourceRow = table.rows[r]
    if (isAllHeaderRow(sourceRow)) {
      for (let c = 0; c < numCols; c += 1) {
        const cell = grid[r]?.[c]
        const text = cell?.text.trim()
        if (text) columnKeys[c] = { text, isGroup: (cell?.columns ?? 1) > 1 }
      }
      continue
    }
    let rowHeader = rowHeaderText(sourceRow)
    let skipCols = rowHeader !== null ? leadingHeaderSpan(grid[r]!) : 0

    if (rowHeader !== null) {
      // A genuine (non-group) column key already covers one of this row's own data columns:
      // the row sits under real column headers, so those headers win over the row's own
      // leading `<th>` (issue #478) -- treat it as an ordinary column-keyed row instead.
      let underGenuineColumnHeader = false
      for (let c = skipCols; c < numCols; c += 1) {
        const colKey = columnKeys[c]
        if ((grid[r]![c]?.text ?? '').trim() && colKey !== null && !colKey.isGroup) {
          underGenuineColumnHeader = true
          break
        }
      }
      if (underGenuineColumnHeader) {
        rowHeader = null
        skipCols = 0
      }
    }

    if (rowHeader === null) {
      const coveredCols: number[] = []
      for (let c = skipCols; c < numCols; c += 1) {
        if ((grid[r]![c]?.text ?? '').trim()) coveredCols.push(c)
      }
      if (coveredCols.length >= 2) {
        // A single source cell (buildGrid places the SAME TableCell reference into every grid
        // position its span covers) filling every one of the row's covered columns is a
        // full-width note or sub-heading, not parallel key/value pairs -- emit it once.
        const distinctCells = new Set(coveredCols.map((c) => grid[r]![c]))
        if (distinctCells.size === 1) {
          const groupKey = coveredCols.map((c) => columnKeys[c]).find((k) => k?.isGroup)
          const noteText = grid[r]![coveredCols[0]!]!.text.trim()
          chargeLine(groupKey ? `${groupKey.text} — ${noteText}` : noteText)
          continue
        }
      }
      const hasGenuineKey = coveredCols.some((c) => columnKeys[c] !== null && !columnKeys[c]!.isGroup)
      if (coveredCols.length > 0 && !hasGenuineKey) {
        const groupKey = coveredCols.map((c) => columnKeys[c]).find((k) => k?.isGroup)
        const groupLabel = groupKey ? groupKey.text : null
        let line: string
        if (numCols === 2 && coveredCols.length === 2) {
          const label = grid[r]![coveredCols[0]!]!.text.trim()
          const value = grid[r]![coveredCols[1]!]!.text.trim()
          line = groupLabel ? `${groupLabel} — ${label}: ${value}` : `${label}: ${value}`
        } else {
          const values = coveredCols.map((c) => grid[r]![c]!.text.trim())
          line = groupLabel ? `${groupLabel}: ${values.join('; ')}` : values.join('; ')
        }
        chargeLine(line)
        continue
      }
    }

    const parts: string[] = []
    for (let c = skipCols; c < numCols; c += 1) {
      const value = grid[r]![c]?.text ?? ''
      if (!value.trim()) continue // a ragged row's empty trailing pair carries no information
      const colKey = columnKeys[c]
      // A group-sourced key never becomes a literal per-cell key (see above), even in this
      // mixed fallback (some covered columns genuinely headed, this one is not): it falls back
      // to `Column N` exactly as an unheaded column always has.
      const key = rowHeader ?? (colKey && !colKey.isGroup ? colKey.text : null) ?? `Column ${c + 1}`
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

/** True when `cc` is a UTF-16 high (lead) surrogate. */
function isHighSurrogate(cc: number): boolean {
  return cc >= 0xd800 && cc <= 0xdbff
}
/** True when `cc` is a UTF-16 low (trail) surrogate. */
function isLowSurrogate(cc: number): boolean {
  return cc >= 0xdc00 && cc <= 0xdfff
}

/** Hard-splits a line longer than `maxChars`, preferring a `'; '` pair boundary within budget
 *  and falling back to a raw character cut -- the segment cap must hold even for a single
 *  record line whose value alone exceeds it (issue #478). The raw-character fallback never
 *  cuts inside a UTF-16 surrogate pair (an astral character, e.g. an emoji, split across two
 *  code units would otherwise leave a lone surrogate in both pieces): the cut index is nudged
 *  left past the pair boundary, losing no character and keeping every piece well-formed UTF-16. */
const LONG_LINE_CUT = ' [cut]'
function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line]
  const budget = Math.max(1, maxChars - LONG_LINE_CUT.length)
  const pieces: string[] = []
  let rest = line
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('; ', budget)
    if (cut <= 0) cut = budget
    while (cut > 0 && isHighSurrogate(rest.charCodeAt(cut - 1)) && isLowSurrogate(rest.charCodeAt(cut))) {
      cut -= 1
    }
    pieces.push(`${rest.slice(0, cut)}${LONG_LINE_CUT}`)
    rest = rest.slice(cut).replace(/^; /, '')
  }
  pieces.push(rest)
  return pieces
}

export interface TableSerialisation {
  segments: string[]
  /** Grid cells placed plus characters emitted, for this table AND every nested table it
   *  absorbed -- the real cost of delivering this table, charged into html.ts's `work` counter
   *  alongside the existing per-byte sub-scan charge (issue #478: previously only the table's
   *  SOURCE BYTES were charged, and a nested table's own grid/line-building cost was not
   *  charged anywhere, so the pinned work/n bound never saw it at all). */
  workUnits: number
}

/**
 * Render a RetainedTable into one or more segment texts, capped so a large table cannot
 * explode the unit count: at most TABLE_MAX_SEGMENTS segments of at most
 * TABLE_SEGMENT_MAX_CHARS characters each, with any single over-long line hard-split first.
 * A table cut by any cap -- including a cap that fired inside a table it absorbed by nesting --
 * says so in its own text.
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
  // dropped by the row/segment caps, or by a NESTED table's own row cap (`nestedRowsTruncated`,
  // issue #478) -- "source rows" since `table.totalSourceRows` counts every top-level `<tr>`
  // including header rows, not only the data rows `consumed` counts; and cells or content
  // dropped by the column/grid/char/span caps, or by a nested table's own such cap
  // (`nestedGridTruncated`).
  const markers: string[] = []
  if (table.rowsTruncated || table.nestedRowsTruncated || cutForSegments || consumed < lines.length) {
    markers.push(`[Rows 1-${consumed} of ${table.totalSourceRows} source rows shown]`)
  }
  if (gridTruncated || table.spanClamped || table.nestedGridTruncated) {
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
  return { segments: texts, workUnits: cellsPlaced + charsUsed + table.nestedWork }
}
