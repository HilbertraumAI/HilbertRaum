import { describe, it, expect, vi, afterEach } from 'vitest'
import { openDatabase } from '../../src/main/services/db'
import { MockEmbedder, VectorIndex } from '../../src/main/services/embeddings'
import {
  corpusNeedsReindex,
  generateGroundedAnswer,
  ragSettingsFrom,
  retrieve,
  NO_DOCUMENT_CONTEXT_ANSWER,
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
import { legacyDbPath, openFreshDb } from '../helpers/db-fixtures'
import { chunkIdsOf, seedEmbeddedDoc } from '../helpers/doc-fixtures'

// Phase 17 (rag-design.md §10): "ask selected documents" scoping through
// VectorIndex → retrieve → generateGroundedAnswer → the conversation's persisted
// scope_json, plus the actionable reindex-needed empty-corpus answer (§5.2).

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- VectorIndex document scoping ------------------------------------------------

describe('VectorIndex documentIds scope', () => {
  it('only returns hits from the scoped documents', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    const docA = await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha unique words here'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['alpha unique words here']) // identical text

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
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha words'])
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['alpha words'])

    const unscoped = new VectorIndex(db, embedder, { embeddingModelId: embedder.id, documentIds: [] })
    expect(await unscoped.searchText('alpha words', 10)).toHaveLength(2)
  })

  it('composes with the embedding-model-id filter', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    const docA = await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha words'])
    const oldDoc = await seedEmbeddedDoc(db, embedder, 'old.txt', ['alpha words'], { modelId: 'old-model' })

    // The old-model document is INSIDE the doc scope, so only the model-id filter can drop its vector.
    const index = new VectorIndex(db, embedder, {
      embeddingModelId: embedder.id,
      documentIds: [docA, oldDoc]
    })
    expect((await index.searchText('alpha words', 10)).map((h) => h.chunkId)).toEqual(chunkIdsOf(db, docA))
  })
})

// ---- retrieve + generateGroundedAnswer threading ----------------------------------

describe('scoped retrieval', () => {
  it('retrieve only cites the scoped document even when another matches better', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    // docA matches the question only partly (cosine ≈0.36, two shared keywords); notes.txt matches it exactly.
    const docA = await seedEmbeddedDoc(db, embedder, 'contract.pdf', ['the payment terms of the question are net thirty days'])
    const notes = await seedEmbeddedDoc(db, embedder, 'notes.txt', ['the exact question text verbatim match'])
    const q = 'the exact question text verbatim match'
    const { chunks, citations } = await retrieve(db, embedder, q, SETTINGS, { documentIds: [docA] })
    expect(chunks.map((c) => c.documentId)).toEqual([docA])
    expect(citations.map((c) => c.sourceTitle)).toEqual(['contract.pdf'])
    // A null scope is the whole corpus, so the better match is back.
    const all = await retrieve(db, embedder, q, SETTINGS, null)
    expect(new Set(all.chunks.map((c) => c.documentId))).toEqual(new Set([docA, notes]))
  })

  // The production `scope` option (what registerRagIpc passes from resolveScope) must reach retrieval: two
  // identical documents, so only the scope can explain a single-source answer. collections-ipc's U3 pin does not
  // prove this — a pinned single document is read whole, a path that never reads the retrieval scope.
  it('generateGroundedAnswer threads the conversation scope into retrieval', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    const docA = await seedEmbeddedDoc(db, embedder, 'a.pdf', ['solar panels convert light to power'])
    await seedEmbeddedDoc(db, embedder, 'b.pdf', ['solar panels convert light to power'])

    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: [docA] })
    const q = 'solar panels convert light to power'
    appendMessage(db, { conversationId: conv.id, role: 'user', content: q })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, q, SETTINGS, {
      scope: { documentIds: conv.scopeDocumentIds }
    })
    expect(msg.citations?.length).toBe(1)
    expect(msg.citations?.[0].sourceTitle).toBe('a.pdf')
  })
})

// ---- The reindex-needed empty-corpus variant (§5.2) -------------------------------

describe('corpusNeedsReindex + REINDEX_NEEDED_ANSWER', () => {
  it('is false with no documents and false when a document is visible to the embedder', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha'])
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
  })

  it('is true when every indexed document was embedded under a different model', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    await seedEmbeddedDoc(db, embedder, 'a.txt', ['alpha'], { modelId: 'old-model' })
    expect(corpusNeedsReindex(db, embedder.id)).toBe(true)
    // A partial mismatch (one visible doc) goes back to the normal path.
    await seedEmbeddedDoc(db, embedder, 'b.txt', ['beta'])
    expect(corpusNeedsReindex(db, embedder.id)).toBe(false)
  })

})

// ---- RAG-N6: corpusNeedsReindex honours the SAME archived exclusion retrieval applies ----------
//
// retrieve() (and VectorIndex/keyword search) drop `lifecycle='archived'` documents unless
// scope.includeArchived is set, via the shared buildScopeFilter. corpusNeedsReindex must use the
// SAME filter, or an all-archived scope (where retrieval returns nothing) would be diagnosed as a
// STALE corpus (REINDEX_NEEDED) instead of an empty one (NO_DOCUMENT_CONTEXT). The check already
// routes through buildScopeFilter (Collections core); these tests pin that parity with teeth.
describe('corpusNeedsReindex includeArchived parity (RAG-N6)', () => {
  it('an all-archived, embedder-invisible scope is EMPTY (false), not stale, by default', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    // One indexed doc, embedded under a DIFFERENT model AND archived. Under the active embedder it
    // is invisible (would read as "stale") — but it is also archived, so an includeArchived-false
    // scope must treat it as out of scope entirely.
    const docId = await seedEmbeddedDoc(db, embedder, 'old-archived.txt', ['alpha words'], { modelId: 'old-model' })
    db.prepare("UPDATE documents SET lifecycle = 'archived' WHERE id = ?").run(docId)

    const scope = { documentIds: [docId], collectionIds: null, includeArchived: false }
    // Archived excluded ⇒ indexed count 0 ⇒ false. (Without the archived exclusion this reads
    // indexed=1/visible=0 ⇒ wrongly true ⇒ stale "needs reindex" diagnosis.)
    expect(corpusNeedsReindex(db, embedder.id, scope)).toBe(false)
    // With includeArchived the archived doc IS in scope and is invisible to the active embedder, so
    // the honest answer flips to "needs reindex" — proving the flag (not a blanket rule) drives it.
    expect(corpusNeedsReindex(db, embedder.id, { ...scope, includeArchived: true })).toBe(true)
  })

  it('generateGroundedAnswer over an all-archived scope answers NO_DOCUMENT_CONTEXT, not REINDEX_NEEDED', async () => {
    const db = openFreshDb('scope')
    const embedder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, embedder, 'old-archived.txt', ['alpha words'], { modelId: 'old-model' })
    db.prepare("UPDATE documents SET lifecycle = 'archived' WHERE id = ?").run(docId)

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'alpha words' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const chatSpy = vi.spyOn(runtime, 'chatStream')

    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'alpha words', SETTINGS, {
      scope: { documentIds: [docId], collectionIds: null, includeArchived: false }
    })
    // Retrieval excluded the archived doc → no chunks. The empty-context diagnosis must match that
    // exclusion: the scope is empty (NO_DOCUMENT_CONTEXT), not stale (REINDEX_NEEDED).
    expect(msg.content).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
    expect(chatSpy).not.toHaveBeenCalled()
  })
})

// ---- Conversation scope persistence (chat service + migration) --------------------

describe('conversation scope persistence', () => {
  it('createConversation persists the scope and it round-trips through list/get', () => {
    const db = openFreshDb('scope')
    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: ['d1', 'd2'] })
    expect(conv.scopeDocumentIds).toEqual(['d1', 'd2'])
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toEqual(['d1', 'd2'])
    expect(listConversations(db)[0].scopeDocumentIds).toEqual(['d1', 'd2'])
  })

  it('normalizes empty / junk scopes to null (whole corpus)', () => {
    const db = openFreshDb('scope')
    expect(createConversation(db, { scopeDocumentIds: [] }).scopeDocumentIds).toBeNull()
    expect(createConversation(db, {}).scopeDocumentIds).toBeNull()
    // Malformed stored JSON must not break a conversation.
    const conv = createConversation(db, {})
    db.prepare('UPDATE conversations SET scope_json = ? WHERE id = ?').run('{not json', conv.id)
    expect(getConversation(db, conv.id)?.scopeDocumentIds).toBeNull()
  })

  it('updateConversationScope replaces and clears the scope', () => {
    const db = openFreshDb('scope')
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
    const path = legacyDbPath('scope-mig', (raw) => {
      raw.exec(`CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL DEFAULT 'chat')`)
      raw.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, model_id, mode)
         VALUES ('legacy', 'Old chat', '2026-01-01', '2026-01-01', NULL, 'chat')`
      ).run()
    })

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
