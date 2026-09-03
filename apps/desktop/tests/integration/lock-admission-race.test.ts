import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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
import type { OcrEngine } from '../../src/main/services/ocr'
import { createQueuedDocument, documentsDir, processDocument } from '../../src/main/services/ingestion'
import { createPlaintextOps } from '../../src/main/services/ingestion/plaintext-ops'
import { performShutdown } from '../../src/main/shutdown'
import { t } from '../../src/shared/i18n'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/**
 * One real macrotask (≥ 1 ms). Used only as a bounded CEILING for "nothing else happened".
 * A `setImmediate` loop would starve the libuv poll phase where fs callbacks land, so a helper
 * waiting on real file I/O (the async decrypt of a preview) would never see it progress (#258).
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

/** Drain up to `ceiling` ticks, resolving as soon as `pred` holds. Never a fixed sleep. */
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
  /** The imported photo (an encrypted stored copy) when an `ocrEngine` was supplied. */
  photoId: string | null
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
  /**
   * An OCR engine for the photo the harness then also imports — the park seam for the
   * plaintext-operation cases (#237): a photo preview re-recognizes its decrypted stored copy,
   * so a gated `recognize()` parks the preview with its `.parse-preview-*` transient on disk.
   */
  ocrEngine?: OcrEngine
  /**
   * Shorten the lock/quit plaintext-operation settle bound (5 s in production) through the
   * registry seam on ctx, so the sweep-bounded cases do not wait out the real constant.
   */
  settleBoundMs?: number
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

  // The photo for the plaintext-operation cases: imported (and OCR'd once, unparked) so its
  // stored copy is an `.enc` whose preview must decrypt to a transient. `images/` exists so the
  // name sweeps below can read it.
  mkdirSync(join(workspacePath, 'images'), { recursive: true })
  let photoId: string | null = null
  if (opts.ocrEngine) {
    const photoPath = join(root, 'photo.png')
    writeFileSync(photoPath, validPngBytes())
    const photo = createQueuedDocument(ctrl.requireDb(), photoPath)
    const indexed = await processDocument(ctrl.requireDb(), storeDir, photo.id, {
      embedder: fakeEmbedder,
      cipher: ctrl.documentCipher(),
      ocrEngine: opts.ocrEngine
    })
    expect(indexed.status).toBe('indexed')
    photoId = photo.id
  }

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
    trustedSenders: ANY_SENDER,
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
    ocrEngine: opts.ocrEngine ?? null,
    manifestsDir: null,
    isDev: false
  } as unknown as AppContext

  // The plaintext-operation registry (#237), as `main/index.ts` wires it; optionally with the
  // settle bound shortened through the seam (the constant itself stays the production value).
  const ops = createPlaintextOps()
  const bound = opts.settleBoundMs
  ctx.plaintextOps =
    bound === undefined ? ops : { ...ops, awaitSettled: (ms) => ops.awaitSettled(Math.min(ms, bound)) }

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
    photoId,
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
  it('stops the local API BEFORE the sidecar suspends (local-api D7 — the lock-path ordering pin)', async () => {
    // The quit-path twin lives in shutdown.test.ts; without THIS pin a runLockTeardown
    // reorder could let an external stream hold the model while the vault re-encrypts.
    const h = await harness()
    const stop = vi.fn(async () => {
      // The API must die before the teardown reaches the gated sidecar block.
      expect(h.suspendEntered()).toBe(false)
    })
    ;(h.ctx as { localApi?: { stop: () => Promise<void> } }).localApi = { stop }
    const { lockP } = await parkedLock(h)
    expect(stop).toHaveBeenCalledTimes(1)
    h.releaseSuspend()
    await lockP
    expect(h.ctrl.isUnlocked()).toBe(false)
  })

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
      trustedSenders: ANY_SENDER,
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
    log: { error: (): undefined => undefined, info: (): undefined => undefined }
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

// ---- #237 — plaintext operations already IN FLIGHT at lock/quit ------------------
//
// A preview of an encrypted stored copy decrypts it to a `.parse-preview-<uuid><ext>` transient
// and shreds it only in its own `finally`. Lock and quit awaited chat streams, doc tasks and the
// sidecar stops but held no handle on that work: they reported `locked` / resolved (with
// `app.exit(0)` next) while the parse was still running and the decrypted file sat on the drive,
// and the preview then delivered its text across IPC after the lock. Now every such operation
// registers with `ctx.plaintextOps`; lock and quit abort the registry, await its settle within
// the task-settle bound, and shred whatever is still registered before the vault re-encrypts.
//
// The parked document is a photo with a gated OCR engine — there is no parser-injection seam for
// pdf/docx. Two engine flavours: one that honours the abort signal (the photo and audio parsers
// forward it) and one that ignores it, modelling pdfjs/mammoth. For the latter the transient is
// shredded under the parser at the settle bound (sweep-bounded) and the preview handler's
// admission re-check refuses the text afterwards. The real tesseract `suspend()` would also
// terminate its worker mid-recognition; the fake's no-op `suspend()`/`stop()` remove that partial
// mitigation so the photo stands in for the parsers that have none.
//
// Does not prove: that quit residue survives a real process exit (asserted at `performShutdown`
// resolution, the instant `app.exit(0)` would run), nor pdf/docx parses themselves.

interface GatedOcrEngine extends OcrEngine {
  /** Park the NEXT recognition until `release()` (or its abort signal, when honoured). */
  parkNext(): void
  release(): void
  entered(): boolean
  abortSeen(): boolean
}

function gatedOcrEngine(opts: { honoursSignal: boolean }): GatedOcrEngine {
  let park = false
  let entered = false
  let abortSeen = false
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  return {
    id: 'gated-ocr',
    languages: ['eng'],
    recognize: async (_image, o) => {
      if (!park) return { text: 'SECRET PLAINTEXT', confidence: 90 }
      park = false
      entered = true
      if (opts.honoursSignal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            abortSeen = true
            reject(new Error('recognition aborted'))
          }
          if (o?.signal?.aborted) {
            onAbort()
            return
          }
          o?.signal?.addEventListener('abort', onAbort, { once: true })
          void gate.then(() => {
            o?.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      } else {
        o?.signal?.addEventListener(
          'abort',
          () => {
            abortSeen = true
          },
          { once: true }
        )
        await gate
      }
      return { text: 'SECRET PLAINTEXT', confidence: 90 }
    },
    suspend: async () => {},
    stop: async () => {},
    parkNext: () => {
      park = true
    },
    release: () => release(),
    entered: () => entered,
    abortSeen: () => abortSeen
  }
}

/** Every decrypted-transient name under `dir` — the same patterns the startup crash sweep uses. */
function transientNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.includes('.parse') || n.endsWith('.tmp'))
    .sort()
}

/** The encrypted stored copies under `dir` — what the sweep must never touch. */
function storedCopies(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.enc'))
    .sort()
}

/** Park a preview of the harness photo on the gated engine, transient on disk. */
async function parkedPreview(
  h: Harness,
  ocr: GatedOcrEngine
): Promise<{ previewP: Promise<{ result: unknown }>; docs: string; images: string }> {
  const docs = documentsDir(h.ctx.paths.workspacePath)
  const images = join(h.ctx.paths.workspacePath, 'images')
  ocr.parkNext()
  const previewP = invoke(handlers, IPC.previewDocument, h.photoId)
  previewP.catch(() => undefined) // asserted later; never an unhandled rejection meanwhile
  // A real async decrypt + row read precede the park — a generous ceiling for a starved runner.
  expect(await waitUntil(() => ocr.entered(), 1_000)).toBe(true)
  const during = transientNames(docs)
  expect(during).toHaveLength(1)
  expect(during[0]).toMatch(/\.parse-preview-/)
  return { previewP, docs, images }
}

describe('plaintext operations across the lock boundary (#237)', () => {
  it('lock aborts a parked preview, waits for it to unwind, and reports locked with no transient on the drive', async () => {
    const ocr = gatedOcrEngine({ honoursSignal: true })
    const h = await harness({ ocrEngine: ocr })
    h.releaseSuspend() // the sidecar gate is not the subject here
    const { previewP, docs, images } = await parkedPreview(h, ocr)
    const storedBefore = storedCopies(docs)
    expect(storedBefore).toHaveLength(2) // the text document + the photo

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(h.ctrl.isUnlocked()).toBe(false)
    // At the instant lock reported locked: nothing decrypted is left under documents/ or images/
    // (a name sweep, not the registry's view of itself).
    expect(transientNames(docs)).toEqual([])
    expect(transientNames(images)).toEqual([])
    // …and the stored copies beside the transient were never touched.
    expect(storedCopies(docs)).toEqual(storedBefore)
    // The abort reached the parser — nothing had to release it.
    expect(ocr.abortSeen()).toBe(true)
    // The preview REJECTS with the locked copy; it never delivers text after the lock.
    await expect(previewP).rejects.toThrow(t('en', 'main.docs.locked'))
  })

  it('lock waits for a parser that ignores the abort until it unwinds — the settle, not merely the bound', async () => {
    const ocr = gatedOcrEngine({ honoursSignal: false })
    // The production bound (5 s) — the release below must be what lets the lock through.
    const h = await harness({ ocrEngine: ocr })
    h.releaseSuspend()
    const { previewP, docs } = await parkedPreview(h, ocr)

    let lockSettled = false
    const t0 = Date.now()
    const lockP = invoke(handlers, IPC.lockWorkspace).finally(() => {
      lockSettled = true
    })
    lockP.catch(() => undefined)
    // Parser parked, bound not elapsed: the lock is WAITING and the vault is still open.
    for (let i = 0; i < 50; i++) await tick()
    expect(lockSettled).toBe(false)
    expect(h.ctrl.isUnlocked()).toBe(true)
    expect(ocr.abortSeen()).toBe(true) // it was asked to stop; it just cannot

    ocr.release()
    const { result } = await lockP
    expect(result).toMatchObject({ state: 'locked' })
    // Well inside the 5 s `LOCK_TASK_SETTLE_TIMEOUT_MS`: the release let it through, not the bound.
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(transientNames(docs)).toEqual([])
    // The parser finished with text in hand — the handler's admission re-check refuses it.
    await expect(previewP).rejects.toThrow(t('en', 'main.docs.locked'))
  })

  it('a parser that ignores the abort is sweep-bounded: locked at the bound, its transient shredded under it', async () => {
    const ocr = gatedOcrEngine({ honoursSignal: false })
    const h = await harness({ ocrEngine: ocr, settleBoundMs: 100 })
    h.releaseSuspend()
    const { previewP, docs, images } = await parkedPreview(h, ocr)
    const storedBefore = storedCopies(docs)

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(h.ctrl.isUnlocked()).toBe(false)
    expect(transientNames(docs)).toEqual([])
    expect(transientNames(images)).toEqual([])
    expect(storedCopies(docs)).toEqual(storedBefore)

    // Nothing released the parser: the lock went on at the bound. Let it finish now.
    ocr.release()
    await expect(previewP).rejects.toThrow(t('en', 'main.docs.locked'))
    expect(transientNames(docs)).toEqual([]) // its own finally found nothing left to shred
  })
})

describe('plaintext operations across the QUIT boundary (#237)', () => {
  const quitDeps = {
    inFlightStreams: new Map<string, AbortController>(),
    streamSettled: new Map<string, Promise<void>>(),
    detachVaultKey: (): void => {},
    log: { error: (): undefined => undefined, info: (): undefined => undefined }
  }

  it('performShutdown resolves only after the parked preview unwound — no transient left for app.exit', async () => {
    const ocr = gatedOcrEngine({ honoursSignal: true })
    const h = await harness({ ocrEngine: ocr })
    h.releaseSuspend()
    const { previewP, docs, images } = await parkedPreview(h, ocr)
    const storedBefore = storedCopies(docs)

    await performShutdown(h.ctx, quitDeps)
    // The instant `app.exit(0)` would run:
    expect(h.ctrl.isUnlocked()).toBe(false)
    expect(transientNames(docs)).toEqual([])
    expect(transientNames(images)).toEqual([])
    expect(storedCopies(docs)).toEqual(storedBefore)
    expect(ocr.abortSeen()).toBe(true)
    await expect(previewP).rejects.toThrow(t('en', 'main.docs.locked'))
  })

  it('a parser that ignores the abort is sweep-bounded on quit too', async () => {
    const ocr = gatedOcrEngine({ honoursSignal: false })
    const h = await harness({ ocrEngine: ocr, settleBoundMs: 100 })
    h.releaseSuspend()
    const { previewP, docs, images } = await parkedPreview(h, ocr)
    const storedBefore = storedCopies(docs)

    await performShutdown(h.ctx, quitDeps)
    expect(h.ctrl.isUnlocked()).toBe(false)
    expect(transientNames(docs)).toEqual([])
    expect(transientNames(images)).toEqual([])
    expect(storedCopies(docs)).toEqual(storedBefore)

    ocr.release()
    await expect(previewP).rejects.toThrow(t('en', 'main.docs.locked'))
    // The reproduction's post-quit self-heal check, carried: the parser's own shred finds nothing.
    expect(await waitUntil(() => transientNames(docs).length === 0, 300)).toBe(true)
  })
})
