import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// #301 P3b — the knowledge-pack SESSION BOUNDARY (findings H4 and M4; checks T07 and T08).
//
// Everything here runs against a REAL encrypted vault (or a real plaintext_dev controller), the
// REAL `registerZimIpc` + `registerWorkspaceIpc` handlers, a REAL `ZimService` with a real
// operation registry, and a REAL loopback HTTP server standing in for kiwix-serve's port. Only
// the two kiwix-tools CHILDREN are fakes — and they are the P3a fakes, so "the child ignored
// SIGTERM" means the same thing here as in the lifecycle suite.
//
// What the reproductions look like: "Lock now" runs a multi-second AWAITED teardown while the
// database is still OPEN. Before this phase every pack operation checked admission at the
// handler's first line and never again, so an operation that was mid-await when the user locked
// — a native file picker the OS will not cancel, a discovery pass inside a 30 s kiwix-manage
// spawn, a library rebuild, a sidecar start, a health probe, an article read in flight — came
// back seconds later and wrote to that database, or handed archive text to the renderer, after
// the workspace reported locked. Lock + unlock made it worse: `workspaceAdmitsWork` was true
// again, so the late completion wrote into a DIFFERENT session's database.
//
// Every ordering fact below is a controlled promise with an `entered`/`release` pair. No fixed
// sleep is ever the proof of an outcome; `tick`/`waitUntil` only bound "nothing else happened".

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
const dialogState = vi.hoisted(() => ({
  entered: false,
  gate: null as Promise<void> | null,
  paths: [] as string[],
  canceled: false
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    // The OS picker: it CANNOT be cancelled from the app, which is the whole point of the H4
    // reproduction — the test releases it late, exactly as a user who clicks "Open" after
    // locking would.
    showOpenDialog: async () => {
      dialogState.entered = true
      if (dialogState.gate) await dialogState.gate
      return { canceled: dialogState.canceled, filePaths: dialogState.paths }
    }
  },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => {} }
}))

import { registerZimIpc } from '../../src/main/ipc/registerZimIpc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import {
  WorkspaceController,
  createEncryptedVaultOnDisk,
  vaultPathsFrom,
  workspaceAdmitsWork,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createPlaintextOps, type PlaintextOpsRegistry } from '../../src/main/services/ingestion/plaintext-ops'
import { registeredSidecarPids, type SpawnFn } from '../../src/main/services/runtime/sidecar'
import { ZimService } from '../../src/main/services/zim'
import { zimTransientDir } from '../../src/main/services/zim/transients'
import { startKnowledgePackSession } from '../../src/main/services/zim/session'
import { performShutdown } from '../../src/main/shutdown'
import { log } from '../../src/main/services/logging'
import { t } from '../../src/shared/i18n'
import { ServeFakeChild, serveGate, type ServeChildMode } from '../helpers/zim-fakes'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** One real macrotask. Only ever a CEILING for "nothing else happened", never a proof. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

/** Drain up to `ceiling` ticks, resolving as soon as `pred` holds. Never a fixed sleep. */
async function waitUntil(pred: () => boolean, ceiling = 400): Promise<boolean> {
  for (let i = 0; i < ceiling; i++) {
    if (pred()) return true
    await tick()
  }
  return pred()
}

/**
 * Attach a no-op rejection handler NOW. Every operation parked below is rejected by the lock
 * itself (`zimOps.abortAll()` fires several awaits before the assertion is written), so without
 * this the runtime reports a perfectly expected rejection as unhandled. The promise is still
 * asserted on afterwards — a second handler observes the same rejection.
 */
function keepHandled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}

/** Assert a promise rejects with the #159 AbortError convention. */
async function expectAbortError(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error('expected an AbortError rejection, but the call resolved')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(DOMException)
  expect((err as DOMException).name).toBe('AbortError')
}

interface SessionHooks {
  /** Runs inside a fake kiwix-manage child before it appends its `<book>` and exits 0. */
  manage: (libraryXmlPath: string, zimPath: string) => Promise<void>
  findPort: () => Promise<number>
  probe: (port: number) => Promise<boolean>
  /** Runs before the loopback server answers; park it to hold an HTTP read open. */
  beforeRespond: (url: string) => Promise<void>
}

interface SessionHarness {
  root: string
  workspacePath: string
  zimDir: string
  ctrl: WorkspaceController
  ctx: AppContext
  zimOps: PlaintextOpsRegistry
  svc: ZimService
  hooks: SessionHooks
  serveSpawns: Array<{ libraryXmlPath: string; child: ServeFakeChild }>
  /** Every kiwix-manage invocation, split by what it was writing. */
  buildAdds: string[]
  metaAdds: string[]
  httpPort: number
  /** Mode applied to the NEXT spawned kiwix-serve / kiwix-manage child. */
  modes: { serve: ServeChildMode; manage: ServeChildMode }
  db(): Db
  addPackFile(leaf: string): string
  registerPack(leaf: string): Promise<string>
  transientEntries(): string[]
  packRows(): Array<{ id: string; enabled: number; updated_at: string }>
  /** Arm the gated sidecar boundary so the NEXT lock/quit parks inside its teardown. */
  armLockGate(): void
  suspendEntered(): boolean
  releaseSuspend(): void
  close(): Promise<void>
}

interface HarnessOptions {
  /**
   * `encrypted` — a real vault, unlocked (the default);
   * `encrypted-locked` — a real vault left LOCKED, so the test drives the real unlock handler;
   * `none` — no vault at all, so the test drives the real create handler;
   * `plaintext_dev` — the other workspace mode R-7 must cover (its DB is open from `init()`).
   */
  vault?: 'encrypted' | 'encrypted-locked' | 'none' | 'plaintext_dev'
  /** Fail the vault re-encrypt (the CODE-1a disk-full shape) so `lock()` throws AFTER teardown. */
  failReEncrypt?: boolean
  /** Shorten the ZIM settle bound (5 s in production) through the registry seam on ctx. */
  settleBoundMs?: number
}

async function sessionHarness(opts: HarnessOptions = {}): Promise<SessionHarness> {
  const vault = opts.vault ?? 'encrypted'
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zimsession-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  const workspacePath = join(root, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  const zimDir = join(root, 'zim')
  mkdirSync(zimDir, { recursive: true })
  const vp: VaultPaths = vaultPathsFrom({
    configPath: join(root, 'config'),
    dbPath: join(workspacePath, 'hilbertraum.sqlite')
  })

  let ctrl: WorkspaceController
  if (vault === 'plaintext_dev') {
    // The plaintext_dev half of R-7: the same transient directory, the same cleanup, a
    // controller whose DB is simply open from `init()`.
    ctrl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctrl.init()
    expect(ctrl.isUnlocked(), 'plaintext_dev workspace opens at init').toBe(true)
  } else {
    if (vault !== 'none') createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    ctrl = new WorkspaceController(
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
    if (vault === 'encrypted') ctrl.unlock('right-password')
  }
  if (ctrl.isUnlocked()) primeSettings(ctrl.requireDb())

  // ---- the loopback stand-in for kiwix-serve's port ---------------------------------
  const hooks: SessionHooks = {
    manage: async () => undefined,
    findPort: async () => httpPort,
    probe: async () => true,
    beforeRespond: async () => undefined
  }
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      try {
        await hooks.beforeRespond(url)
      } catch {
        /* a parked response released by teardown still answers */
      }
      if (url.startsWith('/search')) {
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(SEARCH_XML)
        return
      }
      if (url.startsWith('/raw/')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(ARTICLE_HTML)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const httpPort = typeof address === 'object' && address !== null ? address.port : 0
  expect(httpPort).toBeGreaterThan(0)

  // ---- the fake tools children (the P3a doubles) -----------------------------------
  const serveSpawns: Array<{ libraryXmlPath: string; child: ServeFakeChild }> = []
  const buildAdds: string[] = []
  const metaAdds: string[] = []
  let servePid = 9700
  let managePid = 7700
  const transientDir = zimTransientDir(workspacePath)

  const modes: { serve: ServeChildMode; manage: ServeChildMode } = {
    serve: 'exit-on-sigterm',
    manage: 'exit-on-sigterm'
  }

  const serveSpawn: SpawnFn = (_command, args) => {
    const child = new ServeFakeChild(servePid++, modes.serve)
    serveSpawns.push({ libraryXmlPath: args[args.indexOf('--library') + 1] as string, child })
    return child
  }
  const manageSpawn: SpawnFn = (_command, args) => {
    const libraryXmlPath = args[0] as string
    const zimPath = args[2] as string
    const child = new ServeFakeChild(managePid++, modes.manage)
    if (dirname(libraryXmlPath) === transientDir) buildAdds.push(basename(zimPath))
    else metaAdds.push(basename(zimPath))
    void (async () => {
      let failure: unknown = null
      try {
        await hooks.manage(libraryXmlPath, zimPath)
      } catch (err) {
        failure = err
      }
      await tick()
      if (child.killed) return // a killed kiwix-manage never appends anything
      if (failure) {
        child.stderr.emit('data', String(failure))
        child.emit('exit', 1, null)
        return
      }
      const stem = basename(zimPath).replace(/\.zim$/i, '')
      appendFileSync(
        libraryXmlPath,
        `<book id="uuid-${stem}" path="${zimPath.replace(/\\/g, '/')}" title="Title of ${stem}" ` +
          `description="Test archive" language="deu" date="2026-07-01" articleCount="41" mediaCount="7" />\n`
      )
      child.emit('exit', 0, null)
    })()
    return child
  }

  const zimOpsReal = createPlaintextOps()
  const bound = opts.settleBoundMs
  const zimOps: PlaintextOpsRegistry =
    bound === undefined
      ? zimOpsReal
      : { ...zimOpsReal, awaitSettled: (ms) => zimOpsReal.awaitSettled(Math.min(ms, bound)) }

  const svc = new ZimService({
    rootPath: root,
    isDev: true,
    admission: {
      admitsWork: () => workspaceAdmitsWork(ctrl),
      epoch: () => ctrl.unlockEpoch()
    },
    ops: zimOps,
    transientDir,
    deps: {
      resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
      spawn: serveSpawn,
      manageSpawn,
      findPort: () => hooks.findPort(),
      probe: (port) => hooks.probe(port),
      verifyBinary: async () => 'ok',
      healthTimeoutMs: 1_000,
      healthIntervalMs: 1,
      killGraceMs: 5,
      forceKillWaitMs: 5
    }
  })

  // The gated lock boundary: the teardown awaits this suspend, so the handler parks
  // mid-teardown with the database still open — the real multi-second window. RE-ARMABLE, so
  // one harness can be driven through several lock/unlock cycles (the T07 walk does seven).
  let suspendEntered = false
  let suspendGate: Promise<void> | null = null
  let releaseCurrent: () => void = () => undefined
  const armLockGate = (): void => {
    suspendEntered = false
    let release!: () => void
    suspendGate = new Promise<void>((r) => (release = r))
    releaseCurrent = () => {
      suspendGate = null
      release()
    }
  }
  const releaseSuspend = (): void => releaseCurrent()

  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: root, configPath: join(root, 'config'), workspacePath, dbPath: vp.dbPath },
    get db() {
      return ctrl.requireDb()
    },
    workspace: ctrl,
    runtime: {
      stop: async () => {},
      shutdown: () => {},
      isShutdown: () => false,
      activeModelId: () => null,
      active: () => null,
      status: () => ({ running: false, modelId: null, backend: null })
    },
    embedder: {
      id: 'mock-embedder',
      dimensions: 4,
      embed: async () => [],
      suspend: (): Promise<void> => {
        suspendEntered = true
        return suspendGate ?? Promise.resolve()
      },
      // QUIT stops the embedder where LOCK suspends it — gate both on the same handle so
      // `performShutdown` parks in exactly the same window.
      stop: (): Promise<void> => {
        suspendEntered = true
        return suspendGate ?? Promise.resolve()
      }
    },
    manifestsDir: null,
    isDev: true,
    zim: svc,
    zimOps
  } as unknown as AppContext

  registerZimIpc(ctx)
  registerWorkspaceIpc(ctx)

  const full: SessionHarness = {
    root,
    workspacePath,
    zimDir,
    ctrl,
    ctx,
    zimOps,
    svc,
    hooks,
    serveSpawns,
    buildAdds,
    metaAdds,
    httpPort,
    modes,
    db: () => ctrl.requireDb(),
    addPackFile: (leaf) => {
      const p = join(zimDir, leaf)
      writeFileSync(p, 'ZIM')
      return p
    },
    registerPack: async (leaf) => {
      const p = full.addPackFile(leaf)
      const pack = await svc.registerPack(ctrl.requireDb(), p)
      return pack.id
    },
    transientEntries: () => {
      try {
        return readdirSync(transientDir).sort()
      } catch {
        return []
      }
    },
    packRows: () =>
      ctrl
        .requireDb()
        .prepare('SELECT id, enabled, updated_at FROM knowledge_packs ORDER BY id')
        .all() as unknown as Array<{ id: string; enabled: number; updated_at: string }>,
    armLockGate,
    suspendEntered: () => suspendEntered,
    releaseSuspend,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  return full
}

/** Settings that keep the post-unlock seams cheap: already benchmarked, no auto-start. */
function primeSettings(db: Db): void {
  seedSettings(db)
  const now = new Date().toISOString()
  const put = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  )
  put.run('lastBenchmark', JSON.stringify({ tokensPerSecond: 10 }), now)
  put.run('autoStartActiveModel', 'false', now)
}

const SEARCH_XML =
  '<?xml version="1.0" encoding="UTF-8"?><rss><channel>' +
  '<item><title>Alpha and the climate</title><link>/content/alpha/A/Alpha</link>' +
  '<wordCount>240</wordCount></item></channel></rss>'

const ARTICLE_HTML =
  '<html><body><h1>Alpha and the climate</h1><p>' +
  'Alpha is a test archive article about the climate. '.repeat(40) +
  '</p></body></html>'

/**
 * Park the lock handler inside its awaited teardown and assert the database is still open
 * there. Returned WRAPPED — an `async` function returning it bare would adopt (await) the very
 * promise this helper must not wait on.
 */
async function parkedLock(h: SessionHarness): Promise<{ lockP: Promise<{ result: unknown }> }> {
  h.armLockGate()
  const lockP = invoke(handlers, IPC.lockWorkspace)
  expect(await waitUntil(() => h.suspendEntered())).toBe(true)
  // THE window: the teardown is running, the vault has NOT re-encrypted, `isUnlocked()` is true
  // — and `zimOps.abortAll()` has already fired (it precedes the sidecar block).
  expect(h.ctrl.isUnlocked()).toBe(true)
  return { lockP }
}

beforeEach(() => {
  ipcState.handlers.clear()
  dialogState.entered = false
  dialogState.gate = null
  dialogState.paths = []
  dialogState.canceled = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('knowledge packs across the session boundary (#301 P3b, H4/M4)', () => {
  it('T07 lock during picker / discovery / registration / rebuild / start / probe / HTTP read (real vault harness): no post-lock DB write or content response, late picker result rejected, children and transients handled before lock completes, fresh session works', async () => {
    const h = await sessionHarness()
    try {
      const alpha = await h.registerPack('alpha.zim')
      const rowsAtStart = h.packRows()
      expect(rowsAtStart).toHaveLength(1)

      // ---- (1) PICKER: the OS dialog resolves AFTER the lock armed ---------------------
      {
        const picked = h.addPackFile('picked-during-lock.zim')
        dialogState.paths = [picked]
        let releaseDialog!: () => void
        dialogState.gate = new Promise<void>((r) => (releaseDialog = r))
        const addP = keepHandled(invoke(handlers, IPC.addKnowledgePacks))
        expect(await waitUntil(() => dialogState.entered)).toBe(true)

        const { lockP } = await parkedLock(h)
        const rowsInLock = h.packRows()
        const metaAddsInLock = h.metaAdds.length
        releaseDialog()
        // The friendly locked copy — not a raw abort, not a silent success.
        await expect(addP).rejects.toThrow(t('en', 'main.docs.locked'))
        for (let i = 0; i < 10; i++) await tick()
        // Nothing was registered: the row set is byte-for-byte what it was, INCLUDING
        // `updated_at` (an UPSERT that only touched timestamps would show here).
        expect(h.packRows()).toEqual(rowsInLock)
        expect(h.metaAdds).toHaveLength(metaAddsInLock) // the manager was never even spawned

        h.releaseSuspend()
        await lockP
        expect(h.ctrl.isUnlocked()).toBe(false)
        // The lock did not report success with plaintext left behind.
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
        expect(h.packRows()).toEqual(rowsAtStart) // …and not after the unlock either
      }

      // ---- (2) DISCOVERY: a lock lands inside a parked kiwix-manage spawn --------------
      {
        h.addPackFile('discovered-during-lock.zim')
        const manageGate = serveGate<void>()
        h.hooks.manage = () => manageGate.wait()
        const discP = keepHandled(h.svc.discoverDrivePacks(h.db()))
        await manageGate.entered
        const { lockP } = await parkedLock(h)
        const rowsInLock = h.packRows()
        h.hooks.manage = async () => undefined
        manageGate.release()

        await expectAbortError(discP)
        expect(h.packRows()).toEqual(rowsInLock)

        h.releaseSuspend()
        await lockP
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
        expect(h.packRows()).toEqual(rowsAtStart)
      }

      // ---- (3) REGISTRATION: the picker returned in time, the manager did not ----------
      {
        dialogState.gate = null
        dialogState.paths = [h.addPackFile('registered-during-lock.zim')]
        const manageGate = serveGate<void>()
        h.hooks.manage = () => manageGate.wait()
        const addP = keepHandled(invoke(handlers, IPC.addKnowledgePacks))
        await manageGate.entered
        const { lockP } = await parkedLock(h)
        const rowsInLock = h.packRows()
        h.hooks.manage = async () => undefined
        manageGate.release()

        await expect(addP).rejects.toThrow(t('en', 'main.docs.locked'))
        expect(h.packRows()).toEqual(rowsInLock)

        h.releaseSuspend()
        await lockP
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
        expect(h.packRows()).toEqual(rowsAtStart)
      }

      // ---- (4) REBUILD: the ask's library build is parked mid-write --------------------
      {
        const arm = h.svc.makeArm(h.db(), [alpha])
        expect(arm).not.toBeNull()
        const manageGate = serveGate<void>()
        h.hooks.manage = () => manageGate.wait()
        const askP = keepHandled(arm!('alpha climate', new AbortController().signal))
        await manageGate.entered
        const { lockP } = await parkedLock(h)
        h.hooks.manage = async () => undefined
        manageGate.release()

        await expectAbortError(askP)
        expect(h.serveSpawns).toHaveLength(0) // nothing was ever launched for that build

        h.releaseSuspend()
        await lockP
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
      }

      // ---- (5) START: the port allocation is parked when the lock lands ----------------
      {
        const arm = h.svc.makeArm(h.db(), [alpha])
        const portGate = serveGate<number>()
        h.hooks.findPort = () => portGate.wait()
        const askP = keepHandled(arm!('alpha climate', new AbortController().signal))
        await portGate.entered
        const { lockP } = await parkedLock(h)
        h.hooks.findPort = async () => h.httpPort
        portGate.release(h.httpPort)

        await expectAbortError(askP)
        expect(h.serveSpawns).toHaveLength(0) // the abandoned build never reached a spawn
        expect(h.svc.serverState()).toBeNull()

        h.releaseSuspend()
        await lockP
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
      }

      // ---- (6) PROBE: the health probe succeeds only AFTER the lock --------------------
      {
        const arm = h.svc.makeArm(h.db(), [alpha])
        const probeGate = serveGate<boolean>()
        h.hooks.probe = () => probeGate.wait()
        const askP = keepHandled(arm!('alpha climate', new AbortController().signal))
        await probeGate.entered
        expect(h.serveSpawns).toHaveLength(1) // a child IS running now
        const probedChild = h.serveSpawns[0]!.child
        const { lockP } = await parkedLock(h)
        h.hooks.probe = async () => true
        probeGate.release(true) // the probe says "healthy" — after the teardown began

        await expectAbortError(askP)
        expect(h.svc.serverState()).toBeNull() // nothing was published

        h.releaseSuspend()
        await lockP
        // The child was killed as part of the lock, and its build file is gone.
        expect(probedChild.killCalls.length).toBeGreaterThan(0)
        expect(registeredSidecarPids('kiwix_tools')).not.toContain(probedChild.pid)
        expect(h.transientEntries()).toEqual([])
        h.ctrl.unlock('right-password')
      }

      // ---- (7) HTTP READ: the article body is in flight when the lock lands ------------
      {
        // Warm the sidecar first, so the read really is an HTTP read and not a start.
        const port = await h.svc.ensureServer(h.db())
        expect(port).toBe(h.httpPort)
        const servedChild = h.serveSpawns[h.serveSpawns.length - 1]!.child
        const httpGate = serveGate<void>()
        h.hooks.beforeRespond = (url) => (url.startsWith('/raw/') ? httpGate.wait() : Promise.resolve())
        const readP = keepHandled(invoke(handlers, IPC.getPackArticle, alpha, 'A/Alpha'))
        await httpGate.entered
        const { lockP } = await parkedLock(h)
        h.hooks.beforeRespond = async () => undefined
        httpGate.release()

        // NEVER content: the viewer gets the honest "unavailable" null, never sections read
        // out of an archive after the workspace locked.
        const { result } = await readP
        expect(result).toBeNull()

        h.releaseSuspend()
        await lockP
        expect(servedChild.killCalls.length).toBeGreaterThan(0)
        expect(h.transientEntries()).toEqual([])
      }

      // ---- every child of every leg was killed, and a FRESH session serves again -------
      expect(h.serveSpawns.every((s) => s.child.killCalls.length > 0)).toBe(true)
      const generationsBefore = h.serveSpawns.length
      h.ctrl.unlock('right-password')
      const arm = h.svc.makeArm(h.db(), [alpha])
      const candidates = await arm!('alpha climate', new AbortController().signal)
      expect(h.serveSpawns.length).toBe(generationsBefore + 1) // a NEW child, new generation
      expect(h.svc.serverState()).toMatchObject({ port: h.httpPort, alive: true })
      expect(candidates.length).toBeGreaterThan(0) // and it really answered with article text
      expect(h.packRows()).toEqual(rowsAtStart) // no leg ever wrote a row
    } finally {
      await h.close()
    }
  })

  it('T08 failed lock encryption then new work, create / unlock / plaintext-dev startup reconciliation, quit during start: recovery admits new work without resurrecting cancelled work and quit stays terminal', async () => {
    // ---- (a) a FAILED lock admits new work but never revives the cancelled work --------
    {
      // The parked picker is still live at the lock's ZIM settle, which is the point — the
      // bound is shortened through the registry seam so this case does not sit out the real 5 s
      // constant (the constant itself is untouched).
      const h = await sessionHarness({ failReEncrypt: true, settleBoundMs: 50 })
      try {
        const alpha = await h.registerPack('alpha.zim')
        const rowsBefore = h.packRows()

        // A picker parked BEFORE the lock: the OS dialog cannot be cancelled.
        dialogState.paths = [h.addPackFile('picked-before-failed-lock.zim')]
        let releaseDialog!: () => void
        dialogState.gate = new Promise<void>((r) => (releaseDialog = r))
        const stalePickerP = keepHandled(invoke(handlers, IPC.addKnowledgePacks))
        expect(await waitUntil(() => dialogState.entered)).toBe(true)

        // The lock runs its whole teardown and then fails at the re-encrypt (ENOSPC).
        await expect(invoke(handlers, IPC.lockWorkspace)).rejects.toThrow(
          t('en', 'main.workspace.lockFailed')
        )
        expect(h.ctrl.isUnlocked()).toBe(true)
        expect(h.ctrl.isLocking()).toBe(false)
        const epochAfterFailure = h.ctrl.unlockEpoch()

        // The OLD picker resolves now. Admission is restored and the epoch never moved, so
        // ONLY the aborted operation signal can refuse it — which is exactly why the picker
        // wait is an operation and not an epoch ticket.
        releaseDialog()
        await expect(stalePickerP).rejects.toThrow(t('en', 'main.docs.locked'))
        expect(h.packRows()).toEqual(rowsBefore)

        // NEW work is admitted at once — nothing latched.
        dialogState.gate = null
        dialogState.paths = [h.addPackFile('added-after-failed-lock.zim')]
        const { result } = await invoke(handlers, IPC.addKnowledgePacks)
        expect(Array.isArray(result) && result.length).toBe(1)
        expect(h.packRows()).toHaveLength(2)

        // …and a new ask restarts the suspended sidecar (a cold start, no latch).
        const arm = h.svc.makeArm(h.db(), [alpha])
        const candidates = await arm!('alpha climate', new AbortController().signal)
        expect(candidates.length).toBeGreaterThan(0)
        expect(h.svc.serverState()).toMatchObject({ alive: true })
        expect(h.ctrl.unlockEpoch()).toBe(epochAfterFailure) // no new session was started
      } finally {
        await h.close()
      }
    }

    // ---- (b) UNLOCK runs exactly ONE session pass, and only after the handler resolved --
    {
      const h = await sessionHarness({ vault: 'encrypted-locked' })
      try {
        // A pack file is already on the drive: the session pass is what discovers it.
        h.addPackFile('on-the-drive.zim')
        const pass = vi.spyOn(h.svc, 'discoverDrivePacks')

        const unlockP = invoke(handlers, IPC.unlockWorkspace, 'right-password')
        // Nothing runs while the unlock invoke is still pending — D3's "never on the critical
        // path" is the claim, and this is the assertion that would catch a synchronous call.
        expect(pass).not.toHaveBeenCalled()
        const { result } = await unlockP
        expect(result).toMatchObject({ ok: true })
        expect(pass).not.toHaveBeenCalled()

        expect(await waitUntil(() => pass.mock.calls.length > 0)).toBe(true)
        expect(await waitUntil(() => h.metaAdds.length > 0)).toBe(true)
        for (let i = 0; i < 30; i++) await tick()
        expect(pass).toHaveBeenCalledTimes(1) // exactly ONE pass per session
        expect(h.metaAdds).toEqual(['on-the-drive.zim'])
        expect(h.packRows()).toHaveLength(1)
      } finally {
        await h.close()
      }
    }

    // ---- (c) CREATE runs the same single pass, after its own promise resolved ----------
    {
      const h = await sessionHarness({ vault: 'none' })
      try {
        h.addPackFile('on-a-brand-new-drive.zim')
        const pass = vi.spyOn(h.svc, 'discoverDrivePacks')

        const createP = invoke(handlers, IPC.createWorkspace, 'a-good-password', 'encrypted')
        expect(pass).not.toHaveBeenCalled()
        const { result } = await createP
        expect(result).toMatchObject({ ok: true })
        expect(pass).not.toHaveBeenCalled() // never on the create's critical path either

        expect(await waitUntil(() => h.metaAdds.length > 0)).toBe(true)
        for (let i = 0; i < 30; i++) await tick()
        expect(pass).toHaveBeenCalledTimes(1)
        expect(h.packRows()).toHaveLength(1)
      } finally {
        await h.close()
      }
    }

    // ---- (d) PLAINTEXT-DEV STARTUP: the third seam, the same single pass ---------------
    {
      const h = await sessionHarness({ vault: 'plaintext_dev' })
      try {
        // A plaintext_dev workspace is already open at startup, so `main/index.ts` calls the
        // seam directly after `maybeStartLocalApi`. That call is what this drives (the module
        // itself needs Electron, so it cannot be driven end to end here).
        h.addPackFile('startup-drive-pack.zim')
        const pass = vi.spyOn(h.svc, 'discoverDrivePacks')
        startKnowledgePackSession(h.ctx)
        expect(pass).not.toHaveBeenCalled() // scheduled, never inline

        expect(await waitUntil(() => h.metaAdds.length > 0)).toBe(true)
        for (let i = 0; i < 30; i++) await tick()
        expect(pass).toHaveBeenCalledTimes(1)
        expect(h.packRows()).toHaveLength(1)

        // A session that is no longer admitted does nothing at all when its timer fires.
        h.ctrl.beginLock()
        const second = vi.spyOn(h.svc, 'discoverDrivePacks')
        startKnowledgePackSession(h.ctx)
        for (let i = 0; i < 30; i++) await tick()
        expect(second).not.toHaveBeenCalled()
        h.ctrl.cancelLock()
      } finally {
        await h.close()
      }
    }

    // ---- (e) QUIT during a parked start is TERMINAL ------------------------------------
    {
      const h = await sessionHarness()
      try {
        const alpha = await h.registerPack('alpha.zim')
        const db = h.db() // captured while open: quit closes the workspace below
        const arm = h.svc.makeArm(h.db(), [alpha])
        const probeGate = serveGate<boolean>()
        h.hooks.probe = () => probeGate.wait()
        const askP = keepHandled(arm!('alpha climate', new AbortController().signal))
        await probeGate.entered
        const startedChild = h.serveSpawns[0]!.child

        h.armLockGate()
        const quitP = performShutdown(h.ctx, {
          inFlightStreams: new Map(),
          streamSettled: new Map(),
          detachVaultKey: () => {},
          log: { error: () => undefined, info: () => undefined }
        })
        expect(await waitUntil(() => h.suspendEntered())).toBe(true)
        h.hooks.probe = async () => true
        probeGate.release(true) // the probe succeeds — after the quit began

        await expectAbortError(askP)
        h.releaseSuspend()
        await quitP

        expect(startedChild.killCalls.length).toBeGreaterThan(0)
        expect(h.transientEntries()).toEqual([])
        // Terminal: a later ask cannot resurrect the child as an orphan. `stop()`'s latch is
        // checked before anything touches the database, so the captured handle is enough.
        const spawnsAtQuit = h.serveSpawns.length
        await expectAbortError(h.svc.ensureServer(db))
        expect(h.serveSpawns).toHaveLength(spawnsAtQuit)
      } finally {
        await h.close()
      }
    }
  })

  it('a manager child that cannot be confirmed dead keeps its meta dir: the lock reports kept, NOT confirmed, and the PID stays reapable', async () => {
    const h = await sessionHarness()
    const warn = vi.spyOn(log, 'warn')
    try {
      // A kiwix-manage child that ignores SIGTERM *and* SIGKILL: `kiwixManageAdd` escalates,
      // waits its bound and settles `uncertain`. Its throwaway meta dir may still be written,
      // so it must survive the lock — reported, never silently called clean.
      h.modes.manage = 'ignore-all'
      const manageGate = serveGate<void>()
      h.hooks.manage = () => manageGate.wait()
      const addP = keepHandled(h.svc.registerPack(h.db(), h.addPackFile('stubborn.zim')))
      await manageGate.entered
      const stubbornPid = registeredSidecarPids('kiwix_tools').slice(-1)[0]
      expect(typeof stubbornPid).toBe('number')

      const { lockP } = await parkedLock(h)
      manageGate.release()
      await expect(addP).rejects.toThrow()

      h.releaseSuspend()
      await lockP

      // The meta dir is still there and the lock said so.
      const left = h.transientEntries()
      expect(left.filter((e) => /^meta-\d+$/.test(e))).toHaveLength(1)
      expect(registeredSidecarPids('kiwix_tools')).toContain(stubbornPid)
      const notConfirmed = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0] === 'Lock: ZIM cleanup NOT confirmed'
      )
      expect(notConfirmed).toHaveLength(1)
      expect(notConfirmed[0]?.[1]).toMatchObject({ kept: 1 })
      // The sentinel rule: counts only — no pack title, no path.
      expect(JSON.stringify(notConfirmed[0])).not.toContain('stubborn')
      expect(JSON.stringify(notConfirmed[0])).not.toContain(h.workspacePath)

      // The NEXT session start removes what the lock deliberately kept.
      h.ctrl.unlock('right-password')
      const report = h.svc.cleanupTransients('session-start')
      expect(report).toMatchObject({ removed: 0, kept: 1 })
    } finally {
      warn.mockRestore()
      await h.close()
    }
  })

  it('an operation still live at the settle bound has its tracked transient shredded under it, and the lock reports NOT confirmed', async () => {
    const h = await sessionHarness({ settleBoundMs: 25 })
    const warn = vi.spyOn(log, 'warn')
    try {
      // An operation that never releases — the shape of a step that cannot cancel. It tracks a
      // build file exactly as the service does before writing one.
      mkdirSync(zimTransientDir(h.workspacePath), { recursive: true })
      const stranded = join(zimTransientDir(h.workspacePath), 'library.99.xml')
      writeFileSync(stranded, '<library><book title="Private archive" /></library>')
      const op = h.zimOps.register('zim-reconcile')
      op.track(stranded)

      const { lockP } = await parkedLock(h)
      h.releaseSuspend()
      await lockP

      // Shredded under the operation at the bound (the #237 posture), and reported honestly.
      expect(existsSync(stranded)).toBe(false)
      expect(h.transientEntries()).toEqual([])
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages).toContain('Lock: knowledge-pack operations still running at the settle bound — sweeping')
      expect(messages).toContain('Lock: ZIM cleanup NOT confirmed')
      op.release()
    } finally {
      warn.mockRestore()
      await h.close()
    }
  })
})
