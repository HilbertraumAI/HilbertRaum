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
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'what are the totals?'))

    expect(res.answer).toContain(tr('skills.invoiceAnalysis.count', { count: 2 }))
    expect(res.answer).toContain('120.00') // net
    expect(res.answer).toContain('24.00') // tax
    expect(res.answer).toContain('144.00') // gross
    expect(res.answer).toContain('EUR')
    // A clean invoice reconciles, so there is NO "check these totals first" block.
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.unreconciledHeading'))
  })

  it('figures are quoted, never invented — only the invoice’s printed totals appear', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'gross amount?'))
    const numbers = (res.answer.match(/\d+\.\d{2}/g) ?? []).sort()
    expect(numbers).toEqual(['120.00', '144.00', '24.00'].sort())
  })

  it('surfaces a failed reconciliation check BEFORE the headline gross (SKILL.md)', async () => {
    const db = freshDb()
    // Gross 200,00 cannot equal net 120,00 + tax 24,00 → netPlusTaxIsGross mismatch.
    const text = CLEAN.replace('Gross total 144,00 EUR', 'Gross total 200,00 EUR')
    const id = seedDoc(db, text)
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'do the totals reconcile?'))

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
    await invoiceAnalysisHandler.run(ctx)

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
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'totals?'))
    expect(res.coverage.mode).toBe('extract')
    expect(res.coverage.chunksTotal).toBe(8) // 8 seeded chunk rows
    expect(res.coverage.chunksCovered).toBe(8)
    expect(res.coverage.fullyChunked).toBe(true) // gates the "whole document" meter wording
  })

  it('coverage fullyChunked is FALSE for a legacy (not fully chunked) document', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // fully_chunked NULL
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'totals?'))
    expect(res.coverage.mode).toBe('extract')
    expect(res.coverage.fullyChunked).toBe(false)
  })

  it('citations are real SOURCE chunks (M2) — labelled S1…Sn', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run(ctxFor(db, { documentIds: [id] }, 'totals?'))

    expect(res.citations.length).toBeGreaterThan(0)
    res.citations.forEach((c, i) => expect(c.label).toBe(`S${i + 1}`))
    const snippets = res.citations.map((c) => c.snippet ?? '').join('\n')
    // The snippets come from the document's own lines (line items + header), not a synthesised total.
    expect(snippets).toContain('Widget')
    expect(snippets).toContain('Acme GmbH')
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
