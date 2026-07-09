import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  getDocument,
  getDocumentSummary,
  processDocument,
  reconcileStuckTrees,
  reindexDocument,
  setDocumentSummary
} from '../../src/main/services/ingestion'
import { DocTaskManager } from '../../src/main/services/doctasks'
import { buildTree } from '../../src/main/services/analysis/tree-build'
import { ModelSlotArbiter } from '../../src/main/services/analysis/model-slot-arbiter'
import {
  documentChunkCount,
  documentCoverage,
  documentLeafProvenance,
  reachableLeafChunkIds
} from '../../src/main/services/analysis/coverage'
import { t } from '../../src/shared/i18n'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions
} from '../../src/main/services/runtime'

// Whole-document-analysis Phase 1 (docs/rag-design.md §14.1–§14.3 — analysis design record): cap honesty
// (C1/C2/C4/M13), the ingest-time summary tree (the yielding build + per-node transaction +
// content cache), and the tree-first summary (M1). Mock runtime, no model, no network.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-wda-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Import a .txt of literal `text` through the REAL ingestion pipeline. */
async function importText(text: string, name = 'doc.txt'): Promise<string> {
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  await processDocument(db, storeDir, info.id)
  return info.id
}

/** A doc of `words` distinct whitespace words (distinct ⇒ distinct chunk/group hashes). */
function importWords(words: number, name = 'doc.txt'): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `word${i}`).join(' ')
  return importText(text, name)
}

interface ScriptedRuntime extends ModelRuntime {
  calls: number
  maxConcurrent: number
}

/** Mock runtime: a distinct summary per distinct prompt (so group hashes are distinct). */
function scriptedRuntime(opts: { tokenDelayMs?: number } = {}): ScriptedRuntime {
  let concurrent = 0
  const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const tmr = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(tmr)
        resolve()
      })
    })
  const rt: ScriptedRuntime = {
    modelId: 'scripted-model',
    calls: 0,
    maxConcurrent: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      rt.calls += 1
      concurrent += 1
      rt.maxConcurrent = Math.max(rt.maxConcurrent, concurrent)
      try {
        const user = messages.find((m) => m.role === 'user')?.content ?? ''
        // Cheap deterministic per-input marker — distinct inputs ⇒ distinct summaries.
        let h = 0
        for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) | 0
        const reply = `summary-${(h >>> 0).toString(16)}`
        for (const token of reply.match(/\S+\s*/g) ?? [reply]) {
          if (options?.signal?.aborted) return
          if (opts.tokenDelayMs) await delay(opts.tokenDelayMs, options?.signal)
          yield token
        }
      } finally {
        concurrent -= 1
      }
    }
  }
  return rt
}

function makeManager(runtime: ModelRuntime | null, contextTokens = 4096): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    getRuntime: () => runtime,
    getTranslator: () => null,
    isChatStreaming: () => false,
    getContextTokens: () => contextTokens,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({}),
    beginDocumentWork: () => () => {}
  })
}

type AnyStatus = ReturnType<DocTaskManager['getDocTask']>
async function waitTerminal(m: DocTaskManager, jobId: string): Promise<AnyStatus> {
  const start = Date.now()
  for (;;) {
    const s = m.getDocTask(jobId)
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') return s
    if (Date.now() - start > 10_000) throw new Error(`task never finished: ${s.state}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
async function waitFor(pred: () => boolean, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Walk tree_edges from the root, collecting reachable leaf-chunk ids. */
function reachableLeafChunks(documentId: string): Set<string> {
  const root = db
    .prepare('SELECT id FROM tree_nodes WHERE document_id = ? AND is_root = 1 LIMIT 1')
    .get(documentId) as unknown as { id: string } | undefined
  const out = new Set<string>()
  if (!root) return out
  const stack: Array<{ id: string; isChunk: boolean }> = [{ id: root.id, isChunk: false }]
  while (stack.length) {
    const cur = stack.pop()!
    if (cur.isChunk) {
      out.add(cur.id)
      continue
    }
    const edges = db
      .prepare('SELECT child_id, child_is_chunk FROM tree_edges WHERE parent_id = ? ORDER BY ordinal')
      .all(cur.id) as unknown as Array<{ child_id: string; child_is_chunk: number }>
    for (const e of edges) stack.push({ id: e.child_id, isChunk: e.child_is_chunk === 1 })
  }
  return out
}

function chunkIds(documentId: string): string[] {
  return (
    db
      .prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(documentId) as unknown as Array<{ id: string }>
  ).map((r) => r.id)
}

function treeStatus(documentId: string): string | null {
  return (
    db.prepare('SELECT tree_status FROM documents WHERE id = ?').get(documentId) as unknown as {
      tree_status: string | null
    }
  ).tree_status
}

// ---- Cap honesty (C1/C2/C4/M13) -----------------------------------------------------

describe('cap honesty', () => {
  it('rejects an over-cap document at index time with main.ingest.tooManyChunks, never partial', async () => {
    // ~430k single-token words ⇒ > MAX_CHUNKS_PER_DOCUMENT (1000) windows at the default size.
    const p = join(tmp, 'huge.txt')
    writeFileSync(p, 'a '.repeat(430_000), 'utf8')
    const info = createQueuedDocument(db, p)
    const done = await processDocument(db, storeDir, info.id)

    expect(done.status).toBe('failed')
    expect(done.errorMessage).toBe(t('en', 'main.ingest.tooManyChunks'))
    // Never partial-indexed: no chunks were written.
    expect(chunkIds(info.id).length).toBe(0)
  })

  it('sets fully_chunked on every successful index (and the marker proves whole-doc coverage)', async () => {
    const id = await importWords(300)
    const row = db.prepare('SELECT fully_chunked FROM documents WHERE id = ?').get(id) as unknown as {
      fully_chunked: string | null
    }
    expect(row.fully_chunked).toBeTruthy()
  })

  it('M13: re-indexing an over-cap document fails BEFORE deleting its existing chunks', async () => {
    // A searchable (small) doc that later "grows" over the cap on re-parse must not be left
    // zero-chunk. Simulate by indexing small, then overwriting the stored copy with an
    // over-cap body and re-indexing — the gate must throw before the destructive DELETE.
    const id = await importWords(300)
    const before = chunkIds(id).length
    expect(before).toBeGreaterThan(0)

    // Overwrite the stored copy with an over-cap body, then re-index.
    const stored = (
      db.prepare('SELECT stored_path FROM documents WHERE id = ?').get(id) as unknown as {
        stored_path: string
      }
    ).stored_path
    writeFileSync(stored, 'a '.repeat(430_000), 'utf8')
    const info = await reindexDocument(db, storeDir, id)

    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(t('en', 'main.ingest.tooManyChunks'))
    // The prior chunks survived the failed re-index (gate failed CLOSED).
    expect(chunkIds(id).length).toBe(before)
  })
})

// ---- Tree build structure + coverage (M11) ------------------------------------------

describe('summary tree build', () => {
  it('builds a tree whose root reaches EVERY chunk leaf, including the last (no truncation)', async () => {
    // Small group budget (contextTokens 1024) ⇒ many nodes from a modest doc.
    const id = await importWords(4000)
    const all = chunkIds(id)
    expect(all.length).toBeGreaterThan(1)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)

    const { jobId } = m.startDocTask({ kind: 'tree', documentIds: [id] })
    const s = await waitTerminal(m, jobId)
    expect(s.state).toBe('done')
    expect(treeStatus(id)).toBe('ready')

    const leaves = reachableLeafChunks(id)
    // Structural no-truncation invariant: coverage = reachable leaves = chunk count, and the
    // LAST chunk is reachable from the root.
    expect(leaves.size).toBe(all.length)
    expect(leaves.has(all[all.length - 1])).toBe(true)

    // No dangling edges: every edge's parent is a real node.
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tree_edges e
         WHERE NOT EXISTS (SELECT 1 FROM tree_nodes n WHERE n.id = e.parent_id)`
      )
      .get() as unknown as { n: number }
    expect(dangling.n).toBe(0)
  })

  it('serves the ready tree root as a whole-document summary at <= 1 model call (truncated:false)', async () => {
    const id = await importWords(4000)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)

    const callsAfterBuild = runtime.calls
    const summaryJob = m.startDocTask({ kind: 'summary', documentIds: [id] })
    const s = await waitTerminal(m, summaryJob.jobId)
    expect(s.state).toBe('done')
    // Tier 1: the root summary verbatim, no extra model call (Q6).
    expect(runtime.calls).toBe(callsAfterBuild)

    const summary = getDocumentSummary(db, id)
    expect(summary?.truncated).toBe(false)
    const root = db
      .prepare('SELECT summary_text FROM tree_nodes WHERE document_id = ? AND is_root = 1')
      .get(id) as unknown as { summary_text: string }
    expect(summary?.text).toBe(root.summary_text)
  })

  it('a tree-less doc still summarizes via the capped map-reduce path', async () => {
    const id = await importWords(300)
    expect(treeStatus(id)).toBeNull()
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 4096)
    const s = await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id] }).jobId)
    expect(s.state).toBe('done')
    expect(getDocumentSummary(db, id)?.text).toBeTruthy()
    expect(runtime.calls).toBeGreaterThan(0) // it actually called the model (no tree)
  })
})

// ---- HIGH_BUG vuln-scan-2026-06-21: provable termination at a starved budget ---------

describe('tree build termination (HIGH_BUG vuln-scan-2026-06-21)', () => {
  it('terminates with bounded model calls when every node summary EXCEEDS the budget window', async () => {
    // The pathological case: a tiny contextTokens (1024 ⇒ ~200-word budget) and a model that
    // emits summaries far larger than the budget. Before the fix, the upper levels never
    // reduced (each over-budget summary sat alone), so the for(;;) loop summarised the same
    // node count forever — an infinite loop issuing unbounded generate() calls that
    // permanently blocked the single-slot doc-task queue. With minPerGroup=2 at the
    // node-reduction levels the count strictly shrinks, so this build PROVABLY halts. If the
    // fix regresses, this test hangs (times out) instead of passing.
    const id = await importWords(4000)
    const leafCount = chunkIds(id).length
    expect(leafCount).toBeGreaterThan(1)

    let calls = 0
    // A summary much larger than the ~200-word budget, distinct per call (no trivial cache
    // collapse that would mask the call count).
    const bigSummary = (): string => {
      calls += 1
      return Array.from({ length: 400 }, (_, i) => `lorem${i}`).join(' ') + ` #${calls}`
    }

    const meta = await buildTree(id, {
      db,
      modelId: 'm',
      contextTokens: 1024, // direct call bypasses the settings clamp ⇒ exercises the loop guard
      signal: new AbortController().signal,
      arbiter: new ModelSlotArbiter(),
      jobId: 'job-terminate',
      generate: async () => bigSummary()
    })

    expect(treeStatus(id)).toBe('ready')
    expect(meta.levels).toBeGreaterThan(1) // it actually reduced across multiple levels
    // The root reaches every leaf — no chunk dropped despite the forced pairing.
    expect(reachableLeafChunks(id).size).toBe(leafCount)
    // Bounded work: each level at least halves the node count, so total nodes (hence calls)
    // is O(leaves), nowhere near the unbounded loop the bug produced.
    expect(calls).toBeLessThan(leafCount * 4)
  })
})

// ---- Resume + cache (C3) + re-index invalidation (H1/H2) ----------------------------

describe('content cache, resume, and re-index invalidation', () => {
  it('a rebuild over a warm summary_cache costs 0 model calls', async () => {
    const id = await importWords(4000)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    const firstBuildCalls = runtime.calls
    expect(firstBuildCalls).toBeGreaterThan(0)

    // Rebuild from scratch (discard + rebuild): every group's content is cached ⇒ 0 calls.
    runtime.calls = 0
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    expect(treeStatus(id)).toBe('ready')
    expect(runtime.calls).toBe(0)
  })

  it('re-index tears the tree down (stale), and a rebuild reuses the cache despite chunk-id churn', async () => {
    const id = await importWords(4000)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    const oldChunks = new Set(chunkIds(id))

    // Re-index: same content, fresh chunk ids; the tree is torn down to 'stale'.
    await reindexDocument(db, storeDir, id)
    expect(treeStatus(id)).toBe('stale')
    expect(db.prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ?').get(id)).toMatchObject({
      n: 0
    })
    const newChunks = new Set(chunkIds(id))
    // Chunk ids actually churned (no overlap), proving the cache is keyed by text not id.
    expect([...newChunks].some((c) => oldChunks.has(c))).toBe(false)

    runtime.calls = 0
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    expect(treeStatus(id)).toBe('ready')
    expect(runtime.calls).toBe(0) // warm cache reused despite full chunk-id churn

    // Provenance walk after the rebuild has no dangling edges and full coverage.
    expect(reachableLeafChunks(id).size).toBe(newChunks.size)
  })

  it('C3: a boilerplate doc yields DISTINCT nodes that share ONE cache entry (no collapse)', async () => {
    // Identical repeated sections (same text) — distinct structural positions must stay
    // distinct nodes; the cache holds one entry for that text under the model.
    const para = Array.from({ length: 300 }, (_, i) => `clause${i % 10}`).join(' ')
    const id = await importText(Array.from({ length: 6 }, () => para).join('\n\n'), 'boiler.txt')
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)

    const nodeCount = db
      .prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ?')
      .get(id) as unknown as { n: number }
    const distinctSummaries = db
      .prepare('SELECT COUNT(DISTINCT summary_text) AS n FROM tree_nodes WHERE document_id = ?')
      .get(id) as unknown as { n: number }
    // Many nodes, but the repeated leaf groups share summary text (collapse-proof: nodes are
    // by-position, the cache is by-content).
    expect(nodeCount.n).toBeGreaterThan(distinctSummaries.n)
    expect(reachableLeafChunks(id).size).toBe(chunkIds(id).length)
  })
})

// ---- C4: legacy fully_chunked gate --------------------------------------------------

describe('C4 deep-index gate', () => {
  it('refuses a tree build for a legacy (fully_chunked NULL) doc until it is re-indexed', async () => {
    const id = await importWords(4000)
    // Simulate a legacy index (pre-Phase-1): clear the marker.
    db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(id)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)

    expect(() => m.startDocTask({ kind: 'tree', documentIds: [id] })).toThrow()

    // Re-index re-chunks fully (sets the marker); the build is then allowed.
    await reindexDocument(db, storeDir, id)
    const s = await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    expect(s.state).toBe('done')
    expect(treeStatus(id)).toBe('ready')
  })
})

// ---- Per-node durability (H11) ------------------------------------------------------

describe('H11 per-node transaction durability', () => {
  it('rolls back on an injected edge insert failure; the shared connection is not poisoned', async () => {
    const id = await importWords(4000)
    let failOnce = true
    // Wrap the connection so the FIRST tree_edges insert throws (a SQLITE-style error that
    // would NOT auto-roll-back). buildTree must ROLLBACK so the next writer can BEGIN.
    const wrapped = {
      prepare(sql: string) {
        const stmt = db.prepare(sql)
        if (failOnce && sql.includes('INSERT INTO tree_edges')) {
          return {
            run: () => {
              failOnce = false
              throw new Error('SQLITE_IOERR: injected edge insert failure')
            }
          }
        }
        return stmt
      },
      exec: (sql: string) => db.exec(sql)
    } as unknown as Db

    await expect(
      buildTree(id, {
        db: wrapped,
        modelId: 'm',
        contextTokens: 1024,
        signal: new AbortController().signal,
        arbiter: new ModelSlotArbiter(),
        jobId: 'job-h11',
        generate: async () => 'summary'
      })
    ).rejects.toThrow(/injected edge insert/)

    // The connection must be usable: a fresh transaction starts cleanly (it would throw
    // "cannot start a transaction within a transaction" if BEGIN was left open).
    expect(() => {
      db.exec('BEGIN')
      db.exec('COMMIT')
    }).not.toThrow()
    // The build is left resumable (still 'building', not finalized to 'ready').
    expect(treeStatus(id)).toBe('building')
  })
})

// ---- H10: yielding handoff (pause + in-session resume; abort rejects) ---------------

describe('H10 yielding build handshake', () => {
  it('a chat slot request pauses the build, which then resumes in-session to ready', async () => {
    const id = await importWords(8000)
    const runtime = scriptedRuntime({ tokenDelayMs: 15 })
    const m = makeManager(runtime, 1024)
    const { jobId } = m.startDocTask({ kind: 'tree', documentIds: [id] })

    // Wait until the build is mid-flight (at least one node committed, not finished).
    await waitFor(() => m.getDocTask(jobId).progress.stepsDone >= 1, 'first node')
    expect(m.isYieldingBuildActive()).toBe(true)

    // Chat claims the slot — resolves only once the builder parks (≈ one node).
    const release = await m.acquireChatSlot()
    const atPause = m.getDocTask(jobId)
    expect(atPause.state).toBe('running') // paused, NOT done/cancelled

    // Releasing resumes the SAME build in-session — it reaches ready with no restart.
    release()
    const s = await waitTerminal(m, jobId)
    expect(s.state).toBe('done')
    expect(treeStatus(id)).toBe('ready')
    expect(reachableLeafChunks(id).size).toBe(chunkIds(id).length)
    expect(runtime.maxConcurrent).toBe(1) // builder + chat never overlapped
  })

  it('cancelling a parked build rejects the reacquire — no hung await, left resumable', async () => {
    const id = await importWords(8000)
    const runtime = scriptedRuntime({ tokenDelayMs: 15 })
    const m = makeManager(runtime, 1024)
    const { jobId } = m.startDocTask({ kind: 'tree', documentIds: [id] })
    await waitFor(() => m.getDocTask(jobId).progress.stepsDone >= 1, 'first node')

    const release = await m.acquireChatSlot() // build parks
    expect(m.getDocTask(jobId).state).toBe('running')

    m.cancelDocTask(jobId) // aborts controller AND rejects the parked reacquire
    const s = await waitTerminal(m, jobId)
    expect(s.state).toBe('cancelled')
    expect(treeStatus(id)).toBe('building') // resumable, never finalized
    release() // idempotent / no-op now
  })
})

// ---- Persistence round-trip + reconcile ---------------------------------------------

describe('persistence + reconcile', () => {
  it('tree nodes + summary_cache persist and read back across a DB reopen (inherits vault encryption)', async () => {
    const dbPath = join(tmp, 'test.sqlite')
    const id = await importWords(4000)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    const nodeCountBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ?').get(id) as unknown as {
        n: number
      }
    ).n
    const cacheBefore = (
      db.prepare('SELECT COUNT(*) AS n FROM summary_cache').get() as unknown as { n: number }
    ).n
    db.close()

    // Reopen (the whole file is what the vault encrypts at rest — persistence is identical).
    db = openDatabase(dbPath)
    expect(treeStatus(id)).toBe('ready')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ?').get(id) as unknown as {
        n: number
      }).n
    ).toBe(nodeCountBefore)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM summary_cache').get() as unknown as { n: number }).n
    ).toBe(cacheBefore)
    const root = db
      .prepare('SELECT summary_text FROM tree_nodes WHERE document_id = ? AND is_root = 1')
      .get(id) as unknown as { summary_text: string } | undefined
    expect(root?.summary_text).toBeTruthy()
  })

  it('reconcileStuckTrees flips a stale building tree to pending (resumable)', async () => {
    const id = await importWords(300)
    db.prepare("UPDATE documents SET tree_status = 'building', updated_at = ? WHERE id = ?").run(
      '2020-01-01T00:00:00.000Z',
      id
    )
    const n = reconcileStuckTrees(db, new Date().toISOString())
    expect(n).toBe(1)
    expect(treeStatus(id)).toBe('pending')
  })
})

// ---- Phase 2: coverage math + provenance (C1/L2, M2) --------------------------------

describe('coverage math + provenance', () => {
  async function buildReadyTree(words = 4000): Promise<string> {
    const id = await importWords(words)
    const m = makeManager(scriptedRuntime(), 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    return id
  }

  it('a ready tree reports whole-document tree coverage at the served tier (100% only when ready)', async () => {
    const id = await buildReadyTree()
    // A Tier-1 summary (the stored root, untruncated) ⇒ the coverage describes the deep index.
    const m = makeManager(scriptedRuntime(), 1024)
    await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id] }).jobId)
    const summary = getDocumentSummary(db, id)

    const cov = documentCoverage(db, id, summary)
    const total = documentChunkCount(db, id)
    expect(cov.mode).toBe('tree')
    expect(cov.treeStatus).toBe('ready')
    expect(cov.chunksCovered).toBe(total) // reachable leaves == chunk count (whole document)
    expect(cov.chunksTotal).toBe(total)
    expect(cov.truncated).toBe(false)
    expect(cov.treeLevels).toBeGreaterThanOrEqual(1)
    expect(cov.tier).toBe(1)
  })

  it('reachable leaves == chunk count, and provenance is the leaf SOURCE chunks (M2)', async () => {
    const id = await buildReadyTree()
    const total = documentChunkCount(db, id)
    expect(reachableLeafChunkIds(db, id).length).toBe(total)
    const prov = documentLeafProvenance(db, id, 'doc.txt')
    // One citation per leaf source chunk — never a node summary (M2). Labels are [S1..].
    expect(prov.length).toBe(total)
    expect(prov[0].label).toBe('S1')
  })

  it('a tree-less doc is capped: truncated ⇒ beginning, untruncated ⇒ whole (never tree 100%)', async () => {
    const id = await importWords(300)
    expect(treeStatus(id)).toBeNull()
    const total = documentChunkCount(db, id)

    setDocumentSummary(db, id, { text: 's', modelId: 'm', createdAt: '2026-01-01T00:00:00Z', truncated: true })
    const truncCov = documentCoverage(db, id, getDocumentSummary(db, id))
    expect(truncCov.mode).toBe('capped')
    expect(truncCov.truncated).toBe(true)

    setDocumentSummary(db, id, { text: 's', modelId: 'm', createdAt: '2026-01-01T00:00:00Z', truncated: false })
    const wholeCov = documentCoverage(db, id, getDocumentSummary(db, id))
    expect(wholeCov.mode).toBe('capped')
    expect(wholeCov.truncated).toBe(false)
    expect(wholeCov.chunksCovered).toBe(total)
  })

  it('reachableLeafChunkIds terminates on a cyclic tree instead of overflowing the stack (BUG vuln-scan-2026-06-21)', async () => {
    const id = await buildReadyTree()
    const total = documentChunkCount(db, id)
    expect(reachableLeafChunkIds(db, id).length).toBe(total)
    // Inject a node→node back-edge (DB corruption / a hypothetical builder bug): a descendant
    // node points back at the root, forming a cycle. An unguarded DFS would recurse forever
    // and crash the read; the visited-node guard makes it terminate with leaf coverage intact.
    const root = db
      .prepare('SELECT id FROM tree_nodes WHERE document_id = ? AND is_root = 1')
      .get(id) as { id: string }
    const deep = db
      .prepare('SELECT id FROM tree_nodes WHERE document_id = ? AND is_root = 0 ORDER BY level LIMIT 1')
      .get(id) as { id: string } | undefined
    expect(deep).toBeTruthy()
    db.prepare(
      'INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 0, 999)'
    ).run(deep!.id, root.id)
    expect(reachableLeafChunkIds(db, id).length).toBe(total) // terminates, no double-count
  })

  it('a building tree reports tree state (labelled building, NOT ready/100% — C1)', async () => {
    const id = await buildReadyTree()
    db.prepare("UPDATE documents SET tree_status = 'building' WHERE id = ?").run(id)
    // The pure deep-index state (no summary) — used by the row chip.
    const cov = documentCoverage(db, id, null)
    expect(cov.mode).toBe('tree')
    expect(cov.treeStatus).toBe('building') // never 'ready' ⇒ the meter can't render "whole"
    expect(cov.truncated).toBe(true)
  })
})

// ---- Phase 2: coverage tiers (0 / 1 / few model calls) ------------------------------

describe('coverage tiers', () => {
  async function withTree(words: number, ctx = 1024): Promise<{ id: string; runtime: ScriptedRuntime; m: DocTaskManager }> {
    const id = await importWords(words)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, ctx)
    await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    return { id, runtime, m }
  }

  it('Tier 1 serves the root verbatim with 0 extra model calls (truncated:false)', async () => {
    const { id, runtime, m } = await withTree(4000)
    const before = runtime.calls
    await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id], params: { tier: 1 } }).jobId)
    expect(runtime.calls).toBe(before) // 0 extra calls (Q6)
    const s = getDocumentSummary(db, id)
    expect(s?.truncated).toBe(false)
    expect(s?.tier).toBe(1)
    const root = db
      .prepare('SELECT summary_text FROM tree_nodes WHERE document_id = ? AND is_root = 1')
      .get(id) as unknown as { summary_text: string }
    expect(s?.text).toBe(root.summary_text)
  })

  it('Tier 2 runs exactly ONE reduce over the precomputed sections (truncated:false)', async () => {
    const { id, runtime, m } = await withTree(4000)
    const before = runtime.calls
    await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id], params: { tier: 2 } }).jobId)
    expect(runtime.calls).toBe(before + 1) // exactly one reduce call
    const s = getDocumentSummary(db, id)
    expect(s?.truncated).toBe(false)
    expect(s?.tier).toBe(2)
  })

  it('Tier 3 reduces every section in a few calls bounded by NODE count, not document size', async () => {
    const { id, runtime, m } = await withTree(8000)
    const level1 = (
      db
        .prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ? AND level = 1')
        .get(id) as unknown as { n: number }
    ).n
    const before = runtime.calls
    await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id], params: { tier: 3 } }).jobId)
    const used = runtime.calls - before
    expect(used).toBeGreaterThanOrEqual(1)
    expect(used).toBeLessThanOrEqual(level1 + 1) // bounded by node count (+1 reduce), never chunk/doc size
    const s = getDocumentSummary(db, id)
    expect(s?.truncated).toBe(false)
    expect(s?.tier).toBe(3)
  })

  it('an absent tier param defaults to Tier 1 (the one-click summary is unchanged)', async () => {
    const { id, runtime, m } = await withTree(4000)
    const before = runtime.calls
    await waitTerminal(m, m.startDocTask({ kind: 'summary', documentIds: [id] }).jobId) // no params
    expect(runtime.calls).toBe(before) // Tier-1 default ⇒ 0 extra calls
    expect(getDocumentSummary(db, id)?.tier).toBe(1)
  })
})

// ---- #38: the deep-index chain — "Build deep index" = tree + extract, one user concept ----

describe('deep-index extract chain (#38)', () => {
  const extractStatusOf = (id: string): string | null =>
    (
      db.prepare('SELECT extract_status FROM documents WHERE id = ?').get(id) as unknown as {
        extract_status: string | null
      }
    ).extract_status

  it('a tree task started with withExtract chains the extract pass after success', async () => {
    const id = await importWords(4000)
    const runtime = scriptedRuntime()
    const m = makeManager(runtime, 1024)
    const s = await waitTerminal(
      m,
      m.startDocTask({ kind: 'tree', documentIds: [id], params: { withExtract: true } }).jobId
    )
    expect(s.state).toBe('done')
    expect(treeStatus(id)).toBe('ready')
    // The chained extract pass was enqueued by the manager itself and runs next — the deep
    // index is complete only when BOTH passes are (the row action and badge key off this).
    await waitFor(() => extractStatusOf(id) === 'ready' && !m.hasActiveTask(), 'chained extract')
  })

  it('a plain tree task (no withExtract) never chains — extract stays manual elsewhere', async () => {
    const id = await importWords(4000)
    const m = makeManager(scriptedRuntime(), 1024)
    const s = await waitTerminal(m, m.startDocTask({ kind: 'tree', documentIds: [id] }).jobId)
    expect(s.state).toBe('done')
    await waitFor(() => !m.hasActiveTask(), 'queue drained')
    expect(extractStatusOf(id)).toBeNull() // no surprise CPU spend (rag-design §14.5)
  })

  it('a CANCELLED tree build never chains the extract pass', async () => {
    const id = await importWords(8000)
    const runtime = scriptedRuntime({ tokenDelayMs: 15 })
    const m = makeManager(runtime, 1024)
    const { jobId } = m.startDocTask({ kind: 'tree', documentIds: [id], params: { withExtract: true } })
    await waitFor(() => m.getDocTask(jobId).state === 'running', 'build running')
    m.cancelDocTask(jobId)
    const s = await waitTerminal(m, jobId)
    expect(s.state).toBe('cancelled')
    await waitFor(() => !m.hasActiveTask(), 'queue drained')
    expect(extractStatusOf(id)).toBeNull() // the user said stop — no chained work
  })

  it('withExtract on the auto-enqueue path is never set — maybeEnqueueTreeBuild starts a plain tree', async () => {
    // The import-time auto-enqueue must not inherit the chain: the extract pass is user-
    // triggered only (rag-design §14.5 — no surprise CPU spend at import).
    const id = await importWords(8000)
    db.prepare("UPDATE documents SET tree_status = NULL WHERE id = ?").run(id)
    const m = makeManager(scriptedRuntime(), 1024)
    m.maybeEnqueueTreeBuild(id)
    await waitFor(() => treeStatus(id) === 'ready' && !m.hasActiveTask(), 'auto tree')
    expect(extractStatusOf(id)).toBeNull()
  })
})
