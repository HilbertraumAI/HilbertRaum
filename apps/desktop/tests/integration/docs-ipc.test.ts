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
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type { DocumentInfo } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshWorkspace(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'paid-docsipc-'))
  return { db: openDatabase(join(root, 'paid.sqlite')), workspacePath: root }
}

function ctxWith(db: Db, workspacePath: string, embedder: Embedder, unlocked: boolean): AppContext {
  return {
    db,
    paths: { workspacePath },
    embedder,
    workspace: { isUnlocked: () => unlocked }
  } as unknown as AppContext
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

  it('returns done:true for an unknown import job so a poller stops', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), true))
    const { result } = await invoke(handlers, IPC.getImportJob, 'no-such-job')
    expect(result).toMatchObject({ done: true, total: 0 })
  })
})
