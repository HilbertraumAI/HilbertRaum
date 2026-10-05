import { describe, it, expect } from 'vitest'
import {
  extractTransactionsTool,
  extractTransactionRows,
  extractTransactionsWithStats,
  extractStatementBalances,
  assessCompleteness,
  reconcileBalances,
  categorizeRow,
  summarizeCashflow,
  transactionsToCsv,
  buildStatementJson,
  validateStatementBalancesTool,
  categorizeTransactionsTool,
  summarizeCashflowTool,
  exportTransactionsCsvTool,
  UNCATEGORIZED,
  BANK_EXTRACTOR_VERSION,
  type ExtractTransactionsOutput,
  type TransactionInput
} from '../../src/main/services/skills/tools/bank-statement'
import { inferDateOrder } from '../../src/main/services/skills/tools/money'
import { runSkillTool, validateToolOutput } from '../../src/main/services/skills/tool-registry'
import type { AuditEventType, DocumentChunkRead, SkillTool, SkillToolContext } from '../../src/shared/types'

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
// The Unicode look-alikes a de-AT / Swiss PDF prints (R1, audit §5.3): a MINUS / EN DASH / NON-BREAKING
// HYPHEN sign, NBSP / narrow NBSP / FIGURE SPACE thousands separators, a U+2019 apostrophe group. Built
// from code points so the fixtures stay visible.
const MINUS = String.fromCharCode(0x2212)
const ENDASH = String.fromCharCode(0x2013)
const NBHYPHEN = String.fromCharCode(0x2011)
const NBSP = String.fromCharCode(0x00a0)
const NNBSP = String.fromCharCode(0x202f)
const FIGSP = String.fromCharCode(0x2007)
const RSQUO = String.fromCharCode(0x2019)

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
    expect(rows[0].valueDate).toBeUndefined() // a single-date row captures no value date (BL-1)
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

describe('extractStatementBalances (the completeness-gate inputs — §3.5 / D56)', () => {
  // `toEqual` per row: an absent balance is ABSENT (no key), never a guessed value.
  it.each<[string, string, { openingBalance?: number; closingBalance?: number }]>([
    [
      'EN labels, last figure on the line',
      'Opening balance 2.000,00\n... rows ...\nClosing balance 4.454,10',
      { openingBalance: 2000, closingBalance: 4454.1 }
    ],
    [
      'DE labels',
      'Alter Kontostand 2.000,00\nNeuer Kontostand 4.454,10',
      { openingBalance: 2000, closingBalance: 4454.1 }
    ],
    ['a date earlier on the balance line is skipped, the trailing figure is read', 'Saldovortrag 01.01.2024 1.234,56', { openingBalance: 1234.56 }],
    ['no balance label ⇒ nothing (the gate then downgrades)', '2026-01-02 Coffee -3,50 100,00', {}],
    // R2 (audit §5.4): `per` / `am` / `zum` are all in use across AT/DE banks; recognizing only `per`
    // silently lost the completeness gate on an `am`/`zum` statement.
    [
      'R2: `Kontostand am` is a dual-role balance label too',
      'Kontostand am 31.03.2025 35.037,04\n... rows ...\nKontostand am 23.06.2025 30.647,07',
      { openingBalance: 35037.04, closingBalance: 30647.07 }
    ],
    [
      'R2: `Kontostand zum` is a dual-role balance label too',
      'Kontostand zum 01.01.2026 1.000,00\n... rows ...\nKontostand zum 31.01.2026 2.500,50',
      { openingBalance: 1000, closingBalance: 2500.5 }
    ],
    // BEFORE (BL-N2): the closing read the last money token '30.06.20' → 3006.20 (the date as the balance).
    [
      'BL-N2: a trailing-date closing line reads the FIGURE, not the date, as the balance',
      [
        'Kontoauszug EUR',
        'Anfangssaldo 2.000,00',
        '2026-01-02 Grocery -45,90 1.954,10',
        '2026-01-03 Salary 2.500,00 4.454,10',
        'Endsaldo 4.454,10 EUR per 30.06.2026'
      ].join('\n'),
      { openingBalance: 2000, closingBalance: 4454.1 }
    ],
    // `Endsaldo 1.234,56 EUR per 31.03.26` read closing 3103.26 before (the 2-digit year was invisible to
    // the scrub); the opening's `per 01.03.26` likewise read 103.26.
    [
      'R7 SKA-2: a dd.mm.yy TRAILING date on a balance line is scrubbed — the printed figure wins',
      [
        'Zeitraum 01.03.2026 bis 31.03.2026',
        'Anfangssaldo 1.000,00 EUR per 01.03.26',
        'Endsaldo 1.234,56 EUR per 31.03.26'
      ].join('\n'),
      { openingBalance: 1000, closingBalance: 1234.56 }
    ],
    [
      'R7 review: a PUNCTUATION-trailed dd.mm.yy balance date is scrubbed too',
      'Zeitraum 01.03.2026 bis 31.03.2026\nEndsaldo 1.234,56 EUR per 31.03.26.',
      { closingBalance: 1234.56 }
    ],
    // U1 (audit §2.3): bare integers MONEY_RE rejects; `lastMoneyOnLine` falls back to the shared
    // `lastCurrencyAdjacentInteger`, mirroring the invoice `totalsMoney` fallback.
    [
      'U1: a ROUND balance printed with no decimal, currency-adjacent',
      'Opening balance 914 $\n... rows ...\nClosing balance 1 000 $',
      { openingBalance: 914, closingBalance: 1000 }
    ],
    ['U1: the SIGN of a currency-adjacent round balance is kept (a credit-note closing)', 'Closing balance -50 EUR', { closingBalance: -50 }],
    ['U1: a bare integer touching no currency marker is not read (drop-don’t-guess)', 'Opening balance 914', {}],
    // The balance readers run over the SAME normalized text as the row extractor.
    [
      'R1: NBSP-grouped Kontostand balances read in full',
      `Kontostand per 01.01.2026 1${NBSP}000,00\nKontostand per 31.01.2026 2${NBSP}500,50`,
      { openingBalance: 1000, closingBalance: 2500.5 }
    ]
  ])('reads the printed balances: %s', (_label, text, expected) => {
    expect(extractStatementBalances([chunk(text)])).toEqual(expected)
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
  it.each<[string, string[], string[]]>([
    [
      'completes dd.mm.yy rows against a 4-digit anchor date in the document',
      [
        'Kontoauszug Zeitraum 01.01.2026 - 31.01.2026', // the 4-digit-year anchor
        '05.01.26 Gehalt ACME 2.500,00 3.500,00',
        '06.01.26 Miete -900,00 2.600,00'
      ],
      ['2026-01-05', '2026-01-06']
    ],
    [
      'drops dd.mm.yy rows when the document has NO 4-digit anchor (no guess ⇒ zero rows — posture asserted explicitly)',
      ['05.01.26 Gehalt ACME 2.500,00 3.500,00', '06.01.26 Miete -900,00 2.600,00'],
      []
    ],
    [
      'cross-year: a bare 28.12. row on a January-anchored statement gets the PREVIOUS year (not the naive page-year stamp)',
      [
        'Kontoauszug Zeitraum 01.01.2026 - 31.01.2026',
        '05.01.2026 Gehalt ACME 2.500,00 3.500,00',
        '28.12. Miete -900,00 2.600,00'
      ],
      ['2026-01-05', '2025-12-28']
    ]
  ])('%s', (_label, lines, dates) => {
    const rows = extractTransactionRows([chunk(lines.join('\n'), 1)], 'EUR')
    expect(rows.map((r) => r.date)).toEqual(dates)
  })
})

describe('extractTransactionRows — wrapped descriptions (R6, §5.7)', () => {
  // `chunks` are one page each: a continuation never crosses a chunk boundary (`pending` is per-segment).
  it.each<[string, string[], Array<Record<string, unknown>>]>([
    // A SEPA row whose payee prints on the line below: before R6 the `NETFLIX…` line was dropped (the row
    // kept only `SEPA-Lastschrift`), degrading the categorizer and the listing.
    [
      'appends a dateless/money-less follower line to the prior row (merchant name survives)',
      ['2026-03-01 SEPA-Lastschrift -12,99 1.000,00\nNETFLIX INTERNATIONAL B.V.'],
      [{ amount: -12.99, balanceAfter: 1000, description: 'SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.' }]
    ],
    [
      'is BOUNDED to one continuation line — a third dateless line does not glue',
      ['2026-03-01 SEPA-Lastschrift -12,99 1.000,00\nNETFLIX INTERNATIONAL B.V.\nAmsterdam NL'],
      [{ description: 'SEPA-Lastschrift NETFLIX INTERNATIONAL B.V.' }]
    ],
    // A balance-label line (a summary) and a genuine next transaction each CLOSE the pending row.
    [
      'does NOT glue a balance-label line or a following transaction to the prior row',
      ['2026-03-01 Kaffeehaus -3,50 996,50\nKontostand am 31.03.2026 996,50\n2026-03-02 Bäckerei -2,00 994,50'],
      [{ description: 'Kaffeehaus' }, { description: 'Bäckerei' }]
    ],
    // A bare figure line (an FX/annotation remnant) carries a money token, so it closes the pending row.
    [
      'does NOT glue a figure-bearing follower line (a stray annotation is not payee text)',
      ['2026-03-01 Kaffeehaus -3,50 996,50\n1,50'],
      [{ description: 'Kaffeehaus' }] // NOT "Kaffeehaus 1,50"
    ],
    [
      'does NOT carry a continuation across a chunk/page boundary (a page-2 column header is not absorbed)',
      [
        '2026-03-01 Kaffeehaus -3,50 996,50',
        'Buchungstag Valuta Buchungstext Betrag Saldo\n2026-03-02 Bäckerei -2,00 994,50'
      ],
      [{ description: 'Kaffeehaus' }, { description: 'Bäckerei' }]
    ],
    [
      'R2: an `am`/`zum` Kontostand line is dropped from the transaction stream, not read as a phantom row (§5.4)',
      ['Kontoauszug EUR\n2026-01-02 Kaffeehaus -3,50 996,50\nKontostand am 31.01.2026 996,50'],
      [{ description: 'Kaffeehaus', amount: -3.5 }]
    ]
  ])('%s', (_label, texts, expected) => {
    const rows = extractTransactionRows(
      texts.map((t, i) => chunk(t, i + 1, i)),
      'EUR'
    )
    expect(rows).toHaveLength(expected.length)
    expect(rows).toMatchObject(expected)
  })
})

describe('BANK_EXTRACTOR_VERSION (A9 staleness stamp)', () => {
  it('is at 11 — the IA-3 shared date-order classifier change (invoice-audit-2026-07-06 T-6)', () => {
    // The constant gates A9 re-extraction: any statement stamped lower is STALE and re-extracted. The
    // per-version changelog lives on the constant in bank-statement.ts; a deliberate bump updates this literal.
    expect(BANK_EXTRACTOR_VERSION).toBe(11)
  })
})

describe('extractTransactionsWithStats — droppedRowCount (U1, audit §2.3)', () => {
  it.each<[string, string, string | null, number, number]>([
    [
      'is 0 on a clean statement (every money line parsed) — the "whole statement" claim stands',
      'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10',
      'EUR',
      2,
      0
    ],
    // No detectable currency (null statement currency, no symbol/code) → parseLine drops both rows; each
    // is a money-bearing line the parser could not read → counted.
    ['counts a currency-less money-bearing row the parser rejected', '2026-01-02 Grocery -45,90\n2026-01-03 Mystery -12,00', null, 0, 2],
    [
      'does NOT count a money-LESS header/period line (it never looked like a transaction)',
      'Kontoauszug Zeitraum 01.01.2026 - 31.03.2026\n2026-01-02 Grocery -45,90 1.954,10',
      'EUR',
      1,
      0 // the period header carries no money-shaped token after date-scrub
    ],
    // "31.02.2026" is date-SHAPED but not a valid calendar date → parseLine drops the row; it IS counted (a
    // parse-gated check would silently miss it and keep the answer's "whole statement" claim over a drop).
    [
      'counts a booking row dropped for a DATE-parse failure (malformed / no-anchor date) — SHAPE not parse',
      '2026-01-02 Grocery -45,90 1.954,10\n31.02.2026 Payee 90,00 EUR',
      'EUR',
      1,
      1
    ],
    // The plain-path mirror of the geometry Valuta/FX second baseline: a figure with no leading date token
    // is a memo/reference, never a transaction — counting it would falsely gate the read.
    [
      'a money-bearing line whose DESCRIPTION leads (no date-shaped token) is NOT counted (FX/memo exclusion)',
      '2026-01-02 Grocery -45,90 1.954,10\nAuftraggeber Hausverwaltung 12,50 CHF',
      'EUR',
      1,
      0
    ]
  ])('%s', (_label, text, currency, rowCount, dropped) => {
    const stats = extractTransactionsWithStats([chunk(text, 1)], currency)
    expect(stats.rows).toHaveLength(rowCount)
    expect(stats.droppedRowCount).toBe(dropped)
  })
})

describe('R7 — a mid-line/trailing date is never an amount (skills-audit-2026-07-03 SKA-1/SKA-2)', () => {
  // `splitLeadingDates` consumes only the LEADING date; the un-blanked money scan then read the second
  // date's `30.04` as the amount → {date: 2026-04-01, description: "bis", amount: 30.04}. `31.03.26` is
  // money-shaped whole (→ 3103.26); with the widened scrub the blanked scan sees nothing.
  it.each([
    [
      'a period line `01.04.2026 bis 30.04.2026` no longer invents a "bis" transaction (SKA-1)',
      'Statement EUR\n01.04.2026 bis 30.04.2026\n02.04.2026 Grocery -45,90'
    ],
    [
      'the dd.mm.yy period variant no longer invents a 3103.26-style transaction (SKA-1 + SKA-2)',
      '01.03.2026 bis 31.03.2026\n15.03.26 bis 31.03.26 Zinsperiode\n02.03.2026 Grocery -45,90 EUR'
    ]
  ])('%s', (_label, text) => {
    const stats = extractTransactionsWithStats([chunk(text, 1)], 'EUR')
    expect(stats.rows).toHaveLength(1)
    expect(stats.rows[0].description).toBe('Grocery')
    expect(stats.droppedRowCount).toBe(0) // the period line carries NO money token → never counted
  })

  it('a TRAILING date on a booking row is not a phantom balance column (SKA-1)', () => {
    // Before: matches were [900,00, 31.03.26] → hasBalance → balanceAfter 3103.26 (a confidently-wrong figure).
    const rows = extractTransactionRows([chunk('05.03.2026 Miete 900,00 EUR per 31.03.26', 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(900)
    expect(rows[0].balanceAfter).toBeUndefined()
    expect(rows[0].description).toBe('Miete')
  })

  // The SKA-1 blanking is SAME-LENGTH: a mid-line date LEFT of the figure stays in the description
  // byte-exact (the slice uses ORIGINAL text at blanked-scan indices), and the figure-region slice still
  // sees the adjacent foreign code. The second row pins the date ADJACENT to the figure: the blanked date's
  // tail sits inside MONEY_RE's up-to-4-space leading gap (`\s{0,4}`), so a raw `match.index` slice would
  // chop `…31.03.26` bytes out of the description.
  it.each<[string, string, Record<string, unknown>]>([
    [
      'the SKA-1 blanking is SAME-LENGTH: description slicing and figure-region currency stay byte-correct',
      '05.03.2026 Ref 31.12.2026 Gutschrift 100,00 USD 1.100,00',
      // currency: figure-region detection unshifted (BL-2 slice intact)
      { description: 'Ref 31.12.2026 Gutschrift', currency: 'USD', amount: 100, balanceAfter: 1100 }
    ],
    [
      'the figureStart trim is pinned with the date ADJACENT to the figure (R7 review)',
      '05.03.2026 Zinsen bis 31.03.26 100,00 1.100,00',
      { description: 'Zinsen bis 31.03.26', amount: 100, balanceAfter: 1100 }
    ]
  ])('%s', (_label, line, expected) => {
    const rows = extractTransactionRows([chunk(line, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(expected)
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

  it('dd.mm.yy rows with a per-row currency CELL keep their document currency vote (R7 review — zero-rows regression)', async () => {
    // The `<date> <desc> EUR <amount>` layout's only EUR sits LEFT of the amount; the SKA-2 scrub removed its
    // accidental vote (the date used to be the first "money" match). The figure-ADJACENT code now votes
    // deliberately, so the whole tool still extracts every row — a lost vote leaves a null currency and every
    // row is dropped.
    const text = ['01.06.2026 Miete EUR 850,00-', '15.06.26 REWE Markt EUR 19,15-', '20.06.26 Gutschrift EUR 250,00'].join('\n')
    const { ctx } = makeCtx([chunk(text, 1)])
    const result = await runSkillTool(extractTransactionsTool, {
      skillId: 'app:bank-statement',
      input: { documentId: 'd1' },
      ctx
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const out = result.output as ExtractTransactionsOutput
      expect(out.currency).toBe('EUR')
      expect(out.transactions.map((r) => r.amount)).toEqual([-850, -19.15, 250])
      expect(out.droppedRowCount).toBe(0)
    }
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
  // The first row has nothing to compare against (a baseline → unknown); only a genuine comparison with a
  // predecessor's printed balance counts as `ok`, and a statement that verified nothing is never `reconciled`.
  it.each<[string, TransactionInput[], string[], boolean]>([
    [
      'the baseline row is unknown, only a genuine predecessor-comparison is ok',
      [tx({ amount: -45.9, balanceAfter: 1954.1 }), tx({ amount: 2500, balanceAfter: 4454.1 })],
      ['unknown', 'ok'],
      true
    ],
    [
      // The lone printed balance is a baseline with no predecessor — it must NOT count as a pass.
      'a single-transaction statement verifies nothing ⇒ not reconciled (honesty)',
      [tx({ amount: -45.9, balanceAfter: 1954.1 })],
      ['unknown'],
      false
    ],
    [
      'flags a mismatch and an unknown (no printed balance), never invents',
      [
        tx({ amount: -45.9, balanceAfter: 1954.1 }),
        tx({ amount: 2500, balanceAfter: 9999.99 }), // wrong running balance vs predecessor
        tx({ amount: -5, balanceAfter: undefined }) // no balance printed → unknown
      ],
      ['unknown', 'mismatch', 'unknown'],
      false
    ],
    [
      // The running chain would add a USD amount onto a EUR balance — meaningless; nothing is genuinely
      // checked, so no spurious `mismatch` flows into the completeness gate (BL-2).
      'a MIXED-currency statement is all-unknown, never a cross-currency mismatch (BL-2)',
      [
        tx({ amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 }),
        tx({ amount: -10, currency: 'USD', balanceAfter: 1944.1 }) // a same-currency chain would 'mismatch'
      ],
      ['unknown', 'unknown'],
      false
    ],
    [
      // No predecessor ever has a balance: the whole statement is unchecked, never silently "reconciled".
      'all-baseline (no row prints a balance) ⇒ not reconciled',
      [tx(), tx()],
      ['unknown', 'unknown'],
      false
    ],
    [
      // C1 (balance-less gap rows): both gap amounts are carried forward to the next printed balance —
      // 1.000,00 → (−10) → (−20) → (−50) == 920,00 — so the accumulator spans the WHOLE gap.
      'C1: TWO consecutive balance-less gap rows still tie out (the accumulator spans the gap)',
      [
        tx({ amount: 5, balanceAfter: 1000 }),
        tx({ amount: -10 }),
        tx({ amount: -20 }),
        tx({ amount: -50, balanceAfter: 920 })
      ],
      ['unknown', 'unknown', 'unknown', 'ok'],
      true
    ]
  ])('reconcileBalances: %s', (_label, rows, statuses, reconciled) => {
    const res = reconcileBalances(rows)
    expect(res.rows.map((r) => r.status)).toEqual(statuses)
    expect(res.reconciled).toBe(reconciled)
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
})

describe('export_transactions_csv (S11c)', () => {
  it('transactionsToCsv writes a header + escaped rows, fixed-dp amounts, blanks for nulls', () => {
    const csv = transactionsToCsv([
      tx({ date: '2026-01-02', description: 'Café, Vienna', amount: -4.5, balanceAfter: 100 }),
      tx({ date: '2026-01-03', description: 'Salary', amount: 2500, valueDate: '2026-01-03', sourcePage: 2 }),
      // S12 audit F4: a formula-shaped description is prefixed with a quote so a spreadsheet reads it as
      // text (the per-cell cases live in money.test.ts › csvField; this is the wiring through the column).
      tx({ description: '=HYPERLINK("http://evil","click")', amount: -1 })
    ])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('date,valueDate,description,amount,currency,balanceAfter,sourcePage')
    expect(lines[1]).toBe('2026-01-02,,"Café, Vienna",-4.50,EUR,100.00,') // comma field quoted; nulls blank
    expect(lines[2]).toBe('2026-01-03,2026-01-03,Salary,2500.00,EUR,,2')
    expect(lines[3]).toBe('2026-01-02,,"\'=HYPERLINK(""http://evil"",""click"")",-1.00,EUR,,') // amount never neutralized
  })

  it('emits the category column ONLY when a row carries one (presence gate, result-tables D62)', () => {
    // No row categorized → the byte-identical 7-column shape (pinned above). One categorized row →
    // the column appears for ALL rows, blank where unassigned (absent, never invented).
    const withCategories = transactionsToCsv([
      tx({ date: '2026-01-02', description: 'Grocery', amount: -45.9, category: 'Groceries' }),
      tx({ date: '2026-01-03', description: 'Mystery', amount: -1 })
    ])
    const lines = withCategories.trimEnd().split('\r\n')
    expect(lines[0]).toBe('date,valueDate,description,amount,currency,balanceAfter,sourcePage,category')
    expect(lines[1]).toBe('2026-01-02,,Grocery,-45.90,EUR,,,Groceries')
    expect(lines[2]).toBe('2026-01-03,,Mystery,-1.00,EUR,,,')
  })

  it('neutralizes a formula-shaped category label (the CSV boundary is one audited path, D60)', () => {
    const csv = transactionsToCsv([tx({ description: 'x', amount: -1, category: '=SUM(A1)' })])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[1]).toBe("2026-01-02,,x,-1.00,EUR,,,'=SUM(A1)")
  })

  it('buildStatementJson carries per-row categories under the same presence gate (D62)', () => {
    const rows = [tx({ category: 'Groceries' }), tx({ description: 'Other' })]
    const withCats = JSON.parse(buildStatementJson({ rows, summary: summarizeCashflow(rows) }))
    expect(withCats.transactions[0].category).toBe('Groceries')
    expect(withCats.transactions[1].category).toBeNull() // unassigned → explicit null, never invented
    const plain = JSON.parse(buildStatementJson({ rows: [tx()], summary: summarizeCashflow([tx()]) }))
    expect('category' in plain.transactions[0]).toBe(false) // never-categorized → stable prior shape
  })
})

// Each downstream tool runs THROUGH the gate and emits output that passes its own outputSchema.
// export_transactions_csv is the only confirm-gated tool (its refusal without confirmation is pinned in
// skills-run.test.ts and skills-tool-registry.test.ts), so it runs confirmed here.
describe('the downstream tools through the gate (S11c)', () => {
  it.each<[string, SkillTool, unknown, boolean]>([
    [
      'validate_statement_balances',
      validateStatementBalancesTool,
      { transactions: [tx({ amount: -45.9, balanceAfter: 1954.1 })] },
      false
    ],
    ['categorize_transactions', categorizeTransactionsTool, { transactions: [tx()] }, false],
    ['summarize_cashflow', summarizeCashflowTool, { transactions: [tx({ amount: 5 })] }, false],
    ['export_transactions_csv (confirmed)', exportTransactionsCsvTool, { transactions: [tx()] }, true]
  ])('%s runs with schema-valid output', async (_name, tool, input, confirmed) => {
    const result = await runSkillTool(tool, {
      skillId: 'app:bank-statement',
      input,
      ctx: downstreamCtx(),
      confirmed
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(validateToolOutput(tool, result.output)).toEqual([])
  })
})

// full-audit-2026-06-28 Phase 1 (financial correctness): adversarial WHOLE-STRING tests driven through
// the REAL entry points (extractTransactionRows / extractStatementBalances / reconcileBalances /
// assessCompleteness), not pre-isolated tokens (TEST-N2). Each pins a fixed reproduction from §2.
describe('financial correctness (full-audit-2026-06-28 Phase 1)', () => {
  // The 12/31 row has day 31 > 12, so it can ONLY be mm/dd → the whole document infers month-first and the
  // otherwise-ambiguous 03/05 resolves to the US reading; the EU twin keeps the de-AT day-first default.
  it.each<[string, string[], string, string[]]>([
    [
      'BL-N1: a US-ordered statement is inferred month-first — no dropped rows, correct month',
      ['Statement USD', '12/31/2026 Year-end fee -5,00 95,00', '03/05/2026 Service charge -6,00 89,00'],
      'USD',
      // BEFORE: 12/31 → null → the whole row was SILENTLY DROPPED, and 03/05 read '2026-05-03' (a wrong May)
      ['2026-12-31', '2026-03-05']
    ],
    [
      'BL-N1: the de-AT day-first default holds on an EU statement (and when nothing disambiguates)',
      [
        'Statement EUR',
        '31/12/2026 Jahresgebühr -5,00 95,00', // day 31 > 12 confirms day-first
        '03/05/2026 Lastschrift -6,00 89,00' // ⇒ 5 May, the de-AT reading
      ],
      'EUR',
      ['2026-12-31', '2026-05-03']
    ]
  ])('%s', (_label, lines, currency, dates) => {
    const rows = extractTransactionRows([chunk(lines.join('\n'), 1)], currency)
    expect(rows.map((r) => r.date)).toEqual(dates)
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

  // The shared MONEY_RE token boundary, read through the real extractor (DECISION 2).
  it.each<[string, string, string, Record<string, number>]>([
    [
      // de-AT '.' = thousands. BEFORE: MONEY_RE grabbed '1.00' out of '1.000' → €1 (a 1000× understatement).
      'TEST-N2: a bare grouped figure with no 2-dp tail is read as thousands, not €1',
      'Statement EUR\n2026-01-02 Miete 1.000 9.000',
      'EUR',
      { amount: 1000, balanceAfter: 9000 }
    ],
    [
      // BEFORE: 567.89 (only the trailing space-group survived)
      'TEST-N2: a space-grouped amount is read whole',
      'Statement EUR\n2026-01-02 Bonus 1 234 567,89 1 300 000,00',
      'EUR',
      { amount: 1234567.89 }
    ],
    [
      // BEFORE: 234.56 (the apostrophe group was dropped)
      'TEST-N2: an apostrophe-grouped amount is read whole',
      "Statement CHF\n2026-01-02 Zahlung 1'234.56 9'999.00",
      'CHF',
      { amount: 1234.56 }
    ],
    [
      // The `(?<!\d)` anchor stops "…778899 300,00" reading "899 300,00" → 899300 (the pdf-layout hazard).
      'TEST-N2: space grouping does not merge across a digit boundary',
      'Statement EUR\n2026-01-02 Sender GmbH Auftrag 778899 300,00 1.255,00',
      'EUR',
      { amount: 300, balanceAfter: 1255 }
    ],
    [
      // The `(?<![A-Za-z0-9])` boundary stops "Ref123 456,78" reading "123 456,78" → 123456.78.
      'TEST-N2: space grouping does not fuse a LETTER-preceded digit tail with the amount (adversarial review)',
      'Statement EUR\n2026-01-02 Zahlung Ref123 456,78 1.000,00',
      'EUR',
      { amount: 456.78, balanceAfter: 1000 }
    ]
  ])('%s', (_label, text, currency, expected) => {
    expect(extractTransactionRows([chunk(text, 1)], currency)[0]).toMatchObject(expected)
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
})

// full-audit-2026-06-29 Phase 1 (financial correctness): BL-1/BL-2/BL-3 — adversarial WHOLE-STRING
// fixtures through the REAL entry points (extractTransactionRows / reconcileBalances / summarizeCashflow
// / categorizeRow), not pre-isolated tokens. Each pins a fixed reproduction from the audit §2.
describe('financial correctness (full-audit-2026-06-29 Phase 1)', () => {
  // ---- BL-1: a leading-minus figure must not steal the previous figure's sign ----
  // BEFORE the fix MONEY_RE's trailing `-?` ate the balance's leading minus ACROSS the separating space, so
  // BOTH signs flipped. The chain still tied out internally, so `reconcileBalances` reported `ok` on the
  // WRONG figures — the safety net could not catch it.
  it.each<
    [string, string[], number[], number[], { totalIn: number; totalOut: number; net: number }]
  >([
    [
      // "2.500,00 -500,00" = a +2500 credit into an overdrawn account, new balance −500.
      'BL-1: a leading-minus running balance keeps its sign; the credit before it stays positive',
      [
        'Kontoauszug EUR',
        '2026-01-02 Gehalt ACME 2.500,00 -500,00', // credit INTO an overdrawn account (balance still −500)
        '2026-01-03 Supermarkt Billa -45,90 -545,90' // debit; balance stays negative (−500 − 45,90)
      ],
      [2500, -45.9], // BEFORE: rows[0] = { amount: −2500, balanceAfter: +500 }
      [-500, -545.9],
      // The headline is right: the credit is inflow, not outflow (BEFORE: net −2545,90).
      { totalIn: 2500, totalOut: 45.9, net: 2454.1 }
    ],
    [
      // With EVERY balance leading-minus and EVERY amount positive the bug flipped the WHOLE chain
      // consistently (prevBal+amount==bal still held with every sign negated) — reconcile false-green.
      'BL-1: a fully-negative-balance chain is no longer silently sign-flipped (reconcile false-green)',
      [
        'Kontoauszug EUR',
        '2026-01-02 Einzahlung 1.000,00 -2.000,00', // +1000 into a −3000 overdraft → −2000
        '2026-01-03 Einzahlung 1.500,00 -500,00' // +1500 → −500
      ],
      [1000, 1500], // BEFORE: [−1000, −1500]
      [-2000, -500], // BEFORE: [+2000, +500]
      { totalIn: 2500, totalOut: 0, net: 2500 }
    ]
  ])('%s', (_label, lines, amounts, balances, summary) => {
    const rows = extractTransactionRows([chunk(lines.join('\n'), 1)], 'EUR')
    expect(rows.map((r) => r.amount)).toEqual(amounts)
    expect(rows.map((r) => r.balanceAfter)).toEqual(balances)
    // The chain ties out on the CORRECT signs (−500 + −45,90 == −545,90).
    const reconcile = reconcileBalances(rows)
    expect(reconcile.rows.map((r) => r.status)).toEqual(['unknown', 'ok'])
    expect(reconcile.reconciled).toBe(true)
    expect(summarizeCashflow(rows)).toMatchObject(summary)
  })

  // The de-AT debit convention prints the sign as a GLUED trailing minus ("45,90-"), usually followed by a
  // running-balance column. The fix keeps reading the glued minus as a debit while NOT stealing a SEPARATED
  // leading minus (the BL-1 case above). The disambiguator is the SPACE: a glued "-" belongs to the figure on
  // its left; a "-<digit>" after a space is the next figure's leading sign. (A blanket trailing-minus
  // lookahead would mis-read this debit as +45,90 — the reason the fix is space-aware.)
  it.each<[string, string[], Array<Record<string, number>>, string[]]>([
    [
      'BL-1: the de-AT GLUED trailing minus is preserved even when a balance figure follows',
      [
        'Kontoauszug EUR',
        '2026-01-02 Miete 45,90- 1.908,20', // glued trailing-minus debit; positive running balance
        '2026-01-03 Bargeld 200,00- 1.708,20' // glued trailing-minus debit again (1.908,20 − 200 = 1.708,20)
      ],
      [
        { amount: -45.9, balanceAfter: 1908.2 },
        { amount: -200, balanceAfter: 1708.2 }
      ],
      ['unknown', 'ok']
    ],
    [
      // The lone-figure de-AT debit "12,00-": a trailing minus with nothing after it is the figure's own sign.
      'BL-1: a glued trailing-minus debit at END of line still reads negative (no following figure)',
      ['Statement EUR', '2026-01-02 Auszahlung 500,00-'],
      [{ amount: -500 }],
      ['unknown']
    ]
  ])('%s', (_label, lines, expected, statuses) => {
    const rows = extractTransactionRows([chunk(lines.join('\n'), 1)], 'EUR')
    expect(rows).toHaveLength(expected.length)
    expect(rows).toMatchObject(expected)
    expect(reconcileBalances(rows).rows.map((r) => r.status)).toEqual(statuses)
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
})

// full-audit-2026-06-29-postmerge Phase 1 (money-parser correctness): F1 (unmatched amount column →
// balance read as amount) + T4 (parens-negative through the real scanner) + T5 (the 2-dp integer-cent
// invariant). Adversarial WHOLE-STRING fixtures through the real `extractTransactionRows`, not
// pre-isolated `parseAmount` tokens. Written CHARACTERIZATION-FIRST (pinning today's behaviour, the BUG
// assertions labelled) then flipped to the correct values once the fix landed.
describe('money-parser correctness (full-audit-2026-06-29-postmerge Phase 1)', () => {
  // ---- F1: on a BALANCE-COLUMN statement an uncaptured amount must not let the balance be read as the
  //      amount; the keep/drop is statement-context-aware so a no-balance numeric-payee listing survives.
  // The amount is a bare whole-euro integer (`50`) or a single-decimal figure (`12,5`) MONEY_RE rejects, so the
  // row collapses to ONE money match — the BALANCE. BEFORE (F1 bug): amount = matches[0] = the running balance
  // (the cardinal "confidently-wrong money" harm, off by the whole balance magnitude). NOW: the statement HAS a
  // balance column (the Grocery row prints one), so the ambiguous row — one money token with a bare number
  // abutting it on the left — is DROPPED rather than promote the balance (§22-D1).
  it.each<[string, string, number]>([
    ['F1: on a balance-column statement, a whole-euro amount + 2-dp balance row is DROPPED', '2026-01-02 Sparen 50 1.234,56', 1234.56],
    ['F1: on a balance-column statement, a single-decimal amount row is DROPPED', '2026-01-03 Zinsen 12,5 1.000,00', 1000]
  ])('%s', (_label, ambiguousRow, balanceFigure) => {
    const text = [
      'Kontoauszug EUR',
      '2026-01-01 Grocery -45,90 1.954,10', // a normal 2-figure row → establishes the balance column
      ambiguousRow
    ].join('\n')
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ description: 'Grocery', amount: -45.9, balanceAfter: 1954.1 })
    expect(rows.some((r) => r.amount === balanceFigure)).toBe(false) // the balance never becomes an amount
  })

  // The crucial false-positive guard. No row prints a running balance → the statement has no balance column →
  // a single money token is the AMOUNT, even when the payee ends in a store id (the HVB "Umsätze" shape the
  // geometry feature was built for). Dropping the numeric-payee row here would regress the flagship real case.
  it.each<[string, string, Array<Record<string, unknown>>]>([
    [
      'F1: a NO-balance "Umsätze" listing keeps a numeric-ending payee (the lone token IS the amount)',
      [
        'Kontoumsaetze EUR',
        '2026-01-20 KARTENZAHLUNG REWE SAGT DANKE 1234 -19,15',
        '2026-01-29 SEPA-GUTSCHRIFT Arbeitgeber 34,39'
      ].join('\n'),
      [{ description: 'KARTENZAHLUNG REWE SAGT DANKE 1234', amount: -19.15 }, { amount: 34.39 }]
    ],
    [
      'F1: a genuine single-figure no-balance row (description has no trailing number) still parses',
      'Kontoauszug EUR\n2026-01-02 Mystery shop -45,90',
      [{ description: 'Mystery shop', amount: -45.9 }]
    ]
  ])('%s', (_label, text, expected) => {
    const rows = extractTransactionRows([chunk(text, 1)], 'EUR')
    expect(rows).toHaveLength(expected.length)
    expect(rows).toMatchObject(expected)
    expect(rows.every((r) => r.balanceAfter === undefined)).toBe(true)
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
  // ---- FIN-1: the document currency is a figure-adjacent MAJORITY vote (the `detectDocumentCurrency` cells
  //      live in money.test.ts); the tests below drive the tool end to end ----
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
  it.each<[string, string, string, Record<string, unknown>]>([
    [
      'a U+2212 minus signs the amount negative (a debit is no longer read as a credit)',
      `2026-01-02 Grocery Store ${MINUS}45,90 1.954,10`,
      'EUR',
      { amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 }
    ],
    [
      'an EN-DASH trailing minus (de-AT glued debit sign) signs the amount negative',
      `2026-01-02 Lastschrift 45,90${ENDASH} 1.954,10`,
      'EUR',
      { amount: -45.9 }
    ],
    [
      'a NON-BREAKING-HYPHEN trailing minus is normalized the same way',
      `2026-01-02 Lastschrift 45,90${NBHYPHEN} 1.954,10`,
      'EUR',
      { amount: -45.9 }
    ],
    [
      'an NBSP-grouped amount reads its FULL magnitude (1 234,56 → 1234.56, not 234.56)',
      `2026-01-02 Big Payment ${MINUS}1${NBSP}234,56 5${NBSP}678,90`,
      'EUR',
      { amount: -1234.56, balanceAfter: 5678.9 }
    ],
    [
      'a NARROW NBSP (U+202F) grouping is normalized identically',
      `2026-01-02 Rent ${MINUS}1${NNBSP}000,00 4${NNBSP}454,10`,
      'EUR',
      { amount: -1000, balanceAfter: 4454.1 }
    ],
    [
      'a Swiss U+2019 apostrophe group reads 1’234.56 → 1234.56 (not truncated)',
      `2026-01-02 Zahlung ${MINUS}1${RSQUO}234.56 5${RSQUO}678.90`,
      'CHF',
      { amount: -1234.56, balanceAfter: 5678.9, currency: 'CHF' }
    ],
    // The only extractor-level U+2007 input in this suite (balance side).
    [
      'a FIGURE-SPACE (U+2007) balance group is normalized too',
      `2026-01-02 X ${MINUS}1${NBSP}234,56 8${FIGSP}765,44`,
      'EUR',
      { amount: -1234.56, balanceAfter: 8765.44 }
    ]
  ])('%s', (_label, line, currency, expected) => {
    const rows = extractTransactionRows([chunk(line, 1)], currency)
    expect(rows[0]).toMatchObject(expected)
  })
})
