import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { PdfParser } from '../../src/main/services/ingestion/parsers/pdf'
import { extractTransactionRows } from '../../src/main/services/skills/tools/bank-statement'
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
