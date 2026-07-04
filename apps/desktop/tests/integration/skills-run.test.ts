import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createConversation, exportTranscript, appendMessage } from '../../src/main/services/chat'
import {
  resolveDocumentReader,
  runBankExtraction,
  runBalanceValidation,
  runCategorization,
  runCashflowSummary,
  runCsvExport,
  isBankStatementStale,
  latestBankStatementId,
  type LoadedTransaction
} from '../../src/main/services/skills/run'
import { activeDocumentLockCount } from '../../src/main/services/skills/doc-lock'
import {
  BANK_EXTRACTOR_VERSION,
  reconcileBalances,
  summarizeCashflow,
  type TransactionInput
} from '../../src/main/services/skills/tools/bank-statement'
import type { AuditEventType, DocumentChunkRead } from '../../src/shared/types'

/**
 * Count the `db.prepare` calls whose SQL matches `pattern` while `fn` runs (audit P-1 query-count
 * assertions). `UPDATE … bank_transactions` is excluded by matching `FROM bank_transactions` — only
 * the row LOADS are counted, never the reconciled/category persists.
 */
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

/** Load a statement's rows in the `LoadedTransaction` shape the analysis handler hands to the seams as
 *  `preloaded` (id + tool fields, null columns omitted, row order). */
function loadLoadedRows(db: Db, statementId: string): LoadedTransaction[] {
  const rows = db
    .prepare(
      `SELECT id, row_index AS rowIndex, date, value_date AS valueDate, description, amount, currency,
              balance_after AS balanceAfter, source_page AS sourcePage
       FROM bank_transactions WHERE statement_id = ? ORDER BY row_index`
    )
    .all(statementId) as Array<{
    id: string
    rowIndex: number
    date: string
    valueDate: string | null
    description: string
    amount: number
    currency: string
    balanceAfter: number | null
    sourcePage: number | null
  }>
  return rows.map((r) => {
    const t: LoadedTransaction = {
      id: r.id,
      rowIndex: r.rowIndex,
      date: r.date,
      description: r.description,
      amount: r.amount,
      currency: r.currency
    }
    if (r.valueDate != null) t.valueDate = r.valueDate
    if (r.balanceAfter != null) t.balanceAfter = r.balanceAfter
    if (r.sourcePage != null) t.sourcePage = r.sourcePage
    return t
  })
}

// architecture.md "Skills — design record" §8 (S11a) — the app-orchestrated run seam end-to-end on a real DB:
// build the narrow context → run extract_transactions through the gate → persist. Proves the
// skill_runs lifecycle, the content-class bank tables, frozen scope, the no-partial-persist on
// cancel, the ids/counts-only audit (sentinel grep), and the export exclusion (§9.5).

const SENTINEL = 'XRUN_SENTINEL_secret_payee_42424242'

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-run-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function seedDocWithChunks(db: Db, chunks: Array<{ text: string; page: number | null }>): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Statement', 'indexed', 'application/pdf', ?, ?)`
  ).run(docId, now, now)
  chunks.forEach((c, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'p', ?, ?)`
    ).run(randomUUID(), docId, i, c.text, c.page, now)
  })
  return docId
}

function capturingAudit(): { audit: (t: AuditEventType, m?: Record<string, unknown>) => void; events: unknown[] } {
  const events: unknown[] = []
  return { audit: (type, meta) => events.push({ type, meta }), events }
}

describe('resolveDocumentReader — layout flag is threaded only when requested (D58)', () => {
  it('requests layout reconstruction ONLY when deps.layout is set (bank-statement), else text mode', async () => {
    const db = freshDb()
    const seen: Array<{ layout?: boolean } | undefined> = []
    const readDocumentSegments = async (
      _id: string,
      opts?: { layout?: boolean }
    ): Promise<DocumentChunkRead[]> => {
      seen.push(opts)
      return [{ text: '2026-01-02 Coffee -3,50 100,00', page: 1, index: 0 }]
    }

    // Bank-statement path sets layout:true → the segment reader is asked for geometry reconstruction.
    await resolveDocumentReader(db, 'doc', { readDocumentSegments, layout: true })
    expect(seen.at(-1)).toEqual({ layout: true })

    // Redaction/invoice paths leave layout unset → text mode (byte-unchanged), never layout:true.
    await resolveDocumentReader(db, 'doc', { readDocumentSegments })
    expect(seen.at(-1)).toEqual({ layout: undefined })
  })
})

describe('runBankExtraction (S11a)', () => {
  it('migration creates skill_runs + bank data tables (incl. the S11c additive tables/columns)', () => {
    const db = freshDb()
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    expect(names).toContain('skill_runs')
    expect(names).toContain('bank_statements')
    expect(names).toContain('bank_transactions')
    // S11c additive tables.
    expect(names).toContain('bank_categories')
    expect(names).toContain('bank_category_rules')
    expect(names).toContain('bank_corrections')
    // S11c additive columns on bank_transactions (ensureColumn).
    const cols = (db.prepare(`PRAGMA table_info(bank_transactions)`).all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['category_id', 'reconciled', 'confidence']))
  })

  it('isBankStatementStale: an older statement is STALE now the extractor is at v9 (R7 date-vs-money bump); current is fresh', async () => {
    // C-4 moved the version 1 → 2; the full-audit-2026-06-29 follow-up Phase 1 (FIN-1/3/4) moved it 2 → 3;
    // skills-remediation R1 (audit §5.3, Unicode normalization pre-pass) moved it 3 → 4; R2 (audit §5.4,
    // `Kontostand am`/`zum` balance labels) moved it 4 → 5; R5 (audit §5.7, anchor-gated year completion +
    // cross-year rollover) moved it 5 → 6; R6 (audit §5.7, wrapped-description continuation) moved it 6 → 7;
    // U1 (audit §2.3, droppedRowCount + currency-adjacent balance read) moved it 7 → 8; R7 (skills-audit-
    // 2026-07-03 SKA-1/2/13, date-vs-money disambiguation) moves it 8 → 9, so every statement an OLDER
    // (v8…v1 / pre-versioning NULL) parser produced must re-extract via the A9 path. A fresh extraction
    // is stamped at the current version → never stale.
    expect(BANK_EXTRACTOR_VERSION).toBe(9)
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: 'Statement EUR\n2026-01-02 Coffee -3,50 100,00', page: 1 }])
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', documentId: docId }, { audit: () => {} })
    const id = res.statementId!
    expect(isBankStatementStale(db, id)).toBe(false) // freshly stamped at the current version

    db.prepare('UPDATE bank_statements SET extractor_version = 4 WHERE id = ?').run(id)
    expect(isBankStatementStale(db, id)).toBe(true) // produced by the pre-R2 parser → re-extract
    db.prepare('UPDATE bank_statements SET extractor_version = NULL WHERE id = ?').run(id)
    expect(isBankStatementStale(db, id)).toBe(true) // legacy / pre-versioning → re-extract
    // SKA-26 (R9): the DOWNGRADE half — rows a NEWER extractor wrote are stale to this (older) code
    // too. On a rollback the newer extractor IS the suspected bug, so serving its rows as fresh would
    // be exactly backwards; `!==` (not `<`) makes the mismatch symmetric. Deterministic extractors
    // make this safe (same version ⇒ same rows ⇒ no re-extract loop).
    db.prepare('UPDATE bank_statements SET extractor_version = ? WHERE id = ?').run(BANK_EXTRACTOR_VERSION + 1, id)
    expect(isBankStatementStale(db, id)).toBe(true) // written by a newer app → re-extract after rollback
  })

  it('runs end-to-end: persists statement + transactions and marks the run done', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const docId = seedDocWithChunks(db, [
      { text: 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10', page: 1 }
    ])
    const { audit, events } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', conversationId: conv.id, documentId: docId }, { audit })

    expect(res.ok).toBe(true)
    expect(res.transactionCount).toBe(2)
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(run.status).toBe('done')
    expect(run.result_ref).toBe(res.statementId)
    const statementId = res.statementId!
    const stmt = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(statementId) as Record<string, unknown>
    expect(stmt.document_id).toBe(docId)
    expect(stmt.currency).toBe('EUR')
    const txs = db.prepare('SELECT * FROM bank_transactions WHERE statement_id = ? ORDER BY row_index').all(statementId) as Array<Record<string, unknown>>
    expect(txs).toHaveLength(2)
    expect(txs[0]).toMatchObject({ description: 'Grocery', amount: -45.9, currency: 'EUR', source_page: 1 })
    // The gate audited the run, ids/counts only.
    expect((events as Array<{ type: string }>).map((e) => e.type)).toEqual(['skill_run_started', 'skill_run_done'])
  })

  it('reads the injected VERBATIM segments, not the (newline-collapsed) chunks table', async () => {
    const db = freshDb()
    // Simulate the PRODUCTION chunk shape: the retrieval windows collapse every newline to a space,
    // so the line-oriented parser reading THIS would see one giant "line" → at most one garbled row.
    const collapsed = 'Statement EUR 2026-01-02 Grocery -45,90 1.954,10 2026-01-03 Salary 2.500,00 4.454,10'
    const docId = seedDocWithChunks(db, [{ text: collapsed, page: 1 }])
    // The faithful, newline-preserving segments the IPC supplies via extractDocumentPreview.
    const segments = [
      {
        text: 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10',
        page: 1,
        index: 0
      }
    ]
    const { audit } = capturingAudit()
    const res = await runBankExtraction(
      db,
      { skillInstallId: 'app:bank-statement', documentId: docId },
      { audit, readDocumentSegments: async () => segments }
    )
    expect(res.ok).toBe(true)
    // Both rows parse from the verbatim segments; the collapsed chunk text would have yielded ≤1.
    expect(res.transactionCount).toBe(2)
    const descs = (
      db.prepare('SELECT description FROM bank_transactions ORDER BY row_index').all() as Array<{
        description: string
      }>
    ).map((r) => r.description)
    expect(descs).toEqual(['Grocery', 'Salary'])
  })

  it('a failing verbatim re-extraction surfaces as a terminal failed run (B4)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 Coffee -3,50', page: 1 }])
    const { audit } = capturingAudit()
    const res = await runBankExtraction(
      db,
      { skillInstallId: 'app:bank-statement', documentId: docId },
      {
        audit,
        readDocumentSegments: async () => {
          throw new Error('stored copy is gone')
        }
      }
    )
    expect(res.ok).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  it('a DB error before the gate still drives the run to a terminal state (B4 — no stranded "started")', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 Coffee -3,50', page: 1 }])
    db.exec('DROP TABLE chunks') // make buildReadDocumentChunks' prepare throw AFTER the started-insert
    const { audit } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', documentId: docId }, { audit })
    expect(res.ok).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed') // never left at 'started'
  })

  it('only persists rows from the requested (in-scope) document', async () => {
    const db = freshDb()
    const docA = seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 FromA -10,00', page: 1 }])
    seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 FromB -99,00', page: 1 }]) // not requested
    const { audit } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', documentId: docA }, { audit })
    expect(res.ok).toBe(true)
    const descs = (db.prepare('SELECT description FROM bank_transactions').all() as Array<{ description: string }>).map(
      (r) => r.description
    )
    expect(descs).toEqual(['FromA']) // FromB was never read (out of the frozen scope)
  })

  it('on cancel: marks the run cancelled and persists NO bank rows', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 Coffee -3,50', page: 1 }])
    const ac = new AbortController()
    ac.abort()
    const { audit, events } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', documentId: docId }, { audit, signal: ac.signal })
    expect(res.ok).toBe(false)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get()).toEqual({ n: 0 })
    expect(events).toEqual([]) // aborted before the gate started a run
  })

  it('sentinel: a secret in a transaction description never reaches audit/log or skill_runs metadata', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    const docId = seedDocWithChunks(db, [{ text: `EUR\n2026-01-02 ${SENTINEL} -12,00`, page: 1 }])
    const { audit, events } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId: 'app:bank-statement', conversationId: conv.id, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    // The secret DOES land in the content-class table (encrypted DB) — that is correct.
    const tx = db.prepare('SELECT description FROM bank_transactions LIMIT 1').get() as { description: string }
    expect(tx.description).toContain(SENTINEL)
    // …but NEVER in the audit stream or the run-history row (ids/counts/refs only).
    expect(JSON.stringify(events)).not.toContain(SENTINEL)
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(JSON.stringify(run)).not.toContain(SENTINEL)
  })

  it('export exclusion: the conversation transcript export carries no bank-run content (§9.5)', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'here is my statement' })
    const docId = seedDocWithChunks(db, [{ text: `EUR\n2026-01-02 ${SENTINEL} -12,00`, page: 1 }])
    const { audit } = capturingAudit()
    await runBankExtraction(db, { skillInstallId: 'app:bank-statement', conversationId: conv.id, documentId: docId }, { audit })
    const { markdown } = exportTranscript(db, conv.id)
    expect(markdown).not.toContain(SENTINEL) // bank rows + skill_runs are not part of the export
  })
})

// architecture.md "Skills — design record" §8 (S11c) — the downstream run seams: they load the LATEST statement for
// the in-scope document, run the PURE tool through the gate with structured input, and persist
// atomically. The export seam is the first FS-write (a stub save here; the real save is the IPC test).

describe('downstream statement seams (S11c)', () => {
  const skillInstallId = 'app:bank-statement'

  async function extractFirst(
    db: Db,
    text = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'
  ): Promise<string> {
    const docId = seedDocWithChunks(db, [{ text, page: 1 }])
    const { audit } = capturingAudit()
    const res = await runBankExtraction(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    return docId
  }

  it('a downstream tool fails friendly when no statement has been extracted yet', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: 'EUR\n2026-01-02 Coffee -3,50', page: 1 }])
    const { audit, events } = capturingAudit()
    const res = await runCashflowSummary(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/first/i)
    expect(res.errorCode).toBe('needsExtraction') // content-free code the renderer localizes (I1)
    expect(events).toEqual([]) // no tool ran ⇒ no audit event
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('failed')
  })

  it('validate persists per-row reconciled flags + reports the verdict', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    expect(res.resultKind).toBe('reconciled')
    expect(res.count).toBe(0) // no mismatches
    const flags = (db.prepare('SELECT reconciled FROM bank_transactions ORDER BY row_index').all() as Array<{
      reconciled: number | null
    }>).map((r) => r.reconciled)
    // The first row is the baseline (no predecessor balance to check) → NULL/unchecked; only the
    // second row is a genuine comparison against its predecessor → reconciled (1).
    expect(flags).toEqual([null, 1])
  })

  it('categorize seeds built-in categories/rules and assigns category_id', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const res = await runCategorization(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    // Built-ins seeded once.
    expect((db.prepare('SELECT COUNT(*) AS n FROM bank_categories').get() as { n: number }).n).toBeGreaterThan(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM bank_category_rules').get() as { n: number }).n).toBeGreaterThan(0)
    // Salary row → Income.
    const salary = db
      .prepare(
        `SELECT c.name FROM bank_transactions t JOIN bank_categories c ON c.id = t.category_id
         WHERE t.description = 'Salary'`
      )
      .get() as { name: string }
    expect(salary.name).toBe('Income')
    // Re-running does not duplicate the built-in rule set.
    const ruleCountBefore = (db.prepare('SELECT COUNT(*) AS n FROM bank_category_rules').get() as { n: number }).n
    await runCategorization(db, { skillInstallId, documentId: docId }, { audit })
    expect((db.prepare('SELECT COUNT(*) AS n FROM bank_category_rules').get() as { n: number }).n).toBe(ruleCountBefore)
  })

  it('summarize is read-only: marks the run done, persists no figures', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const res = await runCashflowSummary(db, { skillInstallId, documentId: docId }, { audit })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('done')
  })

  it('summarize/validate surface the validated tool output equal to the pure function (audit P-1)', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const summary = await runCashflowSummary(db, { skillInstallId, documentId: docId }, { audit })
    const validate = await runBalanceValidation(db, { skillInstallId, documentId: docId }, { audit })
    // The CLEAN fixture's two rows, as the pure tools see them (null columns omitted). The analysis
    // handler now REUSES `output` instead of recomputing, so it must deep-equal a fresh recompute.
    const rows: TransactionInput[] = [
      { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 },
      { date: '2026-01-03', description: 'Salary', amount: 2500, currency: 'EUR', balanceAfter: 4454.1 }
    ]
    expect(summary.output).toEqual(summarizeCashflow(rows))
    expect(validate.output).toEqual(reconcileBalances(rows))
  })

  it('preloaded rows skip the bank_transactions re-query but yield the SAME output (audit P-1)', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const statementId = (
      db.prepare('SELECT id FROM bank_statements WHERE document_id = ?').get(docId) as { id: string }
    ).id
    const loaded = loadLoadedRows(db, statementId) // the analysis handler's single load

    // Baseline (no preload) — each seam loads its own rows.
    const baseSummary = await runCashflowSummary(db, { skillInstallId, documentId: docId }, { audit })
    const baseValidate = await runBalanceValidation(db, { skillInstallId, documentId: docId }, { audit })

    let summary: Awaited<ReturnType<typeof runCashflowSummary>> | undefined
    let validate: Awaited<ReturnType<typeof runBalanceValidation>> | undefined
    const reads = await countPrepares(db, /FROM bank_transactions\b/i, async () => {
      summary = await runCashflowSummary(db, { skillInstallId, documentId: docId }, { audit }, loaded)
      validate = await runBalanceValidation(db, { skillInstallId, documentId: docId }, { audit }, loaded)
    })
    expect(reads).toBe(0) // both seams used the preloaded rows — neither re-queried bank_transactions
    expect(summary!.output).toEqual(baseSummary.output) // identical figures to the self-loading path
    expect(validate!.output).toEqual(baseValidate.output)
    // validate still persisted the reconciled flags against the preloaded ids (unchanged behaviour).
    const flags = (
      db.prepare('SELECT reconciled FROM bank_transactions ORDER BY row_index').all() as Array<{
        reconciled: number | null
      }>
    ).map((r) => r.reconciled)
    expect(flags).toEqual([null, 1])
  })

  it('export produces the CSV, the seam writes it (stub), and reports the row count', async () => {
    const db = freshDb()
    const docId = await extractFirst(db, `Statement EUR\n2026-01-02 ${SENTINEL} -12,00 1.000,00`)
    const { audit, events } = capturingAudit()
    let written: { name: string; content: string } | null = null
    let locksDuringDialog = -1
    const saveTextFile = async (name: string, content: string): Promise<boolean> => {
      // SKA-28 scope pin: the per-document hold must be RELEASED before the save dialog opens — a
      // minutes-open dialog must not block the categorize doctask / chat analysis on this document.
      // No competitor is queued in this test, so a released hold means ZERO live chains here (a
      // variant holding the lock across the dialog reads 1). Recorded, asserted after the run —
      // an expect() throw inside the stub would be swallowed as exportWriteFailed.
      locksDuringDialog = activeDocumentLockCount()
      written = { name, content }
      return true
    }
    const res = await runCsvExport(db, { skillInstallId, documentId: docId }, { audit, saveTextFile, confirmed: true })
    expect(locksDuringDialog).toBe(0)
    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    expect(written!.name).toBe('transactions.csv')
    expect(written!.content).toContain(SENTINEL) // the CSV carries the content (user-chosen file) — correct
    // …but the audit stream never does (ids/counts only); and the run row carries no path/content.
    expect(JSON.stringify(events)).not.toContain(SENTINEL)
    const run = db.prepare('SELECT * FROM skill_runs WHERE id = ?').get(res.runId) as Record<string, unknown>
    expect(JSON.stringify(run)).not.toContain(SENTINEL)
    expect(run.status).toBe('done')
    expect(run.result_ref).toBeNull() // export yields no DB artifact; the path is never recorded
  })

  it('export refuses without confirmation (the gate) — nothing is written', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    let saveCalled = false
    const res = await runCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      saveTextFile: async () => {
        saveCalled = true
        return true
      }
    })
    expect(res.ok).toBe(false)
    expect(saveCalled).toBe(false) // the gate refused before producing/saving anything
  })

  it('export cancelled at the save dialog persists nothing and reports it calmly', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const res = await runCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      saveTextFile: async () => false, // user dismissed the dialog
      confirmed: true
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true) // a dialog dismissal is a cancel, not a failure (B1)
    expect(res.error).toMatch(/cancel/i)
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('export already cancelled before the write opens no save dialog and persists nothing (B2)', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    const ac = new AbortController()
    ac.abort() // Cancel landed before the export reached its FS-write boundary
    let saveCalled = false
    const res = await runCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      signal: ac.signal,
      saveTextFile: async () => {
        saveCalled = true
        return true
      },
      confirmed: true
    })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(saveCalled).toBe(false) // nothing was written under a cancel
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('SKA-27: a transient finishRun(done) failure neither strands started nor reports failure after the write', async () => {
    // The pre-R9 defect: the terminal 'done' UPDATE after the (minutes-open) save dialog was UNGUARDED —
    // a workspace transiently locked mid-dialog threw out of the seam, stranding the skill_runs row at
    // 'started' forever AND telling the user "failed. Nothing was changed." after the file WAS written.
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()

    // Inject the throwing seam: once the file is written, the FIRST terminal `UPDATE skill_runs` throws
    // (the transiently-locked-DB class); the guarded retry must land the second one.
    let fileWritten = false
    let failuresInjected = 0
    const realPrepare = db.prepare.bind(db)
    ;(db as unknown as { prepare: Db['prepare'] }).prepare = ((sql: string) => {
      if (fileWritten && failuresInjected === 0 && /UPDATE skill_runs SET status/.test(sql)) {
        failuresInjected++
        throw new Error('database is locked')
      }
      return realPrepare(sql)
    }) as Db['prepare']

    try {
      const res = await runCsvExport(db, { skillInstallId, documentId: docId }, {
        audit,
        confirmed: true,
        saveTextFile: async () => {
          fileWritten = true
          return true
        }
      })
      expect(failuresInjected).toBe(1) // the injected throw actually fired on the 'done' write
      expect(res.ok).toBe(true) // NEVER "failed. Nothing was changed." after a successful write
      expect(res.count).toBe(2)
      expect(res.error).toBeUndefined()
      const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
      expect(run.status).toBe('done') // the guarded retry landed the terminal status — no stranded 'started'
    } finally {
      ;(db as unknown as { prepare: Db['prepare'] }).prepare = realPrepare
    }
  })

  it('SKA-27: the done timestamp is taken at the WRITE, not before the save dialog', async () => {
    const db = freshDb()
    const docId = await extractFirst(db)
    const { audit } = capturingAudit()
    // Deterministic clock: every now() before the file write returns T_PREP; after it, T_WRITE. The
    // pre-R9 code stamped 'done' with prepareDomainRun's pre-dialog `completedAt` (T_PREP) — run
    // history timestamped an export minutes early when the dialog sat open.
    const T_PREP = '2026-07-04T10:00:00.000Z'
    const T_WRITE = '2026-07-04T10:07:00.000Z'
    let wrote = false
    const res = await runCsvExport(db, { skillInstallId, documentId: docId }, {
      audit,
      confirmed: true,
      now: () => (wrote ? T_WRITE : T_PREP),
      saveTextFile: async () => {
        wrote = true // the dialog "sat open" — every later now() is write-time
        return true
      }
    })
    expect(res.ok).toBe(true)
    const run = db.prepare('SELECT status, completed_at AS c FROM skill_runs WHERE id = ?').get(res.runId) as {
      status: string
      c: string
    }
    expect(run.status).toBe('done')
    expect(run.c).toBe(T_WRITE) // not the pre-dialog prepare time
  })
})

// R3 (audit §5.6): the run-bar buttons (Validate/Summarize) and the CSV export must NEVER serve rows a
// SINCE-FIXED extractor produced — the version bump means those figures were mis-read. `prepareStatementRun`
// re-extracts a stale statement in place before the downstream tool runs, mirroring the analysis-handler
// parity path. These tests seed a COLLAPSED chunk row (the chunk-table fallback would yield ≤1 row) and
// provide FAITHFUL segments, so a re-extraction reading 2 rows proves it read the segments (not the chunks).
describe('R3 — downstream runs re-extract a STALE statement before serving rows (audit §5.6)', () => {
  const COLLAPSED = 'Statement EUR 2026-01-02 Grocery -45,90 1.954,10 2026-01-03 Salary 2.500,00 4.454,10'
  const SEGMENTS: DocumentChunkRead[] = [
    { text: 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10', page: 1, index: 0 }
  ]
  const faithfulReader = async (): Promise<DocumentChunkRead[]> => SEGMENTS
  const ARGS = (docId: string): { skillInstallId: string; documentId: string } => ({
    skillInstallId: 'app:bank-statement',
    documentId: docId
  })

  /** Extract once at the CURRENT version from the faithful segments, then force the row stale. */
  async function seedStaleStatement(db: Db, docId: string): Promise<string> {
    const res = await runBankExtraction(db, ARGS(docId), { audit: () => {}, readDocumentSegments: faithfulReader })
    const id = res.statementId!
    expect(res.transactionCount).toBe(2)
    db.prepare('UPDATE bank_statements SET extractor_version = 2 WHERE id = ?').run(id)
    expect(isBankStatementStale(db, id)).toBe(true)
    return id
  }

  it('Validate re-extracts the stale statement (new id, current version, faithful rows) before reconciling', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const staleId = await seedStaleStatement(db, docId)

    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, ARGS(docId), { audit, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(true)

    const freshId = latestBankStatementId(db, docId)!
    expect(freshId).not.toBe(staleId) // a NEW extraction replaced the stale one
    expect(isBankStatementStale(db, freshId)).toBe(false) // stamped at the current version
    // replaceExisting deleted the stale statement — no accumulation, and the old id is gone.
    const count = (db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1)
    expect(db.prepare('SELECT id FROM bank_statements WHERE id = ?').get(staleId)).toBeUndefined()
    // The re-extraction read the FAITHFUL segments: 2 rows (the collapsed chunk fallback would give ≤1).
    const txCount = (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE statement_id = ?').get(freshId) as { n: number }).n
    expect(txCount).toBe(2)
  })

  it('Summarize re-extracts the stale statement before computing the cashflow (count = re-extracted rows)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const staleId = await seedStaleStatement(db, docId)

    const { audit } = capturingAudit()
    const res = await runCashflowSummary(db, ARGS(docId), { audit, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2) // both re-extracted rows summarized (the stale row set is not served)
    const freshId = latestBankStatementId(db, docId)!
    expect(freshId).not.toBe(staleId)
    expect(isBankStatementStale(db, freshId)).toBe(false)
  })

  it('CSV export re-extracts the stale statement and writes the FRESH rows', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const staleId = await seedStaleStatement(db, docId)

    let written = ''
    const { audit } = capturingAudit()
    const res = await runCsvExport(db, ARGS(docId), {
      audit,
      confirmed: true,
      readDocumentSegments: faithfulReader,
      saveTextFile: async (_name, content) => {
        written = content
        return true
      }
    })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2) // two re-extracted rows exported (not the stale set)
    // The written CSV carries BOTH faithful rows — the collapsed chunk fallback could not have produced them.
    expect(written).toContain('Grocery')
    expect(written).toContain('Salary')
    const freshId = latestBankStatementId(db, docId)!
    expect(isBankStatementStale(db, freshId)).toBe(false)
  })

  it('a FRESH statement is NOT re-extracted (same id, no duplicate) — re-extraction only fires when stale', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const res0 = await runBankExtraction(db, ARGS(docId), { audit: () => {}, readDocumentSegments: faithfulReader })
    const freshId = res0.statementId!
    expect(isBankStatementStale(db, freshId)).toBe(false)

    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, ARGS(docId), { audit, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(true)
    // The statement id is unchanged and there is still exactly ONE statement — nothing re-extracted.
    expect(latestBankStatementId(db, docId)).toBe(freshId)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1)
  })

  it('a stale statement whose re-extraction FAILS fails the run with needsExtraction (no bad rows served)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const staleId = await seedStaleStatement(db, docId)

    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, ARGS(docId), {
      audit,
      readDocumentSegments: async () => {
        throw new Error('stored copy is gone')
      }
    })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('needsExtraction') // the plan's decision: fail with the existing code
    // The stale statement is NOT deleted on a failed re-extraction (the DELETE only runs inside a
    // successful persist), and no wrong figures were served.
    expect(db.prepare('SELECT id FROM bank_statements WHERE id = ?').get(staleId)).toBeDefined()
  })

  it('a user CANCEL mid-re-extraction is reported cancelled (not a needsExtraction failure)', async () => {
    // Regression for a run-bar defect the re-extraction introduced: a deliberate cancel during the stale
    // re-extraction must surface as `cancelled` (run history 'cancelled'), NOT a 'failed' run with the
    // misleading "read the statement first" needsExtraction message.
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    await seedStaleStatement(db, docId)

    const ac = new AbortController()
    ac.abort() // Cancel landed before the re-extraction's gate ran → runSkillTool returns cancelled
    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, ARGS(docId), { audit, signal: ac.signal, readDocumentSegments: faithfulReader })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(res.errorCode).toBeUndefined() // NOT needsExtraction — a cancel is not a failure
    const run = db.prepare('SELECT status FROM skill_runs WHERE id = ?').get(res.runId) as { status: string }
    expect(run.status).toBe('cancelled')
  })

  it('a stale statement is NOT re-extracted when the caller supplies preloaded rows (guard for the analysis lane)', async () => {
    // The `preloaded === undefined` half of the guard: the analysis lane re-extracts a stale statement
    // ITSELF and then hands the fresh rows down as `preloaded`. Re-extracting again here would DELETE the
    // very rows it handed us (stranding the persist that targets their ids). So even a STALE statement must
    // be left untouched when preloaded rows are supplied. Dropping the sub-condition would fail this test.
    const db = freshDb()
    const docId = seedDocWithChunks(db, [{ text: COLLAPSED, page: 1 }])
    const staleId = await seedStaleStatement(db, docId)
    const preloaded = loadLoadedRows(db, staleId)

    const { audit } = capturingAudit()
    const res = await runBalanceValidation(db, ARGS(docId), { audit, readDocumentSegments: faithfulReader }, preloaded)
    expect(res.ok).toBe(true)
    // No re-extraction: the SAME (still-stale) statement is served — the caller owns the freshness decision.
    expect(latestBankStatementId(db, docId)).toBe(staleId)
    expect(isBankStatementStale(db, staleId)).toBe(true)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(docId) as { n: number }).n
    expect(count).toBe(1) // no duplicate spawned
  })
})
