import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Db } from '../../src/main/services/db'
import { MockEmbedder } from '../../src/main/services/embeddings'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { generateGroundedAnswer, ragSettingsFrom } from '../../src/main/services/rag'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { DEFAULT_SETTINGS, type Message } from '../../src/shared/types'
import { openFreshDb } from '../helpers/db-fixtures'
import { seedEmbeddedDoc } from '../helpers/doc-fixtures'

// Beta-feedback plan Phase 5 (#24, D72) — the RELEVANCE path (ordinary "ask my documents"
// retrieval) now stamps a real `CoverageInfo` so the answer can show "based on N of M sections".
// This suite pins the STAMP (main): `mode:'relevance'`; `chunksCovered` = the distinct cited
// chunks; `chunksTotal` = Σ documentChunkCount over the DISTINCT documents the retrieved chunks
// came from (single-doc = that doc's total; multi-doc SUMS across the cited docs — honest by
// wording, never "whole document"); `fullyChunked` reflects those docs. An empty retrieval
// (NO_DOCUMENT_CONTEXT / REINDEX_NEEDED) still persists NO coverage (the no-context case is pinned
// by rag.test.ts's empty-corpus row). The whole-document/capped stamps are unchanged.

// A high cosine floor so only the exact-match chunk(s) survive retrieval — filler/decoy chunks
// (disjoint tokens ⇒ near-zero cosine, no keyword hit) are dropped, making the cited set exact.
const SETTINGS = { ...ragSettingsFrom(DEFAULT_SETTINGS), minSimilarity: 0.5 }

function runtime() {
  return createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
}

/**
 * One indexed document (+ its mock embeddings) with an explicit `fully_chunked` state; chunk i sits on page i + 1.
 * The distinct pages are load-bearing: the (document, page) dedup would merge same-page cited chunks, and the
 * whole-document read de-overlaps same-page neighbours.
 */
function seedDocument(db: Db, embedder: MockEmbedder, title: string, texts: string[], fullyChunked: boolean): Promise<string> {
  return seedEmbeddedDoc(db, embedder, title, texts.map((text, i) => ({ text, page: i + 1 })), { fullyChunked })
}

const QUERY = 'photosynthesis converts sunlight into chemical energy in plants'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relevance coverage stamp (Phase 5, #24, D72)', () => {
  it('a single-doc relevance answer stamps mode:relevance with cited/total section counts', async () => {
    const db = openFreshDb('relcov')
    const embedder = new MockEmbedder()
    // 3 chunks total; only the first shares tokens with the query ⇒ 1 cited of 3 sections.
    const docId = await seedDocument(
      db,
      embedder,
      'science.pdf',
      [QUERY, 'unrelated alpha filler one', 'unrelated beta filler two'],
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
    const db = openFreshDb('relcov')
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'legacy.pdf', [QUERY, 'filler zzz'], false)
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUERY })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, QUERY, SETTINGS)) as Message

    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.coverage?.fullyChunked).toBe(false)
  })

  it('a multi-doc relevance answer SUMS chunksTotal over the DISTINCT cited documents only', async () => {
    const db = openFreshDb('relcov')
    const embedder = new MockEmbedder()
    // a.pdf carries TWO cited chunks (pages 1 and 2, so dedup keeps both) of 3, b.pdf one of 2; a decoy doc with
    // disjoint text is NEVER cited, so its 5 sections must NOT enter the total. a.pdf's two cited chunks are what
    // make a per-CHUNK sum (3 + 3 + 2 = 8) differ from the per-document one (3 + 2 = 5).
    await seedDocument(db, embedder, 'a.pdf', [QUERY, QUERY, 'a filler aaa'], true)
    await seedDocument(db, embedder, 'b.pdf', [QUERY, 'b filler bbb'], true)
    await seedDocument(db, embedder, 'decoy.pdf', ['decoy one', 'decoy two', 'decoy three', 'decoy four', 'decoy five'], true)
    // No scope ⇒ the whole corpus is searchable; only a.pdf + b.pdf actually match.
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUERY })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, QUERY, SETTINGS)) as Message

    expect(msg.coverage?.mode).toBe('relevance')
    expect(msg.coverage?.chunksCovered).toBe(3) // a.pdf's two cited chunks + b.pdf's one
    expect(msg.coverage?.chunksTotal).toBe(5) // a.pdf(3) + b.pdf(2), each document once — decoy's 5 excluded
    expect(msg.coverage?.chunksCovered).toBe(msg.citations?.length)
  })

  it('the whole-document path still stamps capped coverage (unchanged by Phase 5), labelled when it fits (#643)', async () => {
    const db = openFreshDb('relcov')
    const embedder = new MockEmbedder()
    const docId = await seedDocument(db, embedder, 'whole.pdf', [QUERY, 'second section body'], true)
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [docId] } })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'summarise the whole document' })

    const msg = (await generateGroundedAnswer(db, runtime(), embedder, conv.id, 'summarise the whole document', SETTINGS, {
      wholeDocument: { documentId: docId }
    })) as Message

    expect(msg.coverage?.mode).toBe('capped')
    // #643: the document fit, so one grounded turn showed both sections under their [Sn] labels — the
    // citations are labelled excerpts (cards keep [Sn], a review links the markers), not provenance.
    expect(msg.coverage?.labelledExcerpts).toBe(true)
  })
})
