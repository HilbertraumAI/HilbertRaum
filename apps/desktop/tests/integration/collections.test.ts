import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  addToCollection,
  conversationAttachmentIds,
  createCollection,
  deleteCollection,
  docLifecycle,
  documentIdsInCollection,
  fileDocumentByDestination,
  fileFromPendingDestination,
  getBuiltinCollection,
  linkConversationDocument,
  listCollections,
  parsePendingDestination,
  projectOnlyDocumentIds,
  removeFromCollection,
  renameCollection,
  resolveScope,
  setCollectionArchived
} from '../../src/main/services/collections'
import {
  createConversation,
  getConversation,
  setConversationCollection,
  setScope
} from '../../src/main/services/chat'

// Document-organization plan, Phase A: collection CRUD + membership, the built-in
// seed + Library backfill migration, version-skew CASCADE, and resolveScope.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-coll-')), 'test.sqlite'))
}

/** Insert a bare document row (no chunks/vectors needed for membership tests). */
function seedDoc(
  db: Db,
  id: string,
  opts: { status?: string; origin?: string | null } = {}
): string {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, status, origin_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `${id}.txt`, opts.status ?? 'indexed', opts.origin ?? null, now, now)
  return id
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- Built-in seed + backfill migration (plan §9) ----------------------------------

describe('built-in seed', () => {
  it('seeds exactly one Library and one Temporary, undeletable + idempotent on re-open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-coll-seed-'))
    const path = join(dir, 'test.sqlite')
    const db = openDatabase(path)

    const library = getBuiltinCollection(db, 'library')
    const temporary = getBuiltinCollection(db, 'temporary')
    expect(library?.builtin).toBe(true)
    expect(temporary?.builtin).toBe(true)
    expect(library?.name).toBe('Library')
    expect(temporary?.name).toBe('Temporary')

    // Built-ins are undeletable / unarchivable.
    expect(() => deleteCollection(db, library!.id)).toThrow(/Built-in/)
    expect(() => setCollectionArchived(db, library!.id, true)).toThrow(/Built-in/)
    db.close()

    // Re-open: still exactly one of each (no double-seed).
    const again = openDatabase(path)
    expect(again.prepare("SELECT COUNT(*) AS n FROM collections WHERE type='library'").get()).toEqual({
      n: 1
    })
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM collections WHERE type='temporary'").get()
    ).toEqual({ n: 1 })
  })
})

describe('Library backfill', () => {
  it('files indexed non-generated unfiled docs into Library; skips generated + unindexed', () => {
    // Build a pre-feature DB (documents only) then migrate by opening it.
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-coll-bf-'))
    const path = join(dir, 'old.sqlite')
    const nodeRequire = createRequire(process.execPath)
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, original_path TEXT, stored_path TEXT,
      mime_type TEXT, size_bytes INTEGER, sha256 TEXT, status TEXT NOT NULL,
      error_message TEXT, origin_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    const ins = old.prepare(
      `INSERT INTO documents (id, title, status, origin_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`
    )
    ins.run('indexed-1', 'a.txt', 'indexed', null)
    ins.run('indexed-2', 'b.txt', 'indexed', null)
    ins.run('generated-1', 't.md', 'indexed', JSON.stringify({ type: 'translation' })) // generated → no membership
    ins.run('queued-1', 'c.txt', 'queued', null) // still importing → not backfilled (M1)
    old.close()

    const db = openDatabase(path)
    const library = getBuiltinCollection(db, 'library')!
    const members = documentIdsInCollection(db, library.id).sort()
    expect(members).toEqual(['indexed-1', 'indexed-2'])

    // Re-open must not double-file (the NOT EXISTS guard).
    const again = openDatabase(path)
    const lib2 = getBuiltinCollection(again, 'library')!
    expect(documentIdsInCollection(again, lib2.id).sort()).toEqual(['indexed-1', 'indexed-2'])
  })
})

// ---- CRUD + membership -------------------------------------------------------------

describe('collection CRUD + membership', () => {
  it('creates, renames, archives/unarchives a project; delete keeps its documents', () => {
    const db = freshDb()
    const project = createCollection(db, '  Tax 2025  ')
    expect(project.name).toBe('Tax 2025')
    expect(project.type).toBe('project')
    expect(project.builtin).toBe(false)
    expect(() => createCollection(db, '   ')).toThrow(/empty/)

    expect(renameCollection(db, project.id, 'Tax 2026').name).toBe('Tax 2026')
    expect(setCollectionArchived(db, project.id, true).archivedAt).not.toBeNull()
    expect(setCollectionArchived(db, project.id, false).archivedAt).toBeNull()

    const doc = seedDoc(db, 'doc-1')
    addToCollection(db, [doc], project.id)
    expect(documentIdsInCollection(db, project.id)).toEqual(['doc-1'])

    // Delete (membership-only) drops the collection + membership, keeps the document.
    deleteCollection(db, project.id)
    expect(listCollections(db).some((c) => c.id === project.id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM document_collections').get()
    ).toEqual({ n: 0 })
  })

  it('membership add is idempotent; remove is a no-op for non-members', () => {
    const db = freshDb()
    const project = createCollection(db, 'P')
    seedDoc(db, 'd1')
    addToCollection(db, ['d1'], project.id)
    addToCollection(db, ['d1'], project.id) // duplicate → no-op
    expect(documentIdsInCollection(db, project.id)).toEqual(['d1'])
    removeFromCollection(db, ['nope'], project.id) // not a member → no-op
    expect(documentIdsInCollection(db, project.id)).toEqual(['d1'])
    removeFromCollection(db, ['d1'], project.id)
    expect(documentIdsInCollection(db, project.id)).toEqual([])
  })

  it('docLifecycle coalesces NULL/unknown to permanent', () => {
    expect(docLifecycle(null)).toBe('permanent')
    expect(docLifecycle(undefined)).toBe('permanent')
    expect(docLifecycle('weird')).toBe('permanent')
    expect(docLifecycle('temporary')).toBe('temporary')
    expect(docLifecycle('archived')).toBe('archived')
  })
})

// ---- Version-skew: deleting a document cascades memberships + links (plan C4) -------

describe('ON DELETE CASCADE (version skew)', () => {
  it('a direct DELETE FROM documents cascades membership + conversation links, no FK error', () => {
    const db = freshDb()
    const project = createCollection(db, 'P')
    const lib = getBuiltinCollection(db, 'library')!
    const doc = seedDoc(db, 'd1')
    addToCollection(db, [doc], project.id)
    addToCollection(db, [doc], lib.id)
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare(
      `INSERT INTO conversation_documents (conversation_id, document_id, added_at) VALUES (?, ?, ?)`
    ).run(conv.id, doc, new Date().toISOString())

    // The pre-feature delete path: a direct DELETE with foreign_keys = ON.
    expect(() => db.prepare('DELETE FROM documents WHERE id = ?').run(doc)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_collections').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversation_documents').get()).toEqual({ n: 0 })
  })
})

// ---- resolveScope (plan §10.1) -----------------------------------------------------

describe('resolveScope', () => {
  it('defaults a documents-mode conversation to the whole Library', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const conv = createConversation(db, { mode: 'documents' })
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toEqual([lib.id])
    expect(scope.documentIds).toBeNull()
    expect(scope.hasExplicitDocSelection).toBe(false)
  })

  it('maps a legacy scope_json to a specific-doc selection', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents', scopeDocumentIds: ['da', 'db'] })
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toBeNull()
    expect(scope.documentIds).toEqual(['da', 'db'])
    expect(scope.hasExplicitDocSelection).toBe(true)
  })

  it('maps a legacy collection_id to that project', () => {
    const db = freshDb()
    const project = createCollection(db, 'P')
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare('UPDATE conversations SET collection_id = ? WHERE id = ?').run(project.id, conv.id)
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toEqual([project.id])
    expect(scope.hasExplicitDocSelection).toBe(false)
  })

  it('resolves a composite scope_v2_json as a union (collections + specific docs)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Tax')
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare('UPDATE conversations SET scope_v2_json = ? WHERE id = ?').run(
      JSON.stringify({ collectionIds: [lib.id, project.id], documentIds: ['contractA'] }),
      conv.id
    )
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds?.sort()).toEqual([lib.id, project.id].sort())
    expect(scope.documentIds).toEqual(['contractA'])
    expect(scope.hasExplicitDocSelection).toBe(true)
  })

  it('treats an empty scope_v2_json as the explicit "All documents" choice', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare('UPDATE conversations SET scope_v2_json = ? WHERE id = ?').run(
      JSON.stringify({ collectionIds: [], documentIds: [] }),
      conv.id
    )
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toBeNull()
    expect(scope.documentIds).toBeNull()
  })

  it('always unions chat attachments without flagging them as a hand-pick (N2)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const conv = createConversation(db, { mode: 'documents' })
    seedDoc(db, 'attach-1')
    db.prepare(
      `INSERT INTO conversation_documents (conversation_id, document_id, added_at) VALUES (?, ?, ?)`
    ).run(conv.id, 'attach-1', new Date().toISOString())
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toEqual([lib.id]) // default library still present
    expect(scope.documentIds).toEqual(['attach-1']) // attachment unioned in
    expect(scope.hasExplicitDocSelection).toBe(false) // attachment is NOT a hand-pick
  })

  it('falls back to the Library default on malformed scope_v2_json (never throws)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare('UPDATE conversations SET scope_v2_json = ? WHERE id = ?').run('{not json', conv.id)
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toEqual([lib.id])
  })

  // ---- D71 (#26): creation-time docs-only default scope for attachment / "Ask selected" chats ----
  // A conversation born from an attachment persists an EMPTY EXPLICIT scope at creation
  // (createDocsConversationForAttach); "Ask selected" persists the picked documentIds. Both must
  // resolve to exactly those documents, while a plain conversation stays on the Library default.
  it('an attachment-default conversation (empty explicit scope) resolves to just its attachments, not the whole Library (D71)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    // The attach path persists an empty EXPLICIT scope at creation.
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: [] }
    })
    seedDoc(db, 'attach-1')
    db.prepare(
      `INSERT INTO conversation_documents (conversation_id, document_id, added_at) VALUES (?, ?, ?)`
    ).run(conv.id, 'attach-1', new Date().toISOString())
    const scope = resolveScope(db, conv.id)
    // The Library collection is NOT in scope — retrieval is exactly the attached file (via the union).
    expect(scope.collectionIds).toBeNull()
    expect(scope.documentIds).toEqual(['attach-1'])
    expect(scope.hasExplicitDocSelection).toBe(false) // an attachment is not a hand-pick (N2)

    // Contrast (fallback byte-identical): a NULL-scope plain conversation with the SAME attachment
    // still keeps the whole Library alongside it — the #26 friction this phase leaves untouched for
    // plain chats. Only the creation-persisted scope changes for attachment/"Ask selected" chats.
    const plain = createConversation(db, { mode: 'documents' })
    db.prepare(
      `INSERT INTO conversation_documents (conversation_id, document_id, added_at) VALUES (?, ?, ?)`
    ).run(plain.id, 'attach-1', new Date().toISOString())
    const plainScope = resolveScope(db, plain.id)
    expect(plainScope.collectionIds).toEqual([lib.id])
    expect(plainScope.documentIds).toEqual(['attach-1'])
  })

  it('an "Ask selected" conversation (scope_v2 documentIds) resolves to exactly those documents (D71)', () => {
    const db = freshDb()
    const conv = createConversation(db, {
      mode: 'documents',
      scope: { collectionIds: [], documentIds: ['sel-1', 'sel-2'] }
    })
    const scope = resolveScope(db, conv.id)
    expect(scope.collectionIds).toBeNull()
    expect(scope.documentIds).toEqual(['sel-1', 'sel-2'])
    expect(scope.hasExplicitDocSelection).toBe(true)
  })
})

// ---- Conversation scope/collection data contract (plan §8.3, Phase B) --------------

describe('conversation scope + collection round-trip', () => {
  it('createConversation persists scope + collectionId; rowToConversation reads them back', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Tax')
    const conv = createConversation(db, {
      mode: 'documents',
      collectionId: project.id,
      scope: { collectionIds: [lib.id, project.id], documentIds: ['contractA'] }
    })
    const reread = getConversation(db, conv.id)!
    expect(reread.collectionId).toBe(project.id)
    expect(reread.scope).toEqual({
      collectionIds: [lib.id, project.id],
      documentIds: ['contractA'],
      includeArchived: false
    })
    // The composite scope is authoritative for resolveScope.
    const resolved = resolveScope(db, conv.id)
    expect(resolved.collectionIds?.sort()).toEqual([lib.id, project.id].sort())
    expect(resolved.documentIds).toEqual(['contractA'])
  })

  it('setScope writer round-trips; an empty scope is the explicit "All documents" choice', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    setScope(db, conv.id, { collectionIds: [], documentIds: [] })
    expect(getConversation(db, conv.id)!.scope).toEqual({
      collectionIds: [],
      documentIds: [],
      includeArchived: false
    })
    const resolved = resolveScope(db, conv.id)
    expect(resolved.collectionIds).toBeNull()
    expect(resolved.documentIds).toBeNull()
    // Null clears it back to the legacy/Library interpretation.
    setScope(db, conv.id, null)
    expect(getConversation(db, conv.id)!.scope).toBeNull()
  })

  it('setConversationCollection writer round-trips the anchor', () => {
    const db = freshDb()
    const project = createCollection(db, 'P')
    const conv = createConversation(db, { mode: 'documents' })
    setConversationCollection(db, conv.id, project.id)
    expect(getConversation(db, conv.id)!.collectionId).toBe(project.id)
    setConversationCollection(db, conv.id, null)
    expect(getConversation(db, conv.id)!.collectionId).toBeNull()
  })

  it('a corrupt scope_v2_json falls back without throwing (legacy/Library)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const conv = createConversation(db, { mode: 'documents' })
    db.prepare('UPDATE conversations SET scope_v2_json = ? WHERE id = ?').run('{bad', conv.id)
    expect(() => getConversation(db, conv.id)).not.toThrow()
    expect(getConversation(db, conv.id)!.scope).toBeNull()
    expect(resolveScope(db, conv.id).collectionIds).toEqual([lib.id])
  })

  it('projectOnlyDocumentIds spares a Library member and flags a project-only doc (C2)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Lawsuit')
    seedDoc(db, 'libdoc')
    seedDoc(db, 'projonly')
    addToCollection(db, ['libdoc'], lib.id)
    addToCollection(db, ['libdoc'], project.id)
    addToCollection(db, ['projonly'], project.id)
    expect(projectOnlyDocumentIds(db, project.id)).toEqual(['projonly'])
  })
})

// ---- Phase C: import destination filing (plan §11.3) -------------------------------

describe('import destination filing', () => {
  /** A document's stored lifecycle column (NULL-coalesced like the app). */
  function lifecycleOf(db: Db, id: string): string {
    const row = db.prepare('SELECT lifecycle FROM documents WHERE id = ?').get(id) as
      | { lifecycle: string | null }
      | undefined
    return docLifecycle(row?.lifecycle)
  }
  function isMember(db: Db, docId: string, collectionId: string): boolean {
    return (
      (db
        .prepare('SELECT 1 FROM document_collections WHERE document_id = ? AND collection_id = ?')
        .get(docId, collectionId) as unknown) != null
    )
  }

  it('parsePendingDestination tolerates junk and reads every kind', () => {
    expect(parsePendingDestination(null)).toBeNull()
    expect(parsePendingDestination('{bad')).toBeNull()
    expect(parsePendingDestination(JSON.stringify({ kind: 'nope' }))).toBeNull()
    expect(parsePendingDestination(JSON.stringify({ kind: 'collection' }))).toBeNull() // no id
    expect(parsePendingDestination(JSON.stringify({ kind: 'library' }))).toEqual({ kind: 'library' })
    expect(parsePendingDestination(JSON.stringify({ kind: 'temporary' }))).toEqual({
      kind: 'temporary'
    })
    expect(
      parsePendingDestination(JSON.stringify({ kind: 'collection', collectionId: 'p1' }))
    ).toEqual({ kind: 'collection', collectionId: 'p1' })
    expect(
      parsePendingDestination(JSON.stringify({ kind: 'conversation', conversationId: 'c1' }))
    ).toEqual({ kind: 'conversation', conversationId: 'c1' })
  })

  it('files a document by each destination kind (library/collection/temporary)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const temp = getBuiltinCollection(db, 'temporary')!
    const project = createCollection(db, 'Tax')

    seedDoc(db, 'toLib')
    fileDocumentByDestination(db, 'toLib', { kind: 'library' })
    expect(isMember(db, 'toLib', lib.id)).toBe(true)

    seedDoc(db, 'toProj')
    fileDocumentByDestination(db, 'toProj', { kind: 'collection', collectionId: project.id })
    expect(isMember(db, 'toProj', project.id)).toBe(true)
    expect(isMember(db, 'toProj', lib.id)).toBe(false) // a project import is NOT in Library

    seedDoc(db, 'toTemp')
    fileDocumentByDestination(db, 'toTemp', { kind: 'temporary' })
    expect(isMember(db, 'toTemp', temp.id)).toBe(true)
    expect(lifecycleOf(db, 'toTemp')).toBe('temporary')
    expect(isMember(db, 'toTemp', lib.id)).toBe(false) // temporary stays out of Library
  })

  it('a conversation destination links the doc + files it into Temporary (C3)', () => {
    const db = freshDb()
    const temp = getBuiltinCollection(db, 'temporary')!
    const conv = createConversation(db, { mode: 'documents' })
    seedDoc(db, 'attach')
    fileDocumentByDestination(db, 'attach', { kind: 'conversation', conversationId: conv.id })
    expect(conversationAttachmentIds(db, conv.id)).toEqual(['attach'])
    expect(isMember(db, 'attach', temp.id)).toBe(true)
    expect(lifecycleOf(db, 'attach')).toBe('temporary')
    // The link makes it answerable in this chat (resolveScope rule 1).
    expect(resolveScope(db, conv.id).documentIds).toContain('attach')
  })

  it('FK-guards the link write when the conversation is gone (N3) — doc stays in Temporary', () => {
    const db = freshDb()
    const temp = getBuiltinCollection(db, 'temporary')!
    seedDoc(db, 'orphan')
    // No such conversation: the link is skipped, never throws.
    expect(linkConversationDocument(db, 'ghost-conv', 'orphan')).toBe(false)
    expect(conversationAttachmentIds(db, 'ghost-conv')).toEqual([])
    // Filing to a deleted conversation keeps the doc in Temporary, drops only the link.
    fileDocumentByDestination(db, 'orphan', { kind: 'conversation', conversationId: 'ghost-conv' })
    expect(isMember(db, 'orphan', temp.id)).toBe(true)
    expect(lifecycleOf(db, 'orphan')).toBe('temporary')
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM conversation_documents').get()
    ).toEqual({ n: 0 })
  })

  it('the link write is idempotent (append-only, ON CONFLICT DO NOTHING)', () => {
    const db = freshDb()
    const conv = createConversation(db, { mode: 'documents' })
    seedDoc(db, 'a1')
    expect(linkConversationDocument(db, conv.id, 'a1')).toBe(true)
    expect(linkConversationDocument(db, conv.id, 'a1')).toBe(true) // duplicate → no-op
    expect(conversationAttachmentIds(db, conv.id)).toEqual(['a1'])
  })

  it('fileFromPendingDestination resumes a crash-interrupted import to its destination (M1)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    const project = createCollection(db, 'Lawsuit')
    // A doc queued for a project, then "killed" mid-import (status stays queued).
    seedDoc(db, 'resume', { status: 'queued' })
    db.prepare('UPDATE documents SET pending_destination_json = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'collection', collectionId: project.id }),
      'resume'
    )
    // The migration backfill (status='indexed' gated) must NOT file it into Library.
    expect(isMember(db, 'resume', lib.id)).toBe(false)

    // Resume: it reaches indexed and files itself to the persisted destination, clearing it.
    db.prepare("UPDATE documents SET status = 'indexed' WHERE id = ?").run('resume')
    fileFromPendingDestination(db, 'resume')
    expect(isMember(db, 'resume', project.id)).toBe(true)
    expect(isMember(db, 'resume', lib.id)).toBe(false)
    const after = db.prepare('SELECT pending_destination_json FROM documents WHERE id = ?').get('resume') as {
      pending_destination_json: string | null
    }
    expect(after.pending_destination_json).toBeNull()
  })

  it('fileFromPendingDestination with no recorded intent defaults to Library (byte-for-byte)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    seedDoc(db, 'legacy') // no pending_destination_json
    fileFromPendingDestination(db, 'legacy')
    expect(isMember(db, 'legacy', lib.id)).toBe(true)
  })

  it('fileFromPendingDestination NEVER files a generated doc (origin_json set) into Library (D3/N1)', () => {
    const db = freshDb()
    const lib = getBuiltinCollection(db, 'library')!
    // A generated work-product: indexed, origin stamped, no pending destination, no membership.
    // Re-indexing it drives fileFromPendingDestination, which must skip it (no Library sweep).
    seedDoc(db, 'gen', { origin: JSON.stringify({ kind: 'translation', sourceDocumentIds: ['s'], createdAt: 'x' }) })
    fileFromPendingDestination(db, 'gen')
    expect(isMember(db, 'gen', lib.id)).toBe(false)
  })
})

// ---- Privacy / offline (plan §17/§19.4) --------------------------------------------

describe('no network', () => {
  it('collection CRUD + membership + resolveScope make zero network calls', () => {
    const db = freshDb()
    const socketSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const project = createCollection(db, 'P')
    const doc = seedDoc(db, 'd1')
    addToCollection(db, [doc], project.id)
    renameCollection(db, project.id, 'P2')
    setCollectionArchived(db, project.id, true)
    listCollections(db)
    const conv = createConversation(db, { mode: 'documents' })
    resolveScope(db, conv.id)
    removeFromCollection(db, [doc], project.id)
    deleteCollection(db, project.id)

    expect(socketSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
