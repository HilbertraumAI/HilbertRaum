import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, vi, type Mock } from 'vitest'
import { stringify } from 'yaml'
import { detectSystem } from '../../src/main/services/benchmark'
import { setAnswerSpeedObserver } from '../../src/main/ipc/chat-stream'
import {
  prepareFirstBenchmark,
  scheduleFirstBenchmark,
  type FirstBenchmarkOutcome
} from '../../src/main/ipc/registerBenchmarkIpc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { machineKey, resetPerformanceForTests } from '../../src/main/services/performance'
import { recordModelLoadRead, resetEffectiveReadForTests, setEffectiveReadObserver } from '../../src/main/services/read-speed'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { resetModelPlacementForTests, setModelPlacementObserver } from '../../src/main/services/runtime/placement'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import { seedSettings } from '../../src/main/services/settings'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { createPendingModelSwitchCounter } from '../../src/main/services/rag/device-posture'
import type { AppContext } from '../../src/main/services/context'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeManager,
  RuntimeStartOptions,
  RuntimeTimings
} from '../../src/main/services/runtime'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import type { BenchmarkResult, GpuDevice, RuntimeStatus } from '../../src/shared/types'
import { benchmarkResult } from './benchmark-records'
import { ANY_SENDER } from './ipc'

// Shared fixture for the Performance-screen main-side tests (performance-ipc,
// performance-persistence, performance-notify, performance-gpu, performance-schema,
// first-benchmark-scheduler): a throwaway root + workspace dir, a seeded settings DB, a
// minimal AppContext, a `performance:changed` sink spy, and two typed BenchmarkResult
// builders — one for an arbitrary OTHER computer, one carrying THIS test host's machine
// fingerprint. Below those, the stand-ins the benchmark, picker and posture suites each kept
// a copy of: the speed leg's runtime, the GPU probe, the placeholder binary, the measured cards.
// This module loads main-process code, so a jsdom suite takes its records from `benchmark-records.ts`.
//
// TH2 (PR #303 audit remediation, P8): every root `freshRoot()` mints and every DB
// `seededDb()` opens is registered below so `closePerformanceFixture()` can close the DBs
// and remove the temp directories — before this, NEITHER ever happened, so every test using
// this fixture leaked its `hilbertraum-perf-ipc-*` root (and its open sqlite handle) for the
// life of the process. Call `closePerformanceFixture` from `afterEach` in every file that
// shares this fixture.

const createdRoots: string[] = []
const createdDbs: Db[] = []

export function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-perf-ipc-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  createdRoots.push(root)
  return root
}

export function seededDb(root: string): Db {
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  createdDbs.push(db)
  return db
}

/**
 * TH2 teardown: reset every session latch and observer the sharing files touch, close
 * every DB `seededDb()` opened (a double close — e.g. a test whose own `WorkspaceController`
 * already closed it via `ctrl.lock()` — is swallowed), then remove every root `freshRoot()`
 * minted. `resetEffectiveReadForTests` / `resetModelPlacementForTests` already null their own
 * observers; `setEffectiveReadObserver` / `setModelPlacementObserver` are still called
 * explicitly here (belt and suspenders — this teardown must not silently stop covering them if
 * that internal detail ever changes), and `setAnswerSpeedObserver` has no reset of its own.
 *
 * The first-benchmark attempt memo and moved-drive latch are NOT reset: both are keyed on the DB
 * handle + the unlock epoch, so a test's new `seededDb()` is already a new session. A row that needs
 * a second session on ONE handle says so with an epoch bump (`sessionWorkspace().completeUnlock()`).
 *
 * Root removal closes DBs FIRST: on Windows a still-open sqlite file makes `rmSync` fail. If it
 * still fails (a close that is asynchronously settling), retry ONCE after a real macrotask
 * (never a bare microtask/turn count — CLAUDE.md's testing convention) and let a second failure
 * throw — that would be a genuine leak, not a timing artifact.
 */
export async function closePerformanceFixture(): Promise<void> {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
  setPerformanceChangedSink(null)
  setEffectiveReadObserver(null)
  setModelPlacementObserver(null)
  setAnswerSpeedObserver(null)

  const dbs = createdDbs.splice(0, createdDbs.length)
  for (const db of dbs) {
    try {
      db.close()
    } catch {
      /* already closed by the test itself (e.g. a WorkspaceController's ctrl.lock()) */
    }
  }

  const roots = createdRoots.splice(0, createdRoots.length)
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1))
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** A stopped chat runtime's status (the fixture's default `runtime.status()`). */
export function stoppedStatus(): RuntimeStatus {
  return { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }
}

export function ctxWith(root: string, db: Db, over: Record<string, unknown> = {}): AppContext {
  return {
    paths: { rootPath: root, workspacePath: join(root, 'workspace') },
    db,
    workspace: { isUnlocked: () => true },
    // The registrars go through `guardedHandle` (#252), which refuses a context without a
    // trusted-sender set; the permissive harness set keeps registration possible here.
    trustedSenders: { ...ANY_SENDER },
    // No binary on this root: the GPU probe resolves to "no devices" and never blocks.
    probeGpu: undefined,
    runtime: { occupancy: new ModelOccupancy(), active: () => null, status: stoppedStatus },
    isDev: true,
    // #477: pendingModelSwitches is required — startModelRuntime's committed-switch branch
    // calls it unconditionally now (no more `?.`/`??` fallback). `over` can still replace it.
    pendingModelSwitches: createPendingModelSwitchCounter(),
    ...over
  } as unknown as AppContext
}

/**
 * Install a spy as the `performance:changed` sink (replacing the window broadcast) and
 * return it. `probe`, when given, runs on every push and its return value is recorded as
 * that call's result — so a test can assert the ORDER of a push against the persist/release
 * it must follow. `closePerformanceFixture` clears the sink after each test.
 */
export function performanceChangedSpy<T = void>(probe?: () => T): ReturnType<typeof vi.fn<() => T>> {
  const spy = vi.fn<() => T>(() => (probe ? probe() : (undefined as T)))
  setPerformanceChangedSink(() => {
    spy()
  })
  return spy
}

/** A result from some OTHER computer (a fingerprint no test host carries). */
export { benchmarkResult as result } from './benchmark-records'

/** A result carrying THIS machine's fingerprint (whatever the test host is). */
export function hereResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const sys = detectSystem()
  return benchmarkResult({
    os: sys.os,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    cpuCores: sys.cpuCores,
    ramGb: sys.ramGb,
    gpu: null,
    tokensPerSecond: 12,
    measuredModelId: 'qwen3.5-9b-ud-q4kxl',
    profile: 'LITE',
    recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
    ranAt: '2026-08-20T10:00:00Z',
    ...over
  })
}

/** The repo's committed `model-manifests/`, absolute. Replaces each suite's own `join(__dirname, …)`. */
export const CATALOG_MANIFESTS: string = join(__dirname, '..', '..', '..', '..', 'model-manifests')

/** THIS host's `machineKey` (null when detection fails). Replaces each suite's `here()`. */
export function hereKey(): string | null {
  return machineKey(detectSystem())
}

/**
 * 3 GB in 10 s: a 300 MB/s model-load sample (above the #110 gate), fed to `read-speed`'s observer.
 * The path matters since #392: a weight hashed anywhere in the session records no load sample at
 * all. Replaces performance-persistence's and performance-notify's copies. It only records: a test
 * still resets through `closePerformanceFixture`, and a stored record is `effectiveReadSample`.
 */
export function loadSample(modelId: string, ms = 10_000, path = 'unused'): void {
  recordModelLoadRead(path, ms, modelId, 3_000_000_000)
}

/** Options for `stubChatRuntime`; every default reproduces the speed-leg stub the suites shared. */
export interface StubChatRuntimeOptions {
  /** Default `'stub-chat'`. */
  modelId?: string
  /** Default `['a', 'b']`. */
  chunks?: string[]
  /** `predicted_per_second` of the final timings block. Default 20. */
  perSecond?: number
  /** `predicted_n` of the final timings block. Default: the number of chunks. */
  predictedN?: number
  /** The whole timings block, replacing `perSecond` + `predictedN`. `null`: the stream reports none. */
  timings?: RuntimeTimings | null
  /**
   * Runs between two chunks: once for the default stream, the window in which a manual "Use model"
   * lands beside a running benchmark (#393). With `rejectAfterHook`, it runs after the first chunk.
   */
  onChunk?: () => void
  /**
   * After the first chunk the stream THROWS `model stopped`: the killed sidecar, whose iterator
   * rejects rather than delivering another chunk (the realistic #334 leg S5 timing).
   */
  rejectAfterHook?: boolean
  /** `status()` of the manager half (see `StubChatRuntime`). Default `stoppedStatus`. */
  status?: () => RuntimeStatus
  /** `occupancy` of the manager half. Default: a new, idle `ModelOccupancy`. */
  occupancy?: ModelOccupancy
}

/**
 * The runtime `measureTokensPerSecond` reads, plus the three manager members the benchmark reads off
 * `ctx.runtime` (`occupancy`, `active`, `status`), so one object serves both `runBenchmark({ runtime })`
 * and `ctxWith(root, db, { runtime })`. `active()` hands out this object, not a spread copy of it.
 */
export interface StubChatRuntime extends ModelRuntime {
  occupancy: ModelOccupancy
  active(): ModelRuntime | null
  status(): RuntimeStatus
}

/**
 * A chat runtime whose stream is enough for the speed leg. Replaces first-benchmark-scheduler's
 * `stubRuntime`, benchmark's `timedRuntime` / `slowRuntime` / inline `timed`, and performance-ipc's and
 * performance-persistence's `stubRuntime`.
 *
 * It never sleeps: `slowRuntime`'s 450 ms per chunk and `timedRuntime`'s `perChunkDelayMs` have no
 * option here, so a slow reading is `perSecond`, and a wall-clock reading stubs the clock over
 * `timings: null`. To replace a method (a stream that throws at once, one that records its prompt),
 * spread it: `{ ...stubChatRuntime(), async *chatStream() { … } }`. A generation gate, the abort
 * signal and the finish reason (always `'length'`) are not modelled.
 */
export function stubChatRuntime(opts: StubChatRuntimeOptions = {}): StubChatRuntime {
  const chunks = opts.chunks ?? ['a', 'b']
  const timings =
    opts.timings === null
      ? undefined
      : (opts.timings ?? { predicted_n: opts.predictedN ?? chunks.length, predicted_per_second: opts.perSecond ?? 20 })
  const stub: StubChatRuntime = {
    modelId: opts.modelId ?? 'stub-chat',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
      for (const [i, chunk] of chunks.entries()) {
        yield chunk
        if (opts.rejectAfterHook) {
          opts.onChunk?.()
          throw new Error('model stopped')
        }
        if (i < chunks.length - 1) opts.onChunk?.()
      }
      options?.onFinish?.('length', timings)
    },
    occupancy: opts.occupancy ?? new ModelOccupancy(),
    active: () => stub,
    status: opts.status ?? stoppedStatus
  }
  return stub
}

/**
 * Pin `process.platform` and `process.arch` for the enclosing suite: registers `beforeAll` and
 * `afterAll`, which restores what the `beforeAll` found, so a pin inside a pinned describe hands
 * back the outer one. Replaces performance-gpu's and picker-seams' pairs. It does not pin RAM or
 * anything else `node:os` answers: that mock is hoisted, so it stays in the test file.
 */
export function pinPlatform(platform: NodeJS.Platform, arch: string): void {
  let platformDescriptor: PropertyDescriptor | undefined
  let archDescriptor: PropertyDescriptor | undefined
  beforeAll(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  })
  afterAll(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    if (archDescriptor) Object.defineProperty(process, 'arch', archDescriptor)
  })
}

/**
 * A placeholder `llama-server` under `root`, so `probeAndPersistGpu` resolves a binary. Replaces
 * first-benchmark-scheduler's and performance-gpu's `withBinary`, posture-writers' `rootWithBinary`
 * and picker-seams:128-130. Named for the platform at the CALL (under `pinPlatform`, call it from a
 * test or hook, not at collection). It mints no root, and the file cannot run: the probe is
 * `fakeGpuProbe`'s.
 */
export function withLlamaBinary(root: string): void {
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
}

type GpuProbeCall = (binPath: string) => Promise<GpuDevice[] | null>

/**
 * The session-cached probe seam: never spawns anything, and takes the devices, `null` (the probe's
 * UNKNOWN answer, #380) or a function for a parked or scripted answer. Replaces picker-seams:135-142,
 * posture-writers' and first-benchmark-scheduler's `fakeProbe`. The probe IS its own mock, so both
 * `expect(probe).toHaveBeenCalledTimes(1)` and `expect(probe.calls)…` read the same record, and
 * `probe.calls.mockImplementation(…)` re-scripts it. `invalidate` only records: it drops no cached answer.
 */
export function fakeGpuProbe(
  impl: GpuDevice[] | null | (() => Promise<GpuDevice[] | null>)
): CachedGpuProbe & { calls: Mock<GpuProbeCall>; invalidate: Mock<() => void> } {
  const calls = vi.fn<GpuProbeCall>(typeof impl === 'function' ? impl : async () => impl)
  return Object.assign(calls, { calls, invalidate: vi.fn<() => void>() })
}

/**
 * The runtime manager's commit surface for `startModelRuntime`: `start` commits the model it was
 * given, and `activeModelId()` follows. Replaces posture-writers' 4 literals (and their `as any`).
 * `commit(id)` sets the model by hand, for an `over.start` that commits on its own terms. `status()`
 * says no start is in flight; a row about one passes `over.status`. `over` wins over every member.
 * There is no gate, queue or `active()`: a suite that parks a start keeps its own fake.
 */
export function committingRuntime(
  initial: string | null = null,
  over: Partial<RuntimeManager> = {}
): Pick<RuntimeManager, 'activeModelId' | 'status' | 'start'> & { commit(id: string): void } {
  let committed = initial
  return {
    activeModelId: () => committed,
    status: () => ({
      running: committed !== null,
      modelId: committed,
      port: null,
      healthy: committed !== null,
      message: 'ok',
      startingModelId: null
    }),
    start: async (opts: RuntimeStartOptions) => {
      committed = opts.modelId
      return { running: true, modelId: committed, port: null, healthy: true, message: 'ok' }
    },
    commit: (id: string) => {
      committed = id
    },
    ...over
  }
}

/**
 * A session-aware workspace stand-in (the core-model-ipc shape): flags plus the epoch counter.
 * Moved from first-benchmark-scheduler. No `requireDb`: a context whose `db` follows the session
 * keeps its own getter.
 */
export function sessionWorkspace(): {
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

/**
 * The first benchmark with nothing to wait for: prepare, then schedule against a settled promise, so
 * the measurement runs at once. Resolves to the outcome; never rejects. Replaces every test's call of
 * `maybeRunFirstBenchmark`. It passes no scheduler deps: a row about the wait calls the two halves.
 */
export function firstBenchmarkNow(ctx: AppContext): Promise<FirstBenchmarkOutcome> {
  return scheduleFirstBenchmark(ctx, prepareFirstBenchmark(ctx), Promise.resolve())
}

/**
 * The four measured cards, as the probe lists them (MiB). Figures only: a row whose outcome turns on
 * a figure these do not hold keeps its own literal, and says so. Spread to vary one:
 * `{ ...CARDS.RTX_3090, freeMb: 4096 }`.
 */
export const CARDS: Record<'RTX_3080_TI' | 'RTX_3090' | 'GTX_1070_TI' | 'RTX_3060_LAPTOP', GpuDevice> = {
  // tests/fixtures/list-devices-b11146-vulkan-rtx3080ti.txt; model-benchmarks.md, the hardware table, leg 3.
  RTX_3080_TI: { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12084, freeMb: 11316 },
  // tests/fixtures/placement-b9849-partial-62of66-mtp.txt; model-benchmarks.md, the hardware table, leg 7.
  RTX_3090: { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 23575 },
  // model-benchmarks.md, the hardware table, leg 2. The b11146 captures of this card read 7,484-7,490 free.
  GTX_1070_TI: { id: 'Vulkan0', name: 'NVIDIA GeForce GTX 1070 Ti', totalMb: 8273, freeMb: 7504 },
  // tests/fixtures/placement-b9849-partial-18of33-np4.txt; leg 4. Vulkan1: that laptop lists its iGPU first.
  RTX_3060_LAPTOP: { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226 }
}

/**
 * A chat-model manifest under `dir` (created if missing), named `<id>.yaml`. The defaults are
 * posture-writers' RAM-gate fixture (`huge-model`, 9999 GB RAM: no real machine passes). It writes
 * the manifest only: the weight file at `local_path`, which makes the model installed, stays the test's.
 */
export function writeChatManifest(dir: string, over: Record<string, unknown> = {}): void {
  const manifest = {
    id: 'huge-model',
    display_name: 'Huge Model',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    size_on_disk_gb: 999,
    recommended_min_ram_gb: 9999,
    recommended_ram_gb: 9999,
    recommended_context_tokens: 4096,
    local_path: 'models/chat/huge.gguf',
    sha256: 'REPLACE_WITH_REAL_HASH',
    recommended_profiles: ['PRO'],
    license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' },
    ...over
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${manifest.id}.yaml`), stringify(manifest))
}
