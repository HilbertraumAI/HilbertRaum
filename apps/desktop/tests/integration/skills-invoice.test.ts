import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseSkillMarkdown } from '../../src/shared/skill-manifest'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  reconcileSkills,
  getSkill,
  listSkills,
  skillInstallId
} from '../../src/main/services/skills/registry'
import { recordToInfo } from '../../src/main/services/skills/installer'
import {
  runInvoiceExtraction,
  runInvoiceTotalsValidation,
  runInvoiceCsvExport,
  runInvoiceFileExport,
  latestInvoiceId,
  isInvoiceStale
} from '../../src/main/services/skills/invoice-run'
import { runnableToolsForSkill, buildToolRunner } from '../../src/main/services/skills/tool-runs'
import type { InvoiceInput } from '../../src/main/services/skills/tools/invoice'
import type { AuditEventType, DocumentChunkRead, RunnableTool } from '../../src/shared/types'

// architecture.md "Skills — design record" §8 — the SECOND bundled Tier-2 skill: invoice. It mirrors
// the bank-statement skill layer-for-layer to prove the gate generalizes to a second content-class
// domain, with strong EN+DE coverage. This exercises the committed package end to end (parse →
// discover/reconcile) and the run seams on a real DB (extract → validate → export), the
// needs-extraction guard, and the cancelled-save calm path, plus the dispatch wiring.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const APP_SKILLS_DIR = join(REPO_ROOT, 'app-skills')
const INVOICE_SKILL_MD = readFileSync(join(APP_SKILLS_DIR, 'invoice', 'SKILL.md'), 'utf8')

const INVOICE_TEXT = [
  'Invoice',
  'Vendor: ACME Supplies GmbH',
  'Invoice Number: INV-2026-0042',
  'Invoice Date: 2026-03-15',
  'Due Date: 2026-04-14',
  'Currency EUR',
  '',
  'Widget A               2     12,50        25,00',
  'Consulting hours       3     100,00       300,00',
  '',
  'Net Total              325,00',
  'VAT 20%                65,00',
  'Gross Total            390,00'
].join('\n')

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-invoice-')), 'test.sqlite'))
}

function deps(): { appSkillsDir: string; userSkillsDir: string } {
  return {
    appSkillsDir: APP_SKILLS_DIR,
    userSkillsDir: join(mkdtempSync(join(tmpdir(), 'hilbertraum-invoice-user-')), 'user-skills')
  }
}

function seedDocWithChunks(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Invoice', 'indexed', 'application/pdf', ?, ?)`
  ).run(docId, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

function capturingAudit(): { audit: (t: AuditEventType, m?: Record<string, unknown>) => void; events: unknown[] } {
  const events: unknown[] = []
  return { audit: (type, meta) => events.push({ type, meta }), events }
}

describe('invoice — committed SKILL.md is a Tier-2 tool skill', () => {
  it('parses with kind:tool, the three allowedTools, and reservesTools true', () => {
    const parsed = parseSkillMarkdown(INVOICE_SKILL_MD)
    expect(parsed.errors).toEqual([])
    expect(parsed.ok).toBe(true)
    const m = parsed.manifest!
    expect(m.id).toBe('invoice')
    expect(m.kind).toBe('tool')
    expect(m.allowedTools).toEqual([
      'extract_invoice',
      'validate_invoice_totals',
      'export_invoice_csv',
      'export_invoice_json',
      'export_invoice_xml'
    ])
    expect(m.reservesTools).toBe(true)
    // v1 permission ceiling holds.
    expect(m.permissions.network).toBe('denied')
    expect(m.permissions.documents).toBe('selected_only')
  })

  it('covers English + German triggers, singular and plural', () => {
    const kws = parseSkillMarkdown(INVOICE_SKILL_MD).manifest!.triggers.keywords
    // English.
    expect(kws).toContain('invoice')
    expect(kws).toContain('invoices')
    // German singular + plural (the ending breaks the substring, so both are listed).
    expect(kws).toContain('rechnung')
    expect(kws).toContain('rechnungen')
    expect(kws).toContain('rechnungsnummer')
    expect(kws).toContain('mehrwertsteuer')
    expect(kws).toContain('netto')
    expect(kws).toContain('brutto')
  })
})

describe('invoice — discovery + reconcile (S3)', () => {
  it('discovers and reconciles the committed app skill as enabled, with its tools effective', () => {
    const db = freshDb()
    const d = deps()
    const res = reconcileSkills(db, d)
    expect(res.errors).toEqual([])

    const installId = skillInstallId('app', 'invoice')
    const record = getSkill(db, installId)
    expect(record, 'invoice must be discovered from app-skills/').not.toBeNull()
    expect(record!.enabled).toBe(true)
    expect(record!.source).toBe('app')
    expect(record!.trustedLevel).toBe('app')
    expect(record!.kind).toBe('tool')
    expect(record!.manifest.allowedTools).toEqual([
      'extract_invoice',
      'validate_invoice_totals',
      'export_invoice_csv',
      'export_invoice_json',
      'export_invoice_xml'
    ])
    expect(record!.manifest.reservesTools).toBe(true)
    expect(recordToInfo(record!, false).reservesTools).toBe(true)

    // It is one of the bundled app skills (sanity: discovery isn't picking up junk).
    const appSkills = listSkills(db).filter((s) => s.source === 'app')
    expect(appSkills.map((s) => s.id)).toContain('invoice')
  })
})

describe('invoice — the dispatch surfaces the runnable tools', () => {
  it('runnableToolsForSkill returns the five tools, every export confirm-gated', () => {
    const db = freshDb()
    const d = deps()
    reconcileSkills(db, d)
    const record = getSkill(db, skillInstallId('app', 'invoice'))!
    expect(runnableToolsForSkill(record)).toEqual<RunnableTool[]>([
      { name: 'extract_invoice', requiresConfirmation: false },
      { name: 'validate_invoice_totals', requiresConfirmation: false },
      { name: 'export_invoice_csv', requiresConfirmation: true },
      { name: 'export_invoice_json', requiresConfirmation: true },
      { name: 'export_invoice_xml', requiresConfirmation: true }
    ])
  })

  it('buildToolRunner wires each invoice tool (every export needs the save capability)', () => {
    const db = freshDb()
    const { audit } = capturingAudit()
    const args = { skillInstallId: 'app:invoice', conversationId: '', documentId: 'd1' }
    expect(buildToolRunner(db, 'extract_invoice', args, audit)).not.toBeNull()
    expect(buildToolRunner(db, 'validate_invoice_totals', args, audit)).not.toBeNull()
    for (const name of ['export_invoice_csv', 'export_invoice_json', 'export_invoice_xml']) {
      // export returns null without a saveTextFile capability, non-null with it.
      expect(buildToolRunner(db, name, args, audit)).toBeNull()
      expect(buildToolRunner(db, name, args, audit, { saveTextFile: async () => true })).not.toBeNull()
    }
  })
})

describe('invoice — the run seams (extract → validate → export) on a real DB', () => {
  const skillInstallId = 'app:invoice'

  it('migration creates the invoice content-class tables', () => {
    const db = freshDb()
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    expect(names).toContain('invoices')
    expect(names).toContain('invoice_line_items')
  })

  it('runInvoiceExtraction persists header + line items and marks the run done', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit, events } = capturingAudit()
    const res = await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    expect(res.lineItemCount).toBe(2)

    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(run.status).toBe('done')
    expect(run.result_ref).toBe(res.invoiceId)
    const invoiceId = res.invoiceId!

    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Record<string, unknown>
    expect(inv.document_id).toBe(docId)
    expect(inv.vendor).toBe('ACME Supplies GmbH')
    expect(inv.invoice_number).toBe('INV-2026-0042')
    expect(inv.invoice_date).toBe('2026-03-15')
    expect(inv.currency).toBe('EUR')
    expect(inv.net_total).toBe(325)
    expect(inv.gross_total).toBe(390)

    const items = db
      .prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY row_index')
      .all(invoiceId) as Array<Record<string, unknown>>
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ description: 'Widget A', quantity: 2, unit_price: 12.5, line_total: 25, currency: 'EUR' })

    // The gate audited the run, ids/counts only.
    expect((events as Array<{ type: string }>).map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('a downstream tool fails friendly when no invoice has been extracted yet', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit, events } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('needsExtraction')
    expect(res.error).toMatch(/first/i)
    expect(events).toEqual([]) // no tool ran ⇒ no audit event
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  it('validate persists totals_reconciled + reports the verdict', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    expect((await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })).ok).toBe(true)
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    expect(res.resultKind).toBe('reconciled')
    expect(res.count).toBe(0) // no mismatched checks
    const inv = db.prepare('SELECT totals_reconciled FROM invoices LIMIT 1').get() as { totals_reconciled: number }
    expect(inv.totals_reconciled).toBe(1)
  })

  it('export produces the CSV, the seam writes it (stub), reports the row count', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    let written: { name: string; content: string } | null = null
    const res = await runInvoiceCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      saveTextFile: async (name, content) => {
        written = { name, content }
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    expect(written!.name).toBe('invoice-line-items.csv')
    expect(written!.content).toMatch(/^description,quantity,unitPrice,lineTotal,currency/)
    expect(written!.content).toContain('Widget A')
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(run.status).toBe('done')
    expect(run.result_ref).toBeNull() // export yields no DB artifact; the path is never recorded
  })

  it('JSON export produces parseable JSON through the seam (stub), reports the row count', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    let written: { name: string; content: string } | null = null
    const res = await runInvoiceFileExport(
      db,
      { skillInstallId, documentId: docId },
      {
        audit,
        confirmed: true,
        saveTextFile: async (name, content) => {
          written = { name, content }
          return true
        }
      },
      { toolName: 'export_invoice_json', defaultFileName: 'invoice.json' }
    )
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    expect(written!.name).toBe('invoice.json')
    const parsed = JSON.parse(written!.content) as { lineItems: unknown[]; totals: Record<string, unknown> }
    expect(parsed.lineItems).toHaveLength(2)
    expect(parsed.totals.grossTotal).toBe(390)
  })

  it('XML export produces well-formed XML through the seam (stub)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    let written: { name: string; content: string } | null = null
    const res = await runInvoiceFileExport(
      db,
      { skillInstallId, documentId: docId },
      {
        audit,
        confirmed: true,
        saveTextFile: async (name, content) => {
          written = { name, content }
          return true
        }
      },
      { toolName: 'export_invoice_xml', defaultFileName: 'invoice.xml' }
    )
    expect(res.ok).toBe(true)
    expect(written!.name).toBe('invoice.xml')
    expect(written!.content).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(written!.content).toContain('<grossTotal>390.00</grossTotal>')
    expect(written!.content).toContain('<lineItem>')
  })

  it('JSON export refuses without confirmation (the gate) — nothing is written', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    let saveCalled = false
    const res = await runInvoiceFileExport(
      db,
      { skillInstallId, documentId: docId },
      {
        audit,
        saveTextFile: async () => {
          saveCalled = true
          return true
        }
      },
      { toolName: 'export_invoice_json', defaultFileName: 'invoice.json' }
    )
    expect(res.ok).toBe(false)
    expect(saveCalled).toBe(false)
  })

  it('export refuses without confirmation (the gate) — nothing is written', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    let saveCalled = false
    const res = await runInvoiceCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(saveCalled).toBe(false)
  })

  it('export cancelled at the save dialog persists nothing and reports it calmly (not failed)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, INVOICE_TEXT)
    const { audit } = capturingAudit()
    await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit })
    const res = await runInvoiceCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      saveTextFile: async () => false, // user dismissed the dialog
      confirmed: true
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(res.error).toMatch(/cancel/i)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })
})

// R3 (audit §5.6): the invoice run-bar Validate button and the JSON/CSV/XML exports must NEVER serve
// figures a since-fixed extractor mis-read. `prepareInvoiceRun` re-extracts a stale invoice in place
// before the downstream tool runs (mirror of the bank `prepareStatementRun`). A COLLAPSED chunk row
// (line-oriented parsing yields near-nothing) + FAITHFUL segments prove the re-extraction reads the
// segments: 2 line items + gross 390 cannot come from the collapsed chunk.
describe('R3 — downstream invoice runs re-extract a STALE invoice before serving rows (audit §5.6)', () => {
  const skillInstallId = 'app:invoice'
  const COLLAPSED = INVOICE_TEXT.replace(/\n/g, ' ')
  const SEGMENTS: DocumentChunkRead[] = [{ text: INVOICE_TEXT, page: 1, index: 0 }]
  const faithfulReader = async (): Promise<DocumentChunkRead[]> => SEGMENTS

  /** Extract once at the CURRENT version from the faithful segments, then force the invoice stale. */
  async function seedStaleInvoice(db: Db, docId: string): Promise<string> {
    const res = await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {}, readDocumentSegments: faithfulReader })
    const id = res.invoiceId!
    expect(res.lineItemCount).toBe(2)
    db.prepare('UPDATE invoices SET extractor_version = 2 WHERE id = ?').run(id)
    expect(isInvoiceStale(db, id)).toBe(true)
    return id
  }

  it('Validate re-extracts the stale invoice (new id, current version) before reconciling', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const staleId = await seedStaleInvoice(db, docId)

    const { audit } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, { audit, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(true)

    const freshId = latestInvoiceId(db, docId)!
    expect(freshId).not.toBe(staleId)
    expect(isInvoiceStale(db, freshId)).toBe(false)
    // replaceExisting deleted the stale invoice — exactly one remains and the old id is gone.
    const count = (db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1)
    expect(db.prepare('SELECT id FROM invoices WHERE id = ?').get(staleId)).toBeUndefined()
    // The re-extraction read the FAITHFUL segments: both line items are present.
    const items = (db.prepare('SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id = ?').get(freshId) as { n: number }).n
    expect(items).toBe(2)
  })

  it('JSON export re-extracts the stale invoice and serializes the FRESH figures', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const staleId = await seedStaleInvoice(db, docId)

    let written = ''
    const { audit } = capturingAudit()
    const res = await runInvoiceFileExport(
      db,
      { skillInstallId, documentId: docId },
      {
        audit,
        confirmed: true,
        readDocumentSegments: faithfulReader,
        saveTextFile: async (_name, content) => {
          written = content
          return true
        }
      },
      { toolName: 'export_invoice_json', defaultFileName: 'invoice.json' }
    )
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    const parsed = JSON.parse(written) as { lineItems: unknown[]; totals: Record<string, unknown> }
    expect(parsed.lineItems).toHaveLength(2) // re-extracted rows, not the stale set
    expect(parsed.totals.grossTotal).toBe(390)
    const freshId = latestInvoiceId(db, docId)!
    expect(freshId).not.toBe(staleId)
    expect(isInvoiceStale(db, freshId)).toBe(false)
  })

  it('a FRESH invoice is NOT re-extracted (same id, no duplicate)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const res0 = await runInvoiceExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {}, readDocumentSegments: faithfulReader })
    const freshId = res0.invoiceId!
    expect(isInvoiceStale(db, freshId)).toBe(false)

    const { audit } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, { audit, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(true)
    expect(latestInvoiceId(db, docId)).toBe(freshId) // unchanged — nothing re-extracted
    const count = (db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1)
  })

  it('a stale invoice whose re-extraction FAILS fails the run with needsExtraction', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const staleId = await seedStaleInvoice(db, docId)

    const { audit } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, {
      audit,
      readDocumentSegments: async () => {
        throw new Error('stored copy is gone')
      }
    })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('needsExtraction')
    // The stale invoice survives a failed re-extraction (the DELETE only runs in a successful persist).
    expect(db.prepare('SELECT id FROM invoices WHERE id = ?').get(staleId)).toBeDefined()
  })

  it('a user CANCEL mid-re-extraction is reported cancelled (not a needsExtraction failure)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    await seedStaleInvoice(db, docId)

    const ac = new AbortController()
    ac.abort() // cancel before the re-extraction's gate ran → runSkillTool returns cancelled
    const { audit } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, {
      audit,
      signal: ac.signal,
      readDocumentSegments: faithfulReader
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(res.errorCode).toBeUndefined() // NOT needsExtraction — a cancel is not a failure
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('a stale invoice is NOT re-extracted when the caller supplies a preloaded invoice (analysis-lane guard)', async () => {
    // The `preloadedInvoice === undefined` half of the guard: the analysis lane already re-extracted the
    // stale invoice and hands it down as `preloadedInvoice`; re-extracting again would delete its rows.
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const staleId = await seedStaleInvoice(db, docId)
    const preloaded: InvoiceInput = {
      header: { vendor: 'ACME', currency: 'EUR' },
      lineItems: [{ description: 'Item', quantity: 1, unitPrice: 100, lineTotal: 100, currency: 'EUR' }],
      totals: { netTotal: 100, grossTotal: 100 }
    }

    const { audit } = capturingAudit()
    const res = await runInvoiceTotalsValidation(db, { skillInstallId, documentId: docId }, { audit, readDocumentSegments: faithfulReader }, preloaded)
    expect(res.ok).toBe(true)
    // No re-extraction: the SAME (still-stale) invoice is served — the caller owns the freshness decision.
    expect(latestInvoiceId(db, docId)).toBe(staleId)
    expect(isInvoiceStale(db, staleId)).toBe(true)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1)
  })

  it('the run-bar DISPATCH forwards the segment reader to a stale invoice re-extraction (buildToolRunner, R3 / §5.6)', async () => {
    // Discriminating twin of the bank IPC test: proves `tool-runs.ts` forwards `readDocumentSegments` to
    // the downstream INVOICE dispatch. The COLLAPSED chunk yields ~0 line items via the chunk fallback;
    // only the faithful segments give 2. Revert the invoice forwarding and this test fails.
    const db = freshDb()
    const docId = seedDocWithChunks(db, COLLAPSED)
    const { audit } = capturingAudit()
    const args = { skillInstallId, conversationId: '', documentId: docId }
    const runnerDeps = { readDocumentSegments: faithfulReader }
    const runCtx = { signal: new AbortController().signal, onProgress: () => {} }

    // Extract through the dispatch (reads the forwarded segments) — two line items.
    const extract = buildToolRunner(db, 'extract_invoice', args, audit, runnerDeps)!
    expect((await extract(runCtx)).ok).toBe(true)
    const staleId = latestInvoiceId(db, docId)!
    db.prepare('UPDATE invoices SET extractor_version = 2 WHERE id = ?').run(staleId)

    // A downstream dispatch (Validate) must re-extract from the forwarded segments, not the chunk fallback.
    const validate = buildToolRunner(db, 'validate_invoice_totals', args, audit, runnerDeps)!
    expect((await validate(runCtx)).ok).toBe(true)

    const freshId = latestInvoiceId(db, docId)!
    expect(freshId).not.toBe(staleId) // re-extracted through the dispatch
    const items = (db.prepare('SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id = ?').get(freshId) as { n: number }).n
    expect(items).toBe(2) // faithful segments — the collapsed chunk fallback would give 0
  })
})
