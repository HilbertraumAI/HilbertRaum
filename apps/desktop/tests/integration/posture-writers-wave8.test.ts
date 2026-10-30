import { afterEach, describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

// Wave 8 (step 4-8): "one per posture-input writer" (ruling (e)) -- after the write, the NEXT
// posture resolution (via `resolveRerankerDevicePosture`, the ONE shared helper every writer
// ultimately feeds) reflects it. Also ruling (a)'s own required tests: absent inputs mean `cpu`,
// the pending counter under overlapping `startModelRuntime` calls, a gate-refused start leaves it
// at zero, the awaited suspend's placement, and the masked same-model restart (F15).

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  app: { getVersion: () => '0.0.0-test' }
}))

import type { Db } from '../../src/main/services/db'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import {
  resolveRerankerDevicePosture,
  snapshotRerankerOccupancy,
  createPendingModelSwitchCounter,
  type RerankerOccupancySnapshot
} from '../../src/main/services/rag/device-posture'
import { tryGpuAgain } from '../../src/main/ipc/registerBenchmarkIpc'
import { startModelRuntime } from '../../src/main/ipc/registerModelIpc'
import type { AppContext } from '../../src/main/services/context'
import type { AppSettings } from '../../src/shared/types'
import { deferred } from '../helpers/deferred'
import {
  CARDS,
  CATALOG_MANIFESTS,
  closePerformanceFixture,
  committingRuntime,
  ctxWith,
  fakeGpuProbe,
  freshRoot,
  seededDb,
  withLlamaBinary,
  writeChatManifest
} from '../helpers/performance-fixture'
import { runtimeStatus } from '../helpers/status'

const FOUR_B = 'qwen3.5-4b-ud-q4kxl'
const NINE_B = 'qwen3.5-9b-ud-q4kxl'
const NO_OCCUPANCY: Omit<RerankerOccupancySnapshot, 'committedModelId'> = {
  chatStartBusy: false,
  translationOccupied: false
}

afterEach(closePerformanceFixture)

const freshDb = (): Db => seededDb(freshRoot())

/** A context over a temp root with no weights: a catalog model takes the "missing + dev leniency" mock path. */
function ctxFor(runtime: unknown, reranker: { suspend: () => Promise<void> } | null = null): AppContext {
  const root = freshRoot()
  return ctxWith(root, seededDb(root), {
    manifestsDir: CATALOG_MANIFESTS,
    paths: { rootPath: root, configPath: join(root, 'no-such-config') },
    runtime,
    reranker
  })
}

describe('Wave 8: posture-input writers -- the NEXT resolution reflects the write', () => {
  it.each<[string, Partial<AppSettings>]>([
    ['gpuMode auto -> off', { gpuMode: 'off' }],
    ['gpuAutoDisabled false -> true', { gpuAutoDisabled: true }],
    // The measured small card: 5,226 − the 4B's 3,838 is under the reranker's 2,808 floor.
    ['a fresh probe of a smaller card', { gpuProbe: { devices: [CARDS.RTX_3060_LAPTOP], probedAt: new Date().toISOString() } }]
  ])('%s flips the next resolved posture from gpu to cpu', (_label, patch) => {
    const db = freshDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [CARDS.RTX_3080_TI], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
    updateSettings(db, patch)
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
  })

  it('gpuProbe via probeAndPersistGpu (tryGpuAgain, one of its four triggers) -- carries NO suspend, and the NEXT resolution still reflects it', async () => {
    const root = freshRoot()
    withLlamaBinary(root)
    const db = seededDb(root)
    updateSettings(db, { gpuAutoDisabled: true, gpuProbe: { devices: [], probedAt: '2020-01-01T00:00:00Z' } })
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('cpu')
    const suspend = vi.fn(async () => undefined)
    const ctx = ctxWith(root, db, { probeGpu: fakeGpuProbe([CARDS.RTX_3080_TI]), reranker: { suspend } })
    await tryGpuAgain(ctx) // clears gpuAutoDisabled AND persists a fresh RTX probe -- no suspend call anywhere in this path
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
    expect(suspend).not.toHaveBeenCalled()
  })

  it('a chat start in flight (status().startingModelId) forces cpu regardless of the committed model\'s own headroom', () => {
    const db = freshDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [CARDS.RTX_3080_TI], probedAt: new Date().toISOString() } })
    const runtime = committingRuntime(FOUR_B, { status: () => runtimeStatus({ startingModelId: NINE_B }) })
    const occupancy = snapshotRerankerOccupancy(runtime, createPendingModelSwitchCounter(), () => null)
    expect(occupancy.chatStartBusy).toBe(true)
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, occupancy)).toBe('cpu')
  })
})

describe('Wave 8 ruling (a): absent inputs mean cpu -- never a fallback to the setting', () => {
  it('a null committed model means cpu, even with provable headroom on record', () => {
    const db = freshDb()
    updateSettings(db, { gpuMode: 'auto', gpuAutoDisabled: false, gpuProbe: { devices: [CARDS.RTX_3080_TI], probedAt: new Date().toISOString() } })
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: null, ...NO_OCCUPANCY })).toBe('cpu')
  })

  it('settings.activeModelId is NEVER consulted -- a stale/mismatched setting changes nothing', () => {
    const db = freshDb()
    // The GTX 1070 Ti (#391 leg 2): its 7,504 MiB free decide this row. The 9B leaves less than the
    // floor free, the 4B more — on the 3080 Ti both models read 'gpu', so a resolver that read the
    // setting would pass unseen.
    updateSettings(db, {
      gpuMode: 'auto',
      gpuAutoDisabled: false,
      gpuProbe: { devices: [CARDS.GTX_1070_TI], probedAt: new Date().toISOString() },
      activeModelId: NINE_B // the SETTING says the 9B (posture would be cpu if this were read)
    })
    // The COMMITTED model is the 4B -- the posture must follow IT, not the stale setting.
    expect(resolveRerankerDevicePosture(getSettings(db), CATALOG_MANIFESTS, { committedModelId: FOUR_B, ...NO_OCCUPANCY })).toBe('gpu')
  })
})

describe('Wave 8 ruling (a): the pending-switch counter', () => {
  it('overlapping startModelRuntime calls each increment/decrement the counter -- it is a counter, never a boolean', async () => {
    const bothInside = deferred<void>()
    let arrived = 0
    let peak = 0
    const ctx = ctxFor(committingRuntime(), {
      suspend: async () => {
        peak = Math.max(peak, ctx.pendingModelSwitches.count)
        if (++arrived === 2) bothInside.resolve()
        await bothInside.promise // holds the first call inside until the second is in too
      }
    })
    // Two overlapping calls (the unlock auto-start beside a Use click): both request a switch.
    await Promise.all([startModelRuntime(ctx, FOUR_B), startModelRuntime(ctx, NINE_B)])
    expect(peak).toBe(2) // a boolean could never have shown 2
    expect(ctx.pendingModelSwitches.count).toBe(0) // both decremented -- never stranded
  })

  it('a start refused at the RAM gate leaves the counter at zero (the try begins right after the increment, never a function-wide finally)', async () => {
    const runtime = committingRuntime(null, {
      start: async () => {
        throw new Error('must not be reached -- the RAM gate refuses first')
      }
    })
    let suspendCalled = false
    // The RAM gate only fires when computeInstallState resolves 'installed' -- the "missing
    // weight + dev leniency" mock fallback this file's OTHER tests use bypasses it entirely
    // (`if (state === 'installed' && ...)`). So: a REAL manifest + a present weight FILE (dev
    // leniency accepts it as installed without a real hash match), with an impossible RAM
    // requirement.
    const root = freshRoot()
    const manifestsDir = join(root, 'model-manifests')
    mkdirSync(manifestsDir, { recursive: true })
    writeChatManifest(manifestsDir, {
      id: 'huge-model',
      display_name: 'Huge Model',
      size_on_disk_gb: 999,
      recommended_min_ram_gb: 9999, // no real machine passes
      recommended_ram_gb: 9999,
      local_path: 'models/chat/huge.gguf'
    })
    mkdirSync(join(root, 'models', 'chat'), { recursive: true })
    writeFileSync(join(root, 'models', 'chat', 'huge.gguf'), 'weights')
    const ctx = ctxWith(root, seededDb(root), {
      manifestsDir,
      paths: { rootPath: root, configPath: join(root, 'no-such-config') },
      runtime,
      reranker: { suspend: async () => { suspendCalled = true } }
    })
    await expect(startModelRuntime(ctx, 'huge-model')).rejects.toThrow(/needs at least 9999 GB RAM/)
    expect(suspendCalled).toBe(false) // never reached the pending/suspend section at all
    expect(ctx.pendingModelSwitches.count).toBe(0)
  })

  it('placement: the awaited suspend runs strictly between the RAM gate and ctx.runtime.start, so it never sees the shutdown/lock/epoch re-checks skipped', async () => {
    const order: string[] = []
    const runtime = committingRuntime(null, {
      isShutdown: () => {
        order.push('shutdown-recheck')
        return false
      },
      start: async (opts) => {
        order.push('runtime.start')
        runtime.commit(opts.modelId)
        return runtimeStatus({ modelId: opts.modelId })
      }
    })
    const ctx = ctxFor(runtime, {
      suspend: async () => {
        order.push('suspend')
      }
    })
    await startModelRuntime(ctx, FOUR_B)
    // suspend() ran, and it ran BEFORE the shutdown re-check and BEFORE ctx.runtime.start.
    expect(order).toEqual(['suspend', 'shutdown-recheck', 'runtime.start'])
  })

  it('F15: a masked same-model restart (activeModelId already equals the requested id) never increments the counter or suspends', async () => {
    let suspendCalled = false
    // ALREADY committed to this exact model. `settings.activeModelId` stays unset: that difference
    // from core-model-ipc's same-model row is the point, so a guard reading the setting goes red here.
    const ctx = ctxFor(committingRuntime(FOUR_B), { suspend: async () => { suspendCalled = true } })
    await startModelRuntime(ctx, FOUR_B) // the SAME model -- not a switch
    expect(suspendCalled).toBe(false)
    expect(ctx.pendingModelSwitches.count).toBe(0)
  })
})
