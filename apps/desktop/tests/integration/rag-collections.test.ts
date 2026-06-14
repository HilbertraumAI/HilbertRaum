import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
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
  addToCollection,
  createCollection,
  getBuiltinCollection,
  setCollectionArchived
} from '../../src/main/services/collections'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// Document-organization plan §10.2 (Phase A): collection-aware retrieval — the
// membership/id UNION (D1), the document-level archived exclusion (C1), the structural
// exclusion of generated docs (D3/N1), and the scope-threaded re-index check (M2). The
// legacy positional scope path stays byte-identical (covered in rag-scope.test.ts).

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-ragcoll-')), 'test.sqlite'))
}

async function seedDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[],
  opts: { modelId?: string; origin?: string | null } = {}
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, origin_json, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?, ?)`
  ).run(docId, title, opts.origin ?? null, now, now)
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
    ).run(chunkId, opts.modelId ?? embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
  }
  return docId
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('collection-scoped retrieval', () => {
  it('scopes to collection members and UNIONS them with specific document ids (D1)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'shared phrase across documents'
    const inProject = await seedDocument(db, embedder, 'project.pdf', [q])
    const specific = await seedDocument(db, embedder, 'specific.pdf', [q])
    await seedDocument(db, embedder, 'outsider.pdf', [q]) // neither in project nor selected

    const project = createCollection(db, 'Tax')
    addToCollection(db, [inProject], project.id)

    // Project only.
    const onlyProject = await retrieve(db, embedder, q, SETTINGS, { collectionIds: [project.id] })
    expect(onlyProject.chunks.map((c) => c.documentId)).toEqual([inProject])

    // Project ∪ a specific doc → both, never the outsider.
    const union = await retrieve(db, embedder, q, SETTINGS, {
      collectionIds: [project.id],
      documentIds: [specific]
    })
    expect(union.chunks.map((c) => c.documentId).sort()).toEqual([inProject, specific].sort())
  })

  it('counts a doc in BOTH a picked collection AND documentIds exactly once (D1 union de-dup, TEST-8)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'shared phrase across documents'
    const both = await seedDocument(db, embedder, 'both.pdf', [q, q]) // two chunks
    const project = createCollection(db, 'Tax')
    addToCollection(db, [both], project.id)

    // Same doc reachable via the collection EXISTS branch AND the explicit-id IN branch.
    const union = await retrieve(db, embedder, q, SETTINGS, {
      collectionIds: [project.id],
      documentIds: [both]
    })
    // The UNION must not double-count: exactly the doc's two chunks, each once.
    const fromBoth = union.chunks.filter((c) => c.documentId === both)
    expect(fromBoth).toHaveLength(2)
  })

  it('excludes document-level archived by default, includes with includeArchived (C1)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'archived content marker'
    const doc = await seedDocument(db, embedder, 'old.pdf', [q])
    const lib = getBuiltinCollection(db, 'library')!
    addToCollection(db, [doc], lib.id)
    db.prepare("UPDATE documents SET lifecycle = 'archived' WHERE id = ?").run(doc)

    const excluded = await retrieve(db, embedder, q, SETTINGS, { collectionIds: [lib.id] })
    expect(excluded.chunks).toHaveLength(0)
    const included = await retrieve(db, embedder, q, SETTINGS, {
      collectionIds: [lib.id],
      includeArchived: true
    })
    expect(included.chunks).toHaveLength(1)
  })

  it('keeps a Library member answerable even when its OTHER project is archived (C1)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'policy that lives in both library and a project'
    const doc = await seedDocument(db, embedder, 'policy.pdf', [q])
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Tax 2025')
    addToCollection(db, [doc], lib.id)
    addToCollection(db, [doc], project.id)

    setCollectionArchived(db, project.id, true) // archive the PROJECT, not the document

    // A Library-scoped ask still finds it: project archive is not a global exclusion.
    const fromLibrary = await retrieve(db, embedder, q, SETTINGS, { collectionIds: [lib.id] })
    expect(fromLibrary.chunks.map((c) => c.documentId)).toEqual([doc])
  })

  it('excludes a generated doc from a collection scope but allows explicit selection (D3/N1)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'translated text body content'
    const generated = await seedDocument(db, embedder, 'translation.md', [q], {
      origin: JSON.stringify({ type: 'translation' })
    })
    // Generated docs get NO membership (it would be skipped by backfill too).
    const lib = getBuiltinCollection(db, 'library')!

    const fromLibrary = await retrieve(db, embedder, q, SETTINGS, { collectionIds: [lib.id] })
    expect(fromLibrary.chunks).toHaveLength(0) // structurally absent — no membership

    const explicit = await retrieve(db, embedder, q, SETTINGS, { documentIds: [generated] })
    expect(explicit.chunks.map((c) => c.documentId)).toEqual([generated])
  })
})

describe('scope-aware corpusNeedsReindex (M2)', () => {
  it('empty-project scope ⇒ NO_DOCUMENT_CONTEXT (re-index would not help)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    // Library has a visible doc, but the (empty) project scope has none.
    const lib = getBuiltinCollection(db, 'library')!
    const inLib = await seedDocument(db, embedder, 'a.pdf', ['library content here'])
    addToCollection(db, [inLib], lib.id)
    const emptyProject = createCollection(db, 'Empty')

    expect(corpusNeedsReindex(db, embedder.id, { collectionIds: [emptyProject.id] })).toBe(false)

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'anything at all' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const chatSpy = vi.spyOn(runtime, 'chatStream')
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'anything at all', SETTINGS, {
      scope: { collectionIds: [emptyProject.id] }
    })
    expect(msg.content).toBe(NO_DOCUMENT_CONTEXT_ANSWER)
    expect(chatSpy).not.toHaveBeenCalled()
  })

  it('all-stale-project scope ⇒ REINDEX_NEEDED (indexed but invisible to the embedder)', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const stale = await seedDocument(db, embedder, 'stale.pdf', ['stale words'], {
      modelId: 'old-model'
    })
    const project = createCollection(db, 'Stale')
    addToCollection(db, [stale], project.id)

    expect(corpusNeedsReindex(db, embedder.id, { collectionIds: [project.id] })).toBe(true)

    const conv = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'stale words' })
    const runtime = createMockRuntime({ modelId: 'm', modelPath: '/m.gguf', contextTokens: 1024 })
    const msg = await generateGroundedAnswer(db, runtime, embedder, conv.id, 'stale words', SETTINGS, {
      scope: { collectionIds: [project.id] }
    })
    expect(msg.content).toBe(REINDEX_NEEDED_ANSWER)
  })
})

describe('legacy arg-5 union normalization (H3)', () => {
  it('a bare doc-id array still scopes exactly like before', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const q = 'identical phrase'
    const docA = await seedDocument(db, embedder, 'a.pdf', [q])
    await seedDocument(db, embedder, 'b.pdf', [q])
    const scoped = await retrieve(db, embedder, q, SETTINGS, [docA])
    expect(scoped.chunks.map((c) => c.documentId)).toEqual([docA])
    // null = whole corpus.
    const all = await retrieve(db, embedder, q, SETTINGS, null)
    expect(all.chunks.length).toBe(2)
  })
})
