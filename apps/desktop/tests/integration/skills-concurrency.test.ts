import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { runBankExtraction, runCashflowSummary, runCategorization, runCsvExport, latestBankStatementId } from '../../src/main/services/skills/run'
import { withDocumentLock, activeDocumentLockCount } from '../../src/main/services/skills/doc-lock'
import { SkillRunController } from '../../src/main/services/skills/run-controller'
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

  it('SKA-24: an aborted PARKED waiter rejects immediately, never runs, and a THIRD caller still acquires', async () => {
    // The chain invariant under abort: the waiter's tail is PUBLISHED before it parks, so the abort
    // path must still settle it (release + prune) — otherwise every later caller deadlocks forever.
    const docId = 'doc-abort-parked'
    let releaseHolder!: () => void
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve
    })
    const order: string[] = []

    // Caller 1 HOLDS the lock (parked inside its own fn, like a long categorize).
    let holderStarted!: () => void
    const holderAcquired = new Promise<void>((resolve) => {
      holderStarted = resolve
    })
    const holder = withDocumentLock(docId, async () => {
      order.push('holder:start')
      holderStarted()
      await holderGate
      order.push('holder:end')
    })
    await holderAcquired // the holder provably holds the lock

    // Caller 2 parks behind it with a signal, then aborts.
    const ac = new AbortController()
    let waiterRan = false
    const waiter = withDocumentLock(docId, async () => {
      waiterRan = true
    }, ac.signal)
    const waiterErr = waiter.then(
      () => null,
      (e: unknown) => e
    )
    ac.abort()
    // Assertions before the holder releases run in a try/finally: a red one must still release the
    // gate, or the leaked module-global chain poisons every later activeDocumentLockCount() test.
    try {
      const err = await waiterErr // rejects IMMEDIATELY — the holder is still parked on its gate
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe('AbortError')
      expect(waiterRan).toBe(false)
      expect(order).toEqual(['holder:start']) // the holder had NOT finished when the waiter rejected
    } finally {
      releaseHolder()
    }

    // Caller 3 (no signal) queues after the aborted waiter — the chain must not be wedged.
    const third = withDocumentLock(docId, async () => {
      order.push('third')
      return 7
    })
    await holder
    expect(await third).toBe(7)
    expect(order).toEqual(['holder:start', 'holder:end', 'third'])
    await Promise.resolve() // let the aborted waiter's deferred prune run
    expect(activeDocumentLockCount()).toBe(0) // no leaked chain entry from the aborted waiter
  })

  it('SKA-24: an already-aborted caller facing a FREE lock still runs fn (the seam records the honest cancel)', async () => {
    const ac = new AbortController()
    ac.abort()
    let ran = false
    await withDocumentLock('doc-abort-free', async () => {
      ran = true
    }, ac.signal)
    expect(ran).toBe(true) // pre-R9 behaviour preserved: the seam's own first signal check owns this case
    expect(activeDocumentLockCount()).toBe(0)
  })

  it('SKA-24 end-to-end: Cancel flips a run QUEUED on the doc lock to cancelled while the holder still runs', async () => {
    // The user-visible defect: a run queued behind a long categorize showed a dead "running" spinner
    // after Cancel until the other lane finished. Now the parked waiter rejects, the controller's
    // catch runs `finish`, and `signal.aborted` maps it to 'cancelled' (the documented fallback).
    const db = freshDb()
    const docId = seedDocWithChunks(db, STATEMENT_TEXT)
    const pre = await runBankExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {} })
    expect(pre.ok).toBe(true)

    // Lane A (the "long categorize" stand-in): a re-extract parked at its segment read, HOLDING the lock.
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    let laneAReached!: () => void
    const laneAAtBarrier = new Promise<void>((resolve) => {
      laneAReached = resolve
    })
    const laneA = runBankExtraction(
      db,
      { skillInstallId, documentId: docId },
      { audit: () => {}, replaceExisting: true, layout: true, readDocumentSegments: barrierReader(STATEMENT_TEXT, laneAReached, barrier) }
    )
    await laneAAtBarrier

    // Lane B: a controller-started categorize on the SAME document — it parks on the doc lock.
    const controller = new SkillRunController()
    const started = controller.start({
      skillInstallId,
      toolName: 'categorize_transactions',
      documentId: docId,
      documentCount: 1,
      runner: ({ signal, onProgress }) =>
        runCategorization(db, { skillInstallId, documentId: docId }, { audit: () => {}, signal, onProgress })
    })
    expect(started.state).toBe('running')

    controller.cancel(started.runHandle)
    // Assertions before the barrier releases run in a try/finally: a red one must still release lane A,
    // or the leaked module-global chain poisons every later activeDocumentLockCount() test.
    try {
      // The parked waiter rejects on the abort; the controller flips to 'cancelled' WITHOUT waiting for
      // lane A (which is still parked on its barrier). Bounded poll — no dependence on hop counts.
      for (let i = 0; i < 50 && controller.get(started.runHandle)!.state === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(controller.get(started.runHandle)!.state).toBe('cancelled')

      // Lane B never created ANY run row (cancelled BEFORE acquiring — nothing to strand, and no
      // phantom terminal row either): only the pre-seed 'done' + lane A's in-flight 'started' exist.
      const rows = db.prepare('SELECT status FROM skill_runs ORDER BY created_at').all() as Array<{ status: string }>
      expect(rows.map((r) => r.status).sort()).toEqual(['done', 'started'])
    } finally {
      releaseBarrier()
    }
    const resA = await laneA
    expect(resA.ok).toBe(true) // the holder was never disturbed

    // A THIRD caller acquires after both settled — the chain was not wedged by the aborted waiter.
    const resC = await runCategorization(db, { skillInstallId, documentId: docId }, { audit: () => {} })
    expect(resC.ok).toBe(true)
    expect(activeDocumentLockCount()).toBe(0)
  })

  it('SKA-28: an export racing a competing replace-delete never writes an empty file (TOCTOU closed)', async () => {
    // Pre-R9, `runDomainFileExport` held NO outer lock: its R3 staleness re-extract self-locked and
    // RELEASED, and the subsequent row load ran unlocked — a competing lane's DELETE (the doctask
    // replace step, reduced here to its interleave-relevant essence) could land between the two, so the
    // export loaded 0 rows and wrote an empty CSV reported "saved 0 rows". The audit notes the window
    // is microtask-narrow in production but test environments can invert the timing — this barrier
    // forces exactly that inversion. Post-fix the export's ONE hold spans prepare+load+serialize, so it
    // writes either its re-extracted rows or runs strictly before/after the competitor — never [].
    const db = freshDb()
    const COLLAPSED = 'Statement EUR 2026-01-02 Grocery -45,90 1.954,10 2026-01-03 Salary 2.500,00 4.454,10'
    const docId = seedDocWithChunks(db, COLLAPSED)

    // Seed a statement extracted from FAITHFUL segments, then force it stale so the export re-extracts.
    const pre = await runBankExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {}, readDocumentSegments: async () => segmentsFor(STATEMENT_TEXT) })
    expect(pre.transactionCount).toBe(2)
    db.prepare('UPDATE bank_statements SET extractor_version = 2 WHERE id = ?').run(pre.statementId!)

    // The export parks at its re-extract's segment read (holding the outer lock post-fix).
    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    let exportReached!: () => void
    const exportAtBarrier = new Promise<void>((resolve) => {
      exportReached = resolve
    })
    let written: string | null = null
    const exportRun = runCsvExport(db, { skillInstallId, documentId: docId }, {
      audit: () => {},
      confirmed: true,
      readDocumentSegments: barrierReader(STATEMENT_TEXT, exportReached, barrier),
      saveTextFile: async (_name, content) => {
        written = content
        return true
      }
    })
    await exportAtBarrier

    // The competing replace-delete queues on the lock. Its body is SYNCHRONOUS on acquisition — the
    // most aggressive interleave a cooperative scheduler allows (pre-fix it deterministically ran
    // between the export's re-extract release and its unlocked load).
    const competitor = withDocumentLock(docId, async () => {
      db.prepare(
        `DELETE FROM bank_transactions WHERE statement_id IN (SELECT id FROM bank_statements WHERE document_id = ?)`
      ).run(docId)
      db.prepare('DELETE FROM bank_statements WHERE document_id = ?').run(docId)
    })

    releaseBarrier()
    const res = await exportRun
    await competitor
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2) // never "saved 0 rows"
    expect(written!).toContain('Grocery') // the serialized text carries the re-extracted rows…
    expect(written!).toContain('Salary') // …not an empty header-only CSV
    expect(activeDocumentLockCount()).toBe(0)
  })

  it('SKA-28: summarize under the same racing replace-delete serves the re-extracted rows, never 0', async () => {
    // The summarize twin: `runCashflowSummary` was the OTHER downstream seam holding no outer lock
    // (validate/categorize already wrap). Same interleave, same fix — one hold across prepare+load.
    const db = freshDb()
    const COLLAPSED = 'Statement EUR 2026-01-02 Grocery -45,90 1.954,10 2026-01-03 Salary 2.500,00 4.454,10'
    const docId = seedDocWithChunks(db, COLLAPSED)
    const pre = await runBankExtraction(db, { skillInstallId, documentId: docId }, { audit: () => {}, readDocumentSegments: async () => segmentsFor(STATEMENT_TEXT) })
    expect(pre.transactionCount).toBe(2)
    db.prepare('UPDATE bank_statements SET extractor_version = 2 WHERE id = ?').run(pre.statementId!)

    let releaseBarrier!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    let summarizeReached!: () => void
    const summarizeAtBarrier = new Promise<void>((resolve) => {
      summarizeReached = resolve
    })
    const summaryRun = runCashflowSummary(db, { skillInstallId, documentId: docId }, {
      audit: () => {},
      readDocumentSegments: barrierReader(STATEMENT_TEXT, summarizeReached, barrier)
    })
    await summarizeAtBarrier

    const competitor = withDocumentLock(docId, async () => {
      db.prepare(
        `DELETE FROM bank_transactions WHERE statement_id IN (SELECT id FROM bank_statements WHERE document_id = ?)`
      ).run(docId)
      db.prepare('DELETE FROM bank_statements WHERE document_id = ?').run(docId)
    })

    releaseBarrier()
    const res = await summaryRun
    await competitor
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2) // the summary read the rows its own re-extract persisted — never 0
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
