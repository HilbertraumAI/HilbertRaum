import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { DocTaskManager, type DocTaskDeps } from '../../src/main/services/doctasks'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// Phase 33 — the `categorize` document task (the bank-statement LLM categorizer's lane). CI posture:
// zero model, zero network — a scripted runtime (or none, for the deterministic fallback). Covers:
// the model path persists `category_id`; the no-runtime path degrades to the deterministic rule pass;
// and the (D) ordering fix — categorize AUTO-EXTRACTS when no statement exists yet.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-doccat-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Ingest a .txt with explicit content (newlines preserved in the parser segments). */
async function importText(content: string, name = 'statement.txt'): Promise<string> {
  const p = join(tmp, name)
  writeFileSync(p, content, 'utf8')
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id, {})
  expect(done.status).toBe('indexed')
  return info.id
}

/** Seed a bank_statements row + transactions directly (skips the auto-extract path). */
function seedStatement(documentId: string, rows: Array<{ desc: string; amount: number }>): string {
  const stmtId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bank_statements (id, document_id, run_id, period_start, period_end, currency, opening_balance, closing_balance, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'EUR', NULL, NULL, ?)`
  ).run(stmtId, documentId, now)
  const ins = db.prepare(
    `INSERT INTO bank_transactions (id, statement_id, run_id, row_index, date, value_date, description, amount, currency, balance_after, source_page, created_at)
     VALUES (?, ?, NULL, ?, '2026-03-01', NULL, ?, ?, 'EUR', NULL, NULL, ?)`
  )
  rows.forEach((r, i) => ins.run(randomUUID(), stmtId, i, r.desc, r.amount, now))
  return stmtId
}

/** A scripted runtime that maps each batch row's description to a category via `map`. */
function scriptedRuntime(map: (desc: string) => string): ModelRuntime {
  return {
    modelId: 'mock',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const user = messages[1].content
      const lines = user.split('\n').filter((l) => /^\d+\t/.test(l))
      const assignments = lines.map((l) => {
        const [idx, , ...rest] = l.split('\t')
        return { index: Number(idx), category: map(rest.join('\t')) }
      })
      const text = JSON.stringify({ assignments })
      for (const tok of text.match(/\S+\s*/g) ?? [text]) {
        if (options?.signal?.aborted) return
        yield tok
      }
    }
  }
}

function makeManager(runtime: ModelRuntime | null): DocTaskManager {
  const deps: DocTaskDeps = {
    getDb: () => db,
    getRuntime: () => runtime,
    isChatStreaming: () => false,
    getContextTokens: () => 4096,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({}),
    beginDocumentWork: () => () => {}
  }
  return new DocTaskManager(deps)
}

async function waitTerminal(mgr: DocTaskManager, jobId: string): Promise<ReturnType<DocTaskManager['getDocTask']>> {
  const start = Date.now()
  for (;;) {
    const s = mgr.getDocTask(jobId)
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') return s
    if (Date.now() - start > 10_000) throw new Error(`task ${jobId} never finished: ${s.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** The persisted category name per row (LEFT JOIN), in row order. */
function persistedCategories(statementId: string): Array<string | null> {
  return (
    db
      .prepare(
        `SELECT c.name AS name FROM bank_transactions t
         LEFT JOIN bank_categories c ON c.id = t.category_id
         WHERE t.statement_id = ? ORDER BY t.row_index`
      )
      .all(statementId) as Array<{ name: string | null }>
  ).map((r) => r.name ?? null)
}

describe('categorize doctask — model path', () => {
  it('persists model-assigned categories (incl. the richer taxonomy)', async () => {
    const docId = await importText('Umsätze EUR\nplaceholder')
    const stmtId = seedStatement(docId, [
      { desc: 'Gebühr Kontofuehrung', amount: -3.5 }, // prefiltered → Fees (no model)
      { desc: 'REWE Markt', amount: -45.9 },
      { desc: 'Amazon Bestellung', amount: -20 }
    ])
    const mgr = makeManager(scriptedRuntime((d) => (d.includes('REWE') ? 'Groceries' : 'Shopping')))
    const { jobId } = mgr.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const status = await waitTerminal(mgr, jobId)

    expect(status.state).toBe('done')
    expect(persistedCategories(stmtId)).toEqual(['Fees', 'Groceries', 'Shopping'])
  })
})

describe('categorize doctask — no runtime (deterministic fallback)', () => {
  it('degrades to the deterministic rule pass and still persists category_id', async () => {
    const docId = await importText('Umsätze EUR\nplaceholder')
    const stmtId = seedStatement(docId, [
      { desc: 'Gehalt ACME', amount: 2500 }, // Income rule
      { desc: 'Unklare Buchung', amount: -9.99 } // negative sign → Spending
    ])
    const mgr = makeManager(null)
    const { jobId } = mgr.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const status = await waitTerminal(mgr, jobId)

    expect(status.state).toBe('done')
    expect(persistedCategories(stmtId)).toEqual(['Income', 'Spending'])
  })
})

describe('categorize doctask — auto-extract (the (D) ordering fix)', () => {
  it('extracts the statement first when none exists, then categorizes', async () => {
    // A bank-statement-shaped .txt with NO prior extraction — clicking categorize before extract.
    const docId = await importText(
      'Umsätze EUR\n2026-03-01 Gehalt ACME 2.500,00\n2026-03-02 Miete -800,00\n2026-03-03 Gebühr -3,50'
    )
    const mgr = makeManager(null) // deterministic — the point is the auto-extract, not the model
    const { jobId } = mgr.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const status = await waitTerminal(mgr, jobId)
    expect(status.state).toBe('done')

    // A statement was created by the auto-extract, and its rows carry categories.
    const stmt = db
      .prepare('SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(docId) as { id: string } | undefined
    expect(stmt).toBeTruthy()
    const cats = persistedCategories(stmt!.id)
    expect(cats.length).toBeGreaterThan(0)
    expect(cats.every((c) => c != null)).toBe(true)
  })
})
