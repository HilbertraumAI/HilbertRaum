import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
  createQueuedDocuments,
  listDocuments,
  processDocument,
  extractDocumentPreview,
  readStoredDocumentText,
  documentsDir
} from '../../src/main/services/ingestion'
import {
  conversationAttachmentIds,
  createCollection,
  deleteCollection,
  documentIdsInCollection,
  getBuiltinCollection
} from '../../src/main/services/collections'
import type { DocumentCipher } from '../../src/main/services/workspace-vault'
import { createConversation } from '../../src/main/services/chat'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type {
  DocumentInfo,
  DocumentOrigin,
  DocumentPreview,
  ImportJob,
  ImportJobStatus,
  ImportOptions,
  ReindexJobStatus
} from '../../src/shared/types'
import { LARGE_FILE_BYTES } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

function freshWorkspace(): { db: Db; workspacePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-docsipc-'))
  return { db: openDatabase(join(root, 'hilbertraum.sqlite')), workspacePath: root }
}

function ctxWith(
  db: Db,
  workspacePath: string,
  embedder: Embedder,
  unlocked: boolean,
  docTasks?: unknown
): AppContext {
  return {
    db,
    paths: { workspacePath },
    embedder,
    // A full-enough workspace for the background import loop (lease + null cipher).
    workspace: {
      isUnlocked: () => unlocked,
      beginDocumentWork: () => () => {},
      documentCipher: () => null
    },
    // Optional: a fake DocTaskManager (e.g. one whose maybeEnqueueTreeBuild throws) to prove the
    // deep-index offer is fire-and-forget and never fails a (re)index.
    docTasks
  } as unknown as AppContext
}

/** Drive the background import loop to completion by polling the in-memory job aggregate. */
async function runImport(paths: string[], options?: ImportOptions): Promise<ImportJob> {
  const { result } = await invoke(handlers, IPC.importDocuments, paths, options)
  const job = result as ImportJob
  // T-7 (Chat & Documents audit 2026-07-07): a generous non-racy ceiling (was 200×5ms ≈ 1s) —
  // the loop settles well before this; the higher bound only removes headroom flakiness on a
  // busy CI box, it never gates a passing run.
  for (let i = 0; i < 400; i++) {
    const { result: s } = await invoke(handlers, IPC.getImportJob, job.jobId)
    if ((s as ImportJobStatus).done) break
    await new Promise((r) => setTimeout(r, 5))
  }
  return job
}

/** An embedder whose `embed` parks on a gate until `release()` — an import job holding it stays
 *  in-flight (and the doc sits in `processing`) until released. Used by T-3 / DB-6. */
function gatedEmbedder(): { embedder: Embedder; release: () => void } {
  const base = createMockEmbedder()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const embedder: Embedder = {
    id: base.id,
    dimensions: base.dimensions,
    embed: async (texts: string[]) => {
      await gate
      return base.embed(texts)
    }
  }
  return { embedder, release }
}

/** An embedder that can gate each `embed` call individually (T-7). With gating OFF every embed
 *  passes straight through (used during the initial import); with gating ON the NEXT embed parks
 *  until `release()`, and `awaitParked()` resolves once a call is waiting — so a test can drive the
 *  bulk re-index to a known, deterministic point. `release()` also turns gating off, so any further
 *  embed of the in-flight document (if it batches) passes and the loop can still break cleanly. */
function perFileGatedEmbedder(): {
  embedder: Embedder
  setGating: (on: boolean) => void
  awaitParked: () => Promise<void>
  release: () => void
} {
  const base = createMockEmbedder()
  let gating = false
  let parkedResolve: (() => void) | null = null
  let onPark: (() => void) | null = null
  const embedder: Embedder = {
    id: base.id,
    dimensions: base.dimensions,
    embed: async (texts: string[]) => {
      if (gating) {
        await new Promise<void>((resolve) => {
          parkedResolve = resolve
          onPark?.()
          onPark = null
        })
      }
      return base.embed(texts)
    }
  }
  return {
    embedder,
    setGating: (on: boolean) => {
      gating = on
    },
    awaitParked: () =>
      new Promise<void>((res) => {
        if (parkedResolve) return res()
        onPark = res
      }),
    release: () => {
      gating = false
      const r = parkedResolve
      parkedResolve = null
      r?.()
    }
  }
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

  it('a throwing maybeEnqueueTreeBuild never fails the import or reindex (fire-and-forget)', async () => {
    const { db, workspacePath } = freshWorkspace()
    // A stale/odd DocTaskManager whose deep-index offer throws — the exact runtime shape behind
    // "ctx.docTasks?.maybeEnqueueTreeBuild is not a function". The document still indexes fine; the
    // optional deep-index offer must be swallowed, not counted as a failed import / a rejected reindex.
    const docTasks = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'maybeEnqueueTreeBuild') {
            return () => {
              throw new Error('maybeEnqueueTreeBuild is not a function')
            }
          }
          // Every other guard the docs IPC consults (isDocumentBusy/hasActiveTask/…): a benign
          // falsy no-op, so only the deep-index offer is the thing that throws.
          return () => false
        }
      }
    )
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true, docTasks))
    const file = join(workspacePath, 'report.txt')
    writeFileSync(file, 'quarterly report alpha beta gamma delta epsilon')

    // Import path: the job completes with the doc INDEXED and ZERO failures despite the throw.
    const { result: imp } = await invoke(handlers, IPC.importDocuments, [file])
    const jobId = (imp as ImportJob).jobId
    let status: ImportJobStatus | undefined
    for (let i = 0; i < 200; i++) {
      status = (await invoke(handlers, IPC.getImportJob, jobId)).result as ImportJobStatus
      if (status.done) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(status?.failed).toBe(0)
    expect(status?.completed).toBe(1)
    const id = (imp as ImportJob).documentIds[0]
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === id)!.status).toBe('indexed')

    // Reindex path: resolves to `indexed` instead of rejecting on the same throw.
    const info = (await invoke(handlers, IPC.reindexDocument, id)).result as DocumentInfo
    expect(info.status).toBe('indexed')
  })

  it('startReindexAll runs the bulk loop in main, recoverable via parameterless getReindexAllJob', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const a = join(workspacePath, 'a.txt')
    const b = join(workspacePath, 'b.txt')
    writeFileSync(a, 'alpha beta gamma delta')
    writeFileSync(b, 'epsilon zeta eta theta')
    const { documentIds } = await runImport([a, b])
    expect(documentIds).toHaveLength(2)

    // Start the bulk re-index; the loop lives in MAIN, so the renderer can poll without the jobId.
    const started = (await invoke(handlers, IPC.startReindexAll, documentIds)).result as ReindexJobStatus
    expect(started.total).toBe(2)
    expect(started.done).toBe(false)
    // Recovery: the parameterless getter returns the SAME in-flight job (this is what survives a
    // navigation/remount), and a second start while running is idempotent (same jobId, no relaunch).
    const recovered = (await invoke(handlers, IPC.getReindexAllJob)).result as ReindexJobStatus
    expect(recovered.jobId).toBe(started.jobId)
    const again = (await invoke(handlers, IPC.startReindexAll, documentIds)).result as ReindexJobStatus
    expect(again.jobId).toBe(started.jobId)

    // Poll to completion, exactly as the renderer does.
    let job = recovered
    for (let i = 0; i < 200 && !job.done; i++) {
      await new Promise((r) => setTimeout(r, 5))
      job = (await invoke(handlers, IPC.getReindexAllJob)).result as ReindexJobStatus
    }
    expect(job.done).toBe(true)
    expect(job.completed).toBe(2)
    expect(job.failed).toBe(0)
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(documentIds.every((id) => listed.find((d) => d.id === id)?.status === 'indexed')).toBe(true)
  })

  // T-7 (Chat & Documents audit 2026-07-07): de-flaked. The prior version cancelled "right away"
  // and asserted `completed < total`, racing the (fast) mock embedder — on a quick box all six
  // could finish before the cancel landed, and the exact stop point was nondeterministic. Now a
  // per-file gated embedder parks the FIRST document's re-embed; we cancel while it is in flight
  // and then release it, so the loop finishes exactly that one document and breaks at the next
  // boundary — a deterministic `completed === 1`, no wall-clock dependency.
  it('cancelReindexAll stops the in-flight bulk loop deterministically (cancelled, completed===1)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const { embedder, setGating, awaitParked, release } = perFileGatedEmbedder()
    registerDocsIpc(ctxWith(db, workspacePath, embedder, /* unlocked */ true))
    const paths: string[] = []
    for (let i = 0; i < 6; i++) {
      const f = join(workspacePath, `f${i}.txt`)
      writeFileSync(f, `doc ${i} alpha beta gamma delta`)
      paths.push(f)
    }
    // Import with gating OFF so the six embeds pass straight through.
    const { documentIds } = await runImport(paths)
    expect(documentIds).toHaveLength(6)

    // Gate each re-embed so cancellation lands at a KNOWN point rather than racing the clock.
    setGating(true)
    const started = (await invoke(handlers, IPC.startReindexAll, documentIds)).result as ReindexJobStatus
    expect(started.done).toBe(false)

    // The first document's re-embed parks. Cancel WHILE it is in flight, then release it: the loop
    // counts that one document, then breaks at the next boundary (`if (signal.aborted) break`).
    await awaitParked()
    await invoke(handlers, IPC.cancelReindexAll)
    release()

    let job = started
    for (let i = 0; i < 400 && !job.done; i++) {
      await new Promise((r) => setTimeout(r, 5))
      job = (await invoke(handlers, IPC.getReindexAllJob)).result as ReindexJobStatus
    }
    expect(job.done).toBe(true)
    expect(job.cancelled).toBe(true)
    expect(job.completed).toBe(1) // exactly the one in-flight document — no wall-clock race
    expect(job.failed).toBe(0)
  })

  it('a mid-loop rejection (deleted doc) fails only that document — the rest still re-index', async () => {
    // PR review: the batch must continue past a document whose re-index rejects (here: deleted
    // between listing and the loop reaching it), not abort the remainder with one generic error.
    // The settled counts still add up to total so the renderer's summary toast is honest.
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      const f = join(workspacePath, `m${i}.txt`)
      writeFileSync(f, `doc ${i} alpha beta gamma delta`)
      paths.push(f)
    }
    const { documentIds } = await runImport(paths)
    expect(documentIds).toHaveLength(3)
    // Delete the MIDDLE document so the loop hits the rejection with work still remaining.
    await invoke(handlers, IPC.deleteDocument, documentIds[1])

    const started = (await invoke(handlers, IPC.startReindexAll, documentIds)).result as ReindexJobStatus
    let job = started
    for (let i = 0; i < 200 && !job.done; i++) {
      await new Promise((r) => setTimeout(r, 5))
      job = (await invoke(handlers, IPC.getReindexAllJob)).result as ReindexJobStatus
    }
    expect(job.done).toBe(true)
    expect(job.cancelled).toBe(false)
    expect(job.completed).toBe(2) // the docs AFTER the rejection were still processed
    expect(job.failed).toBe(1)
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === documentIds[0])?.status).toBe('indexed')
    expect(listed.find((d) => d.id === documentIds[2])?.status).toBe('indexed')
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

// Session 1 (DB-1/DB-2/DB-3) — Documents backend data integrity. Each test is teeth-checked:
// reverting its fix reddens the marked assertion.
describe('registerDocsIpc — Session 1 data integrity (DB-1/DB-2/DB-3)', () => {
  // DB-1 #1: filing to a collection id that never existed must degrade to Library rather than
  // FK-throw. Pre-fix the raw `addToCollection` throws inside the import loop's try → the doc is
  // counted `failed`, the `document_imported` audit is skipped, `pending_destination_json` is
  // never cleared, and every FUTURE re-index rethrows forever.
  it('DB-1: import to a GHOST collection degrades to Library — indexed, audited, re-indexable', async () => {
    const { db, workspacePath } = freshWorkspace()
    const audit = vi.fn()
    registerDocsIpc({
      ...ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true),
      audit
    } as unknown as AppContext)
    const file = join(workspacePath, 'doc.txt')
    writeFileSync(file, 'a document filed into a collection id that does not exist any more here')

    const job = await runImport([file], {
      destination: { kind: 'collection', collectionId: 'ghost-id' }
    })
    const id = job.documentIds[0]

    // TEETH: filing no longer throws → the doc completes, not `failed`.
    const status = (await invoke(handlers, IPC.getImportJob, job.jobId)).result as ImportJobStatus
    expect(status.failed).toBe(0)
    expect(status.completed).toBe(1)

    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === id)!.status).toBe('indexed')
    // Degraded into Library (the default), not the ghost.
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'library')!.id)).toContain(id)
    // TEETH: the audit event fired (skipped on the pre-fix failed path).
    expect(audit).toHaveBeenCalledWith(
      'document_imported',
      expect.anything(),
      expect.objectContaining({ documentId: id, status: 'indexed' })
    )
    // TEETH: pending intent cleared (never cleared on the pre-fix throw).
    const row = db
      .prepare('SELECT pending_destination_json FROM documents WHERE id = ?')
      .get(id) as { pending_destination_json: string | null }
    expect(row.pending_destination_json).toBeNull()
    // TEETH: a follow-up single re-index RESOLVES `indexed` (pre-fix it rejects forever).
    const info = (await invoke(handlers, IPC.reindexDocument, id)).result as DocumentInfo
    expect(info.status).toBe('indexed')
  })

  // DB-1 #2: the crash-resume re-index path (M1) must survive the destination collection being
  // deleted between queue time and re-index — the exact "delete the project while its import is
  // interrupted" scenario. Mirrors the M1 test but deletes the collection before reconcile+reindex.
  it('DB-1/M1: crash-resume re-index into a DELETED collection degrades to Library, pending cleared', async () => {
    const { db, workspacePath } = freshWorkspace()
    const project = createCollection(db, 'Doomed')
    const lib = getBuiltinCollection(db, 'library')!
    const file = join(workspacePath, 'brief.txt')
    writeFileSync(file, 'a legal brief queued for a project that is about to be deleted right here')
    const doc = createQueuedDocument(db, file, {
      destination: { kind: 'collection', collectionId: project.id }
    })
    db.prepare(
      "UPDATE documents SET status = 'queued', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(doc.id)

    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))

    // First list reconciles the prior-run stuck row → failed (filed nowhere yet).
    const before = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(before.find((d) => d.id === doc.id)!.status).toBe('failed')

    // The destination project is deleted before the user clicks Re-index.
    deleteCollection(db, project.id)

    // TEETH: re-index RESOLVES `indexed` instead of rejecting with a raw FK error forever.
    const info = (await invoke(handlers, IPC.reindexDocument, doc.id)).result as DocumentInfo
    expect(info.status).toBe('indexed')
    // Degraded into Library; pending cleared so it never wedges again.
    expect(documentIdsInCollection(db, lib.id)).toContain(doc.id)
    const row = db
      .prepare('SELECT pending_destination_json FROM documents WHERE id = ?')
      .get(doc.id) as { pending_destination_json: string | null }
    expect(row.pending_destination_json).toBeNull()
  })

  // DB-2: two concurrent same-doc reads must not decrypt into and shred a SHARED transient path.
  // The fake cipher forces an interleave (`setTimeout(0)` before the copy) and records the
  // destination path of every decrypt.
  it('DB-2: concurrent same-doc previews use unique transients and never shred each other', async () => {
    const { db, workspacePath } = freshWorkspace()
    const embedder = createMockEmbedder()
    const storeDir = documentsDir(workspacePath)
    const decryptDests: string[] = []
    const copy = (src: string, dest: string): void => writeFileSync(dest, readFileSync(src))
    const cipher: DocumentCipher = {
      encryptFile: copy,
      decryptFile: copy,
      encryptFileAsync: async (src, dest) => {
        copy(src, dest)
      },
      decryptFileAsync: async (src, dest) => {
        decryptDests.push(dest)
        await new Promise((r) => setTimeout(r, 0)) // force the two reads to interleave
        copy(src, dest)
      }
    }
    const file = join(workspacePath, 'secret.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi')
    const doc = createQueuedDocument(db, file)
    // Encrypt into the workspace (`stored_path` becomes the `.enc` copy) via the fake cipher.
    await processDocument(db, storeDir, doc.id, { embedder, embeddingModelId: embedder.id, cipher })

    const [a, b] = await Promise.all([
      extractDocumentPreview(db, storeDir, doc.id, { cipher }),
      extractDocumentPreview(db, storeDir, doc.id, { cipher })
    ])
    // Both reads succeed with equal, non-empty content — no cross-shred corruption / ENOENT.
    const textOf = (p: { segments: Array<{ text: string }> }): string =>
      p.segments.map((s) => s.text).join('')
    expect(textOf(a).length).toBeGreaterThan(0)
    expect(textOf(b)).toEqual(textOf(a))
    // TEETH: the two concurrent reads decrypted into DISTINCT transient paths. Revert the
    // `randomUUID()` infix → both reconstruct `${id}.parse-preview.txt` → the Set collapses to 1.
    expect(new Set(decryptDests).size).toBe(2)
  })

  // DB-3: a live doc-task ingestion (translation-materialize / OCR re-ingest) drives `documents`
  // rows OUTSIDE this module's `processing` set. A `listDocuments` poll during its embed window
  // must NOT flip the row to `failed`; once the task ends, a genuinely-stuck row still reconciles.
  it('DB-3: a live doc-task ingestion is not flipped to failed; reconciles once the task ends', async () => {
    const { db, workspacePath } = freshWorkspace()
    const file = join(workspacePath, 'src.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta')
    const doc = createQueuedDocument(db, file)
    // Mid-embed with an OLD updated_at — the `now` watermark alone would wrongly reconcile this.
    db.prepare(
      "UPDATE documents SET status = 'embedding', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(doc.id)

    let taskActive = true
    const docTasks = { hasActiveTask: () => taskActive, isDocumentBusy: () => false }
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true, docTasks))

    // TEETH: while a doc task is live the sweep is gated off → the row stays `embedding`.
    // Remove the `!taskActive` gate on `reconcileStuckDocuments` → this first list flips it.
    const busy = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(busy.find((d) => d.id === doc.id)!.status).toBe('embedding')

    // Task ends → the next poll reconciles the genuinely-stuck row to `failed` (the `now`
    // watermark still works — it is NOT swapped for PROCESS_START_ISO).
    taskActive = false
    const idle = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(idle.find((d) => d.id === doc.id)!.status).toBe('failed')
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

// Session 6 — Documents backend performance (DB-4, DB-5, DB-6, DB-7). Backend/perf only; sits on
// top of Session 1's guards (shared files). Each test reddens if its fix is reverted.
describe('registerDocsIpc — Session 6 backend performance (DB-4…DB-7)', () => {
  /** An embedder whose `embed` parks on a gate so an import job stays in-flight until released. */
  function gatedEmbedder(): { embedder: Embedder; release: () => void } {
    const base = createMockEmbedder()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const embedder: Embedder = {
      id: base.id,
      dimensions: base.dimensions,
      embed: async (texts: string[]) => {
        await gate
        return base.embed(texts)
      }
    }
    return { embedder, release }
  }

  // DB-4 (unit): the batch inserts one row per file, in order, sizes where statable. A nonexistent
  // path still queues a row (mirrors createQueuedDocument's insert-regardless) with a null size, so
  // no row is silently dropped and the id list aligns 1:1 with the input files.
  it('DB-4: createQueuedDocuments batch-inserts ids in order, sizes where statable', () => {
    const { db } = freshWorkspace()
    const dir = mkdtempSync(join(tmpdir(), 'hr-cqd-'))
    const real = ['a.txt', 'b.txt', 'c.txt'].map((n) => join(dir, n))
    real.forEach((f, i) => writeFileSync(f, 'x'.repeat((i + 1) * 10)))
    const missing = join(dir, 'gone.txt')

    const ids = createQueuedDocuments(db, [
      { filePath: real[0] },
      { filePath: real[1] },
      { filePath: missing },
      { filePath: real[2] }
    ])

    expect(ids).toHaveLength(4)
    const rows = ids.map(
      (id) =>
        db
          .prepare('SELECT id, title, size_bytes, status FROM documents WHERE id = ?')
          .get(id) as { id: string; title: string; size_bytes: number | null; status: string }
    )
    // Order preserved (ING-3 in-order push), the missing file included with a null size.
    expect(rows.map((r) => r.title)).toEqual(['a.txt', 'b.txt', 'gone.txt', 'c.txt'])
    expect(rows.map((r) => r.status)).toEqual(['queued', 'queued', 'queued', 'queued'])
    expect(rows.map((r) => r.size_bytes)).toEqual([10, 20, null, 30])
  })

  // DB-4 (integration): a folder import queues EVERY row synchronously before the invoke returns —
  // the batch commits all N inserts in one BEGIN…COMMIT (the walk stays synchronous). Reverting to a
  // lazy/async queue phase would make the count < N at return.
  it('DB-4: a folder import queues all rows synchronously before importDocuments returns', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const dir = mkdtempSync(join(tmpdir(), 'hr-batch-'))
    const files = Array.from({ length: 6 }, (_, i) => join(dir, `f${i}.txt`))
    files.forEach((f, i) => writeFileSync(f, `document number ${i} alpha beta gamma delta epsilon`))

    const { result } = await invoke(handlers, IPC.importDocuments, files)
    const job = result as ImportJob
    expect(job.documentIds).toHaveLength(6)
    // All six rows exist the instant the invoke returns — the batch queued them synchronously.
    const placeholders = job.documentIds.map(() => '?').join(',')
    const count = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM documents WHERE id IN (${placeholders})`)
        .get(...job.documentIds) as { n: number }
    ).n
    expect(count).toBe(6)

    // Drive to completion so the lease/loop unwind cleanly, then confirm every row indexed.
    for (let i = 0; i < 200; i++) {
      const { result: s } = await invoke(handlers, IPC.getImportJob, job.jobId)
      if ((s as ImportJobStatus).done) break
      await new Promise((r) => setTimeout(r, 5))
    }
    const docs = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(docs.filter((d) => job.documentIds.includes(d.id)).every((d) => d.status === 'indexed')).toBe(true)
  })

  // DB-5: on a mid-import poll (no `indexed` row) the embeddings⋈chunks join is pure waste — no
  // indexed row can be flagged stale. The early-out skips it; the chunk count is still correct and
  // staleEmbeddings stays undefined. Teeth: a `db.prepare` spy proves the join SQL is never prepared.
  it('DB-5: a mid-import list skips the embeddings join yet reports the chunk count', async () => {
    const { db, workspacePath } = freshWorkspace()
    const embedder = createMockEmbedder()
    const storeDir = documentsDir(workspacePath)
    const file = join(workspacePath, 'src.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu')
    const doc = createQueuedDocument(db, file)
    // Fully index it (chunks + embeddings under `embedder.id`), then force it BACK to a mid-import
    // status so the list has chunks-with-embeddings present but no `indexed` row.
    await processDocument(db, storeDir, doc.id, { embedder, embeddingModelId: embedder.id })
    db.prepare("UPDATE documents SET status = 'embedding' WHERE id = ?").run(doc.id)

    const JOIN_SQL = 'FROM embeddings e JOIN chunks c'
    const prepareSpy = vi.spyOn(db, 'prepare')
    const docs = listDocuments(db, embedder.id)
    const joinPrepared = prepareSpy.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes(JOIN_SQL)
    )
    prepareSpy.mockRestore()

    const info = docs.find((d) => d.id === doc.id)!
    expect(info.chunkCount).toBeGreaterThan(0) // chunkCounts is always built — badge stays correct
    expect(info.staleEmbeddings).toBeUndefined() // no indexed row → never flagged stale
    // TEETH: revert the `!force && rows.some(indexed)` guard → the full-corpus join runs on the poll.
    expect(joinPrepared).toBe(false)
  })

  // DB-5 negative control: with an `indexed` row whose vectors predate an embedder switch, the join
  // DOES run and staleEmbeddings is built (the M7 path is unaffected by the early-out).
  it('DB-5: an indexed row still builds embeddedCounts and can be flagged stale', async () => {
    const { db, workspacePath } = freshWorkspace()
    const indexer = createMockEmbedder()
    const storeDir = documentsDir(workspacePath)
    const file = join(workspacePath, 'kept.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta eta theta')
    const doc = createQueuedDocument(db, file)
    await processDocument(db, storeDir, doc.id, { embedder: indexer, embeddingModelId: indexer.id })

    const JOIN_SQL = 'FROM embeddings e JOIN chunks c'
    const prepareSpy = vi.spyOn(db, 'prepare')
    // The ACTIVE embedder reports a DIFFERENT id → the indexed doc's vectors no longer match.
    const docs = listDocuments(db, 'a-different-model')
    const joinPrepared = prepareSpy.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes(JOIN_SQL)
    )
    prepareSpy.mockRestore()

    expect(joinPrepared).toBe(true) // an indexed row is present → the join is NOT skipped
    expect(docs.find((d) => d.id === doc.id)!.staleEmbeddings).toBe(true)
  })

  // DB-6: the jobs map is capped at IMPORT_JOB_CAP (16). After > 16 completed imports the oldest is
  // evicted → getImportJob returns the synthetic done:true; the newest keeps its real counts.
  it('DB-6: the jobs map is capped — the oldest done job is evicted, the newest survives', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true))
    const file = join(workspacePath, 'x.txt')
    writeFileSync(file, 'one small indexable document alpha beta gamma delta epsilon zeta')
    const jobIds: string[] = []
    for (let i = 0; i < 18; i++) jobIds.push((await runImport([file])).jobId)

    // The first job was evicted → the synthetic unknown-job status.
    const first = (await invoke(handlers, IPC.getImportJob, jobIds[0])).result as ImportJobStatus
    expect(first).toEqual({ jobId: jobIds[0], total: 0, completed: 0, failed: 0, done: true })
    // TEETH: remove the cap → jobIds[0] keeps its real counts (total:1) and this reddens.
    const last = (await invoke(handlers, IPC.getImportJob, jobIds[17])).result as ImportJobStatus
    expect(last.total).toBe(1)
    expect(last.completed).toBe(1)
  })

  // DB-6: an IN-FLIGHT job is never evicted, even by 16 newer jobs — the eviction predicate deletes
  // only DONE jobs, and the in-flight job is the OLDEST (insertion order) here.
  it('DB-6: an in-flight import job is never evicted by newer jobs', async () => {
    const { db, workspacePath } = freshWorkspace()
    const { embedder, release } = gatedEmbedder()
    registerDocsIpc(ctxWith(db, workspacePath, embedder, /* unlocked */ true))
    const file = join(workspacePath, 'slow.txt')
    writeFileSync(file, 'a slow-to-embed document alpha beta gamma delta epsilon zeta eta theta')

    // Start a real import; its embed parks on the gate, so the job stays in-flight (done:false).
    const gated = (await invoke(handlers, IPC.importDocuments, [file])).result as ImportJob
    await new Promise((r) => setTimeout(r, 20)) // let the loop reach the gated embed
    // Fire 16 EMPTY imports (instantly done) to exceed IMPORT_JOB_CAP with the gated job the oldest.
    for (let i = 0; i < 16; i++) await invoke(handlers, IPC.importDocuments, [])

    // The in-flight job survived — getImportJob returns its REAL status (done:false), not the
    // synthetic done:true an evicted/unknown id would produce.
    const status = (await invoke(handlers, IPC.getImportJob, gated.jobId)).result as ImportJobStatus
    expect(status.done).toBe(false)
    // TEETH: drop the `if (s.done)` guard (evict oldest regardless) → the OLDEST job is the in-flight
    // gated one → it is evicted → getImportJob returns synthetic done:true → this reddens.

    release() // let the gated embed resolve, then drain so the loop/lease unwind cleanly
    for (let i = 0; i < 200; i++) {
      const s = (await invoke(handlers, IPC.getImportJob, gated.jobId)).result as ImportJobStatus
      if (s.done) break
      await new Promise((r) => setTimeout(r, 5))
    }
  })

  // DB-7: the export text reader decrypts via decryptFileAsync (PERF-1), NOT the sync decryptFile;
  // two concurrent same-doc reads both succeed (the DB-2 unique-transient sibling).
  it('DB-7: readStoredDocumentText decrypts via decryptFileAsync, concurrent reads both succeed', async () => {
    const { db, workspacePath } = freshWorkspace()
    const embedder = createMockEmbedder()
    const storeDir = documentsDir(workspacePath)
    let syncCalled = false
    let asyncCalls = 0
    const copy = (src: string, dest: string): void => writeFileSync(dest, readFileSync(src))
    const cipher: DocumentCipher = {
      encryptFile: copy,
      decryptFile: (src, dest) => {
        syncCalled = true
        copy(src, dest)
      },
      encryptFileAsync: async (src, dest) => {
        copy(src, dest)
      },
      decryptFileAsync: async (src, dest) => {
        asyncCalls++
        await new Promise((r) => setTimeout(r, 0)) // force the two reads to interleave
        copy(src, dest)
      }
    }
    const file = join(workspacePath, 'note.txt')
    writeFileSync(file, 'the quick brown fox jumps over the lazy dog again and again indeed')
    const doc = createQueuedDocument(db, file)
    // Encrypt into the workspace (stored_path becomes the `.enc` copy) via the fake cipher.
    await processDocument(db, storeDir, doc.id, { embedder, embeddingModelId: embedder.id, cipher })

    const [a, b] = await Promise.all([
      readStoredDocumentText(db, storeDir, doc.id, { cipher }),
      readStoredDocumentText(db, storeDir, doc.id, { cipher })
    ])
    expect(a.text).toContain('quick brown fox')
    expect(b.text).toEqual(a.text)
    // TEETH: revert to the sync `cipher.decryptFile` → syncCalled true, asyncCalls 0.
    expect(syncCalled).toBe(false)
    expect(asyncCalls).toBe(2)
  })
})

// Session 7 — docs-IPC guard preconditions (T-3) + the import-loop lock-mid-job break (T-4).
// Tests only; each reddens if the guard/mechanism it pins regresses.
describe('registerDocsIpc — Session 7 guard preconditions & lock-mid-job (T-3/T-4)', () => {
  // T-3 (processing gate): while a document is being ingested it sits in `processing`, so
  // delete / reindex / preview must all refuse with the friendly "still being processed" copy —
  // the docs-side mirror of the chat "refuses to delete while streaming" test. A gated embedder
  // parks the import at the embed phase so the row stays in `processing` for the assertions.
  it('T-3: a document in `processing` blocks delete, reindex AND preview (still being processed)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const { embedder, release } = gatedEmbedder()
    registerDocsIpc(ctxWith(db, workspacePath, embedder, /* unlocked */ true))
    const file = join(workspacePath, 'slow.txt')
    writeFileSync(file, 'a slow-to-embed document alpha beta gamma delta epsilon zeta eta theta iota')

    const gated = (await invoke(handlers, IPC.importDocuments, [file])).result as ImportJob
    const id = gated.documentIds[0]
    await new Promise((r) => setTimeout(r, 20)) // let the loop reach the gated embed → id in `processing`

    await expect(invoke(handlers, IPC.deleteDocument, id)).rejects.toThrow(/still being processed/)
    await expect(invoke(handlers, IPC.reindexDocument, id)).rejects.toThrow(/still being processed/)
    await expect(invoke(handlers, IPC.previewDocument, id)).rejects.toThrow(/still being processed/)

    // Release + drain so the loop/lease unwind cleanly (no leak into the next test).
    release()
    for (let i = 0; i < 400; i++) {
      const s = (await invoke(handlers, IPC.getImportJob, gated.jobId)).result as ImportJobStatus
      if (s.done) break
      await new Promise((r) => setTimeout(r, 5))
    }
  })

  // T-3 (task-busy gate + negative control): a live doc task (summary/deep-index/translation)
  // reports `isDocumentBusy → true`, so delete + reindex must refuse with "a task is running" —
  // but previewDocument consults ONLY `requireNotProcessing`, NOT the task gate, so it still
  // resolves. That asymmetry (preview is read-only, doesn't rewrite the stored copy) is the point.
  it('T-3: a live doc-task blocks delete/reindex (task is running) but NOT preview (negative control)', async () => {
    const { db, workspacePath } = freshWorkspace()
    let busy = false
    const docTasks = {
      isDocumentBusy: () => busy,
      hasActiveTask: () => false,
      maybeEnqueueTreeBuild: () => {}
    }
    registerDocsIpc(ctxWith(db, workspacePath, createMockEmbedder(), /* unlocked */ true, docTasks))
    const file = join(workspacePath, 'doc.txt')
    writeFileSync(file, 'a document with enough words to index for the task-busy guard test right here')
    const { documentIds } = await runImport([file])
    const id = documentIds[0]

    // A task now holds the document.
    busy = true
    await expect(invoke(handlers, IPC.deleteDocument, id)).rejects.toThrow(/task is running/i)
    await expect(invoke(handlers, IPC.reindexDocument, id)).rejects.toThrow(/task is running/i)
    // NEGATIVE CONTROL: preview is not gated on the task → it resolves with real content.
    const preview = (await invoke(handlers, IPC.previewDocument, id)).result as DocumentPreview
    expect(preview.segments.length).toBeGreaterThan(0)
  })

  // T-4: a "Lock now" that lands mid-import must break the loop cleanly and leave the not-yet-
  // finalized look-ahead document non-terminal INSIDE the lock (never a half-written terminal
  // state), with the doc-work lease balanced; then, after unlock, the very reconcile the drain
  // enables flips that row to `failed` (re-indexable). The embedder flips the workspace locked as
  // it finishes the FIRST document's embed, so f0 completes and the loop breaks before f1.
  it('T-4: a mid-job workspace lock breaks the import; the drained look-ahead row reconciles after unlock', async () => {
    const { db, workspacePath } = freshWorkspace()
    let unlocked = true
    let leaseDelta = 0
    const base = createMockEmbedder()
    const embedder: Embedder = {
      id: base.id,
      dimensions: base.dimensions,
      embed: async (texts: string[]) => {
        const out = await base.embed(texts)
        unlocked = false // "Lock now" landed during the first document's embed
        return out
      }
    }
    const ctx = {
      ...ctxWith(db, workspacePath, embedder, /* unlocked */ true),
      workspace: {
        isUnlocked: () => unlocked,
        beginDocumentWork: () => {
          leaseDelta += 1
          return () => {
            leaseDelta -= 1
          }
        },
        documentCipher: () => null
      }
    } as unknown as AppContext
    registerDocsIpc(ctx)

    const f0 = join(workspacePath, 'f0.txt')
    const f1 = join(workspacePath, 'f1.txt')
    writeFileSync(f0, 'the first file alpha beta gamma delta epsilon zeta eta theta iota kappa')
    writeFileSync(f1, 'the second file lambda mu nu xi omicron pi rho sigma tau upsilon phi chi')

    const job = (await invoke(handlers, IPC.importDocuments, [f0, f1])).result as ImportJob
    const [id0, id1] = job.documentIds

    // Drive to done via getImportJob (it needs NO unlock, unlike listDocuments) since the workspace
    // locks itself mid-job.
    let status: ImportJobStatus = { jobId: job.jobId, total: 2, completed: 0, failed: 0, done: false }
    for (let i = 0; i < 400; i++) {
      status = (await invoke(handlers, IPC.getImportJob, job.jobId)).result as ImportJobStatus
      if (status.done) break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(status.done).toBe(true)
    expect(status.completed).toBe(1) // only f0 finished before the lock landed
    expect(status.failed).toBe(0)

    // f0 indexed; f1 left NON-TERMINAL inside the lock — raw SELECT (no listDocuments reconcile yet;
    // listDocuments is unlock-gated anyway).
    const rawStatus = (id: string): string =>
      (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status
    expect(rawStatus(id0)).toBe('indexed')
    expect(['queued', 'extracting', 'chunking', 'embedding']).toContain(rawStatus(id1))
    // The one doc-work lease the whole job holds was released in the loop's finally.
    expect(leaseDelta).toBe(0)

    // Unlock + backdate f1 so the `now` watermark reconciles it deterministically on the next list.
    unlocked = true
    db.prepare("UPDATE documents SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id1)
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    // TEETH: remove the drain's `processing.delete(pending.id)` → f1 stays in `processing` →
    // the post-job sweep gate (`processing.size === 0`) never opens → f1 stays non-terminal here.
    expect(listed.find((d) => d.id === id1)!.status).toBe('failed')
  })
})
