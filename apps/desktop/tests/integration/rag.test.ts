import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import {
  buildGroundedPrompt,
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  NO_DOCUMENT_CONTEXT_ANSWER,
  type RagRetrievalSettings,
  type RetrievedChunk
} from '../../src/main/services/rag'
import { appendMessage, createConversation, listMessages } from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import {
  createQueuedDocument,
  documentsDir,
  processDocument
} from '../../src/main/services/ingestion'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-rag-')), 'test.sqlite'))
}
function store(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'paid-rag-ws-')))
}
function write(name: string, data: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'paid-rag-src-')), name)
  writeFileSync(p, data)
  return p
}

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

interface SeedChunk {
  text: string
  pageNumber?: number | null
  sectionLabel?: string | null
}

/** Insert one document with the given chunks + their mock embeddings. */
async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  chunks: SeedChunk[]
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
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
      chunks[i].pageNumber ?? null,
      chunks[i].sectionLabel ?? null,
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

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- Grounded prompt assembly (spec §7.8 template) ------------------------------

describe('buildGroundedPrompt', () => {
  const chunks: RetrievedChunk[] = [
    {
      label: 'S1',
      chunkId: 'c1',
      documentId: 'd1',
      text: 'The liability cap is one million dollars.',
      sourceTitle: 'Contract.pdf',
      pageNumber: 4,
      sectionLabel: null,
      score: 0.99
    },
    {
      label: 'S2',
      chunkId: 'c2',
      documentId: 'd2',
      text: 'Either party may terminate with notice.',
      sourceTitle: 'Terms.docx',
      pageNumber: null,
      sectionLabel: 'Termination',
      score: 0.8
    }
  ]

  it('matches the spec §7.8 template: rules, question, numbered excerpts, source format', () => {
    const p = buildGroundedPrompt('What is the liability cap?', chunks)
    expect(p).toContain('You are answering a question using local documents.')
    expect(p).toContain('Rules:')
    expect(p).toContain('- Cite sources inline using [S1], [S2], etc.')
    expect(p).toContain('- Do not invent citations.')
    // Question section carries the verbatim user question.
    expect(p).toContain('Question:\nWhat is the liability cap?')
    // Source-context format: "[Sn] File: X | Page: 4" then the quoted chunk text.
    expect(p).toContain('[S1] File: Contract.pdf | Page: 4')
    expect(p).toContain('"The liability cap is one million dollars."')
    // Page-less chunks fall back to the section label.
    expect(p).toContain('[S2] File: Terms.docx | Section: Termination')
    expect(p.trimEnd().endsWith('Answer:')).toBe(true)
  })

  it('omits the meta suffix when a chunk has neither page nor section', () => {
    const p = buildGroundedPrompt('q', [
      { ...chunks[0], pageNumber: null, sectionLabel: null, sourceTitle: 'notes.txt' }
    ])
    expect(p).toContain('[S1] File: notes.txt\n')
    expect(p).not.toContain('notes.txt |')
  })
})

// ---- Retrieval + citation resolution --------------------------------------------

describe('retrieve', () => {
  it('returns the matching chunk for a question with resolved citations + snippet', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'science.pdf', [
      { text: 'photosynthesis converts sunlight into chemical energy in plants', pageNumber: 2 },
      { text: 'the stock market rallied on strong earnings reports today', pageNumber: 7 }
    ])

    const { chunks, citations } = await retrieve(
      db,
      embedder,
      'photosynthesis converts sunlight into chemical energy in plants',
      SETTINGS
    )
    expect(chunks[0].label).toBe('S1')
    expect(chunks[0].text).toContain('photosynthesis')
    expect(chunks[0].score).toBeCloseTo(1, 5)

    expect(citations[0]).toMatchObject({
      label: 'S1',
      sourceTitle: 'science.pdf',
      pageNumber: 2
    })
    expect(citations[0].snippet).toContain('photosynthesis')
  })

  it('assigns sequential [Sn] labels in score order', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', [
      { text: 'alpha unique words one' },
      { text: 'beta different words two' },
      { text: 'gamma separate words three' }
    ])
    const { chunks } = await retrieve(db, embedder, 'alpha unique words one', SETTINGS)
    expect(chunks.map((c) => c.label)).toEqual(['S1', 'S2', 'S3'])
    expect(chunks[0].text).toContain('alpha')
  })

  it('dedups by document/page, keeping the best-scoring chunk per page', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'doc.pdf', [
      { text: 'alpha beta gamma delta', pageNumber: 4 }, // exact match → highest
      { text: 'alpha beta gamma delta epsilon zeta', pageNumber: 4 }, // same page, lower
      { text: 'unrelated content over here', pageNumber: 5 }
    ])
    const { chunks } = await retrieve(db, embedder, 'alpha beta gamma delta', SETTINGS)
    const page4 = chunks.filter((c) => c.pageNumber === 4)
    expect(page4).toHaveLength(1)
    expect(page4[0].text).toBe('alpha beta gamma delta')
  })

  it('trims to topKFinal under the max-context-tokens budget', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // Four ~1000-token chunks sharing the query tokens so all score high (no dedup: no page).
    const base = Array.from({ length: 1000 }, () => 'lorem').join(' ')
    await seedDocument(db, embedder, 'big.txt', [
      { text: `${base} one` },
      { text: `${base} two` },
      { text: `${base} three` },
      { text: `${base} four` }
    ])
    const budget: RagRetrievalSettings = { ...SETTINGS, maxContextTokens: 2500, topKFinal: 6 }
    const { chunks } = await retrieve(db, embedder, 'lorem', budget)
    // First chunk (~1001) always included; second fits (~2002); third would exceed 2500.
    expect(chunks).toHaveLength(2)
  })

  it('drops hits below the min-similarity threshold', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', [
      { text: 'quantum chromodynamics gauge theory' },
      { text: 'banana smoothie recipe with yogurt' }
    ])
    const strict: RagRetrievalSettings = { ...SETTINGS, minSimilarity: 0.99 }
    const { chunks } = await retrieve(db, embedder, 'quantum chromodynamics gauge theory', strict)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('quantum')
  })
})

// ---- generateGroundedAnswer: streaming + citation persistence -------------------

describe('generateGroundedAnswer', () => {
  function runtime() {
    return createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
  }

  it('streams an answer and persists citations to citations_json', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'science.pdf', [
      { text: 'photosynthesis converts sunlight into chemical energy in plants', pageNumber: 2 }
    ])
    const conv = createConversation(db, { mode: 'documents' })
    const question = 'photosynthesis converts sunlight into chemical energy in plants'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: question })

    const tokens: string[] = []
    const msg = await generateGroundedAnswer(db, runtime(), embedder, conv.id, question, SETTINGS, {
      onToken: (t) => tokens.push(t)
    })

    expect(tokens.length).toBeGreaterThan(1)
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe(tokens.join(''))
    expect(msg.citations).toBeDefined()
    expect(msg.citations?.[0]).toMatchObject({ label: 'S1', sourceTitle: 'science.pdf', pageNumber: 2 })

    // Citations round-trip through citations_json on reload.
    const reloaded = listMessages(db, conv.id).at(-1)
    expect(reloaded?.citations?.[0].label).toBe('S1')
    expect(reloaded?.citations?.[0].snippet).toContain('photosynthesis')
  })

  it('answers "not found in your documents" without calling the model on an empty corpus', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'anything?' })

    const rt = runtime()
    const chatSpy = vi.spyOn(rt, 'chatStream')
    const msg = await generateGroundedAnswer(db, rt, embedder, conv.id, 'anything?', SETTINGS)

    expect(msg.content).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
    expect(msg.citations).toBeUndefined()
    expect(chatSpy).not.toHaveBeenCalled()
  })
})

// ---- No-network guarantee across the whole ask path -----------------------------

describe('offline guarantee (RAG ask path)', () => {
  it('makes zero network calls across ingestion + retrieval + grounded answer', async () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const db = freshDb()
    const embedder = new MockEmbedder()
    const src = write('notes.txt', 'the local assistant answers strictly from your own documents')
    const queued = createQueuedDocument(db, src)
    await processDocument(db, store(), queued.id, { embedder })

    const conv = createConversation(db, { mode: 'documents' })
    const q = 'the local assistant answers strictly from your own documents'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })
    const rt = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const msg = await generateGroundedAnswer(db, rt, embedder, conv.id, q, SETTINGS)
    expect(msg.citations?.length).toBeGreaterThan(0)

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
