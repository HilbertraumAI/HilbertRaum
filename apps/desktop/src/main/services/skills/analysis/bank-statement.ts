import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { buildScopeFilter } from '../../retrieval-scope'
import { documentChunkCount } from '../../analysis/coverage'
import { skillInstallId } from '../registry'
import {
  isBankStatementStale,
  latestBankStatementId,
  runBalanceValidation,
  runBankExtraction,
  runCashflowSummary,
  runCategorization,
  type BankExtractionArgs,
  type BankExtractionDeps
} from '../run'
import {
  BUILTIN_CATEGORIES,
  assessCompleteness,
  categorizeRow,
  reconcileBalances,
  summarizeCashflow,
  type CashflowSummary,
  type CompletenessStatus,
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

/** A statement row paired with its PERSISTED category name — the two are read in one query so their
 *  alignment is STRUCTURAL (each row carries its own category), never an index match across two arrays. */
interface RowWithCategory {
  row: TransactionInput
  /** The persisted category name (LLM doctask or rule pass), or null when the row is unassigned. */
  category: string | null
}

/**
 * Load a statement's rows AND their persisted categories in ONE LEFT-JOINed query (Phase 31–33
 * follow-up). The pure tools' input (`TransactionInput`, nulls omitted — reconcile relies on it) and
 * the per-row category travel together, so `categoryTotals` reads each row's own category instead of
 * indexing two separately-ordered arrays in lockstep. A null category falls back to the on-the-fly
 * `categorizeRow` at read time (no persistence required to answer).
 */
function loadStatementRowsWithCategories(db: Db, statementId: string): RowWithCategory[] {
  const rows = db
    .prepare(
      `SELECT t.date, t.value_date AS valueDate, t.description, t.amount, t.currency,
              t.balance_after AS balanceAfter, t.source_page AS sourcePage,
              c.name AS categoryName
       FROM bank_transactions t
       LEFT JOIN bank_categories c ON c.id = t.category_id
       WHERE t.statement_id = ? ORDER BY t.row_index`
    )
    .all(statementId) as Array<{
    date: string
    valueDate: string | null
    description: string
    amount: number
    currency: string
    balanceAfter: number | null
    sourcePage: number | null
    categoryName: string | null
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
    return { row: t, category: r.categoryName ?? null }
  })
}

// The categories the DETERMINISTIC rule pass can produce (`categorizeRow`). Used only as a BACK-COMPAT
// fallback for statements categorized before the authoritative `categorized_by_model` flag existed: a
// persisted category outside this set could only have come from the LLM categorizer's richer taxonomy.
const DETERMINISTIC_CATEGORY_SET: ReadonlySet<string> = new Set(BUILTIN_CATEGORIES)

/**
 * Whether the breakdown is MODEL-ASSISTED. Prefers the authoritative persisted flag the categorizer
 * doctask wrote (`bank_statements.categorized_by_model` — true whenever the LLM was consulted, even when
 * every label it emitted happens to be in the rule set, which the old name-based heuristic missed). For
 * a statement categorized before that flag existed (NULL), falls back to "any persisted category lies
 * outside the deterministic rule set". A statement seeded only by the read-time deterministic pass has a
 * NULL flag and only rule-set names → correctly NOT model-assisted.
 */
function loadCategorizedByModel(db: Db, statementId: string): boolean | null {
  const row = db
    .prepare('SELECT categorized_by_model AS flag FROM bank_statements WHERE id = ?')
    .get(statementId) as { flag: number | null } | undefined
  return row?.flag == null ? null : row.flag === 1
}

function isModelAssisted(flag: boolean | null, persisted: readonly (string | null)[]): boolean {
  if (flag != null) return flag
  return persisted.some((c) => c != null && !DETERMINISTIC_CATEGORY_SET.has(c))
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

/**
 * The localized DISPLAY label for a category (Phase 33). The PERSISTED identifier stays the canonical
 * English name (the enum / model-assisted detection key on it); this only localizes the breakdown
 * display. An unknown name (e.g. a future user-defined category) falls back to its raw identifier.
 */
function categoryLabel(tr: Tr, category: string): string {
  const key = `skills.bankCategory.${category}` as MessageKey
  const label = tr(key)
  // A missing key returns the key itself (the i18n contract) — fall back to the raw identifier then.
  return label === key ? category : label
}

interface CategoryTotal {
  category: string
  amount: number
  count: number
}

/**
 * Aggregate signed amounts per category, document order preserved. The category is each row's PERSISTED
 * one (written by the LLM categorizer doctask or the deterministic rule pass) when present, else computed
 * on the fly via `categorizeRow` — so a breakdown is answerable even before any categorize run. Each
 * `RowWithCategory` carries its own category (one JOINed read), so no cross-array index alignment.
 */
function categoryTotals(paired: readonly RowWithCategory[]): CategoryTotal[] {
  const order: string[] = []
  const byCat = new Map<string, CategoryTotal>()
  for (const { row, category: persisted } of paired) {
    const category = persisted ?? categorizeRow(row)
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

/** Bound the inline transaction listing so a many-row statement can't flood the answer (CSV exports all). */
const MAX_LISTED_TRANSACTIONS = 10

/**
 * Build the deterministic, localized answer (Markdown, 0 model calls) — the precedent is
 * `analysis/listing-answer.ts`. Unreconciled rows lead (SKILL.md "before presenting a total"); the
 * totals only print when every row shares one currency (mixed ⇒ an honest "no single total"). A bounded
 * transaction listing always trails so "show me the transactions" is answerable in every non-empty case.
 */
export function buildBankAnswer(
  tr: Tr,
  data: {
    rows: TransactionInput[]
    summary: CashflowSummary
    reconcile: ReconcileResult
    categories: CategoryTotal[] | null
    /**
     * The refined §3.5 / D56 completeness STATUS (three outcomes — see `assessCompleteness`):
     *  - `'complete'`     — printed opening + Σ == closing: present the VERIFIED statement total + the
     *                       proven-whole caveat.
     *  - `'unverified'`   — no opening/closing to tie against AND nothing contradicting: present the same
     *                       figures but with the UNVERIFIED caveat (a clearly-labelled sum of the rows
     *                       read, NOT a verified statement total) — honest, and the user's no-balance case.
     *  - `'contradicted'` — a printed balance the rows refute (mismatch, or opening+Σ != closing): keep
     *                       the honest refusal (never a mis-read/partial sum dressed up as the total).
     */
    status: CompletenessStatus
    /**
     * True when the per-category breakdown was produced with the LLM categorizer (Phase 33). It adds a
     * "model-assisted" note so a model-assigned category is never mistaken for a verified figure — a
     * category is not a figure (it never moves the total or the D56 gate). False for the deterministic
     * rule pass / on-the-fly `categorizeRow`. Only meaningful when `categories` is non-null.
     */
    modelAssisted?: boolean
  }
): string {
  const { rows, summary, reconcile, categories, status, modelAssisted } = data
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
    // so this case is safe regardless of the completeness status.
    lines.push(tr('skills.bankAnalysis.noCurrency'))
  } else if (status === 'contradicted') {
    // (B) The document's own balance claim is refuted by the rows: downgrade to honesty (D56) — never a
    // mis-read/partial sum dressed up as the total.
    lines.push(tr('skills.bankAnalysis.incompleteNoTotal'))
  } else {
    // (A) 'complete' (proven whole) OR 'unverified' (no balance to confirm, nothing contradicting):
    // present the single-currency totals + categories. The CAVEAT distinguishes the two — a verified
    // statement total vs an honestly-labelled sum of the rows read.
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
            category: categoryLabel(tr, c.category),
            amount: fmt(c.amount),
            currency: summary.currency,
            count: c.count
          })
        )
      }
      // A model-assigned category is NOT a verified figure — note it so the breakdown is read honestly
      // (the verified total + the D56 gate are untouched by a mislabel). Only when the LLM was involved.
      if (modelAssisted) lines.push(tr('skills.bankAnalysis.categoryAssisted'))
    }
    lines.push(
      '',
      status === 'complete'
        ? tr('skills.bankAnalysis.caveat')
        : tr('skills.bankAnalysis.unverifiedCaveat', { count: rows.length })
    )
  }

  // A bounded transaction listing so "show me the transactions" is answerable in EVERY non-empty case
  // (including the refusal + mixed-currency branches) — it is just what was read, always honest.
  lines.push('', tr('skills.bankAnalysis.transactionsHeading'))
  for (const row of rows.slice(0, MAX_LISTED_TRANSACTIONS)) {
    lines.push(
      tr('skills.bankAnalysis.transactionItem', {
        date: row.date,
        description: row.description,
        amount: fmt(row.amount),
        currency: row.currency
      })
    )
  }
  if (rows.length > MAX_LISTED_TRANSACTIONS) {
    lines.push(tr('skills.bankAnalysis.transactionsMore', { count: rows.length - MAX_LISTED_TRANSACTIONS }))
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

    // Auto-run the READ-ONLY tools through the run seam (D46). REUSE the latest extracted statement when
    // one exists and is FRESH (extraction is deterministic, so reusing avoids a duplicate AND preserves
    // any persisted categories from a prior `categorize` doctask). Re-extract only when NONE exists yet,
    // OR when the latest was produced by an outdated extractor (A9 — `isBankStatementStale`): a since-fixed
    // parser bug must not keep serving mis-signed / lost-payee rows. A re-extract REPLACES the stale
    // statement (`replaceExisting`) — the old per-row categories go with it (the rows changed; the
    // breakdown's deterministic pass / the next categorize run recomputes them honestly).
    let statementId = latestBankStatementId(db, target.id)
    if (!statementId || isBankStatementStale(db, statementId)) {
      const extraction = await runBankExtraction(db, args, { ...deps, replaceExisting: true })
      if (!extraction.ok || !extraction.statementId) {
        return { answer: ctx.tr('skills.bankAnalysis.couldNotRead'), citations: [], coverage: computeCoverage(db, target.id) }
      }
      statementId = extraction.statementId
    }
    await runCashflowSummary(db, args, deps)
    await runBalanceValidation(db, args, deps)

    // Figures come from the PERSISTED rows via the PURE tool functions (the seams surface only counts).
    // Rows + persisted categories arrive together (one JOINed read) so the breakdown alignment is structural.
    let paired = loadStatementRowsWithCategories(db, statementId)
    const rows = paired.map((p) => p.row)
    const summary = summarizeCashflow(rows)
    const reconcile = reconcileBalances(rows)

    // Per-category breakdown (only for a category-shaped question). It reads the PERSISTED categories
    // (the LLM categorizer doctask, or a prior rule pass) — `categorize` is the ONLY model call and it
    // happens in the doctask lane, NEVER here (this handler stays 0-model-calls). When nothing has been
    // categorized yet, run the DETERMINISTIC rule pass once (0 model calls) so a breakdown still shows;
    // model-assigned categories (if present) are never overwritten by it. `modelAssisted` (a persisted
    // category outside the deterministic set) drives the honest "model-assisted" note.
    const categoryShaped = isCategoryShaped(ctx.question)
    let categories: CategoryTotal[] | null = null
    let modelAssisted = false
    if (categoryShaped) {
      if (!paired.some((p) => p.category != null)) {
        await runCategorization(db, args, deps) // deterministic seed when nothing is categorized yet
        paired = loadStatementRowsWithCategories(db, statementId)
      }
      categories = categoryTotals(paired)
      modelAssisted = isModelAssisted(
        loadCategorizedByModel(db, statementId),
        paired.map((p) => p.category)
      )
    }

    // Completeness assessment (§3.5, D56): the only true proof a total is WHOLE is the statement's
    // printed opening + Σamounts == closing. Load the persisted balances and classify into one of three
    // outcomes — `complete` (proven), `contradicted` (a printed balance the rows refute → refuse), or
    // `unverified` (no balance to tie against, nothing contradicting → present a clearly-labelled sum of
    // the rows read, the no-balance "Umsätze" case). `buildBankAnswer` renders each honestly.
    const balances = loadStatementBalances(db, statementId)
    const status = assessCompleteness({
      rows,
      openingBalance: balances.openingBalance,
      closingBalance: balances.closingBalance,
      reconcile
    })

    const answer = buildBankAnswer(ctx.tr, { rows, summary, reconcile, categories, status, modelAssisted })
    const citations = buildBankCitations(db, target.id, target.title, rows)
    const coverage = computeCoverage(db, target.id)
    return { answer, citations, coverage }
  }
}
