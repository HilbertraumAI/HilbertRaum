import type {
  DocumentChunkRead,
  JsonSchema,
  SkillTool,
  ToolResult
} from '../../../../shared/types'
import { MONEY_EPS, MONEY_RE, csvField, detectCurrency, parseAmount, parseDate } from './money'

// The deterministic money/date/CSV parsing primitives are shared with the invoice tools (one parser
// per locale rule, §8). Re-exported here so existing import sites (`tools/bank-statement`) and the
// unit tests keep resolving `parseAmount`/`parseDate`/`detectCurrency` from this module.
export { detectCurrency, parseAmount, parseDate } from './money'

// Bank-statement Tier-2 tools (architecture.md "Skills — design record" §8, Phase S11a). Kept OUT of the generic
// `tool-registry.ts` so bank specifics never leak into the skills infrastructure (skills-plan §13);
// the registry merely imports the finished `SkillTool` and lists it. S11a ships ONLY
// `extract_transactions`; validate/categorize/summarize/export arrive at S11c.
//
// Pure main-side TS: no node:fs, no network, no native deps (CLAUDE.md §0). The tool's WHOLE reach
// is `ctx.readDocumentChunks` over the frozen selected-document scope (it cannot widen scope or
// touch a DB/FS/net handle — §14); it persists nothing (the gate stays content-free — the
// `run.ts` orchestration seam writes the rows). The extractor is DETERMINISTIC and OFFLINE: it
// quotes only what it can confidently parse and DROPS ambiguous rows rather than invent figures
// (the §22-D1 honesty posture; parse quality is a known limitation that improves later).

// ---- The output contract (the `JsonSchema` subset, mirroring the committed transaction.schema.json) ----

/** One extracted transaction row — the shape of `app-skills/bank-statement/schemas/transaction.schema.json`. */
const TRANSACTION_ROW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'description', 'amount', 'currency'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    valueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string', minLength: 1 },
    amount: { type: 'number' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    balanceAfter: { type: 'number' },
    sourcePage: { type: 'integer', minimum: 1 }
  }
}

/** A hard cap so a pathological document can never produce an unbounded array (the gate also validates). */
export const MAX_TRANSACTIONS = 10000

const EXTRACT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    transactions: { type: 'array', items: TRANSACTION_ROW_SCHEMA, maxItems: MAX_TRANSACTIONS },
    // The detected statement currency, if any — a convenience for the orchestration seam (optional).
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }
  }
}

export interface ExtractedTransaction {
  date: string
  valueDate?: string
  description: string
  amount: number
  currency: string
  balanceAfter?: number
  sourcePage?: number
}

export interface ExtractTransactionsOutput {
  transactions: ExtractedTransaction[]
  currency?: string
}

// ---- Deterministic parsing helpers (the money/date primitives are shared via `./money`) ----

function parseLine(line: string, page: number | null, statementCurrency: string | null): ExtractedTransaction | null {
  const m = /^(\S+)\s+(.*)$/.exec(line)
  if (!m) return null
  const date = parseDate(m[1])
  if (!date) return null
  const rest = m[2]
  const matches = [...rest.matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  const first = matches[0]
  const description = rest.slice(0, first.index).trim()
  if (!description) return null
  const amount = parseAmount(first[0])
  if (amount === null) return null
  const currency = detectCurrency(line) ?? statementCurrency
  if (!currency) return null
  const row: ExtractedTransaction = { date, description, amount, currency }
  if (matches.length >= 2) {
    const bal = parseAmount(matches[matches.length - 1][0])
    if (bal !== null) row.balanceAfter = bal
  }
  if (page != null) row.sourcePage = page
  return row
}

/** Pure extractor over already-read chunks — emits only fully-valid rows (ambiguous lines dropped). */
export function extractTransactionRows(
  chunks: DocumentChunkRead[],
  statementCurrency: string | null
): ExtractedTransaction[] {
  const rows: ExtractedTransaction[] = []
  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const row = parseLine(line, chunk.page, statementCurrency)
      if (row) {
        rows.push(row)
        if (rows.length >= MAX_TRANSACTIONS) return rows
      }
    }
  }
  return rows
}

// ---- The tool ----

/**
 * `extract_transactions` (S11a) — read-only over the selected document scope. Reads the document's
 * page-addressable chunks via the narrow `ctx.readDocumentChunks`, parses transaction rows
 * deterministically and offline, and returns the schema-validated rows. It persists nothing (the
 * `run.ts` seam writes the rows); a wrong-shape result fails the run at the gate.
 */
export const extractTransactionsTool: SkillTool = {
  name: 'extract_transactions',
  description:
    'Read the selected bank statement and return its transaction rows (date, description, signed amount, currency) exactly as printed. Read-only; sees only the selected document.',
  permissions: ['read-selected-docs'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId'],
    properties: { documentId: { type: 'string', minLength: 1 } }
  },
  outputSchema: EXTRACT_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { documentId } = input as { documentId: string }
    let chunks: DocumentChunkRead[]
    try {
      chunks = ctx.readDocumentChunks(documentId)
    } catch {
      // Out-of-scope / unreadable — friendly + content-free; the technical reason is the seam's log.
      return { ok: false, error: 'This statement could not be read.' }
    }
    const statementCurrency = detectCurrency(chunks.map((c) => c.text).join('\n'))
    const transactions = extractTransactionRows(chunks, statementCurrency)
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    const output: ExtractTransactionsOutput = { transactions }
    if (statementCurrency) output.currency = statementCurrency
    return { ok: true, output }
  }
}

// =====================================================================================
// S11c — the downstream bank tools (validate / categorize / summarize / export).
//
// DESIGN (recorded in architecture.md "Skills — design record" §8 + the BUILD_STATE handoff): these tools
// operate on the ALREADY-EXTRACTED transactions, not on document chunks. The orchestration seam
// (`run.ts`) loads the latest statement's rows and passes them as STRUCTURED INPUT — so the tools
// stay PURE (no new `SkillToolContext` accessor; the §14 ceiling is unchanged) and remain trivially
// unit-testable. Each tool is deterministic + offline and honours the §22-D1 honesty posture: it
// never invents a figure and flags what it cannot confirm. PERSISTENCE stays in the seam (the gate
// + tools are content-free of side effects); `export_transactions_csv` only *produces* the CSV — the
// seam does the user-gated, main-side file write.
// =====================================================================================

/** A transaction row as the seam hands it in (the persisted shape; nulls are omitted, not passed). */
export interface TransactionInput {
  date: string
  valueDate?: string
  description: string
  amount: number
  currency: string
  balanceAfter?: number
  sourcePage?: number
}

/** The shared input contract for the downstream tools — the seam passes the loaded rows verbatim. */
const TRANSACTIONS_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    transactions: { type: 'array', items: TRANSACTION_ROW_SCHEMA, maxItems: MAX_TRANSACTIONS }
  }
}

// ---- validate_statement_balances (read-only; reconciles printed vs computed running balance) ----

export type ReconcileStatus = 'ok' | 'mismatch' | 'unknown'

export interface ReconcileRow {
  index: number
  status: ReconcileStatus
}

export interface ReconcileResult {
  /** Overall verdict: at least one row could be checked AND nothing contradicted (honesty). */
  reconciled: boolean
  rows: ReconcileRow[]
}

/**
 * Reconcile each row's printed running balance against the computed one (pure, deterministic).
 * For a row i with a printed `balanceAfter`, the expected balance is `balanceAfter[i-1] + amount[i]`,
 * so a row is `ok` only when its printed balance agrees with the computed one within half a cent, and
 * `mismatch` when they disagree. A row is `unknown` when it (or its predecessor) prints no balance —
 * including the **baseline** row (the first row, or any row whose predecessor printed no balance):
 * with nothing to compare against, the baseline has NOT been genuinely checked, so it is `unknown`,
 * never counted as `ok`. Counting the baseline as a pass would let a single-transaction statement
 * report `reconciled: true` having verified nothing — at odds with the §22-D1 "say so plainly /
 * don't paper over" honesty posture. `reconciled` is therefore true only when no row mismatched AND
 * at least one row was actually compared against a predecessor (`okCount > 0`).
 */
export function reconcileBalances(rows: TransactionInput[]): ReconcileResult {
  const out: ReconcileRow[] = []
  let prevBalance: number | null = null
  let okCount = 0
  let mismatchCount = 0
  rows.forEach((row, i) => {
    const printed = row.balanceAfter
    let status: ReconcileStatus
    if (printed === undefined) {
      status = 'unknown'
    } else if (prevBalance === null) {
      // Baseline row: a printed balance with no predecessor balance to compare against. NOT a
      // genuine check — flagged `unknown` so a lone baseline can never report `reconciled: true`.
      status = 'unknown'
    } else {
      const expected = prevBalance + row.amount
      if (Math.abs(printed - expected) < MONEY_EPS) {
        status = 'ok'
        okCount++
      } else {
        status = 'mismatch'
        mismatchCount++
      }
    }
    if (printed !== undefined) prevBalance = printed
    out.push({ index: i, status })
  })
  return { reconciled: mismatchCount === 0 && okCount > 0, rows: out }
}

const RECONCILE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reconciled', 'rows'],
  properties: {
    reconciled: { type: 'boolean' },
    rows: {
      type: 'array',
      maxItems: MAX_TRANSACTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'status'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          status: { type: 'string', enum: ['ok', 'mismatch', 'unknown'] }
        }
      }
    }
  }
}

export const validateStatementBalancesTool: SkillTool = {
  name: 'validate_statement_balances',
  description:
    'Check each transaction’s printed running balance against the computed one and report which rows reconcile. Read-only; never changes a figure.',
  permissions: ['read-selected-docs'],
  inputSchema: TRANSACTIONS_INPUT_SCHEMA,
  outputSchema: RECONCILE_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { transactions } = input as { transactions: TransactionInput[] }
    return { ok: true, output: reconcileBalances(transactions) }
  }
}

// ---- categorize_transactions (deterministic, rule-based) ----

/** A built-in category and the deterministic rules that assign it (seeded into the data tables). */
export interface CategoryRule {
  category: string
  matchKind: 'description-substring' | 'amount-sign'
  pattern: string
}

export const UNCATEGORIZED = 'Uncategorized'

/**
 * The built-in, deterministic categorization rules (offline, no ML). Applied in order — the first
 * match wins; a row that matches nothing falls back by sign (negative → Spending, else
 * Uncategorized). Substring matches are case-insensitive; EN + DE keywords for the de-AT target.
 */
export const BUILTIN_CATEGORY_RULES: readonly CategoryRule[] = [
  { category: 'Fees', matchKind: 'description-substring', pattern: 'fee' },
  { category: 'Fees', matchKind: 'description-substring', pattern: 'gebühr' },
  { category: 'Fees', matchKind: 'description-substring', pattern: 'charge' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'salary' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'gehalt' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'lohn' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'payroll' },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'transfer' },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'überweisung' },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'sepa' },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'atm' },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'bargeld' },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'withdrawal' },
  { category: 'Income', matchKind: 'amount-sign', pattern: 'positive' }
]

/** Every built-in category name (seed set for `bank_categories`), insertion order, deduped. */
export const BUILTIN_CATEGORIES: readonly string[] = [
  ...new Set([...BUILTIN_CATEGORY_RULES.map((r) => r.category), 'Spending', UNCATEGORIZED])
]

/** Assign one row a category name deterministically (pure). First matching rule wins; sign fallback. */
export function categorizeRow(row: TransactionInput): string {
  const desc = row.description.toLowerCase()
  for (const rule of BUILTIN_CATEGORY_RULES) {
    if (rule.matchKind === 'description-substring') {
      if (desc.includes(rule.pattern)) return rule.category
    } else if (rule.pattern === 'positive' && row.amount > 0) {
      return rule.category
    } else if (rule.pattern === 'negative' && row.amount < 0) {
      return rule.category
    }
  }
  return row.amount < 0 ? 'Spending' : UNCATEGORIZED
}

export interface CategorizationRow {
  index: number
  category: string
}

/** Categorize every row (pure). */
export function categorizeRows(rows: TransactionInput[]): CategorizationRow[] {
  return rows.map((row, index) => ({ index, category: categorizeRow(row) }))
}

const CATEGORIZE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['categories'],
  properties: {
    categories: {
      type: 'array',
      maxItems: MAX_TRANSACTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'category'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          category: { type: 'string', minLength: 1 }
        }
      }
    }
  }
}

export const categorizeTransactionsTool: SkillTool = {
  name: 'categorize_transactions',
  description:
    'Assign each transaction a category using built-in deterministic rules (no guessing beyond the rules). Reads the selected statement’s rows only.',
  permissions: ['read-selected-docs'],
  inputSchema: TRANSACTIONS_INPUT_SCHEMA,
  outputSchema: CATEGORIZE_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { transactions } = input as { transactions: TransactionInput[] }
    return { ok: true, output: { categories: categorizeRows(transactions) } }
  }
}

// ---- summarize_cashflow (read-only; computed totals) ----

export interface CashflowSummary {
  totalIn: number
  totalOut: number
  net: number
  count: number
  currency?: string
}

/**
 * Sum inflows / outflows / net over the rows (pure, deterministic). `totalOut` is the absolute sum
 * of negative amounts; `net` is the signed sum. The currency is reported only when EVERY row shares
 * one (mixed-currency statements report none rather than implying a meaningless total — honesty).
 */
export function summarizeCashflow(rows: TransactionInput[]): CashflowSummary {
  let totalIn = 0
  let totalOut = 0
  const currencies = new Set<string>()
  for (const row of rows) {
    if (row.amount >= 0) totalIn += row.amount
    else totalOut += -row.amount
    currencies.add(row.currency)
  }
  const round = (n: number): number => Math.round(n * 100) / 100
  // Round each total ONCE, then derive net from the rounded figures, so the three reported numbers
  // are always self-consistent (net === totalIn − totalOut) rather than each independently rounded.
  const inRounded = round(totalIn)
  const outRounded = round(totalOut)
  const summary: CashflowSummary = {
    totalIn: inRounded,
    totalOut: outRounded,
    net: round(inRounded - outRounded),
    count: rows.length
  }
  if (currencies.size === 1) summary.currency = [...currencies][0]
  return summary
}

const CASHFLOW_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['totalIn', 'totalOut', 'net', 'count'],
  properties: {
    totalIn: { type: 'number' },
    totalOut: { type: 'number' },
    net: { type: 'number' },
    count: { type: 'integer', minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }
  }
}

export const summarizeCashflowTool: SkillTool = {
  name: 'summarize_cashflow',
  description:
    'Total the inflows, outflows, and net change across the selected statement’s transactions. Read-only; computed from the extracted rows.',
  permissions: ['read-selected-docs'],
  inputSchema: TRANSACTIONS_INPUT_SCHEMA,
  outputSchema: CASHFLOW_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { transactions } = input as { transactions: TransactionInput[] }
    return { ok: true, output: summarizeCashflow(transactions) }
  }
}

// ---- export_transactions_csv (export-file; confirm-gated; the seam does the FS write) ----

// `csvField` (the formula-injection neutralization) lives in `./money` — the export boundary is the
// same for the bank and invoice CSVs, so the neutralization is one shared, audited function (S12 F4).

/** Serialize the rows to CSV text (pure — no FS). Header + one line per row, stable column order. */
export function transactionsToCsv(rows: TransactionInput[]): string {
  const header = ['date', 'valueDate', 'description', 'amount', 'currency', 'balanceAfter', 'sourcePage']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        csvField(row.date),
        csvField(row.valueDate ?? ''),
        csvField(row.description),
        // Fixed 2-dp decimal with a dot — a stable, locale-free CSV number (not a re-printed figure).
        row.amount.toFixed(2),
        csvField(row.currency),
        row.balanceAfter === undefined ? '' : row.balanceAfter.toFixed(2),
        row.sourcePage === undefined ? '' : String(row.sourcePage)
      ].join(',')
    )
  }
  // Trailing newline so the file ends cleanly; \r\n for spreadsheet friendliness.
  return lines.join('\r\n') + '\r\n'
}

const CSV_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['csv', 'rowCount'],
  properties: {
    csv: { type: 'string' },
    rowCount: { type: 'integer', minimum: 0 }
  }
}

export const exportTransactionsCsvTool: SkillTool = {
  name: 'export_transactions_csv',
  description:
    'Produce a CSV of the selected statement’s transactions for you to save. Requires your confirmation; you choose where the file is written.',
  permissions: ['export-file'],
  inputSchema: TRANSACTIONS_INPUT_SCHEMA,
  outputSchema: CSV_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { transactions } = input as { transactions: TransactionInput[] }
    return { ok: true, output: { csv: transactionsToCsv(transactions), rowCount: transactions.length } }
  }
}
