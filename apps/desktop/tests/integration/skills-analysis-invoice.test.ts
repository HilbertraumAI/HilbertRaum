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
import { appendMessage, createConversation } from '../../src/main/services/chat'
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

function ctxFor(
  db: Db,
  scope: RetrievalScope,
  question: string,
  conversationId: string | null = null
): SkillAnalysisContext & {
  events: Array<{ type: string; meta?: Record<string, unknown> }>
} {
  const { audit, events } = capturingAudit()
  return {
    db,
    scope,
    question,
    skillInstallId: INVOICE_INSTALL_ID,
    conversationId,
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

describe('invoice analysis handler — date-order caveat (R5, §5.7)', () => {
  // An invoice whose LEADING delivery-date column is ORDER-AMBIGUOUS (both fields ≤ 12): day-first is
  // applied with no evidence ⇒ the answer carries ONE honest date caveat. (The date must LEAD its line to
  // vote — a labelled `Invoice date 03.05.2026` reads as a money-shaped `03.05` token, not a booking date.)
  // The ISO-dated CLEAN carries no ambiguous date ⇒ no caveat. Totals are unchanged (the date is stripped).
  const AMBIGUOUS = [
    'Invoice number INV-001',
    'Vendor Acme GmbH',
    '03.05.2026 Widget 2 50,00 100,00',
    'Gadget 1 20,00 20,00',
    'Net total 120,00 EUR',
    'VAT 20% 24,00 EUR',
    'Gross total 144,00 EUR'
  ].join('\n')

  // A summary-shaped ask keeps the deterministic TEMPLATE (W3), which carries the R5 date caveat.
  it('appends the day-first caveat (en) when the invoice gives no date-order evidence', async () => {
    const db = freshDb()
    const id = seedDoc(db, AMBIGUOUS)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))
    expect(res.answer).toContain(t('en', 'skills.invoiceAnalysis.dateOrderCaveat'))
  })

  it('appends the caveat rendered in German (du-form) when tr is de', async () => {
    const db = freshDb()
    const id = seedDoc(db, AMBIGUOUS)
    const ctx = {
      ...ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'),
      tr: (k: MessageKey, p?: MessageParams) => t('de', k, p)
    }
    const res = await invoiceAnalysisHandler.run!(ctx)
    expect(res.answer).toContain(t('de', 'skills.invoiceAnalysis.dateOrderCaveat'))
    expect(res.answer).not.toContain(' Sie ')
  })

  it('adds NO caveat when the invoice date is ISO (evidence — the day-first guess is moot)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))
    expect(res.answer).not.toContain(t('en', 'skills.invoiceAnalysis.dateOrderCaveat'))
  })

  // W3: a NON-summary question routes to grounded-data (empty deterministic answer, a model stream is
  // built downstream). R5's honesty must NOT vanish — the date caveat rides the grounded-data POSTSCRIPT.
  it('grounded-data path carries the R5 date caveat in the deterministic postscript', async () => {
    const db = freshDb()
    const id = seedDoc(db, AMBIGUOUS)
    // (P3 note: the fixture states no due date, so a "fällig" question now falls through to the
    // relevance path by design — a non-field figure question keeps this turn on grounded-data.)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'was kostet das widget?'))
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).toBe('') // the model answer is streamed by registerRagIpc, not built here
    expect(res.postscript).toContain(t('en', 'skills.invoiceAnalysis.dateOrderCaveat'))
  })
})

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

describe('invoice analysis handler — honest completeness gate (U1, §2.3)', () => {
  // One good line item + one the parser DROPS as a fused space-group amount ("Gizmo 10 100" → 10 100).
  const ONE_DROPPED = [
    'Invoice number INV-001',
    'Vendor Acme GmbH',
    'Widget 2 50,00 100,00',
    'Gizmo 10 100',
    'Net total 100,00 EUR'
  ].join('\n')

  it('gates the count line: droppedRowCount > 0 ⇒ the honest partial headline, not "the whole invoice"', async () => {
    const db = freshDb()
    const id = seedDoc(db, ONE_DROPPED)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.countPartial', { count: 1, dropped: 1 }))
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.count', { count: 1 }))
  })

  it('a clean invoice keeps the plain "the whole invoice" count (no false gate)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.count', { count: 2 }))
  })
})

describe('invoice analysis handler — run()', () => {
  it('exhaustive figures: count + net/tax/gross read from the extracted invoice', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    // W3: a summary-shaped ask keeps the deterministic template (a bare "what are the totals?" now streams
    // a grounded-data model answer — see rag-skill-analysis-invoice.test.ts).
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))

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
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))
    const numbers = (res.answer.match(/\d+\.\d{2}/g) ?? []).sort()
    // The two line-item totals (100,00 / 20,00) that the listing surfaces, plus the three printed totals
    // (net 120,00, tax 24,00, gross 144,00). Every figure is printed on the invoice — nothing invented.
    expect(numbers).toEqual(['100.00', '20.00', '120.00', '24.00', '144.00'].sort())
  })

  it('lists the line items so "list all positions" is answerable (not just a count)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    // An explicit list-ask ("liste alle positionen auf") is a summary shape → the template's listing.
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'liste alle positionen auf'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.positionsHeading'))
    // Both line-item descriptions and their printed totals appear, each verbatim.
    expect(res.answer).toContain('Widget')
    expect(res.answer).toContain('Gadget')
    expect(res.answer).toContain('100.00')
    expect(res.answer).toContain('20.00')
  })

  it('R6: the listing shows a CLEANED (debris-stripped) line-item description (audit §5.7)', async () => {
    // A `<rowIndex> <description> <qty> <rate>% <unitPrice> <lineTotal>` row: 12 × 76,17 = 914,04 confirms
    // the split, so the leading index + trailing `12 0%` debris are stripped and the listing shows the clean
    // description (not the raw "1 Web hosting 12 Monate 12 0%"). Exercises extract → persist → listing.
    const DEBRIS = [
      'Invoice number INV-777',
      'Vendor Debris GmbH',
      '1 Web hosting 12 Monate 12 0% 76,17 914,04',
      'Net total 914,04 EUR'
    ].join('\n')
    const db = freshDb()
    const id = seedDoc(db, DEBRIS)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'liste alle positionen auf'))
    expect(res.answer).toContain('Web hosting 12 Monate') // the identity-confirmed cleaned description
    expect(res.answer).not.toContain('1 Web hosting') // leading row-index gone
    expect(res.answer).not.toContain('0%') // trailing tax-rate debris gone
  })

  it('W3 grounded-data outcome: a non-summary question returns the verified data block + totals postscript', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'who is the vendor?'))

    // The handler builds the grounded-data OUTCOME (the model stream itself is registerRagIpc's job).
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).toBe('')
    // The data block is the serialized VERIFIED object: JSON + reconciliation + a provenance note.
    expect(res.dataBlock).toContain('Invoice (JSON):')
    expect(res.dataBlock).toContain('"vendor": "Acme GmbH"')
    expect(res.dataBlock).toContain('- overall: reconciled')
    expect(res.dataBlock).toContain('Quote these figures verbatim')
    // The deterministic totals echo is the postscript (net/tax/gross verbatim from the parser).
    expect(res.postscript).toContain('120.00')
    expect(res.postscript).toContain('24.00')
    expect(res.postscript).toContain('144.00')
    // Real citations + honest extract coverage pass straight through (same as the template path).
    expect(res.citations.length).toBeGreaterThan(0)
    expect(res.coverage!.mode).toBe('extract')
  })

  it('an EMPTY invoice-looking doc + a non-summary question stays on the template (not grounded-data)', async () => {
    // W3 `|| !hasContent` arm: an extraction that found no line items AND no totals has no verified data to
    // hand a model, so even a non-summary question ("who is the vendor?") keeps the honest empty template
    // rather than streaming a model answer over a hollow all-null JSON block. (This db has no installed
    // skill row, so the W2 plausibility fall-through does not apply — the empty template is correct here.)
    const db = freshDb()
    const id = seedDoc(db, 'Just a short note. No line items, no totals, nothing to reconcile.')
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'who is the vendor?'))

    expect(res.mode).not.toBe('grounded-data')
    expect(res.dataBlock).toBeUndefined()
    expect(res.answer).toBe(tr('skills.invoiceAnalysis.empty'))
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
    // §3.6-low (W4): the CSV intro states honestly that CSV omits the header + totals (they ride in
    // JSON/XML), instead of the old generic "the invoice as CSV" claim — pin that honesty branch.
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.formatIntroCsv'))
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
    const grossLabel = tr('skills.invoiceAnalysis.gross', { value: '200.00 EUR' })
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

  // U5 (audit §6.2/ux stopgap): a LONG invoice prints its totals at the END, past the first 12 chunks.
  // The invoice schema records no per-figure source page, so citations are chunks — and a leading-only
  // slice would point ENTIRELY away from where the headline totals were read. The stopgap reserves the
  // last TAIL_CITATIONS slots for the closing chunks.
  it('a long invoice cites its CLOSING chunks (totals), not only the first 12 (last-chunks stopgap)', async () => {
    const db = freshDb()
    const lines = [
      'Invoice number INV-LONG',
      'Vendor Acme GmbH',
      'Invoice date 2026-01-15',
      ...Array.from({ length: 11 }, () => 'Widget 1 10,00 10,00'), // 11 line items → net 110
      'Net total 110,00 EUR',
      'Gross total ZZTOTALMARKER 110,00 EUR' // the very LAST chunk (index 15, well past MAX_CITATIONS=12)
    ]
    const id = seedDoc(db, lines.join('\n'))
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))

    // Capped at MAX_CITATIONS (12), still labelled S1…S12 in order.
    expect(res.citations).toHaveLength(12)
    res.citations.forEach((c, i) => expect(c.label).toBe(`S${i + 1}`))
    const snippets = res.citations.map((c) => c.snippet ?? '')
    // Leading chunks preserved (header is still cited)…
    expect(snippets[0]).toContain('INV-LONG')
    // …AND the closing totals chunk (index 15) is cited — a leading-only slice (first 12) would have
    // dropped it entirely. The unique marker lives ONLY on the last line, so this can't pass by accident.
    expect(snippets.some((s) => s.includes('ZZTOTALMARKER'))).toBe(true)
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

    // The second run sees the stale invoice → re-extracts, REPLACING it in place (no duplicate). A
    // summary-shaped ask keeps the deterministic template so the re-extracted figures show in `answer`.
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'give me a summary of the totals'))

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

// W6 (audit §3.1, SKA-5) — the grounded-data honesty COMPOSITION for the invoice: droppedRowCount now
// reaches the mode's data block + postscript (an invoice has no balance proof, so any dropped line
// hedges). A non-summary question ("who is the vendor?") routes to grounded-data.
describe('invoice grounded-data honesty composition (W6, §3.1 SKA-5)', () => {
  // One good line item + one dropped fused space-group amount ("Gizmo 10 100" → 10 100). dropped 1.
  const ONE_DROPPED = [
    'Invoice number INV-001',
    'Vendor Acme GmbH',
    'Widget 2 50,00 100,00',
    'Gizmo 10 100',
    'Net total 100,00 EUR'
  ].join('\n')

  it('SKA-5: droppedRowCount reaches the grounded-data postscript (countPartial hedge) AND the data block (MISSING note)', async () => {
    const db = freshDb()
    const id = seedDoc(db, ONE_DROPPED)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'who is the vendor?'))
    expect(res.mode).toBe('grounded-data')
    // The totals echo still rides (net 100,00), plus the honest dropped hedge beneath it (count 1, dropped 1).
    expect(res.postscript).toContain('100.00')
    expect(res.postscript).toContain(tr('skills.invoiceAnalysis.countPartial', { count: 1, dropped: 1 }))
    // The data block declares the missing line — a "how many line items?" narration cannot claim completeness.
    expect(res.dataBlock).toContain('MISSING from this data')
    expect(res.dataBlock).not.toContain('parsed and reconciled from the whole document')
  })

  it('SKA-5: a clean invoice keeps whole-document provenance and no hedge (no false gate)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'who is the vendor?'))
    expect(res.mode).toBe('grounded-data')
    expect(res.dataBlock).toContain('every value above was parsed and reconciled from the whole document')
    expect(res.dataBlock).not.toContain('MISSING')
    expect(res.postscript).not.toContain(tr('skills.invoiceAnalysis.countPartial', { count: 2, dropped: 0 }))
  })
})

// W7 (audit §3.2/§3.3) — answer-shape tuning for the invoice, end-to-end through run().
describe('invoice W7 answer-shape tuning (SKA-9/SKA-10)', () => {
  it('SKA-9 separable verbs "Fasse die Rechnung zusammen" / "Liste die Positionen auf" keep the TEMPLATE', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    for (const q of ['Fasse die Rechnung zusammen', 'Liste die Positionen auf']) {
      const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, q))
      expect(res.mode, `"${q}" must keep the template`).not.toBe('grounded-data')
      expect(res.answer.length, `"${q}" template answer is non-empty`).toBeGreaterThan(0)
    }
  })

  it('SKA-9 a separable ask WITH a format word ("… als json zusammen") still serializes (format wins first)', async () => {
    // The format short-circuit precedes isSummaryShaped, so a genuine "als JSON" request is untouched by
    // the new separable-summary regex (guards against the regex hijacking a format ask to the template).
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'fasse die rechnung als json zusammen')
    )
    expect(res.answer).toContain('```json')
  })

  it('SKA-10 explanatory format Q "Warum fehlt im JSON die MwSt?" reaches grounded-data, not the JSON dump', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Warum fehlt im JSON die MwSt?')
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })
})

// invoice-hardening-2026-07-04 P2 — the reconciliation GATE end-to-end through run(): mismatched totals
// never print under the confident "exactly as printed" heading, and the grounded-data postscript
// suppresses the figure echo instead of asserting contradictory figures as document quotes.
describe('invoice P2 reconciliation gating through run() (invoice-hardening-2026-07-04)', () => {
  // Strong 2-dp totals that mismatch: gross 200,00 ≠ net 120,00 + tax 24,00 (P2's weak-read retraction
  // does not touch decimal-shaped figures — the ANSWER layer owns this case).
  const MISMATCHED = CLEAN.replace('Gross total 144,00 EUR', 'Gross total 200,00 EUR')

  it('template path: mismatched totals print under the UNVERIFIED heading with the caveat', async () => {
    const db = freshDb()
    const id = seedDoc(db, MISMATCHED)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen')
    )
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.totalsHeadingUnverified'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.unreconciledCaveat'))
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.totalsHeading'))
  })

  it('template path: reconciled totals keep the confident heading, no caveat', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen')
    )
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.totalsHeading'))
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.unreconciledCaveat'))
  })

  it('grounded-data path: the postscript suppresses the figure echo on a mismatched invoice', async () => {
    const db = freshDb()
    const id = seedDoc(db, MISMATCHED)
    // (P3 note: the question must not name a missing header field — "fällig" would now fall through to
    // the relevance path on this due-date-less fixture, which is P3's own tested behaviour.)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'warum stimmen die summen nicht?')
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.postscript).toContain(tr('skills.invoiceAnalysis.figureEchoSuppressed'))
    expect(res.postscript).not.toContain('200.00')
    // The model-facing block carries the mismatch warning.
    expect(res.dataBlock).toContain('WARNING: the checks above MISMATCH')
  })
})

// invoice-hardening-2026-07-04 P1 — negation-aware format detection + the byte-identical replay
// backstop. The incident: "Analysiere die Rechnung im Roh format - nicht im json" matched the bare
// `\bjson\b` token and re-served the byte-identical JSON dump (0 model calls, ~9 ms) against a question
// that explicitly asked AWAY from JSON.
describe('invoice P1 format negation + replay backstop (invoice-hardening-2026-07-04)', () => {
  it('the incident question "… im Roh format - nicht im json" reaches grounded-data, never the dump', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Analysiere die Rechnung im Roh format - nicht im json')
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })

  it('an English negated ask "not as json — explain the invoice" reaches grounded-data', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'not as json — explain the invoice please')
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })

  it('an affirmed format NEXT TO a negated one ("als CSV, nicht als JSON") still serializes CSV', async () => {
    // The negation check is per MENTION: the negated json token is skipped, the affirmed csv wins.
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'die rechnung als csv, nicht als json')
    )
    expect(res.answer).toContain('```csv')
    expect(res.answer).not.toContain('```json')
  })

  it('a raw/prose ask ("die Rechnung im Rohformat bitte") never serializes', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'zeig mir die Rechnung im Rohformat bitte')
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })

  it('backstop: a negator OUTSIDE the window never re-serves the previous byte-identical dump', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const conv = createConversation(db)
    // Turn 1: a genuine JSON ask; its answer is persisted as the previous assistant turn.
    const first = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'die rechnung als json bitte', conv.id)
    )
    expect(first.answer).toContain('```json')
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: first.answer })
    // Turn 2: "nicht" sits > NEGATION_WINDOW chars before "json", so detectFormat still affirms JSON —
    // the conversation-level backstop must catch the byte-identical replay and fall to grounded-data.
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'bitte nicht in dem komischen kaputten json', conv.id)
    )
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })

  it('a repeat format ask WITHOUT a negator ("nochmal als json") re-serves the dump — correct repeat', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const conv = createConversation(db)
    const first = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'die rechnung als json bitte', conv.id)
    )
    appendMessage(db, { conversationId: conv.id, role: 'assistant', content: first.answer })
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'nochmal als json bitte', conv.id)
    )
    // No negator in the question ⇒ the backstop stays out of the way; the dump IS the right answer.
    expect(res.answer).toBe(first.answer)
  })
})

// invoice-hardening-2026-07-04 P3 — the glyph-soup gate (+ one geometry retry) and the missing-field
// fall-through, end-to-end through run().
describe('invoice P3 glyph-soup gate + geometry retry + missing-field fall-through', () => {
  // The incident shape: per-glyph spacing fragments the text layer into single-glyph token runs, and
  // the scraped figures cannot corroborate each other.
  const SOUP = [
    'I n v o i c e',
    '1   0 % 3   Article — Stablecoin Yield Farming 167,70',
    '$ 9 1 4 = $ 915,92',
    '( 1 U S D T = $ 0,99',
    'Netto 4 $',
    'Total 914 $'
  ].join('\n')

  const toSegments = (text: string) => text.split('\n').map((line, index) => ({ text: line, page: 1, index }))

  it('soup + unverifiable figures → the unreadable-layout refusal (never fragments as an invoice)', async () => {
    const db = freshDb()
    const id = seedDoc(db, SOUP)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen'))
    expect(res.answer).toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    expect(res.mode).not.toBe('grounded-data')
  })

  it('soup blocks the JSON dump too (the gate precedes the format short-circuit)', async () => {
    const db = freshDb()
    const id = seedDoc(db, SOUP)
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'die rechnung als json bitte'))
    expect(res.answer).toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    expect(res.answer).not.toContain('```json')
  })

  it('the geometry retry recovers a document whose LAYOUT read is clean', async () => {
    const db = freshDb()
    const id = seedDoc(db, SOUP)
    const ctx = {
      ...ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen'),
      readDocumentSegments: async (_id: string, opts?: { layout?: boolean }) =>
        opts?.layout ? toSegments(CLEAN) : toSegments(SOUP)
    }
    const res = await invoiceAnalysisHandler.run!(ctx)
    // The layout re-read replaced the soup extraction: the CLEAN totals answer — no refusal, no caveat.
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.totalsHeading'))
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.unreadableLayout'))
    expect(res.answer).not.toContain(tr('skills.invoiceAnalysis.textQualityCaveat'))
    const row = db.prepare('SELECT text_quality AS q FROM invoices').get() as { q: string | null }
    expect(row.q).toBeNull()
  })

  it('a still-soupy retry is FINAL: suspect-confirmed persists and later turns re-extract nothing', async () => {
    const db = freshDb()
    const id = seedDoc(db, SOUP)
    const reads: Array<boolean | undefined> = []
    const ctx = {
      ...ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen'),
      readDocumentSegments: async (_id: string, opts?: { layout?: boolean }) => {
        reads.push(opts?.layout)
        return toSegments(SOUP)
      }
    }
    const first = await invoiceAnalysisHandler.run!(ctx)
    expect(first.answer).toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    const row = db.prepare('SELECT text_quality AS q FROM invoices').get() as { q: string | null }
    expect(row.q).toBe('suspect-confirmed')
    const readsAfterFirst = reads.length
    const second = await invoiceAnalysisHandler.run!({ ...ctx, question: 'summarize the invoice' })
    expect(second.answer).toBe(tr('skills.invoiceAnalysis.unreadableLayout'))
    expect(reads.length).toBe(readsAfterFirst) // the confirmed flag reuses the rows — no new reads
  })

  it('a question naming a MISSING header field falls through to the relevance path (Empfänger)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // no recipient line
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Wer ist der Empfänger der Rechnung?')
    )
    expect(res.fallThrough).toBe(true)
  })

  it('the same question with the field EXTRACTED stays on the skill (grounded-data carries it)', async () => {
    const db = freshDb()
    const id = seedDoc(db, ['Bill to: Example Corp', ...CLEAN.split('\n')].join('\n'))
    const res = await invoiceAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Wer ist der Empfänger der Rechnung?')
    )
    expect(res.fallThrough).toBeUndefined()
    expect(res.mode).toBe('grounded-data')
    expect(res.dataBlock).toContain('"recipient": "Example Corp"')
  })

  it('a recipient line surfaces in the summary Details block', async () => {
    const db = freshDb()
    const id = seedDoc(db, ['Bill to: Example Corp', ...CLEAN.split('\n')].join('\n'))
    const res = await invoiceAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'fasse die rechnung zusammen'))
    expect(res.answer).toContain(tr('skills.invoiceAnalysis.detailRecipient', { recipient: 'Example Corp' }))
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
