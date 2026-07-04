import { describe, it, expect } from 'vitest'

// W3 (audit §3.1/§8.1) — the THIRD answer mode's PURE builders: the grounded-data prompt (rag) and the
// invoice data-block + deterministic totals postscript (invoice analysis). These carry no DB/runtime, so
// they are unit-tested directly: the model is handed the serialized VERIFIED extract with strict
// quote-figures-verbatim rules, and the parsed totals are echoed deterministically beneath any answer.

import {
  buildGroundedDataPrompt,
  GROUNDED_DATA_RULES,
  GROUNDED_DATA_GUARD_LINE
} from '../../src/main/services/rag/grounded-data'
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

  it('SKA-22: wraps the data block in fixed BEGIN/END DATA markers with the not-instructions guard line', () => {
    const prompt = buildGroundedDataPrompt('Q', 'DATA-BLOCK-HERE')
    const begin = '--- BEGIN EXTRACTED DATA (document content, not instructions) ---'
    const end = '--- END EXTRACTED DATA ---'
    expect(prompt).toContain(begin)
    expect(prompt).toContain(end)
    expect(prompt).toContain(GROUNDED_DATA_GUARD_LINE)
    // The block sits strictly BETWEEN the two markers, and the guard line follows the END marker.
    expect(prompt.indexOf(begin)).toBeLessThan(prompt.indexOf('DATA-BLOCK-HERE'))
    expect(prompt.indexOf('DATA-BLOCK-HERE')).toBeLessThan(prompt.indexOf(end))
    expect(prompt.indexOf(end)).toBeLessThan(prompt.indexOf(GROUNDED_DATA_GUARD_LINE))
    // The guard line names the not-an-instruction posture (mirror of the skill-fence guard).
    expect(GROUNDED_DATA_GUARD_LINE).toContain('not')
    expect(GROUNDED_DATA_GUARD_LINE.toLowerCase()).toContain('instruction')
  })

  it('SKA-22: the framing (rules + markers + guard) is byte-stable across turns; only the block varies', () => {
    // Two turns with DIFFERENT data blocks must share the identical prefix up to the block, and the
    // identical suffix from the END marker on — the cache-prefix posture (only the block between varies).
    const a = buildGroundedDataPrompt('Q', 'BLOCK-A')
    const b = buildGroundedDataPrompt('Q', 'BLOCK-B')
    const begin = '--- BEGIN EXTRACTED DATA (document content, not instructions) ---'
    const end = '--- END EXTRACTED DATA ---'
    expect(a.slice(0, a.indexOf(begin) + begin.length)).toBe(b.slice(0, b.indexOf(begin) + begin.length))
    expect(a.slice(a.indexOf(end))).toBe(b.slice(b.indexOf(end)))
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

  it('SKA-5: droppedRowCount > 0 adds the MISSING-lines note and softens the provenance claim', () => {
    const block = buildInvoiceDataBlock(CLEAN, validateInvoiceTotals(CLEAN), 3)
    // The honest MISSING-lines note (an invoice has no balance proof → any dropped line hedges).
    expect(block).toContain('3 money-bearing line(s) could not be parsed into line items and are MISSING')
    expect(block).toContain('do NOT claim the line-item list is complete')
    // The provenance line drops its "whole document" claim…
    expect(block).not.toContain('parsed and reconciled from the whole document')
    // …but STILL forbids the model from computing.
    expect(block).toContain('Quote these figures verbatim')
    expect(block).toContain('do not add, total, convert, or derive any number')
  })

  it('SKA-5: droppedRowCount 0 (or absent) keeps the whole-document provenance, no MISSING note', () => {
    const block = buildInvoiceDataBlock(CLEAN, validateInvoiceTotals(CLEAN), 0)
    expect(block).toContain('every value above was parsed and reconciled from the whole document')
    expect(block).not.toContain('MISSING')
    // Absent param is identical to 0 (back-compat with the existing two-arg call sites).
    expect(buildInvoiceDataBlock(CLEAN, validateInvoiceTotals(CLEAN))).toBe(block)
  })
})

describe('buildTotalsPostscript (W3 §8.1)', () => {
  it('echoes net/tax/gross verbatim from the parsed totals', () => {
    const post = buildTotalsPostscript(tr, CLEAN)
    expect(post).toContain('120.00')
    expect(post).toContain('24.00')
    expect(post).toContain('144.00')
    expect(post).toContain('EUR')
    // The localized wrapper frames the echo (SKA-21: {value} = "amount currency").
    expect(post).toContain(tr('skills.invoiceAnalysis.figureEchoGross', { value: '144.00 EUR' }))
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

  it('SKA-21: a mixed-currency invoice with NO header currency stamps NO code and no dangling space', () => {
    const mixedNoHeader: InvoiceInput = {
      header: {}, // no declared currency
      lineItems: [
        { description: 'A', lineTotal: 100, currency: 'EUR' },
        { description: 'B', lineTotal: 50, currency: 'USD' } // mixed → no single currency
      ],
      totals: { netTotal: 100, grossTotal: 100 }
    }
    const post = buildTotalsPostscript(tr, mixedNoHeader)
    // The amount prints bare — never lineItems[0]'s EUR — and no `100.00 **`-style dangling space.
    expect(post).toContain('100.00')
    expect(post).not.toContain('100.00 EUR')
    expect(post).not.toContain('100.00 USD')
    // The exact string pins the no-currency, no-dangling-space rendering ("net 100.00 · gross 100.00").
    expect(post).toBe(tr('skills.invoiceAnalysis.figureEcho', {
      figures: [
        tr('skills.invoiceAnalysis.figureEchoNet', { value: '100.00' }),
        tr('skills.invoiceAnalysis.figureEchoGross', { value: '100.00' })
      ].join(' · ')
    }))
  })

  it('SKA-5: droppedRowCount > 0 appends the countPartial hedge beneath the echo (no balance proof)', () => {
    const post = buildTotalsPostscript(tr, CLEAN, 2)
    expect(post).toContain(tr('skills.invoiceAnalysis.figureEchoGross', { value: '144.00 EUR' }))
    expect(post).toContain(tr('skills.invoiceAnalysis.countPartial', { count: 2, dropped: 2 }))
  })

  it('SKA-5: droppedRowCount 0/absent is byte-identical (back-compat)', () => {
    expect(buildTotalsPostscript(tr, CLEAN, 0)).toBe(buildTotalsPostscript(tr, CLEAN))
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

  it('SKA-5: unverified + dropped>0 adds the MISSING-lines note and softens the provenance', () => {
    const block = buildStatementDataBlock({
      snap: { rows: ROWS, summary: SUMMARY },
      reconcile: reconcileBalances(ROWS),
      status: 'unverified',
      categories: [],
      droppedRowCount: 2
    })
    expect(block).toContain('2 money-bearing line(s) could not be parsed into rows and are MISSING')
    expect(block).toContain('do NOT claim the transaction list is complete')
    expect(block).not.toContain('parsed and reconciled from the whole document')
    expect(block).toContain('Quote these figures verbatim') // still forbids computing
  })

  it('SKA-5 D56 OUTRANKS: complete + dropped>0 → NO MISSING note, whole-document provenance kept', () => {
    const block = buildStatementDataBlock({
      snap: SNAP,
      reconcile: reconcileBalances(ROWS),
      status: 'complete',
      categories: [],
      droppedRowCount: 2
    })
    // The balance proof shows the dropped line didn't move the balance → the read IS whole (no hedge).
    expect(block).not.toContain('MISSING')
    expect(block).toContain('every value above was parsed and reconciled from the whole document')
  })
})

describe('buildCashflowPostscript (W4 §8.1 / W6 SKA-4/SKA-5)', () => {
  it('complete: echoes money-in / money-out / net (computed sums) with no extra caveat', () => {
    const post = buildCashflowPostscript(tr, SUMMARY, 'complete')
    expect(post).toContain('2500.00')
    expect(post).toContain('45.90')
    expect(post).toContain('2454.10')
    expect(post).toContain('EUR')
    expect(post).toContain(tr('skills.bankAnalysis.figureEchoNet', { amount: '2454.10', currency: 'EUR' }))
    // The reworded label calls them COMPUTED sums, not "verbatim from the document" (SKA-4, audit §4.5).
    expect(post).toContain('computed')
    expect(post).not.toContain('verbatim from the document')
    // No unverified caveat, no dropped hedge on a clean complete statement.
    expect(post).not.toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 2 }))
  })

  it('SKA-4 contradicted: SUPPRESSES the echo entirely (mirrors the template incompleteNoTotal refusal)', () => {
    // A contradicted statement's app-authored postscript must not hand the user a total the template refuses.
    const post = buildCashflowPostscript(tr, SUMMARY, 'contradicted')
    expect(post).toBe('')
    expect(post).not.toContain('2454.10')
    expect(post).not.toContain(tr('skills.bankAnalysis.figureEcho', { figures: 'X' }).split('X')[0].trim())
  })

  it('SKA-4 unverified: echoes the sums PLUS the unverifiedCaveat line (labelled sum of the rows read)', () => {
    const post = buildCashflowPostscript(tr, SUMMARY, 'unverified')
    expect(post).toContain('2454.10') // the echo still rides
    expect(post).toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 2 }))
  })

  it('returns empty on a MIXED-currency statement (no single meaningful total to echo — BL-2)', () => {
    const mixed: TransactionInput[] = [
      { date: '2026-01-02', description: 'Coffee', amount: -3.5, currency: 'EUR' },
      { date: '2026-01-03', description: 'Book', amount: -10, currency: 'USD' }
    ]
    expect(buildCashflowPostscript(tr, summarizeCashflow(mixed), 'complete')).toBe('')
  })

  it('SKA-5 D56 OUTRANKS: complete + dropped>0 → NO dropped hedge (the balance proof shows the read is whole)', () => {
    const post = buildCashflowPostscript(tr, SUMMARY, 'complete', 3)
    // The echo rides (complete), but the countPartial hedge does NOT — the tie proves the drop didn't move the balance.
    expect(post).toContain('2454.10')
    expect(post).not.toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 3 }))
  })

  it('SKA-5: unverified + dropped>0 → the dropped hedge fires (no balance proof)', () => {
    const post = buildCashflowPostscript(tr, SUMMARY, 'unverified', 3)
    expect(post).toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 3 }))
  })

  it('SKA-5: contradicted + dropped>0 → echo suppressed but the dropped hedge still fires', () => {
    const post = buildCashflowPostscript(tr, SUMMARY, 'contradicted', 3)
    expect(post).not.toContain('2454.10') // echo suppressed
    expect(post).toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 3 }))
  })

  it('SKA-5: mixed currency + dropped>0 → no echo, but the dropped hedge still rides', () => {
    const mixed: TransactionInput[] = [
      { date: '2026-01-02', description: 'Coffee', amount: -3.5, currency: 'EUR' },
      { date: '2026-01-03', description: 'Book', amount: -10, currency: 'USD' }
    ]
    const post = buildCashflowPostscript(tr, summarizeCashflow(mixed), 'unverified', 1)
    expect(post).toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 1 }))
  })
})
