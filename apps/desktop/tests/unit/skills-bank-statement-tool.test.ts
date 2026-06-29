import { describe, it, expect } from 'vitest'
import {
  extractTransactionsTool,
  extractTransactionRows,
  extractStatementBalances,
  assessCompleteness,
  isStatementComplete,
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
  BANK_EXTRACTOR_VERSION,
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

  it('parses a 4-column Buchung/Valuta/Betrag/Saldo statement: value date stripped, not read as the amount (BL-1)', () => {
    // The common DACH layout prints a booking date (Buchungstag) AND a value date (Wertstellung/Valuta)
    // as the first two columns. Before the BL-1 fix, MONEY_RE read the value date's `dd.mm.20yy` tail as
    // a 2-decimal amount (`07.06.2026` → `07.06.20` → 706.20): the LEADING value date made `matches[0]`
    // start at index 0 → an empty description → the row was SILENTLY DROPPED. Now the whole leading date
    // run is stripped first, so both rows parse with the real amount + a non-empty description, and the
    // value date is captured separately.
    const text = [
      'Kontoauszug EUR',
      'Buchung    Valuta      Buchungstext       Betrag      Saldo', // header — no leading date, dropped
      '06.06.2026 07.06.2026 Supermarkt Billa   -45,90      1.954,10',
      '08.06.2026 09.06.2026 Gehalt ACME         2.500,00    4.454,10'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2) // NEITHER row dropped by the value-date column
    expect(rows[0]).toMatchObject({
      date: '2026-06-06',
      valueDate: '2026-06-07',
      description: 'Supermarkt Billa',
      amount: -45.9, // the real movement — NOT 706.20 (the misread value-date fragment)
      currency: 'EUR',
      balanceAfter: 1954.1
    })
    expect(rows[1]).toMatchObject({
      date: '2026-06-08',
      valueDate: '2026-06-09',
      description: 'Gehalt ACME',
      amount: 2500,
      balanceAfter: 4454.1
    })
    // Every row has a non-empty description and a correctly-signed amount (the BL-1 contract).
    expect(rows.every((r) => r.description.length > 0)).toBe(true)
    // The amounts feed the correct total: Σ = 2500 − 45.90 = 2454.10 (no 706.20-style date fragment).
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(2454.1, 2)
  })

  it('captures the value date only when a SECOND leading date is present (single-date rows unchanged)', () => {
    // A plain single-date row is byte-identical to before the BL-1 fix — `valueDate` stays undefined.
    const single = extractTransactionRows([chunk('2026-01-02 Grocery -45,90 1.954,10', 1)], 'EUR')
    expect(single[0].valueDate).toBeUndefined()
    expect(single[0]).toMatchObject({ date: '2026-01-02', description: 'Grocery', amount: -45.9 })
  })

  it('ReDoS regression: a giant digit/separator run is scanned linearly (no main-process freeze)', () => {
    // vuln-scan-2026-06-21: the shared MONEY_RE used to backtrack quadratically (O(N²)) on a long
    // run of digits/separators with no valid `[.,]\d{2}` tail — a hostile statement whose chunk is
    // one giant line could freeze the main process for seconds-to-minutes. The bounded quantifiers
    // make the scan linear, so even a 200k-char adversarial line resolves in well under a second.
    const giant = '2026-01-02 Payment ' + '0'.repeat(200_000) // no decimal tail anywhere
    const start = Date.now()
    const rows = extractTransactionRows([chunk(giant, 1)], 'EUR')
    expect(rows).toEqual([]) // nothing parses (no valid amount) — and importantly, fast
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('extractStatementBalances + isStatementComplete (completeness gate — §3.5 / D56)', () => {
  it('reads the printed opening and closing balances (EN + DE labels), last figure on the line', () => {
    const en = chunk('Opening balance 2.000,00\n... rows ...\nClosing balance 4.454,10')
    expect(extractStatementBalances([en])).toEqual({ openingBalance: 2000, closingBalance: 4454.1 })
    const de = chunk('Alter Kontostand 2.000,00\nNeuer Kontostand 4.454,10')
    expect(extractStatementBalances([de])).toEqual({ openingBalance: 2000, closingBalance: 4454.1 })
  })

  it('skips a date earlier on the balance line and reads the trailing figure', () => {
    const c = chunk('Saldovortrag 01.01.2024 1.234,56')
    expect(extractStatementBalances([c]).openingBalance).toBe(1234.56)
  })

  it('returns nothing when no balance label is present (gate then downgrades)', () => {
    expect(extractStatementBalances([chunk('2026-01-02 Coffee -3,50 100,00')])).toEqual({})
  })

  it('disambiguates the dual-role `Kontostand per` label by DATE: earliest = opening, latest = closing (audit C-4)', () => {
    // Raiffeisen "Mein ELBA" prints BOTH the opening and the closing balance with the SAME label,
    // `Kontostand per <date>`. The earliest-dated line is the opening; the latest-dated is the closing.
    const c = chunk('Kontostand per 31.03.2025 35.037,04\n... rows ...\nKontostand per 23.06.2025 30.647,07')
    expect(extractStatementBalances([c])).toEqual({ openingBalance: 35037.04, closingBalance: 30647.07 })
  })

  it('a SINGLE `Kontostand per` line is CLOSING only — opening stays undefined (audit C-4)', () => {
    // One such line cannot bracket the period, so reading it as BOTH opening and closing (the old dual
    // listing) produced opening == closing → a false `contradicted`. Now it is the closing only, so the
    // gate downgrades to an honest `unverified` labelled sum instead of refusing.
    expect(extractStatementBalances([chunk('Kontostand per 31.03.2025 35.037,04')])).toEqual({
      closingBalance: 35037.04
    })
    // A statement with a lone Kontostand-per line + rows is `unverified`, NOT `contradicted` (the C-4 fix).
    const rows: TransactionInput[] = [
      { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR' },
      { date: '2026-01-03', description: 'Salary', amount: 2500, currency: 'EUR' }
    ]
    const { openingBalance, closingBalance } = extractStatementBalances([
      chunk('Kontostand per 31.03.2025 35.037,04')
    ])
    expect(assessCompleteness({ rows, openingBalance, closingBalance, reconcile: reconcileBalances(rows) })).toBe(
      'unverified'
    )
  })

  it('is complete only when opening + Σamounts == closing within half a cent', () => {
    const rows = [
      { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR' },
      { date: '2026-01-03', description: 'Salary', amount: 2500, currency: 'EUR' }
    ]
    const reconcile = reconcileBalances(rows)
    expect(
      isStatementComplete({ rows, openingBalance: 2000, closingBalance: 4454.1, reconcile })
    ).toBe(true)
    // A closing balance that doesn't tie out → NOT complete (no proof).
    expect(
      isStatementComplete({ rows, openingBalance: 2000, closingBalance: 9999.99, reconcile })
    ).toBe(false)
    // Missing either balance → NOT complete (the per-row chain alone is never the proof).
    expect(isStatementComplete({ rows, closingBalance: 4454.1, reconcile })).toBe(false)
    expect(isStatementComplete({ rows, openingBalance: 2000, reconcile })).toBe(false)
  })

  it('a per-row balance MISMATCH can never be complete (a mismatch is a read error)', () => {
    const rows = [
      { date: '2026-01-02', description: 'Alpha', amount: -10, currency: 'EUR', balanceAfter: 100 },
      { date: '2026-01-03', description: 'Beta', amount: -10, currency: 'EUR', balanceAfter: 200 } // can't follow 100−10
    ]
    const reconcile = reconcileBalances(rows)
    // Even if some opening/closing pair were supplied, the contradicting chain forbids completeness.
    expect(isStatementComplete({ rows, openingBalance: 110, closingBalance: 90, reconcile })).toBe(false)
  })
})

describe('assessCompleteness — the three-outcome refinement (§3.5 / D56)', () => {
  const ROWS: TransactionInput[] = [
    { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR' },
    { date: '2026-01-03', description: 'Salary', amount: 2500, currency: 'EUR' }
  ]

  it("'complete' only when printed opening + Σ == closing AND no per-row mismatch", () => {
    const reconcile = reconcileBalances(ROWS)
    expect(assessCompleteness({ rows: ROWS, openingBalance: 2000, closingBalance: 4454.1, reconcile })).toBe('complete')
  })

  it("'unverified' when NO opening/closing balance is printed and nothing contradicts (the no-balance case)", () => {
    // The reported HVB "Umsätze" shape: rows read cleanly, no statement-level balance to tie against.
    const reconcile = reconcileBalances(ROWS)
    expect(assessCompleteness({ rows: ROWS, reconcile })).toBe('unverified')
    // A single printed balance (only opening, or only closing) cannot form a tie either → still unverified.
    expect(assessCompleteness({ rows: ROWS, openingBalance: 2000, reconcile })).toBe('unverified')
    expect(assessCompleteness({ rows: ROWS, closingBalance: 4454.1, reconcile })).toBe('unverified')
  })

  it("'contradicted' when a printed opening+closing pair does NOT tie out (a suspect read)", () => {
    const reconcile = reconcileBalances(ROWS)
    expect(assessCompleteness({ rows: ROWS, openingBalance: 2000, closingBalance: 9999.99, reconcile })).toBe(
      'contradicted'
    )
  })

  it("'contradicted' on a per-row balance mismatch, regardless of (or absent) summary balances", () => {
    const rows: TransactionInput[] = [
      { date: '2026-01-02', description: 'Alpha', amount: -10, currency: 'EUR', balanceAfter: 100 },
      { date: '2026-01-03', description: 'Beta', amount: -10, currency: 'EUR', balanceAfter: 200 } // can't follow 100−10
    ]
    const reconcile = reconcileBalances(rows)
    // A mismatch is a read error → suspect even when NO opening/closing is printed (never 'unverified').
    expect(assessCompleteness({ rows, reconcile })).toBe('contradicted')
    expect(assessCompleteness({ rows, openingBalance: 110, closingBalance: 90, reconcile })).toBe('contradicted')
  })

  it('isStatementComplete is exactly the boolean projection of the complete status', () => {
    const reconcile = reconcileBalances(ROWS)
    expect(isStatementComplete({ rows: ROWS, openingBalance: 2000, closingBalance: 4454.1, reconcile })).toBe(true)
    expect(isStatementComplete({ rows: ROWS, reconcile })).toBe(false) // unverified ⇒ not 'complete'
  })

  it("'unverified' for a MIXED-currency statement — never a meaningless cross-currency tie (audit BL-2/TEST-6)", () => {
    // Σ over rows in different currencies is a meaningless figure to compare against ONE opening/closing
    // pair, so the gate must never claim 'complete' OR 'contradicted' from it — the honest verdict is
    // 'unverified' (mirrors summarizeCashflow's single-currency guard).
    const mixed: TransactionInput[] = [
      { date: '2026-01-02', description: 'Coffee', amount: -3.5, currency: 'EUR' },
      { date: '2026-01-03', description: 'Book', amount: -10, currency: 'USD' }
    ]
    const reconcile = reconcileBalances(mixed)
    // Even a printed opening+closing pair (which on a single-currency statement would force a verdict)
    // cannot make a mixed-currency statement 'complete' or 'contradicted'.
    expect(assessCompleteness({ rows: mixed, openingBalance: 100, closingBalance: 86.5, reconcile })).toBe(
      'unverified'
    )
    expect(assessCompleteness({ rows: mixed, openingBalance: 100, closingBalance: 9999.99, reconcile })).toBe(
      'unverified'
    )
    expect(isStatementComplete({ rows: mixed, openingBalance: 100, closingBalance: 86.5, reconcile })).toBe(false)
  })

  it("sums in INTEGER CENTS so float drift over many rows can't flip a tying statement to contradicted (audit C-3)", () => {
    // A genuinely-tying statement whose NAIVE float `reduce(acc + amount)` drifts past MONEY_EPS. The
    // magnitude is adversarially large so the per-addition rounding accumulates within a few thousand
    // rows (on a real statement the drift is far smaller, but the property is the same): 3000 rows of
    // 700000000.07 sum EXACTLY to 2_100_000_000_210.00 in cents, but the float sum drifts ~0.06.
    const N = 3000
    const AMOUNT = 700000000.07
    const CLOSING = 2100000000210
    const rows: TransactionInput[] = Array.from({ length: N }, (_, i) => ({
      date: '2026-01-02',
      description: `Row ${i}`,
      amount: AMOUNT,
      currency: 'EUR'
    }))
    // Premise check: the OLD float sum would have failed the half-cent compare → a false 'contradicted'.
    const naiveFloatSum = rows.reduce((acc, r) => acc + r.amount, 0)
    expect(Math.abs(0 + naiveFloatSum - CLOSING)).toBeGreaterThan(0.005)
    // The cent-exact gate ties out → 'complete' (no per-row balances, so reconcile has no mismatch).
    const reconcile = reconcileBalances(rows)
    expect(assessCompleteness({ rows, openingBalance: 0, closingBalance: CLOSING, reconcile })).toBe('complete')
  })
})

describe('BANK_EXTRACTOR_VERSION (A9 staleness stamp)', () => {
  it('is at 2 — the audit C-4 bump (Kontostand-per disambiguation changes persisted balances)', () => {
    // The constant gates A9 re-extraction: any statement stamped < this is STALE and re-extracted. The
    // C-4 fix changes the persisted opening/closing on Raiffeisen statements, so v1 rows MUST re-extract;
    // `skills-run.test.ts` proves `isBankStatementStale` flags a v1 statement once this reads 2.
    expect(BANK_EXTRACTOR_VERSION).toBe(2)
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
    // TEST-N5: assert the OUTCOME (a successful run records start + done, and never a failure)
    // via membership rather than an exact, order-pinned array that a benign new lifecycle event
    // would break while still passing if `done` silently stopped firing.
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('skill_run_started')
    expect(eventTypes).toContain('skill_run_done')
    expect(eventTypes).not.toContain('skill_run_failed')
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
  it('reconcileBalances: baseline row is unknown, only a genuine predecessor-comparison is ok', () => {
    const rows = [
      tx({ amount: -45.9, balanceAfter: 1954.1 }),
      tx({ amount: 2500, balanceAfter: 4454.1 })
    ]
    const res = reconcileBalances(rows)
    // The first row has nothing to compare against (baseline → unknown); the second row IS a genuine
    // check against its predecessor's printed balance, so it reconciles.
    expect(res.reconciled).toBe(true)
    expect(res.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
  })

  it('reconcileBalances: a single-transaction statement verifies nothing ⇒ not reconciled (honesty)', () => {
    // The lone printed balance is a baseline with no predecessor — it must NOT count as a pass, or
    // the statement would claim `reconciled: true` having checked nothing (the fix for over-reporting).
    const res = reconcileBalances([tx({ amount: -45.9, balanceAfter: 1954.1 })])
    expect(res.reconciled).toBe(false)
    expect(res.rows.map((r) => r.status)).toEqual(['unknown'])
  })

  it('reconcileBalances: flags a mismatch and an unknown (no printed balance), never invents', () => {
    const rows = [
      tx({ amount: -45.9, balanceAfter: 1954.1 }),
      tx({ amount: 2500, balanceAfter: 9999.99 }), // wrong running balance vs predecessor
      tx({ amount: -5, balanceAfter: undefined }) // no balance printed → unknown
    ]
    const res = reconcileBalances(rows)
    expect(res.reconciled).toBe(false)
    // Row 0 is the baseline (unknown); row 1 is a genuine comparison that disagrees (mismatch).
    expect(res.rows.map((r) => r.status)).toEqual(['unknown', 'mismatch', 'unknown'])
  })

  it('reconcileBalances: genuine mismatch alone ⇒ not reconciled', () => {
    const rows = [
      tx({ amount: 100, balanceAfter: 100 }),
      tx({ amount: 50, balanceAfter: 999 }) // expected 150 → mismatch
    ]
    const res = reconcileBalances(rows)
    expect(res.reconciled).toBe(false)
    expect(res.rows.map((r) => r.status)).toEqual(['unknown', 'mismatch'])
  })

  it('reconcileBalances: a MIXED-currency statement is all-unknown, never a cross-currency mismatch (BL-2)', () => {
    // The running chain `prevBalance + amount` would add a USD amount onto a EUR balance — meaningless.
    // Every row is reported `unknown` (nothing genuinely checked), so the statement is never reconciled
    // and no spurious `mismatch` flows into the completeness gate.
    const rows = [
      tx({ amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 }),
      tx({ amount: -10, currency: 'USD', balanceAfter: 1944.1 }) // a same-currency chain would 'mismatch'
    ]
    const res = reconcileBalances(rows)
    expect(res.reconciled).toBe(false)
    expect(res.rows.map((r) => r.status)).toEqual(['unknown', 'unknown'])
  })

  it('reconcileBalances: all-baseline (no predecessor ever has a balance) ⇒ not reconciled', () => {
    // Every row prints no balance, so there is never a predecessor balance to compare against — the
    // whole statement is unchecked, never silently "reconciled".
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
    expect(categorizeRow(tx({ description: 'Monatliche Gebühr Konto', amount: -3 }))).toBe('Fees') // DE keyword as its own word
    expect(categorizeRow(tx({ description: 'Salary March', amount: 2500 }))).toBe('Income')
    expect(categorizeRow(tx({ description: 'SEPA Überweisung', amount: -100 }))).toBe('Transfer')
    expect(categorizeRow(tx({ description: 'ATM withdrawal', amount: -50 }))).toBe('Cash')
    expect(categorizeRow(tx({ description: 'Unknown shop', amount: -12 }))).toBe('Spending')
    expect(categorizeRow(tx({ description: 'Mystery credit', amount: 7 }))).toBe('Income') // positive ⇒ Income
    expect(categorizeRow(tx({ description: 'Zero', amount: 0 }))).toBe(UNCATEGORIZED)
  })

  it('categorizeRow matches description rules on WORD boundaries, not raw substrings (audit C-1)', () => {
    // A coincidental substring no longer mis-files: 'fee'⊂'coffee', 'atm'⊂'atmosphere', 'lohn'⊂'mühlohn'.
    expect(categorizeRow(tx({ description: 'Coffee shop', amount: -3.5 }))).not.toBe('Fees')
    expect(categorizeRow(tx({ description: 'Coffee shop', amount: -3.5 }))).toBe('Spending') // sign fallback
    expect(categorizeRow(tx({ description: 'Atmosphere Bar', amount: -12 }))).not.toBe('Cash')
    expect(categorizeRow(tx({ description: 'Baeckerei Muehlohn', amount: -3.1 }))).not.toBe('Income')
    // A COMPOUND that merely contains a keyword no longer matches — so it now agrees with the LLM
    // prefilter (which sends such a row to the model): 'Kontoführungsgebühr' has no standalone 'gebühr'.
    expect(categorizeRow(tx({ description: 'Kontoführungsgebühr', amount: -3 }))).toBe('Spending')
    // The keyword as its OWN word still matches.
    expect(categorizeRow(tx({ description: 'Coffee and a fee', amount: -3.5 }))).toBe('Fees')
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

  it('neutralizes a formula hidden behind leading whitespace (post-S12 hardening)', () => {
    // Some importers trim leading spaces before evaluating, so " =cmd" is dangerous too.
    const csv = transactionsToCsv([
      tx({ description: '  =1+1', amount: -1 }),
      tx({ description: '\t@cmd', amount: -2 }),
      tx({ description: 'safe text', amount: -3 })
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[1]).toBe('2026-01-02,,\'  =1+1,-1.00,EUR,,') // quote prefixed before the spaces
    expect(lines[2]).toBe('2026-01-02,,\'\t@cmd,-2.00,EUR,,') // leading tab is neutralized (not a quote trigger)
    expect(lines[3]).toBe('2026-01-02,,safe text,-3.00,EUR,,') // ordinary text untouched
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

// full-audit-2026-06-28 Phase 1 (financial correctness): adversarial WHOLE-STRING tests driven through
// the REAL entry points (extractTransactionRows / extractStatementBalances / reconcileBalances /
// assessCompleteness), not pre-isolated tokens (TEST-N2). Each pins a fixed reproduction from §2.
describe('financial correctness (full-audit-2026-06-28 Phase 1)', () => {
  it('BL-N1: a US-ordered statement is inferred month-first — no dropped rows, correct month', () => {
    // The 12/31 row has day 31 > 12, so it can ONLY be mm/dd → the whole document infers month-first;
    // the otherwise-ambiguous 03/05 then resolves to the US reading (3 March → '2026-03-05').
    const us = [
      'Statement USD',
      '12/31/2026 Year-end fee -5,00 95,00',
      '03/05/2026 Service charge -6,00 89,00'
    ].join('\n')
    const rows = extractTransactionRows([chunk(us, 1)], 'USD')
    expect(rows).toHaveLength(2) // BEFORE: 12/31 → null → the whole row was SILENTLY DROPPED (length 1)
    expect(rows[0].date).toBe('2026-12-31') // not dropped
    expect(rows[1].date).toBe('2026-03-05') // US month — BEFORE: '2026-05-03' (a confidently-wrong May)
  })

  it('BL-N1: the de-AT day-first default holds on an EU statement (and when nothing disambiguates)', () => {
    const eu = [
      'Statement EUR',
      '31/12/2026 Jahresgebühr -5,00 95,00', // day 31 > 12 confirms day-first
      '03/05/2026 Lastschrift -6,00 89,00' // ⇒ 5 May, the de-AT reading
    ].join('\n')
    expect(extractTransactionRows([chunk(eu, 1)], 'EUR').map((r) => r.date)).toEqual([
      '2026-12-31',
      '2026-05-03'
    ])
  })

  it('BL-N2: a trailing-date closing line reads the FIGURE, not the date, as the balance', () => {
    const c = chunk(
      'Kontoauszug EUR\nAnfangssaldo 2.000,00\n' +
        '2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10\n' +
        'Endsaldo 4.454,10 EUR per 30.06.2026'
    )
    // BEFORE: the closing read the last money token '30.06.20' → 3006.20 (the date mis-read as the balance).
    expect(extractStatementBalances([c])).toEqual({ openingBalance: 2000, closingBalance: 4454.1 })
  })

  it('BL-N2: the de-AT date-FIRST `Kontostand per <date> <figure>` shape is unaffected', () => {
    const c = chunk('Kontostand per 31.03.2025 35.037,04\n... rows ...\nKontostand per 23.06.2025 30.647,07')
    expect(extractStatementBalances([c])).toEqual({ openingBalance: 35037.04, closingBalance: 30647.07 })
  })

  it('BL-N3: a money-shaped token in the description does not steal the amount (column by position)', () => {
    const rows = extractTransactionRows(
      [chunk('Statement EUR\n2026-01-02 Betrag 100,00 EUR -100,00 900,00', 1)],
      'EUR'
    )
    expect(rows).toHaveLength(1)
    // BEFORE: amount = the FIRST money token = 100 (wrong value AND wrong sign); now amount is the
    // second-to-last token (the amount column) and the last is the running balance.
    expect(rows[0]).toMatchObject({ amount: -100, balanceAfter: 900 })
  })

  it('TEST-N2: a bare grouped figure with no 2-dp tail is read as thousands, not €1 (DECISION 2)', () => {
    // de-AT '.' = thousands. BEFORE: MONEY_RE grabbed '1.00' out of '1.000' → €1 (a 1000× understatement).
    const rows = extractTransactionRows([chunk('Statement EUR\n2026-01-02 Miete 1.000 9.000', 1)], 'EUR')
    expect(rows[0]).toMatchObject({ amount: 1000, balanceAfter: 9000 })
  })

  it('TEST-N2: space-grouped and apostrophe-grouped amounts are read whole (DECISION 2)', () => {
    const space = extractTransactionRows(
      [chunk('Statement EUR\n2026-01-02 Bonus 1 234 567,89 1 300 000,00', 1)],
      'EUR'
    )
    expect(space[0].amount).toBe(1234567.89) // BEFORE: 567.89 (only the trailing space-group survived)
    const apo = extractTransactionRows(
      [chunk("Statement CHF\n2026-01-02 Zahlung 1'234.56 9'999.00", 1)],
      'CHF'
    )
    expect(apo[0].amount).toBe(1234.56) // BEFORE: 234.56 (the apostrophe group was dropped)
  })

  it('TEST-N2: space grouping does not merge across a digit boundary (the pdf-layout continuation hazard)', () => {
    // A reference number's 3-digit TAIL must not fuse with a following amount across a space — the
    // `(?<!\d)` anchor on MONEY_RE prevents "…778899 300,00" from reading "899 300,00" → 899300.
    const rows = extractTransactionRows(
      [chunk('Statement EUR\n2026-01-02 Sender GmbH Auftrag 778899 300,00 1.255,00', 1)],
      'EUR'
    )
    expect(rows[0]).toMatchObject({ amount: 300, balanceAfter: 1255 })
  })

  it('TEST-N2: space grouping does not fuse a LETTER-preceded digit tail with the amount (adversarial review)', () => {
    // A reference like "Ref123" abuts a space-grouped amount: the `(?<![A-Za-z0-9])` boundary on the
    // space-grouped form prevents "Ref123 456,78" from reading "123 456,78" → 123456.78.
    const rows = extractTransactionRows(
      [chunk('Statement EUR\n2026-01-02 Zahlung Ref123 456,78 1.000,00', 1)],
      'EUR'
    )
    expect(rows[0]).toMatchObject({ amount: 456.78, balanceAfter: 1000 })
  })

  it('TEST-N2 e2e: a TYING statement stays complete through a trailing-date closing + in-description money', () => {
    // Combines BL-N2 (trailing-date closing) and BL-N3 (in-description money). opening 2000 +
    // (−100 + 2500) == closing 4400. BEFORE: the in-description 100,00 became the amount AND the closing
    // read '30.06.20' → 3006.20, so the tie failed → a false 'contradicted' (an honest total suppressed).
    const text = [
      'Kontoauszug EUR',
      'Anfangssaldo 2.000,00',
      '2026-01-02 Betrag 100,00 EUR -100,00 1.900,00',
      '2026-01-03 Gehalt 2.500,00 4.400,00',
      'Endsaldo 4.400,00 EUR per 30.06.2026'
    ].join('\n')
    const chunks = [chunk(text, 1)]
    const rows = extractTransactionRows(chunks, 'EUR')
    expect(rows.map((r) => r.amount)).toEqual([-100, 2500])
    const { openingBalance, closingBalance } = extractStatementBalances(chunks)
    expect({ openingBalance, closingBalance }).toEqual({ openingBalance: 2000, closingBalance: 4400 })
    const reconcile = reconcileBalances(rows)
    expect(assessCompleteness({ rows, openingBalance, closingBalance, reconcile })).toBe('complete')
  })

  it('BL-N5: reconcileBalances compares in integer cents (consistent with assessCompleteness, audit C-3)', () => {
    // A clean per-row chain still reconciles; the comparison is now cent-exact rather than a float epsilon
    // (no realistic 2-dp input distinguishes the two — this is the consistency the audit asked for; the
    // teeth are structural: reconcile and assessCompleteness now use the identical Math.round(x*100) path).
    const rows: TransactionInput[] = [
      tx({ amount: -45.9, balanceAfter: 1954.1 }),
      tx({ amount: 2500, balanceAfter: 4454.1 })
    ]
    const res = reconcileBalances(rows)
    expect(res.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
    expect(res.reconciled).toBe(true)
  })
})

// full-audit-2026-06-29 Phase 1 (financial correctness): BL-1/BL-2/BL-3 — adversarial WHOLE-STRING
// fixtures through the REAL entry points (extractTransactionRows / reconcileBalances / summarizeCashflow
// / categorizeRow), not pre-isolated tokens. Each pins a fixed reproduction from the audit §2.
describe('financial correctness (full-audit-2026-06-29 Phase 1)', () => {
  // ---- BL-1: a leading-minus figure must not steal the previous figure's sign ----
  it('BL-1: a leading-minus running balance keeps its sign; the credit before it stays positive', () => {
    // "2.500,00 -500,00" = a +2500 credit into an overdrawn account, new balance −500. BEFORE the fix
    // MONEY_RE's trailing `-?` ate the balance's leading minus ACROSS the separating space → amount −2500,
    // balance +500 (BOTH signs flipped). The chain still tied out internally, so `reconcileBalances`
    // reported `ok` on the WRONG figures — the safety net could not catch it.
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Gehalt ACME 2.500,00 -500,00', // credit INTO an overdrawn account (balance still −500)
      '2026-01-03 Supermarkt Billa -45,90 -545,90' // debit; balance stays negative (−500 − 45,90)
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    // BEFORE: rows[0] = { amount: −2500, balanceAfter: +500 } — a +€2500 credit became a −€2500 debit
    // and a −€500 overdraft became +€500.
    expect(rows[0]).toMatchObject({ amount: 2500, balanceAfter: -500 })
    expect(rows[1]).toMatchObject({ amount: -45.9, balanceAfter: -545.9 })
    // The running-balance chain ties out on the CORRECT signs (−500 + −45,90 == −545,90) — reconcile `ok`.
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
    expect(reconcile.reconciled).toBe(true)
    // The headline figure is right: the credit is inflow, not outflow (BEFORE: net −2545,90).
    expect(summarizeCashflow(rows)).toMatchObject({ totalIn: 2500, totalOut: 45.9, net: 2454.1 })
  })

  it('BL-1: a fully-negative-balance chain is no longer silently sign-flipped (reconcile false-green)', () => {
    // The audit's core insight: with EVERY balance leading-minus and EVERY amount positive, the bug
    // flipped the WHOLE chain consistently (prevBal+amount==bal still held with every sign negated), so
    // reconcile reported `ok` on confidently-wrong figures. Now the signs are read correctly.
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Einzahlung 1.000,00 -2.000,00', // +1000 into a −3000 overdraft → −2000
      '2026-01-03 Einzahlung 1.500,00 -500,00' // +1500 → −500
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows.map((r) => r.amount)).toEqual([1000, 1500]) // BEFORE: [−1000, −1500]
    expect(rows.map((r) => r.balanceAfter)).toEqual([-2000, -500]) // BEFORE: [+2000, +500]
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
    expect(summarizeCashflow(rows)).toMatchObject({ totalIn: 2500, totalOut: 0, net: 2500 })
  })

  it('BL-1: the de-AT GLUED trailing minus is preserved even when a balance figure follows', () => {
    // The de-AT debit convention prints the sign as a GLUED trailing minus ("45,90-"), and a running-
    // balance column normally follows it. The fix must keep reading the glued minus as a debit while NOT
    // stealing a SEPARATED leading minus (the BL-1 case above). The disambiguator is the SPACE: a glued
    // "-" belongs to the figure on its left; a "-<digit>" after a space is the next figure's leading sign.
    // (A blanket trailing-minus lookahead would mis-read this de-AT debit as +45,90 — the reason the fix
    // is space-aware rather than the audit's first-pass `(?:-(?!\s*[-+(]?\d))?` suggestion.)
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Miete 45,90- 1.908,20', // glued trailing-minus debit; positive running balance
      '2026-01-03 Bargeld 200,00- 1.708,20' // glued trailing-minus debit again (1.908,20 − 200 = 1.708,20)
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows[0]).toMatchObject({ amount: -45.9, balanceAfter: 1908.2 })
    expect(rows[1]).toMatchObject({ amount: -200, balanceAfter: 1708.2 })
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
  })

  it('BL-1: a glued trailing-minus debit at END of line still reads negative (no following figure)', () => {
    // The lone-figure de-AT debit "12,00-" (parseAmount-level fixture line 71) read through the real
    // extractor: a trailing minus with nothing after it is unambiguously the figure's own sign.
    const rows = extractTransactionRows([chunk('Statement EUR\n2026-01-02 Auszahlung 500,00-', 1)], 'EUR')
    expect(rows[0]).toMatchObject({ amount: -500 })
  })

  // ---- BL-2: a currency token in a payee description must not disable totals/reconciliation ----
  it('BL-2: a currency WORD in a description no longer suppresses the single-currency total', () => {
    // BEFORE: per-row `detectCurrency(line)` scanned the WHOLE line incl. the free-text description, so a
    // memo containing "USD"/"$" tagged the row that currency → the row-currency set gained a member →
    // summarizeCashflow returned no single total, reconcileBalances marked EVERY row `unknown`, and
    // assessCompleteness dropped to `unverified`. One description string silently killed totalling for the
    // whole EUR statement. Per-row detection now scans only the FIGURE REGION (from the first money token
    // on), so a currency word LEFT of the amount is ignored.
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Netflix USD subscription -12,99 1.187,01', // "USD" in the memo
      '2026-01-03 Amazon $ gift card -20,00 1.167,01', // "$" in the memo
      '2026-01-04 Gehalt ACME 2.000,00 3.167,01'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.currency === 'EUR')).toBe(true) // BEFORE: ['USD','USD','EUR']
    // A single EUR total is computed (BEFORE: currency undefined — the "no single total" refusal).
    const summary = summarizeCashflow(rows)
    expect(summary.currency).toBe('EUR')
    expect(summary).toMatchObject({ totalIn: 2000, totalOut: 32.99, net: 1967.01 })
    // Reconciliation runs in EUR (BEFORE: every row `unknown`).
    const reconcile = reconcileBalances(rows)
    expect(reconcile.reconciled).toBe(true)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok', 'ok'])
    expect(assessCompleteness({ rows, reconcile })).toBe('unverified') // no opening/closing pair, but not from a phantom mix
  })

  it('BL-2: a GENUINELY mixed-currency row (currency ADJACENT to the figure) still refuses a single total', () => {
    // The figure region runs from the first money token onward, so a currency printed NEXT TO the amount is
    // still detected per-row — a genuinely mixed statement keeps its honest "no single total" refusal
    // (mixed-currency honesty intact, the reason this is figure-region rather than `statementCurrency ?? …`).
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Coffee -3,50 1.000,00',
      '2026-01-03 Foreign purchase -20,00 USD' // a real foreign-currency row: USD sits next to the figure
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows.map((r) => r.currency)).toEqual(['EUR', 'USD'])
    expect(summarizeCashflow(rows).currency).toBeUndefined() // honest mixed-currency refusal preserved
  })
})
