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
import { BANK_FIXTURES } from '../fixtures/real-layouts/corpus'

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

/** Count the `db.prepare` calls whose SQL matches `pattern` while `fn` runs (audit P-1 query-count).
 *  Matching `FROM bank_transactions` counts only row LOADS, never the reconciled/category UPDATEs. */
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

// A 4-column DACH layout (Buchungstag + Valuta value date + Betrag + Saldo) with printed opening/closing
// balances that tie out. Before the BL-1 fix the leading value date was read as the amount (the row
// dropped or mis-valued); now every row parses with the real amount and feeds the VERIFIED total.
const TWO_DATE_COMPLETE =
  'Kontoauszug EUR\nAnfangssaldo 2.000,00\n' +
  '06.06.2026 07.06.2026 Supermarkt Billa -45,90 1.954,10\n' +
  '08.06.2026 09.06.2026 Gehalt ACME 2.500,00 4.454,10\n' +
  'Endsaldo 4.454,10'

// A TYING statement whose closing line carries a TRAILING date (BL-N2) and whose first row hides a
// money-shaped reference (100,00 EUR) before the real amount (BL-N3). opening 2000 + (−100 + 2500) ==
// closing 4400 must read as a VERIFIED total. Before the Phase-1 fixes the in-description 100,00 became
// the amount AND the closing read '30.06.20' → 3006.20, so the tie failed → a false refusal.
const TRAILING_DATE_COMPLETE =
  'Kontoauszug EUR\nAnfangssaldo 2.000,00\n' +
  '2026-01-02 Betrag 100,00 EUR -100,00 1.900,00\n' +
  '2026-01-03 Gehalt 2.500,00 4.400,00\n' +
  'Endsaldo 4.400,00 EUR per 30.06.2026'

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

  // Regression: German verb/noun phrasings that miss the English keywords. "Kategorisiere die
  // Transaktionen" is category-shaped (kategor…) but the verb "kategorisiere" ⊄ "kategorie" and the noun
  // "Transaktionen" ⊄ the English "transaction" — so it was NOT analysis-shaped, fell through to generic
  // RAG, and overflowed the context window on a long Kontoauszug. Category-shaped ⟹ analysis-shaped now.
  it.each([
    'Kategorisiere die Transaktionen',
    'Zeig mir alle Transaktionen',
    'Fasse den Geldfluss zusammen'
  ])('applies on the de-AT phrasing %j (context-overflow regression)', (question) => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN)
    expect(bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(true)
  })
})

describe('bank-statement analysis handler — date-order caveat (R5, §5.7)', () => {
  // An all-ambiguous statement (every dotted date has BOTH fields ≤ 12): day-first is applied with NO
  // evidence, so the answer must carry ONE honest date caveat. Opening + Σ == closing ⇒ a verified total.
  const AMBIGUOUS =
    'Statement EUR\nOpening balance 2.000,00\n03.05.2026 Grocery -45,90 1.954,10\n' +
    '04.06.2026 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'

  it('appends the day-first caveat (en) when the document gives no date-order evidence', async () => {
    const db = freshDb()
    const id = seedDoc(db, AMBIGUOUS)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(res.answer).toContain(t('en', 'skills.bankAnalysis.dateOrderCaveat'))
  })

  it('appends the day-first caveat rendered in German (du-form) when tr is de', async () => {
    const db = freshDb()
    const id = seedDoc(db, AMBIGUOUS)
    const ctx = {
      ...ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'),
      tr: (k: MessageKey, p?: MessageParams) => t('de', k, p)
    }
    const res = await bankStatementAnalysisHandler.run!(ctx)
    expect(res.answer).toContain(t('de', 'skills.bankAnalysis.dateOrderCaveat'))
    expect(res.answer).not.toContain(' Sie ') // du-form: the new caveat never says Sie
  })

  it('adds NO caveat when the dates carry evidence (COMPLETE uses ISO dates ⇒ the guess is moot)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(res.answer).not.toContain(t('en', 'skills.bankAnalysis.dateOrderCaveat'))
  })

  // Regression guard for the 4-digit-only ambiguity-sniff gap: a statement whose booking dates are all
  // 2-digit-year (dd.mm.yy) — the exact cohort R5 newly parses — must still fire the day-first caveat. The
  // ISO `Statement date` line supplies the year anchor (so the yy rows parse) but does NOT vote, so the yy
  // booking dates are the ONLY order-ambiguous dates. Before the fix this answered with NO caveat.
  const YY_AMBIGUOUS =
    'Statement date 2026-01-31 EUR\nOpening balance 2.000,00\n03.05.26 Grocery -45,90 1.954,10\n' +
    '04.06.26 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'

  it('appends the caveat on a dd.mm.yy statement whose only order-ambiguous dates are 2-digit-year', async () => {
    const db = freshDb()
    const id = seedDoc(db, YY_AMBIGUOUS)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    // The yy rows parsed against the anchor (proving R5 extraction), AND the caveat fired (proving the fix).
    expect(res.answer).toContain(t('en', 'skills.bankAnalysis.count', { count: 2 }))
    expect(res.answer).toContain(t('en', 'skills.bankAnalysis.dateOrderCaveat'))
  })
})

describe('bank-statement analysis handler — honest completeness gate (U1, §2.3)', () => {
  // One good row + one row the parser DROPS as an ambiguous balance-as-amount ("Sparen 50 …" — a lone
  // money token with a bare-number-trailing description on a balance-column statement). droppedRowCount = 1.
  const ONE_DROPPED =
    'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Sparen 50 1.234,56'

  it('gates the count line: droppedRowCount > 0 ⇒ the honest partial headline, not "the whole statement"', async () => {
    const db = freshDb()
    const id = seedDoc(db, ONE_DROPPED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    // One row survived; one money-bearing line was dropped → the partial headline (count 1, dropped 1).
    expect(res.answer).toContain(tr('skills.bankAnalysis.countPartial', { count: 1, dropped: 1 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 1 }))
  })

  // A per-row printed balance that the amounts refute ⇒ status 'contradicted'; both rows parse (dropped 0).
  const CONTRADICTED =
    'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
    '2026-01-03 Salary 2.500,00 9.999,99\nClosing balance 9.999,99'

  it('gates the count line: a CONTRADICTED statement drops the "whole statement" claim (self-contradiction fix)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CONTRADICTED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(res.answer).toContain(tr('skills.bankAnalysis.countContradicted', { count: 2 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    // The body still refuses a total (the balances don't tie) — the count line no longer contradicts it.
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
  })

  it('a clean, complete statement keeps the plain "across the whole statement" count (no false gate)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 0 }))
  })

  // D56 completeness PROOF outranks the parse-gap gate: opening 100 + kept Salary 100 == closing 200 ties out,
  // so the ambiguous dropped "Foo 1234 50,00" line provably didn't move the balance (a non-transaction figure).
  // The read IS the whole statement, so the headline must be the plain count — NOT a countPartial hedge over a
  // body that presents the proven-whole total (the self-contradiction the review caught).
  const COMPLETE_WITH_DROPPED =
    'Statement EUR\nOpening balance 100,00\n2026-01-02 Salary 100,00 200,00\n' +
    '2026-01-03 Foo 1234 50,00\nClosing balance 200,00'

  it('D56 complete OUTRANKS the parse-gap gate: a tying statement with a dropped line keeps the whole-statement count', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE_WITH_DROPPED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 1 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.countPartial', { count: 1, dropped: 1 }))
    // The body presents the verified total (complete), and it no longer contradicts the headline.
    expect(res.answer).toContain(tr('skills.bankAnalysis.caveat'))
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

  it('issues ONE bank_transactions read per analysis question (audit P-1): the seams reuse the single load', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    // Warm-up extracts a FRESH statement so the measured run reuses it (no re-extraction in the window).
    await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))
    const reads = await countPrepares(db, /FROM bank_transactions\b/i, async () => {
      await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    })
    // Was THREE before Phase 4 (summarize seam load + validate seam load + the handler's own load); now
    // the handler loads once and hands the rows to both seams as `preloaded`, so neither re-queries.
    // TEST-N5: assert the OUTCOME (no DUPLICATE load) rather than an exact count — a safe refactor
    // that loads zero extra times still passes; a regression that re-queries (2+) still fails.
    expect(reads).toBeLessThanOrEqual(1)
  })

  it('figures are quoted, never invented — no fabricated number leaks into the answer', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'totals?'))
    // The only DISTINCT figures present are the three derived totals (the transaction listing re-prints
    // the two row amounts 45.90 / 2500.00, which are a SUBSET of those — no new number is invented; the
    // opening/closing balances that proved completeness are NOT re-printed).
    const numbers = [...new Set(res.answer.match(/\d+\.\d{2}/g) ?? [])].sort()
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
    // The transaction listing still appears even on the refusal — the user can SEE the rows that were read.
    expect(res.answer).toContain(tr('skills.bankAnalysis.transactionsHeading'))
  })

  it('4-column Buchung/Valuta statement: rows parse with the real amount and feed the verified total (BL-1 e2e)', async () => {
    const db = freshDb()
    const id = seedDoc(db, TWO_DATE_COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))

    // Both rows parsed (count 2) — neither dropped by the leading value-date column.
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    // Money in 2500.00, out 45.90, net 2454.10 — the value date never became a 706.20-style amount.
    expect(res.answer).toContain('2500.00')
    expect(res.answer).toContain('45.90')
    expect(res.answer).toContain('2454.10')
    expect(res.answer).not.toContain('706.20') // no misread value-date fragment leaks as an amount
    // opening 2000.00 + Σ 2454.10 == closing 4454.10 ties out → the VERIFIED (whole-document) caveat,
    // not the unverified labelled-sum caveat and not the refusal.
    expect(res.answer).toContain(tr('skills.bankAnalysis.caveat'))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 2 }))
  })

  it('trailing-date closing + in-description money: the TYING statement presents the VERIFIED total (BL-N2/BL-N3 e2e)', async () => {
    const db = freshDb()
    const id = seedDoc(db, TRAILING_DATE_COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))

    // Both rows parse with the real amounts (−100 + 2500); the in-description 100,00 never became the amount.
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    expect(res.answer).toContain('2500.00') // money in
    expect(res.answer).toContain('100.00') // money out (the real −100 amount, not the 100,00 reference)
    expect(res.answer).toContain('2400.00') // net change
    expect(res.answer).not.toContain('3006.20') // the trailing date never became the closing balance
    // opening 2000 + Σ 2400 == closing 4400 ties out → the VERIFIED caveat, not the refusal.
    expect(res.answer).toContain(tr('skills.bankAnalysis.caveat'))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
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
    // Deterministic rule pass only — NOT labelled model-assisted.
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.categoryAssisted'))
    // …but it IS labelled a quick rule-based grouping that points at the Categorize button (audit C-2),
    // so the chat breakdown and the (model-assisted) button result are not silently divergent.
    expect(res.answer).toContain(tr('skills.bankAnalysis.categoryRuleBased'))
  })

  it('reads PERSISTED categories (Phase 33) and labels a model-assigned breakdown model-assisted', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    // First call extracts + deterministically categorizes the statement (creates the statement).
    await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'break down spending by category'))
    const stmt = db
      .prepare('SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(id) as { id: string }

    // Simulate the LLM categorizer doctask having assigned a RICHER category (outside the rule set).
    const now = new Date().toISOString()
    const catId = randomUUID()
    db.prepare('INSERT INTO bank_categories (id, name, builtin, created_at) VALUES (?, ?, 1, ?)').run(
      catId,
      'Groceries',
      now
    )
    db.prepare(
      `UPDATE bank_transactions SET category_id = ?
       WHERE id = (SELECT id FROM bank_transactions WHERE statement_id = ? ORDER BY row_index LIMIT 1)`
    ).run(catId, stmt.id)

    // The second call REUSES the same statement, so it reads the persisted categories — including the
    // model-assigned "Groceries" — and labels the breakdown model-assisted (it never re-extracts/overwrites).
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'break down spending by category')
    )
    expect(res.answer).toContain('Groceries')
    expect(res.answer).toContain(tr('skills.bankAnalysis.categoryAssisted'))
    // The model-assisted breakdown carries the assisted note, NOT the rule-based one (audit C-2).
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.categoryRuleBased'))
    // No duplicate statement was created (re-extraction is suppressed when one exists).
    const count = db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(id) as {
      n: number
    }
    expect(count.n).toBe(1)
  })

  it('re-extracts and REPLACES a statement produced by an outdated extractor (A9 staleness)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    // First run extracts → a statement stamped with the current extractor version.
    await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))
    const before = db
      .prepare('SELECT id, extractor_version AS v FROM bank_statements WHERE document_id = ?')
      .get(id) as { id: string; v: number }
    expect(before.v).toBeGreaterThanOrEqual(1)

    // Simulate it having been produced by an OLDER parser: blank the version, and tamper a row figure so
    // we can prove the rows are actually re-read (a reuse would keep the bogus 99999).
    db.prepare('UPDATE bank_statements SET extractor_version = NULL WHERE id = ?').run(before.id)
    db.prepare('UPDATE bank_transactions SET amount = 99999 WHERE statement_id = ?').run(before.id)

    // The second run sees the stale statement → re-extracts, REPLACING it (no duplicate accumulation).
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))

    const stmts = db
      .prepare('SELECT id, extractor_version AS v FROM bank_statements WHERE document_id = ?')
      .all(id) as Array<{ id: string; v: number }>
    expect(stmts.length).toBe(1) // the stale one was deleted, not left alongside a fresh copy
    expect(stmts[0].id).not.toBe(before.id) // a fresh statement replaced it
    expect(stmts[0].v).toBeGreaterThanOrEqual(1) // re-stamped at the current version (no longer stale)
    // The tampered figure is gone; the answer reflects the correctly re-extracted rows.
    expect(res.answer).not.toContain('99999')
    expect(res.answer).toContain('2454.10')
  })

  it('REUSES a fresh (current-version) statement — no re-extraction, no duplicate (A9)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))
    const first = db
      .prepare('SELECT id FROM bank_statements WHERE document_id = ?')
      .get(id) as { id: string }
    // The second run reuses the same statement (it is at the current version → not stale).
    await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'total?'))
    const stmts = db
      .prepare('SELECT id FROM bank_statements WHERE document_id = ?')
      .all(id) as Array<{ id: string }>
    expect(stmts.length).toBe(1)
    expect(stmts[0].id).toBe(first.id) // same statement, not re-extracted
  })

  it('localizes the category DISPLAY labels (DE) while persisting canonical English identifiers', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const deTr = (key: MessageKey, params?: MessageParams): string => t('de', key, params)
    const deCtx = { ...ctxFor(db, { documentIds: [id] }, 'break down spending by category'), tr: deTr }
    const res = await bankStatementAnalysisHandler.run!(deCtx)

    // Salary → Income (rule), shown with the German label; the canonical identifier persists in English.
    expect(res.answer).toContain('Einkommen')
    expect(res.answer).not.toContain('- Income:')
    const persisted = db
      .prepare(
        `SELECT c.name AS name FROM bank_transactions t JOIN bank_categories c ON c.id = t.category_id
         WHERE c.name = 'Income' LIMIT 1`
      )
      .get() as { name: string } | undefined
    expect(persisted?.name).toBe('Income')
  })

  it('presents a clearly-LABELLED sum when no opening/closing balance is printed (D56 unverified case)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CLEAN) // reconciles per-row, no opening/closing balance — nothing CONTRADICTS the read
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'what is the total?'))

    // The document never CLAIMS a statement total, so a sum over "the rows I read" is honest + useful —
    // presented WITH the unverified caveat, NOT the refusal (the refusal is now case (B) only).
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    expect(res.answer).toContain('Net change')
    expect(res.answer).toContain('2454.10')
    expect(res.answer).toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 2 }))
    // It must NOT be dressed up as a verified statement total (no proven-whole caveat, no refusal).
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.caveat'))
  })

  // Regression for the reported HVB online "Umsätze" bug: a transaction listing with NO printed
  // opening/closing balance and many EUR rows. It must produce totals + a per-category breakdown + a
  // bounded listing (the user could SEE the rows), all under the unverified caveat — never the refusal.
  it('no-balance "Umsätze" listing: totals + categories + bounded listing under the unverified caveat', async () => {
    const db = freshDb()
    const id = seedDoc(
      db,
      'Umsätze EUR\n' +
        '2026-03-01 Gehalt ACME 2.500,00\n' +
        '2026-03-02 Miete -800,00\n' +
        '2026-03-03 Supermarkt -45,90\n' +
        '2026-03-04 Gebühr Kontofuehrung -3,50\n' +
        '2026-03-05 Überweisung Max -100,00\n' +
        '2026-03-06 Tankstelle -60,00\n' +
        '2026-03-07 Restaurant -32,00\n' +
        '2026-03-08 Apotheke -18,75\n' +
        '2026-03-09 Zinsen 1,20\n' +
        '2026-03-10 Bargeld ATM -200,00\n' +
        '2026-03-11 Kino -25,00\n' +
        '2026-03-12 Abo Streaming -9,99'
    )
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Summiere die Ausgaben je Kategorie')
    )

    // 12 rows read, a presented total, and the per-category breakdown the question asked for.
    expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 12 }))
    expect(res.answer).toContain('Net change')
    expect(res.answer).toContain(tr('skills.bankAnalysis.categoryHeading'))
    expect(res.answer).toContain('Income') // Gehalt → Income (built-in rule)
    expect(res.answer).toContain('Fees') // Gebühr → Fees
    // The honest, labelled caveat — NOT the refusal (this is the user's exact case, now fixed).
    expect(res.answer).toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 12 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    // The bounded listing surfaces the first rows and notes the remainder (12 − 10 = 2 more).
    expect(res.answer).toContain(tr('skills.bankAnalysis.transactionsHeading'))
    expect(res.answer).toContain('Gehalt ACME')
    expect(res.answer).toContain(tr('skills.bankAnalysis.transactionsMore', { count: 2 }))
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

describe('bank-statement analysis handler — W4 answer-shape routing (§3.1/§3.3/§8.1)', () => {
  it('grounded-data path: a non-summary question returns mode grounded-data (data block + postscript), not the template', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    // "what was my largest transaction?" is bank-analysis-shaped ('transaction') but NOT a summary/total/
    // category/list ask, so instead of the wrong in/out/net template it hands the model the verified data.
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'what was my largest transaction?')
    )

    expect(res.mode).toBe('grounded-data')
    expect(res.answer).toBe('') // the template answer is empty; the model answer is streamed by the IPC path
    // The data block is the serialized VERIFIED statement (JSON + reconciliation + provenance).
    expect(res.dataBlock).toContain('Bank statement (JSON):')
    expect(res.dataBlock).toContain('Grocery')
    expect(res.dataBlock).toContain('Salary')
    expect(res.dataBlock).toContain('Quote these figures verbatim')
    // The deterministic per-category grouping rides the block too, so a "how much did I spend on X?"
    // question is answerable — pins the run() `categories ?? categoryTotals(paired)` wiring end-to-end,
    // not just the pure builder (a regression dropping it to [] would otherwise stay green).
    expect(res.dataBlock).toContain('Category totals')
    expect(res.dataBlock).toContain('- Income:') // Salary → Income (built-in rule)
    // The deterministic in/out/net postscript rides beneath (echoed under the model answer downstream).
    expect(res.postscript).toContain('2454.10') // net change, verbatim
    expect(res.postscript).toContain(tr('skills.bankAnalysis.figureEchoNet', { amount: '2454.10', currency: 'EUR' }))
    // Honest extract coverage + real citations pass straight through (source of truth = the extractor).
    expect(res.coverage?.mode).toBe('extract')
    expect(res.citations.length).toBeGreaterThan(0)
  })

  it('summary/total/reconcile/category asks STILL get the deterministic template (mode unset)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    for (const q of [
      'summarize the cashflow',
      'what is the total?',
      'do the balances reconcile?',
      'break down spending by category'
    ]) {
      const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, q))
      expect(res.mode, `"${q}" must keep the template`).toBeUndefined()
      expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    }
  })

  it('format path (JSON): "as JSON" serializes the statement inline — rows + summary + balances, no model, no template', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'give me this statement as JSON')
    )
    expect(res.mode).toBeUndefined()
    const block = /```json\n([\s\S]*?)\n```/.exec(res.answer)
    expect(block, 'a json code block is present').not.toBeNull()
    const parsed = JSON.parse(block![1]) as {
      transactions: unknown[]
      summary: { net: number }
      openingBalance: number | null
    }
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.summary.net).toBe(2454.1)
    expect(parsed.openingBalance).toBe(2000)
    // It did NOT fall through to the prose count template.
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 2 }))
  })

  it('format path (CSV): "as CSV" serializes the transaction rows inline with the honest CSV intro', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'show me the statement as CSV')
    )
    expect(res.mode).toBeUndefined() // the 0-model deterministic short-circuit, not grounded-data
    expect(res.answer).toContain('```csv')
    expect(res.answer).toContain('date,valueDate,description,amount,currency,balanceAfter,sourcePage')
    expect(res.answer).toContain('Grocery')
    // The CSV intro states honestly that CSV omits the summary + balances (§3.6-low precedent).
    expect(res.answer).toContain(tr('skills.bankAnalysis.formatIntroCsv'))
  })

  it('follow-up regression: a repeat "warum stimmen die Summen nicht?" is NOT the byte-identical template', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    // A summary ask first — the deterministic template (the "byte-identical" answer users complained about).
    const first = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, 'summarize the cashflow'))
    expect(first.mode).toBeUndefined()
    // The explanatory follow-up (contains 'summe' but ASKS WHY) must route to grounded-data — the template
    // can only PRINT figures, never explain — so the repeat intercept produces a DIFFERENT (model) answer.
    const second = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'warum stimmen die Summen nicht?')
    )
    expect(second.mode).toBe('grounded-data')
    expect(second.answer).not.toBe(first.answer)
    expect(second.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 2 }))
  })

  it('grounded-data postscript carries the R5 date caveat when dates were read day-first with no evidence', async () => {
    const db = freshDb()
    // All-ambiguous dotted dates + a tying opening/closing → day-first applied with no evidence (R5).
    const id = seedDoc(
      db,
      'Statement EUR\nOpening balance 2.000,00\n03.05.2026 Grocery -45,90 1.954,10\n' +
        '04.06.2026 Salary 2.500,00 4.454,10\nClosing balance 4.454,10'
    )
    // T2 reachability pin (SKA-7 history): pre-W7 this exact string FAILED applies() — the test called
    // run() directly and so pinned a production-UNREACHABLE path. W7's `zahlung`/payment route stems made
    // it reachable; this assertion keeps it that way — if the vocabulary ever regresses, this reds instead
    // of the suite silently validating a path no user can reach. (A T2 sweep checked every other question
    // this suite drives through run(): all pass applies() — this was the only historic bypass.)
    const question = 'what was my biggest payment?'
    expect(bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(true)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question))
    expect(res.mode).toBe('grounded-data')
    // Both the deterministic in/out/net echo AND the R5 caveat ride the postscript (R5 honesty preserved).
    expect(res.postscript).toContain('2454.10')
    expect(res.postscript).toContain(tr('skills.bankAnalysis.dateOrderCaveat'))
  })
})

// W6 (audit §3.1, SKA-4/SKA-5) — the grounded-data honesty COMPOSITION: the mode's postscript + data
// block now honour the D56 completeness gate and the U1 droppedRowCount, end-to-end through run(). A
// non-summary question ("what was my largest transaction?") routes to grounded-data over each fixture.
describe('bank-statement grounded-data honesty composition (W6, §3.1 SKA-4/SKA-5)', () => {
  const NON_SUMMARY = 'what was my largest transaction?'

  it('SKA-4 complete: the postscript echoes the COMPUTED sums (no "verbatim" mislabel), no hedge', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, NON_SUMMARY))
    expect(res.mode).toBe('grounded-data')
    expect(res.postscript).toContain('2454.10')
    expect(res.postscript).toContain('computed') // reworded label (SKA-4, audit §4.5)
    expect(res.postscript).not.toContain('verbatim from the document')
    expect(res.postscript).not.toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 0 }))
    // The data block asserts whole-document provenance (nothing dropped, complete).
    expect(res.dataBlock).toContain('every value above was parsed and reconciled from the whole document')
    expect(res.dataBlock).not.toContain('MISSING')
  })

  // One kept row + one dropped money line, NO printed balances → status 'unverified', dropped 1.
  const ONE_DROPPED = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Sparen 50 1.234,56'
  it('SKA-4/SKA-5 unverified + dropped: echo + unverifiedCaveat + the dropped hedge; data block MISSING note', async () => {
    const db = freshDb()
    const id = seedDoc(db, ONE_DROPPED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, NON_SUMMARY))
    expect(res.mode).toBe('grounded-data')
    // The unverified caveat rides under the echo (SKA-4), and the dropped hedge fires (SKA-5, no balance proof).
    expect(res.postscript).toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 1 }))
    expect(res.postscript).toContain(tr('skills.bankAnalysis.countPartial', { count: 1, dropped: 1 }))
    // The data block honestly declares the missing line (a "how many?" narration can't claim completeness).
    expect(res.dataBlock).toContain('MISSING from this data')
    expect(res.dataBlock).not.toContain('parsed and reconciled from the whole document')
  })

  // D56 PROOF outranks the parse gap: opening 100 + Salary 100 == closing 200 ties, so the dropped
  // "Foo 1234 50,00" line provably didn't move the balance → complete, NO hedge (mirrors the template).
  const COMPLETE_WITH_DROPPED =
    'Statement EUR\nOpening balance 100,00\n2026-01-02 Salary 100,00 200,00\n' +
    '2026-01-03 Foo 1234 50,00\nClosing balance 200,00'
  it('SKA-5 D56 OUTRANKS: complete + dropped>0 → echo present, NO dropped hedge, whole-document provenance', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE_WITH_DROPPED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, NON_SUMMARY))
    expect(res.mode).toBe('grounded-data')
    expect(res.postscript).not.toContain(tr('skills.bankAnalysis.countPartial', { count: 1, dropped: 1 }))
    expect(res.dataBlock).not.toContain('MISSING')
    expect(res.dataBlock).toContain('every value above was parsed and reconciled from the whole document')
  })

  // A per-row balance the amounts refute → status 'contradicted' (dropped 0).
  const CONTRADICTED =
    'Statement EUR\nOpening balance 2.000,00\n2026-01-02 Grocery -45,90 1.954,10\n' +
    '2026-01-03 Salary 2.500,00 9.999,99\nClosing balance 9.999,99'
  it('SKA-4 contradicted: the postscript SUPPRESSES the figure echo (mirrors incompleteNoTotal)', async () => {
    const db = freshDb()
    const id = seedDoc(db, CONTRADICTED)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, NON_SUMMARY))
    expect(res.mode).toBe('grounded-data')
    // No app-authored total under the model answer on a statement the balances refute.
    expect(res.postscript).not.toContain('2454.10')
    expect(res.postscript).not.toContain('computed')
    // The data block still carries the honest contradicted verdict for the model to narrate.
    expect(res.dataBlock).toContain('NOT verified as the whole statement')
  })
})

// W7 (audit §3.2/§3.3/§3.4) — answer-shape + classifier vocabulary tuning, end-to-end through run().
describe('bank-statement W7 answer-shape tuning (SKA-9/SKA-10/SKA-20)', () => {
  it('SKA-9 separable verbs "Fasse … zusammen" / "Liste … auf" keep the D56-gated TEMPLATE (mode unset)', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    for (const q of ['Fasse den Kontoauszug zusammen', 'Liste die Transaktionen auf']) {
      const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, q))
      expect(res.mode, `"${q}" must keep the template`).toBeUndefined()
      expect(res.answer).toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    }
  })

  it('SKA-9 accepted "auf"-preposition over-fire: "Liste die Buchungen auf dem Konto" → template (safe side)', async () => {
    // "auf" doubles as a preposition; the /\blist…\bauf\b/ regex over-fires this to the TEMPLATE — the
    // deterministic side (a listing ask is a template ask anyway). Documented, pinned here.
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Liste die Buchungen auf dem Konto')
    )
    expect(res.mode).toBeUndefined()
  })

  it('SKA-10 explanatory format Q "Warum fehlt der Saldo im JSON?" reaches grounded-data, not the JSON dump', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'Warum fehlt der Saldo im JSON?')
    )
    // The WHY guard suppresses the serializer short-circuit → grounded-data can explain (not re-dump JSON).
    expect(res.mode).toBe('grounded-data')
    expect(res.answer).not.toContain('```json')
  })

  it('SKA-20 "how much did I spend on groceries?" is GROUNDED-DATA (the flagship), not the category template', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'how much did I spend on groceries?')
    )
    expect(res.mode).toBe('grounded-data') // was the category TEMPLATE while 'spend on' ∈ CATEGORY_KEYWORDS
    // The per-category grouping still rides the grounded-data block, so the spend ask is answerable.
    expect(res.dataBlock).toContain('Category totals')
  })

  it('SKA-20 an EXPLICIT "break down … by category" ask STILL gets the category template', async () => {
    const db = freshDb()
    const id = seedDoc(db, COMPLETE)
    const res = await bankStatementAnalysisHandler.run!(
      ctxFor(db, { documentIds: [id] }, 'break down spending by category')
    )
    expect(res.mode).toBeUndefined() // 'by category' still routes to the template
  })
})

// T2 (skills-audit-2026-07-03 §5/§7) — the REAL-LAYOUT honesty fixtures end-to-end: the same corpus
// statements the extractor snapshot pins (tests/fixtures/real-layouts/corpus.ts) run through the FULL
// analysis handler, so the U1 partial/contradicted headlines and the W6 postscript suppression are
// proven over realistic layouts, not only the constructed one-liners above. Questions here are
// production-reachable (they pass applies() — asserted, the T2 reachability discipline).
describe('bank-statement analysis over the real-layout corpus (T2 — U1 headlines + W6 suppression)', () => {
  const fixtureText = (id: string): string => {
    const fx = BANK_FIXTURES.find((f) => f.id === id)
    if (!fx) throw new Error(`corpus fixture ${id} missing`)
    return fx.chunks.join('\n')
  }

  it('bank-at-ocr-dropped-row: the template headline is the honest countPartial (2 kept, 1 dropped) — U1 e2e', async () => {
    // Teeth: revert U1's countPartial gate (headline always the plain count) → red.
    const db = freshDb()
    const id = seedDoc(db, fixtureText('bank-at-ocr-dropped-row'))
    const question = 'summarize the cashflow'
    expect(bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(true)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question))
    expect(res.answer).toContain(tr('skills.bankAnalysis.countPartial', { count: 2, dropped: 1 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    // No printed balance → the totals stay a clearly-labelled unverified sum, never a verified total.
    expect(res.answer).toContain(tr('skills.bankAnalysis.unverifiedCaveat', { count: 2 }))
  })

  it('bank-de-contradicted-closing: the template headline is countContradicted and NO total is presented — U1/D56 e2e', async () => {
    const db = freshDb()
    const id = seedDoc(db, fixtureText('bank-de-contradicted-closing'))
    const question = 'summarize the cashflow'
    expect(bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(true)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question))
    // dropped 0 + a refuted printed balance → the CONTRADICTED headline (not countPartial, not plain).
    expect(res.answer).toContain(tr('skills.bankAnalysis.countContradicted', { count: 2 }))
    expect(res.answer).not.toContain(tr('skills.bankAnalysis.count', { count: 2 }))
    // The body refuses a total (the D56 downgrade) — net 80.00 must never be presented.
    expect(res.answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(res.answer).not.toContain('80.00')
  })

  it('bank-de-contradicted-closing: the grounded-data postscript SUPPRESSES the figure echo — W6 e2e', async () => {
    // Teeth: revert W6's status-gated buildCashflowPostscript (echo unconditional) → red.
    const db = freshDb()
    const id = seedDoc(db, fixtureText('bank-de-contradicted-closing'))
    const question = 'what was my largest transaction?' // non-summary shape → grounded-data
    expect(bankStatementAnalysisHandler.applies({ db, scope: { documentIds: [id] }, question })).toBe(true)
    const res = await bankStatementAnalysisHandler.run!(ctxFor(db, { documentIds: [id] }, question))
    expect(res.mode).toBe('grounded-data')
    // No app-authored in/out/net rides under the model answer on a statement the balances refute.
    expect(res.postscript).not.toContain('80.00')
    expect(res.postscript).not.toContain('computed')
    // The data block still hands the model the honest contradicted verdict to narrate.
    expect(res.dataBlock).toContain('NOT verified as the whole statement')
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
