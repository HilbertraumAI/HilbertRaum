import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex, encodeVector } from '../../src/main/services/embeddings'
import {
  corpusNeedsReindex,
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  NO_DOCUMENT_CONTEXT_ANSWER,
  REINDEX_NEEDED_ANSWER,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  updateConversationScope
} from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// Phase 17 (post-mvp-functionality-plan §5): "ask selected documents" scoping through
// VectorIndex → retrieve → generateGroundedAnswer → the conversation's persisted
// scope_json, plus the actionable reindex-needed empty-corpus answer (§5.2).

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function freshDb(): { db: Db; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'paid-scope-')), 'test.sqlite')
  return { db: openDatabase(path), path }
}

/** Seed one indexed document with chunks + vectors under `modelId`. */
async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[],
  modelId: string = embedder.id
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const vectors = await embedder.embed(texts)
  for (let i = 0; i < texts.length; i++) {
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(chunkId, docId, i, texts[i], title, texts[i].split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, modelId, encodeVector(vectors[i]), vectors[i].length, now)
  }
  return docId
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- VectorIndex document scoping ------------------------------------------------

describe('VectorIndex documentIds scope', () => {
  it('only returns hits from the scoped documents', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    const docA = await seedDocument(db, embedder, 'a.txt', ['alpha unique words here'])
    await seedDocument(db, embedder, 'b.txt', ['alpha unique words here']) // identical text

    const scoped = new VectorIndex(db, embedder, {
      embeddingModelId: embedder.id,
      documentIds: [docA]
    })
    const hits = await scoped.searchText('alpha unique words here', 10)
    expect(hits).toHaveLength(1)
    const owner = db
      .prepare('SELECT document_id FROM chunks WHERE id = ?')
      .get(hits[0].chunkId) as unknown as { document_id: string }
    expect(owner.document_id).toBe(docA)
  })

  it('an empty/absent scope searches the whole corpus (existing behavior)', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['alpha words'])
    await seedDocument(db, embedder, 'b.txt', ['alpha words'])

    const unscoped = new VectorIndex(db, embedder, { embeddingModelId: embedder.id, documentIds: [] })
    expect(await unscoped.searchText('alpha words', 10)).toHaveLength(2)
  })

  it('composes with the embedding-model-id filter', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    const docA = await seedDocument(db, embedder, 'a.txt', ['alpha words'])
    await seedDocument(db, embedder, 'old.txt', ['alpha words'], 'old-model')

    const index = new VectorIndex(db, embedder, {
      embeddingModelId: embedder.id,
      documentIds: [docA]
    })
    expect(await index.searchText('alpha words', 10)).toHaveLength(1)
  })
})

// ---- retrieve + generateGroundedAnswer threading ----------------------------------

describe('scoped retrieval', () => {
  it('retrieve only cites the scoped document even when another matches better', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    const docA = await seedDocument(db, embedder, 'contract.pdf', ['payment terms net thirty days'])
    await seedDocument(db, embedder, 'notes.txt', ['the exact question text verbatim match'])

    const { chunks, citations } = await retrieve(
      db,
      embedder,
      'the exact question text verbatim match',
      SETTINGS,
      [docA]
    )
    expect(chunks.every((c) => c.documentId === docA)).toBe(true)
    expect(citations.every((c) => c.sourceTitle === 'contract.pdf')).toBe(true)
  })

  it('generateGroundedAnswer threads the conversation scope into retrieval', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    const docA = await seedDocument(db, embedder, 'a.pdf', ['solar panels convert light to power'])
    await seedDocument(db, embedder, 'b.pdf', ['solar panels convert light to power'])

    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: [docA] })
    const q = 'solar panels convert light to power'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, q, SETTINGS, {
      scopeDocumentIds: conv.scopeDocumentIds
    })
    expect(msg.citations?.length).toBe(1)
    expect(msg.citations?.[0].sourceTitle).toBe('a.pdf')
  })
})

// ---- The reindex-needed empty-corpus variant (§5.2) -------------------------------

describe('corpusNeedsReindex + REINDEX_NEEDED_ANSWER', () => {
  it('is false with no documents and false when a document is visible to the embedder', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
    await seedDocument(db, embedder, 'a.txt', ['alpha'])
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
  })

  it('is true when every indexed document was embedded under a different model', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['alpha'], 'old-model')
    expect(corpusNeedsReindex(db, embedder.id)).toBe(true)
    // A partial mismatch (one visible doc) goes back to the normal path.
    await seedDocument(db, embedder, 'b.txt', ['beta'])
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
  })

  it('answers with the re-index guidance, never calling the model', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    await seedDocument(db, embedder, 'a.txt', ['alpha words'], 'old-model')

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'alpha words' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const chatSpy = vi.spyOn(runtime, 'chatStream')

    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'alpha words', SETTINGS)
    expect(msg.content).toBe(REINDEX_NEEDED_ANSWER)
    expect(chatSpy).not.toHaveBeenCalled()
  })

  it('keeps the plain "not found" answer when the corpus is empty', async () => {
    const { db } = freshDb()
    const embedder = new MockEmbedder()
    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'anything' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'anything', SETTINGS)
    expect(msg.content).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
  })
})

// ---- Conversation scope persistence (chat service + migration) --------------------

describe('conversation scope persistence', () => {
  it('createConversation persists the scope and it round-trips through list/get', () => {
    const { db } = freshDb()
    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: ['d1', 'd2'] })
    expect(conv.scopeDocumentIds).toEqual(['d1', 'd2'])
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toEqual(['d1', 'd2'])
    expect(listConversations(db)[0].scopeDocumentIds).toEqual(['d1', 'd2'])
  })

  it('normalizes empty / junk scopes to null (whole corpus)', () => {
    const { db } = freshDb()
    expect(createConversation(db, { scopeDocumentIds: [] }).scopeDocumentIds).toBeNull()
    expect(createConversation(db, {}).scopeDocumentIds).toBeNull()
    // Malformed stored JSON must not break a conversation.
    const conv = createConversation(db, {})
    db.prepare('UPDATE conversations SET scope_json = ? WHERE id = ?').run('{not json', conv.id)
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toBeNull()
  })

  it('updateConversationScope replaces and clears the scope', () => {
    const { db } = freshDb()
    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: ['d1', 'd2'] })
    expect(updateConversationScope(db, conv.id, ['d1']).scopeDocumentIds).toEqual(['d1'])
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toEqual(['d1'])
    expect(updateConversationScope(db, conv.id, null).scopeDocumentIds).toBeNull()
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toBeNull()
    expect(() => updateConversationScope(db, 'nope', ['d1'])).toThrow(/Unknown conversation/)
  })

  it('migrates a pre-Phase-17 database: scope_json is added to an existing table', () => {
    // Build a DB whose conversations table predates the scope_json column, exactly as a
    // real pre-Phase-17 workspace would have it on disk.
    const dir = mkdtempSync(join(tmpdir(), 'paid-scope-mig-'))
    const path = join(dir, 'old.sqlite')
    const nodeRequire = createRequire(process.execPath)
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL DEFAULT 'chat')`)
    old.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, model_id, mode)
       VALUES ('legacy', 'Old chat', '2026-01-01', '2026-01-01', NULL, 'chat')`
    ).run()
    old.close()

    const db = openDatabase(path)
    const cols = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toContain('scope_json')
    // The legacy row reads back unscoped; new scoped writes work in the migrated DB.
    expect(getConversation(db, 'legacy')?.scopeDocumentIds).toBeNull()
    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: ['d9'] })
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toEqual(['d9'])
  })
})
