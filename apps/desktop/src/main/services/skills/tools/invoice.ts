import type { DocumentChunkRead, JsonSchema, SkillTool, ToolResult } from '../../../../shared/types'
import {
  MONEY_EPS,
  MONEY_RE,
  csvField,
  detectCurrency,
  detectDocumentCurrency,
  inferDateOrder,
  parseAmount,
  parseDate,
  splitLeadingDates,
  stripDateTokens,
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
}

/** What the extractor returns (and what every downstream tool takes as structured input). */
export type ExtractInvoiceOutput = ExtractedInvoice
export type InvoiceInput = ExtractedInvoice

/** A hard cap so a pathological document can never produce an unbounded array (the gate also validates). */
export const MAX_LINE_ITEMS = 10000

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
 */
export const INVOICE_EXTRACTOR_VERSION = 2

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
    totals: TOTALS_SCHEMA
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
// "Net Total" / "Gross Total" resolve to their own field (each matched at the line start).
const NET_LABELS = ['net total', 'nettobetrag', 'netto', 'subtotal', 'zwischensumme', 'net amount']
const TAX_LABELS = ['vat', 'mehrwertsteuer', 'umsatzsteuer', 'mwst', 'tax total', 'tax', 'steuer']
const GROSS_LABELS = [
  'gross total', 'gross amount', 'gesamtbetrag', 'rechnungsbetrag', 'gesamt', 'brutto', 'amount due',
  'zu zahlen', 'zahlbetrag', 'total'
]

const DATE_TOKEN_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}/
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

/** If `line` starts with one of `labels`, return the trimmed remainder (the value), else null. */
function labeledValue(line: string, labels: readonly string[]): string | null {
  const lower = line.toLowerCase()
  for (const label of labels) {
    if (!lower.startsWith(label)) continue
    // Strip the label, then an optional separator (`:`/`#`/`-`) and surrounding whitespace.
    const rest = line.slice(label.length).replace(/^\s*[:#-]?\s*/, '').trim()
    if (rest) return rest
  }
  return null
}

function startsWithAny(lower: string, labels: readonly string[]): boolean {
  return labels.some((l) => lower.startsWith(l))
}

/** Parse the first ISO / dotted-slashed date token out of a value, or null. `order` is the per-document
 *  date ordering (BL-N1), so a US `mm/dd/yyyy` header date parses on a US-ordered invoice. */
function parseDateInText(text: string, order: DateOrder = 'dmy'): string | null {
  const m = DATE_TOKEN_RE.exec(text)
  return m ? parseDate(m[0], order) : null
}

/** The last money token on a line (the printed figure), or null if none parses. Date tokens are scrubbed
 *  first (BL-N2) so a trailing date on a totals line — `Gross total 390,00 EUR per 30.06.2026` — can't
 *  be read as the figure (it would otherwise yield `30.06.20` → 3006.20). */
function lastMoney(line: string): number | null {
  const matches = [...stripDateTokens(line).matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  return parseAmount(matches[matches.length - 1][0])
}

/** Read a percent figure (e.g. "20%", "19,5 %") from a line, or null. */
function parsePercent(line: string): number | null {
  const m = PERCENT_RE.exec(line)
  if (!m) return null
  const v = Number(m[1].replace(',', '.'))
  return Number.isFinite(v) ? v : null
}

/** Apply a header label to the line; returns true when the line WAS a header line (consumed). */
function applyHeader(line: string, header: InvoiceHeader, order: DateOrder = 'dmy'): boolean {
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
  const dueRaw = labeledValue(line, DUE_LABELS)
  if (dueRaw !== null) {
    const d = parseDateInText(dueRaw, order)
    if (d && !header.dueDate) header.dueDate = d
    return true
  }
  const dateRaw = labeledValue(line, INVOICE_DATE_LABELS)
  if (dateRaw !== null) {
    const d = parseDateInText(dateRaw, order)
    if (d && !header.invoiceDate) header.invoiceDate = d
    return true
  }
  return false
}

/** Apply a totals label to the line; returns true when the line WAS a totals line (consumed). */
function applyTotals(line: string, totals: InvoiceTotals): boolean {
  const lower = line.toLowerCase()
  // net first, then tax, then gross (the bare "total" is a gross label — so "Net Total" wins as net).
  if (startsWithAny(lower, NET_LABELS)) {
    const v = lastMoney(line)
    if (v !== null && totals.netTotal === undefined) totals.netTotal = v
    return true
  }
  if (startsWithAny(lower, TAX_LABELS)) {
    const v = lastMoney(line)
    if (v !== null && totals.taxTotal === undefined) totals.taxTotal = v
    const rate = parsePercent(line)
    if (rate !== null && totals.taxRatePercent === undefined) totals.taxRatePercent = rate
    return true
  }
  if (startsWithAny(lower, GROSS_LABELS)) {
    const v = lastMoney(line)
    if (v !== null && totals.grossTotal === undefined) totals.grossTotal = v
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
  order: DateOrder = 'dmy'
): InvoiceLineItem | null {
  // Strip any leading DATE column(s) (e.g. a service-/delivery-date column) before the money scan so a
  // `dd.mm.yyyy` token's `.20yy` tail can't be read as a price (shared BL-1 fix; see bank `parseLine`).
  // An invoice line item rarely leads with a date, so this is usually a no-op; when it does, the date is
  // dropped (line items carry no date field) and the description starts at the first non-date token.
  // `order` is the per-document date ordering (BL-N1), so a US `mm/dd/yyyy` lead column is recognised.
  const { rest } = splitLeadingDates(line, order)
  const matches = [...rest.matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  // F6 — DROP a space-column FUSION (`Widget 10 100` → `10 100` → 10100, ~100× too large). The bank path
  // is mitigated by the geometry column model (D58); the invoice path has NO geometry backstop (F10), so
  // a fusion-prone space-grouped token (no 2-dp decimal tail) on ANY column makes the row ambiguous.
  if (matches.some((m) => isFusedSpaceGroup(m[0]))) return null

  const amounts: number[] = []
  for (const m of matches) {
    const a = parseAmount(m[0])
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
  const afterLast = rest.slice((lastMatch.index ?? 0) + lastMatch[0].length)
  if (UNCAPTURED_AMOUNT_AFTER.test(afterLast)) return null

  let description = rest.slice(0, matches[0].index).trim()
  if (!description) return null
  // F3 — detect the per-line currency only in the FIGURE REGION (the text from the first money token on),
  // mirroring the bank `parseLine` BL-2 fix. detectCurrency scans ISO codes before symbols, so scanning
  // the whole `line` let a currency WORD in the free-text description (`USD adapter cable 12,50` on a EUR
  // invoice) beat the figure-adjacent symbol and tag the line USD; the line totals then summed across a
  // phantom mixed-currency set in `validateInvoiceTotals`. A genuine foreign-currency line prints its
  // code/symbol NEXT TO the amount (inside the figure region) and is still detected (mixed-currency
  // honesty preserved) — preferred over `documentCurrency ?? detectCurrency`, which would silently fold a
  // truly-mixed line into the document currency.
  const figureRegion = rest.slice(matches[0].index)
  const currency = detectCurrency(figureRegion) ?? documentCurrency
  if (!currency) return null

  // F8 — split a trailing number off the description as `quantity` ONLY when a unit token is present
  // (QTY_TRAIL_RE group 3) OR a second money column (a unit price, `amounts.length >= 2`) corroborates
  // it. Without either, a product-coded description (`iPhone 15`, `Calendar 2026`) had its trailing
  // number greedily read as a quantity. (lineTotal is unaffected — this is a metadata fix.)
  let quantity: number | undefined
  const qtyMatch = QTY_TRAIL_RE.exec(description)
  if (qtyMatch && qtyMatch[1].trim() && (qtyMatch[3] !== undefined || amounts.length >= 2)) {
    const q = Number(qtyMatch[2].replace(',', '.'))
    if (Number.isFinite(q)) {
      quantity = q
      description = qtyMatch[1].trim()
    }
  }

  const item: InvoiceLineItem = {
    description,
    lineTotal: amounts[amounts.length - 1],
    currency
  }
  if (quantity !== undefined) item.quantity = quantity
  if (amounts.length >= 2) item.unitPrice = amounts[amounts.length - 2]
  return item
}

/** Pure extractor over already-read chunks — header + line items + totals, ambiguous data dropped. */
export function extractInvoice(
  chunks: DocumentChunkRead[],
  documentCurrency: string | null,
  order?: DateOrder
): ExtractedInvoice {
  // Infer the document's date ordering ONCE (BL-N1) so US-ordered header dates parse mm/dd consistently.
  const dateOrder = order ?? inferDateOrder(chunks.map((c) => c.text).join('\n'))
  const header: InvoiceHeader = {}
  const lineItems: InvoiceLineItem[] = []
  const totals: InvoiceTotals = {}
  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (applyHeader(line, header, dateOrder)) continue
      if (applyTotals(line, totals)) continue
      const item = parseLineItem(line, documentCurrency, dateOrder)
      if (item) {
        lineItems.push(item)
        if (lineItems.length >= MAX_LINE_ITEMS) {
          if (documentCurrency && !header.currency) header.currency = documentCurrency
          return { header, lineItems, totals }
        }
      }
    }
  }
  if (documentCurrency && !header.currency) header.currency = documentCurrency
  return { header, lineItems, totals }
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
    const joined = chunks.map((c) => c.text).join('\n')
    // FIN-1 — document currency by MAJORITY VOTE over figure-adjacent detections (mirror of the bank
    // path): a currency WORD in a line-item description (left of the amount) or a stray code in a note no
    // longer beats the figure-adjacent / header-declared currency that the net/tax/gross are printed in.
    const currency = detectDocumentCurrency(joined)
    const invoice = extractInvoice(chunks, currency, inferDateOrder(joined))
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
