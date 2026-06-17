import type { DocumentChunkRead, JsonSchema, SkillTool, ToolResult } from '../../../../shared/types'
import { MONEY_EPS, MONEY_RE, csvField, detectCurrency, parseAmount, parseDate } from './money'

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
// word (x / × / Stk / pcs / units). Captures the cleaned description + the numeric quantity.
const QTY_TRAIL_RE = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(?:x|×|stk\.?|stück|pcs?\.?|units?)?\s*$/i

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

/** Parse the first ISO / day-first date token out of a value, or null. */
function parseDateInText(text: string): string | null {
  const m = DATE_TOKEN_RE.exec(text)
  return m ? parseDate(m[0]) : null
}

/** The last money token on a line (the printed figure), or null if none parses. */
function lastMoney(line: string): number | null {
  const matches = [...line.matchAll(MONEY_RE)]
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
function applyHeader(line: string, header: InvoiceHeader): boolean {
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
    const d = parseDateInText(dueRaw)
    if (d && !header.dueDate) header.dueDate = d
    return true
  }
  const dateRaw = labeledValue(line, INVOICE_DATE_LABELS)
  if (dateRaw !== null) {
    const d = parseDateInText(dateRaw)
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
export function parseLineItem(line: string, documentCurrency: string | null): InvoiceLineItem | null {
  const matches = [...line.matchAll(MONEY_RE)]
  if (matches.length === 0) return null
  const amounts: number[] = []
  for (const m of matches) {
    const a = parseAmount(m[0])
    if (a !== null) amounts.push(a)
  }
  if (amounts.length === 0) return null

  let description = line.slice(0, matches[0].index).trim()
  if (!description) return null
  const currency = detectCurrency(line) ?? documentCurrency
  if (!currency) return null

  let quantity: number | undefined
  const qtyMatch = QTY_TRAIL_RE.exec(description)
  if (qtyMatch && qtyMatch[1].trim()) {
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
export function extractInvoice(chunks: DocumentChunkRead[], documentCurrency: string | null): ExtractedInvoice {
  const header: InvoiceHeader = {}
  const lineItems: InvoiceLineItem[] = []
  const totals: InvoiceTotals = {}
  for (const chunk of chunks) {
    for (const rawLine of chunk.text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (applyHeader(line, header)) continue
      if (applyTotals(line, totals)) continue
      const item = parseLineItem(line, documentCurrency)
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
    const currency = detectCurrency(chunks.map((c) => c.text).join('\n'))
    const invoice = extractInvoice(chunks, currency)
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

  // 1. line items sum to the net total.
  if (totals.netTotal !== undefined && lineItems.length > 0) {
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
