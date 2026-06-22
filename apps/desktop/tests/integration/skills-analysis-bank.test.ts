import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  BANK_STATEMENT_INSTALL_ID,
  bankStatementAnalysisHandler
} from '../../src/main/services/skills/analysis/bank-statement'
import {
  clearSkillAnalysisHandlers,
  getSkillAnalysisHandler,
  registerSkillAnalysisHandler
} from '../../src/main/services/skills/analysis/registry'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import type { SkillAnalysisContext } from '../../src/main/services/skills/analysis/types'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'
import type { AuditEventType, RetrievalScope } from '../../src/shared/types'

// full-doc-skills plan §3.1, Phase 2 — the analysis-handler seam + bank handler, driven DIRECTLY (no
// IPC, no chat wiring). Seeds the `chunks` table (the legacy reader path — no segment reader injected),
// exactly as the skills-run integration tests do, and asserts the deterministic whole-document answer
// honours SKILL.md: count + totals computed from the rows, unreconciled rows BEFORE the total, mixed
// currency reported as no-total, figures quoted (never invented), export never auto-run, honest
// extract coverage with `fullyChunked` gating, and citations that are real source chunks (M2).

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-analysis-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function seedDoc(
  db: Db,
  text: string,
  opts: { fullyChunked?: boolean } = {}
): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'Statement', 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, opts.fullyChunked ? now : null, now, now)
  // One chunk per line so citations resolve against real source rows (page-addressable).
  text.split('\n').forEach((line, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'Statement', 1, ?)`
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
    skillInstallId: BANK_STATEMENT_INSTALL_ID,
    conversationId: null,
    audit,
    tr,
    events
  }
}

// A clean 2-row statement: Grocery -45.90 (out), Salary +2500.00 (in); the running balances reconcile.
// NOTE: it prints NO opening/closing balance, so under the D56 completeness gate it cannot PROVE it
// captured the whole statement → no total is presented (the downgrade). Used by the tests that don't
// assert a total (applies/coverage/citations) and by the explicit "no balance → downgrade" gate test.
const CLEAN = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'

// The same two rows WITH the printed opening/closing balances that prove completeness under the gate
// (opening 2000.00 + Σ 2454.10 == closing 4454.10) — required before any total is shown (§3.5, D56).
const COMPLETE =
  'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
  '2026-01-03 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'

describe('bank-statement analysis handler — applies() pre-flight (R2)', () => {
  it('applies on an analysis-shaped question over a single in-scope statement', () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    expect(
      bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'summarize the transactions' })
    ).toBe(true)
  })

  it('does not apply when no document is in scope', () => {
    const db = freshDb()
    seedDoc(db, CLEAN)
    expect(
      bankStatementAnalysisHandler.applies({ db, scope: { documentIds: ['does-not-exist'] }, question: 'total?' })
    ).toBe(false)
  })

  it('does not apply over a multi-document scope (single-statement only)', () => {
    const db = freshDb()
    const a = seedDoc(db, CLEAN)
    const b = seedDoc(db, CLEAN)
    expect(
      bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [a, b] }, question: 'reconcile the balances' })
    ).toBe(false)
  })

  it('does not apply to an off-topic question (keeps the relevance path — plan §3.2)', () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    expect(
      bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question: 'who wrote this letter?' })
    ).toBe(false)
  })
})

describe('bank-statement analysis handler — run()', () => {
  it('exhaustive math: count + in/out/net totals computed from the extracted rows', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const ctx = ctxFor(db, { documentIds: [id] }, 'summarize the cashflow')
    const res = await bankStatementAnalysisHandler.run!(ctx)

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    // Money in = 2500.00, money out = 45.90, net = 2454.10 — the rows' own printed figures, verbatim.
    expect(res.answer).toContain('2500.00')
    expect(res.answer).toContain('45.90')
    expect(res.answer).toContain('2454.10')
    expect(res.answer).toContain('EUR')
    // The statement reconciles, so there is NO "check these rows first" block.
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.unreconciledHeading'))
  })

  it('figures are quoted, never invented — no fabricated number leaks into the answer', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    // The only figures present are the three derived totals — nothing else (the opening/closing
    // balances that proved completeness are NOT re-printed in the answer).
    const numbers = (res.answer.match(/\d+\.\d{2}/g) ?? []).sort()
    expect(numbers).toEqual(['2454.10', '2500.00', '45.90'].sort())
  })

  it('surfaces unreconciled rows AND downgrades (a mismatch can never present a total — D56)', async () => {
    const db = freshDb()
    // Row 2's printed balance (200,00) cannot follow 100,00 after a −10,00 movement → a mismatch.
    const id = seedDoc(db, 'Statement EUR\n2026-01-02 Alpha -10,00 100,00\n2026-01-03 Beta -10,00 200,00')
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'do the balances reconcile?'))

    const heading = tr('skills.bankAnalysis.unreconciledHeading')
    expect(res.answer).toContain(heading)
    expect(res.answer).toContain('Beta') // the offending row is still listed (honest)
    // A reconcile mismatch is a read error, so completeness is unproven → no total, the honest downgrade.
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('Net change')
  })

  it('mixed-currency statement reports NO single total (honesty)', async () => {
    const db = freshDb()
    const id = seedDoc(db, 'Statement\n2026-01-02 Coffee -3,50 EUR\n2026-01-03 Book -10,00 USD')
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))

    expect(res.answer).toContain(tr('skills.bankAnalysis.noCurrency'))
    expect(res.answer).not.toContain('Net change') // the totals line is suppressed
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
  })

  it('NEVER auto-runs export_transactions_csv (export stays confirm-gated)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const ctx = ctxFor(db, { documentIds: [id] }, 'summarize and reconcile')
    await bankStatementAnalysisHandler.run!(ctx)

    const toolNames = ctx.events.map((e) => e.meta?.toolName)
    expect(toolNames).toContain('extract_transactions')
    expect(toolNames).toContain('summarize_cashflow')
    expect(toolNames).toContain('validate_statement_balances')
    expect(toolNames).not.toContain('export_transactions_csv')
    // No skill run ever targeted the export tool.
    const exportRuns = db
      .prepare("SELECT COUNT(*) AS n FROM skill_runs")
      .get() as { n: number }
    expect(exportRuns.n).toBe(3) // extract + summarize + validate; categorize NOT run (not category-shaped)
  })

  it('runs categorize only for a category-shaped question, and shows a per-category breakdown', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const ctx = ctxFor(db, { documentIds: [id] }, 'break down my spending by category')
    const res = await bankStatementAnalysisHandler.run!(ctx)

    expect(ctx.events.map((e) => e.meta?.toolName)).toContain('categorize_transactions')
    expect(res.answer).toContain(tr('skills.bankAnalysis.categoryHeading'))
    expect(res.answer).toContain('Income') // Salary → Income (built-in rule)
  })

  it('downgrades to honesty (NO total) when the statement prints no opening/closing balance (D56)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // reconciles per-row, but no opening/closing balance to PROVE completeness
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))

    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    // A partial read must NEVER surface as a confident total/net.
    expect(res.answer).not.toContain('Net change')
    expect(res.answer).not.toContain('2454.10')
  })

  it('presents a total only once the opening + Σ == closing balance ties out (D56)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))
    expect(res.answer).toContain('Net change')
    expect(res.answer).toContain('2454.10')
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
  })

  it('downgrades when a printed closing balance does NOT tie out with the rows (D56)', async () => {
    const db = freshDb()
    // Opening 2000.00 + Σ 2454.10 = 4454.10, but the statement prints a closing of 9999.99 → no proof.
    const id = seedDoc(
      db,
      'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
        '2026-01-03 Salary 2.500,00 4.454,10\nClosing balance 9.999,99'
    )
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('Net change')
  })

  it('coverage is extract with fullyChunked TRUE when the document is fully chunked', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN, { fullyChunked: true })
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summary'))
    expect(res.coverage!.mode).toBe('extract')
    expect(res.coverage!.chunksTotal).toBe(3) // 3 seeded chunk rows
    expect(res.coverage!.chunksCovered).toBe(3)
    expect(res.coverage!.fullyChunked).toBe(true) // gates the "whole document" meter wording
  })

  it('coverage fullyChunked is FALSE for a legacy (not fully chunked) document', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // fully_chunked NULL
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summary'))
    expect(res.coverage!.mode).toBe('extract')
    expect(res.coverage!.fullyChunked).toBe(false)
  })

  it('citations are real SOURCE chunks (M2) — never the synthesised total', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize'))

    expect(res.citations.length).toBeGreaterThan(0)
    res.citations.forEach((c, i) => expect(c.label).toBe(`S${i + 1}`))
    // The snippets come from the document's own lines…
    const snippets = res.citations.map((c) => c.snippet ?? '').join('\n')
    expect(snippets).toContain('Grocery')
    expect(snippets).toContain('Salary')
    // …and NEVER carry the synthesised net total (which is not printed anywhere in the source).
    expect(snippets).not.toContain('2454.10')
  })
})

describe('analysis-handler registry', () => {
  it('register/get round-trips by install id; an unknown id returns undefined', () => {
    clearSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID)).toBeUndefined()
    registerSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID, bankStatementAnalysisHandler)
    expect(getSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID)).toBe(bankStatementAnalysisHandler)
    expect(getSkillAnalysisHandler('app:not-a-skill')).toBeUndefined()
  })

  it('registerBuiltinSkillAnalysisHandlers wires the bank handler (D49)', () => {
    clearSkillAnalysisHandlers()
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(BANK_STATEMENT_INSTALL_ID)).toBe(bankStatementAnalysisHandler)
  })
})
