import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerDocsIpc — the handler glue: the `requireUnlocked` guard on
// DB-backed handlers (M6), the one-shot startup reconcile of documents stuck mid-ingestion
// by a prior run (M5), and threading the active embedder id into listDocuments so the
// stale-embedding flag surfaces (M7).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
const dialogState = vi.hoisted(() => ({ result: { canceled: true, filePaths: [] as string[] } }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => dialogState.result }
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
import type {
  DocumentInfo,
  DocumentOrigin,
  ImportJob,
  ImportJobStatus,
  ImportOptions
} from '../../src/shared/types'
import { LARGE_FILE_BYTES } from '../../src/shared/types'
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

beforeEach(() => {
  ipcState.handlers.clear()
  dialogState.result = { canceled: true, filePaths: [] }
})

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

  // ---- M1 crash-resume through the REAL re-index flow (DM-1 / TEST-1) ---------------

  it('crash-resume re-index files by the pending destination, not Library (M1/DM-1)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const project = createCollection(db, 'Lawsuit')
    const lib = getBuiltinCollection(db, 'library')!

    // Simulate a crash-interrupted PROJECT import: the destination is persisted at queue
    // time, but the row never reached `indexed` and was last touched by a PRIOR run (old
    // updated_at) — exactly the state `reconcileStuckDocuments` reconciles to `failed`.
    const file = join(workspacePath, 'brief.txt')
    writeFileSync(file, 'a legal brief about the lawsuit with several indexable words here')
    const doc = createQueuedDocument(db, file, {
      destination: { kind: 'collection', collectionId: project.id }
    })
    db.prepare(
      "UPDATE documents SET status = 'queued', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(doc.id)

    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))

    // The first listDocuments runs the one-shot reconcile → the stuck row becomes `failed`,
    // and it is filed NOWHERE yet (its destination intent is still only the pending JSON).
    const before = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(before.find((d) => d.id === doc.id)!.status).toBe('failed')
    expect(documentIdsInCollection(db, project.id)).not.toContain(doc.id)

    // User clicks Re-index → the REAL reindexDocument IPC path (NOT the import loop, NOT the
    // helper). Before the DM-1 fix this reached `indexed` and filed the doc nowhere.
    const info = (await invoke(handlers, IPC.reindexDocument, doc.id)).result as DocumentInfo
    expect(info.status).toBe('indexed')

    // It lands in the intended PROJECT (not Library), and the pending intent is cleared.
    expect(documentIdsInCollection(db, project.id)).toContain(doc.id)
    expect(documentIdsInCollection(db, lib.id)).not.toContain(doc.id)
    const row = db
      .prepare('SELECT pending_destination_json FROM documents WHERE id = ?')
      .get(doc.id) as { pending_destination_json: string | null }
    expect(row.pending_destination_json).toBeNull()
  })

  // ---- DM-2: generated provenance is stamped at queue time, never backfilled --------

  it('a generated doc carries origin_json from queue time, so a crash never backfills it into Library (DM-2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-dm2-'))
    const dbPath = join(root, 'hilbertraum.sqlite')
    let db = openDatabase(dbPath)
    const file = join(root, 'translation.md')
    writeFileSync(file, '# Translated output\n\nsome generated body text to index here')

    // Materialize-style create: provenance is stamped AT QUEUE TIME (the DM-2 fix), before
    // the row can ever flip to `indexed` — closing the window the old stamp-after-`indexed`
    // ordering left open.
    const origin: DocumentOrigin = {
      kind: 'translation',
      sourceDocumentIds: ['src'],
      modelId: 'm',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    const doc = createQueuedDocument(db, file, { displayTitle: 'translation.md', origin })
    const stamped = db
      .prepare('SELECT origin_json, status FROM documents WHERE id = ?')
      .get(doc.id) as { origin_json: string | null; status: string }
    expect(stamped.origin_json).not.toBeNull() // stamped while still `queued`
    expect(stamped.status).toBe('queued')

    // Simulate a kill in the exact old crash window: the row reached `indexed` with NO
    // membership (generated, D3). origin_json is already set, so the backfill guard holds.
    db.prepare("UPDATE documents SET status = 'indexed' WHERE id = ?").run(doc.id)
    db.close()

    // Next app open re-runs the Library backfill — the work-product must NOT be swept in.
    db = openDatabase(dbPath)
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'library')!.id)).not.toContain(doc.id)
  })

  // ---- Phase E: docs:list smart-view predicates (plan §7.6/§12.1) ------------------

  it('filters docs:list by each smart view and orders "recent" by createdAt desc', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const project = createCollection(db, 'Tax 2025')

    // A project-filed doc (older) and a Library-default doc (newer).
    const filed = join(workspacePath, 'filed.txt')
    writeFileSync(filed, 'a receipt filed straight into the tax project for the year')
    const filedJob = await runImport([filed], { destination: { kind: 'collection', collectionId: project.id } })
    const libDoc = join(workspacePath, 'note.txt')
    writeFileSync(libDoc, 'a plain library note with several words to index here')
    const libJob = await runImport([libDoc])
    const filedId = filedJob.documentIds[0]
    const libId = libJob.documentIds[0]
    // Make the Library doc unambiguously newer so the "recent" ordering is deterministic.
    db.prepare("UPDATE documents SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(filedId)
    db.prepare("UPDATE documents SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(libId)

    const list = async (smart: string): Promise<DocumentInfo[]> =>
      (await invoke(handlers, IPC.listDocuments, { smart } as never)).result as DocumentInfo[]

    // Unfiled: the Library-only doc is "unfiled" (Library doesn't count); the project doc isn't.
    const unfiled = await list('unfiled')
    expect(unfiled.map((d) => d.id)).toContain(libId)
    expect(unfiled.map((d) => d.id)).not.toContain(filedId)

    // Recently added: newest first.
    const recent = await list('recent')
    expect(recent[0].id).toBe(libId)
    expect(recent.findIndex((d) => d.id === libId)).toBeLessThan(recent.findIndex((d) => d.id === filedId))

    // Large files: bump one doc's size past the threshold; only it shows.
    db.prepare('UPDATE documents SET size_bytes = ? WHERE id = ?').run(LARGE_FILE_BYTES + 1, libId)
    const large = await list('large')
    expect(large.map((d) => d.id)).toEqual([libId])

    // Failed imports: force one to failed.
    db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(filedId)
    const failed = await list('failed')
    expect(failed.map((d) => d.id)).toEqual([filedId])

    // 'all' is a no-op (returns everything non-deleted).
    expect((await list('all')).length).toBeGreaterThanOrEqual(2)
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

  // ING-3 — the 1-deep parse/embed pipeline. A multi-file import must keep per-file
  // statuses correct, preserve ordering, and isolate one failing file mid-batch (the embed
  // phase, now pipelined behind the next file's parse, is where the failure is injected).
  it('keeps per-file statuses correct and survives one failing file mid-batch (ING-3)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const mock = createMockEmbedder()
    // An embedder that throws when a chunk batch carries the sentinel — simulates one file's
    // embed (finalize) phase failing while the other files succeed.
    const embedder: Embedder = {
      id: mock.id,
      dimensions: mock.dimensions,
      embed: async (texts) => {
        if (texts.some((t) => t.includes('FAILMARKER'))) {
          throw new Error('embed boom (simulated mid-batch failure)')
        }
        return mock.embed(texts)
      }
    }
    registerDocsIpc(ctxWith(db, workspacePath, embedder, /* unlocked */ true))

    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-ing3-'))
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    const f3 = join(dir, 'c.txt')
    writeFileSync(f1, 'alpha beta gamma the good first file with enough words to chunk')
    writeFileSync(f2, 'this middle file carries the FAILMARKER and must fail to embed')
    writeFileSync(f3, 'delta epsilon zeta the good third file with enough words to chunk')

    const job = await runImport([f1, f2, f3])
    // Ordering preserved: the queued ids follow the input order (a, b, c).
    expect(job.documentIds).toHaveLength(3)

    // The aggregate job status: two completed, one failed — the failing file did not abort
    // the batch or the third file's import.
    const jobId = (job as unknown as ImportJob).jobId
    const { result: status } = await invoke(handlers, IPC.getImportJob, jobId)
    expect(status).toMatchObject({ done: true, completed: 2, failed: 1 })

    // Per-file statuses by id (the source of truth): a + c indexed, b failed.
    const { result: docsRes } = await invoke(handlers, IPC.listDocuments)
    const docs = docsRes as DocumentInfo[]
    const byId = new Map(docs.map((d) => [d.id, d]))
    const [idA, idB, idC] = job.documentIds
    expect(byId.get(idA)?.title).toBe('a.txt')
    expect(byId.get(idA)?.status).toBe('indexed')
    expect(byId.get(idB)?.title).toBe('b.txt')
    expect(byId.get(idB)?.status).toBe('failed')
    expect(byId.get(idC)?.title).toBe('c.txt')
    expect(byId.get(idC)?.status).toBe('indexed') // the file AFTER the failure still indexed

    // The two good files got embeddings; the failed one did not (its chunks may exist, but
    // no vectors were written) — so search only sees the survivors.
    const vectorCount = (id: string): number =>
      (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.document_id = ?'
          )
          .get(id) as { n: number }
      ).n
    expect(vectorCount(idA)).toBeGreaterThan(0)
    expect(vectorCount(idC)).toBeGreaterThan(0)
    expect(vectorCount(idB)).toBe(0)
  })
})

// D1 (vuln-scan-2026-06-21): importDocuments must not be a confused-deputy arbitrary-file
// reader. A PICKER import is bound to the one-time token pickDocuments minted (main imports
// exactly what it returned, ignoring the renderer's `paths`); a forged/replayed token imports
// nothing; the drag-drop seam (no token) is hardened (real file kept, symlink rejected).
describe('registerDocsIpc — import path binding (D1)', () => {
  const ctx = (db: Db, workspacePath: string): AppContext =>
    ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true)

  async function pick(files: string[]): Promise<{ token: string; paths: string[] }> {
    dialogState.result = { canceled: false, filePaths: files }
    const { result } = await invoke(handlers, IPC.pickDocuments, 'files')
    return result as { token: string; paths: string[] }
  }

  it('binds a PICKER import to the pickDocuments token (raw paths are ignored)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctx(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-pick-'))
    const file = join(dir, 'picked.txt')
    writeFileSync(file, 'a picked library note with enough words to index here please')
    const { token, paths } = await pick([file])
    expect(paths).toContain(file)
    expect(token).not.toBe('')
    // Pass an EMPTY paths arg with the token: main imports what was picked, not what we passed.
    const job = await runImport([], { pickerToken: token })
    expect(job.documentIds).toHaveLength(1)
  })

  it('imports nothing for a forged/unknown token — even when raw paths name a real file', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctx(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-forge-'))
    const file = join(dir, 'secret.txt')
    writeFileSync(file, 'a real, existing, supported-type file a renderer should not read at will')
    // A code-exec'd renderer supplies a real path + a bogus picker token → nothing imported.
    const job = await runImport([file], { pickerToken: 'not-a-real-token' })
    expect(job.documentIds).toEqual([])
  })

  it('treats a picker token as single-use (a replay imports nothing)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctx(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-once-'))
    const file = join(dir, 'once.txt')
    writeFileSync(file, 'a one-shot picked note with enough words to index here please now')
    const { token } = await pick([file])
    expect((await runImport([], { pickerToken: token })).documentIds).toHaveLength(1)
    expect((await runImport([], { pickerToken: token })).documentIds).toEqual([])
  })

  it('hardens the drag-drop seam (no token): keeps a real file, rejects a symlink', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctx(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-drop-'))
    const real = join(dir, 'real.txt')
    writeFileSync(real, 'a genuinely dropped file with several indexable words here right now')
    // A real dropped file imports (drag-drop is a user gesture; only the token is absent).
    expect((await runImport([real])).documentIds).toHaveLength(1)
    // A `.txt`-named symlink to a sensitive target is rejected by the hardening. Symlink
    // creation can be unprivileged-blocked on Windows — skip the assertion if so.
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'a sensitive target a renderer tried to reach through a .txt symlink')
    const link = join(dir, 'link.txt')
    let linked = false
    try {
      symlinkSync(target, link)
      linked = true
    } catch {
      /* no symlink privilege on this host — the hardening still runs in production */
    }
    if (linked) {
      expect((await runImport([link])).documentIds).toEqual([])
    }
  })
})
