import { describe, it, expect } from 'vitest'
import {
  extractTransactionsTool,
  extractTransactionRows,
  extractTransactionsWithStats,
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
import {
  detectDocumentCurrency,
  inferDateAnchor,
  inferDateOrder,
  inferDateOrderResult
} from '../../src/main/services/skills/tools/money'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import { prefilterCategory } from '../../src/main/services/skills/categorizer'
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
    expect(parseDate('31.01.26')).toBeNull() // 2-digit year unsupported WITHOUT a document anchor (R5)
    expect(parseDate('not-a-date')).toBeNull()
  })

  it('parseDate — anchor-gated 2-digit-year / bare completion + cross-year rollover (R5, §5.7)', () => {
    const janAnchor = { year: 2026, month: 1 } // a January-anchored (period) statement
    // No anchor ⇒ a 2-digit-year or bare date is DROPPED, exactly as before (drop-don't-guess).
    expect(parseDate('05.01.26')).toBeNull()
    expect(parseDate('28.12.')).toBeNull()
    // 2-digit year ⇒ the anchor's century window.
    expect(parseDate('05.01.26', 'dmy', janAnchor)).toBe('2026-01-05')
    expect(parseDate('05.01.99', 'dmy', { year: 1998, month: 1 })).toBe('1999-01-05')
    // Bare date ⇒ the anchor year; a December row on a January statement is the PREVIOUS year (rollover),
    // and a January row on a December statement is the NEXT year.
    expect(parseDate('15.06.', 'dmy', { year: 2026, month: 6 })).toBe('2026-06-15')
    expect(parseDate('28.12.', 'dmy', janAnchor)).toBe('2025-12-28')
    expect(parseDate('03.01.', 'dmy', { year: 2025, month: 12 })).toBe('2026-01-03')
    // A 2-digit-year date is NOT rolled (its year is explicit); only bare dates roll.
    expect(parseDate('28.12.25', 'dmy', janAnchor)).toBe('2025-12-28')
    // A bare decimal (no SECOND separator) is never a date — a price stays a price.
    expect(parseDate('28.12', 'dmy', janAnchor)).toBeNull()
    // mdy anchor path: US 2-digit year completes month-first.
    expect(parseDate('01.05.26', 'mdy', { year: 2026, month: 1 })).toBe('2026-01-05')
  })

  it('inferDateAnchor — first fully-printed year+month, order-aware, null without one (R5)', () => {
    expect(inferDateAnchor('Kontoauszug Zeitraum 05.01.2026 - 31.01.2026\n28.12. Miete -900,00')).toEqual({
      year: 2026,
      month: 1
    })
    // Order-aware: a US mm/dd/yyyy anchor reads month-first.
    expect(inferDateAnchor('Invoice date 03/15/2026', 'mdy')).toEqual({ year: 2026, month: 3 })
    // No fully-printed 4-digit-year date ⇒ no anchor (a grouped amount is never mistaken for one).
    expect(inferDateAnchor('28.12. Miete -900,00 2.500,00\n05.01. Gehalt 1.234,56')).toBeNull()
  })

  it('inferDateOrderResult — evidence vs the day-first default (R5, §5.7)', () => {
    // All-ambiguous doc (every leading date field ≤ 12): day-first is applied with NO evidence ⇒ 'default'
    // (caveat-worthy). The dates LEAD their money rows — the booking-column vote scope (FIN-4).
    const ambiguous = inferDateOrderResult('03.05.2026 Grocery -45,90\n04.06.2026 Salary 2.500,00')
    expect(ambiguous.order).toBe('dmy')
    expect(ambiguous.inferred).toBe('default')
    // An unambiguous leading date (a field > 12) fixes the order ⇒ 'evidence' (no caveat).
    expect(inferDateOrderResult('31.01.2026 Grocery -45,90\n15.02.2026 Salary 2.500,00').inferred).toBe('evidence')
    expect(inferDateOrderResult('12/31/2026 Grocery -45,90').order).toBe('mdy')
    expect(inferDateOrderResult('12/31/2026 Grocery -45,90').inferred).toBe('evidence')
    // Only ISO dates ⇒ the day-first guess is moot ⇒ 'evidence' (never a spurious caveat).
    expect(inferDateOrderResult('2026-03-05 Coffee -3,50 100,00').inferred).toBe('evidence')
  })

  it('inferDateOrderResult — 2-digit-year / bare ambiguous dates also drive the flag (R5 fix, §5.7)', () => {
    // The dd.mm.yy / bare cohort R5 newly PARSES (day-first) must register in the order sniff too — else a
    // genuinely day-first-guessed statement neither infers the right order nor flags 'default' (the caveat
    // would silently miss the exact rows it protects). yy rows leading money lines are order-ambiguous:
    expect(inferDateOrderResult('03.05.26 Grocery -45,90\n04.06.26 Salary 2.500,00').inferred).toBe('default')
    // A bare de-AT day>12 date is day-first EVIDENCE (28 can only be a day) — previously ignored entirely.
    expect(inferDateOrderResult('28.12. Miete -900,00').order).toBe('dmy')
    expect(inferDateOrderResult('28.12. Miete -900,00').inferred).toBe('evidence')
    // A US mm/dd/yy row (second field > 12) is month-first evidence — previously mis-defaulted to dmy and
    // then dropped every row (day 12, month 31 = invalid).
    expect(inferDateOrderResult('12/31/26 Grocery -45,90').order).toBe('mdy')
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

  it('R2: recognizes `Kontostand am` / `Kontostand zum` as dual-role balance labels too (audit §5.4)', () => {
    // `per` / `am` / `zum` are all in use across AT/DE banks; recognizing only `per` silently lost the
    // completeness gate (and left phantom transactions) on an `am`/`zum` statement.
    const am = chunk('Kontostand am 31.03.2025 35.037,04\n... rows ...\nKontostand am 23.06.2025 30.647,07')
    expect(extractStatementBalances([am])).toEqual({ openingBalance: 35037.04, closingBalance: 30647.07 })
    const zum = chunk('Kontostand zum 01.01.2026 1.000,00\n... rows ...\nKontostand zum 31.01.2026 2.500,50')
    expect(extractStatementBalances([zum])).toEqual({ openingBalance: 1000, closingBalance: 2500.5 })
  })

  it('R2: an `am`/`zum` Kontostand line is dropped from the transaction stream, not read as a phantom row (§5.4)', () => {
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Kaffeehaus -3,50 996,50',
      'Kontostand am 31.01.2026 996,50'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1) // the balance line is a summary, not a transaction
    expect(rows[0]).toMatchObject({ description: 'Kaffeehaus', amount: -3.5 })
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

describe('extractTransactionRows — date correctness (R5, §5.7)', () => {
  it('completes dd.mm.yy rows against a 4-digit anchor date in the document', () => {
    const text = [
      'Kontoauszug Zeitraum 01.01.2026 - 31.01.2026', // the 4-digit-year anchor
      '05.01.26 Gehalt ACME 2.500,00 3.500,00',
      '06.01.26 Miete -900,00 2.600,00'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0].date).toBe('2026-01-05')
    expect(rows[1].date).toBe('2026-01-06')
  })

  it('drops dd.mm.yy rows when the document has NO 4-digit anchor (posture preserved — asserted explicitly)', () => {
    const text = ['05.01.26 Gehalt ACME 2.500,00 3.500,00', '06.01.26 Miete -900,00 2.600,00'].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(0) // no anchor ⇒ no guess ⇒ zero rows (the drop-don't-guess posture stands)
  })

  it('cross-year: a bare 28.12. row on a January-anchored statement gets the PREVIOUS year', () => {
    const text = [
      'Kontoauszug Zeitraum 01.01.2026 - 31.01.2026',
      '05.01.2026 Gehalt ACME 2.500,00 3.500,00',
      '28.12. Miete -900,00 2.600,00'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    const december = rows.find((r) => r.description.includes('Miete'))
    expect(december?.date).toBe('2025-12-28') // NOT 2026-12-28 (the naive page-year stamp)
  })
})

describe('extractTransactionRows — wrapped descriptions (R6, §5.7)', () => {
  it('appends a dateless/money-less follower line to the prior row (merchant name survives)', () => {
    // A SEPA row whose payee prints on the line below: before R6 the `NETFLIX…` line was dropped (the row
    // kept only `SEPA-Lastschrift`), degrading the categorizer and the listing. R6 appends the wrapped
    // payee line to the row's description (the plain-text mirror of the geometry multi-baseline association).
    const text = [
      '2026-03-01 SEPA-Lastschrift -12,99 1.000,00',
      'NETFLIX INTERNATIONAL B.V.'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toContain('NETFLIX')
    expect(rows[0]).toMatchObject({ amount: -12.99, balanceAfter: 1000, description: 'SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.' })
  })

  it('is BOUNDED to one continuation line — a third dateless line does not glue', () => {
    const text = [
      '2026-03-01 SEPA-Lastschrift -12,99 1.000,00',
      'NETFLIX INTERNATIONAL B.V.', // absorbed (1st continuation)
      'Amsterdam NL' // NOT absorbed — past the single-line bound
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.')
    expect(rows[0].description).not.toContain('Amsterdam')
  })

  it('does NOT glue a balance-label line or a following transaction to the prior row', () => {
    // A balance-label line (a summary) and a genuine next transaction each CLOSE the pending row rather
    // than being absorbed as description text — the continuation is strictly a dateless/money-less wrap.
    const text = [
      '2026-03-01 Kaffeehaus -3,50 996,50',
      'Kontostand am 31.03.2026 996,50', // balance label — read by extractStatementBalances, never glued
      '2026-03-02 Bäckerei -2,00 994,50'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0].description).toBe('Kaffeehaus')
    expect(rows[1].description).toBe('Bäckerei')
  })

  it('does NOT glue a figure-bearing follower line (a stray annotation is not payee text)', () => {
    // The continuation is strictly dateless AND money-less. A bare figure line (an FX/annotation remnant)
    // carries a money token, so it CLOSES the pending row instead of being absorbed into the description.
    const text = ['2026-03-01 Kaffeehaus -3,50 996,50', '1,50'].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('Kaffeehaus') // NOT "Kaffeehaus 1,50"
  })

  it('does NOT carry a continuation across a chunk/page boundary (each chunk is one page)', () => {
    // A wrapped payee prints on the SAME page as its booking row; `pending` is scoped per-segment, so a
    // page-2 repeated column header must NOT glue onto page-1's last row (the multi-page common case).
    const rows = extractTransactionRows(
      [
        chunk('2026-03-01 Kaffeehaus -3,50 996,50', 1, 0),
        chunk('Buchungstag Valuta Buchungstext Betrag Saldo\n2026-03-02 Bäckerei -2,00 994,50', 2, 1)
      ],
      'EUR'
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].description).toBe('Kaffeehaus') // page-2 header NOT absorbed across the boundary
    expect(rows[1].description).toBe('Bäckerei')
  })
})

describe('BANK_EXTRACTOR_VERSION (A9 staleness stamp)', () => {
  it('is at 9 — the R7 date-vs-money disambiguation bump (SKA-1/2/13)', () => {
    // The constant gates A9 re-extraction: any statement stamped < this is STALE and re-extracted. R1
    // added the `normalizeExtractionText` pre-pass (v4); R2 extended the dual-role balance label (v5); R5
    // completes 2-digit-year / bare dates + cross-year rollover (v6); R6 appends wrapped continuations (v7);
    // U1 records `droppedRowCount` + reads a currency-adjacent round balance (v8). R7 (skills-audit-
    // 2026-07-03 SKA-1/2/13) date-blanks the row money scan, widens the date scrub to dd.mm.yy, and
    // column-gates the geometry `d.dd` classification — each changes persisted rows/balances, so v8
    // (and older) rows MUST re-extract once this reads 9.
    expect(BANK_EXTRACTOR_VERSION).toBe(9)
  })
})

describe('extractTransactionsWithStats — droppedRowCount (U1, audit §2.3)', () => {
  it('is 0 on a clean statement (every money line parsed) — the "whole statement" claim stands', () => {
    const text = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
    expect(extractTransactionsWithStats([chunk(text, 1)], 'EUR').droppedRowCount).toBe(0)
  })

  it('counts a currency-less money-bearing row the parser rejected', () => {
    // The second row prints a money token but NO detectable currency (null statement currency, no symbol/
    // code) → parseLine drops it; it is a money-bearing line the parser could not read → counted.
    const text = '2026-01-02 Grocery -45,90\n2026-01-03 Mystery -12,00'
    const stats = extractTransactionsWithStats([chunk(text, 1)], null)
    expect(stats.rows).toHaveLength(0) // both rows currency-less → dropped
    expect(stats.droppedRowCount).toBe(2)
  })

  it('does NOT count a money-LESS header/period line (it never looked like a transaction)', () => {
    const text = 'Kontoauszug Zeitraum 01.01.2026 - 31.03.2026\n2026-01-02 Grocery -45,90 1.954,10'
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(1)
    expect(stats.droppedRowCount).toBe(0) // the period header carries no money-shaped token after date-scrub
  })

  it('counts a booking row dropped for a DATE-parse failure (malformed / no-anchor date) — SHAPE not parse', () => {
    // "31.02.2026" is date-SHAPED but not a valid calendar date → parseLine drops the row; it is still a
    // booking-row shape the parser couldn't read, so it IS counted (a parse-gated check would silently miss
    // it and let the answer keep its "whole statement" claim over a genuinely-dropped row).
    const text = '2026-01-02 Grocery -45,90 1.954,10\n31.02.2026 Payee 90,00 EUR'
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(1) // the malformed-date row dropped
    expect(stats.droppedRowCount).toBe(1) // …but counted (date-SHAPE test, not date-PARSE)
  })

  it('a money-bearing line whose DESCRIPTION leads (no date-shaped token) is NOT counted (FX/memo exclusion)', () => {
    // The plain-path mirror of the geometry Valuta/FX second baseline: a follower line with a figure but no
    // leading date token is a memo/reference, never a transaction — counting it would falsely gate the read.
    const text = '2026-01-02 Grocery -45,90 1.954,10\nAuftraggeber Hausverwaltung 12,50 CHF'
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.droppedRowCount).toBe(0)
  })

  it('extractTransactionRows stays the rows-only wrapper (byte-identical array result)', () => {
    const text = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10'
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toEqual(extractTransactionsWithStats([chunk(text, 1)], 'EUR').rows)
    expect(rows).toHaveLength(1)
  })
})

describe('R7 — a mid-line/trailing date is never an amount (skills-audit-2026-07-03 SKA-1/SKA-2)', () => {
  it('a period line `01.04.2026 bis 30.04.2026` no longer invents a "bis" transaction (SKA-1)', () => {
    // splitLeadingDates consumes only the LEADING date; the un-blanked money scan then read the second
    // date's `30.04` as the amount → {date: 2026-04-01, description: "bis", amount: 30.04}.
    const text = 'Statement EUR\n01.04.2026 bis 30.04.2026\n02.04.2026 Grocery -45,90'
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0].description).toBe('Grocery')
    expect(stats.droppedRowCount).toBe(0) // the period line carries NO money token → never counted
  })

  it('the dd.mm.yy period variant no longer invents a 3103.26-style transaction (SKA-1 + SKA-2)', () => {
    // `31.03.26` is money-shaped whole (→ 3103.26); with the widened scrub the blanked scan sees nothing.
    const text = '01.03.2026 bis 31.03.2026\n15.03.26 bis 31.03.26 Zinsperiode\n02.03.2026 Grocery -45,90 EUR'
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0].description).toBe('Grocery')
    expect(stats.droppedRowCount).toBe(0)
  })

  it('a TRAILING date on a booking row is not a phantom balance column (SKA-1)', () => {
    // Before: matches were [900,00, 31.03.26] → hasBalance → balanceAfter 3103.26 (a confidently-wrong figure).
    const rows = extractTransactionRows([chunk('05.03.2026 Miete 900,00 EUR per 31.03.26', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(900)
    expect(rows[0].balanceAfter).toBeUndefined()
    expect(rows[0].description).toBe('Miete')
  })

  it('the SKA-1 blanking is SAME-LENGTH: description slicing and figure-region currency stay byte-correct', () => {
    // A mid-line date LEFT of the figure stays in the description byte-exact (the slice uses ORIGINAL
    // text at blanked-scan indices), and the figure-region slice still sees the adjacent foreign code.
    const rows = extractTransactionRows(
      [chunk('05.03.2026 Ref 31.12.2026 Gutschrift 100,00 USD 1.100,00', 1)],
      'EUR'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('Ref 31.12.2026 Gutschrift') // byte-exact incl. the untouched date
    expect(rows[0].currency).toBe('USD') // figure-region currency detection unshifted (BL-2 slice intact)
    expect(rows[0].amount).toBe(100)
    expect(rows[0].balanceAfter).toBe(1100)
  })

  it('a dd.mm.yy TRAILING date on a balance line is scrubbed — the printed figure wins (SKA-2, the BL-N2 twin)', () => {
    // `Endsaldo 1.234,56 EUR per 31.03.26` read closing 3103.26 before (the 2-digit year was invisible
    // to the scrub); the opening's `per 01.03.26` likewise read 103.26.
    const text = [
      'Zeitraum 01.03.2026 bis 31.03.2026',
      'Anfangssaldo 1.000,00 EUR per 01.03.26',
      'Endsaldo 1.234,56 EUR per 31.03.26'
    ].join('\n')
    const balances = extractStatementBalances([chunk(text, 1)])
    expect(balances.openingBalance).toBe(1000)
    expect(balances.closingBalance).toBe(1234.56)
  })

  it('a PUNCTUATION-trailed dd.mm.yy balance date is scrubbed too (R7 review)', () => {
    const balances = extractStatementBalances([
      chunk('Zeitraum 01.03.2026 bis 31.03.2026\nEndsaldo 1.234,56 EUR per 31.03.26.', 1)
    ])
    expect(balances.closingBalance).toBe(1234.56) // was 3103.26 with the plain (?![\d.,']) lookahead
  })

  it('a blanked date RANGE after the amount is not a spaced trailing debit minus (R7 review — sign-flip guard)', () => {
    // MONEY_RE's trailing `\s+-` region is unbounded whitespace, so on the blanked scan it reached
    // ACROSS the blanked first date of `1.500,00 01.04.2026 - 30.06.2026` and read the range dash as a
    // de-AT trailing debit → a silent −1500. The decoration is re-validated against the ORIGINAL bytes.
    for (const range of ['01.04.2026 - 30.06.2026', '01.04.2026-30.06.2026', '01.04.26 - 30.06.26']) {
      const stats = extractTransactionsWithStats([chunk(`01.06.2026 Miete Q2 1.500,00 ${range}`, 1)], 'EUR')
      expect(stats.rows).toHaveLength(1)
      expect(stats.rows[0].amount).toBe(1500) // positive-as-printed; the dash belongs to the range
      expect(stats.rows[0].balanceAfter).toBeUndefined()
      expect(stats.droppedRowCount).toBe(0)
    }
    // …while a GENUINE spaced trailing minus (real whitespace gap) keeps its BL-1 debit semantics.
    const debit = extractTransactionRows([chunk('05.03.2026 Lastschrift 45,90 -', 1)], 'EUR')
    expect(debit[0].amount).toBe(-45.9)
  })

  it('a trailing VALUE-DATE in the description no longer false-flags the F1 ambiguous-amount drop (R7 review)', () => {
    // The F1 flag read the ORIGINAL description tail, whose `02.03.2026` the scan itself had just
    // blanked as a date — on a balance-column statement the row was silently dropped.
    const text = [
      '01.03.2026 Gehalt 2.500,00 3.500,00', // establishes the balance column
      '02.03.2026 REWE DANKT 02.03.2026 -19,15'
    ].join('\n')
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(2)
    expect(stats.rows[1].amount).toBe(-19.15)
    expect(stats.droppedRowCount).toBe(0)
    // A GENUINE bare-number description tail still flags (and drops, on this balance-column statement).
    const flagged = extractTransactionsWithStats(
      [chunk('01.03.2026 Gehalt 2.500,00 3.500,00\n02.03.2026 Sparen 50 1.234,56', 1)],
      'EUR'
    )
    expect(flagged.rows).toHaveLength(1)
    expect(flagged.droppedRowCount).toBe(1)
  })

  it('the figureStart trim is pinned with the date ADJACENT to the figure (R7 review — the \\s{0,4} window)', () => {
    // The blanked date's tail sits inside MONEY_RE's up-to-4-space leading gap, so a raw `match.index`
    // slice would chop `…31.03.26` bytes out of the description.
    const rows = extractTransactionRows([chunk('05.03.2026 Zinsen bis 31.03.26 100,00 1.100,00', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('Zinsen bis 31.03.26') // byte-exact, date intact
    expect(rows[0].amount).toBe(100)
    expect(rows[0].balanceAfter).toBe(1100)
  })

  it('dd.mm.yy rows with a per-row currency CELL keep their document currency vote (R7 review — zero-rows regression)', () => {
    // The `<date> <desc> EUR <amount>` layout's only EUR sits LEFT of the amount; the SKA-2 scrub
    // removed its accidental vote (the date used to be the first "money" match). The figure-ADJACENT
    // code now votes deliberately, so the whole pipeline still extracts every row.
    const text = ['01.06.2026 Miete EUR 850,00-', '15.06.26 REWE Markt EUR 19,15-', '20.06.26 Gutschrift EUR 250,00'].join('\n')
    const joined = text
    const currency = detectDocumentCurrency(joined)
    expect(currency).toBe('EUR')
    const stats = extractTransactionsWithStats([chunk(text, 1)], currency)
    expect(stats.rows.map((r) => r.amount)).toEqual([-850, -19.15, 250])
    expect(stats.droppedRowCount).toBe(0)
  })
})

describe('extractStatementBalances — currency-adjacent round balance (U1, audit §2.3)', () => {
  it('reads a ROUND opening/closing balance printed with NO decimal, currency-adjacent (was lost before)', () => {
    // "Opening balance 914 $" / "Closing balance 1 000 EUR": bare integers MONEY_RE rejects, so the §3.5
    // completeness gate silently lost these. `lastMoneyOnLine` now falls back to the shared
    // `lastCurrencyAdjacentInteger`, mirroring the invoice `totalsMoney` fallback.
    const c = chunk('Opening balance 914 $\n... rows ...\nClosing balance 1 000 $')
    expect(extractStatementBalances([c])).toEqual({ openingBalance: 914, closingBalance: 1000 })
  })

  it('keeps the SIGN of a currency-adjacent round balance (a credit-note closing)', () => {
    expect(extractStatementBalances([chunk('Closing balance -50 EUR')])).toEqual({ closingBalance: -50 })
  })

  it('does NOT read a bare integer that touches no currency marker (drop-don’t-guess)', () => {
    // "Opening balance 914" (no symbol, no code) stays unread — a stray reference integer is not a balance.
    expect(extractStatementBalances([chunk('Opening balance 914')])).toEqual({})
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

  it('categorizeRow keeps the strict two-sided boundary for short English tokens (audit C-1)', () => {
    // The short, ambiguous English tokens still need BOTH sides bounded so a coincidental substring does
    // not mis-file: 'fee'⊂'coffee', 'atm'⊂'atmosphere', and 'lohn' (kept strict) ⊄ 'muehlohn'.
    expect(categorizeRow(tx({ description: 'Coffee shop', amount: -3.5 }))).not.toBe('Fees')
    expect(categorizeRow(tx({ description: 'Coffee shop', amount: -3.5 }))).toBe('Spending') // sign fallback
    expect(categorizeRow(tx({ description: 'Atmosphere Bar', amount: -12 }))).not.toBe('Cash')
    expect(categorizeRow(tx({ description: 'Baeckerei Muehlohn', amount: -3.1 }))).not.toBe('Income')
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

  // ---- BL-3: German closed-compounds must reach the deterministic categorizer (de-AT target locale) ----
  it('BL-3: German closed-compound keywords categorize inside a compound (de-AT)', () => {
    // The C-1 two-sided word boundary stopped 'fee'⊂'coffee' but ALSO stopped the de-AT keywords from
    // ever matching, because German forms closed compounds where the keyword sits at a morpheme seam that
    // is a word edge on only ONE side. The compound-prone DE keywords (gebühr/gehalt/überweisung/bargeld)
    // now match on a one-sided boundary, so account/bank fees and salary/transfer compounds bucket
    // correctly instead of falling through to the generic negative→Spending bucket.
    expect(categorizeRow(tx({ description: 'Kontoführungsgebühr', amount: -3 }))).toBe('Fees') // BEFORE: Spending
    expect(categorizeRow(tx({ description: 'Bankgebühr Auslandseinsatz', amount: -2.5 }))).toBe('Fees')
    expect(categorizeRow(tx({ description: 'SEPA-Überweisung Miete', amount: -800 }))).toBe('Transfer')
    expect(categorizeRow(tx({ description: 'Dauerüberweisung Sparen', amount: -100 }))).toBe('Transfer')
    expect(categorizeRow(tx({ description: 'Gehaltszahlung Juni', amount: 2500 }))).toBe('Income')
    expect(categorizeRow(tx({ description: 'Bargeldbehebung Bankomat', amount: -150 }))).toBe('Cash')
  })

  it('BL-3: the LLM prefilter agrees with categorizeRow on the CONFIDENT German compounds (audit C-1 invariant)', () => {
    // Both deterministic paths share `wordIncludes` + the same compound flag, so a CONFIDENT compound that
    // categorizes deterministically must ALSO be confidently pre-filtered (kept off the model). Only the
    // unambiguous buckets qualify — transfer-boilerplate (sepa/überweisung) is deliberately excluded now
    // (see the divergence test below, R3 / audit §5.5).
    for (const desc of ['Kontoführungsgebühr', 'Gehaltszahlung Juni']) {
      expect(prefilterCategory(tx({ description: desc, amount: -3 }))).toBe(categorizeRow(tx({ description: desc, amount: -3 })))
      expect(prefilterCategory(tx({ description: desc, amount: -3 }))).not.toBeNull()
    }
  })

  it('R3 / §5.5 + SKA-44: transfer boilerplate DIVERGES — categorizeRow labels Transfer, but the prefilter sends it to the model', () => {
    // `sepa`/`überweisung` (R3) and the EN `transfer` twin (SKA-44, R9) are `confident: false`: they
    // describe the payment rails, not the merchant. The deterministic NO-model fallback still buckets
    // them 'Transfer', but the LLM prefilter must return null so a runtime can assign the richer
    // 15-category taxonomy instead.
    for (const desc of ['SEPA-Überweisung Miete', 'Dauerüberweisung Sparen', 'SEPA-Lastschrift NETFLIX', 'TRANSFER TO NETFLIX']) {
      expect(categorizeRow(tx({ description: desc, amount: -12 }))).toBe('Transfer')
      expect(prefilterCategory(tx({ description: desc, amount: -12 }))).toBeNull()
    }
  })

  it('BL-3: the C-1 English/ambiguous guards still hold (no reintroduced false positives)', () => {
    // The relaxation is German-only: short English tokens keep the strict two-sided boundary, and 'lohn'
    // (the ambiguous DE token — muehlohn/Belohnung) stays strict too (salary is covered by the positive-
    // amount sign fallback). So a coincidental substring is still NOT mis-filed.
    expect(categorizeRow(tx({ description: 'Coffee shop', amount: -3.5 }))).not.toBe('Fees')
    expect(categorizeRow(tx({ description: 'Atmosphere Bar', amount: -12 }))).not.toBe('Cash')
    expect(categorizeRow(tx({ description: 'Baeckerei Muehlohn', amount: -3.1 }))).not.toBe('Income')
    expect(prefilterCategory(tx({ description: 'Coffee Fellows', amount: -4.2 }))).toBeNull()
    expect(prefilterCategory(tx({ description: 'ATMOS Sportswear', amount: -89 }))).toBeNull()
  })
})

// full-audit-2026-06-29-postmerge Phase 1 (money-parser correctness): F1 (unmatched amount column →
// balance read as amount) + T4 (parens-negative through the real scanner) + T5 (the 2-dp integer-cent
// invariant). Adversarial WHOLE-STRING fixtures through the real `extractTransactionRows`, not
// pre-isolated `parseAmount` tokens. Written CHARACTERIZATION-FIRST (pinning today's behaviour, the BUG
// assertions labelled) then flipped to the correct values once the fix landed.
describe('money-parser correctness (full-audit-2026-06-29-postmerge Phase 1)', () => {
  // ---- F1: on a BALANCE-COLUMN statement an uncaptured amount must not let the balance be read as the
  //      amount; the keep/drop is statement-context-aware so a no-balance numeric-payee listing survives.
  it('F1: on a balance-column statement, a whole-euro amount + 2-dp balance row is DROPPED', () => {
    // `Sparen 50 1.234,56`: the amount `50` is a bare whole-euro integer MONEY_RE rejects (no 2-dp tail,
    // not grouped), so the row collapses to ONE money match — the BALANCE `1.234,56`. BEFORE (F1 bug):
    // amount = matches[0] = 1234.56 (the running balance silently read as the movement amount — the
    // cardinal "confidently-wrong money" harm, off by the whole running-balance magnitude). NOW: the
    // statement HAS a balance column (the Grocery row prints one), so the ambiguous row — one money token
    // with a bare number abutting it on the left — is DROPPED rather than promote the balance (§22-D1).
    const text = [
      'Kontoauszug EUR',
      '2026-01-01 Grocery -45,90 1.954,10', // a normal 2-figure row → establishes the balance column
      '2026-01-02 Sparen 50 1.234,56' // amount `50` uncaptured; `1.234,56` is the BALANCE → drop
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ description: 'Grocery', amount: -45.9, balanceAfter: 1954.1 })
    expect(rows.some((r) => r.amount === 1234.56)).toBe(false) // the balance never becomes an amount
  })

  it('F1: on a balance-column statement, a single-decimal amount row is DROPPED', () => {
    // `Zinsen 12,5 1.000,00`: `12,5` is a single-decimal figure MONEY_RE rejects (it needs a 2-digit minor
    // tail), so only the balance `1.000,00` matches. BEFORE: amount = 1000 (the balance). NOW: dropped.
    const text = [
      'Kontoauszug EUR',
      '2026-01-01 Grocery -45,90 1.954,10',
      '2026-01-03 Zinsen 12,5 1.000,00'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows.map((r) => r.description)).toEqual(['Grocery'])
    expect(rows.some((r) => r.amount === 1000)).toBe(false)
  })

  it('F1: a NO-balance "Umsätze" listing keeps a numeric-ending payee (the lone token IS the amount)', () => {
    // The crucial false-positive guard. No row prints a running balance → the statement has no balance
    // column → a single money token is the AMOUNT, even when the payee ends in a store id. This is the HVB
    // "Umsätze" shape the geometry feature was built for; dropping the numeric-payee row here would regress
    // the flagship real case. `REWE … 1234 -19,15` parses with amount −19,15, NOT a dropped/blanked row.
    const text = [
      'Kontoumsaetze EUR',
      '2026-01-20 KARTENZAHLUNG REWE SAGT DANKE 1234 -19,15',
      '2026-01-29 SEPA-GUTSCHRIFT Arbeitgeber 34,39'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ description: 'KARTENZAHLUNG REWE SAGT DANKE 1234', amount: -19.15 })
    expect(rows[1]).toMatchObject({ amount: 34.39 })
  })

  it('F1: a genuine single-figure no-balance row (description has no trailing number) still parses', () => {
    const rows = extractTransactionRows([chunk('Kontoauszug EUR\n2026-01-02 Mystery shop -45,90', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ description: 'Mystery shop', amount: -45.9 })
    expect(rows[0].balanceAfter).toBeUndefined()
  })

  it('F1: the normal 2-figure de-AT row is byte-identical to before (no over-drop on a real amount column)', () => {
    // The fix must not touch the common `<desc> <amount> <balance>` row: both figures match MONEY_RE, so
    // there is no uncaptured column and the position logic stands unchanged.
    const rows = extractTransactionRows([chunk('Kontoauszug EUR\n2026-01-02 Grocery -45,90 1.954,10', 1)], 'EUR')
    expect(rows[0]).toMatchObject({ description: 'Grocery', amount: -45.9, balanceAfter: 1954.1 })
  })

  // ---- T4: parens-negative through the REAL MONEY_RE scanner (not a pre-isolated parseAmount token) ----
  it('T4: a parentheses-negative amount parses through the real extractor', () => {
    const rows = extractTransactionRows([chunk('Statement EUR\n2026-01-02 Refund (45,00) 1.000,00', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: -45, balanceAfter: 1000 })
  })

  // ---- T5: the 2-dp integer-cent invariant — every emitted figure is exactly 2 decimal places ----
  it('T5: a >2-dp figure is normalised to the nearest cent (the integer-cent invariant holds)', () => {
    // A both-separator `1.234,567` is the only form that reaches a 3rd decimal (the single-separator
    // 3-digit-group thousands forms `1.000`/`12.345` are integers — DECISION 2). parseAmount now rounds
    // every figure to 2-dp, so `Math.round(amount*100)` is its EXACT cent value (the load-bearing premise
    // of assessCompleteness/reconcileBalances). Decision (T5): a >2-dp printed figure is read to the
    // nearest cent — a sub-cent normalisation, never a confidently-wrong magnitude — not dropped.
    const rows = extractTransactionRows([chunk('Statement EUR\n2026-01-02 Posten 1.234,567 9.999,99', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(1234.57) // BEFORE: 1234.567 (a 3-dp value escaping the cent invariant)
    expect(rows[0].amount).toBe(Math.round(rows[0].amount * 100) / 100) // exactly 2-dp
  })
})

// full-audit-2026-06-29 follow-up Phase 1 (financial correctness): FIN-1 (document/statement currency by
// MAJORITY VOTE over figure-adjacent detections, not first-code-anywhere) + FIN-4 (date order inferred from
// the LEADING date column only, so a memo date can't day/month-swap every row). Adversarial WHOLE-STRING
// fixtures through the real `detectDocumentCurrency` / `extractTransactionsTool` / `extractTransactionRows`.
describe('financial correctness (full-audit-2026-06-29 follow-up Phase 1)', () => {
  // ---- FIN-1: detectDocumentCurrency (the figure-adjacent majority vote that replaces detectCurrency(joined)) ----
  it('FIN-1: detectDocumentCurrency ignores a currency word LEFT of the amount but reads a header declaration', () => {
    // The contamination source: a stray code in a payee memo (LEFT of the figure). A money line votes only
    // on its figure region; a non-money line (a header/label) votes on its whole text. BEFORE the fix the
    // tool used detectCurrency(joined) = "first code ANYWHERE wins" → the memo USD (earlier in the text) won.
    expect(detectDocumentCurrency('Kontoauszug\n02.01.2026 USD Memo -12,00 100,00\nWährung EUR')).toBe('EUR')
  })

  it('FIN-1: detectDocumentCurrency reads a figure-adjacent foreign currency, majority-votes, breaks ties by order', () => {
    expect(detectDocumentCurrency('Hotel -120,00 USD 880,00')).toBe('USD') // adjacent foreign code
    expect(detectDocumentCurrency('A 100,00 USD\nB 50,00 USD\nNote EUR')).toBe('USD') // majority wins
    expect(detectDocumentCurrency('Saldo 100,00 EUR\nPay in USD or CHF')).toBe('EUR') // tie → first appearance
    expect(detectDocumentCurrency('No money here\nJust prose')).toBeNull() // no code in any voting region
  })

  it('FIN-1: a stray code in a payee memo no longer stamps the whole statement (wrong-currency total)', async () => {
    // A bare-amount EUR statement: the only figure-adjacent code is the EUR on the closing line; a payee
    // memo carries "USD" to the LEFT of its amount, EARLIER in document order. BEFORE: detectCurrency(joined)
    // returned the FIRST code anywhere = USD → every bare row fell back to USD → a VERIFIED total in the
    // WRONG currency, and the uniform mislabel never tripped the mixed-currency guard.
    const text = [
      'Kontoauszug',
      '05.03.2026 USD Auslandsentgelt Wien -12,99 1.187,01',
      '07.03.2026 Gehalt ACME 2.000,00 3.187,01',
      'Endsaldo 3.187,01 EUR'
    ].join('\n')
    const { ctx } = makeCtx([chunk(text, 1)])
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractTransactionsOutput
      expect(out.currency).toBe('EUR') // BEFORE: 'USD'
      expect(out.transactions).toHaveLength(2)
      expect(out.transactions.every((t) => t.currency === 'EUR')).toBe(true) // BEFORE: every row 'USD'
      expect(summarizeCashflow(out.transactions).currency).toBe('EUR') // a single EUR total, not wrong-currency
    }
  })

  it('FIN-1: a truly-mixed statement (a figure-adjacent foreign row) still refuses a single total', async () => {
    // The fix supplies only the BARE-row fallback; per-row detection still tags a figure-adjacent foreign
    // row, so a genuinely-mixed statement keeps its honest "no single total" refusal (mixed path preserved).
    const text = ['Kontoauszug EUR', '2026-01-02 Coffee -3,50 1.000,00', '2026-01-03 Foreign -20,00 USD'].join('\n')
    const { ctx } = makeCtx([chunk(text, 1)])
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractTransactionsOutput
      expect(out.transactions.map((t) => t.currency)).toEqual(['EUR', 'USD'])
      expect(summarizeCashflow(out.transactions).currency).toBeUndefined() // honest mixed-currency refusal
    }
  })

  // ---- FIN-4: a foreign-format date in a MEMO must not flip the whole document's date order ----
  it('FIN-4: a US-format date inside a payee memo does not day/month-swap every dotted booking date', () => {
    // de-AT dotted booking dates with day ≤ 12 are ambiguous; a single `03/15/2026` (second field 15 → US)
    // in a memo used to flip inferDateOrder to month-first over the WHOLE text → every row silently swapped
    // (all still valid dates → none dropped → fully silent). The scan is now restricted to the LEADING date
    // column, so a description/memo date can't vote.
    const text = [
      'Kontoauszug EUR',
      '05.03.2026 Zahlung ORDER 03/15/2026 Ref -50,00 1.000,00',
      '07.03.2026 Gehalt ACME 2.000,00 3.000,00',
      '11.03.2026 Miete -800,00 2.200,00'
    ].join('\n')
    // The inferrer itself stays day-first (the memo date no longer votes) …
    expect(inferDateOrder(text)).toBe('dmy') // BEFORE: 'mdy' (the memo's 03/15 flipped it)
    // … so every booking date parses day-first (5/7/11 March), not month-first (3 May / 3 Jul / …).
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows.map((r) => r.date)).toEqual(['2026-03-05', '2026-03-07', '2026-03-11'])
  })

  it('FIN-4: a GENUINE US statement (rows LEAD with mm/dd) still flips to month-first', () => {
    // The leading-column restriction must not break real US detection: a leading `12/31/2026` (second field
    // 31 → US) still votes, so the otherwise-ambiguous rows resolve month-first.
    const text = ['Statement USD', '12/31/2026 Year-end fee -5,00 95,00', '03/05/2026 Service -6,00 89,00'].join('\n')
    expect(inferDateOrder(text)).toBe('mdy')
    expect(extractTransactionRows([chunk(text, 1)], 'USD').map((r) => r.date)).toEqual(['2026-12-31', '2026-03-05'])
  })
})

// full-audit-2026-06-30 Phase A (financial correctness): C1 (reconcile breaks the running-balance chain
// across a balance-less row → false `mismatch` → a CORRECT total withheld) + C5 (zero-amount classified
// inconsistently between summary and breakdown). Adversarial WHOLE-STRING fixtures through the REAL entry
// points (extractTransactionRows / extractStatementBalances / reconcileBalances / assessCompleteness /
// summarizeCashflow / categorizeRow), not pre-isolated tokens (TEST-N2). Written CHARACTERIZATION-FIRST.
describe('financial correctness (full-audit-2026-06-30 Phase A)', () => {
  // ---- C1: a balance-less amount row mid-statement must still ADVANCE the chain (not be dropped) ----
  it('C1: a balance-less amount row BETWEEN two balance-bearing rows whose chain ties out → all ok/unknown, complete', () => {
    // The reported harm: a bank prints the running balance only on a day's last line (same-day grouping) or
    // an OCR drops a balance cell, so a mid-statement row has a real amount but NO printed balanceAfter. The
    // pre-fix code dropped that gap row from the chain entirely — `prevBalance` advanced only on a printed
    // balance — so the NEXT balance-bearing row computed `prevBalance + thisAmount`, OMITTING the gap row's
    // amount, and reported a FALSE `mismatch`. That single mismatch forced assessCompleteness → 'contradicted'
    // → buildBankAnswer withheld a verifiable, CORRECT total. True chain here: 2000 → 1954,10 → (−10) →
    // 1924,10 ties out exactly. BEFORE (the bug): rows[2] expected 1954,10 + (−20) = 1934,10 ≠ 1924,10 →
    // ['unknown','unknown','mismatch'], reconciled:false, 'contradicted'.
    const text = [
      'Kontoauszug EUR',
      'Anfangssaldo 2.000,00',
      '2026-01-02 Grocery -45,90 1.954,10', // baseline (printed balance, no predecessor → unknown)
      '2026-01-03 Coffee -10,00', // GAP: a real −10 amount, NO printed running balance
      '2026-01-04 Bookshop -20,00 1.924,10', // 1.954,10 + (−10) + (−20) == 1.924,10 (the gap amount counts)
      'Endsaldo 1.924,10'
    ].join('\n')
    const chunks = [chunk(text, 1)]
    const rows = extractTransactionRows(chunks, 'EUR')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({ description: 'Coffee', amount: -10 })
    expect(rows[1].balanceAfter).toBeUndefined() // the gap row genuinely prints no balance
    const reconcile = reconcileBalances(rows)
    // The gap row is `unknown` (it prints no balance to check) but its amount STILL advances the chain, so
    // the following balance-bearing row reconciles `ok` rather than falsely mismatching.
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'unknown', 'ok'])
    expect(reconcile.reconciled).toBe(true)
    const { openingBalance, closingBalance } = extractStatementBalances(chunks)
    expect({ openingBalance, closingBalance }).toEqual({ openingBalance: 2000, closingBalance: 1924.1 })
    // The verified total is no longer withheld: opening + Σamounts == closing → 'complete'.
    expect(assessCompleteness({ rows, openingBalance, closingBalance, reconcile })).toBe('complete')
  })

  it('C1: TWO consecutive balance-less gap rows still tie out (the accumulator spans the whole gap)', () => {
    // Same-day grouping can print the balance only on the day's LAST line, leaving several rows balance-less.
    // 1.000,00 → (−10) → (−20) → 970,00: both gap amounts must be carried forward to the next printed balance.
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Startbuchung 5,00 1.000,00', // baseline balance 1.000,00 (its own amount resets the gap accumulator)
      '2026-01-03 Coffee -10,00', // gap 1
      '2026-01-03 Tea -20,00', // gap 2 (same day)
      '2026-01-03 Lunch -50,00 920,00' // 1.000,00 + (−10) + (−20) + (−50) == 920,00
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(4)
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'unknown', 'unknown', 'ok'])
    expect(reconcile.reconciled).toBe(true)
  })

  it('C1: a GENUINELY broken chain is still a `mismatch` (the accumulator does not paper over read errors)', () => {
    // The fix must not become a rubber stamp: a printed balance that does NOT equal the correct running
    // total (even after carrying the gap amount) is still flagged. Correct would be 1.924,10; the statement
    // prints 1.900,00 → mismatch under BOTH the old and the new arithmetic, so a real error still surfaces.
    const text = [
      'Kontoauszug EUR',
      '2026-01-02 Grocery -45,90 1.954,10',
      '2026-01-03 Coffee -10,00', // gap
      '2026-01-04 Bookshop -20,00 1.900,00' // wrong: 1.954,10 + (−10) + (−20) == 1.924,10, not 1.900,00
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'unknown', 'mismatch'])
    expect(reconcile.reconciled).toBe(false)
    expect(assessCompleteness({ rows, reconcile })).toBe('contradicted')
  })

  it('C1 regression: the normal 2-figure de-AT row is BYTE-IDENTICAL (no gap → no accumulator effect)', () => {
    // Two balance-bearing rows, no gap: the baseline is `unknown`, the second is a genuine `ok`. This is the
    // pre-fix behaviour unchanged — the accumulator stays at zero across a row that prints its own balance.
    const rows = extractTransactionRows(
      [chunk('Kontoauszug EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10', 1)],
      'EUR'
    )
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
    expect(reconcile.reconciled).toBe(true)
  })

  it('C1 regression: the HVB no-balance "Umsätze" listing stays all-unknown / not reconciled (BYTE-IDENTICAL)', () => {
    // No row prints a running balance, so the accumulator runs but is never compared against a printed
    // balance — okCount stays 0 → not reconciled, every row `unknown`, exactly as before the fix.
    const text = [
      'Kontoumsaetze EUR',
      '2026-01-20 KARTENZAHLUNG REWE SAGT DANKE 1234 -19,15',
      '2026-01-29 SEPA-GUTSCHRIFT Arbeitgeber 34,39'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.every((r) => r.status === 'unknown')).toBe(true)
    expect(reconcile.reconciled).toBe(false)
  })

  // ---- C5: a zero-amount row must be classified consistently across the summary and the breakdown ----
  it('C5: a 0.00 row is neither inflow nor outflow — consistent across summarizeCashflow and categorizeRow', () => {
    // BEFORE: summarizeCashflow used `amount >= 0` (a 0.00 row counted as INFLOW) while categorizeRow uses
    // `> 0` Income / `< 0` Spending / else Uncategorized (a 0.00 row is UNCATEGORIZED = neither). The two
    // surfaces disagreed on the same row. The figure is zero, so the TOTALS are unaffected either way; the
    // fix makes the CONVENTION consistent: zero is neither inflow nor outflow in both. (This pins the
    // convention against a future change that would make the zero attribution actually matter.)
    expect(categorizeRow(tx({ amount: 0 }))).toBe(UNCATEGORIZED) // breakdown: neither Income nor Spending
    const s = summarizeCashflow([tx({ amount: 12.5 }), tx({ amount: 0 }), tx({ amount: -4 })])
    // The zero contributes to NEITHER total; the figures match the breakdown's "neither" verdict.
    expect(s).toEqual({ totalIn: 12.5, totalOut: 4, net: 8.5, count: 3, currency: 'EUR' })
    // A lone 0.00 row: no inflow, no outflow, net zero (and still counted in `count` — it is a real row).
    expect(summarizeCashflow([tx({ amount: 0 })])).toEqual({
      totalIn: 0,
      totalOut: 0,
      net: 0,
      count: 1,
      currency: 'EUR'
    })
  })
})

// ---------------------------------------------------------------------------------------------------
// R1 (skills-remediation, audit §5.3) — the shared Unicode normalization pre-pass. A de-AT / Swiss PDF
// routinely prints a Unicode MINUS (U+2212 / EN DASH / NON-BREAKING HYPHEN), a NO-BREAK-SPACE thousands
// separator (NBSP / narrow NBSP / figure space), or a Swiss U+2019 apostrophe group. Without the pre-pass
// MONEY_RE (whose sign class is ASCII-only, and whose space grouping matches an ASCII space) either loses
// the sign — a DEBIT read as a CREDIT — or truncates the magnitude to the last group (a 1000× error).
// These construct realistic layouts with the real codepoints and execute the REAL extractor.
// ---------------------------------------------------------------------------------------------------
describe('R1 — Unicode normalization at the extractor entry (audit §5.3)', () => {
  const MINUS = '\u2212' // MINUS SIGN
  const ENDASH = '\u2013' // EN DASH
  const NBHYPHEN = '\u2011' // NON-BREAKING HYPHEN
  const NBSP = '\u00A0' // NO-BREAK SPACE
  const NNBSP = '\u202F' // NARROW NO-BREAK SPACE
  const FIGSP = '\u2007' // FIGURE SPACE
  const RSQUO = '\u2019' // RIGHT SINGLE QUOTATION MARK (Swiss apostrophe grouping)

  it('a U+2212 minus signs the amount negative (a debit is no longer read as a credit)', () => {
    const rows = extractTransactionRows([chunk(`2026-01-02 Grocery Store ${MINUS}45,90 1.954,10`, 1)], 'EUR')
    expect(rows[0]).toMatchObject({ amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 })
  })

  it('an EN-DASH trailing minus (de-AT glued debit sign) signs the amount negative', () => {
    const rows = extractTransactionRows([chunk(`2026-01-02 Lastschrift 45,90${ENDASH} 1.954,10`, 1)], 'EUR')
    expect(rows[0].amount).toBe(-45.9)
  })

  it('a NON-BREAKING-HYPHEN trailing minus is normalized the same way', () => {
    const rows = extractTransactionRows([chunk(`2026-01-02 Lastschrift 45,90${NBHYPHEN} 1.954,10`, 1)], 'EUR')
    expect(rows[0].amount).toBe(-45.9)
  })

  it('an NBSP-grouped amount reads its FULL magnitude (1 234,56 → 1234.56, not 234.56)', () => {
    const rows = extractTransactionRows(
      [chunk(`2026-01-02 Big Payment ${MINUS}1${NBSP}234,56 5${NBSP}678,90`, 1)],
      'EUR'
    )
    expect(rows[0]).toMatchObject({ amount: -1234.56, balanceAfter: 5678.9 })
  })

  it('a NARROW NBSP (U+202F) grouping is normalized identically', () => {
    const rows = extractTransactionRows([chunk(`2026-01-02 Rent ${MINUS}1${NNBSP}000,00 4${NNBSP}454,10`, 1)], 'EUR')
    expect(rows[0]).toMatchObject({ amount: -1000, balanceAfter: 4454.1 })
  })

  it('a Swiss U+2019 apostrophe group reads 1’234.56 → 1234.56 (not truncated)', () => {
    const rows = extractTransactionRows(
      [chunk(`2026-01-02 Zahlung ${MINUS}1${RSQUO}234.56 5${RSQUO}678.90`, 1)],
      'CHF'
    )
    expect(rows[0]).toMatchObject({ amount: -1234.56, balanceAfter: 5678.9, currency: 'CHF' })
  })

  it('a full statement of NBSP / figure-space rows parses correctly end-to-end (Σ from clean magnitudes)', () => {
    const text = [
      'Kontoauszug EUR',
      `2026-01-02 Supermarkt Billa ${MINUS}1${NBSP}234,56 8${FIGSP}765,44`,
      `2026-01-03 Gehalt ACME 2${NBSP}500,00 11${NBSP}265,44`
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ amount: -1234.56, balanceAfter: 8765.44 })
    expect(rows[1]).toMatchObject({ amount: 2500, balanceAfter: 11265.44 })
    // The net follows from the clean magnitudes — NOT the 1000×-truncated 2500 − 234.56 ≈ 2265.44.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(1265.44, 2)
  })

  it('extractStatementBalances normalizes too: NBSP-grouped Kontostand balances read in full', () => {
    // The balance readers (`lastMoneyOnLine`) run over the SAME normalized text, so a Raiffeisen
    // `Kontostand per <date>` pair with NBSP-grouped balances brackets the period with full magnitudes.
    const text = [
      `Kontostand per 01.01.2026 1${NBSP}000,00`,
      `Kontostand per 31.01.2026 2${NBSP}500,50`
    ].join('\n')
    expect(extractStatementBalances([chunk(text, 1)])).toEqual({
      openingBalance: 1000,
      closingBalance: 2500.5
    })
  })

  it('ASCII inputs are unaffected (the normalization is a no-op for clean text)', () => {
    // The acceptance guard: an all-ASCII statement produces the exact same rows as before R1.
    const text = [
      'Account statement EUR',
      '2026-01-02 Grocery Store -45,90 1.954,10',
      '2026-01-03 Salary ACME 2.500,00 4.454,10'
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 2)], 'EUR')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ amount: -45.9, balanceAfter: 1954.1 })
    expect(rows[1]).toMatchObject({ amount: 2500, balanceAfter: 4454.1 })
  })
})
