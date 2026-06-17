import { describe, it, expect } from 'vitest'
import {
  extractTransactionsTool,
  extractTransactionRows,
  parseAmount,
  parseDate,
  detectCurrency,
  type ExtractTransactionsOutput
} from '../../src/main/services/skills/tools/bank-statement'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import type { AuditEventType, DocumentChunkRead, SkillToolContext } from '../../src/shared/types'

// docs/skills-s11-plan.md §5 (S11a) — the bank-statement extract_transactions tool, proven in
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
