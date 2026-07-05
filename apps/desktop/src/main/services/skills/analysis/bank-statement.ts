import type { Db } from '../../db'
import type { Citation } from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'
import { skillInstallId } from '../registry'
import { routeMatch } from '../vocabulary'
import {
  isBankStatementStale,
  latestBankStatementId,
  persistCategorization,
  runBalanceValidation,
  runBankExtraction,
  runCashflowSummary,
  runCategorization,
  type BankExtractionArgs,
  type BankExtractionDeps,
  type LoadedTransaction
} from '../run'
import {
  CATEGORIZER_CATEGORIES,
  categorizeTransactions,
  parseRequestedCategories,
  parseTaxonomyCsv,
  parseTaxonomyFileRef,
  type CustomCategoryInput
} from '../categorizer'
import { enrichRows, parseTableRequest, wantsExtraColumns } from '../enricher'
import { tableToCsv, type TableSpec } from '../../tables'
import { withDocumentLock } from '../doc-lock'
import {
  BUILTIN_CATEGORIES,
  UNCATEGORIZED,
  assessCompleteness,
  buildStatementJson,
  categorizeRow,
  reconcileBalances,
  rowsCarryCategories,
  summarizeCashflow,
  transactionsTableSpec,
  transactionsToCsv,
  type CashflowSummary,
  type CompletenessStatus,
  type ReconcileResult,
  type StatementSnapshot,
  type TransactionInput
} from '../tools/bank-statement'
import {
  chunksToCitations,
  computeCoverage,
  fmt,
  loadCitationChunks,
  shouldFallThroughOnEmpty,
  singleDocMatchesSkillClass,
  singleInScopeDocument
} from './common'
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

// Analysis-shaped intent now reads the ONE canonical bank vocabulary (W5, audit §3.2/§4.1): its
// `route|both` entries — accounting/transaction words, EN + DE for the de-AT target — matched word-boundary
// for single tokens (`net` no longer intercepts "Netflix") and substring for phrases/German stems (so
// `transaktion` still catches "Transaktion"/"Transaktionen" and the run seams see "Kategorisiere die
// Transaktionen" instead of overflowing generic RAG on a multi-page Kontoauszug). The vocabulary is
// single-sourced with the SKILL.md suggestion keywords (parity-tested), so routing and offers no longer
// drift. Conservative by design — a tool skill answering an off-topic question keeps the relevance path.

// A category-shaped question additionally wants a per-category breakdown (drives `categorize_*`). Kept as
// its OWN stem list (a sub-behaviour gate, not a trigger) — `kategor`/`categor` are substring stems that
// select the breakdown detail, distinct from the analysis-vs-off-topic trigger the vocabulary owns.
// SKA-20 (W7, audit §3.4/§4.1) — the `spend on`/`spending on` stems were DROPPED here. They routed
// "how much did I spend on groceries?" to the category TEMPLATE, while the past tense (`spent on`, never
// present) reached grounded-data — the engine flipped on tense, and the W3/W4 record + the run() comment
// + a test comment ALL cite that exact question as the flagship GROUNDED-DATA example. Dropping the
// spend-stems makes the flagship true (a filtered spend ask now narrates the verified extract, with the
// deterministic per-category grouping still riding the grounded-data block), tense-independent. The
// explicit "break down by category" ask keeps the template via `categor`/`breakdown`/`kategor`/`aufschlüssel`.
const CATEGORY_KEYWORDS: readonly string[] = [
  'categor', 'breakdown', 'by category',
  'kategor', 'nach kategorie', 'aufschlüssel'
]

function isAnalysisShaped(question: string): boolean {
  // A CATEGORY request ("Kategorisiere …", "nach Kategorie", "break down …") is DEFINITIONALLY an
  // analysis request, so it routes to this 0-model handler too — otherwise a category question that
  // happens to miss every analysis term falls through to generic RAG and overflows the context window on a
  // long statement. Category-shaped ⟹ analysis-shaped.
  return routeMatch('bank-statement', question) || isCategoryShaped(question)
}

function isCategoryShaped(question: string): boolean {
  const q = question.toLowerCase()
  return CATEGORY_KEYWORDS.some((k) => q.includes(k))
}

// Format-transformation intent (W4, audit §3.3 — the bank half of invoice-format-2026-07-01). When
// present the handler SERIALIZES the already-extracted statement DETERMINISTICALLY (no model call, no
// invented figure — a serializer cannot read a number the parser did not) instead of a prose/model
// answer. `applies()` stays TRUE (a bank keyword still owns the turn), so a format ask never leaks the
// raw statement into the generic RAG path. Word-bounded so `json`/`csv` match only as standalone tokens.
// Bank supports JSON (rows + summary + balances) and CSV (rows only — the export serializer); there is
// no statement XML serializer, so "as xml" is left to fall through to the summary/grounded-data routing.
type OutputFormat = 'json' | 'csv'
function detectFormat(question: string): OutputFormat | null {
  const q = question.toLowerCase()
  if (/\bjson\b/.test(q)) return 'json'
  if (/\bcsv\b/.test(q)) return 'csv'
  return null
}

// W4 answer-shape routing (audit §3.1/§8.1), ported from the invoice handler (W3). The question selects
// the ANSWER SHAPE, not document access (every shape reads the same extracted statement): an aggregate
// SUMMARY / reconcile / totals / balance / category / list ask keeps the high-stakes deterministic
// TEMPLATE — the one path that runs the D56 completeness gate + surfaces unreconciled rows BEFORE any
// total, a posture the LLM must never own — while everything else that passed `applies()` (a specific
// filter, a superlative, an entity, or a "why" follow-up: "how much did I spend on groceries?", "wer hat
// die höchste Zahlung bekommen?", "warum stimmen die Summen nicht?") streams a model answer that NARRATES
// the verified data (grounded-data). All three examples now ROUTE and land on grounded-data as written:
// W7 dropped `spend on` from `CATEGORY_KEYWORDS` (SKA-20) so the groceries ask is grounded-data not the
// category template, and added the `zahlung` route stem (SKA-7) so the Zahlung ask reaches the handler at
// all (audit §4.1). Substring-matched, already inside a bank-shaped `applies()`. The set
// is DELIBERATELY broader than the invoice one: for a statement the totals ARE the D56-gated headline
// (a mis-read partial sum masquerading as the verified total is the cardinal harm), so `total`/`summe`/
// `saldo`/`kontostand`/`net change`/`cashflow` stay on the gated template, not the model.
const SUMMARY_KEYWORDS: readonly string[] = [
  'summar', // summary / summarize / summarise
  'overview',
  'überblick',
  'zusammenfass', // Zusammenfassung / zusammenfassen
  'reconcil', // reconcile / reconciliation
  'abgleich', // DE: reconcile
  'total', // total / totals — the D56-gated headline figure
  'net change', // the totals-line label (bank answer)
  'cashflow',
  'cash flow',
  'geldfluss',
  'summe', // Was ist die Summe? — a total ask → the completeness gate, not the model
  'kontostand',
  'saldo', // balance asks → the deterministic balance/completeness answer
  'alle transaktionen',
  'transaktionen auflisten',
  'list the transaction',
  'list all transaction'
]

// The German reconcile ask "Stimmen die Salden?" / "Stimmt die Summe?" (do the balances/totals add up?).
// WORD-anchored, NOT a bare `stimmen` substring: `stimmen` ⊂ bestimmen / abstimmen / übereinstimmen — a
// bare match would over-fire those to the template. Mirrors the invoice `RECONCILE_STIMMT_RE`.
const RECONCILE_STIMMT_RE = /\bstimm(en|t)\b/

// SKA-9 (W7, audit §3.2) — German SEPARABLE verb forms the joined-stem SUMMARY_KEYWORDS miss: the
// imperative "Fasse den Kontoauszug zusammen" / "Liste die Transaktionen auf" are the most common list/
// summary phrasings, and must reach the D56-gated TEMPLATE (ordering + completeness posture) instead of
// streaming grounded-data. Word-anchored on BOTH particles, linear (a single unbounded `[\s\S]*` between
// two anchors — no nested quantifier, ReDoS-safe per the suite's precedents). NOTE: "auf" doubles as a
// preposition ("Liste die Buchungen auf dem Konto"), so `/\blist…\bauf\b/` OVER-fires that to the template —
// the safe deterministic side (a listing ask is a template ask anyway); accepted, pinned by an eval item.
const SEPARABLE_SUMMARY_RES: readonly RegExp[] = [
  /\bfass(e|t|en)?\b[\s\S]*\bzusammen\b/, // fasse/fasst/fassen … zusammen
  /\blist(e|et)?\b[\s\S]*\bauf\b/ // liste/listet … auf
]

// A WHY / explanatory marker escapes the summary shape even when a summary stem is present: the template
// can only PRINT figures, never EXPLAIN, so "Warum stimmen die Summen nicht?" is a grounded-data question
// (the audit §3.1 / W4 follow-up case — a repeat "summe"/"total" intercept must NOT re-serve the
// byte-identical template). Word-bounded so it never fires inside an unrelated word. Mirrors the invoice.
const EXPLANATORY_RE = /\b(?:warum|wieso|weshalb|why)\b|\bhow come\b/

function isSummaryShaped(question: string): boolean {
  const q = question.toLowerCase()
  if (EXPLANATORY_RE.test(q)) return false // "warum …" always explains → grounded-data
  // A CATEGORY breakdown is a high-stakes deterministic shape too (the template renders the per-category
  // totals + the honest model-assisted note); keep it on the template unless it ASKS WHY (guarded above).
  return (
    SUMMARY_KEYWORDS.some((k) => q.includes(k)) ||
    RECONCILE_STIMMT_RE.test(q) ||
    SEPARABLE_SUMMARY_RES.some((re) => re.test(q)) ||
    isCategoryShaped(q)
  )
}

// `singleInScopeDocument` (also the W2 plausibility gate's `shouldFallThroughOnEmpty`) is the shared
// `analysis/common.ts` helper (A1) — the byte-identical copy that lived here + in the invoice handler.

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

/** The persisted count of money-bearing lines the extractor could NOT parse (U1, audit §2.3) — gates the
 *  "whole statement" answer claim. 0 (or NULL, a pre-U1 row → treated as "no gate") when nothing dropped. */
function loadDroppedRowCount(db: Db, statementId: string): number {
  const row = db
    .prepare('SELECT dropped_row_count AS n FROM bank_statements WHERE id = ?')
    .get(statementId) as { n: number | null } | undefined
  return row?.n ?? 0
}

/**
 * Find the taxonomy document a question referenced by NAME (Phase 1.6): a case-insensitive title
 * match across the indexed library (extension-stripped stems match too — "taxonomie.csv" finds a
 * doc titled "Taxonomie"), EXCLUDING the statement itself. Ties break to the most recently updated
 * (the user's latest version). This is a LOOKUP only — the retrieval scope is never widened, and the
 * statement stays the handler's single in-scope document.
 */
function findDocumentByName(db: Db, ref: string, excludeId: string): { id: string; title: string } | null {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const stem = (s: string): string => s.replace(/\.[a-z0-9]{1,8}$/i, '')
  const wanted = new Set([norm(ref), norm(stem(ref))].filter((s) => s.length > 0))
  if (wanted.size === 0) return null
  const docs = db
    .prepare(`SELECT id, title FROM documents WHERE status = 'indexed' AND id != ? ORDER BY updated_at DESC`)
    .all(excludeId) as Array<{ id: string; title: string }>
  for (const d of docs) {
    if (wanted.has(norm(d.title)) || wanted.has(norm(stem(d.title)))) return d
  }
  return null
}

/** A referenced document's plain text: the faithful parser segments when the IPC injected the
 *  reader, else the chunks table (the unit-test path). A taxonomy file is small — read whole. */
async function readDocumentPlainText(ctx: SkillAnalysisContext, documentId: string): Promise<string> {
  if (ctx.readDocumentSegments) {
    const segments = await ctx.readDocumentSegments(documentId)
    return segments.map((s) => s.text).join('\n')
  }
  const rows = ctx.db
    .prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as Array<{ text: string }>
  return rows.map((r) => r.text).join('\n')
}

const MAX_CITATIONS = 12

/**
 * Real source chunks behind the figures (M2-safe) — never the synthesised total. We cite the
 * document's actual `chunks` rows, narrowed to the pages the extracted transactions came from (their
 * `sourcePage`) when known, so the citations point at where the figures were read; the shared
 * `loadCitationChunks`/`chunksToCitations` (A1) supply the query + `[Sn]` projection. Falls back to the
 * document's leading chunks when no row carries a page.
 */
function buildBankCitations(
  db: Db,
  documentId: string,
  title: string,
  rows: TransactionInput[]
): Citation[] {
  const pages = new Set<number>()
  for (const r of rows) if (r.sourcePage != null) pages.add(r.sourcePage)
  const all = loadCitationChunks(db, documentId)
  const picked = (pages.size > 0 ? all.filter((c) => c.page_number != null && pages.has(c.page_number)) : all).slice(
    0,
    MAX_CITATIONS
  )
  return chunksToCitations(picked, title)
}

type Tr = (key: MessageKey, params?: MessageParams) => string

/** The category names that HAVE a localized display label (the fixed taxonomies). A USER-DEFINED
 *  name (Phase 1.5 custom sets) is deliberately NOT probed against the i18n catalog: the catalog
 *  logs unknown keys, and a custom category name is CONTENT — it must never reach the diagnostics
 *  log (§22-M1). */
const LOCALIZED_CATEGORY_NAMES: ReadonlySet<string> = new Set([...BUILTIN_CATEGORIES, ...CATEGORIZER_CATEGORIES])

/**
 * The localized DISPLAY label for a category (Phase 33). The PERSISTED identifier stays the canonical
 * English name (the enum / model-assisted detection key on it); this only localizes the breakdown
 * display. An unknown name (a user-defined category) is shown verbatim — without an i18n probe (see
 * `LOCALIZED_CATEGORY_NAMES`).
 */
function categoryLabel(tr: Tr, category: string): string {
  if (!LOCALIZED_CATEGORY_NAMES.has(category)) return category
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
 * Render the extracted statement as JSON/CSV inside a fenced code block, with a short honest intro (W4,
 * audit §3.3 — the bank half of invoice-format-2026-07-01). Pure serialization of the SAME structured
 * rows the extractor produced — the figures are the parser's, so nothing here can invent or transpose a
 * number (a serializer cannot read a figure the parser did not). JSON carries the transactions + the
 * cashflow summary + the printed balances; CSV reuses the export serializer (transaction ROWS ONLY — the
 * summary/balances aren't in CSV), and the CSV intro says so (§3.6 honesty precedent).
 */
export function buildFormatAnswer(
  tr: Tr,
  format: OutputFormat,
  snap: StatementSnapshot,
  /** Set when the rows carry categories (a category-shaped format ask, D63): selects the honest
   *  model-assisted vs rule-based note appended under the fenced block — a category is a LABEL,
   *  never a parser figure, and the serialized output must say which kind it got. */
  categoryNote?: { modelAssisted: boolean }
): string {
  const content = format === 'json' ? buildStatementJson(snap) : transactionsToCsv(snap.rows)
  const intro =
    format === 'csv'
      ? tr('skills.bankAnalysis.formatIntroCsv')
      : tr('skills.bankAnalysis.formatIntro', { format: format.toUpperCase() })
  const note =
    categoryNote && rowsCarryCategories(snap.rows)
      ? `\n\n${tr(categoryNote.modelAssisted ? 'skills.bankAnalysis.categoryAssisted' : 'skills.bankAnalysis.categoryRuleBased')}`
      : ''
  return `${intro}\n\n\`\`\`${format}\n${content}\n\`\`\`${note}`
}

/** The transaction cap for the grounded-data block (W4 §8.1 4096-ctx guard, mirror of the invoice
 *  `MAX_DATA_BLOCK_ITEMS`): the summary + balances ALWAYS stay (the figures questions ask about); rows
 *  past this are dropped from the block with an honest "…and N more" note. A coarse structural bound. */
const MAX_DATA_BLOCK_ROWS = 150

/** A one-line, content-free English description of the D56 completeness status for the data block, so the
 *  model NARRATING the statement knows whether the totals are proven-whole and can caveat honestly (it is
 *  never asked to recompute the gate — the verdict is the extractor's). */
function completenessNote(status: CompletenessStatus): string {
  switch (status) {
    case 'complete':
      return 'the printed opening + Σ(amounts) == closing balance ties out, so these are the whole statement'
    case 'contradicted':
      return 'a printed balance disagrees with the rows, so the totals are NOT verified as the whole statement'
    case 'unverified':
      return 'the statement prints no opening/closing balance to confirm every row was captured — treat the totals as a sum of the rows read, not a verified statement total'
  }
}

/**
 * Serialize the VERIFIED statement as the grounded-data block (W4, audit §8.1 — mirror of the invoice
 * `buildInvoiceDataBlock`): the JSON (rows + cashflow summary + balances) + the deterministic balance
 * reconciliation + the D56 completeness verdict + a deterministic per-category grouping + a provenance
 * note. This is authoritative context the model NARRATES (never computes over) — `buildStatementJson`
 * emits the parser's figures, so nothing here can invent a number. Rows past `MAX_DATA_BLOCK_ROWS` are
 * omitted from the JSON with an honest count (summary + balances always kept). Fixed English, model-facing.
 */
export function buildStatementDataBlock(args: {
  snap: StatementSnapshot
  reconcile: ReconcileResult
  status: CompletenessStatus
  categories: CategoryTotal[]
  /**
   * How many money-bearing lines the extractor could NOT parse (U1/SKA-5, audit §2.3/§3.1). When the
   * hedge fires (see below) a MISSING-lines note is added and the provenance line drops its "whole
   * document" claim, so the model NARRATING the block cannot assert the transaction list is complete.
   */
  droppedRowCount?: number
}): string {
  const { snap, reconcile, status, categories } = args
  // SKA-5 (W6) — D56 OUTRANKS the parse gap on the BANK side (mirror U1 / decision D56 / commit 42a4eb9):
  // a `complete` status means the printed opening + Σ == closing balance PROOF shows the dropped line(s)
  // provably did not move the balance → the read IS the whole statement, so NO missing-lines hedge. The
  // hedge (and the softened provenance) fire only on a NON-complete status (`unverified`/`contradicted`),
  // where there is no balance proof that the dropped figures were non-transactions.
  const dropped = args.droppedRowCount ?? 0
  const hedgeDropped = dropped > 0 && status !== 'complete'
  const omitted = Math.max(0, snap.rows.length - MAX_DATA_BLOCK_ROWS)
  const capped: StatementSnapshot =
    omitted > 0 ? { ...snap, rows: snap.rows.slice(0, MAX_DATA_BLOCK_ROWS) } : snap
  const lines: string[] = ['Bank statement (JSON):', buildStatementJson(capped)]
  if (omitted > 0) {
    lines.push(`(${omitted} further transaction(s) were parsed but omitted from this block for length.)`)
  }
  const mismatched = reconcile.rows.filter((r) => r.status === 'mismatch').map((r) => r.index)
  lines.push(
    '',
    'Balance reconciliation (computed deterministically by the extractor — do NOT recompute):',
    `- running balances: ${reconcile.reconciled ? 'reconciled' : 'not reconciled'}`
  )
  if (mismatched.length > 0) {
    lines.push(`- rows whose printed running balance disagrees (0-based index): ${mismatched.join(', ')}`)
  }
  lines.push(`- completeness: ${completenessNote(status)}`)
  if (categories.length > 0) {
    lines.push('', 'Category totals (a deterministic rule-based grouping of the signed amounts — NOT model-assigned):')
    for (const c of categories) {
      lines.push(`- ${c.category}: ${fmt(c.amount)} ${c.currency} (${c.count} row(s))`)
    }
  }
  // SKA-5 (W6): the honest MISSING-lines note — some money-bearing line(s) could not be parsed into rows,
  // so the model must NOT narrate this list as complete. Suppressed when D56 proves the read whole (above).
  if (hedgeDropped) {
    lines.push(
      '',
      `NOTE: ${dropped} money-bearing line(s) could not be parsed into rows and are MISSING from this data — ` +
        'do NOT claim the transaction list is complete or that this is the whole statement.'
    )
  }
  // The provenance line's "from the whole document" claim is conditional on the same gate: when lines were
  // dropped (and D56 did not prove wholeness) it must not assert the extract is whole.
  lines.push(
    '',
    hedgeDropped
      ? 'Provenance: the values above were parsed and reconciled by a deterministic offline extractor, but ' +
          'some money-bearing lines could not be parsed and are missing (see the NOTE above). Quote these ' +
          'figures verbatim; do not add, total, convert, or derive any number.'
      : 'Provenance: every value above was parsed and reconciled from the whole document by a deterministic ' +
          'offline extractor. Quote these figures verbatim; do not add, total, convert, or derive any number.'
  )
  return lines.join('\n')
}

/**
 * The deterministic figure echo appended UNDER a grounded-data model answer (W4 §8.1 caveat, mirror of
 * the invoice `buildTotalsPostscript`): the COMPUTED money-in / money-out / net (`summarizeCashflow` sums,
 * NOT figures printed in the document — SKA-4), so a model misquote is immediately contradicted. The echo
 * is now GATED on the D56 completeness `status`, so the deterministic app-authored postscript can never
 * hand the user a total the TEMPLATE path refuses (SKA-4, audit §3.1):
 *   - `complete`     — the computed-sums echo, as before (proven whole).
 *   - `unverified`   — the echo PLUS the `unverifiedCaveat` line (a clearly-labelled sum of the rows read,
 *                      not a verified statement total), mirroring the template's `unverifiedCaveat` branch.
 *   - `contradicted` — SUPPRESS the echo entirely (chosen over echoing the printed opening/closing: the
 *                      postscript builder is not threaded the printed balances, and re-surfacing a figure a
 *                      refuted statement contradicts would add a new money surface for no honesty gain —
 *                      this mirrors the template's `incompleteNoTotal` refusal, which prints no sum).
 * Plus the SKA-5 dropped-line hedge (D56 outranks on the bank side — fires only on a non-`complete` status).
 * Returns '' on a MIXED-currency statement (`summary.currency` absent) for the ECHO — there is no single
 * meaningful total to echo (BL-2/D56) — but a dropped-line hedge still rides when applicable. The R5 date
 * caveat is appended by the CALLER regardless of status, so it is unaffected by this gating.
 */
export function buildCashflowPostscript(
  tr: Tr,
  summary: CashflowSummary,
  status: CompletenessStatus,
  droppedRowCount?: number
): string {
  const parts: string[] = []
  // The computed in/out/net echo — only with a single currency AND when D56 does not refuse a total.
  if (summary.currency && status !== 'contradicted') {
    const figures = [
      tr('skills.bankAnalysis.figureEchoIn', { amount: fmt(summary.totalIn), currency: summary.currency }),
      tr('skills.bankAnalysis.figureEchoOut', { amount: fmt(summary.totalOut), currency: summary.currency }),
      tr('skills.bankAnalysis.figureEchoNet', { amount: fmt(summary.net), currency: summary.currency })
    ].join(' · ')
    const echo = tr('skills.bankAnalysis.figureEcho', { figures })
    parts.push(
      status === 'unverified'
        ? [echo, tr('skills.bankAnalysis.unverifiedCaveat', { count: summary.count })].join('\n\n')
        : echo // 'complete'
    )
  }
  // SKA-5: the dropped-line hedge. D56 OUTRANKS on the bank side (mirror U1 / commit 42a4eb9) — a `complete`
  // balance proof means the dropped figures did not move the balance, so NO hedge; it fires only otherwise.
  const dropped = droppedRowCount ?? 0
  if (dropped > 0 && status !== 'complete') {
    parts.push(tr('skills.bankAnalysis.countPartial', { count: summary.count, dropped }))
  }
  return parts.join('\n\n')
}

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
    /**
     * How many money-bearing lines the extractor could NOT parse (U1, audit §2.3). Gates the "whole
     * statement" headline: > 0 ⇒ an honest "**{count}** read; **{dropped}** line(s) with figures I
     * couldn't parse". Combined with the D56 `status`, this also kills the self-contradicting count line —
     * a `contradicted` statement no longer claims "across the whole statement" over a body that says the
     * balances don't add up. The extractor scanned every section; it just could not parse every figure.
     */
    droppedRowCount?: number
  }
): string {
  const { rows, summary, reconcile, categories, status, modelAssisted, dateOrderInferred } = data
  if (rows.length === 0) return tr('skills.bankAnalysis.empty')

  // U1 (audit §2.3): the headline count is honesty-gated. The D56 completeness PROOF outranks the parse-gap
  // hedge: when the printed opening + Σ == closing ties out over the kept rows (`status === 'complete'`), a
  // dropped money line provably did NOT move the balance (a non-transaction figure), so the read IS the whole
  // statement and the plain "across the whole statement" line is honest — a `countPartial` hedge would both
  // contradict the proven-whole total the body then presents AND be factually less accurate. Otherwise a real
  // parse gap (`dropped > 0`) drops the "whole statement" claim for the honest partial; else a `contradicted`
  // balance uses the no-whole-claim headline (the printed balances refute the rows); else the plain line. The
  // extractor read every section — this gates the exhaustiveness of the TRANSACTIONS, not the reading pass.
  const dropped = data.droppedRowCount ?? 0
  const countLine =
    status === 'complete'
      ? tr('skills.bankAnalysis.count', { count: rows.length })
      : dropped > 0
        ? tr('skills.bankAnalysis.countPartial', { count: rows.length, dropped })
        : status === 'contradicted'
          ? tr('skills.bankAnalysis.countContradicted', { count: rows.length })
          : tr('skills.bankAnalysis.count', { count: rows.length })
  const lines: string[] = [countLine]

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
  mode: 'exhaustive',
  // The doc-count-agnostic intent (W2, audit §2.1): an analysis-shaped bank question, regardless of how
  // many documents are in scope. `applies()` = this AND a single in-scope doc; when it fails ONLY on the
  // count, the chat path narrows to the best-matching statement or routes (never a silent fall-through).
  intends(input: SkillAnalysisInput): boolean {
    return isAnalysisShaped(input.question)
  },

  // A4 (SKA-7 structural, audit §3.2/§8.2): the single-doc INVERSION gate. The single in-scope document is
  // plausibly a statement when it matches the skill's manifest doc signals OR a persisted extraction already
  // exists for it (`latestBankStatementId`). When true and `applies()` is false (a phrasing miss), the chat
  // path runs this handler anyway, so an on-topic money question that misses the vocabulary is answered from
  // the verified extract (grounded-data) instead of raw top-k + 4B arithmetic. A doc matching neither keeps
  // the phrasing gate (the W2 plausibility posture, inverted). No new capability, no new model call (SEC-1).
  classMatches(input: SkillAnalysisInput, skillInstallId: string): boolean {
    return singleDocMatchesSkillClass(input.db, skillInstallId, input.scope, (db, id) => latestBankStatementId(db, id) != null)
  },

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
    // this hold is in effect; unrelated documents still answer concurrently. The turn signal rides
    // along (SKA-24): a Stop while parked behind another lane rejects out to `withChatStream`, which
    // treats an aborted rejection as the calm empty-done cancel — no dead wait behind a long categorize.
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

      // W2 plausibility gate (audit §4.5): the extractor found NO transactions. If this document doesn't
      // even look like a statement by the skill's own manifest signals (filename/MIME), it almost
      // certainly isn't one (a contract in scope with the bank skill sticky) — fall through to the
      // ordinary grounded path so the LLM answers the user's ACTUAL question, instead of the honest-but-
      // useless "I read the whole statement but couldn't find any transactions" template. A zero-row read
      // on a doc that DOES look like a statement keeps that honest empty answer. Deterministic, no model.
      if (rows.length === 0 && shouldFallThroughOnEmpty(db, ctx.skillInstallId, target)) {
        return { answer: '', citations: [], fallThrough: true }
      }

      // Citations + coverage + balances are the SAME for the format, template, and grounded-data shapes
      // (all three read the whole extracted statement); the deterministic extractor is the source of truth
      // for the figures on every path. Hoisted here so the format short-circuit below can return them.
      const citations = buildBankCitations(db, target.id, target.title, rows)
      const coverage = computeCoverage(db, target.id)
      const balances = loadStatementBalances(db, statementId)

      // Per-category breakdown (only for a category-shaped question). It reads the PERSISTED categories
      // (the LLM categorizer doctask, or a prior rule pass) — `categorize` is the ONLY model call and it
      // happens in the doctask lane, NEVER here (this handler stays 0-model-calls). When nothing has been
      // categorized yet, run the DETERMINISTIC rule pass once (0 model calls) so a breakdown still shows;
      // model-assigned categories (if present) are never overwritten by it. `modelAssisted` (a persisted
      // category outside the deterministic set) drives the honest "model-assisted" note.
      // HOISTED ABOVE the format short-circuit (result-tables plan §3, D63): "Kategorisiere … und
      // exportiere als CSV" used to hit the format return FIRST and never categorize — the categorize
      // half of the ask was silently dropped. Categorizing before serializing lets the format answer
      // carry each row's category (presence-gated column, D62). Guarded to a non-empty statement — the
      // categorize seam has nothing to persist on zero rows.
      const categoryShaped = isCategoryShaped(ctx.question)
      let categories: CategoryTotal[] | null = null
      let modelAssisted = false
      if (categoryShaped && rows.length > 0) {
        // A USER-SUPPLIED custom category set ("Kategorisiere in Miete, Kinder, Sonstiges …" —
        // result-tables plan, Phase 1.5). The parse is conservative (≥2 plausible labels after a
        // categorize stem, deliverable tail cut, whole parse rejected on any bad token). When the
        // persisted labels already live inside the requested set the prior run is REUSED (asking for
        // the CSV again does not re-pay the model); otherwise the enum-constrained categorizer runs
        // INLINE — sanctioned here because the chat turn holds the exclusive model slot (the same
        // slot grounded-data streams in). With no runtime the ask is REFUSED with friendly copy: the
        // deterministic rules cannot know the user's labels, and a silent fixed-taxonomy fallback
        // would answer a different question than the one asked.
        // A taxonomy FILE reference wins over an inline list (Phase 1.6): "Kategorisiere nach den
        // Kategorien in taxonomie.csv" loads the referenced document from the library BY NAME (a
        // lookup only — retrieval scope is never widened; the statement stays the single in-scope
        // doc), parses one label per line (optional keyword GLOSS after the delimiter, fed to the
        // model prompt), and rides the same custom-set path below. A missing file or an unparseable
        // list is an honest refusal NAMING the file — never a silent fixed-taxonomy fallback.
        let requested: CustomCategoryInput | null = null
        const taxonomyRef = parseTaxonomyFileRef(ctx.question)
        if (taxonomyRef) {
          const taxonomyDoc = findDocumentByName(db, taxonomyRef, target.id)
          if (!taxonomyDoc) {
            return {
              answer: ctx.tr('skills.bankAnalysis.customTaxonomyNotFound', { name: taxonomyRef }),
              citations,
              coverage
            }
          }
          const parsed = parseTaxonomyCsv(await readDocumentPlainText(ctx, taxonomyDoc.id))
          if (!parsed) {
            return {
              answer: ctx.tr('skills.bankAnalysis.customTaxonomyUnparseable', { name: taxonomyDoc.title }),
              citations,
              coverage
            }
          }
          requested = parsed
        } else {
          requested = parseRequestedCategories(ctx.question)
        }
        if (requested) {
          const requestedNames = requested.map((c) => (typeof c === 'string' ? c : c.name))
          const persisted = new Set(
            paired.map((p) => p.category).filter((c): c is string => c != null && c !== UNCATEGORIZED)
          )
          const requestedSet = new Set(requestedNames)
          const covered = persisted.size > 0 && [...persisted].every((c) => requestedSet.has(c))
          if (!covered) {
            if (!ctx.runtime) {
              return {
                answer: ctx.tr('skills.bankAnalysis.customCategoriesNeedModel', {
                  categories: requestedNames.join(', ')
                }),
                citations,
                coverage
              }
            }
            const run = await categorizeTransactions(rows, {
              runtime: ctx.runtime,
              signal: ctx.signal ?? new AbortController().signal,
              categories: requested
            })
            persistCategorization(db, statementId, toLoadedTransactions(paired), run.assignments, run.modelAssisted, ctx.now)
            paired = loadStatementRowsWithCategories(db, statementId)
          }
        } else if (!paired.some((p) => p.category != null)) {
          // Deterministic seed when nothing is categorized yet — reuse the single load (audit P-1); the
          // reload afterwards is the one extra `bank_transactions` read the category path needs (to pick
          // up the freshly persisted `category_id`).
          await runCategorization(db, args, deps, toLoadedTransactions(paired))
          paired = loadStatementRowsWithCategories(db, statementId)
        }
        categories = categoryTotals(paired)
        modelAssisted = isModelAssisted(
          loadCategorizedByModel(db, statementId),
          paired.map((p) => p.category)
        )
      }

      // A machine-FORMAT request ("als JSON"/"as CSV") is answered by SERIALIZING the already-extracted
      // statement (W4, audit §3.3 — the bank half of the invoice format mode) — deterministic, 0 model
      // calls, no reconciliation needed (mirror of the invoice format path, which likewise returns before
      // the validate seam). Guarded to a non-empty statement so a zero-row extraction still gets the honest
      // prose fallback below (never an empty JSON husk dressed up as an answer). JSON carries rows +
      // cashflow summary + balances; CSV reuses the export serializer (rows only) — computed purely here.
      // On a CATEGORY-shaped format ask (D63) the serialized rows carry their categories (persisted, or
      // the on-the-fly rule fallback for a stray unassigned row) and the honest assisted/rule-based note
      // rides under the fenced block; a plain format ask keeps the byte-identical category-less shape.
      // SKA-10 (W7, audit §3.3): a WHY/how-come format question ("Warum fehlt im JSON die MwSt?") is an
      // EXPLANATION, not a serialization request — re-serving the byte-identical dump is the repeat-loop
      // class W3/W4 killed elsewhere. Guard the format short-circuit with EXPLANATORY_RE so it reaches
      // grounded-data (which can explain) instead. The serializer is deterministic; it cannot say WHY.
      const format = EXPLANATORY_RE.test(ctx.question.toLowerCase()) ? null : detectFormat(ctx.question)
      if (format && rows.length > 0) {
        const snapRows = categoryShaped
          ? paired.map((p) => ({ ...p.row, category: p.category ?? categorizeRow(p.row) }))
          : rows

        // Phase 3 (result-tables §5): user-requested DERIVED columns ("… als CSV mit einer Spalte
        // Empfänger"). The cheap deterministic pre-gate keeps a plain format ask 0-model; only a
        // column-shaped ask pays the ONE grammar-constrained TableRequest parse, and only a
        // non-empty validated request pays the per-row enrichment (the WHOLE extracted statement,
        // batched, blank cells where the model was unsure — never a guess). Any parse/enrich fault
        // falls through to the plain table below — never a half-enriched answer. A derived value is
        // a MODEL-FILLED label, never a parser figure — the note under the fence says so.
        if (format === 'csv' && ctx.runtime && wantsExtraColumns(ctx.question)) {
          const signal = ctx.signal ?? new AbortController().signal
          const derived = await parseTableRequest(ctx.question, { runtime: ctx.runtime, signal })
          if (derived && derived.length > 0) {
            const filled = await enrichRows(snapRows, derived, { runtime: ctx.runtime, signal })
            const base = transactionsTableSpec(snapRows)
            const table: TableSpec<object> = {
              columns: [...base.columns, ...derived.map((c) => ({ key: c.name, label: c.name }))],
              rows: snapRows.map((r, i) => ({ ...r, ...filled[i] }))
            }
            const notes = [
              ctx.tr('skills.bankAnalysis.derivedColumnsNote', {
                columns: derived.map((c) => c.name).join(', ')
              })
            ]
            if (categoryShaped && rowsCarryCategories(snapRows)) {
              notes.push(
                ctx.tr(modelAssisted ? 'skills.bankAnalysis.categoryAssisted' : 'skills.bankAnalysis.categoryRuleBased')
              )
            }
            const answer = `${ctx.tr('skills.bankAnalysis.formatIntroCsv')}\n\n\`\`\`csv\n${tableToCsv(table)}\n\`\`\`\n\n${notes.join('\n')}`
            return { answer, citations, coverage, table }
          }
        }

        const snap: StatementSnapshot = { rows: snapRows, summary: summarizeCashflow(rows), ...balances }
        return {
          answer: buildFormatAnswer(ctx.tr, format, snap, categoryShaped ? { modelAssisted } : undefined),
          citations,
          coverage,
          // Phase 2 (result-tables §4): the structured rows behind this answer, persisted with the
          // message so the message-level "Export CSV" can re-serialize them to a file on demand.
          table: transactionsTableSpec(snapRows)
        }
      }

      const loaded = toLoadedTransactions(paired)
      const summaryResult = await runCashflowSummary(db, args, deps, loaded)
      const validateResult = await runBalanceValidation(db, args, deps, loaded)
      const summary = (summaryResult.output as CashflowSummary | undefined) ?? summarizeCashflow(rows)
      const reconcile = (validateResult.output as ReconcileResult | undefined) ?? reconcileBalances(rows)

      // Completeness assessment (§3.5, D56): the only true proof a total is WHOLE is the statement's
      // printed opening + Σamounts == closing. Classify into one of three outcomes — `complete` (proven),
      // `contradicted` (a printed balance the rows refute → refuse), or `unverified` (no balance to tie
      // against, nothing contradicting → present a clearly-labelled sum of the rows read, the no-balance
      // "Umsätze" case). `buildBankAnswer` renders each honestly; the data block carries the same verdict.
      const status = assessCompleteness({
        rows,
        openingBalance: balances.openingBalance,
        closingBalance: balances.closingBalance,
        reconcile
      })
      const dateOrderInferred = loadDateOrderInferred(db, statementId)
      const droppedRowCount = loadDroppedRowCount(db, statementId)

      // W4 answer-shape routing (audit §3.1/§8.1), ported from the invoice handler (W3): an aggregate
      // summary / reconcile / total / balance / category / list ask keeps the high-stakes deterministic
      // TEMPLATE — the ONLY path that runs the D56 completeness gate + surfaces unreconciled rows BEFORE any
      // total, a posture the LLM must never own; everything else that passed applies() — a specific filter,
      // a superlative, an entity, a "why" follow-up ("how much did I spend on groceries?", "warum stimmen
      // die Summen nicht?") — streams a model answer that NARRATES the verified data (grounded-data), with
      // the parsed in/out/net echoed deterministically beneath it. The LLM never computes a figure; it reads
      // the data. A zero-row extraction that reached here (a real statement with no readable rows — not a
      // fall-through non-statement) also stays on the template: it owns the honest empty answer, and there
      // is no verified data to hand a model.
      if (isSummaryShaped(ctx.question) || rows.length === 0) {
        const answer = buildBankAnswer(ctx.tr, {
          rows,
          summary,
          reconcile,
          categories,
          status,
          modelAssisted,
          dateOrderInferred,
          droppedRowCount
        })
        return { answer, citations, coverage }
      }

      // The grounded-data postscript is the deterministic in/out/net echo (§8.1) PLUS the R5 honest date
      // caveat when the dates were read day-first with no evidence — a template appendix (R5, audit §5.7)
      // that must ride the grounded-data answer too, else W4 would silently drop R5's honesty for exactly
      // the date/filter questions that now route HERE. Both are deterministic, content-free beyond the
      // parser's own figures. The per-category grouping is computed deterministically for the data block
      // (so a "how much on groceries?" question is answerable) — no model, no persistence (categoryTotals
      // falls back to the rule-based categorizeRow when nothing is persisted).
      const postscriptParts: string[] = []
      // SKA-4/SKA-5 (W6): the echo is D56-status-gated and carries the dropped-line hedge (the composition
      // the wave built in separate phases and never wired). The R5 date caveat still rides regardless.
      const cashflowEcho = buildCashflowPostscript(ctx.tr, summary, status, droppedRowCount)
      if (cashflowEcho) postscriptParts.push(cashflowEcho)
      if (dateOrderInferred === 'default') postscriptParts.push(ctx.tr('skills.bankAnalysis.dateOrderCaveat'))
      return {
        answer: '',
        mode: 'grounded-data',
        dataBlock: buildStatementDataBlock({
          snap: { rows, summary, ...balances },
          reconcile,
          status,
          categories: categories ?? categoryTotals(paired),
          droppedRowCount
        }),
        postscript: postscriptParts.join('\n\n'),
        citations,
        coverage
      }
    }, ctx.signal)
  }
}
