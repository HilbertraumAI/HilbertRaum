import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector } from '../../src/main/services/embeddings'
import { buildFtsMatchQuery } from '../../src/main/services/fts'
import { keywordSearchChunks, rrfFuse } from '../../src/main/services/rag/hybrid'
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
import { legacyDbPath, openFreshDb } from '../helpers/db-fixtures'
import { chunkIdsOf, seedEmbeddedDoc } from '../helpers/doc-fixtures'

// Phase 21 (rag-design §11 keyword index): the FTS5 keyword index — the guarded migration's
// backfill + sanitized MATCH queries + the embedder-visibility rule — RRF fusion, and the
// rebuilt retrieve() pipeline incl. the fake-reranker end-to-end cases and the grounding-guard
// invariants. The chunks_fts trigger set and its sync are pinned in fts-rowid-sync.test.ts (CODE-4).

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function ftsRows(db: Db): Array<{ text: string; chunk_id: string }> {
  return db.prepare('SELECT text, chunk_id FROM chunks_fts ORDER BY chunk_id').all() as unknown as Array<{
    text: string
    chunk_id: string
  }>
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- Migration backfill (db.ts ensureChunksFts) -----------------------------------

describe('chunks_fts migration + sync', () => {
  it('backfills a pre-Phase-21 database (existing chunks become searchable on open)', async () => {
    // Build a DB with the full pre-Phase-21 schema and chunk rows, but no FTS table —
    // exactly what an upgraded workspace looks like on disk (the scope_json precedent).
    const path = legacyDbPath('hybrid-mig', (raw) => {
      raw.exec(`CREATE TABLE documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
        mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL,
        error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
      raw.exec(`CREATE TABLE chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL, source_label TEXT NOT NULL, page_number INTEGER,
        section_label TEXT, token_count INTEGER, created_at TEXT NOT NULL)`)
      raw.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
         VALUES ('legacy-chunk', 'doc1', 0, 'legacy invoice text', 'old.pdf', '2026-01-01')`
      ).run()
    })

    const db = openDatabase(path)
    expect(ftsRows(db)).toEqual([{ text: 'legacy invoice text', chunk_id: 'legacy-chunk' }])
    // And the backfill happens ONCE: re-opening must not duplicate rows.
    const again = openDatabase(path)
    expect(ftsRows(again)).toHaveLength(1)
  })
})

// ---- MATCH query sanitization ------------------------------------------------------

describe('buildFtsMatchQuery', () => {
  it('quotes tokens and ORs them (FTS5 operators in user text are neutralized); a token-less question yields null', () => {
    expect(buildFtsMatchQuery('invoice INV-2024-001')).toBe('"invoice" OR "inv" OR "2024" OR "001"')
    // Operator-laden questions become plain quoted tokens, never syntax.
    expect(buildFtsMatchQuery('a AND b OR c NEAR(d) NOT "e*"')).toBe(
      '"a" OR "and" OR "b" OR "or" OR "c" OR "near" OR "d" OR "not" OR "e"'
    )
    expect(buildFtsMatchQuery('')).toBeNull()
    expect(buildFtsMatchQuery('?! …')).toBeNull()
  })
})

// ---- keywordSearchChunks ----------------------------------------------------------

describe('keywordSearchChunks', () => {
  it('finds exact terms and ranks the term-bearing chunk first', async () => {
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', [
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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'old.txt', ['unique invoice token xyzzy'], { modelId: 'old-model' })
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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    const a = await seedEmbeddedDoc(db, embedder, 'a.txt', ['shared token zork here'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['shared token zork there'])
    const hits = keywordSearchChunks(db, 'zork', 10, {
      embeddingModelId: embedder.id,
      documentIds: [a]
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].chunkId).toBe(chunkIdsOf(db, a)[0])
  })

  it('returns [] for token-less questions and topK <= 0', async () => {
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha'])
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
    expect(fused[0].rrfScore).toBeCloseTo(2 / 61, 10) // RRF k = 60 (rag-design D13)
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
    // M-C4: a #1 vector hit vs a #1 keyword-only hit tie on RRF score AND best rank (1), so only
    // chunk id decides — before the fix keyword-only hits carried vectorRank = MAX_SAFE_INTEGER
    // and always lost this tie.
    const tie = rrfFuse([{ chunkId: 'v', score: 0.9 }], [{ chunkId: 'k', bm25: -1 }])
    expect(tie.map((c) => c.chunkId)).toEqual(['k', 'v']) // 'k' < 'v' by id; no list bias
    expect(fused.map((c) => c.chunkId)).toEqual(['z', 'y'])
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
    const db = openFreshDb('hybrid')
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
    const db = openFreshDb('hybrid')
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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'similar.txt', ['solar panels convert light to power cleanly'])
    const invoice = await seedEmbeddedDoc(db, embedder, 'invoice.txt', [
      'INV-2024-001 totals nine hundred euro'
    ])
    // Simulate the real failure mode hybrid search exists for: the chunk's EMBEDDING
    // does not capture the literal code (here: overwrite it with an unrelated vector,
    // still visible under the active embedder), so the vector pass cannot rank it on the code.
    const [unrelated] = await embedder.embed(['completely unrelated padding text'])
    db.prepare('UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?').run(
      encodeVector(unrelated),
      chunkIdsOf(db, invoice)[0]
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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['solar panels convert light to power'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['the payment terms are net thirty days'])

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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['solar panels convert light to power'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['solar panels store power for the night'])
    const q = 'solar panels convert light to power'
    const fused = await retrieve(db, embedder, q, SETTINGS)
    expect(fused.chunks).toHaveLength(2) // two candidates, so an order exists to keep
    const failing: Reranker = {
      id: 'broken',
      async rerank() {
        throw new Error('sidecar died')
      }
    }
    const { chunks } = await retrieve(db, embedder, q, SETTINGS, null, failing)
    expect(chunks.map((c) => [c.chunkId, c.score])).toEqual(fused.chunks.map((c) => [c.chunkId, c.score]))
  })

  it('is byte-identical to the vector-only pipeline when no reranker and no keyword overlap', async () => {
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha beta gamma'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['delta epsilon zeta'])

    // No query token appears in any chunk → the keyword list is empty; with no
    // reranker, the result must be exactly the pre-Phase-21 one: cosine order +
    // cosine scores.
    const q = 'unrelated query words'
    // Premise: no keyword overlap.
    expect(keywordSearchChunks(db, q, SETTINGS.topKInitial, { embeddingModelId: embedder.id })).toEqual([])
    const { chunks } = await retrieve(db, embedder, q, SETTINGS)
    const vectorOnly = (
      await new VectorIndex(db, embedder, { embeddingModelId: embedder.id }).searchText(q, SETTINGS.topKInitial)
    ).filter((h) => h.score >= SETTINGS.minSimilarity)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.map((c) => [c.chunkId, c.score])).toEqual(vectorOnly.map((h) => [h.chunkId, h.score]))
  })

  it('grounding guard: an invisible corpus still yields REINDEX_NEEDED_ANSWER even with a lexical match', async () => {
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    // Indexed under another embedder: lexically matching, but invisible (§5.4).
    await seedEmbeddedDoc(db, embedder, 'old.txt', ['unique invoice token xyzzy'], { modelId: 'old-model' })

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
    const db = openFreshDb('hybrid')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['solar panels convert light to power'])
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
