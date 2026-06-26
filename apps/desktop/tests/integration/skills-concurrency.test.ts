import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { runBankExtraction, runCategorization, latestBankStatementId } from '../../src/main/services/skills/run'
import { withDocumentLock, activeDocumentLockCount } from '../../src/main/services/skills/doc-lock'
import type { AuditEventType, DocumentChunkRead } from '../../src/shared/types'

// Cross-lane write safety (skills-tools-audit-2026-06-26 PC-1, §2.3). The main process is
// single-threaded, so the hazard these tests reproduce is NOT an OS data race but COOPERATIVE
// interleaving across `await` points: one lane suspended at an await while another runs its DELETE+
// INSERT on the SAME document. We force the interleave with a controllable barrier inside the segment
// reader (the exact await `runBankExtraction` suspends on while it re-reads the stored document), then
// assert the per-document lock serializes the write-capable sections — and that UNRELATED documents
// still run fully concurrently. See `services/skills/doc-lock.ts`.

const skillInstallId = 'app:bank-statement'
const STATEMENT_TEXT = 'Statement EUR\n2026-01-02 Grocery -45,90 1.954,10\n2026-01-03 Salary 2.500,00 4.454,10'

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-concurrency-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

function seedDocWithChunks(db: Db, text: string): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, 'Statement', 'indexed', 'application/pdf', ?, ?)`
  ).run(docId, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}

/** The faithful, newline-preserving segments the IPC would supply via extractDocumentPreview. */
function segmentsFor(text: string): DocumentChunkRead[] {
  return [{ text, page: 1, index: 0 }]
}

/** A segment reader that signals when the seam reaches it, then suspends until `release` resolves. */
function barrierReader(
  text: string,
  reached: () => void,
  release: Promise<void>
): (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]> {
  return async () => {
    reached()
    await release
    return segmentsFor(text)
  }
}

function countStatements(db: Db, documentId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM bank_statements WHERE document_id = ?').get(documentId) as { n: number }).n
}

describe('cross-lane write safety — per-document serialization (audit PC-1)', () => {
  it('a re-extract and a categorize on the SAME document serialize (no vanished-mid-read, deterministic)', async () => {
    const db = freshDb()
    const docId = seedDocWithChunks(db, STATEMENT_TEXT)

    // Pre-seed an initial statement S0 (the chunk-table path; no audit kept).
    const pre = await runBankExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {} })
    expect(pre.ok).toBe(true)
    const s0 = pre.statementId!

    // Order log: BOTH lanes' gate audits append here, tagged by lane. With the lock, lane A's pair must
    // fully precede lane B's — proving the categorize ran AFTER the re-extract, on the new statement.
    const order: string[] = []
    const auditA = (type: AuditEventType): void => void order.push(`A:${type}`)
    const auditB = (type: AuditEventType): void => void order.push(`B:${type}`)

    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    let laneAReached!: () => void
    const laneAAtBarrier = new Promise<void>((resolve) => {
      laneAReached = resolve
    })

    // Lane A — a chat-style re-extract (replaceExisting → DELETE S0 + INSERT S1). It suspends at the
    // segment-read barrier while HOLDING the per-document lock.
    const laneA = runBankExtraction(
      db,
      { skillInstallId, documentId: docId },
      { audit: auditA, replaceExisting: true, layout: true, readDocumentSegments: barrierReader(STATEMENT_TEXT, laneAReached, barrier) }
    )
    await laneAAtBarrier // lane A is now parked at its await, holding the doc lock

    // Lane B — a button-style categorize on the SAME document. It must BLOCK on the doc lock until lane
    // A finishes; only then does it see (and categorize) the NEW statement.
    const laneB = runCategorization(db, { skillInstallId, documentId: docId }, { audit: auditB })

    releaseBarrier() // let lane A complete its DELETE+INSERT and release the lock
    const [resA, resB] = await Promise.all([laneA, laneB])
    expect(resA.ok).toBe(true)
    expect(resB.ok).toBe(true)

    // Serialized: lane A's whole run precedes lane B's (never interleaved at the gate).
    expect(order).toEqual(['A:skill_run_started', 'A:skill_run_done', 'B:skill_run_started', 'B:skill_run_done'])

    // Deterministic final state: exactly ONE statement (S0 replaced by S1), and the categorize landed on
    // the NEW statement (not the deleted S0 → no lost work, no "vanished mid-read").
    const s1 = latestBankStatementId(db, docId)!
    expect(s1).not.toBe(s0)
    expect(s1).toBe(resA.statementId)
    expect(countStatements(db, docId)).toBe(1)

    const rows = db
      .prepare('SELECT statement_id, category_id FROM bank_transactions')
      .all() as Array<{ statement_id: string; category_id: string | null }>
    // No orphans: every surviving row belongs to S1 (S0's rows were deleted with it).
    expect(rows.every((r) => r.statement_id === s1)).toBe(true)
    // The categorize ran on S1's rows — at least one carries a category (the Salary→Income rule row).
    expect(rows.some((r) => r.category_id != null)).toBe(true)

    expect(activeDocumentLockCount()).toBe(0) // the chain drained — no map leak
  })

  it('two DIFFERENT documents run concurrently (the lock does not serialize unrelated work)', async () => {
    const db = freshDb()
    const docX = seedDocWithChunks(db, STATEMENT_TEXT)
    const docY = seedDocWithChunks(db, STATEMENT_TEXT)

    let releaseAll!: () => void
    const release = new Promise<void>((resolve) => {
      releaseAll = resolve
    })
    let xReached!: () => void
    const xAtBarrier = new Promise<void>((resolve) => {
      xReached = resolve
    })
    let yReached!: () => void
    const yAtBarrier = new Promise<void>((resolve) => {
      yReached = resolve
    })

    // Both extractions park at their segment-read barrier. With a PER-document lock they reach it
    // together; a (buggy) global lock would keep Y's reader from ever running while X is parked → this
    // `Promise.all` would hang and the test would time out.
    const runX = runBankExtraction(
      db,
      { skillInstallId, documentId: docX },
      { audit: () => {}, replaceExisting: true, layout: true, readDocumentSegments: barrierReader(STATEMENT_TEXT, xReached, release) }
    )
    const runY = runBankExtraction(
      db,
      { skillInstallId, documentId: docY },
      { audit: () => {}, replaceExisting: true, layout: true, readDocumentSegments: barrierReader(STATEMENT_TEXT, yReached, release) }
    )

    await Promise.all([xAtBarrier, yAtBarrier]) // both in flight at once → genuinely concurrent

    releaseAll()
    const [resX, resY] = await Promise.all([runX, runY])
    expect(resX.ok).toBe(true)
    expect(resY.ok).toBe(true)
    expect(countStatements(db, docX)).toBe(1)
    expect(countStatements(db, docY)).toBe(1)
    expect(activeDocumentLockCount()).toBe(0)
  })

  it('withDocumentLock is re-entrant within one async chain (a nested same-doc acquire does not deadlock)', async () => {
    // The load-bearing property for the lane wraps: the analysis handler / runCategorize hold the lock
    // across a sequence AND call self-locking seams inside. A nested acquire of an already-held id must
    // run inline rather than await the outer hold forever.
    const docId = 'doc-reentrant'
    const seen: string[] = []
    const result = await withDocumentLock(docId, async () => {
      seen.push('outer')
      const inner = await withDocumentLock(docId, async () => {
        seen.push('inner')
        return 42
      })
      return inner
    })
    expect(result).toBe(42)
    expect(seen).toEqual(['outer', 'inner'])
    expect(activeDocumentLockCount()).toBe(0)
  })
})
