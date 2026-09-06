import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
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
import { detectSystem, type RunBenchmarkDeps } from '../../src/main/services/benchmark'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import { machineKey, resetPerformanceForTests } from '../../src/main/services/performance'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions, RuntimeStartOptions } from '../../src/main/services/runtime'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { WorkspaceController, createEncryptedVaultOnDisk, vaultPathsFrom } from '../../src/main/services/workspace-vault'
import { IPC } from '../../src/shared/ipc'
import type { AppSettings, BenchmarkResult, PrivacyPolicy, RuntimeStatus } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { ctxWith, freshRoot, hereResult, performanceChangedSpy, result, seededDb, stoppedStatus } from '../helpers/performance-fixture'

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

/** A chat runtime stub whose stream yields a couple of chunks with timings — enough for the speed leg. */
function stubRuntime(): ModelRuntime {
  return {
    modelId: 'stub-chat',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
      yield 'a'
      yield 'b'
      options?.onFinish?.('length', { predicted_n: 2, predicted_per_second: 20 })
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
        ? { running: true, modelId: current.modelId, port: 1, healthy: true, message: 'Running', backend: 'cpu' }
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
function seamCtx(root: string, ctrl: WorkspaceController, runtime: FakeRuntime): AppContext {
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'config') },
    get db() {
      return ctrl.requireDb()
    },
    workspace: ctrl,
    runtime,
    manifestsDir: REPO_MANIFESTS,
    isDev: true
  } as unknown as AppContext
  registerWorkspaceIpc(ctx)
  return ctx
}

/** An encrypted vault whose settings hold `seed`, LOCKED, so the unlock handler opens it. */
function lockedVault(seed: Partial<AppSettings>, runtime: FakeRuntime): { ctrl: WorkspaceController; ctx: AppContext } {
  const root = freshRoot()
  mkdirSync(join(root, 'config'), { recursive: true })
  const vp = vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'hilbertraum.sqlite') })
  createEncryptedVaultOnDisk(vp, PASSWORD, FAST_KDF)
  const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
  ctrl.init()
  ctrl.unlock(PASSWORD)
  updateSettings(ctrl.requireDb(), seed)
  ctrl.lock()
  return { ctrl, ctx: seamCtx(root, ctrl, runtime) }
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

describe('prepareFirstBenchmark: the cheap half', () => {
  it('a fresh workspace owes a first run; a known computer is restored synchronously and owes nothing; a legacy blob owes nothing', () => {
    const root = freshRoot()
    const fresh = seededDb(root)
    expect(prepareFirstBenchmark(ctxWith(root, fresh))).toEqual({ run: 'first-run', attempted: false, epoch: undefined, hereKey: here() })

    const db = seededDb(root)
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })
    const spy = performanceChangedSpy(() => getSettings(db).lastBenchmark?.ranAt)
    expect(prepareFirstBenchmark(ctxWith(root, db))).toMatchObject({ run: null, attempted: false })
    // Restored — and pushed — before the call returns: nothing to await.
    expect(getSettings(db).lastBenchmark).toEqual(known)
    expect(spy.mock.results.map((r) => r.value)).toEqual([known.ranAt])

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
    expect(prepareFirstBenchmark(ctxWith(root, db, { workspace: ws }))).toEqual({ run: null, attempted: false, epoch: undefined, hereKey: null })
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
    expect(spy.mock.results.map((r) => r.value)).toEqual([[foreign.cpuModel]])
    expect(runBenchmarkSpy).not.toHaveBeenCalled()

    await expect(scheduleFirstBenchmark(ctx, decision, Promise.resolve())).resolves.toBe('ran')

    const s = getSettings(db)
    expect(machineKey(s.lastBenchmark)).toBe(here())
    expect(s.benchmarkHistory.map((e) => machineKey(e))).toEqual([here(), machineKey(foreign)])
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
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
    expect(spy).toHaveBeenCalledTimes(2) // the run's own start + idle pushes
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
    // The failed run still bracketed itself: the running push, then the idle push after the release.
    expect(spy.mock.results.map((r) => r.value)).toEqual([true, false])

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
    ).rejects.toThrow(/locked/)

    expect(getSettings(db).lastBenchmark).toEqual(foreign)
    expect(getSettings(db).benchmarkHistory).toEqual([foreign])
    expect(spy.mock.results.map((r) => r.value)).toEqual([true, false])
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
    ).rejects.toThrow(/re-opened/)
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

    expect(events).toEqual([`performance:changed → ${known.ranAt}`, 'runtime.start'])
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
    await vi.waitFor(() => {
      expect(machineKey(getSettings(ctx.db).lastBenchmark)).toBe(here())
    })
    expect(runBenchmarkSpy).toHaveBeenCalledTimes(1)
    expect(runBenchmarkSpy.mock.calls[0][0].runtime?.modelId).toBe('stub-chat')
    expect(getSettings(ctx.db).lastBenchmark).toMatchObject({ tokensPerSecond: 20, measuredModelId: 'stub-chat' })
    expect(getSettings(ctx.db).benchmarkHistory.map((e) => machineKey(e))).toEqual([here(), machineKey(foreign)])
    ctrl.lock()
  })
})
