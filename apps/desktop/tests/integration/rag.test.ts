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
  buildGroundedChatMessages,
  buildGroundedPrompt,
  detectFilenameScope,
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
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-rag-')), 'test.sqlite'))
}
function store(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'hilbertraum-rag-ws-')))
}
function write(name: string, data: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'hilbertraum-rag-src-')), name)
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
    const budget: RagRetrievalSettings = { ...SETTINGS, maxContextTokens: 3500, topKFinal: 6 }
    const { chunks } = await retrieve(db, embedder, 'lorem', budget)
    // ~1001 words ≈ ceil(1001 * 1.3) ≈ 1302 model tokens per chunk. First chunk always
    // included (~1302); second fits (~2604 ≤ 3500); third would exceed 3500.
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

  // Filename auto-scope (detectFilenameScope) + retrieve narrowing: naming a file in the
  // question should keep other documents out of the sources. See scope.ts.
  it('restricts sources to the named file when the question names a filename', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const contractId = await seedDocument(db, embedder, 'contract.pdf', [
      { text: 'the liability cap under this agreement is one million dollars', pageNumber: 1 }
    ])
    await seedDocument(db, embedder, 'invoice.pdf', [
      // Worded to also resemble the question so it WOULD surface without scoping.
      { text: 'the liability cap line item on this invoice is one million dollars', pageNumber: 1 }
    ])

    const question = 'what is the liability cap in contract.pdf?'

    // Without scope, both documents surface as sources (the reported bug).
    const wide = await retrieve(db, embedder, question, SETTINGS)
    expect(new Set(wide.chunks.map((c) => c.sourceTitle))).toEqual(
      new Set(['contract.pdf', 'invoice.pdf'])
    )

    // The detector picks the named file, and scoped retrieval returns only its chunks.
    const detected = detectFilenameScope(question, [
      { id: contractId, title: 'contract.pdf' },
      { id: 'other', title: 'invoice.pdf' }
    ])
    expect(detected?.ids).toEqual([contractId])
    const scoped = await retrieve(db, embedder, question, SETTINGS, detected?.ids)
    expect(scoped.chunks.length).toBeGreaterThan(0)
    expect(scoped.chunks.every((c) => c.sourceTitle === 'contract.pdf')).toBe(true)
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

  it('drops structurally-wrong citations_json on reload instead of passing it untyped (L6)', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    // A valid-JSON but wrong-shape payload (e.g. a stale/hand-edited row): one good citation,
    // one missing the required sourceTitle, one not even an object.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, citations_json)
       VALUES ('m1', ?, 'assistant', 'answer', ?, NULL, ?)`
    ).run(
      conv.id,
      now,
      JSON.stringify([
        { label: 'S1', sourceTitle: 'good.pdf', pageNumber: 1 },
        { label: 'S2' }, // missing sourceTitle → rejected
        'not-an-object' // → rejected
      ])
    )
    // A row whose citations_json is not even valid JSON must not throw.
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, citations_json)
       VALUES ('m2', ?, 'assistant', 'answer2', ?, NULL, '{not json')`
    ).run(conv.id, now)

    const msgs = listMessages(db, conv.id)
    // Only the well-shaped citation survives; the malformed ones are dropped, not forwarded.
    expect(msgs[0].citations).toHaveLength(1)
    expect(msgs[0].citations?.[0]).toMatchObject({ label: 'S1', sourceTitle: 'good.pdf' })
    expect(msgs[1].citations).toBeUndefined()
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

  // Phase 20: document answers always run 'balanced' — no mode is sent to the runtime
  // (chatStream's omitted-mode default IS balanced), and persisted grounded answers
  // get the same think-block hygiene as plain chat (D6).
  it('passes NO answer-depth mode to the runtime (documents stay balanced)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', [{ text: 'grounded answers stay balanced here' }])
    const conv = createConversation(db, { mode: 'documents' })
    const q = 'grounded answers stay balanced here'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })

    const rt = runtime()
    const chatSpy = vi.spyOn(rt, 'chatStream')
    await generateGroundedAnswer(db, rt, embedder, conv.id, q, SETTINGS)

    expect(chatSpy).toHaveBeenCalledTimes(1)
    const options = chatSpy.mock.calls[0][1]
    expect(options?.mode).toBeUndefined()
  })

  it('strips inline think blocks from the persisted grounded answer (D6)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'b.txt', [{ text: 'thinking hygiene applies to grounded answers' }])
    const conv = createConversation(db, { mode: 'documents' })
    const q = 'thinking hygiene applies to grounded answers'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })

    const rt = runtime()
    vi.spyOn(rt, 'chatStream').mockImplementation(async function* () {
      yield '<think>retrieval reasoning</think>'
      yield 'Cited answer [S1].'
    })
    const msg = await generateGroundedAnswer(db, rt, embedder, conv.id, q, SETTINGS)
    expect(msg.content).toBe('Cited answer [S1].')
    expect(listMessages(db, conv.id).at(-1)?.content).not.toContain('<think>')
  })

  it('buildGroundedChatMessages scrubs think blocks from replayed assistant turns', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q1' })
    appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: '<think>old reasoning</think>Earlier cited answer [S1].'
    })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'q2' })

    const messages = buildGroundedChatMessages(db, conv.id, 'GROUNDED PROMPT')
    expect(messages.at(-1)?.content).toBe('GROUNDED PROMPT')
    const assistantTurn = messages.find((m) => m.role === 'assistant')
    expect(assistantTurn?.content).toBe('Earlier cited answer [S1].')
  })

  it('buildGroundedChatMessages trims old history to the context window, always keeping the grounded turn', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    const big = Array(300).fill('word').join(' ')
    // A long prior conversation that, with a fresh grounded block on top, would overflow.
    for (let i = 0; i < 10; i++) {
      appendMessage(db, { conversationId: conv.id, role: 'user', content: big })
      appendMessage(db, { conversationId: conv.id, role: 'assistant', content: big })
    }
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'current question' })

    const grounded = `GROUNDED BLOCK ${big}`
    const full = buildGroundedChatMessages(db, conv.id, grounded) // no budget
    const fitted = buildGroundedChatMessages(db, conv.id, grounded, 2048) // budgeted

    expect(fitted.length).toBeLessThan(full.length)
    expect(fitted[0].role).toBe('system')
    // The grounded prompt (which replaced the last user turn) is always the final message.
    expect(fitted.at(-1)?.content).toBe(grounded)
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
