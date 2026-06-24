import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  childCollections,
  collectionBreadcrumb,
  createCollection,
  deleteCollection,
  descendantCollectionIds,
  getCollection,
  moveCollection,
  resolveScope,
  setCollectionArchived
} from '../../src/main/services/collections'
import { createConversation, setScope } from '../../src/main/services/chat'

// Nested collections (folder tree): parent_id makes collections a tree; scoping to a node retrieves
// its whole subtree. These cover the data layer — tree ops, the cycle guard, recursive scope.

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-tree-')), 'test.sqlite'))
}

/** A document + its membership in a collection (enough for resolveScope's membership filter). */
function fileDoc(db: Db, id: string, collectionId: string): void {
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at)
     VALUES (?, ?, 'indexed', '2026-01-01', '2026-01-01')`
  ).run(id, id)
  db.prepare(
    "INSERT INTO document_collections (document_id, collection_id, role, added_at) VALUES (?, ?, 'source', '2026-01-01')"
  ).run(id, collectionId)
}

describe('collections tree — structure ops', () => {
  it('nests via parentId and lists direct children', () => {
    const db = freshDb()
    const parent = createCollection(db, 'Parent')
    const child = createCollection(db, 'Child', 'project', { parentId: parent.id })
    expect(child.parentId).toBe(parent.id)
    expect(childCollections(db, parent.id).map((c) => c.id)).toEqual([child.id])
    expect(getCollection(db, child.id)?.parentId).toBe(parent.id)
  })

  it('rejects creating under a missing parent', () => {
    const db = freshDb()
    expect(() => createCollection(db, 'X', 'project', { parentId: 'nope' })).toThrow(/Unknown parent/)
  })

  it('breadcrumb returns the root→node chain in order', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B', 'project', { parentId: a.id })
    const c = createCollection(db, 'C', 'project', { parentId: b.id })
    expect(collectionBreadcrumb(db, c.id).map((n) => n.name)).toEqual(['A', 'B', 'C'])
  })

  it('move re-parents, but rejects a cycle (into its own subtree) and built-ins', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B', 'project', { parentId: a.id })
    const c = createCollection(db, 'C', 'project', { parentId: b.id })
    // Move C to top level — fine.
    expect(moveCollection(db, c.id, null).parentId).toBeNull()
    // Move A under C (C is A's former descendant, now detached) — fine since C is no longer under A.
    expect(moveCollection(db, a.id, c.id).parentId).toBe(c.id)
    // Cycle: move C under B which is under A which is now under C → C into its own subtree.
    expect(() => moveCollection(db, c.id, b.id)).toThrow(/own subtree/)
    const libraryId = (db.prepare("SELECT id FROM collections WHERE type='library'").get() as { id: string }).id
    expect(() => moveCollection(db, libraryId, a.id)).toThrow(/Built-in/)
  })

  it('delete re-parents children to the deleted node parent (no orphans)', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B', 'project', { parentId: a.id })
    const c = createCollection(db, 'C', 'project', { parentId: b.id })
    deleteCollection(db, b.id)
    expect(getCollection(db, b.id)).toBeNull()
    expect(getCollection(db, c.id)?.parentId).toBe(a.id) // C lifted up to A
  })
})

describe('collections tree — recursive scope', () => {
  it('descendantCollectionIds returns the whole subtree, skipping archived branches by default', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B', 'project', { parentId: a.id })
    const c = createCollection(db, 'C', 'project', { parentId: b.id })
    const archived = createCollection(db, 'Arc', 'project', { parentId: a.id })
    createCollection(db, 'UnderArc', 'project', { parentId: archived.id })
    setCollectionArchived(db, archived.id, true)
    const ids = new Set(descendantCollectionIds(db, [a.id]))
    expect(ids.has(a.id) && ids.has(b.id) && ids.has(c.id)).toBe(true)
    expect(ids.has(archived.id)).toBe(false) // archived branch pruned
    expect(descendantCollectionIds(db, [a.id], { includeArchived: true })).toContain(archived.id)
  })

  it('scoping a conversation to a parent retrieves a grandchild-only document; a sibling does not', () => {
    const db = freshDb()
    const a = createCollection(db, 'A')
    const b = createCollection(db, 'B', 'project', { parentId: a.id })
    const grandchild = createCollection(db, 'GC', 'project', { parentId: b.id })
    const sibling = createCollection(db, 'Sib')
    fileDoc(db, 'docGC', grandchild.id)

    const conv = createConversation(db, { mode: 'documents' })
    setScope(db, conv.id, { collectionIds: [a.id], documentIds: [] })
    expect(resolveScope(db, conv.id).collectionIds).toContain(grandchild.id) // subtree expansion

    setScope(db, conv.id, { collectionIds: [sibling.id], documentIds: [] })
    expect(resolveScope(db, conv.id).collectionIds ?? []).not.toContain(grandchild.id)
  })
})
