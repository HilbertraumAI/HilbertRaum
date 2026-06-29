import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector } from '../../src/main/services/embeddings'
import {
  buildFtsMatchQuery,
  keywordSearchChunks,
  rrfFuse,
  RRF_K
} from '../../src/main/services/rag/hybrid'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  REINDEX_NEEDED_ANSWER,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { Reranker } from '../../src/main/services/reranker'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// Phase 21 (rag-design §11 keyword index): the FTS5 keyword index — guarded migration +
// trigger sync + sanitized MATCH queries + the embedder-visibility rule — RRF fusion,
// and the rebuilt retrieve() pipeline incl. the fake-reranker end-to-end cases and the
// grounding-guard invariants.

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-hybrid-')), 'test.sqlite'))
}

/** Seed one indexed document with chunks + vectors under `modelId` (rag-scope pattern). */
async function seedDocument(
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
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(chunkId, docId, i, texts[i], title, texts[i].split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, modelId, encodeVector(vectors[i]), vectors[i].length, now)
  }
  return { docId, chunkIds }
}

function ftsRows(db: Db): Array<{ text: string; chunk_id: string }> {
  return db.prepare('SELECT text, chunk_id FROM chunks_fts ORDER BY chunk_id').all() as unknown as Array<{
    text: string
    chunk_id: string
  }>
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- Migration + trigger sync (db.ts ensureChunksFts) -----------------------------

describe('chunks_fts migration + sync', () => {
  it('creates the FTS table and triggers on a fresh database', () => {
    const db = freshDb()
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'chunks_fts%'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(names).toContain('chunks_fts')
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(triggers).toEqual(expect.arrayContaining(['chunks_fts_ai', 'chunks_fts_ad', 'chunks_fts_au']))
  })

  it('backfills a pre-Phase-21 database (existing chunks become searchable on open)', async () => {
    // Build a DB with the full pre-Phase-21 schema and chunk rows, but no FTS table —
    // exactly what an upgraded workspace looks like on disk (the scope_json precedent).
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-hybrid-mig-'))
    const path = join(dir, 'old.sqlite')
    const nodeRequire = createRequire(process.execPath)
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
      mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    old.exec(`CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL, source_label TEXT NOT NULL, page_number INTEGER,
      section_label TEXT, token_count INTEGER, created_at TEXT NOT NULL)`)
    old.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
       VALUES ('legacy-chunk', 'doc1', 0, 'legacy invoice text', 'old.pdf', '2026-01-01')`
    ).run()
    old.close()

    const db = openDatabase(path)
    expect(ftsRows(db)).toEqual([{ text: 'legacy invoice text', chunk_id: 'legacy-chunk' }])
    // And the backfill happens ONCE: re-opening must not duplicate rows.
    const again = openDatabase(path)
    expect(ftsRows(again)).toHaveLength(1)
  })

  it('triggers keep the index exact across insert, reindex (delete+insert), and delete', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId, chunkIds } = await seedDocument(db, embedder, 'a.txt', ['alpha text', 'beta text'])
    expect(ftsRows(db)).toHaveLength(2)

    // Re-index = delete a document's chunks + insert fresh ones (the ingestion path).
    db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(docId)
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId)
    expect(ftsRows(db)).toHaveLength(0)
    await seedDocument(db, embedder, 'a.txt', ['gamma replacement text'])
    expect(ftsRows(db).map((r) => r.text)).toEqual(['gamma replacement text'])

    // UPDATE OF text (no current code path does this, but the trigger covers it).
    const survivor = ftsRows(db)[0].chunk_id
    db.prepare('UPDATE chunks SET text = ? WHERE id = ?').run('edited text', survivor)
    expect(ftsRows(db).map((r) => r.text)).toEqual(['edited text'])
    expect(chunkIds).toHaveLength(2) // (lint appeasement: the original ids are gone)
  })
})

// ---- MATCH query sanitization ------------------------------------------------------

describe('buildFtsMatchQuery', () => {
  it('quotes tokens and ORs them (FTS5 operators in user text are neutralized)', () => {
    expect(buildFtsMatchQuery('invoice INV-2024-001')).toBe('"invoice" OR "inv" OR "2024" OR "001"')
    // Operator-laden questions become plain quoted tokens, never syntax.
    expect(buildFtsMatchQuery('a AND b OR c NEAR(d) NOT "e*"')).toBe(
      '"a" OR "and" OR "b" OR "or" OR "c" OR "near" OR "d" OR "not" OR "e"'
    )
  })

  it('returns null when the question has no tokens', () => {
    expect(buildFtsMatchQuery('')).toBeNull()
    expect(buildFtsMatchQuery('?! …')).toBeNull()
  })
})

// ---- keywordSearchChunks ----------------------------------------------------------

describe('keywordSearchChunks', () => {
  it('finds exact terms and ranks the term-bearing chunk first', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', [
      'general words about solar panels and power',
      'invoice INV-2024-001 total amount due'
    ])
    const hits = keywordSearchChunks(db, 'what is invoice INV-2024-001?', 10, {
      embeddingModelId: embedder.id
    })
    expect(hits.length).toBeGreaterThan(0)
    const top = db
      .prepare('SELECT text FROM chunks WHERE id = ?')
      .get(hits[0].chunkId) as unknown as { text: string }
    expect(top.text).toContain('INV-2024-001')
  })

  it('excludes chunks with no vector under the active embedder (visibility rule §5.4)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'old.txt', ['unique invoice token xyzzy'], 'old-model')
    // The text matches lexically, but the chunk is invisible to the active embedder —
    // the keyword path must NOT widen what vector search could see.
    expect(
      keywordSearchChunks(db, 'xyzzy', 10, { embeddingModelId: embedder.id })
    ).toHaveLength(0)
    expect(
      keywordSearchChunks(db, 'xyzzy', 10, { embeddingModelId: 'old-model' })
    ).toHaveLength(1)
  })

  it('composes with the documentIds scope', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const a = await seedDocument(db, embedder, 'a.txt', ['shared token zork here'])
    await seedDocument(db, embedder, 'b.txt', ['shared token zork there'])
    const hits = keywordSearchChunks(db, 'zork', 10, {
      embeddingModelId: embedder.id,
      documentIds: [a.docId]
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].chunkId).toBe(a.chunkIds[0])
  })

  it('returns [] for token-less questions and topK <= 0', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['alpha'])
    expect(keywordSearchChunks(db, '…', 10, { embeddingModelId: embedder.id })).toEqual([])
    expect(keywordSearchChunks(db, 'alpha', 0, { embeddingModelId: embedder.id })).toEqual([])
  })
})

// ---- RRF fusion --------------------------------------------------------------------

describe('rrfFuse', () => {
  it('a chunk found by both paths outranks single-path chunks at equal ranks', () => {
    const fused = rrfFuse(
      [
        { chunkId: 'both', score: 0.9 },
        { chunkId: 'vec-only', score: 0.8 }
      ],
      [{ chunkId: 'both', bm25: -2 }, { chunkId: 'kw-only', bm25: -1 }]
    )
    expect(fused[0].chunkId).toBe('both')
    expect(fused[0].rrfScore).toBeCloseTo(2 / (RRF_K + 1), 10)
    expect(fused[0].cosine).toBe(0.9)
    // Keyword-only candidates carry no cosine.
    const kwOnly = fused.find((c) => c.chunkId === 'kw-only')
    expect(kwOnly?.cosine).toBeNull()
  })

  it('with no keyword hits the fused order IS the vector order (pass-through)', () => {
    const fused = rrfFuse(
      [
        { chunkId: 'a', score: 0.9 },
        { chunkId: 'b', score: 0.5 },
        { chunkId: 'c', score: 0.1 }
      ],
      []
    )
    expect(fused.map((c) => c.chunkId)).toEqual(['a', 'b', 'c'])
    expect(fused.map((c) => c.cosine)).toEqual([0.9, 0.5, 0.1])
  })

  it('breaks exact ties deterministically (best rank across both lists, then chunk id)', () => {
    const fused = rrfFuse([], [{ chunkId: 'z', bm25: -1 }, { chunkId: 'y', bm25: -0.5 }])
    // A #1 vector hit vs a #1 keyword-only hit: equal RRF score, equal best rank (1) →
    // the ONLY remaining tiebreak is chunk id, so neither list is privileged (M-C4).
    const tie = rrfFuse([{ chunkId: 'v', score: 0.9 }], [{ chunkId: 'k', bm25: -1 }])
    expect(tie.map((c) => c.chunkId)).toEqual(['k', 'v']) // 'k' < 'v' by id; no list bias
    expect(fused.map((c) => c.chunkId)).toEqual(['z', 'y'])
  })

  // M-C4: a #1 keyword-only hit must NOT be systematically suppressed below a vector
  // hit it ties on RRF score. Before the fix, keyword-only chunks carried
  // vectorRank = MAX_SAFE_INTEGER and ALWAYS lost the tiebreak to any vector-listed
  // chunk, even one ranked lower in its own list.
  it('a #1 keyword-only hit ties on best rank with a #1 vector hit (not buried last)', () => {
    // Keyword-only 'invoice-code' is rank 1 → RRF 1/(K+1), best rank 1.
    // Vector 'vec-2' is rank 2 → RRF 1/(K+2), best rank 2. The keyword-only chunk has
    // BOTH the higher RRF score and the better best-rank, so it must outrank 'vec-2'.
    // Under the old vectorRank tiebreak its rank-1 status was invisible.
    const fused = rrfFuse(
      [
        { chunkId: 'vec-1', score: 0.9 }, // vector rank 1
        { chunkId: 'vec-2', score: 0.5 } // vector rank 2
      ],
      [{ chunkId: 'invoice-code', bm25: -3 }] // keyword rank 1, keyword-only
    )
    const codeIdx = fused.findIndex((c) => c.chunkId === 'invoice-code')
    const vec2Idx = fused.findIndex((c) => c.chunkId === 'vec-2')
    expect(codeIdx).toBeLessThan(vec2Idx) // exact-term hit beats the lower vector hit
    // It ties 'vec-1' exactly (both RRF 1/(K+1), both best rank 1) → id decides:
    // 'invoice-code' < 'vec-1', so the keyword-only chunk leads the result.
    expect(fused[0].chunkId).toBe('invoice-code')
  })
})

// ---- RAG-1 (full-audit-2026-06-29): per-list tie-break determinism -----------------

/**
 * Seed ONE document with two chunks that share identical text (so they tie on BOTH bm25 and
 * cosine). `firstId` is inserted first (lower rowid). Choosing ids whose insertion order is
 * the REVERSE of their sorted order makes the tiebreak observable: without it, both list
 * paths fall back to rowid/insertion order; with it, they pin chunkId-ascending.
 */
async function seedTiedPair(
  db: Db,
  embedder: MockEmbedder,
  firstId: string,
  secondId: string,
  text: string
): Promise<void> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, 'tied.txt', 'indexed', ?, ?)`
  ).run(docId, now, now)
  const [vec] = await embedder.embed([text])
  let idx = 0
  for (const chunkId of [firstId, secondId]) {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, 'tied.txt', NULL, NULL, ?, ?)`
    ).run(chunkId, docId, idx, text, text.split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vec), vec.length, now)
    idx++
  }
}

describe('RAG-1 tie-break determinism', () => {
  it('the vector path returns equal-cosine hits in stable chunkId order', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // 'chunk-zzz' is inserted FIRST (lower rowid / scan order) but sorts AFTER 'chunk-aaa'.
    await seedTiedPair(db, embedder, 'chunk-zzz', 'chunk-aaa', 'identical tied text')
    const [query] = await embedder.embed(['identical tied text'])
    const hits = new VectorIndex(db, embedder, { embeddingModelId: embedder.id }).search(query, 10)
    expect(hits).toHaveLength(2)
    expect(hits[0].score).toBeCloseTo(hits[1].score, 12) // genuinely tied cosines
    // The chunkId tiebreak pins ascending order regardless of scan order.
    // Teeth: drop the `|| (a.chunkId < b.chunkId …)` and the stable sort keeps scan order
    // (['chunk-zzz','chunk-aaa']) → this assertion fails.
    expect(hits.map((h) => h.chunkId)).toEqual(['chunk-aaa', 'chunk-zzz'])
  })

  it('the keyword path returns equal-bm25 hits in stable chunkId order', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedTiedPair(db, embedder, 'chunk-zzz', 'chunk-aaa', 'zork zork zork')
    const hits = keywordSearchChunks(db, 'zork', 10, { embeddingModelId: embedder.id })
    expect(hits).toHaveLength(2)
    expect(hits[0].bm25).toBeCloseTo(hits[1].bm25, 12) // identical text → identical bm25 rank
    // Teeth: drop `, chunks_fts.chunk_id` from the ORDER BY → SQLite returns the ties in
    // rowid order (['chunk-zzz','chunk-aaa']) → this assertion fails.
    expect(hits.map((h) => h.chunkId)).toEqual(['chunk-aaa', 'chunk-zzz'])
  })
})

// ---- retrieve() end-to-end: hybrid + reranker + grounding guard --------------------

function fakeReranker(scoreFor: (text: string) => number): Reranker & { calls: string[][] } {
  const calls: string[][] = []
  return {
    id: 'fake-reranker',
    calls,
    async rerank(_query, documents) {
      calls.push([...documents])
      return documents.map((d, index) => ({ index, score: scoreFor(d) }))
    }
  }
}

describe('retrieve() — hybrid pipeline', () => {
  it('a keyword hit rescues an exact-term chunk to #1, ahead of a vector-only distractor [TEST-N4]', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'similar.txt', ['solar panels convert light to power cleanly'])
    const invoice = await seedDocument(db, embedder, 'invoice.txt', [
      'INV-2024-001 totals nine hundred euro'
    ])
    // Simulate the real failure mode hybrid search exists for: the chunk's EMBEDDING
    // does not capture the literal code (here: overwrite it with an unrelated vector,
    // still visible under the active embedder), so the vector pass cannot rank it on the code.
    const [unrelated] = await embedder.embed(['completely unrelated padding text'])
    db.prepare('UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?').run(
      encodeVector(unrelated),
      invoice.chunkIds[0]
    )

    // TEST-N4: assert relative RANK, not just membership. minSimilarity -1 keeps BOTH chunks as
    // vector candidates (the distractor's noise cosine vs the code query is slightly negative);
    // only the invoice chunk is ALSO a keyword hit for the exact code. RRF rewards the chunk
    // present in BOTH lists, so the keyword path lifts the invoice chunk to #1 over the
    // vector-only distractor — deterministically, regardless of the noise-cosine vector order.
    const settings = { ...SETTINGS, minSimilarity: -1 }
    const { chunks } = await retrieve(db, embedder, 'INV-2024-001', settings)
    expect(chunks.map((c) => c.sourceTitle)).toEqual(['invoice.txt', 'similar.txt'])
  })

  it('applies the reranker ordering between fusion and dedup', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['solar panels convert light to power'])
    await seedDocument(db, embedder, 'b.txt', ['the payment terms are net thirty days'])

    // The reranker says the payment chunk is the relevant one — regardless of cosine.
    const reranker = fakeReranker((text) => (text.includes('payment') ? 9 : -3))
    const { chunks } = await retrieve(
      db,
      embedder,
      'solar panels convert light to power',
      SETTINGS,
      null,
      reranker
    )
    expect(chunks[0].sourceTitle).toBe('b.txt')
    expect(chunks[0].score).toBe(9) // score now carries the rerank relevance
    expect(reranker.calls).toHaveLength(1)
  })

  it('falls back to the fused order when the reranker fails (never breaks asking)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['solar panels convert light to power'])

    const failing: Reranker = {
      id: 'broken',
      async rerank() {
        throw new Error('sidecar died')
      }
    }
    const { chunks } = await retrieve(
      db,
      embedder,
      'solar panels convert light to power',
      SETTINGS,
      null,
      failing
    )
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].sourceTitle).toBe('a.txt')
  })

  it('is byte-identical to the vector-only pipeline when no reranker and no keyword overlap', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['alpha beta gamma'])
    await seedDocument(db, embedder, 'b.txt', ['delta epsilon zeta'])

    // No query token appears in any chunk → the keyword list is empty; with no
    // reranker, the result must be exactly the pre-Phase-21 one: cosine order +
    // cosine scores.
    const { chunks } = await retrieve(db, embedder, 'unrelated query words', SETTINGS)
    expect(chunks.length).toBeGreaterThan(0)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1].score).toBeGreaterThanOrEqual(chunks[i].score)
    }
    // Scores are cosines (bounded), not RRF scores (≤ ~2/(k+1) ≈ 0.033 for k=60 — a
    // cosine of exactly that magnitude is implausible for shared-token-free text).
    expect(chunks.every((c) => c.score >= -1 && c.score <= 1)).toBe(true)
  })

  it('grounding guard: an invisible corpus still yields REINDEX_NEEDED_ANSWER even with a lexical match', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // Indexed under another embedder: lexically matching, but invisible (§5.4).
    await seedDocument(db, embedder, 'old.txt', ['unique invoice token xyzzy'], 'old-model')

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'xyzzy' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const chatSpy = vi.spyOn(runtime, 'chatStream')

    const reranker = fakeReranker(() => 1)
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'xyzzy', SETTINGS, {
      reranker
    })
    expect(msg.content).toBe(REINDEX_NEEDED_ANSWER)
    expect(chatSpy).not.toHaveBeenCalled() // the model is NEVER called on empty retrieval
    expect(reranker.calls).toHaveLength(0) // nothing to rerank either
  })

  it('generateGroundedAnswer threads the reranker through opts', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['solar panels convert light to power'])
    const conv = createConversation(db, { mode: 'documents' })
    const q = 'solar panels convert light to power'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const reranker = fakeReranker(() => 5)
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, q, SETTINGS, { reranker })
    expect(reranker.calls).toHaveLength(1)
    expect(msg.citations?.length).toBeGreaterThan(0)
  })
})
