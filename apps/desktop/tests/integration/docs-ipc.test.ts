import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerDocsIpc — the handler glue: the `requireUnlocked` guard on
// DB-backed handlers (M6), the one-shot startup reconcile of documents stuck mid-ingestion
// by a prior run (M5), and threading the active embedder id into listDocuments so the
// stale-embedding flag surfaces (M7).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  documentsDir
} from '../../src/main/services/ingestion'
import {
  conversationAttachmentIds,
  createCollection,
  documentIdsInCollection,
  getBuiltinCollection
} from '../../src/main/services/collections'
import { createConversation } from '../../src/main/services/chat'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type { DocumentInfo, ImportJob, ImportJobStatus, ImportOptions } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshWorkspace(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-docsipc-'))
  return { db: openDatabase(join(root, 'hilbertraum.sqlite')), workspacePath: root }
}

function ctxWith(db: Db, workspacePath: string, embedder: Embedder, unlocked: boolean): AppContext {
  return {
    db,
    paths: { workspacePath },
    embedder,
    // A full-enough workspace for the background import loop (lease + null cipher).
    workspace: {
      isUnlocked: () => unlocked,
      beginDocumentWork: () => () => {},
      documentCipher: () => null
    }
  } as unknown as AppContext
}

/** Drive the background import loop to completion by polling the in-memory job aggregate. */
async function runImport(
  paths: string[],
  options?: ImportOptions
): Promise<{ documentIds: string[] }> {
  const { result } = await invoke(handlers, IPC.importDocuments, paths, options)
  const job = result as ImportJob
  for (let i = 0; i < 200; i++) {
    const { result: s } = await invoke(handlers, IPC.getImportJob, job.jobId)
    if ((s as ImportJobStatus).done) break
    await new Promise((r) => setTimeout(r, 5))
  }
  return job
}

beforeEach(() => ipcState.handlers.clear())

describe('registerDocsIpc', () => {
  it('rejects DB-backed handlers with a clear message while the workspace is locked (M6)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ false))

    await expect(invoke(handlers, IPC.listDocuments)).rejects.toThrow(/Workspace is locked/)
    await expect(invoke(handlers, IPC.importDocuments, ['/x.txt'])).rejects.toThrow(/Workspace is locked/)
    await expect(invoke(handlers, IPC.reindexDocument, 'id')).rejects.toThrow(/Workspace is locked/)
    await expect(invoke(handlers, IPC.deleteDocument, 'id')).rejects.toThrow(/Workspace is locked/)
    // L-3: importPreflight is now unlock-gated too (was an unauthenticated filesystem
    // walk/count oracle).
    await expect(invoke(handlers, IPC.importPreflight, ['/some/dir'])).rejects.toThrow(/Workspace is locked/)
  })

  it('importPreflight type-filters its paths arg and never throws on junk (L-3)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    // A non-array arg and non-string elements reduce to an empty selection (no walk crash).
    const bogus = await invoke(handlers, IPC.importPreflight, { not: 'an array' } as unknown as string[])
    expect(bogus.result).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
    const mixed = await invoke(handlers, IPC.importPreflight, [42, null] as unknown as string[])
    expect(mixed.result).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
  })

  it('reconciles a prior-run stuck document and flags a stale-embedding document (M5 + M7)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const indexer = createMockEmbedder() // id = 'mock-embedder'
    const storeDir = documentsDir(workspacePath)

    // An indexed document with vectors under the 'mock-embedder' id.
    const file = join(workspacePath, 'src.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta eta theta')
    const good = createQueuedDocument(db, file)
    await processDocument(db, storeDir, good.id, { embedder: indexer, embeddingModelId: indexer.id })

    // A document left mid-ingestion by a previous run (non-terminal + an old timestamp).
    const stuck = createQueuedDocument(db, file)
    db.prepare("UPDATE documents SET status = 'extracting', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      stuck.id
    )

    // The ACTIVE embedder reports a DIFFERENT id, so the indexed doc's vectors no longer match.
    const activeEmbedder = { ...createMockEmbedder(), id: 'a-different-model' } as Embedder
    registerDocsIpc(ctxWith(db, workspacePath, activeEmbedder, /* unlocked */ true))

    const { result } = await invoke(handlers, IPC.listDocuments)
    const docs = result as DocumentInfo[]
    const byId = (id: string): DocumentInfo => docs.find((d) => d.id === id)!

    // M5: the stuck doc was reset to failed on the first list.
    expect(byId(stuck.id).status).toBe('failed')
    // M7: the indexed doc is flagged stale because the active embedder id differs.
    expect(byId(good.id).status).toBe('indexed')
    expect(byId(good.id).staleEmbeddings).toBe(true)
  })

  // ---- Phase C: import destination round-trip (plan §11.3) -------------------------

  it('imports into Temporary (membership + lifecycle, NOT Library) via the destination option', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const file = join(workspacePath, 'invoice.txt')
    writeFileSync(file, 'invoice total due 2026-01-31 alpha beta gamma')

    const job = await runImport([file], { destination: { kind: 'temporary' } })
    const id = job.documentIds[0]
    const { result } = await invoke(handlers, IPC.listDocuments)
    const doc = (result as DocumentInfo[]).find((d) => d.id === id)!
    expect(doc.status).toBe('indexed')
    expect(doc.lifecycle).toBe('temporary')
    const temp = getBuiltinCollection(db, 'temporary')!
    const lib = getBuiltinCollection(db, 'library')!
    expect(documentIdsInCollection(db, temp.id)).toContain(id)
    expect(documentIdsInCollection(db, lib.id)).not.toContain(id) // stays out of Library
  })

  it('imports a chat attachment: Temporary + a conversation_documents link (C3)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const conv = createConversation(db, { mode: 'documents' })
    const file = join(workspacePath, 'drop.txt')
    writeFileSync(file, 'a dropped file about widgets and gadgets')

    const job = await runImport([file], {
      destination: { kind: 'conversation', conversationId: conv.id }
    })
    const id = job.documentIds[0]
    expect(conversationAttachmentIds(db, conv.id)).toEqual([id])
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'temporary')!.id)).toContain(id)
  })

  it('imports into a project (membership, NOT Library) via the collection destination', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const project = createCollection(db, 'Tax 2025')
    const file = join(workspacePath, 'receipt.txt')
    writeFileSync(file, 'a receipt for the tax project filing')

    const job = await runImport([file], {
      destination: { kind: 'collection', collectionId: project.id }
    })
    const id = job.documentIds[0]
    expect(documentIdsInCollection(db, project.id)).toContain(id)
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'library')!.id)).not.toContain(id)
  })

  it('an options-less import still defaults to Library, byte-for-byte', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const file = join(workspacePath, 'note.txt')
    writeFileSync(file, 'a plain library note with several words to index')

    const job = await runImport([file])
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'library')!.id)).toContain(
      job.documentIds[0]
    )
  })

  it('returns done:true for an unknown import job so a poller stops', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), true))
    const { result } = await invoke(handlers, IPC.getImportJob, 'no-such-job')
    expect(result).toMatchObject({ done: true, total: 0 })
  })

  // M-S2: the renderer is the untrusted boundary — a non-array `paths` (or non-string
  // elements) must NOT throw at the IPC layer (which would also leak the doc-work lease).
  it('treats a malformed importDocuments paths arg as an empty import (no throw, lease released)', async () => {
    const { db, workspacePath } = freshWorkspace()
    let leaseDelta = 0
    const ctx = {
      ...ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true),
      workspace: {
        isUnlocked: () => true,
        beginDocumentWork: () => {
          leaseDelta += 1
          return () => {
            leaseDelta -= 1
          }
        }
      }
    } as unknown as AppContext
    registerDocsIpc(ctx)

    // A non-array arg and an array with a non-string element both reduce to no real files
    // (the throwing path is what M-S2 prevents). The handler returns a clean empty job.
    const bogus = await invoke(handlers, IPC.importDocuments, { not: 'an array' } as unknown as string[])
    expect((bogus.result as { documentIds: string[] }).documentIds).toEqual([])
    const mixed = await invoke(handlers, IPC.importDocuments, [42, null, '/nope.txt'] as unknown as string[])
    expect((mixed.result as { documentIds: string[] }).documentIds).toEqual([]) // /nope.txt absent → dropped

    // The lease is released in the background loop's finally — let those microtasks run,
    // then confirm no lease leaked (both acquire/release pairs balanced).
    await new Promise((r) => setTimeout(r, 0))
    expect(leaseDelta).toBe(0)
  })
})
