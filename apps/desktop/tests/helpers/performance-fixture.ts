import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { detectSystem } from '../../src/main/services/benchmark'
import { setAnswerSpeedObserver } from '../../src/main/ipc/chat-stream'
import { resetFirstBenchmarkForTests } from '../../src/main/ipc/registerBenchmarkIpc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { resetPerformanceForTests } from '../../src/main/services/performance'
import { resetEffectiveReadForTests, setEffectiveReadObserver } from '../../src/main/services/read-speed'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { resetModelPlacementForTests, setModelPlacementObserver } from '../../src/main/services/runtime/placement'
import { seedSettings } from '../../src/main/services/settings'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import type { AppContext } from '../../src/main/services/context'
import type { BenchmarkResult, RuntimeStatus } from '../../src/shared/types'
import { ANY_SENDER } from './ipc'

// Shared fixture for the Performance-screen main-side tests (performance-ipc,
// performance-persistence, performance-notify, performance-gpu, performance-schema,
// first-benchmark-scheduler): a throwaway root + workspace dir, a seeded settings DB, a
// minimal AppContext, a `performance:changed` sink spy, and two typed BenchmarkResult
// builders — one for an arbitrary OTHER computer, one carrying THIS test host's machine
// fingerprint.
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
 * TH2 teardown: reset every module-level latch/memo/observer the sharing files touch, close
 * every DB `seededDb()` opened (a double close — e.g. a test whose own `WorkspaceController`
 * already closed it via `ctrl.lock()` — is swallowed), then remove every root `freshRoot()`
 * minted. `resetEffectiveReadForTests` / `resetModelPlacementForTests` already null their own
 * observers; `setEffectiveReadObserver` / `setModelPlacementObserver` are still called
 * explicitly here (belt and suspenders — this teardown must not silently stop covering them if
 * that internal detail ever changes), and `setAnswerSpeedObserver` has no reset of its own.
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
  resetFirstBenchmarkForTests()
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
    ...over
  } as unknown as AppContext
}

/**
 * Install a spy as the `performance:changed` sink (replacing the window broadcast) and
 * return it. `probe`, when given, runs on every push and its return value is recorded as
 * that call's result — so a test can assert the ORDER of a push against the persist/release
 * it must follow. Reset with `setPerformanceChangedSink(null)` in `beforeEach`.
 */
export function performanceChangedSpy<T = void>(probe?: () => T): ReturnType<typeof vi.fn<() => T>> {
  const spy = vi.fn<() => T>(() => (probe ? probe() : (undefined as T)))
  setPerformanceChangedSink(() => {
    spy()
  })
  return spy
}

/** A result from some OTHER computer (a fingerprint no test host carries). */
export function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'win32',
    arch: 'x64',
    cpuModel: 'Some Other CPU',
    cpuCores: 32,
    ramGb: 64,
    gpu: 'NVIDIA GeForce RTX 3090',
    driveReadMbps: null,
    driveWriteMbps: 900,
    tokensPerSecond: 41,
    measuredModelId: 'qwen3.8-27b-ud-q4km',
    effectiveRead: null,
    profile: 'PRO',
    recommendedModelId: 'qwen3.8-27b-ud-q4km',
    warnings: [],
    ranAt: '2026-09-02T10:00:00Z',
    ...over
  }
}

/** A result carrying THIS machine's fingerprint (whatever the test host is). */
export function hereResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  const sys = detectSystem()
  return result({
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
