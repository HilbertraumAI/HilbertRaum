import type { Db } from '../../db'
import type { Citation, CoverageInfo, RetrievalScope } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { documentsInScope } from '../scope-documents'
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
  type BankExtractionDeps,
  type LoadedTransaction
} from '../run'
import { withDocumentLock } from '../doc-lock'
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
// STEMS, not whole words (matched by substring), so German inflections/compounds are covered: e.g.
// `transaktion` catches "Transaktion"/"Transaktionen"; `zusammenfass` catches "Zusammenfassung"/
// "zusammenfassen"; `geldfluss` catches the app's own "Geldfluss zusammenfassen" button phrasing. The
// German noun `Transaktion` and the verb `kategorisier`… do NOT contain the English `transaction`/the
// noun `kategorie`, so without these a natural de-AT request like "Kategorisiere die Transaktionen" was
// NOT recognised as analysis-shaped → it fell through this 0-model handler to generic RAG, which stuffs
// the whole statement into the model and overflows the context window on a multi-page Kontoauszug.
const ANALYSIS_KEYWORDS: readonly string[] = [
  'transaction', 'transactions', 'balance', 'balances', 'reconcile', 'reconciliation',
  'cashflow', 'cash flow', 'total', 'totals', 'sum', 'summary', 'summarize', 'summarise',
  'spend', 'spending', 'spent', 'income', 'expense', 'expenses', 'net', 'statement',
  'deposit', 'withdrawal', 'how much', 'how many', 'overview',
  'kontoauszug', 'buchung', 'buchungen', 'saldo', 'umsatz', 'umsätze', 'ausgabe', 'ausgaben',
  'einnahme', 'einnahmen', 'betrag', 'beträge', 'summe', 'überweisung', 'abgleich',
  'zusammenfass', 'geldfluss', 'transaktion', 'kategorie', 'kategorien'
]

// A category-shaped question additionally wants a per-category breakdown (drives `categorize_*`).
const CATEGORY_KEYWORDS: readonly string[] = [
  'categor', 'breakdown', 'by category', 'spending on', 'spend on',
  'kategor', 'nach kategorie', 'aufschlüssel'
]

function isAnalysisShaped(question: string): boolean {
  const q = question.toLowerCase()
  // A CATEGORY request ("Kategorisiere …", "nach Kategorie", "break down …") is DEFINITIONALLY an
  // analysis request, so it must route to this 0-model handler too — otherwise a category question that
  // happens to miss every ANALYSIS_KEYWORD (e.g. "Kategorisiere die Transaktionen") falls through to
  // generic RAG and overflows the context window on a long statement. Category-shaped ⟹ analysis-shaped.
  return ANALYSIS_KEYWORDS.some((k) => q.includes(k)) || isCategoryShaped(q)
}

function isCategoryShaped(question: string): boolean {
  const q = question.toLowerCase()
  return CATEGORY_KEYWORDS.some((k) => q.includes(k))
}

/** The single in-scope ANSWERABLE document, or null when the scope is not exactly one (R2). The chat
 *  analysis path reads the stored `chunks`, so it requires them (`requireChunks: true`) — an indexed
 *  but unchunked document is runnable via the button but not answerable here (X-1, the shared helper). */
function singleInScopeDocument(db: Db, scope: RetrievalScope): { id: string; title: string } | null {
  const docs = documentsInScope(db, scope, { requireChunks: true })
  return docs.length === 1 ? { id: docs[0].id, title: docs[0].title } : null
}

/** A statement row paired with its PERSISTED category name — the two are read in one query so their
 *  alignment is STRUCTURAL (each row carries its own category), never an index match across two arrays.
 *  Carries the row's `id`/`rowIndex` too so the handler can hand the SAME single load to the downstream
 *  seams as `preloaded` (audit P-1) — they persist against `id`, in `rowIndex` order. */
interface RowWithCategory {
  id: string
  rowIndex: number
  row: TransactionInput
  /** The persisted category name (LLM doctask or rule pass), or null when the row is unassigned. */
  category: string | null
}

/**
 * Load a statement's rows AND their persisted categories in ONE LEFT-JOINed query (Phase 31–33
 * follow-up). The pure tools' input (`TransactionInput`, nulls omitted — reconcile relies on it) and
 * the per-row category travel together, so `categoryTotals` reads each row's own category instead of
 * indexing two separately-ordered arrays in lockstep. A null category falls back to the on-the-fly
 * `categorizeRow` at read time (no persistence required to answer). This is the handler's SINGLE
 * `bank_transactions` read (audit P-1): it also carries `id`/`rowIndex` so the rows can be fed to the
 * downstream seams (`runCashflowSummary`/`runBalanceValidation`/`runCategorization`) as `preloaded`,
 * sparing each seam its own re-query.
 */
function loadStatementRowsWithCategories(db: Db, statementId: string): RowWithCategory[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.row_index AS rowIndex, t.date, t.value_date AS valueDate, t.description,
              t.amount, t.currency, t.balance_after AS balanceAfter, t.source_page AS sourcePage,
              c.name AS categoryName
       FROM bank_transactions t
       LEFT JOIN bank_categories c ON c.id = t.category_id
       WHERE t.statement_id = ? ORDER BY t.row_index`
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
    return { id: r.id, rowIndex: r.rowIndex, row: t, category: r.categoryName ?? null }
  })
}

/** Project the single row load into the `LoadedTransaction` shape the downstream seams persist against
 *  (id + rowIndex + the tool input fields, in row order) — so the seams reuse these instead of
 *  re-querying `bank_transactions` (audit P-1). */
function toLoadedTransactions(paired: readonly RowWithCategory[]): LoadedTransaction[] {
  return paired.map((p) => ({ id: p.id, rowIndex: p.rowIndex, ...p.row }))
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

/** The persisted date-order provenance flag (R5, audit §5.7) — drives the one honest date caveat, or null. */
function loadDateOrderInferred(db: Db, statementId: string): 'evidence' | 'default' | null {
  const row = db
    .prepare('SELECT date_order_inferred AS flag FROM bank_statements WHERE id = ?')
    .get(statementId) as { flag: string | null } | undefined
  return row?.flag === 'default' ? 'default' : row?.flag === 'evidence' ? 'evidence' : null
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
  currency: string
  amount: number
  count: number
}

/**
 * Aggregate signed amounts per category, document order preserved. The category is each row's PERSISTED
 * one (written by the LLM categorizer doctask or the deterministic rule pass) when present, else computed
 * on the fly via `categorizeRow` — so a breakdown is answerable even before any categorize run. Each
 * `RowWithCategory` carries its own category (one JOINed read), so no cross-array index alignment.
 *
 * Keyed by (category, CURRENCY) (audit BL-3): signed amounts are never summed ACROSS currencies into one
 * figure — a EUR "Fees" row and a USD "Fees" row are distinct totals, each carrying its own currency. On
 * the single-currency path (the only branch `buildBankAnswer` renders the breakdown) this collapses to
 * one entry per category, byte-identical to before; the currency key only matters if a future caller
 * reuses this on a mixed-currency statement.
 */
function categoryTotals(paired: readonly RowWithCategory[]): CategoryTotal[] {
  const order: string[] = []
  const byKey = new Map<string, CategoryTotal>()
  for (const { row, category: persisted } of paired) {
    const category = persisted ?? categorizeRow(row)
    const key = `${row.currency} ${category}` // currency is a fixed 3-char code, so the split is unambiguous
    let entry = byKey.get(key)
    if (!entry) {
      entry = { category, currency: row.currency, amount: 0, count: 0 }
      byKey.set(key, entry)
      order.push(key)
    }
    entry.amount += row.amount
    entry.count += 1
  }
  return order.map((k) => {
    const e = byKey.get(k)!
    return { category: e.category, currency: e.currency, amount: Math.round(e.amount * 100) / 100, count: e.count }
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
    /**
     * The persisted date-order provenance (R5, audit §5.7). When 'default' — day-first was applied to
     * genuinely order-ambiguous dates with no evidence — ONE honest caveat line is appended. 'evidence'/
     * null/absent adds nothing (the order is trustworthy or moot). Never a figure; a trailing note only.
     */
    dateOrderInferred?: 'evidence' | 'default' | null
  }
): string {
  const { rows, summary, reconcile, categories, status, modelAssisted, dateOrderInferred } = data
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
            // Each total carries its OWN currency (BL-3) — identical to `summary.currency` on this
            // single-currency branch (the only one that renders the breakdown), but correct by construction.
            currency: c.currency,
            count: c.count
          })
        )
      }
      // A model-assigned category is NOT a verified figure — note it so the breakdown is read honestly
      // (the verified total + the D56 gate are untouched by a mislabel). When the LLM was NOT involved,
      // say so instead: the chat breakdown is a quick RULE-based grouping and the "Categorize" button
      // gives the richer model-assisted taxonomy — making the two entry points' divergence explicit
      // rather than silent (audit C-2), without adding a model call to this 0-model-call path.
      lines.push(
        tr(modelAssisted ? 'skills.bankAnalysis.categoryAssisted' : 'skills.bankAnalysis.categoryRuleBased')
      )
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

  // One honest date caveat (R5, audit §5.7): the document gave no evidence of day- vs month-first, so the
  // dotted/slashed dates above were read day-first (the de-AT default). A trailing note — never a figure.
  if (dateOrderInferred === 'default') lines.push('', tr('skills.bankAnalysis.dateOrderCaveat'))

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

    // Serialize the WHOLE read→extract→validate→categorize→read-back sequence per document (audit
    // PC-1): the individual seams self-lock, but only one outer lock spanning the sequence keeps a
    // re-extract from ANOTHER lane (a button run / a categorize doctask) from deleting the statement
    // BETWEEN two of this handler's own steps. Re-entrant — the inner seam locks become no-ops while
    // this hold is in effect; unrelated documents still answer concurrently.
    return withDocumentLock(target.id, async () => {
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

      // Load the rows + persisted categories ONCE (the single `bank_transactions` read — audit P-1), then
      // hand the SAME rows to the downstream seams as `preloaded` so they don't each re-query. The seams
      // keep their `skill_runs` lifecycle + ids/counts audit (unchanged), and now RETURN their validated
      // figures (`output`) for in-process reuse — so the handler reuses them instead of recomputing the
      // same pure function (audit P-1/P-2). A seam that failed returns no `output`; fall back to a pure
      // recompute over the loaded rows then, preserving the prior byte-identical answer in every case.
      let paired = loadStatementRowsWithCategories(db, statementId)
      const rows = paired.map((p) => p.row)
      const loaded = toLoadedTransactions(paired)
      const summaryResult = await runCashflowSummary(db, args, deps, loaded)
      const validateResult = await runBalanceValidation(db, args, deps, loaded)
      const summary = (summaryResult.output as CashflowSummary | undefined) ?? summarizeCashflow(rows)
      const reconcile = (validateResult.output as ReconcileResult | undefined) ?? reconcileBalances(rows)

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
          // Deterministic seed when nothing is categorized yet — reuse the single load (audit P-1); the
          // reload afterwards is the one extra `bank_transactions` read the category path needs (to pick
          // up the freshly persisted `category_id`).
          await runCategorization(db, args, deps, loaded)
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

      const answer = buildBankAnswer(ctx.tr, {
        rows,
        summary,
        reconcile,
        categories,
        status,
        modelAssisted,
        dateOrderInferred: loadDateOrderInferred(db, statementId)
      })
      const citations = buildBankCitations(db, target.id, target.title, rows)
      const coverage = computeCoverage(db, target.id)
      return { answer, citations, coverage }
    })
  }
}
