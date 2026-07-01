import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder } from '../../src/main/services/embeddings'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// TEST-3 (full-audit-2026-06-29 follow-up, Phase 7): a MODEL-FREE, deterministic CI FLOOR on
// end-to-end RAG RETRIEVAL quality — the one material coverage gap the audit found.
//
// The scorer logic (tests/eval/score.test.ts) and the skill-trigger precision bar are CI-gated,
// but actual retrieval→answer quality (does the known-correct passage come back, with the right
// citation?) was asserted ONLY in env-gated MANUAL suites (tests/manual/model-eval.test.ts,
// rag-quality.test.ts) that `npm test` never runs. So a regression in chunking / embedding-prefix /
// reranking / ragMinSimilarity / top-k / FUSION / citation assembly passed CI green.
//
// This guards the PLUMBING, not the model. The mock line is drawn at the SAME embedder seam the
// rest of the RAG integration suite uses (`MockEmbedder` — deterministic, hash-based, offline;
// rag.test.ts): the corpus is CONSTRUCTED so the known-correct chunk wins both the vector and the
// keyword channel decisively, then the REAL pipeline runs end-to-end — the real chunker
// (`processDocument`), the real `MockEmbedder`, the real `VectorIndex` cosine scan, the real FTS5
// keyword scan, the real RRF fusion, dedup, top-k trim, and `[Sn]`/`Citation[]` assembly. Nothing
// is over-mocked: only the embedder/model boundary is synthetic, exactly as the manual benchmark
// keeps the real model. The real-model EM/hallucination benchmark stays manual; THIS pins that the
// pipeline that feeds it stays wired.
//
// TEETH-CHECKED (recorded in architecture.md "Test-enforcement seams", Phase-7 subsection):
//   • break the FUSION ORDER (reverse `rrfFuse`'s sort in rag/hybrid.ts) → a distractor ranks
//     first → the "known-correct chunk is S1" assertion reds.
//   • drop the TOP-K trim (remove the `selected.length >= topKFinal` break in rag/index.ts) → the
//     over-cap corpus returns every candidate → the "capped at topKFinal" assertion reds.

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-ragfloor-')), 'test.sqlite'))
}

/** A real document store dir (the `documents/` subdir of a throwaway workspace). */
function freshStore(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-ragfloor-ws-')))
}

/**
 * Import ONE document through the REAL ingestion pipeline (write file → queue → chunk → embed →
 * store + FTS-index), so retrieval exercises the genuine chunker + FTS rows, not a hand-seeded
 * `chunks` insert. Returns the document id; the chunk's `source_label`/citation `sourceTitle` is
 * the file basename (ingestion/index.ts).
 */
async function importDoc(
  db: Db,
  storeDir: string,
  embedder: MockEmbedder,
  name: string,
  text: string
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-ragfloor-src-'))
  const src = join(dir, name)
  writeFileSync(src, text)
  const queued = createQueuedDocument(db, src)
  await processDocument(db, storeDir, queued.id, { embedder })
  return queued.id
}

// A fixed synthetic corpus: ONE answer document, ONE partially-relevant document, and one
// unrelated distractor. The question shares a large, distinctive token set with the answer
// (photosynthesis / sunlight / water / carbon dioxide / glucose / chloroplasts / green / plant);
// the PARTIAL doc shares only a few of those (green / plants / sunlight / water) so it reliably
// enters the candidate set but ranks strictly BELOW the answer; the distractor shares essentially
// none. The answer therefore wins both the cosine and the keyword channel decisively — and because
// a weaker competitor is always present, reversing the fusion order demonstrably moves the answer
// off the top (the fusion-order teeth-check bites).
const ANSWER_DOC = 'photosynthesis.txt'
const ANSWER_TEXT =
  'Photosynthesis converts sunlight water and carbon dioxide into glucose and oxygen inside the chloroplasts of green plant cells.'
const PARTIAL_DOC = 'garden-notes.txt'
const PARTIAL_TEXT = 'Green plants need plenty of sunlight and water to grow well through the summer.'
const DISTRACTOR_RECIPE = 'smoothie-recipe.txt'
const DISTRACTOR_TEXT =
  'Blend frozen bananas with creamy yogurt a spoonful of honey and a splash of milk for a quick breakfast.'
const QUESTION =
  'How does photosynthesis convert sunlight water and carbon dioxide into glucose inside the chloroplasts of green plant cells?'

describe('RAG pipeline floor (TEST-3, model-free)', () => {
  it('returns the known-correct chunk first, with its citation assembled (chunk→embed→fuse→rank→cite)', async () => {
    const db = freshDb()
    const store = freshStore()
    const embedder = new MockEmbedder()
    await importDoc(db, store, embedder, ANSWER_DOC, ANSWER_TEXT)
    await importDoc(db, store, embedder, PARTIAL_DOC, PARTIAL_TEXT)
    await importDoc(db, store, embedder, DISTRACTOR_RECIPE, DISTRACTOR_TEXT)

    const { chunks, citations } = await retrieve(db, embedder, QUESTION, SETTINGS)

    // The known-correct passage ranks FIRST (this is the assertion the fusion-order teeth-check
    // breaks) — by id/content, not just by topic.
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].label).toBe('S1')
    expect(chunks[0].sourceTitle).toBe(ANSWER_DOC)
    expect(chunks[0].text.toLowerCase()).toContain('glucose')
    expect(chunks.findIndex((c) => c.sourceTitle === ANSWER_DOC)).toBe(0)

    // …and its citation is assembled for the winning chunk (the [Sn]→Citation step).
    expect(citations[0]).toMatchObject({ label: 'S1', sourceTitle: ANSWER_DOC })
    expect(citations[0].snippet).toMatch(/photosynthesis/i)
  })

  it('caps the result at topKFinal even when more candidates rank above the similarity floor (top-k trim)', async () => {
    const db = freshDb()
    const store = freshStore()
    const embedder = new MockEmbedder()
    // Five documents that ALL share the query's distinctive phrase → all clear the (default 0)
    // similarity floor and all enter fusion. With topKFinal=3 the pipeline must return exactly 3.
    for (let i = 0; i < 5; i++) {
      await importDoc(
        db,
        store,
        embedder,
        `photosynthesis-${i}.txt`,
        `Photosynthesis in green plants converts sunlight into chemical energy. Field note number ${i}.`
      )
    }
    // A generous context budget so topKFinal — not maxContextTokens — is the binding cap.
    const capped: RagRetrievalSettings = { ...SETTINGS, topKFinal: 3, maxContextTokens: 1_000_000 }
    const { chunks } = await retrieve(
      db,
      embedder,
      'photosynthesis green plants convert sunlight into chemical energy',
      capped
    )

    expect(chunks).toHaveLength(3) // capped at topKFinal (drop the trim → 5 → reds)
    expect(chunks.map((c) => c.label)).toEqual(['S1', 'S2', 'S3'])
    // Every returned chunk is one of the indexed relevant docs (no phantom rows).
    for (const c of chunks) expect(c.sourceTitle.startsWith('photosynthesis-')).toBe(true)
  })

  it('assembles a cited grounded answer end-to-end whose first citation is the answer document', async () => {
    const db = freshDb()
    const store = freshStore()
    const embedder = new MockEmbedder()
    await importDoc(db, store, embedder, ANSWER_DOC, ANSWER_TEXT)
    await importDoc(db, store, embedder, PARTIAL_DOC, PARTIAL_TEXT)

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: QUESTION })
    const runtime = createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })

    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, QUESTION, SETTINGS)

    expect(msg.role).toBe('assistant')
    expect(msg.citations?.length).toBeGreaterThan(0)
    expect(msg.citations?.[0]).toMatchObject({ label: 'S1', sourceTitle: ANSWER_DOC })
  })

  // §L0 context-overflow fix (backend audit 2026-07-01): the relevance excerpt budget must clamp to
  // the REAL launched window, not just the fixed ragMaxContextTokens setting — otherwise a small-window
  // model's grounded turn overflows n_ctx and llama-server returns HTTP 400 "exceeds the context size".
  it('clamps the excerpt budget to a small launched window so fewer excerpts pack than a large window', async () => {
    const db = freshDb()
    const store = freshStore()
    const embedder = new MockEmbedder()
    // Six strongly-matching documents, each a sizable single chunk. With a large window they all pack
    // into the 2500-token excerpt budget; a small launched window must clamp to fewer so the grounded
    // turn fits. Removing the clamp (in generateGroundedAnswer) makes BOTH return the same count → reds.
    const filler = 'photosynthesis sunlight water carbon dioxide glucose oxygen chloroplasts green plant cells '.repeat(20)
    for (let i = 0; i < 6; i++) {
      await importDoc(db, store, embedder, `photosynthesis-${i}.txt`, `Document ${i}. ${filler}`)
    }
    const settings: RagRetrievalSettings = { ...SETTINGS, topKFinal: 6 }
    // A runtime that reports a given window but returns a trivial reply instantly — the mock's
    // default echoes the (large) grounded prompt token-by-token, which is irrelevant here and slow.
    const windowRuntime = (contextTokens: number): ReturnType<typeof createMockRuntime> => {
      const rt = createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens })
      ;(rt as { chatStream: unknown }).chatStream = async function* () {
        yield 'ok'
      }
      return rt
    }

    const bigConv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: bigConv.id, role: 'user', content: QUESTION })
    const big = await generateGroundedAnswer(db, windowRuntime(100_000), embedder, bigConv.id, QUESTION, settings)

    const smallConv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: smallConv.id, role: 'user', content: QUESTION })
    const small = await generateGroundedAnswer(db, windowRuntime(2048), embedder, smallConv.id, QUESTION, settings)

    // Large window packs more excerpts; the small window is clamped to fewer — but always ≥1 (the
    // grounding rule keeps the top chunk).
    expect(big.citations!.length).toBeGreaterThan(small.citations!.length)
    expect(small.citations!.length).toBeGreaterThanOrEqual(1)
  })
})
