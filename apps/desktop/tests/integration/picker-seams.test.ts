import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

import { buildPerformanceSnapshot, runAndPersistBenchmark } from '../../src/main/ipc/registerBenchmarkIpc'
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
// is the 27B Q5; an 8 GiB card fits the 9B (needs 8,117 MiB by the PR's estimate).
const RAM_PICK = 'qwen3.8-27b-ud-q5km'
const CARD8_PICK = 'qwen3.5-9b-ud-q4kxl'

const CARD8: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3070', totalMb: 8192, freeMb: 8000 }
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

  it('8 GiB card → the 9B on the benchmark AND the Models ★; no card → the RAM pick on both', async () => {
    const withCard = fixture({ probeReturns: [CARD8] })
    const bench = await runAndPersistBenchmark(withCard.ctx)
    expect(bench.recommendedModelId).toBe(CARD8_PICK)
    expect(bench.gpu).toBe(CARD8.name)
    expect(bench.gpuVramMb).toBe(8192)
    expect(getSettings(withCard.ctx.db).gpuProbe?.devices).toEqual([CARD8])
    expect(await liveStar(withCard.ctx)).toBe(CARD8_PICK)
    expect(pickerMemoryFor(getSettings(withCard.ctx.db))).toEqual({ memoryClass: 'discrete', machineVramMb: 8192 })

    const noCard = fixture({ probeReturns: [] })
    const benchNoCard = await runAndPersistBenchmark(noCard.ctx)
    expect(benchNoCard.recommendedModelId).toBe(RAM_PICK)
    expect(benchNoCard.gpu).toBeNull()
    expect(benchNoCard.gpuVramMb).toBeNull()
    expect(await liveStar(noCard.ctx)).toBe(RAM_PICK)
    expect(pickerMemoryFor(getSettings(noCard.ctx.db))).toEqual({ memoryClass: 'cpu', machineVramMb: null })
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
    expect(pickerMemoryFor(getSettings(ctx.db))).toEqual({ memoryClass: 'cpu', machineVramMb: null })
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
