import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  MockEmbedder,
  VectorIndex,
  encodeVector,
  decodeVector,
  dotProduct,
  getResidentVectors,
  invalidateResidentVectors,
  purgeResidentVectors
} from '../../src/main/services/embeddings'
import {
  createQueuedDocument,
  processDocument,
  deleteDocument,
  documentsDir
} from '../../src/main/services/ingestion'

// RAG-1 / RAG-6 (perf audit Wave P4): the resident decoded-vector cache behind
// `VectorIndex.search`. These tests pin the highest-risk surface — the cache must NEVER serve a
// stale or post-lock vector, and ranking must stay byte-identical to a from-scratch decode.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-residcache-')), 'test.sqlite'))
}
function store(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-ws-')))
}
function writeSrc(name: string, data: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'hilbertraum-src-')), name)
  writeFileSync(p, data)
  return p
}

/** Seed one indexed doc with chunks + vectors via direct SQL (no invalidation hook). */
async function seedDoc(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[],
  modelId: string = embedder.id
): Promise<{ docId: string; chunkIds: string[] }> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const vectors = await embedder.embed(texts)
  const chunkIds: string[] = []
  for (let i = 0; i < texts.length; i++) {
    const chunkId = randomUUID()
    chunkIds.push(chunkId)
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(chunkId, docId, i, texts[i], title, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, modelId, encodeVector(vectors[i]), vectors[i].length, now)
  }
  return { docId, chunkIds }
}

/** From-scratch oracle: decode every stored vector and rank by dot product, no cache. */
function oracleRanking(db: Db, query: Float32Array, modelId: string): string[] {
  const rows = db
    .prepare('SELECT chunk_id, vector_blob, dimensions FROM embeddings WHERE embedding_model_id = ?')
    .all(modelId) as unknown as Array<{ chunk_id: string; vector_blob: Uint8Array; dimensions: number }>
  return rows
    .filter((r) => r.dimensions === query.length && r.vector_blob.length >= r.dimensions * 4)
    // The filter guarantees a full-length blob, so decodeVector is non-null here.
    .map((r) => ({ id: r.chunk_id, s: dotProduct(query, decodeVector(r.vector_blob, r.dimensions)!) }))
    .sort((a, b) => b.s - a.s)
    .map((h) => h.id)
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- Equivalence: cached ranking == from-scratch decode ranking -------------------

describe('resident cache — ranking equivalence', () => {
  it('produces the identical ranking + scores a from-scratch decode would', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const texts = Array.from({ length: 40 }, (_, i) => `topic number ${i} with some shared words`)
    await seedDoc(db, embedder, 'corpus.txt', texts)
    const [query] = await embedder.embed(['topic number 17 with some shared words'])

    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const hits = index.search(query, 40)
    // Same order as the oracle, to the last element.
    expect(hits.map((h) => h.chunkId)).toEqual(oracleRanking(db, query, embedder.id))
    // And the actual scores match a direct dot product to float tolerance.
    const resident = getResidentVectors(db)
    for (const h of hits) {
      expect(h.score).toBeCloseTo(dotProduct(query, resident.get(h.chunkId)!), 6)
    }
  })
})

// ---- Signature-driven staleness (the primary mechanism) ---------------------------

describe('resident cache — staleness signature', () => {
  it('reflects a direct INSERT made AFTER the cache was first built (no explicit hook)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, 'a.txt', ['alpha one', 'alpha two'])
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })

    // Build the cache.
    expect(index.search((await embedder.embed(['alpha']))[0], 10)).toHaveLength(2)

    // Direct INSERT bypassing every invalidation hook — only the signature can catch it.
    await seedDoc(db, embedder, 'b.txt', ['beta unique sentence here'])
    const [q] = await embedder.embed(['beta unique sentence here'])
    const hits = index.search(q, 10)
    expect(hits).toHaveLength(3) // the new chunk is visible
    expect(hits[0].score).toBeCloseTo(1, 5) // and ranks first (self-match)
  })

  it('reflects a direct DELETE made after the cache was built', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { chunkIds } = await seedDoc(db, embedder, 'a.txt', ['alpha one', 'alpha two', 'alpha three'])
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const [q] = await embedder.embed(['alpha'])
    expect(index.search(q, 10)).toHaveLength(3)

    db.prepare('DELETE FROM embeddings WHERE chunk_id = ?').run(chunkIds[0])
    const hits = index.search(q, 10)
    expect(hits).toHaveLength(2)
    expect(hits.some((h) => h.chunkId === chunkIds[0])).toBe(false)
  })
})

// ---- Explicit invalidate / purge --------------------------------------------------

describe('resident cache — invalidate & purge', () => {
  it('rebuilds correctly after an explicit invalidate', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, 'a.txt', ['alpha one', 'alpha two'])
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const [q] = await embedder.embed(['alpha'])
    expect(index.search(q, 10)).toHaveLength(2)
    invalidateResidentVectors(db)
    expect(index.search(q, 10)).toHaveLength(2) // rebuilds, same result
  })

  it('purge drops the cache (lock semantics) and the next search rebuilds', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, 'a.txt', ['alpha one', 'alpha two'])
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const [q] = await embedder.embed(['alpha'])
    const before = index.search(q, 10)
    purgeResidentVectors(db) // workspace-lock purge
    const after = index.search(q, 10) // rebuilt from the DB
    expect(after.map((h) => h.chunkId)).toEqual(before.map((h) => h.chunkId))
  })
})

// ---- Scope composition with the cache ---------------------------------------------

describe('resident cache — scope filters compose unchanged', () => {
  it('honours documentIds, the model-id filter, and includeArchived', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId: docA } = await seedDoc(db, embedder, 'a.txt', ['shared phrase here'])
    await seedDoc(db, embedder, 'b.txt', ['shared phrase here']) // identical text, other doc
    await seedDoc(db, embedder, 'old.txt', ['shared phrase here'], 'old-model') // stale model
    // Archive a fourth doc; default retrieval must exclude it.
    const { docId: archived } = await seedDoc(db, embedder, 'arch.txt', ['shared phrase here'])
    db.prepare("UPDATE documents SET lifecycle = 'archived' WHERE id = ?").run(archived)
    const [q] = await embedder.embed(['shared phrase here'])

    // Model filter: the 'old-model' doc is never returned.
    const all = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const allHits = all.search(q, 10)
    expect(allHits).toHaveLength(2) // docA + docB; archived excluded; old-model excluded
    const owners = new Set(
      allHits.map(
        (h) =>
          (db.prepare('SELECT document_id FROM chunks WHERE id = ?').get(h.chunkId) as { document_id: string })
            .document_id
      )
    )
    expect(owners.has(archived)).toBe(false)

    // documentIds scope: only docA.
    const scoped = new VectorIndex(db, embedder, { embeddingModelId: embedder.id, documentIds: [docA] })
    expect(scoped.search(q, 10)).toHaveLength(1)

    // includeArchived widens to include the archived doc.
    const withArchived = new VectorIndex(db, embedder, {
      embeddingModelId: embedder.id,
      includeArchived: true
    })
    expect(withArchived.search(q, 10)).toHaveLength(3)
  })
})

// ---- Ingestion write-path hooks (import / reindex / delete) ------------------------

describe('resident cache — ingestion lifecycle', () => {
  it('import → reindex (same doc) → delete all reflect through search', async () => {
    const db = freshDb()
    const storeDir = store()
    const embedder = new MockEmbedder()

    // Import builds the doc + vectors; the finalize-insert hook invalidates the cache.
    const src = writeSrc('doc.txt', 'the original sentence about photosynthesis in plants')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, storeDir, queued.id, { embedder })
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    const [qOrig] = await embedder.embed(['the original sentence about photosynthesis in plants'])
    let hits = index.search(qOrig, 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].score).toBeCloseTo(1, 5)

    // Reindex (same doc id): prepareDocument DELETEs the old chunks+embeddings (chunk-phase
    // hook) and finalizeDocument re-INSERTs fresh vectors (finalize hook). The cache must
    // rebuild cleanly — not go empty, not retain a phantom of the dropped row ids. New chunk
    // ids are minted, so a stale cache would surface dangling ids / a wrong count.
    await processDocument(db, storeDir, queued.id, { embedder })
    hits = index.search(qOrig, 5)
    expect(hits[0].score).toBeCloseTo(1, 5) // still self-matches after the rebuild
    // Every returned chunk id is a CURRENT row (no stale ids from the pre-reindex build).
    for (const h of hits) {
      const row = db.prepare('SELECT 1 FROM embeddings WHERE chunk_id = ?').get(h.chunkId)
      expect(row).toBeTruthy()
    }

    // Delete — the delete hook invalidates; no chunks remain.
    deleteDocument(db, queued.id)
    expect(index.search(qOrig, 5)).toHaveLength(0)
  })
})

// ---- Offline guarantee through the cached path ------------------------------------

describe('resident cache — offline guarantee', () => {
  it('makes zero network calls across build + search', async () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDoc(db, embedder, 'a.txt', ['offline alpha', 'offline beta'])
    const index = new VectorIndex(db, embedder, { embeddingModelId: embedder.id })
    index.search((await embedder.embed(['offline']))[0], 5) // builds cache + scans

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
