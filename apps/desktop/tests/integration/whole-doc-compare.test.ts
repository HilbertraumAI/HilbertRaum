import { describe, it, expect, beforeEach } from 'vitest'
import type { Db } from '../../src/main/services/db'
import type { DocTaskDeps, DocTaskManager } from '../../src/main/services/doctasks'
import {
  compareAsymmetricNotice,
  compareSymmetricTruncationNotice
} from '../../src/main/services/doctasks/compare'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import { readStoredDocumentText } from '../../src/main/services/ingestion'
import {
  docTaskManager,
  docTaskRuntime,
  docTaskWorld,
  importWords,
  userPromptOf,
  waitTerminal,
  type DocRuntime,
  type DocRuntimeCall,
  type DocTaskWorld
} from '../helpers/doctask-fixtures'

// Phase 4 (whole-document-analysis plan §4.3, H4/H5/H8, L6) — the SYMMETRIC both-trees
// compare and lazy node embeddings. CI posture: mock runtime + mock embedder, zero network.
// The mock embedder is deterministic/hash-based, so node alignment is meaningful only for
// structure (M11) — these tests assert the MECHANICS (lazy embed + reuse + the H5 staleness
// guard + the labelled asymmetric fallback), not summary/diff CONTENT. The
// alignment MIRROR property is asserted purely in unit/node-align.test.ts.

let w: DocTaskWorld
let db: Db
let storeDir: string

beforeEach(() => {
  w = docTaskWorld('wdcmp')
  ;({ db, storeDir } = w)
})

const REPORT =
  '## What both documents share\n- A shared point.\n\n## What differs between them\n- A difference.'

/** Tree summaries + compare notes/report — deterministic per prompt shape. Tree-build single-pass summaries AND
 *  the reduce both get the REPORT. */
const compareReply = (call: DocRuntimeCall): string =>
  userPromptOf(call).includes('section by section') ? '- Same: a note.\n- Only in A: a thing.' : REPORT
const cmpRuntime = (): DocRuntime => docTaskRuntime({ reply: compareReply })
/** Every doc here is imported with mock vectors (the trees and the mode-(b) fallback need them). */
const importEmbedded = (n: number, name: string, prefix: string): Promise<string> =>
  importWords(w, n, { name, prefix, deps: { embedder: createMockEmbedder() } })
/** contextTokens 1024 (a small window ⇒ many tree nodes) + the given ingestion deps. */
const cmpManager = (runtime: DocRuntime, getIngestionDeps: DocTaskDeps['getIngestionDeps']): DocTaskManager =>
  docTaskManager(w, { getRuntime: () => runtime, getContextTokens: () => 1024, getIngestionDeps })

/** A mock embedder that counts embed() invocations (one per ensureNodeEmbeddings batch). */
class CountingEmbedder implements Embedder {
  readonly id: string
  readonly dimensions = 384
  embedCalls = 0
  private readonly inner = createMockEmbedder()
  constructor(id = 'mock-embedder') {
    this.id = id
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls += 1
    return this.inner.embed(texts)
  }
}

async function buildTreeFor(manager: DocTaskManager, id: string): Promise<void> {
  const { jobId } = manager.startDocTask({ kind: 'tree', documentIds: [id] })
  expect((await waitTerminal(manager, jobId, 15_000)).state).toBe('done')
  const row = db.prepare('SELECT tree_status FROM documents WHERE id = ?').get(id) as {
    tree_status: string | null
  }
  expect(row.tree_status).toBe('ready')
}

async function runCompare(
  manager: DocTaskManager,
  a: string,
  b: string
): Promise<{ state: string; docId: string | null; text: string }> {
  const { jobId } = manager.startDocTask({ kind: 'compare', documentIds: [a, b] })
  const { state } = await waitTerminal(manager, jobId, 15_000)
  const docId = manager.getDocTask(jobId).resultRef?.documentId ?? null
  const text = docId ? (await readStoredDocumentText(db, storeDir, docId)).text : ''
  return { state, docId, text }
}

interface NodeRow {
  id: string
  embedding_blob: Uint8Array | null
  dimensions: number | null
  embedding_model_id: string | null
}

function nodeRows(id: string): NodeRow[] {
  return db
    .prepare(
      'SELECT id, embedding_blob, dimensions, embedding_model_id FROM tree_nodes WHERE document_id = ?'
    )
    .all(id) as unknown as NodeRow[]
}

describe('symmetric both-trees compare (mode c) — lazy node embeddings', () => {
  it('takes the symmetric path, embeds nodes once under the active embedder, reuses them', async () => {
    const a = await importEmbedded(1200, 'a.txt', 'alpha')
    const b = await importEmbedded(1200, 'b.txt', 'beta')
    const embedder = new CountingEmbedder()
    const runtime = cmpRuntime()
    const manager = cmpManager(runtime, () => ({ embedder }))

    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)
    // Trees build on the chat runtime — NODE vectors are still NULL at this point (L6).
    expect(nodeRows(a).every((r) => r.embedding_blob === null)).toBe(true)
    expect(embedder.embedCalls).toBe(0)

    // First compare: lazily embeds both trees' nodes (one sidecar batch per document) plus the
    // one batch the materialize-import step embeds for the output doc's chunk.
    const first = await runCompare(manager, a, b)
    expect(first.state).toBe('done')
    expect(embedder.embedCalls).toBe(3) // 2 node-embed batches + 1 materialize embed

    // Every node now has a vector under the active embedder; count == node count.
    for (const id of [a, b]) {
      const rows = nodeRows(id)
      expect(rows.length).toBeGreaterThan(0)
      expect(
        rows.every(
          (r) => r.embedding_blob !== null && r.embedding_model_id === 'mock-embedder' && r.dimensions === 384
        )
      ).toBe(true)
    }

    // It really took the symmetric path (aligned-section diff prompts), not the A-driven one,
    // and the output carries NO asymmetric label.
    const prompts = runtime.calls.map(userPromptOf)
    expect(prompts.some((p) => p.includes('aligned section'))).toBe(true)
    expect(first.text).not.toContain('one-directional')

    // Second compare reuses the stored node vectors: only the materialize embed runs (1),
    // ZERO additional node-embed calls.
    const before = embedder.embedCalls
    const second = await runCompare(manager, a, b)
    expect(second.state).toBe('done')
    expect(embedder.embedCalls - before).toBe(1)
  })

  it('a tree rebuild reuses the cached node vectors — still 0 sidecar calls', async () => {
    const a = await importEmbedded(1200, 'a.txt', 'alpha')
    const b = await importEmbedded(1200, 'b.txt', 'beta')
    const embedder = new CountingEmbedder()
    const manager = cmpManager(cmpRuntime(), () => ({ embedder }))
    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)
    await runCompare(manager, a, b)
    expect(embedder.embedCalls).toBe(3) // 2 node-embed batches + 1 materialize embed

    // Rebuild both trees (warm summary_cache → fresh node rows with the SAME content_hash).
    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)
    // The rebuilt nodes start NULL again, but their vectors are cached in summary_cache.
    expect(nodeRows(a).every((r) => r.embedding_blob === null)).toBe(true)

    const before = embedder.embedCalls
    const again = await runCompare(manager, a, b)
    expect(again.state).toBe('done')
    // Only the materialize embed (1) — node vectors refilled from summary_cache, not the sidecar.
    expect(embedder.embedCalls - before).toBe(1)
    expect(nodeRows(a).every((r) => r.embedding_blob !== null)).toBe(true)
  })

  it('labels the symmetric report truncated when a lopsided pair overflows the reduce budget (M-1)', async () => {
    // A small doc A (few level-1 sections) vs a large doc B (many sections): the symmetric
    // path is still taken (min sections ≤ ceiling), aligns min(A,B) pairs, and attributes the
    // many leftover B sections to Only-B notes. Those notes overflow the small reduce budget,
    // so the belt condenses the tail — which must surface the honest truncation notice rather
    // than implying a complete two-way comparison (H8).
    const a = await importEmbedded(1200, 'a.txt', 'alpha')
    const b = await importEmbedded(12000, 'b.txt', 'beta')
    const manager = cmpManager(cmpRuntime(), () => ({ embedder: createMockEmbedder() }))
    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)

    const r = await runCompare(manager, a, b)
    expect(r.state).toBe('done')
    // Still the SYMMETRIC path (not the A-driven asymmetric fallback) — no one-directional label.
    expect(r.text).not.toContain('one-directional')
    // …but honestly flagged as condensed.
    expect(r.text).toContain(compareSymmetricTruncationNotice())
  })

  it('re-embeds under a NEW embedder (H5 staleness) — never a silent empty alignment', async () => {
    const a = await importEmbedded(1200, 'a.txt', 'alpha')
    const b = await importEmbedded(1200, 'b.txt', 'beta')
    const first = new CountingEmbedder('mock-embedder')
    let active: CountingEmbedder = first
    const manager = cmpManager(cmpRuntime(), () => ({ embedder: active }))
    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)
    await runCompare(manager, a, b)
    expect(nodeRows(a).every((r) => r.embedding_model_id === 'mock-embedder')).toBe(true)

    // Swap the active embedder (mock↔real / model swap). The node vectors are now stale; the
    // compare must RE-EMBED them under the new id (cheap, no chat), not align over nothing.
    const swapped = new CountingEmbedder('mock-embedder-v2')
    active = swapped
    const r = await runCompare(manager, a, b)
    expect(r.state).toBe('done')
    // 2 node re-embed batches (one per doc, under the new id) + 1 materialize embed.
    expect(swapped.embedCalls).toBe(3)
    for (const id of [a, b]) {
      expect(nodeRows(id).every((row) => row.embedding_model_id === 'mock-embedder-v2')).toBe(true)
    }
  })
})

describe('the symmetric call ceiling (SYMMETRIC_COMPARE_CALL_CEILING = 24) at its boundary (#682)', () => {
  it('a smaller doc with exactly 24 level-1 sections still compares symmetrically; 25 falls back to the labelled mode (b)', async () => {
    // At ctx 1024 the tree's 200-word group budget is below one 500-token chunk, so every chunk is its own level-1
    // section. Distinct prefixes share no words (the diff declines) and the sizes rule out a single pass, so the
    // ceiling alone picks the mode.
    const a = await importEmbedded(10_100, 'a.txt', 'alpha')
    const b = await importEmbedded(10_500, 'b.txt', 'beta')
    const c = await importEmbedded(10_500, 'c.txt', 'gamma')
    const runtime = cmpRuntime()
    const manager = cmpManager(runtime, () => ({ embedder: createMockEmbedder() }))
    for (const id of [a, b, c]) await buildTreeFor(manager, id)
    const level1 = (id: string): number =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM tree_nodes WHERE document_id = ? AND level = 1').get(id) as {
          n: number
        }
      ).n
    expect([level1(a), level1(b), level1(c)]).toEqual([24, 25, 25])

    // min(24, 25) = 24: at the ceiling, so the aligned-section path runs.
    let before = runtime.calls.length
    const atCeiling = await runCompare(manager, a, b)
    expect(atCeiling.state).toBe('done')
    expect(runtime.calls.slice(before).map(userPromptOf).some((p) => p.includes('aligned section'))).toBe(true)
    expect(atCeiling.text).not.toContain('one-directional')

    // min(25, 25) = 25: one over, so the compare falls back to mode (b) and says it is one-directional.
    before = runtime.calls.length
    const overCeiling = await runCompare(manager, b, c)
    expect(overCeiling.state).toBe('done')
    expect(runtime.calls.slice(before).map(userPromptOf).some((p) => p.includes('aligned section'))).toBe(false)
    expect(overCeiling.text).toContain(compareAsymmetricNotice('c.txt'))
  })
})

describe('asymmetric fallback (mode b) — labelled, reached only without both trees', () => {
  it('labels the comparison one-directional when the two documents are not both deeply indexed', async () => {
    const a = await importEmbedded(1200, 'a.txt', 'alpha')
    const b = await importEmbedded(1200, 'b.txt', 'beta')
    const manager = cmpManager(cmpRuntime(), () => ({ embedder: createMockEmbedder() }))
    // Build a tree on ONLY one of the two documents → symmetric path NOT available.
    await buildTreeFor(manager, a)

    const r = await runCompare(manager, a, b)
    expect(r.state).toBe('done')
    expect(r.text).toContain(compareAsymmetricNotice('b.txt'))
  })
})
