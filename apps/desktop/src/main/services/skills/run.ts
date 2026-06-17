import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit, SkillToolContext } from '../../../shared/types'
import { getRegisteredTool, runSkillTool } from './tool-registry'
import {
  BUILTIN_CATEGORIES,
  BUILTIN_CATEGORY_RULES,
  type CashflowSummary,
  type CategorizationRow,
  type ExtractTransactionsOutput,
  type ReconcileResult,
  type TransactionInput
} from './tools/bank-statement'

// The app-orchestrated run seam (architecture.md "Skills — design record" §8, Phase S11a). This is the exact
// function S11b's IPC/UI will call: it is invoked by the APP from a user action (DS4), never by the
// model parsing tool_calls. It builds the NARROW `SkillToolContext` (frozen scope + the only content
// reach, `readDocumentChunks`), runs `extract_transactions` THROUGH the S10 gate (`runSkillTool` —
// validate→run→validate), and on success persists the rows. No IPC/renderer in S11a.
//
// Two sinks, deliberately distinct:
//   - the GATE brackets the TOOL run on the ids/counts-only AUDIT sink (skill_run_started/done/failed);
//   - this SEAM owns the `skill_runs` TABLE row (the run-history lifecycle) + the content-class bank
//     data tables. The table never stores content: document_ids_json is ids, result_ref is the
//     bank_statements id, error is friendly/technical (skills-plan §8.2/§9.5).
// A persist failure ROLLBACKs so NO partial bank rows survive (no-partial-persist, §12.2).

const EXTRACT_TOOL_NAME = 'extract_transactions'

export interface BankExtractionArgs {
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run row + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (a doc-action run may not be a chat). */
  conversationId?: string | null
  /** The single selected document to extract from (becomes the frozen one-id scope). */
  documentId: string
}

export interface BankExtractionDeps {
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation (S11b wires the Cancel affordance to this). */
  signal?: AbortSignal
  /** Optional progress, merged into the polling status by the app. */
  onProgress?: (p: { done: number; total: number }) => void
  /** Clock seam for deterministic tests. */
  now?: () => string
}

export interface BankExtractionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The created `bank_statements.id` on success. */
  statementId?: string
  transactionCount?: number
  /**
   * True when the run ended because it was CANCELLED (vs a genuine failure). The seam is the
   * authority on this — the controller must not re-derive it from a late `signal.aborted` (B2).
   */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1) — e.g. 'unavailable'. */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * Build the scope-bounded content read for the context (skills-plan §12 / S11a). It is the WHOLE of
 * a tool's content reach: a per-document chunk read confined to the `allowed` id set — an id outside
 * the frozen scope returns `[]`. NOT a general Db/SQL/FS handle (the closure is the only capability).
 */
export function buildReadDocumentChunks(db: Db, allowed: ReadonlySet<string>): SkillToolContext['readDocumentChunks'] {
  const stmt = db.prepare(
    'SELECT text, page_number AS page, chunk_index AS idx FROM chunks WHERE document_id = ? ORDER BY chunk_index'
  )
  return (documentId: string): DocumentChunkRead[] => {
    if (!allowed.has(documentId)) return [] // scope-bounded: an out-of-scope id is refused
    const rows = stmt.all(documentId) as unknown as Array<{ text: string; page: number | null; idx: number }>
    return rows.map((r) => ({ text: r.text, page: r.page ?? null, index: r.idx }))
  }
}

export function finishRun(
  db: Db,
  runId: string,
  status: 'done' | 'failed' | 'cancelled',
  completedAt: string,
  resultRef: string | null,
  error: string | null
): void {
  db.prepare(
    'UPDATE skill_runs SET status = ?, completed_at = ?, result_ref = ?, error = ? WHERE id = ?'
  ).run(status, completedAt, resultRef, error, runId)
}

/**
 * Run `extract_transactions` on one selected document through the gate and persist the result.
 * Returns ids/counts only — never the extracted content (which lives only in the bank data tables).
 */
export async function runBankExtraction(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<BankExtractionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]

  // Record the run as started BEFORE the gate (committed; survives a later ROLLBACK of the bank rows).
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  // Everything after the 'started' insert is guarded: any UNEXPECTED throw (e.g. a transiently
  // locked DB while building the chunk reader) must still drive a terminal status — never leave the
  // run stranded at 'started' (B4). The expected paths (bad shape, cancel, persist failure) return
  // their own terminal result inside; this outer catch is the safety net.
  try {
    const tool = getRegisteredTool(EXTRACT_TOOL_NAME)
    if (!tool) {
      // No run happened ⇒ no audit event (matches the gate's "pre-run refusals are not audited").
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'unavailable', error: msg }
    }

    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      readDocumentChunks: buildReadDocumentChunks(db, new Set(documentIds)),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: { documentId: args.documentId },
      ctx
    })

    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { ok: false, runId, cancelled, error: result.error }
    }

    // Persist the schema-validated output atomically — a failed write leaves NO partial rows.
    const output = result.output as ExtractTransactionsOutput
    const statementId = randomUUID()
    const completedAt = now()
    try {
      db.exec('BEGIN')
      db.prepare(
        `INSERT INTO bank_statements (id, document_id, run_id, period_start, period_end, currency, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`
      ).run(statementId, args.documentId, runId, output.currency ?? null, completedAt)
      const insertTx = db.prepare(
        `INSERT INTO bank_transactions
          (id, statement_id, run_id, row_index, date, value_date, description, amount, currency, balance_after, source_page, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      output.transactions.forEach((t, i) => {
        insertTx.run(
          randomUUID(),
          statementId,
          runId,
          i,
          t.date,
          t.valueDate ?? null,
          t.description,
          t.amount,
          t.currency,
          t.balanceAfter ?? null,
          t.sourcePage ?? null,
          completedAt
        )
      })
      db.prepare(
        `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
      ).run(completedAt, statementId, runId)
      db.exec('COMMIT')
    } catch {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original failure */
      }
      // Technical reason to the local log only — never the renderer/audit (§22-M1).
      console.error('[skills] bank extraction failed to persist')
      const msg = 'This statement could not be saved. Nothing was changed.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'persistFailed', error: msg }
    }

    return { ok: true, runId, statementId, transactionCount: output.transactions.length }
  } catch {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* no active transaction */
    }
    console.error('[skills] bank extraction failed unexpectedly')
    const msg = 'This statement could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'persistFailed', error: msg }
  }
}

// =====================================================================================
// S11c — the downstream run seams (validate / categorize / summarize / export).
//
// These tools operate on the ALREADY-EXTRACTED rows, not document chunks. The seam loads the
// LATEST statement for the in-scope document (deterministic target — architecture.md "Skills — design record" §8
// S11c) and passes the rows to the PURE tool as STRUCTURED INPUT (no new SkillToolContext accessor;
// the §14 ceiling is unchanged). Persistence (reconciled flags / category assignments) stays here,
// atomically (no-partial-persist). `summarize_cashflow` is read-only (no persist). The CSV export
// is the first FS-write from a skill tool: the tool only *produces* the CSV; the seam writes it via
// a MAIN-side, user-chosen save — the path + content are NEVER logged/audited (ids/counts only).
// =====================================================================================

const VALIDATE_TOOL_NAME = 'validate_statement_balances'
const CATEGORIZE_TOOL_NAME = 'categorize_transactions'
const SUMMARIZE_TOOL_NAME = 'summarize_cashflow'
const EXPORT_TOOL_NAME = 'export_transactions_csv'

/** A transaction loaded from the DB — the tool input fields plus the ids the seam persists against. */
interface LoadedTransaction extends TransactionInput {
  id: string
  rowIndex: number
}

export interface StatementToolResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure). */
  runId: string
  /** A content-free count the renderer surfaces (rows touched / not reconciling / saved). */
  count?: number
  /** A content-free outcome discriminator (validate: 'reconciled'|'unreconciled'|'unchecked'). */
  resultKind?: string
  /**
   * True when the run ended because it was CANCELLED (vs a genuine failure) — e.g. the user
   * dismissed the CSV save dialog, or Cancel landed before the work persisted (B1/B2). The
   * controller surfaces this directly instead of re-deriving it from `signal.aborted`.
   */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1) — e.g. 'needsExtraction'. */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/** The newest statement for a document (the deterministic run target), or null if none extracted. */
function latestStatement(db: Db, documentId: string): { id: string } | null {
  const row = db
    .prepare(
      `SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(documentId) as { id: string } | undefined
  return row ?? null
}

/** Load a statement's transactions in stable row order (null columns omitted, not passed as null). */
function loadTransactions(db: Db, statementId: string): LoadedTransaction[] {
  const rows = db
    .prepare(
      `SELECT id, row_index AS rowIndex, date, value_date AS valueDate, description, amount, currency,
              balance_after AS balanceAfter, source_page AS sourcePage
       FROM bank_transactions WHERE statement_id = ? ORDER BY row_index`
    )
    .all(statementId) as Array<{
    id: string
    rowIndex: number
    date: string
    valueDate: string | null
    description: string
    amount: number
    currency: string
    balanceAfter: number | null
    sourcePage: number | null
  }>
  return rows.map((r) => {
    const t: LoadedTransaction = {
      id: r.id,
      rowIndex: r.rowIndex,
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: r.currency
    }
    if (r.valueDate != null) t.valueDate = r.valueDate
    if (r.balanceAfter != null) t.balanceAfter = r.balanceAfter
    if (r.sourcePage != null) t.sourcePage = r.sourcePage
    return t
  })
}

/** Strip the persistence-only ids before handing the rows to the pure tool (schema is strict). */
function toToolInput(txs: LoadedTransaction[]): { transactions: TransactionInput[] } {
  return {
    transactions: txs.map(({ id: _id, rowIndex: _rowIndex, ...rest }) => rest)
  }
}

interface PreparedRun {
  runId: string
  statementId: string
  transactions: LoadedTransaction[]
  output: unknown
  completedAt: string
}

/**
 * The shared prefix for every downstream tool: record the run as started, locate the latest
 * statement, load its rows, run the PURE tool through the gate with the rows as structured input.
 * Returns the gate output for the caller to persist, or a finished failure result. The run row is
 * left `started` on success — the caller finalizes it inside its own persist transaction.
 */
async function prepareStatementRun(
  db: Db,
  toolName: string,
  args: BankExtractionArgs,
  deps: BankExtractionDeps,
  confirmed?: boolean
): Promise<{ prepared: PreparedRun } | { failed: StatementToolResult }> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  // Guarded like runBankExtraction (B4): an unexpected throw between the 'started' insert and a
  // terminal result (e.g. a DB error in latestStatement/loadTransactions) must not strand the run.
  try {
    const tool = getRegisteredTool(toolName)
    if (!tool) {
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'unavailable', error: msg } }
    }

    const statement = latestStatement(db, args.documentId)
    if (!statement) {
      // Honest, friendly: the downstream tools need an extraction first (no figure invented).
      const msg = 'Read the statement first, then run this tool.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
    }

    const transactions = loadTransactions(db, statement.id)
    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      readDocumentChunks: buildReadDocumentChunks(db, new Set(documentIds)),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: toToolInput(transactions),
      ctx,
      confirmed
    })
    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { failed: { ok: false, runId, cancelled, error: result.error } }
    }
    return {
      prepared: { runId, statementId: statement.id, transactions, output: result.output, completedAt: now() }
    }
  } catch {
    console.error('[skills] statement run failed unexpectedly')
    const msg = 'This could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { failed: { ok: false, runId, errorCode: 'persistFailed', error: msg } }
  }
}

/** Roll back a persist failure and mark the run failed — no partial annotations survive. */
function persistFailure(db: Db, runId: string, now: () => string): StatementToolResult {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* keep the original failure */
  }
  console.error('[skills] statement tool failed to persist')
  const msg = 'This could not be saved. Nothing was changed.'
  finishRun(db, runId, 'failed', now(), null, msg)
  return { ok: false, runId, errorCode: 'persistFailed', error: msg }
}

/**
 * `validate_statement_balances` — reconcile printed vs computed running balances and persist the
 * per-row `reconciled` flag (1 ok / 0 mismatch / NULL unchecked). The `count` is the number of rows
 * that DON'T reconcile; `resultKind` distinguishes a clean pass from "nothing could be checked".
 */
export async function runBalanceValidation(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, VALIDATE_TOOL_NAME, args, deps)
  if ('failed' in prep) return prep.failed
  const { runId, statementId, transactions, output, completedAt } = prep.prepared
  const reconcile = output as ReconcileResult
  const mismatchCount = reconcile.rows.filter((r) => r.status === 'mismatch').length
  const checkedAny = reconcile.rows.some((r) => r.status !== 'unknown')
  const resultKind = reconcile.reconciled ? 'reconciled' : checkedAny ? 'unreconciled' : 'unchecked'
  try {
    db.exec('BEGIN')
    const upd = db.prepare('UPDATE bank_transactions SET reconciled = ? WHERE id = ?')
    for (const row of reconcile.rows) {
      const tx = transactions[row.index]
      if (!tx) continue
      const flag = row.status === 'ok' ? 1 : row.status === 'mismatch' ? 0 : null
      upd.run(flag, tx.id)
    }
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, statementId, runId)
    db.exec('COMMIT')
  } catch {
    return persistFailure(db, runId, now)
  }
  return { ok: true, runId, count: mismatchCount, resultKind }
}

/** Get (seeding once) the built-in `bank_categories` ids by name, plus seed the rules they use. */
function ensureBuiltinCategories(db: Db, now: string): Map<string, string> {
  const existing = db.prepare('SELECT id, name FROM bank_categories WHERE builtin = 1').all() as Array<{
    id: string
    name: string
  }>
  const byName = new Map(existing.map((c) => [c.name, c.id]))
  const insertCat = db.prepare(
    'INSERT INTO bank_categories (id, name, builtin, created_at) VALUES (?, ?, 1, ?)'
  )
  for (const name of BUILTIN_CATEGORIES) {
    if (!byName.has(name)) {
      const id = randomUUID()
      insertCat.run(id, name, now)
      byName.set(name, id)
    }
  }
  // Seed the deterministic rules once (transparency: the rules the tool applied are stored too).
  const ruleCount = (db.prepare('SELECT COUNT(*) AS n FROM bank_category_rules').get() as { n: number }).n
  if (ruleCount === 0) {
    const insertRule = db.prepare(
      'INSERT INTO bank_category_rules (id, category_id, match_kind, pattern, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const rule of BUILTIN_CATEGORY_RULES) {
      const catId = byName.get(rule.category)
      if (catId) insertRule.run(randomUUID(), catId, rule.matchKind, rule.pattern, now)
    }
  }
  return byName
}

/**
 * `categorize_transactions` — assign each row a built-in category (deterministic rules) and persist
 * `bank_transactions.category_id`, seeding the built-in categories/rules on first use. The `count`
 * is the number of rows categorized.
 */
export async function runCategorization(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, CATEGORIZE_TOOL_NAME, args, deps)
  if ('failed' in prep) return prep.failed
  const { runId, statementId, transactions, output, completedAt } = prep.prepared
  const { categories } = output as { categories: CategorizationRow[] }
  try {
    db.exec('BEGIN')
    const byName = ensureBuiltinCategories(db, completedAt)
    const upd = db.prepare('UPDATE bank_transactions SET category_id = ? WHERE id = ?')
    for (const assignment of categories) {
      const tx = transactions[assignment.index]
      const catId = byName.get(assignment.category)
      if (tx && catId) upd.run(catId, tx.id)
    }
    db.prepare(
      `UPDATE skill_runs SET status = 'done', completed_at = ?, result_ref = ?, error = NULL WHERE id = ?`
    ).run(completedAt, statementId, runId)
    db.exec('COMMIT')
  } catch {
    return persistFailure(db, runId, now)
  }
  return { ok: true, runId, count: categories.length }
}

/**
 * `summarize_cashflow` — compute inflow/outflow/net totals (read-only; nothing persists). The
 * figures are content and are NOT surfaced in v1 (the busy row stays ids/counts only — a dedicated
 * view / the model-explains step is a later wave); the run proves the pipeline + reports the count.
 */
export async function runCashflowSummary(
  db: Db,
  args: BankExtractionArgs,
  deps: BankExtractionDeps
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, SUMMARIZE_TOOL_NAME, args, deps)
  if ('failed' in prep) return prep.failed
  const { runId, statementId, output, completedAt } = prep.prepared
  const summary = output as CashflowSummary
  // No data table for a summary (no overbuild, §13) — record the run done, persist no figures.
  finishRun(db, runId, 'done', completedAt, statementId, null)
  return { ok: true, runId, count: summary.count }
}

export interface CsvExportDeps extends BankExtractionDeps {
  /**
   * Save CSV text to a user-chosen path (MAIN-side: a save dialog + write). Returns true once
   * written, false if the user cancelled the dialog. The path + content are NEVER logged/audited —
   * the seam only learns whether the user saved (ids/counts boundary, §9.5/§22-M1).
   */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

/**
 * `export_transactions_csv` — produce the CSV (pure tool, confirm-gated `export-file`) and write it
 * MAIN-side to a user-chosen path. The CSV content + the chosen path never touch any log/audit; only
 * "saved N rows" (a count) is surfaced. A cancelled save persists nothing and reports it calmly.
 */
export async function runCsvExport(
  db: Db,
  args: BankExtractionArgs,
  deps: CsvExportDeps
): Promise<StatementToolResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const prep = await prepareStatementRun(db, EXPORT_TOOL_NAME, args, deps, deps.confirmed)
  if ('failed' in prep) return prep.failed
  const { runId, output, completedAt } = prep.prepared
  const { csv, rowCount } = output as { csv: string; rowCount: number }
  // Cancelled after the tool produced the CSV but before the write — don't even open the save
  // dialog, and report it as cancelled (not failed), so nothing is written under a cancel (B2).
  if (deps.signal?.aborted) {
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  let saved: boolean
  try {
    saved = await deps.saveTextFile('transactions.csv', csv)
  } catch {
    console.error('[skills] CSV export failed to write')
    const msg = 'The file could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
  }
  if (!saved) {
    // The user cancelled the save dialog — a calm, non-error outcome (history records it cancelled,
    // and the controller surfaces it as cancelled, not a failure — B1).
    finishRun(db, runId, 'cancelled', now(), null, null)
    return { ok: false, runId, cancelled: true, error: 'Export cancelled. Nothing was saved.' }
  }
  // result_ref stays NULL — the export produces no DB artifact, and the path is never recorded.
  finishRun(db, runId, 'done', completedAt, null, null)
  return { ok: true, runId, count: rowCount }
}
