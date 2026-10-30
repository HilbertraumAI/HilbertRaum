import { describe, it, expect, vi, afterEach } from 'vitest'

// The Performance screen's snapshot (benchmark.md "Performance screen"): the current-machine
// flag, other machines, observed rows — session latches only, M3 — `running` from the
// benchmark's own span, M1, and the chat row's residency from the runtime state, DR6.

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { buildPerformanceSnapshot } from '../../src/main/ipc/registerBenchmarkIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { recordAnswerSpeed } from '../../src/main/services/performance'
import { recordChecksumRead, recordModelLoadRead } from '../../src/main/services/read-speed'
import { recordModelPlacement } from '../../src/main/services/runtime/placement'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { RuntimeStatus } from '../../src/shared/types'
import { effectiveReadSample, modelPlacement } from '../helpers/benchmark-records'
import {
  CATALOG_MANIFESTS,
  closePerformanceFixture,
  ctxWith,
  freshRoot,
  hereKey,
  hereResult,
  performanceChangedSpy,
  pinPlatform,
  result,
  seededDb,
  stoppedStatus,
  stubChatRuntime
} from '../helpers/performance-fixture'
import { runtimeStatus } from '../helpers/status'

// The snapshot's memory class reads the platform, and no CI leg runs tests on macOS, so
// these rows state it. Apple Silicon has its own rows in unit/performance and performance-gpu.
pinPlatform('win32', 'x64')

// TH2: every root/DB this file's tests create goes through the fixture's `freshRoot`/
// `seededDb`, so the shared teardown (module resets + DB close + temp-dir removal) applies.
afterEach(closePerformanceFixture)

/** A persisted model-load sample (the shape the Drive tile shows; never an observed row). */
const persistedLoad = effectiveReadSample({
  mbps: 430,
  bytes: 5_800_000_000,
  ms: 13_500,
  source: 'model_load',
  modelId: 'qwen3.5-9b-ud-q4kxl',
  at: '2026-08-20T10:00:00Z'
})

/** A running, healthy chat runtime's status for `modelId`. */
function runningStatus(modelId: string, over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return runtimeStatus({ running: true, modelId, port: 1, healthy: true, message: 'Running', backend: 'cpu', ...over })
}

describe('buildPerformanceSnapshot', () => {
  it('flags whether the current result is this machine, lists the others, and carries the observed rows', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    const here = hereResult({ effectiveRead: persistedLoad })
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
    // No model start this session: the observed row is empty (M3) — the persisted sample is the
    // Drive tile's figure, with its own source and date, not a "while you worked" observation.
    expect(snap.observed.lastModelLoad).toBeNull()
    expect(snap.current?.effectiveRead).toEqual(persistedLoad)
  })

  describe('observed rows are session latches only (M3 / G2)', () => {
    it('a same-machine persisted-only model_load sample is NOT an observed model start', () => {
      const root = freshRoot()
      const db = seededDb(root)
      const here = hereResult({ effectiveRead: persistedLoad })
      updateSettings(db, { lastBenchmark: here, benchmarkHistory: [here] })

      const snap = buildPerformanceSnapshot(ctxWith(root, db))

      expect(snap.currentMachine).toBe(true)
      expect(snap.observed).toEqual({ lastAnswer: null, lastModelLoad: null, lastChecksum: null })
      // The Drive tile keeps the persisted figure, source and date untouched.
      expect(snap.current?.effectiveRead).toEqual(persistedLoad)
    })

    it("another computer's persisted model_load sample is not one either", () => {
      const root = freshRoot()
      const db = seededDb(root)
      const foreign = result({ effectiveRead: { ...persistedLoad, modelId: 'foreign-model' } })
      updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })

      const snap = buildPerformanceSnapshot(ctxWith(root, db))

      expect(snap.currentMachine).toBe(false)
      expect(snap.observed.lastModelLoad).toBeNull()
    })

    it('a model start THIS session is', () => {
      const root = freshRoot()
      const db = seededDb(root)
      updateSettings(db, { lastBenchmark: hereResult({ effectiveRead: persistedLoad }) })
      recordModelLoadRead('unused', 10_000, 'session-load', 3_000_000_000)

      const snap = buildPerformanceSnapshot(ctxWith(root, db))

      expect(snap.observed.lastModelLoad?.modelId).toBe('session-load')
      expect(snap.observed.lastModelLoad?.mbps).toBe(300)
    })
  })

  it('`running` reads the benchmark span itself: a foreground chat does not hide it (M1)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    const ctx = ctxWith(root, db)
    const release = ctx.runtime.occupancy.begin('benchmark')
    // `modelBusyLane` answers 'chat' first while a stream is in flight — the old read.
    inFlightStreams.set('chat', new AbortController())
    try {
      expect(buildPerformanceSnapshot(ctx).running).toBe(true)
    } finally {
      inFlightStreams.clear()
      release()
    }
    expect(buildPerformanceSnapshot(ctx).running).toBe(false)
  })

  it('the snapshot is a getter: reading it never pushes `performance:changed`', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    const spy = performanceChangedSpy()
    buildPerformanceSnapshot(ctxWith(root, db))
    buildPerformanceSnapshot(ctxWith(root, db))
    expect(spy).not.toHaveBeenCalled()
  })

  it('the Your-model block: no active model → unknown; a persisted placement for THIS machine → observed', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    let snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.model).toBeNull()
    expect(snap.placement.verdict.kind).toBe('unknown')

    // An active model with a persisted placement stamped with THIS machine.
    const here = hereKey()
    updateSettings(db, {
      activeModelId: 'some-model',
      modelPlacements: {
        'some-model': modelPlacement({
          modelId: 'some-model', contextTokens: 4096, backend: 'cpu', gpuLayers: null, totalLayers: null,
          gpuModelMb: null, cpuModelMb: 3000, gpuKvMb: null, cpuKvMb: 200, metalMaxWorkingSetMb: null,
          machineKey: here, at: '2026-09-05T00:00:00Z'
        })
      }
    })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.model?.id).toBe('some-model')
    // Not in the catalog: size 0, context from settings.
    expect(snap.placement.model?.sizeOnDiskGb).toBe(0)
    expect(snap.placement.observed?.cpuModelMb).toBe(3000)
    expect(snap.placement.verdict).toMatchObject({ kind: 'cpu', needMb: 3200, estimated: false })

    // The same record stamped with ANOTHER machine is ignored.
    updateSettings(db, { modelPlacements: { 'some-model': { ...getSettings(db).modelPlacements['some-model'], machineKey: 'elsewhere' } } })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed).toBeNull()

    // The session latch (this start) wins over the persisted record. Its context matches the
    // configured launch context, as the persisted one did — a latch measured with a DIFFERENT
    // context is no longer presented as the measured fit (see performance-schema.test.ts).
    recordModelPlacement(
      modelPlacement({
        modelId: 'some-model', contextTokens: 4096, backend: 'gpu', gpuLayers: 10, totalLayers: 10,
        gpuModelMb: 2500, cpuModelMb: 100, gpuKvMb: 300, cpuKvMb: null, metalMaxWorkingSetMb: null,
        machineKey: here, at: '2026-09-05T01:00:00Z'
      })
    )
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed?.at).toBe('2026-09-05T01:00:00Z')
    expect(snap.placement.verdict.kind).toBe('gpu')
  })

  it('lists every model the app can hold, with liveness from each service', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
    const ctx = ctxWith(root, db, {
      manifestsDir: CATALOG_MANIFESTS,
      runtime: stubChatRuntime({ modelId: 'qwen3.5-9b-ud-q4kxl', status: () => runningStatus('qwen3.5-9b-ud-q4kxl') }),
      translator: { deviceStatus: () => ({ device: 'auto', gpuLayers: 20, totalLayers: 49, live: true }) },
      vision: { isLoaded: () => false },
      reranker: { isLoaded: () => true },
      embedder: { isLoaded: () => true }
    })
    const snap = buildPerformanceSnapshot(ctx)
    const rows = snap.placement.models
    expect(rows[0]).toMatchObject({ role: 'chat', modelId: 'qwen3.5-9b-ud-q4kxl', loaded: true, lifetime: 'session' })
    // The catalog's translation model, live; pinned roles say cpu. Its split shows only on a row that
    // says 'gpu' (#671) — pinned in performance-gpu.test.ts.
    const tr = rows.find((r) => r.role === 'translation')
    expect(tr).toMatchObject({ loaded: true, lifetime: 'idle' })
    expect(tr?.modelId).toBe('translategemma-12b-it-q4')
    expect(rows.find((r) => r.role === 'vision')).toMatchObject({ device: 'cpu', loaded: false, lifetime: 'idle' })
    // A fake without the optional `devicePosture` member reports 'cpu' (Wave 8 ruling (d), the
    // `isLoaded?` pattern's own default) -- unchanged from before this step.
    expect(rows.find((r) => r.role === 'reranker')).toMatchObject({ device: 'cpu', loaded: true, lifetime: 'session' })
    expect(rows.find((r) => r.role === 'embeddings')).toMatchObject({ device: 'cpu', loaded: true })
    expect(rows.find((r) => r.role === 'transcriber')).toMatchObject({ device: 'cpu', loaded: false, lifetime: 'per-use' })
  })

  it('the chat row is "loaded" only once the ACTIVE model is running and ready (DR6)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'm' })
    const chatRow = (status: RuntimeStatus, active: unknown = null) =>
      buildPerformanceSnapshot(
        ctxWith(root, db, { runtime: { occupancy: new ModelOccupancy(), active: () => active, status: () => status } })
      ).placement.models[0]

    // A start in flight: `active()` is null through the whole window (the #109 warm-up runs
    // against the inner runtime), and the row must say so.
    expect(chatRow({ ...stoppedStatus(), message: 'Starting', startingModelId: 'm' }).loaded).toBe(false)
    // Ready.
    expect(chatRow(runningStatus('m'), { modelId: 'm' }).loaded).toBe(true)
    // A switch underway: the old model is still up, the active (new) one is not resident yet.
    expect(chatRow(runningStatus('old', { startingModelId: 'm' }), { modelId: 'old' }).loaded).toBe(false)
    // Running but not healthy, or running some other model than the active one: not this row.
    expect(chatRow(runningStatus('m', { healthy: false }), { modelId: 'm' }).loaded).toBe(false)
    expect(chatRow(runningStatus('other'), { modelId: 'other' }).loaded).toBe(false)
    // Stopped.
    expect(chatRow(stoppedStatus()).loaded).toBe(false)
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
