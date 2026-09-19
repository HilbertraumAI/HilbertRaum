import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stringify } from 'yaml'

// Wave 8 (step 4-8): "one per posture-input writer" (ruling (e)) -- after the write, the NEXT
// posture resolution (via `resolveRerankerDevicePosture`, the ONE shared helper every writer
// ultimately feeds) reflects it. Also ruling (a)'s own required tests: absent inputs mean `cpu`,
// the pending counter under overlapping `startModelRuntime` calls, a gate-refused start leaves it
// at zero, the awaited suspend's placement, and the masked same-model restart (F15).

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  app: { getVersion: () => '0.0.0-test' }
}))

import { openDatabase, type Db } from '../../src/main/services/db'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import {
  resolveRerankerDevicePosture,
  snapshotRerankerOccupancy,
  createPendingModelSwitchCounter,
  type RerankerOccupancySnapshot
} from '../../src/main/services/rag/device-posture'
import { tryGpuAgain } from '../../src/main/ipc/registerBenchmarkIpc'
import { startModelRuntime } from '../../src/main/ipc/registerModelIpc'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import type { AppContext } from '../../src/main/services/context'
import type { CachedGpuProbe } from '../../src/main/services/runtime/gpu'
import type { GpuDevice } from '../../src/shared/types'

const REPO_MANIFESTS = join(process.cwd(), '..', '..', 'model-manifests')
const RTX: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
const FOUR_B = 'qwen3.5-4b-ud-q4kxl'
const NINE_B = 'qwen3.5-9b-ud-q4kxl'
const NO_OCCUPANCY: Omit<RerankerOccupancySnapshot, 'committedModelId'> = {
  chatStartBusy: false,
  translationOccupied: false
}

function seededDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-posture-writers-')), 'test.sqlite'))
  seedSettings(db)
  return db
}

function fakeProbe(devices: GpuDevice[] | null): CachedGpuProbe {
  return (async () => devices) as unknown as CachedGpuProbe
}

function rootWithBinary(): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-posture-writers-root-'))
  const dir = llamaServerDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'fake-binary')
  return root
}

describe('Wave 8: posture-input writers -- the NEXT resolution reflects the write', () => {
  it('gpuMode (settings:update): auto -> off flips the resolved posture to cpu', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    const before = resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })
    expect(before).toBe('gpu')
    updateSettings(db, { gpuMode: 'off' })
    const after = resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })
    expect(after).toBe('cpu')
  })

  it('gpuAutoDisabled (settings:update): false -> true flips the resolved posture to cpu', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
    updateSettings(db, { gpuAutoDisabled: true })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
  })

  // persistGpuFailure (main/index.ts) is an inline closure, not exported for direct testing --
  // its write is `updateSettings(db, { gpuAutoDisabled: true, gpuLastError })`, exactly the shape
  // proven here; the READ side (resolveRerankerDevicePosture) cannot tell which caller wrote it.
  it('gpuAutoDisabled via persistGpuFailure\'s write shape ({ gpuAutoDisabled: true, gpuLastError }) flips the resolved posture to cpu', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
    updateSettings(db, { gpuAutoDisabled: true, gpuLastError: `${new Date().toISOString()} — GPU crash` })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
  })

  it('gpuProbe via settings:update (a fresh probe with less free memory) flips the resolved posture to cpu', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
    const smallCard = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994 } as GpuDevice
    updateSettings(db, { gpuProbe: { devices: [smallCard], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
  })

  it('gpuProbe via probeAndPersistGpu (tryGpuAgain, one of its four triggers) -- carries NO suspend, and the NEXT resolution still reflects it', async () => {
    const root = rootWithBinary()
    const db = seededDb()
    updateSettings(db, { gpuAutoDisabled: true, gpuProbe: { devices: [], probedAt: '2020-01-01T00:00:00Z' } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
    const ctx = {
      paths: { rootPath: root, workspacePath: join(root, 'workspace') },
      db,
      workspace: { isUnlocked: () => true },
      probeGpu: fakeProbe([RTX])
    } as unknown as AppContext
    await tryGpuAgain(ctx) // clears gpuAutoDisabled AND persists a fresh RTX probe -- no suspend call anywhere in this path
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
  })

  it('the committed chat model (a real startModelRuntime commit): the next resolution follows the RUNTIME, not the setting', async () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    let committed: string | null = null
    const runtime = {
      activeModelId: () => committed,
      status: () => ({ startingModelId: null }) as any,
      start: async (opts: { modelId: string }) => {
        committed = opts.modelId
        return { running: true, modelId: committed, port: null, healthy: true, message: 'ok' }
      }
    }
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: runtime.activeModelId(), ...NO_OCCUPANCY })).toBe('cpu') // null committed -> cpu
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: '/no-such-root', configPath: join(tmpdir(), 'hilbertraum-no-such-config') },
      isDev: true,
      runtime,
      reranker: null,
      workspace: { isUnlocked: () => true },
      // #477: pendingModelSwitches is required — startModelRuntime's committed-switch branch
      // calls it unconditionally now.
      pendingModelSwitches: createPendingModelSwitchCounter()
    } as unknown as AppContext
    await startModelRuntime(ctx, FOUR_B) // commits via the REAL gate/hash pipeline (mock fallback: missing weights + dev leniency)
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: runtime.activeModelId(), ...NO_OCCUPANCY })).toBe('gpu')
  })

  it('a chat start in flight (status().startingModelId) forces cpu regardless of the committed model\'s own headroom', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    const runtime = { activeModelId: () => FOUR_B, status: () => ({ startingModelId: NINE_B }) }
    const occupancy = snapshotRerankerOccupancy(runtime as any, createPendingModelSwitchCounter(), () => null)
    expect(occupancy.chatStartBusy).toBe(true)
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, occupancy)).toBe('cpu')
  })
})

describe('Wave 8 ruling (a): absent inputs mean cpu -- never a fallback to the setting', () => {
  it('a null committed model means cpu, even with provable headroom on record', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: null, ...NO_OCCUPANCY })).toBe('cpu')
  })

  it('settings.activeModelId is NEVER consulted -- a stale/mismatched setting changes nothing', () => {
    const db = seededDb()
    updateSettings(db, {
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() },
      activeModelId: NINE_B // the SETTING says the 9B (posture would be cpu if this were read)
    })
    // The COMMITTED model is the 4B -- the posture must follow IT, not the stale setting.
    expect(resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
  })

  it('each absent occupancy input alone means cpu', () => {
    const db = seededDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [RTX], probedAt: new Date().toISOString() } })
    expect(
      resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, chatStartBusy: true, translationOccupied: false })
    ).toBe('cpu')
    expect(
      resolveRerankerDevicePosture(getSettings(db), REPO_MANIFESTS, { committedModelId: FOUR_B, chatStartBusy: false, translationOccupied: true })
    ).toBe('cpu')
  })
})

describe('Wave 8 ruling (a): the pending-switch counter', () => {
  function ctxFor(db: Db, runtime: { activeModelId(): string | null; start(o: { modelId: string }): Promise<unknown> }, reranker: { suspend: () => Promise<void> }) {
    return {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: '/no-such-root', configPath: join(tmpdir(), 'hilbertraum-no-such-config') },
      isDev: true,
      runtime,
      reranker,
      workspace: { isUnlocked: () => true },
      pendingModelSwitches: createPendingModelSwitchCounter()
    } as unknown as AppContext & { pendingModelSwitches: ReturnType<typeof createPendingModelSwitchCounter> }
  }

  it('overlapping startModelRuntime calls each increment/decrement the counter -- it is a counter, never a boolean', async () => {
    const db = seededDb()
    let committed: string | null = null
    const suspendCalls: number[] = []
    let peak = 0
    const runtime = {
      activeModelId: () => committed,
      status: () => ({ startingModelId: null }) as any,
      start: async (opts: { modelId: string }) => {
        committed = opts.modelId
        return { running: true, modelId: committed, port: null, healthy: true, message: 'ok' }
      }
    }
    const ctx = ctxFor(
      db,
      runtime,
      {
        suspend: async () => {
          suspendCalls.push(ctx.pendingModelSwitches.count)
          peak = Math.max(peak, ctx.pendingModelSwitches.count)
          await new Promise((r) => setTimeout(r, 5)) // hold the window open so the two calls overlap
        }
      }
    )
    // Two overlapping calls (the unlock auto-start beside a Use click): both request a switch.
    await Promise.all([startModelRuntime(ctx, FOUR_B), startModelRuntime(ctx, NINE_B)])
    expect(peak).toBe(2) // a boolean could never have shown 2
    expect(ctx.pendingModelSwitches.count).toBe(0) // both decremented -- never stranded
  })

  it('a start refused at the RAM gate leaves the counter at zero (the try begins right after the increment, never a function-wide finally)', async () => {
    const db = seededDb()
    const runtime = {
      activeModelId: () => null,
      status: () => ({ startingModelId: null }) as any,
      start: async () => {
        throw new Error('must not be reached -- the RAM gate refuses first')
      }
    }
    let suspendCalled = false
    // The RAM gate only fires when computeInstallState resolves 'installed' -- the "missing
    // weight + dev leniency" mock fallback this file's OTHER tests use bypasses it entirely
    // (`if (state === 'installed' && ...)`). So: a REAL manifest + a present weight FILE (dev
    // leniency accepts it as installed without a real hash match), with an impossible RAM
    // requirement -- the core-model-ipc.test.ts RAM-gate fixture, reused verbatim.
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-posture-ramgate-'))
    const manifestsDir = join(root, 'model-manifests')
    mkdirSync(manifestsDir, { recursive: true })
    writeFileSync(
      join(manifestsDir, 'huge.yaml'),
      stringify({
        id: 'huge-model',
        display_name: 'Huge Model',
        family: 'qwen3',
        role: 'chat',
        format: 'gguf',
        runtime: 'llama_cpp',
        license: 'apache-2.0',
        size_on_disk_gb: 999,
        recommended_min_ram_gb: 9999, // no real machine passes
        recommended_ram_gb: 9999,
        recommended_context_tokens: 4096,
        local_path: 'models/chat/huge.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH',
        recommended_profiles: ['PRO'],
        license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
      })
    )
    mkdirSync(join(root, 'models', 'chat'), { recursive: true })
    writeFileSync(join(root, 'models', 'chat', 'huge.gguf'), 'weights')
    const ctx = {
      db,
      manifestsDir,
      paths: { rootPath: root, configPath: join(tmpdir(), 'hilbertraum-no-such-config') },
      isDev: true,
      runtime,
      reranker: { suspend: async () => { suspendCalled = true } },
      workspace: { isUnlocked: () => true },
      pendingModelSwitches: createPendingModelSwitchCounter()
    } as unknown as AppContext & { pendingModelSwitches: ReturnType<typeof createPendingModelSwitchCounter> }
    await expect(startModelRuntime(ctx, 'huge-model')).rejects.toThrow(/needs at least 9999 GB RAM/)
    expect(suspendCalled).toBe(false) // never reached the pending/suspend section at all
    expect(ctx.pendingModelSwitches.count).toBe(0)
  })

  it('placement: the awaited suspend runs strictly between the RAM gate and ctx.runtime.start, so it never sees the shutdown/lock/epoch re-checks skipped', async () => {
    const db = seededDb()
    const order: string[] = []
    let committed: string | null = null
    const runtime = {
      activeModelId: () => committed,
      status: () => ({ startingModelId: null }) as any,
      start: async (opts: { modelId: string }) => {
        order.push('runtime.start')
        committed = opts.modelId
        return { running: true, modelId: committed, port: null, healthy: true, message: 'ok' }
      },
      isShutdown: () => {
        order.push('shutdown-recheck')
        return false
      }
    }
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: '/no-such-root', configPath: join(tmpdir(), 'hilbertraum-no-such-config') },
      isDev: true,
      runtime,
      reranker: {
        suspend: async () => {
          order.push('suspend')
        }
      },
      pendingModelSwitches: createPendingModelSwitchCounter(),
      workspace: { isUnlocked: () => true, isLocking: () => false }
    } as unknown as AppContext
    await startModelRuntime(ctx, FOUR_B)
    // suspend() ran, and it ran BEFORE the shutdown re-check and BEFORE ctx.runtime.start.
    expect(order).toEqual(['suspend', 'shutdown-recheck', 'runtime.start'])
  })

  it('F15: a masked same-model restart (activeModelId already equals the requested id) never increments the counter or suspends', async () => {
    const db = seededDb()
    let suspendCalled = false
    const runtime = {
      activeModelId: () => FOUR_B, // ALREADY committed to this exact model
      status: () => ({ startingModelId: null }) as any,
      start: async (opts: { modelId: string }) => ({ running: true, modelId: opts.modelId, port: null, healthy: true, message: 'ok' })
    }
    const ctx = ctxFor(db, runtime, { suspend: async () => { suspendCalled = true } })
    await startModelRuntime(ctx, FOUR_B) // the SAME model -- not a switch
    expect(suspendCalled).toBe(false)
    expect(ctx.pendingModelSwitches.count).toBe(0)
  })
})
