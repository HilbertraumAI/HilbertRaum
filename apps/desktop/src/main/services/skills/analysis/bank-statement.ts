import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { buildScopeFilter } from '../../retrieval-scope'
import { documentChunkCount } from '../../analysis/coverage'
import { skillInstallId } from '../registry'
import {
  runBalanceValidation,
  runBankExtraction,
  runCashflowSummary,
  runCategorization,
  type BankExtractionArgs,
  type BankExtractionDeps
} from '../run'
import {
  categorizeRow,
  isStatementComplete,
  reconcileBalances,
  summarizeCashflow,
  type CashflowSummary,
  type ReconcileResult,
  type TransactionInput
} from '../tools/bank-statement'
import type { SkillAnalysisContext, SkillAnalysisHandler, SkillAnalysisInput, SkillAnalysisResult } from './types'

// The bank-statement analysis handler (full-doc-skills plan §3.1/§3.4, Phase 2). On an analysis-shaped
// bank question over a single in-scope statement it AUTO-RUNS the read-only tools through the existing
// run seam (`extract_transactions` → `summarize_cashflow` + `validate_statement_balances`, plus
// `categorize_transactions` only when the question is category-shaped) for their persistence +
// `skill_runs` lifecycle + ids/counts audit, then synthesises a deterministic, localized answer whose
// FIGURES are computed from the persisted rows via the PURE exported tool functions (the run seams
// surface only counts, never the content figures — so we read them ourselves). It NEVER runs
// `export_transactions_csv` (excluded by construction — export stays confirm-gated). The answer
// honours `app-skills/bank-statement/SKILL.md`: lead with the count, surface unreconciled rows BEFORE
// the total, quote the printed figures, report mixed currency as "no single total", invent nothing.

/** The bundled bank-statement skill's install id (`"app:bank-statement"`) — the registry key. */
export const BANK_STATEMENT_INSTALL_ID = skillInstallId('app', 'bank-statement')

// Analysis-shaped intent: accounting/transaction words (EN + DE for the de-AT target). Conservative
// by design — a tool skill answering an off-topic question keeps the relevance path (plan §3.2).
const ANALYSIS_KEYWORDS: readonly string[] = [
  'transaction', 'transactions', 'balance', 'balances', 'reconcile', 'reconciliation',
  'cashflow', 'cash flow', 'total', 'totals', 'sum', 'summary', 'summarize', 'summarise',
  'spend', 'spending', 'spent', 'income', 'expense', 'expenses', 'net', 'statement',
  'deposit', 'withdrawal', 'how much', 'how many', 'overview',
  'kontoauszug', 'buchung', 'buchungen', 'saldo', 'umsatz', 'umsätze', 'ausgabe', 'ausgaben',
  'einnahme', 'einnahmen', 'betrag', 'beträge', 'summe', 'überweisung', 'abgleich',
  'zusammenfassung', 'kategorie', 'kategorien'
]

// A category-shaped question additionally wants a per-category breakdown (drives `categorize_*`).
const CATEGORY_KEYWORDS: readonly string[] = [
  'categor', 'breakdown', 'by category', 'spending on', 'spend on',
  'kategor', 'nach kategorie', 'aufschlüssel'
]

function isAnalysisShaped(question: string): boolean {
  const q = question.toLowerCase()
  return ANALYSIS_KEYWORDS.some((k) => q.includes(k))
}

function isCategoryShaped(question: string): boolean {
  const q = question.toLowerCase()
  return CATEGORY_KEYWORDS.some((k) => q.includes(k))
}

/** The indexed, answerable documents within a scope (mirrors registerRagIpc.documentsInScope). */
function inScopeDocuments(db: Db, scope: RetrievalScope): Array<{ id: string; title: string }> {
  const filter = buildScopeFilter(scope, 'd.id')
  const where = filter ? ` AND ${filter.sql}` : ''
  const params = filter ? filter.params : []
  return db
    .prepare(
      `SELECT d.id AS id, d.title AS title FROM documents d
       WHERE d.status = 'indexed'
         AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)${where}`
    )
    .all(...params) as Array<{ id: string; title: string }>
}

/** The single in-scope document, or null when the scope is not exactly one document (R2). */
function singleInScopeDocument(db: Db, scope: RetrievalScope): { id: string; title: string } | null {
  const docs = inScopeDocuments(db, scope)
  return docs.length === 1 ? docs[0] : null
}

/** Load a statement's rows as the pure tools' input (nulls omitted, not passed — reconcile relies on it). */
function loadStatementRows(db: Db, statementId: string): TransactionInput[] {
  const rows = db
    .prepare(
      `SELECT date, value_date AS valueDate, description, amount, currency,
              balance_after AS balanceAfter, source_page AS sourcePage
       FROM bank_transactions WHERE statement_id = ? ORDER BY row_index`
    )
    .all(statementId) as Array<{
    date: string
    valueDate: string | null
    description: string
    amount: number
    currency: string
    balanceAfter: number | null
    sourcePage: number | null
  }>
  return rows.map((r) => {
    const t: TransactionInput = {
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

/** The persisted statement-level opening/closing balances for the completeness gate (§3.5, D56). */
function loadStatementBalances(db: Db, statementId: string): { openingBalance?: number; closingBalance?: number } {
  const row = db
    .prepare('SELECT opening_balance AS opening, closing_balance AS closing FROM bank_statements WHERE id = ?')
    .get(statementId) as { opening: number | null; closing: number | null } | undefined
  const out: { openingBalance?: number; closingBalance?: number } = {}
  if (row?.opening != null) out.openingBalance = row.opening
  if (row?.closing != null) out.closingBalance = row.closing
  return out
}

const MAX_CITATIONS = 12

interface ChunkRow {
  chunk_index: number
  text: string
  source_label: string | null
  page_number: number | null
  section_label: string | null
}

/**
 * Real source chunks behind the figures (M2-safe) — never the synthesised total. We cite the
 * document's actual `chunks` rows, narrowed to the pages the extracted transactions came from (their
 * `sourcePage`) when known, so the citations point at where the figures were read; `[Sn]` labelling
 * matches the rest of the app. Falls back to the document's leading chunks when no row carries a page.
 */
function buildBankCitations(
  db: Db,
  documentId: string,
  title: string,
  rows: TransactionInput[]
): Citation[] {
  const pages = new Set<number>()
  for (const r of rows) if (r.sourcePage != null) pages.add(r.sourcePage)
  const all = db
    .prepare(
      `SELECT chunk_index, text, source_label, page_number, section_label
       FROM chunks WHERE document_id = ? ORDER BY chunk_index`
    )
    .all(documentId) as unknown as ChunkRow[]
  const picked = (pages.size > 0 ? all.filter((c) => c.page_number != null && pages.has(c.page_number)) : all).slice(
    0,
    MAX_CITATIONS
  )
  return picked.map((c, i) => ({
    label: `S${i + 1}`,
    sourceTitle: c.source_label ?? title,
    pageNumber: c.page_number,
    section: c.section_label,
    snippet: c.text.length > 280 ? `${c.text.slice(0, 280)}…` : c.text
  }))
}

/** Honest extract coverage (D48): every chunk scanned; `fullyChunked` gates the "whole document" wording. */
function computeCoverage(db: Db, documentId: string): CoverageInfo {
  const chunksTotal = documentChunkCount(db, documentId)
  const row = db
    .prepare('SELECT fully_chunked FROM documents WHERE id = ?')
    .get(documentId) as { fully_chunked: string | null } | undefined
  return {
    mode: 'extract',
    chunksCovered: chunksTotal, // the tool read every chunk
    chunksTotal,
    fullyChunked: row?.fully_chunked != null // NULL (legacy/truncated) → false
  }
}

type Tr = (key: MessageKey, params?: MessageParams) => string

/** Format a parsed figure as a stable 2-dp decimal — the verbatim numeric (matches the CSV export). */
function fmt(n: number): string {
  return n.toFixed(2)
}

interface CategoryTotal {
  category: string
  amount: number
  count: number
}

/** Aggregate signed amounts per deterministic category (pure `categorizeRow`), document order preserved. */
function categoryTotals(rows: TransactionInput[]): CategoryTotal[] {
  const order: string[] = []
  const byCat = new Map<string, CategoryTotal>()
  for (const row of rows) {
    const category = categorizeRow(row)
    let entry = byCat.get(category)
    if (!entry) {
      entry = { category, amount: 0, count: 0 }
      byCat.set(category, entry)
      order.push(category)
    }
    entry.amount += row.amount
    entry.count += 1
  }
  return order.map((c) => {
    const e = byCat.get(c)!
    return { category: c, amount: Math.round(e.amount * 100) / 100, count: e.count }
  })
}

/**
 * Build the deterministic, localized answer (Markdown, 0 model calls) — the precedent is
 * `analysis/listing-answer.ts`. Unreconciled rows lead (SKILL.md "before presenting a total"); the
 * totals only print when every row shares one currency (mixed ⇒ an honest "no single total").
 */
export function buildBankAnswer(
  tr: Tr,
  data: {
    rows: TransactionInput[]
    summary: CashflowSummary
    reconcile: ReconcileResult
    categories: CategoryTotal[] | null
    /**
     * The §3.5 / D56 completeness PROOF — `opening + Σamounts == closing`. A single-currency total is
     * presented ONLY when this is true; otherwise the answer downgrades to an honest "couldn't confirm
     * the whole statement" message and presents NO total/category/net (never a partial sum as the total).
     */
    complete: boolean
  }
): string {
  const { rows, summary, reconcile, categories, complete } = data
  if (rows.length === 0) return tr('skills.bankAnalysis.empty')

  const lines: string[] = [tr('skills.bankAnalysis.count', { count: rows.length })]

  // Surface unreconciled rows BEFORE the total (printed balance disagrees with the amounts).
  const mismatches = reconcile.rows.filter((r) => r.status === 'mismatch')
  if (mismatches.length > 0) {
    lines.push('', tr('skills.bankAnalysis.unreconciledHeading'))
    for (const m of mismatches) {
      const row = rows[m.index]
      if (!row) continue
      lines.push(
        tr('skills.bankAnalysis.unreconciledItem', {
          date: row.date,
          description: row.description,
          amount: fmt(row.amount),
          currency: row.currency
        })
      )
    }
  }

  lines.push('')
  if (!summary.currency) {
    // Mixed currency: no single total is presented at all (honest, and NOT a partial-total risk),
    // so this case is safe regardless of the completeness gate.
    lines.push(tr('skills.bankAnalysis.noCurrency'))
  } else if (complete) {
    // Provably complete (opening + Σ == closing): present the single-currency totals.
    lines.push(
      tr('skills.bankAnalysis.totals', {
        inAmount: fmt(summary.totalIn),
        outAmount: fmt(summary.totalOut),
        netAmount: fmt(summary.net),
        currency: summary.currency
      })
    )
    if (categories && categories.length > 0) {
      lines.push('', tr('skills.bankAnalysis.categoryHeading'))
      for (const c of categories) {
        lines.push(
          tr('skills.bankAnalysis.categoryItem', {
            category: c.category,
            amount: fmt(c.amount),
            currency: summary.currency,
            count: c.count
          })
        )
      }
    }
    lines.push('', tr('skills.bankAnalysis.caveat'))
  } else {
    // Completeness UNPROVEN (D56): downgrade to honesty — never a partial sum dressed up as the total.
    lines.push(tr('skills.bankAnalysis.incompleteNoTotal'))
  }

  return lines.join('\n')
}

export const bankStatementAnalysisHandler: SkillAnalysisHandler = {
  applies(input: SkillAnalysisInput): boolean {
    // Cheap pre-flight (R2): a well-defined single in-scope doc + an analysis-shaped bank question.
    // The refuse / not-fully-chunked routing decision is Phase 3 — Phase 2 only emits honest coverage.
    if (!isAnalysisShaped(input.question)) return false
    return singleInScopeDocument(input.db, input.scope) !== null
  },

  async run(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult> {
    const { db } = ctx
    const target = singleInScopeDocument(db, ctx.scope)
    if (!target) {
      // Defensive: `run` is only reached after `applies()` (which requires one doc); honest fallback.
      return { answer: ctx.tr('skills.bankAnalysis.couldNotRead'), citations: [], coverage: computeCoverage(db, '') }
    }

    const args: BankExtractionArgs = {
      skillInstallId: ctx.skillInstallId,
      conversationId: ctx.conversationId ?? null,
      documentId: target.id
    }
    const deps: BankExtractionDeps = {
      audit: ctx.audit,
      signal: ctx.signal,
      now: ctx.now,
      readDocumentSegments: ctx.readDocumentSegments,
      // Geometry-aware layout reconstruction for the columnar statement (plan §3.1, D58 — bank only).
      layout: true
    }

    // Auto-run the READ-ONLY tools through the run seam (D46) — extract first, then the downstream
    // read-only seams for their lifecycle + persistence. Export is excluded by construction.
    const extraction = await runBankExtraction(db, args, deps)
    if (!extraction.ok || !extraction.statementId) {
      return { answer: ctx.tr('skills.bankAnalysis.couldNotRead'), citations: [], coverage: computeCoverage(db, target.id) }
    }
    await runCashflowSummary(db, args, deps)
    await runBalanceValidation(db, args, deps)
    const categoryShaped = isCategoryShaped(ctx.question)
    if (categoryShaped) await runCategorization(db, args, deps)

    // Figures come from the PERSISTED rows via the PURE tool functions (the seams surface only counts).
    const rows = loadStatementRows(db, extraction.statementId)
    const summary = summarizeCashflow(rows)
    const reconcile = reconcileBalances(rows)
    const categories = categoryShaped ? categoryTotals(rows) : null

    // Completeness gate (§3.5, D56): the only true proof a total is whole is the statement's printed
    // opening + Σamounts == closing. Load the persisted balances and prove it; an unproven statement
    // downgrades to honesty in `buildBankAnswer` (no total presented), never a confident partial sum.
    const balances = loadStatementBalances(db, extraction.statementId)
    const complete = isStatementComplete({
      rows,
      openingBalance: balances.openingBalance,
      closingBalance: balances.closingBalance,
      reconcile
    })

    const answer = buildBankAnswer(ctx.tr, { rows, summary, reconcile, categories, complete })
    const citations = buildBankCitations(db, target.id, target.title, rows)
    const coverage = computeCoverage(db, target.id)
    return { answer, citations, coverage }
  }
}
