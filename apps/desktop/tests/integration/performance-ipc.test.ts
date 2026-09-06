import { describe, it, expect, vi, beforeEach } from 'vitest'
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
import { liveChatRecommendation, pickerMemoryFor, speedSignalFor } from '../../src/main/ipc/registerModelIpc'
import { detectSystem } from '../../src/main/services/benchmark'
import { discoverManifests, machineRamGb, recommendChatModelId } from '../../src/main/services/models'
import { machineKey, recordAnswerSpeed, resetPerformanceForTests } from '../../src/main/services/performance'
import { recordChecksumRead, resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { BenchmarkProgressStep, BenchmarkResult } from '../../src/shared/types'
import { ctxWith, freshRoot, hereResult, result, seededDb } from '../helpers/performance-fixture'

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
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
    // No catalog on this context: nothing to recommend live (listModels returns no list either).
    expect(snap.recommendation).toBeNull()
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
    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.currentGpu).toEqual({ name: 'NVIDIA GeForce RTX 3090', totalMb: 24576 })
    // The result predates gpuVramMb: the probe's figure is folded in for THIS machine…
    expect(snap.current?.gpuVramMb).toBe(24576)
  })

  it('does not fold the live probe into another computer\'s result', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    delete (foreign as Partial<BenchmarkResult>).gpuVramMb
    updateSettings(db, {
      lastBenchmark: foreign,
      gpuProbe: { devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, freeMb: 20000 }], probedAt: '2026-09-05T00:00:00Z' }
    })
    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.currentMachine).toBe(false)
    expect(snap.current?.gpuVramMb).toBeUndefined()
    expect(snap.currentGpu?.totalMb).toBe(24576)
  })

  it('the Your-model block: no active model → unknown; a persisted placement for THIS machine → observed', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    let snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.model).toBeNull()
    expect(snap.placement.verdict.kind).toBe('unknown')
    expect(['discrete', 'unified', 'cpu']).toContain(snap.placement.memoryClass)

    // An active model with a persisted placement stamped with THIS machine.
    const here = machineKey(detectSystem())
    updateSettings(db, {
      activeModelId: 'some-model',
      modelPlacements: {
        'some-model': {
          modelId: 'some-model', contextTokens: 4096, backend: 'cpu', gpuLayers: null, totalLayers: null,
          gpuModelMb: null, cpuModelMb: 3000, gpuKvMb: null, cpuKvMb: 200, metalMaxWorkingSetMb: null,
          machineKey: here, at: '2026-09-05T00:00:00Z'
        }
      }
    })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.model?.id).toBe('some-model')
    // Not in the catalog: size 0, context from settings.
    expect(snap.placement.model?.sizeOnDiskGb).toBe(0)
    // A catalog model's size is converted from the manifest's decimal GB to GiB, the unit the
    // rest of the screen uses (19.8 decimal GB reads 18.4).
    expect(Math.round(((19.8 * 1e9) / 1024 ** 3) * 10) / 10).toBe(18.4)
    expect(snap.placement.observed?.cpuModelMb).toBe(3000)
    expect(snap.placement.verdict).toMatchObject({ kind: 'cpu', needMb: 3200, estimated: false })

    // The same record stamped with ANOTHER machine is ignored.
    updateSettings(db, { modelPlacements: { 'some-model': { ...getSettings(db).modelPlacements['some-model'], machineKey: 'elsewhere' } } })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed).toBeNull()

    // The session latch (this start) wins over the persisted record.
    recordModelPlacement({
      modelId: 'some-model', contextTokens: 8192, backend: 'gpu', gpuLayers: 10, totalLayers: 10,
      gpuModelMb: 2500, cpuModelMb: 100, gpuKvMb: 300, cpuKvMb: null, metalMaxWorkingSetMb: null,
      machineKey: here, at: '2026-09-05T01:00:00Z'
    })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed?.contextTokens).toBe(8192)
    expect(snap.placement.verdict.kind).toBe('gpu')
  })

  it('lists every model the app can hold, with liveness from each service and the totals', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
    const ctx = ctxWith(root, db, {
      manifestsDir: join(__dirname, '..', '..', '..', '..', 'model-manifests'),
      runtime: { occupancy: new ModelOccupancy(), active: () => ({ modelId: 'qwen3.5-9b-ud-q4kxl' }) },
      translator: { deviceStatus: () => ({ device: 'auto', gpuLayers: 20, totalLayers: 49, live: true }) },
      vision: { isLoaded: () => false },
      reranker: { isLoaded: () => true },
      embedder: { isLoaded: () => true }
    })
    const snap = buildPerformanceSnapshot(ctx)
    const rows = snap.placement.models
    expect(rows[0]).toMatchObject({ role: 'chat', modelId: 'qwen3.5-9b-ud-q4kxl', loaded: true, lifetime: 'session' })
    // The catalog's translation model, live, with its observed split; pinned roles say cpu.
    const tr = rows.find((r) => r.role === 'translation')
    expect(tr).toMatchObject({ loaded: true, lifetime: 'idle', gpuLayers: 20, totalLayers: 49 })
    expect(tr?.modelId).toBeTruthy()
    expect(rows.find((r) => r.role === 'vision')).toMatchObject({ device: 'cpu', loaded: false, lifetime: 'idle' })
    expect(rows.find((r) => r.role === 'reranker')).toMatchObject({ device: 'cpu', loaded: true, lifetime: 'session' })
    expect(rows.find((r) => r.role === 'embeddings')).toMatchObject({ device: 'cpu', loaded: true })
    expect(rows.find((r) => r.role === 'transcriber')).toMatchObject({ device: 'cpu', loaded: false, lifetime: 'per-use' })
    // Sizes are GiB from the manifests' decimal GB; the total sums every row.
    const sum = rows.reduce((a, r) => a + (r.sizeOnDiskGb ?? 0), 0)
    expect(snap.placement.totals.ramAllMb).toBe(Math.round(sum * 1024))
    // Both on the card only counts on a machine WITH a card (this test host has no probe → cpu class).
    expect(snap.placement.totals.bothOnCard).toBe(snap.placement.memoryClass !== 'cpu')
  })

  it('carries the LIVE recommendation, built from the same inputs the listModels handler feeds buildModelList', () => {
    // Host-dependent (this machine's RAM, its probe if any), so the assertion is equality with the
    // shared input functions, not a pinned id — the pinned cases live in picker-seams.test.ts.
    const root = freshRoot()
    const db = seededDb(root)
    const manifestsDir = join(__dirname, '..', '..', '..', '..', 'model-manifests')
    updateSettings(db, { lastBenchmark: hereResult({ tokensPerSecond: 4, measuredModelId: 'qwen3.5-9b-ud-q4kxl' }) })
    const snap = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir }))
    const settings = getSettings(db)
    const manifests = discoverManifests(manifestsDir).manifests.map((m) => m.manifest)
    const memory = pickerMemoryFor(settings)
    expect(snap.recommendation).toEqual(liveChatRecommendation(settings, manifests))
    expect(snap.recommendation?.basis).toBe(memory.memoryClass)
    expect(snap.recommendation?.basis).toBe(snap.placement.memoryClass)
    expect(snap.recommendation?.modelId).toBe(
      recommendChatModelId(
        manifests,
        { memoryClass: memory.memoryClass ?? 'cpu', ramGb: machineRamGb(), budgetMb: memory.graphicsBudgetMb ?? null },
        speedSignalFor(settings)
      )
    )
    // The signal is the persisted pairing, exactly as the handler derives it.
    expect(speedSignalFor(settings)).toEqual({ tokensPerSecond: 4, measuredModelId: 'qwen3.5-9b-ud-q4kxl' })
    expect(speedSignalFor({ ...settings, lastBenchmark: null })).toBeNull()
    // The saved field is left alone.
    expect(snap.current?.recommendedModelId).toBe('qwen3.5-9b-ud-q4kxl')
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
