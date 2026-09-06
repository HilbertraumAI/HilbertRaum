import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

import { randomUUID } from 'node:crypto'
import {
  appendMessage,
  createConversation,
  deleteLastAssistantMessage,
  exportTranscript,
  listMessages,
  restoreMessage,
  setScope
} from '../../src/main/services/chat'
import { resolveScope } from '../../src/main/services/collections'
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { ModelRuntime } from '../../src/main/services/runtime'
import {
  generateGroundedAnswer,
  ragSettingsFrom,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import type { KnowledgePackOutcome, Message } from '../../src/shared/types'
import { registerZimIpc } from '../../src/main/ipc/registerZimIpc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { KnowledgePackAddResult, PrivacyPolicy } from '../../src/shared/types'
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
import { ZimService, type ServedLibrary, type ZimPacksChangedNotice } from '../../src/main/services/zim'
import { readZimHeader, servingNameFor } from '../../src/main/services/zim/identity'
import { encodeArticlePath } from '../../src/main/services/zim/client'
import { packUuid, writeZimFixture } from '../helpers/zim-header'
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

/** Per-service seam overrides a test can hand `newService` (#301 P4, T16-a needs a service whose
 *  kiwix-tools bundle is ABSENT, so the arm reports `tools-missing` without waking a sidecar). */
interface ServiceOverrides {
  resolveTools?: () => { serve: string; manage: string } | null
}

interface SessionHooks {
  /** Runs inside a fake kiwix-manage child before it appends its `<book>` and exits 0. */
  manage: (libraryXmlPath: string, zimPath: string) => Promise<void>
  findPort: () => Promise<number>
  probe: (port: number) => Promise<boolean>
  /** Runs before the loopback server answers; park it to hold an HTTP read open. */
  beforeRespond: (url: string) => Promise<void>
  /** Decide the whole response for this URL (T12), or null for the default fixtures.
   *  `headers` carries a redirect's `Location` (#301 P7 T19); it defaults to none. */
  respond: (url: string) => {
    status: number
    headers?: Record<string, string>
    body: string
  } | null
  /**
   * Cut ONE response short (#301 P7 T19), the measured kiwix-serve 3.8.1 fault: a 200 with an
   * HONEST `Content-Length`, then `partial` bytes and a connection that simply hangs — the rest
   * never arrives. Null answers normally. Runs after `beforeRespond`, before `respond`.
   */
  truncate: (url: string) => { partial: string; total: number } | null
  /**
   * The per-ATTEMPT `/raw` timeout of the stall retry (`ARTICLE_READ_TIMEOUT_MS`, #301 P7 T19).
   * A hook rather than a fixed dep so ONE leg can shrink it: every other article read in this
   * file keeps the shipped 4 s, T07's parked-read-under-lock leg included.
   */
  articleTimeoutMs?: number
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
  /** Every URL the loopback server was asked for, in order (T12 route assertions). */
  requests: string[]
  /** A SECOND `ZimService` over the same seams — "the app restarted", and with a different
   *  `rootPath`, "the drive came back under another letter". */
  newService(rootOverride?: string, over?: ServiceOverrides): ZimService
  /** Mode applied to the NEXT spawned kiwix-serve / kiwix-manage child. */
  modes: { serve: ServeChildMode; manage: ServeChildMode }
  db(): Db
  addPackFile(leaf: string, uuid?: string): string
  registerPack(leaf: string, uuid?: string): Promise<string>
  transientEntries(): string[]
  packRows(): Array<{ id: string; enabled: number; removed_at: string | null; updated_at: string }>
  /** Every `packs:changed` notice emitted by ANY `ZimService` this harness created (the main
   *  `svc` and every `newService()`), in order — the `notify` seam (#301 P3b, plan §9.17 (e)3). */
  notices: ZimPacksChangedNotice[]
  /** Every `ctx.audit(...)` call the real handlers made (#301 P5 — the DTO legs assert that a
   *  failed file audits nothing and that no title / path ever rides the audit). */
  auditCalls: Array<{ type: string; message: string; metadata: unknown }>
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
    beforeRespond: async () => undefined,
    truncate: () => null,
    respond: () => null
  }
  const requests: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      requests.push(url)
      try {
        await hooks.beforeRespond(url)
      } catch {
        /* a parked response released by teardown still answers */
      }
      // #301 P7 T19: the measured stall — headers, an honest length, most of the body, then
      // silence. Left hanging on purpose; the client's per-attempt timeout is what ends it.
      const cut = hooks.truncate(url)
      if (cut) {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-length': String(cut.total)
        })
        res.write(cut.partial) // …and the rest never arrives
        return
      }
      // The T12 seam: a test that needs per-book / per-entry bytes answers here, so
      // "the viewer fetched the OTHER archive" cannot pass as a success.
      const custom = hooks.respond(url)
      if (custom) {
        res.writeHead(custom.status, { 'content-type': 'text/html', ...custom.headers })
        res.end(custom.body)
        return
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
        `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" title="Title of ${stem}" ` +
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

  // The `notify` seam (#301 P3b, plan §9.17 (e)3): every notice from EVERY ZimService this
  // harness creates (the main `svc` and any `newService()`), in emission order.
  const notices: ZimPacksChangedNotice[] = []

  const makeService = (rootOverride?: string, over: ServiceOverrides = {}): ZimService =>
    new ZimService({
      rootPath: rootOverride ?? root,
      isDev: true,
      admission: {
        admitsWork: () => workspaceAdmitsWork(ctrl),
        epoch: () => ctrl.unlockEpoch()
      },
      ops: zimOps,
      transientDir,
      notify: (event) => notices.push(event),
      deps: {
        resolveTools:
          over.resolveTools ?? (() => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' })),
        spawn: serveSpawn,
        manageSpawn,
        findPort: () => hooks.findPort(),
        probe: (port) => hooks.probe(port),
        verifyBinary: async () => 'ok',
        healthTimeoutMs: 1_000,
        healthIntervalMs: 1,
        killGraceMs: 5,
        forceKillWaitMs: 5,
        // Read at CALL time (#301 P7 T19), so the stall-retry leg shrinks the per-attempt
        // budget for itself and leaves every other read on the shipped default.
        get articleTimeoutMs(): number | undefined {
          return hooks.articleTimeoutMs
        }
      }
    })
  const svc = makeService()

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

  const auditCalls: SessionHarness['auditCalls'] = []
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
    zimOps,
    audit: (type: string, message: string, metadata: unknown) =>
      auditCalls.push({ type, message, metadata })
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
    requests,
    newService: makeService,
    modes,
    db: () => ctrl.requireDb(),
    // A REAL 80-byte header (#301 P3b): identity is what the FILE says. The uuid is derived
    // from the leaf unless the caller pins one (the collision cases need a chosen ORDER).
    addPackFile: (leaf, uuid) => {
      return writeZimFixture(join(zimDir, leaf), uuid ?? packUuid('0000cc03', leaf.slice(0, 6)), {
        trailing: `body of ${leaf}`
      })
    },
    registerPack: async (leaf, uuid) => {
      const p = full.addPackFile(leaf, uuid)
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
        .prepare('SELECT id, enabled, removed_at, updated_at FROM knowledge_packs ORDER BY id')
        .all() as unknown as Array<{
        id: string
        enabled: number
        removed_at: string | null
        updated_at: string
      }>,
    notices,
    auditCalls,
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
        const discP = keepHandled(h.svc.reconcile(h.db()))
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
        const library = await h.svc.ensureServer(h.db())
        expect(library).toMatchObject({ port: h.httpPort })
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
      const { candidates } = await arm!('alpha climate', new AbortController().signal)
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
        // #301 P5 (L1): `packs:add` answers the typed DTO, not a bare array.
        expect((result as KnowledgePackAddResult).outcome).toBe('success')
        expect((result as KnowledgePackAddResult).added).toHaveLength(1)
        expect(h.packRows()).toHaveLength(2)

        // …and a new ask restarts the suspended sidecar (a cold start, no latch).
        const arm = h.svc.makeArm(h.db(), [alpha])
        const { candidates } = await arm!('alpha climate', new AbortController().signal)
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
        const pass = vi.spyOn(h.svc, 'reconcile')

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
        const pass = vi.spyOn(h.svc, 'reconcile')

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
        const pass = vi.spyOn(h.svc, 'reconcile')
        startKnowledgePackSession(h.ctx)
        expect(pass).not.toHaveBeenCalled() // scheduled, never inline

        expect(await waitUntil(() => h.metaAdds.length > 0)).toBe(true)
        for (let i = 0; i < 30; i++) await tick()
        expect(pass).toHaveBeenCalledTimes(1)
        expect(h.packRows()).toHaveLength(1)

        // A session that is no longer admitted does nothing at all when its timer fires.
        h.ctrl.beginLock()
        const second = vi.spyOn(h.svc, 'reconcile')
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

  // ---------------------------------------------------------------------------------------
  // T12 — routes, encoding and the hint-free locator (#301 P3b, finding L4; plan §9.17 (d)6–8)
  // ---------------------------------------------------------------------------------------
  it('T12 collision / Unicode / plus / percent entry paths through one encoding boundary, an old citation without URL id, a saved citation after rename / restart / drive-letter change: expected article bytes, collision loser not served, stale or hostile hint cannot select another book', async () => {
    const h = await sessionHarness()
    try {
      // Known content per (serving name, entry): "the viewer fetched the OTHER archive" can
      // never pass as a success, because the bytes name what was actually asked for.
      h.hooks.respond = (url) => {
        const m = /^\/raw\/([^/]+)\/content\/(.+)$/.exec(url)
        if (!m) return null
        const name = decodeURIComponent(m[1]!)
        const entry = m[2]!.split('/').map(decodeURIComponent).join('/')
        return {
          status: 200,
          body:
            `<html><body><h1>${name} :: ${entry}</h1><p>` +
            `Known content of ${name} at ${entry}. `.repeat(6) +
            '</p></body></html>'
        }
      }
      const rawRequests = (): string[] => h.requests.filter((u) => u.startsWith('/raw/'))
      const readArticle = async (svc: ZimService, packId: string, path: string): Promise<string> => {
        const article = await svc.getArticle(h.db(), packId, path)
        expect(article, `article for ${packId} ${path}`).not.toBeNull()
        return article!.sections.map((s) => s.text).join('\n')
      }
      // ---- (1) TWO SERVING-NAME COLLISIONS: the smaller UUID wins, the loser is excluded ---
      // libkiwix walks its book map in ascending UUID order and keeps the FIRST book for a
      // name, so `wikipedia_de` and `aplusb` each have exactly one legitimate owner. We leave
      // the losers OUT of the built library, which is why the server never sees a collision.
      const accentWinner = await h.registerPack('Wikipédia_DE.zim', '11111111-0000-4000-8000-000000000000')
      const accentLoser = await h.registerPack('wikipedia_de.zim', '99999999-0000-4000-8000-000000000000')
      const plusWinner = await h.registerPack('a+b.zim', '22222222-0000-4000-8000-000000000000')
      const plusLoser = await h.registerPack('aplusb.zim', '88888888-0000-4000-8000-000000000000')
      const unicodePack = await h.registerPack(
        'Groß Wiki+2024 100%.zim',
        '33333333-0000-4000-8000-000000000000'
      )

      const library = (await h.svc.ensureServer(h.db())) as ServedLibrary
      expect(library).not.toBeNull()
      expect(library.names.get(accentWinner)).toBe('wikipedia_de')
      expect(library.names.get(plusWinner)).toBe('aplusb')
      expect(library.names.has(accentLoser)).toBe(false)
      expect(library.names.has(plusLoser)).toBe(false)
      expect([...library.excluded].sort((a, b) => a.packId.localeCompare(b.packId))).toEqual([
        { packId: plusLoser, collidesWith: plusWinner },
        { packId: accentLoser, collidesWith: accentWinner }
      ])
      // The fake kiwix-manage was pointed at the WINNERS only: the XML the child was handed
      // never contained the losers, so no collision could be resolved server-side at all.
      expect(h.buildAdds.slice().sort()).toEqual(
        ['Groß Wiki+2024 100%.zim', 'Wikipédia_DE.zim', 'a+b.zim'].sort()
      )
      const servedChild = h.serveSpawns[h.serveSpawns.length - 1]!
      const servedXml = readFileSync(servedChild.libraryXmlPath, 'utf8')
      expect(servedXml).toContain(accentWinner)
      expect(servedXml).not.toContain(accentLoser)
      expect(servedXml).not.toContain(plusLoser)

      // A read of the WINNER goes out under the shared name and comes back with its own bytes.
      const winnerText = await readArticle(h.svc, accentWinner, 'A/Alpha')
      expect(winnerText).toContain('Known content of wikipedia_de at A/Alpha')
      // A read of the LOSER is refused — honestly, and WITHOUT a request: the pack is not in
      // the served map, so there is no name under which it could be fetched. (Pre-P3b the
      // viewer derived the name from the filename stem, and `wikipedia_de.zim` would have read
      // the WINNER's article under the loser's title.)
      const before = rawRequests().length
      expect(await h.svc.getArticle(h.db(), accentLoser, 'A/Alpha')).toBeNull()
      expect(await h.svc.getArticle(h.db(), plusLoser, 'A/Alpha')).toBeNull()
      expect(rawRequests()).toHaveLength(before)
      // …and the ask arm skips them too, so archive text is never labelled with the wrong pack.
      // #301 P4: skipping them is no longer SILENT — each collision loser gets the honest
      // `not-served` outcome beside the empty candidate list (plan §9.21 (e)2).
      const arm = h.svc.makeArm(h.db(), [accentLoser, plusLoser])
      const collided = await arm!('alpha climate', new AbortController().signal)
      expect(collided.candidates).toEqual([])
      expect(
        collided.outcomes.map((o) => ({ packId: o.packId, status: o.status, reason: o.reason }))
      ).toEqual(
        expect.arrayContaining([
          { packId: accentLoser, status: 'skipped', reason: 'not-served' },
          { packId: plusLoser, status: 'skipped', reason: 'not-served' }
        ])
      )
      // ---- (2) THE REQUEST PATH CARRIES THE EXACT servingNameFor VALUE --------------------
      const unicodeFile = join(h.zimDir, 'Groß Wiki+2024 100%.zim')
      const expectedName = servingNameFor(unicodeFile)
      expect(expectedName).toBe(servingNameFor(unicodeFile)) // pinned below by the URL itself
      expect(library.names.get(unicodePack)).toBe(expectedName)
      h.requests.length = 0
      await readArticle(h.svc, unicodePack, 'A/Alpha')
      expect(rawRequests()).toEqual([
        `/raw/${encodeURIComponent(expectedName)}/content/${encodeArticlePath('A/Alpha')}`
      ])
      // Unicode, `+`, `%` and a space all survive the round trip, escaped exactly once.
      expect(expectedName).toContain('plus')
      expect(expectedName).toContain('_')
      expect(expectedName).not.toContain(' ')
      expect(expectedName).not.toContain('+')
      // ---- (3) ENTRY PATHS: encoded slash, hash, percent, space, Unicode — ONE encoder ----
      const hostileEntries = [
        'A/Über_ß',
        'A/one#two',
        'A/50%_rule',
        'A/a%2Fb', // an ALREADY-encoded slash inside one segment: it must not become structure
        'A/with space/deep',
        'A/plus+sign'
      ]
      for (const entry of hostileEntries) {
        h.requests.length = 0
        const text = await readArticle(h.svc, unicodePack, entry)
        const url = rawRequests()[0]!
        // The URL is exactly what the ONE encoder produces…
        expect(url).toBe(`/raw/${encodeURIComponent(expectedName)}/content/${encodeArticlePath(entry)}`)
        // …and the server's decode of it yields the entry we asked for, segment for segment.
        const decoded = /^\/raw\/[^/]+\/content\/(.+)$/
          .exec(url)![1]!
          .split('/')
          .map(decodeURIComponent)
          .join('/')
        expect(decoded).toBe(entry)
        expect(text).toContain(`Known content of ${expectedName} at ${entry}`)
        // ONE encode pass, never two: a LITERAL `%` in the key is escaped exactly once
        // (`a%2Fb` → `a%252Fb`, and one decode gives `a%2Fb` back — asserted above), while a key
        // with no percent at all can never produce a `%25` (the L4 `my%20wiki` → `my%2520wiki`
        // double-encode regression).
        const encodedEntry = /^\/raw\/[^/]+\/content\/(.+)$/.exec(url)![1]!
        if (!entry.includes('%')) expect(encodedEntry).not.toContain('%25')
      }
      // ---- (4) THE LOCATOR IS packId + articlePath — NO ROUTE HINT ------------------------
      // An "old citation": nothing but the two fields a stored citation has ever carried.
      const atlas = await h.registerPack('atlas.zim', '44444444-0000-4000-8000-000000000000')
      const oldCitation = { packId: atlas, articlePath: 'A/Klimawandel' }
      const viaIpc = await invoke(handlers, IPC.getPackArticle, oldCitation.packId, oldCitation.articlePath)
      const sectionsOf = (r: unknown): string =>
        ((r as { sections: Array<{ text: string }> }).sections ?? []).map((s) => s.text).join('\n')
      const originalText = sectionsOf(viaIpc.result)
      expect(originalText).toContain('Known content of atlas at A/Klimawandel')

      // (a) RENAME: the file is renamed on the drive, so its SERVING NAME changes too. The
      //     citation still resolves, because the route is looked up in the CURRENT map on read
      //     rather than stored with the citation.
      renameSync(join(h.zimDir, 'atlas.zim'), join(h.zimDir, 'Atlas Weltkarte+2027.zim'))
      await h.svc.reconcile(h.db())
      const renamedName = servingNameFor(join(h.zimDir, 'Atlas Weltkarte+2027.zim'))
      expect(renamedName).not.toBe('atlas')
      h.requests.length = 0
      const afterRename = await readArticle(h.svc, oldCitation.packId, oldCitation.articlePath)
      expect(rawRequests()[0]).toContain(encodeURIComponent(renamedName))
      expect(afterRename).toContain(`Known content of ${renamedName} at A/Klimawandel`)

      // A hostile EXTRA argument on the channel changes nothing: the handler reads exactly two,
      // and the route comes from the service's own map. "Serve me THAT book instead" is not a
      // request this surface can express.
      h.requests.length = 0
      const poisoned = await invoke(
        handlers,
        IPC.getPackArticle,
        oldCitation.packId,
        oldCitation.articlePath,
        'wikipedia_de'
      )
      expect(sectionsOf(poisoned.result)).toContain(`Known content of ${renamedName}`)
      expect(rawRequests()[0]).toContain(encodeURIComponent(renamedName))
      expect(rawRequests()[0]).not.toContain('wikipedia_de')

      // (b) RESTART: a brand-new ZimService over the SAME database — the citation needs no
      //     migration and no hint.
      const restarted = h.newService()
      const afterRestart = await readArticle(restarted, oldCitation.packId, oldCitation.articlePath)
      expect(afterRestart).toBe(afterRename)

      // (c) DRIVE-LETTER CHANGE: the drive comes back under another root, and the recorded
      //     absolute path no longer exists. The drive-relative `zim/<leaf>` candidate resolves,
      //     and its header proves it is the same archive.
      const newRoot = join(h.root, 'K-drive')
      mkdirSync(join(newRoot, 'zim'), { recursive: true })
      copyFileSync(
        join(h.zimDir, 'Atlas Weltkarte+2027.zim'),
        join(newRoot, 'zim', 'Atlas Weltkarte+2027.zim')
      )
      rmSync(join(h.zimDir, 'Atlas Weltkarte+2027.zim'))
      const relocated = h.newService(newRoot)
      const afterRelocation = await readArticle(relocated, oldCitation.packId, oldCitation.articlePath)
      expect(afterRelocation).toBe(afterRename) // byte-identical article text
      // ---- (5) THERE IS NO HINT FIELD TO POISON ------------------------------------------
      // A renderer-supplied route hint is the attack this design removes rather than validates:
      // it simply does not exist on the citation, on the viewer target, or on the bridge.
      const src = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
      const citation = /export interface Citation \{[\s\S]*?\n\}/.exec(src('src/shared/types.ts'))![0]
      expect(citation).toContain('packId')
      expect(citation).toContain('articlePath')
      expect(citation).not.toMatch(/urlId/i)
      const target = /export interface ArticleTarget \{[\s\S]*?\n\}/.exec(
        src('src/renderer/chat/ArticleModal.tsx')
      )![0]
      expect(target).not.toMatch(/urlId/i)
      const bridge = /getPackArticle: \(([\s\S]*?)\):/.exec(src('src/preload/index.ts'))![1]!
      expect(bridge).not.toMatch(/urlId/i)
      // packId + articlePath, and nothing else may cross the bridge.
      expect(
        bridge
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      ).toEqual(['packId: string', 'articlePath: string'])
    } finally {
      await h.close()
    }
  })

  // ---------------------------------------------------------------------------------------
  // T19 (the real-tool acceptance run) — kiwix-serve 3.8.1 answers a ZIM REDIRECT ENTRY under
  // /raw with a 302 to the VIEWER route /content/<book>/<target>. The viewer must open the
  // target; a redirect naming ANOTHER book must stay the honest null (finding L4).
  // (#301 P7; docs/rag-design.md §17 D-Z11)
  // ---------------------------------------------------------------------------------------
  it('T19 a redirect entry read over packs:getArticle opens the TARGET article, while a cross-book redirect stays null and fetches nothing from the other book', async () => {
    const h = await sessionHarness()
    try {
      const packId = await h.registerPack('klima.zim', '55555555-0000-4000-8000-000000000000')
      const library = (await h.svc.ensureServer(h.db())) as ServedLibrary
      const name = library.names.get(packId)!
      const alias = 'A/CO2-Äquivalent' // the redirect entry the user's citation names
      const target = 'A/Treibhauspotential' // the article it aliases
      const aliasUrl = `/raw/${encodeURIComponent(name)}/content/${encodeArticlePath(alias)}`
      const targetUrl = `/raw/${encodeURIComponent(name)}/content/${encodeArticlePath(target)}`
      const targetHtml =
        '<html><body><h1>Treibhauspotential</h1><p>' +
        'Das Treibhauspotential ist der Zielartikel dieser Weiterleitung. '.repeat(40) +
        '</p></body></html>'
      /** Where the alias redirects; flipped to another book for the second half. */
      let location = `/content/${name}/${encodeArticlePath(target)}`
      h.hooks.respond = (url) => {
        if (url === aliasUrl) return { status: 302, headers: { location }, body: '' }
        if (url === targetUrl) return { status: 200, body: targetHtml }
        return null
      }
      const rawsSinceMark = (mark: number): string[] =>
        h.requests.slice(mark).filter((u) => u.startsWith('/raw/'))

      // ---- (1) THE SAME BOOK: the viewer gets the TARGET article, title and all ------------
      let mark = h.requests.length
      const opened = (await invoke(handlers, IPC.getPackArticle, packId, alias)).result as {
        title: string
        sections: Array<{ label: string | null; text: string }>
      } | null
      expect(opened).not.toBeNull()
      // The title comes from the fetched HTML, so it is the TARGET's — the locator that was
      // stored stays `packId + articlePath` (the alias), unchanged by the hop.
      expect(opened!.title).toBe('Treibhauspotential')
      expect(opened!.sections.map((s) => s.text).join('\n')).toContain('Zielartikel dieser Weiterleitung')
      // Exactly one hop: the alias, then the target, and nothing else.
      expect(rawsSinceMark(mark)).toEqual([aliasUrl, targetUrl])

      // ---- (2) ANOTHER BOOK: null, and not one byte read from that book --------------------
      location = '/content/some_other_book/A/Treibhauspotential'
      mark = h.requests.length
      const crossBook = await invoke(handlers, IPC.getPackArticle, packId, alias)
      expect(crossBook.result).toBeNull()
      expect(rawsSinceMark(mark)).toEqual([aliasUrl])
    } finally {
      await h.close()
    }
  })

  it('T19 an article whose first /raw read is cut short still opens whole: the stall is retried inside the same guard window', async () => {
    // The measured kiwix-serve 3.8.1 (win-x86_64) fault: ~5–20 % of `/raw` reads of an entry
    // above ~80 KB deliver the 200, a `Content-Length` and most of the body in 3–6 ms and then
    // hang, the last part never arriving, while the server stays alive and answers the next
    // request normally. Before the retry the viewer showed "This article is not available
    // right now"; the truncated body must never be shown as the article either.
    const h = await sessionHarness()
    try {
      const packId = await h.registerPack('klima.zim', '66666666-0000-4000-8000-000000000000')
      const library = (await h.svc.ensureServer(h.db())) as ServedLibrary
      const name = library.names.get(packId)!
      const entry = 'A/Treibhauseffekt' // one of the measured stallers (234 KB in the archive)
      const entryUrl = `/raw/${encodeURIComponent(name)}/content/${encodeArticlePath(entry)}`
      const html =
        '<html><body><h1>Treibhauseffekt</h1><p>' +
        'Der Treibhauseffekt beschreibt die Erwärmung der Atmosphäre. '.repeat(40) +
        '</p><p>Schlussabsatz: der letzte Teil des Artikels.</p></body></html>'
      h.hooks.respond = (url) => (url === entryUrl ? { status: 200, body: html } : null)
      // Shrunk for this leg only: the shipped budget is 4 s per attempt.
      h.hooks.articleTimeoutMs = 300
      let stalls = 0
      h.hooks.truncate = (url) => {
        // The FIRST read of this entry is cut at ~85 %: the closing paragraph — the only place
        // "Schlussabsatz" appears — is in the part that never arrives.
        if (url !== entryUrl || stalls > 0) return null
        stalls++
        return { partial: html.slice(0, Math.floor(html.length * 0.85)), total: Buffer.byteLength(html) }
      }

      const mark = h.requests.length
      const opened = (await invoke(handlers, IPC.getPackArticle, packId, entry)).result as {
        title: string
        sections: Array<{ label: string | null; text: string }>
      } | null

      // The viewer gets the WHOLE article, not the honest-but-wrong "unavailable" null and not
      // the truncated body either.
      expect(opened).not.toBeNull()
      expect(opened!.title).toBe('Treibhauseffekt')
      const text = opened!.sections.map((s) => s.text).join('\n')
      expect(text).toContain('Erwärmung der Atmosphäre')
      expect(text).toContain('Schlussabsatz')
      // Two reads of the SAME route and nothing else: the retry is a fresh request inside the
      // one request-guard window, so the guard's own lifecycle retry is untouched.
      expect(h.requests.slice(mark).filter((u) => u.startsWith('/raw/'))).toEqual([entryUrl, entryUrl])
      expect(stalls).toBe(1)
      // No child was restarted for it — the server tuple never changed across the stall.
      expect(h.svc.serverState()).toMatchObject({ port: h.httpPort, alive: true })
    } finally {
      await h.close()
    }
  })

  // ---------------------------------------------------------------------------------------
  // T13 — packs:list, refresh serialization, the pack-update event, remove/disable winning
  // (#301 P3b, finding L7; plan §9.17 (e))
  // ---------------------------------------------------------------------------------------
  it('T13 packs:list performs no discovery or filesystem writes; startup reconciliation and explicit Refresh are serialized; the update event reaches a mounted Chat and old-epoch events are ignored; a user remove / disable wins over late metadata', async () => {
    const h = await sessionHarness()
    try {
      // ---- (1) packs:list is DATABASE-ONLY: a dropped, unregistered file triggers no manager
      //      spawn and no write — `listPacks` never reads tools state or the drive at all, so
      //      this covers both the "no tools" and the "tools installed" shapes of the row. -----
      h.addPackFile('never-discovered.zim')
      const rowsBefore = h.packRows()
      const buildAddsBefore = h.buildAdds.length
      const metaAddsBefore = h.metaAdds.length
      const listed = (await invoke(handlers, IPC.listKnowledgePacks)).result as unknown[]
      expect(listed).toEqual([])
      expect(h.packRows()).toEqual(rowsBefore) // byte-for-byte, INCLUDING updated_at
      expect(h.buildAdds.length).toBe(buildAddsBefore) // no serve-library manager spawn
      expect(h.metaAdds.length).toBe(metaAddsBefore) // no registration manager spawn
      // ---- (2) a parked session-start reconcile + two packs:refresh calls: exactly ONE run
      //      in flight and exactly ONE coalesced rerun after release, never a third pass ------
      const manageGate = serveGate<void>()
      h.hooks.manage = () => manageGate.wait()
      const noticesAtStep2 = h.notices.length
      const parkedStartP = keepHandled(h.svc.reconcile(h.db()))
      await manageGate.entered
      // Two explicit Refresh calls while the pass is in flight: the single-flight latch
      // (`runAgain`) coalesces them into exactly ONE more pass, however many Refreshes arrived.
      const refresh1P = invoke(handlers, IPC.refreshKnowledgePacks)
      const refresh2P = invoke(handlers, IPC.refreshKnowledgePacks)
      expect((await refresh1P).result).toEqual({ started: true })
      expect((await refresh2P).result).toEqual({ started: true })
      const metaAddsAtPark = h.metaAdds.length
      manageGate.release()
      await parkedStartP
      for (let i = 0; i < 20; i++) await tick() // drain the coalesced rerun
      // The rerun finds `never-discovered.zim` ALREADY registered by the parked pass, so it
      // spawns no second manager call — proof there was no THIRD, uncoalesced pass either.
      expect(h.metaAdds.length).toBe(metaAddsAtPark)
      const reconcileStarts = h.notices
        .slice(noticesAtStep2)
        .filter((n) => n.reason === 'reconcile-start')
      const reconcileEnds = h.notices
        .slice(noticesAtStep2)
        .filter((n) => n.reason === 'reconcile-end')
      expect(reconcileStarts).toHaveLength(2) // the parked pass + exactly one coalesced rerun
      expect(reconcileEnds).toHaveLength(2)
      // ---- (3) the notify seam: reconcile-start then reconcile-end carry the CURRENT epoch,
      //      never an old one — a lock parked mid-reconcile emits its reconcile-start but NEVER
      //      a reconcile-end (the post-manager assert throws first) and writes nothing; the new
      //      session's own pass emits both, under the NEW epoch, and its write lands. ----------
      h.addPackFile('discovered-across-lock.zim')
      const epochBeforeLock = h.ctrl.unlockEpoch()
      const lockManageGate = serveGate<void>()
      h.hooks.manage = () => lockManageGate.wait()
      const noticesAtStep3 = h.notices.length
      const parkedAcrossLockP = keepHandled(h.svc.reconcile(h.db()))
      await lockManageGate.entered
      const { lockP } = await parkedLock(h)
      const rowsInLock = h.packRows()
      h.hooks.manage = async () => undefined
      lockManageGate.release()
      await expectAbortError(parkedAcrossLockP)
      expect(h.packRows()).toEqual(rowsInLock) // the parked pass wrote nothing
      h.releaseSuspend()
      await lockP
      const parkedWindowNotices = h.notices.slice(noticesAtStep3)
      expect(parkedWindowNotices.map((n) => n.reason)).toEqual(['reconcile-start'])
      expect(parkedWindowNotices[0]?.epoch).toBe(epochBeforeLock)

      h.ctrl.unlock('right-password')
      const epochAfterUnlock = h.ctrl.unlockEpoch()
      expect(epochAfterUnlock).not.toBe(epochBeforeLock)
      const noticesAtStep3b = h.notices.length
      const metaAddsBeforeNewSession = h.metaAdds.length
      await h.svc.reconcile(h.db())
      const newSessionNotices = h.notices.slice(noticesAtStep3b)
      expect(newSessionNotices.map((n) => n.reason)).toEqual(['reconcile-start', 'reconcile-end'])
      expect(newSessionNotices.every((n) => n.epoch === epochAfterUnlock)).toBe(true)
      // The new session's own pass is the one that actually registers the file the parked,
      // aborted pass never got to.
      expect(h.metaAdds.length).toBe(metaAddsBeforeNewSession + 1)
      expect(h.metaAdds.slice(-1)).toEqual(['discovered-across-lock.zim'])
      // ---- (4) packs:remove / packs:setEnabled(false) issued while a reconcile is parked WIN:
      //      after release the rows stay tombstoned / disabled, and the columns the reconcile
      //      does not own (`enabled`, `removed_at`) — nor even touch when nothing else about
      //      the row changed (`updated_at`) — were never rewritten by the late pass. -----------
      const alphaId = await h.registerPack('alpha-t13.zim')
      const betaId = await h.registerPack('beta-t13.zim')
      h.addPackFile('gamma-t13.zim') // unregistered — the pass has real work to park inside
      const gammaGate = serveGate<void>()
      h.hooks.manage = () => gammaGate.wait()
      const mutationRaceP = keepHandled(h.svc.reconcile(h.db()))
      await gammaGate.entered

      await invoke(handlers, IPC.removeKnowledgePack, alphaId)
      await invoke(handlers, IPC.setKnowledgePackEnabled, betaId, false)
      const rowById = (id: string): { enabled: number; removed_at: string | null; updated_at: string } =>
        h.packRows().find((r) => r.id === id)!
      const alphaAfterMutation = rowById(alphaId)
      const betaAfterMutation = rowById(betaId)
      expect(alphaAfterMutation.removed_at).not.toBeNull()
      expect(betaAfterMutation.enabled).toBe(0)

      h.hooks.manage = async () => undefined
      gammaGate.release()
      await mutationRaceP

      const alphaAfterReconcile = rowById(alphaId)
      const betaAfterReconcile = rowById(betaId)
      expect(alphaAfterReconcile.removed_at).toBe(alphaAfterMutation.removed_at)
      expect(betaAfterReconcile.enabled).toBe(0)
      // Never rewritten by the late pass: neither the columns the reconcile does not own…
      expect(alphaAfterReconcile.updated_at).toBe(alphaAfterMutation.updated_at)
      expect(betaAfterReconcile.updated_at).toBe(betaAfterMutation.updated_at)
      // …and gamma — the file the pass actually had work for — DID get registered, proving the
      // pass really ran to completion rather than the assertions above passing vacuously.
      expect(h.metaAdds).toContain('gamma-t13.zim')
    } finally {
      await h.close()
    }
  })

  // ---------------------------------------------------------------------------------------
  // T17 — the ACCESS BOUNDARY (#301 P5, findings M1 / L1 / L5; plan §9.19 (a)/(g))
  //
  // kiwix-serve has no request authentication upstream (owner ruling D1(a), residual R-9), so
  // the app cannot ask "is this our child answering?". What it CAN do is notice that its own
  // child's lifecycle moved around a request: `ZimService.withServer` captures the published
  // tuple (revision, generation, port, alive) before the request and reads it again after the
  // response, discards anything observed across a change of it — a successful body included —
  // and retries exactly once while the same unlocked session still admits the operation.
  //
  // The loopback server in this harness is deliberately the SQUATTER: it keeps answering on
  // the very port a dead child held, which is exactly the M1 injection channel. The legs below
  // are all controlled promises with entered/released boundaries; no sleep is ever the proof.
  // ---------------------------------------------------------------------------------------
  it('T17 child death / reused port / stale response rejected by the alive-generation guard with one admitted retry; no retry into a new session or after cancellation; articlePath route contract enforced; cancelled / partial / failed add (incl. a MIXED add) reported through the typed DTO with generic UI copy and no path or stderr leak', async () => {
    const h = await sessionHarness({ settleBoundMs: 200 })
    try {
      // What a process squatting on the port would inject. If ANY of it reaches a candidate
      // or an article, the guard did not do its job — it rides the search link (→ the
      // candidate's `articlePath` and `chunkId`) and the article body (→ `sourceTitle`).
      const SENTINEL = 'SQUATTER-INJECTED-EVIDENCE'
      const SENTINEL_SEARCH_XML =
        '<?xml version="1.0" encoding="UTF-8"?><rss><channel>' +
        `<item><title>${SENTINEL}</title><link>/content/alpha/A/${SENTINEL}</link>` +
        '<wordCount>99</wordCount></item></channel></rss>'
      const SENTINEL_ARTICLE_HTML =
        `<html><body><h1>${SENTINEL}</h1><p>` +
        `${SENTINEL} says the opposite of the archive. `.repeat(40) +
        '</p></body></html>'
      const searchesSince = (mark: number): string[] =>
        h.requests.slice(mark).filter((u) => u.startsWith('/search'))
      const rawsSince = (mark: number): string[] =>
        h.requests.slice(mark).filter((u) => u.startsWith('/raw/'))
      const liveChild = (): ServeFakeChild => h.serveSpawns[h.serveSpawns.length - 1]!.child

      const alpha = await h.registerPack('alpha.zim')
      // ---- (1) CHILD DEATH MID-ASK: the parked /search response is discarded -------------
      // The search is parked on the wire, the child dies underneath it, and the response is
      // then released carrying the squatter's article. The guard sees `alive:false` on the
      // second read of `serverState()` and throws the whole attempt away.
      {
        const warm = await h.svc.ensureServer(h.db())
        expect(warm).toMatchObject({ port: h.httpPort })
        const generationBefore = h.svc.serverState()!.generation
        const spawnsBefore = h.serveSpawns.length
        const mark = h.requests.length

        const searchGate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/search') ? searchGate.wait() : Promise.resolve()
        let searchResponses = 0
        h.hooks.respond = (url) => {
          if (url.startsWith('/raw/') && url.includes(SENTINEL)) {
            return { status: 200, body: SENTINEL_ARTICLE_HTML }
          }
          if (!url.startsWith('/search')) return null
          searchResponses++
          // ONLY the first response is the squatter's; the retry gets the honest fixture.
          return searchResponses === 1 ? { status: 200, body: SENTINEL_SEARCH_XML } : null
        }

        const askP = h.svc.makeArm(h.db(), [alpha])!(
          'alpha climate',
          new AbortController().signal
        )
        await searchGate.entered
        liveChild().emit('exit', 0, null) // it dies while OUR response is still in flight
        h.hooks.beforeRespond = async () => undefined
        searchGate.release()

        const { candidates } = await askP
        expect(searchResponses).toBe(2) // the attempt plus EXACTLY one retry
        expect(searchesSince(mark)).toHaveLength(2)
        expect(h.serveSpawns).toHaveLength(spawnsBefore + 1) // a genuinely new child…
        expect(h.svc.serverState()!.generation).toBeGreaterThan(generationBefore) // …new generation
        // The candidates come from the SECOND attempt only, and nothing the squatter said
        // survived into the grounded prompt.
        expect(candidates.length).toBeGreaterThan(0)
        expect(JSON.stringify(candidates)).not.toContain(SENTINEL)
        expect(candidates.every((c) => c.articlePath === 'A/Alpha')).toBe(true)
        h.hooks.respond = () => null
      }
      // ---- (2) THE REUSED PORT: the same socket, accepted only because we stayed alive ----
      // `findPort` hands back the same `httpPort` every time, so the retried child in leg (1)
      // published on the exact port the dead child had held and the squatter had answered on.
      // The port is therefore NOT what distinguishes the rejected response from this accepted
      // one — the only difference is that our own generation stayed alive across it.
      {
        expect(h.svc.serverState()).toMatchObject({ port: h.httpPort, alive: true })
        const generationsAtRequest: Array<number | null> = []
        h.hooks.beforeRespond = async (url) => {
          if (url.startsWith('/search')) {
            generationsAtRequest.push(h.svc.serverState()?.generation ?? null)
          }
        }
        const mark = h.requests.length
        const { candidates } = await h.svc.makeArm(h.db(), [alpha])!(
          'alpha climate',
          new AbortController().signal
        )
        expect(candidates.length).toBeGreaterThan(0)
        expect(searchesSince(mark)).toHaveLength(1) // accepted first time: no retry at all
        expect(generationsAtRequest).toHaveLength(1)
        // Before and after are the same live generation — the accept condition itself.
        expect(h.svc.serverState()).toMatchObject({
          port: h.httpPort,
          alive: true,
          generation: generationsAtRequest[0]
        })
        h.hooks.beforeRespond = async () => undefined
      }
      // ---- (3) STALE GENERATION: eligibility is RECOMPUTED, never the old list -----------
      // A second pack is disabled while an article fetch is parked. `setPackEnabled` bumps the
      // revision and tears the child down, so the response arrives across a lifecycle change
      // and is discarded; the retry re-enters from `ensureServer` under the CURRENT revision,
      // so the disabled pack is not in the new served set and is never searched again.
      {
        const bravo = await h.registerPack('bravo.zim')
        const rebuilt = await h.svc.ensureServer(h.db())
        expect(rebuilt!.names.has(bravo)).toBe(true)
        const mark = h.requests.length

        const rawGate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/raw/') ? rawGate.wait() : Promise.resolve()
        const askP = h.svc.makeArm(h.db(), [alpha, bravo])!(
          'alpha climate',
          new AbortController().signal
        )
        await rawGate.entered
        h.svc.setPackEnabled(h.db(), bravo, false) // invalidateLibrary(): the publication drops
        h.hooks.beforeRespond = async () => undefined
        rawGate.release()

        const { candidates } = await askP
        const searches = searchesSince(mark)
        expect(searches.filter((u) => u.includes(encodeURIComponent(alpha)))).toHaveLength(2)
        // Searched once — by the DISCARDED attempt, which was built from the pre-change list.
        // The retry never asks for it again: it re-queried `retrievablePacks` and re-read
        // `library.names` for the attempt it was actually handed.
        expect(searches.filter((u) => u.includes(encodeURIComponent(bravo)))).toHaveLength(1)
        expect(candidates.length).toBeGreaterThan(0)
        expect(candidates.every((c) => c.packId === alpha)).toBe(true)
        expect((await h.svc.ensureServer(h.db()))!.names.has(bravo)).toBe(false)
      }

      // ---- (3b) …and the re-query is what does it, not merely the new serving map ---------
      // Here the pack's FILE disappears mid-attempt. Nothing invalidates the library, so the
      // retry restarts over the SAME build and `library.names` STILL carries the pack: only
      // re-running `retrievablePacks` inside the callback — which resolves each pack by its
      // header UUID — can notice that it is no longer retrievable.
      {
        const delta = await h.registerPack('delta.zim')
        expect((await h.svc.ensureServer(h.db()))!.names.has(delta)).toBe(true)
        const mark = h.requests.length

        const rawGate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/raw/') ? rawGate.wait() : Promise.resolve()
        const askP = h.svc.makeArm(h.db(), [alpha, delta])!(
          'alpha climate',
          new AbortController().signal
        )
        await rawGate.entered
        rmSync(join(h.zimDir, 'delta.zim')) // no revision bump: the published build stands
        liveChild().emit('exit', 0, null) // …but the child dies, so the attempt is discarded
        h.hooks.beforeRespond = async () => undefined
        rawGate.release()

        const { candidates } = await askP
        const searches = searchesSince(mark)
        expect(searches.filter((u) => u.includes(encodeURIComponent(alpha)))).toHaveLength(2)
        expect(searches.filter((u) => u.includes(encodeURIComponent(delta)))).toHaveLength(1)
        expect(candidates.every((c) => c.packId === alpha)).toBe(true)
        // The reused build still names it — which is exactly why the map alone is not enough.
        expect((await h.svc.ensureServer(h.db()))!.names.has(delta)).toBe(true)
      }
      // ---- (4) NO RETRY INTO A NEW SESSION: lock + unlock across a parked response --------
      // The retry is admitted only while the SAME unlocked session still wants the work. A
      // lock aborts the operation; the unlock that follows restores admission and starts a NEW
      // epoch — and neither of those may turn into a second request under the new session.
      {
        const mark = h.requests.length
        const gate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/search') ? gate.wait() : Promise.resolve()
        const askP = keepHandled(
          h.svc.makeArm(h.db(), [alpha])!('alpha climate', new AbortController().signal)
        )
        await gate.entered

        const { lockP } = await parkedLock(h)
        h.releaseSuspend()
        await lockP
        expect(h.ctrl.isUnlocked()).toBe(false)
        const unlocked = await invoke(handlers, IPC.unlockWorkspace, 'right-password')
        expect(unlocked.result).toMatchObject({ ok: true })
        for (let i = 0; i < 20; i++) await tick() // let the new session's own pass finish

        h.hooks.beforeRespond = async () => undefined
        gate.release() // the parked response arrives in a session that is not its own
        await expectAbortError(askP)
        expect(searchesSince(mark)).toHaveLength(1) // never a second request
      }
      // ---- (5) NO RETRY AFTER CANCELLATION: the user's own abort ------------------------
      {
        const mark = h.requests.length
        const gate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/search') ? gate.wait() : Promise.resolve()
        const askCtrl = new AbortController()
        const askP = keepHandled(h.svc.makeArm(h.db(), [alpha])!('alpha climate', askCtrl.signal))
        await gate.entered
        askCtrl.abort()
        h.hooks.beforeRespond = async () => undefined
        gate.release()
        await expectAbortError(askP)
        expect(searchesSince(mark)).toHaveLength(1)
      }
      // ---- (6) EXACTLY ONE RETRY: a death during the retry as well -----------------------
      // The retry budget is one, not "until it works": a server that keeps dying must produce
      // an honest ordinary failure, not an unbounded loop against a possibly-hostile port.
      {
        // Start from a child that has already died, so BOTH attempts spawn their own and the
        // spawn log counts them.
        if (h.svc.serverState()?.alive) liveChild().emit('exit', 0, null)
        const mark = h.requests.length
        const spawnsBefore = h.serveSpawns.length
        h.hooks.beforeRespond = async (url) => {
          if (url.startsWith('/search')) liveChild().emit('exit', 0, null)
        }
        const askP = h.svc.makeArm(h.db(), [alpha])!(
          'alpha climate',
          new AbortController().signal
        )
        // #301 P4 (plan §9.21 (e)2): a twice-discarded attempt is an ORDINARY failure, not the
        // #159 abort convention — the session still admits the work, so the ask RESOLVES and
        // every eligible pack carries `failed / server-restarted` with no candidates. (Before the
        // outcome contract this leg asserted a `StaleServerError` REJECTION, which erased the very
        // outcomes the user is owed; the retry BUDGET it proves is unchanged.)
        const restarted = await askP
        expect(restarted.candidates).toEqual([])
        expect(restarted.outcomes).toEqual([
          {
            packId: alpha,
            title: expect.any(String),
            status: 'failed',
            reason: 'server-restarted',
            found: 0,
            admitted: 0
          }
        ])
        expect(searchesSince(mark)).toHaveLength(2)
        expect(h.serveSpawns).toHaveLength(spawnsBefore + 2)
        h.hooks.beforeRespond = async () => undefined
      }
      // ---- (7) THE VIEWER: the same guard on getArticle, and the lock leg ----------------
      {
        // (a) death mid-read → one retry → the article of the SECOND attempt.
        await h.svc.ensureServer(h.db())
        const mark = h.requests.length
        let rawResponses = 0
        h.hooks.beforeRespond = async (url) => {
          if (url.startsWith('/raw/') && rawResponses === 0) liveChild().emit('exit', 0, null)
        }
        h.hooks.respond = (url) => {
          if (!url.startsWith('/raw/')) return null
          rawResponses++
          return rawResponses === 1 ? { status: 200, body: SENTINEL_ARTICLE_HTML } : null
        }
        const article = await h.svc.getArticle(h.db(), alpha, 'A/Alpha')
        expect(article).not.toBeNull()
        expect(article!.title).toBe('Alpha and the climate')
        expect(JSON.stringify(article)).not.toContain(SENTINEL)
        expect(rawsSince(mark)).toHaveLength(2)
        h.hooks.respond = () => null
        h.hooks.beforeRespond = async () => undefined

        // (b) a lock lands during the read: the SERVICE refuses with the #159 AbortError and
        //     the REAL `packs:getArticle` handler turns that into the viewer's honest null.
        const gate = serveGate<void>()
        h.hooks.beforeRespond = (url) =>
          url.startsWith('/raw/') ? gate.wait() : Promise.resolve()
        const handlerReadP = keepHandled(invoke(handlers, IPC.getPackArticle, alpha, 'A/Alpha'))
        const serviceReadP = keepHandled(h.svc.getArticle(h.db(), alpha, 'A/Alpha'))
        await gate.entered
        const { lockP } = await parkedLock(h)
        h.hooks.beforeRespond = async () => undefined
        gate.release()
        await expectAbortError(serviceReadP)
        expect((await handlerReadP).result).toBeNull()
        h.releaseSuspend()
        await lockP
        expect(h.ctrl.isUnlocked()).toBe(false)
        h.ctrl.unlock('right-password')
      }

      // --- L5 legs (#301 P5, finding L5; plan §9.19 (b)) — the entry-key contract runs FIRST inside
      // the one encoder, so a hazardous key is refused before any HTTP request; the compatibility
      // keys each issue exactly one /raw request with the expected per-segment encoding.
      {
        const l5 = await sessionHarness()
        try {
          const alpha = await l5.registerPack('alpha-l5.zim')
          l5.requests.length = 0
          const hazardous = [
            'A/../B', // a dot segment
            'A/x' + String.fromCharCode(0) + 'y', // a C0 control
            'A/' + 'x'.repeat(2049), // over MAX_ARTICLE_PATH_CHARS = 2048
            '' // empty
          ]
          for (const badPath of hazardous) {
            const res = await invoke(handlers, IPC.getPackArticle, alpha, badPath)
            expect(res.result, `hazardous key ${JSON.stringify(badPath.slice(0, 12))}`).toBeNull()
          }
          expect(l5.requests.filter((u) => u.startsWith('/raw/'))).toHaveLength(0)

          const compatible = [
            'A/https://example.com/a//b', // empty segments — zimit-era URL-shaped keys
            'A/one:two?three#four%25plus+amp&eq=space five', // URL-shaped punctuation + space
            'A/a%2Fb', // an already-encoded slash inside one segment
            'Treibhausgas', // namespace-less
            '-/style.css',
            'I/img.png',
            'A/Foo.', // trailing dot
            'A/..foo', // starts with dots, not exactly ".."
            'A/.hidden' // starts with a dot, not exactly "."
          ]
          for (const key of compatible) {
            l5.requests.length = 0
            const res = await invoke(handlers, IPC.getPackArticle, alpha, key)
            expect(res.result, `compatible key ${key}`).not.toBeNull()
            const rawRequests = l5.requests.filter((u) => u.startsWith('/raw/'))
            expect(rawRequests).toHaveLength(1)
            expect(rawRequests[0]).toContain(`/content/${encodeArticlePath(key)}`)
          }
        } finally {
          await l5.close()
        }
      }
      // --- DTO legs (#301 P5, finding L1; plan §9.19 (c)) — the REAL handler + REAL service + the
      // fake kiwix-manage child failing one of two files with a sentinel PATH on its stderr:
      // cancelled / MIXED / all-fail, observed only through the public IPC result and the audit.
      {
        const dto = await sessionHarness()
        try {
          dto.hooks.manage = async () => undefined
          dialogState.paths = []
          dialogState.canceled = true
          const cancelled = await invoke(handlers, IPC.addKnowledgePacks)
          expect(cancelled.result).toEqual({ outcome: 'cancelled', added: [], failed: 0, failureReason: null })
          dialogState.canceled = false

          const SENTINEL_LEAF = 'XSENTINEL_T17_DTO_MIXED_leaf.zim'
          const goodPath = dto.addPackFile('good-t17-dto.zim')
          const badPath = dto.addPackFile(SENTINEL_LEAF)
          dto.hooks.manage = async (_libraryXmlPath: string, zimPath: string) => {
            if (zimPath === badPath) throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
          }
          dialogState.paths = [goodPath, badPath]
          const mixed = (await invoke(handlers, IPC.addKnowledgePacks)).result as KnowledgePackAddResult
          expect(mixed.outcome).toBe('partial')
          expect(mixed.added).toHaveLength(1)
          expect(mixed.added[0]?.leaf).toBe('good-t17-dto.zim')
          expect(mixed.failed).toBe(1)
          // The fake child exits 1 with that stderr, so the REAL kiwixManageAdd rejects with a
          // KiwixManageError — classified as the manager's failure, a CODE.
          expect(mixed.failureReason).toBe('manager')
          const mixedJson = JSON.stringify(mixed)
          expect(mixedJson).not.toContain('XSENTINEL_T17_DTO_MIXED')
          expect(mixedJson).not.toContain(badPath)
          expect(mixedJson).not.toContain('Cannot add ZIM')
          const added = dto.auditCalls.filter((c) => c.type === 'knowledge_pack_added')
          expect(added).toHaveLength(1) // the failed file audits nothing
          expect(JSON.stringify(dto.auditCalls)).not.toContain('XSENTINEL_T17_DTO_MIXED')
          expect(JSON.stringify(dto.auditCalls)).not.toContain('good-t17-dto')

          const allBadA = dto.addPackFile('all-fail-t17-a.zim')
          const allBadB = dto.addPackFile('all-fail-t17-b.zim')
          dto.hooks.manage = async (_libraryXmlPath: string, zimPath: string) => {
            throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
          }
          dialogState.paths = [allBadA, allBadB]
          const allFail = (await invoke(handlers, IPC.addKnowledgePacks)).result as KnowledgePackAddResult
          expect(allFail.outcome).toBe('failure') // resolves — no throw
          expect(allFail.added).toHaveLength(0)
          expect(allFail.failed).toBe(2)
          expect(allFail.failureReason).toBe('manager')
          const allFailJson = JSON.stringify(allFail)
          expect(allFailJson).not.toContain('all-fail-t17-a.zim')
          expect(allFailJson).not.toContain('all-fail-t17-b.zim')
          expect(dto.auditCalls.filter((c) => c.type === 'knowledge_pack_added')).toHaveLength(1)
          dto.hooks.manage = async () => undefined
        } finally {
          await dto.close()
        }
      }
    } finally {
      await h.close()
    }
  })
})

// ---- T16-a — per-ask knowledge-pack OUTCOMES, end to end (#301 P4, findings M6/M7) ----------
//
// The honesty gap this closes: before P4 a pack the user ticked could be disabled, gone from the
// drive, index-less, trimmed by the selection cap, colliding on its serving name, or its search
// could simply fail — and the answer looked exactly like "your packs were searched and had
// nothing to add". The arm now classifies EVERY selected id before any eligibility filter, the
// outcome set is persisted WITH the answer message, and the answer paths that read documents
// instead of querying packs say so rather than staying silent.
//
// Everything below runs on the real session harness: a real vault, a real `ZimService` with a
// real op registry, fake kiwix children, the real loopback server standing in for kiwix-serve,
// and a REAL `retrieve` / `generateGroundedAnswer` over the mock runtime with a real
// `createConversation` / `setScope` / `resolveScope`. Ordering is controlled promises only.

const EMPTY_SEARCH_XML = '<?xml version="1.0" encoding="UTF-8"?><rss><channel></channel></rss>'

/** The mock chat runtime the grounded answers stream from (no network, no model). */
const askRuntime = (): ModelRuntime =>
  createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 4096 })

const ASK_SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

/** Seed one indexed document with real embeddings, and return its id. */
async function seedAskDocument(
  db: Db,
  embedder: MockEmbedder,
  title: string,
  texts: string[]
): Promise<string> {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
  ).run(docId, title, now, now)
  const vectors = await embedder.embed(texts)
  for (let i = 0; i < texts.length; i++) {
    const chunkId = randomUUID()
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    ).run(chunkId, docId, i, texts[i], title, texts[i]!.split(/\s+/).length, now)
    db.prepare(
      `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(chunkId, embedder.id, encodeVector(vectors[i]!), vectors[i]!.length, now)
  }
  return docId
}

/** Just the comparable part of an outcome — titles vary with the fixture's file names. */
const shape = (outcomes: KnowledgePackOutcome[] | undefined) =>
  (outcomes ?? [])
    .map((o) => ({ packId: o.packId, status: o.status, reason: o.reason }))
    .sort((a, b) => a.packId.localeCompare(b.packId))

describe('T16 — per-ask knowledge-pack outcomes end to end (#301 P4, M6/M7)', () => {
  it('T16 per-ask outcomes (all failed / zero hits / missing tools / removed or disabled selection / mixed / all fetches failed / two chats / scope changed mid-ask / reload) survive zero-citation answers, associate with the right message, persist with it, and whole-doc / compare never claim packs were queried', async () => {
    const h = await sessionHarness()
    try {
      const db = h.db()
      const embedder = new MockEmbedder()
      const runtime = askRuntime()
      const question = 'alpha climate'
      // A document that WOULD answer the question, so the "documents on" legs really do produce a
      // documents-only answer whose only honest pack signal is the outcome set.
      const docA = await seedAskDocument(db, embedder, 'climate-notes.txt', [
        'Alpha and the climate: a local note about the climate of alpha.',
        'An unrelated paragraph about invoices and tax.'
      ])
      const docB = await seedAskDocument(db, embedder, 'climate-notes-v2.txt', [
        'Alpha and the climate: a revised local note about the climate of alpha.',
        'An unrelated paragraph about invoices and tax.'
      ])

      const alpha = await h.registerPack('alpha.zim')
      const bravo = await h.registerPack('bravo.zim')
      // Start the sidecar up front so the concurrency leg below parks on `/search`, never on a
      // cold start (which would serialize the two asks and prove nothing about ordering).
      expect(await h.svc.ensureServer(db)).not.toBeNull()

      // The harness's default article fixture is ~2 kB, and the mock runtime ECHOES the grounded
      // prompt token by token — so a successful archive leg would spend seconds streaming an
      // excerpt none of these assertions read. A SHORT article keeps every leg's behaviour
      // identical (it still carries both query terms, so it still produces a candidate) and the
      // test fast. Legs that need a specific failure layer their own responder over this one.
      const shortArticle =
        '<html><body><h1>Alpha and the climate</h1><p>' +
        'Alpha climate note. '.repeat(6) +
        '</p></body></html>'
      const baseRespond = (url: string): { status: number; body: string } | null =>
        url.startsWith('/raw/') ? { status: 200, body: shortArticle } : null
      h.hooks.respond = baseRespond

      const searchesSince = (mark: number): string[] =>
        h.requests.slice(mark).filter((u) => u.startsWith('/search'))

      /** One ask, exactly as `registerRagIpc` composes it: resolve the stored scope, build the
       *  arm from `scope.packIds`, and stream a real grounded answer over the mock runtime. */
      const ask = async (
        conversationId: string,
        svc: ZimService = h.svc,
        over: { wholeDocument?: { documentId: string }; wholeDocumentCompare?: { documentIds: string[] } } = {}
      ): Promise<Message> => {
        appendMessage(db, { conversationId, role: 'user', content: question })
        const scope = resolveScope(db, conversationId)
        return generateGroundedAnswer(db, runtime, embedder, conversationId, question, ASK_SETTINGS, {
          scope,
          externalArm: svc.makeArm(db, scope.packIds),
          ...over
        })
      }

      const newChat = (packIds: string[], documentsOff = true) => {
        const conv = createConversation(db, { mode: 'documents' })
        setScope(db, conv.id, {
          collectionIds: [],
          documentIds: [],
          packIds,
          ...(documentsOff ? { documentsOff: true as const } : {})
        })
        return conv
      }
      // ---- (1) EVERY SOURCE FAILED: two packs, both `/search` calls answer 500 ---------------
      // The ask still resolves (an unplugged pack drive never breaks asking) and the answer is
      // the no-context one — but it now carries WHY, per pack, instead of implying "no hits".
      {
        h.hooks.respond = (url) =>
          url.startsWith('/search') ? { status: 500, body: 'boom' } : baseRespond(url)
        const conv = newChat([alpha, bravo])
        const msg = await ask(conv.id)
        expect(shape(msg.packOutcomes)).toEqual(
          [
            { packId: alpha, status: 'failed', reason: 'search-failed' },
            { packId: bravo, status: 'failed', reason: 'search-failed' }
          ].sort((a, b) => a.packId.localeCompare(b.packId))
        )
        // A ZERO-CITATION answer — exactly the turn the notice exists for.
        expect(msg.citations ?? []).toEqual([])
        expect(msg.packOutcomes!.every((o) => o.found === 0 && o.admitted === 0)).toBe(true)
        // …and it is PERSISTED with that message, not an ephemeral side channel.
        expect(listMessages(db, conv.id).at(-1)?.packOutcomes).toEqual(msg.packOutcomes)
        h.hooks.respond = baseRespond
      }
      // ---- (2) ZERO HITS: the search succeeded and the archive simply had nothing ------------
      // `searched` with zero counts — a DIFFERENT fact from (1), and the user can now tell them
      // apart, which was the whole complaint.
      {
        h.hooks.respond = (url) =>
          url.startsWith('/search') ? { status: 200, body: EMPTY_SEARCH_XML } : baseRespond(url)
        const conv = newChat([alpha])
        const msg = await ask(conv.id)
        expect(msg.packOutcomes).toEqual([
          { packId: alpha, title: expect.any(String), status: 'searched', reason: null, found: 0, admitted: 0 }
        ])
        h.hooks.respond = baseRespond
      }
      // ---- (3) MISSING TOOLS: no kiwix-tools bundle at all -----------------------------------
      // The old arm returned null here, which erased every outcome. It now reports them WITHOUT
      // waking a sidecar or sending a request.
      {
        const toolless = h.newService(undefined, { resolveTools: () => null })
        const spawnsBefore = h.serveSpawns.length
        const mark = h.requests.length
        const conv = newChat([alpha, bravo])
        const msg = await ask(conv.id, toolless)
        expect(shape(msg.packOutcomes)).toEqual(
          [
            { packId: alpha, status: 'skipped', reason: 'tools-missing' },
            { packId: bravo, status: 'skipped', reason: 'tools-missing' }
          ].sort((a, b) => a.packId.localeCompare(b.packId))
        )
        expect(h.serveSpawns).toHaveLength(spawnsBefore)
        expect(searchesSince(mark)).toEqual([])
      }
      // ---- (4) A REMOVED AND A DISABLED PACK, plus an id with no row at all ------------------
      {
        const disabled = await h.registerPack('disabled.zim')
        const tombstoned = await h.registerPack('tombstoned.zim')
        db.prepare('UPDATE knowledge_packs SET enabled = 0 WHERE id = ?').run(disabled)
        db.prepare('UPDATE knowledge_packs SET removed_at = ? WHERE id = ?').run(
          new Date().toISOString(),
          tombstoned
        )
        const mark = h.requests.length
        const conv = newChat([disabled, tombstoned, 'uuid-never-registered'])
        const msg = await ask(conv.id)
        expect(shape(msg.packOutcomes)).toEqual(
          [
            { packId: disabled, status: 'skipped', reason: 'disabled' },
            { packId: tombstoned, status: 'skipped', reason: 'removed' },
            { packId: 'uuid-never-registered', status: 'skipped', reason: 'removed' }
          ].sort((a, b) => a.packId.localeCompare(b.packId))
        )
        // An id with NO registration row has no title to show — the renderer says "a removed
        // pack" rather than printing a raw UUID.
        expect(msg.packOutcomes!.find((o) => o.packId === 'uuid-never-registered')!.title).toBeNull()
        // Not one request went out for any of them.
        expect(searchesSince(mark)).toEqual([])
      }
      // ---- (5) A SERVING-NAME COLLISION LOSER: `not-served`, never searched under the winner --
      {
        const winner = await h.registerPack('Wikipédia_DE.zim', '11111111-0000-4000-8000-000000000000')
        const loser = await h.registerPack('wikipedia_de.zim', '99999999-0000-4000-8000-000000000000')
        const library = (await h.svc.ensureServer(db)) as ServedLibrary
        expect(library.names.has(loser)).toBe(false)
        const mark = h.requests.length
        const conv = newChat([loser])
        const msg = await ask(conv.id)
        expect(shape(msg.packOutcomes)).toEqual([
          { packId: loser, status: 'skipped', reason: 'not-served' }
        ])
        // The loser's UUID was never asked for — that is the point: its article text must never
        // reach an answer labelled with the winner's identity.
        expect(searchesSince(mark).filter((u) => u.includes(encodeURIComponent(loser)))).toEqual([])
        expect(winner).not.toBe(loser)
      }
      // ---- (6) MIXED: one pack answers, one fails — and the answer really cites the good one --
      {
        h.hooks.respond = (url) =>
          url.startsWith('/search') && url.includes(encodeURIComponent(bravo))
            ? { status: 500, body: 'boom' }
            : baseRespond(url)
        const conv = newChat([alpha, bravo])
        const msg = await ask(conv.id)
        const byId = new Map(msg.packOutcomes!.map((o) => [o.packId, o]))
        expect(byId.get(alpha)).toMatchObject({ status: 'searched', reason: null })
        expect(byId.get(alpha)!.found).toBeGreaterThan(0)
        expect(byId.get(alpha)!.admitted).toBeGreaterThan(0)
        expect(byId.get(bravo)).toMatchObject({ status: 'failed', reason: 'search-failed' })
        expect(msg.citations!.some((c) => c.sourceKind === 'archive' && c.packId === alpha)).toBe(true)
        h.hooks.respond = baseRespond
      }
      // ---- (7) ALL FETCHES FAILED: hits found, every article read refused --------------------
      {
        h.hooks.respond = (url) => (url.startsWith('/raw/') ? { status: 500, body: 'boom' } : baseRespond(url))
        const conv = newChat([alpha])
        const msg = await ask(conv.id)
        expect(shape(msg.packOutcomes)).toEqual([
          { packId: alpha, status: 'failed', reason: 'read-failed' }
        ])
        h.hooks.respond = baseRespond
      }
      // ---- (8) DOCUMENTS ON: a documents-only answer still records what the packs did ---------
      // Zero ARCHIVE citations, a perfectly ordinary document answer — and the outcome set is the
      // only thing standing between the user and the false read "the packs found nothing".
      {
        h.hooks.respond = (url) =>
          url.startsWith('/search') ? { status: 500, body: 'boom' } : baseRespond(url)
        const conv = newChat([alpha], false)
        const msg = await ask(conv.id)
        expect(msg.citations!.length).toBeGreaterThan(0)
        expect(msg.citations!.some((c) => c.sourceKind === 'archive')).toBe(false)
        expect(shape(msg.packOutcomes)).toEqual([
          { packId: alpha, status: 'failed', reason: 'search-failed' }
        ])
        h.hooks.respond = baseRespond
      }
      // ---- (9) TWO CHATS CONCURRENTLY, responses released in REVERSE order -------------------
      // The outcome set belongs to ONE ask. Two asks in flight whose responses land out of order
      // must not cross-write each other's message.
      {
        const gateA = serveGate<void>()
        const gateB = serveGate<void>()
        h.hooks.beforeRespond = (url) => {
          if (!url.startsWith('/search')) return Promise.resolve()
          if (url.includes(encodeURIComponent(alpha))) return gateA.wait()
          if (url.includes(encodeURIComponent(bravo))) return gateB.wait()
          return Promise.resolve()
        }
        const convA = newChat([alpha])
        const convB = newChat([bravo])
        const askA = ask(convA.id)
        await gateA.entered
        const askB = ask(convB.id)
        await gateB.entered
        // Released LAST-IN-FIRST-OUT: B's response arrives before A's.
        gateB.release()
        const msgB = await askB
        gateA.release()
        const msgA = await askA
        h.hooks.beforeRespond = async () => undefined

        expect(shape(msgA.packOutcomes)).toEqual([{ packId: alpha, status: 'searched', reason: null }])
        expect(shape(msgB.packOutcomes)).toEqual([{ packId: bravo, status: 'searched', reason: null }])
        // …and on RELOAD each conversation reads back its own set, keyed to its own message.
        expect(listMessages(db, convA.id).at(-1)).toMatchObject({ id: msgA.id })
        expect(shape(listMessages(db, convA.id).at(-1)?.packOutcomes)).toEqual([
          { packId: alpha, status: 'searched', reason: null }
        ])
        expect(shape(listMessages(db, convB.id).at(-1)?.packOutcomes)).toEqual([
          { packId: bravo, status: 'searched', reason: null }
        ])
      }
      // ---- (10) SCOPE CHANGED MID-ASK: the persisted set is the ASK-TIME one ------------------
      {
        const gate = serveGate<void>()
        h.hooks.beforeRespond = (url) => (url.startsWith('/search') ? gate.wait() : Promise.resolve())
        const conv = newChat([alpha])
        const askP = ask(conv.id)
        await gate.entered
        // The user re-ticks the popover while the answer is still streaming.
        setScope(db, conv.id, { collectionIds: [], documentIds: [], packIds: [bravo], documentsOff: true })
        gate.release()
        const msg = await askP
        h.hooks.beforeRespond = async () => undefined
        expect(shape(msg.packOutcomes)).toEqual([{ packId: alpha, status: 'searched', reason: null }])
        expect(resolveScope(db, conv.id).packIds).toEqual([bravo]) // the NEW scope stands for the next ask
        expect(shape(listMessages(db, conv.id).at(-1)?.packOutcomes)).toEqual([
          { packId: alpha, status: 'searched', reason: null }
        ])
      }
      // ---- (11) REGENERATE (delete + restore) and EXPORT --------------------------------------
      {
        const conv = newChat([alpha])
        const msg = await ask(conv.id)
        const storedBefore = (
          db.prepare('SELECT pack_outcomes_json AS j FROM messages WHERE id = ?').get(msg.id) as { j: string }
        ).j
        expect(storedBefore).not.toBeNull()
        const snapshot = deleteLastAssistantMessage(db, conv.id)
        expect(snapshot!.packOutcomesJson).toBe(storedBefore)
        restoreMessage(db, snapshot!)
        expect(
          (db.prepare('SELECT pack_outcomes_json AS j FROM messages WHERE id = ?').get(msg.id) as { j: string }).j
        ).toBe(storedBefore) // byte-identical across the regenerate round trip
        expect(shape(listMessages(db, conv.id).at(-1)?.packOutcomes)).toEqual([
          { packId: alpha, status: 'searched', reason: null }
        ])
        const { markdown } = exportTranscript(db, conv.id)
        expect(markdown).toContain('Knowledge packs:')
        expect(markdown).toMatch(/- .*: searched — \d+ passage\(s\)/)
      }
      // ---- (12) WHOLE-DOCUMENT and COMPARE: `mode`, and NOT ONE pack request ------------------
      // These paths read the document(s) by definition. Saying nothing would let the user read the
      // answer as "the packs were consulted and added nothing".
      {
        const mark = h.requests.length
        const convWhole = newChat([alpha, bravo], false)
        const whole = await ask(convWhole.id, h.svc, { wholeDocument: { documentId: docA } })
        expect(shape(whole.packOutcomes)).toEqual(
          [
            { packId: alpha, status: 'skipped', reason: 'mode' },
            { packId: bravo, status: 'skipped', reason: 'mode' }
          ].sort((a, b) => a.packId.localeCompare(b.packId))
        )
        // Titles come from the registry (a DB-only read), so the notice can name the packs.
        expect(whole.packOutcomes!.every((o) => typeof o.title === 'string')).toBe(true)

        const convCompare = newChat([alpha], false)
        const compare = await ask(convCompare.id, h.svc, {
          wholeDocumentCompare: { documentIds: [docA, docB] }
        })
        expect(shape(compare.packOutcomes)).toEqual([
          { packId: alpha, status: 'skipped', reason: 'mode' }
        ])
        // The claim these legs really pin: ZERO pack requests went out on either path.
        expect(searchesSince(mark)).toEqual([])
        expect(h.requests.slice(mark).filter((u) => u.startsWith('/raw/'))).toEqual([])
        // …and it survives the reload, like every other outcome set.
        expect(shape(listMessages(db, convWhole.id).at(-1)?.packOutcomes)).toEqual(
          shape(whole.packOutcomes)
        )
      }
    } finally {
      await h.close()
    }
    // A whole-pipeline test: twelve legs, each a REAL grounded answer over the mock runtime
    // against a real service and a real loopback sidecar. The ceiling is generous on purpose —
    // it bounds a hang, it is never the proof of anything (§10.1: every ordering fact below is a
    // controlled promise with an entered/release pair, and no leg waits on a fixed sleep).
  }, 120_000)
})

// ---- #340 — the searchability probe after Add packs… / Enable (rag-design §17 D-Z15) ----------
//
// The owner's real-drive observation (T19): a pack added through Add packs… stayed
// `searchable: unknown` — tickable, no badge — until the next Refresh or unlock, because the
// `/suggest` probe ran only at the END of a reconciliation, and an ask in between reported an
// index-less pack as "search failed" (the `/search` 404) instead of "no full-text index". The
// probe now also runs, in the background, once per completed `packs:add` batch and on
// `packs:setEnabled(…, true)` — through the SAME request guard and under the SAME cache key as
// the reconcile's probe, so a Refresh afterwards asks nothing again.
//
// Real vault, the real handlers, the real service + registry, fake kiwix children and the
// loopback stand-in; the harness's default responder 404s `/suggest` (unknown), so this suite
// answers it the way the pinned binary does (T19: a `path` title entry for every book, the
// synthetic `pattern` entry only for an indexed one). Every wait is bounded, never a fixed sleep.
describe('#340 — searchability is confirmed right after Add packs… / Enable (D-Z15)', () => {
  /** The pinned binary's /suggest shape: a title match for every book, `pattern` iff indexed. */
  const suggestFor =
    (indexed: ReadonlySet<string>) =>
    (url: string): { status: number; headers?: Record<string, string>; body: string } | null => {
      if (!url.startsWith('/suggest')) return null
      const name = new URL(url, 'http://127.0.0.1').searchParams.get('content') ?? ''
      const entries: Array<Record<string, string>> = [{ value: 'the', label: 'the', kind: 'path', path: 'A/The' }]
      if (indexed.has(name)) entries.push({ value: 'the ', label: "containing 'the'...", kind: 'pattern' })
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(entries) }
    }
  const searchableOf = (h: SessionHarness, id: string): { searchable: string | null; searchable_key: string | null } =>
    h.db().prepare('SELECT searchable, searchable_key FROM knowledge_packs WHERE id = ?').get(id) as unknown as {
      searchable: string | null
      searchable_key: string | null
    }
  const suggestsSince = (h: SessionHarness, mark: number): string[] =>
    h.requests.slice(mark).filter((u) => u.startsWith('/suggest'))

  it('#340 a pack added through packs:add (or enabled through packs:setEnabled) is probed in the background: the verdict lands without a Refresh, under the reconcile’s own cache key, the picker is told, an ask in between says "no full-text index", and a lock mid-probe writes nothing', async () => {
    const h = await sessionHarness()
    try {
      const db = h.db()
      // Serving names are the leaf without `.zim` (D-Z11), so the responder keys on the leaf.
      h.hooks.respond = suggestFor(new Set(['alpha-indexed']))

      // ---- (1) ONE add batch, two files: both confirmed, one sidecar start, no Refresh ------
      dialogState.paths = [h.addPackFile('alpha-indexed.zim'), h.addPackFile('bravo-noindex.zim')]
      const noticesBefore = h.notices.length
      const spawnsBefore = h.serveSpawns.length
      const { result } = await invoke(handlers, IPC.addKnowledgePacks)
      const added = (result as KnowledgePackAddResult).added
      expect(added).toHaveLength(2)
      const alpha = added.find((p) => p.leaf === 'alpha-indexed.zim')!.id
      const bravo = added.find((p) => p.leaf === 'bravo-noindex.zim')!.id
      // The add RESOLVED before the probe ran (D3: never on the caller's critical path).
      expect(searchableOf(h, alpha)).toEqual({ searchable: null, searchable_key: null })
      expect(searchableOf(h, bravo)).toEqual({ searchable: null, searchable_key: null })
      expect(
        await waitUntil(() => searchableOf(h, alpha).searchable === 'yes' && searchableOf(h, bravo).searchable === 'no')
      ).toBe(true)
      // Once per batch, after the loop: ONE sidecar start, one /suggest per pack.
      expect(h.serveSpawns.length - spawnsBefore).toBe(1)
      expect(suggestsSince(h, 0).filter((u) => u.includes('alpha-indexed'))).toHaveLength(1)
      expect(suggestsSince(h, 0).filter((u) => u.includes('bravo-noindex'))).toHaveLength(1)
      // The verdict is keyed exactly as the reconcile keys it: `<size>:<mtime>:<tools fingerprint>`.
      const keyAlpha = searchableOf(h, alpha).searchable_key
      expect(keyAlpha).toMatch(/^\d+:[\d.]+:.+$/)
      // …and the picker / panel were told, under THIS session's epoch, after the verdict landed.
      const mutation = h.notices.slice(noticesBefore).filter((n) => n.reason === 'mutation')
      expect(mutation.length).toBeGreaterThan(0)
      expect(mutation[mutation.length - 1]!.epoch).toBe(h.ctrl.unlockEpoch())
      // An ask in between now reports the index-less pack honestly: skipped, not failed.
      const arm = h.svc.makeArm(db, [bravo])
      const { outcomes } = await arm!('alpha climate', new AbortController().signal)
      expect(outcomes).toEqual([expect.objectContaining({ packId: bravo, status: 'skipped', reason: 'not-searchable' })])

      // ---- (2) the next Refresh asks NOTHING again — same key, verdict kept ---------------
      const mark = h.requests.length
      await h.svc.reconcile(db) // the whole pass, its end-probe included
      expect(suggestsSince(h, mark)).toEqual([])
      expect(searchableOf(h, alpha)).toEqual({ searchable: 'yes', searchable_key: keyAlpha })
      expect(searchableOf(h, bravo).searchable).toBe('no')

      // ---- (3) ENABLE after a registration that never probed ----------------------------
      // The direct service API does not schedule (the IPC layer owns the trigger); the pack
      // stays unknown through a disable, and the enable through packs:setEnabled probes it.
      const charlie = await h.registerPack('charlie-indexed.zim')
      h.hooks.respond = suggestFor(new Set(['alpha-indexed', 'charlie-indexed']))
      await invoke(handlers, IPC.setKnowledgePackEnabled, charlie, false)
      for (let i = 0; i < 10; i++) await tick() // a ceiling, not a proof: nothing probed a disable
      expect(searchableOf(h, charlie).searchable).toBeNull()
      await invoke(handlers, IPC.setKnowledgePackEnabled, charlie, true)
      expect(await waitUntil(() => searchableOf(h, charlie).searchable === 'yes')).toBe(true)

      // ---- (4) a LOCK landing while the probe's /suggest is parked writes nothing --------
      h.hooks.respond = suggestFor(new Set(['alpha-indexed', 'charlie-indexed', 'delta-indexed']))
      const probeGate = serveGate<void>()
      h.hooks.beforeRespond = async (url) => {
        if (url.startsWith('/suggest')) await probeGate.wait()
      }
      dialogState.paths = [h.addPackFile('delta-indexed.zim')]
      const { result: r4 } = await invoke(handlers, IPC.addKnowledgePacks)
      const delta = (r4 as KnowledgePackAddResult).added[0]!.id
      await probeGate.entered // the probe is inside its request when the lock arms
      const { lockP } = await parkedLock(h)
      h.hooks.beforeRespond = async () => undefined
      probeGate.release() // the response arrives — into an aborted operation
      h.releaseSuspend()
      await lockP
      expect(h.ctrl.isUnlocked()).toBe(false)
      expect(h.transientEntries()).toEqual([])
      // A fresh session through the real unlock handler: the row is still unknown (no post-lock
      // write) — and that session's reconcile-end probe then confirms it, unprompted.
      const { result: unlocked } = await invoke(handlers, IPC.unlockWorkspace, 'right-password')
      expect(unlocked).toMatchObject({ ok: true })
      expect(searchableOf(h, delta).searchable).toBeNull()
      expect(await waitUntil(() => searchableOf(h, delta).searchable === 'yes', 2_000)).toBe(true)
    } finally {
      await h.close()
    }
  }, 60_000)
})
