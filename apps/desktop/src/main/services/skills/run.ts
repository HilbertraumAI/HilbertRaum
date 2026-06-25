import { randomUUID } from 'node:crypto'
import type { Db } from '../db'
import type { DocumentChunkRead, SkillToolAudit, SkillToolContext } from '../../../shared/types'
import { getRegisteredTool, runSkillTool } from './tool-registry'
import {
  BANK_EXTRACTOR_VERSION,
  BUILTIN_CATEGORIES,
  BUILTIN_CATEGORY_RULES,
  type CashflowSummary,
  type CategorizationRow,
  type ExtractTransactionsOutput,
  type ReconcileResult,
  type TransactionInput
} from './tools/bank-statement'
import { CATEGORIZER_CATEGORIES } from './categorizer'
import type { RedactDocumentOutput } from './tools/redaction'

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
  /**
   * The verbatim content reach: a document's ordered, non-overlapping, newline-preserving parser
   * segments (the IPC injects `extractDocumentPreview`). Required for a FAITHFUL extraction — the
   * stored `chunks` table collapses newlines and overlaps (`resolveDocumentReader`). Absent ⇒ the
   * legacy chunk-table reader (the integration tests that seed `chunks` directly).
   */
  readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
  /**
   * Request geometry-aware layout reconstruction from the segment reader (PDF geometry-extraction plan
   * §3.1, D58 — bank-statement only). Threaded into `resolveDocumentReader`; the redaction/invoice
   * seams leave it unset and get byte-unchanged reading-order text.
   */
  layout?: boolean
  /**
   * Re-extraction (A9): when set, DELETE every prior `bank_statements` row (and its transactions /
   * corrections) for the document inside the persist transaction BEFORE inserting the fresh one. The
   * reuse paths pass it when the latest statement is STALE (`isBankStatementStale`) so a since-fixed
   * parser bug's rows are replaced — and so re-extraction never accumulates duplicate statements. The
   * persisted categories on the old rows are intentionally NOT carried over (the rows changed precisely
   * because the parser changed them — the honest move is to recompute, which the breakdown's
   * deterministic pass / the next categorize run does). Unset (the default) = the additive behaviour.
   */
  replaceExisting?: boolean
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

/**
 * Resolve a content-reading tool's `readDocumentChunks`. The CORRECT source is the document's
 * ordered, non-overlapping, newline-preserving parser SEGMENTS (`readDocumentSegments`, injected by
 * the IPC via `extractDocumentPreview`). The stored `chunks` table is the WRONG source for these
 * tools: those are retrieval windows that collapse every newline into a space and overlap by ~80
 * tokens, so the line-oriented bank/invoice extractors see one giant "line" (near-zero rows) and the
 * redaction copy comes out de-formatted with duplicated overlap regions. When no segment reader is
 * injected (legacy/test callers that seed the `chunks` table directly), fall back to the chunk-table
 * reader. Either way the reach stays FROZEN to the single in-scope id (the §14 ceiling is unchanged —
 * the seam, not the tool, holds the FS/cipher capability via the injected closure).
 */
export async function resolveDocumentReader(
  db: Db,
  documentId: string,
  deps: {
    readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
    layout?: boolean
  }
): Promise<SkillToolContext['readDocumentChunks']> {
  if (!deps.readDocumentSegments) return buildReadDocumentChunks(db, new Set([documentId]))
  let segments: DocumentChunkRead[]
  try {
    // Layout reconstruction is requested only for the bank-statement skill (D58); other callers leave
    // `deps.layout` unset and receive byte-unchanged reading-order segments.
    segments = await deps.readDocumentSegments(documentId, { layout: deps.layout })
  } catch {
    // Re-extraction failed (the stored copy is gone, or encrypted with no cipher). Surface it
    // through the tool's OWN "could not be read" path: a reader that refuses the in-scope id, so
    // the tool returns its friendly content-free error and the seam records a terminal 'failed'.
    return (id: string): DocumentChunkRead[] => {
      if (id === documentId) throw new Error('document re-extraction failed')
      return []
    }
  }
  return (id: string): DocumentChunkRead[] => (id === documentId ? segments : [])
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
      readDocumentChunks: await resolveDocumentReader(db, args.documentId, deps),
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
      // Re-extraction (A9): replace the document's prior (stale) statements in the SAME transaction, so
      // a re-extract never accumulates duplicates and the swap is atomic (a failure rolls back to the old).
      if (deps.replaceExisting) deleteBankStatementsForDocument(db, args.documentId)
      db.prepare(
        `INSERT INTO bank_statements
           (id, document_id, run_id, period_start, period_end, currency, opening_balance, closing_balance,
            extractor_version, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
      ).run(
        statementId,
        args.documentId,
        runId,
        output.currency ?? null,
        output.openingBalance ?? null,
        output.closingBalance ?? null,
        BANK_EXTRACTOR_VERSION,
        completedAt
      )
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

/**
 * The newest statement id for a document, or null if none has been extracted. The single source of
 * truth for "the latest statement" across the three call sites — the run seam (here), the `categorize`
 * doctask (`doctasks/manager.ts`) and the analysis read-back (`analysis/bank-statement.ts`). The
 * `created_at DESC, id DESC` tie-break is LOAD-BEARING: it decides which statement gets categorized vs.
 * read back, so all three MUST resolve the SAME row — hence one shared helper, not three copies.
 */
export function latestBankStatementId(db: Db, documentId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(documentId) as { id: string } | undefined
  return row?.id ?? null
}

/**
 * Whether a statement was produced by an OUTDATED extractor (A9). True when its `extractor_version` is
 * NULL (extracted before versioning / by an older parser) or LESS than the current
 * `BANK_EXTRACTOR_VERSION` — i.e. a since-fixed parser bug may have mis-signed an amount or lost a payee
 * in these rows. The reuse paths (analysis read-back + categorize doctask) re-extract a stale statement
 * (with `replaceExisting`) instead of serving its rows. A statement at the current version is fresh.
 */
export function isBankStatementStale(db: Db, statementId: string): boolean {
  const row = db
    .prepare('SELECT extractor_version AS v FROM bank_statements WHERE id = ?')
    .get(statementId) as { v: number | null } | undefined
  if (!row) return false // unknown id — nothing to re-extract (callers handle the missing case)
  return row.v == null || row.v < BANK_EXTRACTOR_VERSION
}

/**
 * Delete every `bank_statements` row for a document plus its dependent rows (transactions, and any
 * corrections on them) in FK order — the "replace" half of a re-extraction (A9). Runs inside the
 * caller's transaction. `bank_corrections` carries no writes yet (schema-only), but is cleared
 * defensively so a future correction can never be orphaned onto a deleted transaction.
 */
function deleteBankStatementsForDocument(db: Db, documentId: string): void {
  db.prepare(
    `DELETE FROM bank_corrections WHERE transaction_id IN (
       SELECT t.id FROM bank_transactions t
       JOIN bank_statements s ON s.id = t.statement_id
       WHERE s.document_id = ?)`
  ).run(documentId)
  db.prepare(
    `DELETE FROM bank_transactions WHERE statement_id IN (
       SELECT id FROM bank_statements WHERE document_id = ?)`
  ).run(documentId)
  db.prepare('DELETE FROM bank_statements WHERE document_id = ?').run(documentId)
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

    const statementId = latestBankStatementId(db, args.documentId)
    if (!statementId) {
      // Honest, friendly: the downstream tools need an extraction first (no figure invented).
      const msg = 'Read the statement first, then run this tool.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { failed: { ok: false, runId, errorCode: 'needsExtraction', error: msg } }
    }

    const transactions = loadTransactions(db, statementId)
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
      prepared: { runId, statementId, transactions, output: result.output, completedAt: now() }
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

/**
 * Get (seeding once) the built-in `bank_categories` ids by name, plus seed the rules they use.
 * The seeded NAMES are the union of the deterministic-rule categories (`BUILTIN_CATEGORIES`) and the
 * richer LLM-categorizer taxonomy (`CATEGORIZER_CATEGORIES`, Phase 33), so a model-assigned category
 * (e.g. "Groceries") always maps to a seeded row. Only the deterministic categories carry RULES.
 * Exported so the `'categorize'` doctask (the LLM categorizer's lane) reuses the exact same seed.
 */
export function ensureBuiltinCategories(db: Db, now: string): Map<string, string> {
  const existing = db.prepare('SELECT id, name FROM bank_categories WHERE builtin = 1').all() as Array<{
    id: string
    name: string
  }>
  const byName = new Map(existing.map((c) => [c.name, c.id]))
  const insertCat = db.prepare(
    'INSERT INTO bank_categories (id, name, builtin, created_at) VALUES (?, ?, 1, ?)'
  )
  for (const name of [...new Set([...BUILTIN_CATEGORIES, ...CATEGORIZER_CATEGORIES])]) {
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
  // Guard the terminal write: `prepareStatementRun` leaves the row at 'started', so an unexpected
  // throw here (e.g. a transiently-locked DB) must still drive a terminal 'failed' status rather
  // than stranding the run at 'started' forever (B4 — the invariant the sibling seams hold via
  // persistFailure; this is the one downstream seam with no surrounding transaction).
  try {
    finishRun(db, runId, 'done', completedAt, statementId, null)
  } catch {
    return persistFailure(db, runId, now)
  }
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

// =====================================================================================
// S11d — document redaction: the read-transform-export Tier-2 shape (architecture.md "Skills —
// design record" §8).
//
// Unlike the bank/invoice domains there is NO content-class data table and NO BEGIN/COMMIT: the
// deliverable is a FILE, not rows, so the seam records only the `skill_runs` lifecycle row
// (started → terminal; result_ref stays NULL) and writes the redacted text MAIN-side to a
// user-chosen path. The tool reads the selected document's chunks (the only content reach) and
// produces the redacted text + per-category counts; this seam writes that text via the SAME
// `saveTextFile` boundary the CSV export uses, gated on the `export-file` confirm (the gate also
// enforces it). PRIVACY: the redacted text is written ONLY to the user-chosen file (the deliberate,
// user-initiated exception); the detected personal-data values never reach any log/audit/run row —
// only the COUNT + a 'redacted'/'clean' discriminator are surfaced. The cancelled-before-write guard
// (B2) reports a cancel and writes nothing; the 'started' row always reaches a terminal status (B4).
// =====================================================================================

const REDACT_TOOL_NAME = 'redact_document'

export interface RedactionDeps extends BankExtractionDeps {
  /**
   * Save the redacted text to a user-chosen path (MAIN-side: a save dialog + write). Returns true
   * once written, false if the user cancelled. The path + content are NEVER logged/audited — the
   * seam only learns whether the user saved (ids/counts boundary, §9.5/§22-M1).
   */
  saveTextFile: (defaultFileName: string, content: string) => Promise<boolean>
  /** True once the user accepted the write/export confirm modal (the gate also enforces it). */
  confirmed?: boolean
}

export interface RedactionResult {
  ok: boolean
  /** The `skill_runs.id` (always created, even on failure, so the lifecycle is recorded). */
  runId: string
  /** The number of personal-data items masked (a content-free count the renderer surfaces). */
  redactionCount?: number
  /** A content-free outcome discriminator: 'redacted' when something was masked, else 'clean'. */
  resultKind?: string
  /** True when the run ended because it was CANCELLED (vs a genuine failure) — the seam is authority (B2). */
  cancelled?: boolean
  /** A content-free failure reason CODE the renderer localizes (I1). */
  errorCode?: string
  /** A friendly, content-free reason on failure. */
  error?: string
}

/**
 * `redact_document` — read the selected document, mask the detectable personal data (pure tool,
 * confirm-gated `export-file`), and write the redacted copy MAIN-side to a user-chosen path. The
 * redacted content + the chosen path never touch any log/audit; only "N items hidden" (a count) and a
 * 'redacted'/'clean' discriminator are surfaced. A cancelled save persists nothing and reports it
 * calmly. No data table, no BEGIN/COMMIT — only the `skill_runs` lifecycle row is recorded.
 */
export async function runDocumentRedaction(
  db: Db,
  args: BankExtractionArgs,
  deps: RedactionDeps
): Promise<RedactionResult> {
  const now = deps.now ?? (() => new Date().toISOString())
  const runId = randomUUID()
  const documentIds = [args.documentId]

  // Record the run as started BEFORE the gate; it always reaches a terminal status (B4).
  db.prepare(
    `INSERT INTO skill_runs (id, skill_install_id, conversation_id, document_ids_json, status, created_at)
     VALUES (?, ?, ?, ?, 'started', ?)`
  ).run(runId, args.skillInstallId, args.conversationId ?? null, JSON.stringify(documentIds), now())

  try {
    const tool = getRegisteredTool(REDACT_TOOL_NAME)
    if (!tool) {
      const msg = 'This tool is not available.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'unavailable', error: msg }
    }

    const signal = deps.signal ?? new AbortController().signal
    const ctx: SkillToolContext = {
      documentIds,
      readDocumentChunks: await resolveDocumentReader(db, args.documentId, deps),
      signal,
      onProgress: deps.onProgress,
      audit: deps.audit
    }

    const result = await runSkillTool(tool, {
      skillId: args.skillInstallId,
      input: { documentId: args.documentId },
      ctx,
      confirmed: deps.confirmed
    })
    if (!result.ok) {
      const cancelled = signal.aborted
      finishRun(db, runId, cancelled ? 'cancelled' : 'failed', now(), null, result.error)
      return { ok: false, runId, cancelled, error: result.error }
    }

    const output = result.output as RedactDocumentOutput
    const resultKind = output.totalRedactions > 0 ? 'redacted' : 'clean'

    // Cancelled after the tool produced the text but before the write — don't open the save dialog,
    // and report it as cancelled (not failed), so nothing is written under a cancel (B2).
    if (signal.aborted) {
      finishRun(db, runId, 'cancelled', now(), null, null)
      return { ok: false, runId, cancelled: true, error: 'Redaction cancelled. Nothing was saved.' }
    }
    let saved: boolean
    try {
      saved = await deps.saveTextFile('redacted.txt', output.redactedText)
    } catch {
      console.error('[skills] redaction failed to write')
      const msg = 'The file could not be saved. Nothing was changed.'
      finishRun(db, runId, 'failed', now(), null, msg)
      return { ok: false, runId, errorCode: 'exportWriteFailed', error: msg }
    }
    if (!saved) {
      // The user cancelled the save dialog — a calm, non-error outcome (B1).
      finishRun(db, runId, 'cancelled', now(), null, null)
      return { ok: false, runId, cancelled: true, error: 'Redaction cancelled. Nothing was saved.' }
    }
    // result_ref stays NULL — redaction produces no DB artifact, and the path is never recorded.
    finishRun(db, runId, 'done', now(), null, null)
    return { ok: true, runId, redactionCount: output.totalRedactions, resultKind }
  } catch {
    console.error('[skills] redaction failed unexpectedly')
    const msg = 'This could not be saved. Nothing was changed.'
    finishRun(db, runId, 'failed', now(), null, msg)
    return { ok: false, runId, errorCode: 'persistFailed', error: msg }
  }
}
