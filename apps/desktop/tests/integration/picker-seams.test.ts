import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The two seams the chat recommendation leaves the main process through — the benchmark
// (`runAndPersistBenchmark` → `BenchmarkResult.recommendedModelId` / `.gpu` / `.gpuVramMb`)
// and the Models screen (the REAL `listModels` IPC handler → the ★ pick) — plus the Performance
// snapshot, all fed by ONE budget-device decision (`nextStartMemory`, PR #308 audit decisions 6
// and 9; benchmark.md "Performance screen"). Everything here is deterministic: electron is
// mocked, RAM is pinned to 32 GiB, the platform to win32/x64 (the CI matrix runs ubuntu and
// windows; a darwin/arm64 host would read as unified), the GPU probe is a fake, and the drive
// root carries a fake `llama-server` so `probeAndPersistGpu` resolves a binary.
//
// The audit's mutation guards M3/M4 (P1 log): removing the memory inputs from the `listModels`
// handler, or the class from `probeAndPersistGpu`'s summary, must turn this file red — the
// divergent explicit pair is 8 GiB card → 9B versus no card → the RAM 32 pick, the 27B Q5.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' }
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  totalmem: () => 32 * 1024 ** 3
}))
// P2a: a switch that makes the settings store refuse `gpuProbe` writes only — the witness that
// the probe helper's catch-branch persistence cannot throw out of the benchmark. Off by default
// (pass-through to the real module).
const settingsState = vi.hoisted(() => ({ refuseGpuProbeWrites: false }))
vi.mock('../../src/main/services/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/services/settings')>()
  return {
    ...actual,
    updateSettings: (...args: Parameters<typeof actual.updateSettings>): ReturnType<typeof actual.updateSettings> => {
      if (settingsState.refuseGpuProbeWrites && 'gpuProbe' in (args[1] ?? {})) throw new Error('settings store refused the write')
      return actual.updateSettings(...args)
    }
  }
})

import { buildPerformanceSnapshot, maybeRunFirstBenchmark, runAndPersistBenchmark } from '../../src/main/ipc/registerBenchmarkIpc'
import { pickerMemoryFor, registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { detectSystem } from '../../src/main/services/benchmark'
import { openDatabase } from '../../src/main/services/db'
import { machineRamGb } from '../../src/main/services/models'
import { machineKey } from '../../src/main/services/performance'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import { IPC } from '../../src/shared/ipc'
import type { AppContext } from '../../src/main/services/context'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import type { AppSettings, GpuDevice, ModelInfo } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const MANIFESTS = join(__dirname, '..', '..', '..', '..', 'model-manifests')

// The committed catalog's answers at RAM 32 (benchmark.md table; audit §7 item 2): the RAM pick
// is the 27B Q5. Since rule C on the free-memory basis (P3, decisions 10/11) an 8 GiB card with
// ≈ 7.5–8.0 GiB FREE does not hold the 9B (8,014 MiB with its 0.4 GiB cache term), so the card
// pick is the 4B — still divergent from the RAM pick, which is what the mutation guards need.
const RAM_PICK = 'qwen3.8-27b-ud-q5km'
const CARD8_PICK = 'qwen3.5-4b-ud-q4kxl'
const CARD8_ROOMY_PICK = 'qwen3.5-9b-ud-q4kxl'

const CARD8: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3070', totalMb: 8192, freeMb: 8000 }
// The same card with 8,100 MiB free: holds the 9B — the witness that the seams feed the FREE
// figure (by total − 1,024 it would read 7,168 and give the 4B).
const CARD8_ROOMY: GpuDevice = { ...CARD8, freeMb: 8100 }
// N8 / decision 3: the 6 GB laptop class reports under the 6,144 MiB gate on Vulkan (RTX 4050
// Laptop, audit D1) and never reaches the card path; an RTX 2060 reports exactly 6,144 and does.
const RTX4050_LAPTOP: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4050 Laptop GPU', totalMb: 5921, freeMb: 5153 }
const RTX2060: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 2060', totalMb: 6144, freeMb: 5136 }
// A hybrid laptop as the pinned b9849 Vulkan build lists it (audit R6): the iGPU first.
const ARL: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Graphics (ARL)', totalMb: 11577, freeMb: 8251 }
const RTX5060: GpuDevice = { id: 'Vulkan1', name: 'NVIDIA GeForce RTX 5060', totalMb: 8151, freeMb: 7573 }

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')
beforeAll(() => {
  // Pinned explicitly, not inherited from the host: the class decision reads process.platform /
  // process.arch, and the fake binary below is named for the same pinned platform.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
})
afterAll(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
  if (archDescriptor) Object.defineProperty(process, 'arch', archDescriptor)
})
beforeEach(() => {
  ipcState.handlers.clear()
})

interface Fixture {
  ctx: AppContext
  probe: ReturnType<typeof vi.fn>
}

/** A drive root with a fake llama-server, a seeded DB, a fake session probe, and a minimal context. */
function fixture(opts: { probeReturns: GpuDevice[]; persisted?: GpuDevice[] | null; settings?: Partial<AppSettings> }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-picker-seams-'))
  mkdirSync(join(root, 'workspace'))
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  if (opts.persisted) updateSettings(db, { gpuProbe: { devices: opts.persisted, probedAt: '2026-08-20T00:00:00Z' } })
  if (opts.settings) updateSettings(db, opts.settings)
  const probe = vi.fn(async () => opts.probeReturns)
  const ctx = {
    paths: { rootPath: root, workspacePath: join(root, 'workspace'), configPath: join(root, 'no-such-config') },
    db,
    manifestsDir: MANIFESTS,
    workspace: { isUnlocked: () => true },
    trustedSenders: { ...ANY_SENDER },
    probeGpu: Object.assign(probe, { invalidate: vi.fn() }) as unknown as CachedGpuProbe,
    runtime: { occupancy: new ModelOccupancy(), active: () => null, activeModelId: () => null },
    isDev: false
  } as unknown as AppContext
  return { ctx, probe }
}

/** The Models screen's ★ through the REAL `listModels` handler (registered via the electron mock). */
async function liveStar(ctx: AppContext): Promise<string | undefined> {
  ipcState.handlers.clear()
  registerModelIpc(ctx)
  const { result } = await invoke(handlers, IPC.listModels)
  return (result as ModelInfo[]).find((m) => m.role === 'chat' && m.recommended)?.id
}

describe('picker seams: the budget device decides on both consumers (decision 9)', () => {
  it('sanity: RAM is pinned to 32 GB and the platform to win32/x64', () => {
    expect(machineRamGb()).toBe(32)
    expect(process.platform).toBe('win32')
    expect(process.arch).toBe('x64')
  })

  it('8 GiB card → the 4B on the benchmark AND the Models ★; no card → the RAM pick on both', async () => {
    const withCard = fixture({ probeReturns: [CARD8] })
    const bench = await runAndPersistBenchmark(withCard.ctx)
    expect(bench.recommendedModelId).toBe(CARD8_PICK)
    expect(bench.gpu).toBe(CARD8.name)
    expect(bench.gpuVramMb).toBe(8192)
    expect(getSettings(withCard.ctx.db).gpuProbe?.devices).toEqual([CARD8])
    expect(await liveStar(withCard.ctx)).toBe(CARD8_PICK)
    // The budget is the probe's FREE figure (decision 10), raw MiB — not the total the tile shows.
    expect(pickerMemoryFor(getSettings(withCard.ctx.db))).toEqual({ memoryClass: 'discrete', graphicsBudgetMb: 8000 })

    const noCard = fixture({ probeReturns: [] })
    const benchNoCard = await runAndPersistBenchmark(noCard.ctx)
    expect(benchNoCard.recommendedModelId).toBe(RAM_PICK)
    expect(benchNoCard.gpu).toBeNull()
    expect(benchNoCard.gpuVramMb).toBeNull()
    expect(await liveStar(noCard.ctx)).toBe(RAM_PICK)
    expect(pickerMemoryFor(getSettings(noCard.ctx.db))).toEqual({ memoryClass: 'cpu', graphicsBudgetMb: null })
  })

  it('the FREE figure decides on both seams: the same 8 GiB card with 8,100 MiB free holds the 9B', async () => {
    const { ctx } = fixture({ probeReturns: [CARD8_ROOMY] })
    const bench = await runAndPersistBenchmark(ctx)
    expect(bench.recommendedModelId).toBe(CARD8_ROOMY_PICK)
    expect(bench.gpuVramMb).toBe(8192) // the tile still shows the total
    expect(await liveStar(ctx)).toBe(CARD8_ROOMY_PICK)
    expect(pickerMemoryFor(getSettings(ctx.db))).toEqual({ memoryClass: 'discrete', graphicsBudgetMb: 8100 })
  })

  it('N8 gate boundary: 5,921 MiB (RTX 4050 Laptop) stays a RAM machine; 6,144 (RTX 2060) reaches the card path', async () => {
    const laptop = fixture({ probeReturns: [RTX4050_LAPTOP] })
    const benchLaptop = await runAndPersistBenchmark(laptop.ctx)
    expect(pickerMemoryFor(getSettings(laptop.ctx.db))).toEqual({ memoryClass: 'cpu', graphicsBudgetMb: null })
    expect(benchLaptop.recommendedModelId).toBe(RAM_PICK)
    expect(benchLaptop.gpu).toBeNull()
    expect(await liveStar(laptop.ctx)).toBe(RAM_PICK)

    const desktop = fixture({ probeReturns: [RTX2060] })
    const benchDesktop = await runAndPersistBenchmark(desktop.ctx)
    expect(pickerMemoryFor(getSettings(desktop.ctx.db))).toEqual({ memoryClass: 'discrete', graphicsBudgetMb: 5136 })
    expect(benchDesktop.recommendedModelId).toBe(CARD8_PICK) // the 4B: 4,512 MiB fits 5,136
    expect(benchDesktop.gpu).toBe(RTX2060.name)
    expect(benchDesktop.gpuVramMb).toBe(6144)
    expect(await liveStar(desktop.ctx)).toBe(CARD8_PICK)
  })

  it('a hybrid laptop gives the same pick in either device order, and every surface names the RTX', async () => {
    for (const devices of [[ARL, RTX5060], [RTX5060, ARL]]) {
      const { ctx } = fixture({ probeReturns: devices })
      const bench = await runAndPersistBenchmark(ctx)
      expect(bench.recommendedModelId).toBe(CARD8_PICK)
      expect(bench.gpu).toBe(RTX5060.name)
      expect(bench.gpuVramMb).toBe(8151)
      expect(await liveStar(ctx)).toBe(CARD8_PICK)
      const snap = buildPerformanceSnapshot(ctx)
      expect(snap.currentGpu).toEqual({ name: RTX5060.name, totalMb: 8151 })
      expect(snap.placement.memoryClass).toBe('discrete')
      expect(snap.placement.vramMb).toBe(8151)
    }
  })

  it('an integrated-only laptop is a RAM machine: cpu class, RAM pick, no graphics tile input', async () => {
    const { ctx } = fixture({ probeReturns: [ARL] })
    const bench = await runAndPersistBenchmark(ctx)
    expect(bench.recommendedModelId).toBe(RAM_PICK)
    expect(bench.gpu).toBeNull()
    expect(bench.gpuVramMb).toBeNull()
    expect(await liveStar(ctx)).toBe(RAM_PICK)
    const snap = buildPerformanceSnapshot(ctx)
    expect(snap.placement.memoryClass).toBe('cpu')
    expect(snap.placement.vramMb).toBeNull()
    expect(snap.currentGpu).toBeNull()
    // The shared-memory figure never becomes a "card" for the Performance result either.
    expect(snap.current?.gpuVramMb).toBeNull()
  })

  it('the persisted probe alone (no benchmark run) drives the Models ★ and the snapshot the same way', async () => {
    const { ctx } = fixture({ probeReturns: [], persisted: [ARL, RTX5060] })
    expect(await liveStar(ctx)).toBe(CARD8_PICK)
    const snap = buildPerformanceSnapshot(ctx)
    expect(snap.currentGpu?.name).toBe(RTX5060.name)
    expect(snap.placement.vramMb).toBe(8151)
  })
})

describe('picker seams: the next start honours the GPU flags (decision 6)', () => {
  it.each([
    ['gpuMode: off', { gpuMode: 'off' as const }],
    ['gpuAutoDisabled: true', { gpuAutoDisabled: true }]
  ])('%s with an 8 GiB card → the RAM pick on both seams and a cpu-class next start', async (_label, flags) => {
    const { ctx } = fixture({ probeReturns: [CARD8], persisted: [CARD8], settings: flags })
    const bench = await runAndPersistBenchmark(ctx)
    expect(bench.recommendedModelId).toBe(RAM_PICK)
    // The card stays KNOWN (the probe still persists it for Diagnostics / "Try GPU again")…
    expect(getSettings(ctx.db).gpuProbe?.devices).toEqual([CARD8])
    // …but the next start has no budget device, so the result names none.
    expect(bench.gpu).toBeNull()
    expect(bench.gpuVramMb).toBeNull()
    expect(await liveStar(ctx)).toBe(RAM_PICK)
    const snap = buildPerformanceSnapshot(ctx)
    expect(snap.placement.memoryClass).toBe('cpu')
    expect(snap.placement.vramMb).toBeNull()
    expect(snap.currentGpu).toBeNull()
    expect(pickerMemoryFor(getSettings(ctx.db))).toEqual({ memoryClass: 'cpu', graphicsBudgetMb: null })
  })

  it('a placement OBSERVED on the card stays observed after the GPU is switched off (a toggle restarts nothing)', () => {
    const here = machineKey(detectSystem())
    const { ctx } = fixture({
      probeReturns: [CARD8],
      persisted: [CARD8],
      settings: {
        activeModelId: CARD8_PICK,
        modelPlacements: {
          [CARD8_PICK]: {
            modelId: CARD8_PICK, contextTokens: 8192, backend: 'gpu', gpuLayers: 41, totalLayers: 41,
            gpuModelMb: 5500, cpuModelMb: 400, gpuKvMb: 640, cpuKvMb: null, metalMaxWorkingSetMb: null,
            machineKey: here, at: '2026-09-05T00:00:00Z'
          }
        }
      }
    })
    const before = buildPerformanceSnapshot(ctx)
    expect(before.placement.memoryClass).toBe('discrete')
    expect(before.placement.verdict).toMatchObject({ kind: 'gpu', estimated: false, budgetMb: 8192 })

    updateSettings(ctx.db, { gpuMode: 'off' })
    const after = buildPerformanceSnapshot(ctx)
    // The NEXT start's class flips; what the LAST start did is still reported as observed.
    expect(after.placement.memoryClass).toBe('cpu')
    expect(after.placement.observed?.gpuLayers).toBe(41)
    expect(after.placement.verdict).toMatchObject({ kind: 'gpu', estimated: false })
  })

  it('"Try GPU again" clears the latch before it re-probes, so the summary describes the start that follows', async () => {
    const { ctx } = fixture({ probeReturns: [CARD8], persisted: [], settings: { gpuAutoDisabled: true } })
    expect(await liveStar(ctx)).toBe(RAM_PICK)
    const { tryGpuAgain } = await import('../../src/main/ipc/registerBenchmarkIpc')
    const settings = await tryGpuAgain(ctx)
    expect(settings.gpuAutoDisabled).toBe(false)
    expect(settings.gpuProbe?.devices).toEqual([CARD8])
    expect(await liveStar(ctx)).toBe(CARD8_PICK)
    expect(buildPerformanceSnapshot(ctx).placement.memoryClass).toBe('discrete')
  })
})

describe('picker seams: a probe that cannot run or that threw persists an EMPTY probe (P2a, decision 6; audit A5/A5b/A5c)', () => {
  // The audit's stale-card fixture: a drive that left a machine with an 8 GiB RTX 3070 and a
  // pre-PR saved Q5 result, now on a computer where the probe cannot say anything.
  const STALE_AT = '2026-08-20T00:00:00Z'
  function staleCard(opts: { binary: boolean; probe?: () => Promise<GpuDevice[]> }): Fixture {
    const f = fixture({ probeReturns: [], persisted: [CARD8] })
    updateSettings(f.ctx.db, {
      lastBenchmark: {
        ...detectSystem(),
        gpu: CARD8.name,
        gpuVramMb: CARD8.totalMb,
        driveReadMbps: null,
        driveWriteMbps: null,
        tokensPerSecond: null,
        measuredModelId: null,
        profile: 'PRO',
        recommendedModelId: RAM_PICK,
        warnings: [],
        ranAt: STALE_AT
      }
    })
    if (!opts.binary) rmSync(llamaServerDir(f.ctx.paths.rootPath), { recursive: true, force: true })
    if (opts.probe) f.probe.mockImplementation(opts.probe)
    return f
  }

  async function expectEmptyProbeAndRamPickOnBothSeams(f: Fixture): Promise<void> {
    // The badge would have said 9B from the stale card before the run…
    expect(await liveStar(f.ctx)).toBe(CARD8_PICK)
    const bench = await runAndPersistBenchmark(f.ctx)
    const probe = getSettings(f.ctx.db).gpuProbe
    // …the run replaces the stale card with THIS session's (empty) probe, freshly stamped…
    expect(probe?.devices).toEqual([])
    expect(probe?.probedAt).not.toBe(STALE_AT)
    expect(Date.parse(probe?.probedAt ?? '')).toBeGreaterThan(Date.parse(STALE_AT))
    // …so the benchmark and the Models ★ agree on the RAM pick, and no surface names a card.
    expect(bench.recommendedModelId).toBe(RAM_PICK)
    expect(bench.gpu).toBeNull()
    expect(bench.gpuVramMb).toBeNull()
    expect(await liveStar(f.ctx)).toBe(RAM_PICK)
    const snap = buildPerformanceSnapshot(f.ctx)
    expect(snap.currentGpu).toBeNull()
    expect(snap.placement.memoryClass).toBe('cpu')
    expect(snap.current?.gpuVramMb).toBeNull()
  }

  it('no binary → the probe never runs, yet `gpuProbe` becomes { devices: [], probedAt } (A5)', async () => {
    const f = staleCard({ binary: false })
    await expectEmptyProbeAndRamPickOnBothSeams(f)
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('the probe throws → the same empty probe is persisted and the run still completes (A5b)', async () => {
    const f = staleCard({
      binary: true,
      probe: async () => {
        throw new Error('probe exploded')
      }
    })
    await expectEmptyProbeAndRamPickOnBothSeams(f)
    expect(f.probe).toHaveBeenCalledTimes(1)
  })

  it('the probe returns [] → the same empty probe (the control, A5c: this path was already right)', async () => {
    const f = staleCard({ binary: true })
    await expectEmptyProbeAndRamPickOnBothSeams(f)
    expect(f.probe).toHaveBeenCalledTimes(1)
  })

  it('a successful probe still persists its devices (unchanged path)', async () => {
    const f = staleCard({ binary: true, probe: async () => [ARL, RTX5060] })
    const bench = await runAndPersistBenchmark(f.ctx)
    expect(getSettings(f.ctx.db).gpuProbe?.devices).toEqual([ARL, RTX5060])
    expect(getSettings(f.ctx.db).gpuProbe?.probedAt).not.toBe(STALE_AT)
    expect(bench.recommendedModelId).toBe(CARD8_PICK)
    expect(bench.gpu).toBe(RTX5060.name)
  })

  it('the session refresh (maybeRunFirstBenchmark) clears a stale card the same way when the binary is gone', async () => {
    const f = staleCard({ binary: false })
    maybeRunFirstBenchmark(f.ctx)
    await vi.waitFor(() => expect(getSettings(f.ctx.db).gpuProbe?.devices).toEqual([]))
    expect(getSettings(f.ctx.db).gpuProbe?.probedAt).not.toBe(STALE_AT)
    // Same machine, already benchmarked: the saved result is kept, not re-run (A4 unchanged)…
    await new Promise((r) => setTimeout(r, 200))
    expect(getSettings(f.ctx.db).lastBenchmark?.ranAt).toBe(STALE_AT)
    // …and the badge now reads the RAM pick, in step with the saved result.
    expect(await liveStar(f.ctx)).toBe(RAM_PICK)
  })

  it('the empty-probe write itself failing (thrown path, store refuses) never escapes: the run still completes', async () => {
    const f = staleCard({
      binary: true,
      probe: async () => {
        throw new Error('probe exploded')
      }
    })
    settingsState.refuseGpuProbeWrites = true
    try {
      // Both the probe AND the catch branch's own persistence write throw; the benchmark must
      // still return (the helper's contract: never throws), with the in-memory empty device list.
      const bench = await runAndPersistBenchmark(f.ctx)
      expect(bench.recommendedModelId).toBe(RAM_PICK)
      expect(bench.gpu).toBeNull()
      // The refused write means the stale card is still on disk — the residual this test pins:
      // the store's refusal, not the probe, is what keeps it (a locked workspace re-probes on unlock).
      expect(getSettings(f.ctx.db).gpuProbe?.devices).toEqual([CARD8])
    } finally {
      settingsState.refuseGpuProbeWrites = false
    }
  })
})
