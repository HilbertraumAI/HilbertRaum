import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AUD-02 — the lock-teardown ADMISSION window.
//
// "Lock now" runs a multi-second AWAITED teardown (sidecar suspends, in-flight-stream settles,
// doc-task settle, resident-vector purge) and only re-encrypts the vault at the very END. Every
// content-surface guard used to be a bare `workspace.isUnlocked()`, which is literally "the DB
// handle is non-null" — still true for the whole teardown. An `ipcMain.handle` yields the main
// thread at each `await`, so an invoke that lands 1-10 s after the user clicks Lock now was
// DISPATCHED and ADMITTED, pumped immediately, and — because `suspend()`/`stop()` are deliberately
// non-latching for the remainder of the handler — lazily RESPAWNED the sidecar the teardown had
// just killed: a ~10 GB TranslateGemma with document text in its KV cache, or a ~4.6 GB vision
// runtime with image-derived prefill, still running after the workspace reports locked.
//
// These tests park the lock handler INSIDE its awaited teardown (a boundary-fake sidecar suspend
// that resolves on command), prove the DB is still open in that window, and then drive each
// content surface through its real IPC handler. Each must refuse with its module's existing
// friendly locked copy, and no spawn observable (`translate()` / vision `createRuntime` /
// a queued documents row) may fire.
//
// Real encrypted vault + real SQLite + the real DocTaskManager / TranslateJobService /
// VisionService; only the sidecars and the embedder are boundary fakes.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  // Only referenced inside picker handlers this file never drives.
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => {} }
}))

import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { registerDocTasksIpc } from '../../src/main/ipc/registerDocTasksIpc'
import { registerTranslateIpc } from '../../src/main/ipc/registerTranslateIpc'
import { registerImagesIpc } from '../../src/main/ipc/registerImagesIpc'
import { registerDocsIpc } from '../../src/main/ipc/registerDocsIpc'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import {
  WorkspaceController,
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  workspaceAdmitsWork,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import { DocTaskManager } from '../../src/main/services/doctasks'
import { TranslateJobService } from '../../src/main/services/translation/jobs'
import { VisionService, type VisionAnalyzer } from '../../src/main/services/vision'
import type { Translator, TranslateOptions } from '../../src/main/services/translation'
import type { Embedder } from '../../src/main/services/embeddings'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { performShutdown } from '../../src/main/shutdown'
import { t } from '../../src/shared/i18n'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** One event-loop turn. Used only as a bounded CEILING for "nothing else happened". */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Drain up to `ceiling` turns, resolving as soon as `pred` holds. Never a fixed sleep. */
async function waitUntil(pred: () => boolean, ceiling = 200): Promise<boolean> {
  for (let i = 0; i < ceiling; i++) {
    if (pred()) return true
    await tick()
  }
  return pred()
}

/**
 * A minimal PNG whose HEADER parses (signature + a 2x2 IHDR): the main-side analyze validation
 * rejects a claimed png/jpeg with an unparseable header as `decodeFailed`, which would make the
 * "no vision runtime was built" assertion pass for the wrong reason.
 */
function validPngBytes(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(b.buffer)
  dv.setUint32(16, 2) // width
  dv.setUint32(20, 2) // height
  return b
}

/** A deterministic 4-dim embedder — the ingestion fixture needs vectors, not quality. */
const fakeEmbedder: Embedder = {
  id: 'mock-embedder',
  dimensions: 4,
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0]))
}

interface Harness {
  ctrl: WorkspaceController
  ctx: AppContext
  documentId: string
  translator: Translator & { translate: ReturnType<typeof vi.fn> }
  createRuntime: ReturnType<typeof vi.fn>
  /** Resolves once the lock handler has entered the gated sidecar suspend. */
  suspendEntered: () => boolean
  /** Let the parked teardown continue. */
  releaseSuspend: () => void
}

interface HarnessOptions {
  /**
   * Fail the vault re-encrypt (the CODE-1a disk-full shape) through the controller's own
   * `encryptFileImpl` seam, so `lock()` throws AFTER the teardown and the controller restores
   * itself to a consistently UNLOCKED state — the path whose latch disarm must be proven.
   */
  failReEncrypt?: boolean
  /**
   * Make the gated sidecar boundary throw SYNCHRONOUSLY instead of parking. The teardown's
   * `Promise.allSettled([...])` evaluates its elements before `allSettled` ever sees them, so a
   * synchronous throw escapes the whole handler — the shape that would strand the latch armed
   * over a still-open workspace without a structural disarm.
   */
  suspendThrowsSync?: boolean
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-lockrace-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const vp: VaultPaths = vaultPathsFrom({
    configPath: join(root, 'config'),
    dbPath: join(workspacePath, 'hilbertraum.sqlite')
  })
  createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
  const ctrl = new WorkspaceController(
    vp,
    ENCRYPTION_REQUIRED,
    false,
    opts.failReEncrypt
      ? () => {
          throw new Error('ENOSPC: no space left on device')
        }
      : undefined
  )
  ctrl.init()
  ctrl.unlock('right-password')
  const storeDir = documentsDir(workspacePath)

  // A REAL imported document (encrypted `.enc` sidecar), so `startDocTask('translation')` clears
  // every validation guard and the only thing that can refuse it is the admission gate.
  const srcPath = join(root, 'source.txt')
  writeFileSync(srcPath, Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '), 'utf8')
  const queued = createQueuedDocument(ctrl.requireDb(), srcPath)
  const imported = await processDocument(ctrl.requireDb(), storeDir, queued.id, {
    embedder: fakeEmbedder,
    cipher: ctrl.documentCipher()
  })
  expect(imported.status).toBe('indexed')

  const translate = vi.fn(async (opts: TranslateOptions) => opts.text)
  const translator = {
    modelId: 'fake-translator',
    contextWindow: () => 4096,
    translate,
    stop: async () => {},
    suspend: async () => {}
  } as unknown as Translator & { translate: ReturnType<typeof vi.fn> }

  // The gated boundary: the lock handler awaits this suspend, so it parks mid-teardown with the
  // DB still open — exactly the window a real multi-second sidecar teardown opens.
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  // The failed-re-encrypt case is about what happens AFTER the teardown, so let it run straight
  // through instead of parking (nothing releases the gate there).
  if (opts.failReEncrypt) release()

  const ctx = {
    paths: { rootPath: root, configPath: join(root, 'config'), workspacePath, dbPath: vp.dbPath },
    get db() {
      return ctrl.requireDb()
    },
    workspace: ctrl,
    // `shutdown` is the quit path's runtime latch — present so the quit teardown runs the same
    // shape it does in production (a missing method there would throw into a best-effort catch).
    runtime: {
      stop: async () => {},
      shutdown: () => {},
      isShutdown: () => false,
      activeModelId: () => null,
      active: () => null
    },
    embedder: {
      ...fakeEmbedder,
      suspend: (): Promise<void> => {
        entered = true
        if (opts.suspendThrowsSync) throw new Error('embedder suspend blew up synchronously')
        return gate
      },
      // QUIT stops the embedder (`stop()`) where LOCK suspends it — gate both on the same handle
      // so `performShutdown` parks in exactly the same window.
      stop: (): Promise<void> => {
        entered = true
        return gate
      }
    },
    translator,
    manifestsDir: null,
    isDev: false
  } as unknown as AppContext

  ctx.docTasks = new DocTaskManager({
    getDb: () => ctrl.requireDb(),
    getRuntime: () => null,
    getTranslator: () => ctx.translator ?? null,
    isChatStreaming: () => false,
    getContextTokens: () => 4096,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({ embedder: fakeEmbedder, cipher: ctrl.documentCipher() }),
    beginDocumentWork: () => ctrl.beginDocumentWork(),
    isWorkspaceLocking: () => ctrl.isLocking?.() ?? false
  })
  ctx.translateJobs = new TranslateJobService({
    getTranslator: () => ctx.translator ?? null,
    hasActiveDocTask: () => ctx.docTasks?.hasActiveTask() ?? false,
    isWorkspaceLocking: () => ctrl.isLocking?.() ?? false
  })
  const analyzer: VisionAnalyzer = { analyze: async () => 'an answer', stop: async () => {} }
  const createRuntime = vi.fn(() => analyzer)
  ctx.vision = new VisionService({
    getStatus: async () => ({ available: true, modelId: 'fake-vision', modelDisplayName: 'Fake' }),
    createRuntime,
    isWorkspaceLocking: () => ctrl.isLocking?.() ?? false
  })

  registerWorkspaceIpc(ctx)
  registerDocTasksIpc(ctx)
  registerTranslateIpc(ctx, ctx.translateJobs)
  registerImagesIpc(ctx, ctx.vision)
  registerDocsIpc(ctx)

  return {
    ctrl,
    ctx,
    documentId: queued.id,
    translator,
    createRuntime,
    suspendEntered: () => entered,
    releaseSuspend: release
  }
}

/**
 * Park the lock handler inside its awaited teardown and assert the DB is still open there.
 * The in-flight lock promise is returned WRAPPED — an `async` function that returned it bare
 * would adopt (await) it, which is precisely the promise this helper must not wait on.
 */
async function parkedLock(h: Harness): Promise<{ lockP: Promise<{ result: unknown }> }> {
  const lockP = invoke(handlers, IPC.lockWorkspace)
  expect(await waitUntil(() => h.suspendEntered())).toBe(true)
  // THE window: the teardown is running, the vault has NOT re-encrypted, `isUnlocked()` is true.
  expect(h.ctrl.isUnlocked()).toBe(true)
  return { lockP }
}

beforeEach(() => ipcState.handlers.clear())

describe('admission during the lock teardown (AUD-02)', () => {
  it('refuses startDocTask("translation") while the lock teardown is parked — no sidecar respawn', async () => {
    const h = await harness()
    const { lockP } = await parkedLock(h)

    await expect(
      invoke(handlers, IPC.startDocTask, {
        kind: 'translation',
        documentIds: [h.documentId],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
    ).rejects.toThrow(/Workspace is locked\./)
    // Teeth: give the queue/pump a bounded budget to prove nothing reached the sidecar.
    for (let i = 0; i < 20; i++) await tick()
    expect(h.translator.translate).not.toHaveBeenCalled()
    expect(h.ctx.docTasks?.hasActiveTask()).toBe(false)

    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  it('refuses translateStart while the lock teardown is parked — no sidecar respawn', async () => {
    const h = await harness()
    const { lockP } = await parkedLock(h)

    await expect(
      invoke(handlers, IPC.translateStart, { sourceLang: 'en', targetLang: 'de', text: 'hello world' })
    ).rejects.toThrow(/Workspace is locked\./)
    for (let i = 0; i < 20; i++) await tick()
    expect(h.translator.translate).not.toHaveBeenCalled()

    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  it('refuses imageAnalyze while the lock teardown is parked — no vision runtime is built', async () => {
    const h = await harness()
    const { lockP } = await parkedLock(h)

    await expect(
      invoke(handlers, IPC.imageAnalyze, {
        imageBytes: validPngBytes(),
        mimeType: 'image/png',
        question: 'what is this?'
      })
    ).rejects.toThrow(/Workspace is locked\./)
    for (let i = 0; i < 20; i++) await tick()
    expect(h.createRuntime).not.toHaveBeenCalled()

    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  it('refuses importDocuments while the lock teardown is parked — no document row is queued', async () => {
    const h = await harness()
    const before = (
      h.ctrl.requireDb().prepare('SELECT COUNT(*) AS n FROM documents').get() as unknown as { n: number }
    ).n
    const { lockP } = await parkedLock(h)

    const dropped = join(h.ctx.paths.rootPath, 'dropped.txt')
    writeFileSync(dropped, 'some text to import', 'utf8')
    await expect(invoke(handlers, IPC.importDocuments, [dropped])).rejects.toThrow(/Workspace is locked\./)
    for (let i = 0; i < 20; i++) await tick()
    const after = (
      h.ctrl.requireDb().prepare('SELECT COUNT(*) AS n FROM documents').get() as unknown as { n: number }
    ).n
    expect(after).toBe(before)

    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  // The latch must not outlive a FAILED lock. The re-encrypt realistically fails on ENOSPC (during
  // a lock the plaintext DB + the old `.enc` + the new `.enc.tmp` coexist, so each lock needs
  // ~DB-size free space on a nearly-full stick). The controller then restores itself to a
  // consistently UNLOCKED state — plaintext DB re-opened, key kept for the retry — so the session
  // must keep working; a latch left armed there would refuse every content surface for the rest of
  // the session with the workspace wide open and no recovery short of a relaunch.
  //
  // Driven through the REAL lock handler (not by poking the controller's setters), with the
  // failure injected at the controller's own `encryptFileImpl` seam.
  it('a FAILED lock (disk full) leaves the workspace usable — real handler, real failure seam', async () => {
    const h = await harness({ failReEncrypt: true })

    // The friendly localized copy, never the raw ENOSPC string.
    await expect(invoke(handlers, IPC.lockWorkspace)).rejects.toThrow(
      t('en', 'main.workspace.lockFailed')
    )
    await expect(invoke(handlers, IPC.lockWorkspace)).rejects.not.toThrow(/ENOSPC/)

    // The workspace is genuinely still open, and the latch did NOT survive the failure.
    expect(h.ctrl.isUnlocked()).toBe(true)
    expect(h.ctrl.isLocking()).toBe(false)

    // …and a content surface actually ADMITS again — the property that matters, asserted by
    // driving one rather than by reading the flag.
    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'translation',
      documentIds: [h.documentId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    expect(result).toMatchObject({ jobId: expect.any(String) })
    h.ctx.docTasks?.cancelAllDocTasks()
    await h.ctx.docTasks?.awaitActiveTaskSettled()
  })

  // A throw ANYWHERE between arming the latch and `lock()` must disarm it too. Arming a latch
  // ahead of multi-second work introduces a failure mode the pre-latch code did not have: the
  // workspace stays UNLOCKED (DB open, key live) while every guard reports locked, and `unlock()`
  // cannot rescue it — it early-returns on an already-unlocked controller before it can start a
  // new session. The teardown boundaries are all async today, so this drives the one shape that
  // still escapes: a boundary that throws SYNCHRONOUSLY while the `allSettled` array is being
  // built, before `allSettled` can swallow anything.
  it('a synchronous throw mid-teardown still disarms the latch (structural, not per-boundary)', async () => {
    const h = await harness({ suspendThrowsSync: true })

    await expect(invoke(handlers, IPC.lockWorkspace)).rejects.toThrow(/blew up synchronously/)
    // The workspace never locked — and must not be stranded behind an armed latch.
    expect(h.ctrl.isUnlocked()).toBe(true)
    expect(h.ctrl.isLocking()).toBe(false)
    expect(workspaceAdmitsWork(h.ctrl)).toBe(true)

    const { result } = await invoke(handlers, IPC.startDocTask, {
      kind: 'translation',
      documentIds: [h.documentId],
      params: { sourceLang: 'en', targetLang: 'de' }
    })
    expect(result).toMatchObject({ jobId: expect.any(String) })
    h.ctx.docTasks?.cancelAllDocTasks()
    await h.ctx.docTasks?.awaitActiveTaskSettled()
  })

  // An `unlockWorkspace` landing mid-teardown must NOT disarm the latch: `unlock()` early-returns
  // on an already-unlocked controller, deliberately before it can start a new session. Pinning it
  // here so the ordering stays an intentional guarantee rather than an accident.
  it('an unlock landing mid-teardown cannot re-open the admission window', async () => {
    const h = await harness()
    const { lockP } = await parkedLock(h)

    const { result } = await invoke(handlers, IPC.unlockWorkspace, 'right-password')
    expect(result).toMatchObject({ ok: true }) // already unlocked → a no-op success
    expect(h.ctrl.isLocking()).toBe(true) // …but the latch is untouched
    await expect(
      invoke(handlers, IPC.startDocTask, {
        kind: 'translation',
        documentIds: [h.documentId],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
    ).rejects.toThrow(/Workspace is locked\./)

    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  // A `plaintext_dev` workspace has no vault to re-encrypt, so `lock()` is a deliberate no-op and
  // the DB stays open. The latch must NOT survive that: only an unlock clears it, and a plaintext
  // workspace never unlocks again — a "Lock now" there would otherwise refuse every content
  // surface for the rest of the session with nothing able to undo it.
  it('does not leave a plaintext_dev workspace latched after its no-op lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-lockrace-plain-'))
    mkdirSync(join(root, 'config'), { recursive: true })
    mkdirSync(join(root, 'workspace'), { recursive: true })
    const ctrl = new WorkspaceController(
      vaultPathsFrom({
        configPath: join(root, 'config'),
        dbPath: join(root, 'workspace', 'hilbertraum.sqlite')
      }),
      DEFAULT_POLICY,
      true // dev → the plaintext workspace opens at init()
    )
    ctrl.init()
    expect(ctrl.isUnlocked()).toBe(true)
    registerWorkspaceIpc({
      workspace: ctrl,
      runtime: { stop: async () => {}, activeModelId: () => null },
      embedder: { stop: async () => {} }
    } as unknown as AppContext)

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'unlocked', mode: 'plaintext_dev' })
    expect(ctrl.isLocking()).toBe(false)
    expect(workspaceAdmitsWork(ctrl)).toBe(true)
  })

  // A COMPLETED lock deliberately leaves the latch armed (isUnlocked() already reports locked);
  // the NEXT unlock is what clears it, so the workspace is fully usable again afterwards.
  it('clears the latch on the next unlock (a locked-then-unlocked session admits work again)', async () => {
    const h = await harness()
    const { lockP } = await parkedLock(h)
    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
    expect(h.ctrl.isLocking()).toBe(true) // armed until the next unlock

    h.ctrl.unlock('right-password')
    expect(h.ctrl.isUnlocked()).toBe(true)
    expect(h.ctrl.isLocking()).toBe(false)
    // The unlock also advances the session epoch, which is what invalidates a stale model start
    // whose multi-GB weight hash spanned the whole lock → unlock cycle (AUD-03).
    expect(h.ctrl.unlockEpoch()).toBeGreaterThan(0)
  })
})

// The QUIT teardown opens the same admission window as the lock: the DB stays open while it
// awaits the sidecar stops, the stream settles and the doc-task settle — up to ~10 s before
// `app.exit(0)`. Most sidecars are safe there because quit uses the permanently-latching `stop()`
// where lock uses the non-latching `suspend()`, so an admitted call fails at `ensureStarted`
// rather than respawning. Two are not, and are covered here.
describe('admission during the QUIT teardown (AUD-02)', () => {
  const quitDeps = {
    inFlightStreams: new Map<string, AbortController>(),
    streamSettled: new Map<string, Promise<void>>(),
    detachVaultKey: (): void => {},
    log: { error: (): undefined => undefined }
  }

  /** Park `performShutdown` inside its awaited sidecar-stop window (wrapped — see `parkedLock`). */
  async function parkedQuit(h: Harness): Promise<{ quitP: Promise<void> }> {
    const quitP = performShutdown(h.ctx, quitDeps)
    expect(await waitUntil(() => h.suspendEntered())).toBe(true)
    expect(h.ctrl.isUnlocked()).toBe(true) // the vault has not re-encrypted yet
    return { quitP }
  }

  // VisionService rebuilds its runtime per analyze and clears its own `tearingDown` flag in
  // `stop()`'s `finally`, so the moment quit's `vision.stop()` resolves inside the `allSettled`
  // an admitted analyze builds a FRESH ~4.6 GB llama-server — which then orphans at
  // `app.exit(0)`, holding a loopback port and GBs of RAM.
  it('refuses imageAnalyze — no fresh vision sidecar to orphan at app.exit', async () => {
    const h = await harness()
    const { quitP } = await parkedQuit(h)

    await expect(
      invoke(handlers, IPC.imageAnalyze, {
        imageBytes: validPngBytes(),
        mimeType: 'image/png',
        question: 'what is this?'
      })
    ).rejects.toThrow(/Workspace is locked\./)
    for (let i = 0; i < 20; i++) await tick()
    expect(h.createRuntime).not.toHaveBeenCalled()

    h.releaseSuspend()
    await quitP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

  // An import admitted during quit decrypts a document to a plaintext transient; `app.exit(0)`
  // landing between that write and the `finally` that shreds it strands plaintext on the drive
  // until the next launch's crash sweep.
  it('refuses importDocuments — no plaintext transient stranded by app.exit', async () => {
    const h = await harness()
    const before = (
      h.ctrl.requireDb().prepare('SELECT COUNT(*) AS n FROM documents').get() as unknown as { n: number }
    ).n
    const { quitP } = await parkedQuit(h)

    const dropped = join(h.ctx.paths.rootPath, 'dropped-on-quit.txt')
    writeFileSync(dropped, 'some text to import', 'utf8')
    await expect(invoke(handlers, IPC.importDocuments, [dropped])).rejects.toThrow(/Workspace is locked\./)
    for (let i = 0; i < 20; i++) await tick()
    const after = (
      h.ctrl.requireDb().prepare('SELECT COUNT(*) AS n FROM documents').get() as unknown as { n: number }
    ).n
    expect(after).toBe(before)

    h.releaseSuspend()
    await quitP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })
})
