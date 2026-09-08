import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The first-run benchmark behind the model auto-start (PR #303 audit L1 / SD2, owner decision
// G5; benchmark.md "History per machine" → "Scheduling behind the auto-start"):
//  - `prepareFirstBenchmark` is the CHEAP half — restore / seed / backfill, synchronous, before
//    the auto-start is even called — and returns a decision; `scheduleFirstBenchmark` is the
//    MEASUREMENT half, which waits for the auto-start to settle (success OR failure) before any
//    benchmark I/O, re-checks admission / session epoch / quit latch / busy lanes / an
//    already-current result at settlement, and at the wait bound DEFERS with exactly one
//    continuation instead of running into the unfinished load;
//  - SD2: one automatic attempt per unlock session (a memo keyed on the DB handle + the epoch);
//    the next session re-checks, and a successful manual run ends the re-check;
//  - the late-write guard: a lock, or a lock + re-unlock, completing during the drive/speed
//    legs refuses the persist;
//  - the production seams (`registerWorkspaceIpc` unlock/create) run the split in that order.
//
// Every wait here is on a real completion seam (the fake runtime's start gate, the scheduler's
// outcome promise, a `vi.waitFor` on persisted state); the only clock is the injected deferral
// timer, driven by hand for the timeout case alone.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

// The measurement itself, wrapped (calling through) so a test can prove it was NOT invoked
// while a start is pending — the L1 defect was benchmark I/O during the load — and fail it on
// demand (SD2's failing machine).
const { runBenchmarkSpy } = vi.hoisted(() => ({
  runBenchmarkSpy: vi.fn<(deps: RunBenchmarkDeps) => Promise<BenchmarkResult>>()
}))
vi.mock('../../src/main/services/benchmark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/benchmark')>()
  runBenchmarkSpy.mockImplementation(actual.runBenchmark)
  return { ...actual, runBenchmark: runBenchmarkSpy }
})

import {
  BenchmarkBusyError,
  FIRST_BENCHMARK_SETTLE_TIMEOUT_MS,
  maybeRunFirstBenchmark,
  movedDriveNotice,
  prepareFirstBenchmark,
  resetFirstBenchmarkForTests,
  runAndPersistBenchmark,
  scheduleFirstBenchmark,
  type FirstBenchmarkOutcome,
  type FirstBenchmarkSchedulerDeps
} from '../../src/main/ipc/registerBenchmarkIpc'
import { maybeAutoStartActiveModel } from '../../src/main/ipc/registerModelIpc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { t } from '../../src/shared/i18n'
import { classifyProfile, detectSystem, type RunBenchmarkDeps } from '../../src/main/services/benchmark'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import { machineKey, resetPerformanceForTests } from '../../src/main/services/performance'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { WorkspaceController, createEncryptedVaultOnDisk, vaultPathsFrom } from '../../src/main/services/workspace-vault'
import { IPC } from '../../src/shared/ipc'
import type { AppSettings, BenchmarkResult, GpuDevice, HardwareProfile, PrivacyPolicy, RuntimeStatus } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import {
  closePerformanceFixture,
  ctxWith,
  freshRoot,
  hereResult,
  performanceChangedSpy,
  result,
  seededDb,
  stoppedStatus
} from '../helpers/performance-fixture'

const handlers = ipcState.handlers as unknown as IpcHandlers
const REPO_MANIFESTS = join(__dirname, '..', '..', '..', '..', 'model-manifests')
/** A catalog chat model with no weights under the test roots: developer leniency lets the
 *  auto-start reach `runtime.start` through the mock-fallback path (the core-model-ipc idiom). */
const CHAT_MODEL = 'qwen3-4b-instruct-q4'
const PASSWORD = 'right-password'
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

const here = (): string | null => machineKey(detectSystem())
/** The card of the #330 round trip — the one the probe was too slow to enumerate. */
const RTX_DEVICE: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
/** One macrotask hop — room for a wrong implementation to (wrongly) start I/O before an assert. */
const hop = (): Promise<void> => new Promise((r) => setImmediate(r))
async function hops(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await hop()
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A chat runtime stub whose stream yields a couple of chunks with timings — enough for the
 * speed leg. `onChunk` runs BETWEEN the two yields: the window in which a manual "Use model"
 * lands beside a running benchmark (#393). With `rejectAfterHook` the generator then THROWS
 * instead of yielding the second chunk — the killed sidecar, whose iterator rejects rather
 * than delivering another chunk (the realistic #334 leg S5 timing: chunks are ~125 ms apart at
 * 8 tok/s, the `startingModelId` flip → the stop is one microtask).
 */
function stubRuntime(
  onChunk?: () => void,
  opts?: { rejectAfterHook?: boolean; modelId?: string; perSecond?: number }
): ModelRuntime {
  return {
    modelId: opts?.modelId ?? 'stub-chat',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
      yield 'a'
      onChunk?.()
      if (opts?.rejectAfterHook) throw new Error('model stopped')
      yield 'b'
      options?.onFinish?.('length', { predicted_n: 2, predicted_per_second: opts?.perSecond ?? 20 })
    }
  }
}

/**
 * The runtime manager's surface the auto-start and the benchmark read, with a `start` that
 * parks on a gate (the multi-GB load window) until the test releases or fails it, and
 * `status()` / `active()` that flip with it.
 */
interface FakeRuntime {
  occupancy: ModelOccupancy
  active: () => ModelRuntime | null
  activeModelId: () => string | null
  status: () => RuntimeStatus
  isShutdown: () => boolean
  start: (opts: RuntimeStartOptions) => Promise<RuntimeStatus>
  stop: () => Promise<void>
  startCalls: number
  /** Resolves when `start` was invoked — the auto-start got past its install check. */
  startReached: Promise<RuntimeStartOptions>
  finishStart: () => void
  failStart: (err: Error) => void
  /**
   * A manual "Use model" enqueued beside a run (#393): sets `startingModelId` and resolves
   * NOTHING, modelling `RuntimeManager.start()`'s synchronous flip (index.ts:519), which
   * precedes the queued `doStart`'s stop of the running model (index.ts:608).
   */
  enqueueManualStart: (modelId: string) => void
  /**
   * That start COMPLETING beside the run (#393): the flag goes back to null and the manager
   * commits a NEW runtime object (`this.current = this.decorateWithGenerationGate(next)`,
   * index.ts:640) — the one the leg captured is dead and is no longer what `active()` hands out.
   */
  completeManualStart: (modelId: string) => void
  /** Install the running runtime, once, the way a committed start does (identity is stable). */
  setCurrent: (next: ModelRuntime | null) => void
  quit: () => void
}

function fakeRuntime(opts: { ready?: boolean; onStart?: () => void } = {}): FakeRuntime {
  let current: ModelRuntime | null = opts.ready ? stubRuntime() : null
  let starting: string | null = null
  let shutdown = false
  const reached = deferred<RuntimeStartOptions>()
  const gate = deferred()
  gate.promise.catch(() => undefined) // a failed start observed only inside `start`
  const rt: FakeRuntime = {
    occupancy: new ModelOccupancy(),
    active: () => current,
    activeModelId: () => current?.modelId ?? null,
    status: () =>
      current
        ? // A start in flight while some model runs is the manager's `switchingId`
          // (`RuntimeManager.status()`, index.ts:706) — null while the SAME model is starting.
          {
            running: true,
            modelId: current.modelId,
            port: 1,
            healthy: true,
            message: 'Running',
            backend: 'cpu',
            startingModelId: starting === current.modelId ? null : starting
          }
        : { ...stoppedStatus(), message: starting ? 'Starting' : 'Stopped', startingModelId: starting },
    isShutdown: () => shutdown,
    startCalls: 0,
    start: async (o) => {
      rt.startCalls += 1
      starting = o.modelId
      opts.onStart?.()
      reached.resolve(o)
      try {
        await gate.promise
      } finally {
        starting = null
      }
      current = stubRuntime()
      return rt.status()
    },
    stop: async () => {
      current = null
    },
    startReached: reached.promise,
    finishStart: () => gate.resolve(),
    failStart: (err) => gate.reject(err),
    enqueueManualStart: (modelId) => {
      starting = modelId
    },
    completeManualStart: (modelId) => {
      starting = null
      current = stubRuntime(undefined, { modelId })
    },
    setCurrent: (next) => {
      current = next
    },
    quit: () => {
      shutdown = true
    }
  }
  return rt
}

/** The injected deferral clock: arms one callback, fired by hand; a cancel disarms it. */
function fakeTimer(): {
  timer: NonNullable<FirstBenchmarkSchedulerDeps['timer']>
  armed: number[]
  cancelled: number
  fire: () => void
} {
  let pending: (() => void) | null = null
  const state = {
    armed: [] as number[],
    cancelled: 0,
    fire: (): void => {
      const fn = pending
      pending = null
      fn?.()
    },
    timer: (fn: () => void, ms: number): (() => void) => {
      state.armed.push(ms)
      pending = fn
      return () => {
        state.cancelled += 1
        pending = null
      }
    }
  }
  return state
}

/** A context the REAL `maybeAutoStartActiveModel` can drive against the fake runtime. */
function autoStartCtx(root: string, db: Db, runtime: FakeRuntime, over: Record<string, unknown> = {}): AppContext {
  return ctxWith(root, db, {
    manifestsDir: REPO_MANIFESTS,
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'no-such-config') },
    runtime,
    ...over
  })
}

/** A session-aware workspace stand-in (the core-model-ipc shape): flags plus the epoch counter. */
function sessionWorkspace(): {
  isUnlocked: () => boolean
  isLocking: () => boolean
  unlockEpoch: () => number
  beginLock: () => void
  completeLock: () => void
  completeUnlock: () => void
} {
  let unlocked = true
  let locking = false
  let epoch = 1
  return {
    isUnlocked: () => unlocked,
    isLocking: () => locking,
    unlockEpoch: () => epoch,
    beginLock: () => {
      locking = true
    },
    completeLock: () => {
      locking = true
      unlocked = false
    },
    completeUnlock: () => {
      locking = false
      unlocked = true
      epoch += 1
    }
  }
}

/** A context wired like production for the workspace IPC seams: `db` resolves through the controller. */
function seamCtx(root: string, ctrl: WorkspaceController, runtime: FakeRuntime, probeGpu?: CachedGpuProbe): AppContext {
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
    get db() {
      return ctrl.requireDb()
    },
    workspace: ctrl,
    runtime,
    manifestsDir: REPO_MANIFESTS,
    probeGpu,
    isDev: true
  } as unknown as AppContext
  registerWorkspaceIpc(ctx)
  return ctx
}

/** The session-cached probe seam, driven by hand — the injected fn never spawns anything. */
function fakeProbe(impl: () => Promise<GpuDevice[] | null>): CachedGpuProbe & { calls: () => number } {
  let calls = 0
  const probe = (_bin: string): Promise<GpuDevice[] | null> => {
    calls += 1
    return impl()
  }
  return Object.assign(probe, { invalidate: () => undefined, calls: () => calls })
}

/** A drive root with a placeholder `llama-server`, so `probeAndPersistGpu` resolves a binary. */
function withBinary(root: string): void {
  mkdirSync(llamaServerDir(root), { recursive: true })
  writeFileSync(join(llamaServerDir(root), llamaServerBinaryName()), 'fake-binary')
}

/** An encrypted vault whose settings hold `seed`, LOCKED, so the unlock handler opens it. */
function lockedVault(
  seed: Partial<AppSettings>,
  runtime: FakeRuntime,
  probeGpu?: CachedGpuProbe
): { ctrl: WorkspaceController; ctx: AppContext; root: string } {
  const root = freshRoot()
  mkdirSync(join(root, 'config'), { recursive: true })
  const vp = vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'hilbertraum.sqlite') })
  createEncryptedVaultOnDisk(vp, PASSWORD, FAST_KDF)
  const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctrl.init()
  ctrl.unlock(PASSWORD)
  updateSettings(ctrl.requireDb(), seed)
  ctrl.lock()
  return { ctrl, ctx: seamCtx(root, ctrl, runtime, probeGpu), root }
}

/** A foreign headline with no local history: the new-computer decision, seeded synchronously. */
function movedToNewMachine(db: Db): BenchmarkResult {
  const foreign = result()
  updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })
  return foreign
}

beforeEach(() => {
  ipcState.handlers.clear()
  runBenchmarkSpy.mockClear()
  resetFirstBenchmarkForTests()
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  setPerformanceChangedSink(null)
  inFlightStreams.clear()
})

// TH2: every root here comes from the fixture's `freshRoot` (directly, or via `lockedVault`);
// the DBs `lockedVault`/`seamCtx` open through a real `WorkspaceController` are outside the
// `seededDb` registry, but every test using them calls `ctrl.lock()` (which closes its DB)
// before returning, so by the time this runs there is nothing left open on those roots either.
afterEach(closePerformanceFixture)

describe('prepareFirstBenchmark: the cheap half', () => {
  it('a fresh workspace owes a first run; a known computer is restored synchronously and owes nothing; a legacy blob owes nothing', () => {
    const root = freshRoot()
    const fresh = seededDb(root)
    expect(prepareFirstBenchmark(ctxWith(root, fresh))).toEqual({
      run: 'first-run',
      attempted: false,
      epoch: undefined,
      hereKey: here(),
      // #380: no probe fires on a first run (there is no benchmark to refresh beside), so this
      // is the already-resolved placeholder — the seam's auto-start is not delayed at all.
      probed: expect.any(Promise)
    })

    const db = seededDb(root)
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })
    const spy = performanceChangedSpy(() => getSettings(db).lastBenchmark?.ranAt)
    expect(prepareFirstBenchmark(ctxWith(root, db))).toMatchObject({ run: null, attempted: false })
    // Restored — and pushed — before the call returns: nothing to await. Two pushes, in order:
    // the once-per-session probe refresh of a root without a binary persists the EMPTY stamped
    // probe (PR #308 decision 6; `lastBenchmark` is still the foreign one when it fires), then
    // the restore.
    expect(getSettings(db).lastBenchmark).toEqual(known)
    expect(spy.mock.results.map((r) => r.value)).toEqual([foreign.ranAt, known.ranAt])

    const legacy = seededDb(root)
    updateSettings(legacy, { lastBenchmark: { profile: 'BALANCED' } as unknown as BenchmarkResult })
    expect(prepareFirstBenchmark(ctxWith(root, legacy))).toMatchObject({ run: null, attempted: false })
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
  })

  it('a locked workspace (or one whose lock is under way) owes nothing and captures no session', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    ws.beginLock()
    expect(prepareFirstBenchmark(ctxWith(root, db, { workspace: ws }))).toEqual({
      run: null,
      attempted: false,
      epoch: undefined,
      hereKey: null,
      probed: expect.any(Promise)
    })
    ws.completeLock()
    expect(prepareFirstBenchmark(ctxWith(root, db, { workspace: ws }))).toMatchObject({ run: null })
  })

  it('the synthetic moved drive: the foreign headline is seeded before the run is owed, and the whole prepare → schedule → persist path files both computers', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign }) // an upgraded workspace: no history row yet
    const ctx = ctxWith(root, db)
    const spy = performanceChangedSpy(() => getSettings(db).benchmarkHistory.map((e) => e.cpuModel))

    const decision = prepareFirstBenchmark(ctx)

    expect(decision).toMatchObject({ run: 'new-machine', attempted: false, hereKey: here() })
    // Seeded synchronously (M4), with its push, before any measurement.
    expect(getSettings(db).benchmarkHistory).toEqual([foreign])
    // [the empty-probe write of a root without a binary (history still empty), the seed]
    expect(spy.mock.results.map((r) => r.value)).toEqual([[], [foreign.cpuModel]])
    expect(runBenchmarkSpy).not.toHaveBeenCalled()

    await expect(scheduleFirstBenchmark(ctx, decision, Promise.resolve())).resolves.toBe('ran')

    const s = getSettings(db)
    expect(machineKey(s.lastBenchmark)).toBe(here())
    expect(s.benchmarkHistory.map((e) => machineKey(e))).toEqual([here(), machineKey(foreign)])
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
  })
})

// §5 item 22 (a), owner decision 2026-09-08: the moved-drive check used to be entirely silent —
// it either restored this computer's stored result (re-measuring NOTHING) or owed a background
// measurement, and the user was told neither. `movedDriveNotice` is the session state Home reads.
// The teeth here are the DISTINCTIONS: a restore is not a measurement, an owed run that never
// happened is not a run in progress, and a same-machine launch says nothing at all.
describe('movedDriveNotice: what the moved-drive check did (§5 item 22 (a))', () => {
  it('says nothing on an ordinary same-machine launch, a fresh workspace, or a legacy blob', () => {
    const root = freshRoot()
    // A fresh workspace owes a FIRST RUN — which is not a moved drive, and must not borrow this
    // notice: "this drive has not been used on this computer before" would be a lie about a
    // workspace that has never been used anywhere.
    const fresh = seededDb(root)
    const freshCtx = ctxWith(root, fresh)
    expect(prepareFirstBenchmark(freshCtx)).toMatchObject({ run: 'first-run' })
    expect(movedDriveNotice(freshCtx)).toBeNull()

    const same = seededDb(root)
    updateSettings(same, { lastBenchmark: hereResult() })
    const sameCtx = ctxWith(root, same)
    prepareFirstBenchmark(sameCtx)
    expect(movedDriveNotice(sameCtx)).toBeNull()

    const legacy = seededDb(root)
    updateSettings(legacy, { lastBenchmark: { profile: 'BALANCED' } as unknown as BenchmarkResult })
    const legacyCtx = ctxWith(root, legacy)
    prepareFirstBenchmark(legacyCtx)
    expect(movedDriveNotice(legacyCtx)).toBeNull()
  })

  it('a RESTORE says so and carries the restored result’s own date — nothing was re-measured', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })
    const ctx = ctxWith(root, db)

    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null })
    // The date is the RESTORED result's, not "now": that is the whole point — the figures the
    // user is about to read on Performance were measured then.
    expect(movedDriveNotice(ctx)).toEqual({ kind: 'restored', ranAt: known.ranAt })
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
  })

  it('a NEW computer says a check is running, and stops saying so once the run lands', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    movedToNewMachine(db)
    const ctx = ctxWith(root, db)

    const decision = prepareFirstBenchmark(ctx)
    expect(decision).toMatchObject({ run: 'new-machine' })
    // While it is owed AND running, the notice claims exactly that — and Home renders no action
    // for this state, so it never asks for a check that is already under way.
    expect(movedDriveNotice(ctx)).toEqual({ kind: 'measuring' })

    await expect(scheduleFirstBenchmark(ctx, decision, Promise.resolve())).resolves.toBe('ran')
    // A measured result for this computer exists now: there is nothing left to say.
    expect(movedDriveNotice(ctx)).toBeNull()
  })

  it('an owed run that is SKIPPED stops claiming a check is running, and offers one instead', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    movedToNewMachine(db)
    const ctx = ctxWith(root, db)

    const decision = prepareFirstBenchmark(ctx)
    expect(movedDriveNotice(ctx)).toEqual({ kind: 'measuring' })

    // Another lane owns the model at settlement — the ordinary `skipped-busy` outcome. (A skill
    // run, not a doc task: the doc-task span is answered through `ctx.docTasks`, which a bare
    // fixture context does not wire.) Without this transition the notice would claim
    // "a check is running in the background" for the rest of the session, and no check would
    // ever run (SD2: one automatic attempt per unlock).
    const release = ctx.runtime.occupancy.begin('skill-run')
    await expect(scheduleFirstBenchmark(ctx, decision, Promise.resolve())).resolves.toBe('skipped-busy')
    release()
    expect(movedDriveNotice(ctx)).toEqual({ kind: 'owed' })
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
  })

  it('a manual check clears the notice, whichever state was standing', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })
    const ctx = ctxWith(root, db)

    prepareFirstBenchmark(ctx)
    expect(movedDriveNotice(ctx)).toMatchObject({ kind: 'restored' })

    // This is what the notice's "Check this computer" leads to on the Performance screen.
    await runAndPersistBenchmark(ctx)
    expect(movedDriveNotice(ctx)).toBeNull()
  })

  it('is session-scoped: another workspace handle sees nothing', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, hereResult()] })
    const ctx = ctxWith(root, db)
    prepareFirstBenchmark(ctx)
    expect(movedDriveNotice(ctx)).toMatchObject({ kind: 'restored' })

    // A different DB handle is a different session (the key `attemptMemo` uses): the notice is
    // not global state leaking across workspaces.
    const other = seededDb(freshRoot())
    expect(movedDriveNotice(ctxWith(root, other))).toBeNull()
  })
})

describe('scheduleFirstBenchmark: runs at once when nothing is starting', () => {
  it('a fresh workspace with no active model: the auto-start settles immediately and the run lands', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const rt = fakeRuntime()
    const ctx = autoStartCtx(root, db, rt)

    const decision = prepareFirstBenchmark(ctx)
    const started = maybeAutoStartActiveModel(ctx)
    await expect(scheduleFirstBenchmark(ctx, decision, started)).resolves.toBe('ran')

    expect(rt.startCalls).toBe(0)
    expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
    expect(getSettings(db).lastBenchmark?.tokensPerSecond).toBeNull()
  })

  it('auto-start disabled: the run lands at once, nothing is started', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { activeModelId: CHAT_MODEL, autoStartActiveModel: false })
    const rt = fakeRuntime()
    const ctx = autoStartCtx(root, db, rt)

    const started = maybeAutoStartActiveModel(ctx)
    await expect(scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), started)).resolves.toBe('ran')

    expect(rt.startCalls).toBe(0)
    expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
  })

  it('an already-ready runtime: the run lands at once and the speed leg sees it', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { activeModelId: CHAT_MODEL })
    const rt = fakeRuntime({ ready: true })
    const ctx = autoStartCtx(root, db, rt)

    const started = maybeAutoStartActiveModel(ctx) // "something is already running — keep it"
    await expect(scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), started)).resolves.toBe('ran')

    expect(rt.startCalls).toBe(0)
    expect(runBenchmarkSpy.mock.calls[0][0].runtime).not.toBeNull()
    expect(getSettings(db).lastBenchmark).toMatchObject({ tokensPerSecond: 20, measuredModelId: 'stub-chat' })
  })
})

describe('a model start in flight beside the speed leg (#393)', () => {
  /**
   * A crawl: strictly below `VERY_LOW_TOKENS_PER_SECOND` (3), so a run that MEASURES it steps
   * the profile one rung down. That is what makes the profile assertions below discriminating —
   * the stub's usual 20 tok/s classifies exactly like no reading at all.
   */
  const CRAWL_TPS = 2

  /**
   * One run of the fixture, with the runtime the manager holds built by `build`. A separate
   * root/DB each time: the SD2 memo is keyed on the DB handle.
   *
   * The runtime is installed ONCE, so `active()` hands out the same object on every call —
   * `RuntimeManager.active()` returns `this.current`, a single decorator instance per committed
   * start (runtime/index.ts:640/677), and the leg's identity check reads exactly that.
   */
  async function runOnce(build: (rt: FakeRuntime) => ModelRuntime): Promise<BenchmarkResult> {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { activeModelId: CHAT_MODEL })
    const rt = fakeRuntime({ ready: true })
    const ctx = autoStartCtx(root, db, rt)
    rt.setCurrent(build(rt))
    // Nothing is starting when the run is scheduled (the settlement re-check passes); the
    // manual start arrives later, mid-stream, which is exactly the #393 window.
    await expect(scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), Promise.resolve())).resolves.toBe('ran')
    const saved = getSettings(db).lastBenchmark
    expect(saved).not.toBeNull()
    return saved as BenchmarkResult
  }

  /** The two classifications a run on THIS host can land on: with no speed input, and with a crawl. */
  const profiles = (): { noSpeed: HardwareProfile; stepped: HardwareProfile } => {
    const ramGb = detectSystem().ramGb
    // The same inputs `runBenchmark` classifies with here: no usable GPU (these roots carry no
    // probe binary, so the probe reports no devices).
    return {
      noSpeed: classifyProfile(ramGb, { tokensPerSecond: null, gpuUseful: false }),
      stepped: classifyProfile(ramGb, { tokensPerSecond: CRAWL_TPS, gpuUseful: false })
    }
  }

  it('a manual start enqueued during the run skips the speed leg with the warning, profile untouched (#393)', async () => {
    const { noSpeed, stepped } = profiles()
    // The sibling run measures a CRAWL, so its profile is stepped DOWN. Unless this host is
    // already on the lowest rung (RAM ≤ 8 GB and no useful GPU, where `Math.max(idx - 1, 0)` is
    // a no-op), the two classifications differ and the comparison below can genuinely fail.
    const slow = await runOnce(() => stubRuntime(undefined, { perSecond: CRAWL_TPS }))
    expect(slow.tokensPerSecond).toBe(CRAWL_TPS)
    expect(slow.profile).toBe(stepped)

    // "Use model" on ANOTHER model, pressed between two streamed chunks: `startingModelId` is
    // set synchronously, strictly before the queued `doStart` stops the model we stream on.
    const saved = await runOnce((rt) => stubRuntime(() => rt.enqueueManualStart('some-other-model')))

    expect(saved).toMatchObject({ tokensPerSecond: null, measuredModelId: null })
    expect(saved.warnings).toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
    // The rest of the result is untouched: the profile is the no-speed classification from RAM
    // and GPU alone — a skipped leg never steps it down, the way a measured crawl would.
    expect(saved.profile).toBe(noSpeed)
    if (stepped !== noSpeed) expect(saved.profile).not.toBe(slow.profile)
  })

  it('a start that stops the model between two chunks still yields the skipped warning, not a silent null (#393)', async () => {
    const { noSpeed } = profiles()

    // The realistic S5 timing: the stop lands BETWEEN chunks, so the iterator rejects instead
    // of delivering one and the per-chunk check never fires — the catch must warn all the same.
    const saved = await runOnce((rt) =>
      stubRuntime(() => rt.enqueueManualStart('some-other-model'), { rejectAfterHook: true })
    )

    // `tokensPerSecond` is already null on the unfixed code (the catch returned null silently) —
    // the WARNING is what discriminates here: without it the missing figure has no explanation.
    expect(saved).toMatchObject({ tokensPerSecond: null, measuredModelId: null })
    expect(saved.warnings).toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
    expect(saved.profile).toBe(noSpeed)
  })

  it('a start that COMPLETED between the runtime capture and the leg skips it too (#393)', async () => {
    // The gap the review found: `runBenchmarkAndPersist` captures `ctx.runtime.active()` before
    // the GPU + drive probes. A start that COMPLETES in that window puts `startingModelId` back
    // to null and commits a NEW runtime — the captured one is dead, so neither the lane check nor
    // the start-in-flight check sees anything. The manager no longer holding the captured object
    // is the signal.
    const saved = await runOnce((rt) => stubRuntime(() => rt.completeManualStart('some-other-model')))

    expect(saved).toMatchObject({ tokensPerSecond: null, measuredModelId: null })
    expect(saved.warnings).toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })

  it('a completed start whose stop also killed the captured stream warns rather than going silent (#393)', async () => {
    const saved = await runOnce((rt) =>
      stubRuntime(() => rt.completeManualStart('some-other-model'), { rejectAfterHook: true })
    )

    expect(saved).toMatchObject({ tokensPerSecond: null, measuredModelId: null })
    expect(saved.warnings).toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })

  it('nothing starting: the speed leg measures as before', async () => {
    const saved = await runOnce(() => stubRuntime())

    expect(saved).toMatchObject({ tokensPerSecond: 20, measuredModelId: 'stub-chat' })
    expect(saved.warnings).not.toContain(t('en', 'main.benchmark.warnSpeedSkipped'))
  })
})

describe('behind a pending model start', () => {
  it('no benchmark I/O while the start is pending; once it resolves the run measures the started runtime', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { activeModelId: CHAT_MODEL })
    const rt = fakeRuntime()
    const ctx = autoStartCtx(root, db, rt)
    const spy = performanceChangedSpy()

    const decision = prepareFirstBenchmark(ctx)
    const started = maybeAutoStartActiveModel(ctx)
    const outcome = scheduleFirstBenchmark(ctx, decision, started)

    // The auto-start reached the manager (its install check done) and is parked in the load.
    await rt.startReached
    await hops(5)
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(rt.occupancy.held('benchmark')).toBe(false)
    expect(spy).not.toHaveBeenCalled() // no span taken, so no "running" push either
    expect(getSettings(db).lastBenchmark).toBeNull()

    rt.finishStart()
    await expect(outcome).resolves.toBe('ran')

    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    // L1's second half: the leg saw the runtime the start brought up, not the null captured earlier.
    expect(runBenchmarkSpy.mock.calls[0][0].runtime?.modelId).toBe('stub-chat')
    expect(getSettings(db).lastBenchmark).toMatchObject({ tokensPerSecond: 20, measuredModelId: 'stub-chat' })
    // The run's own start push, its probe write (the EMPTY stamped probe of a root without a
    // binary, PR #308 decision 6) and the idle push; prepare pushed nothing (a first run owes
    // the probe to the run itself).
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('a FAILED start still permits the run — without the speed leg', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { activeModelId: CHAT_MODEL })
    const rt = fakeRuntime()
    const ctx = autoStartCtx(root, db, rt)

    const decision = prepareFirstBenchmark(ctx)
    const started = maybeAutoStartActiveModel(ctx)
    const outcome = scheduleFirstBenchmark(ctx, decision, started)
    await rt.startReached
    rt.failStart(new Error('health timeout'))

    await expect(started).resolves.toBeUndefined() // the auto-start never rejects
    await expect(outcome).resolves.toBe('ran')
    expect(runBenchmarkSpy.mock.calls[0][0].runtime).toBeNull()
    expect(getSettings(db).lastBenchmark).toMatchObject({ tokensPerSecond: null, measuredModelId: null })
  })

  it('a bare pending settlement: nothing runs until it settles, and the deferral timer is cleared once it does', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    const settled = deferred()
    const clock = fakeTimer()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise, { timer: clock.timer })

    expect(clock.armed).toEqual([FIRST_BENCHMARK_SETTLE_TIMEOUT_MS])
    await hops(5)
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(getSettings(db).lastBenchmark).toBeNull()

    settled.resolve()
    await expect(outcome).resolves.toBe('ran')
    expect(clock.cancelled).toBe(1)
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
  })
})

describe('the deferral boundary', () => {
  it('at the timeout: "deferred", still no I/O, exactly one continuation registered', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    const settled = deferred()
    const clock = fakeTimer()
    const onContinuation = vi.fn<(p: Promise<FirstBenchmarkOutcome>) => void>()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise, {
      timer: clock.timer,
      onContinuation
    })
    clock.fire()

    await expect(outcome).resolves.toBe('deferred')
    expect(onContinuation).toHaveBeenCalledTimes(1)
    await hops(5)
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(getSettings(db).lastBenchmark).toBeNull()
  })

  it('late settlement after the timeout: the continuation runs once; a second settlement or scheduling runs nothing', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    const settled = deferred()
    const clock = fakeTimer()
    let continuation: Promise<FirstBenchmarkOutcome> | null = null
    const decision = prepareFirstBenchmark(ctx)

    const outcome = scheduleFirstBenchmark(ctx, decision, settled.promise, {
      timer: clock.timer,
      onContinuation: (p) => {
        continuation = p
      }
    })
    clock.fire()
    await expect(outcome).resolves.toBe('deferred')

    settled.resolve()
    await expect(continuation!).resolves.toBe('ran')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())

    // Scheduled again in the same session with the stale decision: SD2 refuses; prepared afresh:
    // the workspace now holds this computer's result, so nothing is owed.
    await expect(scheduleFirstBenchmark(ctx, decision, Promise.resolve())).resolves.toBe('skipped-attempted')
    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('not-needed')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
  })
})

describe('settlement re-checks', () => {
  it('a lock completing during the wait → skipped-admission', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    const foreign = movedToNewMachine(db)
    const settled = deferred()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise)
    ws.completeLock()
    settled.resolve()

    await expect(outcome).resolves.toBe('skipped-admission')
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(getSettings(db).lastBenchmark).toEqual(foreign)
  })

  it('a lock UNDER WAY at settlement (DB still open, latch armed) → skipped-admission', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    movedToNewMachine(db)
    const settled = deferred()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise)
    ws.beginLock()
    expect(ws.isUnlocked()).toBe(true)
    settled.resolve()

    await expect(outcome).resolves.toBe('skipped-admission')
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
  })

  it('a lock AND a re-unlock during the wait (the flags look untouched, the epoch does not) → skipped-epoch', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    movedToNewMachine(db)
    const settled = deferred()

    const decision = prepareFirstBenchmark(ctx)
    expect(decision.epoch).toBe(1)
    const outcome = scheduleFirstBenchmark(ctx, decision, settled.promise)
    ws.completeLock()
    ws.completeUnlock()
    expect(ws.isUnlocked()).toBe(true)
    expect(ws.isLocking()).toBe(false)
    settled.resolve()

    await expect(outcome).resolves.toBe('skipped-epoch')
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    // The NEW session owes its own check — and makes its own attempt.
    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('ran')
  })

  it('a quit during the wait → skipped-shutdown', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const rt = fakeRuntime()
    const ctx = ctxWith(root, db, { runtime: rt })
    const settled = deferred()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise)
    rt.quit()
    settled.resolve()

    await expect(outcome).resolves.toBe('skipped-shutdown')
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
  })

  it('a lane holding the model at settlement → skipped-busy, no retry, no push', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    const spy = performanceChangedSpy()

    // Another benchmark's span (the #185 re-entrancy guard).
    const release = ctx.runtime.occupancy.begin('benchmark')
    const settled = deferred()
    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise)
    settled.resolve()
    await expect(outcome).resolves.toBe('skipped-busy')
    release()

    // The user's first message (the foreground lane), in a fresh session.
    resetFirstBenchmarkForTests()
    inFlightStreams.set('chat', new AbortController())
    try {
      await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('skipped-busy')
      // The refusal the run itself throws is the typed one the scheduler maps.
      await expect(runAndPersistBenchmark(ctx)).rejects.toBeInstanceOf(BenchmarkBusyError)
      await expect(runAndPersistBenchmark(ctx)).rejects.toMatchObject({ lane: 'chat' })
    } finally {
      inFlightStreams.clear()
    }
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    expect(getSettings(db).lastBenchmark).toBeNull()
  })

  it('a manual benchmark completing while waiting → skipped-already-current', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    movedToNewMachine(db)
    const settled = deferred()

    const outcome = scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), settled.promise)
    const manual = await runAndPersistBenchmark(ctx)
    settled.resolve()

    await expect(outcome).resolves.toBe('skipped-already-current')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1) // the manual run only
    expect(getSettings(db).lastBenchmark?.ranAt).toBe(manual.ranAt)
  })
})

describe('SD2: one automatic attempt per unlock session', () => {
  it('repeated scheduling in one session → skipped-attempted (the same decision twice, a second prepare, a concurrent wrapper call)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ctx = ctxWith(root, db)
    const settled = deferred()

    const d1 = prepareFirstBenchmark(ctx)
    const first = scheduleFirstBenchmark(ctx, d1, settled.promise)
    await expect(scheduleFirstBenchmark(ctx, d1, Promise.resolve())).resolves.toBe('skipped-attempted')
    const d2 = prepareFirstBenchmark(ctx)
    expect(d2).toMatchObject({ run: null, attempted: true })
    await expect(scheduleFirstBenchmark(ctx, d2, Promise.resolve())).resolves.toBe('skipped-attempted')
    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('skipped-attempted')
    expect(runBenchmarkSpy).not.toHaveBeenCalled()

    settled.resolve()
    await expect(first).resolves.toBe('ran')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
  })

  it('a failed new-computer run is not retried in the session; the next session re-checks and runs', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    const foreign = movedToNewMachine(db)
    runBenchmarkSpy.mockRejectedValueOnce(new Error('drive probe blew up'))
    const spy = performanceChangedSpy(() => ctx.runtime.occupancy.held('benchmark'))

    const d1 = prepareFirstBenchmark(ctx)
    expect(d1).toMatchObject({ run: 'new-machine', attempted: false, epoch: 1 })
    await expect(scheduleFirstBenchmark(ctx, d1, Promise.resolve())).resolves.toBe('failed')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    expect(getSettings(db).lastBenchmark).toEqual(foreign)
    // Five pushes: the once-per-session probe refresh at prepare (the EMPTY stamped probe of a
    // root without a binary, PR #308 decision 6; no span held), then the failed run still
    // bracketed itself — the running push, the run's own probe write (held), the idle push
    // after the release — and finally the moved-drive notice's own (§5 item 22 (a)): the run's
    // idle push fired BEFORE the notice moved from "measuring" to "owed", so without this fifth
    // one an already-open Home would keep claiming a check is running. The span is released by
    // then, hence `false`. A run that PERSISTS pushes no extra one (it clears the notice before
    // its own idle push), which is why only this failure path grew a push.
    expect(spy.mock.results.map((r) => r.value)).toEqual([false, true, true, false, false])

    // The same session asks again (a second unlock landing on an already-open workspace, any
    // later caller): no retry.
    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: true, epoch: 1 })
    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('skipped-attempted')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)

    // Lock + unlock: a new session re-checks — and this time the measurement lands.
    ws.completeLock()
    ws.completeUnlock()
    const d3 = prepareFirstBenchmark(ctx)
    expect(d3).toMatchObject({ run: 'new-machine', attempted: false, epoch: 2 })
    await expect(scheduleFirstBenchmark(ctx, d3, Promise.resolve())).resolves.toBe('ran')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(2)
    expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
  })

  it('a successful MANUAL run ends the re-check: the next prepare owes nothing, in this session and the next', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    movedToNewMachine(db)
    runBenchmarkSpy.mockRejectedValueOnce(new Error('no binary'))

    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('failed')
    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: true })

    await runAndPersistBenchmark(ctx) // Diagnostics → Run benchmark

    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: false })
    ws.completeLock()
    ws.completeUnlock()
    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: false })
    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('not-needed')
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(2) // the failed automatic one + the manual one
  })
})

describe('the late-write guard (runAndPersistBenchmark)', () => {
  // A-D2: the refusal is the localized emission — one message for a completed lock, a lock under
  // way and a lock-and-re-unlock (the log lines tell them apart), never a raw English string.
  const notSaved = t('en', 'main.benchmark.lockedDuringRun')

  it.each([
    ['a lock completed', (ws: ReturnType<typeof sessionWorkspace>) => ws.completeLock()],
    ['a lock under way (DB open, latch armed)', (ws: ReturnType<typeof sessionWorkspace>) => ws.beginLock()]
  ])('%s between the legs and the persist: rejects, writes nothing, the idle push still follows the release', async (_label, lock) => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    const foreign = movedToNewMachine(db)
    const spy = performanceChangedSpy(() => ctx.runtime.occupancy.held('benchmark'))

    await expect(
      runAndPersistBenchmark(ctx, (step) => {
        if (step === 'done') lock(ws) // lands after the probes, right before the persist
      })
    ).rejects.toThrow(notSaved)

    expect(getSettings(db).lastBenchmark).toEqual(foreign)
    expect(getSettings(db).benchmarkHistory).toEqual([foreign])
    // Running, the run's own probe write (the EMPTY stamped probe of a root without a binary,
    // PR #308 decision 6 — it lands before the lock, with the span held), idle after the release.
    expect(spy.mock.results.map((r) => r.value)).toEqual([true, true, false])
    expect(ctx.runtime.occupancy.held('benchmark')).toBe(false)
  })

  it('a lock AND a re-unlock between the legs and the persist: rejects (the epoch moved); the same session persists', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    const foreign = movedToNewMachine(db)

    await expect(
      runAndPersistBenchmark(ctx, (step) => {
        if (step === 'done') {
          ws.completeLock()
          ws.completeUnlock() // both flags read exactly as before; only the epoch tells
        }
      })
    ).rejects.toThrow(notSaved)
    expect(getSettings(db).lastBenchmark).toEqual(foreign)

    // The control: the same session, the same run → written.
    const fresh = await runAndPersistBenchmark(ctx)
    expect(getSettings(db).lastBenchmark?.ranAt).toBe(fresh.ranAt)
  })

  it('through the scheduler, a refused late persist is a "failed" outcome', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const ws = sessionWorkspace()
    const ctx = ctxWith(root, db, { workspace: ws })
    const foreign = movedToNewMachine(db)
    const measure = runBenchmarkSpy.getMockImplementation()!
    runBenchmarkSpy.mockImplementationOnce(async (deps) => {
      const measured = await measure(deps)
      ws.completeLock() // "Lock now" completes while the result is being assembled
      return measured
    })

    await expect(maybeRunFirstBenchmark(ctx)).resolves.toBe('failed')
    expect(getSettings(db).lastBenchmark).toEqual(foreign)
  })
})

describe('the production seams (registerWorkspaceIpc)', () => {
  it('create: a fresh vault has no model to wait for — the benchmark lands at once', async () => {
    const root = freshRoot()
    mkdirSync(join(root, 'config'), { recursive: true })
    const vp = vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'hilbertraum.sqlite') })
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    const rt = fakeRuntime()
    const ctx = seamCtx(root, ctrl, rt)

    const { result: created } = await invoke(handlers, IPC.createWorkspace, PASSWORD, 'encrypted')
    expect(created).toMatchObject({ ok: true })

    // TH2: this goes through the real registerWorkspaceIpc seam, which `void`s
    // scheduleFirstBenchmark — there is no returned outcome for the test to await, so this
    // stays a poll on the persisted state (unlike the direct scheduler calls elsewhere in this
    // file, which now await the outcome instead of vi.waitFor).
    await vi.waitFor(() => {
      expect(machineKey(getSettings(ctx.db).lastBenchmark)).toBe(here())
    })
    expect(rt.startCalls).toBe(0)
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    ctrl.lock()
  })

  it('unlock on a KNOWN computer: the restore and its push land before the model start is even invoked; nothing is measured', async () => {
    const events: string[] = []
    const rt = fakeRuntime({ onStart: () => events.push('runtime.start') })
    const foreign = result()
    const known = hereResult()
    const { ctrl, ctx } = lockedVault(
      { lastBenchmark: foreign, benchmarkHistory: [foreign, known], activeModelId: CHAT_MODEL },
      rt
    )
    setPerformanceChangedSink(() => {
      events.push(`performance:changed → ${getSettings(ctx.db).lastBenchmark?.ranAt}`)
    })

    const { result: unlocked } = await invoke(handlers, IPC.unlockWorkspace, PASSWORD)
    expect(unlocked).toMatchObject({ ok: true })
    await rt.startReached

    // The probe refresh pushes first (the EMPTY stamped probe of a vault root without a binary,
    // PR #308 decision 6 — `lastBenchmark` still the foreign one), then the restore, both
    // before the start is invoked.
    expect(events).toEqual([`performance:changed → ${foreign.ranAt}`, `performance:changed → ${known.ranAt}`, 'runtime.start'])
    expect(getSettings(ctx.db).lastBenchmark).toEqual(known)
    // Nothing owed: the seam scheduled no measurement (no attempt on record for this session).
    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: false, epoch: ctrl.unlockEpoch() })
    rt.finishStart()
    await hops(5)
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    ctrl.lock()
  })

  it('unlock on a NEW computer with an active model: no benchmark I/O until the start settles, then the run measures the started runtime', async () => {
    const rt = fakeRuntime()
    const foreign = result()
    const { ctrl, ctx } = lockedVault({ lastBenchmark: foreign, benchmarkHistory: [foreign], activeModelId: CHAT_MODEL }, rt)

    const { result: unlocked } = await invoke(handlers, IPC.unlockWorkspace, PASSWORD)
    expect(unlocked).toMatchObject({ ok: true })
    await rt.startReached
    await hops(5)

    // Parked in the load: the seam accepted the scheduling, yet nothing has touched the drive.
    expect(prepareFirstBenchmark(ctx)).toMatchObject({ run: null, attempted: true, epoch: ctrl.unlockEpoch() })
    expect(runBenchmarkSpy).not.toHaveBeenCalled()
    expect(rt.occupancy.held('benchmark')).toBe(false)
    expect(getSettings(ctx.db).lastBenchmark).toEqual(foreign)

    rt.finishStart()
    // TH2: same as the 'create' test above — a real IPC seam voids scheduleFirstBenchmark, so
    // there is no handle to await and this stays a poll on the persisted state.
    await vi.waitFor(() => {
      expect(machineKey(getSettings(ctx.db).lastBenchmark)).toBe(here())
    })
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    expect(runBenchmarkSpy.mock.calls[0][0].runtime?.modelId).toBe('stub-chat')
    expect(getSettings(ctx.db).lastBenchmark).toMatchObject({ tokensPerSecond: 20, measuredModelId: 'stub-chat' })
    expect(getSettings(ctx.db).benchmarkHistory.map((e) => machineKey(e))).toEqual([here(), machineKey(foreign)])
    ctrl.lock()
  })

  // #380 — the unlock-time probe/auto-start race. `prepareFirstBenchmark` fired the probe
  // fire-and-forget and the seam called the auto-start in the SAME tick, so the
  // `--list-devices` child and the multi-GB weight upload competed for the driver. The ladder
  // shares that very in-flight promise, so on the #330 round trip the probe hit its 10 s bound,
  // an empty stamped probe was persisted (tile "None", RAM basis) and a card decoding at
  // 98–100 tok/s was labelled "cpu". The auto-start now waits for the probe to settle.
  it('unlock on a card machine: the auto-start WAITS for the session probe, whose write lands first', async () => {
    const events: string[] = []
    const rt = fakeRuntime({ onStart: () => events.push('runtime.start') })
    const known = hereResult()
    const pending = deferred<GpuDevice[] | null>()
    const probe = fakeProbe(() => pending.promise)
    const { ctrl, ctx, root } = lockedVault(
      { lastBenchmark: known, benchmarkHistory: [known], activeModelId: CHAT_MODEL },
      rt,
      probe
    )
    withBinary(root)
    setPerformanceChangedSink(() => events.push('performance:changed'))

    const { result: unlocked } = await invoke(handlers, IPC.unlockWorkspace, PASSWORD)
    expect(unlocked).toMatchObject({ ok: true })

    // The driver has not answered yet — and NOTHING has been started, so the weight upload is
    // not competing with the probe for it. RACED, not sampled after a fixed number of hops: the
    // auto-start's own path runs `computeInstallState`, whose real fs work decides WHEN the
    // pre-fix start lands, so a bare `startCalls === 0` after N hops could pass on the UNFIXED
    // code purely because the disk was slow that run. Whichever settles first wins the race, so
    // the pre-fix failure is unconditional. (RED before the fix: 'started'.)
    const idle = hops(60).then(() => 'idle' as const)
    expect(await Promise.race([rt.startReached.then(() => 'started' as const), idle])).toBe('idle')
    await idle
    expect(probe.calls()).toBe(1)
    expect(rt.startCalls).toBe(0)
    expect(events).toEqual([])

    pending.resolve([RTX_DEVICE])
    await rt.startReached

    // The probe's stamped write — and its push — precede the start the ladder will label.
    expect(getSettings(ctx.db).gpuProbe).toMatchObject({ devices: [RTX_DEVICE], machineKey: here() })
    expect(events).toEqual(['performance:changed', 'runtime.start'])
    rt.finishStart()
    ctrl.lock()
  })

  it('unlock on a card-less machine: an EMPTY answer still releases the auto-start', async () => {
    const rt = fakeRuntime()
    const known = hereResult()
    const pending = deferred<GpuDevice[] | null>()
    const { ctrl, ctx, root } = lockedVault(
      { lastBenchmark: known, benchmarkHistory: [known], activeModelId: CHAT_MODEL },
      rt,
      fakeProbe(() => pending.promise)
    )
    withBinary(root)

    await invoke(handlers, IPC.unlockWorkspace, PASSWORD)
    await hops(5)
    expect(rt.startCalls).toBe(0)

    pending.resolve([])
    await rt.startReached // the control: the gate releases on ANY settled answer, not just a card
    expect(getSettings(ctx.db).gpuProbe).toMatchObject({ devices: [], machineKey: here() })
    rt.finishStart()
    ctrl.lock()
  })

  it('unlock with NO binary for this OS: nothing to probe, so the auto-start is not delayed at all', async () => {
    // The 10 s bound only exists for a wedged driver. A machine with no `llama-server` never
    // calls the probe — `resolveLlamaServerPath` is null — and the empty stamped write happens
    // synchronously, so the start is reached without waiting for anything.
    const rt = fakeRuntime()
    const known = hereResult()
    const never = deferred<GpuDevice[] | null>()
    const probe = fakeProbe(() => never.promise)
    const { ctrl } = lockedVault(
      { lastBenchmark: known, benchmarkHistory: [known], activeModelId: CHAT_MODEL },
      rt,
      probe
    )

    await invoke(handlers, IPC.unlockWorkspace, PASSWORD)
    await rt.startReached
    expect(probe.calls()).toBe(0)
    rt.finishStart()
    ctrl.lock()
  })
})
