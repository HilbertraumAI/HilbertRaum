import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  extractDocumentPreview,
  processDocument,
  reindexDocument
} from '../../src/main/services/ingestion'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import {
  INVOICE_INSTALL_ID,
  invoiceAnalysisHandler
} from '../../src/main/services/skills/analysis/invoice'
import {
  BANK_STATEMENT_INSTALL_ID,
  bankStatementAnalysisHandler
} from '../../src/main/services/skills/analysis/bank-statement'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import type { DocumentChunkRead, RetrievalScope } from '../../src/shared/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'

// invoice-audit IA-1 (P-1): a re-indexed / OCR-re-ingested document re-extracts on the next analysis
// question — the re-index teardown now purges the persisted bank/invoice skill rows in the same
// transaction, so the version-only staleness gate can no longer keep serving figures read from text
// that no longer exists (and a glyph-soup `suspect-confirmed` refusal can no longer survive the very
// OCR the app told the user to run). These tests drive the REAL ingestion pipeline (processDocument /
// reindexDocument) so the actual teardown runs, then the REAL analysis handlers over faithful segments.

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

// A clean invoice: net 120 / tax 24 / gross 144 (all three checks reconcile).
const INV_V1 = [
  'Invoice number INV-001',
  'Vendor Acme GmbH',
  'Invoice date 2026-01-15',
  'Widget 2 50,00 100,00',
  'Gadget 1 20,00 20,00',
  'Net total 120,00 EUR',
  'VAT 20% 24,00 EUR',
  'Gross total 144,00 EUR'
].join('\n')

// A DIFFERENT clean invoice (the "OCR / re-ingest changed the text" content): net 200 / tax 40 / gross 240.
const INV_V2 = [
  'Invoice number INV-002',
  'Vendor Beta AG',
  'Invoice date 2026-02-15',
  'Widget 4 50,00 200,00',
  'Net total 200,00 EUR',
  'VAT 20% 40,00 EUR',
  'Gross total 240,00 EUR'
].join('\n')

// Glyph soup: per-glyph spacing fragments the text layer; the scraped figures cannot corroborate.
const SOUP = [
  'I n v o i c e',
  '1   0 % 3   Article — Stablecoin Yield Farming 167,70',
  '$ 9 1 4 = $ 915,92',
  '( 1 U S D T = $ 0,99',
  'Netto 4 $',
  'Total 914 $'
].join('\n')

// Bank statements with printed opening/closing balances so the completeness gate presents a total.
const BANK_V1 =
  'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
  '2026-01-03 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'
const BANK_V2 =
  'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
  '2026-01-03 Salary 3.000,00 4.954,10\nClosing balance 4.954,10'

const DEPS = { embedder: createMockEmbedder() }

interface Ingested {
  db: Db
  storeDir: string
  docId: string
  /** Overwrite the workspace stored copy (what re-index re-parses) to simulate OCR / a changed text layer. */
  rewrite: (text: string) => void
  /** The production segment-reader adapter (mirrors `buildDocumentSegmentReader`). */
  readDocumentSegments: (id: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
}

async function ingest(text: string, title: string): Promise<Ingested> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-ia1-'))
  const db = openDatabase(join(root, 'test.sqlite'))
  const storeDir = documentsDir(join(root, 'workspace'))
  const docPath = join(root, title)
  writeFileSync(docPath, text, 'utf8')
  const doc = createQueuedDocument(db, docPath)
  await processDocument(db, storeDir, doc.id, DEPS)
  const readDocumentSegments = async (id: string, opts?: { layout?: boolean }): Promise<DocumentChunkRead[]> => {
    const preview = await extractDocumentPreview(db, storeDir, id, {}, opts?.layout ? { layout: true } : {})
    return preview.segments.map((s, index) => ({ text: s.text, page: s.pageNumber, index }))
  }
  const rewrite = (next: string): void => {
    const storedPath = (
      db.prepare('SELECT stored_path AS p FROM documents WHERE id = ?').get(doc.id) as { p: string }
    ).p
    writeFileSync(storedPath, next, 'utf8')
  }
  return { db, storeDir, docId: doc.id, rewrite, readDocumentSegments }
}

function invoiceCtx(h: Ingested, question: string): SkillAnalysisContext {
  return {
    db: h.db,
    scope: { collectionIds: [], documentIds: [h.docId] } as RetrievalScope,
    question,
    skillInstallId: INVOICE_INSTALL_ID,
    conversationId: null,
    audit: () => {},
    tr,
    readDocumentSegments: h.readDocumentSegments
  }
}

function bankCtx(h: Ingested, question: string): SkillAnalysisContext {
  return {
    db: h.db,
    scope: { collectionIds: [], documentIds: [h.docId] } as RetrievalScope,
    question,
    skillInstallId: BANK_STATEMENT_INSTALL_ID,
    conversationId: null,
    audit: () => {},
    tr,
    readDocumentSegments: h.readDocumentSegments
  }
}

describe('invoice-audit IA-1 (P-1) — re-index purges skill rows so a content change re-extracts', () => {
  // The exact worst journey from the audit: soup → refusal telling the user to OCR → OCR (re-index with
  // clean text) → a REAL answer. Before the fix the version-only staleness gate kept the
  // `suspect-confirmed` soup row forever, so the same refusal returned no matter how often OCR was run.
  it('soup invoice → refusal → re-index with clean text → a real totals answer (not the refusal)', async () => {
    const h = await ingest(SOUP, 'invoice.txt')

    const before = await invoiceAnalysisHandler.run!(invoiceCtx(h, 'fasse die rechnung zusammen'))
    expect(before.answer).toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    // The retry completed and was still soup → the flag is legitimately confirmed at this point.
    const flag = h.db.prepare('SELECT text_quality AS q FROM invoices').get() as { q: string | null }
    expect(flag.q).toBe('suspect-confirmed')

    // The user runs OCR → the document's text is now clean, and re-index re-parses it.
    h.rewrite(INV_V1)
    await reindexDocument(h.db, h.storeDir, h.docId, DEPS)
    // The purge removed the stale soup extraction — nothing left to reuse.
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number }).n).toBe(0)

    const after = await invoiceAnalysisHandler.run!(invoiceCtx(h, 'fasse die rechnung zusammen'))
    expect(after.answer).not.toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    expect(after.answer).toContain('120.00')
    expect(after.answer).toContain('144.00')
  })

  // The quieter, worse variant: a document whose text layer silently CHANGED keeps answering with figures
  // from the OLD content until the row is purged. Re-index must make the next question re-extract.
  it('invoice: a silent content change re-extracts on the next question (new figures, not the old)', async () => {
    const h = await ingest(INV_V1, 'invoice.txt')

    const before = await invoiceAnalysisHandler.run!(invoiceCtx(h, 'give me a summary of this invoice'))
    expect(before.answer).toContain('144.00') // v1 gross

    h.rewrite(INV_V2)
    await reindexDocument(h.db, h.storeDir, h.docId, DEPS)

    const after = await invoiceAnalysisHandler.run!(invoiceCtx(h, 'give me a summary of this invoice'))
    expect(after.answer).toContain('240.00') // v2 gross — re-extracted
    expect(after.answer).not.toContain('144.00') // the stale v1 figure is gone
    const row = h.db.prepare('SELECT gross_total AS g FROM invoices').get() as { g: number }
    expect(row.g).toBe(240)
  })

  // The bank twin shares the identical version-only staleness gap; `purgeSkillDataForDocument` covers both.
  it('bank statement: a silent content change re-extracts on the next question (new figures)', async () => {
    const h = await ingest(BANK_V1, 'statement.txt')

    const before = await bankStatementAnalysisHandler.run!(bankCtx(h, 'summarize the cashflow'))
    expect(before.answer).toContain('2500.00') // v1 money-in
    expect(before.answer).toContain('2454.10') // v1 net change

    h.rewrite(BANK_V2)
    await reindexDocument(h.db, h.storeDir, h.docId, DEPS)

    const after = await bankStatementAnalysisHandler.run!(bankCtx(h, 'summarize the cashflow'))
    expect(after.answer).toContain('3000.00') // v2 money-in — re-extracted
    expect(after.answer).toContain('2954.10') // v2 net change
    expect(after.answer).not.toContain('2500.00') // the stale v1 figure is gone
  })

  // Directly pin that the teardown purges BOTH twins in the same re-index transaction. On a fresh schema
  // the documents→CASCADE fires only on a document DELETE (not a re-index), so this is our explicit purge.
  it('re-index purges BOTH invoices AND bank_statements rows bound to the document', async () => {
    const h = await ingest(INV_V1, 'invoice.txt')
    const now = new Date().toISOString()
    h.db
      .prepare('INSERT INTO invoices (id, document_id, created_at) VALUES (?, ?, ?)')
      .run(randomUUID(), h.docId, now)
    h.db
      .prepare('INSERT INTO bank_statements (id, document_id, created_at) VALUES (?, ?, ?)')
      .run(randomUUID(), h.docId, now)

    await reindexDocument(h.db, h.storeDir, h.docId, DEPS)

    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?').get(h.docId) as { n: number }).n
    ).toBe(0)
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(h.docId) as {
        n: number
      }).n
    ).toBe(0)
  })
})
