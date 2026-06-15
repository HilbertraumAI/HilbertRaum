import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  processDocument,
  type IngestionDeps
} from '../../src/main/services/ingestion'
import { DocTaskManager, type DocTaskDeps } from '../../src/main/services/doctasks'
import {
  compareAsymmetricNotice,
  compareSymmetricTruncationNotice
} from '../../src/main/services/doctasks/compare'
import { decodeVector } from '../../src/main/services/embeddings'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions
} from '../../src/main/services/runtime'
import { readStoredDocumentText } from '../../src/main/services/ingestion'

// Phase 4 (whole-document-analysis plan §4.3, H4/H5/H8, L6) — the SYMMETRIC both-trees
// compare and lazy node embeddings. CI posture: mock runtime + mock embedder, zero network.
// The mock embedder is deterministic/hash-based, so node alignment is meaningful only for
// structure (M11) — these tests assert the MECHANICS (lazy embed + reuse + the H5 staleness
// guard + the labelled asymmetric fallback + persistence), not summary/diff CONTENT. The
// alignment MIRROR property is asserted purely in unit/node-align.test.ts.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-wdcmp-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

const REPORT =
  '## What both documents share\n- A shared point.\n\n## What differs between them\n- A difference.'

interface ScriptedRuntime extends ModelRuntime {
  calls: Array<{ messages: ChatMessage[]; options?: RuntimeChatOptions }>
}

function promptOf(call: { messages: ChatMessage[] }): string {
  return call.messages[call.messages.length - 1]?.content ?? ''
}

/** Tree summaries + compare notes/report — deterministic per prompt shape. */
function reply(call: { messages: ChatMessage[] }): string {
  const p = promptOf(call)
  if (p.includes('section by section')) return '- Same: a note.\n- Only in A: a thing.'
  return REPORT // tree-build single-pass summaries AND the reduce both land here
}

function scriptedRuntime(): ScriptedRuntime {
  const runtime: ScriptedRuntime = {
    modelId: 'scripted-model',
    calls: [],
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call = { messages, options }
      runtime.calls.push(call)
      const text = reply(call)
      for (const token of text.match(/\S+\s*/g) ?? [text]) {
        if (options?.signal?.aborted) return
        yield token
      }
    }
  }
  return runtime
}

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

async function importDoc(words: number, name: string, prefix: string): Promise<string> {
  const text = Array.from({ length: words }, (_, i) => `${prefix}${i}`).join(' ')
  const p = join(tmp, name)
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id, { embedder: createMockEmbedder() })
  expect(done.status).toBe('indexed')
  return info.id
}

function makeManager(opts: {
  runtime: ModelRuntime
  contextTokens?: number
  ingestionDeps: () => IngestionDeps
}): DocTaskManager {
  const deps: DocTaskDeps = {
    getDb: () => db,
    getRuntime: () => opts.runtime,
    isChatStreaming: () => false,
    getContextTokens: () => opts.contextTokens ?? 1024,
    getStoreDir: () => storeDir,
    getIngestionDeps: opts.ingestionDeps,
    beginDocumentWork: () => () => {}
  }
  return new DocTaskManager(deps)
}

async function waitTerminal(manager: DocTaskManager, jobId: string): Promise<string> {
  const start = Date.now()
  for (;;) {
    const s = manager.getDocTask(jobId)
    if (s.state === 'done' || s.state === 'failed' || s.state === 'cancelled') return s.state
    if (Date.now() - start > 15_000) throw new Error(`task ${jobId} never finished: ${s.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function buildTreeFor(manager: DocTaskManager, id: string): Promise<void> {
  const { jobId } = manager.startDocTask({ kind: 'tree', documentIds: [id] })
  expect(await waitTerminal(manager, jobId)).toBe('done')
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
  const state = await waitTerminal(manager, jobId)
  const docId = manager.getDocTask(jobId).resultRef?.documentId ?? null
  const text = docId ? readStoredDocumentText(db, storeDir, docId).text : ''
  return { state, docId, text }
}

function nodeRows(id: string): Array<{
  id: string
  embedding_blob: Uint8Array | null
  dimensions: number | null
  embedding_model_id: string | null
}> {
  return db
    .prepare(
      'SELECT id, embedding_blob, dimensions, embedding_model_id FROM tree_nodes WHERE document_id = ?'
    )
    .all(id) as never
}

describe('symmetric both-trees compare (mode c) — lazy node embeddings', () => {
  it('takes the symmetric path, embeds nodes once under the active embedder, reuses them', async () => {
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(1200, 'b.txt', 'beta')
    const embedder = new CountingEmbedder()
    const runtime = scriptedRuntime()
    const manager = makeManager({ runtime, ingestionDeps: () => ({ embedder }) })

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
      expect(rows.every((r) => r.embedding_blob !== null && r.embedding_model_id === 'mock-embedder')).toBe(
        true
      )
    }

    // It really took the symmetric path (aligned-section diff prompts), not the A-driven one,
    // and the output carries NO asymmetric label.
    const prompts = runtime.calls.map(promptOf)
    expect(prompts.some((p) => p.includes('aligned section'))).toBe(true)
    expect(first.text).not.toContain('one-directional')

    // Second compare reuses the stored node vectors: only the materialize embed runs (1),
    // ZERO additional node-embed calls.
    const before = embedder.embedCalls
    const second = await runCompare(manager, a, b)
    expect(second.state).toBe('done')
    expect(embedder.embedCalls - before).toBe(1)
  })

  it('a rebuild (re-index) reuses the cached node vectors — still 0 sidecar calls', async () => {
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(1200, 'b.txt', 'beta')
    const embedder = new CountingEmbedder()
    const manager = makeManager({ runtime: scriptedRuntime(), ingestionDeps: () => ({ embedder }) })
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
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(12000, 'b.txt', 'beta')
    const manager = makeManager({
      runtime: scriptedRuntime(),
      ingestionDeps: () => ({ embedder: createMockEmbedder() })
    })
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
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(1200, 'b.txt', 'beta')
    const first = new CountingEmbedder('mock-embedder')
    let active: CountingEmbedder = first
    const manager = makeManager({ runtime: scriptedRuntime(), ingestionDeps: () => ({ embedder: active }) })
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

describe('asymmetric fallback (mode b) — labelled, reached only without both trees', () => {
  it('labels the comparison one-directional when the two documents are not both deeply indexed', async () => {
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(1200, 'b.txt', 'beta')
    const manager = makeManager({
      runtime: scriptedRuntime(),
      ingestionDeps: () => ({ embedder: createMockEmbedder() })
    })
    // Build a tree on ONLY one of the two documents → symmetric path NOT available.
    await buildTreeFor(manager, a)

    const r = await runCompare(manager, a, b)
    expect(r.state).toBe('done')
    expect(r.text).toContain(compareAsymmetricNotice('b.txt'))
  })
})

describe('persistence — node vectors survive a reopen (whole-file encrypted at rest)', () => {
  it('node vectors persist and decode after the database is reopened', async () => {
    const a = await importDoc(1200, 'a.txt', 'alpha')
    const b = await importDoc(1200, 'b.txt', 'beta')
    const manager = makeManager({
      runtime: scriptedRuntime(),
      ingestionDeps: () => ({ embedder: createMockEmbedder() })
    })
    await buildTreeFor(manager, a)
    await buildTreeFor(manager, b)
    await runCompare(manager, a, b)

    const reopened = openDatabase(join(tmp, 'test.sqlite'))
    const rows = reopened
      .prepare(
        'SELECT embedding_blob, dimensions FROM tree_nodes WHERE document_id = ? AND embedding_blob IS NOT NULL'
      )
      .all(a) as Array<{ embedding_blob: Uint8Array; dimensions: number }>
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const vec = decodeVector(row.embedding_blob, row.dimensions)
      expect(vec).toHaveLength(384)
      let norm = 0
      for (const x of vec) norm += x * x
      expect(norm).toBeGreaterThan(0) // a real, non-zero vector round-tripped
    }
  })
})
