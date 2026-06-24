import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { Collection } from '../../shared/types'
import {
  childCollections,
  collectionBreadcrumb,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  moveCollection,
  projectOnlyDocumentIds,
  renameCollection,
  setCollectionArchived
} from '../services/collections'
import { deleteDocument } from '../services/ingestion'
import { tMain } from '../services/i18n'

// IPC for document-organization collections (projects + the seeded built-ins;
// document-organization plan §16). Pure local SQLite writes — no network, no model calls.
//
// Audit privacy (plan §17): every collection event records id + type + affected COUNT
// ONLY — NEVER the collection/project NAME (a project name like "Divorce" is content-ish;
// the filename-logging allowance does NOT extend to it). Enforced by the sentinel-grep
// test in tests/integration/audit-ipc.test.ts.

export function registerCollectionsIpc(ctx: AppContext): void {
  // DB-backed handlers require an unlocked workspace; surface a clean message instead of
  // the raw "Workspace is locked" the `ctx.db` getter would throw mid-operation.
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) {
      throw new Error(tMain('main.docs.locked'))
    }
  }

  ipcMain.handle(IPC.listCollections, (): Collection[] => {
    requireUnlocked()
    return listCollections(ctx.db)
  })

  ipcMain.handle(
    IPC.createCollection,
    (
      _e,
      name: string,
      opts?: { description?: string | null; color?: string | null; parentId?: string | null }
    ): Collection => {
      requireUnlocked()
      const coll = createCollection(ctx.db, name, 'project', {
        description: opts?.description ?? null,
        color: opts?.color ?? null,
        parentId: opts?.parentId ?? null
      })
      // Privacy: id + type only — never the name.
      ctx.audit?.('collection_created', 'Project created', { collectionId: coll.id, type: coll.type })
      return coll
    }
  )

  // Folder-tree reads/writes (nested collections). Names are never audited (content-ish).
  ipcMain.handle(IPC.childCollections, (_e, parentId: string | null): Collection[] => {
    requireUnlocked()
    return childCollections(ctx.db, parentId ?? null)
  })

  ipcMain.handle(IPC.collectionBreadcrumb, (_e, id: string): Collection[] => {
    requireUnlocked()
    return collectionBreadcrumb(ctx.db, id)
  })

  ipcMain.handle(IPC.moveCollection, (_e, id: string, newParentId: string | null): Collection => {
    requireUnlocked()
    const coll = moveCollection(ctx.db, id, newParentId ?? null)
    ctx.audit?.('collection_moved', 'Project moved in folder tree', { collectionId: coll.id, type: coll.type })
    return coll
  })

  ipcMain.handle(IPC.renameCollection, (_e, id: string, name: string): Collection => {
    requireUnlocked()
    const coll = renameCollection(ctx.db, id, name)
    ctx.audit?.('collection_renamed', 'Project renamed', { collectionId: coll.id, type: coll.type })
    return coll
  })

  ipcMain.handle(IPC.setCollectionArchived, (_e, id: string, archived: boolean): Collection => {
    requireUnlocked()
    const coll = setCollectionArchived(ctx.db, id, archived)
    ctx.audit?.('collection_archived', 'Project archive state changed', {
      collectionId: coll.id,
      type: coll.type,
      archived
    })
    return coll
  })

  // Delete a project, two modes (plan §12.3):
  //  - 'membershipOnly': drop the collection + its memberships (CASCADE); keep every doc.
  //  - 'withDocuments':  additionally delete ONLY genuinely project-only docs (C2 predicate
  //    — never a Library member). The actual shred reuses ingestion `deleteDocument`.
  ipcMain.handle(
    IPC.deleteCollection,
    (_e, id: string, mode: 'membershipOnly' | 'withDocuments'): void => {
      requireUnlocked()
      const coll = getCollection(ctx.db, id)
      if (!coll) return
      if (coll.builtin) throw new Error(tMain('main.collections.builtinUndeletable'))
      let deletedCount = 0
      if (mode === 'withDocuments') {
        // Compute project-only docs BEFORE dropping the collection (CASCADE would remove
        // the memberships the predicate reads). Then delete the collection, then shred the
        // docs — order keeps the predicate accurate and the doc delete idempotent.
        const onlyHere = projectOnlyDocumentIds(ctx.db, id)
        deleteCollection(ctx.db, id)
        for (const docId of onlyHere) {
          deleteDocument(ctx.db, docId)
          deletedCount += 1
        }
      } else {
        deleteCollection(ctx.db, id)
      }
      ctx.audit?.('collection_deleted', 'Project deleted', {
        collectionId: id,
        type: coll.type,
        mode,
        deletedDocumentCount: deletedCount
      })
    }
  )
}
