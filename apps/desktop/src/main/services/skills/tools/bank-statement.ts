import type {
  DocumentChunkRead,
  JsonSchema,
  SkillTool,
  ToolResult
} from '../../../../shared/types'
import {
  MONEY_RE,
  blankDateTokens,
  csvField,
  detectCurrency,
  detectDocumentCurrency,
  hasMoneyToken,
  inferDateAnchor,
  inferDateOrder,
  inferDateOrderResult,
  lastCurrencyAdjacentInteger,
  normalizeExtractionText,
  parseAmount,
  parseDate,
  scanMoneyWithBlankedDates,
  splitLeadingDates,
  stripDateTokens,
  wordIncludes,
  type DateAnchor,
  type DateOrder
} from './money'
import { tableToCsv, type TableColumn, type TableSpec } from '../../tables'

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
    sourcePage: { type: 'integer', minimum: 1 },
    // Optional persisted category name (D61) — rides the row through the downstream tools/export.
    category: { type: 'string', minLength: 1 }
  }
}

/** A hard cap so a pathological document can never produce an unbounded array (the gate also validates). */
export const MAX_TRANSACTIONS = 10000

/**
 * How many wrapped DESCRIPTION continuation lines a single transaction row may absorb on the plain-text
 * path (R6, audit §5.7). ONE — the plain path has no column geometry to confirm the association (unlike
 * the geometry `MAX_CONTINUATION_ROWS` = 4), so a single immediately-following dateless/money-less line is
 * the conservative bound: enough to recover a merchant name that wrapped once, not enough to swallow a
 * footer note that happens to sit under the last row.
 */
const MAX_PLAIN_CONTINUATION_ROWS = 1

/**
 * The deterministic bank-statement extractor version (A9, Phase 31–33 follow-up). Stamped onto every
 * `bank_statements` row (`run.ts` `runBankExtraction`) and compared on reuse: a statement whose stored
 * `extractor_version` is NULL (legacy) or DIFFERS from this is STALE (SKA-26/R9: `!==`, not `<` — a
 * NEWER-version row after a rollback re-extracts too) — the analysis read-back + the categorize doctask
 * re-extract it (replacing the rows) rather than keep serving figures a since-fixed
 * parser bug mis-signed or whose payee it lost.
 *
 * BUMP THIS by one whenever a change alters the extractor's OUTPUT for the same input — in EITHER the
 * line parser here (`extractTransactions`/`parseLine`/`applySignMarker`) OR the geometry reconstruction
 * (`pdf-layout.ts` `reconstructPage`). A pure refactor that cannot change any output does NOT need a bump.
 *
 * History (each entry = the output-affecting work that warranted the value):
 *   1 — baseline: Phase 32 multi-baseline payee recovery + currency-token class + A3 sign-column fold,
 *       and the Phase 31–33 review's sign-handling correctness fixes (the current parser as built).
 *   2 — audit C-4: `extractStatementBalances` disambiguates the dual-role `Kontostand per` label by date
 *       (earliest = opening, latest = closing; a lone line = closing only) instead of reading it as BOTH
 *       opening and closing, changing the persisted `opening_balance`/`closing_balance` on Raiffeisen
 *       "Mein ELBA"-style statements. Stale v1 statements re-extract via the A9 path on the next reuse.
 *   3 — full-audit-2026-06-29 follow-up Phase 1: FIN-1 (statement currency by majority vote over
 *       figure-adjacent detections, not first-code-anywhere — fixes a wrong-currency total when a memo
 *       carries a stray code), FIN-3 (geometry classifier reads bare-thousands / apostrophe amounts and
 *       no longer mis-reads `2.500` as a date → the reconstructed line carries the real amount), and
 *       FIN-4 (date-order inferred from the LEADING date column only, so a memo date can't day/month-swap
 *       every row). Each can change the persisted currency / amounts / dates, so stale v2 rows re-extract.
 *   4 — skills-remediation R1 (audit §5.3): a shared `normalizeExtractionText` pre-pass runs at the plain-
 *       text extractor entry points (rows + balances), and the geometry path normalizes each token in
 *       `rowTokens` (its private mirror), so a Unicode minus (U+2212 / en dash / non-breaking hyphen), a
 *       no-break-space thousands separator (NBSP / narrow NBSP / figure space), or a Swiss U+2019 apostrophe
 *       group is read correctly — a `−45,90` debit now signs negative and a `1 234,56` (NBSP) no longer
 *       truncates to 234,56. Changes persisted amounts/signs on affected statements, so stale v3 rows re-extract.
 *   5 — skills-remediation R2 (audit §5.4): the dual-role balance label now recognizes `Kontostand am` and
 *       `Kontostand zum` alongside `Kontostand per` (all three prepositions are in use across AT/DE banks),
 *       so an `am`/`zum` statement's opening/closing balances feed the §3.5 completeness gate and those
 *       lines are dropped from the transaction stream instead of double-counting. Changes the persisted
 *       balances (and row set) on affected statements, so stale v4 rows re-extract.
 *   6 — skills-remediation R5 (audit §5.7): date correctness. `parseDate` now completes a 2-digit-year
 *       `dd.mm.yy` or a BARE `dd.mm.` date against the document year anchor (`inferDateAnchor`) — a
 *       plain/CSV statement that prints `dd.mm.yy` dates extracted ZERO rows before; and cross-year
 *       month-rollover assigns a December row on a January-anchored statement to the PREVIOUS year (both the
 *       geometry `toFullDate` and the plain path). Changes the persisted transaction dates (and the row set,
 *       since previously-dropped `dd.mm.yy` rows now parse) on affected statements, so stale v5 rows re-extract.
 *   7 — skills-remediation R6 (audit §5.7): wrapped descriptions. A dateless, money-less line that
 *       DIRECTLY follows a parsed transaction row is appended to that row's description as a bounded
 *       (single-line) continuation — the plain-text mirror of the geometry multi-baseline association
 *       (`pdf-layout.ts`) — so a merchant/payee name that wrapped to the next line (a `SEPA-Lastschrift`
 *       row whose `NETFLIX INTERNATIONAL…` payee printed on the line below) survives instead of being
 *       silently dropped (which degraded the categorizer and the listing). Changes the persisted
 *       description on affected statements (and thus the categorizer's input), so stale v6 rows re-extract.
 *   8 — skills-remediation U1 (audit §2.3): the extractor now records `droppedRowCount` — how many
 *       money-bearing lines it REJECTED (couldn't turn into a row) — so the answer can gate its "whole
 *       statement" claim honestly; and `lastMoneyOnLine` reads a currency-ADJACENT bare integer when
 *       MONEY_RE finds none, so a round `Opening balance 914 $` feeds the §3.5/D56 completeness gate
 *       instead of silently losing it. The new field + the recovered balances change the persisted output
 *       on affected statements, so stale v7 rows re-extract.
 *   9 — skills-audit-2026-07-03 R7 (SKA-1, SKA-2, SKA-13): a mid-line/trailing date can no longer be read
 *       as an amount. `parseLine` scans money via `scanMoneyWithBlankedDates` — a same-length date-BLANKED
 *       copy with each match's trailing sign re-validated against the original bytes (SKA-1) — so a
 *       period line `01.04.2026 bis 30.04.2026` no longer invents a transaction, a trailing date is never
 *       a phantom balance, and a blanked billing-period range never reads as a trailing debit minus; the
 *       shared `DATE_TOKEN_RE` scrub gained a double-guarded 2-digit-year alternative incl. terminal
 *       punctuation (SKA-2), so `Endsaldo 1.234,56 EUR per 31.03.26` reads the balance (not 3103.26) and a
 *       money-less dd.mm.yy period line no longer inflates `droppedRowCount`; `detectDocumentCurrency`
 *       additionally counts a code IMMEDIATELY left of a line's first figure (the per-row currency-cell
 *       layout, whose accidental vote the widened scrub had removed); and the geometry path
 *       (`pdf-layout.ts parseTransactionRow`) re-reads a yearless `d.dd` outside the Datum band as MONEY
 *       under four row-context guards (SKA-13), so a dot-decimal amount (`5.04`) on a CH/UK/US statement
 *       is no longer eaten as a date (balance-as-amount / silent row loss) while dotless Valuta dates and
 *       apostrophe/comma-decimal rows keep their safe legacy reads. Each changes persisted rows/balances
 *       on affected statements, so stale v8 rows re-extract.
 */
export const BANK_EXTRACTOR_VERSION = 9

const EXTRACT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    transactions: { type: 'array', items: TRANSACTION_ROW_SCHEMA, maxItems: MAX_TRANSACTIONS },
    // The detected statement currency, if any — a convenience for the orchestration seam (optional).
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    // Statement-level opening/closing balances for the completeness gate (§3.5, D56) — optional.
    openingBalance: { type: 'number' },
    closingBalance: { type: 'number' },
    // Whether the date ORDER was inferred from evidence or defaulted to day-first on ambiguous dates (R5,
    // audit §5.7) — persisted and surfaced as one honest answer caveat. Optional.
    dateOrderInferred: { type: 'string', enum: ['evidence', 'default'] },
    // How many money-bearing lines the extractor REJECTED (U1, audit §2.3) — gates the "whole statement"
    // claim in the answer. Optional; persisted to `bank_statements.dropped_row_count`.
    droppedRowCount: { type: 'integer', minimum: 0 }
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
  /** The statement's printed OPENING balance (Anfangssaldo / "balance brought forward"), if found. */
  openingBalance?: number
  /** The statement's printed CLOSING balance (Endsaldo / "balance carried forward"), if found. */
  closingBalance?: number
  /** Whether the date order rests on evidence or defaulted to day-first on ambiguous dates (R5, §5.7). */
  dateOrderInferred?: 'evidence' | 'default'
  /**
   * How many money-bearing lines the extractor REJECTED — a line that carries a money-shaped token
   * (`hasMoneyToken`) yet did NOT become a transaction row (an unparseable/currency-less/no-anchor-date
   * row, or a row dropped as an ambiguous balance-as-amount), U1 / audit §2.3. Persisted; when > 0 the
   * deterministic answer drops the "whole statement" claim for an honest "M lines could not be parsed".
   */
  droppedRowCount?: number
}

// ---- Deterministic parsing helpers (the money/date primitives are shared via `./money`) ----

// A description that ENDS in a bare numeric token — a digit run (with optional grouping separators and
// sign/paren) the 2-dp MONEY_RE rejected: a whole-euro `50`, a single-decimal `12,5`, a reference `1234`.
// Used by the F1 ambiguity flag (parseLine): when a row collapses to ONE money token AND its description
// ends in such a bare number, that number COULD be an uncaptured amount column (making the lone token the
// balance) OR payee text (making the lone token the amount). End-anchored so a number in the MIDDLE of a
// description (`Ref 50 Grocery`) — clearly payee text, not a column — never flags. The keep/drop decision
// is taken per-STATEMENT in `extractTransactionRows` (a flagged row is dropped only when the statement has
// a balance column), so a no-balance "Umsätze" listing with numeric payees (`REWE … 1234`) is preserved.
const DESC_TRAILING_NUMBER = /(?:^|\s)[-+(]?\d[\d.,']*[-)]?$/

// A line whose FIRST whitespace token is DATE-SHAPED — a dotted/slashed `d?d.m?m.[yy[yy]]` (bare/2-digit/
// 4-digit year) or an ISO `yyyy-mm-dd` — regardless of whether that date PARSES. Used ONLY by the U1
// dropped-row counter (audit §2.3): a transaction row dropped PURELY because its leading date could not be
// completed (a malformed calendar date, or a 2-digit/bare year with no document anchor) has
// `splitLeadingDates().dates.length === 0`, so a parse-gated check would silently miss it and let the answer
// keep its "whole statement" claim over a genuinely-dropped row. Matching the SHAPE (not the parse) counts it,
// while still excluding a memo / FX-reference continuation line whose DESCRIPTION leads (the geometry
// multi-baseline case). It is intentionally looser than a valid date: a mis-read `31.02.2026` still counts.
const LEADING_DATE_SHAPE_RE = /^(?:\d{1,2}[./]\d{1,2}[./]\d{0,4}|\d{4}-\d{2}-\d{2})(?=\s|$)/

/**
 * Parse one transaction line. Returns the row plus `ambiguousAmount` — true when the row has exactly one
 * money token AND its description ends in a bare number the 2-dp scan rejected (F1). On a statement with a
 * balance column that shape is almost certainly an uncaptured amount + a captured BALANCE, so the lone
 * token (recorded as `amount` here) would be the running balance read as the movement amount — the
 * cardinal "confidently-wrong money" harm. `extractTransactionRows` drops such rows ONLY when the
 * statement actually has a balance column; on a no-balance listing the lone token genuinely IS the amount.
 */
function parseLine(
  line: string,
  page: number | null,
  statementCurrency: string | null,
  order: DateOrder = 'dmy',
  anchor?: DateAnchor | null
): { row: ExtractedTransaction; ambiguousAmount: boolean } | null {
  // Strip the leading DATE column(s) before the money scan (BL-1): the FIRST is the booking date, a
  // SECOND consecutive date token is the value date (Wertstellung/Valuta). Reading only the first token
  // left a value-date column in `rest`, where MONEY_RE reads its `dd.mm.20yy` tail as a 2-decimal amount —
  // dropping the row (empty description) or mis-valuing it. `splitLeadingDates` consumes the whole leading
  // date run; the description then starts at the first non-date token. `order` is the per-document date
  // ordering (BL-N1), so a US `mm/dd/yyyy` booking date is recognised (not dropped) on a US statement.
  // `anchor` (R5) completes a 2-digit-year / bare leading date against the document's own year; without it
  // such a date parses to null and the row is dropped (drop-don't-guess) exactly as before.
  const { dates, rest } = splitLeadingDates(line, order, anchor)
  if (dates.length === 0) return null
  const date = dates[0]
  // SKA-1 (skills-audit-2026-07-03): scan money over a DATE-BLANKED copy of `rest`. `splitLeadingDates`
  // consumes only the LEADING date run, so a MID-LINE date stayed in `rest`, where MONEY_RE read its
  // `dd.mm.yy(yy)` tail as a 2-dp amount — a period line `01.04.2026 bis 30.04.2026` invented the
  // transaction `{description: "bis", amount: 30.04}` (the dd.mm.yy twin invented 3004.26), and a
  // TRAILING date became a phantom balance column. The blanking is SAME-LENGTH (spaces), so every match
  // index below stays valid in the ORIGINAL `rest`: the `description` slice and the figure-region
  // currency slice are byte-identical to before on any date-free row.
  const { matches } = scanMoneyWithBlankedDates(rest)
  if (matches.length === 0) return null
  // The figure boundary is the first NON-SPACE of the first match, not `match.index`: MONEY_RE tolerates
  // up to 4 leading spaces (`\s{0,4}`), and on the BLANKED scan those spaces can be a blanked date's TAIL
  // — slicing at `match.index` would chop those original bytes out of the description. On a date-free row
  // the skipped chars are real whitespace, so this is byte-identical to the pre-SKA-1 slice.
  const first = matches[0]
  const figureStart = first.index + (first.token.length - first.token.trimStart().length)
  // The description is the text before the FIRST money token (everything to the left of the figure run).
  const description = rest.slice(0, figureStart).trim()
  if (!description) return null
  // F1 (full-audit-2026-06-29-postmerge) — FLAG (don't yet drop) an ambiguous amount column. A whole-euro
  // amount (`50`) or single-decimal (`12,5`) is REJECTED by MONEY_RE (no 2-dp tail, not grouped), so a
  // `Sparen 50 1.234,56` row collapses to ONE money match — the BALANCE — and `matches[0]` would take the
  // running balance AS the amount. We can't disambiguate from a single line (the same shape is a no-balance
  // row whose payee ends in a number, `REWE … 1234 -19,15`), so the keep/drop is decided per-statement in
  // `extractTransactionRows` using whether a balance column exists. (The flag is the LEFT-side uncaptured
  // column because the bank amount is the second-to-last figure; the invoice path flags a RIGHT-side column
  // because it reads the line total as the LAST figure — `invoice.ts parseLineItem`.)
  // The F1 flag reads the BLANKED description tail (R7 review): a trailing VALUE-DATE in the description
  // (`REWE DANKT 02.03.2026 -19,15`) is knowably NOT an uncaptured amount column — the scan just blanked
  // it as a date — so it must not flag the row (which would silently drop it on any balance-column
  // statement). A genuine bare-number tail is never date-shaped and still flags.
  const ambiguousAmount = matches.length === 1 && DESC_TRAILING_NUMBER.test(blankDateTokens(description))
  // BL-N3 — choose the amount column by POSITION, not the first money token. With ≥2 figures the LAST is
  // the balance and the SECOND-TO-LAST is the movement amount; a money-shaped reference inside the
  // description (e.g. an "…100,00 EUR…" note) therefore no longer steals the amount (and its sign). With
  // exactly one figure there is no balance column, so that figure is the amount. (For the normal 2-figure
  // row the second-to-last IS the first, so this is byte-identical to before on every existing fixture.)
  const hasBalance = matches.length >= 2
  const amount = parseAmount(matches[hasBalance ? matches.length - 2 : 0].token)
  if (amount === null) return null
  // Per-row currency detection is restricted to the FIGURE REGION — the text from the FIRST money token
  // onward (audit BL-2). Scanning the whole line let a currency WORD in the free-text description (a EUR
  // row whose memo says "Netflix USD subscription") tag the row USD, growing the row-currency set so
  // summarizeCashflow/reconcileBalances/assessCompleteness all fell back to the mixed-currency refusal —
  // one description string silently suppressed totalling for the whole statement. A GENUINE foreign-
  // currency row prints its code/symbol NEXT TO the amount (inside the figure region), so it is still
  // detected and mixed-currency honesty is preserved (this is why we slice the figure region rather than
  // simply preferring statementCurrency, which would silently sum a truly-mixed line in one currency).
  const figureRegion = rest.slice(figureStart)
  const currency = detectCurrency(figureRegion) ?? statementCurrency
  if (!currency) return null
  const row: ExtractedTransaction = { date, description, amount, currency }
  // A value-date column (the second leading date), when present, is captured as `valueDate` — the
  // schema/CSV already carry it; the booking date (de-AT Buchungstag) is conventionally printed first.
  if (dates.length >= 2) row.valueDate = dates[1]
  if (hasBalance) {
    const bal = parseAmount(matches[matches.length - 1].token)
    if (bal !== null) row.balanceAfter = bal
  }
  if (page != null) row.sourcePage = page
  return { row, ambiguousAmount }
}

// ---- Statement-level opening/closing balance (PDF geometry-extraction plan §3.5, D56) ----
//
// The completeness gate's ONLY true proof is `opening + Σamounts == closing`, which needs a
// statement-level opening/closing balance we did not capture before. These are printed on labelled
// summary lines (NOT transaction rows — they carry no booking date, so `parseLine` ignores them). We
// scan for the label, then read the LAST money token on that line (the figure trails the label, and a
// date earlier on the line is skipped by taking the last token).

// `kontostand per/am/zum <date>` is the Raiffeisen "Mein ELBA" (and several other AT/DE banks') balance-
// line label: the statement prints the OPENING balance as `Kontostand per <period-start>` and the CLOSING
// balance as `Kontostand per <period-end>` — the SAME label for both. It therefore CANNOT be split by
// label alone, so it is kept OUT of the opening/closing lists below and disambiguated by DATE in
// `extractStatementBalances` (audit C-4): the earliest-dated line is the opening, the latest-dated is the
// closing; a lone such line is the closing only. It still belongs to `BALANCE_LABELS` so the line is
// dropped from the transaction stream. The `per` / `am` / `zum` prepositions are all in use across banks
// (audit §5.4): recognizing only `per` silently lost the completeness gate on an `am`/`zum` statement.
// NOT "Aktueller Kontostand" (the top-of-document restatement of the closing value — it would corrupt the
// opening).
const KONTOSTAND_LABELS: readonly string[] = ['kontostand per', 'kontostand am', 'kontostand zum']

/** Whether a lowercased line carries a dual-role `Kontostand per/am/zum` balance label. */
function isKontostandLine(lower: string): boolean {
  return KONTOSTAND_LABELS.some((l) => lower.includes(l))
}

/** Opening-balance label fragments (lowercased substrings), EN + DE for the de-AT target. */
const OPENING_LABELS: readonly string[] = [
  'opening balance', 'balance brought forward', 'previous balance', 'starting balance',
  'alter kontostand', 'alter saldo', 'anfangssaldo', 'saldovortrag', 'kontostand alt', 'saldo alt'
]

/** Closing-balance label fragments (lowercased substrings), EN + DE. */
const CLOSING_LABELS: readonly string[] = [
  'closing balance', 'balance carried forward', 'new balance', 'ending balance', 'final balance',
  'neuer kontostand', 'neuer saldo', 'endsaldo', 'schlusssaldo', 'kontostand neu', 'saldo neu'
]

/**
 * A printed opening/closing BALANCE line is a statement SUMMARY, not a transaction — even when it
 * carries a booking-column date and a figure (the Raiffeisen `Kontostand per 31.03.2026 35.037,04`
 * shape, which the geometry column model cannot distinguish from a transaction because the date sits in
 * the Datum column). Counting it as a transaction both inflates the row count and DOUBLE-COUNTS the
 * opening/closing into Σamounts, breaking the completeness tie — so the extractor drops any line
 * matching a balance label; `extractStatementBalances` still reads those same lines for the gate.
 */
const BALANCE_LABELS: readonly string[] = [...OPENING_LABELS, ...CLOSING_LABELS, ...KONTOSTAND_LABELS]

function isBalanceLabelLine(lowerLine: string): boolean {
  return BALANCE_LABELS.some((l) => lowerLine.includes(l))
}

/**
 * The last money token on a line as a number, or null when the line carries no parseable figure. Date
 * tokens are SCRUBBED first (BL-N2): a balance line shaped `Endsaldo 1.234,56 EUR per 30.06.2026` would
 * otherwise read the trailing date's `30.06.20` as the figure (→ 3006.20). Stripping handles a date at
 * EITHER end, so the de-AT date-FIRST `Kontostand per <date> <figure>` shape still reads its figure too.
 */
function lastMoneyOnLine(line: string): number | null {
  const matches = [...stripDateTokens(line).matchAll(MONEY_RE)]
  if (matches.length > 0) return parseAmount(matches[matches.length - 1][0])
  // U1 (audit §2.3): a balance printed as a ROUND currency-adjacent integer (`Opening balance 914 $`,
  // `Kontostand 1 000 EUR`) has no MONEY_RE match — read the last currency-adjacent bare integer so the
  // §3.5/D56 completeness gate isn't silently lost on this extremely common layout (mirror of the
  // invoice `totalsMoney` fallback, now the shared `lastCurrencyAdjacentInteger`).
  return lastCurrencyAdjacentInteger(line)
}

/** The first whitespace-token on a line that parses as a date (ISO `YYYY-MM-DD`), or null. `anchor` (R5)
 *  completes a 2-digit-year / bare date against the document year; without it those parse to null as before. */
function firstDateOnLine(line: string, order: DateOrder = 'dmy', anchor?: DateAnchor | null): string | null {
  for (const token of line.split(/\s+/)) {
    const d = parseDate(token, order, anchor)
    if (d) return d
  }
  return null
}

/**
 * Extract the statement-level opening/closing balances from the read text (pure, deterministic).
 * Explicit opening/closing labels (Anfangssaldo / Endsaldo, …) take the FIRST labelled opening line and
 * the LAST labelled closing line (a closing/"new balance" is often repeated in a footer summary — the
 * last wins). The Raiffeisen `Kontostand per <date>` label is BOTH opening and closing, so it is
 * disambiguated by DATE (audit C-4): with two distinct-dated such lines the earliest is the opening and
 * the latest is the closing; a single such line (no pair to bracket the period) is the CLOSING ONLY (the
 * opening stays undefined → the §3.5 gate downgrades to an honest labelled sum, not a false refusal).
 * Explicit labels win over the date-derived pair where both appear. Returns only what is confidently
 * found; a missing balance stays undefined and the completeness gate (§3.5) then downgrades to honesty.
 */
export function extractStatementBalances(
  chunks: DocumentChunkRead[],
  order?: DateOrder,
  anchor?: DateAnchor | null
): {
  openingBalance?: number
  closingBalance?: number
} {
  // R1 (audit §5.3): normalize Unicode side-doors before any money/date scan (mirrors extractTransactionRows).
  const texts = chunks.map((c) => normalizeExtractionText(c.text))
  // Per-document date ordering (BL-N1) — so a US-ordered `Kontostand per <date>` line sorts correctly. The
  // year anchor (R5) is resolved here too (default) so a bare/2-digit balance-line date completes; when the
  // caller passes both (the extract tool), the recompute is skipped.
  const joined = texts.join('\n')
  const dateOrder = order ?? inferDateOrder(joined)
  const dateAnchor = anchor ?? inferDateAnchor(joined, dateOrder)
  let explicitOpening: number | undefined
  let explicitClosing: number | undefined
  // Every `Kontostand per <date>` line with its (parsed) period date — resolved to opening/closing below.
  const kontostand: { date: string | null; value: number }[] = []
  for (const text of texts) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const lower = line.toLowerCase()
      if (isKontostandLine(lower)) {
        // A dual-role label — never matched against the opening/closing lists; resolved by date below.
        const value = lastMoneyOnLine(line)
        if (value !== null) kontostand.push({ date: firstDateOnLine(line, dateOrder, dateAnchor), value })
        continue
      }
      if (explicitOpening === undefined && OPENING_LABELS.some((l) => lower.includes(l))) {
        const v = lastMoneyOnLine(line)
        if (v !== null) explicitOpening = v
      }
      if (CLOSING_LABELS.some((l) => lower.includes(l))) {
        const v = lastMoneyOnLine(line)
        if (v !== null) explicitClosing = v // last labelled closing line wins
      }
    }
  }

  // Resolve the `Kontostand per` lines by date. A period is bracketed only when two such lines carry
  // DISTINCT dates (earliest = opening, latest = closing). A single line — or several sharing one date —
  // cannot bracket a period, so it is the CLOSING only (last in document order); the opening stays
  // undefined so the gate downgrades to `unverified` rather than reading opening == closing and refusing.
  let kontostandOpening: number | undefined
  let kontostandClosing: number | undefined
  if (kontostand.length > 0) {
    const dated = kontostand.filter((k): k is { date: string; value: number } => k.date !== null)
    const sorted = [...dated].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (sorted.length >= 2 && sorted[0].date < sorted[sorted.length - 1].date) {
      kontostandOpening = sorted[0].value
      kontostandClosing = sorted[sorted.length - 1].value
    } else {
      kontostandClosing = kontostand[kontostand.length - 1].value
    }
  }

  // Explicit opening/closing labels take precedence; the date-derived pair fills any slot they leave open.
  const openingBalance = explicitOpening ?? kontostandOpening
  const closingBalance = explicitClosing ?? kontostandClosing
  const out: { openingBalance?: number; closingBalance?: number } = {}
  if (openingBalance !== undefined) out.openingBalance = openingBalance
  if (closingBalance !== undefined) out.closingBalance = closingBalance
  return out
}

/**
 * The refined §3.5 / D56 completeness assessment — THREE outcomes, not a boolean, because the absence
 * of a printed balance and a CONTRADICTED printed balance deserve different answers (the original gate
 * conflated them, refusing a perfectly honest sum on a balance-less "Umsätze" listing):
 *
 *  - `'complete'`     — the statement PRINTS opening + closing and they tie out against the rows
 *                       (`opening + Σamounts == closing` within half a cent) AND no per-row running
 *                       balance contradicts. The total is provably the WHOLE statement → present it.
 *  - `'contradicted'` — the document makes a balance CLAIM the rows refute: a per-row running balance
 *                       mismatches (a read error), OR a printed opening+closing pair that does NOT tie
 *                       out. The read is suspect → refuse a total (a mis-read/partial sum could
 *                       masquerade as the whole — the cardinal D56 harm).
 *  - `'unverified'`   — NO opening+closing pair to tie against AND no per-row mismatch. The document
 *                       never CLAIMS a statement total, so it cannot be CONTRADICTED; an honestly
 *                       LABELLED sum over "the rows I read" is correct and useful (NOT a partial sum
 *                       dressed up as the statement total). The caller presents figures WITH a caveat.
 *
 * A clean per-row chain is NECESSARY-not-sufficient for `'complete'` (rows dropped past the last
 * printed balance leave the chain intact), so it is never the proof on its own — `'complete'` still
 * requires the printed opening+closing tie.
 */
export type CompletenessStatus = 'complete' | 'unverified' | 'contradicted'

export function assessCompleteness(args: {
  rows: TransactionInput[]
  openingBalance?: number
  closingBalance?: number
  reconcile: ReconcileResult
}): CompletenessStatus {
  const { rows, openingBalance, closingBalance, reconcile } = args
  // The completeness tie sums every amount into ONE figure to compare against a single opening/closing
  // pair — meaningful only when every row shares a currency (mirror summarizeCashflow's single-currency
  // guard; audit BL-2). On a mixed-currency statement that sum is a meaningless cross-currency figure, so
  // we never claim 'complete' OR 'contradicted' from it — the honest verdict is 'unverified'. (The bank
  // answer already suppresses any total for mixed currency; this keeps the public predicate honest for
  // any other caller too.) An empty / single-currency statement falls through to the real assessment.
  if (new Set(rows.map((r) => r.currency)).size > 1) return 'unverified'
  // A per-row running balance that contradicts is a read error — suspect regardless of summary balances.
  if (reconcile.rows.some((r) => r.status === 'mismatch')) return 'contradicted'
  // No statement-level opening+closing pair to tie against: nothing claimed → nothing contradicted.
  if (openingBalance === undefined || closingBalance === undefined) return 'unverified'
  // Both balances printed: they MUST tie out, else the document's own claim is contradicted. Sum and
  // compare in INTEGER CENTS, not floats (audit C-3): a float `reduce(acc + amount)` over thousands of
  // 2-dp rows accumulates representation error that can drift `opening + Σ − closing` past MONEY_EPS and
  // flip a genuinely-tying statement to `contradicted`. Every figure is exactly 2-dp (MONEY_RE ends in
  // `[.,]\d{2}`), so `Math.round(x*100)` is its exact cent value and the tie is an EXACT integer test
  // (the faithful, drift-free equivalent of the old `< 0.005`, since 2-dp figures differ by whole cents).
  const toCents = (n: number): number => Math.round(n * 100)
  const sumCents = rows.reduce((acc, r) => acc + toCents(r.amount), 0)
  return toCents(openingBalance) + sumCents === toCents(closingBalance) ? 'complete' : 'contradicted'
}

/**
 * The boolean "provably WHOLE" predicate — `assessCompleteness(...) === 'complete'`. Retained because
 * the gate's hardest property (a clean chain is necessary-not-sufficient; a printed-but-contradicted
 * balance is never complete) is pinned by name in the unit tests, and a `'complete'` total is the only
 * one presented as the verified statement total. When this returns false the caller MUST NOT present a
 * total AS the statement total — it either honestly downgrades (`'contradicted'`) or presents a clearly
 * labelled sum of the rows read (`'unverified'`); see `buildBankAnswer`.
 */
export function isStatementComplete(args: {
  rows: TransactionInput[]
  openingBalance?: number
  closingBalance?: number
  reconcile: ReconcileResult
}): boolean {
  return assessCompleteness(args) === 'complete'
}

/**
 * Whether a line is a pure DESCRIPTION continuation — the wrapped payee/purpose of the row above. It
 * carries NO leading booking date (a leading date would make it its own transaction) and NO money token
 * (a figure would be a running-balance / FX / footer annotation, not payee text). Mirror of the geometry
 * `continuationText` guard on the plain-text path (R6, audit §5.7). `anchor` completes a 2-digit / bare
 * date so a wrapped-looking `dd.mm.` line that is actually a booking row is NOT absorbed as text.
 */
function isDescriptionContinuation(line: string, order: DateOrder, anchor?: DateAnchor | null): boolean {
  if (splitLeadingDates(line, order, anchor).dates.length > 0) return false
  return [...line.matchAll(MONEY_RE)].length === 0
}

/**
 * Pure extractor + completeness stats: the fully-valid rows AND `droppedRowCount` — how many money-bearing
 * lines the parser REJECTED (U1, audit §2.3). A rejected line is one that carries a money-shaped token
 * (`hasMoneyToken`) yet did not become a row: an unparseable / currency-less / no-anchor-date row, or a row
 * later dropped as an ambiguous balance-as-amount. Counting them lets the answer gate its "whole statement"
 * claim instead of asserting exhaustiveness while silently dropping figures. `extractTransactionRows` is the
 * rows-only wrapper the tools/tests keep calling (unchanged signature).
 */
export function extractTransactionsWithStats(
  chunks: DocumentChunkRead[],
  statementCurrency: string | null,
  order?: DateOrder,
  anchor?: DateAnchor | null
): { rows: ExtractedTransaction[]; droppedRowCount: number } {
  // R1 (audit §5.3): normalize Unicode side-doors (U+2212 minus family, NBSP thousands-space family,
  // U+2019 apostrophe) ONCE at the entry so every downstream regex (MONEY_RE, date scans) sees ASCII.
  const texts = chunks.map((c) => normalizeExtractionText(c.text))
  // Infer the document's date ordering ONCE over the whole (normalized) text (BL-N1) so a US-ordered
  // statement parses mm/dd consistently across rows (no silent drop of day>12 rows, no wrong month). The
  // year anchor (R5) — resolved here by default, or supplied by the extract tool — completes 2-digit / bare
  // dates against the document's own year; without an anchor those rows drop exactly as before.
  const joined = texts.join('\n')
  const dateOrder = order ?? inferDateOrder(joined)
  const dateAnchor = anchor ?? inferDateAnchor(joined, dateOrder)
  const parsed: { row: ExtractedTransaction; ambiguousAmount: boolean }[] = []
  // U1 (audit §2.3): money-bearing lines the parser could not turn into a row (the honesty signal).
  let droppedWithFigure = 0
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    // R6 (audit §5.7): a dateless, money-less line that DIRECTLY follows a parsed row is a wrapped
    // continuation of that row's payee/purpose (the plain-text mirror of the geometry multi-baseline
    // association). It is appended to the pending row's description so a merchant name that wrapped once
    // survives (it was silently dropped before). The pending row is closed by the next parsed row, a
    // balance-label line, a blank line, any other non-continuation line, or the end of this SEGMENT.
    // `pending` is scoped PER CHUNK: each chunk is one page on the real path (segments map 1:1 to pages),
    // and a wrapped payee always prints on the SAME page as its booking row — so it must NOT survive the
    // segment boundary (else a page-2 running header / footer would glue onto page-1's last row). This
    // mirrors the geometry `reconstructPage`, which keeps its pending LOCAL and flushes it at page end.
    let pending: { row: ExtractedTransaction; absorbed: number } | null = null
    for (const rawLine of texts[ci].split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) {
        pending = null // a blank line breaks a wrapped-description run
        continue
      }
      // A printed opening/closing balance line is a summary, not a transaction — skip it even though
      // it may carry a booking-column date + figure (it is read by `extractStatementBalances` instead).
      // It also CLOSES any pending row (a summary line is never a payee continuation).
      if (isBalanceLabelLine(line.toLowerCase())) {
        pending = null
        continue
      }
      const p = parseLine(line, chunk.page, statementCurrency, dateOrder, dateAnchor)
      if (p) {
        parsed.push(p)
        pending = { row: p.row, absorbed: 0 }
        if (parsed.length >= MAX_TRANSACTIONS) break
        continue
      }
      // Not a parsed row: when it carries no leading date and no money token it is a wrapped payee
      // continuation of the row above — append it to that row's description (bounded). Anything else
      // (a header line, a figure-bearing annotation) closes the pending row instead.
      if (
        pending &&
        pending.absorbed < MAX_PLAIN_CONTINUATION_ROWS &&
        isDescriptionContinuation(line, dateOrder, dateAnchor)
      ) {
        pending.row.description = `${pending.row.description} ${line}`.trim()
        pending.absorbed++
        continue
      }
      // U1 (audit §2.3): a rejected, non-continuation line that looks like a TRANSACTION the parser could
      // not read — a DATE-SHAPED leading token AND a money-shaped token — is counted, so the answer gates its
      // "whole statement" claim (a currency-less row, an empty-description figure row, a fused-amount row, OR
      // a row dropped purely because its leading date failed to PARSE — a mis-read/no-anchor date). The
      // leading-date-SHAPE test is load-bearing: it excludes a money-LESS header/period line AND a memo /
      // FX-reference continuation line (a Valuta+foreign-currency second baseline whose DESCRIPTION leads, so
      // it carries no leading date token) — those carry figures but were never transactions, so counting them
      // would falsely gate a correctly-read statement (the geometry multi-baseline case). SHAPE (not parse) so
      // a `31.02.2026`/`03.05.26`-no-anchor booking row still counts (parse-gated it would silently miss it).
      if (LEADING_DATE_SHAPE_RE.test(line) && hasMoneyToken(line)) droppedWithFigure++
      pending = null
    }
    if (parsed.length >= MAX_TRANSACTIONS) break
  }
  // F1 — drop ambiguous single-amount rows ONLY when the statement has a balance column. A row flagged
  // `ambiguousAmount` (one money token + a bare-number-trailing description) is an uncaptured-amount /
  // balance-read-as-amount hazard ONLY when the statement prints running balances (so the lone token is a
  // BALANCE); on a no-balance "Umsätze" listing the lone token genuinely IS the amount and a numeric payee
  // (`REWE … 1234`) must be kept. `hasBalanceColumn` is established by the unambiguous (≥2-figure) rows.
  const hasBalanceColumn = parsed.some((p) => p.row.balanceAfter !== undefined)
  const kept = parsed.filter((p) => !(p.ambiguousAmount && hasBalanceColumn))
  // An ambiguous row DROPPED here is also a money-bearing line the parser could not confidently keep — fold
  // it into the completeness signal (U1), so a statement whose rows were dropped for ambiguity is honest.
  const ambiguousDropped = parsed.length - kept.length
  return { rows: kept.map((p) => p.row), droppedRowCount: droppedWithFigure + ambiguousDropped }
}

/** Pure extractor over already-read chunks — emits only fully-valid rows (ambiguous lines dropped). The
 *  rows-only wrapper over `extractTransactionsWithStats` (the tools/tests call this; the extract tool reads
 *  the stats variant for `droppedRowCount`). */
export function extractTransactionRows(
  chunks: DocumentChunkRead[],
  statementCurrency: string | null,
  order?: DateOrder,
  anchor?: DateAnchor | null
): ExtractedTransaction[] {
  return extractTransactionsWithStats(chunks, statementCurrency, order, anchor).rows
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
    // R1 (audit §5.3): normalize Unicode side-doors before the currency vote / date-order inference read
    // MONEY_RE over this text (the extractors normalize their own chunk copies independently; idempotent).
    const joined = normalizeExtractionText(chunks.map((c) => c.text).join('\n'))
    // FIN-1 — the statement-level currency by MAJORITY VOTE over figure-adjacent detections (not the old
    // `detectCurrency(joined)` "first code anywhere wins", which let a stray code in a payee memo stamp the
    // whole statement — and its verified total — in the wrong currency). This is the per-row fallback for
    // bare-amount rows AND the reported `output.currency`; per-row detection still tags figure-adjacent
    // foreign rows, so a genuinely-mixed statement still reaches the mixed/unverified path.
    const statementCurrency = detectDocumentCurrency(joined)
    // Infer the document's date ordering ONCE and hand it to both extractors so they agree (BL-N1). R5: also
    // resolve the year ANCHOR once (2-digit / bare date completion + cross-year rollover) and record whether
    // the order rests on evidence or defaulted to day-first on ambiguous dates (`dateOrderInferred`).
    const { order: dateOrder, inferred: dateOrderInferred } = inferDateOrderResult(joined)
    const dateAnchor = inferDateAnchor(joined, dateOrder)
    const { rows: transactions, droppedRowCount } = extractTransactionsWithStats(
      chunks,
      statementCurrency,
      dateOrder,
      dateAnchor
    )
    const balances = extractStatementBalances(chunks, dateOrder, dateAnchor)
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    const output: ExtractTransactionsOutput = { transactions, dateOrderInferred, droppedRowCount }
    if (statementCurrency) output.currency = statementCurrency
    if (balances.openingBalance !== undefined) output.openingBalance = balances.openingBalance
    if (balances.closingBalance !== undefined) output.closingBalance = balances.closingBalance
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
  /**
   * The row's PERSISTED category name, when a categorize run assigned one (result-tables plan §3,
   * D61). Travels WITH the row so the CSV/JSON serializers can emit it without an index-matched
   * parallel array crossing a seam. OPTIONAL and never produced by the extractor — a category is a
   * label, not a figure; tools that don't read it are unaffected.
   */
  category?: string
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
 * The expected balance for a row with a printed `balanceAfter` is the last printed balance PLUS every
 * amount booked since (the gap-row amounts AND this row's amount), so a row is `ok` only when its printed
 * balance agrees with the computed one to the cent, and `mismatch` when they disagree.
 *
 * A balance-bearing row is `unknown` when its predecessor printed no balance to anchor against —
 * including the **baseline** row (the first row, or the first after a balance-less run with no prior
 * printed balance): with nothing to compare against, the baseline has NOT been genuinely checked, so it
 * is `unknown`, never counted as `ok`. Counting the baseline as a pass would let a single-transaction
 * statement report `reconciled: true` having verified nothing — at odds with the §22-D1 "say so plainly
 * / don't paper over" honesty posture. `reconciled` is therefore true only when no row mismatched AND at
 * least one row was actually compared against a predecessor (`okCount > 0`).
 *
 * **Balance-less rows still ADVANCE the chain (full-audit-2026-06-30 C1).** A mid-statement row can carry
 * a real `amount` but no printed `balanceAfter` — same-day grouping (the bank prints the running balance
 * only on the day's last line) or an OCR-dropped balance cell. Such a row is reported `unknown` (it prints
 * no balance of its own to check), but its amount is carried in a `sinceLastPrinted` cents accumulator and
 * folded into the NEXT printed balance's expected value. The earlier code dropped the gap row from the
 * chain entirely (it advanced `prevBalance` only on a printed balance), so the next balance-bearing row was
 * judged against a stale predecessor with the gap amount OMITTED → a FALSE `mismatch` → `assessCompleteness`
 * returned `'contradicted'` and a correct, verifiable total was withheld from the user (the inverse of the
 * confidently-wrong harm, equally trust-damaging). Since `amount` is a required `number` on every row
 * (`TransactionInput`/the schema), the chain is never "genuinely broken" by a missing amount, so there is
 * no revert-to-`unknown`-on-missing-amount branch to write; a real read error still surfaces as a
 * `mismatch` when the carried total disagrees with a printed balance.
 */
export function reconcileBalances(rows: TransactionInput[]): ReconcileResult {
  // The running-balance chain (`prevBalance + amount`) is only meaningful WITHIN one currency; a
  // mixed-currency statement would add an amount in one currency onto a balance printed in another
  // (audit BL-2). Report every row `unknown` (nothing genuinely checked, never reconciled) rather than a
  // spurious ok/mismatch — mirrors the single-currency guard in summarizeCashflow/assessCompleteness.
  if (new Set(rows.map((r) => r.currency)).size > 1) {
    return { reconciled: false, rows: rows.map((_, i) => ({ index: i, status: 'unknown' as const })) }
  }
  // Compare in INTEGER CENTS, not a float epsilon (BL-N5) — the SAME `Math.round(x*100)` path
  // `assessCompleteness` uses (audit C-3). Every figure is exactly 2-dp, so the cent value is exact and
  // the running-balance check is an exact integer test; a per-row float epsilon could otherwise flip the
  // very gate the integer sum was made to stabilise (a `mismatch` forces `assessCompleteness` to
  // `contradicted`). Faithful to the old `< MONEY_EPS` for 2-dp figures (they differ by whole cents).
  const toCents = (n: number): number => Math.round(n * 100)
  const out: ReconcileRow[] = []
  let prevBalance: number | null = null
  // Cents booked since the last PRINTED balance — the amounts of any balance-less gap rows that must be
  // folded into the next printed balance's expected value (C1). Reset whenever a printed balance lands.
  let sinceLastPrinted = 0
  let okCount = 0
  let mismatchCount = 0
  rows.forEach((row, i) => {
    const printed = row.balanceAfter
    let status: ReconcileStatus
    if (printed === undefined) {
      // Balance-less row: not a check on its own (it prints no balance to compare), but its amount still
      // advances the chain so the next printed balance ties out. Honest verdict: `unknown` (not checked).
      status = 'unknown'
      sinceLastPrinted += toCents(row.amount)
    } else if (prevBalance === null) {
      // Baseline row: a printed balance with no predecessor balance to compare against. NOT a genuine
      // check — flagged `unknown` so a lone baseline can never report `reconciled: true`. Any amounts
      // booked before the first printed balance can't be tied to anything, so discard the accumulator.
      status = 'unknown'
      sinceLastPrinted = 0
    } else {
      const expected = toCents(prevBalance) + sinceLastPrinted + toCents(row.amount)
      if (toCents(printed) === expected) {
        status = 'ok'
        okCount++
      } else {
        status = 'mismatch'
        mismatchCount++
      }
      sinceLastPrinted = 0
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
  /**
   * German closed-compound keyword (full-audit-2026-06-29 BL-3): match INSIDE a compound (a one-sided
   * word boundary via `wordIncludes(..., true)`) because German fuses keywords into closed compounds
   * (`kontoführungs+gebühr`). Off (default) keeps the STRICT two-sided boundary for short, ambiguous
   * English tokens (`fee`⊂`coffee`, `atm`⊂`atmos`) and for `lohn` (⊂`muehlohn`/`Belohnung`). The flag is
   * matching-only — `run.ts` seeds just `match_kind`/`pattern` into `bank_category_rules` (transparency),
   * so it is not persisted.
   */
  compound?: boolean
  /**
   * Whether a match on this rule is CONFIDENT enough to skip the LLM categorizer (R3 / audit §5.5).
   * Defaults to true (omitted ⇒ confident): a keyword like `gebühr`/`gehalt` unambiguously names one
   * bucket, so `prefilterCategory` returns it and the model is never consulted for that row. Set FALSE
   * for transfer-BOILERPLATE patterns (`sepa`, `überweisung`) that merely describe the RAILS a payment
   * rode, not what it was — Netflix, rent and a doctor refund all carry "SEPA" and must reach the
   * 15-category model when a runtime is loaded. A non-confident rule stays in `categorizeRow` (the
   * deterministic NO-model fallback still labels them 'Transfer' offline), but `prefilterCategory`
   * ignores it so those rows go to the model instead of being vetoed by boilerplate.
   */
  confident?: boolean
}

export const UNCATEGORIZED = 'Uncategorized'

/**
 * The built-in, deterministic categorization rules (offline, no ML). Applied in order — the first
 * match wins; a row that matches nothing falls back by sign (negative → Spending, else
 * Uncategorized). Substring matches are case-insensitive; EN + DE keywords for the de-AT target.
 */
// `compound: true` marks the UNAMBIGUOUS German keywords that must match inside a closed compound (BL-3):
// gebühr/gehalt/überweisung/bargeld. The short English tokens (fee/charge/atm/…) and the ambiguous
// `lohn` (⊂ muehlohn/Belohnung) stay STRICT — income from salary is still covered by the positive-amount
// sign fallback, so `lohn` need not (and must not) be relaxed.
// `confident: false` marks TRANSFER-BOILERPLATE (`sepa`, `überweisung`, and — SKA-44, R9 — the EN
// `transfer`): these describe the payment RAILS, not the merchant, so most de-AT rows carry the German
// pair and every EN wire/standing-order row carries "transfer" ("TRANSFER TO NETFLIX…" is a Netflix
// charge, not a 'Transfer'; R3 was scoped de-AT and left the EN twin confident — same semantics, same
// treatment). They stay here as the deterministic NO-model fallback (`categorizeRow` still labels them
// 'Transfer' offline) but `prefilterCategory` skips them, so with a runtime loaded those rows reach the
// 15-category LLM instead of collapsing into 'Transfer'.
export const BUILTIN_CATEGORY_RULES: readonly CategoryRule[] = [
  { category: 'Fees', matchKind: 'description-substring', pattern: 'fee' },
  { category: 'Fees', matchKind: 'description-substring', pattern: 'gebühr', compound: true },
  { category: 'Fees', matchKind: 'description-substring', pattern: 'charge' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'salary' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'gehalt', compound: true },
  { category: 'Income', matchKind: 'description-substring', pattern: 'lohn' },
  { category: 'Income', matchKind: 'description-substring', pattern: 'payroll' },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'transfer', confident: false },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'überweisung', compound: true, confident: false },
  { category: 'Transfer', matchKind: 'description-substring', pattern: 'sepa', confident: false },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'atm' },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'bargeld', compound: true },
  { category: 'Cash', matchKind: 'description-substring', pattern: 'withdrawal' },
  { category: 'Income', matchKind: 'amount-sign', pattern: 'positive' }
]

/** Every built-in category name (seed set for `bank_categories`), insertion order, deduped. */
export const BUILTIN_CATEGORIES: readonly string[] = [
  ...new Set([...BUILTIN_CATEGORY_RULES.map((r) => r.category), 'Spending', UNCATEGORIZED])
]

/**
 * Assign one row a category name deterministically (pure). First matching rule wins; sign fallback.
 * Description rules match on WORD boundaries (shared `wordIncludes`, not a raw `includes`), so a
 * coincidental substring no longer mis-files (`coffee`→Fees, `atmosphere`→Cash, `mühlohn`→Income) and
 * this deterministic path AGREES with the LLM `prefilterCategory` on the same rules (audit C-1).
 */
export function categorizeRow(row: TransactionInput): string {
  const desc = row.description.toLowerCase()
  for (const rule of BUILTIN_CATEGORY_RULES) {
    if (rule.matchKind === 'description-substring') {
      if (wordIncludes(desc, rule.pattern, rule.compound)) return rule.category
    } else if (rule.pattern === 'positive' && row.amount > 0) {
      return rule.category
    } else if (rule.pattern === 'negative' && row.amount < 0) {
      return rule.category
    }
  }
  // Sign fallback: a negative amount is Spending; a positive one was caught by the amount-sign rule
  // above, so reaching here means amount is zero → Uncategorized. A `0.00` row is therefore neither
  // inflow nor outflow — the convention summarizeCashflow now shares (full-audit-2026-06-30 C5).
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
 * Sum inflows / outflows / net over the rows (pure, deterministic). `totalIn` is the sum of POSITIVE
 * amounts, `totalOut` the absolute sum of NEGATIVE amounts; `net` is the signed sum. A genuine `0.00`
 * row is neither inflow nor outflow (full-audit-2026-06-30 C5): the prior `amount >= 0` test counted it
 * as inflow while `categorizeRow` files it `Uncategorized` (neither Income nor Spending), so the two
 * surfaces disagreed for the same row. Aligning on `> 0` / `< 0` makes the convention consistent (the
 * figure is zero, so the reported totals are unchanged either way). The currency is reported only when
 * EVERY row shares one (mixed-currency statements report none rather than implying a meaningless total).
 */
export function summarizeCashflow(rows: TransactionInput[]): CashflowSummary {
  let totalIn = 0
  let totalOut = 0
  const currencies = new Set<string>()
  for (const row of rows) {
    if (row.amount > 0) totalIn += row.amount
    else if (row.amount < 0) totalOut += -row.amount // a 0.00 row is neither inflow nor outflow (C5)
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

/** Whether ANY row carries a persisted category — the presence gate (D62) both serializers share:
 *  a never-categorized statement keeps its byte-identical 7-column shape (an always-empty
 *  `category` column would imply "categorized, all blank" — dishonest). */
export function rowsCarryCategories(rows: readonly TransactionInput[]): boolean {
  return rows.some((r) => r.category !== undefined)
}

/**
 * The statement rows as a generic `TableSpec` (result-tables plan §3/§4): the SINGLE column
 * definition every tabular surface shares — the inline format answer, the confirm-gated file
 * export, and the persisted per-message result table. The `category` column is presence-gated
 * (D62).
 */
export function transactionsTableSpec(rows: TransactionInput[]): TableSpec<TransactionInput> {
  const columns: TableColumn[] = [
    { key: 'date', label: 'date' },
    { key: 'valueDate', label: 'valueDate' },
    { key: 'description', label: 'description' },
    // Fixed 2-dp decimal with a dot — a stable, locale-free CSV number (not a re-printed figure).
    { key: 'amount', label: 'amount', kind: 'money' },
    { key: 'currency', label: 'currency' },
    { key: 'balanceAfter', label: 'balanceAfter', kind: 'money' },
    { key: 'sourcePage', label: 'sourcePage', kind: 'integer' }
  ]
  if (rowsCarryCategories(rows)) columns.push({ key: 'category', label: 'category' })
  return { columns, rows }
}

/**
 * Serialize the rows to CSV text (pure — no FS) via the generic `TableSpec` path (result-tables
 * plan §3, D60): the columns are data, not code, so both CSV surfaces (the inline format answer
 * and the confirm-gated file export) emit whatever columns the rows actually carry.
 */
export function transactionsToCsv(rows: TransactionInput[]): string {
  return tableToCsv(transactionsTableSpec(rows))
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

// ---- JSON serializer (W4, audit §3.3 — bank format parity with the invoice handler) ----
//
// Pure format transformation of the ALREADY-EXTRACTED statement — the deterministic, honest-by-type-
// safety answer to "give me this statement as JSON" (the bank half of what invoice got at
// invoice-format-2026-07-01). Mirrors `buildInvoiceJson`: it serializes the SAME rows the extractor
// produced + the deterministic cashflow summary + the persisted opening/closing balances (no model call,
// no invented figure — a serializer cannot read a number the parser did not; the §22-D1 posture holds by
// construction). CSV parity is the existing `transactionsToCsv` (transaction rows only, matching the
// export). Emits a STABLE shape (absent fields explicit `null`) so a downstream consumer sees a
// predictable schema; numbers keep the extractor's 2-dp cent invariant.

/** The read-side view the bank JSON serializer + the grounded-data block are built from: the extracted
 *  rows, the deterministic cashflow summary, and the statement's printed opening/closing balances. */
export interface StatementSnapshot {
  rows: TransactionInput[]
  summary: CashflowSummary
  openingBalance?: number
  closingBalance?: number
}

/** The canonical plain object the JSON serializer emits — a stable shape (nulls for absent fields). */
function statementToPlainObject(snap: StatementSnapshot): Record<string, unknown> {
  const { rows, summary, openingBalance, closingBalance } = snap
  return {
    openingBalance: openingBalance ?? null,
    closingBalance: closingBalance ?? null,
    // Reported only when EVERY row shares one currency (mixed → null); mirrors summarizeCashflow (BL-2).
    currency: summary.currency ?? null,
    summary: {
      totalIn: summary.totalIn,
      totalOut: summary.totalOut,
      net: summary.net,
      count: summary.count,
      currency: summary.currency ?? null
    },
    transactions: rows.map((r) => {
      const tx: Record<string, unknown> = {
        date: r.date,
        valueDate: r.valueDate ?? null,
        description: r.description,
        amount: r.amount,
        currency: r.currency,
        balanceAfter: r.balanceAfter ?? null,
        sourcePage: r.sourcePage ?? null
      }
      // Same presence gate as the CSV (D62): the field appears only when the statement actually
      // carries categories, so a never-categorized statement keeps its stable prior shape.
      if (rowsCarryCategories(rows)) tx.category = r.category ?? null
      return tx
    })
  }
}

/** Serialize the extracted statement to pretty-printed JSON (2-space indent). Pure — no FS, no model. */
export function buildStatementJson(snap: StatementSnapshot): string {
  return JSON.stringify(statementToPlainObject(snap), null, 2)
}
