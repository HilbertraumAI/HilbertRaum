import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { TableColumn, TableSpec } from './index'

// Persistence for generic result tables (result-tables plan §4, Phase 2): one table per assistant
// message, saved right after the message row, loaded on demand by the message-level export IPC.
// Deletion is FK-CASCADEd from `messages` (regenerate + conversation delete), so there is no
// explicit purge here. Content posture: columns/rows are CONTENT — they live only in this table
// and the user-chosen export file, never in a log/audit (ids/counts only at the boundaries).

/** Row ceiling per persisted table — parity with the bank domain's MAX_TRANSACTIONS bound, so a
 *  pathological table can never grow the messages DB unbounded. Excess rows are NOT persisted;
 *  the caller decides whether that warrants withholding the table entirely (the bank handler's
 *  tables are already bounded upstream, so this is a backstop, not a working path). */
export const MAX_RESULT_TABLE_ROWS = 10000

export interface SaveResultTableInput {
  messageId: string
  conversationId: string
  table: TableSpec<object>
  /** Content-free origin discriminator (e.g. 'bank-statement'). */
  source?: string
  now?: () => string
}

/** Persist a message's result table. Returns false (persisting nothing) when the table is empty,
 *  over the row ceiling, or fails to serialize — the ANSWER must never be blocked by its table
 *  (mirror of `serializeCoverage`'s best-effort posture). */
export function saveResultTable(db: Db, input: SaveResultTableInput): boolean {
  const { table } = input
  if (table.columns.length === 0 || table.rows.length === 0) return false
  if (table.rows.length > MAX_RESULT_TABLE_ROWS) return false
  let columnsJson: string
  let rowsJson: string
  try {
    columnsJson = JSON.stringify(table.columns)
    rowsJson = JSON.stringify(table.rows)
  } catch {
    return false
  }
  const at = (input.now ?? (() => new Date().toISOString()))()
  db.prepare(
    `INSERT INTO result_tables (id, message_id, conversation_id, columns_json, rows_json, row_count, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    input.messageId,
    input.conversationId,
    columnsJson,
    rowsJson,
    table.rows.length,
    input.source ?? null,
    at
  )
  return true
}

/** Load the result table attached to a message, or null (no table / malformed payload — tolerant,
 *  like `parseCoverage`: a broken row must never break the caller). */
export function loadResultTable(db: Db, messageId: string): TableSpec | null {
  const row = db
    .prepare('SELECT columns_json, rows_json FROM result_tables WHERE message_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(messageId) as { columns_json: string; rows_json: string } | undefined
  if (!row) return null
  try {
    const columns = JSON.parse(row.columns_json) as TableColumn[]
    const rows = JSON.parse(row.rows_json) as Array<Record<string, string | number | null>>
    if (!Array.isArray(columns) || !Array.isArray(rows) || columns.length === 0) return null
    if (columns.some((c) => typeof c?.key !== 'string' || typeof c?.label !== 'string')) return null
    return { columns, rows }
  } catch {
    return null
  }
}
