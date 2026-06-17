import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createConversation, exportTranscript, appendMessage } from '../../src/main/services/chat'
import { runBankExtraction } from '../../src/main/services/skills/run'
import type { AuditEventType } from '../../src/shared/types'

// docs/skills-s11-plan.md §6/§7 (S11a) — the app-orchestrated run seam end-to-end on a real DB:
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

describe('runBankExtraction (S11a)', () => {
  it('migration creates skill_runs + bank data tables', () => {
    const db = freshDb()
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name
    )
    expect(names).toContain('skill_runs')
    expect(names).toContain('bank_statements')
    expect(names).toContain('bank_transactions')
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
