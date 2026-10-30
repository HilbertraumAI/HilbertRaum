import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { join, parse } from 'node:path'
import type { Db } from '../../src/main/services/db'
import { initPerf } from '../../src/main/services/perf'
import {
  MIN_READ_SAMPLE_MS,
  latestEffectiveRead,
  latestEffectiveReadBySource,
  recordModelLoadRead,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'
import {
  beginChecksumInstrumentation,
  sha256File,
  verifyChecksum,
  computeInstallState,
  buildModelList,
  checksumCacheStats,
  createSettingsHashStore,
  invalidateChecksum,
  manifestFiles,
  primeChecksum,
  recommendModelId,
  recommendModelIdByRam,
  recommendModelIdByVram,
  recommendChatModelId,
  estimateGraphicsNeedMib,
  fitsGraphicsMemory,
  graphicsBudgetMib,
  weightsMib,
  SLOW_PICK_TOKENS_PER_SECOND,
  discoverManifests,
  findManifestById,
  launchContextTokens,
  selectModel,
  resolveManifestsDir,
  weightPath
} from '../../src/main/services/models'
import type { ModelManifest } from '../../src/shared/manifest'
import type { ModelVerifyProgress } from '../../src/shared/types'
import { openFreshDb, tempRoot } from '../helpers/db-fixtures'
import { until } from '../helpers/hang-budget'
import { manifestsDirWith, rawManifest, sha256, validManifest, writeDriveFile, writeManifest } from '../helpers/manifest-fixtures'

/** What every `buildModelList` call passes for the machine's RAM, as production always does. Never the host's. */
const PINNED_RAM_GB = 16

/** impl-H: not shared, a static settings import in db-fixtures would change what its other importers load. */
function seededFreshDb(label: string): Db {
  const db = openFreshDb(label)
  seedSettings(db)
  return db
}

const savedPerfEnv = process.env.HILBERTRAUM_PERF_LOG

afterEach(() => {
  if (savedPerfEnv === undefined) delete process.env.HILBERTRAUM_PERF_LOG
  else process.env.HILBERTRAUM_PERF_LOG = savedPerfEnv
  vi.useRealTimers()
})

/** Route the shared perf module at a fresh dir and return a reader for its log. */
function armPerfLog(): () => string[] {
  const dir = tempRoot('perf')
  process.env.HILBERTRAUM_PERF_LOG = '1'
  initPerf(dir)
  const file = join(dir, 'perf.log')
  return () => {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean)
  }
}

/** The parsed `checksum_done` marks: the read's own close, which lands AFTER a cancelled caller rejects. */
function doneMarks(readLog: () => string[]): Array<{ ok: boolean }> {
  return readLog()
    .filter((l) => l.includes(' checksum_done '))
    .map((l) => JSON.parse(l.slice(l.indexOf('{'))))
}

describe('checksum verification', () => {
  it('hashes a file and matches its own SHA-256', async () => {
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'hello world')
    const expected = sha256('hello world')

    expect(await sha256File(file)).toBe(expected)

    const ok = await verifyChecksum(file, expected)
    expect(ok).toEqual({ exists: true, matched: true, actual: expected })

    const bad = await verifyChecksum(file, 'f'.repeat(64))
    expect(bad.matched).toBe(false)
  })

  it('reports a missing file', async () => {
    const res = await verifyChecksum(join(tempRoot('hash'), 'nope.bin'), 'f'.repeat(64))
    expect(res).toEqual({ exists: false, matched: null, actual: null })
  })

  it('returns matched=null for a placeholder hash', async () => {
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'data')
    const res = await verifyChecksum(file, 'REPLACE_WITH_REAL_HASH')
    expect(res.matched).toBe(null)
    expect(res.exists).toBe(true)
  })
})

// H5 (audit round 4): listModels runs on every Models/Chat screen mount; without a cache
// every visit re-hashed every multi-GB GGUF on the drive (minutes of USB I/O per
// navigation). Hash once per (path, size, mtime); a changed file re-hashes.
describe('checksum cache (H5)', () => {
  it('hashes a file once and serves repeat verifications from the cache', async () => {
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'big model weights')
    const expected = sha256('big model weights')

    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)

    // Second + third verification: cache hit, no re-hash, same result.
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('re-hashes when the file changes, so a swapped weight is still detected', async () => {
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'original')
    const originalHash = sha256('original')
    expect((await verifyChecksum(file, originalHash)).matched).toBe(true)

    const before = checksumCacheStats.computed
    writeFileSync(file, 'tampered-or-updated') // different size → cache invalid
    const res = await verifyChecksum(file, originalHash)
    expect(res.matched).toBe(false)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })
})

// #106: every REAL multi-GB hash — wherever it runs — emits one `checksum_start`/
// `checksum_done` perf-mark pair + one app.log line, fired at the single choke point
// (`sha256FileCached`'s miss branch), never at the many cache traversals above it. And
// concurrent callers for the same path share ONE physical hash (single-flight): the
// unlock auto-start racing a Models-screen mount used to run two full media reads of
// the same weight.
describe('checksum instrumentation + single-flight (#106)', () => {
  const WEIGHT_BYTES = 6_000_000_000
  /** One instrumented hash whose elapsed just clears the SHIPPED sample floor (performance clock is fake in these rows). */
  function overFloor(file: 'download' | 'weight', path?: string | null): void {
    const instrumentation = beginChecksumInstrumentation({ modelId: 'm', file }, WEIGHT_BYTES, path)
    vi.advanceTimersByTime(MIN_READ_SAMPLE_MS + 1)
    instrumentation.end(true)
  }

  it('emits one mark pair (+ bytes, model label) on a real hash — and none on a cache hit', async () => {
    const readLog = armPerfLog()
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'instrumented weights')
    const expected = sha256('instrumented weights')

    expect(
      (
        await verifyChecksum(file, expected, undefined, undefined, {
          modelId: 'qwen3-4b-instruct-q4',
          file: 'weight'
        })
      ).matched
    ).toBe(true)

    const lines = readLog()
    const starts = lines.filter((l) => l.includes(' checksum_start '))
    const dones = lines.filter((l) => l.includes(' checksum_done '))
    expect(starts).toHaveLength(1)
    expect(dones).toHaveLength(1)
    const startFields = JSON.parse(starts[0].slice(starts[0].indexOf('{')))
    const doneFields = JSON.parse(dones[0].slice(dones[0].indexOf('{')))
    expect(startFields.modelId).toBe('qwen3-4b-instruct-q4')
    expect(startFields.file).toBe('weight')
    expect(startFields.bytes).toBe('instrumented weights'.length)
    expect(doneFields.seq).toBe(startFields.seq)
    expect(doneFields.ok).toBe(true)
    expect(typeof doneFields.ms).toBe('number')

    // A cache hit is NOT a hash: a second verification adds no marks.
    const fresh = armPerfLog()
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(fresh().filter((l) => l.includes('checksum_'))).toHaveLength(0)
  })

  it('a forced re-hash (invalidateChecksum, the "Verify checksum" button) fires the marks again', async () => {
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'reverify me')
    const expected = sha256('reverify me')
    expect((await verifyChecksum(file, expected)).matched).toBe(true)

    const readLog = armPerfLog()
    invalidateChecksum(file)
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(readLog().filter((l) => l.includes(' checksum_start '))).toHaveLength(1)
  })

  it('a failing hash still closes its pair (checksum_done ok:false) and caches nothing', async () => {
    const readLog = armPerfLog()
    // A directory passes the existsSync guard and stats fine, but the read stream
    // rejects (EISDIR) — a deterministic mid-hash failure on every platform.
    const dir = tempRoot('hash')
    const before = checksumCacheStats.computed

    await expect(verifyChecksum(dir, 'f'.repeat(64))).rejects.toThrow()

    expect(checksumCacheStats.computed).toBe(before) // a throwing hash increments nothing
    const dones = readLog().filter((l) => l.includes(' checksum_done '))
    expect(dones).toHaveLength(1)
    expect(JSON.parse(dones[0].slice(dones[0].indexOf('{'))).ok).toBe(false)
  })

  it('concurrent verifications of the same file share ONE physical hash (single-flight)', async () => {
    const readLog = armPerfLog()
    const dir = tempRoot('hash')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'shared single-flight weights')
    const expected = sha256('shared single-flight weights')

    const db = seededFreshDb('single-flight')
    const joinerStore = createSettingsHashStore(() => db, dir)
    const joinerProgress: number[] = []

    const before = checksumCacheStats.computed
    const [a, b] = await Promise.all([
      verifyChecksum(file, expected),
      verifyChecksum(file, expected, joinerStore, (n) => joinerProgress.push(n))
    ])

    expect(a.matched).toBe(true)
    expect(b.matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
    // One physical hash → exactly one mark pair.
    expect(readLog().filter((l) => l.includes(' checksum_start '))).toHaveLength(1)
    // The joiner's progress sink was multicast the final exact-total call…
    expect(joinerProgress.at(-1)).toBe('shared single-flight weights'.length)
    // …and the joiner's own L2 store was still populated — with the LEADER's entry
    // (leader-stat key + leader digest), so a file replaced mid-hash can never mint a
    // live-keyed entry whose hash was computed for different content.
    expect(joinerStore.get(file)?.actual).toBe(expected)
    expect(joinerStore.get(file)?.size).toBe('shared single-flight weights'.length)
  })

  it("a 'download' hash keeps its marks but never feeds the effective-read latch (page-cache-warm)", () => {
    resetEffectiveReadForTests()
    vi.useFakeTimers({ toFake: ['performance'] })
    const readLog = armPerfLog()
    // Elapsed past the floor, so the LABEL, not the floor, is what the download assertion proves.
    overFloor('download')
    expect(latestEffectiveRead()).toBeNull() // the app just WROTE those bytes (F-35 class)

    overFloor('weight')
    expect(latestEffectiveRead()?.source).toBe('checksum') // a cold-file hash samples

    // Both hashes were fully instrumented regardless.
    expect(readLog().filter((l) => l.includes(' checksum_done '))).toHaveLength(2)
  })

  it("a 'download' verify never adds its path to the #392 warmed set (the .part is renamed away)", () => {
    resetEffectiveReadForTests()
    vi.useFakeTimers({ toFake: ['performance'] })
    const weight = '/models/w.gguf'
    // Production's download verify also withholds the path (null). Handing it over here leaves the
    // label alone to keep the sample and the warmed set away.
    overFloor('download', weight)
    expect(latestEffectiveRead()).toBeNull()
    // A model started from that very path afterwards therefore still samples honestly.
    recordModelLoadRead(weight, 10_000, 'm', WEIGHT_BYTES)
    expect(latestEffectiveRead()?.source).toBe('model_load')
  })

  it('a real weight hash registers its path: the start that follows records no load sample (#392)', () => {
    resetEffectiveReadForTests()
    vi.useFakeTimers({ toFake: ['performance'] })
    const weight = '/models/w.gguf'
    overFloor('weight', weight)
    expect(latestEffectiveRead()?.source).toBe('checksum')

    recordModelLoadRead(weight, 10_000, 'm', WEIGHT_BYTES)
    expect(latestEffectiveRead()?.source).toBe('checksum') // the RAM figure never lands
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })
})

// Post-MVP: the in-memory cache dies with the session, so the FIRST Models/Chat visit
// after every app start still re-hashed multi-GB weights. The settings-backed store
// persists (path, size, mtime, sha256) inside the DB so an unchanged file is hashed
// once EVER; size/mtime changes and the explicit "Verify checksum" force a real re-hash.
describe('persistent checksum cache (settings hash store)', () => {
  function makeStore(): { store: ReturnType<typeof createSettingsHashStore>; db: Db; root: string } {
    const db = seededFreshDb('cache')
    const root = tempRoot('drive')
    return { store: createSettingsHashStore(() => db, root), db, root }
  }

  it('serves the hash from the DB after a simulated restart (no re-hash)', async () => {
    const { store, db, root } = makeStore()
    const file = join(root, 'weight.bin')
    writeFileSync(file, 'persisted weights')
    const expected = sha256('persisted weights')

    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
    expect(getSettings(db).checksumCache['weight.bin']?.sha256).toBe(expected)

    invalidateChecksum(file) // simulate an app restart (in-memory L1 gone, DB survives)
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1) // served from the store
  })

  it('re-hashes when the file content/size changed since the persisted entry', async () => {
    const { store, root } = makeStore()
    const file = join(root, 'weight.bin')
    writeFileSync(file, 'original')
    const originalHash = sha256('original')
    expect((await verifyChecksum(file, originalHash, store)).matched).toBe(true)

    invalidateChecksum(file)
    writeFileSync(file, 'replaced with another model') // different size → entry invalid
    const before = checksumCacheStats.computed
    const res = await verifyChecksum(file, originalHash, store)
    expect(res.matched).toBe(false)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('invalidateChecksum drops memory + store so the next verify truly re-hashes', async () => {
    const { store, db, root } = makeStore()
    const file = join(root, 'weight.bin')
    writeFileSync(file, 'weights')
    const expected = sha256('weights')
    await verifyChecksum(file, expected, store)
    expect(getSettings(db).checksumCache['weight.bin']).toBeDefined()

    invalidateChecksum(file, store)
    expect(getSettings(db).checksumCache['weight.bin']).toBeUndefined()
    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('get degrades on a corrupted `checksumCache: null` row and the next set self-repairs it (BE-1)', () => {
    const { store, db, root } = makeStore()
    const weight = join(root, 'weight.gguf')
    // A row corrupted BEFORE the write gate rejected null (full-audit 2026-07-10 BE-1):
    // updateSettings drops `{ checksumCache: null }` now, so plant it directly via SQL.
    db.prepare(`UPDATE settings SET value_json = 'null' WHERE key = 'checksumCache'`).run()
    expect(getSettings(db).checksumCache).toBeNull() // the corruption really is in place
    // Read-side belt: degrade to "no cache" instead of throwing out of every checksum reader.
    expect(store.get(weight)).toBeNull()
    // set() writes a healthy object over the corrupted row.
    store.set(weight, { size: 3, mtimeMs: 4, actual: 'feed' })
    expect(getSettings(db).checksumCache['weight.gguf']?.sha256).toBe('feed')
  })

  it('degrades to the in-memory fallback on a CLOSED DB — never throws into the caller (BE-2)', () => {
    // A workspace lock closes the settings DB while a multi-hour download still runs; the
    // store must keep serving (cache is an optimization), not throw "database is not open".
    const { store, db } = makeStore()
    db.close()
    expect(() => store.set('/w.gguf', { size: 1, mtimeMs: 2, actual: 'abcd' })).not.toThrow()
    expect(store.get('/w.gguf')).toEqual({ size: 1, mtimeMs: 2, actual: 'abcd' }) // the fallback serves it
    expect(() => store.delete('/w.gguf')).not.toThrow()
    expect(store.get('/w.gguf')).toBeNull()
  })

  it('resolves the LIVE handle per call — a DB swapped between calls is used, never the stale one (BE-2)', () => {
    // The lock/unlock cycle REPLACES the DB handle (`ctx.db` is a getter); a store created at
    // IPC registration must follow it instead of pinning the handle it saw at construction.
    const db1 = seededFreshDb('cache1')
    let current = db1
    const root = tempRoot('drive')
    const store = createSettingsHashStore(() => current, root)
    store.set(join(root, 'a.gguf'), { size: 1, mtimeMs: 2, actual: 'aaaa' })
    expect(getSettings(db1).checksumCache['a.gguf']?.sha256).toBe('aaaa')

    db1.close() // lock…
    const db2 = seededFreshDb('cache2')
    current = db2 // …unlock hands out a fresh handle

    store.set(join(root, 'b.gguf'), { size: 3, mtimeMs: 4, actual: 'bbbb' })
    expect(getSettings(db2).checksumCache['b.gguf']?.sha256).toBe('bbbb') // wrote via the LIVE handle
    expect(store.get(join(root, 'b.gguf'))).toEqual({ size: 3, mtimeMs: 4, actual: 'bbbb' })
  })

  // CODE-15 (full-audit 2026-07-11): keyed by drive-RELATIVE path so moving the drive between
  // machines (a new drive letter / mount point) re-hashes nothing — the flagship scenario that
  // an absolute key forced a full multi-GB re-hash for, plus permanent orphan entries.
  it('primes under drive root A and rebuilds under root B with ZERO re-hashes (drive-letter move)', async () => {
    const db = seededFreshDb('cache')

    // "Mount A" — the drive as first seen (e.g. E:\). Same physical file, same relative path.
    const rootA = tempRoot('driveA')
    const expected = writeDriveFile(rootA, 'models/chat/w.bin', 'drive-move weights')
    const fileA = join(rootA, 'models', 'chat', 'w.bin')
    // A real drive move keeps the file's size AND mtime; pin both files to one fixed clean-ms
    // timestamp so the (size, mtime) validity check matches exactly across the two mounts (raw
    // statSync mtimeMs carries sub-ms precision an utimes copy would truncate).
    const fixed = new Date('2026-07-01T00:00:00.000Z')
    utimesSync(fileA, fixed, fixed)
    const storeA = createSettingsHashStore(() => db, rootA)
    expect((await verifyChecksum(fileA, expected, storeA)).matched).toBe(true)
    // Keyed relatively, not by the absolute mount-A path.
    expect(getSettings(db).checksumCache['models/chat/w.bin']?.sha256).toBe(expected)
    expect(getSettings(db).checksumCache[fileA]).toBeUndefined()

    // Replug on another machine: the settings DB travels with the drive (reused `db`); the same
    // physical file now sits under a different mount root, size+mtime preserved by the filesystem.
    const rootB = tempRoot('driveB')
    writeDriveFile(rootB, 'models/chat/w.bin', 'drive-move weights')
    const fileB = join(rootB, 'models', 'chat', 'w.bin')
    utimesSync(fileB, fixed, fixed)

    const before = checksumCacheStats.computed
    const storeB = createSettingsHashStore(() => db, rootB)
    expect((await verifyChecksum(fileB, expected, storeB)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before) // served from the relative-keyed entry — no re-hash
  })

  it('lazily migrates a legacy ABSOLUTE-key entry to the relative key on read (drops the orphan)', () => {
    const db = seededFreshDb('cache')
    const root = tempRoot('drive')
    const abs = join(root, 'models', 'chat', 'legacy.bin')
    // Pre-migration code keyed by the absolute path — plant such an entry.
    updateSettings(db, { checksumCache: { [abs]: { size: 5, mtimeMs: 6, sha256: 'legacyhash' } } })

    const store = createSettingsHashStore(() => db, root)
    // A read under the absolute path resolves to the relative key, misses, adopts the legacy entry.
    expect(store.get(abs)).toEqual({ size: 5, mtimeMs: 6, actual: 'legacyhash' })
    const cache = getSettings(db).checksumCache
    expect(cache['models/chat/legacy.bin']?.sha256).toBe('legacyhash') // rewritten under the relative key
    expect(cache[abs]).toBeUndefined() // absolute orphan cleaned up
  })
})

describe('weightPath', () => {
  it('resolves a normal relative local_path under the drive root', () => {
    const p = weightPath('/drive', validManifest())
    expect(p).toBe(join('/drive', 'models/chat/qwen3-4b-instruct-q4.gguf'))
  })

  it('rejects a local_path that escapes the drive root', () => {
    // weightPath keeps its OWN runtime escape guard (defense in depth). validateManifest now
    // rejects such a path up front (vuln-scan 2026-06-21), so build the manifest object
    // directly to exercise weightPath's independent guard rather than the validation layer.
    const escaping: ModelManifest = { ...validManifest(), localPath: '../../etc/passwd' }
    expect(() => weightPath('/drive', escaping)).toThrow(/escapes the drive root/)
  })

  it('accepts a bare drive/filesystem root that already ends in a separator', () => {
    // A portable drive is launched from a bare root (e.g. `D:\`). resolve() keeps the
    // trailing separator there, so a naive `base + sep` containment check would double it
    // (`D:\\`) and wrongly reject every weight. Regression for the D:\ launch bug.
    const root = parse(process.cwd()).root // `C:\` on Windows, `/` on POSIX
    expect(() => weightPath(root, validManifest())).not.toThrow()
    expect(weightPath(root, validManifest())).toBe(join(root, 'models/chat/qwen3-4b-instruct-q4.gguf'))
  })
})

describe('computeInstallState', () => {
  function rootWithWeight(content: string): string {
    const root = tempRoot('root')
    writeDriveFile(root, 'models/chat/qwen3-4b-instruct-q4.gguf', content)
    return root
  }

  // TG-1: install state is role-agnostic. A single-file `translation` GGUF is present + verified ⇒ installed, exactly like a
  // chat weight; these rows guard the claim that discovery and install state need no per-role code.
  const BY_ROLE: Array<[string, Record<string, unknown>]> = [
    ['chat', {}],
    ['translation', { id: 'translategemma-12b-it-q4', role: 'translation', family: 'translategemma', license: 'gemma', local_path: 'models/translation/tg.gguf' }]
  ]

  it.each(BY_ROLE)('is missing when the weight file is absent (%s)', async (_role, fields) => {
    const root = tempRoot('root')
    for (const developerMode of [true, false]) {
      expect(await computeInstallState(validManifest(fields), root, { developerMode })).toBe('missing')
    }
  })

  it.each(BY_ROLE)('is installed when present and the hash matches (%s)', async (_role, fields) => {
    const root = tempRoot('root')
    const hash = writeDriveFile(root, validManifest(fields).localPath, 'weights')
    const state = await computeInstallState(validManifest({ ...fields, sha256: hash }), root, { developerMode: false })
    expect(state).toBe('installed')
  })

  it('is checksum_failed when the hash mismatches', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(validManifest({ sha256: 'a'.repeat(64) }), root, {
      developerMode: false
    })
    expect(state).toBe('checksum_failed')
  })

  it('treats a placeholder hash as installed in developer mode', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(validManifest(), root, { developerMode: true })
    expect(state).toBe('installed')
  })

  it('treats a placeholder hash as checksum_failed outside developer mode', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(validManifest(), root, { developerMode: false })
    expect(state).toBe('checksum_failed')
  })

  it('never hashes a placeholder-hash weight (H5: pure wasted I/O on a multi-GB file)', async () => {
    const root = rootWithWeight('weights')
    const before = checksumCacheStats.computed
    await computeInstallState(validManifest(), root, { developerMode: true })
    await computeInstallState(validManifest(), root, { developerMode: false })
    expect(checksumCacheStats.computed).toBe(before)
  })

  it('is unsupported for an unknown runtime/format', async () => {
    const root = tempRoot('root')
    const state = await computeInstallState(validManifest({ runtime: 'onnx' }), root, {
      developerMode: true
    })
    expect(state).toBe('unsupported')
  })

  // Phase 36 fix: the support gate is a runtime↔format PAIR check. The whisper
  // transcriber (whisper_cpp + ggml) is supported — it used to fall through the
  // llama-only whitelist and show "Unsupported" on the AI Model screen, which also
  // hid its in-app download (the download offer requires state 'missing').
  it('supports the whisper transcriber pair (whisper_cpp + ggml)', async () => {
    const root = tempRoot('root')
    const whisper = validManifest({
      id: 'whisper-small-multilingual',
      role: 'transcriber',
      runtime: 'whisper_cpp',
      format: 'ggml',
      local_path: 'models/transcriber/ggml-small.bin'
    })
    // Absent weights → 'missing' (downloadable), NOT 'unsupported'.
    expect(await computeInstallState(whisper, root, { developerMode: false })).toBe('missing')

    // Present + matching hash → installed.
    const hash = writeDriveFile(root, 'models/transcriber/ggml-small.bin', 'ggml-weights')
    const verified = validManifest({
      id: 'whisper-small-multilingual',
      role: 'transcriber',
      runtime: 'whisper_cpp',
      format: 'ggml',
      local_path: 'models/transcriber/ggml-small.bin',
      sha256: hash
    })
    expect(await computeInstallState(verified, root, { developerMode: false })).toBe('installed')
  })

  it('rejects MISMATCHED runtime/format pairs (never a silent pass)', async () => {
    const root = tempRoot('root')
    const cases = [
      { runtime: 'whisper_cpp', format: 'gguf' },
      { runtime: 'llama_cpp', format: 'ggml' }
    ]
    for (const c of cases) {
      expect(
        await computeInstallState(validManifest(c), root, { developerMode: true }),
        `${c.runtime}+${c.format}`
      ).toBe('unsupported')
    }
  })
})

// Image-understanding plan §8.2: a vision model is TWO files (GGUF + mmproj); install state
// requires BOTH present + verified.
describe('computeInstallState — vision (both files verified)', () => {
  function visionManifest(overrides: Record<string, unknown> = {}): ModelManifest {
    return validManifest({
      id: 'qwen2.5-vl-3b-instruct-q4',
      role: 'vision',
      family: 'qwen2.5-vl',
      local_path: 'models/vision/vl.gguf',
      mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'REPLACE_WITH_REAL_HASH' },
      ...overrides
    })
  }

  it('is missing when the GGUF is present but the mmproj is absent', async () => {
    const root = tempRoot('vision')
    writeDriveFile(root, 'models/vision/vl.gguf', 'lm')
    expect(await computeInstallState(visionManifest(), root, { developerMode: true })).toBe('missing')
  })

  it('is installed (dev) when both files are present with placeholder hashes', async () => {
    const root = tempRoot('vision')
    writeDriveFile(root, 'models/vision/vl.gguf', 'lm')
    writeDriveFile(root, 'models/vision/mmproj.gguf', 'proj')
    expect(await computeInstallState(visionManifest(), root, { developerMode: true })).toBe('installed')
  })

  it('is installed when both files are present and BOTH hashes match', async () => {
    const root = tempRoot('vision')
    writeDriveFile(root, 'models/vision/vl.gguf', 'lm-bytes')
    writeDriveFile(root, 'models/vision/mmproj.gguf', 'proj-bytes')
    const m = visionManifest({
      sha256: sha256('lm-bytes'),
      mmproj: {
        local_path: 'models/vision/mmproj.gguf',
        sha256: sha256('proj-bytes')
      }
    })
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('installed')
  })

  it('is checksum_failed when the mmproj hash does NOT match (the GGUF is fine)', async () => {
    const root = tempRoot('vision')
    writeDriveFile(root, 'models/vision/vl.gguf', 'lm-bytes')
    writeDriveFile(root, 'models/vision/mmproj.gguf', 'proj-bytes')
    const m = visionManifest({
      sha256: sha256('lm-bytes'),
      mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'a'.repeat(64) }
    })
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('checksum_failed')
  })
})

// #310: a weight that ships as a `-00001-of-00004` shard set is FOUR files. The manifest's
// `files:` list declares shards 2-4 with their own hashes, and every state below is decided
// over the whole set — the issue's three reproduction probes, converted.
describe('#310 multi-file install state (shard set)', () => {
  const shardPath = (n: number): string => `models/chat/flash-${String(n).padStart(5, '0')}-of-00004.gguf`

  function shardManifest(shas: [string, string, string, string]): ModelManifest {
    return validManifest({
      id: 'sharded-chat',
      local_path: shardPath(1),
      sha256: shas[0],
      files: [2, 3, 4].map((n, i) => ({ local_path: shardPath(n), sha256: shas[i + 1] }))
    })
  }
  const writeShard = (root: string, n: number, content: string): string => writeDriveFile(root, shardPath(n), content)
  const bytes = (n: number): string => `shard-${n}-bytes`
  const realHashes = (): [string, string, string, string] =>
    [1, 2, 3, 4].map((n) => sha256(bytes(n))) as [
      string,
      string,
      string,
      string
    ]

  it('enumerates every required shard, not just the first (issue probe 1)', () => {
    const files = manifestFiles('C:/drive', shardManifest(realHashes()))
    expect(files.map((f) => f.localPath)).toEqual([1, 2, 3, 4].map(shardPath))
    expect(files.map((f) => f.kind)).toEqual(['weight', 'extra', 'extra', 'extra'])
  })

  it('refuses installed when only the VERIFIED first shard exists (issue probe 2)', async () => {
    const root = tempRoot('shard')
    const h = writeShard(root, 1, bytes(1))
    // The real checksum-cache seam: shard 1 is already known-good, so only the siblings' absence
    // can produce the honest answer.
    primeChecksum(join(root, ...shardPath(1).split('/')), h)
    const m = shardManifest(realHashes())
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('missing')
  })

  it('refuses installed when the sibling shards are CORRUPT (issue probe 3)', async () => {
    const root = tempRoot('shard')
    const h = writeShard(root, 1, bytes(1))
    primeChecksum(join(root, ...shardPath(1).split('/')), h)
    for (const n of [2, 3, 4]) writeShard(root, n, 'corrupt sibling bytes')
    const m = shardManifest(realHashes())
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('checksum_failed')
  })

  it('accepts the complete, matching set (criterion 4)', async () => {
    const root = tempRoot('shard')
    for (const n of [1, 2, 3, 4]) writeShard(root, n, bytes(n))
    expect(await computeInstallState(shardManifest(realHashes()), root, { developerMode: false })).toBe(
      'installed'
    )
  })

  it('counts EVERY shard in the verification byte denominator', async () => {
    const root = tempRoot('shard')
    for (const n of [1, 2, 3, 4]) writeShard(root, n, bytes(n))
    const shas = realHashes()
    const dir = manifestsDirWith(
      rawManifest({
        id: 'sharded-chat',
        local_path: shardPath(1),
        sha256: shas[0],
        files: [2, 3, 4].map((n, i) => ({ local_path: shardPath(n), sha256: shas[i + 1] }))
      })
    )
    const events: ModelVerifyProgress[] = []
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      onProgress: (p) => events.push(p)
    })
    expect(models[0].state).toBe('installed')
    const total = [1, 2, 3, 4].reduce((sum, n) => sum + Buffer.byteLength(bytes(n)), 0)
    expect(events.every((e) => e.overallBytesTotal === total)).toBe(true)
    expect(events.at(-1)!.overallBytesHashed).toBe(total)
  })

  // RT-3: the lazy path may answer from the cache only when EVERY file has a hit — a cached
  // shard 1 next to three un-hashed siblings must not decide the model's state.
  it('skipHash answers from the cache only when ALL shards are cached', async () => {
    const root = tempRoot('shard')
    const shas = realHashes()
    for (const n of [1, 2, 3, 4]) writeShard(root, n, bytes(n))
    const abs = (n: number): string => join(root, ...shardPath(n).split('/'))
    const m = shardManifest(shas)

    // Only shard 1 cached ⇒ display-only 'installed', nothing hashed.
    primeChecksum(abs(1), shas[0])
    let before = checksumCacheStats.computed
    expect(await computeInstallState(m, root, { developerMode: false, skipHash: true })).toBe('installed')
    expect(checksumCacheStats.computed).toBe(before)

    // All four cached, and shard 3's cached hash does NOT match ⇒ honest checksum_failed,
    // still without hashing anything.
    primeChecksum(abs(1), shas[0])
    primeChecksum(abs(2), shas[1])
    primeChecksum(abs(3), 'a'.repeat(64))
    primeChecksum(abs(4), shas[3])
    before = checksumCacheStats.computed
    expect(await computeInstallState(m, root, { developerMode: false, skipHash: true })).toBe(
      'checksum_failed'
    )
    expect(checksumCacheStats.computed).toBe(before)
  })

  it('treats a placeholder hash on a SIBLING the same as one on the primary', async () => {
    const root = tempRoot('shard')
    for (const n of [1, 2, 3, 4]) writeShard(root, n, bytes(n))
    const shas = realHashes()
    const m = shardManifest([shas[0], 'REPLACE_WITH_REAL_HASH', shas[2], shas[3]])
    expect(await computeInstallState(m, root, { developerMode: true })).toBe('installed')
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('checksum_failed')
  })
})

describe('recommendModelId', () => {
  const tiny = validManifest({ id: 'tiny', recommended_profiles: ['TINY', 'UNKNOWN'] })
  const lite = validManifest({ id: 'lite', recommended_profiles: ['LITE'] })
  const embed = validManifest({
    id: 'embed',
    role: 'embeddings',
    recommended_profiles: ['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN']
  })
  const all = [tiny, lite, embed]

  it('maps LITE to the 4B chat model', () => {
    expect(recommendModelId(all, 'LITE', 'chat')).toBe('lite')
  })
  it('maps TINY and UNKNOWN to the small model', () => {
    expect(recommendModelId(all, 'TINY', 'chat')).toBe('tiny')
    expect(recommendModelId(all, 'UNKNOWN', 'chat')).toBe('tiny')
  })
  it('recommends embeddings independently of chat', () => {
    expect(recommendModelId(all, 'LITE', 'embeddings')).toBe('embed')
  })
  it('returns null when nothing matches', () => {
    expect(recommendModelId(all, 'BALANCED', 'chat')).toBe(null)
  })
})

// §6.6 RULE C (PR #308 audit, 2026-09-06; decisions 1, 2, 7, 10, 11): on a discrete card the
// established RAM pick stands wherever it FITS THE CARD's budget (weights + 15 % working buffers
// + the model's context cache + the fit's 1 GiB margin, all in raw MiB); where it does not, the
// highest-RANKED eligible model (ties by tier, then size) takes over; where nothing is eligible
// the RAM pick stands as the documented partial-offload fallback. RAM stays a hard gate, and the
// §6.5 step-down is confined to the eligible pool on both ends (R1/R2).
describe('recommendModelIdByVram / recommendChatModelId (§6.6 rule C)', () => {
  const tiny = validManifest({ id: 'tiny', size_on_disk_gb: 2.9, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 3 })
  const small12 = validManifest({ id: 'small12', size_on_disk_gb: 3.3, recommended_min_ram_gb: 8, recommended_ram_gb: 12, recommendation_rank: 3 })
  const mid = validManifest({ id: 'mid', size_on_disk_gb: 6.0, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 3 })
  const g12 = validManifest({ id: 'g12', size_on_disk_gb: 7.0, recommended_min_ram_gb: 14, recommended_ram_gb: 24, recommendation_rank: 2 })
  const big = validManifest({ id: 'big', size_on_disk_gb: 19.8, recommended_min_ram_gb: 23, recommended_ram_gb: 32, recommendation_rank: 3 })
  const huge = validManifest({ id: 'huge', size_on_disk_gb: 22.2, recommended_min_ram_gb: 24, recommended_ram_gb: 32, recommendation_rank: 1 })
  const all = [tiny, mid, big, huge]
  const slowOn = (id: string) => ({ tokensPerSecond: SLOW_PICK_TOKENS_PER_SECOND - 1, measuredModelId: id })

  it('estimateGraphicsNeedMib: OFFLOADABLE weights MiB × 1.15 + the cache term × 1024 + the 1,024 MiB margin', () => {
    // 6.0 decimal GB = 5,722.0 MiB of weights; with the 0.5 GiB default cache: 8,116.3 MiB.
    expect(weightsMib(mid)).toBeCloseTo(5722.0, 0)
    expect(estimateGraphicsNeedMib(mid)).toBeCloseTo(8116.3, 0)
    expect(fitsGraphicsMemory(mid, 8117)).toBe(true)
    expect(fitsGraphicsMemory(mid, 8116)).toBe(false)
    // 19.8 GB → 18,882.8 MiB; 23,251.2 MiB with the default cache (the rig's 22.7 GiB).
    expect(estimateGraphicsNeedMib(big)).toBeCloseTo(23251.2, 0)
    expect(fitsGraphicsMemory(big, 24 * 1024)).toBe(true)
    expect(fitsGraphicsMemory(big, 23_000)).toBe(false)
    // Decision 11: a manifest's own cache figure replaces the 0.5 GiB default — 0.4 GiB on the
    // 9B-shaped model reads 8,013.9; 1.1 GiB on the 27B-shaped one reads 23,865.6.
    // §5 item 22 (e): a measured host-mapped share leaves BOTH the base and the 15 % term. The
    // 9B's real figures — 6.0 GB with 545.62 MiB host-mapped and a 0.3 GiB cache — read 7,284.3,
    // against 8,116.3 for the same weights with no field at all.
    const hostMapped = validManifest({
      id: 'hostMapped',
      size_on_disk_gb: 6.0,
      estimated_context_cache_gib: 0.3,
      host_mapped_weights_mib: 545.62
    })
    expect(estimateGraphicsNeedMib(hostMapped)).toBeCloseTo((5722.045 - 545.62) * 1.15 + 0.3 * 1024 + 1024, 1)
    // Clamped, never negative: a figure at or above the weights leaves the cache + margin alone.
    const silly = validManifest({ id: 'silly', size_on_disk_gb: 6.0, host_mapped_weights_mib: 99_999 })
    expect(estimateGraphicsNeedMib(silly)).toBeCloseTo(0.5 * 1024 + 1024, 6)
    const mid04 = validManifest({ id: 'mid04', size_on_disk_gb: 6.0, estimated_context_cache_gib: 0.4 })
    const big11 = validManifest({ id: 'big11', size_on_disk_gb: 19.8, estimated_context_cache_gib: 1.1 })
    expect(estimateGraphicsNeedMib(mid04)).toBeCloseTo(8013.9, 0)
    expect(estimateGraphicsNeedMib(big11)).toBeCloseTo(23865.6, 0)
    // A zero cache figure is honoured (not treated as absent).
    const zero = validManifest({ id: 'zero', size_on_disk_gb: 6.0, estimated_context_cache_gib: 0 })
    expect(estimateGraphicsNeedMib(zero)).toBeCloseTo(8116.3 - 512, 0)
  })

  it('graphicsBudgetMib (decision 10): the probe\'s free figure, else total − 1,024; null with no device', () => {
    expect(graphicsBudgetMib({ totalMb: 8273, freeMb: 7504 })).toBe(7504)
    expect(graphicsBudgetMib({ totalMb: 8273 } as { totalMb: number; freeMb: number })).toBe(7249)
    expect(graphicsBudgetMib({ totalMb: 8273, freeMb: Number.NaN })).toBe(7249)
    expect(graphicsBudgetMib(null)).toBeNull()
    expect(graphicsBudgetMib(undefined)).toBeNull()
  })

  it('the RAM pick stands wherever the card can hold it (rule C step 2, the established recommendation wins)', () => {
    // RAM 64 → base = big (rank 3 beats huge's rank 1 in the 32 tier); it fits 24,000 MiB.
    expect(recommendModelIdByRam(all, 64)).toBe('big')
    expect(recommendModelIdByVram(all, 24_000, 64)).toBe('big')
    // RAM 24 in a catalog whose 24 tier is g12 (rank 2): g12 is the RAM pick and it fits a 12 GiB
    // budget (9,213 MiB) — so it STAYS, though a rank-3 mid also fits (decision 2 applies only
    // where the RAM pick does not fit).
    const withG12 = [...all, g12]
    expect(recommendModelIdByRam(withG12, 24)).toBe('g12')
    expect(recommendModelIdByVram(withG12, 12_288, 24)).toBe('g12')
  })

  it('where the RAM pick does not fit, the fallback is RANK-first, then tier, then size (not the RAM picker\'s tier-first)', () => {
    // RAM 32 → base = big (23,251 MiB) does not fit 12,288: the eligible pool is g12 (rank 2,
    // tier 24), mid (rank 3, tier 16), tiny (rank 3, tier 16) → rank first → mid over g12,
    // then size breaks the mid/tiny tie.
    const withG12 = [...all, g12]
    expect(recommendModelIdByVram(withG12, 12_288, 32)).toBe('mid')
    expect(recommendModelIdByVram(all, 23_000, 64)).toBe('mid')
    expect(recommendModelIdByVram(all, 8_000, 64)).toBe('tiny') // mid needs 8,116
    // STRICTLY ranked (owner decision 2026-09-06, #326): a rank-0 model is never the automatic pick,
    // so when no ranked model fits the no-fit fallback wins — the RAM pick (big at RAM 64), which
    // partially offloads — never the rank-0 model that would fit.
    const rank0 = validManifest({ id: 'rank0', size_on_disk_gb: 1.3, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 0 })
    expect(recommendModelIdByVram([...all, rank0], 8_000, 64)).toBe('tiny')
    expect(recommendModelIdByVram([...all, rank0], 4_000, 64)).toBe(recommendModelIdByRam(all, 64))
    expect(recommendModelIdByVram([...all, rank0], 4_000, 64)).toBe('big')
  })

  it('RAM stays a hard gate: never a model the Models screen would refuse to start', () => {
    // A 24 GiB budget in a 16 GB box: big needs 23 GB RAM minimum → the RAM pick mid stands.
    expect(recommendModelIdByVram(all, 24_000, 16)).toBe('mid')
    // …and the fallback pool honours the floor too: RAM 12, budget 24,000 → base = small12
    // (the 12 tier) fits → stands; mid (min 12) would be admissible but is not the RAM pick.
    expect(recommendModelIdByVram([...all, small12], 24_000, 12)).toBe('small12')
  })

  it('unknown RAM keeps the floor open (the pre-rule-C card-path semantics): the best fitting model by rank', () => {
    for (const ram of [Number.NaN, 0, -1]) {
      expect(recommendModelIdByVram(all, 24_000, ram), `ram=${ram}`).toBe('big')
      expect(recommendModelIdByVram(all, 8_000, ram), `ram=${ram}`).toBe('tiny')
      expect(recommendModelIdByVram(all, 4_000, ram), `ram=${ram}`).toBeNull()
    }
  })

  it('nothing eligible → the RAM pick stands as the documented no-fit fallback, and never steps', () => {
    expect(recommendModelIdByVram(all, 4_000, 64)).toBe(recommendModelIdByRam(all, 64))
    expect(recommendModelIdByVram(all, 4_000, 64, 'chat', slowOn('big'))).toBe('big')
    const onlyBig = [big, huge]
    expect(recommendModelIdByVram(onlyBig, 8_000, 64)).toBe(recommendModelIdByRam(onlyBig, 64))
    // An unknown / non-positive budget is the RAM path outright (with the signal, as before).
    expect(recommendModelIdByVram(all, Number.NaN, 64)).toBe(recommendModelIdByRam(all, 64))
    expect(recommendModelIdByVram(all, 0, 64, 'chat', slowOn('big'))).toBe(recommendModelIdByRam(all, 64, 'chat', slowOn('big')))
  })

  it('§6.5 step-down applies ONCE to the candidate, within the eligible pool on both ends (R1/R2)', () => {
    // A right-sized crawl on the eligible candidate steps to the next eligible ranked tier.
    expect(recommendModelIdByVram(all, 24_000, 64, 'chat', slowOn('big'))).toBe('mid')
    // R2: a crawl on a model the card CANNOT hold (huge, 25,883 MiB) says nothing → keep.
    expect(recommendModelIdByVram(all, 24_000, 64, 'chat', slowOn('huge'))).toBe('big')
    // R2 again: candidate is the fallback mid; the crawl was on big (not eligible) → keep.
    expect(recommendModelIdByVram(all, 23_000, 64, 'chat', slowOn('big'))).toBe('mid')
    // R1: the destination must be eligible. Budget 5,000: tiny (4,717) is the candidate; the
    // lower tier small12 needs 5,155 → not eligible → keep tiny (pre-rule-C code stepped there).
    const withSmall = [...all, small12]
    expect(recommendModelIdByVram(withSmall, 5_000, 64)).toBe('tiny')
    expect(recommendModelIdByVram(withSmall, 5_000, 64, 'chat', slowOn('tiny'))).toBe('tiny')
    expect(recommendModelIdByVram(withSmall, 5_200, 64, 'chat', slowOn('tiny'))).toBe('small12')
    // R1 (RAM side): RAM 20 → base mid; a crawl on big (oversized for the pick's tier) → keep.
    expect(recommendModelIdByVram(all, 24_000, 20, 'chat', slowOn('big'))).toBe('mid')
  })

  it('recommendChatModelId dispatches: discrete + budget → rule C; unified / cpu / unknown budget → RAM, byte-identical', () => {
    expect(recommendChatModelId(all, { memoryClass: 'discrete', ramGb: 64, budgetMb: 8 * 1024 })).toBe('mid')
    expect(recommendChatModelId(all, { memoryClass: 'discrete', ramGb: 64, budgetMb: 8_000 })).toBe('tiny')
    // Known budget on the other classes is ignored — the RAM pick, exactly as with none.
    for (const budgetMb of [24 * 1024, 8_000, null]) {
      expect(recommendChatModelId(all, { memoryClass: 'unified', ramGb: 64, budgetMb }), `unified ${budgetMb}`).toBe('big')
      expect(recommendChatModelId(all, { memoryClass: 'cpu', ramGb: 64, budgetMb }), `cpu ${budgetMb}`).toBe('big')
      expect(recommendChatModelId(all, { memoryClass: 'cpu', ramGb: 64, budgetMb }, slowOn('big')), `cpu slow ${budgetMb}`).toBe(
        recommendModelIdByRam(all, 64, 'chat', slowOn('big'))
      )
    }
    expect(recommendChatModelId(all, { memoryClass: 'discrete', ramGb: 64, budgetMb: null })).toBe('big')
    expect(recommendChatModelId(all, { memoryClass: 'discrete', ramGb: 64, budgetMb: 0 })).toBe('big')
  })
})

// LARGEST model that runs comfortably (recommended_ram_gb fits); if nothing fits
// comfortably, the lightest model that at least meets its minimum; else null.
describe('recommendModelIdByRam', () => {
  const small = validManifest({
    id: 'small',
    size_on_disk_gb: 2.7,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16
  })
  const medium = validManifest({
    id: 'medium',
    size_on_disk_gb: 5.5,
    recommended_min_ram_gb: 16,
    recommended_ram_gb: 32
  })
  const large = validManifest({
    id: 'large',
    size_on_disk_gb: 9.5,
    recommended_min_ram_gb: 32,
    recommended_ram_gb: 64
  })
  const embed = validManifest({
    id: 'embed',
    role: 'embeddings',
    recommended_min_ram_gb: 4,
    recommended_ram_gb: 8
  })
  const all = [small, medium, large, embed]

  it('picks the largest model that fits comfortably', () => {
    expect(recommendModelIdByRam(all, 64)).toBe('large')
    expect(recommendModelIdByRam(all, 32)).toBe('medium')
    expect(recommendModelIdByRam(all, 16)).toBe('small')
  })

  it('falls back to the lightest runnable model when nothing fits comfortably', () => {
    // 8 GB: no chat model has recommended_ram_gb <= 8, but small's minimum (8) is met.
    expect(recommendModelIdByRam(all, 8)).toBe('small')
  })

  it('returns null when not even the minimum fits, or RAM is unknown', () => {
    expect(recommendModelIdByRam(all, 4)).toBe(null)
    expect(recommendModelIdByRam(all, 0)).toBe(null)
    expect(recommendModelIdByRam(all, Number.NaN)).toBe(null)
  })

  it('scopes to the requested role', () => {
    expect(recommendModelIdByRam(all, 64, 'embeddings')).toBe('embed')
  })

  // Phase-29 quality-aware tiebreak: among models that tie on capacity fit, higher
  // recommendation_rank wins BEFORE disk size — so a benchmark winner is preferred over a
  // larger-on-disk loser. Default rank 0 keeps the legacy biggest-disk behaviour (above).
  it('prefers higher recommendation_rank among models that tie on comfortable RAM', () => {
    const winner = validManifest({ id: 'winner', size_on_disk_gb: 5.2, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 2 })
    const loser = validManifest({ id: 'loser', size_on_disk_gb: 5.3, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 0 })
    // 16 GB: both comfortable + tie on recommended_ram_gb; rank picks the (smaller) winner,
    // where the old disk-size tiebreak would have picked the bigger loser.
    expect(recommendModelIdByRam([winner, loser], 16)).toBe('winner')
  })

  it('applies the rank tiebreak in the lightest-runnable fallback too', () => {
    const keep = validManifest({ id: 'keep', size_on_disk_gb: 2.7, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 2 })
    const alt = validManifest({ id: 'alt', size_on_disk_gb: 2.5, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 1 })
    // 8 GB: neither comfortable; both runnable at min 8. Rank keeps the preferred 'keep' ahead
    // of the smaller 'alt' (e.g. the thinking-capable default over the instruct-only refresh).
    expect(recommendModelIdByRam([keep, alt], 8)).toBe('keep')
  })

  // #48 ranked-only guard (model-benchmarks.md §6.3): rank is a within-tier tiebreak, so a
  // rank-0 model (never benchmarked, or a benchmark loser) in a BIGGER capacity group used to
  // beat every ranked winner on capacity alone. Rank-0 models are now considered only when no
  // ranked model fits the stage at all.
  it('never recommends a comfortable rank-0 model over a ranked winner in a smaller tier [#48]', () => {
    const winner = validManifest({ id: 'winner', size_on_disk_gb: 7.0, recommended_min_ram_gb: 14, recommended_ram_gb: 24, recommendation_rank: 2 })
    const unevaled = validManifest({ id: 'unevaled', size_on_disk_gb: 22.2, recommended_min_ram_gb: 24, recommended_ram_gb: 32, recommendation_rank: 0 })
    // 32 GB: the never-evaled model tops the capacity sort, but a ranked winner fits → winner.
    expect(recommendModelIdByRam([winner, unevaled], 32)).toBe('winner')
  })

  it('still recommends a rank-0 model when nothing ranked fits the stage [#48]', () => {
    const unevaled = validManifest({ id: 'unevaled', size_on_disk_gb: 2.9, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 0 })
    const rankedTooBig = validManifest({ id: 'big-winner', size_on_disk_gb: 9.5, recommended_min_ram_gb: 32, recommended_ram_gb: 64, recommendation_rank: 2 })
    expect(recommendModelIdByRam([unevaled, rankedTooBig], 16)).toBe('unevaled') // comfortable stage
    expect(recommendModelIdByRam([unevaled, rankedTooBig], 8)).toBe('unevaled') // runnable fallback
  })

  // §6.5 speed-signal step-down (issue #95): a measured crawl on a right-sized model steps
  // the comfortable pick down ONE capacity tier; every other shape of signal changes nothing.
  describe('speed-signal step-down (model-benchmarks §6.5, issue #95)', () => {
    // Three ranked tiers (mirrors the committed 16/24/32 structure) + a rank-0 floor below.
    const top = validManifest({ id: 'top', size_on_disk_gb: 19.5, recommended_min_ram_gb: 24, recommended_ram_gb: 32, recommendation_rank: 3 })
    const mid = validManifest({ id: 'mid', size_on_disk_gb: 16.8, recommended_min_ram_gb: 20, recommended_ram_gb: 24, recommendation_rank: 3 })
    const low = validManifest({ id: 'low', size_on_disk_gb: 6.0, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 3 })
    const floor0 = validManifest({ id: 'floor0', size_on_disk_gb: 1.3, recommended_min_ram_gb: 6, recommended_ram_gb: 8, recommendation_rank: 0 })
    const all = [top, mid, low, floor0]
    const slow = (measuredModelId: string | null, tokensPerSecond: number | null = 2.1) => ({
      tokensPerSecond,
      measuredModelId
    })

    it('steps one tier down on a crawl measured on a right-sized model', () => {
      expect(recommendModelIdByRam(all, 32, 'chat', slow('top'))).toBe('mid')
      // A crawl on a SMALLER right-sized model is also a valid signal (it bounds the pick).
      expect(recommendModelIdByRam(all, 32, 'chat', slow('mid'))).toBe('mid')
      expect(recommendModelIdByRam(all, 24, 'chat', slow('mid'))).toBe('low')
    })

    it('never downgrades on a crawl measured on an OVERSIZED loaded model (the #52 lesson)', () => {
      // 24 GB machine, crawl measured on the 32 GB-tier model the user started manually:
      // expected to crawl — the pick stays.
      expect(recommendModelIdByRam(all, 24, 'chat', slow('top'))).toBe('mid')
    })

    it('the step never lands on a rank-0 model (§6.3 guard unchanged)', () => {
      // 16 GB: the only tier below 'low' is the rank-0 floor — keep the pick.
      expect(recommendModelIdByRam(all, 16, 'chat', slow('low'))).toBe('low')
    })

    it('keeps the pick when no lower tier exists at all', () => {
      expect(recommendModelIdByRam([top, mid, low], 16, 'chat', slow('low'))).toBe('low')
    })

    it('a runnable-stage (fallback) pick never steps', () => {
      // 12 GB: nothing fits comfortably, so 'wide' (the lowest minimum) is the runnable pick, and 'narrow' is a ranked tier
      // below it. A step has somewhere to land, so only the stage rule keeps 'wide'.
      const wide = validManifest({ id: 'wide', recommended_min_ram_gb: 10, recommended_ram_gb: 24, recommendation_rank: 3 })
      const narrow = validManifest({ id: 'narrow', recommended_min_ram_gb: 11, recommended_ram_gb: 16, recommendation_rank: 3 })
      expect(recommendModelIdByRam([wide, narrow], 12, 'chat', slow('wide'))).toBe('wide')
    })

    it('an unresolvable or absent measuredModelId is no signal', () => {
      expect(recommendModelIdByRam(all, 32, 'chat', slow('uninstalled-ghost'))).toBe('top')
      expect(recommendModelIdByRam(all, 32, 'chat', slow(null))).toBe('top')
    })

    it('applies strictly below the threshold (boundary at SLOW_PICK_TOKENS_PER_SECOND)', () => {
      expect(SLOW_PICK_TOKENS_PER_SECOND).toBe(5)
      expect(recommendModelIdByRam(all, 32, 'chat', slow('top', 5))).toBe('top')
      expect(recommendModelIdByRam(all, 32, 'chat', slow('top', 4.9))).toBe('mid')
      // No probe (null) and nonsense (0/negative) are no signal.
      expect(recommendModelIdByRam(all, 32, 'chat', slow('top', null))).toBe('top')
      expect(recommendModelIdByRam(all, 32, 'chat', slow('top', 0))).toBe('top')
    })

    it('scopes to the requested role: a chat crawl never moves an embeddings pick', () => {
      const embed = validManifest({ id: 'embed', role: 'embeddings', recommended_min_ram_gb: 4, recommended_ram_gb: 8 })
      expect(recommendModelIdByRam([...all, embed], 32, 'embeddings', slow('top'))).toBe('embed')
    })
  })
})

describe('buildModelList — RAM gate', () => {
  it('flags models above the machine RAM and recommends the best RAM fit', async () => {
    const dir = manifestsDirWith(
      rawManifest({ id: 'fits', recommended_min_ram_gb: 8, recommended_ram_gb: 16 }),
      rawManifest({ id: 'too-big', recommended_min_ram_gb: 64, recommended_ram_gb: 128 })
    )
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: tempRoot('root'),
      profile: 'UNKNOWN',
      developerMode: true,
      machineRamGb: 16
    })
    const byId = Object.fromEntries(models.map((m) => [m.id, m]))
    expect(byId['fits'].insufficientRam).toBe(false)
    expect(byId['fits'].recommended).toBe(true) // RAM best fit, despite UNKNOWN profile
    expect(byId['too-big'].insufficientRam).toBe(true)
    expect(byId['too-big'].recommended).toBe(false)
  })

  // §6.5 (issue #95): the speedSignal option threads the persisted Diagnostics pairing into
  // the CHAT recommendation — the ★ flag moves one tier down on a right-sized crawl and is
  // byte-identical without a signal.
  it('moves the recommended flag one tier down on a slow speed signal (§6.5)', async () => {
    const dir = manifestsDirWith(
      rawManifest({ id: 'big', recommended_min_ram_gb: 20, recommended_ram_gb: 24, recommendation_rank: 3, size_on_disk_gb: 16.8 }),
      rawManifest({ id: 'small', recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 3, size_on_disk_gb: 6.0 })
    )
    const base = {
      manifestsDir: dir,
      rootPath: tempRoot('root'),
      profile: 'UNKNOWN' as const,
      developerMode: true,
      machineRamGb: 24
    }
    const noSignal = await buildModelList(base)
    expect(noSignal.models.find((m) => m.recommended)?.id).toBe('big')

    const withSignal = await buildModelList({
      ...base,
      speedSignal: { tokensPerSecond: 2.2, measuredModelId: 'big' }
    })
    expect(withSignal.models.find((m) => m.recommended)?.id).toBe('small')

    // A null signal (no benchmark yet) is the no-signal path, exactly.
    const nullSignal = await buildModelList({ ...base, speedSignal: null })
    expect(nullSignal.models.find((m) => m.recommended)?.id).toBe('big')
  })
})

// RT-3 lazy verification. On a cold cache the lazy mode (`onlyVerifyModelId`) hashes ONLY the
// named model, while the full mode (no `onlyVerifyModelId`) hashes the full set. Since #382
// lazy is what every routine caller uses — the workspace gate, the Performance screen AND an
// ordinary Models-screen visit — and the full mode has exactly one caller left: the Models
// screen's explicit "Check all model files" action (plus the ship-time gates, which have their
// own path). Inactive present weights are still reported `installed` (display-only — the start
// gate re-verifies what it launches).
describe('buildModelList — RT-3 lazy verification', () => {
  function twoModels(): { dir: string; root: string } {
    const root = tempRoot('root')
    const hA = writeDriveFile(root, 'models/chat/a.gguf', 'AAAA')
    const hB = writeDriveFile(root, 'models/chat/b.gguf', 'BBBBBBBB')
    const dir = manifestsDirWith(
      rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: hA }),
      rawManifest({ id: 'b', local_path: 'models/chat/b.gguf', sha256: hB })
    )
    return { dir, root }
  }

  it('lazy with no active model (null) hashes nothing', async () => {
    const { dir, root } = twoModels()
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      onlyVerifyModelId: null
    })
    expect(checksumCacheStats.computed).toBe(before)
    expect(models.every((m) => m.state === 'installed')).toBe(true)
  })

  it('still serves a cached hash for an inactive model (honest checksum_failed)', async () => {
    const { dir, root } = twoModels()
    const base = { manifestsDir: dir, rootPath: root, profile: 'UNKNOWN' as const, developerMode: false, machineRamGb: PINNED_RAM_GB }
    // Warm the cache for both (full pass), then plant a cached hash for 'b' that does not match its manifest:
    // the lazy pass must surface it for free, not report 'installed' on the skip-hash branch.
    await buildModelList(base)
    primeChecksum(join(root, 'models', 'chat', 'b.gguf'), 'a'.repeat(64))
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({ ...base, onlyVerifyModelId: 'a' })
    expect(checksumCacheStats.computed).toBe(before)
    expect(models.find((m) => m.id === 'a')?.state).toBe('installed')
    expect(models.find((m) => m.id === 'b')?.state).toBe('checksum_failed')
  })
})

// First-run verification progress (architecture.md "Model verification progress"): the
// `listModels`/`buildModelList` path streams a byte-weighted progress signal so the gate +
// Models screen can show a determinate bar instead of an opaque spinner while multi-GB
// weights hash for the first time.
describe('buildModelList — verification progress', () => {
  it('reports byte-weighted progress across the models that hash', async () => {
    const root = tempRoot('root')
    const h1 = writeDriveFile(root, 'models/chat/a.gguf', 'AAAA') // 4 bytes
    const h2 = writeDriveFile(root, 'models/chat/b.gguf', 'BBBBBBBB') // 8 bytes
    const dir = manifestsDirWith(
      rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h1 }),
      rawManifest({ id: 'b', local_path: 'models/chat/b.gguf', sha256: h2 })
    )
    const events: ModelVerifyProgress[] = []
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      onProgress: (p) => events.push(p)
    })
    expect(models.every((m) => m.state === 'installed')).toBe(true)
    // Every weight really hashed, and each reported its own bytes: the terminal event alone is built from the pre-pass.
    expect(checksumCacheStats.computed).toBe(before + 2)
    expect(events.filter((e) => !e.done).map((e) => [e.modelIndex, e.overallBytesHashed])).toEqual([[1, 4], [2, 12]])

    // Denominator = both files; step counter spans both; overall byte count is monotonic.
    expect(events.every((e) => e.overallBytesTotal === 12)).toBe(true)
    expect(events.every((e) => e.modelCount === 2)).toBe(true)
    expect(events.map((e) => e.modelIndex)).toEqual([...events.map((e) => e.modelIndex)].sort((a, b) => a - b))
    const hashed = events.map((e) => e.overallBytesHashed)
    expect(hashed).toEqual([...hashed].sort((a, b) => a - b))

    // The terminal event settles the bar to 100%.
    const last = events.at(-1)!
    expect(last.done).toBe(true)
    expect(last.overallBytesHashed).toBe(12)
    expect(last.modelIndex).toBe(2)
  })

  it('emits NO events when every weight is already cached (the common 2nd run)', async () => {
    const root = tempRoot('root')
    const h = writeDriveFile(root, 'models/chat/a.gguf', 'cached weights')
    const dir = manifestsDirWith(rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h }))
    const db = seededFreshDb('cached')
    const store = createSettingsHashStore(() => db, root)

    const opts = { manifestsDir: dir, rootPath: root, profile: 'UNKNOWN' as const, developerMode: false, machineRamGb: PINNED_RAM_GB, hashStore: store }
    await buildModelList(opts) // warm the cache
    const events: ModelVerifyProgress[] = []
    await buildModelList({ ...opts, onProgress: (p) => events.push(p) })
    expect(events).toEqual([])
  })

  it('excludes missing and placeholder-hash weights from the byte denominator', async () => {
    const root = tempRoot('root')
    const real = writeDriveFile(root, 'models/chat/real.gguf', 'REAL') // 4 bytes, will hash
    // placeholder hash (default fixture) → never hashed; missing file → never hashed.
    const dir = manifestsDirWith(
      rawManifest({ id: 'real', local_path: 'models/chat/real.gguf', sha256: real }),
      rawManifest({ id: 'placeholder', local_path: 'models/chat/placeholder.gguf' }),
      rawManifest({ id: 'missing', local_path: 'models/chat/missing.gguf', sha256: 'f'.repeat(64) })
    )
    const events: ModelVerifyProgress[] = []
    await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: true, // placeholder counts as installed, still not hashed
      machineRamGb: PINNED_RAM_GB,
      onProgress: (p) => events.push(p)
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.overallBytesTotal === 4)).toBe(true)
    expect(events.every((e) => e.modelCount === 1)).toBe(true)
  })
})
// #420 — cancelling a verification pass. Before this, `sha256File` took no abort signal, so
// the Models screen's "Check all model files" ran to the end whatever the user did: 39.44 GB
// at a mean 25.8 MB/s on the #330 slow drive is ~25 minutes of USB I/O that survived
// navigating away and even window destruction. Only the DISPLAY-side passes are cancellable;
// the §7.4 start gate and the ship-time gates pass no signal and are untouched.
describe('cancellable verification (#420)', () => {
  /** A file big enough that `sha256File`'s 64 MiB progress throttle fires mid-read, which is
   *  what makes a mid-file abort deterministic (and what the #392 warm mark needs). */
  const OVER_PROGRESS_CHUNK = 70 * 1024 * 1024
  let bigSha: string | undefined
  const bigFileSha = (): string => (bigSha ??= createHash('sha256').update(Buffer.alloc(OVER_PROGRESS_CHUNK)).digest('hex'))

  function bigFile(): string {
    const file = join(tempRoot('abort'), 'weight.bin')
    writeFileSync(file, Buffer.alloc(OVER_PROGRESS_CHUNK))
    return file
  }

  // ---- trap 1: the promise must REJECT, never hang -----------------------------------
  // `sha256File` attaches only `error` and `end`. A naive `stream.destroy()` emits `close`
  // and NEITHER of those, so the promise would simply never settle and every awaiting caller
  // — computeInstallState, buildModelList, the IPC handler, the renderer's busy flag — would
  // park forever. These pin the rejection, not merely that hashing stopped.
  it('rejects (never hangs) when the signal fires while the read is open', async () => {
    const file = join(tempRoot('abort'), 'weight.bin')
    writeFileSync(file, 'abort me')
    const controller = new AbortController()
    const promise = sha256File(file, undefined, controller.signal)
    controller.abort() // the stream is open (fs.open is async) → destroy-with-error path
    await expect(promise).rejects.toThrow(/cancelled/i)
  })

  it('rejects without reading anything when the signal is ALREADY aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // A path that does not exist: reaching the filesystem at all would give ENOENT instead.
    await expect(
      sha256File(join(tempRoot('abort'), 'never-opened.bin'), undefined, controller.signal)
    ).rejects.toThrow(/cancelled/i)
  })

  it('with NO signal it behaves exactly as before (progress + digest)', async () => {
    const file = join(tempRoot('abort'), 'weight.bin')
    writeFileSync(file, 'unchanged')
    const seen: number[] = []
    await expect(sha256File(file, (b) => seen.push(b))).resolves.toBe(
      sha256('unchanged')
    )
    expect(seen).toEqual([Buffer.byteLength('unchanged')])
  })

  it('aborts mid-file: the read stops and nothing is cached or counted', async () => {
    const readLog = armPerfLog()
    const file = bigFile()
    const before = checksumCacheStats.computed
    const controller = new AbortController()
    // The 64 MiB throttle fires once with ~6 MiB still to read — a genuine mid-read abort.
    await expect(
      verifyChecksum(file, bigFileSha(), undefined, () => controller.abort(), undefined, controller.signal)
    ).rejects.toThrow(/cancelled/i)
    // The caller rejects first; the read's own catch closes the pair after it. Verifying again before that close joins the dying read.
    await until(() => doneMarks(readLog).length > 0, 'the cancelled read closing')
    expect(doneMarks(readLog)).toEqual([expect.objectContaining({ ok: false })])
    expect(checksumCacheStats.computed).toBe(before)
    // Nothing was cached: a fresh verify hashes for real and matches.
    expect((await verifyChecksum(file, bigFileSha())).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  // ---- trap 2: single-flight sharing --------------------------------------------------
  // `inFlightHashes` makes concurrent callers of the same path share ONE physical read —
  // it exists precisely because the unlock auto-start races a Models-screen pass over the
  // same weight. The rule: the shared read is aborted only when EVERY waiter has abandoned
  // it, so an uncancellable caller can never be collateral damage.
  it('a cancelled screen pass does not abort the hash an uncancellable caller joined', async () => {
    const file = bigFile()
    const expected = bigFileSha()
    const before = checksumCacheStats.computed
    const controller = new AbortController()
    // Same tick: the leader registers in `inFlightHashes` synchronously, so the second call
    // JOINS it rather than starting a second multi-GB read.
    const screen = verifyChecksum(file, expected, undefined, undefined, undefined, controller.signal)
    const gate = verifyChecksum(file, expected) // the §7.4 start gate — no signal
    controller.abort()

    await expect(screen).rejects.toThrow(/cancelled/i)
    expect((await gate).matched).toBe(true) // the shared read ran to the end for the gate
    expect(checksumCacheStats.computed).toBe(before + 1) // and it was ONE physical hash
  })

  it('…and the other way round: a cancelled JOINER leaves the uncancellable leader alone', async () => {
    const file = bigFile()
    const expected = bigFileSha()
    const before = checksumCacheStats.computed
    const controller = new AbortController()
    const gate = verifyChecksum(file, expected) // leads, uncancellable
    const screen = verifyChecksum(file, expected, undefined, undefined, undefined, controller.signal)
    controller.abort()

    await expect(screen).rejects.toThrow(/cancelled/i)
    expect((await gate).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('the physical read DOES stop once every waiter has cancelled', async () => {
    const readLog = armPerfLog()
    const file = bigFile()
    const expected = bigFileSha()
    const before = checksumCacheStats.computed
    const a = new AbortController()
    const b = new AbortController()
    const first = verifyChecksum(file, expected, undefined, undefined, undefined, a.signal)
    const second = verifyChecksum(file, expected, undefined, undefined, undefined, b.signal)
    a.abort()
    b.abort()

    await expect(first).rejects.toThrow(/cancelled/i)
    await expect(second).rejects.toThrow(/cancelled/i)
    // Both rejections come from the waiters, not the read: only the close says the read really stopped.
    await until(() => doneMarks(readLog).length > 0, 'the abandoned read closing')
    expect(doneMarks(readLog)).toEqual([expect.objectContaining({ ok: false })])
    expect(checksumCacheStats.computed).toBe(before)
  })

  // ---- the persistence guarantees a cancelled hash must leave alone -------------------
  it('a cancelled hash records no read sample and never marks the file page-cache-warm', async () => {
    const readLog = armPerfLog()
    resetEffectiveReadForTests()
    const file = bigFile()
    const controller = new AbortController()
    await expect(
      verifyChecksum(
        file,
        bigFileSha(),
        undefined,
        () => controller.abort(),
        { modelId: 'm', file: 'weight' },
        controller.signal
      )
    ).rejects.toThrow(/cancelled/i)
    await until(() => doneMarks(readLog).length > 0, 'the cancelled read closing')
    expect(doneMarks(readLog)).toEqual([expect.objectContaining({ ok: false })])
    // Weak alone on a fast disk (under the 250 ms floor); the warm mark below carries the proof, its registration ignores the elapsed floor.
    expect(latestEffectiveReadBySource('checksum')).toBeNull()

    // The teeth: the file was NOT registered in #392's warmed set, so a model-load window
    // over it still records honestly. (A completed hash of the same file suppresses it —
    // the contrast case below.)
    recordModelLoadRead(file, 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveReadBySource('model_load')).not.toBeNull()
  })

  it('…while a COMPLETED hash of the same file does mark it warm (the contrast)', async () => {
    resetEffectiveReadForTests()
    const file = bigFile()
    await verifyChecksum(
      file,
      bigFileSha(),
      undefined,
      undefined,
      { modelId: 'm', file: 'weight' }
    )
    recordModelLoadRead(file, 10_000, 'm', 6_000_000_000)
    expect(latestEffectiveReadBySource('model_load')).toBeNull()
  })

  // ---- the loops, not only the stream --------------------------------------------------
  it('a cancel between two weights stops the pass immediately — the next model never hashes', async () => {
    const root = tempRoot('root')
    const h1 = writeDriveFile(root, 'models/chat/a.gguf', 'AAAA')
    const h2 = writeDriveFile(root, 'models/chat/b.gguf', 'BBBBBBBB')
    const dir = manifestsDirWith(
      rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h1 }),
      rawManifest({ id: 'b', local_path: 'models/chat/b.gguf', sha256: h2 })
    )
    const before = checksumCacheStats.computed
    const controller = new AbortController()
    const events: ModelVerifyProgress[] = []
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      signal: controller.signal,
      // The first model's final progress event lands once its file is hashed — cancel there.
      onProgress: (p) => {
        events.push(p)
        if (!p.done) controller.abort()
      }
    })
    // Exactly ONE physical hash: the abort lands in the first file's final progress, the waiter rejects, the pass goes calm, and 'b' never opens.
    expect(checksumCacheStats.computed).toBe(before + 1)
    expect(manifestErrors).toEqual([])
    // The list is still complete and honest: what was reached is verified, the rest is
    // present-but-unchecked, which is exactly what RT-3 lazy verification reports.
    expect(models.map((m) => m.id).sort()).toEqual(['a', 'b'])
    expect(models.every((m) => m.state === 'installed')).toBe(true)
    // No event ever names the model that was skipped, and the bar still settles.
    expect(events.some((e) => e.modelId === 'b')).toBe(false)
    expect(events.at(-1)?.done).toBe(true)
  })

  it('an already-cancelled pass hashes nothing at all and still settles the bar', async () => {
    const root = tempRoot('root')
    const h = writeDriveFile(root, 'models/chat/a.gguf', 'AAAA')
    const dir = manifestsDirWith(rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h }))
    const before = checksumCacheStats.computed
    const controller = new AbortController()
    controller.abort()
    const events: ModelVerifyProgress[] = []
    const { models, manifestErrors } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      signal: controller.signal,
      onProgress: (p) => events.push(p)
    })
    expect(manifestErrors).toEqual([]) // a cancelled model is never reported as a manifest ERROR
    expect(checksumCacheStats.computed).toBe(before)
    expect(models[0].state).toBe('installed')
    expect(events).toHaveLength(1)
    expect(events[0].done).toBe(true)
  })

  it('the renderer-minted run id tags every event of the pass (it is the cancel handle)', async () => {
    const root = tempRoot('root')
    const h = writeDriveFile(root, 'models/chat/a.gguf', 'AAAA')
    const dir = manifestsDirWith(rawManifest({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h }))
    const events: ModelVerifyProgress[] = []
    await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      machineRamGb: PINNED_RAM_GB,
      runId: 'renderer-minted',
      onProgress: (p) => events.push(p)
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.runId === 'renderer-minted')).toBe(true)
  })
})


describe('discoverManifests', () => {
  it('parses valid manifests and reports invalid ones', () => {
    const dir = tempRoot('manifests')
    writeManifest(dir, 'good.yaml', rawManifest())
    writeManifest(dir, 'embed.yml', rawManifest({ id: 'embed', role: 'embeddings' }))
    writeManifest(dir, 'bad.yaml', { id: 'broken' }) // missing required fields
    writeFileSync(join(dir, 'notes.txt'), 'ignored') // non-manifest file skipped
    writeFileSync(join(dir, 'syntax.yaml'), 'a: [unclosed')

    const res = discoverManifests(dir)
    expect(res.manifests.map((m) => m.manifest.id).sort()).toEqual(['embed', 'qwen3-4b-instruct-q4'])
    expect(res.errors.length).toBe(2)
    expect(res.errors[0]).toContain('bad.yaml')
    expect(res.errors[1]).toContain('syntax.yaml')
    expect(res.errors[1]).toContain('YAML parse error')
  })

  it('flags duplicate ids', () => {
    const dir = tempRoot('manifests')
    writeManifest(dir, 'a.yaml', rawManifest())
    writeManifest(dir, 'b.yaml', rawManifest())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
    expect(res.errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })

  it('recurses into subdirectories', () => {
    const dir = tempRoot('manifests')
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeManifest(join(dir, 'chat'), 'm.yaml', rawManifest())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
  })

  // #333: the walk/read/parse phase split feeding the opt-in `discover_manifests` mark runs on
  // a second code path (the `timed` branch — extra clocks, a byte count, and the file list
  // hoisted out of the `for` head). Discovery is the §7.4 install gate's own source of truth, so
  // the instrumentation must be provably semantics-free: same manifests, same errors, same
  // order, with the perf log on and off. The mark's CONTENT is not asserted here — perf.ts
  // buffers pre-`initPerf` marks in memory by design and exposes no reader.
  it('returns an identical result with the perf log enabled (#333 instrumentation)', () => {
    const dir = tempRoot('manifests')
    writeManifest(dir, 'good.yaml', rawManifest())
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeManifest(join(dir, 'chat'), 'nested.yml', rawManifest({ id: 'nested' }))
    writeManifest(dir, 'bad.yaml', { id: 'broken' })

    const before = process.env.HILBERTRAUM_PERF_LOG
    const off = discoverManifests(dir)
    process.env.HILBERTRAUM_PERF_LOG = '1'
    let on: ReturnType<typeof discoverManifests>
    try {
      on = discoverManifests(dir)
    } finally {
      if (before === undefined) delete process.env.HILBERTRAUM_PERF_LOG
      else process.env.HILBERTRAUM_PERF_LOG = before
    }

    expect(on.manifests.map((m) => m.manifest.id)).toEqual(off.manifests.map((m) => m.manifest.id))
    expect(on.manifests.map((m) => m.sourceFile)).toEqual(off.manifests.map((m) => m.sourceFile))
    expect(on.errors).toEqual(off.errors)
    expect(off.manifests.length).toBe(2)
    expect(off.errors.length).toBe(1)
  })
})

// full-audit 2026-07-10 BE-5: launchContextTokens is the ONE spelling of the launch-window
// precedence (override ?? manifest recommended ?? legacy setting). startModelRuntime launches
// with it and the no-runtime doc-task budget fallback (index.ts getContextTokens) mirrors it —
// these pin the precedence for BOTH callers. Before the fix the fallback skipped the manifest's
// recommended window, so the tree-build size gate planned against the legacy 4096 default.
describe('launchContextTokens (full-audit 2026-07-10 BE-5)', () => {
  const legacy = { contextTokens: 4096, contextTokensOverride: null }

  it('prefers the manifest recommended window over the legacy setting', () => {
    const dir = tempRoot('launch-ctx')
    writeManifest(dir, 'm.yaml', rawManifest({ recommended_context_tokens: 32768 }))
    const manifest = findManifestById(dir, 'qwen3-4b-instruct-q4')
    expect(manifest?.recommendedContextTokens).toBe(32768)
    expect(launchContextTokens(legacy, manifest)).toBe(32768)
  })

  it('falls back to the legacy setting for a manifest without a recommended window (0)', () => {
    expect(launchContextTokens(legacy, validManifest({ recommended_context_tokens: 0 }))).toBe(4096)
  })

  it('falls back to the legacy setting when no manifest resolves', () => {
    const dir = tempRoot('launch-ctx')
    writeManifest(dir, 'm.yaml', rawManifest())
    // A manifest missing the field entirely fails validation → resolves to null, never NaN.
    const missingField = rawManifest()
    delete missingField.recommended_context_tokens
    writeManifest(dir, 'missing.yaml', { ...missingField, id: 'no-ctx-model' })
    expect(findManifestById(dir, 'no-ctx-model')).toBeNull()
    expect(findManifestById(dir, 'unknown-id')).toBeNull()
    expect(findManifestById(null, 'qwen3-4b-instruct-q4')).toBeNull()
    expect(findManifestById(dir, null)).toBeNull()
    expect(findManifestById(join(dir, 'no-such-subdir'), 'qwen3-4b-instruct-q4')).toBeNull()
    expect(launchContextTokens(legacy, null)).toBe(4096)
  })

  it('the user context-size override wins over both', () => {
    const s = { contextTokens: 4096, contextTokensOverride: 8192 }
    expect(launchContextTokens(s, validManifest({ recommended_context_tokens: 32768 }))).toBe(8192)
    expect(launchContextTokens(s, null)).toBe(8192)
  })
})

describe('resolveManifestsDir', () => {
  it('honours an explicit override that exists', () => {
    const dir = tempRoot('manifests')
    expect(resolveManifestsDir('/somewhere', dir)).toBe(dir)
  })
  it('falls back to the walk-up when the override path is missing (M21)', () => {
    const root = tempRoot('up-fallback')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    expect(resolveManifestsDir(root, join(root, 'no-such-dir'))).toBe(mdir)
  })
  it('finds model-manifests by walking up', () => {
    const root = tempRoot('up')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    const deep = join(root, 'apps', 'desktop', 'out', 'main')
    mkdirSync(deep, { recursive: true })
    expect(resolveManifestsDir(deep)).toBe(mdir)
  })
  it('returns null when nothing is found', () => {
    expect(resolveManifestsDir(tempRoot('empty'))).toBe(null)
  })
})

describe('selectModel', () => {
  function setup(): { db: Db; manifestsDir: string } {
    const manifestsDir = tempRoot('manifests')
    writeManifest(manifestsDir, 'chat.yaml', rawManifest())
    writeManifest(manifestsDir, 'embed.yaml', rawManifest({ id: 'embed', role: 'embeddings' }))
    return { db: seededFreshDb('select'), manifestsDir }
  }

  it('persists a chat selection to activeModelId', () => {
    const { db, manifestsDir } = setup()
    const res = selectModel(db, manifestsDir, 'qwen3-4b-instruct-q4')
    expect(res.activeModelId).toBe('qwen3-4b-instruct-q4')
    expect(getSettings(db).activeModelId).toBe('qwen3-4b-instruct-q4')
  })

  it('persists an embedding selection to activeEmbeddingModelId', () => {
    const { db, manifestsDir } = setup()
    const res = selectModel(db, manifestsDir, 'embed')
    expect(res.activeEmbeddingModelId).toBe('embed')
    expect(getSettings(db).activeModelId).toBe(null) // chat slot untouched
  })

  it('throws on an unknown model id', () => {
    const { db, manifestsDir } = setup()
    expect(() => selectModel(db, manifestsDir, 'nope')).toThrow()
  })

  // Phase 36 fix + TG-1: availability-driven roles have no settings slot. The old role-else-chat fallback would have
  // written such an id into activeModelId — the CHAT slot — and broken chat.
  const AUTO_ROLES: Array<[string, Record<string, unknown>]> = [
    ['transcriber', { id: 'whisper-small-multilingual', role: 'transcriber', runtime: 'whisper_cpp', format: 'ggml', local_path: 'models/transcriber/ggml-small.bin' }],
    ['reranker', { id: 'bge-reranker', role: 'reranker', local_path: 'models/reranker/bge.gguf' }],
    ['vision', { id: 'qwen2.5-vl', role: 'vision', family: 'qwen2.5-vl', local_path: 'models/vision/vl.gguf', mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'REPLACE_WITH_REAL_HASH' } }],
    ['translation', { id: 'translategemma-12b-it-q4', role: 'translation', family: 'translategemma', license: 'gemma', local_path: 'models/translation/translategemma-12b-it.Q4_K_M.gguf' }]
  ]

  it.each(AUTO_ROLES)('refuses a %s selection and leaves both slots untouched', (_role, fields) => {
    const { db, manifestsDir } = setup()
    writeManifest(manifestsDir, 'auto.yaml', rawManifest(fields))
    expect(() => selectModel(db, manifestsDir, String(fields.id))).toThrow(/used automatically/)
    expect(getSettings(db).activeModelId).toBe(null)
    expect(getSettings(db).activeEmbeddingModelId).toBe(null)
  })
})
