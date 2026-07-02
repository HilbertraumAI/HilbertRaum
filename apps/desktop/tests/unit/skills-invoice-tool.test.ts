import { describe, it, expect } from 'vitest'
import {
  extractInvoiceTool,
  extractInvoice,
  parseLineItem,
  validateInvoiceTotals,
  validateInvoiceTotalsTool,
  exportInvoiceCsvTool,
  exportInvoiceJsonTool,
  exportInvoiceXmlTool,
  buildInvoiceJson,
  buildInvoiceXml,
  lineItemsToCsv,
  type ExtractInvoiceOutput,
  type InvoiceInput
} from '../../src/main/services/skills/tools/invoice'
import { parseAmount, parseDate, detectCurrency } from '../../src/main/services/skills/tools/money'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import type { AuditEventType, DocumentChunkRead, SkillToolContext } from '../../src/shared/types'

// architecture.md "Skills — design record" §8 — the invoice Tier-2 tools, the SECOND content-class
// domain, proven in isolation: the deterministic/offline label parser, the honest "drop ambiguous
// data" posture, the totals reconciliation (ok/mismatch/unknown), and the CSV formula-injection
// neutralization. The tools run THROUGH the gate with schema-valid output. No DB, no Electron.

interface CapturedEvent {
  type: AuditEventType
  meta?: Record<string, unknown>
}

function makeCtx(
  chunks: DocumentChunkRead[],
  over: Partial<SkillToolContext> = {}
): { ctx: SkillToolContext; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const ctx: SkillToolContext = {
    documentIds: ['d1'],
    readDocumentChunks: (id) => (id === 'd1' ? chunks : []),
    signal: new AbortController().signal,
    audit: (type, meta) => events.push({ type, meta }),
    ...over
  }
  return { ctx, events }
}

function chunk(text: string, page: number | null = 1, index = 0): DocumentChunkRead {
  return { text, page, index }
}

// A well-formed bilingual-friendly invoice fixture (de-AT "1.234,56" amounts, day-first not needed here).
const INVOICE_TEXT = [
  'Invoice',
  'Vendor: ACME Supplies GmbH',
  'Invoice Number: INV-2026-0042',
  'Invoice Date: 2026-03-15',
  'Due Date: 2026-04-14',
  'Currency EUR',
  '',
  'Description            Qty   Unit Price   Line Total',
  'Widget A               2     12,50        25,00',
  'Consulting hours       3     100,00       300,00',
  '',
  'Net Total              325,00',
  'VAT 20%                65,00',
  'Gross Total            390,00'
].join('\n')

describe('invoice parser reuses the shared money/date helpers', () => {
  it('parseAmount/parseDate/detectCurrency behave as in the shared module', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56)
    expect(parseDate('31.01.2026')).toBe('2026-01-31')
    // A non-currency 3-letter token ("INV") must not block a later allowlisted "EUR".
    expect(detectCurrency('Rechnung INV-2026 Betrag EUR 100,00')).toBe('EUR')
    expect(detectCurrency('THE CAT SAT')).toBeNull()
  })
})

describe('extractInvoice (happy path)', () => {
  const invoice = extractInvoice([chunk(INVOICE_TEXT, 1)], 'EUR')

  it('parses the header from labeled lines (vendor, number, ISO dates, currency)', () => {
    expect(invoice.header).toEqual({
      vendor: 'ACME Supplies GmbH',
      invoiceNumber: 'INV-2026-0042',
      invoiceDate: '2026-03-15',
      dueDate: '2026-04-14',
      currency: 'EUR'
    })
  })

  it('parses line items with quantity, unit price, line total, and currency', () => {
    expect(invoice.lineItems).toEqual([
      { description: 'Widget A', quantity: 2, unitPrice: 12.5, lineTotal: 25, currency: 'EUR' },
      { description: 'Consulting hours', quantity: 3, unitPrice: 100, lineTotal: 300, currency: 'EUR' }
    ])
  })

  it('parses the totals incl. the VAT rate from the tax line', () => {
    expect(invoice.totals).toEqual({ netTotal: 325, taxTotal: 65, taxRatePercent: 20, grossTotal: 390 })
  })
})

describe('extractInvoice (conservative drops)', () => {
  it('drops a line item with no detectable currency (never invents one)', () => {
    const inv = extractInvoice([chunk('Widget X   2   9,99', 1)], null)
    expect(inv.lineItems).toEqual([])
  })

  it('parseLineItem sets only lineTotal when a single money token is present', () => {
    const li = parseLineItem('Flat service fee   50,00', 'EUR')
    expect(li).toEqual({ description: 'Flat service fee', lineTotal: 50, currency: 'EUR' })
  })

  it('parseLineItem strips a leading service-/delivery-date column before the money scan (shared BL-1 fix)', () => {
    // A line item that leads with a `dd.mm.yyyy` column: before BL-1, MONEY_RE read the date's `.20yy`
    // tail as a price (`07.04.2026` → `07.04.20` → 704.20) and mis-set unitPrice; now the leading date
    // is stripped, so the only price read is the real line total.
    const li = parseLineItem('07.04.2026 Consulting   120,00', 'EUR')
    expect(li).toEqual({ description: 'Consulting', lineTotal: 120, currency: 'EUR' })
    expect(li?.unitPrice).toBeUndefined() // the date fragment is NOT mistaken for a unit price
  })

  it('does not mistake a header/totals line for a line item (no figure invented)', () => {
    // "Gross Total" is a totals label, so it never becomes a line item; an unlabeled prose line with
    // no money is dropped.
    const inv = extractInvoice([chunk('Thank you for your business\nGross Total   100,00', 1)], 'EUR')
    expect(inv.lineItems).toEqual([])
    expect(inv.totals.grossTotal).toBe(100)
  })

  it('leaves header fields absent when no label is present (optional, never guessed)', () => {
    const inv = extractInvoice([chunk('Some item   10,00', 1)], 'EUR')
    expect(inv.header.vendor).toBeUndefined()
    expect(inv.header.invoiceNumber).toBeUndefined()
    expect(inv.header.currency).toBe('EUR') // detected, not guessed
  })
})

describe('extractInvoice (round totals printed without a decimal — invoice-totals-2026-07-01)', () => {
  // The "Invoice 04.02.26.pdf" shape: a common layout that prints its totals as ROUND integers with a
  // trailing currency symbol ("Total (excl. Tax) 914 $", "Tax 0 $", "Total (incl. Tax) 914 $"). MONEY_RE
  // rejects bare integers, so before the fix the whole net/tax/gross block came back EMPTY and the skill
  // answered "the invoice doesn't print a net, tax, or gross total I could read" on a perfectly clear bill.
  const REAL = [
    'INVOICE No.: 27',
    'Date:04.02.2026',
    '1 Description for Staking Page | STACKS 1 0% 142,80$ 142,80$',
    '2 Article "How to Earn Bitcoin" 1 0% 167,70$ 167,70$',
    '3 Article "Stablecoin Yield Farming" 1 0% 287,10$ 287,10$',
    '4 Article "How Institutions Are Reshaping Bitcoin" 1 0% 316,40$ 316,40$',
    'Total (excl. Tax) 914 $',
    'Tax 0 $',
    'Total (incl. Tax) 914 $'
  ].join('\n')
  const invoice = extractInvoice([chunk(REAL, 1)], 'USD')

  it('reads the bare-integer totals: net (excl. tax) → 914, tax → 0, gross (incl. tax) → 914', () => {
    expect(invoice.totals).toEqual({ netTotal: 914, taxTotal: 0, grossTotal: 914 })
  })

  it('reconciles: the four line items sum to the net, and net + tax equals the gross', () => {
    const result = validateInvoiceTotals(invoice)
    expect(result.reconciled).toBe(true)
    expect(result.checks.every((c) => c.status !== 'mismatch')).toBe(true)
  })

  it('parses the abbreviated "No.:" invoice number without leaking its "." (was ".: 27")', () => {
    expect(invoice.header.invoiceNumber).toBe('27')
    expect(invoice.header.invoiceDate).toBe('2026-02-04')
  })

  it('a bare integer NOT touching a currency marker is never read as a total (VAT id stays out)', () => {
    // "VAT: ATU81420204" starts with the tax label but the id is glued to letters (no adjacent currency)
    // — it must not be mistaken for a tax amount of 81 420 204.
    const inv = extractInvoice([chunk('VAT: ATU81420204\nTax 0 $', 1)], 'USD')
    expect(inv.totals.taxTotal).toBe(0)
  })
})

describe('extract_invoice through the gate', () => {
  it('returns schema-valid output that passes its own outputSchema', async () => {
    const { ctx, events } = makeCtx([chunk(INVOICE_TEXT, 1)])
    const result = await runSkillTool(extractInvoiceTool, {
      skillId: 'app:invoice',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractInvoiceOutput
      expect(out.lineItems).toHaveLength(2)
      expect(out.header.currency).toBe('EUR')
      expect(validateToolOutput(extractInvoiceTool, result.output)).toEqual([])
    }
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('refuses invalid input (no documentId) without running', async () => {
    const { ctx } = makeCtx([])
    const result = await runSkillTool(extractInvoiceTool, { skillId: 'app:invoice', input: {}, ctx })
    expect(result.ok).toBe(false)
  })

  it('reads only via readDocumentChunks — an out-of-scope id yields an empty invoice', async () => {
    const { ctx } = makeCtx([], { readDocumentChunks: () => [] })
    const result = await runSkillTool(extractInvoiceTool, {
      skillId: 'app:invoice',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as ExtractInvoiceOutput).lineItems).toEqual([])
  })
})

// ---- the downstream tools as PURE functions + through the gate ----

const invoiceInput = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  header: { currency: 'EUR' },
  lineItems: [{ description: 'Widget A', lineTotal: 25, currency: 'EUR' }],
  totals: {},
  ...over
})

function downstreamCtx(): SkillToolContext {
  return {
    documentIds: ['d1'],
    readDocumentChunks: () => [],
    signal: new AbortController().signal,
    audit: () => {}
  }
}

describe('validate_invoice_totals', () => {
  it('reports ok for each check when the printed totals reconcile', () => {
    const res = validateInvoiceTotals({
      header: { currency: 'EUR' },
      lineItems: [
        { description: 'A', lineTotal: 25, currency: 'EUR' },
        { description: 'B', lineTotal: 300, currency: 'EUR' }
      ],
      totals: { netTotal: 325, taxTotal: 65, taxRatePercent: 20, grossTotal: 390 }
    })
    expect(res.reconciled).toBe(true)
    expect(res.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('flags a mismatch (net + tax ≠ gross), keeping the reconciling checks ok', () => {
    const res = validateInvoiceTotals({
      header: { currency: 'EUR' },
      lineItems: [{ description: 'A', lineTotal: 325, currency: 'EUR' }],
      totals: { netTotal: 325, taxTotal: 65, taxRatePercent: 20, grossTotal: 400 } // gross wrong
    })
    expect(res.reconciled).toBe(false)
    const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.status]))
    expect(byName.lineItemsSumToNet).toBe('ok')
    expect(byName.netPlusTaxIsGross).toBe('mismatch')
    expect(byName.taxMatchesRate).toBe('ok')
  })

  it('reports unknown when a needed figure is absent (never assumes correct)', () => {
    const res = validateInvoiceTotals({
      header: { currency: 'EUR' },
      lineItems: [{ description: 'A', lineTotal: 25, currency: 'EUR' }],
      totals: {} // nothing printed to check
    })
    expect(res.reconciled).toBe(false)
    expect(res.checks.every((c) => c.status === 'unknown')).toBe(true)
  })

  it('runs through the gate with schema-valid output', async () => {
    const result = await runSkillTool(validateInvoiceTotalsTool, {
      skillId: 'app:invoice',
      input: invoiceInput({ totals: { netTotal: 25 } }),
      ctx: downstreamCtx()
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateToolOutput(validateInvoiceTotalsTool, result.output)).toEqual([])
  })
})

describe('export_invoice_csv', () => {
  it('lineItemsToCsv writes a header + escaped rows, fixed-dp numbers, blanks for nulls', () => {
    const csv = lineItemsToCsv([
      { description: 'Café, Vienna', quantity: 2, unitPrice: 12.5, lineTotal: 25, currency: 'EUR' },
      { description: 'Service', lineTotal: 100, currency: 'EUR' }
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('description,quantity,unitPrice,lineTotal,currency')
    expect(lines[1]).toBe('"Café, Vienna",2.00,12.50,25.00,EUR') // comma field quoted; fixed-dp
    expect(lines[2]).toBe('Service,,,100.00,EUR') // absent quantity/unitPrice blank
  })

  it('neutralizes spreadsheet formula injection in text fields (S12 audit F4)', () => {
    const csv = lineItemsToCsv([
      { description: '=HYPERLINK("http://evil","click")', lineTotal: 1, currency: 'EUR' },
      { description: '\t@cmd', lineTotal: 2, currency: 'EUR' },
      { description: '  =1+1', lineTotal: 3, currency: 'EUR' },
      { description: 'safe text', lineTotal: 4, currency: 'EUR' }
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://evil"",""click"")",,,1.00,EUR')
    expect(lines[2]).toBe("'\t@cmd,,,2.00,EUR") // leading tab neutralized, not a quote trigger
    expect(lines[3]).toBe("'  =1+1,,,3.00,EUR") // quote prefixed before the leading spaces
    expect(lines[4]).toBe('safe text,,,4.00,EUR')
  })

  it('is confirm-gated: the gate refuses it without confirmation', async () => {
    const refused = await runSkillTool(exportInvoiceCsvTool, {
      skillId: 'app:invoice',
      input: invoiceInput(),
      ctx: downstreamCtx()
    })
    expect(refused.ok).toBe(false)
    const ok = await runSkillTool(exportInvoiceCsvTool, {
      skillId: 'app:invoice',
      input: invoiceInput(),
      ctx: downstreamCtx(),
      confirmed: true
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(validateToolOutput(exportInvoiceCsvTool, ok.output)).toEqual([])
  })
})

describe('JSON / XML serializers (invoice-format-2026-07-01)', () => {
  const full = (): InvoiceInput => ({
    header: { vendor: 'ACME', invoiceNumber: 'INV-1', invoiceDate: '2026-03-15', currency: 'EUR' },
    lineItems: [
      { description: 'Widget A', quantity: 2, unitPrice: 12.5, lineTotal: 25, currency: 'EUR' },
      { description: 'Consulting', lineTotal: 300, currency: 'EUR' }
    ],
    totals: { netTotal: 325, taxTotal: 65, taxRatePercent: 20, grossTotal: 390 }
  })

  it('buildInvoiceJson emits parseable JSON with the extracted figures and a stable shape', () => {
    const parsed = JSON.parse(buildInvoiceJson(full())) as {
      invoiceNumber: string
      dueDate: string | null
      lineItems: Array<{ lineTotal: number }>
      totals: Record<string, number | null>
    }
    expect(parsed.invoiceNumber).toBe('INV-1')
    expect(parsed.dueDate).toBeNull() // absent field is an explicit null (stable shape)
    expect(parsed.lineItems).toHaveLength(2)
    expect(parsed.lineItems[0].lineTotal).toBe(25)
    expect(parsed.totals.grossTotal).toBe(390)
    expect(parsed.totals.taxRatePercent).toBe(20)
  })

  it('buildInvoiceXml emits well-formed XML, 2-dp numbers, absent fields omitted', () => {
    const xml = buildInvoiceXml(full())
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<invoice>/)
    expect(xml).toContain('<invoiceNumber>INV-1</invoiceNumber>')
    expect(xml).toContain('<lineTotal>25.00</lineTotal>')
    expect(xml).toContain('<grossTotal>390.00</grossTotal>')
    expect(xml).not.toContain('<dueDate>') // absent field omitted, never an empty element
  })

  it('buildInvoiceXml escapes the five XML entities in a description (markup can never break)', () => {
    const xml = buildInvoiceXml({
      header: { currency: 'EUR' },
      lineItems: [{ description: 'A & B <"x"> \'y\'', lineTotal: 1, currency: 'EUR' }],
      totals: {}
    })
    expect(xml).toContain('<description>A &amp; B &lt;&quot;x&quot;&gt; &apos;y&apos;</description>')
    expect(xml).not.toMatch(/<description>A & B/)
  })

  it('the JSON / XML export tools are confirm-gated and return schema-valid {content, rowCount}', async () => {
    for (const tool of [exportInvoiceJsonTool, exportInvoiceXmlTool]) {
      const refused = await runSkillTool(tool, { skillId: 'app:invoice', input: full(), ctx: downstreamCtx() })
      expect(refused.ok).toBe(false)
      const ok = await runSkillTool(tool, {
        skillId: 'app:invoice',
        input: full(),
        ctx: downstreamCtx(),
        confirmed: true
      })
      expect(ok.ok).toBe(true)
      if (ok.ok) {
        expect(validateToolOutput(tool, ok.output)).toEqual([])
        expect((ok.output as { rowCount: number }).rowCount).toBe(2)
      }
    }
  })
})

// full-audit-2026-06-28 Phase 1 (financial correctness): adversarial whole-string tests through the real
// invoice entry points (extractInvoice / parseLineItem). The invoice path shares money.ts with the bank
// path, so the same locale/grouping/trailing-date fixes apply.
describe('financial correctness (full-audit-2026-06-28 Phase 1)', () => {
  it('BL-N1: infers month-first invoice/due dates on a US-ordered invoice', () => {
    const inv = extractInvoice(
      [chunk('Invoice\nInvoice date 06/15/2026\nDue date 07/20/2026\nWidget 50,00', 1)],
      'EUR'
    )
    // BEFORE: 06/15 read day-first (day 6, month 15) → invalid → null → the header date silently dropped.
    expect(inv.header.invoiceDate).toBe('2026-06-15')
    expect(inv.header.dueDate).toBe('2026-07-20')
  })

  it('BL-N2: a trailing-date total line reads the FIGURE, not the date, as the total', () => {
    const inv = extractInvoice([chunk('Invoice\nGross total 390,00 EUR per 30.06.2026', 1)], 'EUR')
    expect(inv.totals.grossTotal).toBe(390) // BEFORE: lastMoney read '30.06.20' → 3006.20
  })

  it('TEST-N2: parseLineItem reads grouped figures (thousands / space / apostrophe) whole (DECISION 2)', () => {
    expect(parseLineItem('Maschine 12.500', 'EUR')).toMatchObject({ lineTotal: 12500 }) // BEFORE: 12.5
    expect(parseLineItem('Charge 1 234 567,89', 'EUR')).toMatchObject({ lineTotal: 1234567.89 }) // BEFORE: 567.89
    expect(parseLineItem("Pos 1'234.56", 'CHF')).toMatchObject({ lineTotal: 1234.56 }) // BEFORE: 234.56
  })
})

// full-audit-2026-06-29-postmerge Phase 1 (money-parser correctness): the invoice path is the more
// exposed money path (no geometry backstop, F10). F1 (uncaptured line-total column), F3 (per-line
// currency from the whole line + the missing single-currency guard), F6 (space-column fusion), F8
// (greedy qty split), T5 (2-dp invariant), T9 (negative line totals). Whole-string fixtures through the
// real `parseLineItem` / `validateInvoiceTotals`.
describe('money-parser correctness (full-audit-2026-06-29-postmerge Phase 1)', () => {
  // ---- F1: an uncaptured line-total column (the real total to the RIGHT) must not yield a wrong total ----
  it('F1: a row whose REAL line total is an uncaptured whole-number column is DROPPED', () => {
    // `Hosting 12,50 500`: the unit price `12,50` matches but the line total `500` is a bare integer
    // MONEY_RE rejects, so it collapses to ONE money token. BEFORE (F1 bug): lineTotal = amounts[last] =
    // 12.50 (the unit price read as the line total — the real 500 lost). NOW: an uncaptured numeric column
    // to the RIGHT of the last money token (invoices read the line total as the LAST figure) makes the
    // line total ambiguous → DROP (honesty). The bank mirror drops on a LEFT-side uncaptured column
    // because the bank reads the amount as the second-to-last figure — the asymmetry is intentional.
    expect(parseLineItem('Hosting 12,50 500', 'EUR')).toBeNull()
  })

  it('F1: a clean line item with the line total LAST (no uncaptured column) still parses', () => {
    // The drop is scoped to an uncaptured numeric column abutting the figures: an ordinary single-total
    // line is unaffected.
    expect(parseLineItem('Flat service fee 50,00', 'EUR')).toEqual({
      description: 'Flat service fee',
      lineTotal: 50,
      currency: 'EUR'
    })
  })

  // ---- F6: space-separated columns must not fuse into one figure on the geometry-less invoice path ----
  it('F6: space-separated columns are DROPPED, never fused into one ~100×-too-large figure', () => {
    // `Widget 10 100`: MONEY_RE's space-grouped alternative reads `10 100` as ONE figure → 10100 (qty 10 +
    // amount 100 fused). BEFORE: lineTotal = 10100. NOW: a space-grouped token WITHOUT a 2-dp decimal tail
    // is column-fusion-prone on the geometry-less invoice path → the row is DROPPED. A decimal-anchored
    // space group (`1 234 567,89`) is a real figure and is preserved (next test).
    expect(parseLineItem('Widget 10 100', 'EUR')).toBeNull()
  })

  it('F6: a decimal-anchored space-grouped figure is still read whole (not a false fusion drop)', () => {
    expect(parseLineItem('Charge 1 234 567,89', 'EUR')).toMatchObject({ lineTotal: 1234567.89 })
  })

  // ---- F8: a trailing number is split as quantity ONLY with a unit token or a corroborating column ----
  it('F8: a product-coded description does NOT split a trailing number as quantity', () => {
    // `iPhone 15 1.799,00`: BEFORE the trailing `15` was split off as quantity (description "iPhone"), with
    // no unit word and no unit-price column to corroborate. NOW the split requires a unit token OR a
    // second money column (a unit price) → "iPhone 15" stays the description, no quantity. (lineTotal was
    // always correct — this is a metadata fix. The thousands-dot price keeps the `15` from fusing across
    // the space into the figure — see the F6 fusion trade-off.)
    expect(parseLineItem('iPhone 15 1.799,00', 'EUR')).toEqual({
      description: 'iPhone 15',
      lineTotal: 1799,
      currency: 'EUR'
    })
  })

  it('F8: a trailing quantity WITH a unit token still splits', () => {
    expect(parseLineItem('Cable 3 x 50,00', 'EUR')).toMatchObject({
      description: 'Cable',
      quantity: 3,
      lineTotal: 50
    })
  })

  it('F8: a quantity corroborated by a unit-price column still splits (the columnar happy path)', () => {
    // `Widget A 2 12,50 25,00`: two money columns (unit price 12,50 + line total 25,00) corroborate the
    // bare `2` as a quantity, so the split is allowed even without a unit word.
    expect(parseLineItem('Widget A 2 12,50 25,00', 'EUR')).toEqual({
      description: 'Widget A',
      quantity: 2,
      unitPrice: 12.5,
      lineTotal: 25,
      currency: 'EUR'
    })
  })

  // ---- F3: per-line currency is detected only in the FIGURE REGION (mirror of the bank BL-2 fix) ----
  it('F3: a currency WORD in the description no longer overrides the document currency', () => {
    // `USD adapter cable 12,50` on a EUR invoice: detectCurrency scans ISO codes before symbols, so the
    // description "USD" used to beat the document currency. BEFORE: currency "USD". NOW: detection scans
    // only the figure region (from the first money token on), so the description "USD" is ignored →
    // falls back to the document currency EUR.
    expect(parseLineItem('USD adapter cable 12,50', 'EUR')).toMatchObject({ currency: 'EUR' })
  })

  it('F3: a GENUINELY figure-adjacent foreign currency is still detected', () => {
    // A foreign code printed NEXT TO the amount (inside the figure region) is still honoured — mixed-
    // currency honesty preserved.
    expect(parseLineItem('Imported part 20,00 USD', 'EUR')).toMatchObject({ currency: 'USD', lineTotal: 20 })
  })

  it('F3: validateInvoiceTotals returns lineItemsSumToNet:unknown for MIXED line-item currencies', () => {
    // Without a single-currency guard the line totals were summed across currencies and reconciled against
    // a meaningless cross-currency figure (a spurious ok/mismatch). NOW a >1 currency set → unknown
    // (mirrors assessCompleteness/reconcileBalances).
    const res = validateInvoiceTotals({
      header: {},
      lineItems: [
        { description: 'A', lineTotal: 100, currency: 'EUR' },
        { description: 'B', lineTotal: 50, currency: 'USD' }
      ],
      totals: { netTotal: 150 } // 100 + 50 == 150 would spuriously pass if summed across currencies
    })
    const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.status]))
    expect(byName.lineItemsSumToNet).toBe('unknown')
  })

  it('F3: a single-currency invoice still reconciles its line items to the net (guard does not over-fire)', () => {
    const res = validateInvoiceTotals({
      header: { currency: 'EUR' },
      lineItems: [
        { description: 'A', lineTotal: 100, currency: 'EUR' },
        { description: 'B', lineTotal: 50, currency: 'EUR' }
      ],
      totals: { netTotal: 150 }
    })
    const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.status]))
    expect(byName.lineItemsSumToNet).toBe('ok')
  })

  // ---- T5: the 2-dp integer-cent invariant on the invoice path ----
  it('T5: a >2-dp line total is normalised to the nearest cent', () => {
    const li = parseLineItem('Pos 1.234,567', 'EUR')
    expect(li?.lineTotal).toBe(1234.57) // BEFORE: 1234.567
    expect(li?.lineTotal).toBe(Math.round((li?.lineTotal ?? 0) * 100) / 100) // exactly 2-dp
  })

  // ---- T9: negative line totals / credit notes (Gutschrift / Rabatt) ----
  it('T9: a negative line total (Rabatt / Gutschrift) parses with the correct sign', () => {
    expect(parseLineItem('Rabatt -50,00', 'EUR')).toMatchObject({ lineTotal: -50 })
    expect(parseLineItem('Gutschrift (30,00)', 'EUR')).toMatchObject({ lineTotal: -30 })
  })
})

// full-audit-2026-06-29 follow-up Phase 1 (financial correctness): FIN-1 (document currency by MAJORITY
// VOTE over figure-adjacent detections — mirror of the bank fix) + FIN-2 (the F1 right-side uncaptured-
// column drop only fires on a money-shaped-but-rejected trailing token, so a valid item with a trailing
// annotation is no longer deleted) + FIN-4 (date order from the leading date column only). Whole-string
// fixtures through the real `extractInvoiceTool` / `extractInvoice` / `parseLineItem`.
describe('financial correctness (full-audit-2026-06-29 follow-up Phase 1)', () => {
  // ---- FIN-1: a currency word in a line-item description must not stamp the invoice currency ----
  it('FIN-1: a currency word in a line-item description no longer overrides the header-declared currency', async () => {
    // "USD adapter cable 12,50" on a EUR invoice: detectCurrency scans ISO codes before symbols, so the
    // description "USD" (earlier in the text than the "Currency EUR" header line) used to win the tool's
    // detectCurrency(joined) → net/tax/gross printed in the WRONG code. The tool now majority-votes over
    // figure-adjacent detections + header declarations, so the left-of-figure "USD" no longer counts.
    const text = ['Invoice', 'USD adapter cable 12,50', 'Net Total 12,50', 'Gross Total 12,50', 'Currency EUR'].join('\n')
    const { ctx } = makeCtx([chunk(text, 1)])
    const result = await runSkillTool(extractInvoiceTool, { skillId: 'app:invoice', input: { documentId: 'd1' }, ctx })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractInvoiceOutput
      expect(out.header.currency).toBe('EUR') // BEFORE: 'USD'
      expect(out.lineItems[0].currency).toBe('EUR') // BEFORE: 'USD'
    }
  })

  // ---- FIN-2: the right-side uncaptured-column drop must not delete valid items with trailing annotations ----
  it('FIN-2: keeps a valid line item with a trailing position annotation', () => {
    expect(parseLineItem('Service 12,50 (Pos. 3)', 'EUR')).toEqual({ description: 'Service', lineTotal: 12.5, currency: 'EUR' })
  })

  it('FIN-2: keeps a valid line item with a trailing per-line VAT %', () => {
    expect(parseLineItem('Beratung 1.234,56 19% MwSt', 'EUR')).toEqual({ description: 'Beratung', lineTotal: 1234.56, currency: 'EUR' })
  })

  it('FIN-2: keeps a valid line item with a trailing currency + unit token', () => {
    expect(parseLineItem('Line 50,00 EUR 2 Stk', 'EUR')).toEqual({ description: 'Line', lineTotal: 50, currency: 'EUR' })
  })

  it('FIN-2: still DROPS a genuine uncaptured whole-number total column (F1 preserved)', () => {
    // The region after the last money match is ENTIRELY a bare integer (the real line total) → ambiguous → drop.
    expect(parseLineItem('Hosting 12,50 500', 'EUR')).toBeNull()
  })

  // ---- FIN-4: a US-format date inside a line-item description must not flip the header date order ----
  it('FIN-4: a US-format date in a line-item description does not flip the header date order', () => {
    const inv = extractInvoice([chunk('Invoice\nInvoice date 05.03.2026\nWidget delivered 03/15/2026 100,00', 1)], 'EUR')
    // BEFORE: the memo 03/15/2026 (US) flipped the whole document to month-first → 05.03.2026 → 3 May.
    expect(inv.header.invoiceDate).toBe('2026-03-05')
  })
})

// ---------------------------------------------------------------------------------------------------
// R1 (skills-remediation, audit §5.3 + §5.7-low). Two fixes, both executing the REAL extractor:
//   §5.3   — the shared `normalizeExtractionText` pre-pass at `extractInvoice`'s entry (a Unicode minus /
//            no-break-space thousands separator / Swiss U+2019 apostrophe group read correctly).
//   §5.7-low — `totalsMoney`'s currency-adjacent bare-integer fallback is now SIGN-AWARE, so a credit-note
//            total printed WITHOUT a decimal/grouping keeps its sign (a credit is not read as a charge).
// ---------------------------------------------------------------------------------------------------
describe('R1 — invoice Unicode normalization + sign-aware bare-integer total (audit §5.3 / §5.7-low)', () => {
  const MINUS = '\u2212' // MINUS SIGN
  const NBSP = '\u00A0' // NO-BREAK SPACE
  const RSQUO = '\u2019' // RIGHT SINGLE QUOTATION MARK (Swiss apostrophe grouping)

  it('§5.3: an NBSP-grouped total reads its FULL magnitude (1 234,56 → 1234.56, not 234.56)', () => {
    const invoice = extractInvoice([chunk(`Gesamtbetrag 1${NBSP}234,56 EUR`, 1)], 'EUR')
    expect(invoice.totals.grossTotal).toBe(1234.56)
  })

  it('§5.3: a U+2212 minus on a net total signs it negative (−325,00 → −325)', () => {
    const invoice = extractInvoice([chunk(`Nettobetrag ${MINUS}325,00 EUR`, 1)], 'EUR')
    expect(invoice.totals.netTotal).toBe(-325)
  })

  it('§5.3: a Swiss U+2019 apostrophe-grouped gross total reads 1’234.56 → 1234.56', () => {
    const invoice = extractInvoice([chunk(`Gesamtbetrag 1${RSQUO}234.56 CHF`, 1)], 'CHF')
    expect(invoice.totals.grossTotal).toBe(1234.56)
  })

  it('§5.7-low: a credit-note bare-integer total keeps its sign (Gesamtbetrag -914 EUR → −914)', () => {
    const invoice = extractInvoice([chunk('Gesamtbetrag -914 EUR', 1)], 'EUR')
    expect(invoice.totals.grossTotal).toBe(-914)
  })

  it('§5.7-low: a POSITIVE bare-integer total is unchanged — no regression (Gesamtbetrag 914 EUR → 914)', () => {
    const invoice = extractInvoice([chunk('Gesamtbetrag 914 EUR', 1)], 'EUR')
    expect(invoice.totals.grossTotal).toBe(914)
  })
})

// ---------------------------------------------------------------------------------------------------
// R2 (skills-remediation, audit §5.2 CRITICAL + §5.4). Structural label matching (word boundary +
// "remainder is just the figure"), last-totals-block-wins, the summary-line guard, and the extended
// German totals vocabulary — all executing the REAL extractor over the audit's probe inputs.
// ---------------------------------------------------------------------------------------------------
describe('R2 — structural invoice label matching + last-block-wins + summary guard (audit §5.2 / §5.4)', () => {
  it('§5.2 CRITICAL: "Steuerberatung Jänner 500,00 EUR" is a LINE ITEM, never a taxTotal', () => {
    const inv = extractInvoice([chunk('Steuerberatung Jänner 500,00 EUR', 1)], 'EUR')
    // BEFORE: `steuer` prefix-matched → 500 stolen into taxTotal, the item deleted. NOW the word boundary
    // stops the mid-word match, so the line is the ordinary consulting line item it is.
    expect(inv.totals.taxTotal).toBeUndefined()
    expect(inv.lineItems).toEqual([{ description: 'Steuerberatung Jänner', lineTotal: 500, currency: 'EUR' }])
  })

  it('§5.2: a totals label whose remainder still carries a description stays a LINE ITEM', () => {
    // Each begins with a totals word but has a real description after it → NOT a total (isFillerOnly fails).
    expect(extractInvoice([chunk('Netto-Miete Objekt 3 1.000,00 EUR', 1)], 'EUR')).toMatchObject({
      lineItems: [{ description: 'Netto-Miete Objekt 3', lineTotal: 1000, currency: 'EUR' }],
      totals: {}
    })
    expect(extractInvoice([chunk('Total hours consulting 40,00 EUR', 1)], 'EUR')).toMatchObject({
      lineItems: [{ description: 'Total hours consulting', lineTotal: 40, currency: 'EUR' }],
      totals: {}
    })
    // "Due" is a header (due-date) label; header matching must not swallow a money-bearing line either.
    expect(extractInvoice([chunk('Due diligence review 2.000,00 EUR', 1)], 'EUR')).toMatchObject({
      lineItems: [{ description: 'Due diligence review', lineTotal: 2000, currency: 'EUR' }],
      header: {}
    })
  })

  it('§5.2: a genuine boundary-matched totals label still parses (no over-correction)', () => {
    expect(extractInvoice([chunk('Steuer: 60,00 EUR', 1)], 'EUR')).toMatchObject({
      totals: { taxTotal: 60 },
      lineItems: []
    })
    expect(extractInvoice([chunk('Tax 60,00 EUR', 1)], 'EUR')).toMatchObject({
      totals: { taxTotal: 60 },
      lineItems: []
    })
  })

  it('§5.4: extended German summary labels resolve to totals with ZERO phantom line items', () => {
    const summe = extractInvoice([chunk('Summe 300,00 EUR', 1)], 'EUR')
    expect(summe.totals.grossTotal).toBe(300)
    expect(summe.lineItems).toEqual([])

    const rsumme = extractInvoice([chunk('Rechnungssumme inkl. USt 360,00 EUR', 1)], 'EUR')
    expect(rsumme.totals.grossTotal).toBe(360)
    expect(rsumme.lineItems).toEqual([])

    const endbetrag = extractInvoice([chunk('Endbetrag 360,00 EUR', 1)], 'EUR')
    expect(endbetrag.totals.grossTotal).toBe(360)
    expect(endbetrag.lineItems).toEqual([])
  })

  it('§5.2: the LAST totals block wins (a later gross overwrites an earlier one)', () => {
    const inv = extractInvoice([chunk('Gesamtbetrag 100,00 EUR\nGesamtbetrag 250,00 EUR', 1)], 'EUR')
    expect(inv.totals.grossTotal).toBe(250) // BEFORE: 100 (first-wins)
  })

  it('§5.2: the canonical Austrian tax-advisor invoice — probe rows stay items, totals from the real block', () => {
    const TEXT = [
      'Rechnung',
      'Lieferant: Steuerberatung Muster GmbH',
      'Rechnungsnummer: R-2026-001',
      'Rechnungsdatum: 15.01.2026',
      'Steuerberatung Jänner 500,00 EUR',
      'Netto-Miete Objekt 3 1.000,00 EUR',
      'Total hours consulting 40,00 EUR',
      'Due diligence review 2.000,00 EUR',
      'Summe netto 3.540,00 EUR',
      'Umsatzsteuer 20% 708,00 EUR',
      'Rechnungssumme inkl. USt 4.248,00 EUR'
    ].join('\n')
    const inv = extractInvoice([chunk(TEXT, 1)], 'EUR')
    // All four probe rows are LINE ITEMS — none stolen into a total, none a phantom summary item.
    expect(inv.lineItems.map((li) => li.description)).toEqual([
      'Steuerberatung Jänner',
      'Netto-Miete Objekt 3',
      'Total hours consulting',
      'Due diligence review'
    ])
    expect(inv.lineItems.map((li) => li.lineTotal)).toEqual([500, 1000, 40, 2000])
    // Totals read from the real block below the items — and they reconcile end to end.
    expect(inv.totals).toEqual({ netTotal: 3540, taxTotal: 708, taxRatePercent: 20, grossTotal: 4248 })
    expect(validateInvoiceTotals(inv).reconciled).toBe(true)
    // The vendor name that BEGINS with "Steuerberatung" is captured as the vendor, not read as a tax label.
    expect(inv.header.vendor).toBe('Steuerberatung Muster GmbH')
  })
})
