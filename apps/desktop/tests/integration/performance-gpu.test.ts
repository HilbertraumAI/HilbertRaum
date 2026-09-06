import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The graphics figures of the Performance screen come from ONE eligible source (PR #303 audit
// M8 / N1 / DR1 / DR2 / DR5, owner decisions G3 / G4):
//  - the persisted probe is STAMPED with the machine it ran on, and a probe stamped with
//    another machine supplies nothing; an unstamped legacy probe stays eligible (G3);
//  - of the eligible probe, ONE device is selected — the BUDGET device for the next start
//    (`nextStartMemory`: the largest usable card; PR #308 audit decision 9, unified with this
//    audit's M8.2 at the merge of the two) — and its name and memory travel together into the
//    benchmark result, the fold-in, `currentGpu` and the VRAM budget — on a hybrid
//    [iGPU, dGPU] box that is the dGPU, never devices[0]; an integrated-only box has NO device
//    for the next start (null everywhere, the RAM pick);
//  - the probe write: every path persists THIS session's stamped answer — a resolved list
//    (empty included), no binary and a rejecting probe alike (PR #308 audit decision 6: a
//    stale same-machine card must not survive a failed refresh; an empty stamped result
//    re-stamps no old device); a probe that outlives a lock or its workspace session writes
//    nothing — and "Try GPU again" pushes as soon as it clears the flags, before the probe's
//    own write pushes again (A-D1);
//  - the rows say where a model runs under the CURRENT configuration (DR1), the free/working
//    figures are attributed to the selected device (DR2), and the "everything at once" total
//    is class-aware (DR5);
//  - the hardware-profile bump follows ALL devices, as before (G4).

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { buildPerformanceSnapshot, runAndPersistBenchmark, tryGpuAgain } from '../../src/main/ipc/registerBenchmarkIpc'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { classifyProfile, detectSystem } from '../../src/main/services/benchmark'
import type { AppContext } from '../../src/main/services/context'
import type { Db } from '../../src/main/services/db'
import { machineKey, memoryClassOf, resetPerformanceForTests } from '../../src/main/services/performance'
import { resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type {
  AppSettings,
  BenchmarkResult,
  GpuDevice,
  GpuProbeResult,
  ModelPlacement,
  PerformanceSnapshot,
  RuntimeStatus,
  TranslationDeviceStatus
} from '../../src/shared/types'
import {
  closePerformanceFixture,
  ctxWith,
  freshRoot,
  hereResult,
  performanceChangedSpy,
  result,
  seededDb
} from '../helpers/performance-fixture'

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
  setPerformanceChangedSink(null)
})

// TH2: every root/DB in this file (including via the `cardMachine`/`withLog` helpers below)
// comes from the fixture's `freshRoot`/`seededDb` — safe to add the shared teardown.
afterEach(closePerformanceFixture)

const IRIS: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16_384, freeMb: 15_000 }
const RTX: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_576, freeMb: 22_000 }
const PROBED_AT = '2026-09-05T00:00:00Z'
const FOREIGN_KEY = 'linux|x64|Some Other CPU|32|64'
const CHAT = 'qwen3.5-9b-ud-q4kxl'
const MANIFESTS = join(__dirname, '..', '..', '..', '..', 'model-manifests')

const here = (): string | null => machineKey(detectSystem())

/** A persisted probe: unstamped (legacy) when `stamp` is omitted, else stamped with it. */
function probe(devices: GpuDevice[], stamp?: string | null): GpuProbeResult {
  return stamp === undefined ? { devices, probedAt: PROBED_AT } : { devices, probedAt: PROBED_AT, machineKey: stamp }
}

/** A result of THIS machine persisted before `gpuVramMb` existed, naming whatever `gpu` says. */
function legacyResult(gpu: string | null = null): BenchmarkResult {
  const r = hereResult({ gpu })
  delete r.gpuVramMb
  return r
}

/** A placeholder llama-server so `probeAndPersistGpu` resolves a binary; the injected probe never spawns it. */
function withBinary(root: string): void {
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), '')
}

function fakeProbe(impl: () => Promise<GpuDevice[]>): CachedGpuProbe {
  return Object.assign((_bin: string) => impl(), { invalidate: () => undefined })
}

function runningStatus(modelId: string): RuntimeStatus {
  return { running: true, modelId, port: 1, healthy: true, message: 'Running', backend: 'gpu' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('one eligible source: the selected device (M8.2)', () => {
  it('a hybrid [iGPU, dGPU] probe: currentGpu, the VRAM budget, the class and the fold-in all describe the dGPU', () => {
    const root = freshRoot()
    const db = seededDb(root)
    // An "already-mixed" older row: the old devices[0] rule recorded the iGPU's name.
    updateSettings(db, { lastBenchmark: legacyResult(IRIS.name), gpuProbe: probe([IRIS, RTX]) })

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    expect(snap.currentGpu).toEqual({ name: RTX.name, totalMb: RTX.totalMb, useful: true })
    expect(snap.placement.vramMb).toBe(RTX.totalMb)
    expect(snap.placement.memoryClass).toBe(memoryClassOf(process.platform, process.arch, [IRIS, RTX]))
    expect(snap.placement.memoryClass).not.toBe('cpu')
    // The fold-in replaces NAME and memory together: never the old iGPU name with the dGPU's figure.
    expect(snap.current?.gpu).toBe(RTX.name)
    expect(snap.current?.gpuVramMb).toBe(RTX.totalMb)
  })

  it('an integrated-only probe: no budget device — currentGpu is null, no VRAM budget, nothing folded in (M8.1 / PR #308 decision 9)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: legacyResult(), gpuProbe: probe([IRIS]) })

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    // The #303 P5 rule named the iGPU with `useful: false`; merged with #308, the snapshot
    // names the BUDGET device only, and an integrated device is not one for any consumer —
    // the tile reads "No usable graphics card", the ★ is the RAM pick. A RECORDED integrated
    // device (a legacy or foreign result) still reads "Integrated, shared memory" on screen.
    expect(snap.currentGpu).toBeNull()
    expect(snap.placement.vramMb).toBeNull()
    expect(snap.placement.memoryClass).toBe(memoryClassOf(process.platform, process.arch, [IRIS]))
    expect(snap.current?.gpu).toBeNull()
    expect(snap.current?.gpuVramMb).toBeUndefined()
  })

  it('a result that already carries a figure is left alone; a foreign result is never folded', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult({ gpu: 'NVIDIA GeForce GTX 1650', gpuVramMb: 4096 }), gpuProbe: probe([RTX]) })
    expect(buildPerformanceSnapshot(ctxWith(root, db)).current).toMatchObject({ gpu: 'NVIDIA GeForce GTX 1650', gpuVramMb: 4096 })

    const foreign = result()
    delete (foreign as Partial<BenchmarkResult>).gpuVramMb
    updateSettings(db, { lastBenchmark: foreign })
    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.currentMachine).toBe(false)
    expect(snap.current?.gpuVramMb).toBeUndefined()
    expect(snap.current?.gpu).toBe(foreign.gpu)
    // The probe is still this machine's: the tile may show it beside the foreign result's own copy.
    expect(snap.currentGpu).toEqual({ name: RTX.name, totalMb: RTX.totalMb, useful: true })
  })

  it('the benchmark records the selected device as one pair; the profile bump follows ALL devices (G4)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)

    const hybrid = await runAndPersistBenchmark(ctxWith(root, db, { probeGpu: fakeProbe(async () => [IRIS, RTX]) }))
    expect(hybrid.gpu).toBe(RTX.name)
    expect(hybrid.gpuVramMb).toBe(RTX.totalMb)
    expect(hybrid.profile).toBe(classifyProfile(hybrid.ramGb, { gpuUseful: true }))
    // The probe write is stamped with this machine.
    expect(getSettings(db).gpuProbe).toMatchObject({ devices: [IRIS, RTX], machineKey: here() })

    const igpu = await runAndPersistBenchmark(ctxWith(root, db, { probeGpu: fakeProbe(async () => [IRIS]) }))
    // No budget device: the record names no card (the next start runs from RAM) and it bumps nothing.
    expect(igpu.gpu).toBeNull()
    expect(igpu.gpuVramMb).toBeNull()
    expect(igpu.profile).toBe(classifyProfile(igpu.ramGb, { gpuUseful: false }))

    const none = await runAndPersistBenchmark(ctxWith(root, db, { probeGpu: fakeProbe(async () => []) }))
    expect(none.gpu).toBeNull()
    expect(none.gpuVramMb).toBeNull()
  })
})

describe('probe identity (M8.3, G3)', () => {
  it('a probe stamped with ANOTHER machine supplies nothing: no fold-in, no currentGpu, no class beyond cpu, no budget', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: legacyResult(), gpuProbe: probe([RTX], FOREIGN_KEY) })

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    expect(snap.currentGpu).toBeNull()
    expect(snap.current?.gpuVramMb).toBeUndefined()
    expect(snap.current?.gpu).toBeNull()
    expect(snap.placement.vramMb).toBeNull()
    expect(snap.placement.memoryClass).toBe(memoryClassOf(process.platform, process.arch, []))
    // The raw settings still hold the devices — nothing was deleted, they are just not this machine's.
    expect(getSettings(db).gpuProbe).toEqual(probe([RTX], FOREIGN_KEY))
  })

  it('an unstamped legacy probe stays eligible (unverifiable until a local refresh replaces it)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: legacyResult(), gpuProbe: probe([RTX]) })
    expect('machineKey' in getSettings(db).gpuProbe!).toBe(false)

    const snap = buildPerformanceSnapshot(ctxWith(root, db))

    expect(snap.currentGpu).toEqual({ name: RTX.name, totalMb: RTX.totalMb, useful: true })
    expect(snap.placement.vramMb).toBe(RTX.totalMb)
    expect(snap.current?.gpuVramMb).toBe(RTX.totalMb)
  })

  it('a probe stamped with THIS machine, or with an unknown identity, is eligible', () => {
    for (const stamp of [here(), null]) {
      const root = freshRoot()
      const db = seededDb(root)
      updateSettings(db, { lastBenchmark: legacyResult(), gpuProbe: probe([RTX], stamp) })
      expect(buildPerformanceSnapshot(ctxWith(root, db)).currentGpu).toEqual({ name: RTX.name, totalMb: RTX.totalMb, useful: true })
    }
  })
})

describe('the probe write (probeAndPersistGpu, through "Try GPU again")', () => {
  /** What a push saw (A-D1): the flags as written by then, the probe as it stood. */
  const flagsAndProbe = (db: Db) => () => {
    const s = getSettings(db)
    return { gpuAutoDisabled: s.gpuAutoDisabled, gpuLastError: s.gpuLastError, gpuProbe: s.gpuProbe }
  }

  it('no binary for this OS: the probe never runs, yet an EMPTY probe stamped with THIS machine replaces the old one — the flag clear pushes first, the write pushes again (A-D1)', async () => {
    // The #303 P5 rule wrote nothing here so old devices were never re-stamped as local; merged
    // with #308 (decision 6, findings R3/R5) every path persists this session's answer: the empty
    // stamped result re-stamps no old device, and a stale SAME-machine card no longer survives a
    // refresh that could not see it (picker-seams.test.ts pins that case). "Try GPU again" pushes
    // as soon as it clears the flags (#303 P10, A-D1), so the sequence is TWO pushes: the first
    // sees the cleared flags and the untouched foreign probe, the second the empty stamped probe.
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = probe([RTX], FOREIGN_KEY)
    updateSettings(db, { gpuProbe: foreign, gpuAutoDisabled: true, gpuLastError: 'Vulkan device lost' })
    const probeFn = vi.fn(async () => [IRIS])
    const spy = performanceChangedSpy(flagsAndProbe(db))

    await tryGpuAgain(ctxWith(root, db, { probeGpu: fakeProbe(probeFn) }))

    expect(probeFn).not.toHaveBeenCalled()
    const written = getSettings(db).gpuProbe!
    expect(written.devices).toEqual([])
    expect(written.machineKey).toBe(here())
    expect(Number.isNaN(new Date(written.probedAt).getTime())).toBe(false)
    expect(spy.mock.results.map((r) => r.value)).toEqual([
      { gpuAutoDisabled: false, gpuLastError: null, gpuProbe: foreign },
      { gpuAutoDisabled: false, gpuLastError: null, gpuProbe: written }
    ])
  })

  it('a rejecting probe: the same EMPTY stamped probe replaces the old devices (the old ones are never re-stamped as local) — the flag clear pushes first, the write pushes again (A-D1)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)
    const foreign = probe([RTX], FOREIGN_KEY)
    updateSettings(db, { gpuProbe: foreign, gpuAutoDisabled: true, gpuLastError: 'Vulkan device lost' })
    const spy = performanceChangedSpy(flagsAndProbe(db))

    await tryGpuAgain(ctxWith(root, db, { probeGpu: fakeProbe(async () => { throw new Error('driver wedged') }) }))

    const written = getSettings(db).gpuProbe!
    expect(written.devices).toEqual([])
    expect(written.machineKey).toBe(here())
    expect(spy.mock.results.map((r) => r.value)).toEqual([
      { gpuAutoDisabled: false, gpuLastError: null, gpuProbe: foreign },
      { gpuAutoDisabled: false, gpuLastError: null, gpuProbe: written }
    ])
  })

  it('an EMPTY result replaces the old devices with the current, stamped, empty probe — and pushes', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)
    updateSettings(db, { gpuProbe: probe([RTX], FOREIGN_KEY) })
    const spy = performanceChangedSpy(() => getSettings(db).gpuProbe)

    await tryGpuAgain(ctxWith(root, db, { probeGpu: fakeProbe(async () => []) }))

    const written = getSettings(db).gpuProbe!
    expect(written.devices).toEqual([])
    expect(written.machineKey).toBe(here())
    expect(Number.isNaN(new Date(written.probedAt).getTime())).toBe(false)
    // Pushed after the flag clear (the old probe still in place) and again after the write (A-D1).
    expect(spy.mock.results.map((r) => r.value)).toEqual([probe([RTX], FOREIGN_KEY), written])
  })

  it('a probe-only refresh writes the devices stamped with this machine and pushes', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)
    const spy = performanceChangedSpy()

    const settings = await tryGpuAgain(ctxWith(root, db, { probeGpu: fakeProbe(async () => [IRIS, RTX]) }))

    expect(settings.gpuProbe).toMatchObject({ devices: [IRIS, RTX], machineKey: here() })
    expect(spy).toHaveBeenCalledTimes(2) // the flag clear, then the write (A-D1)
  })

  it('a probe that resolves after the workspace locked writes nothing', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)
    const before = probe([RTX], FOREIGN_KEY)
    updateSettings(db, { gpuProbe: before })
    let unlocked = true
    const pending = deferred<GpuDevice[]>()
    const ctx = ctxWith(root, db, {
      workspace: { isUnlocked: () => unlocked, isLocking: () => false },
      probeGpu: fakeProbe(() => pending.promise)
    })
    const spy = performanceChangedSpy()

    const run = tryGpuAgain(ctx)
    unlocked = false // "Lock now" completes while the driver is still enumerating
    pending.resolve([IRIS, RTX])
    await run

    expect(getSettings(db).gpuProbe).toEqual(before)
    expect(spy).toHaveBeenCalledTimes(1) // the flag clear, before the lock (A-D1); the late result adds nothing
  })

  it('a probe that outlives its workspace session (a lock AND a re-unlock) writes nothing', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    withBinary(root)
    const before = probe([RTX], FOREIGN_KEY)
    updateSettings(db, { gpuProbe: before })
    let epoch = 3
    const pending = deferred<GpuDevice[]>()
    const ctx = ctxWith(root, db, {
      workspace: { isUnlocked: () => true, isLocking: () => false, unlockEpoch: () => epoch },
      probeGpu: fakeProbe(() => pending.promise)
    })
    const spy = performanceChangedSpy()

    const run = tryGpuAgain(ctx)
    epoch += 1 // locked and unlocked again: both flags read exactly as before, the epoch does not
    pending.resolve([IRIS, RTX])
    await run

    expect(getSettings(db).gpuProbe).toEqual(before)
    expect(spy).toHaveBeenCalledTimes(1) // the flag clear only (A-D1); the stale result adds nothing

    // The control: the same session, the same probe → written.
    const again = deferred<GpuDevice[]>()
    ctx.probeGpu = fakeProbe(() => again.promise)
    const run2 = tryGpuAgain(ctx)
    again.resolve([IRIS, RTX])
    await run2
    expect(getSettings(db).gpuProbe).toMatchObject({ devices: [IRIS, RTX], machineKey: here() })
    expect(spy).toHaveBeenCalledTimes(3) // + the flag clear and the write
  })
})

/** A card machine with the 9B active and running, the translation sidecar live with 20/49 layers, and the real catalog. */
function cardMachine(over: {
  settings?: Partial<AppSettings>
  translation?: TranslationDeviceStatus | null
  status?: RuntimeStatus
  placement?: Partial<ModelPlacement>
} = {}): { placement: PerformanceSnapshot['placement']; db: Db; ctx: AppContext } {
  // Each machine starts from a clean session latch: a placement recorded for an earlier
  // machine in the same test must not count as this one's observation.
  resetModelPlacementForTests()
  const root = freshRoot()
  const db = seededDb(root)
  updateSettings(db, { lastBenchmark: hereResult(), activeModelId: CHAT, gpuProbe: probe([RTX], here()), ...over.settings })
  const ctx = ctxWith(root, db, {
    manifestsDir: MANIFESTS,
    runtime: {
      occupancy: new ModelOccupancy(),
      active: () => ({ modelId: CHAT }),
      status: () => over.status ?? runningStatus(CHAT)
    },
    translator: {
      deviceStatus: () =>
        over.translation === undefined ? { device: 'auto', gpuLayers: 20, totalLayers: 49, live: true } : over.translation
    }
  })
  if (over.placement) {
    // The launch context the snapshot resolves for the active model: a placement must carry it
    // to count as observed (the measured-evidence rule).
    const contextTokens = buildPerformanceSnapshot(ctx).placement.model?.contextTokens ?? 0
    recordModelPlacement({
      modelId: CHAT, contextTokens, backend: 'gpu', gpuLayers: 41, totalLayers: 41,
      gpuModelMb: 5500, cpuModelMb: 400, gpuKvMb: 640, cpuKvMb: null, metalMaxWorkingSetMb: null,
      machineKey: here(), at: '2026-09-05T01:00:00Z', ...over.placement
    })
  }
  return { placement: buildPerformanceSnapshot(ctx).placement, db, ctx }
}

const rowOf = (p: PerformanceSnapshot['placement'], role: 'chat' | 'translation') => p.models.find((r) => r.role === role)!

describe('capability is not execution (DR1)', () => {
  it('GPU on: chat and translation say gpu; bothOnCard needs chat resident on the GPU with layers and the translation live with layers', () => {
    const on = cardMachine({ placement: {} })
    expect(rowOf(on.placement, 'chat').device).toBe('gpu')
    expect(rowOf(on.placement, 'translation').device).toBe('gpu')
    expect(on.placement.totals.bothOnCard).toBe(true)
    // The estimate/measurement for the card, not the processor.
    expect(on.placement.verdict.kind).toBe('gpu')

    // A live translation sidecar at 0 offloaded layers is not on the card.
    expect(cardMachine({ placement: {}, translation: { device: 'auto', gpuLayers: 0, totalLayers: 49, live: true } }).placement.totals.bothOnCard).toBe(false)
    // A chat start observed at 0 layers, or with no reported split, is not on the card either.
    expect(cardMachine({ placement: { gpuLayers: 0 } }).placement.totals.bothOnCard).toBe(false)
    expect(cardMachine({ placement: { gpuLayers: null, totalLayers: null } }).placement.totals.bothOnCard).toBe(false)
    // No observation under a GPU-eligible configuration counts as on the card.
    expect(cardMachine().placement.totals.bothOnCard).toBe(true)
    // The chat model not resident: not both.
    expect(cardMachine({ status: { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' } }).placement.totals.bothOnCard).toBe(false)
  })

  it("gpuMode 'off': both rows say cpu, the verdict is the processor estimate against RAM, bothOnCard is false — and the class is the NEXT start's, cpu", () => {
    const off = cardMachine({ settings: { gpuMode: 'off' } })
    expect(rowOf(off.placement, 'chat').device).toBe('cpu')
    expect(rowOf(off.placement, 'translation').device).toBe('cpu')
    expect(off.placement.totals.bothOnCard).toBe(false)
    expect(off.placement.verdict.kind).not.toBe('gpu')
    expect(off.placement.verdict.estimated).toBe(true)
    expect(off.placement.verdict.budgetMb).toBe(off.placement.ramMb)
    // The #303 P5 rule kept the HARDWARE class here; merged with #308 (decision 6) the snapshot's
    // class and card describe the next start, which the switched-off card takes no part in —
    // the same answer `pickerMemoryFor` gives the Models ★ (`memoryClassOf`, the profile bump's
    // gate, is the unchanged flags-at-default wrapper).
    expect(off.placement.memoryClass).toBe('cpu')
    expect(off.placement.vramMb).toBeNull()
  })

  it('gpuAutoDisabled: the same', () => {
    const auto = cardMachine({ settings: { gpuAutoDisabled: true } })
    expect(rowOf(auto.placement, 'chat').device).toBe('cpu')
    expect(rowOf(auto.placement, 'translation').device).toBe('cpu')
    expect(auto.placement.totals.bothOnCard).toBe(false)
    expect(auto.placement.verdict.kind).not.toBe('gpu')
    expect(auto.placement.verdict.budgetMb).toBe(auto.placement.ramMb)
  })

  it('a translation sidecar forced to --device none says cpu while chat keeps the card', () => {
    const forced = cardMachine({ placement: {}, translation: { device: 'cpu', gpuLayers: null, totalLayers: null, live: true } })
    expect(rowOf(forced.placement, 'chat').device).toBe('gpu')
    expect(rowOf(forced.placement, 'translation').device).toBe('cpu')
    expect(forced.placement.totals.bothOnCard).toBe(false)
  })

  it('a matching start OBSERVED on the CPU backend puts the chat row on the processor and judges it against RAM', () => {
    const observedCpu = cardMachine({ placement: { backend: 'cpu', gpuLayers: null, totalLayers: null, gpuModelMb: null, gpuKvMb: null, cpuModelMb: 5900, cpuKvMb: 640 } })
    expect(rowOf(observedCpu.placement, 'chat').device).toBe('cpu')
    expect(rowOf(observedCpu.placement, 'translation').device).toBe('gpu')
    expect(observedCpu.placement.totals.bothOnCard).toBe(false)
    expect(observedCpu.placement.verdict).toMatchObject({ kind: 'cpu', estimated: false, budgetMb: observedCpu.placement.ramMb })
  })

  it('no usable card: both rows say cpu whatever the configuration', () => {
    const none = cardMachine({ settings: { gpuProbe: probe([IRIS], here()) } })
    expect(rowOf(none.placement, 'chat').device).toBe(memoryClassOf(process.platform, process.arch, [IRIS]) === 'cpu' ? 'cpu' : 'gpu')
    if (none.placement.memoryClass === 'cpu') {
      expect(rowOf(none.placement, 'translation').device).toBe('cpu')
      expect(none.placement.totals.bothOnCard).toBe(false)
    }
  })
})

describe('free/compute attribution to the selected device (DR2)', () => {
  const irisRow = { label: 'Vulkan0', name: IRIS.name, totalMb: 16_384, freeMb: 15_000, computeMb: 300 }
  const rtxRow = { label: 'Vulkan1', name: RTX.name, totalMb: 24_576, freeMb: 2703, computeMb: 2860 }

  /** An active model outside the catalog (context = the settings default) with a latched partial start. */
  function withLog(devices: ModelPlacement['devices'], probed: GpuDevice[]): PerformanceSnapshot['placement'] {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'some-model', gpuProbe: probe(probed, here()) })
    const contextTokens = getSettings(db).contextTokens
    recordModelPlacement({
      modelId: 'some-model', contextTokens, backend: 'gpu', gpuLayers: 62, totalLayers: 66,
      gpuModelMb: 17_600, cpuModelMb: 1750, gpuKvMb: 512, cpuKvMb: null, metalMaxWorkingSetMb: null,
      // The legacy summary fields say what the FIRST row and the SUM would: the iGPU's free memory.
      gpuFreeAtStartMb: 15_000, gpuComputeMb: 3160, devices,
      machineKey: here(), at: '2026-09-05T01:00:00Z'
    })
    return buildPerformanceSnapshot(ctxWith(root, db)).placement
  }

  it('a hybrid log: the figures are the selected dGPU’s, by name — never the first row’s', () => {
    const p = withLog([irisRow, rtxRow], [IRIS, RTX])
    expect(p.observed).not.toBeNull()
    expect(p.verdict).toMatchObject({ kind: 'partial', freeAtStartMb: 2703, workingMb: 2860, spillMb: 1750, budgetMb: RTX.totalMb })
  })

  it('the selected device absent from the log: null, never the iGPU’s free memory', () => {
    const p = withLog([irisRow, { ...rtxRow, name: 'NVIDIA GeForce RTX 3080 Ti' }], [IRIS, RTX])
    expect(p.verdict).toMatchObject({ kind: 'partial', freeAtStartMb: null, workingMb: null })
  })

  it('a lone row: the selected device’s own figures when it is that device, null when it is not (A-D3)', () => {
    // The dGPU alone in the log, the dGPU selected: the row answers, not the legacy summary.
    expect(withLog([rtxRow], [RTX]).verdict).toMatchObject({ freeAtStartMb: 2703, workingMb: 2860 })
    // An iGPU-only log beside a selected dGPU: never the iGPU’s free memory under the dGPU’s budget.
    expect(withLog([irisRow], [IRIS, RTX]).verdict).toMatchObject({ kind: 'partial', freeAtStartMb: null, workingMb: null })
  })

  it('a record persisted before the rows existed attributes as it always did', () => {
    expect(withLog(undefined, [IRIS, RTX]).verdict).toMatchObject({ freeAtStartMb: 15_000, workingMb: 3160 })
  })
})

describe('everything loaded at once (DR5)', () => {
  it('cpu class: every row counts', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: CHAT })
    const p = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: MANIFESTS })).placement
    // No probe on this host: the cpu class (or, on Apple Silicon, unified — the full sum too).
    expect(['cpu', 'unified']).toContain(p.memoryClass)
    const sum = p.models.reduce((a, r) => a + (r.sizeOnDiskGb ?? 0) * 1024, 0)
    expect(p.totals.ramAllMb).toBe(Math.round(sum))
  })

  it.skipIf(process.platform === 'darwin' && process.arch === 'arm64')(
    'discrete: the processor rows plus the observed chat spill and the live translation spill',
    () => {
      const { placement: p } = cardMachine({ placement: { gpuLayers: 30, totalLayers: 41, cpuModelMb: 1900, cpuKvMb: 200 } })
      expect(p.memoryClass).toBe('discrete')
      expect(p.verdict).toMatchObject({ kind: 'partial', estimated: false, spillMb: 2100 })
      const tr = rowOf(p, 'translation')
      const pinned = p.models.filter((r) => r.device === 'cpu').reduce((a, r) => a + (r.sizeOnDiskGb ?? 0) * 1024, 0)
      const translationSpill = (tr.sizeOnDiskGb ?? 0) * 1024 * (1 - 20 / 49)
      expect(p.totals.ramAllMb).toBe(Math.round(pinned + 2100 + translationSpill))
      // Chat weights on the card are NOT counted against RAM.
      expect(p.totals.ramAllMb).toBeLessThan(Math.round(p.models.reduce((a, r) => a + (r.sizeOnDiskGb ?? 0) * 1024, 0)))

      // GPU off: every row is on the processor → the plain sum again.
      const off = cardMachine({ settings: { gpuMode: 'off' } }).placement
      expect(off.totals.ramAllMb).toBe(Math.round(off.models.reduce((a, r) => a + (r.sizeOnDiskGb ?? 0) * 1024, 0)))
    }
  )
})
