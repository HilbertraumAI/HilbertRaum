import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { BANK_EXTRACTOR_VERSION } from '../../src/main/services/skills/tools/bank-statement'
import { buildToolRunner, toSkillToolAudit } from '../../src/main/services/skills/tool-runs'
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

/** Seed a bank_statements row + transactions directly (skips the auto-extract path). Stamped with the
 *  CURRENT extractor version so the doctask treats it as fresh (not stale → no A9 re-extraction). */
function seedStatement(documentId: string, rows: Array<{ desc: string; amount: number }>): string {
  const stmtId = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO bank_statements (id, document_id, run_id, period_start, period_end, currency, opening_balance, closing_balance, extractor_version, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'EUR', NULL, NULL, ?, ?)`
  ).run(stmtId, documentId, BANK_EXTRACTOR_VERSION, now)
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

/** The persisted model-assisted flag for a statement (Phase 33 / A8): 1 = LLM consulted, 0 = deterministic. */
function categorizedByModel(statementId: string): number | null {
  const row = db
    .prepare('SELECT categorized_by_model AS flag FROM bank_statements WHERE id = ?')
    .get(statementId) as { flag: number | null } | undefined
  return row?.flag ?? null
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
    // The model was consulted → the authoritative model-assisted flag is persisted (Phase 33 / A8).
    expect(categorizedByModel(stmtId)).toBe(1)
  })

  it('records model-assisted even when every model label happens to be in the rule set (A8)', async () => {
    // The model assigns ONLY rule-set categories (Income/Transfer) — the old name-based heuristic would
    // miss this and label the breakdown deterministic. The persisted flag is the truthful signal.
    const docId = await importText('Umsätze EUR\nplaceholder')
    const stmtId = seedStatement(docId, [
      { desc: 'Acme Werk', amount: 2500 }, // model → Income (in the rule set, but model-assigned)
      { desc: 'Max Mustermann', amount: -100 } // model → Transfer (also in the rule set)
    ])
    const mgr = makeManager(scriptedRuntime((d) => (d.includes('Acme') ? 'Income' : 'Transfer')))
    const { jobId } = mgr.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const status = await waitTerminal(mgr, jobId)

    expect(status.state).toBe('done')
    expect(persistedCategories(stmtId)).toEqual(['Income', 'Transfer'])
    expect(categorizedByModel(stmtId)).toBe(1) // model was involved, despite only in-set labels
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
    // No runtime → deterministic pass → NOT model-assisted (the flag is 0, never null on a completed run).
    expect(categorizedByModel(stmtId)).toBe(0)
  })
})

describe('categorize doctask — A9 staleness re-extraction', () => {
  it('re-extracts (replacing) a statement from an outdated extractor, then categorizes the fresh rows', async () => {
    // A bank-statement-shaped doc with real rows, plus a pre-existing STALE statement (NULL version)
    // whose single row is bogus — the doctask must re-extract (replace) and categorize the corrected rows.
    const docId = await importText('Umsätze EUR\n2026-03-01 Gehalt ACME 2.500,00\n2026-03-02 Gebühr -3,50')
    const staleId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO bank_statements (id, document_id, run_id, period_start, period_end, currency, opening_balance, closing_balance, extractor_version, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 'EUR', NULL, NULL, NULL, ?)`
    ).run(staleId, docId, now)
    db.prepare(
      `INSERT INTO bank_transactions (id, statement_id, run_id, row_index, date, value_date, description, amount, currency, balance_after, source_page, created_at)
       VALUES (?, ?, NULL, 0, '2026-03-01', NULL, 'BOGUS STALE ROW', 1, 'EUR', NULL, NULL, ?)`
    ).run(randomUUID(), staleId, now)

    const mgr = makeManager(null) // deterministic — the point is the re-extraction
    const { jobId } = mgr.startDocTask({ kind: 'categorize', documentIds: [docId] })
    const status = await waitTerminal(mgr, jobId)
    expect(status.state).toBe('done')

    // The stale statement was REPLACED: exactly one remains, a fresh id at the current version.
    const stmts = db
      .prepare('SELECT id, extractor_version AS v FROM bank_statements WHERE document_id = ?')
      .all(docId) as Array<{ id: string; v: number }>
    expect(stmts.length).toBe(1)
    expect(stmts[0].id).not.toBe(staleId)
    expect(stmts[0].v).toBe(BANK_EXTRACTOR_VERSION)
    // The bogus row is gone; the two re-extracted rows are categorized (Gehalt → Income, Gebühr → Fees).
    const cats = persistedCategories(stmts[0].id)
    expect(cats).toEqual(['Income', 'Fees'])
  })
})

describe('categorize doctask — extract does not auto-categorize (U-2)', () => {
  it('an extract run leaves the categorize lane untouched and the rows uncategorized', async () => {
    // U-2 (audit 2026-06-26): a read-only extract no longer silently starts the LLM categorizer. Run
    // the extract through the tool-run dispatch with a FULLY functional doctask lane available — the
    // old Phase-33 auto-offer would have enqueued a `categorize` job here; now nothing touches the lane.
    const text = 'Umsätze EUR\n2026-03-01 Gehalt ACME 2.500,00\n2026-03-02 Gebühr -3,50'
    const docId = await importText(text)
    const mgr = makeManager(null)
    // Spy on the REAL manager: record every job the extract asks it to start (synchronous — the old
    // auto-offer called startDocTask inside the runner before it returned, so a regression is caught).
    const started: Array<{ kind: string }> = []
    const realStart = mgr.startDocTask.bind(mgr)
    mgr.startDocTask = ((req: Parameters<DocTaskManager['startDocTask']>[0]) => {
      started.push(req)
      return realStart(req)
    }) as DocTaskManager['startDocTask']
    const runner = buildToolRunner(
      db,
      'extract_transactions',
      { skillInstallId: 'app:bank-statement', conversationId: '', documentId: docId },
      toSkillToolAudit(),
      { docTasks: mgr, readDocumentSegments: async () => [{ text, page: 1, index: 0 }] }
    )!
    const outcome = await runner({ signal: new AbortController().signal, onProgress: () => {} })
    expect(outcome.ok).toBe(true)
    expect(outcome.transactionCount).toBeGreaterThan(0) // rows WERE extracted (the rows>0 guard would have fired)
    // The doctask lane was never asked to do anything — no hidden model run.
    expect(started).toHaveLength(0)
    // The freshly-extracted rows stay UNcategorized until the user explicitly taps "Categorize".
    const stmt = db
      .prepare('SELECT id FROM bank_statements WHERE document_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(docId) as { id: string }
    expect(persistedCategories(stmt.id).every((c) => c === null)).toBe(true)
  })
})

describe('categorize doctask — persist rollback (T3: no partial categorization survives a failure)', () => {
  it('rolls back the category_id persist on an injected mid-transaction failure; connection not poisoned', async () => {
    // Drive the REAL categorize handler (via the REAL DocTaskManager). Seed a fresh statement so the
    // auto-extract path is skipped and the only `UPDATE bank_transactions SET category_id` is the
    // step-(3) persist (handlers/categorize.ts:110 BEGIN…COMMIT). Mirror the data-layer-hardening
    // gold standard (deleteConversation): wrap the connection so the FIRST persist UPDATE throws
    // mid-transaction — after BEGIN + the in-txn `ensureBuiltinCategories` seed — and assert (a)
    // nothing partial persisted AND (b) the shared connection is not poisoned.
    const docId = await importText('Umsätze EUR\nplaceholder')
    const stmtId = seedStatement(docId, [
      { desc: 'REWE Markt', amount: -45.9 },
      { desc: 'Amazon Bestellung', amount: -20 }
    ])

    // Everything except the targeted row UPDATE hits the real connection (so BEGIN/COMMIT/ROLLBACK and
    // the category seed are genuine); the throw is ONE-shot so a later clean run recovers fully.
    let failOnce = true
    const wrapped = new Proxy(db as object, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (failOnce && sql.includes('UPDATE bank_transactions SET category_id')) {
              return {
                run: () => {
                  failOnce = false
                  throw new Error('injected: category_id persist failed mid-transaction')
                }
              }
            }
            return (target as Db).prepare(sql)
          }
        }
        const val = (target as Record<string | symbol, unknown>)[prop]
        return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val
      }
    }) as unknown as Db

    const runtime = scriptedRuntime((d) => (d.includes('REWE') ? 'Groceries' : 'Shopping'))
    const deps: DocTaskDeps = {
      getDb: () => wrapped,
      getRuntime: () => runtime,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {}
    }
    const mgr = new DocTaskManager(deps)
    const status = await waitTerminal(mgr, mgr.startDocTask({ kind: 'categorize', documentIds: [docId] }).jobId)

    // (a) The task FAILED and NOTHING partial persisted: the rows are still uncategorized, the
    // statement was never marked model-assisted, AND the in-transaction builtin-category seed was
    // rolled back too (the rollback genuinely un-did every in-txn write, not just the row UPDATE).
    expect(status.state).toBe('failed')
    expect(persistedCategories(stmtId)).toEqual([null, null])
    expect(categorizedByModel(stmtId)).toBeNull()
    const catCount = (db.prepare('SELECT COUNT(*) AS n FROM bank_categories').get() as { n: number }).n
    expect(catCount).toBe(0)

    // (b) The shared connection is NOT poisoned — a fresh transaction opens cleanly (it would throw
    // "cannot start a transaction within a transaction" if a BEGIN were left dangling by the failure).
    expect(() => {
      db.exec('BEGIN')
      db.exec('COMMIT')
    }).not.toThrow()

    // A clean re-run (the injection was one-shot) categorizes + persists normally — full recovery.
    const status2 = await waitTerminal(mgr, mgr.startDocTask({ kind: 'categorize', documentIds: [docId] }).jobId)
    expect(status2.state).toBe('done')
    expect(persistedCategories(stmtId)).toEqual(['Groceries', 'Shopping'])
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
