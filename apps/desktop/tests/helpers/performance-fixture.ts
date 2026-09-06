import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { detectSystem } from '../../src/main/services/benchmark'
import { openDatabase, type Db } from '../../src/main/services/db'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { seedSettings } from '../../src/main/services/settings'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import type { AppContext } from '../../src/main/services/context'
import type { BenchmarkResult, RuntimeStatus } from '../../src/shared/types'
import { ANY_SENDER } from './ipc'

// Shared fixture for the Performance-screen main-side tests (performance-ipc,
// performance-persistence, performance-notify): a throwaway root + workspace dir, a seeded
// settings DB, a minimal AppContext, a `performance:changed` sink spy, and two typed
// BenchmarkResult builders — one for an arbitrary OTHER computer, one carrying THIS test
// host's machine fingerprint.

export function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-perf-ipc-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return root
}

export function seededDb(root: string): Db {
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return db
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
