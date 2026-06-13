import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector } from '../../src/main/services/embeddings'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-mismatch-')), 'test.sqlite'))
}

/**
 * Seed a chunk + an embedding tagged with `modelId`. The vector is the MockEmbedder's
 * vector for `text` (deterministic, 384-dim) — but we deliberately tag DIFFERENT rows
 * with DIFFERENT model ids to simulate a corpus indexed under mock vs. real E5.
 */
async function seed(db: Db, embedder: MockEmbedder, chunkId: string, text: string, modelId: string): Promise<void> {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO documents (id, title, status, created_at, updated_at)
     VALUES ('doc', 'doc.txt', 'indexed', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
     VALUES (?, 'doc', 0, ?, 'doc.txt', 1, ?)`
  ).run(chunkId, text, now)
  const [vec] = await embedder.embed([text])
  db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(chunkId, modelId, encodeVector(vec), vec.length, now)
}

describe('embedding-model mismatch guard (Phase 10)', () => {
  it('both mock and real-E5 vectors are 384-dim — the dimension guard alone cannot separate them', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder, 'mock-chunk', 'shared text about privacy', 'mock-embedder')
    await seed(db, embedder, 'e5-chunk', 'shared text about privacy', 'multilingual-e5-small-q8')

    // WITHOUT a model-id filter, BOTH 384-dim rows match the query → they blend.
    const unfiltered = new VectorIndex(db, embedder)
    const hitsAll = await unfiltered.searchText('shared text about privacy', 10)
    expect(hitsAll.map((h) => h.chunkId).sort()).toEqual(['e5-chunk', 'mock-chunk'])
  })

  it('filters search to the active embedding_model_id so a mock→real switch cannot blend spaces', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder, 'mock-chunk', 'alpha beta gamma', 'mock-embedder')
    await seed(db, embedder, 'e5-chunk', 'alpha beta gamma', 'multilingual-e5-small-q8')

    // Scope to the real model id: only the E5-tagged vector is considered.
    const real = new VectorIndex(db, embedder, { embeddingModelId: 'multilingual-e5-small-q8' })
    const realHits = await real.searchText('alpha beta gamma', 10)
    expect(realHits.map((h) => h.chunkId)).toEqual(['e5-chunk'])

    // Scope to the mock id: only the mock-tagged vector is considered.
    const mock = new VectorIndex(db, embedder, { embeddingModelId: 'mock-embedder' })
    const mockHits = await mock.searchText('alpha beta gamma', 10)
    expect(mockHits.map((h) => h.chunkId)).toEqual(['mock-chunk'])
  })

  it('an empty/whitespace model id disables the filter (scans all rows)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder, 'a', 'one two three', 'mock-embedder')
    const idx = new VectorIndex(db, embedder, { embeddingModelId: '' })
    const hits = await idx.searchText('one two three', 5)
    expect(hits).toHaveLength(1)
  })
})
