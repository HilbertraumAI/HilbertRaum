import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { extractStatementBalances, extractTransactionRows } from '../../src/main/services/skills/tools/bank-statement'
import {
  BANK_STATEMENT_INSTALL_ID,
  bankStatementAnalysisHandler
} from '../../src/main/services/skills/analysis/bank-statement'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { makeColumnarPdf, type PdfCell } from '../helpers/fixtures'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AuditEventType, DocumentChunkRead, RetrievalScope } from '../../src/shared/types'

// PDF geometry-extraction plan §3.1/§6, Stage 1 — the WHOLE deterministic path end-to-end on a real
// synthetic PDF: a COLUMNAR German statement (the HVB failure shape) whose per-row dates are BARE
// (DD.MM.) with the year only in the page header, a value-date column, and printed opening/closing
// balances. We drive `PdfParser.parse({ layout })` (the same reader the bank analysis seam reaches via
// `readDocumentSegments`), prove geometry mode recovers the rows the text mode loses, and prove the
// D56 completeness gate presents a total only when the balances tie out — all with ZERO model calls
// (the handler is deterministic; no runtime is constructed). The fixture is SYNTHETIC, never a real
// statement (D57 / privacy).

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

const COL = { date: 50, valueDate: 100, desc: 160, amount: 420, balance: 500 }

/** Build the columnar statement's positioned cells; `closing` lets a test break the balance tie. */
function statementCells(closing: string): PdfCell[] {
  const cells: PdfCell[] = []
  // Header — the YEAR lives ONLY here (the per-row dates below are bare DD.MM., the root-cause bug).
  cells.push({ text: 'Kontoauszug 2024 - alle Betraege in EUR', x: 50, y: 750 })
  // Column header row (no date → preserved raw, dropped by the extractor).
  cells.push(
    { text: 'Datum', x: COL.date, y: 720 },
    { text: 'Wert', x: COL.valueDate, y: 720 },
    { text: 'Buchungstext', x: COL.desc, y: 720 },
    { text: 'Betrag', x: COL.amount, y: 720 },
    { text: 'Saldo', x: COL.balance, y: 720 }
  )
  // Printed opening balance (Anfangssaldo) — needed by the completeness gate.
  cells.push({ text: 'Anfangssaldo', x: COL.date, y: 700 }, { text: '1.000,00', x: COL.amount, y: 700 })
  // Three transactions: booking date · value date · description · amount · running balance.
  const rows = [
    { d: '05.01.', desc: 'Gehalt ACME', amt: '2.000,00', bal: '3.000,00' },
    { d: '06.01.', desc: 'Miete', amt: '-800,00', bal: '2.200,00' },
    { d: '07.01.', desc: 'SEPA Müller', amt: '-200,00', bal: '2.000,00' } // umlaut round-trips via WinAnsi
  ]
  let y = 680
  for (const r of rows) {
    cells.push(
      { text: r.d, x: COL.date, y },
      { text: r.d, x: COL.valueDate, y }, // value-date column — MUST be dropped, not read as the amount
      { text: r.desc, x: COL.desc, y },
      { text: r.amt, x: COL.amount, y },
      { text: r.bal, x: COL.balance, y }
    )
    y -= 20
  }
  // Printed closing balance (Endsaldo). Opening 1000 + Σ(2000−800−200=1000) == 2000 when it ties out.
  cells.push({ text: 'Endsaldo', x: COL.date, y }, { text: closing, x: COL.amount, y })
  return cells
}

function writePdf(cells: PdfCell[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-pdflayout-'))
  const path = join(dir, 'statement.pdf')
  writeFileSync(path, makeColumnarPdf(cells))
  return path
}

async function parseSegments(pdfPath: string, layout: boolean): Promise<DocumentChunkRead[]> {
  const parsed = await PdfParser.parse(pdfPath, { layout, maxPages: 5000 })
  return parsed.segments.map((s, index) => ({ text: s.text, page: s.pageNumber ?? null, index }))
}

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-pdflayout-db-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Seed the document + one chunk per segment line (citations/coverage read the chunks table). */
function seedDoc(db: Db, segments: DocumentChunkRead[]): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'statement.pdf', 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, now, now, now)
  let idx = 0
  for (const seg of segments) {
    for (const line of seg.text.split('\n')) {
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
         VALUES (?, ?, ?, ?, 'statement.pdf', 1, ?)`
      ).run(randomUUID(), docId, idx++, line, now)
    }
  }
  return docId
}

function ctxFor(
  db: Db,
  docId: string,
  question: string,
  pdfPath: string
): SkillAnalysisContext & { events: Array<{ type: AuditEventType; meta?: Record<string, unknown> }> } {
  const events: Array<{ type: AuditEventType; meta?: Record<string, unknown> }> = []
  const scope: RetrievalScope = { documentIds: [docId] }
  return {
    db,
    scope,
    question,
    skillInstallId: BANK_STATEMENT_INSTALL_ID,
    conversationId: null,
    audit: (type, meta) => events.push({ type, meta }),
    tr,
    // The bank handler sets `layout: true`, which arrives here as opts.layout (proves the wiring).
    readDocumentSegments: (_id, opts) => parseSegments(pdfPath, opts?.layout === true),
    events
  }
}

describe('PDF layout mode — geometry reconstruction recovers the columnar statement', () => {
  it('layout mode rebuilds the rows that text mode loses (the root-cause contrast)', async () => {
    const pdfPath = writePdf(statementCells('2.000,00'))

    // TEXT mode (today's default): bare DD.MM. dates, year only in the header → parseDate rejects
    // every row → ZERO transactions. This is exactly the user-reported HVB failure.
    const textRows = extractTransactionRows(await parseSegments(pdfPath, false), 'EUR')
    expect(textRows).toHaveLength(0)

    // LAYOUT mode: the header year is resolved into each row's full date → the rows are recovered.
    const layoutSegments = await parseSegments(pdfPath, true)
    const layoutRows = extractTransactionRows(layoutSegments, 'EUR')
    expect(layoutRows).toHaveLength(3)
    expect(layoutRows[0]).toMatchObject({ date: '2024-01-05', amount: 2000, balanceAfter: 3000 })
    expect(layoutRows[1]).toMatchObject({ date: '2024-01-06', amount: -800 })
    // The value-date column was dropped — the amount is the real figure, not the bare date.
    expect(layoutRows[2]).toMatchObject({ date: '2024-01-07', amount: -200 })
    // German umlaut survived the WinAnsi round-trip into the description.
    expect(layoutRows[2].description).toContain('Müller')
  })

  it('full analysis: non-empty rows, the correct total, honest coverage, citations, 0 model calls', async () => {
    const pdfPath = writePdf(statementCells('2.000,00')) // opening 1000 + Σ 1000 == closing 2000 (ties)
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const ctx = ctxFor(db, docId, 'summarize the cashflow', pdfPath)

    const res = await bankStatementAnalysisHandler.run!(ctx)

    // 3 transactions, a presented total (the gate proved completeness), correct figures.
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain('Net change')
    expect(res.answer).toContain('2000.00') // money in (Gehalt)
    expect(res.answer).toContain('1000.00') // money out (800 + 200) AND net (2000 − 1000)
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))

    // Honest coverage + real citations.
    expect(res.coverage!.mode).toBe('extract')
    expect(res.citations.length).toBeGreaterThan(0)

    // ZERO model calls: only the deterministic read-only tools ran (no runtime exists in this test).
    const toolNames = ctx.events.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_transactions')
    expect(toolNames).toContain('summarize_cashflow')
    expect(toolNames).not.toContain('export_transactions_csv')
  })

  it('partial/mis-read fixture: a non-tying closing balance MUST downgrade (no total — D56)', async () => {
    // Same rows, but the printed Endsaldo is wrong (9.999,99) → completeness cannot be proven.
    const pdfPath = writePdf(statementCells('9.999,99'))
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, docId, 'what is the total?', pdfPath))

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('Net change')
  })
})

// ---------------------------------------------------------------------------------------------------
// Raiffeisen "Mein ELBA" regression (Phase 31 column model). The gold-set measurement surfaced that
// Stage 1 OVER-extracted this layout: the Valuta (value-date) column sits on a SEPARATE baseline that
// aligns with a row's SECOND description line, and that continuation line hides a foreign-currency
// reference amount (e.g. `39,00 USD`). Before the column model, `clusterRows` emitted that second line
// as its own visual row, `reconstructLine` saw a date (the Valuta) + a money token (the FX amount) and
// emitted a SPURIOUS transaction — and the opening/closing balances, printed as `Kontostand per <date>`
// lines, were both mis-parsed as transactions too. So 26 real rows became 43 and the gate could not
// present a total. The fix: only a date in the booking-DATE column qualifies a row, and a `Kontostand
// per` line is read by the balance gate. This pins the layout so it can't silently regress. SYNTHETIC
// (`makeColumnarPdf`), never a real statement (D57).
describe('PDF layout mode — Raiffeisen Valuta/second-baseline + Kontostand-per regression (column model)', () => {
  // Columns: Datum | Valuta | Buchungstext | Betrag | Saldo. The opening/closing `Kontostand per <date>`
  // lines are rendered as pseudo-rows with the date IN the Datum column (the real Raiffeisen geometry),
  // so only the balance-label guard — not column position — can keep them out of the transactions.
  const RCOL = { date: 50, valuta: 110, desc: 170, amount: 440, balance: 510 }

  /** Build the Raiffeisen-shaped cells; `closing` lets a test break the balance tie. */
  function raiffeisenCells(closing: string): PdfCell[] {
    const cells: PdfCell[] = []
    // Header — currency only; the YEAR is resolved from the first full date (the opening line below).
    cells.push({ text: 'Mein ELBA Kontoauszug EUR', x: 50, y: 760 })
    // Column-header row (no date → preserved raw, dropped by the extractor).
    cells.push(
      { text: 'Datum', x: RCOL.date, y: 740 },
      { text: 'Valuta', x: RCOL.valuta, y: 740 },
      { text: 'Buchungstext', x: RCOL.desc, y: 740 },
      { text: 'Betrag', x: RCOL.amount, y: 740 },
      { text: 'Saldo', x: RCOL.balance, y: 740 }
    )
    // Opening balance pseudo-row: a full DATE in the Datum column + the `Kontostand per` label + amount.
    // The date is in the booking column, so the column model alone CANNOT reject it — the label guard must.
    cells.push(
      { text: '31.03.2025', x: RCOL.date, y: 720 },
      { text: 'Kontostand per', x: RCOL.desc, y: 720 },
      { text: '35.037,04', x: RCOL.amount, y: 720 }
    )
    // Three real transactions. Opening 35.037,04 + Σ(1.000 − 5.000 − 389,97 = −4.389,97) == 30.647,07.
    const rows = [
      { d: '05.04.', desc: 'Gehalt ACME', amt: '1.000,00', bal: '36.037,04', v: '07.04.', cont: 'Zahlungsreferenz ePAYMENT 39,00 USD' },
      { d: '12.04.', desc: 'Miete', amt: '-5.000,00', bal: '31.037,04', v: '14.04.', cont: 'Auftraggeber Hausverwaltung 12,50 CHF' },
      { d: '20.04.', desc: 'SEPA Müller', amt: '-389,97', bal: '30.647,07', v: '22.04.', cont: 'Verwendungszweck Foo 56,27 PT' }
    ]
    let y = 700
    for (const r of rows) {
      // Booking baseline: booking date (Datum column) · description · amount · running balance.
      cells.push(
        { text: r.d, x: RCOL.date, y },
        { text: r.desc, x: RCOL.desc, y },
        { text: r.amt, x: RCOL.amount, y },
        { text: r.bal, x: RCOL.balance, y }
      )
      // SECOND baseline (12 pt lower → a separate visual row): Valuta date + an FX-laden continuation.
      // The ONLY date here is the Valuta column; the ONLY money is the foreign-currency reference.
      cells.push(
        { text: r.v, x: RCOL.valuta, y: y - 12 },
        { text: r.cont, x: RCOL.desc, y: y - 12 }
      )
      y -= 30
    }
    // Closing balance pseudo-row (Kontostand per <period-end>) — same in-column-date shape as the opening.
    cells.push(
      { text: '23.06.2025', x: RCOL.date, y },
      { text: 'Kontostand per', x: RCOL.desc, y },
      { text: closing, x: RCOL.amount, y }
    )
    return cells
  }

  it('extracts ONLY the real booking rows — no spurious Valuta/FX or Kontostand-per rows', async () => {
    const layoutRows = extractTransactionRows(await parseSegments(writePdf(raiffeisenCells('30.647,07')), true), 'EUR')

    // Exactly the three real transactions — the ~spurious second-baseline rows are gone.
    expect(layoutRows).toHaveLength(3)
    expect(layoutRows.map((r) => r.amount)).toEqual([1000, -5000, -389.97])
    expect(layoutRows.map((r) => r.date)).toEqual(['2025-04-05', '2025-04-12', '2025-04-20'])
    // The foreign-currency reference amounts hidden in the continuation lines were NOT extracted.
    for (const fx of [39, 12.5, 56.27, -39, -12.5, -56.27]) {
      expect(layoutRows.map((r) => r.amount)).not.toContain(fx)
    }
    // The balances were read from the `Kontostand per` lines, not turned into transactions.
    const balances = extractStatementBalances(
      (await parseSegments(writePdf(raiffeisenCells('30.647,07')), true)).map((s) => ({
        text: s.text,
        page: s.page,
        index: 0
      }))
    )
    expect(balances.openingBalance).toBeCloseTo(35037.04, 2)
    expect(balances.closingBalance).toBeCloseTo(30647.07, 2)
  })

  it('full analysis: the gate PASSES and presents the correct total (figures tie out)', async () => {
    const pdfPath = writePdf(raiffeisenCells('30.647,07'))
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const ctx = ctxFor(db, docId, 'summarize the cashflow and the total', pdfPath)

    const res = await bankStatementAnalysisHandler.run!(ctx)

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain('Net change')
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    // totalIn 1000.00, totalOut 5389.97, net −4389.97 — all from the three real rows.
    expect(res.answer).toContain('1000.00')
    expect(res.answer).toContain('5389.97')
    expect(res.answer).toContain('-4389.97')

    // The persisted opening/closing (what the gate tied against) match the printed Kontostand-per figures.
    const stmt = db
      .prepare(
        `SELECT opening_balance AS opening, closing_balance AS closing
         FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(docId) as { opening: number | null; closing: number | null }
    expect(stmt.opening).toBeCloseTo(35037.04, 2)
    expect(stmt.closing).toBeCloseTo(30647.07, 2)

    // Still zero model calls — the deterministic read-only tools only.
    const toolNames = ctx.events.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_transactions')
    expect(toolNames).not.toContain('export_transactions_csv')
  })

  it('a non-tying Kontostand-per closing still downgrades (no total — D56 holds with the new label)', async () => {
    const pdfPath = writePdf(raiffeisenCells('9.999,99'))
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, docId, 'what is the total?', pdfPath))

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('Net change')
  })
})

// ---------------------------------------------------------------------------------------------------
// Synthetic BREADTH coverage (Phase 31, Task 1; D57 — synthetic only, never a real statement). The two
// real gold-set statements are both German; these fixtures exercise layouts the code now claims to
// handle but those two don't: ENGLISH opening/closing labels on the gate-PASS path, an ENGLISH
// value-date column on a second baseline (the column-model rejection in English), the honest gate
// DOWNGRADE for a running-balance-only statement with NO printed opening/closing (in English), and a
// multi-line wrapped description row (the booking row must still extract cleanly). All `makeColumnarPdf`.
describe('PDF layout mode — synthetic breadth (English labels, EN value-date, EN downgrade, wrapped desc)', () => {
  // (a) English opening/closing labels that tie out → the gate PRESENTS the total, in English.
  it('English Balance brought/carried forward that ties out → gate presents the total (EN)', async () => {
    // English amounts use comma-thousands/dot-decimal (1,000.00) — parseAmount reads both locales.
    const EC = { date: 50, desc: 160, amount: 420, balance: 500 }
    const cells: PdfCell[] = []
    // Header carries the year (bare per-row dates below) + the currency.
    cells.push({ text: 'Account Statement 2023 - all amounts in USD', x: 50, y: 750 })
    cells.push(
      { text: 'Date', x: EC.date, y: 720 },
      { text: 'Description', x: EC.desc, y: 720 },
      { text: 'Amount', x: EC.amount, y: 720 },
      { text: 'Balance', x: EC.balance, y: 720 }
    )
    // Opening label (no date → raw line, read only by the balance gate).
    cells.push({ text: 'Balance brought forward', x: EC.desc, y: 700 }, { text: '1,000.00', x: EC.amount, y: 700 })
    const rows = [
      { d: '01.05.', desc: 'Payroll', amt: '2,000.00', bal: '3,000.00' },
      { d: '02.05.', desc: 'Rent', amt: '-800.00', bal: '2,200.00' },
      { d: '03.05.', desc: 'Card payment', amt: '-200.00', bal: '2,000.00' }
    ]
    let y = 680
    for (const r of rows) {
      cells.push(
        { text: r.d, x: EC.date, y },
        { text: r.desc, x: EC.desc, y },
        { text: r.amt, x: EC.amount, y },
        { text: r.bal, x: EC.balance, y }
      )
      y -= 20
    }
    // Closing label ties out: opening 1000 + Σ(2000−800−200=1000) == 2000.
    cells.push({ text: 'Balance carried forward', x: EC.desc, y }, { text: '2,000.00', x: EC.amount, y })

    const pdfPath = writePdf(cells)
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, docId, 'what is the total?', pdfPath))

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain('Net change') // the English totals line is presented
    expect(res.answer).toContain('2000.00') // money in (Payroll)
    expect(res.answer).toContain('1000.00') // money out (800 + 200) AND net (2000 − 1000)
    expect(res.answer).toContain('USD')
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
  })

  // (b) An English value-date column on a SECOND baseline → detectDatumColumn rejects it: no spurious row.
  it('English value-date on a second baseline → column model rejects it (no spurious FX row)', async () => {
    const BC = { date: 50, value: 110, desc: 170, amount: 440, balance: 510 }
    const cells: PdfCell[] = []
    cells.push({ text: 'Monthly Statement 2024 - amounts in USD', x: 50, y: 760 })
    cells.push(
      { text: 'Date', x: BC.date, y: 740 },
      { text: 'Value', x: BC.value, y: 740 },
      { text: 'Description', x: BC.desc, y: 740 },
      { text: 'Amount', x: BC.amount, y: 740 },
      { text: 'Balance', x: BC.balance, y: 740 }
    )
    const rows = [
      { d: '05.04.', desc: 'Salary', amt: '1,000.00', bal: '6,000.00', v: '07.04.', cont: 'Reference ePayment 39.00 GBP' },
      { d: '12.04.', desc: 'Rent', amt: '-500.00', bal: '5,500.00', v: '14.04.', cont: 'Landlord ref 12.50 CHF' },
      { d: '20.04.', desc: 'Groceries', amt: '-60.00', bal: '5,440.00', v: '22.04.', cont: 'Card auth 7.25 SEK' }
    ]
    let y = 720
    for (const r of rows) {
      // Booking baseline: booking date (Datum column, x=50) · description · amount · balance.
      cells.push(
        { text: r.d, x: BC.date, y },
        { text: r.desc, x: BC.desc, y },
        { text: r.amt, x: BC.amount, y },
        { text: r.bal, x: BC.balance, y }
      )
      // Second baseline (12pt lower): ONLY the value-date (x=110, out of column) + an FX reference amount.
      cells.push({ text: r.v, x: BC.value, y: y - 12 }, { text: r.cont, x: BC.desc, y: y - 12 })
      y -= 30
    }

    const layoutRows = extractTransactionRows(await parseSegments(writePdf(cells), true), 'USD')
    // Exactly the three booking rows — density (3 dates at x=50) makes x=50 the booking column, so the
    // value-date column at x=110 cannot qualify the second-baseline rows.
    expect(layoutRows).toHaveLength(3)
    expect(layoutRows.map((r) => r.amount)).toEqual([1000, -500, -60])
    expect(layoutRows.map((r) => r.date)).toEqual(['2024-04-05', '2024-04-12', '2024-04-20'])
    // The foreign-currency reference amounts hidden in the continuation lines were NOT extracted.
    for (const fx of [39, 12.5, 7.25, -39, -12.5, -7.25]) {
      expect(layoutRows.map((r) => r.amount)).not.toContain(fx)
    }
  })

  // (c) A running-balance-only statement with NO printed opening/closing → the honest gate DOWNGRADE (EN).
  it('English running-balance-only (no opening/closing) → honest downgrade, no total', async () => {
    const RC = { date: 50, desc: 160, amount: 420, balance: 500 }
    const cells: PdfCell[] = []
    cells.push({ text: 'Statement 2022 in GBP', x: 50, y: 750 })
    cells.push(
      { text: 'Date', x: RC.date, y: 720 },
      { text: 'Description', x: RC.desc, y: 720 },
      { text: 'Amount', x: RC.amount, y: 720 },
      { text: 'Balance', x: RC.balance, y: 720 }
    )
    // Three real rows WITH running balances but NO Balance brought/carried forward lines anywhere.
    const rows = [
      { d: '01.06.', desc: 'Refund', amt: '150.00', bal: '1,150.00' },
      { d: '02.06.', desc: 'Subscription', amt: '-9.99', bal: '1,140.01' },
      { d: '03.06.', desc: 'Coffee shop', amt: '-4.50', bal: '1,135.51' }
    ]
    let y = 700
    for (const r of rows) {
      cells.push(
        { text: r.d, x: RC.date, y },
        { text: r.desc, x: RC.desc, y },
        { text: r.amt, x: RC.amount, y },
        { text: r.bal, x: RC.balance, y }
      )
      y -= 20
    }

    const pdfPath = writePdf(cells)
    const segments = await parseSegments(pdfPath, true)
    const db = freshDb()
    const docId = seedDoc(db, segments)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, docId, 'what is the total spending?', pdfPath))

    // The rows are read, but with no opening/closing balance to tie against, completeness is unprovable.
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 3 }))
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('Net change')
  })

  // (d) A multi-line wrapped description row → the booking row still extracts cleanly (the wrap is a
  //     separate text-only visual row with no booking-column date/amount, so it is dropped, not a row).
  it('multi-line wrapped description → the booking row still extracts cleanly', async () => {
    const WC = { date: 50, desc: 160, amount: 420, balance: 500 }
    const cells: PdfCell[] = []
    cells.push({ text: 'Statement 2024 in EUR', x: 50, y: 750 })
    cells.push(
      { text: 'Date', x: WC.date, y: 720 },
      { text: 'Description', x: WC.desc, y: 720 },
      { text: 'Amount', x: WC.amount, y: 720 },
      { text: 'Balance', x: WC.balance, y: 720 }
    )
    const rows = [
      { d: '10.06.', desc: 'Direct Debit Insurance', amt: '-45.00', bal: '955.00', cont: 'Policy 12345 monthly premium' },
      { d: '15.06.', desc: 'Transfer received', amt: '300.00', bal: '1,255.00', cont: 'Sender Mustermann GmbH order 778899' }
    ]
    let y = 700
    for (const r of rows) {
      cells.push(
        { text: r.d, x: WC.date, y },
        { text: r.desc, x: WC.desc, y },
        { text: r.amt, x: WC.amount, y },
        { text: r.bal, x: WC.balance, y }
      )
      // The wrapped second description line (10pt lower → its own visual row): TEXT only, no date, no
      // money token (the integers 12345/778899 lack a decimal tail, so MONEY_RE never matches them).
      cells.push({ text: r.cont, x: WC.desc, y: y - 10 })
      y -= 26
    }

    const layoutRows = extractTransactionRows(await parseSegments(writePdf(cells), true), 'EUR')
    // Exactly the two booking rows — the wrapped continuation lines produced no spurious rows.
    expect(layoutRows).toHaveLength(2)
    expect(layoutRows[0]).toMatchObject({ date: '2024-06-10', amount: -45, balanceAfter: 955 })
    expect(layoutRows[1]).toMatchObject({ date: '2024-06-15', amount: 300 })
    expect(layoutRows[0].description).toContain('Direct Debit Insurance')
  })
})
