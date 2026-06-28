import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Backend audit 2026-06-27 — Phase 1 (DATA-1 / DOC-1 / MAINT-1 / TEST-1). Deleting a document that
// has bank/invoice extractions used to SHRED the file, delete its chunks/embeddings, then throw
// SQLITE_CONSTRAINT_FOREIGNKEY on the final `DELETE FROM documents` (the bank/invoice tables
// reference documents WITHOUT cascade) — leaving a corrupt, undeletable document. These tests pin
// the fix: deleteDocument now purges every derived row in FK order inside ONE transaction and shreds
// the file only AFTER the commit. The teeth target the EXISTING-drive condition (no cascade), which
// is exactly where the bug bites and where the explicit ordered delete is load-bearing — see
// `degradeSkillTablesToLegacyFk`. A separate test pins the fresh-schema CASCADE (defense-in-depth).
//
// Privacy posture: bank/invoice rows are CONTENT-CLASS, but this teardown touches only ids/row
// counts — nothing here logs or audits a figure.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
  app: { getVersion: () => '0.0.0-test' }
}))

import { openDatabase, type Db } from '../../src/main/services/db'
import { deleteDocument } from '../../src/main/services/ingestion'
import { runBankExtraction } from '../../src/main/services/skills/run'
import { runInvoiceExtraction } from '../../src/main/services/skills/invoice-run'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import { IPC } from '../../src/shared/ipc'
import type { SkillToolAudit } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

// A two-row EUR statement (the skills-run fixture) and a two-line invoice (the skills-invoice
// fixture) fed to the REAL extractors via `readDocumentSegments` so each writes its own rows.
const BANK_SEGMENTS = [
  { text: 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10', page: 1, index: 0 }
]
const INVOICE_SEGMENTS = [
  {
    text: [
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
    ].join('\n'),
    page: 1,
    index: 0
  }
]

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-deldoc-')), 'test.sqlite'))
}

const noopAudit: SkillToolAudit = () => {}

/**
 * Reproduce a drive created BEFORE the DATA-1 fix: the bank/invoice tables reference `documents`
 * (and their parents) with NO `ON DELETE CASCADE`. `CREATE TABLE IF NOT EXISTS` can't alter an
 * existing FK, so a real pre-fix drive keeps the un-cascaded shape — and the explicit ordered delete
 * in `deleteDocument` is the ONLY thing that keeps deletion safe there. We read each table's LIVE DDL
 * (so any migrated columns carry over automatically), strip the cascade, and recreate it. The tables
 * are empty on a fresh DB, so no row copy is needed.
 */
function degradeSkillTablesToLegacyFk(db: Db): void {
  const tables = ['bank_corrections', 'bank_transactions', 'invoice_line_items', 'bank_statements', 'invoices']
  const ddls = new Map<string, string>()
  for (const t of tables) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as
      | { sql: string }
      | undefined
    if (!row) throw new Error(`expected table ${t} to exist`)
    const stripped = row.sql.replaceAll(' ON DELETE CASCADE', '')
    expect(stripped, `${t} DDL should have a cascade to strip`).not.toBe(row.sql)
    ddls.set(t, stripped)
  }
  db.exec('PRAGMA foreign_keys = OFF')
  for (const t of tables) db.exec(`DROP TABLE ${t}`)
  for (const t of ['bank_statements', 'invoices', 'bank_transactions', 'bank_corrections', 'invoice_line_items']) {
    db.exec(ddls.get(t)!)
  }
  db.exec('PRAGMA foreign_keys = ON')
}

function seedDoc(
  db: Db,
  opts: { chunks?: string[]; storedPath?: string | null } = {}
): { docId: string; chunkIds: string[] } {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, stored_path, created_at, updated_at)
     VALUES (?, 'Doc', 'indexed', 'application/pdf', ?, ?, ?)`
  ).run(docId, opts.storedPath ?? null, now, now)
  const chunkIds: string[] = []
  ;(opts.chunks ?? []).forEach((text, i) => {
    const cid = randomUUID()
    chunkIds.push(cid)
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'p', 1, ?)`
    ).run(cid, docId, i, text, now)
  })
  return { docId, chunkIds }
}

/** Count every row that hangs off a document, across the chunk and bank/invoice chains. */
function derivedCounts(db: Db, docId: string): Record<string, number> {
  const n = (sql: string): number => (db.prepare(sql).get(docId) as { n: number }).n
  return {
    documents: n('SELECT COUNT(*) n FROM documents WHERE id = ?'),
    chunks: n('SELECT COUNT(*) n FROM chunks WHERE document_id = ?'),
    embeddings: n('SELECT COUNT(*) n FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)'),
    treeNodes: n('SELECT COUNT(*) n FROM tree_nodes WHERE document_id = ?'),
    bankStatements: n('SELECT COUNT(*) n FROM bank_statements WHERE document_id = ?'),
    bankTransactions: n(
      'SELECT COUNT(*) n FROM bank_transactions WHERE statement_id IN (SELECT id FROM bank_statements WHERE document_id = ?)'
    ),
    bankCorrections: n(
      `SELECT COUNT(*) n FROM bank_corrections WHERE transaction_id IN (
         SELECT t.id FROM bank_transactions t JOIN bank_statements s ON s.id = t.statement_id WHERE s.document_id = ?)`
    ),
    invoices: n('SELECT COUNT(*) n FROM invoices WHERE document_id = ?'),
    invoiceLineItems: n(
      'SELECT COUNT(*) n FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE document_id = ?)'
    )
  }
}

/** Drive the real bank + invoice extractors so the document carries rows in BOTH content domains. */
async function seedExtractions(db: Db, docId: string): Promise<void> {
  const bank = await runBankExtraction(
    db,
    { skillInstallId: 'app:bank-statement', documentId: docId },
    { audit: noopAudit, readDocumentSegments: async () => BANK_SEGMENTS }
  )
  expect(bank.ok, 'bank extraction should persist rows').toBe(true)
  expect(bank.transactionCount).toBe(2)
  const inv = await runInvoiceExtraction(
    db,
    { skillInstallId: 'app:invoice', documentId: docId },
    { audit: noopAudit, readDocumentSegments: async () => INVOICE_SEGMENTS }
  )
  expect(inv.ok, 'invoice extraction should persist rows').toBe(true)
  expect(inv.lineItemCount).toBe(2)
}

beforeEach(() => {
  ipcState.handlers.clear()
})

describe('deleteDocument — purges bank/invoice derivatives (audit DATA-1, existing-drive shape)', () => {
  it('deletes a document with REAL bank + invoice extractions cleanly: every derived row gone, file shredded', async () => {
    const db = freshDb()
    degradeSkillTablesToLegacyFk(db) // a drive created before this fix — no cascade to documents

    const fileDir = mkdtempSync(join(tmpdir(), 'hilbertraum-deldoc-store-'))
    const storedPath = join(fileDir, 'statement.pdf')
    writeFileSync(storedPath, 'workspace copy bytes')
    const { docId, chunkIds } = seedDoc(db, { chunks: ['chunk a', 'chunk b'], storedPath })
    const now = new Date().toISOString()

    // An embeddings row on a chunk (no documents-cascade — purged explicitly before chunks)…
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, 'mock', ?, 3, ?)`
    ).run(chunkIds[0], Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer), now)
    // …a summary-tree node…
    db.prepare(
      `INSERT INTO tree_nodes (id, document_id, level, ordinal, is_root, summary_text, content_hash, created_at)
       VALUES (?, ?, 1, 0, 1, 'summary', 'hash', ?)`
    ).run(randomUUID(), docId, now)

    await seedExtractions(db, docId)

    // A user correction on a real transaction (no UI writes bank_corrections yet — insert directly
    // so the teardown's corrections branch is exercised, not assumed dead).
    const txId = (db.prepare('SELECT id FROM bank_transactions LIMIT 1').get() as { id: string }).id
    db.prepare(
      `INSERT INTO bank_corrections (id, transaction_id, field, old_value, new_value, created_at)
       VALUES (?, ?, 'amount', '0', '0', ?)`
    ).run(randomUUID(), txId, now)

    const before = derivedCounts(db, docId)
    expect(before).toMatchObject({
      documents: 1,
      chunks: 2,
      embeddings: 1,
      treeNodes: 1,
      bankStatements: 1,
      bankTransactions: 2,
      bankCorrections: 1,
      invoices: 1,
      invoiceLineItems: 2
    })
    expect(existsSync(storedPath)).toBe(true)

    expect(() => deleteDocument(db, docId)).not.toThrow()

    expect(derivedCounts(db, docId)).toEqual({
      documents: 0,
      chunks: 0,
      embeddings: 0,
      treeNodes: 0,
      bankStatements: 0,
      bankTransactions: 0,
      bankCorrections: 0,
      invoices: 0,
      invoiceLineItems: 0
    })
    // The workspace copy was shredded only after the DB commit succeeded.
    expect(existsSync(storedPath)).toBe(false)
    // The skill_runs history (ids/refs only) is intentionally NOT deleted — it has no FK to documents.
    const runs = (db.prepare('SELECT COUNT(*) n FROM skill_runs').get() as { n: number }).n
    expect(runs).toBeGreaterThan(0)
  })

  it('TEETH: without the ordered cleanup, the un-cascaded FK blocks the delete (the bug DATA-1 closes)', async () => {
    const db = freshDb()
    degradeSkillTablesToLegacyFk(db)
    const { docId } = seedDoc(db)
    await seedExtractions(db, docId)

    // Reproduce the pre-fix deleteDocument: a bare `DELETE FROM documents` that skips the bank/invoice
    // rows. On a no-cascade drive this is exactly the throw that left a corrupt, undeletable document.
    expect(() => db.prepare('DELETE FROM documents WHERE id = ?').run(docId)).toThrow(/FOREIGN KEY|constraint/i)
    // The row is still there — the failed delete changed nothing.
    expect(derivedCounts(db, docId).documents).toBe(1)
  })
})

describe('fresh-schema cascade — defense-in-depth for the next table (audit DATA-1)', () => {
  it('a bare DELETE FROM documents cascades the whole bank/invoice chain with no FK error', async () => {
    const db = freshDb() // current schema: full ON DELETE CASCADE down both chains
    // No chunks (the chunks FK has no cascade) — isolate the bank/invoice cascade. Feed the
    // extractors via segments so they need no chunk rows.
    const { docId } = seedDoc(db)
    await seedExtractions(db, docId)
    const before = derivedCounts(db, docId)
    expect(before.bankStatements).toBe(1)
    expect(before.invoices).toBe(1)

    // The pre-fix bare delete that DATA-1 reproduced as a throw now cascades cleanly on a fresh DB.
    expect(() => db.prepare('DELETE FROM documents WHERE id = ?').run(docId)).not.toThrow()
    expect(derivedCounts(db, docId)).toMatchObject({
      documents: 0,
      bankStatements: 0,
      bankTransactions: 0,
      bankCorrections: 0,
      invoices: 0,
      invoiceLineItems: 0
    })
  })
})

describe('deleteDocument IPC — a document WITH a tool run deletes + audits (TEST-1 gap)', () => {
  it('the real docs IPC handler deletes a doc that has bank/invoice rows and fires document_deleted', async () => {
    const db = freshDb()
    degradeSkillTablesToLegacyFk(db) // exercise the manual purge end-to-end through the handler
    const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-deldoc-ipc-'))
    const workspacePath = join(rootPath, 'workspace')
    mkdirSync(workspacePath, { recursive: true })

    const events: Array<{ type: string }> = []
    const ctx = {
      paths: { rootPath, workspacePath, configPath: join(rootPath, 'config') },
      db,
      workspace: { isUnlocked: () => true, documentCipher: () => null, beginDocumentWork: () => () => {} },
      embedder: createMockEmbedder(),
      audit: (type: string) => events.push({ type })
    } as unknown as AppContext
    registerDocsIpc(ctx)

    const { docId } = seedDoc(db, { chunks: ['chunk a'] })
    await seedExtractions(db, docId)
    expect(derivedCounts(db, docId).bankStatements).toBe(1)

    await invoke(handlers, IPC.deleteDocument, docId)

    expect(events.map((e) => e.type)).toContain('document_deleted')
    expect(derivedCounts(db, docId)).toMatchObject({ documents: 0, bankStatements: 0, invoices: 0 })
  })
})
