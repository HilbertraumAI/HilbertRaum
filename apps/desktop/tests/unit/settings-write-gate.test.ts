import { describe, it, expect } from 'vitest'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_SETTINGS, MAX_BENCHMARK_HISTORY, type AppSettings } from '../../src/shared/types'
import { rawSetting } from '../helpers/db-fixtures'
import { seededFreshDb } from '../helpers/seeded-db'

// BE-1 (full-audit 2026-07-10): the write gate's generic type check had two holes —
// (a) `value === null` bypassed it for EVERY key, so `{ checksumCache: null }` persisted over
// the non-nullable `{}` default and every checksum-cache reader threw until the row was
// repaired (bricking the Models screen); (b) keys whose DEFAULT is null (activeModelId,
// activeEmbeddingModelId, lastBenchmark, gpuLastError, gpuProbe) carried no type information,
// so ANY JSON of any size persisted into the encrypted settings blob. These pin the closed
// gate; `contextTokensOverride` keeps its own clamp (settings-context-override.test.ts).
//
// `getSettings` re-validates the benchmark records on READ, so a read-back cannot tell a write
// that stored junk from one that dropped it: the rows about what a WRITE persists read the stored
// row itself (`rawSetting`). An older build reads that row without the read-side repair.

// The shipped bounds, pinned by VALUE (CONTRIBUTING "Pin the bound that ships"): settings.ts keeps
// them private, so a change to one fails here instead of moving with the test.
const MAX_ID = 512 // MAX_SETTINGS_ID_LENGTH
const MAX_ERROR = 4096 // MAX_SETTINGS_ERROR_LENGTH
const MAX_OBJECT_BYTES = 256 * 1024 // MAX_SETTINGS_OBJECT_BYTES (data-contracts.md "Settings storage")

/** A deliberately mistyped renderer patch crossing the IPC boundary: a whole-patch cast, not `as never`. */
type JunkPatch = Record<string, unknown>
type Bench = NonNullable<AppSettings['lastBenchmark']>
/** The legacy `{ profile }` blob: a valid `lastBenchmark` (G3), but partial, hence the narrow cast. */
const LEGACY_BENCH = { profile: 'BALANCED' } as unknown as Bench

const freshDb = (): ReturnType<typeof seededFreshDb> => seededFreshDb('settings-gate')

describe('settings write gate — benchmarkHistory (the one array-of-objects setting)', () => {
  type History = AppSettings['benchmarkHistory']
  const entry = (cpuModel: string): History[number] =>
    ({ cpuModel, cpuCores: 8, ramGb: 16, os: 'linux', arch: 'x64', ranAt: '2026-09-05T00:00:00Z' }) as unknown as History[number]

  // H1: the gate kept any plain object, so `{}` was a valid history entry — it reached the
  // snapshot and threw in the screen's number formatter. An entry has to say something about a
  // machine to be one; the legacy `{ profile }` blob (a valid `lastBenchmark`) has no machine
  // identity, so it could never be matched again and is not filed either.
  it('keeps plain-object entries, drops junk elements, and caps at MAX_BENCHMARK_HISTORY', () => {
    const db = freshDb()
    const junk = [
      entry('a'),
      'nope',
      42,
      null,
      ['no'],
      {},
      { nothing: true },
      { profile: 'NOPE' },
      LEGACY_BENCH,
      entry('b')
    ] as unknown as History
    updateSettings(db, { benchmarkHistory: junk })
    expect((rawSetting(db, 'benchmarkHistory') as History).map((e) => e.cpuModel)).toEqual(['a', 'b'])
    expect(getSettings(db).benchmarkHistory.map((e) => e.cpuModel)).toEqual(['a', 'b'])

    const many = Array.from({ length: MAX_BENCHMARK_HISTORY + 3 }, (_, i) => entry(`m${i}`))
    updateSettings(db, { benchmarkHistory: many })
    expect(rawSetting(db, 'benchmarkHistory')).toHaveLength(MAX_BENCHMARK_HISTORY)
  })

  it('drops a non-array value and null (the default is a non-null array)', () => {
    const db = freshDb()
    updateSettings(db, { benchmarkHistory: [entry('keep')] })
    updateSettings(db, { benchmarkHistory: { not: 'an array' } as unknown as History })
    updateSettings(db, { benchmarkHistory: null as unknown as History })
    expect(getSettings(db).benchmarkHistory.map((e) => e.cpuModel)).toEqual(['keep'])
  })

  // The history is addressed by machine (`machineKey`): the write files ONE record per machine, the newest. Read off
  // the stored row, since `getSettings` re-applies the same dedup on read and would hide a write that stored both.
  it('drops an entry with no machine identity, and keeps one record per machine', () => {
    const db = freshDb()
    const older = { ...entry('same'), ranAt: '2026-01-01T00:00:00Z', tokensPerSecond: 1 } as History[number]
    const newer = { ...entry('same'), ranAt: '2026-09-05T00:00:00Z', tokensPerSecond: 9 } as History[number]
    updateSettings(db, { benchmarkHistory: [LEGACY_BENCH, older, newer, entry('other')] })
    const stored = rawSetting(db, 'benchmarkHistory') as History
    expect(stored.map((e) => e.cpuModel)).toEqual(['same', 'other'])
    expect(stored[0].tokensPerSecond).toBe(9)
  })
})

describe('settings write gate — modelPlacements (object map, never an array)', () => {
  // PR #303 audit P4: `at` used to be the placeholder 'x' here — the record is VALIDATED now
  // (L8), and a placement the screen dates has to carry a real timestamp.
  const rec = { modelId: 'm', contextTokens: 1, backend: 'cpu', gpuLayers: null, totalLayers: null, gpuModelMb: null, cpuModelMb: 1, gpuKvMb: null, cpuKvMb: null, metalMaxWorkingSetMb: null, machineKey: null, at: '2026-09-05T00:00:00Z' } as const

  it('stores a plain object map and drops an array or a primitive', () => {
    const db = freshDb()
    updateSettings(db, { modelPlacements: { m: rec } })
    expect(getSettings(db).modelPlacements.m?.cpuModelMb).toBe(1)
    updateSettings(db, { modelPlacements: [rec] as unknown as AppSettings['modelPlacements'] })
    updateSettings(db, { modelPlacements: 'junk' as unknown as AppSettings['modelPlacements'] })
    expect(getSettings(db).modelPlacements.m?.cpuModelMb).toBe(1)
  })

  // L8: the gate checked the MAP only, so `{ m: {} }` and `{ m: 'x' }` were both stored and a
  // `{}` record reached `placementVerdict`. Each record validates, and the map key must be the
  // record's own model id (a mismatched key would hand one model's measurement to another).
  it('drops a record that is not a placement, and one filed under the wrong model id', () => {
    const db = freshDb()
    updateSettings(db, { modelPlacements: { m: rec } })
    updateSettings(db, { modelPlacements: { m: {} } } as JunkPatch)
    expect(rawSetting(db, 'modelPlacements')).toEqual({})
    expect(getSettings(db).modelPlacements).toEqual({})
    updateSettings(db, { modelPlacements: { m: rec, junk: 'x' } } as JunkPatch)
    expect(Object.keys(rawSetting(db, 'modelPlacements') as object)).toEqual(['m'])
    updateSettings(db, { modelPlacements: { other: rec } } as JunkPatch)
    expect(rawSetting(db, 'modelPlacements')).toEqual({})
  })
})

describe('settings write gate (BE-1)', () => {
  it('drops null for keys whose default is non-null (checksumCache must stay an object)', () => {
    const db = freshDb()
    updateSettings(db, { checksumCache: null } as JunkPatch)
    expect(getSettings(db).checksumCache).toEqual({})
    // Null must not clobber a real persisted cache either.
    updateSettings(db, { checksumCache: { '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'abc' } } })
    updateSettings(db, { checksumCache: null } as JunkPatch)
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc')
    // Same hole applied to every non-nullable key — spot-check a boolean one.
    updateSettings(db, { allowNetwork: null } as JunkPatch)
    expect(getSettings(db).allowNetwork).toBe(true)
  })

  it('still accepts null for null-default keys ({ activeModelId: null } clears the active model)', () => {
    const db = freshDb()
    updateSettings(db, { activeModelId: 'qwen3-4b-instruct-q4' })
    expect(updateSettings(db, { activeModelId: null }).activeModelId).toBeNull()
    // The "Try GPU again" repair path (registerBenchmarkIpc) clears via gpuLastError: null.
    updateSettings(db, { gpuLastError: 'health check failed' })
    expect(updateSettings(db, { gpuLastError: null }).gpuLastError).toBeNull()
  })

  it('model-id keys accept only bounded strings', () => {
    const db = freshDb()
    updateSettings(db, { activeModelId: {} } as JunkPatch)
    expect(getSettings(db).activeModelId).toBeNull()
    updateSettings(db, { activeModelId: 42 } as JunkPatch)
    expect(getSettings(db).activeModelId).toBeNull()
    updateSettings(db, { activeModelId: 'x'.repeat(MAX_ID + 1) })
    expect(getSettings(db).activeModelId).toBeNull()
    // Exactly at the cap is accepted, so the pinned value holds the bound from both sides.
    expect(updateSettings(db, { activeModelId: 'x'.repeat(MAX_ID) }).activeModelId).toBe('x'.repeat(MAX_ID))
    expect(updateSettings(db, { activeModelId: 'qwen3-4b-instruct-q4' }).activeModelId).toBe(
      'qwen3-4b-instruct-q4'
    )
    updateSettings(db, { activeEmbeddingModelId: ['e5'] } as JunkPatch)
    expect(getSettings(db).activeEmbeddingModelId).toBeNull()
    expect(
      updateSettings(db, { activeEmbeddingModelId: 'e5-small-multilingual' }).activeEmbeddingModelId
    ).toBe('e5-small-multilingual')
  })

  it('gpuLastError accepts only a length-capped string (no multi-MB junk in the encrypted blob)', () => {
    const db = freshDb()
    updateSettings(db, { gpuLastError: { reason: 'boom' } } as JunkPatch)
    expect(getSettings(db).gpuLastError).toBeNull()
    updateSettings(db, { gpuLastError: 'x'.repeat(MAX_ERROR + 1) })
    expect(getSettings(db).gpuLastError).toBeNull()
    // Exactly at the cap is accepted, so the pinned value holds the bound from both sides.
    expect(updateSettings(db, { gpuLastError: 'x'.repeat(MAX_ERROR) }).gpuLastError).toHaveLength(MAX_ERROR)
    // The real writer (persistGpuFailure) sends a ~2 kB timestamped reason — well under the cap.
    const reason = `2026-07-10T00:00:00.000Z — ${'e'.repeat(1990)}`
    expect(updateSettings(db, { gpuLastError: reason }).gpuLastError).toBe(reason)
  })

  // PR #303 audit P4: the blob was `{ profile: 'FAST_LOCAL' }` — a profile name the app has
  // never had. The record is VALIDATED now (H1), so the fixture states a real `HardwareProfile`;
  // `gpuProbe` is validated too since P5 (`normalizeGpuProbe`, behind the same plain-object gate).
  // A real PRIOR value comes first: against the null default a dropped junk write and a stored
  // one look the same, since the read side maps junk to null as well.
  it('lastBenchmark / gpuProbe accept plain objects only', () => {
    const db = freshDb()
    updateSettings(db, { lastBenchmark: LEGACY_BENCH })
    expect(getSettings(db).lastBenchmark?.profile).toBe('BALANCED')
    for (const junk of ['junk', [1, 2, 3]]) {
      updateSettings(db, { lastBenchmark: junk } as JunkPatch)
      expect(getSettings(db).lastBenchmark?.profile).toBe('BALANCED')
    }
    updateSettings(db, { gpuProbe: { devices: [], probedAt: '2026-07-10T00:00:00.000Z' } })
    expect(getSettings(db).gpuProbe?.probedAt).toBe('2026-07-10T00:00:00.000Z')
    updateSettings(db, { gpuProbe: 3.14 } as JunkPatch)
    expect(getSettings(db).gpuProbe?.probedAt).toBe('2026-07-10T00:00:00.000Z')
  })

  // Enum-valued: a renderer bug must not persist junk like `gpuMode: 'banana'` (readers treat
  // anything but 'auto' as off, which fails safe, but junk must not be stored either).
  it("gpuMode accepts only 'auto' or 'off'; junk keeps the prior value", () => {
    const db = freshDb()
    expect(updateSettings(db, { gpuMode: 'off' }).gpuMode).toBe('off')
    updateSettings(db, { gpuMode: 'banana' } as JunkPatch)
    expect(rawSetting(db, 'gpuMode')).toBe('off')
    expect(updateSettings(db, { gpuMode: 'auto' }).gpuMode).toBe('auto')
  })

  // #858: Settings and Privacy read workspaceMode to say "encrypted" and to offer Change password.
  it("workspaceMode accepts only 'encrypted' or 'plaintext_dev'; junk keeps the prior value (#858)", () => {
    const db = freshDb()
    expect(updateSettings(db, { workspaceMode: 'encrypted' }).workspaceMode).toBe('encrypted')
    updateSettings(db, { workspaceMode: 'banana' } as JunkPatch)
    expect(rawSetting(db, 'workspaceMode')).toBe('encrypted')
    expect(updateSettings(db, { workspaceMode: 'plaintext_dev' }).workspaceMode).toBe('plaintext_dev')
  })
})

// CODE-16 (full-audit 2026-07-11): the object-valued settings accepted UNBOUNDED payloads from
// the renderer (a shape check only), and `checksumCache` (non-null object default) let an ARRAY
// slip through the generic `typeof value !== typeof def` gate (arrays report `object`). Both are
// bounded now, SEC-1 style: a >256 KB serialized blob is dropped, and an array for an
// object-default key is rejected.
describe('settings write gate — object-valued size cap + array rejection (CODE-16)', () => {
  it('drops an oversized lastBenchmark blob (serialized JSON over the cap)', () => {
    const db = freshDb()
    // A healthy small blob persists…
    updateSettings(db, { lastBenchmark: LEGACY_BENCH })
    expect(getSettings(db).lastBenchmark?.profile).toBe('BALANCED')
    // …an over-cap payload is dropped, leaving the prior value untouched. PR #303 audit P4: the
    // bloat has to ride a REAL field now (`cpuModel`) — an unknown key is stripped by the H1
    // validator before the cap ever sees it, which would leave this pinning nothing.
    const huge = { profile: 'BALANCED', cpuModel: 'x'.repeat(MAX_OBJECT_BYTES + 1) } as unknown as Bench
    updateSettings(db, { lastBenchmark: huge })
    expect(getSettings(db).lastBenchmark?.profile).toBe('BALANCED')
    expect(getSettings(db).lastBenchmark?.cpuModel).toBe('')
  })

  it('drops an oversized checksumCache blob and rejects an ARRAY for the object-default key', () => {
    const db = freshDb()
    // Array slips through `typeof [] === 'object'` for the non-null object default — reject it.
    updateSettings(db, { checksumCache: [{ size: 1, mtimeMs: 2, sha256: 'a' }] } as JunkPatch)
    expect(getSettings(db).checksumCache).toEqual({})
    // A healthy map persists…
    updateSettings(db, { checksumCache: { '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'abc' } } })
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc')
    // …but an over-cap map is dropped (prior value survives).
    const bloat: Record<string, { size: number; mtimeMs: number; sha256: string }> = {}
    for (let i = 0; JSON.stringify(bloat).length <= MAX_OBJECT_BYTES; i++) {
      bloat[`/weight-${i}.gguf`] = { size: i, mtimeMs: i, sha256: 'f'.repeat(64) }
    }
    updateSettings(db, { checksumCache: bloat })
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc') // unchanged; the bloat was dropped
    expect(getSettings(db).checksumCache['/weight-0.gguf']).toBeUndefined()
    // One character over the cap is dropped and exactly at it is stored, so the pinned value holds
    // the bound from both sides (the bloat above overshoots it by up to one entry).
    const padded = (pad: number): Record<string, { size: number; mtimeMs: number; sha256: string }> => ({
      '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'a'.repeat(pad) }
    })
    const fill = MAX_OBJECT_BYTES - JSON.stringify(padded(0)).length
    const atCap = padded(fill)
    expect(JSON.stringify(atCap)).toHaveLength(MAX_OBJECT_BYTES)
    updateSettings(db, { checksumCache: padded(fill + 1) })
    expect(rawSetting(db, 'checksumCache')).toEqual({ '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'abc' } })
    updateSettings(db, { checksumCache: atCap })
    expect(rawSetting(db, 'checksumCache')).toEqual(atCap)
  })

  it('gpuProbe honours the same serialized-size cap', () => {
    const db = freshDb()
    // A healthy small probe persists…
    updateSettings(db, { gpuProbe: { devices: [], probedAt: '2026-07-10T00:00:00.000Z' } })
    expect(getSettings(db).gpuProbe?.probedAt).toBe('2026-07-10T00:00:00.000Z')
    // …an over-cap payload is dropped, leaving the prior value untouched. PR #303 audit P5: the
    // bloat has to ride a REAL field now (a device `name`) — an unknown key is stripped by
    // `normalizeGpuProbe` before the cap ever sees it, which would leave this pinning nothing.
    const huge = {
      devices: [{ id: 'Vulkan0', name: 'y'.repeat(MAX_OBJECT_BYTES + 1), totalMb: 1, freeMb: 1 }],
      probedAt: '2026-07-11T00:00:00.000Z'
    }
    updateSettings(db, { gpuProbe: huge })
    expect(getSettings(db).gpuProbe).toEqual({ devices: [], probedAt: '2026-07-10T00:00:00.000Z' })
  })

  // 10,001 one-character ids serialize to ~40 KB, far under the byte cap, so the element cap
  // (MAX_SETTINGS_ARRAY) is the only bound on a string[] setting's length.
  it('caps a string[] setting at 10,000 elements, a bound the byte cap alone does not reach', () => {
    const db = freshDb()
    const ids = Array.from({ length: 10_001 }, () => 'x')
    expect(updateSettings(db, { skillInfoSeen: ids }).skillInfoSeen).toHaveLength(10_000)
    expect(rawSetting(db, 'skillInfoSeen')).toHaveLength(10_000)
  })
})

// #868: the retrieval tuning keys stay renderer-writable (no screen writes them; a maintainer can tune
// them in the running app), so the write gate has to bound them. It checked only `typeof`: a negative
// top-k or a huge budget was stored, and NaN or Infinity, which survive the IPC's structured clone,
// were stored as `null` (JSON) and read back by retrieval and the reranker's request ceiling.
// The bounds that ship, pinned by value: a finite number is floored (the counts) and clamped, a
// non-finite one is dropped and the previous value kept (the `localApiPort` convention).
describe('settings write gate — retrieval tuning bounds (#868)', () => {
  type TuningKey = 'ragTopKInitial' | 'ragTopKFinal' | 'ragMaxContextTokens' | 'ragMinSimilarity' | 'contextTokens'

  it.each<[TuningKey, number, number]>([
    ['ragTopKInitial', 0, 1],
    ['ragTopKInitial', -5, 1],
    ['ragTopKInitial', 200, 200],
    ['ragTopKInitial', 201, 200],
    ['ragTopKInitial', 12.9, 12],
    ['ragTopKFinal', 0, 1],
    ['ragTopKFinal', 200, 200],
    ['ragTopKFinal', 1e9, 200],
    ['ragTopKFinal', 6.5, 6],
    ['ragMaxContextTokens', 255, 256],
    ['ragMaxContextTokens', -1, 256],
    ['ragMaxContextTokens', 131_072, 131_072],
    ['ragMaxContextTokens', 131_073, 131_072],
    ['ragMaxContextTokens', 2500.7, 2500],
    ['ragMinSimilarity', -0.5, 0],
    ['ragMinSimilarity', 1.5, 1],
    ['ragMinSimilarity', 0.42, 0.42],
    // The floor (2048) is db-settings.test.ts's row; the ceiling is new.
    ['contextTokens', 131_072, 131_072],
    ['contextTokens', 131_073, 131_072]
  ])('%s: %s is stored as %s', (key, written, stored) => {
    const db = freshDb()
    expect(updateSettings(db, { [key]: written })[key]).toBe(stored)
    expect(rawSetting(db, key)).toBe(stored)
  })

  it.each<[Exclude<TuningKey, 'contextTokens'>, number, number]>([
    ['ragTopKInitial', Number.NaN, 20],
    ['ragTopKInitial', Number.POSITIVE_INFINITY, 20],
    ['ragTopKFinal', Number.NEGATIVE_INFINITY, 8],
    ['ragMaxContextTokens', Number.NaN, 4000],
    ['ragMinSimilarity', Number.NaN, 0.3],
    ['ragMinSimilarity', Number.POSITIVE_INFINITY, 0.3]
  ])('%s: %s is dropped and the tuned value kept', (key, written, tuned) => {
    const db = freshDb()
    updateSettings(db, { [key]: tuned })
    expect(updateSettings(db, { [key]: written })[key]).toBe(tuned)
    expect(rawSetting(db, key)).toBe(tuned)
  })
})

describe('ragRerankWideScope (step 4-4, Wave 4 ruling (a) — the cpu-hi rerank profile opt-in)', () => {
  it('defaults OFF and round-trips true and back to false', () => {
    const db = freshDb()
    expect(getSettings(db).ragRerankWideScope).toBe(false)
    expect(updateSettings(db, { ragRerankWideScope: true }).ragRerankWideScope).toBe(true)
    expect(updateSettings(db, { ragRerankWideScope: false }).ragRerankWideScope).toBe(false)
  })
})

// ---- Local API settings (local-api wave P2) ---------------------------------------------

describe('local API settings (local-api P2)', () => {
  it('defaults: OFF, port 4980, token required (D3/D4)', () => {
    const db = freshDb()
    const s = getSettings(db)
    expect(s.localApiEnabled).toBe(false)
    expect(s.localApiPort).toBe(4980)
    expect(s.localApiTokenRequired).toBe(true)
  })

  it('round-trips the three keys and clamps the port to [1024, 65535]', () => {
    const db = freshDb()
    expect(updateSettings(db, { localApiEnabled: true }).localApiEnabled).toBe(true)
    expect(updateSettings(db, { localApiTokenRequired: false }).localApiTokenRequired).toBe(false)
    expect(updateSettings(db, { localApiPort: 4981 }).localApiPort).toBe(4981)
    expect(updateSettings(db, { localApiPort: 80 }).localApiPort).toBe(1024) // privileged -> floor
    expect(updateSettings(db, { localApiPort: 70_000 }).localApiPort).toBe(65_535)
    expect(updateSettings(db, { localApiPort: 4980.9 }).localApiPort).toBe(4980)
    // Non-finite junk is DROPPED, never defaulted: a customized port must survive a
    // buggy renderer patch (review 2026-08-18 — the contextTokensOverride convention).
    updateSettings(db, { localApiPort: 9000 })
    expect(updateSettings(db, { localApiPort: Number.NaN }).localApiPort).toBe(9000)
    expect(updateSettings(db, { localApiPort: Number.POSITIVE_INFINITY }).localApiPort).toBe(9000)
  })

  // The generic gate every boolean/number key shares: a value of another primitive type is
  // dropped, and null never clobbers a non-null default.
  it('rejects mistyped values (booleans/number only; null never clobbers)', () => {
    const db = freshDb()
    updateSettings(db, { localApiEnabled: 'yes' } as JunkPatch)
    expect(getSettings(db).localApiEnabled).toBe(false)
    updateSettings(db, { localApiPort: '4981' } as JunkPatch)
    expect(getSettings(db).localApiPort).toBe(4980)
    updateSettings(db, { localApiTokenRequired: null } as JunkPatch)
    expect(getSettings(db).localApiTokenRequired).toBe(true)
  })

  it('getSettings NEVER carries a secret-bearing key or the access-key value (audit A3)', async () => {
    const db = freshDb()
    // Mint the real token in its dedicated store, then prove the settings surface -- the
    // object the renderer receives on three IPC surfaces -- cannot leak it.
    const { getOrCreateToken } = await import('../../src/main/services/local-api/token')
    const token = getOrCreateToken(db)
    const s = getSettings(db)
    // The only /token/i keys are the known benign set; the secret has no settings key.
    const tokenKeys = Object.keys(s).filter((k) => /token/i.test(k)).sort()
    expect(tokenKeys).toEqual(
      ['contextTokens', 'contextTokensOverride', 'localApiTokenRequired', 'ragMaxContextTokens'].sort()
    )
    expect(typeof s.localApiTokenRequired).toBe('boolean')
    // And the serialized object contains neither the token value nor its hr- prefix.
    const serialized = JSON.stringify(s)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('hr-')
  })
})

// The key allowlist used `key in DEFAULT_SETTINGS`, which is true for INHERITED names: a
// renderer patch built as JSON.parse('{"__proto__": …}') carries an own `__proto__` property
// and passed the gate. No prototype pollution (JSON.parse never assigns a prototype), but a
// junk row of unbounded size in the encrypted settings blob, parsed on every unlock (#251).
// The gate is `Object.hasOwn` now and the byte cap applies to every non-primitive write.
// The pre-fix behaviour was reproduced during the review that raised #251 by a scratch test
// whose output was not archived; this block is its inverted, durable form: the write allowlist,
// the read allowlist and the generic cap, one row each. (The original block's control rows
// B, C, D, F and the double-revert row E could not fail under either guard's revert.)
describe('settings write gate — inherited keys are not settings (#251)', () => {
  // Built with JSON.parse: an object LITERAL `{ __proto__: … }` would set the prototype
  // instead of creating an own property, which is not what the IPC boundary delivers.
  function protoPatch(json: string): Partial<AppSettings> {
    const patch = JSON.parse(json) as Record<string, unknown>
    expect(Object.hasOwn(patch, '__proto__')).toBe(true)
    return patch as Partial<AppSettings>
  }

  it('A: a `__proto__` key writes no row', () => {
    const db = freshDb()
    updateSettings(db, protoPatch('{"__proto__": {"polluted": 1}}'))
    expect(rawSetting(db, '__proto__')).toBeUndefined()
  })

  // The planted row also carries `lastBenchmark`, a key this workspace has no row for (deleted,
  // as in a workspace written before the key existed). Read with an `in` check, the row would
  // become `stored`'s prototype and `lastBenchmark` would read through it; every other seeded
  // key has its own row, which shadows the prototype.
  it('a `__proto__` row left by an older build is ignored on read and sets no prototype', () => {
    const db = freshDb()
    db.prepare("DELETE FROM settings WHERE key = 'lastBenchmark'").run()
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      '__proto__',
      JSON.stringify({ theme: 'PWNED', polluted: 1, lastBenchmark: { profile: 'BALANCED' } }),
      new Date().toISOString()
    )
    const s = getSettings(db)
    expect(s.lastBenchmark).toBeNull()
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme)
    expect((s as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype)
  })

  it('the byte cap covers every non-primitive write, not only the three named object keys', () => {
    const db = freshDb()
    updateSettings(db, { skillInfoSeen: ['x'.repeat(MAX_OBJECT_BYTES + 1)] })
    expect(getSettings(db).skillInfoSeen).toEqual([])
    updateSettings(db, { skillInfoSeen: ['a', 'b'] })
    expect(getSettings(db).skillInfoSeen).toEqual(['a', 'b'])
  })
})
