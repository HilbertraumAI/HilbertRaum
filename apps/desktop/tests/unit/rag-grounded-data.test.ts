import { describe, it, expect } from 'vitest'

// W3 (audit §3.1/§8.1) — the THIRD answer mode's PURE builders: the grounded-data prompt (rag) and the
// invoice data-block + deterministic totals postscript (invoice analysis). These carry no DB/runtime, so
// they are unit-tested directly: the model is handed the serialized VERIFIED extract with strict
// quote-figures-verbatim rules, and the parsed totals are echoed deterministically beneath any answer.

import { buildGroundedDataPrompt, GROUNDED_DATA_RULES } from '../../src/main/services/rag/grounded-data'
import {
  buildInvoiceDataBlock,
  buildTotalsPostscript
} from '../../src/main/services/skills/analysis/invoice'
import {
  buildStatementDataBlock,
  buildCashflowPostscript
} from '../../src/main/services/skills/analysis/bank-statement'
import { validateInvoiceTotals, type InvoiceInput } from '../../src/main/services/skills/tools/invoice'
import {
  buildStatementJson,
  reconcileBalances,
  summarizeCashflow,
  type StatementSnapshot,
  type TransactionInput
} from '../../src/main/services/skills/tools/bank-statement'
import { t } from '../../src/shared/i18n'

const tr = (key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]): string => t('en', key, params)

// A clean, reconciled invoice: 2 items summing to 120 net, 20% VAT (24), gross 144.
const CLEAN: InvoiceInput = {
  header: { vendor: 'Acme GmbH', invoiceNumber: 'INV-001', invoiceDate: '2026-01-15', currency: 'EUR' },
  lineItems: [
    { description: 'Widget', quantity: 2, unitPrice: 50, lineTotal: 100, currency: 'EUR' },
    { description: 'Gadget', quantity: 1, unitPrice: 20, lineTotal: 20, currency: 'EUR' }
  ],
  totals: { netTotal: 120, taxTotal: 24, taxRatePercent: 20, grossTotal: 144 }
}

describe('buildGroundedDataPrompt (W3 §8.1)', () => {
  it('carries the question, the fixed verbatim rules, and the data block, ending with Answer:', () => {
    const prompt = buildGroundedDataPrompt('Who is the vendor?', 'DATA-BLOCK-HERE')
    expect(prompt).toContain('Question:\nWho is the vendor?')
    expect(prompt).toContain(GROUNDED_DATA_RULES)
    expect(prompt).toContain('quote them EXACTLY')
    expect(prompt).toContain('Do NOT do arithmetic')
    expect(prompt).toContain('DATA-BLOCK-HERE')
    expect(prompt.trimEnd().endsWith('Answer:')).toBe(true)
  })

  it('places the skill fence between the question and the rules; omits it byte-for-byte when absent', () => {
    const withFence = buildGroundedDataPrompt('Q', 'D', '--- SKILL ---')
    expect(withFence).toContain('--- SKILL ---')
    expect(withFence.indexOf('--- SKILL ---')).toBeLessThan(withFence.indexOf(GROUNDED_DATA_RULES))

    const withNull = buildGroundedDataPrompt('Q', 'D', null)
    expect(withNull).toBe(buildGroundedDataPrompt('Q', 'D'))
    expect(withNull).not.toContain('--- SKILL ---')
  })
})

describe('buildInvoiceDataBlock (W3 §8.1)', () => {
  it('serializes the JSON, the deterministic reconciliation results, and a provenance note', () => {
    const block = buildInvoiceDataBlock(CLEAN, validateInvoiceTotals(CLEAN))
    expect(block).toContain('Invoice (JSON):')
    expect(block).toContain('"vendor": "Acme GmbH"')
    expect(block).toContain('"grossTotal": 144')
    // The three named reconciliation checks + the overall verdict, verbatim from the validator.
    expect(block).toContain('- lineItemsSumToNet: ok')
    expect(block).toContain('- netPlusTaxIsGross: ok')
    expect(block).toContain('- overall: reconciled')
    // The provenance line forbids the model from computing.
    expect(block).toContain('Quote these figures verbatim')
    expect(block).toContain('do not add, total, convert, or derive any number')
  })

  it('caps the line items at 150 with an honest omitted-count note (totals always kept)', () => {
    const many: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: Array.from({ length: 151 }, (_, i) => ({
        description: `Item ${i}`,
        lineTotal: 1,
        currency: 'EUR'
      })),
      totals: { grossTotal: 151 }
    }
    const block = buildInvoiceDataBlock(many, validateInvoiceTotals(many))
    expect(block).toContain('1 further line item(s) were parsed but omitted')
    // Item 149 is inside the cap; item 150 (the 151st, 0-indexed) is not present in the JSON.
    expect(block).toContain('"description": "Item 149"')
    expect(block).not.toContain('"description": "Item 150"')
    // Totals survive the cap.
    expect(block).toContain('"grossTotal": 151')
  })
})

describe('buildTotalsPostscript (W3 §8.1)', () => {
  it('echoes net/tax/gross verbatim from the parsed totals', () => {
    const post = buildTotalsPostscript(tr, CLEAN)
    expect(post).toContain('120.00')
    expect(post).toContain('24.00')
    expect(post).toContain('144.00')
    expect(post).toContain('EUR')
    // The localized wrapper frames the echo.
    expect(post).toContain(tr('skills.invoiceAnalysis.figureEchoGross', { amount: '144.00', currency: 'EUR' }))
  })

  it('returns empty when the extraction carried none of net/tax/gross (nothing to echo)', () => {
    const noTotals: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: [{ description: 'Widget', lineTotal: 10, currency: 'EUR' }],
      totals: {}
    }
    expect(buildTotalsPostscript(tr, noTotals)).toBe('')
  })

  it('echoes only the totals that were parsed (a missing figure is omitted, never invented)', () => {
    const netOnly: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: [{ description: 'Widget', lineTotal: 100, currency: 'EUR' }],
      totals: { netTotal: 100 }
    }
    const post = buildTotalsPostscript(tr, netOnly)
    expect(post).toContain('100.00')
    expect(post).not.toContain('tax')
    expect(post).not.toContain('gross')
  })
})

// ---- W4 (audit §3.1/§3.3/§8.1): the BANK port of the third mode's pure builders ----
// A clean 2-row statement: Grocery −45.90 (out), Salary +2500.00 (in); opening 2000 + Σ 2454.10 == 4454.10.
const ROWS: TransactionInput[] = [
  { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 },
  { date: '2026-01-03', description: 'Salary', amount: 2500, currency: 'EUR', balanceAfter: 4454.1 }
]
const SUMMARY = summarizeCashflow(ROWS)
const SNAP: StatementSnapshot = { rows: ROWS, summary: SUMMARY, openingBalance: 2000, closingBalance: 4454.1 }

describe('buildStatementJson (W4 §3.3)', () => {
  it('serializes the transactions + the cashflow summary + the printed balances (stable shape)', () => {
    const json = buildStatementJson(SNAP)
    const parsed = JSON.parse(json) as {
      openingBalance: number | null
      closingBalance: number | null
      currency: string | null
      summary: { totalIn: number; totalOut: number; net: number; count: number }
      transactions: Array<{ description: string; amount: number }>
    }
    expect(parsed.openingBalance).toBe(2000)
    expect(parsed.closingBalance).toBe(4454.1)
    expect(parsed.currency).toBe('EUR')
    expect(parsed.summary.totalIn).toBe(2500)
    expect(parsed.summary.totalOut).toBe(45.9)
    expect(parsed.summary.net).toBe(2454.1)
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.transactions.map((t) => t.description)).toEqual(['Grocery', 'Salary'])
  })

  it('emits null for an absent balance (never an invented figure)', () => {
    const noBalances: StatementSnapshot = { rows: ROWS, summary: SUMMARY }
    const parsed = JSON.parse(buildStatementJson(noBalances)) as { openingBalance: number | null }
    expect(parsed.openingBalance).toBeNull()
  })
})

describe('buildStatementDataBlock (W4 §8.1)', () => {
  it('serializes the JSON, the reconciliation + completeness verdict, categories, and provenance', () => {
    const block = buildStatementDataBlock({
      snap: SNAP,
      reconcile: reconcileBalances(ROWS),
      status: 'complete',
      categories: [{ category: 'Income', currency: 'EUR', amount: 2500, count: 1 }]
    })
    expect(block).toContain('Bank statement (JSON):')
    expect(block).toContain('"totalIn": 2500')
    expect(block).toContain('Balance reconciliation')
    expect(block).toContain('completeness:')
    expect(block).toContain('ties out') // the 'complete' completeness note
    // The category grouping the model can answer "how much on X?" over.
    expect(block).toContain('Category totals')
    expect(block).toContain('- Income: 2500.00 EUR (1 row(s))')
    // The provenance line forbids the model from computing.
    expect(block).toContain('Quote these figures verbatim')
    expect(block).toContain('do not add, total, convert, or derive any number')
  })

  it('flags a NOT-reconciled statement + mismatched row indices honestly', () => {
    // Row 1's printed balance can't follow row 0 → a mismatch (index 1).
    const bad: TransactionInput[] = [
      { date: '2026-01-02', description: 'Alpha', amount: -10, currency: 'EUR', balanceAfter: 100 },
      { date: '2026-01-03', description: 'Beta', amount: -10, currency: 'EUR', balanceAfter: 200 }
    ]
    const block = buildStatementDataBlock({
      snap: { rows: bad, summary: summarizeCashflow(bad) },
      reconcile: reconcileBalances(bad),
      status: 'contradicted',
      categories: []
    })
    expect(block).toContain('running balances: not reconciled')
    expect(block).toContain('rows whose printed running balance disagrees')
    expect(block).toContain('NOT verified as the whole statement') // the 'contradicted' note
    // No category section when none are passed.
    expect(block).not.toContain('Category totals')
  })

  it('caps the transactions at 150 with an honest omitted-count note (summary always kept)', () => {
    const many: TransactionInput[] = Array.from({ length: 151 }, (_, i) => ({
      date: '2026-01-01',
      description: `Row ${i}`,
      amount: -1,
      currency: 'EUR'
    }))
    const block = buildStatementDataBlock({
      snap: { rows: many, summary: summarizeCashflow(many) },
      reconcile: reconcileBalances(many),
      status: 'unverified',
      categories: []
    })
    expect(block).toContain('1 further transaction(s) were parsed but omitted')
    expect(block).toContain('"description": "Row 149"')
    expect(block).not.toContain('"description": "Row 150"')
  })
})

describe('buildCashflowPostscript (W4 §8.1)', () => {
  it('echoes money-in / money-out / net verbatim from the parsed summary', () => {
    const post = buildCashflowPostscript(tr, SUMMARY)
    expect(post).toContain('2500.00')
    expect(post).toContain('45.90')
    expect(post).toContain('2454.10')
    expect(post).toContain('EUR')
    expect(post).toContain(tr('skills.bankAnalysis.figureEchoNet', { amount: '2454.10', currency: 'EUR' }))
  })

  it('returns empty on a MIXED-currency statement (no single meaningful total to echo — BL-2)', () => {
    const mixed: TransactionInput[] = [
      { date: '2026-01-02', description: 'Coffee', amount: -3.5, currency: 'EUR' },
      { date: '2026-01-03', description: 'Book', amount: -10, currency: 'USD' }
    ]
    expect(buildCashflowPostscript(tr, summarizeCashflow(mixed))).toBe('')
  })
})
