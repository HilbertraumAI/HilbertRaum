import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T11 (PR #303 audit remediation, P8): the WIRING around the placement parser — the two ends
// nothing covered before. `placement-parser.test.ts` proves the line shapes and
// `performance-*.test.ts` prove the snapshot; between them sits the seam that actually produces
// a record:
//
//   1. the START LADDER — a rung's stderr reaches THAT attempt's parser, the reading is latched
//      with the backend/context/machine stamp, and it is latched BEFORE the #109 warm-up (a
//      record that only appeared after a warm-up generation would be invisible to the screen the
//      user is already looking at);
//   2. one parser PER ATTEMPT — a retried rung must not sum the failed attempt's buffers into
//      the successful one's reading (`createPlacementParser()` is called inside the walk);
//   3. the PERSISTER — `registerBenchmarkIpc`'s `setModelPlacementObserver` writes
//      `settings.modelPlacements[modelId]` through P4's normalizer, skips the write while the
//      workspace is locked (or locking), and pushes `performance:changed` EITHER WAY (P3: the
//      session latch moved, so the screen must re-read even when nothing was persisted).
//
// Follow-up I1 — capture a REAL llama.cpp verbosity-4 log and pin these numbers to it — is
// CLOSED (#329): both logs below are captured from the pinned build (b9849 799fcc04a) and
// committed byte-for-byte. `placement-b9849-partial-20of33-hybrid.txt` is a 20/33 partial
// offload on a hybrid Radeon-iGPU + RTX-3060 laptop (its cache spill lands in a plain `CPU KV`
// buffer and it carries the recurrent-state pair); `placement-b9849-full-49of49-swa.txt` is a
// 49/49 full offload of Gemma on an RTX 3080 Ti. So this file now proves the WIRING carries a
// real reading end to end, not a shape someone typed.

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

import { registerBenchmarkIpc } from '../../src/main/ipc/registerBenchmarkIpc'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { createSelectingRuntimeFactory, type LlamaRungOptions } from '../../src/main/services/runtime/factory'
import {
  latestModelPlacement,
  recordModelPlacement,
  resetModelPlacementForTests,
  setModelPlacementObserver
} from '../../src/main/services/runtime/placement'
import { resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import { getSettings } from '../../src/main/services/settings'
import type { ModelPrefetch, PrefetchOutcome } from '../../src/main/services/runtime/prefetch'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { GpuDevice, ModelPlacement } from '../../src/shared/types'
import { hangPolls } from '../helpers/hang-budget'
import {
  closePerformanceFixture,
  ctxWith,
  freshRoot,
  performanceChangedSpy,
  seededDb
} from '../helpers/performance-fixture'

const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 4096 }

const RTX: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226 }

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')

/**
 * A REAL partial offload onto a 6 GB laptop card: 20 of 33 layers on the GPU, the rest of the
 * weights `CPU_Mapped`, and the context cache (KV plus the hybrid model's per-sequence recurrent
 * state) split between the card and plain CPU buffers. Captured on b9849; the parser test greps
 * every figure of it line by line.
 */
const PARTIAL_LOG = fixture('placement-b9849-partial-20of33-hybrid.txt')

/** The reading `PARTIAL_LOG` must produce — on its own, and after a discarded first attempt. */
const PARTIAL_READING = {
  gpuLayers: 20,
  totalLayers: 33,
  gpuModelMb: 3393.11,
  cpuModelMb: 2286.14,
  gpuKvMb: 160,
  cpuKvMb: 96,
  gpuRsMb: 29.31,
  cpuRsMb: 20.94,
  metalMaxWorkingSetMb: null,
  // The FIRST device_info row is the Radeon iGPU on this box — the legacy summary field, kept
  // as the parser reports it; the snapshot attributes through `devices` (DR2).
  gpuFreeAtStartMb: 8441,
  gpuComputeMb: 498,
  devices: [
    { label: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', totalMb: 8886, freeMb: 8441, computeMb: null },
    { label: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226, computeMb: 498 }
  ]
}

/**
 * A REAL FULL offload with much bigger buffers (49/49, 6637.63 MiB of weights and a 2,048 MiB
 * SWA cache pair on an RTX 3080 Ti) — the attempt that then fails to come up.
 */
const FULL_LOG = fixture('placement-b9849-full-49of49-swa.txt')

interface LadderAttempt {
  binPath: string
  extraArgs: string[]
  /** The parser feed THIS attempt was handed — its identity is the one-parser-per-attempt proof. */
  onStderrData?: (text: string) => void
}

/**
 * A dedicated ladder harness (`runtime-ladder.test.ts`'s own is deliberately left untouched):
 * the fake llama emits a per-attempt stderr fixture from INSIDE `start()` — through the very
 * `rung.onStderrData` the ladder handed it — before it resolves or throws, which is the order a
 * real load prints in. `chatGate` holds the #109 warm-up open so the latch can be read mid-start.
 */
function ladderHarness(config: {
  /** Attempts 0..failFirst-1 throw AFTER emitting their log (a server that died while loading). */
  failFirst?: number
  /** Stderr the Nth attempt emits; a missing entry means that attempt printed nothing. */
  stderr?: string[]
  probe?: GpuDevice[]
  machineKey?: () => string | null
  /** Fired at the top of the warm-up generation, before `chatGate` is awaited. */
  onChat?: () => void
  /** The warm-up generation awaits this before finishing. */
  chatGate?: Promise<void>
}) {
  const attempts: LadderAttempt[] = []

  // #114: the ladder prefetches on the first attempt — injected, so no test reads a real file.
  const makePrefetch = (_paths: string[]): ModelPrefetch => {
    let settle!: (outcome: PrefetchOutcome) => void
    const done = new Promise<PrefetchOutcome>((resolve) => {
      settle = resolve
    })
    return { done, abort: () => settle('aborted') }
  }

  const makeLlama = (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime => {
    const index = attempts.length
    attempts.push({ binPath, extraArgs: rung?.extraArgs ?? [], onStderrData: rung?.onStderrData })
    return {
      modelId: o.modelId,
      start: async () => {
        const log = config.stderr?.[index]
        if (log != null) rung?.onStderrData?.(log)
        if (index < (config.failFirst ?? 0)) throw new Error(`rung ${index + 1} failed to start`)
      },
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 5000 + index }),
      chatStream: async function* () {
        config.onChat?.()
        if (config.chatGate) await config.chatGate
      }
    }
  }

  const factory = createSelectingRuntimeFactory({
    rootPath: '/root',
    machineKey: config.machineKey,
    resolveBin: () => '/bin/llama-server',
    modelExists: () => true,
    makeLlama,
    makeMock: (o) => ({
      modelId: o.modelId,
      backend: 'mock',
      gpuName: null,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'mock', port: null }),
      chatStream: async function* () {}
    }),
    makePrefetch,
    gpu: {
      getGpuMode: () => 'auto',
      getGpuAutoDisabled: () => false,
      probeDevices: async () => config.probe ?? [],
      resolveCpuBin: () => '/bin/cpu/llama-server'
    }
  })

  return { factory, attempts }
}

/** Resolve once `cond` holds — polled on observable state, never a fixed sleep. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < hangPolls(500, 1); i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error('condition not reached')
}

/** A fully-populated record (every optional field set), for the persister half. */
function placementRecord(over: Partial<ModelPlacement> = {}): ModelPlacement {
  return {
    modelId: 'm',
    contextTokens: 4096,
    backend: 'gpu',
    ...PARTIAL_READING,
    devices: PARTIAL_READING.devices.map((d) => ({ ...d })),
    machineKey: 'k-test',
    at: '2026-09-05T10:00:00.000Z',
    ...over
  }
}

const here = () => {
  const root = freshRoot()
  const db = seededDb(root)
  return { db, ctx: ctxWith(root, db) }
}

beforeEach(() => {
  electronState.handlers.clear()
  electronState.windows.length = 0
  setPerformanceChangedSink(null)
  resetModelPlacementForTests()
  resetEffectiveReadForTests()
})

afterEach(closePerformanceFixture)

describe('the start ladder feeds the placement latch', () => {
  it('latches the reading with the backend, context and machine stamp before the warm-up ends', async () => {
    let releaseWarmUp!: () => void
    const chatGate = new Promise<void>((resolve) => {
      releaseWarmUp = resolve
    })
    let warmUpEntered = false
    const h = ladderHarness({
      probe: [RTX],
      stderr: [PARTIAL_LOG],
      machineKey: () => 'k-test',
      chatGate,
      onChat: () => {
        warmUpEntered = true
      }
    })

    const runtime = h.factory(opts)
    let startResolved = false
    const started = (async () => {
      await runtime.start()
      startResolved = true
    })()

    // Read the latch while the warm-up is still OPEN: the Performance screen must not have to
    // wait out a hidden generation (capped at 90 s) before it can show "Your model".
    await until(() => warmUpEntered)
    expect(startResolved).toBe(false)
    expect(latestModelPlacement()).toEqual({
      modelId: 'm',
      contextTokens: 4096,
      backend: 'gpu',
      ...PARTIAL_READING,
      machineKey: 'k-test',
      at: expect.any(String)
    })
    const at = latestModelPlacement()!.at
    expect(at).toBe(new Date(at).toISOString()) // an ISO instant, not a Date or a local string

    releaseWarmUp()
    await started
    expect(startResolved).toBe(true)
    // The warm-up neither replaces nor clears the observation it ran behind.
    expect(latestModelPlacement()!.at).toBe(at)
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0].onStderrData).toBeTypeOf('function')
  })

  it('stamps a null machineKey when the factory was built without one', async () => {
    const h = ladderHarness({ probe: [RTX], stderr: [PARTIAL_LOG] })
    await h.factory(opts).start()
    expect(latestModelPlacement()?.machineKey).toBeNull()
  })

  it('labels a start whose probe found nothing as cpu, with the same reading', async () => {
    const h = ladderHarness({ probe: [], stderr: [PARTIAL_LOG], machineKey: () => 'k-test' })
    await h.factory(opts).start()
    expect(latestModelPlacement()).toMatchObject({ backend: 'cpu', gpuLayers: 20, totalLayers: 33 })
  })

  it('gives every attempt its OWN parser: a retried rung never sums the failed load', async () => {
    const h = ladderHarness({
      failFirst: 1,
      probe: [RTX],
      stderr: [FULL_LOG, PARTIAL_LOG],
      machineKey: () => 'k-test'
    })
    await h.factory(opts).start()

    // Rung 1 (GPU) printed a 49/49 full offload and then died; rung 2 (--device none) came up.
    expect(h.attempts).toHaveLength(2)
    expect(h.attempts[0].extraArgs).toEqual([])
    expect(h.attempts[1].extraArgs).toEqual(['--device', 'none'])
    // Two feeds, not one shared parser — the identity IS the one-parser-per-attempt rule.
    expect(h.attempts[0].onStderrData).toBeTypeOf('function')
    expect(h.attempts[1].onStderrData).toBeTypeOf('function')
    expect(h.attempts[0].onStderrData).not.toBe(h.attempts[1].onStderrData)

    // ONLY the second attempt's figures: 20/33 layers (not 49/49), 3393.11 MiB of weights on the
    // card (not 10030.74 = 6637.63 + 3393.11), 160 MiB of KV cache (not 2208), 498 MiB of working
    // buffers (not 1039.07) — and the second log's own device rows, not the 3080 Ti's.
    expect(latestModelPlacement()).toEqual({
      modelId: 'm',
      contextTokens: 4096,
      backend: 'cpu',
      ...PARTIAL_READING,
      machineKey: 'k-test',
      at: expect.any(String)
    })
  })

  it('completes the start even when the persisting observer throws', async () => {
    let observed = 0
    setModelPlacementObserver(() => {
      observed += 1
      throw new Error('boom')
    })
    const h = ladderHarness({ probe: [RTX], stderr: [PARTIAL_LOG], machineKey: () => 'k-test' })
    const runtime = h.factory(opts)
    await expect(runtime.start()).resolves.toBeUndefined()
    expect(observed).toBe(1)
    expect(runtime.backend).toBe('gpu')
    expect(latestModelPlacement()).toMatchObject({ modelId: 'm', gpuLayers: 20 })
  })
})

describe('registerBenchmarkIpc persists every observed placement', () => {
  it('writes the record under its own model id, optional fields intact, and pushes once', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    const spy = performanceChangedSpy(() => getSettings(db).modelPlacements['m']?.gpuComputeMb ?? null)

    const record = placementRecord()
    recordModelPlacement(record)

    // Round-trips through P4's normalizer unchanged — `gpuFreeAtStartMb`, `gpuComputeMb`, the
    // recurrent-state pair and the per-device rows are OPTIONAL fields, and a normalizer that
    // dropped them would still leave a valid-looking record behind.
    expect(getSettings(db).modelPlacements['m']).toEqual(record)
    const stored = getSettings(db).modelPlacements['m']
    expect(stored.gpuRsMb).toBe(29.31)
    expect(stored.cpuRsMb).toBe(20.94)
    expect(spy).toHaveBeenCalledTimes(1)
    // The persist precedes the push (P3 ordering: the probe reads settings inside the push).
    expect(spy.mock.results.map((r) => r.value)).toEqual([498])
  })

  it('files each record under its own model id and keeps the earlier models', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    const spy = performanceChangedSpy()

    recordModelPlacement(placementRecord())
    recordModelPlacement(placementRecord({ modelId: 'qwen3.5-9b-ud-q4kxl', backend: 'cpu', contextTokens: 8192 }))

    const placements = getSettings(db).modelPlacements
    expect(Object.keys(placements).sort()).toEqual(['m', 'qwen3.5-9b-ud-q4kxl'])
    // P4's normalizer DROPS any entry whose key is not its own `modelId` (one model's measurement
    // must never be handed to another), so the write has to key by the record — round-trip proves it.
    for (const [key, value] of Object.entries(placements)) expect(value.modelId).toBe(key)
    expect(placements['m'].contextTokens).toBe(4096)
    expect(placements['qwen3.5-9b-ud-q4kxl']).toMatchObject({ backend: 'cpu', contextTokens: 8192 })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('re-recording the same model replaces that row and leaves the others alone', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    recordModelPlacement(placementRecord({ modelId: 'other' }))
    recordModelPlacement(placementRecord())
    recordModelPlacement(placementRecord({ contextTokens: 16384, gpuLayers: 33, at: '2026-09-06T10:00:00.000Z' }))

    const placements = getSettings(db).modelPlacements
    expect(placements['m']).toMatchObject({ contextTokens: 16384, gpuLayers: 33, at: '2026-09-06T10:00:00.000Z' })
    expect(placements['other'].contextTokens).toBe(4096)
  })

  it('skips the write while the workspace is LOCKED but still pushes (the latch moved)', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    recordModelPlacement(placementRecord())
    const spy = performanceChangedSpy()

    ctx.workspace.isUnlocked = () => false
    recordModelPlacement(placementRecord({ contextTokens: 8192 }))

    expect(getSettings(db).modelPlacements['m'].contextTokens).toBe(4096) // unchanged on disk
    expect(latestModelPlacement()?.contextTokens).toBe(8192) // the session latch DID move
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('skips the write while the workspace is LOCKING (AUD-02) but still pushes', () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    recordModelPlacement(placementRecord())
    const spy = performanceChangedSpy()

    // The DB stays OPEN for the whole multi-second lock teardown, so `isUnlocked()` is still true
    // here — only `workspaceAdmitsWork`'s `isLocking()` leg refuses this write.
    ctx.workspace.isLocking = () => true
    recordModelPlacement(placementRecord({ modelId: 'late-arrival' }))

    expect(Object.keys(getSettings(db).modelPlacements)).toEqual(['m'])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a ladder start lands in settings through the registered observer, end to end', async () => {
    const { ctx, db } = here()
    registerBenchmarkIpc(ctx)
    const spy = performanceChangedSpy()

    const h = ladderHarness({ probe: [RTX], stderr: [PARTIAL_LOG], machineKey: () => 'k-test' })
    await h.factory(opts).start()

    expect(getSettings(db).modelPlacements['m']).toEqual({
      modelId: 'm',
      contextTokens: 4096,
      backend: 'gpu',
      ...PARTIAL_READING,
      machineKey: 'k-test',
      at: latestModelPlacement()!.at
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
