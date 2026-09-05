import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Performance screen's main-side seams (benchmark.md "History per machine" /
// "Performance screen"):
//  - a fresh benchmark files its result under this machine in `benchmarkHistory`;
//  - the moved-drive check restores a KNOWN machine's result and benchmarks a NEW one,
//    while a legacy result with no machine identity is left alone;
//  - the snapshot the screen reads (current-machine flag, other machines, observed rows);
//  - the progress steps a run reports.

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import {
  buildPerformanceSnapshot,
  maybeRunFirstBenchmark,
  runAndPersistBenchmark
} from '../../src/main/ipc/registerBenchmarkIpc'
import { detectSystem } from '../../src/main/services/benchmark'
import { openDatabase, type Db } from '../../src/main/services/db'
import { machineKey, recordAnswerSpeed, resetPerformanceForTests } from '../../src/main/services/performance'
import { recordChecksumRead, resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import type { AppContext } from '../../src/main/services/context'
import type { BenchmarkProgressStep, BenchmarkResult } from '../../src/shared/types'

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-perf-ipc-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return root
}

function seededDb(root: string): Db {
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  return db
}

function ctxWith(root: string, db: Db): AppContext {
  return {
    paths: { rootPath: root, workspacePath: join(root, 'workspace') },
    db,
    workspace: { isUnlocked: () => true },
    // No binary on this root: the GPU probe resolves to "no devices" and never blocks.
    probeGpu: undefined,
    runtime: { occupancy: new ModelOccupancy(), active: () => null },
    isDev: true
  } as unknown as AppContext
}

function result(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
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
function hereResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
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

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
})

describe('runAndPersistBenchmark: files the result under this machine', () => {
  it('persists lastBenchmark AND the history entry, keeping other machines, and reports its steps', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })
    const steps: BenchmarkProgressStep[] = []

    const fresh = await runAndPersistBenchmark(ctxWith(root, db), (step) => steps.push(step))

    const s = getSettings(db)
    expect(s.lastBenchmark?.ranAt).toBe(fresh.ranAt)
    expect(machineKey(s.lastBenchmark)).toBe(machineKey(detectSystem()))
    expect(s.benchmarkHistory.map((e) => e.cpuModel)).toEqual([fresh.cpuModel, foreign.cpuModel])
    // No runtime was up: the speed step is not reported at all.
    expect(steps).toEqual(['system', 'drive', 'done'])
  })
})

describe('maybeRunFirstBenchmark: the moved-drive check', () => {
  it('restores the stored result for a KNOWN machine without re-running', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })

    maybeRunFirstBenchmark(ctxWith(root, db))

    await vi.waitFor(() => {
      expect(getSettings(db).lastBenchmark?.ranAt).toBe(known.ranAt)
    })
    // Restored, not re-measured: the entry is byte-identical and the history untouched.
    expect(getSettings(db).lastBenchmark).toEqual(known)
    expect(getSettings(db).benchmarkHistory).toHaveLength(2)
  })

  it('benchmarks a NEW machine in the background and keeps the other machine in the history', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })

    maybeRunFirstBenchmark(ctxWith(root, db))

    await vi.waitFor(() => {
      expect(machineKey(getSettings(db).lastBenchmark)).toBe(machineKey(detectSystem()))
    })
    const history = getSettings(db).benchmarkHistory
    expect(history).toHaveLength(2)
    expect(history.some((e) => e.cpuModel === foreign.cpuModel)).toBe(true)
  })

  it('leaves a legacy result with no machine identity alone (never mistaken for a move)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: { profile: 'BALANCED' } as unknown as BenchmarkResult })

    maybeRunFirstBenchmark(ctxWith(root, db))

    // Give a background run every chance to (wrongly) land, then assert it did not.
    await new Promise((r) => setTimeout(r, 300))
    expect((getSettings(db).lastBenchmark as unknown as { profile: string }).profile).toBe('BALANCED')
    expect(getSettings(db).benchmarkHistory).toEqual([])
  })
})

describe('buildPerformanceSnapshot', () => {
  it('flags whether the current result is this machine, lists the others, and carries the observed rows', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    const here = hereResult({
      effectiveRead: {
        mbps: 430,
        bytes: 5_800_000_000,
        ms: 13_500,
        source: 'model_load',
        modelId: 'qwen3.5-9b-ud-q4kxl',
        at: '2026-08-20T10:00:00Z'
      }
    })
    updateSettings(db, { lastBenchmark: here, benchmarkHistory: [here, foreign] })
    recordAnswerSpeed({ messageId: 'a', tokensPerSecond: 11.8, ttftMs: 900, tokens: 312 }, 'qwen3.5-9b-ud-q4kxl')
    recordChecksumRead(5_800_000_000, 40_000, 'qwen3.5-9b-ud-q4kxl')

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    expect(snap.current?.ranAt).toBe(here.ranAt)
    expect(snap.currentMachine).toBe(true)
    // The live probe rides along for the graphics tile (no probe here: null).
    expect(snap.currentGpu).toBeNull()
    expect(snap.otherMachines.map((e) => e.cpuModel)).toEqual([foreign.cpuModel])
    expect(snap.running).toBe(false)
    expect(snap.observed.lastAnswer?.tokensPerSecond).toBe(11.8)
    expect(snap.observed.lastChecksum?.modelId).toBe('qwen3.5-9b-ud-q4kxl')
    // No model start this session: the persisted model-load sample still tells the story.
    expect(snap.observed.lastModelLoad?.mbps).toBe(430)
  })

  it('carries the live GPU probe for the graphics tile', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, {
      lastBenchmark: hereResult(),
      gpuProbe: { devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, freeMb: 20000 }], probedAt: '2026-09-05T00:00:00Z' }
    })
    expect(buildPerformanceSnapshot(ctxWith(root, db)).currentGpu).toEqual({ name: 'NVIDIA GeForce RTX 3090', totalMb: 24576 })
  })

  it('reads a result from another computer as "not this machine"', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    expect(snap.currentMachine).toBe(false)
    expect(snap.otherMachines).toEqual([])
    expect(snap.currentGpu).toBeNull()
    expect(snap.observed).toEqual({ lastAnswer: null, lastModelLoad: null, lastChecksum: null })
  })
})
