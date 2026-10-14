import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Recording pass-through wrapper over `node:fs` (#240): every call still reaches the real
// filesystem; the mock only RECORDS `(fn, path)` for paths carrying the per-test probe token, so
// a test can prove a renderer-supplied array was refused BEFORE the first `lstat`/`stat`/
// `realpath`. Hoisted above the imports (the workspace-vault-durability.test.ts idiom).
const fsLog = vi.hoisted(() => ({
  probe: '',
  calls: [] as Array<{ fn: string; path: string }>,
  // #274: park the directory walk on a directory whose path carries `probe`. A SYNCHRONOUS
  // walk can only be parked by occupying the thread, so `readdirSync` spins for `spinMs`; the
  // async `fs/promises.readdir` awaits `gate` instead (calling `parked` first, so a test can await
  // the walk actually sitting on the gate). Disarmed before every test.
  slow: { probe: '', spinMs: 0, gate: null as Promise<void> | null, parked: null as (() => void) | null }
}))
const slowMatches = (p: string): boolean => fsLog.slow.probe !== '' && p.includes(fsLog.slow.probe)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const record = <F extends (...args: never[]) => unknown>(fn: string, real: F): F =>
    ((...args: unknown[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (fsLog.probe !== '' && p.includes(fsLog.probe)) fsLog.calls.push({ fn, path: p })
      return (real as unknown as (...a: unknown[]) => unknown)(...args)
    }) as unknown as F
  const spinning = <F extends (...args: never[]) => unknown>(real: F): F =>
    ((...args: unknown[]) => {
      if (fsLog.slow.spinMs > 0 && slowMatches(String(args[0]))) {
        // Occupy the thread the way a slow USB readdir does (Node allows Atomics.wait on the
        // main thread; no timer, no yield).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fsLog.slow.spinMs)
      }
      return (real as unknown as (...a: unknown[]) => unknown)(...args)
    }) as unknown as F
  const mocked = {
    ...actual,
    lstatSync: record('lstatSync', actual.lstatSync),
    statSync: record('statSync', actual.statSync),
    realpathSync: record('realpathSync', actual.realpathSync),
    readdirSync: record('readdirSync', spinning(actual.readdirSync))
  }
  return { ...mocked, default: mocked }
})
// The same recorder over `node:fs/promises` (#274: the walk is asynchronous — the "before any
// filesystem call" proofs must see the promise API too), plus the `gate` park on `readdir`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const record = <F extends (...args: never[]) => unknown>(fn: string, real: F): F =>
    ((...args: unknown[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (fsLog.probe !== '' && p.includes(fsLog.probe)) fsLog.calls.push({ fn, path: p })
      return (real as unknown as (...a: unknown[]) => unknown)(...args)
    }) as unknown as F
  const gated = <F extends (...args: never[]) => Promise<unknown>>(real: F): F =>
    (async (...args: unknown[]) => {
      if (fsLog.slow.gate !== null && slowMatches(String(args[0]))) {
        fsLog.slow.parked?.()
        await fsLog.slow.gate
      }
      return (real as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as unknown as F
  const mocked = {
    ...actual,
    lstat: record('lstat', actual.lstat),
    stat: record('stat', actual.stat),
    realpath: record('realpath', actual.realpath),
    readdir: record('readdir', gated(actual.readdir))
  }
  return { ...mocked, default: mocked }
})

// IPC-layer tests for registerDocsIpc — the handler glue: the startup reconcile of
// documents stuck mid-ingestion by a prior run (M5), threading the active embedder id into listDocuments (M7), the
// import pipeline, picker binding and the guards. The locked-vault refusal of every docs:* handler is
// ipc-lock-coverage.test.ts's MODULES row; the task-busy guard is doctasks-ipc.test.ts's (a real DocTaskManager).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
const dialogState = vi.hoisted(() => ({ result: { canceled: true, filePaths: [] as string[] } }))
// #90: the save-dialog seam for the original-bytes export; `lastOptions` captures the dialog
// options so the suggested name / title / encryption-boundary `message` can be asserted.
const saveDialogState = vi.hoisted(() => ({
  result: { canceled: true as boolean, filePath: undefined as string | undefined },
  lastOptions: null as Record<string, unknown> | null
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => dialogState.result,
    showSaveDialog: async (options: Record<string, unknown>) => {
      saveDialogState.lastOptions = options
      return saveDialogState.result
    }
  }
}))

import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  documentsDir,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import {
  conversationAttachmentIds,
  createCollection,
  deleteCollection,
  documentIdsInCollection,
  getBuiltinCollection,
  resolveScope
} from '../../src/main/services/collections'
import type { DocumentCipher } from '../../src/main/services/workspace-vault'
import { createConversation } from '../../src/main/services/chat'
import { createMockEmbedder } from '../../src/main/services/embeddings/mock'
import type { Embedder } from '../../src/main/services/embeddings'
import type {
  DocumentInfo,
  DocumentLifecycle,
  ImportDestination,
  ImportJob,
  ImportJobStatus,
  ImportOptions,
  ImportPreflight,
  ReindexJobStatus,
  SmartListView
} from '../../src/shared/types'
import { MAX_DROP_PATHS } from '../../src/main/services/ingestion/limits'
import type { AppContext } from '../../src/main/services/context'
import { TASK_DOCUMENT_BUSY_INGESTING_MESSAGE } from '../../src/main/services/doctasks'
import type { OcrEngine } from '../../src/main/services/ocr'
import type { RasterizePdf } from '../../src/main/services/ocr/rasterizer'
import { makeScanOnlyPdf } from '../helpers/fixtures'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { hangBudgetMs, testBudgetMs, until, within } from '../helpers/hang-budget'
import { tempRoot } from '../helpers/db-fixtures'
import { docTaskManager, docTaskRuntime, waitTerminal } from '../helpers/doctask-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

// The recorder is armed per test; disarm it before every test so a failed one cannot leave it on.
beforeEach(() => {
  fsLog.probe = ''
  fsLog.calls.length = 0
  fsLog.slow = { probe: '', spinMs: 0, gate: null, parked: null }
})

function freshWorkspace(): { db: Db; workspacePath: string } {
  const root = tempRoot('docsipc')
  return { db: openDatabase(join(root, 'hilbertraum.sqlite')), workspacePath: root }
}

/** What a test may override on the stand-in ctx; everything else is the harmless default. */
interface CtxOverrides {
  /** Default `createMockEmbedder()`. */
  embedder?: Embedder
  /** Default null (a plaintext store); #90 export tests pass a fake cipher for the `.enc` path. */
  cipher?: DocumentCipher | null
  /** A partial DocTaskManager stand-in (e.g. one whose maybeEnqueueTreeBuild throws). */
  docTasks?: unknown
  audit?: AppContext['audit']
  skillRunActive?: AppContext['skillRunActive']
  /** Merged over the default workspace (unlocked, a no-op lease, the `cipher` above). */
  workspace?: { isUnlocked?: () => boolean; unlockEpoch?: () => number; beginDocumentWork?: () => () => void }
}

function ctxWith(db: Db, workspacePath: string, o: CtxOverrides = {}): AppContext {
  return {
    trustedSenders: ANY_SENDER,
    db,
    paths: { workspacePath },
    embedder: o.embedder ?? createMockEmbedder(),
    // A full-enough workspace for the background import loop (lease + null cipher by default).
    workspace: {
      isUnlocked: () => true,
      beginDocumentWork: () => () => {},
      documentCipher: () => o.cipher ?? null,
      ...o.workspace
    },
    docTasks: o.docTasks,
    audit: o.audit,
    skillRunActive: o.skillRunActive
  } as unknown as AppContext
}

/** Poll a job-status channel until `done`; a hang fails by name after `hangBudgetMs(localMs)` instead of falling
 *  through silently into the next assertion (the hang-budget.ts `hangPolls` warning). */
async function pollDone<T extends { done: boolean }>(what: string, channel: string, ...args: unknown[]): Promise<T> {
  const deadline = Date.now() + hangBudgetMs(5_000)
  for (;;) {
    const s = (await invoke(handlers, channel, ...args)).result as T | null
    if (s?.done) return s
    if (Date.now() > deadline) throw new Error(`${what} never finished`)
    await new Promise((r) => setTimeout(r, 5)) // poll interval of a bounded poll, not a wait-for-it sleep
  }
}
const importDone = (jobId: string): Promise<ImportJobStatus> =>
  pollDone<ImportJobStatus>('the import job', IPC.getImportJob, jobId)
const reindexAllDone = (): Promise<ReindexJobStatus> => pollDone<ReindexJobStatus>('the bulk re-index', IPC.getReindexAllJob)

/** Drive the background import loop to completion by polling the in-memory job aggregate. */
async function runImport(paths: string[], options?: ImportOptions): Promise<ImportJob> {
  const { result } = await invoke(handlers, IPC.importDocuments, paths, options)
  const job = result as ImportJob
  await importDone(job.jobId)
  return job
}

/** An embedder whose `embed` parks on a gate until `release()` — an import job holding it stays
 *  in-flight (and the doc sits in `processing`) until released. Used by T-3 / DB-6. */
function gatedEmbedder(): { embedder: Embedder; release: () => void; reached: () => boolean } {
  const base = createMockEmbedder()
  let release!: () => void
  let reached = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  const embedder: Embedder = {
    id: base.id,
    dimensions: base.dimensions,
    embed: async (texts: string[]) => {
      // `reached` flips the moment the import loop is AT the gated embed (about to park) — the
      // deterministic "in-flight" gate tests poll instead of a fixed sleep (TS-1).
      reached = true
      await gate
      return base.embed(texts)
    }
  }
  return { embedder, release, reached: () => reached }
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
  it('importPreflight type-filters its paths arg and never throws on junk (L-3)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    // A non-array arg and non-string elements reduce to an empty selection (no walk crash).
    const bogus = await invoke(handlers, IPC.importPreflight, { not: 'an array' } as unknown as string[])
    expect(bogus.result).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
    const mixed = await invoke(handlers, IPC.importPreflight, [42, null] as unknown as string[])
    expect(mixed.result).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
  })

  // #240: the renderer-supplied array is capped BEFORE any filesystem call — an unbounded array of
  // unreachable paths used to drive one `lstat`/`stat` per element on the main thread. Strings only:
  // every path here sits under a local temp root; no UNC/device form is ever handed to the real
  // filesystem in any test. (The lexical UNC/device rejection is #222; mapped network drives cannot
  // be told apart lexically at all — that stays a documented residual there.)
  it('refuses more than MAX_DROP_PATHS strings on the drop and preflight seams before any lstat/stat/realpath (#240)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const probe = `probe-${randomUUID()}`
    const paths = Array.from({ length: MAX_DROP_PATHS + 1 }, (_, i) => join(workspacePath, `${probe}-${i}.txt`))
    fsLog.probe = probe
    fsLog.calls.length = 0
    await expect(invoke(handlers, IPC.importPreflight, paths)).rejects.toThrow(/Too many files/)
    expect(fsLog.calls).toEqual([])
    // The drop seam (no picker token) is the same cap.
    await expect(invoke(handlers, IPC.importDocuments, paths)).rejects.toThrow(/Too many files/)
    expect(fsLog.calls).toEqual([])
    // Exactly the cap is admitted and does reach the filesystem (the paths do not exist → empty).
    const atCap = paths.slice(0, MAX_DROP_PATHS)
    const { result } = await invoke(handlers, IPC.importPreflight, atCap)
    expect(result).toEqual({ fileCount: 0, audioFileCount: 0, audioBytes: 0 })
    expect(fsLog.calls.length).toBeGreaterThan(0)
  })

  // A PICKER selection is main-vetted, so it is exempt from the cap: preflight with the token
  // counts main's own paths (the renderer array is ignored), the token stays live for the import.
  it('importPreflight with the pickDocuments token is not capped and does not spend the token (#240)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const probe = `probe-${randomUUID()}`
    const picked = Array.from({ length: MAX_DROP_PATHS + 1 }, (_, i) => join(workspacePath, `${probe}-${i}.txt`))
    // One REAL `.txt` among the picked paths, so both the count and the redeeming import have something to see.
    writeFileSync(picked[0], 'a picked note with enough words to index')
    dialogState.result = { canceled: false, filePaths: picked }
    const { result: pick } = await invoke(handlers, IPC.pickDocuments, 'files')
    const token = (pick as { token: string }).token
    expect(token).not.toBe('')
    fsLog.probe = probe
    // The renderer array is ignored: an EMPTY array + the token still counts the picked paths.
    const { result: pre } = await invoke(handlers, IPC.importPreflight, [], token)
    expect(pre).toEqual({ fileCount: 1, audioFileCount: 0, audioBytes: 0 })
    expect(fsLog.calls.length).toBeGreaterThan(0)
    // Not spent: the import still redeems it (no drop cap on that branch either) — only possible if the
    // preflight left the token live.
    expect((await runImport([], { pickerToken: token })).documentIds).toHaveLength(1)
    // A stale token falls back to the raw (capped) seam.
    await expect(invoke(handlers, IPC.importPreflight, picked, token)).rejects.toThrow(/Too many files/)
    dialogState.result = { canceled: true, filePaths: [] }
  })

  // #274: the directory walk behind a folder drop/pick must not hold the main thread. With the
  // walk parked on one slow directory, the invoke must hand back its promise at once and a
  // concurrent cheap invoke must resolve while the walk is still pending. Red under the
  // synchronous walk: the whole spin ran INSIDE the invoke's synchronous segment, so the call
  // itself took the spin's length before it could even return a promise. The clock brackets ONLY
  // that synchronous segment — two adjacent reads with no promise, timer or I/O in between, which a
  // starved CI runner cannot stretch past a 2 s bound (BUILD_STATE §7: no event-loop-turn counting);
  // a settled-order check was tried and is NOT a discriminator (both handlers are async, so the
  // walk's promise settles after the cheap invoke resumes even when the walk ran inline). The spin
  // parks a synchronous walk (never reached by the async one, so the green path costs nothing);
  // the gate parks the async walk.
  it('a parked walk does not block a concurrent invoke (#274)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const probe = `probe-${randomUUID()}`
    const dir = join(workspacePath, `${probe}-tree`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.txt'), 'x')
    writeFileSync(join(dir, 'b.md'), 'x')
    const SPIN_MS = 2000
    let release!: () => void
    fsLog.slow = { probe, spinMs: SPIN_MS, gate: new Promise<void>((r) => (release = r)), parked: null }

    const t0 = Date.now()
    const walk = invoke(handlers, IPC.importPreflight, [dir])
    const admitMs = Date.now() - t0
    expect(admitMs).toBeLessThan(SPIN_MS)
    // `getImportJob` needs no unlock and touches no filesystem — the cheapest handler there is.
    let walkSettled = false
    void walk.finally(() => {
      walkSettled = true
    })
    await invoke(handlers, IPC.getImportJob, 'no-such-job')
    expect(walkSettled).toBe(false) // the walk is still parked on the gate
    release()
    const { result } = await walk
    expect((result as ImportPreflight).fileCount).toBe(2)
  })

  // #274: a walk cut by its budget is REPORTED — on the preflight result, on the import job the
  // invoke resolves with, and on the polled status — so a silent subset can no longer pass for a
  // complete import. The env override is how the budget is retuned in the field, so it is the
  // seam here too. Absent (not null) when the walk completed: additive on every DTO.
  it('reports a cut walk on the preflight result, the import job and its status (#274)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const dir = join(workspacePath, 'wide')
    mkdirSync(dir)
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${String(i).padStart(2, '0')}.txt`), `note ${i} alpha beta`)
    const prior = process.env.HILBERTRAUM_WALK_MAX_ENTRIES
    process.env.HILBERTRAUM_WALK_MAX_ENTRIES = '4'
    try {
      const pre = (await invoke(handlers, IPC.importPreflight, [dir])).result as ImportPreflight
      expect(pre.exhausted).toBe('entries')
      expect(pre.fileCount).toBeLessThanOrEqual(4)
      const job = await runImport([dir])
      expect(job.exhausted).toBe('entries')
      expect(job.documentIds.length).toBeLessThanOrEqual(4)
      const status = (await invoke(handlers, IPC.getImportJob, job.jobId)).result as ImportJobStatus
      expect(status.exhausted).toBe('entries')
    } finally {
      if (prior === undefined) delete process.env.HILBERTRAUM_WALK_MAX_ENTRIES
      else process.env.HILBERTRAUM_WALK_MAX_ENTRIES = prior
    }
    // A completed walk carries no field at all (the pins above that `toEqual` the bare shape).
    const small = join(workspacePath, 'small')
    mkdirSync(small)
    writeFileSync(join(small, 'one.txt'), 'x')
    const pre = (await invoke(handlers, IPC.importPreflight, [small])).result as ImportPreflight
    expect(pre.exhausted).toBeUndefined()
    const job = await runImport([small])
    expect(job.exhausted).toBeUndefined()
  })

  // #274: the walk is asynchronous, so a lock can land WHILE a folder is being walked. The
  // import must then fail before it touches the workspace: no row queued, the document-work
  // lease never taken (it is acquired only after the walk, so nothing is held across the await),
  // and a picker token NOT spent — it is peeked before the walk and consumed after the gate, so
  // the retry after the re-unlock imports without a second trip through the OS picker.
  it('a lock landing mid-walk fails the import before any row, lease or token spend (#274)', async () => {
    const { db, workspacePath } = freshWorkspace()
    let unlocked = true
    let held = 0
    let peak = 0
    const ctx = ctxWith(db, workspacePath, {
      workspace: {
        isUnlocked: () => unlocked,
        beginDocumentWork: () => {
          held += 1
          peak = Math.max(peak, held)
          return () => {
            held -= 1
          }
        }
      }
    })
    registerDocsIpc(ctx)
    const probe = `probe-${randomUUID()}`
    const dir = join(workspacePath, `${probe}-folder`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'dropped.txt'), 'a dropped note with enough words to index here please')
    dialogState.result = { canceled: false, filePaths: [dir] }
    const token = ((await invoke(handlers, IPC.pickDocuments, 'folder')).result as { token: string }).token
    dialogState.result = { canceled: true, filePaths: [] }
    let release!: () => void
    let walkParked!: () => void
    const parked = new Promise<void>((r) => (walkParked = r))
    fsLog.slow = { probe, spinMs: 0, gate: new Promise<void>((r) => (release = r)), parked: walkParked }

    const importP = invoke(handlers, IPC.importDocuments, [], { pickerToken: token })
    // The walk reaches the folder's gated readdir (its first awaits are the picked path's own
    // stat/realpath); the lock now lands MID-walk, provably, and then the walk finishes.
    await within(parked, 'the walk parking on the gated readdir')
    unlocked = false
    release()
    await expect(importP).rejects.toThrow(/Workspace is locked\./)
    expect(peak).toBe(0)
    expect(held).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
    // The token survived: the retry after the re-unlock imports the picked folder.
    unlocked = true
    const retry = await runImport([], { pickerToken: token })
    expect(retry.documentIds).toHaveLength(1)
  })

  // #274 (AUD-03): a lock AND a re-unlock can both complete inside the walk, after which the
  // unlock gate looks exactly as it did at admission — only the session epoch tells the stale
  // import apart. It is abandoned, not queued into the new session.
  it('a lock + re-unlock inside the walk abandons the import (unlock epoch) (#274)', async () => {
    const { db, workspacePath } = freshWorkspace()
    let epoch = 1
    let held = 0
    const ctx = ctxWith(db, workspacePath, {
      workspace: {
        unlockEpoch: () => epoch,
        beginDocumentWork: () => {
          held += 1
          return () => {
            held -= 1
          }
        }
      }
    })
    registerDocsIpc(ctx)
    const probe = `probe-${randomUUID()}`
    const dir = join(workspacePath, `${probe}-folder`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'note.txt'), 'a note with enough words to index here please now')
    let release!: () => void
    let walkParked!: () => void
    const parked = new Promise<void>((r) => (walkParked = r))
    fsLog.slow = { probe, spinMs: 0, gate: new Promise<void>((r) => (release = r)), parked: walkParked }

    const importP = invoke(handlers, IPC.importDocuments, [dir])
    await within(parked, 'the walk parking on the gated readdir') // the lock + re-unlock now land MID-walk
    epoch += 1 // the session this import was admitted into is gone
    release()
    await expect(importP).rejects.toThrow(/Workspace is locked\./)
    expect(held).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
    // Control: the same import with a stable epoch queues the row.
    expect((await runImport([dir])).documentIds).toHaveLength(1)
  })

  it('reconciles a prior-run stuck document and flags a stale-embedding document (M5 + M7)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const indexer = createMockEmbedder() // id = 'mock-embedder'
    const storeDir = documentsDir(workspacePath)

    // An indexed document with vectors under the 'mock-embedder' id.
    const file = join(workspacePath, 'src.txt')
    writeFileSync(file, 'alpha beta gamma delta epsilon zeta eta theta')
    const good = createQueuedDocument(db, file)
    await processDocument(db, storeDir, good.id, { embedder: indexer })

    // A document left mid-ingestion by a previous run (non-terminal + an old timestamp).
    const stuck = createQueuedDocument(db, file)
    db.prepare("UPDATE documents SET status = 'extracting', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      stuck.id
    )

    // The ACTIVE embedder reports a DIFFERENT id, so the indexed doc's vectors no longer match.
    const activeEmbedder = { ...createMockEmbedder(), id: 'a-different-model' } as Embedder
    registerDocsIpc(ctxWith(db, workspacePath, { embedder: activeEmbedder }))

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

  // The destination option threads through `sanitizeDestination` to the filing step: exactly one of
  // Library / Temporary / the project holds the doc, with the matching lifecycle and (only for a chat
  // attachment, C3) the conversation link. A malformed shape (a collection with no id) is the one input
  // that reaches the sanitizer's default branch: it must file into Library and never throw.
  it.each<{
    name: string
    options: (ids: { projectId: string; convId: string }) => ImportOptions | undefined
    filed: 'library' | 'temporary' | 'project'
    lifecycle: DocumentLifecycle
    linked: boolean
  }>([
    {
      name: 'Temporary',
      options: () => ({ destination: { kind: 'temporary' } }),
      filed: 'temporary',
      lifecycle: 'temporary',
      linked: false
    },
    {
      name: 'a chat attachment (C3)',
      options: ({ convId }) => ({ destination: { kind: 'conversation', conversationId: convId } }),
      filed: 'temporary',
      lifecycle: 'temporary',
      linked: true
    },
    {
      name: 'a project',
      options: ({ projectId }) => ({ destination: { kind: 'collection', collectionId: projectId } }),
      filed: 'project',
      lifecycle: 'permanent',
      linked: false
    },
    {
      name: 'no options (Library, byte-for-byte)',
      options: () => undefined,
      filed: 'library',
      lifecycle: 'permanent',
      linked: false
    },
    {
      name: 'a malformed destination (a collection with no id): Library, never a throw',
      options: () => ({ destination: { kind: 'collection' } as unknown as ImportDestination }),
      filed: 'library',
      lifecycle: 'permanent',
      linked: false
    }
  ])('files an import by its destination: $name', async ({ options, filed, lifecycle, linked }) => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const projectId = createCollection(db, 'Tax 2025').id
    const convId = createConversation(db, { mode: 'documents' }).id
    const file = join(workspacePath, 'invoice.txt')
    writeFileSync(file, 'invoice total due 2026-01-31 alpha beta gamma delta')

    const job = await runImport([file], options({ projectId, convId }))
    const id = job.documentIds[0]
    const doc = ((await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]).find((d) => d.id === id)!
    expect(doc.status).toBe('indexed')
    expect(doc.lifecycle ?? 'permanent').toBe(lifecycle)
    const where = {
      library: getBuiltinCollection(db, 'library')!.id,
      temporary: getBuiltinCollection(db, 'temporary')!.id,
      project: projectId
    }
    for (const [k, collectionId] of Object.entries(where)) {
      expect(documentIdsInCollection(db, collectionId).includes(id), k).toBe(k === filed)
    }
    expect(conversationAttachmentIds(db, convId)).toEqual(linked ? [id] : [])
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
    registerDocsIpc(ctxWith(db, workspacePath, { docTasks }))
    const file = join(workspacePath, 'report.txt')
    writeFileSync(file, 'quarterly report alpha beta gamma delta epsilon')

    // Import path: the job completes with the doc INDEXED and ZERO failures despite the throw.
    const { result: imp } = await invoke(handlers, IPC.importDocuments, [file])
    const jobId = (imp as ImportJob).jobId
    const status = await importDone(jobId)
    expect(status.failed).toBe(0)
    expect(status.completed).toBe(1)
    const id = (imp as ImportJob).documentIds[0]
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === id)!.status).toBe('indexed')

    // Reindex path: resolves to `indexed` instead of rejecting on the same throw.
    const info = (await invoke(handlers, IPC.reindexDocument, id)).result as DocumentInfo
    expect(info.status).toBe('indexed')
  })

  it('startReindexAll runs the bulk loop in main, recoverable via parameterless getReindexAllJob', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
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
    const job = await reindexAllDone()
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
    registerDocsIpc(ctxWith(db, workspacePath, { embedder }))
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
    await within(awaitParked(), 'the re-embed parking on the gate')
    await invoke(handlers, IPC.cancelReindexAll)
    release()

    const job = await reindexAllDone()
    expect(job.cancelled).toBe(true)
    expect(job.completed).toBe(1) // exactly the one in-flight document — no wall-clock race
    expect(job.failed).toBe(0)
  })

  it('a mid-loop rejection (deleted doc) fails only that document — the rest still re-index', async () => {
    // PR review: the batch must continue past a document whose re-index rejects (here: deleted
    // between listing and the loop reaching it), not abort the remainder with one generic error.
    // The settled counts still add up to total so the renderer's summary toast is honest.
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
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

    await invoke(handlers, IPC.startReindexAll, documentIds)
    const job = await reindexAllDone()
    expect(job.cancelled).toBe(false)
    expect(job.completed).toBe(2) // the docs AFTER the rejection were still processed
    expect(job.failed).toBe(1)
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === documentIds[0])?.status).toBe('indexed')
    expect(listed.find((d) => d.id === documentIds[2])?.status).toBe('indexed')
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

    registerDocsIpc(ctxWith(db, workspacePath))

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

  // ---- Phase E: docs:list smart-view predicates (plan §7.6/§12.1) ------------------

  it('filters docs:list by a smart view and orders "recent" by createdAt desc', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
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

    const list = async (smart: SmartListView): Promise<DocumentInfo[]> =>
      (await invoke(handlers, IPC.listDocuments, { smart })).result as DocumentInfo[]

    // Unfiled: the Library-only doc is "unfiled" (Library doesn't count); the project doc isn't.
    const unfiled = await list('unfiled')
    expect(unfiled.map((d) => d.id)).toContain(libId)
    expect(unfiled.map((d) => d.id)).not.toContain(filedId)

    // Recently added: newest first.
    const recent = await list('recent')
    expect(recent[0].id).toBe(libId)
    expect(recent.findIndex((d) => d.id === libId)).toBeLessThan(recent.findIndex((d) => d.id === filedId))

    // (The per-view predicates themselves — large, failed, … — are `matchesSmartView`'s, owned by
    // tests/unit/smart-views.test.ts; this pins the handler threading the filter through.)
    // 'all' is a no-op (returns everything non-deleted).
    expect((await list('all')).length).toBeGreaterThanOrEqual(2)
  })

  // M-S2: the renderer is the untrusted boundary — a non-array `paths` (or non-string
  // elements) must NOT throw at the IPC layer (which would also leak the doc-work lease).
  it('treats a malformed importDocuments paths arg as an empty import (no throw, lease released)', async () => {
    const { db, workspacePath } = freshWorkspace()
    let leaseDelta = 0
    const ctx = ctxWith(db, workspacePath, {
      workspace: {
        beginDocumentWork: () => {
          leaseDelta += 1
          return () => {
            leaseDelta -= 1
          }
        }
      }
    })
    registerDocsIpc(ctx)

    // A non-array arg and an array with a non-string element both reduce to no real files
    // (the throwing path is what M-S2 prevents). The handler returns a clean empty job.
    const bogus = await invoke(handlers, IPC.importDocuments, { not: 'an array' } as unknown as string[])
    expect((bogus.result as { documentIds: string[] }).documentIds).toEqual([])
    const mixed = await invoke(handlers, IPC.importDocuments, [42, null, '/nope.txt'] as unknown as string[])
    expect((mixed.result as { documentIds: string[] }).documentIds).toEqual([]) // /nope.txt absent → dropped

    // An empty job settles synchronously — the background loop has no await, so its `finally`
    // released the lease before the invoke resolved. No acquire/release pair is left open.
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
    registerDocsIpc(ctxWith(db, workspacePath, { embedder }))

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
    const { result: status } = await invoke(handlers, IPC.getImportJob, job.jobId)
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

// Session 1 (DB-1/DB-3) — Documents backend data integrity. Each test is teeth-checked:
// reverting its fix reddens the marked assertion. (DB-2's concurrent-preview row lives in
// encrypted-documents.test.ts beside the other encrypted readers.)
describe('registerDocsIpc — Session 1 data integrity (DB-1/DB-3)', () => {
  // DB-1 #1: filing to a collection id that never existed must degrade to Library rather than
  // FK-throw. Pre-fix the raw `addToCollection` throws inside the import loop's try → the doc is
  // counted `failed`, the `document_imported` audit is skipped, `pending_destination_json` is
  // never cleared, and every FUTURE re-index rethrows forever.
  it('DB-1: import to a GHOST collection degrades to Library — indexed, audited, re-indexable', async () => {
    const { db, workspacePath } = freshWorkspace()
    const audit = vi.fn()
    registerDocsIpc(ctxWith(db, workspacePath, { audit }))
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

    registerDocsIpc(ctxWith(db, workspacePath))

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
    registerDocsIpc(ctxWith(db, workspacePath, { docTasks }))

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
  async function pick(files: string[]): Promise<{ token: string; paths: string[] }> {
    dialogState.result = { canceled: false, filePaths: files }
    const { result } = await invoke(handlers, IPC.pickDocuments, 'files')
    return result as { token: string; paths: string[] }
  }

  it('binds a PICKER import to the pickDocuments token (raw paths are ignored)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-pick-'))
    const file = join(dir, 'picked.txt')
    writeFileSync(file, 'a picked library note with enough words to index here please')
    const other = join(dir, 'other.txt')
    writeFileSync(other, 'another real note the renderer names alongside the token here')
    const { token, paths } = await pick([file])
    expect(paths).toContain(file)
    expect(token).not.toBe('')
    // Pass a DIFFERENT real file as the raw paths with the token: main imports what was picked, not what we passed.
    const job = await runImport([other], { pickerToken: token })
    expect(job.documentIds).toHaveLength(1)
    const titles = (db.prepare('SELECT title FROM documents').all() as Array<{ title: string }>).map((r) => r.title)
    expect(titles).toEqual(['picked.txt'])
  })

  it('imports nothing for a forged/unknown token — even when raw paths name a real file', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-forge-'))
    const file = join(dir, 'secret.txt')
    writeFileSync(file, 'a real, existing, supported-type file a renderer should not read at will')
    // A code-exec'd renderer supplies a real path + a bogus picker token → nothing imported.
    const job = await runImport([file], { pickerToken: 'not-a-real-token' })
    expect(job.documentIds).toEqual([])
  })

  it('treats a picker token as single-use (a replay imports nothing)', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-once-'))
    const file = join(dir, 'once.txt')
    writeFileSync(file, 'a one-shot picked note with enough words to index here please now')
    const { token } = await pick([file])
    expect((await runImport([], { pickerToken: token })).documentIds).toHaveLength(1)
    expect((await runImport([], { pickerToken: token })).documentIds).toEqual([])
  })

  it('hardens the drag-drop seam (no token): keeps a real file, rejects a symlink', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
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

// Session 6 — Documents backend performance (DB-4, DB-6) at the handler. The service halves live
// with their owners: DB-4's batch + DB-5 in ingestion.test.ts, DB-7 in encrypted-documents.test.ts.
describe('registerDocsIpc — Session 6 backend performance (DB-4, DB-6)', () => {
  // DB-4 (integration): a folder import queues EVERY row before the invoke RESOLVES — the batch
  // commits all N inserts in one BEGIN…COMMIT after the (asynchronous since #274) walk is awaited.
  // Reverting to a lazy queue phase would make the count < N at resolution. The invoke names the
  // FOLDER: the batch then sits behind the asynchronous walk (#274), which a file list never awaits.
  it('DB-4: a folder import queues all rows before importDocuments resolves', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const dir = mkdtempSync(join(tmpdir(), 'hr-batch-'))
    const files = Array.from({ length: 6 }, (_, i) => join(dir, `f${i}.txt`))
    files.forEach((f, i) => writeFileSync(f, `document number ${i} alpha beta gamma delta epsilon`))

    const { result } = await invoke(handlers, IPC.importDocuments, [dir])
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
    await importDone(job.jobId)
    const docs = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(docs.filter((d) => job.documentIds.includes(d.id)).every((d) => d.status === 'indexed')).toBe(true)
  })

  // DB-6: the jobs map is capped at IMPORT_JOB_CAP (16). After > 16 completed imports the oldest is
  // evicted → getImportJob returns the synthetic done:true; the newest keeps its real counts.
  it('DB-6: the jobs map is capped — the oldest done job is evicted, the newest survives', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
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
    const { embedder, release, reached } = gatedEmbedder()
    registerDocsIpc(ctxWith(db, workspacePath, { embedder }))
    const file = join(workspacePath, 'slow.txt')
    writeFileSync(file, 'a slow-to-embed document alpha beta gamma delta epsilon zeta eta theta')

    // Start a real import; its embed parks on the gate, so the job stays in-flight (done:false).
    const gated = (await invoke(handlers, IPC.importDocuments, [file])).result as ImportJob
    await until(reached, 'the import loop reaching the gated embed') // loop is AT the gated embed (TS-1)
    // Fire 16 EMPTY imports (instantly done) to exceed IMPORT_JOB_CAP with the gated job the oldest.
    for (let i = 0; i < 16; i++) await invoke(handlers, IPC.importDocuments, [])

    // The in-flight job survived — getImportJob returns its REAL status (done:false), not the
    // synthetic done:true an evicted/unknown id would produce.
    const status = (await invoke(handlers, IPC.getImportJob, gated.jobId)).result as ImportJobStatus
    expect(status.done).toBe(false)
    // TEETH: drop the `if (s.done)` guard (evict oldest regardless) → the OLDEST job is the in-flight
    // gated one → it is evicted → getImportJob returns synthetic done:true → this reddens.

    release() // let the gated embed resolve, then drain so the loop/lease unwind cleanly
    await importDone(gated.jobId)
  })
})

// Session 7 — docs-IPC guard preconditions (T-3) + the import-loop lock-mid-job break (T-4).
// Tests only; each reddens if the guard/mechanism it pins regresses.
describe('registerDocsIpc — Session 7 guard preconditions & lock-mid-job (T-3/T-4)', () => {
  // T-3 (processing gate): while a document is being ingested it sits in `processing`, so
  // delete / reindex / preview / the #90 original export must all refuse with the friendly "still being
  // processed" copy — the docs-side mirror of the chat "refuses to delete while streaming" test. A gated
  // embedder parks the import at the embed phase so the row stays in `processing` for the assertions.
  // (The task-busy half — and its preview negative control — is doctasks-ipc.test.ts's 'busy-document
  // guard', over a REAL DocTaskManager.)
  it('T-3: a document in `processing` blocks delete, reindex, preview and original export (still being processed)', async () => {
    const { db, workspacePath } = freshWorkspace()
    const { embedder, release, reached } = gatedEmbedder()
    registerDocsIpc(ctxWith(db, workspacePath, { embedder }))
    const file = join(workspacePath, 'slow.txt')
    writeFileSync(file, 'a slow-to-embed document alpha beta gamma delta epsilon zeta eta theta iota')

    const gated = (await invoke(handlers, IPC.importDocuments, [file])).result as ImportJob
    const id = gated.documentIds[0]
    // Loop is AT the gated embed → id in `processing` (deterministic gate, no fixed sleep — TS-1).
    await until(reached, 'the import loop reaching the gated embed')

    for (const channel of [IPC.deleteDocument, IPC.reindexDocument, IPC.previewDocument, IPC.exportDocumentOriginal]) {
      await expect(invoke(handlers, channel, id), channel).rejects.toThrow(/still being processed/)
    }

    // Release + drain so the loop/lease unwind cleanly (no leak into the next test).
    release()
    await importDone(gated.jobId)
  })

  // GAP-5 (full-audit 2026-07-11) — the requireNoActiveTask mirror for SKILL runs: an in-flight run
  // (e.g. an extraction suspended at a seam await) reads the document's chunks/segments and persists
  // rows against it; delete/re-index underneath it would interleave with the run. `ctx.skillRunActive`
  // is the probe registerSkillsIpc assigns from its module-local SkillRunController.
  it('GAP-5: a live skill run blocks delete/reindex with the friendly busy copy', async () => {
    const { db, workspacePath } = freshWorkspace()
    let skillBusy = false
    const ctx = ctxWith(db, workspacePath, {
      docTasks: {
        isDocumentBusy: () => false,
        hasActiveTask: () => false,
        maybeEnqueueTreeBuild: () => {}
      },
      skillRunActive: (documentId: string) => skillBusy && typeof documentId === 'string'
    })
    registerDocsIpc(ctx)
    const file = join(workspacePath, 'statement.txt')
    writeFileSync(file, 'a bank statement with enough words to index for the skill-run guard test here')
    const { documentIds } = await runImport([file])
    const id = documentIds[0]

    // A skill run now works on the document (the extraction stalled at a seam, from the UI's view).
    skillBusy = true
    await expect(invoke(handlers, IPC.deleteDocument, id)).rejects.toThrow(/skill is working/i)
    await expect(invoke(handlers, IPC.reindexDocument, id)).rejects.toThrow(/skill is working/i)

    // The run finishes → both proceed again (the guard is scoped to a LIVE run, not sticky).
    skillBusy = false
    const re = (await invoke(handlers, IPC.reindexDocument, id)).result as DocumentInfo
    expect(re.id).toBe(id)
    await invoke(handlers, IPC.deleteDocument, id) // resolves cleanly — no lingering refusal
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
    const ctx = ctxWith(db, workspacePath, {
      embedder,
      workspace: {
        isUnlocked: () => unlocked,
        beginDocumentWork: () => {
          leaseDelta += 1
          return () => {
            leaseDelta -= 1
          }
        }
      }
    })
    registerDocsIpc(ctx)

    const f0 = join(workspacePath, 'f0.txt')
    const f1 = join(workspacePath, 'f1.txt')
    writeFileSync(f0, 'the first file alpha beta gamma delta epsilon zeta eta theta iota kappa')
    writeFileSync(f1, 'the second file lambda mu nu xi omicron pi rho sigma tau upsilon phi chi')

    const job = (await invoke(handlers, IPC.importDocuments, [f0, f1])).result as ImportJob
    const [id0, id1] = job.documentIds

    // Drive to done via getImportJob (it needs NO unlock, unlike listDocuments) since the workspace
    // locks itself mid-job.
    const status = await importDone(job.jobId)
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

// ---- OCR-R P1 (BE-1, ocr-audit 2026-07-18): task admission vs. a live re-index ----------
// `registerDocsIpc` refuses re-index/delete while a task targets the doc
// (`requireNoActiveTask`), but the REVERSE direction did not exist: `startDocTask` never
// consulted the module-local `processing` set, so an OCR re-run admitted mid-re-index would
// interleave two chunk DELETE/INSERT transactions + two embed phases on one document (the
// already-OCR'd PDF keeps its `ocr` metadata through the whole re-index, so no other
// validation catches it). The set's probe is now exposed on ctx (`docIngestionActive`, the
// skillRunActive pattern) and threaded into the manager's admission guard. Closes audit
// test-gap #3; watched fail pre-fix.
//
// Issue #97 (starved-runner flake, the issue-#84 / vault-lock-cipher class): on PR #96's
// run 30809685972 the windows/24.x leg alone hit the global 15 s vitest timeout at
// 28 110 ms — the identical tree was green on the other three legs, on the failed leg's
// re-run, and locally. The test does two full OCR passes + a document ingest + a gated
// re-index (real embed work) before its assertions, so a starved runner can stretch the
// setup past the global budget. Per the established pattern the test carries an explicit
// 60 s timeout, and waitTerminal's liveness bound is 30 s so a genuinely hung task still
// fails first with the informative per-task error. Every assertion is semantic — none is
// a timing bound — so the wider budget loosens nothing the test proves.
//
// #458 residual (run 35099769260): that literal 60 s later BECAME the CI default, so on CI
// this test had no extra room at all — it spent 64 s in setup on a runner that froze twice
// (24 s + 18 s of no output from any process) and timed out before the OCR was even queued.
// The timed-out body then ran on into the next test's handlers, hence the misleading
// `Unknown document` rejection in that log. The budget is now `testBudgetMs` (CI-aware).
describe('doc-task admission vs. in-flight ingestion (BE-1)', () => {
  it('refuses startDocTask("ocr") while a gated re-index holds the document; admits after release', async () => {
    const { db, workspacePath } = freshWorkspace()
    const storeDir = documentsDir(workspacePath)
    const g = perFileGatedEmbedder()
    const ctx = ctxWith(db, workspacePath, { embedder: g.embedder })
    registerDocsIpc(ctx)
    const engine: OcrEngine = {
      id: 'fake-tesseract',
      languages: ['deu', 'eng'],
      recognize: async (image: Buffer) => ({ text: `Seite ${image[0]} erkannt.`, confidence: 90 })
    }
    const rasterize: RasterizePdf = async (_pdf, o) => {
      o.onPageCount?.(2)
      for (let n = 1; n <= 2; n++) await o.onPage(n, Buffer.from([n]))
      return { pageCount: 2 }
    }
    // The live wiring shape: the predicate reads ctx late-bound (registerDocsIpc assigned
    // `ctx.docIngestionActive` above), exactly like main/index.ts.
    const manager = docTaskManager(
      { root: workspacePath, db, storeDir },
      {
        getIngestionDeps: () => ({ embedder: g.embedder }),
        getOcrEngine: () => engine,
        rasterizePdf: rasterize,
        isDocumentProcessing: (id) => ctx.docIngestionActive?.(id) ?? false
      }
    )
    ctx.docTasks = manager

    // A scan-detected PDF, made searchable once — the already-OCR'd re-run target, the one
    // kind whose admission metadata (`doc.ocr`) survives a running re-index.
    const p = join(workspacePath, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(2))
    const info = createQueuedDocument(db, p)
    await processDocument(db, storeDir, info.id)
    const first = manager.startDocTask({ kind: 'ocr', documentIds: [info.id] })
    expect((await waitTerminal(manager, first.jobId, 30_000)).state).toBe('done')

    // Gate the embedder and park a re-index mid-embed — the doc sits in `processing`.
    g.setGating(true)
    const reindexP = invoke(handlers, IPC.reindexDocument, info.id)
    await within(g.awaitParked(), 'the re-embed parking on the gate')
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [info.id] })).toThrow(
      TASK_DOCUMENT_BUSY_INGESTING_MESSAGE
    )
    g.release()
    await reindexP
    // After the re-index settles, the redo admits and completes normally (no over-eager guard).
    const redo = manager.startDocTask({ kind: 'ocr', documentIds: [info.id] })
    expect((await waitTerminal(manager, redo.jobId, 30_000)).state).toBe('done')
  }, testBudgetMs(60_000))
})

// ---- #158 (DT-3): the auto deep-index offer vs the import loop's `processing` window ------
// `offerDeepIndex(id)` used to run INSIDE the per-document try — while the id was still in the
// module-local `processing` set — so with a chat runtime up, `maybeEnqueueTreeBuild`'s
// `startDocTask({kind:'tree'})` always hit the BE-1 `isDocumentProcessing` guard and the
// best-effort catch swallowed it: no tree task, and (runtime present) no `pending` marker
// either. The Q1/Q4 auto-build silently never fired in the wired app; unit tests passed
// because partial deps left the guard unwired. The offer now runs after the `finally`
// releases the id. Watched fail pre-fix (the spy result was a documentBusyIngesting throw).
describe('auto deep-index enqueue at import with a runtime up (#158 / DT-3)', () => {
  it('the import-loop offer survives the wired BE-1 guard and enqueues the tree task', async () => {
    const { db, workspacePath } = freshWorkspace()
    const storeDir = documentsDir(workspacePath)
    const ctx = ctxWith(db, workspacePath)
    registerDocsIpc(ctx)
    // A chat runtime IS up — the branch that enqueues a real tree task (the no-runtime
    // branch writes `tree_status='pending'` before any guard and never had the bug).
    const runtime = docTaskRuntime()
    // The live wiring shape (main/index.ts): the guard reads ctx late-bound.
    const manager = docTaskManager(
      { root: workspacePath, db, storeDir },
      {
        getRuntime: () => runtime,
        // Small context ⇒ ~200-word summary windows ⇒ a ~3,000-word doc exceeds the 12-window
        // ceiling (`planSummaryWindows().truncated`) and qualifies for the auto tree build.
        getContextTokens: () => 1024,
        isDocumentProcessing: (id) => ctx.docIngestionActive?.(id) ?? false
      }
    )
    ctx.docTasks = manager
    const startSpy = vi.spyOn(manager, 'startDocTask')

    const words = Array.from({ length: 3000 }, (_, i) => `wort${i}`).join(' ')
    const p = join(workspacePath, 'grossesdokument.txt')
    writeFileSync(p, words, 'utf8')
    const job = await runImport([p])
    expect(job.documentIds.length).toBe(1)

    // The offer reached startDocTask AND was admitted (pre-fix: the same call THREW
    // documentBusyIngesting into the swallowed best-effort catch).
    const treeIdx = startSpy.mock.calls.findIndex((c) => c[0]?.kind === 'tree')
    expect(treeIdx).toBeGreaterThanOrEqual(0)
    expect(startSpy.mock.results[treeIdx].type).toBe('return')

    // Hygiene: don't leak the enqueued build past the test.
    manager.cancelAllDocTasks()
    await within(manager.awaitActiveTaskSettled(), 'the cancelled tree build settling')
  }, testBudgetMs(60_000))
})

// ---- Issue #90: export the stored ORIGINAL bytes (docs:exportOriginal) --------------------
// The text export (`docs:export`) refuses every non-text format, and the DocRow gate hid even
// that from imported documents — so an imported PDF/DOCX/recording could never leave the
// workspace again. The new channel saves the stored original (any format) via the native save
// dialog: MAIN-only dialog+fs, encryption-boundary warning in the dialog `message`, atomic
// write, ids-only audit (`document_exported`), lease-serialized against a password-change
// re-key.
describe('registerDocsIpc — #90 export original (docs:exportOriginal)', () => {
  beforeEach(() => {
    saveDialogState.result = { canceled: true, filePath: undefined }
    saveDialogState.lastOptions = null
  })

  /** Bytes that are deliberately NOT valid UTF-8: a text-decode round-trip would corrupt
   *  them, so a byte-identical export proves the handler never treats content as text. */
  function binaryishSource(workspacePath: string, name: string): { path: string; bytes: Buffer } {
    const bytes = Buffer.concat([
      Buffer.from('alpha beta gamma delta epsilon zeta eta theta iota kappa\n', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc3, 0x28])
    ])
    const path = join(workspacePath, name)
    writeFileSync(path, bytes)
    return { path, bytes }
  }

  function sha256Hex(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex')
  }

  it('saves the stored original byte-identically (sha256 match), audits ids ONLY, and holds the doc-work lease', async () => {
    const { db, workspacePath } = freshWorkspace()
    const release = vi.fn()
    const beginDocumentWork = vi.fn(() => release)
    const audit = vi.fn()
    registerDocsIpc(ctxWith(db, workspacePath, { workspace: { beginDocumentWork }, audit }))

    const { path, bytes } = binaryishSource(workspacePath, 'notes.txt')
    const job = await runImport([path])
    const id = job.documentIds[0]
    beginDocumentWork.mockClear() // the import loop held it too — count the EXPORT's hold alone
    release.mockClear() // …and released it through the same shared `release`

    const dest = join(workspacePath, 'exported-notes.txt')
    saveDialogState.result = { canceled: false, filePath: dest }
    const { result } = await invoke(handlers, IPC.exportDocumentOriginal, id)
    expect(result).toBe(dest)
    // Byte-for-byte: the export is the ORIGINAL, not a re-render.
    const exported = readFileSync(dest)
    expect(sha256Hex(exported)).toBe(sha256Hex(bytes))
    // The save dialog carried the document's own extension as suggestion + the
    // encryption-boundary warning as `message` (the macOS-sheet voice of the warning).
    expect(String(saveDialogState.lastOptions?.defaultPath)).toMatch(/\.txt$/)
    expect(String(saveDialogState.lastOptions?.message)).toMatch(
      /not protected by your workspace password/
    )
    // Atomic write: no tmp sibling residue next to the destination.
    expect(readdirSync(workspacePath).filter((n) => n.includes('.tmp'))).toEqual([])
    // Audit: ids only — never the title, path, or content (the S1 privacy rule).
    expect(audit).toHaveBeenCalledWith('document_exported', expect.any(String), { documentId: id })
    const meta = audit.mock.calls.find((c) => c[0] === 'document_exported')?.[2] as Record<
      string,
      unknown
    >
    expect(Object.keys(meta)).toEqual(['documentId'])
    // The read was serialized against a password-change re-key (the import-job posture).
    expect(beginDocumentWork).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('exports the original of an ENCRYPTED stored doc and shreds the decrypt transient', async () => {
    const { db, workspacePath } = freshWorkspace()
    const storeDir = documentsDir(workspacePath)
    // A NON-identity fake cipher (XOR): an export that skipped the decrypt would hand back the
    // scrambled `.enc` bytes, which the byte-equality check below then catches.
    const flip = (src: string, dest: string): void =>
      writeFileSync(dest, Buffer.from(readFileSync(src).map((b) => b ^ 0x5a)))
    const decryptDests: string[] = []
    const cipher: DocumentCipher = {
      encryptFile: flip,
      decryptFile: flip,
      encryptFileAsync: async (src, dest) => flip(src, dest),
      decryptFileAsync: async (src, dest) => {
        decryptDests.push(dest)
        flip(src, dest)
      }
    }
    registerDocsIpc(ctxWith(db, workspacePath, { cipher }))

    const { path, bytes } = binaryishSource(workspacePath, 'contract.txt')
    const job = await runImport([path])
    const id = job.documentIds[0]
    // The stored copy is the `.enc` artifact; the on-disk original is now redundant.
    expect(readdirSync(storeDir).every((n) => n.endsWith(ENCRYPTED_DOC_SUFFIX))).toBe(true)
    rmSync(path)
    decryptDests.length = 0 // count the EXPORT's decrypt alone

    const dest = join(workspacePath, 'exported-contract.txt')
    saveDialogState.result = { canceled: false, filePath: dest }
    const { result } = await invoke(handlers, IPC.exportDocumentOriginal, id)
    expect(result).toBe(dest)
    // Byte-for-byte the ORIGINAL — only possible if the `.enc` copy was decrypted.
    expect(readFileSync(dest).equals(bytes)).toBe(true)
    // The export decrypted into one transient (`.parse-export-bin-*`) and shredded it — only the `.enc` remains.
    expect(decryptDests).toHaveLength(1)
    expect(existsSync(decryptDests[0])).toBe(false)
    expect(readdirSync(storeDir).every((n) => n.endsWith(ENCRYPTED_DOC_SUFFIX))).toBe(true)
  })

  it('cancel in the save dialog returns null: no file, no audit event', async () => {
    const { db, workspacePath } = freshWorkspace()
    const audit = vi.fn()
    registerDocsIpc(ctxWith(db, workspacePath, { audit }))
    const { path } = binaryishSource(workspacePath, 'notes.txt')
    const job = await runImport([path])
    audit.mockClear()

    saveDialogState.result = { canceled: true, filePath: undefined }
    const { result } = await invoke(handlers, IPC.exportDocumentOriginal, job.documentIds[0])
    expect(result).toBeNull()
    expect(audit).not.toHaveBeenCalled()
  })

  it('missing stored copy AND missing original → the clear "no longer on disk" error', async () => {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    const { path } = binaryishSource(workspacePath, 'gone.txt')
    const job = await runImport([path])
    const id = job.documentIds[0]
    // Sever both sources: the workspace copy and the (deleted) import original.
    const row = db.prepare('SELECT stored_path FROM documents WHERE id = ?').get(id) as unknown as {
      stored_path: string | null
    }
    if (row.stored_path) rmSync(row.stored_path)
    rmSync(path)
    saveDialogState.result = { canceled: false, filePath: join(workspacePath, 'never.txt') }
    await expect(invoke(handlers, IPC.exportDocumentOriginal, id)).rejects.toThrow(
      /no longer on disk/
    )
  })
})

// #570 / #571: a scan attached in a chat fails (scan detected) and is NOT filed — no link (N4),
// its pending destination still naming the chat. The chat pointer's copy ("it joins this chat by
// itself — no need to attach it again") rests on what happens next: "Make searchable (OCR)" in
// Documents re-indexes the SAME row, and the success files it by that pending destination into
// Temporary + the chat's link. Pinned end to end here (import IPC → OCR task → filing).
describe('a scan attached in a chat, then made searchable in Documents (#570, #571)', () => {
  async function scanAttachedToChat(): Promise<{
    db: Db
    workspacePath: string
    storeDir: string
    convId: string
    id: string
  }> {
    const { db, workspacePath } = freshWorkspace()
    registerDocsIpc(ctxWith(db, workspacePath))
    // The attach-born chat's D71 scope: empty and explicit, narrowed by its attachments.
    const conv = createConversation(db, { mode: 'documents', scope: { collectionIds: [], documentIds: [] } })
    const file = join(workspacePath, 'scan.pdf')
    writeFileSync(file, makeScanOnlyPdf(2))
    const job = await runImport([file], { destination: { kind: 'conversation', conversationId: conv.id } })
    return { db, workspacePath, storeDir: documentsDir(workspacePath), convId: conv.id, id: job.documentIds[0] }
  }
  const pendingOf = (db: Db, id: string): string | null =>
    (db.prepare('SELECT pending_destination_json FROM documents WHERE id = ?').get(id) as {
      pending_destination_json: string | null
    }).pending_destination_json

  it('the failed scan is unfiled, keeps the chat as its destination, and still scopes the chat (#571)', async () => {
    const { db, convId, id } = await scanAttachedToChat()
    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === id)).toMatchObject({ status: 'failed', scanDetected: true })
    expect(conversationAttachmentIds(db, convId)).toEqual([]) // N4: no link for a failed file
    expect(JSON.parse(pendingOf(db, id) ?? 'null')).toEqual({ kind: 'conversation', conversationId: convId })
    // Not the whole corpus: the chat is scoped to its (unreadable) attachment.
    expect(resolveScope(db, convId)).toMatchObject({ collectionIds: null, documentIds: [id] })
  })

  it('OCR from Documents links it to that chat by itself — Temporary, not Library, intent cleared', async () => {
    const { db, workspacePath, storeDir, convId, id } = await scanAttachedToChat()
    const engine: OcrEngine = {
      id: 'fake-tesseract',
      languages: ['deu', 'eng'],
      recognize: async (image: Buffer) => ({ text: `Seite ${image[0]}: Der Vertrag endet am 1. März.`, confidence: 90 })
    }
    const rasterize: RasterizePdf = async (_pdf, o) => {
      o.onPageCount?.(2)
      for (let n = 1; n <= 2; n++) await o.onPage(n, Buffer.from([n]))
      return { pageCount: 2 }
    }
    const manager = docTaskManager(
      { root: workspacePath, db, storeDir },
      {
        getIngestionDeps: () => ({ embedder: createMockEmbedder() }),
        getOcrEngine: () => engine,
        rasterizePdf: rasterize
      }
    )
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [id] })
    const { state } = await waitTerminal(manager, jobId, 30_000)
    expect(state).toBe('done')

    const listed = (await invoke(handlers, IPC.listDocuments)).result as DocumentInfo[]
    expect(listed.find((d) => d.id === id)?.status).toBe('indexed')
    expect(conversationAttachmentIds(db, convId)).toEqual([id]) // joined the chat — no re-attach
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'temporary')!.id)).toContain(id)
    expect(documentIdsInCollection(db, getBuiltinCollection(db, 'library')!.id)).not.toContain(id)
    expect(pendingOf(db, id)).toBeNull()
    expect(resolveScope(db, convId).documentIds).toEqual([id]) // once, now as a linked attachment
  }, testBudgetMs(60_000))
})
