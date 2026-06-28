import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  MockEmbedder,
  VectorIndex,
  cosineSimilarity,
  dotProduct,
  encodeVector,
  decodeVector,
  MOCK_EMBEDDING_DIMENSIONS
} from '../../src/main/services/embeddings'
import {
  createQueuedDocument,
  processDocument,
  documentsDir
} from '../../src/main/services/ingestion'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-db-')), 'test.sqlite'))
}
function store(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-ws-')))
}
function write(name: string, data: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'hilbertraum-emb-')), name)
  writeFileSync(p, data)
  return p
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- MockEmbedder ---------------------------------------------------------------

describe('MockEmbedder', () => {
  it('is deterministic: same text → byte-identical vector', async () => {
    const embedder = new MockEmbedder()
    const [a] = await embedder.embed(['The quick brown fox'])
    const [b] = await embedder.embed(['The quick brown fox'])
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('produces L2-normalized vectors of the configured width (E5-small = 384)', async () => {
    const embedder = new MockEmbedder()
    expect(embedder.dimensions).toBe(MOCK_EMBEDDING_DIMENSIONS)
    expect(MOCK_EMBEDDING_DIMENSIONS).toBe(384)
    const [v] = await embedder.embed(['hello world'])
    expect(v).toHaveLength(384)
    let norm = 0
    for (const x of v) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
  })

  it('gives different texts different vectors but a self-match cosine of 1', async () => {
    const embedder = new MockEmbedder()
    const [a, b] = await embedder.embed(['cats and dogs', 'quantum chromodynamics'])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5)
    expect(cosineSimilarity(a, b)).toBeLessThan(0.99)
  })

  it('returns an all-zero vector for empty text (cosine 0, never NaN)', async () => {
    const embedder = new MockEmbedder()
    const [v] = await embedder.embed([''])
    expect(v.every((x) => x === 0)).toBe(true)
    expect(cosineSimilarity(v, v)).toBe(0)
  })
})

// ---- cosineSimilarity contract --------------------------------------------------

describe('cosineSimilarity', () => {
  it('throws on a length mismatch instead of scoring on the shorter prefix (L2)', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0, 0, 0])
    expect(() => cosineSimilarity(a, b)).toThrow(RangeError)
  })
})

// ---- dotProduct fast path (RAG-1) -----------------------------------------------

describe('dotProduct (RAG-1 search fast path)', () => {
  it('throws on a length mismatch like cosineSimilarity', () => {
    const a = new Float32Array([1, 0, 0])
    const b = new Float32Array([1, 0, 0, 0])
    expect(() => dotProduct(a, b)).toThrow(RangeError)
  })

  it('equals cosineSimilarity on L2-normalized vectors (the search invariant)', async () => {
    // VectorIndex.search relies on cosine == dot for normalized inputs. Embed real
    // (normalized) vectors and assert the two scorers agree to float tolerance.
    const embedder = new MockEmbedder()
    const vecs = await embedder.embed([
      'photosynthesis converts sunlight into chemical energy',
      'the stock market rallied on strong earnings',
      'a recipe for sourdough bread'
    ])
    for (const a of vecs) {
      for (const b of vecs) {
        expect(dotProduct(a, b)).toBeCloseTo(cosineSimilarity(a, b), 5)
      }
    }
  })

  it('produces the SAME ranking the search uses (sorted dot == sorted cosine)', async () => {
    const embedder = new MockEmbedder()
    const corpus = await embedder.embed(['alpha topic', 'beta topic', 'gamma topic', 'delta topic'])
    const [query] = await embedder.embed(['beta topic'])
    const byDot = corpus
      .map((v, i) => ({ i, s: dotProduct(query, v) }))
      .sort((x, y) => y.s - x.s)
      .map((h) => h.i)
    const byCos = corpus
      .map((v, i) => ({ i, s: cosineSimilarity(query, v) }))
      .sort((x, y) => y.s - x.s)
      .map((h) => h.i)
    expect(byDot).toEqual(byCos)
  })
})

// ---- BLOB round-trip ------------------------------------------------------------

describe('vector BLOB encoding', () => {
  it('round-trips Float32 → BLOB → Float32 exactly', () => {
    const original = new Float32Array([0.5, -0.25, 0.125, 1, -1, 0])
    const blob = encodeVector(original)
    const decoded = decodeVector(blob, original.length)
    expect(decoded).not.toBeNull()
    expect(Array.from(decoded!)).toEqual(Array.from(original))
  })

  it('decodes correctly even from an unaligned blob offset', () => {
    const original = new Float32Array([1.5, 2.5, 3.5, 4.5])
    const raw = encodeVector(original)
    // Force a non-4-byte-aligned offset to exercise the copy-on-decode path.
    const padded = Buffer.concat([Buffer.from([0]), raw])
    const unaligned = padded.subarray(1) // byteOffset = 1 (unaligned)
    const decoded = decodeVector(unaligned, original.length)
    expect(decoded).not.toBeNull()
    expect(Array.from(decoded!)).toEqual(Array.from(original))
  })

  it('returns null (does not throw) for a physically truncated blob — DATA-2 guard', () => {
    // A blob shorter than dimensions*4 bytes (e.g. a partial write). The OLD decodeVector
    // would throw a RangeError building the Float32Array view, crashing the caller's scan;
    // the guard now lives inside decodeVector so every call site can skip the row uniformly.
    expect(decodeVector(Buffer.alloc(16), 384)).toBeNull() // 16 bytes ≪ 384*4
    expect(decodeVector(new Uint8Array(0), 4)).toBeNull()
    // A non-positive dimension is also unusable (preserves node-vectors' `!dimensions` skip).
    expect(decodeVector(Buffer.alloc(16), 0)).toBeNull()
    // The boundary: exactly dimensions*4 bytes decodes normally.
    const exact = encodeVector(new Float32Array([1, 2, 3, 4]))
    expect(decodeVector(exact, 4)).not.toBeNull()
  })

  // TEST-N7: a FIXED little-endian byte layout, decoded WITHOUT going through encodeVector. The
  // round-trip tests above can't catch a SYMMETRIC endianness bug (encode + decode both flipped);
  // this pins the on-disk LE contract (spec §6 / EMB-4) against a known wire byte sequence.
  it('decodes a fixed little-endian byte layout independent of encodeVector (TEST-N7)', () => {
    // 1.0f == 0x3f800000, little-endian bytes [00 00 80 3f].
    expect(Array.from(decodeVector(Buffer.from([0x00, 0x00, 0x80, 0x3f]), 1)!)).toEqual([1])
    // [1.0, 2.0]: 2.0f == 0x40000000 → [00 00 00 40].
    expect(
      Array.from(decodeVector(Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40]), 2)!)
    ).toEqual([1, 2])
  })
})

// ---- VectorIndex cosine search --------------------------------------------------

describe('VectorIndex', () => {
  async function seedChunks(db: Db, embedder: MockEmbedder, texts: string[]): Promise<string[]> {
    // Minimal document + chunk + embedding rows so the index has something to scan.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at)
       VALUES ('doc', 'doc.txt', 'indexed', ?, ?)`
    ).run(now, now)
    const ids: string[] = []
    const vectors = await embedder.embed(texts)
    for (let i = 0; i < texts.length; i++) {
      const chunkId = `c${i}`
      ids.push(chunkId)
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
         VALUES (?, 'doc', ?, ?, 'doc.txt', 1, ?)`
      ).run(chunkId, i, texts[i], now)
      db.prepare(
        `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
    }
    return ids
  }

  it('ranks a chunk first when the query equals its text', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const texts = [
      'photosynthesis converts sunlight into chemical energy in plants',
      'the stock market rallied on strong earnings reports today',
      'a recipe for sourdough bread with a long fermentation'
    ]
    await seedChunks(db, embedder, texts)
    const index = new VectorIndex(db, embedder)

    const hits = await index.searchText(texts[1], 3)
    expect(hits).toHaveLength(3)
    expect(hits[0].chunkId).toBe('c1')
    expect(hits[0].score).toBeCloseTo(1, 5)
    // Results are sorted descending by score.
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score)
    expect(hits[1].score).toBeGreaterThanOrEqual(hits[2].score)
  })

  it('honours topK and ignores vectors of a different dimensionality', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedChunks(db, embedder, ['alpha', 'beta', 'gamma'])
    // A stray vector from a different model/dimension must be skipped, not crash.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
       VALUES ('cX', 'doc', 99, 'mismatch', 'doc.txt', 1, ?)`
    ).run(now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES ('cX', 'other', ?, 8, ?)`
    ).run(encodeVector(new Float32Array(8)), now)

    const index = new VectorIndex(db, embedder)
    const hits = await index.searchText('alpha', 2)
    expect(hits).toHaveLength(2)
    expect(hits.some((h) => h.chunkId === 'cX')).toBe(false)
  })

  it('skips a physically truncated blob instead of aborting the whole query', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedChunks(db, embedder, ['alpha', 'beta', 'gamma'])
    // A corrupt row whose blob is shorter than dimensions*4 bytes (e.g. a partial write).
    // The dimensions column still claims 384, so the dimension guard does not catch it —
    // decodeVector would throw a RangeError and break ALL search without the length guard.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
       VALUES ('cT', 'doc', 98, 'truncated', 'doc.txt', 1, ?)`
    ).run(now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES ('cT', ?, ?, 384, ?)`
    ).run(embedder.id, Buffer.alloc(16), now) // 16 bytes ≪ 384*4

    const index = new VectorIndex(db, embedder)
    const hits = await index.searchText('alpha', 3)
    expect(hits).toHaveLength(3) // the three good chunks, query did not crash
    expect(hits.some((h) => h.chunkId === 'cT')).toBe(false)
  })
})

// ---- Query-vector cache (RAG-5) -------------------------------------------------

describe('VectorIndex query-vector cache (RAG-5)', () => {
  async function seed(db: Db, embedder: MockEmbedder): Promise<void> {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at)
       VALUES ('doc', 'doc.txt', 'indexed', ?, ?)`
    ).run(now, now)
    const texts = ['alpha topic', 'beta topic', 'gamma topic']
    const vectors = await embedder.embed(texts)
    for (let i = 0; i < texts.length; i++) {
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, token_count, created_at)
         VALUES (?, 'doc', ?, ?, 'doc.txt', 1, ?)`
      ).run(`c${i}`, i, texts[i], now)
      db.prepare(
        `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(`c${i}`, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
    }
  }

  it('embeds an identical query only once across repeated searches (cache hit)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder)
    const index = new VectorIndex(db, embedder)
    const spy = vi.spyOn(embedder, 'embed') // count ONLY post-seed query embeds

    const first = await index.searchText('beta topic', 3)
    const second = await index.searchText('beta topic', 3)

    expect(spy).toHaveBeenCalledTimes(1) // second query served from the cache
    // A cache hit must return byte-identical ranking + scores.
    expect(second.map((h) => h.chunkId)).toEqual(first.map((h) => h.chunkId))
    expect(second.map((h) => h.score)).toEqual(first.map((h) => h.score))
  })

  it('re-embeds a different query string (key is the exact query)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder)
    const index = new VectorIndex(db, embedder)
    const spy = vi.spyOn(embedder, 'embed')

    await index.searchText('beta topic', 3)
    await index.searchText('gamma topic', 3)

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('shares the cache across VectorIndex instances over the same embedder', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seed(db, embedder)
    const spy = vi.spyOn(embedder, 'embed')

    await new VectorIndex(db, embedder).searchText('beta topic', 3)
    await new VectorIndex(db, embedder).searchText('beta topic', 3)

    expect(spy).toHaveBeenCalledTimes(1) // cache is keyed by embedder instance, not the index
  })

  it('starts fresh for a different embedder instance (cleared on embedder change)', async () => {
    const db = freshDb()
    const embedderA = new MockEmbedder()
    await seed(db, embedderA)
    await new VectorIndex(db, embedderA).searchText('beta topic', 3)

    // A swapped embedder (model change) is a new instance ⇒ empty cache ⇒ a real embed.
    const embedderB = new MockEmbedder()
    const spyB = vi.spyOn(embedderB, 'embed')
    await new VectorIndex(db, embedderB).searchText('beta topic', 3)
    expect(spyB).toHaveBeenCalledTimes(1)
  })
})

// ---- Ingestion writes embeddings ------------------------------------------------

describe('ingestion embedding step', () => {
  it('writes one tagged vector per chunk during processDocument', async () => {
    const db = freshDb()
    const storeDir = store()
    const embedder = new MockEmbedder({ id: 'test-embed-model' })
    const src = write('notes.txt', Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' '))

    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id, {
      embedder,
      embeddingModelId: 'test-embed-model'
    })
    expect(info.status).toBe('indexed')
    expect(info.chunkCount).toBeGreaterThan(1)

    const rows = db
      .prepare(
        `SELECT e.embedding_model_id AS model, e.dimensions AS dims
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ?`
      )
      .all(queued.id) as Array<{ model: string; dims: number }>
    // One embedding per chunk, all tagged with the active model id + correct dims.
    expect(rows).toHaveLength(info.chunkCount)
    expect(rows.every((r) => r.model === 'test-embed-model')).toBe(true)
    expect(rows.every((r) => r.dims === 384)).toBe(true)
  })

  it('falls back to embedder.id when no active embedding model is set', async () => {
    const db = freshDb()
    const storeDir = store()
    const embedder = new MockEmbedder()
    const src = write('a.txt', 'one two three four five')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, storeDir, queued.id, { embedder, embeddingModelId: null })
    const row = db
      .prepare(
        `SELECT e.embedding_model_id AS model FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ? LIMIT 1`
      )
      .get(queued.id) as { model: string }
    expect(row.model).toBe(embedder.id)
  })

  it('skips embedding (pass-through) when no embedder is supplied', async () => {
    const db = freshDb()
    const storeDir = store()
    const src = write('b.txt', 'alpha beta gamma')
    const queued = createQueuedDocument(db, src)
    const info = await processDocument(db, storeDir, queued.id)
    expect(info.status).toBe('indexed')
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ?`
      )
      .get(queued.id) as { n: number }
    expect(n.n).toBe(0)
  })
})

// ---- No-network guarantee (spec Milestone 5 acceptance) -------------------------

describe('offline guarantee', () => {
  it('makes zero network calls across embed + full ingestion + search', async () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const db = freshDb()
    const storeDir = store()
    const embedder = new MockEmbedder()
    const src = write('c.txt', 'the embedder must never touch the network at all')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, storeDir, queued.id, { embedder })
    const index = new VectorIndex(db, embedder)
    await index.searchText('network', 3)

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
