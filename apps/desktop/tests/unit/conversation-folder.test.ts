import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { createConversation, getConversation, moveConversationToCollection, setScope } from '../../src/main/services/chat'
import { createCollection } from '../../src/main/services/collections'

// "Move to folder" (conversation folders): moveConversationToCollection must set the anchor
// (collection_id) AND auto-scope retrieval (scope_v2_json) together, and clear BOTH on removal —
// the property the renderer relies on so a chat in a folder defaults to that folder's documents.

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-folder-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

describe('moveConversationToCollection (conversation folders)', () => {
  it('anchors the conversation AND auto-scopes retrieval to the folder', () => {
    const db = freshDb()
    const project = createCollection(db, 'Taxes 2026')
    const conv = createConversation(db, { mode: 'chat' })

    const moved = moveConversationToCollection(db, conv.id, project.id)
    expect(moved.collectionId).toBe(project.id)
    expect(moved.scope).toEqual({ collectionIds: [project.id], documentIds: [] })

    // Persisted, not just returned (reload normalizes in includeArchived:false, like setScope).
    const reloaded = getConversation(db, conv.id)
    expect(reloaded?.collectionId).toBe(project.id)
    expect(reloaded?.scope).toEqual({ collectionIds: [project.id], documentIds: [], includeArchived: false })
  })

  it('clears both anchor and scope when removed from a folder (null)', () => {
    const db = freshDb()
    const project = createCollection(db, 'Archive me')
    const conv = createConversation(db, { mode: 'chat' })
    moveConversationToCollection(db, conv.id, project.id)

    const removed = moveConversationToCollection(db, conv.id, null)
    expect(removed.collectionId).toBeNull()
    expect(removed.scope).toBeNull()
    const reloaded = getConversation(db, conv.id)
    expect(reloaded?.collectionId).toBeNull()
    expect(reloaded?.scope).toBeNull()
  })

  it('throws for an unknown conversation', () => {
    const db = freshDb()
    expect(() => moveConversationToCollection(db, 'nope', null)).toThrow(/Unknown conversation/)
  })
})

describe('setScope — anchor auto-sync (folder follows scope, no desync)', () => {
  it('anchors to a project when the scope is exactly that one whole project', () => {
    const db = freshDb()
    const project = createCollection(db, 'Taxes')
    const conv = createConversation(db, { mode: 'documents' })
    const out = setScope(db, conv.id, { collectionIds: [project.id], documentIds: [] })
    expect(out.collectionId).toBe(project.id)
    expect(getConversation(db, conv.id)?.collectionId).toBe(project.id)
  })

  it('clears the anchor (→ unfiled) when the scope is mixed, specific-doc, or empty', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B')
    const conv = createConversation(db, { mode: 'documents' })
    // Start anchored to A, then change scope to something that isn't one whole project.
    moveConversationToCollection(db, conv.id, a.id)
    expect(setScope(db, conv.id, { collectionIds: [a.id, b.id], documentIds: [] }).collectionId).toBeNull()
    moveConversationToCollection(db, conv.id, a.id)
    expect(setScope(db, conv.id, { collectionIds: [a.id], documentIds: ['doc1'] }).collectionId).toBeNull()
    moveConversationToCollection(db, conv.id, a.id)
    expect(setScope(db, conv.id, { collectionIds: [], documentIds: [] }).collectionId).toBeNull()
    moveConversationToCollection(db, conv.id, a.id)
    expect(setScope(db, conv.id, null).collectionId).toBeNull()
  })

  it('does not anchor to a built-in (Library) or an archived project', () => {
    const db = freshDb()
    // openDatabase seeds a Library built-in; a whole-Library scope is "all docs", not a project folder.
    const libraryId = (db.prepare("SELECT id FROM collections WHERE type = 'library'").get() as { id: string }).id
    const archived = createCollection(db, 'Old')
    const conv = createConversation(db, { mode: 'documents' })
    expect(setScope(db, conv.id, { collectionIds: [libraryId], documentIds: [] }).collectionId).toBeNull()
    db.prepare('UPDATE collections SET archived_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', archived.id)
    expect(setScope(db, conv.id, { collectionIds: [archived.id], documentIds: [] }).collectionId).toBeNull()
  })
})
