import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  INVOICE_INSTALL_ID,
  invoiceAnalysisHandler
} from '../../src/main/services/skills/analysis/invoice'
import {
  clearSkillAnalysisHandlers,
  getSkillAnalysisHandler,
  registerSkillAnalysisHandler
} from '../../src/main/services/skills/analysis/registry'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AuditEventType, RetrievalScope } from '../../src/shared/types'

// full-doc-skills plan §3.1, Phase 4 / D49 — the invoice analysis handler, driven DIRECTLY (no IPC,
// no chat wiring). Mirrors skills-analysis-bank.test.ts: seeds the `chunks` table (the legacy reader
// path — no segment reader injected), and asserts the deterministic whole-document answer honours
// SKILL.md: count + totals read from the persisted invoice, failed reconciliation checks BEFORE the
// headline gross, figures quoted (never invented), export never auto-run, honest extract coverage with
// `fullyChunked` gating, and citations that are real source chunks (M2).

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-invoice-analysis-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function seedDoc(db: Db, text: string, opts: { fullyChunked?: boolean } = {}): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'Invoice', 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, opts.fullyChunked ? now : null, now, now)
  // One chunk per line so citations resolve against real source rows (page-addressable).
  text.split('\n').forEach((line, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'Invoice', 1, ?)`
    ).run(randomUUID(), docId, i, line, now)
  })
  return docId
}

function capturingAudit(): {
  audit: (t: AuditEventType, m?: Record<string, unknown>) => void
  events: Array<{ type: string; meta?: Record<string, unknown> }>
} {
  const events: Array<{ type: string; meta?: Record<string, unknown> }> = []
  return { audit: (type, meta) => events.push({ type, meta }), events }
}

function ctxFor(db: Db, scope: RetrievalScope, question: string): SkillAnalysisContext & {
  events: Array<{ type: string; meta?: Record<string, unknown> }>
} {
  const { audit, events } = capturingAudit()
  return {
    db,
    scope,
    question,
    skillInstallId: INVOICE_INSTALL_ID,
    conversationId: null,
    audit,
    tr,
    events
  }
}

/** Count the `db.prepare` calls whose SQL matches `pattern` while `fn` runs (audit P-1 query-count). */
async function countPrepares(db: Db, pattern: RegExp, fn: () => Promise<void>): Promise<number> {
  const real = db.prepare.bind(db)
  let count = 0
  const target = db as unknown as { prepare: Db['prepare'] }
  target.prepare = ((sql: string) => {
    if (pattern.test(sql)) count++
    return real(sql)
  }) as Db['prepare']
  try {
    await fn()
  } finally {
    target.prepare = real
  }
  return count
}

// A clean invoice: 2 line items (100,00 + 20,00 = 120,00 net), 20% VAT (24,00), gross 144,00 — all
// three reconciliation checks pass.
const CLEAN = [
  'Invoice number INV-001',
  'Vendor Acme GmbH',
  'Invoice date 2026-01-15',
  'Widget 2 50,00 100,00',
  'Gadget 1 20,00 20,00',
  'Net total 120,00 EUR',
  'VAT 20% 24,00 EUR',
  'Gross total 144,00 EUR'
].join('\n')

describe('invoice analysis handler — applies() pre-flight (R2)', () => {
  it('applies on an analysis-shaped question over a single in-scope invoice', () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    expect(
      invoiceAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'what is the gross total?' })
    ).toBe(true)
  })

  it('does not apply when no document is in scope', () => {
    const db = freshDb()
    seedDoc(db, CLEAN)
    expect(
      invoiceAnalysisHandler.applies({ db, scope: { documentIds: ['does-not-exist'] }, question: 'total?' })
    ).toBe(false)
  })

  it('does not apply over a multi-document scope (single-invoice only)', () => {
    const db = freshDb()
    const a = seedDoc(db, CLEAN)
    const b = seedDoc(db, CLEAN)
    expect(
      invoiceAnalysisHandler.applies({ db, scope: { documentIds: [a, b] }, question: 'reconcile the totals' })
    ).toBe(false)
  })

  it('does not apply to an off-topic question (keeps the relevance path — plan §3.2)', () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    expect(
      invoiceAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'who wrote this letter?' })
    ).toBe(false)
  })
})

describe('invoice analysis handler — run()', () => {
  it('exhaustive figures: count + net/tax/gross read from the extracted invoice', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what are the totals?'))

    expect(res.answer).toContain(tr('skills.invoiceAnalysis.count', { count: 2 }))
    expect(res.answer).toContain('120.00') // net
    expect(res.answer).toContain('24.00') // tax
    expect(res.answer).toContain('144.00') // gross
    expect(res.answer).toContain('EUR')
    // A clean invoice reconciles, so there is NO "check these totals first" block.
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.unreconciledHeading'))
  })

  it('issues ONE invoice line-items read per analysis question (audit P-1): the validate seam reuses the single load', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    // Warm-up extracts a FRESH invoice so the measured run REUSES it (F5): no re-extraction — and so no
    // `replaceExisting` DELETE FROM invoice_line_items — in the measured window, only the genuine load.
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what are the totals?'))
    const reads = await countPrepares(db, /FROM invoice_line_items\b/i, async () => {
      await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what are the totals?'))
    })
    // Was TWO before Phase 4 (the validate seam's loadInvoice + the handler's own loadInvoice); now the
    // handler loads the invoice once and hands it to the validate seam as `preloaded` (no re-query).
    // TEST-N5: assert the OUTCOME (no DUPLICATE load) rather than an exact count — a safe refactor
    // that loads zero extra times still passes; a regression that re-queries (2+) still fails.
    expect(reads).toBeLessThanOrEqual(1)
  })

  it('figures are quoted, never invented — only the invoice’s printed figures appear', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'gross amount?'))
    const numbers = (res.answer.match(/\d+\.\d{2}/g) ?? []).sort()
    // The two line-item totals (100,00 / 20,00) that the listing surfaces, plus the three printed totals
    // (net 120,00, tax 24,00, gross 144,00). Every figure is printed on the invoice — nothing invented.
    expect(numbers).toEqual(['100.00', '20.00', '120.00', '24.00', '144.00'].sort())
  })

  it('lists the line items so "give me the positions" is answerable (not just a count)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'gib mir die positionen'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.positionsHeading'))
    // Both line-item descriptions and their printed totals appear, each verbatim.
    expect(res.answer).toContain('Widget')
    expect(res.answer).toContain('Gadget')
    expect(res.answer).toContain('100.00')
    expect(res.answer).toContain('20.00')
  })

  it('answers a "als JSON" request by serializing the extracted invoice (no prose template)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'fasse die rechnung als json zusammen')
    )
    // The answer carries a fenced ```json block; its content parses and holds the extracted figures.
    const block = /```json\n([\s\S]*?)\n```/.exec(res.answer)
    expect(block, 'a json code block is present').not.toBeNull()
    const parsed = JSON.parse(block![1]) as {
      lineItems: Array<{ description: string; lineTotal: number }>
      totals: Record<string, number | null>
    }
    expect(parsed.lineItems).toHaveLength(2)
    expect(parsed.totals.netTotal).toBe(120)
    expect(parsed.totals.grossTotal).toBe(144)
    // It did NOT fall through to the prose count template.
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.totalsHeading'))
  })

  it('answers an "als CSV" request with the line-items CSV inline', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'gib mir die rechnung als csv'))
    expect(res.answer).toContain('```csv')
    expect(res.answer).toContain('description,quantity,unitPrice,lineTotal,currency')
    expect(res.answer).toContain('Widget')
  })

  it('surfaces a failed reconciliation check BEFORE the headline gross (SKILL.md)', async () => {
    const db = freshDb()
    // Gross 200,00 cannot equal net 120,00 + tax 24,00 → netPlusTaxIsGross mismatch.
    const text = CLEAN.replace('Gross total 144,00 EUR', 'Gross total 200,00 EUR')
    const id = seedDoc(db, text)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'do the totals reconcile?'))

    const heading = tr('skills.invoiceAnalysis.unreconciledHeading')
    expect(res.answer).toContain(heading)
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.checkNetPlusTaxIsGross'))
    // The unreconciled block precedes the totals (which carry the localized gross-total line).
    const grossLabel = tr('skills.invoiceAnalysis.gross', { amount: '200.00', currency: 'EUR' })
    expect(res.answer.indexOf(heading)).toBeLessThan(res.answer.indexOf(grossLabel))
  })

  it('NEVER auto-runs export_invoice_csv (export stays confirm-gated)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const ctx = ctxFor(db, { documentIds: [id] }, 'check the totals')
    await invoiceAnalysisHandler.run!(ctx)

    const toolNames = ctx.events.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_invoice')
    expect(toolNames).toContain('validate_invoice_totals')
    expect(toolNames).not.toContain('export_invoice_csv')
    // Exactly two skill runs: extract + validate (export never fires).
    const runs = db.prepare('SELECT COUNT(*) AS n FROM skill_runs').get() as { n: number }
    expect(runs.n).toBe(2)
  })

  it('coverage is extract with fullyChunked TRUE when the document is fully chunked', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN, { fullyChunked: true })
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    expect(res.coverage!.mode).toBe('extract')
    expect(res.coverage!.chunksTotal).toBe(8) // 8 seeded chunk rows
    expect(res.coverage!.chunksCovered).toBe(8)
    expect(res.coverage!.fullyChunked).toBe(true) // gates the "whole document" meter wording
  })

  it('coverage fullyChunked is FALSE for a legacy (not fully chunked) document', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // fully_chunked NULL
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    expect(res.coverage!.mode).toBe('extract')
    expect(res.coverage!.fullyChunked).toBe(false)
  })

  it('citations are real SOURCE chunks (M2) — labelled S1…Sn', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))

    expect(res.citations.length).toBeGreaterThan(0)
    res.citations.forEach((c, i) => expect(c.label).toBe(`S${i + 1}`))
    const snippets = res.citations.map((c) => c.snippet ?? '').join('\n')
    // The snippets come from the document's own lines (line items + header), not a synthesised total.
    expect(snippets).toContain('Widget')
    expect(snippets).toContain('Acme GmbH')
  })
})

describe('invoice analysis handler — data lifecycle (reuse / replace / staleness parity, F5)', () => {
  it('asking N questions persists exactly ONE invoice + ONE line-item set (no bloat)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    // Three analysis questions over the SAME document — extraction is deterministic, so the rows are
    // identical each time. The fix REUSES the fresh invoice instead of re-inserting (F5: the bank path's
    // reuse/replace parity). Before the fix this persisted three invoices + three line-item sets.
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what are the totals?'))
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the gross total?'))
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'reconcile the totals'))

    const invoices = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE document_id = ?').get(id) as {
      n: number
    }
    expect(invoices.n).toBe(1)
    const lineItems = db
      .prepare(
        `SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id IN
           (SELECT id FROM invoices WHERE document_id = ?)`
      )
      .get(id) as { n: number }
    expect(lineItems.n).toBe(2) // the two CLEAN line items, not 6
  })

  it('REUSES a fresh (current-version) invoice — no re-extraction, no duplicate', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    const first = db.prepare('SELECT id FROM invoices WHERE document_id = ?').get(id) as { id: string }
    // The second run reuses the same invoice (it is at the current version → not stale).
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    const rows = db.prepare('SELECT id FROM invoices WHERE document_id = ?').all(id) as Array<{ id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(first.id) // same invoice, not re-extracted
  })

  it('re-extracts and REPLACES an invoice produced by an outdated extractor (staleness)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    // First run extracts → an invoice stamped with the current extractor version.
    await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    const before = db
      .prepare('SELECT id, extractor_version AS v FROM invoices WHERE document_id = ?')
      .get(id) as { id: string; v: number }
    expect(before.v).toBeGreaterThanOrEqual(1)

    // Simulate it having been produced by an OLDER parser: blank the version, and tamper a figure so we
    // can prove the rows are actually re-read (a reuse would keep the bogus 99999).
    db.prepare('UPDATE invoices SET extractor_version = NULL, gross_total = 99999 WHERE id = ?').run(before.id)
    db.prepare(
      `UPDATE invoice_line_items SET line_total = 99999 WHERE invoice_id = ?`
    ).run(before.id)

    // The second run sees the stale invoice → re-extracts, REPLACING it in place (no duplicate).
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))

    const rows = db
      .prepare('SELECT id, extractor_version AS v FROM invoices WHERE document_id = ?')
      .all(id) as Array<{ id: string; v: number }>
    expect(rows.length).toBe(1) // the stale one was deleted, not left alongside a fresh copy
    expect(rows[0].id).not.toBe(before.id) // a fresh invoice replaced it
    expect(rows[0].v).toBeGreaterThanOrEqual(1) // re-stamped at the current version (no longer stale)
    // The tampered figure is gone; the answer reflects the correctly re-extracted rows.
    expect(res.answer).not.toContain('99999')
    expect(res.answer).toContain('144.00') // the real gross
    // And the line items were replaced too (no orphans, no duplicates).
    const lineItems = db
      .prepare(
        `SELECT COUNT(*) AS n FROM invoice_line_items WHERE invoice_id IN
           (SELECT id FROM invoices WHERE document_id = ?)`
      )
      .get(id) as { n: number }
    expect(lineItems.n).toBe(2)
  })
})

describe('analysis-handler registry — invoice', () => {
  it('register/get round-trips by install id; an unknown id returns undefined', () => {
    clearSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(INVOICE_INSTALL_ID)).toBeUndefined()
    registerSkillAnalysisHandler(INVOICE_INSTALL_ID, invoiceAnalysisHandler)
    expect(getSkillAnalysisHandler(INVOICE_INSTALL_ID)).toBe(invoiceAnalysisHandler)
    expect(getSkillAnalysisHandler('app:not-a-skill')).toBeUndefined()
  })

  it('registerBuiltinSkillAnalysisHandlers wires the invoice handler (D49)', () => {
    clearSkillAnalysisHandlers()
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(INVOICE_INSTALL_ID)).toBe(invoiceAnalysisHandler)
  })
})
