import { csvField } from '../skills/tools/money'

// Generic tabular result model + schema-agnostic CSV serializer (result-tables plan §3, D59/D60).
// A `TableSpec` separates WHICH columns a deliverable carries from any fixed domain struct, so a
// serializer never needs to know the domain: the bank CSV (with or without the presence-gated
// category column, D62), a future invoice table, or a Phase-3 enriched table all serialize through
// the one audited path — including the `csvField` formula-injection neutralization (S12 F4).
// Pure: no FS, no DB, no model.

/** How a column's cells serialize: money = fixed 2-dp dot-decimal (the extractor's cent invariant,
 *  locale-free), integer = plain digits, text = neutralized via `csvField`. */
export type TableColumnKind = 'text' | 'money' | 'integer'

export interface TableColumn {
  /** The row-object key the cells are read from. */
  key: string
  /** The emitted header label. */
  label: string
  /** Cell serialization; defaults to 'text'. */
  kind?: TableColumnKind
}

/** One cell value; null/undefined serialize as an empty field (absent, never invented — §22-D1). */
export type TableCell = string | number | null | undefined

export interface TableSpec<T extends object = Record<string, TableCell>> {
  columns: readonly TableColumn[]
  /** Row objects; each column's cells are read via its `key`. Extra fields are simply not emitted. */
  rows: readonly T[]
}

function cellToCsv(value: TableCell, kind: TableColumnKind): string {
  if (value === null || value === undefined) return ''
  if (kind === 'money') return typeof value === 'number' ? value.toFixed(2) : csvField(value)
  if (kind === 'integer') return typeof value === 'number' ? String(value) : csvField(value)
  return csvField(String(value))
}

/**
 * Serialize a table to CSV text (pure — no FS). Header + one line per row, the spec's column
 * order; `\r\n` line ends + a trailing newline (the existing export contract — spreadsheet
 * friendliness, clean file end). Text cells go through `csvField` so a hostile description can
 * never smuggle a spreadsheet formula (S12 F4); numeric kinds emit bare digits exactly as the
 * previous per-domain serializers did.
 */
export function tableToCsv<T extends object>(spec: TableSpec<T>): string {
  const lines = [spec.columns.map((c) => csvField(c.label)).join(',')]
  for (const row of spec.rows) {
    const cells = row as Record<string, TableCell>
    lines.push(spec.columns.map((c) => cellToCsv(cells[c.key], c.kind ?? 'text')).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
