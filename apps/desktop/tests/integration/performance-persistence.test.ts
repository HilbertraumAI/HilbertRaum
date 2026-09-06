import { describe, it, expect, vi, beforeEach } from 'vitest'
import { t } from '../../src/shared/i18n'

// Benchmark persistence on a drive that TRAVELS (benchmark.md "Persistence" / "History per
// machine"; PR #303 audit M2 / M4 / M6 / L2):
//  - identity before ranking: a foreign persisted effective-read sample is never carried into
//    this machine's benchmark, its warning, or the #107 estimate; an unknown identity on
//    either side stays eligible (G3, compatibility) and never earns a history entry;
//  - the upgrade backfill: an outgoing `lastBenchmark` from another computer is filed into
//    the history before a run, a restore, or a manual run replaces it — exactly once, and the
//    cap evicts the oldest OTHER machine, never the one being restored;
//  - a sample landing mid-run (drive or speed leg) survives the run's own persist;
//  - the observer writes a sample to EVERY eligible destination, retries a failed or
//    deferred write, and repairs a stale history entry beside an up-to-date headline.

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { maybeRunFirstBenchmark, runAndPersistBenchmark } from '../../src/main/ipc/registerBenchmarkIpc'
import { effectiveReadOrPersisted, persistEffectiveRead, registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { modelBusyLane } from '../../src/main/ipc/model-busy'
import { detectSystem } from '../../src/main/services/benchmark'
import type { Db } from '../../src/main/services/db'
import { machineKey, resetPerformanceForTests, upsertHistory } from '../../src/main/services/performance'
import {
  latestEffectiveRead,
  recordChecksumRead,
  recordModelLoadRead,
  resetEffectiveReadForTests,
  setReadSpeedClockForTests
} from '../../src/main/services/read-speed'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { MAX_BENCHMARK_HISTORY, type BenchmarkProgressStep, type BenchmarkResult, type EffectiveReadSample } from '../../src/shared/types'
import { ctxWith, freshRoot, hereResult, result, seededDb } from '../helpers/performance-fixture'

/** A model-load sample measured on some other computer (slow enough to carry the #110 warning). */
const foreignSample: EffectiveReadSample = {
  mbps: 70,
  bytes: 3_000_000_000,
  ms: 42_857,
  source: 'model_load',
  modelId: 'foreign-model',
  at: '2026-08-01T00:00:00Z'
}
const slowReadWarning = (mbps: number): string => t('en', 'main.benchmark.warnSlowRead', { mbps })
const hasSlowReadWarning = (warnings: readonly string[]): boolean =>
  warnings.some((w) => w.includes('model starts will be slow'))
const here = (): string | null => machineKey(detectSystem())

/** 3 GB in 10 s: a 300 MB/s model-load sample (above the #110 gate). */
function loadSample(modelId: string, ms = 10_000): void {
  recordModelLoadRead('unused', ms, modelId, 3_000_000_000)
}

/** A bare runtime whose stream yields a few chunks — enough for the speed leg to run. */
function stubRuntime(): ModelRuntime {
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
    }
  }
}

/** A DB whose FIRST settings write fails (the INSERT prepare throws), then behaves. */
function failingFirstWrite(db: Db): Db {
  let armed = true
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (armed && /^INSERT INTO settings/.test(sql.trim())) {
            armed = false
            throw new Error('simulated write failure')
          }
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

beforeEach(() => {
  resetPerformanceForTests()
  resetEffectiveReadForTests()
  // Samples are identified by their millisecond `at`; two recorded within one millisecond read as
  // one (the PR #303 P5 CI run on ubuntu/Node 24 ignored the fast sample after the slow one at
  // the #110 case). Real loads take seconds — give every recorded sample its own second.
  let tick = Date.parse('2026-09-06T10:00:00.000Z')
  setReadSpeedClockForTests(() => new Date((tick += 1000)))
})

describe('identity before ranking (M2)', () => {
  it('a NEW computer does not inherit a foreign persisted model-load sample, nor its warning', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result({ effectiveRead: foreignSample, warnings: [slowReadWarning(70)] })
    updateSettings(db, { lastBenchmark: foreign })

    const fresh = await runAndPersistBenchmark(ctxWith(root, db))

    expect(fresh.effectiveRead).toBeNull()
    expect(hasSlowReadWarning(fresh.warnings)).toBe(false)
    expect(getSettings(db).lastBenchmark?.effectiveRead).toBeNull()
  })

  it('a local checksum sample beats a foreign persisted model-load sample', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: result({ effectiveRead: foreignSample }) })
    recordChecksumRead(3_000_000_000, 30_000, 'local-model')

    expect(effectiveReadOrPersisted(ctxWith(root, db))?.modelId).toBe('local-model')
  })

  it('same machine: a persisted model_load outranks a session checksum; a newer same-source sample wins', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const persisted: EffectiveReadSample = { ...foreignSample, modelId: 'persisted-load', mbps: 400 }
    updateSettings(db, { lastBenchmark: hereResult({ effectiveRead: persisted }) })
    const ctx = ctxWith(root, db)

    recordChecksumRead(3_000_000_000, 30_000, 'session-checksum')
    expect(effectiveReadOrPersisted(ctx)?.modelId).toBe('persisted-load')

    loadSample('session-load')
    expect(effectiveReadOrPersisted(ctx)?.modelId).toBe('session-load')
  })

  it("this machine's history entry supplies the sample when lastBenchmark is foreign", () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine: EffectiveReadSample = { ...foreignSample, modelId: 'my-load', mbps: 450, at: '2026-07-01T00:00:00Z' }
    const foreign = result({ effectiveRead: foreignSample })
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, hereResult({ effectiveRead: mine })] })

    expect(effectiveReadOrPersisted(ctxWith(root, db))?.modelId).toBe('my-load')
  })

  it('#107 fallback: null when nothing eligible exists (foreign sample only, no local history)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: result({ effectiveRead: foreignSample }) })

    expect(effectiveReadOrPersisted(ctxWith(root, db))).toBeNull()
  })

  it('G3: an unkeyed legacy result stays eligible (compatibility) and never earns a history entry', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const legacy = hereResult({ cpuModel: '', effectiveRead: { ...foreignSample, modelId: 'legacy-load' } })
    expect(machineKey(legacy)).toBeNull()
    updateSettings(db, { lastBenchmark: legacy })
    const ctx = ctxWith(root, db)
    registerModelIpc(ctx)

    // Carried forward: unknown identity on the persisted side reads as "this machine".
    expect(effectiveReadOrPersisted(ctx)?.modelId).toBe('legacy-load')
    // The observer updates the unkeyed headline in place, but files nothing under a key.
    loadSample('local-load')
    expect(getSettings(db).lastBenchmark?.effectiveRead?.modelId).toBe('local-load')
    expect(getSettings(db).benchmarkHistory).toEqual([])

    // A run keeps the (now local) sample and files only ITS keyed result.
    const fresh = await runAndPersistBenchmark(ctx)
    expect(fresh.effectiveRead?.modelId).toBe('local-load')
    const history = getSettings(db).benchmarkHistory
    expect(history).toHaveLength(1)
    expect(machineKey(history[0])).toBe(here())
  })
})

describe('upgrade backfill (M4)', () => {
  it.each([
    ['empty history', false],
    ['absent history row', true]
  ])('first move via maybeRunFirstBenchmark (%s) keeps the old computer', async (_label, dropRow) => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign })
    if (dropRow) db.prepare("DELETE FROM settings WHERE key = 'benchmarkHistory'").run()
    expect(getSettings(db).benchmarkHistory).toEqual([])

    maybeRunFirstBenchmark(ctxWith(root, db))

    await vi.waitFor(() => {
      expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
    })
    const history = getSettings(db).benchmarkHistory
    expect(history).toHaveLength(2)
    expect(history.filter((e) => machineKey(e) === machineKey(foreign))).toHaveLength(1)
    expect(history.find((e) => machineKey(e) === machineKey(foreign))).toEqual(foreign)
  })

  it('a manual first move (runAndPersistBenchmark, no history) keeps the old computer', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign })

    const fresh = await runAndPersistBenchmark(ctxWith(root, db))

    const s = getSettings(db)
    expect(s.lastBenchmark?.ranAt).toBe(fresh.ranAt)
    expect(s.benchmarkHistory.map((e) => e.cpuModel)).toEqual([fresh.cpuModel, foreign.cpuModel])
  })

  it('same machine: the startup branch seeds the history without a rerun', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: mine })
    const ctx = ctxWith(root, db)

    maybeRunFirstBenchmark(ctx)

    // Synchronous branch: seeded, headline untouched, and no benchmark span was taken.
    expect(getSettings(db).benchmarkHistory).toEqual([mine])
    expect(getSettings(db).lastBenchmark).toEqual(mine)
    expect(modelBusyLane(ctx)).toBeNull()
  })

  it('restore (A→B→A) brings back the NEWEST outgoing sample, the one that landed mid-run', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult({ effectiveRead: { ...foreignSample, modelId: 'before-run', mbps: 300 } })
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    const ctx = ctxWith(root, db)
    registerModelIpc(ctx)

    // On A: a model load lands while the benchmark runs.
    const ran = await runAndPersistBenchmark(ctx, (step) => {
      if (step === 'drive') loadSample('mid-run')
    })
    expect(ran.effectiveRead?.modelId).toBe('mid-run')
    // The drive goes to B (its run replaces the headline and files B).
    const b = result()
    updateSettings(db, { lastBenchmark: b, benchmarkHistory: upsertHistory(getSettings(db).benchmarkHistory, b) })
    expect(getSettings(db).lastBenchmark?.cpuModel).toBe(b.cpuModel)

    // …and back to A.
    maybeRunFirstBenchmark(ctx)

    const restored = getSettings(db).lastBenchmark
    expect(restored?.ranAt).toBe(ran.ranAt)
    expect(restored?.effectiveRead?.modelId).toBe('mid-run')
    expect(getSettings(db).benchmarkHistory).toHaveLength(2)
  })

  it('restore backfills a foreign outgoing headline that the history does not hold yet', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const known = hereResult()
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [known] })

    maybeRunFirstBenchmark(ctxWith(root, db))

    expect(getSettings(db).lastBenchmark).toEqual(known)
    expect(getSettings(db).benchmarkHistory.map((e) => e.cpuModel)).toEqual([foreign.cpuModel, known.cpuModel])
  })

  it('at capacity, a restore keeps the restored entry and evicts the oldest OTHER machine', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const others = Array.from({ length: MAX_BENCHMARK_HISTORY - 1 }, (_, i) =>
      result({ cpuModel: `other-${i + 1}`, ranAt: `2026-0${i + 1}-01T00:00:00Z` })
    )
    const known = hereResult({ ranAt: '2026-04-15T00:00:00Z' })
    // Newest first, this machine in the middle of the pack.
    const history = [...others, known].sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
    expect(history).toHaveLength(MAX_BENCHMARK_HISTORY)
    const outgoing = result({ cpuModel: 'outgoing', ranAt: '2026-08-01T00:00:00Z' })
    updateSettings(db, { lastBenchmark: outgoing, benchmarkHistory: history })

    maybeRunFirstBenchmark(ctxWith(root, db))

    const after = getSettings(db).benchmarkHistory
    expect(getSettings(db).lastBenchmark).toEqual(known)
    expect(after).toHaveLength(MAX_BENCHMARK_HISTORY)
    expect(after.some((e) => machineKey(e) === here())).toBe(true)
    expect(after.some((e) => e.cpuModel === 'outgoing')).toBe(true)
    expect(after.some((e) => e.cpuModel === 'other-1')).toBe(false)
    expect(after.map((e) => e.ranAt)).toEqual([...after.map((e) => e.ranAt)].sort().reverse())
  })

  it('at capacity, a run on a new machine keeps the outgoing computer and this one; the oldest others go', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const others = Array.from({ length: MAX_BENCHMARK_HISTORY }, (_, i) =>
      result({ cpuModel: `other-${i + 1}`, ranAt: `2026-0${i + 1}-01T00:00:00Z` })
    ).reverse()
    const outgoing = result({ cpuModel: 'outgoing', ranAt: '2026-09-01T00:00:00Z' })
    updateSettings(db, { lastBenchmark: outgoing, benchmarkHistory: others })

    await runAndPersistBenchmark(ctxWith(root, db))

    const after = getSettings(db).benchmarkHistory
    expect(after).toHaveLength(MAX_BENCHMARK_HISTORY)
    expect(machineKey(after[0])).toBe(here())
    expect(after[1].cpuModel).toBe('outgoing')
    expect(after.some((e) => e.cpuModel === 'other-1')).toBe(false)
    expect(after.some((e) => e.cpuModel === 'other-2')).toBe(false)
    expect(after.some((e) => e.cpuModel === 'other-3')).toBe(true)
  })

  it('the new-machine startup branch files the outgoing computer exactly once (seed + run, no duplicate)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result()
    updateSettings(db, { lastBenchmark: foreign })

    maybeRunFirstBenchmark(ctxWith(root, db))

    // Seeded synchronously, before the background run can replace the headline.
    expect(getSettings(db).benchmarkHistory).toEqual([foreign])
    await vi.waitFor(() => {
      expect(machineKey(getSettings(db).lastBenchmark)).toBe(here())
    })
    const history = getSettings(db).benchmarkHistory
    expect(history).toHaveLength(2)
    expect(history.filter((e) => machineKey(e) === machineKey(foreign))).toHaveLength(1)
  })
})

describe('a sample landing mid-run survives the persist (M6)', () => {
  it('at the drive step boundary — the result, the headline and the history carry it, with its warning', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult({ effectiveRead: { ...foreignSample, modelId: 'before-run', mbps: 300 } })
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    const ctx = ctxWith(root, db)
    registerModelIpc(ctx)
    let observedPersist = false

    const fresh = await runAndPersistBenchmark(ctx, (step) => {
      if (step === 'drive') {
        loadSample('mid-run', 50_000) // 60 MB/s: below the #110 gate
        observedPersist = getSettings(db).lastBenchmark?.effectiveRead?.modelId === 'mid-run'
      }
    })

    expect(observedPersist).toBe(true)
    expect(latestEffectiveRead()?.modelId).toBe('mid-run')
    expect(fresh.effectiveRead?.modelId).toBe('mid-run')
    expect(fresh.warnings).toContain(slowReadWarning(60))
    const s = getSettings(db)
    expect(s.lastBenchmark).toEqual(fresh)
    expect(s.benchmarkHistory).toHaveLength(1)
    expect(s.benchmarkHistory[0]).toEqual(fresh)
  })

  it('at the speed step boundary (a runtime is up, so the speed leg runs)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult({ effectiveRead: { ...foreignSample, modelId: 'before-run', mbps: 300 } })
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    const ctx = ctxWith(root, db, { runtime: { occupancy: new ModelOccupancy(), active: () => stubRuntime() } })
    registerModelIpc(ctx)
    const steps: BenchmarkProgressStep[] = []

    const fresh = await runAndPersistBenchmark(ctx, (step) => {
      steps.push(step)
      if (step === 'speed') loadSample('after-speed')
    })

    expect(steps).toEqual(['system', 'drive', 'speed', 'done'])
    expect(fresh.tokensPerSecond).toBe(20)
    expect(fresh.effectiveRead?.modelId).toBe('after-speed')
    expect(getSettings(db).lastBenchmark?.effectiveRead?.modelId).toBe('after-speed')
    expect(getSettings(db).benchmarkHistory[0].effectiveRead?.modelId).toBe('after-speed')
  })

  it('the returned result is the reconciled one that was persisted (ranAt from the run)', async () => {
    const root = freshRoot()
    const db = seededDb(root)
    updateSettings(db, { lastBenchmark: hereResult(), benchmarkHistory: [hereResult()] })
    const ctx = ctxWith(root, db)
    registerModelIpc(ctx)

    const fresh = await runAndPersistBenchmark(ctx, (step) => {
      if (step === 'drive') loadSample('mid-run')
    })

    expect(getSettings(db).lastBenchmark).toEqual(fresh)
    expect(fresh.ranAt).not.toBe(hereResult().ranAt)
  })
})

describe('the observer persists to every eligible destination (L2)', () => {
  it('updates both lastBenchmark and the matching history entry', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    registerModelIpc(ctxWith(root, db))

    loadSample('local-model')

    const s = getSettings(db)
    expect(s.lastBenchmark?.effectiveRead?.modelId).toBe('local-model')
    expect(s.benchmarkHistory[0].effectiveRead?.modelId).toBe('local-model')
    // A sample-only update is not a new run.
    expect(s.lastBenchmark?.ranAt).toBe(mine.ranAt)
    expect(s.benchmarkHistory[0].ranAt).toBe(mine.ranAt)
  })

  it('foreign lastBenchmark + local history: the history entry only, the foreign headline untouched', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result({ effectiveRead: foreignSample })
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign, mine] })
    registerModelIpc(ctxWith(root, db))

    loadSample('local-model')

    const s = getSettings(db)
    expect(s.lastBenchmark).toEqual(foreign)
    expect(s.benchmarkHistory.find((e) => machineKey(e) === here())?.effectiveRead?.modelId).toBe('local-model')
    expect(s.benchmarkHistory.find((e) => e.cpuModel === foreign.cpuModel)).toEqual(foreign)
  })

  it('repairs a stale history entry beside a headline that already carries the sample', () => {
    const root = freshRoot()
    const db = seededDb(root)
    loadSample('local-model') // no observer registered: latched only
    const sample = latestEffectiveRead()!
    updateSettings(db, {
      lastBenchmark: hereResult({ effectiveRead: sample }),
      benchmarkHistory: [hereResult()]
    })

    persistEffectiveRead(ctxWith(root, db))

    const s = getSettings(db)
    expect(s.benchmarkHistory[0].effectiveRead).toEqual(sample)
    expect(s.lastBenchmark?.effectiveRead).toEqual(sample)
  })

  it('a same-machine model_load destination keeps its sample against a session checksum', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const persisted: EffectiveReadSample = { ...foreignSample, modelId: 'persisted-load', mbps: 400 }
    const mine = hereResult({ effectiveRead: persisted })
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    registerModelIpc(ctxWith(root, db))

    recordChecksumRead(3_000_000_000, 30_000, 'session-checksum')

    const s = getSettings(db)
    expect(s.lastBenchmark?.effectiveRead?.modelId).toBe('persisted-load')
    expect(s.benchmarkHistory[0].effectiveRead?.modelId).toBe('persisted-load')
  })

  it('with no eligible destination nothing is written and the sample is NOT marked handled', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result({ effectiveRead: foreignSample })
    updateSettings(db, { lastBenchmark: foreign })
    const ctx = ctxWith(root, db)
    registerModelIpc(ctx)

    loadSample('local-model')
    expect(getSettings(db)).toMatchObject({ lastBenchmark: foreign, benchmarkHistory: [] })

    // A local entry appears later (a restore, an upgrade seed): the retry lands the sample.
    updateSettings(db, { benchmarkHistory: [foreign, hereResult()] })
    persistEffectiveRead(ctx)
    expect(getSettings(db).lastBenchmark).toEqual(foreign)
    expect(getSettings(db).benchmarkHistory[1].effectiveRead?.modelId).toBe('local-model')
  })

  it('retries after a failed write (the first INSERT throws) — the next call persists', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    const ctx = ctxWith(root, failingFirstWrite(db))
    registerModelIpc(ctx)

    loadSample('local-model') // observer-time write fails
    expect(getSettings(db).lastBenchmark?.effectiveRead).toBeNull()

    persistEffectiveRead(ctx) // the post-start/list/verify retry
    expect(getSettings(db).lastBenchmark?.effectiveRead?.modelId).toBe('local-model')
    expect(getSettings(db).benchmarkHistory[0].effectiveRead?.modelId).toBe('local-model')
  })

  it('retries after a deferred write (the workspace was locked at observer time)', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const mine = hereResult()
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    let locked = true
    const ctx = ctxWith(root, db)
    // The real context resolves `db` through the vault (`requireDb`), which throws while locked.
    Object.defineProperty(ctx, 'db', {
      get: () => {
        if (locked) throw new Error('Workspace is locked')
        return db
      }
    })
    registerModelIpc(ctx)

    loadSample('local-model')
    expect(getSettings(db).lastBenchmark?.effectiveRead).toBeNull()

    locked = false
    persistEffectiveRead(ctx)
    expect(getSettings(db).lastBenchmark?.effectiveRead?.modelId).toBe('local-model')
    expect(getSettings(db).benchmarkHistory[0].effectiveRead?.modelId).toBe('local-model')
  })

  it('the memo is scoped to the DB handle: a re-opened workspace re-evaluates the same sample', () => {
    const rootA = freshRoot()
    const dbA = seededDb(rootA)
    updateSettings(dbA, { lastBenchmark: hereResult() })
    registerModelIpc(ctxWith(rootA, dbA))
    loadSample('local-model')
    const sample = latestEffectiveRead()!
    expect(getSettings(dbA).lastBenchmark?.effectiveRead).toEqual(sample)

    // A second workspace (a lock/unlock yields a new handle) with a bare result of its own.
    const rootB = freshRoot()
    const dbB = seededDb(rootB)
    updateSettings(dbB, { lastBenchmark: hereResult(), benchmarkHistory: [hereResult()] })
    persistEffectiveRead(ctxWith(rootB, dbB))

    const s = getSettings(dbB)
    expect(s.lastBenchmark?.effectiveRead).toEqual(sample)
    expect(s.benchmarkHistory[0].effectiveRead).toEqual(sample)
  })
})

describe('unchanged #110: the slow-read warning tracks the eligible sample only', () => {
  it('a slow local sample re-keys the warning on both destinations; a fast one removes it', () => {
    const root = freshRoot()
    const db = seededDb(root)
    const tiny = t('en', 'main.benchmark.warnTiny')
    const mine = hereResult({ warnings: [tiny] })
    updateSettings(db, { lastBenchmark: mine, benchmarkHistory: [mine] })
    registerModelIpc(ctxWith(root, db))

    loadSample('slow', 50_000) // 60 MB/s
    let s = getSettings(db)
    expect(s.lastBenchmark?.warnings).toEqual([tiny, slowReadWarning(60)])
    expect(s.benchmarkHistory[0].warnings).toEqual([tiny, slowReadWarning(60)])

    loadSample('fast', 6_000) // 500 MB/s
    s = getSettings(db)
    expect(s.lastBenchmark?.warnings).toEqual([tiny])
    expect(s.benchmarkHistory[0].warnings).toEqual([tiny])
    expect(s.lastBenchmark?.ranAt).toBe(mine.ranAt)
  })

  it("a foreign result's warning is never carried into a new computer's run", async () => {
    const root = freshRoot()
    const db = seededDb(root)
    const foreign = result({ effectiveRead: foreignSample, warnings: [slowReadWarning(70)] })
    updateSettings(db, { lastBenchmark: foreign, benchmarkHistory: [foreign] })

    const fresh = await runAndPersistBenchmark(ctxWith(root, db))

    expect(hasSlowReadWarning(fresh.warnings)).toBe(false)
    // …while the foreign entry keeps its own, untouched.
    const kept = getSettings(db).benchmarkHistory.find((e) => e.cpuModel === foreign.cpuModel) as BenchmarkResult
    expect(kept.warnings).toEqual([slowReadWarning(70)])
  })
})
