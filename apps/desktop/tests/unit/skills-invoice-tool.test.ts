import { describe, it, expect } from 'vitest'
import {
  extractInvoiceTool,
  extractInvoice,
  parseLineItem,
  validateInvoiceTotals,
  validateInvoiceTotalsTool,
  exportInvoiceCsvTool,
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
