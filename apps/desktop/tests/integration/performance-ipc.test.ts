import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// The Performance screen's main-side seams (benchmark.md "History per machine" /
// "Performance screen"):
//  - a fresh benchmark files its result under this machine in `benchmarkHistory`;
//  - the moved-drive check restores a KNOWN machine's result and benchmarks a NEW one,
//    while a legacy result with no machine identity is left alone;
//  - the snapshot the screen reads (current-machine flag, other machines, observed rows —
//    session latches only, M3 — `running` from the benchmark's own span, M1, and the chat
//    row's residency from the runtime state, DR6);
//  - the progress steps a run reports: a step ticks only when it SUCCEEDED (L3).

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
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { detectSystem, runBenchmark } from '../../src/main/services/benchmark'
import { machineKey, recordAnswerSpeed, resetPerformanceForTests } from '../../src/main/services/performance'
import { recordChecksumRead, recordModelLoadRead, resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { BenchmarkProgressStep, BenchmarkResult, EffectiveReadSample, RuntimeStatus } from '../../src/shared/types'
import {
  ctxWith,
  freshRoot,
  hereResult,
  performanceChangedSpy,
  result,
  seededDb,
  stoppedStatus
} from '../helpers/performance-fixture'

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
  setPerformanceChangedSink(null)
  inFlightStreams.clear()
})

/** A persisted model-load sample (the shape the Drive tile shows; never an observed row). */
const persistedLoad: EffectiveReadSample = {
  mbps: 430,
  bytes: 5_800_000_000,
  ms: 13_500,
  source: 'model_load',
  modelId: 'qwen3.5-9b-ud-q4kxl',
  at: '2026-08-20T10:00:00Z'
}

/** A bare runtime whose stream yields a few chunks with timings — enough for the speed leg. */
function stubRuntime(over: Partial<ModelRuntime> = {}): ModelRuntime {
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
    },
    ...over
  }
}

/** A running, healthy chat runtime's status for `modelId`. */
function runningStatus(modelId: string, over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return { running: true, modelId, port: 1, healthy: true, message: 'Running', backend: 'cpu', ...over }
}

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
    const here = hereResult({ effectiveRead: persistedLoad })
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

  it('carries the live GPU probe for the graphics tile', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, {
      lastBenchmark: hereResult(),
      gpuProbe: { devices: [{ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, freeMb: 20000 }], probedAt: '2026-09-05T00:00:00Z' }
    })
    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    // P5: the display device carries the shared rule's verdict (an RTX 3090 is usable).
    expect(snap.currentGpu).toEqual({ name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, useful: true })
    // The result predates gpuVramMb: the probe's device is folded in for THIS machine, name and
    // memory together…
    expect(snap.current?.gpuVramMb).toBe(24576)
    expect(snap.current?.gpu).toBe('NVIDIA GeForce RTX 3090')
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

    // The session latch (this start) wins over the persisted record. Its context matches the
    // configured launch context, as the persisted one did — a latch measured with a DIFFERENT
    // context is no longer presented as the measured fit (see performance-schema.test.ts).
    recordModelPlacement({
      modelId: 'some-model', contextTokens: 4096, backend: 'gpu', gpuLayers: 10, totalLayers: 10,
      gpuModelMb: 2500, cpuModelMb: 100, gpuKvMb: 300, cpuKvMb: null, metalMaxWorkingSetMb: null,
      machineKey: here, at: '2026-09-05T01:00:00Z'
    })
    snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed?.at).toBe('2026-09-05T01:00:00Z')
    expect(snap.placement.verdict.kind).toBe('gpu')
  })

  it('lists every model the app can hold, with liveness from each service and the totals', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
    const ctx = ctxWith(root, db, {
      manifestsDir: join(__dirname, '..', '..', '..', '..', 'model-manifests'),
      runtime: {
        occupancy: new ModelOccupancy(),
        active: () => ({ modelId: 'qwen3.5-9b-ud-q4kxl' }),
        status: () => runningStatus('qwen3.5-9b-ud-q4kxl')
      },
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

describe('runBenchmark progress: a step ticks only when it succeeded (L3 / T4)', () => {
  const run = async (
    over: Partial<Parameters<typeof runBenchmark>[0]>,
    workspacePath = join(freshRoot(), 'workspace')
  ): Promise<BenchmarkProgressStep[]> => {
    const steps: BenchmarkProgressStep[] = []
    await runBenchmark({ workspacePath, manifests: [], onProgress: (s) => steps.push(s), ...over })
    return steps
  }

  it('no runtime: system, drive, done', async () => {
    expect(await run({})).toEqual(['system', 'drive', 'done'])
  })

  it('a runtime that produced a reading: system, drive, speed, done', async () => {
    expect(await run({ runtime: stubRuntime() })).toEqual(['system', 'drive', 'speed', 'done'])
  })

  it('a runtime that was busy elsewhere (the leg skipped, #185): no speed step', async () => {
    expect(await run({ runtime: stubRuntime(), modelBusy: () => true })).toEqual(['system', 'drive', 'done'])
  })

  it('a speed probe that failed (the stream threw): no speed step', async () => {
    const failing = stubRuntime({
      async *chatStream() {
        throw new Error('sidecar gone')
      }
    })
    expect(await run({ runtime: failing })).toEqual(['system', 'drive', 'done'])
  })

  it('a drive probe that failed (unwritable workspace): no drive step, and no later step implies it', async () => {
    const missing = join(freshRoot(), 'does-not-exist', 'workspace')
    const steps = await run({ runtime: stubRuntime() }, missing)
    expect(steps).toEqual(['system', 'speed', 'done'])
  })

  it('a throwing onProgress never fails the run', async () => {
    const workspacePath = join(freshRoot(), 'workspace')
    const seen: BenchmarkProgressStep[] = []
    const fresh = await runBenchmark({
      workspacePath,
      manifests: [],
      onProgress: (s) => {
        seen.push(s)
        throw new Error('renderer gone')
      }
    })
    expect(seen).toEqual(['system', 'drive', 'done'])
    expect(fresh.profile).toBeTruthy()
  })
})
