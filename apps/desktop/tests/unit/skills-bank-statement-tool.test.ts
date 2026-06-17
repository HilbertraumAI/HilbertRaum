import { describe, it, expect } from 'vitest'
import {
  extractTransactionsTool,
  extractTransactionRows,
  parseAmount,
  parseDate,
  detectCurrency,
  reconcileBalances,
  categorizeRow,
  categorizeRows,
  summarizeCashflow,
  transactionsToCsv,
  validateStatementBalancesTool,
  categorizeTransactionsTool,
  summarizeCashflowTool,
  exportTransactionsCsvTool,
  UNCATEGORIZED,
  type ExtractTransactionsOutput,
  type TransactionInput
} from '../../src/main/services/skills/tools/bank-statement'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import type { AuditEventType, DocumentChunkRead, SkillToolContext } from '../../src/shared/types'

// architecture.md "Skills — design record" §8 (S11a) — the bank-statement extract_transactions tool, proven in
// isolation: the deterministic/offline parser (dates, amounts, currency), the honest "drop ambiguous
// rows" posture, and the tool running THROUGH the gate with schema-valid output. No DB, no Electron.

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

describe('bank-statement parser helpers', () => {
  it('parseDate normalizes ISO + day-first dotted/slashed, rejects invalid/2-digit-year', () => {
    expect(parseDate('2026-01-31')).toBe('2026-01-31')
    expect(parseDate('31.01.2026')).toBe('2026-01-31')
    expect(parseDate('31/01/2026')).toBe('2026-01-31')
    expect(parseDate('2026-13-01')).toBeNull() // bad month
    expect(parseDate('31.02.2026')).toBeNull() // Feb 31 doesn't exist
    expect(parseDate('31.01.26')).toBeNull() // 2-digit year unsupported
    expect(parseDate('not-a-date')).toBeNull()
  })

  it('parseAmount handles US + German separators, signs, parens, trailing minus', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56) // US thousands + decimal
    expect(parseAmount('1.234,56')).toBe(1234.56) // German thousands + decimal
    expect(parseAmount('-12.00')).toBe(-12)
    expect(parseAmount('12,00-')).toBe(-12) // trailing minus (German bank style)
    expect(parseAmount('(45.00)')).toBe(-45) // parentheses-negative
    expect(parseAmount('1,234')).toBe(1234) // single sep + 3 digits ⇒ thousands, not decimal
    expect(parseAmount('12,50')).toBe(12.5) // single sep + 2 digits ⇒ decimal
    expect(parseAmount('abc')).toBeNull()
  })

  it('detectCurrency reads an allowlisted code or known symbol, ignores random 3-letter words', () => {
    expect(detectCurrency('Total EUR 100,00')).toBe('EUR')
    expect(detectCurrency('Saldo €100,00')).toBe('EUR')
    expect(detectCurrency('$50.00')).toBe('USD')
    expect(detectCurrency('THE CAT SAT')).toBeNull() // not an ISO code
  })
})

describe('extractTransactionRows', () => {
  it('extracts date/description/amount/currency + balance + sourcePage; drops non-transaction lines', () => {
    const text = [
      'Account statement EUR',
      '2026-01-02 Grocery Store -45,90 1.954,10',
      '2026-01-03 Salary ACME 2.500,00 4.454,10',
      'Closing balance 4.454,10', // no leading date ⇒ dropped
      'random prose line'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 2)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      date: '2026-01-02',
      description: 'Grocery Store',
      amount: -45.9,
      currency: 'EUR',
      balanceAfter: 1954.1,
      sourcePage: 2
    })
    expect(rows[1]).toMatchObject({ date: '2026-01-03', amount: 2500, balanceAfter: 4454.1 })
  })

  it('drops a row with no detectable currency (never invents one)', () => {
    const rows = extractTransactionRows([chunk('2026-01-02 Mystery -45,90', 1)], null)
    expect(rows).toEqual([])
  })

  it('omits sourcePage when the chunk has no page', () => {
    const rows = extractTransactionRows([chunk('2026-01-02 Coffee -3,50', null)], 'EUR')
    expect(rows[0].sourcePage).toBeUndefined()
  })
})

describe('extract_transactions through the gate', () => {
  it('returns schema-valid output that passes its own outputSchema', async () => {
    const { ctx, events } = makeCtx([chunk('Statement EUR\n2026-01-02 Coffee -3,50 100,00', 1)])
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractTransactionsOutput
      expect(out.transactions).toHaveLength(1)
      expect(out.currency).toBe('EUR')
      expect(validateToolOutput(extractTransactionsTool, result.output)).toEqual([])
    }
    expect(events.map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('refuses invalid input (no documentId) without running', async () => {
    const { ctx } = makeCtx([])
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: {},
      ctx
    })
    expect(result.ok).toBe(false)
  })

  it('reads only via readDocumentChunks — an out-of-scope id yields no rows', async () => {
    // The tool asks for d1 (in scope); a context whose read returns [] for everything models an
    // out-of-scope read. The tool never has a DB/FS handle to go wider.
    const { ctx } = makeCtx([], { readDocumentChunks: () => [] })
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.output as ExtractTransactionsOutput).transactions).toEqual([])
  })
})

// architecture.md "Skills — design record" §8 (S11c) — the downstream tools, proven as PURE functions + through the
// gate with schema-valid output. They take the extracted rows as structured input (no DB/Electron).

const tx = (over: Partial<TransactionInput> = {}): TransactionInput => ({
  date: '2026-01-02',
  description: 'Row',
  amount: -10,
  currency: 'EUR',
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

describe('validate_statement_balances (S11c)', () => {
  it('reconcileBalances: ok when each printed balance matches the computed running balance', () => {
    const rows = [
      tx({ amount: -45.9, balanceAfter: 1954.1 }),
      tx({ amount: 2500, balanceAfter: 4454.1 })
    ]
    const res = reconcileBalances(rows)
    expect(res.reconciled).toBe(true)
    expect(res.rows.map((r) => r.status)).toEqual(['ok', 'ok'])
  })

  it('reconcileBalances: flags a mismatch and an unknown (no printed balance), never invents', () => {
    const rows = [
      tx({ amount: -45.9, balanceAfter: 1954.1 }),
      tx({ amount: 2500, balanceAfter: 9999.99 }), // wrong running balance
      tx({ amount: -5, balanceAfter: undefined }) // no balance printed → unknown
    ]
    const res = reconcileBalances(rows)
    expect(res.reconciled).toBe(false)
    expect(res.rows.map((r) => r.status)).toEqual(['ok', 'mismatch', 'unknown'])
  })

  it('reconcileBalances: all-unknown ⇒ not reconciled (nothing could be checked)', () => {
    const res = reconcileBalances([tx(), tx()])
    expect(res.reconciled).toBe(false)
    expect(res.rows.every((r) => r.status === 'unknown')).toBe(true)
  })

  it('runs through the gate with schema-valid output', async () => {
    const result = await runSkillTool(validateStatementBalancesTool, {
      skillId: 'app:bank-statement',
      input: { transactions: [tx({ amount: -45.9, balanceAfter: 1954.1 })] },
      ctx: downstreamCtx()
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateToolOutput(validateStatementBalancesTool, result.output)).toEqual([])
  })
})

describe('categorize_transactions (S11c)', () => {
  it('categorizeRow applies deterministic rules (EN + DE keywords), sign fallback', () => {
    expect(categorizeRow(tx({ description: 'Monthly account fee', amount: -3 }))).toBe('Fees')
    expect(categorizeRow(tx({ description: 'Kontoführungsgebühr', amount: -3 }))).toBe('Fees')
    expect(categorizeRow(tx({ description: 'Salary March', amount: 2500 }))).toBe('Income')
    expect(categorizeRow(tx({ description: 'SEPA Überweisung', amount: -100 }))).toBe('Transfer')
    expect(categorizeRow(tx({ description: 'ATM withdrawal', amount: -50 }))).toBe('Cash')
    expect(categorizeRow(tx({ description: 'Unknown shop', amount: -12 }))).toBe('Spending')
    expect(categorizeRow(tx({ description: 'Mystery credit', amount: 7 }))).toBe('Income') // positive ⇒ Income
    expect(categorizeRow(tx({ description: 'Zero', amount: 0 }))).toBe(UNCATEGORIZED)
  })

  it('categorizeRows returns one assignment per row, in order', () => {
    const out = categorizeRows([tx({ amount: 5 }), tx({ description: 'fee', amount: -1 })])
    expect(out).toEqual([
      { index: 0, category: 'Income' },
      { index: 1, category: 'Fees' }
    ])
  })

  it('runs through the gate with schema-valid output', async () => {
    const result = await runSkillTool(categorizeTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { transactions: [tx()] },
      ctx: downstreamCtx()
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateToolOutput(categorizeTransactionsTool, result.output)).toEqual([])
  })
})

describe('summarize_cashflow (S11c)', () => {
  it('summarizeCashflow totals inflows/outflows/net and reports currency only when uniform', () => {
    const s = summarizeCashflow([tx({ amount: 2500 }), tx({ amount: -45.9 }), tx({ amount: -4.1 })])
    expect(s).toEqual({ totalIn: 2500, totalOut: 50, net: 2450, count: 3, currency: 'EUR' })
  })

  it('summarizeCashflow omits currency for a mixed-currency statement (honesty)', () => {
    const s = summarizeCashflow([tx({ amount: 10, currency: 'EUR' }), tx({ amount: -5, currency: 'USD' })])
    expect(s.currency).toBeUndefined()
    expect(s.net).toBe(5)
  })

  it('runs through the gate with schema-valid output', async () => {
    const result = await runSkillTool(summarizeCashflowTool, {
      skillId: 'app:bank-statement',
      input: { transactions: [tx({ amount: 5 })] },
      ctx: downstreamCtx()
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateToolOutput(summarizeCashflowTool, result.output)).toEqual([])
  })
})

describe('export_transactions_csv (S11c)', () => {
  it('transactionsToCsv writes a header + escaped rows, fixed-dp amounts, blanks for nulls', () => {
    const csv = transactionsToCsv([
      tx({ date: '2026-01-02', description: 'Café, Vienna', amount: -4.5, balanceAfter: 100 }),
      tx({ date: '2026-01-03', description: 'Salary', amount: 2500, valueDate: '2026-01-03', sourcePage: 2 })
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('date,valueDate,description,amount,currency,balanceAfter,sourcePage')
    expect(lines[1]).toBe('2026-01-02,,"Café, Vienna",-4.50,EUR,100.00,') // comma field quoted; nulls blank
    expect(lines[2]).toBe('2026-01-03,2026-01-03,Salary,2500.00,EUR,,2')
  })

  it('neutralizes spreadsheet formula injection in text fields (S12 audit F4)', () => {
    // A description beginning with a formula trigger is prefixed with a single quote so a
    // spreadsheet reads the cell as text — and a leading-= field with a comma is also quoted.
    const csv = transactionsToCsv([
      tx({ description: '=HYPERLINK("http://evil","click")', amount: -1 }),
      tx({ description: '+1+2', amount: -2 }),
      tx({ description: '@cmd', amount: -3 }),
      tx({ description: '-leading minus, with comma', amount: -4 })
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[1]).toBe('2026-01-02,,"\'=HYPERLINK(""http://evil"",""click"")",-1.00,EUR,,')
    expect(lines[2]).toBe("2026-01-02,,'+1+2,-2.00,EUR,,")
    expect(lines[3]).toBe("2026-01-02,,'@cmd,-3.00,EUR,,")
    expect(lines[4]).toBe('2026-01-02,,"\'-leading minus, with comma",-4.00,EUR,,')
    // The numeric amount column is formatted separately and is never neutralized.
    expect(lines[2]).toContain(',-2.00,')
  })

  it('is the only confirm-gated tool: the gate refuses it without confirmation', async () => {
    const refused = await runSkillTool(exportTransactionsCsvTool, {
      skillId: 'app:bank-statement',
      input: { transactions: [tx()] },
      ctx: downstreamCtx()
    })
    expect(refused.ok).toBe(false)
    const ok = await runSkillTool(exportTransactionsCsvTool, {
      skillId: 'app:bank-statement',
      input: { transactions: [tx()] },
      ctx: downstreamCtx(),
      confirmed: true
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(validateToolOutput(exportTransactionsCsvTool, ok.output)).toEqual([])
  })
})
