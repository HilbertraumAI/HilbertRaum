import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { generateGroundedAnswer, ragSettingsFrom } from '../../src/main/services/rag'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { DEFAULT_SETTINGS, type Message } from '../../src/shared/types'

// Beta-feedback plan Phase 5 (#24, D72) — the RELEVANCE path (ordinary "ask my documents"
// retrieval) now stamps a real `CoverageInfo` so the answer can show "based on N of M sections".
// This suite pins the STAMP (main): `mode:'relevance'`; `chunksCovered` = the distinct cited
// chunks; `chunksTotal` = Σ documentChunkCount over the DISTINCT documents the retrieved chunks
// came from (single-doc = that doc's total; multi-doc SUMS across the cited docs — honest by
// wording, never "whole document"); `fullyChunked` reflects those docs. An empty retrieval
// (NO_DOCUMENT_CONTEXT / REINDEX_NEEDED) still persists NO coverage. The whole-document/capped
// stamps are unchanged.

// A high cosine floor so only the exact-match chunk(s) survive retrieval — filler/decoy chunks
// (disjoint tokens ⇒ near-zero cosine, no keyword hit) are dropped, making the cited set exact.
const SETTINGS = { ...ragSettingsFrom(DEFAULT_SETTINGS), minSimilarity: 0.5 }

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-relcov-')), 'test.sqlite'))
}

function runtime() {
  return createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
}

interface SeedChunk {
  text: string
  pageNumber?: number | null
}

/** Insert one document (+ its mock embeddings) with an explicit `fully_chunked` state. */
async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  chunks: SeedChunk[],
  fullyChunked: boolean
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, fully_chunked, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?, ?)`
  ).run(docId, title, fullyChunked ? now : null, now, now)
  const vectors = await embedder.embed(chunks.map((c) => c.text))
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chunkId,
      docId,
      i,
      chunks[i].text,
      title,
      chunks[i].pageNumber ?? i + 1,
      null,
      chunks[i].text.split(/\s+/).length,
      now
    )
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
  }
  return docId
}

const QUERY = 'photosynthesis converts sunlight into chemical energy in plants'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relevance coverage stamp (Phase 5, #24, D72)', () => {
  it('a single-doc relevance answer stamps mode:relevance with cited/total section counts', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // 3 chunks total; only the first shares tokens with the query ⇒ 1 cited of 3 sections.
    const docId = await seedDocument(
      db,
      embedder,
      'science.pdf',
      [{ text: QUERY }, { text: 'unrelated alpha filler one' }, { text: 'unrelated beta filler two' }],
      true
    )
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUERY })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, QUERY, SETTINGS)) as Message

    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.coverage?.chunksTotal).toBe(3) // the whole document's section count
    // chunksCovered = distinct cited chunks, which map 1:1 to the persisted citations.
    expect(msg.coverage?.chunksCovered).toBe(msg.citations?.length)
    expect(msg.coverage?.chunksCovered).toBe(1)
    expect(msg.coverage?.fullyChunked).toBe(true)
  })

  it('fullyChunked is false when the cited document is not fully chunked (legacy/truncated)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'legacy.pdf', [{ text: QUERY }, { text: 'filler zzz' }], false)
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUERY })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, QUERY, SETTINGS)) as Message

    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.coverage?.fullyChunked).toBe(false)
  })

  it('a multi-doc relevance answer SUMS chunksTotal over the DISTINCT cited documents only', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // Two docs each carry a chunk matching the query (2 chunks each ⇒ totals sum to 4); a decoy
    // doc with disjoint text is NEVER cited, so its 5 sections must NOT enter the total.
    const docA = await seedDocument(db, embedder, 'a.pdf', [{ text: QUERY }, { text: 'a filler aaa' }], true)
    const docB = await seedDocument(db, embedder, 'b.pdf', [{ text: QUERY }, { text: 'b filler bbb' }], true)
    await seedDocument(
      db,
      embedder,
      'decoy.pdf',
      [
        { text: 'decoy one' },
        { text: 'decoy two' },
        { text: 'decoy three' },
        { text: 'decoy four' },
        { text: 'decoy five' }
      ],
      true
    )
    // No scope ⇒ the whole corpus is searchable; only a.pdf + b.pdf actually match.
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUERY })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, QUERY, SETTINGS)) as Message

    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.coverage?.chunksCovered).toBe(2) // one cited chunk per matching doc
    expect(msg.coverage?.chunksTotal).toBe(4) // a.pdf(2) + b.pdf(2) — decoy's 5 excluded
    expect(msg.coverage?.chunksCovered).toBe(msg.citations?.length)
    void docA
    void docB
  })

  it('an empty-retrieval turn (no document context) persists NO coverage', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'anything at all?' })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, 'anything at all?', SETTINGS)) as Message

    expect(msg.coverage).toBeUndefined()
    expect(msg.citations).toBeUndefined()
  })

  it('the whole-document path still stamps capped coverage (unchanged by Phase 5)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'whole.pdf', [{ text: QUERY }, { text: 'second section body' }], true)
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'summarise the whole document' })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, 'summarise the whole document', SETTINGS, {
      wholeDocument: { documentId: docId }
    })) as Message

    expect(msg.coverage?.mode).toBe('capped')
  })
})
