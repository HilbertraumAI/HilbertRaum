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

import { statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildPerformanceSnapshot } from '../../src/main/ipc/registerBenchmarkIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { recordAnswerSpeed } from '../../src/main/services/performance'
import { recordChecksumRead, recordModelLoadRead } from '../../src/main/services/read-speed'
import { recordModelPlacement } from '../../src/main/services/runtime/placement'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { checksumCacheStats, discoverManifests, manifestFiles, primeChecksum } from '../../src/main/services/models'
import { pickManifestForRole } from '../../src/shared/manifest'
import type { ResidentModelRow, RuntimeStatus } from '../../src/shared/types'
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
  stubChatRuntime,
  withCatalogFiles,
  withLlamaBinary
} from '../helpers/performance-fixture'
import { runtimeStatus } from '../helpers/status'
import { manifestsDirWith, rawManifest, writeDriveFile } from '../helpers/manifest-fixtures'
import { resolveModelByRole } from '../../src/main/services/resolve-model'
import { getVisionStatus } from '../../src/main/services/vision/status'

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
    // Not in the catalog: no size (#914: it was 0, which the screen printed as "0.0 GB"), context from settings. The
    // chat row agrees, and a model with no manifest names no files on this drive.
    expect(snap.placement.model).toMatchObject({ sizeOnDiskGb: null, onDrive: false })
    expect(snap.placement.models[0]).toMatchObject({ role: 'chat', modelId: 'some-model', sizeOnDiskGb: null, onDrive: false })
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

  it('lists every model the app can hold, with liveness from each service and whether its files are on this drive', () => {
    const root = freshRoot()
    // The drive holds the models whose services report live (presence-only stand-ins, #914); images and voice are not on it.
    withCatalogFiles(root, { chat: 'qwen3.5-9b-ud-q4kxl', roles: ['translation', 'reranker', 'embeddings'] })
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
    expect(rows[0]).toMatchObject({ role: 'chat', modelId: 'qwen3.5-9b-ud-q4kxl', onDrive: true, loaded: true, lifetime: 'session' })
    // The catalog's translation model, live; pinned roles say cpu. Its split shows only on a row that
    // says 'gpu' (#671) — pinned in performance-gpu.test.ts.
    const tr = rows.find((r) => r.role === 'translation')
    expect(tr).toMatchObject({ onDrive: true, loaded: true, lifetime: 'idle' })
    expect(tr?.modelId).toBe('translategemma-12b-it-q4')
    // No vision file on this root: the row still names the catalog's model (#890's `?? byRole('vision')` fallback),
    // marked not on this drive (#914).
    expect(rows.find((r) => r.role === 'vision')).toMatchObject({ onDrive: false, device: 'cpu', loaded: false, lifetime: 'idle' })
    // A fake without the optional `devicePosture` member reports 'cpu' (Wave 8 ruling (d), the
    // `isLoaded?` pattern's own default) -- unchanged from before this step.
    expect(rows.find((r) => r.role === 'reranker')).toMatchObject({ onDrive: true, device: 'cpu', loaded: true, lifetime: 'session' })
    expect(rows.find((r) => r.role === 'embeddings')).toMatchObject({ onDrive: true, device: 'cpu', loaded: true })
    expect(rows.find((r) => r.role === 'transcriber')).toMatchObject({ onDrive: false, device: 'cpu', loaded: false, lifetime: 'per-use' })
  })

  // #914 (owner decision G-5 (c)): every role keeps its row, named from the catalog (the planning view the docs
  // promise), but a model whose files are not on this drive is marked so and left out of "Everything loaded at once":
  // nothing will load it. Before, a drive that held only the 9B counted every catalog model in the total, 17.2 GB
  // against the 9B's 5.6 GB. The chat row follows the same rule: with the active model's files gone a start is refused,
  // so nothing is left to count. `placement.model.onDrive` (#914 code review) says the same for "Your model".
  it('#914: a model whose files are not on this drive keeps its row, marked so, and is left out of the total', () => {
    const placementOn = (files: 'chat' | 'none') => {
      const root = freshRoot()
      if (files === 'chat') withCatalogFiles(root, { chat: 'qwen3.5-9b-ud-q4kxl' })
      const db = seededDb(root)
      updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
      return buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: CATALOG_MANIFESTS })).placement
    }
    const chatOnly = placementOn('chat')
    expect(chatOnly.memoryClass).toBe('cpu')
    expect(chatOnly.model).toMatchObject({ id: 'qwen3.5-9b-ud-q4kxl', onDrive: true })
    expect(chatOnly.models.map((r) => [r.role, r.modelId != null, r.onDrive])).toEqual([
      ['chat', true, true],
      ['translation', true, false],
      ['vision', true, false],
      ['reranker', true, false],
      ['embeddings', true, false],
      ['transcriber', true, false]
    ])
    expect(chatOnly.totals.ramAllMb).toBe(Math.round((chatOnly.models[0].sizeOnDiskGb ?? 0) * 1024))

    const nothing = placementOn('none')
    expect(nothing.model).toMatchObject({ id: 'qwen3.5-9b-ud-q4kxl', onDrive: false })
    expect(nothing.models[0]).toMatchObject({ role: 'chat', modelId: 'qwen3.5-9b-ud-q4kxl', onDrive: false })
    expect(nothing.models.every((r) => !r.onDrive)).toBe(true)
    expect(nothing.totals.ramAllMb).toBeNull()
  })

  // #914 code review: loaded beats `onDrive`. The runtime holds the 9B (a weight deleted while held open), so its memory
  // is in use: the chat row stays `onDrive: false` (the presence fact) but is loaded and counts in the total, and
  // "Your model" treats it as here (`placement.model.onDrive`), so the screen keeps its size and verdict.
  it('#914: a resident chat model counts and stays "here" even when its files are not on this drive', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
    const p = buildPerformanceSnapshot(
      ctxWith(root, db, {
        manifestsDir: CATALOG_MANIFESTS,
        runtime: stubChatRuntime({ modelId: 'qwen3.5-9b-ud-q4kxl', status: () => runningStatus('qwen3.5-9b-ud-q4kxl') })
      })
    ).placement
    expect(p.models[0]).toMatchObject({ role: 'chat', onDrive: false, loaded: true })
    expect(p.model).toMatchObject({ id: 'qwen3.5-9b-ud-q4kxl', onDrive: true })
    expect(p.totals.ramAllMb).toBe(Math.round((p.models[0].sizeOnDiskGb ?? 0) * 1024))
  })

  // #933: "Check all model files" found the reranker damaged (its cached digest is not the manifest's), and every start
  // refuses it (#913). Its row says so and "Everything loaded at once" leaves it out: before, it added its 1,126 MiB as a
  // model that would load. The verdict comes from the checksum cache only: the snapshot hashes nothing.
  /** The 9B, the reranker and the embedder on this drive (stand-in bytes), the 9B active, nothing loaded. */
  function threeModelDrive(): { root: string; db: ReturnType<typeof seededDb>; ctx: ReturnType<typeof ctxWith>; rerankerFile: string } {
    const root = freshRoot()
    withCatalogFiles(root, { chat: 'qwen3.5-9b-ud-q4kxl', roles: ['embeddings', 'reranker'] })
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'qwen3.5-9b-ud-q4kxl' })
    const reranker = pickManifestForRole(discoverManifests(CATALOG_MANIFESTS).manifests.map((d) => d.manifest), 'reranker')
    if (!reranker) throw new Error('the catalog has no reranker')
    return { root, db, ctx: ctxWith(root, db, { manifestsDir: CATALOG_MANIFESTS }), rerankerFile: manifestFiles(root, reranker)[0].path }
  }
  /** "Everything loaded at once" for these rows on the `cpu` class: the plain sum (`loadedAtOnceMb`). */
  const sumMb = (rows: ResidentModelRow[]): number => Math.round(rows.reduce((s, r) => s + (r.sizeOnDiskGb ?? 0) * 1024, 0))

  it('#933: a model the checksum cache knows is damaged reads so and is left out of the total; nothing is hashed', () => {
    const { ctx, rerankerFile } = threeModelDrive()
    const before = buildPerformanceSnapshot(ctx).placement
    expect(before.memoryClass).toBe('cpu')
    expect(before.models.find((r) => r.role === 'reranker')).toMatchObject({ onDrive: true, fileCheck: 'ok' }) // not checked yet
    primeChecksum(rerankerFile, 'f'.repeat(64)) // the check of this session found it damaged
    const computed = checksumCacheStats.computed
    const after = buildPerformanceSnapshot(ctx).placement
    const byRole = (role: ResidentModelRow['role']): ResidentModelRow | undefined => after.models.find((r) => r.role === role)
    expect(byRole('reranker')).toMatchObject({ onDrive: true, loaded: false, fileCheck: 'damaged' })
    // Present and never checked: `ok`, read without a hash.
    expect(byRole('chat')?.fileCheck).toBe('ok')
    expect(byRole('embeddings')?.fileCheck).toBe('ok')
    expect(after.model).toMatchObject({ id: 'qwen3.5-9b-ud-q4kxl', fileCheck: 'ok' })
    expect(after.totals.ramAllMb).toBe(
      sumMb([byRole('chat'), byRole('embeddings')].filter((r): r is ResidentModelRow => r != null))
    )
    expect(after.totals.ramAllMb).toBeLessThan(before.totals.ramAllMb ?? 0)
    expect(checksumCacheStats.computed).toBe(computed)
  })

  // #933 (A S-A8): the next session, where the in-memory cache is empty and only the workspace settings hold the check's
  // answer. The snapshot reads the `checksumCache` it has already read, through a view that cannot write: the settings
  // store's `get` would move a legacy absolute key to its drive-relative one, a settings write inside a display getter.
  it.each<[string, (root: string, file: string) => string]>([
    ['its drive-relative key', (root, file) => relative(root, file).split(sep).join('/')],
    ['a legacy absolute key', (_root, file) => file]
  ])('#933: a mismatch only the workspace settings remember (%s) reads damaged; the read hashes and writes nothing', (_key, keyOf) => {
    const { root, db, ctx, rerankerFile } = threeModelDrive()
    const st = statSync(rerankerFile)
    updateSettings(db, {
      checksumCache: { [keyOf(root, rerankerFile)]: { size: st.size, mtimeMs: st.mtimeMs, sha256: 'f'.repeat(64) } }
    })
    const blob = JSON.stringify(getSettings(db).checksumCache)
    const computed = checksumCacheStats.computed
    const p = buildPerformanceSnapshot(ctx).placement
    expect(p.models.find((r) => r.role === 'reranker')?.fileCheck).toBe('damaged')
    expect(checksumCacheStats.computed).toBe(computed)
    expect(JSON.stringify(getSettings(db).checksumCache)).toBe(blob)
  })

  // #933 (A 933.1 #9): a model with no checksum on record (a placeholder hash) is refused at every start outside developer
  // leniency too (#913), so it reads `unverified` and counts nowhere; "Your model" carries the same verdict. With
  // leniency (a dev build, no drive policy) it starts, so it is `ok` and counts.
  it.each<[string, boolean, 'ok' | 'unverified']>([
    ['outside developer leniency', false, 'unverified'],
    ['with developer leniency', true, 'ok']
  ])('#933: an active chat model with no checksum on record, %s', (_case, isDev, verdict) => {
    const root = freshRoot()
    writeDriveFile(root, 'models/chat/ph.gguf', 'weights')
    const dir = manifestsDirWith(rawManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })) // the fixture's hash is the placeholder
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ph' })
    const p = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir, isDev })).placement
    expect(p.models[0]).toMatchObject({ role: 'chat', modelId: 'ph', onDrive: true, fileCheck: verdict })
    expect(p.model).toMatchObject({ id: 'ph', onDrive: true, fileCheck: verdict })
    expect(p.totals.ramAllMb).toBe(verdict === 'ok' ? sumMb([p.models[0]]) : null)
  })

  // #933 (A S-A7): with two vision models, the images service passes over one whose files a check found damaged and runs
  // the next (#890's walk). The row names the same model, read from the cache, instead of the damaged one.
  it('#933: the images row passes over a vision model the cache knows is damaged, as the images service does', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    withLlamaBinary(root)
    const vision = (id: string, flagged: boolean): Record<string, unknown> => {
      const local = `models/vision/${id}.gguf`
      const projector = `models/vision/${id}-mmproj.gguf`
      return rawManifest({
        id,
        role: 'vision',
        input_modalities: ['text', 'image'],
        local_path: local,
        sha256: writeDriveFile(root, local, `${id} weights`),
        mmproj: { local_path: projector, sha256: writeDriveFile(root, projector, `${id} projector`) },
        ...(flagged ? { default_for_role: true } : {})
      })
    }
    const dir = manifestsDirWith(vision('a-vision', true), vision('b-vision', false))
    primeChecksum(join(root, 'models', 'vision', 'a-vision.gguf'), 'f'.repeat(64)) // the preferred one: damaged
    const ctx = ctxWith(root, db, { manifestsDir: dir, vision: { isLoaded: () => false } })
    const row = buildPerformanceSnapshot(ctx).placement.models.find((r) => r.role === 'vision')
    expect(row).toMatchObject({ modelId: 'b-vision', fileCheck: 'ok' })
    expect((await getVisionStatus(ctx)).modelId).toBe('b-vision')
  })

  // #933 review N1: loaded beats the verdict on the images row too, and the row names the model the images service
  // holds (`loadedModelId`), so its name, size, "loaded now" and its share of the total describe the one in memory.
  // (a) The pick was resident when the check found it damaged: the row keeps naming it, not the next candidate.
  // (b) The pick was already damaged when Images started, so the service loaded the next candidate: the row names that.
  it.each<[string, string, { modelId: string; fileCheck: 'ok' | 'damaged' }]>([
    ['the pick, resident when a check found it damaged', 'a-vision', { modelId: 'a-vision', fileCheck: 'damaged' }],
    ['the next candidate, loaded because the pick was damaged first', 'b-vision', { modelId: 'b-vision', fileCheck: 'ok' }]
  ])('#933: while the images service holds a model, the row names the loaded model: %s', (_case, loadedId, expected) => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    const vision = (id: string, sizeGb: number, flagged: boolean): Record<string, unknown> => {
      const local = `models/vision/${id}.gguf`
      const projector = `models/vision/${id}-mmproj.gguf`
      return rawManifest({
        id,
        role: 'vision',
        input_modalities: ['text', 'image'],
        size_on_disk_gb: sizeGb,
        local_path: local,
        sha256: writeDriveFile(root, local, `${id} weights`),
        mmproj: { local_path: projector, sha256: writeDriveFile(root, projector, `${id} projector`) },
        ...(flagged ? { default_for_role: true } : {})
      })
    }
    const dir = manifestsDirWith(vision('a-vision', 3.3, true), vision('b-vision', 2.2, false))
    primeChecksum(join(root, 'models', 'vision', 'a-vision.gguf'), 'f'.repeat(64)) // the pick: damaged
    const ctx = ctxWith(root, db, { manifestsDir: dir, vision: { isLoaded: () => true, loadedModelId: () => loadedId } })
    const p = buildPerformanceSnapshot(ctx).placement
    const row = p.models.find((r) => r.role === 'vision')
    expect(row).toMatchObject({ ...expected, loaded: true, sizeOnDiskGb: loadedId === 'a-vision' ? 3.1 : 2.0 })
    expect(p.totals.ramAllMb).toBe(sumMb(row ? [row] : []))
  })

  // #933 review N4: a check that stops at the first damaged file of a multi-file model leaves the mismatch cached for
  // that file only (#913's S-913-1 case): a projector, or a shard of a `files:` set. The row must read it as damaged.
  it.each<[string, 'projector' | 'shard']>([
    ['the projector of a vision model', 'projector'],
    ['the second shard of a split chat model', 'shard']
  ])('#933: a mismatch cached for %s alone reads damaged', (_case, which) => {
    const root = freshRoot()
    const db = seededDb(root)
    const manifest =
      which === 'projector'
        ? rawManifest({
            id: 'vl',
            role: 'vision',
            input_modalities: ['text', 'image'],
            local_path: 'models/vision/vl.gguf',
            sha256: writeDriveFile(root, 'models/vision/vl.gguf', 'weights'),
            mmproj: { local_path: 'models/vision/vl-mmproj.gguf', sha256: writeDriveFile(root, 'models/vision/vl-mmproj.gguf', 'projector') }
          })
        : rawManifest({
            id: 'split',
            local_path: 'models/chat/split-00001-of-00002.gguf',
            sha256: writeDriveFile(root, 'models/chat/split-00001-of-00002.gguf', 'shard one'),
            files: [{ local_path: 'models/chat/split-00002-of-00002.gguf', sha256: writeDriveFile(root, 'models/chat/split-00002-of-00002.gguf', 'shard two') }]
          })
    const damagedFile = which === 'projector' ? 'models/vision/vl-mmproj.gguf' : 'models/chat/split-00002-of-00002.gguf'
    primeChecksum(join(root, ...damagedFile.split('/')), 'f'.repeat(64))
    updateSettings(db, { lastBenchmark: hereResult(), ...(which === 'shard' ? { activeModelId: 'split' } : {}) })
    const rows = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: manifestsDirWith(manifest), vision: { isLoaded: () => false } }))
      .placement.models
    expect(rows.find((r) => r.role === (which === 'projector' ? 'vision' : 'chat'))).toMatchObject({ onDrive: true, fileCheck: 'damaged' })
  })

  // #933 review N4: developer leniency needs the drive policy too (`developerLeniency`). With the toggle on and a dev
  // build, a commercial policy (`allow_unverified_models: false`) still refuses a placeholder, so the row stays
  // `unverified`.
  it('#933: developer mode under a policy that forbids unverified models keeps a no-checksum model unverified', () => {
    const root = freshRoot()
    writeDriveFile(root, 'models/chat/ph.gguf', 'weights')
    writeDriveFile(root, 'config/policy.json', JSON.stringify({ models: { allow_unverified_models: false, require_sha256_match: true } }))
    const dir = manifestsDirWith(rawManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })) // the fixture's hash is the placeholder
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeModelId: 'ph', developerMode: true })
    const p = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir, isDev: true })).placement
    expect(p.models[0]).toMatchObject({ role: 'chat', modelId: 'ph', fileCheck: 'unverified' })
    expect(p.totals.ramAllMb).toBeNull()
  })

  // #848 review: the Performance screen names a role's model by the SAME pick the app composes with (the flagged
  // default first, `pickManifestForRole` behind `resolveModelByRole`), never simply the first file of the role, so the
  // embedder row cannot name a model the app does not run. #890: nor does the `activeEmbeddingModelId` setting move
  // it; no composer reads that setting, so here it names the other manifest and the row still names `z-default`.
  it('names the embedder the app composes: the flagged default, even when another embeddings manifest sorts first (#848)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), activeEmbeddingModelId: 'a-second' })
    const dir = manifestsDirWith(
      rawManifest({ id: 'a-second', role: 'embeddings', local_path: 'models/embeddings/a-second.gguf' }),
      rawManifest({ id: 'z-default', role: 'embeddings', local_path: 'models/embeddings/z-default.gguf', default_for_role: true })
    )
    const rows = buildPerformanceSnapshot(ctxWith(root, db, { manifestsDir: dir, embedder: { isLoaded: () => false } })).placement.models
    const row = rows.find((r) => r.role === 'embeddings')
    expect(row?.modelId).toBe('z-default')
    expect(row?.modelId).toBe(resolveModelByRole(dir, root, 'embeddings')?.id)
  })

  // #890 (G-8 (ii-a)): the vision row names the model the images service runs. Both take one pick, the flagged vision
  // model among those whose files are all on the drive, else the first of them in walk order. Before, the row named the
  // flagged or first manifest whether its files were there or not, and the service ran the first installed one.
  it.each<[string, Array<{ id: string; present: boolean; flagged?: boolean }>, string]>([
    ['the first is not downloaded', [{ id: 'a-vision', present: false }, { id: 'b-vision', present: true }], 'b-vision'],
    ['the flagged one sorts last', [{ id: 'a-vision', present: true }, { id: 'z-vision', present: true, flagged: true }], 'z-vision'],
    ['the flagged one is not downloaded', [{ id: 'a-vision', present: true }, { id: 'z-vision', present: false, flagged: true }], 'a-vision']
  ])('names the vision model the images service runs: %s (#890)', async (_case, models, expected) => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult() })
    withLlamaBinary(root)
    const dir = manifestsDirWith(
      ...models.map((m) => {
        const local = `models/vision/${m.id}.gguf`
        const projector = `models/vision/${m.id}-mmproj.gguf`
        if (m.present) {
          writeDriveFile(root, local, 'weights')
          writeDriveFile(root, projector, 'projector')
        }
        return rawManifest({
          id: m.id,
          role: 'vision',
          input_modalities: ['text', 'image'],
          local_path: local,
          mmproj: { local_path: projector, sha256: 'REPLACE_WITH_REAL_HASH' },
          ...(m.flagged ? { default_for_role: true } : {})
        })
      })
    )
    const ctx = ctxWith(root, db, { manifestsDir: dir, vision: { isLoaded: () => false } })
    const row = buildPerformanceSnapshot(ctx).placement.models.find((r) => r.role === 'vision')
    const status = await getVisionStatus(ctx)
    expect(status.modelId).toBe(expected)
    expect(row?.modelId).toBe(status.modelId)
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
