import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The Performance screen's push model (PR #303 audit remediation P3, owner decisions G2/G6;
// benchmark.md "Performance screen" → "Data path"):
//  - the IPC controls: `performance:get` stays gated; `benchmark:run` streams its steps to the
//    requesting window only, and a destroyed one never blocks the run;
//  - the ordering contract: the progress 'done' step precedes the persist and the occupancy
//    release, and the terminal `performance:changed` follows BOTH (it is the idle signal);
//  - the notifier itself: every send isolated (a destroyed window, a throwing recipient, a
//    throwing sink) and never a participant in the mutation that triggered it;
//  - every emit site: run start/end (success and failure; a refused run emits nothing),
//    accepted read-speed samples (including a ranked loser), the answer latch, a placement
//    observation, the moved-drive restore / upgrade seed / GPU probe writes, chat-runtime
//    transitions, resident-sidecar transitions, and the settings keys the snapshot reads.

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  windows: [] as Array<{
    isDestroyed: () => boolean
    webContents: { isDestroyed: () => boolean; send: (...args: unknown[]) => void }
  }>
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (key: string, fn: (...args: any[]) => any) => electronState.handlers.set(key, fn),
    removeHandler: (key: string) => electronState.handlers.delete(key)
  },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: { writeText: () => undefined },
  BrowserWindow: { getAllWindows: () => electronState.windows }
}))

import {
  buildPerformanceSnapshot,
  maybeRunFirstBenchmark,
  observeAnswerSpeed,
  registerBenchmarkIpc,
  runAndPersistBenchmark,
  tryGpuAgain
} from '../../src/main/ipc/registerBenchmarkIpc'
import { persistEffectiveRead, registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { notifyPerformanceChanged, setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { E5Embedder } from '../../src/main/services/embeddings/e5'
import { LlamaReranker } from '../../src/main/services/reranker/llama'
import { detectSystem } from '../../src/main/services/benchmark'
import { latestAnswerSpeed, machineKey, resetPerformanceForTests } from '../../src/main/services/performance'
import {
  latestEffectiveRead,
  recordChecksumRead,
  recordModelLoadRead,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import { llamaServerBinaryName, llamaServerDir, type ChildProcessLike } from '../../src/main/services/runtime/sidecar'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { VisionService, type VisionAnalyzer, type VisionStreamEmitter } from '../../src/main/services/vision'
import { EVENTS, IPC } from '../../src/shared/ipc'
import type { BenchmarkProgressStep, GpuDevice, GpuProbeResult, ImageAnalyzeRequest, VisionStatus } from '../../src/shared/types'
import { invoke, makeEvent } from '../helpers/ipc'
import {
  closePerformanceFixture,
  ctxWith,
  freshRoot,
  hereResult,
  performanceChangedSpy,
  result,
  seededDb
} from '../helpers/performance-fixture'

const here = () => {
  const root = freshRoot()
  const db = seededDb(root)
  const ctx = ctxWith(root, db)
  return { root, db, ctx }
}

/** 3 GB in 10 s: a 300 MB/s model-load sample. */
const loadSample = (modelId: string): void => recordModelLoadRead('unused', 10_000, modelId, 3_000_000_000)

/** A placeholder llama-server so `probeAndPersistGpu` resolves a binary; the injected probe never spawns it. */
const plantBinary = (root: string): void => {
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), '')
}

const RTX: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_576, freeMb: 22_000 }

beforeEach(() => {
  electronState.handlers.clear()
  electronState.windows.length = 0
  setPerformanceChangedSink(null)
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
})

// TH2: every root/DB here is minted through the fixture's `freshRoot`/`seededDb` (via this
// file's own `here()` helper) — the shared teardown's extra resets (first-benchmark's memo,
// the two observer setters) are additions this file never depended on being left dirty.
afterEach(closePerformanceFixture)

describe('IPC controls', () => {
  it('performance:get refuses a locked workspace and an untrusted sender', () => {
    const { ctx } = here()
    registerBenchmarkIpc(ctx)
    const get = electronState.handlers.get(IPC.getPerformance)!
    ctx.workspace.isUnlocked = () => false
    expect(() => get(makeEvent())).toThrow()
    ctx.workspace.isUnlocked = () => true
    ctx.trustedSenders.isTrusted = () => false
    expect(() => get(makeEvent(99))).toThrow()
  })

  it('benchmark:run streams its steps to the requesting window; performance:get then returns that result', async () => {
    const { ctx } = here()
    registerBenchmarkIpc(ctx)
    const event = makeEvent()
    const fresh = await electronState.handlers.get(IPC.runBenchmark)!(event)
    expect(event.sender.send.mock.calls).toEqual(
      (['system', 'drive', 'done'] as BenchmarkProgressStep[]).map((s) => [EVENTS.benchmarkProgress, s])
    )
    const snap = electronState.handlers.get(IPC.getPerformance)!(makeEvent())
    expect(snap.current.ranAt).toBe(fresh.ranAt)
    expect(snap.running).toBe(false)
  })

  it('a destroyed requesting window gets no steps; the run still completes and persists', async () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    const event = makeEvent()
    event.sender.destroy()
    const fresh = await electronState.handlers.get(IPC.runBenchmark)!(event)
    expect(event.sender.send).not.toHaveBeenCalled()
    expect(getSettings(db).lastBenchmark?.ranAt).toBe(fresh.ranAt)
  })

  it("'done' precedes the persist and the release; performance:changed follows both (the idle signal)", async () => {
    const { ctx, db } = here()
    const held = () => ctx.runtime.occupancy.held('benchmark')
    const persisted = () => getSettings(db).lastBenchmark !== null
    const spy = performanceChangedSpy(() => ({ held: held(), persisted: persisted() }))
    const atDone: Array<{ held: boolean; persisted: boolean; pushes: number }> = []

    await runAndPersistBenchmark(ctx, (step) => {
      if (step === 'done') atDone.push({ held: held(), persisted: persisted(), pushes: spy.mock.calls.length })
    })

    // At 'done' the probes are complete but nothing is persisted, the span is still held, and
    // only the run-start push has gone out.
    expect(atDone).toEqual([{ held: true, persisted: false, pushes: 1 }])
    // The two pushes bracket the run: start (span held, nothing persisted) and idle (both done).
    expect(spy.mock.results.map((r) => r.value)).toEqual([
      { held: true, persisted: false },
      { held: false, persisted: true }
    ])
    expect(buildPerformanceSnapshot(ctx).running).toBe(false)
  })
})

describe('the notifier', () => {
  it('default broadcast: a destroyed window is skipped, a throwing one never blocks the next, the live one gets the event', () => {
    const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
    const gone = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send: vi.fn() } }
    const closed = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } }
    const broken = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(() => {
          throw new Error('render frame gone')
        })
      }
    }
    electronState.windows.push(gone, closed, broken, live)

    expect(() => notifyPerformanceChanged()).not.toThrow()

    expect(live.webContents.send).toHaveBeenCalledWith(EVENTS.performanceChanged)
    expect(broken.webContents.send).toHaveBeenCalledTimes(1)
    expect(gone.webContents.send).not.toHaveBeenCalled()
    expect(closed.webContents.send).not.toHaveBeenCalled()
  })

  it('a throwing sink never blocks the persist it follows', async () => {
    const { ctx, db } = here()
    setPerformanceChangedSink(() => {
      throw new Error('sink exploded')
    })
    const fresh = await runAndPersistBenchmark(ctx)
    expect(getSettings(db).lastBenchmark?.ranAt).toBe(fresh.ranAt)
    expect(ctx.runtime.occupancy.held('benchmark')).toBe(false)
  })

  it('a FAILED run still pushes after its release (the screen is never left "running")', async () => {
    const { root, db, ctx } = here()
    // The real context resolves `db` through the vault; a lock mid-run makes the persist throw.
    let locked = false
    Object.defineProperty(ctx, 'db', {
      get: () => {
        if (locked) throw new Error('Workspace is locked')
        return db
      }
    })
    const spy = performanceChangedSpy(() => ctx.runtime.occupancy.held('benchmark'))

    await expect(
      runAndPersistBenchmark(ctx, (step) => {
        if (step === 'done') locked = true // lands right before the persist
      })
    ).rejects.toThrow(/locked/)

    expect(spy.mock.results.map((r) => r.value)).toEqual([true, false])
    expect(ctx.runtime.occupancy.held('benchmark')).toBe(false)
    expect(root).toBeTruthy()
  })

  it('a refused second run pushes nothing and leaves the first span held', async () => {
    const { ctx } = here()
    const release = ctx.runtime.occupancy.begin('benchmark') // the "first run"
    const spy = performanceChangedSpy()
    try {
      await expect(runAndPersistBenchmark(ctx)).rejects.toThrow()
      expect(spy).not.toHaveBeenCalled()
      expect(ctx.runtime.occupancy.held('benchmark')).toBe(true)
    } finally {
      release()
    }
  })
})

describe('read-speed samples', () => {
  it('a model load then a checksum: both push; the checksum fills its own row while the ranked latch and the persisted sample stay the model load', () => {
    const { ctx, db } = here()
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    registerModelIpc(ctx)
    const spy = performanceChangedSpy()

    loadSample('load')
    expect(spy).toHaveBeenCalledTimes(1)
    recordChecksumRead(3_000_000_000, 30_000, 'check')
    expect(spy).toHaveBeenCalledTimes(2)

    expect(latestEffectiveRead()?.modelId).toBe('load')
    const s = getSettings(db)
    expect(s.lastBenchmark?.effectiveRead?.modelId).toBe('load')
    expect(s.benchmarkHistory[0].effectiveRead?.modelId).toBe('load')
    const observed = buildPerformanceSnapshot(ctx).observed
    expect(observed.lastModelLoad?.modelId).toBe('load')
    expect(observed.lastChecksum?.modelId).toBe('check')
  })

  it('a retry persist pushes only when it actually wrote', () => {
    const { ctx, db } = here()
    updateSettings(db, { lastBenchmark: hereResult() })
    const spy = performanceChangedSpy()

    persistEffectiveRead(ctx) // nothing latched yet
    expect(spy).not.toHaveBeenCalled()
    loadSample('load') // no observer registered: latched only
    persistEffectiveRead(ctx) // the post-start/list/verify retry writes it
    expect(spy).toHaveBeenCalledTimes(1)
    expect(getSettings(db).lastBenchmark?.effectiveRead?.modelId).toBe('load')
    persistEffectiveRead(ctx) // the memo hit: no write, no push
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('session latches', () => {
  it('a finished answer latches with the running model and pushes', () => {
    const { ctx } = here()
    ctx.runtime.active = () => ({ modelId: 'chat-model' }) as ModelRuntime
    const spy = performanceChangedSpy()
    observeAnswerSpeed(ctx, { messageId: 'a', tokensPerSecond: 12.5, ttftMs: 800, tokens: 100 })
    expect(latestAnswerSpeed()).toMatchObject({ tokensPerSecond: 12.5, modelId: 'chat-model' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a placement observation pushes after its persist — and still pushes when the persist is skipped (locked)', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    const spy = performanceChangedSpy(() => getSettings(db).modelPlacements['m']?.contextTokens ?? null)
    const placement = {
      modelId: 'm', contextTokens: 4096, backend: 'cpu' as const, gpuLayers: null, totalLayers: null,
      gpuModelMb: null, cpuModelMb: 3000, gpuKvMb: null, cpuKvMb: 200, metalMaxWorkingSetMb: null,
      machineKey: null, at: '2026-09-05T00:00:00Z'
    }
    recordModelPlacement(placement)
    expect(spy.mock.results.map((r) => r.value)).toEqual([4096]) // persisted BEFORE the push
    ctx.workspace.isUnlocked = () => false
    recordModelPlacement({ ...placement, contextTokens: 8192 })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(getSettings(db).modelPlacements['m'].contextTokens).toBe(4096) // not persisted while locked
  })
})

describe('restore, seed and probe writes', () => {
  it('the moved-drive restore pushes once, synchronously (a root without a binary probes nothing)', async () => {
    const { ctx, db } = here()
    const foreign = result()
    const known = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, known] })
    const spy = performanceChangedSpy(() => getSettings(db).lastBenchmark?.ranAt)

    maybeRunFirstBenchmark(ctx)

    expect(spy.mock.results.map((r) => r.value)).toEqual([known.ranAt])
    await new Promise<void>((r) => setImmediate(r)) // let the void probe settle: it wrote nothing
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('the same-machine upgrade seed pushes once', () => {
    const { ctx, db } = here()
    updateSettings(db, { lastBenchmark: hereResult() })
    const spy = performanceChangedSpy(() => getSettings(db).benchmarkHistory.length)
    maybeRunFirstBenchmark(ctx)
    expect(spy.mock.results.map((r) => r.value)).toEqual([1])
  })

  it('a completed GPU probe — even an empty one — pushes after its write ("Try GPU again")', async () => {
    const { root, ctx, db } = here()
    plantBinary(root)
    ctx.probeGpu = Object.assign(async () => [], { invalidate: () => undefined })
    const spy = performanceChangedSpy(() => getSettings(db).gpuProbe?.devices ?? null)

    await tryGpuAgain(ctx)

    // The flag clear pushes first (nothing probed yet, A-D1), the probe write second.
    expect(spy.mock.results.map((r) => r.value)).toEqual([null, []])
  })

  const cannotRun: Array<[label: string, binary: boolean, probeImpl: () => Promise<GpuDevice[]>]> = [
    ['no binary for this OS (the probe is never called)', false, async () => [RTX]],
    [
      'a rejecting probe',
      true,
      async () => {
        throw new Error('driver wedged')
      }
    ]
  ]

  it.each(cannotRun)('"Try GPU again" pushes the cleared flags even when the probe cannot run — %s (A-D1)', async (_label, binary, probeImpl) => {
    const { root, ctx, db } = here()
    const before: GpuProbeResult = { devices: [RTX], probedAt: '2026-09-05T00:00:00Z', machineKey: machineKey(detectSystem()) }
    updateSettings(db, { gpuProbe: before, gpuAutoDisabled: true, gpuLastError: 'Vulkan device lost' })
    if (binary) plantBinary(root)
    ctx.probeGpu = Object.assign(probeImpl, { invalidate: () => undefined })
    const chatDevice = (): string => buildPerformanceSnapshot(ctx).placement.models.find((r) => r.role === 'chat')!.device
    // The auto-disable forces the processor: the chat row says so before the button is pressed.
    expect(chatDevice()).toBe('cpu')
    const spy = performanceChangedSpy(() => ({
      gpuAutoDisabled: getSettings(db).gpuAutoDisabled,
      gpuLastError: getSettings(db).gpuLastError,
      chat: chatDevice()
    }))

    await tryGpuAgain(ctx)

    // At least one push, and the first already reads the cleared flags through the snapshot —
    // without it the screen kept the processor-forced rows until something else pushed.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(spy.mock.results[0].value).toEqual({ gpuAutoDisabled: false, gpuLastError: null, chat: 'gpu' })
    expect(getSettings(db).gpuProbe).toEqual(before) // the probe itself wrote nothing
  })
})

describe('the chat runtime', () => {
  const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }
  const fake = (over: Partial<ModelRuntime> = {}): ModelRuntime => ({
    modelId: 'm',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: '', port: 1 }),
    chatStream: async function* () {},
    ...over
  })
  const summary = (mgr: RuntimeManager) => {
    const s = mgr.status()
    return { running: s.running, starting: s.startingModelId ?? null }
  }

  it('pushes on starting, ready and stopped, with status() already reflecting each', async () => {
    const mgr = new RuntimeManager(() => fake())
    const seen: Array<ReturnType<typeof summary>> = []
    const off = mgr.onChange(() => seen.push(summary(mgr)))

    await mgr.start(opts)
    expect(seen).toEqual([
      { running: false, starting: 'm' }, // admitted
      { running: true, starting: null }, // committed (ready)
      { running: true, starting: null } // the start window closed
    ])
    await mgr.stop()
    expect(seen.at(-1)).toEqual({ running: false, starting: null })

    off()
    await mgr.start(opts)
    expect(seen).toHaveLength(4)
  })

  it('a failed start pushes starting then stopped; a throwing listener never fails the start', async () => {
    const failing = fake({
      start: async () => {
        throw new Error('health timeout')
      }
    })
    const mgr = new RuntimeManager(() => failing)
    const seen: Array<ReturnType<typeof summary>> = []
    mgr.onChange(() => {
      throw new Error('listener exploded')
    })
    mgr.onChange(() => seen.push(summary(mgr)))
    await expect(mgr.start(opts)).rejects.toThrow(/health timeout/)
    expect(seen).toEqual([
      { running: false, starting: 'm' },
      { running: false, starting: null }
    ])

    const ok = new RuntimeManager(() => fake())
    ok.onChange(() => {
      throw new Error('listener exploded')
    })
    await expect(ok.start(opts)).resolves.toMatchObject({ running: true })
  })
})

describe('resident sidecars', () => {
  class FakeChild extends EventEmitter implements ChildProcessLike {
    pid = 9
    killed = false
    kill(): boolean {
      this.killed = true
      queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
  }
  const spawn = (): ChildProcessLike => new FakeChild()
  const fetchFor = (route: string, body: unknown): typeof fetch =>
    (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/health')) return { ok: true, status: 200 } as Response
      if (u.endsWith(route)) return { ok: true, status: 200, json: async () => body } as Response
      throw new Error(`unexpected url ${u}`)
    }) as typeof fetch
  const base = { binPath: '/bin/llama-server', modelPath: '/models/x.gguf', findPort: async () => 52000, healthIntervalMs: 1 }

  it('the embedder pushes when its sidecar lands and when it is suspended', async () => {
    const embedder = new E5Embedder({
      ...base,
      id: 'e5',
      dimensions: 2,
      spawn,
      fetchImpl: fetchFor('/v1/embeddings', { data: [{ embedding: [3, 4], index: 0 }] })
    })
    const seen: boolean[] = []
    embedder.onResidencyChange(() => seen.push(embedder.isLoaded()))

    await embedder.embed(['hello'])
    expect(seen).toEqual([true])
    await embedder.suspend()
    expect(seen).toEqual([true, false])
    await embedder.stop() // nothing resident: no flip, no push
    expect(seen).toEqual([true, false])
  })

  it('the reranker pushes the same way', async () => {
    const reranker = new LlamaReranker({
      ...base,
      id: 'rr',
      spawn,
      fetchImpl: fetchFor('/v1/rerank', { results: [{ index: 0, relevance_score: 0.9 }] })
    })
    const seen: boolean[] = []
    reranker.onResidencyChange(() => seen.push(reranker.isLoaded()))

    await reranker.rerank('q', ['doc'])
    expect(seen).toEqual([true])
    await reranker.stop()
    expect(seen).toEqual([true, false])
  })

  it('the vision service forwards the flips of every runtime it builds', async () => {
    const AVAILABLE: VisionStatus = { available: true, modelId: 'vlm', modelDisplayName: 'VLM' }
    let fire: (() => void) | null = null
    const analyzer: VisionAnalyzer = {
      analyze: async () => 'a bar chart',
      onResidencyChange: (cb) => {
        fire = cb
        return () => {
          fire = null
        }
      }
    }
    const service = new VisionService({ getStatus: async () => AVAILABLE, createRuntime: () => analyzer })
    const pushes = vi.fn()
    service.onResidencyChange(pushes)
    const emit: VisionStreamEmitter = { token: vi.fn(), done: vi.fn(), error: vi.fn() }
    const req: ImageAnalyzeRequest = {
      imageBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2]),
      mimeType: 'image/png',
      question: 'what is in this image'
    }

    service.analyze(req, emit)
    await vi.waitFor(() => expect(emit.done).toHaveBeenCalled())

    expect(fire).not.toBeNull()
    fire!()
    expect(pushes).toHaveBeenCalledTimes(1)
  })
})

describe('settings keys the snapshot reads', () => {
  it('selecting a model pushes (models:select)', async () => {
    const { ctx } = here()
    ctx.manifestsDir = join(__dirname, '..', '..', '..', '..', 'model-manifests')
    registerModelIpc(ctx)
    const spy = performanceChangedSpy()
    await invoke(electronState.handlers, IPC.selectModel, 'qwen3.5-9b-ud-q4kxl')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a settings patch touching a snapshot key pushes; one that does not stays silent', async () => {
    const { ctx } = here()
    registerCoreIpc(ctx)
    const spy = performanceChangedSpy()
    await invoke(electronState.handlers, IPC.updateSettings, { contextTokensOverride: 8192 })
    expect(spy).toHaveBeenCalledTimes(1)
    await invoke(electronState.handlers, IPC.updateSettings, { gpuMode: 'off' })
    expect(spy).toHaveBeenCalledTimes(2)
    await invoke(electronState.handlers, IPC.updateSettings, { uiLanguage: 'en' })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
