import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The persisted benchmark records reach every reader through `getSettings` (PR #303 audit
// H1 / L8 / M5 residual, owner decision G7). This file pins the BOUNDARY:
//
//  - H1: a structurally invalid history entry (`{}`) is never stored and never exposed —
//    `buildPerformanceSnapshot().otherMachines` is empty rather than carrying a blob the
//    screen then throws on;
//  - L8/T10: `modelPlacements: { m: {} }` is not a placement map;
//  - the READ side: rows written straight into the DB (an older build, a hand-edited
//    workspace, a half-written blob) bypass `updateSettings` entirely, so `getSettings`
//    validates too, and the startup path, the #108 sample resolution and the snapshot all
//    survive junk;
//  - G3: the legacy `{ profile }` blob stays the current record with safe defaults and never
//    earns a history entry; a complete old result keeps its ABSENT optional fields absent;
//  - M5 residual: the context on the screen is the context the runtime would launch with
//    (`launchContextTokens`), including for a manifest that states none;
//  - measured evidence must match the configuration: a placement recorded with another
//    context, or on the GPU under a forced-CPU configuration, stops counting as the measured
//    fit and travels as `observedMismatch` instead.

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { buildPerformanceSnapshot, maybeRunFirstBenchmark } from '../../src/main/ipc/registerBenchmarkIpc'
import { effectiveReadOrPersisted } from '../../src/main/ipc/registerModelIpc'
import { setPerformanceChangedSink } from '../../src/main/ipc/performance-notify'
import { detectSystem } from '../../src/main/services/benchmark'
import type { Db } from '../../src/main/services/db'
import { machineKey, resetPerformanceForTests } from '../../src/main/services/performance'
import { resetEffectiveReadForTests } from '../../src/main/services/read-speed'
import { recordModelPlacement, resetModelPlacementForTests } from '../../src/main/services/runtime/placement'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { AppSettings, BenchmarkResult, ModelPlacement } from '../../src/shared/types'
import { ctxWith, freshRoot, hereResult, result, seededDb } from '../helpers/performance-fixture'

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  resetModelPlacementForTests()
  setPerformanceChangedSink(null)
})

const here = (): string | null => machineKey(detectSystem())

/** Write a settings row STRAIGHT into the DB, bypassing `updateSettings` and its gates. */
function writeRaw(db: Db, key: string, valueJson: string): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(key, valueJson, '2026-09-05T00:00:00Z')
}

/** A manifests directory holding one chat manifest, written as the app's own YAML. */
function manifestsDir(root: string, id: string, contextTokens: number): string {
  const dir = join(root, 'manifests', 'chat')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.yaml`),
    [
      `id: ${id}`,
      `display_name: ${id}`,
      'family: test',
      'role: chat',
      'format: gguf',
      'runtime: llama_cpp',
      'license: apache-2.0',
      'size_on_disk_gb: 4',
      'recommended_min_ram_gb: 8',
      'recommended_ram_gb: 16',
      `recommended_context_tokens: ${contextTokens}`,
      `local_path: models/chat/${id}.gguf`,
      'sha256: local-unverified',
      'license_review:',
      '  status: approved',
      '  reviewed_by: "test"',
      '  reviewed_at: "2026-09-05"',
      '  notes: "fixture"'
    ].join('\n'),
    'utf8'
  )
  return join(root, 'manifests')
}

/** A placement for `modelId` on THIS machine (the fields the fit verdict reads). */
function placement(over: Partial<ModelPlacement> = {}): ModelPlacement {
  return {
    modelId: 'ctx-model',
    contextTokens: 4096,
    backend: 'gpu',
    gpuLayers: 30,
    totalLayers: 30,
    gpuModelMb: 3000,
    cpuModelMb: 100,
    gpuKvMb: 400,
    cpuKvMb: null,
    metalMaxWorkingSetMb: null,
    machineKey: here(),
    at: '2026-09-05T10:00:00Z',
    ...over
  }
}

describe('the write gate keeps invalid records out of the snapshot', () => {
  it('H1: a `{}` history entry is neither stored nor exposed as another computer', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), benchmarkHistory: [{}] as BenchmarkResult[] })
    expect(getSettings(db).benchmarkHistory).toEqual([])
    expect(buildPerformanceSnapshot(ctxWith(root, db)).otherMachines).toEqual([])
  })

  it('H1: a partially valid history keeps the real machines and drops the blobs', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, {
      lastBenchmark: hereResult(),
      benchmarkHistory: [{}, foreign, { ramGb: 8 }] as BenchmarkResult[]
    })
    expect(buildPerformanceSnapshot(ctxWith(root, db)).otherMachines.map((e) => e.cpuModel)).toEqual([foreign.cpuModel])
  })

  it('T10 / L8: `{ m: {} }` is not a placement map, and a `{}` record never reaches the verdict', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'm' })
    updateSettings(db, { modelPlacements: { m: {} } as unknown as AppSettings['modelPlacements'] })
    expect(getSettings(db).modelPlacements).toEqual({})
    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    expect(snap.placement.observed).toBeNull()
    expect(snap.placement.observedMismatch).toBeNull()
    expect(snap.placement.verdict.estimated).toBe(true)
  })
})

describe('rows that bypassed the write gate are validated on READ', () => {
  it('junk written straight into the DB reads back as the defaults, and every reader survives', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    writeRaw(db, 'lastBenchmark', JSON.stringify({ ramGb: 'lots' }))
    writeRaw(db, 'benchmarkHistory', JSON.stringify([{}, 'nope', 42, { profile: 'FAST_LOCAL' }]))
    writeRaw(db, 'modelPlacements', JSON.stringify({ m: {}, other: 'x' }))

    const s = getSettings(db)
    expect(s.lastBenchmark).toBeNull()
    expect(s.benchmarkHistory).toEqual([])
    expect(s.modelPlacements).toEqual({})

    const ctx = ctxWith(root, db)
    // The three readers that used to take a stored blob at face value.
    expect(() => effectiveReadOrPersisted(ctx)).not.toThrow()
    expect(effectiveReadOrPersisted(ctx)).toBeNull()
    const snap = buildPerformanceSnapshot(ctx)
    expect(snap.current).toBeNull()
    expect(snap.otherMachines).toEqual([])
    expect(snap.placement.observed).toBeNull()

    // `lastBenchmark` reads as null, so this is a first run: the background benchmark lands a
    // real, keyed result over the junk row.
    maybeRunFirstBenchmark(ctx)
    await vi.waitFor(() => {
      expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
    })
  })

  it('a corrupt row does not cost the records beside it', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult()
    updateSettings(db, { benchmarkHistory: [mine] })
    writeRaw(db, 'lastBenchmark', '{ not json at all')
    const s = getSettings(db)
    expect(s.lastBenchmark).toBeNull()
    expect(s.benchmarkHistory.map((e) => e.cpuModel)).toEqual([mine.cpuModel])
  })

  it('a history row holding one machine twice reads back as one entry, the newest', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const older = hereResult({ ranAt: '2026-01-01T00:00:00Z', tokensPerSecond: 1 })
    const newer = hereResult({ ranAt: '2026-09-01T00:00:00Z', tokensPerSecond: 9 })
    writeRaw(db, 'benchmarkHistory', JSON.stringify([older, newer]))
    const stored = getSettings(db).benchmarkHistory
    expect(stored).toHaveLength(1)
    expect(stored[0].tokensPerSecond).toBe(9)
  })
})

describe('legacy records (G3)', () => {
  it('the `{ profile }` blob stays the current record, with safe defaults and no history entry', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: { profile: 'BALANCED' } as unknown as BenchmarkResult })

    const stored = getSettings(db).lastBenchmark
    expect(stored?.profile).toBe('BALANCED')
    // Unknown identity and unknown DATE — never a fabricated "now".
    expect(stored?.ramGb).toBe(0)
    expect(stored?.cpuModel).toBe('')
    expect(stored?.ranAt).toBe('')
    expect(machineKey(stored)).toBeNull()

    const snap = buildPerformanceSnapshot(ctxWith(root, db))
    // An unknown identity still counts as "this machine" (the compatibility policy), and the
    // unkeyed record is never filed as another computer.
    expect(snap.currentMachine).toBe(true)
    expect(snap.current?.profile).toBe('BALANCED')
    expect(snap.otherMachines).toEqual([])
    expect(getSettings(db).benchmarkHistory).toEqual([])
  })

  it('a complete old result missing every optional field round-trips with them still absent', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const old = hereResult()
    delete old.gpuVramMb
    delete old.speedBasis
    delete old.measuredModelId
    delete old.effectiveRead
    updateSettings(db, { lastBenchmark: old, benchmarkHistory: [old] })

    const stored = getSettings(db).lastBenchmark!
    expect(stored).toEqual(old)
    // Absent, not null: "approximate" and "not measured yet" are what the screens must say.
    expect('speedBasis' in stored).toBe(false)
    expect('measuredModelId' in stored).toBe(false)
    expect('effectiveRead' in stored).toBe(false)
    expect('gpuVramMb' in stored).toBe(false)
    expect(getSettings(db).benchmarkHistory[0]).toEqual(old)
  })
})

describe('the context on the screen is the context the runtime would launch with (M5 residual)', () => {
  const contextOf = (root: string, db: Db, dir?: string): number | null =>
    buildPerformanceSnapshot(ctxWith(root, db, dir ? { manifestsDir: dir } : {})).placement.model?.contextTokens ?? null

  it("uses the manifest's recommended window when it states one", () => {
    const root = freshRoot()
    const db = seededDb(root)
    const dir = manifestsDir(root, 'ctx-model', 32_768)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model' })
    expect(contextOf(root, db, dir)).toBe(32_768)
  })

  it('falls back to the settings default for a manifest that states NO window (never "0-token")', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const dir = manifestsDir(root, 'ctx-model', 0)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model' })
    // The launch path's `||` starts such a model on `settings.contextTokens`; the screen used
    // to recompute with `??` and show a 0-token context for the very same start.
    expect(contextOf(root, db, dir)).toBe(getSettings(db).contextTokens)
    expect(contextOf(root, db, dir)).not.toBe(0)
  })

  it('falls back to the settings default with no manifest for the model at all', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'not-in-the-catalog' })
    expect(contextOf(root, db)).toBe(getSettings(db).contextTokens)
  })

  it('the user override wins over both, up to the 131 072 ceiling', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const dir = manifestsDir(root, 'ctx-model', 32_768)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model', contextTokensOverride: 131_072 })
    expect(contextOf(root, db, dir)).toBe(131_072)
  })

  it('carries the RECOMMENDED model’s launch context too, so the screen never recomputes it', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const dir = manifestsDir(root, 'ctx-model', 0)
    updateSettings(db, { lastBenchmark: hereResult({ recommendedModelId: 'ctx-model' }) })
    const withManifests = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir }))
    expect(withManifests.placement.recommendedContextTokens).toBe(getSettings(db).contextTokens)

    updateSettings(db, { contextTokensOverride: 131_072 })
    expect(buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir })).placement.recommendedContextTokens).toBe(131_072)

    // The figure follows the LIVE recommendation (PR #308 decision 8), not the id saved with
    // the check: a result that saved no pick still states the live pick's context…
    updateSettings(db, { lastBenchmark: hereResult({ recommendedModelId: null }) })
    const live = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir }))
    expect(live.recommendation?.modelId).toBe('ctx-model')
    expect(live.placement.recommendedContextTokens).toBe(131_072)
    // …and without a catalog there is no live pick ⇒ nothing to state.
    const none = buildPerformanceSnapshot(ctxWith(root, db))
    expect(none.recommendation).toBeNull()
    expect(none.placement.recommendedContextTokens).toBeNull()
  })
})

describe('a measurement counts as OBSERVED only for the configuration it was taken under', () => {
  /** An active model with one persisted placement, under `settings`. */
  function withPlacement(over: Partial<ModelPlacement>, settings: Partial<AppSettings> = {}) {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model', ...settings })
    updateSettings(db, { modelPlacements: { 'ctx-model': placement(over) } })
    return buildPerformanceSnapshot(ctxWith(root, db)).placement
  }

  it('the matching case: same context, and a GPU record under an auto configuration', () => {
    const p = withPlacement({})
    expect(p.model?.contextTokens).toBe(4096)
    expect(p.observed?.at).toBe('2026-09-05T10:00:00Z')
    expect(p.observedMismatch).toBeNull()
    expect(p.verdict.estimated).toBe(false)
  })

  it('a context change demotes it to the estimate and reports what was measured', () => {
    const p = withPlacement({ contextTokens: 32_768 })
    expect(p.observed).toBeNull()
    expect(p.observedMismatch).toEqual({ contextTokens: 32_768, backend: 'gpu', at: '2026-09-05T10:00:00Z' })
    // The row now answers for the CURRENT settings: the weights-only estimate.
    expect(p.verdict.estimated).toBe(true)
  })

  it('a GPU measurement does not survive the GPU being switched off', () => {
    const off = withPlacement({}, { gpuMode: 'off' })
    expect(off.observed).toBeNull()
    expect(off.observedMismatch).toEqual({ contextTokens: 4096, backend: 'gpu', at: '2026-09-05T10:00:00Z' })

    // The same for the automatic disable after a GPU failure…
    const auto = withPlacement({}, { gpuAutoDisabled: true })
    expect(auto.observed).toBeNull()

    // …while a CPU measurement is exactly what a forced-CPU configuration would produce.
    const cpu = withPlacement({ backend: 'cpu', gpuLayers: null, totalLayers: null, gpuModelMb: null, gpuKvMb: null }, { gpuMode: 'off' })
    expect(cpu.observed?.backend).toBe('cpu')
    expect(cpu.observedMismatch).toBeNull()
    expect(cpu.verdict.kind).toBe('cpu')
  })

  it('a CPU measurement still counts under an automatic configuration (the ladder decides per start)', () => {
    const p = withPlacement({ backend: 'cpu', gpuLayers: null, totalLayers: null })
    expect(p.observed?.backend).toBe('cpu')
    expect(p.observedMismatch).toBeNull()
  })

  it('the mismatched record is KEPT in settings — the next matching start restores it', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model', contextTokensOverride: 32_768 })
    updateSettings(db, { modelPlacements: { 'ctx-model': placement() } })
    expect(buildPerformanceSnapshot(ctxWith(root, db)).placement.observed).toBeNull()
    expect(getSettings(db).modelPlacements['ctx-model']?.contextTokens).toBe(4096)

    updateSettings(db, { contextTokensOverride: null })
    expect(buildPerformanceSnapshot(ctxWith(root, db)).placement.observed?.contextTokens).toBe(4096)
  })

  it('the session latch is judged the same way as the persisted record', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ctx-model' })
    recordModelPlacement(placement({ contextTokens: 16_384, at: '2026-09-05T11:00:00Z' }))
    const p = buildPerformanceSnapshot(ctxWith(root, db)).placement
    expect(p.observed).toBeNull()
    expect(p.observedMismatch).toEqual({ contextTokens: 16_384, backend: 'gpu', at: '2026-09-05T11:00:00Z' })
  })
})
