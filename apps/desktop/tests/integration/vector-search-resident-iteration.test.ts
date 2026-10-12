import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector } from '../../src/main/services/embeddings'
import { setDocumentsLifecycle } from '../../src/main/services/collections'

// P2 (full-audit-2026-06-30) — when there is NO document/collection scope and the archived
// exclusion removes nothing, `VectorIndex.search` iterates the resident decoded-vector map directly
// (filtered by model id) and skips the per-query `SELECT chunk_id` marshal. This proves the fast
// path is (1) BYTE-IDENTICAL to the unchanged scoped scan over the same candidate universe, (2)
// actually TAKEN (no `SELECT chunk_id FROM embeddings` issued — unscoped, and with
// `includeArchived`), (3) correctly model-filtered, and
// (4) correctly DISABLED (falls to the scoped scan) when a live archived exclusion would change the
// candidate set (a real document scope: rag-scope.test.ts "VectorIndex documentIds scope"). Mock
// embedder only — zero model, zero network.

const E5 = 'multilingual-e5-small-q8'
let chunkIdx = 0

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-residiter-')), 'test.sqlite'))
}

async function seedChunk(
  db: Db,
  embedder: MockEmbedder,
  docId: string,
  text: string,
  modelId: string = E5
): Promise<string> {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO documents (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, docId, now, now)
  const chunkId = `chunk-${chunkIdx++}`
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, ?, ?, ?, 'd', 1, ?)`
  ).run(chunkId, docId, chunkIdx, text, now)
  const [vec] = await embedder.embed([text])
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, modelId, encodeVector(vec), vec.length, now)
  return chunkId
}

const TOPICS = [
  'privacy and data protection on a portable drive',
  'offline local language models running from usb',
  'reciprocal rank fusion of vector and keyword search',
  'invoice number 4471 due date and amount',
  'bank statement balance reconciliation and cashflow',
  'image understanding and optical character recognition',
  'encryption argon2id and aes gcm vaults',
  'document tree summarization raptor lite'
]
const QUERIES = [
  'how is privacy handled offline',
  'fuse keyword and vector ranking',
  'what is the invoice total',
  'encrypted vault key derivation'
]

/** Build a multi-doc corpus under `model`; returns the seeded doc ids. */
async function seedCorpus(db: Db, embedder: MockEmbedder, model: string): Promise<string[]> {
  const docs: string[] = []
  for (let i = 0; i < TOPICS.length; i++) {
    const docId = `doc-${model}-${i % 3}` // a few topics per doc
    await seedChunk(db, embedder, docId, TOPICS[i], model)
    if (!docs.includes(docId)) docs.push(docId)
  }
  return docs
}

function hitTuples(hits: { chunkId: string; score: number }[]): Array<[string, number]> {
  return hits.map((h) => [h.chunkId, h.score])
}

beforeEach(() => {
  chunkIdx = 0
})

describe('VectorIndex.search resident iteration (P2) — equivalence with the scoped scan', () => {
  it('no-scope search == an all-documents scoped search, hit-for-hit (ids + scores)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const docs = await seedCorpus(db, embedder, E5)

    const noScope = new VectorIndex(db, embedder, { embeddingModelId: E5 })
    // Passing EVERY doc id as an explicit scope forces the unchanged scoped SQL scan over the
    // identical candidate universe — the reference the fast path must reproduce.
    const allDocsScoped = new VectorIndex(db, embedder, { embeddingModelId: E5, documentIds: docs })

    for (const q of QUERIES) {
      for (const topK of [1, 3, 6, 100]) {
        const fast = await noScope.searchText(q, topK)
        const scoped = await allDocsScoped.searchText(q, topK)
        expect(hitTuples(fast)).toEqual(hitTuples(scoped))
      }
    }
  })

  it('actually takes the fast path: no `SELECT chunk_id FROM embeddings` for an unscoped search', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedCorpus(db, embedder, E5)
    const index = new VectorIndex(db, embedder, { embeddingModelId: E5 })

    await index.searchText(QUERIES[0], 6) // cold: builds the resident cache (one id-less full scan)
    const prepareSpy = vi.spyOn(db, 'prepare')
    await index.searchText(QUERIES[1], 6) // warm unscoped query
    const scannedChunkIds = prepareSpy.mock.calls.some((c) =>
      String(c[0]).includes('SELECT chunk_id FROM embeddings')
    )
    expect(scannedChunkIds).toBe(false) // the fast path skips the candidate marshal
    prepareSpy.mockRestore()
  })
})

describe('VectorIndex.search resident iteration (P2) — model-id filter', () => {
  it('filters search to the active embedding_model_id so a mock→real switch cannot blend spaces (Phase 10)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // Both are 384-dim, so the dimension guard alone cannot tell them apart.
    const mockChunk = await seedChunk(db, embedder, 'd', 'alpha beta gamma', 'mock-embedder')
    const e5Chunk = await seedChunk(db, embedder, 'd', 'alpha beta gamma', E5)

    // Scope to the real model id: only the E5-tagged vector is considered.
    const real = new VectorIndex(db, embedder, { embeddingModelId: E5 })
    expect((await real.searchText('alpha beta gamma', 10)).map((h) => h.chunkId)).toEqual([e5Chunk])
    // Scope to the mock id: only the mock-tagged vector is considered.
    const mock = new VectorIndex(db, embedder, { embeddingModelId: 'mock-embedder' })
    expect((await mock.searchText('alpha beta gamma', 10)).map((h) => h.chunkId)).toEqual([mockChunk])
  })

  it('a null model id disables the filter (fast path scans all resident vectors)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedChunk(db, embedder, 'd', 'alpha beta gamma', 'mock-embedder')
    await seedChunk(db, embedder, 'd', 'alpha beta gamma', E5)
    const unfiltered = new VectorIndex(db, embedder) // no embeddingModelId
    const hits = await unfiltered.searchText('alpha beta gamma', 10)
    expect(hits).toHaveLength(2) // both models' chunks, exactly like the old unfiltered scan
  })
})

describe('VectorIndex.search resident iteration (P2) — archived exclusion preserved', () => {
  it('disables the fast path when archived docs exist (default scope still excludes them)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const docs = await seedCorpus(db, embedder, E5)
    // The first chunk of doc[0] is the only privacy hit; archive that doc.
    setDocumentsLifecycle(db, [docs[0]], 'archived')

    const index = new VectorIndex(db, embedder, { embeddingModelId: E5 }) // includeArchived defaults false
    await index.searchText(QUERIES[0], 6) // cold build
    const prepareSpy = vi.spyOn(db, 'prepare')
    const hits = await index.searchText(QUERIES[0], 100)
    // With an archived doc present + excluded, the scoped scan runs (NOT the resident fast path)…
    const scannedChunkIds = prepareSpy.mock.calls.some((c) =>
      String(c[0]).includes('SELECT chunk_id FROM embeddings')
    )
    expect(scannedChunkIds).toBe(true)
    prepareSpy.mockRestore()
    // …and no chunk from the archived doc appears.
    const archivedChunkIds = new Set(
      (
        db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(docs[0]) as Array<{
          id: string
        }>
      ).map((r) => r.id)
    )
    expect(hits.every((h) => !archivedChunkIds.has(h.chunkId))).toBe(true)
  })

  it('includeArchived:true takes the fast path AND surfaces archived chunks (== scoped reference)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const docs = await seedCorpus(db, embedder, E5)
    setDocumentsLifecycle(db, [docs[0]], 'archived')

    const fastIncl = new VectorIndex(db, embedder, { embeddingModelId: E5, includeArchived: true })
    await fastIncl.searchText(QUERIES[0], 100) // cold: builds the resident cache
    const prepareSpy = vi.spyOn(db, 'prepare')
    const fast: Array<Array<[string, number]>> = []
    for (const q of QUERIES) fast.push(hitTuples(await fastIncl.searchText(q, 100)))
    const scannedChunkIds = prepareSpy.mock.calls.some((c) =>
      String(c[0]).includes('SELECT chunk_id FROM embeddings')
    )
    prepareSpy.mockRestore()
    expect(scannedChunkIds).toBe(false) // the fast path, archived documents and all
    expect(fast[0]).toHaveLength(TOPICS.length) // every resident chunk, the archived doc's included

    const scopedIncl = new VectorIndex(db, embedder, {
      embeddingModelId: E5,
      documentIds: docs,
      includeArchived: true
    })
    for (let i = 0; i < QUERIES.length; i++) {
      expect(fast[i]).toEqual(hitTuples(await scopedIncl.searchText(QUERIES[i], 100)))
    }
  })
})
