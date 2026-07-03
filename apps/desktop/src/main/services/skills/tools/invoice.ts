import type { DocumentChunkRead, JsonSchema, SkillTool, ToolResult } from '../../../../shared/types'
import {
  MONEY_EPS,
  MONEY_RE,
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
  type DateAnchor,
  type DateOrder
} from './money'

// Invoice Tier-2 tools — the SECOND Tier-2 content-class domain (architecture.md "Skills — design
// record" §8). It mirrors the bank-statement tools layer-for-layer to prove the gate generalizes:
// pure main-side TS (no node:fs, no network, no native deps, no Db/SQL handle — CLAUDE.md §0 / the
// §14 ceiling), DETERMINISTIC + OFFLINE parsing, and the §22-D1 honesty posture — it quotes only what
// it can confidently parse and DROPS the ambiguous rather than inventing a figure. Invoice parse
// quality is a known limitation that improves later, so the parsers are CONSERVATIVE, not clever:
// header fields and totals are read from labeled lines only; a line/total that cannot be parsed is
// dropped. The deterministic money/date/CSV primitives are SHARED with bank-statement via `./money`.
//
// The extractor's only content reach is `ctx.readDocumentChunks` over the FROZEN selected-doc scope;
// the downstream tools (validate/export) receive the ALREADY-EXTRACTED invoice as STRUCTURED INPUT
// from the run seam (no new SkillToolContext accessor — the ceiling does not widen). Persistence and
// the user-gated CSV file write live in the seam, not here; these tools are content-free of side
// effects.

// ---- The structured invoice (the output contract + the downstream-input contract) ----

export interface InvoiceHeader {
  vendor?: string
  invoiceNumber?: string
  invoiceDate?: string
  dueDate?: string
  currency?: string
}

export interface InvoiceLineItem {
  description: string
  quantity?: number
  unitPrice?: number
  /** Per-line tax rate (%), recovered ONLY from an identity-confirmed `<qty> <rate>%` column split (R6). */
  taxRatePercent?: number
  lineTotal: number
  currency: string
}

export interface InvoiceTotals {
  netTotal?: number
  taxTotal?: number
  taxRatePercent?: number
  grossTotal?: number
}

export interface ExtractedInvoice {
  header: InvoiceHeader
  lineItems: InvoiceLineItem[]
  totals: InvoiceTotals
  /**
   * Whether the invoice's date ORDER rests on evidence or defaulted to day-first on ambiguous dates (R5,
   * audit §5.7). A document-level provenance flag (not part of the invoice structure) — persisted to
   * `invoices.date_order_inferred` and surfaced as one honest answer caveat. Optional so every downstream
   * tool that takes an `InvoiceInput` (validate/export) simply ignores it.
   */
  dateOrderInferred?: 'evidence' | 'default'
  /**
   * How many money-bearing lines the extractor REJECTED — a line that carries a money-shaped token
   * (`hasMoneyToken`) yet did not become a line item / total / header (U1, audit §2.3). Persisted to
   * `invoices.dropped_row_count`; when > 0 the deterministic answer drops the "the whole invoice" claim for
   * an honest "M lines with figures could not be parsed". A document-level stat, not part of the invoice
   * structure — a downstream tool taking an `InvoiceInput` (validate/export) ignores it.
   */
  droppedRowCount?: number
}

/** What the extractor returns (and what every downstream tool takes as structured input). */
export type ExtractInvoiceOutput = ExtractedInvoice
export type InvoiceInput = ExtractedInvoice

/** A hard cap so a pathological document can never produce an unbounded array (the gate also validates). */
export const MAX_LINE_ITEMS = 10000

/**
 * How many wrapped DESCRIPTION continuation lines a single line item may absorb on the plain-text path
 * (R6, audit §5.7). ONE — the plain path has no column geometry to confirm the association (unlike the
 * geometry `MAX_CONTINUATION_ROWS` = 4), so a single immediately-following money-less line is the
 * conservative bound: enough to recover a description that wrapped once, not enough to swallow a note.
 */
const MAX_PLAIN_CONTINUATION_ROWS = 1

/**
 * The deterministic invoice extractor version (F5 — mirrors `BANK_EXTRACTOR_VERSION`). Stamped onto
 * every `invoices` row (`invoice-run.ts` `runInvoiceExtraction`) and compared on reuse: an invoice whose
 * stored `extractor_version` is NULL (legacy / extracted before versioning) or LESS than this is STALE —
 * the analysis read-back RE-EXTRACTS it (`replaceExisting`, replacing the rows) rather than keep serving
 * figures a since-fixed parser bug mis-read. An invoice at the current version is FRESH and reused.
 *
 * BUMP THIS by one whenever a change alters the extractor's OUTPUT for the same input — in the line
 * parser (`extractInvoice`/`parseLineItem`) or the header/totals readers. A pure refactor that cannot
 * change any output does NOT need a bump.
 *
 * History (each entry = the output-affecting work that warranted the value):
 *   1 — baseline: the invoice parser as built through full-audit-2026-06-29-postmerge Phase 1 (F1 the
 *       statement-context-aware amount-column drop, F3 figure-region currency + single-currency guard,
 *       F6 space-column fusion drop, F8 qty-split corroboration). Pre-versioning rows are NULL → stale.
 *   2 — full-audit-2026-06-29 follow-up Phase 1: FIN-1 (document currency by majority vote over
 *       figure-adjacent detections — a currency word in a line-item description no longer stamps the
 *       net/tax/gross in the wrong code), FIN-2 (the F1 right-side uncaptured-column drop only fires on a
 *       trailing token that is ITSELF a money-shaped-but-rejected bare amount, so a valid item with a
 *       trailing annotation — `(Pos. 3)`, `19% MwSt`, `EUR 2 Stk` — is no longer deleted), and FIN-4 (date
 *       order from the leading date column only). Each can change the persisted output, so v1 rows re-extract.
 *   3 — invoice-totals-2026-07-01: a LABELED totals line now reads a round total printed WITHOUT a
 *       decimal/grouping ("Total (excl. Tax) 914 $", "Tax 0 $") via a currency-ADJACENT bare integer
 *       (`totalsMoney`) — MONEY_RE rejects bare integers, so the whole net/tax/gross block was previously
 *       empty on this extremely common layout; "Total (excl. Tax)" now resolves to the NET (not the
 *       gross) via `EXCL_TAX_RE`; and the abbreviated header label "No.:" no longer leaks its `.:` into
 *       the parsed invoice number. Each changes the persisted output, so v2 rows re-extract.
 *   4 — skills-remediation R1 (audit §5.3 + §5.7-low): a shared `normalizeExtractionText` pre-pass runs
 *       at the extractor entry (`extractInvoice`) so a Unicode minus / no-break-space thousands separator /
 *       Swiss U+2019 apostrophe group is read correctly; and `totalsMoney`'s currency-adjacent bare-integer
 *       fallback is now SIGN-AWARE (a credit-note "Gesamtbetrag -914 EUR" reads −914 instead of +914,
 *       honouring `parseAmount`'s leading/paren/trailing sign rules). Each changes the persisted totals/
 *       amounts on affected invoices, so stale v3 rows re-extract.
 *   5 — skills-remediation R2 (audit §5.2 CRITICAL + §5.4): label matching is now STRUCTURAL — a totals/
 *       header label matches only with a word boundary (`labelBoundaryOk`), so "Steuerberatung Jänner
 *       500,00" is a line item, not a `taxTotal`; a totals label is honoured only when its remainder is
 *       essentially just the figure (`isFillerOnly`), so "Netto-Miete Objekt 3 1.000,00" / "Total hours
 *       consulting 40,00" stay line items; totals are LAST-WINS (a real totals block prints after the
 *       items); the German summary vocabulary is extended (Summe/Gesamtsumme/Rechnungssumme/Endsumme/
 *       Endbetrag) and a summary-line guard (`isSummaryLabelLine`) drops phantom "Summe" items; and header
 *       matching no longer swallows a line that parses as a line item. Each can change the persisted
 *       totals/line items on affected invoices, so stale v4 rows re-extract.
 *   6 — skills-remediation R5 (audit §5.7): date correctness. `parseDate` now completes a 2-digit-year /
 *       bare lead date on a line item against the document year anchor (`inferDateAnchor`) via the shared
 *       `splitLeadingDates` (previously such a date stayed in the description); and the extractor now records
 *       the document-level `dateOrderInferred` provenance (evidence vs day-first default) on the invoice for
 *       the answer caveat. The added output field (and any completed lead date) changes the persisted output,
 *       so stale v5 rows re-extract.
 *   7 — skills-remediation R6 (audit §5.7): row fidelity. (a) A money-less, non-label line that DIRECTLY
 *       follows a line item is appended to that item's description as a bounded (single-line) continuation
 *       — the plain-text mirror of the geometry multi-baseline association — so a wrapped description
 *       survives instead of being dropped. (b) Line-item column debris is cleaned IDENTITY-GATED: a
 *       `<rowIndex> <description> <qty> <rate>%` shape has the leading row index stripped and the trailing
 *       quantity / tax-rate columns split into `quantity` + the new optional `taxRatePercent`, but ONLY
 *       when `quantity × unitPrice ≈ lineTotal` independently confirms the split — otherwise the description
 *       is left exactly as parsed (drop-don't-guess, §22-D1). Changes the persisted descriptions /
 *       quantities on affected invoices, so stale v6 rows re-extract.
 *   8 — skills-remediation U1 (audit §2.3): the extractor now records `droppedRowCount` — how many
 *       money-bearing lines it REJECTED (couldn't turn into a line item / total / header) — so the answer
 *       gates its "the whole invoice" claim honestly instead of asserting exhaustiveness while dropping
 *       figures silently. The new field changes the persisted output, so stale v7 rows re-extract.
 *   9 — skills-audit-2026-07-03 R7 (SKA-1, SKA-2, SKA-14): a date or a header label can no longer swallow
 *       or invent a figure. `parseLineItem` scans money via `scanMoneyWithBlankedDates` — a same-length
 *       date-BLANKED copy with each match's trailing sign re-validated against the original bytes (SKA-1)
 *       — so a mid-line/trailing date is never read as a line total, a trailing date no longer trips the
 *       F1 uncaptured-column drop, and a blanked billing-period range never reads as a trailing debit
 *       minus; the date scrubs gained a double-guarded 2-digit-year alternative incl. terminal punctuation
 *       (SKA-2), so `Gesamtbetrag 390,00 EUR per 30.06.26` reads 390 (not 3006.26), `Datum: 15.03.26` is a
 *       header (not a phantom 1503.26 item), and money-less dd.mm.yy lines no longer inflate
 *       `droppedRowCount`; and the vendor/number header branches fall through on an AMOUNT-shaped line
 *       (`carriesAmountShapedMoney` — a 2-dp figure or currency-adjacent money; a bare grouped header
 *       VALUE like `Rechnung Nr. 26.001` is still consumed, SKA-14), so `From 01.06.2026 to 30.06.2026
 *       Hosting 49,00` / `Rechnung Nr. 2026-14 … über 1.500,00 EUR` stay line items instead of vanishing
 *       into garbage header values. Each changes the persisted items/totals/header on affected invoices,
 *       so stale v8 rows re-extract.
 */
export const INVOICE_EXTRACTOR_VERSION = 9

const HEADER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  // Every header field is OPTIONAL: an invoice without a confidently-parsed vendor/number/date is
  // still extracted (the conservative posture — never fail the whole run because a label is absent).
  required: [],
  properties: {
    vendor: { type: 'string', minLength: 1 },
    invoiceNumber: { type: 'string', minLength: 1 },
    invoiceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }
  }
}

const LINE_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'lineTotal', 'currency'],
  properties: {
    description: { type: 'string', minLength: 1 },
    quantity: { type: 'number' },
    unitPrice: { type: 'number' },
    taxRatePercent: { type: 'number' },
    lineTotal: { type: 'number' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }
  }
}

const TOTALS_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    netTotal: { type: 'number' },
    taxTotal: { type: 'number' },
    taxRatePercent: { type: 'number' },
    grossTotal: { type: 'number' }
  }
}

/** The whole structured invoice — the extract output AND the downstream-tool input share this shape. */
const INVOICE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['header', 'lineItems', 'totals'],
  properties: {
    header: HEADER_SCHEMA,
    lineItems: { type: 'array', items: LINE_ITEM_SCHEMA, maxItems: MAX_LINE_ITEMS },
    totals: TOTALS_SCHEMA,
    // Document-level date-order provenance (R5, audit §5.7) — optional, so a downstream tool handing an
    // invoice loaded from persisted rows (no flag) still validates against this shared input schema.
    dateOrderInferred: { type: 'string', enum: ['evidence', 'default'] },
    // How many money-bearing lines the extractor rejected (U1, audit §2.3) — optional; gates the "whole
    // invoice" answer claim. Ignored by the downstream tools that take an `InvoiceInput`.
    droppedRowCount: { type: 'integer', minimum: 0 }
  }
}

// ---- Deterministic label-based parsing (pure) ----

// Header field labels — matched only at the START of a line (a header field line), case-insensitively,
// so a word appearing mid-sentence is never mistaken for a label. EN + DE for the de-AT target.
const VENDOR_LABELS = ['vendor', 'lieferant', 'seller', 'verkäufer', 'supplier', 'rechnungssteller', 'from']
const NUMBER_LABELS = [
  'invoice number', 'invoice no', 'invoice #', 'rechnungsnummer', 'rechnungs-nr', 'rechnung nr', 'rechnung-nr'
]
// "due" forms are checked BEFORE the invoice-date forms so "Due Date" is not swallowed by "date".
const DUE_LABELS = ['due date', 'fälligkeitsdatum', 'fällig', 'payment due', 'zahlbar bis', 'due']
const INVOICE_DATE_LABELS = ['invoice date', 'rechnungsdatum', 'datum', 'date']

// Totals line labels — checked net → tax → gross so a bare "Total" lands as the gross total while
// "Net Total" / "Gross Total" resolve to their own field. Matched at the line start WITH a structural
// boundary (`labelBoundaryOk`) so a label word can never match a longer word it merely prefixes —
// `steuer` must NOT swallow a "Steuerberatung Jänner 500,00" line item (audit §5.2 CRITICAL). The German
// summary vocabulary is extended (audit §5.4): a `Summe`/`Gesamtsumme`/`Rechnungssumme`/`Endsumme`/
// `Endbetrag` line now resolves to a total instead of falling through to `parseLineItem` as a phantom item.
const NET_LABELS = ['net total', 'net amount', 'nettobetrag', 'netto', 'subtotal', 'zwischensumme', 'summe netto']
const TAX_LABELS = ['vat', 'mehrwertsteuer', 'umsatzsteuer', 'mwst', 'tax total', 'tax', 'steuer']
const GROSS_LABELS = [
  'gross total', 'gross amount', 'gesamtbetrag', 'rechnungsbetrag', 'rechnungssumme', 'gesamtsumme',
  'endsumme', 'endbetrag', 'gesamt', 'brutto', 'amount due', 'zu zahlen', 'zahlbetrag', 'summe', 'total'
]

/**
 * Whether a label matched at a line's START ends on a STRUCTURAL word boundary — the character after the
 * label is not a letter/digit that would make the label a mere PREFIX of a longer word. The audit §5.2
 * CRITICAL fix: without it `steuer` (a TAX label) matched "Steuerberatung Jänner 500,00" and stole its
 * 500 into `taxTotal`, deleting the line item and discarding the real totals block. A label that itself
 * ends in a separator (`invoice #`) always matches — its word already ended, so a following digit
 * ("Invoice #27") is expected, not a continuation. `line`/`label` are compared lowercased by the caller;
 * only character CLASSES matter here, so case is irrelevant.
 */
function labelBoundaryOk(line: string, label: string): boolean {
  if (line.length <= label.length) return true
  const isWordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c)
  return !(isWordChar(label[label.length - 1]) && isWordChar(line[label.length]))
}

// Words that legitimately sit beside a total on a genuine totals/summary line — tax qualifiers, the tax/
// total nouns, currency codes, "as of <date>" connectors, and articles. Removing every date / figure /
// percent / currency symbol from a real totals line leaves ONLY these; any OTHER word means the line
// carries a real description and is a LINE ITEM, not a total ("Netto-Miete Objekt 3 …", "Total hours …").
const TOTALS_FILLER: ReadonlySet<string> = new Set([
  // tax qualifiers
  'inkl', 'incl', 'including', 'zzgl', 'plus', 'excl', 'exkl', 'excluding', 'ohne', 'vor', 'davon',
  // tax / total nouns (a compound totals phrase — "Gesamt Netto Betrag")
  'ust', 'mwst', 'vat', 'steuer', 'umsatzsteuer', 'mehrwertsteuer', 'tax', 'net', 'netto', 'brutto',
  'gross', 'gesamt', 'summe', 'betrag', 'total', 'amount', 'sum', 'saldo', 'zwischensumme',
  // "as of <date>" connectors on a balance/total line ("Gross total 390,00 EUR per 30.06.2026")
  'per', 'am', 'zum', 'vom', 'as', 'of', 'dated', 'stand',
  // articles / conjunctions
  'der', 'die', 'das', 'den', 'des', 'und', 'and', 'the',
  // currency codes (MONEY_RE strips symbols; a spaced ISO code survives as a bare word)
  'eur', 'usd', 'gbp', 'chf', 'jpy', 'cad', 'aud', 'nzd', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf'
])

/**
 * True when `text` — after its date / money / percent / currency-symbol tokens are removed — contains no
 * SUBSTANTIVE word (only `TOTALS_FILLER`). This is the test that a labeled line is a genuine totals line
 * and not a line item whose description merely begins with a totals word. Empty text is filler-only.
 */
function isFillerOnly(text: string): boolean {
  const stripped = stripDateTokens(text)
    .replace(MONEY_RE, ' ')
    .replace(/\d[\d.,'%]*/g, ' ') // bare integers / percents / residual digit debris
    .replace(/[€$£¥%()]/g, ' ')
  const words = stripped
    .split(/[\s.:;#/\\-]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
  return words.every((w) => TOTALS_FILLER.has(w))
}

// The union of all totals labels — a line whose DESCRIPTION (the text before its first figure) is ONLY
// one of these (plus filler) is a statement SUMMARY line, never a line item. Mirrors the bank
// `isBalanceLabelLine` drop (audit §5.4): it kills the phantom "Summe"/"Zwischensumme" items a summary
// line becomes when `applyTotals` did not consume it (e.g. trailing debris sits after the figure).
const SUMMARY_LABELS: readonly string[] = [...NET_LABELS, ...TAX_LABELS, ...GROSS_LABELS]

/** Whether the line's description (text before its first figure) is only a boundary-matched summary label. */
function isSummaryLabelLine(line: string): boolean {
  const lower = line.toLowerCase()
  const label = SUMMARY_LABELS.find((l) => lower.startsWith(l) && labelBoundaryOk(lower, l))
  if (label === undefined) return false
  const beforeFigure = line.slice(label.length).split(MONEY_RE)[0]
  return isFillerOnly(beforeFigure)
}

// The header-value date surfacer (`parseDateInText`). SKA-2 (skills-audit-2026-07-03): mirrors the shared
// scrub's guarded 2-digit-year alternative, so a `Datum: 15.03.26` header line surfaces its date (and is
// CONSUMED as a header once an anchor completes it) instead of falling through to `parseLineItem`, where
// the money-shaped `15.03.26` became the phantom item `{description: "Datum:", lineTotal: 1503.26}`. The
// `\b` + `(?!\d)(?![.,']\d)` guards keep it off real amounts while accepting terminal punctuation
// (`Datum: 15.03.26.`) — see the shared DATE_TOKEN_RE in money.ts for the full rationale.
const DATE_TOKEN_RE =
  /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}|\b\d{1,2}[./]\d{1,2}[./]\d{2}(?!\d)(?![.,']\d)/
const PERCENT_RE = /(\d+(?:[.,]\d+)?)\s*%/
// A bare quantity at the end of the description region: an integer/decimal, optionally with a unit
// word (x / × / Stk / pcs / units). Captures the cleaned description, the numeric quantity, AND the unit
// token (group 3) — the F8 split fires only when group 3 is present OR a unit-price column corroborates.
const QTY_TRAIL_RE = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(x|×|stk\.?|stück|pcs?\.?|units?)?\s*$/i

// F1 (full-audit-2026-06-29-postmerge) / FIN-2 (full-audit-2026-06-29 follow-up) — an uncaptured AMOUNT
// column to the RIGHT of the line total: the invoice reads the line total as the LAST money token, so a
// bare integer / single-decimal figure MONEY_RE rejected, sitting after it, is the real total (`Hosting
// 12,50 500` → the unit price 12,50 read as the total, the real 500 lost) → drop (the §22-D1 honesty
// posture). FIN-2: the region after the last money match must be ENTIRELY that one bare numeric token
// (`^\s*…\s*$`), so a trailing ANNOTATION is NOT mistaken for an uncaptured column and a VALID item
// deleted — the old `/(?:^|\s)[-+(]?\d/` fired on ANY trailing digit and dropped `Service 12,50 (Pos. 3)`,
// `Beratung 1.234,56 19% MwSt`, `Line 50,00 EUR 2 Stk`. A money-shaped-but-rejected token is a leading
// optional sign/paren, a digit run with `.`/`,`/apostrophe grouping, and an optional trailing paren — no
// `%`, no `x`, no unit word, no other text. A trailing currency code carries no leading digit, so it
// never triggers the drop.
const UNCAPTURED_AMOUNT_AFTER = /^\s*[-+(]?\d[\d.,']*\)?\s*$/

/**
 * F6 (full-audit-2026-06-29-postmerge) — whether a matched money token is the FUSION-prone space-grouped
 * form WITHOUT a 2-dp decimal tail (`10 100` → 10100). MONEY_RE's space-grouped alternative reads
 * `<1-3 digits> <3 digits>` as one figure, so two separate columns can fuse across a space on the
 * geometry-less invoice path. A decimal-anchored space group (`1 234 567,89`) is a real figure and is
 * NOT flagged. The leading sign/paren/space and trailing sign/paren/space are stripped first so a signed
 * `1 234,56-` keeps its `,56` tail and passes. (A space group WITH a decimal — `15 799,00` — is
 * indistinguishable from a real 15 799,00 and stays the documented DECISION-2 accepted trade-off.)
 */
function isFusedSpaceGroup(token: string): boolean {
  const core = token.replace(/^[-+(\s]+/, '').replace(/[-+)\s]+$/, '')
  return / /.test(core) && !/[.,]\d{2}$/.test(core)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

// R6 (audit §5.7) — the identity-gated line-item column-debris cleanup. A very common invoice table
// prints  <rowIndex> <description> <qty> <taxRate>% <unitPrice> <lineTotal>  where the rowIndex, the
// quantity and the tax-rate percent are BARE (non-2-dp) tokens MONEY_RE ignores, so they stay glued to
// the parsed description ("1 Web hosting 12 Monate 1 0%"). This regex isolates a trailing `<int> <num>%`
// run (quantity + tax rate) at the END of the description region; the split is applied ONLY when the
// arithmetic identity qty × unitPrice ≈ lineTotal confirms it (see cleanColumnDebris).
const COLUMN_DEBRIS_TRAIL_RE = /^(.*?)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s*%\s*$/

/**
 * Recover `quantity` + `taxRatePercent` from a line item's trailing `<qty> <rate>%` column debris and
 * strip a leading row index — but ONLY when the recovered quantity reproduces the printed line total from
 * the unit price (`quantity × unitPrice ≈ lineTotal`, within half a cent). This is the drop-don't-guess
 * gate (§22-D1): an unverifiable split returns null and the caller leaves the description exactly as
 * parsed. Needs the two money columns (unitPrice = second-to-last, lineTotal = last), so a single-figure
 * row — with no unit price to check against — is never cleaned. The leading-index strip is coupled to the
 * same gate, so the audit probe `1 Web hosting 12 Monate 1 0% 76,17 914,00` (1 × 76,17 ≠ 914) is left
 * entirely intact rather than half-cleaned.
 */
function cleanColumnDebris(
  description: string,
  amounts: number[]
): { description: string; quantity: number; taxRatePercent: number } | null {
  if (amounts.length < 2) return null
  const m = COLUMN_DEBRIS_TRAIL_RE.exec(description)
  if (!m) return null
  const quantity = Number(m[2])
  const taxRatePercent = Number(m[3].replace(',', '.'))
  if (!Number.isFinite(quantity) || !Number.isFinite(taxRatePercent)) return null
  const unitPrice = amounts[amounts.length - 2]
  const lineTotal = amounts[amounts.length - 1]
  // The identity gate — the recovered quantity must tie the unit price to the printed line total.
  if (Math.abs(round2(quantity * unitPrice) - lineTotal) >= MONEY_EPS) return null
  // Also strip ONE leading standalone integer that is a plausible ROW INDEX (1–3 digits) — never persisted
  // as a quantity. A LONGER leading run is left in place: a 4-digit number is far more likely a product year
  // (`2026 Calendar …`) or code than a row index, and the identity gate confirms only the qty/price split,
  // not that the leading token is an index — so clobbering it could silently delete real description text.
  const cleaned = m[1].replace(/^\d{1,3}\s+/, '').trim()
  if (!cleaned) return null
  return { description: cleaned, quantity, taxRatePercent }
}

/** If `line` starts with one of `labels` (WITH a structural boundary), return the trimmed remainder (the
 *  value), else null. The boundary check (audit §5.2) keeps a header label from matching a longer word it
 *  merely prefixes (`from` must not match "Fromage …"). */
function labeledValue(line: string, labels: readonly string[]): string | null {
  const lower = line.toLowerCase()
  for (const label of labels) {
    if (!lower.startsWith(label) || !labelBoundaryOk(lower, label)) continue
    // Strip the label, then a RUN of separator chars (`.`/`:`/`#`/`-`) and surrounding whitespace. The
    // `.` matters for the abbreviated forms whose dot sits OUTSIDE the matched label — `INVOICE No.: 27`
    // ('invoice no' + `.: 27`) yielded a value of `.: 27` under the old single-`[:#-]?` strip; the run
    // now peels the leading `.:` so the value is a clean `27`.
    const rest = line.slice(label.length).replace(/^[\s.:#-]+/, '').trim()
    if (rest) return rest
  }
  return null
}

/** Parse the first ISO / dotted-slashed date token out of a value, or null. `order` is the per-document
 *  date ordering (BL-N1), so a US `mm/dd/yyyy` header date parses on a US-ordered invoice. `anchor` (R5)
 *  completes a 2-digit-year / bare date against the document year; without it those parse to null as before. */
function parseDateInText(text: string, order: DateOrder = 'dmy', anchor?: DateAnchor | null): string | null {
  const m = DATE_TOKEN_RE.exec(text)
  return m ? parseDate(m[0], order, anchor) : null
}

/** The last money token on a line (the printed figure), or null if none parses. Date tokens are scrubbed
 *  first (BL-N2) so a trailing date on a totals line — `Gross total 390,00 EUR per 30.06.2026` — can't
 *  be read as the figure (it would otherwise yield `30.06.20` → 3006.20). */
function lastMoney(line: string): number | null {
  const matches = [...stripDateTokens(line).matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  return parseAmount(matches[matches.length - 1][0])
}

/** "excl./exkl. tax", "net of tax", "vor Steuer" — qualifiers that mark a bare "Total" line as the NET
 *  (not the gross), so an invoice printing "Total (excl. Tax)" and "Total (incl. Tax)" resolves both. */
const EXCL_TAX_RE = /\bexcl|\bexkl|excluding|net of tax|before tax|ohne (?:steuer|ust|umsatzsteuer|mwst)|vor steuer/

/**
 * The printed figure on a LABELED totals line. First the normal last-money token (grouped/decimal via
 * `lastMoney`); failing that — because a ROUND total is frequently printed with NO decimal and NO
 * grouping ("914 $", "0 $"), a bare integer `MONEY_RE` deliberately REJECTS so a reference number in a
 * description is never read as an amount — the LAST bare integer that TOUCHES a currency marker (a
 * symbol glued or spaced, or a spaced ISO code). Currency-adjacency is the safety anchor: it keeps a
 * stray reference/registration integer on the line (a VAT id `ATU81420204`, a `0%` rate) from being
 * mistaken for the amount, while the totals LABEL already scopes this to a net/tax/gross line. Line
 * items never use this — an unlabeled row's bare integer stays ambiguous (the §22-D1 honesty posture).
 */
function totalsMoney(line: string): number | null {
  const v = lastMoney(line)
  if (v !== null) return v
  // R1 (audit §5.7-low): the currency-adjacent bare-integer fallback, sign-aware (a credit note
  // `Gesamtbetrag -914 EUR` reads −914) — now the shared `lastCurrencyAdjacentInteger` (U1: the bank
  // balance reader uses the SAME helper so a round `Opening balance 914 $` is read identically).
  return lastCurrencyAdjacentInteger(line)
}

/** Read a percent figure (e.g. "20%", "19,5 %") from a line, or null. */
function parsePercent(line: string): number | null {
  const m = PERCENT_RE.exec(line)
  if (!m) return null
  const v = Number(m[1].replace(',', '.'))
  return Number.isFinite(v) ? v : null
}

/**
 * The SKA-14 gate signal, tightened by the R7 adversarial review: does the line carry an AMOUNT-shaped
 * money token — a 2-dp DECIMAL figure (`49,00`, `1.500,00`, `(45,00)`), or any money-shaped token on a
 * line that also names a currency (`… über 1.500 EUR`)? A bare dotted/thousands GROUP with no currency
 * is NOT amount-shaped here: `Rechnung Nr. 26.001` (a real DACH `yy.nnn` numbering convention) and
 * `Lieferant: Firma 1.000 GmbH` are header VALUES whose digits merely look grouped — falling through on
 * them INVENTED a €26,001 / €1,000 line item and lost the header (verified review finding), the exact
 * inversion of the harm SKA-14 closes. Dates are scrubbed first so a date is never "money". Residual
 * (accepted, documented): a 2-dp figure genuinely inside a vendor/number VALUE
 * (`Rechnungsnummer 2026/1.234,56`) still falls through and reads as a figure — a 2-dp token is an
 * amount to every other reader in this file, and §22-D1 prefers reading a printed 2-dp figure as a
 * figure over silently discarding it.
 */
function carriesAmountShapedMoney(line: string): boolean {
  const scrubbed = stripDateTokens(line)
  const matches = [...scrubbed.matchAll(MONEY_RE)]
  if (matches.length === 0) return false
  if (matches.some((m) => /[.,]\d{2}[)\s-]*$/.test(m[0].trim()))) return true
  return detectCurrency(scrubbed) !== null
}

/** Apply a header label to the line; returns true when the line WAS a header line (consumed). `anchor` (R5)
 *  completes a 2-digit-year header date (`Datum: 15.03.26`) via the widened local `DATE_TOKEN_RE` (SKA-2). */
function applyHeader(
  line: string,
  header: InvoiceHeader,
  order: DateOrder = 'dmy',
  anchor?: DateAnchor | null
): boolean {
  // SKA-14 (skills-audit-2026-07-03): an AMOUNT-bearing line is never consumed as a vendor/number header.
  // R2 gated only the date branches below (a date label consumes only when a date parses); the vendor/
  // number branches consumed UNCONDITIONALLY, so `From 01.06.2026 to 30.06.2026 Hosting 49,00` ("from" is
  // a vendor label) and `Rechnung Nr. 2026-14 vom 03.05.2026 über 1.500,00 EUR` were swallowed whole: the
  // line item was deleted, `droppedRowCount` was NOT incremented (consumption precedes the count), the
  // "whole invoice" claim stood, and vendor/invoiceNumber captured garbage tails. Such a line falls
  // through to `parseLineItem` instead — a figure must never silently vanish behind a whole-invoice
  // claim (§22-D1). The gate keys on `carriesAmountShapedMoney` (NOT bare `hasMoneyToken`) so a
  // grouped-looking header VALUE (`Rechnung Nr. 26.001`) is still consumed as the header it is.
  if (!carriesAmountShapedMoney(line)) {
    const vendor = labeledValue(line, VENDOR_LABELS)
    if (vendor !== null) {
      if (!header.vendor) header.vendor = vendor
      return true
    }
    const number = labeledValue(line, NUMBER_LABELS)
    if (number !== null) {
      if (!header.invoiceNumber) header.invoiceNumber = number
      return true
    }
  }
  // A date label consumes the line ONLY when a date actually parses from its value (audit §5.2): a line
  // that merely BEGINS with a date word but carries a money-bearing description — `Due diligence review
  // 2.000,00`, `Date storage fee 50,00` — parses no date, so it is NOT consumed here and falls through
  // to `parseLineItem` as the line item it is (rather than being silently swallowed and dropped).
  const dueRaw = labeledValue(line, DUE_LABELS)
  if (dueRaw !== null) {
    const d = parseDateInText(dueRaw, order, anchor)
    if (d) {
      if (!header.dueDate) header.dueDate = d
      return true
    }
  }
  const dateRaw = labeledValue(line, INVOICE_DATE_LABELS)
  if (dateRaw !== null) {
    const d = parseDateInText(dateRaw, order, anchor)
    if (d) {
      if (!header.invoiceDate) header.invoiceDate = d
      return true
    }
  }
  return false
}

/**
 * Apply a totals label to the line; returns true when the line WAS a totals line (consumed). A totals
 * label matches only at the line start WITH a structural boundary (`labelBoundaryOk`), and ONLY when the
 * remainder after it is essentially just the figure (`isFillerOnly`) — a boundary-matched label whose
 * remainder still carries a real description ("Netto-Miete Objekt 3 1.000,00", "Total hours consulting
 * 40,00") is a LINE ITEM and falls through to `parseLineItem` (returns false). Assignment is LAST-WINS —
 * a later totals block overwrites an earlier one, since real invoices print the totals after the line
 * items (audit §5.2). The figure itself is re-read over the whole line by `totalsMoney`.
 */
function applyTotals(line: string, totals: InvoiceTotals): boolean {
  const lower = line.toLowerCase()
  const isTotalsLine = (labels: readonly string[]): boolean => {
    const label = labels.find((l) => lower.startsWith(l) && labelBoundaryOk(lower, l))
    return label !== undefined && isFillerOnly(line.slice(label.length))
  }
  // net first, then tax, then gross (the bare "total" is a gross label — so "Net Total" wins as net).
  if (isTotalsLine(NET_LABELS)) {
    const v = totalsMoney(line)
    if (v !== null) totals.netTotal = v
    return true
  }
  if (isTotalsLine(TAX_LABELS)) {
    const v = totalsMoney(line)
    if (v !== null) totals.taxTotal = v
    const rate = parsePercent(line)
    if (rate !== null) totals.taxRatePercent = rate
    return true
  }
  if (isTotalsLine(GROSS_LABELS)) {
    const v = totalsMoney(line)
    // A bare "Total" qualified by "(excl. tax)"/"net of tax" is the NET, not the gross (a very common
    // layout prints both "Total (excl. Tax)" and "Total (incl. Tax)"); the unqualified/"incl." total
    // stays gross. Without this, "Total (excl. Tax)" landed as the gross and the real gross was dropped.
    if (v !== null && EXCL_TAX_RE.test(lower)) {
      totals.netTotal = v
      return true
    }
    if (v !== null) totals.grossTotal = v
    return true
  }
  return false
}

/**
 * Parse one line into a line item, or null. The description is the text before the first money token;
 * a bare trailing quantity is split off it. With ≥2 money tokens the second-to-last is the unit price
 * and the last is the line total; with one, only the line total is set. A line with no detectable
 * currency is dropped (never invents one).
 */
export function parseLineItem(
  line: string,
  documentCurrency: string | null,
  order: DateOrder = 'dmy',
  anchor?: DateAnchor | null
): InvoiceLineItem | null {
  // Strip any leading DATE column(s) (e.g. a service-/delivery-date column) before the money scan so a
  // `dd.mm.yyyy` token's `.20yy` tail can't be read as a price (shared BL-1 fix; see bank `parseLine`).
  // An invoice line item rarely leads with a date, so this is usually a no-op; when it does, the date is
  // dropped (line items carry no date field) and the description starts at the first non-date token.
  // `order` is the per-document date ordering (BL-N1), so a US `mm/dd/yyyy` lead column is recognised;
  // `anchor` (R5) completes a 2-digit-year / bare lead date, else it parses to null and stays in the text.
  const { rest } = splitLeadingDates(line, order, anchor)
  // SKA-1 (skills-audit-2026-07-03): scan money over a DATE-BLANKED copy of `rest` — a MID-LINE or
  // trailing date (`… über 1.500,00 EUR vom 03.05.2026`, a period line's `bis 30.04.2026`) was read by
  // MONEY_RE as a 2-dp amount and became a phantom line total. Same-length blanking (spaces), so every
  // match index below stays valid in the ORIGINAL `rest`: the `description` slice and the figure-region
  // currency slice are byte-identical to before on any date-free row.
  const { scanRest, matches } = scanMoneyWithBlankedDates(rest)
  if (matches.length === 0) return null
  // F6 — DROP a space-column FUSION (`Widget 10 100` → `10 100` → 10100, ~100× too large). The bank path
  // is mitigated by the geometry column model (D58); the invoice path has NO geometry backstop (F10), so
  // a fusion-prone space-grouped token (no 2-dp decimal tail) on ANY column makes the row ambiguous.
  if (matches.some((m) => isFusedSpaceGroup(m.token))) return null

  const amounts: number[] = []
  for (const m of matches) {
    const a = parseAmount(m.token)
    if (a !== null) amounts.push(a)
  }
  if (amounts.length === 0) return null

  // F1 — DROP an ambiguous line total. The invoice reads the line total as the LAST money token; if the
  // REAL rightmost figure is a bare integer MONEY_RE rejected (`Hosting 12,50 500` → the unit price 12,50
  // read as the line total, the real 500 lost), an uncaptured numeric column sits to the RIGHT of the
  // last match and we cannot tell which figure is the total → drop (the §22-D1 honesty posture). Mirror
  // of the bank `parseLine` drop, but RIGHT-side: the bank amount is the second-to-last figure whereas the
  // invoice line total is the LAST, so the dangerous uncaptured column is on the opposite side.
  const lastMatch = matches[matches.length - 1]
  // The uncaptured-column test reads the BLANKED tail (SKA-1): a trailing DATE after the last money token
  // (`Hosting 49,00 30.06.2026`) is blanks there, so it is never mistaken for an uncaptured amount column
  // (which would delete a valid item); a real bare-number column still triggers the F1 drop.
  const afterLast = scanRest.slice(lastMatch.index + lastMatch.token.length)
  if (UNCAPTURED_AMOUNT_AFTER.test(afterLast)) return null

  // The figure boundary is the first NON-SPACE of the first match, not `match.index`: MONEY_RE tolerates
  // up to 4 leading spaces (`\s{0,4}`), and on the BLANKED scan those spaces can be a blanked date's TAIL
  // — slicing at `match.index` would chop those original bytes out of the description (SKA-1). On a
  // date-free row the skipped chars are real whitespace, so this is byte-identical to the old slice.
  const first = matches[0]
  const figureStart = first.index + (first.token.length - first.token.trimStart().length)
  let description = rest.slice(0, figureStart).trim()
  if (!description) return null
  // F3 — detect the per-line currency only in the FIGURE REGION (the text from the first money token on),
  // mirroring the bank `parseLine` BL-2 fix. detectCurrency scans ISO codes before symbols, so scanning
  // the whole `line` let a currency WORD in the free-text description (`USD adapter cable 12,50` on a EUR
  // invoice) beat the figure-adjacent symbol and tag the line USD; the line totals then summed across a
  // phantom mixed-currency set in `validateInvoiceTotals`. A genuine foreign-currency line prints its
  // code/symbol NEXT TO the amount (inside the figure region) and is still detected (mixed-currency
  // honesty preserved) — preferred over `documentCurrency ?? detectCurrency`, which would silently fold a
  // truly-mixed line into the document currency.
  const figureRegion = rest.slice(figureStart)
  const currency = detectCurrency(figureRegion) ?? documentCurrency
  if (!currency) return null

  let quantity: number | undefined
  let taxRatePercent: number | undefined
  // R6 (audit §5.7) — try the identity-gated column-debris cleanup FIRST: it owns the trailing
  // `<qty> <rate>%` shape and, when the identity confirms, fully determines the cleaned description +
  // quantity + tax rate (and strips a leading row index). It fires only on that specific shape, so any
  // other line falls through to the existing F8 trailing-quantity split unchanged.
  const debris = cleanColumnDebris(description, amounts)
  if (debris) {
    description = debris.description
    quantity = debris.quantity
    taxRatePercent = debris.taxRatePercent
  } else {
    // F8 — split a trailing number off the description as `quantity` ONLY when a unit token is present
    // (QTY_TRAIL_RE group 3) OR a second money column (a unit price, `amounts.length >= 2`) corroborates
    // it. Without either, a product-coded description (`iPhone 15`, `Calendar 2026`) had its trailing
    // number greedily read as a quantity. (lineTotal is unaffected — this is a metadata fix.)
    const qtyMatch = QTY_TRAIL_RE.exec(description)
    if (qtyMatch && qtyMatch[1].trim() && (qtyMatch[3] !== undefined || amounts.length >= 2)) {
      const q = Number(qtyMatch[2].replace(',', '.'))
      if (Number.isFinite(q)) {
        quantity = q
        description = qtyMatch[1].trim()
      }
    }
  }

  const item: InvoiceLineItem = {
    description,
    lineTotal: amounts[amounts.length - 1],
    currency
  }
  if (quantity !== undefined) item.quantity = quantity
  if (taxRatePercent !== undefined) item.taxRatePercent = taxRatePercent
  if (amounts.length >= 2) item.unitPrice = amounts[amounts.length - 2]
  return item
}

/** Pure extractor over already-read chunks — header + line items + totals, ambiguous data dropped. */
export function extractInvoice(
  chunks: DocumentChunkRead[],
  documentCurrency: string | null,
  order?: DateOrder,
  anchor?: DateAnchor | null
): ExtractedInvoice {
  // R1 (audit §5.3): normalize Unicode side-doors (U+2212 minus family, NBSP thousands-space family,
  // U+2019 apostrophe) ONCE at the entry so every downstream regex (MONEY_RE, date scans) sees ASCII.
  const texts = chunks.map((c) => normalizeExtractionText(c.text))
  // Infer the document's date ordering ONCE (BL-N1) so US-ordered header dates parse mm/dd consistently, and
  // the year ANCHOR (R5) so a bare/2-digit lead date on a line item completes (shared with the bank path).
  const joined = texts.join('\n')
  const dateOrder = order ?? inferDateOrder(joined)
  const dateAnchor = anchor ?? inferDateAnchor(joined, dateOrder)
  const header: InvoiceHeader = {}
  const lineItems: InvoiceLineItem[] = []
  const totals: InvoiceTotals = {}
  // U1 (audit §2.3): money-bearing lines the parser could not turn into a line item / total / header.
  let droppedWithFigure = 0
  for (const text of texts) {
    // R6 (audit §5.7): a money-less, non-label line that DIRECTLY follows a line item is a wrapped
    // continuation of that item's description (the plain-text mirror of the geometry multi-baseline
    // association). It is appended to the pending item's description so a description that wrapped once
    // survives. Bounded to ONE line; the pending item is closed by the next line item, a header/totals/
    // summary line, a blank line, any figure-bearing line, or the end of this SEGMENT. `pending` is scoped
    // PER CHUNK (each chunk is one page on the real path) — a wrapped description always prints on the SAME
    // page as its line item, so it must NOT survive the segment boundary (else a page-2 footer / header
    // would glue onto page-1's last line item). Mirrors the geometry per-page flush in `reconstructPage`.
    let pending: { item: InvoiceLineItem; absorbed: number } | null = null
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) {
        pending = null // a blank line breaks a wrapped-description run
        continue
      }
      // Header first (it consumes a labeled date line — `Rechnungsdatum: 15.01.2026` — before the money
      // scan below could misread the date's `15.01` as an amount). `applyHeader` no longer consumes a
      // date-label line unless a date actually parses, so a line item that merely begins with a date word
      // (`Due diligence review 2.000,00`) falls through instead of being swallowed (audit §5.2). A header
      // line also CLOSES any pending item (it is a structural boundary, never a description continuation).
      if (applyHeader(line, header, dateOrder, dateAnchor)) {
        pending = null
        continue
      }
      // A boundary-matched totals label whose remainder is just the figure is a total; one that still
      // carries a real description ("Netto-Miete Objekt 3 1.000,00", "Total hours consulting 40,00")
      // falls through to `parseLineItem` and stays a line item (audit §5.2).
      if (applyTotals(line, totals)) {
        pending = null
        continue
      }
      // A summary line whose description is only a totals label never becomes a phantom line item (§5.4).
      if (isSummaryLabelLine(line)) {
        pending = null
        continue
      }
      const item = parseLineItem(line, documentCurrency, dateOrder, dateAnchor)
      if (item) {
        lineItems.push(item)
        pending = { item, absorbed: 0 }
        if (lineItems.length >= MAX_LINE_ITEMS) {
          if (documentCurrency && !header.currency) header.currency = documentCurrency
          return { header, lineItems, totals, droppedRowCount: droppedWithFigure }
        }
        continue
      }
      // Not a line item: a money-less follower line is a wrapped description continuation of the item
      // above (bounded). Anything carrying a money token closes the pending item instead (a figure is a
      // total/annotation, not description text).
      if (
        pending &&
        pending.absorbed < MAX_PLAIN_CONTINUATION_ROWS &&
        [...line.matchAll(MONEY_RE)].length === 0
      ) {
        pending.item.description = `${pending.item.description} ${line}`.trim()
        pending.absorbed++
        continue
      }
      // U1 (audit §2.3): a rejected, non-continuation line that STILL carries a money-shaped token is a
      // line-item / total candidate the parser could not read (a currency-less row, a fused space-group,
      // an uncaptured-amount drop). Count it so the answer gates its "the whole invoice" claim. A money-LESS
      // note never counts. Header/totals/summary lines were consumed above, so they are excluded.
      if (hasMoneyToken(line)) droppedWithFigure++
      pending = null
    }
  }
  if (documentCurrency && !header.currency) header.currency = documentCurrency
  return { header, lineItems, totals, droppedRowCount: droppedWithFigure }
}

// ---- extract_invoice (read-only over the selected document scope) ----

/**
 * `extract_invoice` — read-only over the selected document scope. Reads the document's
 * page-addressable chunks via the narrow `ctx.readDocumentChunks`, parses the invoice
 * deterministically and offline, and returns the schema-validated structured invoice. It persists
 * nothing (the `invoice-run.ts` seam writes the rows); a wrong-shape result fails the run at the gate.
 */
export const extractInvoiceTool: SkillTool = {
  name: 'extract_invoice',
  description:
    'Read the selected invoice and return its header (vendor, number, dates), line items, and totals exactly as printed. Read-only; sees only the selected document.',
  permissions: ['read-selected-docs'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId'],
    properties: { documentId: { type: 'string', minLength: 1 } }
  },
  outputSchema: INVOICE_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { documentId } = input as { documentId: string }
    let chunks: DocumentChunkRead[]
    try {
      chunks = ctx.readDocumentChunks(documentId)
    } catch {
      // Out-of-scope / unreadable — friendly + content-free; the technical reason is the seam's log.
      return { ok: false, error: 'This invoice could not be read.' }
    }
    // R1 (audit §5.3): normalize Unicode side-doors before the currency vote / date-order inference read
    // MONEY_RE over this text (extractInvoice normalizes its own chunk copies independently; idempotent).
    const joined = normalizeExtractionText(chunks.map((c) => c.text).join('\n'))
    // FIN-1 — document currency by MAJORITY VOTE over figure-adjacent detections (mirror of the bank
    // path): a currency WORD in a line-item description (left of the amount) or a stray code in a note no
    // longer beats the figure-adjacent / header-declared currency that the net/tax/gross are printed in.
    const currency = detectDocumentCurrency(joined)
    // R5 (audit §5.7): resolve date order + evidence flag + year anchor ONCE and hand them to the extractor,
    // then stamp the document-level `dateOrderInferred` provenance onto the returned invoice.
    const { order: dateOrder, inferred: dateOrderInferred } = inferDateOrderResult(joined)
    const dateAnchor = inferDateAnchor(joined, dateOrder)
    const invoice = extractInvoice(chunks, currency, dateOrder, dateAnchor)
    invoice.dateOrderInferred = dateOrderInferred
    ctx.onProgress?.({ done: chunks.length, total: chunks.length })
    return { ok: true, output: invoice }
  }
}

// =====================================================================================
// The downstream invoice tools (validate / export) — operate on the ALREADY-EXTRACTED invoice,
// handed in as STRUCTURED INPUT by the run seam (no new SkillToolContext accessor; §14 unchanged).
// Deterministic + offline; they honour the §22-D1 posture (never invent a figure; flag what cannot
// be confirmed). Persistence + the user-gated CSV write stay in the seam.
// =====================================================================================

// ---- validate_invoice_totals (read-only; deterministic reconciliation) ----

export type InvoiceCheckStatus = 'ok' | 'mismatch' | 'unknown'
export type InvoiceCheckName = 'lineItemsSumToNet' | 'netPlusTaxIsGross' | 'taxMatchesRate'

export interface InvoiceCheck {
  name: InvoiceCheckName
  status: InvoiceCheckStatus
}

export interface InvoiceTotalsResult {
  /** Overall verdict: at least one check could run AND nothing contradicted (honesty). */
  reconciled: boolean
  checks: InvoiceCheck[]
}

/**
 * Reconcile the printed invoice totals, deterministically, within half a cent (pure). Three checks,
 * each `ok` / `mismatch` / `unknown` (a needed figure is absent — flagged, never assumed correct):
 *   - lineItemsSumToNet:  sum(lineItems.lineTotal) == netTotal
 *   - netPlusTaxIsGross:  netTotal + taxTotal == grossTotal
 *   - taxMatchesRate:     taxTotal == round(netTotal * taxRatePercent / 100)
 * `reconciled` is true only when no check mismatched AND at least one check actually ran.
 */
export function validateInvoiceTotals(invoice: InvoiceInput): InvoiceTotalsResult {
  const { lineItems, totals } = invoice
  const checks: InvoiceCheck[] = []
  let okCount = 0
  let mismatchCount = 0
  const record = (name: InvoiceCheckName, status: InvoiceCheckStatus): void => {
    if (status === 'ok') okCount++
    else if (status === 'mismatch') mismatchCount++
    checks.push({ name, status })
  }
  const agree = (a: number, b: number): boolean => Math.abs(a - b) < MONEY_EPS

  // 1. line items sum to the net total — only when every line item shares ONE currency (F3
  // single-currency guard, mirroring assessCompleteness/reconcileBalances on the bank side). Summing
  // `lineTotal` across currencies yields a meaningless cross-currency figure that would reconcile (or
  // fail) against the net spuriously, so a >1 currency set is reported `unknown` rather than ok/mismatch.
  const lineCurrencies = new Set(lineItems.map((li) => li.currency))
  if (totals.netTotal !== undefined && lineItems.length > 0 && lineCurrencies.size <= 1) {
    const sum = round2(lineItems.reduce((acc, li) => acc + li.lineTotal, 0))
    record('lineItemsSumToNet', agree(sum, totals.netTotal) ? 'ok' : 'mismatch')
  } else {
    record('lineItemsSumToNet', 'unknown')
  }

  // 2. net + tax == gross.
  if (totals.netTotal !== undefined && totals.taxTotal !== undefined && totals.grossTotal !== undefined) {
    record('netPlusTaxIsGross', agree(round2(totals.netTotal + totals.taxTotal), totals.grossTotal) ? 'ok' : 'mismatch')
  } else {
    record('netPlusTaxIsGross', 'unknown')
  }

  // 3. tax == net * rate%.
  if (totals.netTotal !== undefined && totals.taxRatePercent !== undefined && totals.taxTotal !== undefined) {
    const expected = round2((totals.netTotal * totals.taxRatePercent) / 100)
    record('taxMatchesRate', agree(expected, totals.taxTotal) ? 'ok' : 'mismatch')
  } else {
    record('taxMatchesRate', 'unknown')
  }

  return { reconciled: mismatchCount === 0 && okCount > 0, checks }
}

const VALIDATE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reconciled', 'checks'],
  properties: {
    reconciled: { type: 'boolean' },
    checks: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status'],
        properties: {
          name: { type: 'string', enum: ['lineItemsSumToNet', 'netPlusTaxIsGross', 'taxMatchesRate'] },
          status: { type: 'string', enum: ['ok', 'mismatch', 'unknown'] }
        }
      }
    }
  }
}

export const validateInvoiceTotalsTool: SkillTool = {
  name: 'validate_invoice_totals',
  description:
    'Check the invoice’s printed totals against each other (line items → net, net + tax → gross, tax vs. rate) and report which reconcile. Read-only; never changes a figure.',
  permissions: ['read-selected-docs'],
  inputSchema: INVOICE_SCHEMA,
  outputSchema: VALIDATE_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    return { ok: true, output: validateInvoiceTotals(input as InvoiceInput) }
  }
}

// ---- export_invoice_csv (export-file; confirm-gated; the seam does the FS write) ----

/** Serialize the line items to CSV text (pure — no FS). Header + one line per item, stable columns. */
export function lineItemsToCsv(lineItems: InvoiceLineItem[]): string {
  const header = ['description', 'quantity', 'unitPrice', 'lineTotal', 'currency']
  const lines = [header.join(',')]
  for (const li of lineItems) {
    lines.push(
      [
        csvField(li.description),
        // Numeric columns: fixed 2-dp, dot decimal — a stable, locale-free CSV number (blank if absent).
        li.quantity === undefined ? '' : li.quantity.toFixed(2),
        li.unitPrice === undefined ? '' : li.unitPrice.toFixed(2),
        li.lineTotal.toFixed(2),
        csvField(li.currency)
      ].join(',')
    )
  }
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

export const exportInvoiceCsvTool: SkillTool = {
  name: 'export_invoice_csv',
  description:
    'Produce a CSV of the selected invoice’s line items for you to save. Requires your confirmation; you choose where the file is written.',
  permissions: ['export-file'],
  inputSchema: INVOICE_SCHEMA,
  outputSchema: CSV_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const { lineItems } = input as InvoiceInput
    return { ok: true, output: { csv: lineItemsToCsv(lineItems), rowCount: lineItems.length } }
  }
}

// ---- JSON / XML serializers (invoice-format-2026-07-01) ----
//
// Pure format transformations of the ALREADY-EXTRACTED invoice — the deterministic, honest-by-type-safety
// answer to "give me this invoice as JSON/XML". They serialize the SAME structured object the extractor
// produced and the run seam persisted (no model call, no new content reach): the figures are the parser's,
// so nothing here can invent or transpose a number (the §22-D1 posture is preserved by construction — a
// serializer cannot read a figure the parser did not). Both emit a STABLE shape (absent header/totals
// fields are explicit `null` in JSON / omitted elements in XML) so a downstream consumer sees a
// predictable schema. Numbers keep the extractor's 2-dp cent invariant. Mirrors `lineItemsToCsv`.

/** The canonical plain object the JSON serializer emits — a stable shape (nulls for absent fields). */
function invoiceToPlainObject(invoice: InvoiceInput): Record<string, unknown> {
  const { header, lineItems, totals } = invoice
  return {
    vendor: header.vendor ?? null,
    invoiceNumber: header.invoiceNumber ?? null,
    invoiceDate: header.invoiceDate ?? null,
    dueDate: header.dueDate ?? null,
    currency: header.currency ?? null,
    lineItems: lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity ?? null,
      unitPrice: li.unitPrice ?? null,
      taxRatePercent: li.taxRatePercent ?? null,
      lineTotal: li.lineTotal,
      currency: li.currency
    })),
    totals: {
      netTotal: totals.netTotal ?? null,
      taxTotal: totals.taxTotal ?? null,
      taxRatePercent: totals.taxRatePercent ?? null,
      grossTotal: totals.grossTotal ?? null
    }
  }
}

/** Serialize the extracted invoice to pretty-printed JSON (2-space indent). Pure — no FS. */
export function buildInvoiceJson(invoice: InvoiceInput): string {
  return JSON.stringify(invoiceToPlainObject(invoice), null, 2)
}

/** XML-escape a text value (the five predefined entities) so a description can never break the markup. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Serialize the extracted invoice to XML. Absent header/totals fields are omitted; numbers are 2-dp. Pure. */
export function buildInvoiceXml(invoice: InvoiceInput): string {
  const { header, lineItems, totals } = invoice
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<invoice>']
  const el = (name: string, value: string | number | undefined, indent = '  '): void => {
    if (value === undefined) return
    const text = typeof value === 'number' ? value.toFixed(2) : xmlEscape(value)
    lines.push(`${indent}<${name}>${text}</${name}>`)
  }
  el('vendor', header.vendor)
  el('invoiceNumber', header.invoiceNumber)
  el('invoiceDate', header.invoiceDate)
  el('dueDate', header.dueDate)
  el('currency', header.currency)
  lines.push('  <lineItems>')
  for (const li of lineItems) {
    lines.push('    <lineItem>')
    el('description', li.description, '      ')
    el('quantity', li.quantity, '      ')
    el('unitPrice', li.unitPrice, '      ')
    el('taxRatePercent', li.taxRatePercent, '      ')
    el('lineTotal', li.lineTotal, '      ')
    el('currency', li.currency, '      ')
    lines.push('    </lineItem>')
  }
  lines.push('  </lineItems>')
  lines.push('  <totals>')
  el('netTotal', totals.netTotal, '    ')
  el('taxTotal', totals.taxTotal, '    ')
  el('taxRatePercent', totals.taxRatePercent, '    ')
  el('grossTotal', totals.grossTotal, '    ')
  lines.push('  </totals>')
  lines.push('</invoice>')
  return lines.join('\n') + '\n'
}

// ---- export_invoice_json / export_invoice_xml (export-file; confirm-gated; the seam does the FS write) ----

/** The uniform file-export tool output: the serialized text + the line-item count (a content-free count). */
const FILE_EXPORT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['content', 'rowCount'],
  properties: {
    content: { type: 'string' },
    rowCount: { type: 'integer', minimum: 0 }
  }
}

export const exportInvoiceJsonTool: SkillTool = {
  name: 'export_invoice_json',
  description:
    'Produce a JSON file of the selected invoice (header, line items, totals) for you to save. Requires your confirmation; you choose where the file is written.',
  permissions: ['export-file'],
  inputSchema: INVOICE_SCHEMA,
  outputSchema: FILE_EXPORT_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const invoice = input as InvoiceInput
    return { ok: true, output: { content: buildInvoiceJson(invoice), rowCount: invoice.lineItems.length } }
  }
}

export const exportInvoiceXmlTool: SkillTool = {
  name: 'export_invoice_xml',
  description:
    'Produce an XML file of the selected invoice (header, line items, totals) for you to save. Requires your confirmation; you choose where the file is written.',
  permissions: ['export-file'],
  inputSchema: INVOICE_SCHEMA,
  outputSchema: FILE_EXPORT_OUTPUT_SCHEMA,
  async run(input, ctx): Promise<ToolResult> {
    if (ctx.signal.aborted) return { ok: false, error: 'This action was cancelled.' }
    const invoice = input as InvoiceInput
    return { ok: true, output: { content: buildInvoiceXml(invoice), rowCount: invoice.lineItems.length } }
  }
}
