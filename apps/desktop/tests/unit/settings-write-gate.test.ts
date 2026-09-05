import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  getSettings,
  MAX_SETTINGS_ERROR_LENGTH,
  MAX_SETTINGS_ID_LENGTH,
  MAX_SETTINGS_OBJECT_BYTES,
  seedSettings,
  updateSettings
} from '../../src/main/services/settings'
import { DEFAULT_SETTINGS, MAX_BENCHMARK_HISTORY, type AppSettings } from '../../src/shared/types'

// BE-1 (full-audit 2026-07-10): the write gate's generic type check had two holes —
// (a) `value === null` bypassed it for EVERY key, so `{ checksumCache: null }` persisted over
// the non-nullable `{}` default and every checksum-cache reader threw until the row was
// repaired (bricking the Models screen); (b) keys whose DEFAULT is null (activeModelId,
// activeEmbeddingModelId, lastBenchmark, gpuLastError, gpuProbe) carried no type information,
// so ANY JSON of any size persisted into the encrypted settings blob. These pin the closed
// gate; `contextTokensOverride` keeps its own clamp (settings-context-override.test.ts).

function freshDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-settings-gate-')), 'test.sqlite'))
  seedSettings(db)
  return db
}

describe('settings write gate — benchmarkHistory (the one array-of-objects setting)', () => {
  type History = AppSettings['benchmarkHistory']
  const entry = (cpuModel: string): History[number] =>
    ({ cpuModel, cpuCores: 8, ramGb: 16, os: 'linux', arch: 'x64', ranAt: '2026-09-05T00:00:00Z' }) as unknown as History[number]

  it('keeps plain-object entries, drops junk elements, and caps at MAX_BENCHMARK_HISTORY', () => {
    const db = freshDb()
    const junk = [entry('a'), 'nope', 42, null, ['no'], entry('b')] as unknown as History
    updateSettings(db, { benchmarkHistory: junk })
    expect(getSettings(db).benchmarkHistory.map((e) => e.cpuModel)).toEqual(['a', 'b'])

    const many = Array.from({ length: MAX_BENCHMARK_HISTORY + 3 }, (_, i) => entry(`m${i}`))
    updateSettings(db, { benchmarkHistory: many })
    expect(getSettings(db).benchmarkHistory).toHaveLength(MAX_BENCHMARK_HISTORY)
  })

  it('drops a non-array value and null (the default is a non-null array)', () => {
    const db = freshDb()
    updateSettings(db, { benchmarkHistory: [entry('keep')] })
    updateSettings(db, { benchmarkHistory: { not: 'an array' } as unknown as History })
    updateSettings(db, { benchmarkHistory: null as unknown as History })
    expect(getSettings(db).benchmarkHistory.map((e) => e.cpuModel)).toEqual(['keep'])
  })
})

describe('settings write gate (BE-1)', () => {
  it('drops null for keys whose default is non-null (checksumCache must stay an object)', () => {
    const db = freshDb()
    updateSettings(db, { checksumCache: null as never })
    expect(getSettings(db).checksumCache).toEqual({})
    // Null must not clobber a real persisted cache either.
    updateSettings(db, { checksumCache: { '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'abc' } } })
    updateSettings(db, { checksumCache: null as never })
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc')
    // Same hole applied to every non-nullable key — spot-check a boolean one.
    updateSettings(db, { allowNetwork: null as never })
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
    updateSettings(db, { activeModelId: {} as never })
    expect(getSettings(db).activeModelId).toBeNull()
    updateSettings(db, { activeModelId: 42 as never })
    expect(getSettings(db).activeModelId).toBeNull()
    updateSettings(db, { activeModelId: 'x'.repeat(MAX_SETTINGS_ID_LENGTH + 1) })
    expect(getSettings(db).activeModelId).toBeNull()
    expect(updateSettings(db, { activeModelId: 'qwen3-4b-instruct-q4' }).activeModelId).toBe(
      'qwen3-4b-instruct-q4'
    )
    updateSettings(db, { activeEmbeddingModelId: ['e5'] as never })
    expect(getSettings(db).activeEmbeddingModelId).toBeNull()
    expect(
      updateSettings(db, { activeEmbeddingModelId: 'e5-small-multilingual' }).activeEmbeddingModelId
    ).toBe('e5-small-multilingual')
  })

  it('gpuLastError accepts only a length-capped string (no multi-MB junk in the encrypted blob)', () => {
    const db = freshDb()
    updateSettings(db, { gpuLastError: { reason: 'boom' } as never })
    expect(getSettings(db).gpuLastError).toBeNull()
    updateSettings(db, { gpuLastError: 'x'.repeat(MAX_SETTINGS_ERROR_LENGTH + 1) })
    expect(getSettings(db).gpuLastError).toBeNull()
    // The real writer (persistGpuFailure) sends a ~2 kB timestamped reason — well under the cap.
    const reason = `2026-07-10T00:00:00.000Z — ${'e'.repeat(1990)}`
    expect(updateSettings(db, { gpuLastError: reason }).gpuLastError).toBe(reason)
  })

  it('lastBenchmark / gpuProbe accept plain objects only', () => {
    const db = freshDb()
    updateSettings(db, { lastBenchmark: 'junk' as never })
    expect(getSettings(db).lastBenchmark).toBeNull()
    updateSettings(db, { lastBenchmark: [1, 2, 3] as never })
    expect(getSettings(db).lastBenchmark).toBeNull()
    updateSettings(db, { lastBenchmark: { profile: 'FAST_LOCAL' } as never })
    expect(getSettings(db).lastBenchmark?.profile).toBe('FAST_LOCAL')
    updateSettings(db, { gpuProbe: 3.14 as never })
    expect(getSettings(db).gpuProbe).toBeNull()
    updateSettings(db, { gpuProbe: { devices: [], probedAt: '2026-07-10T00:00:00.000Z' } })
    expect(getSettings(db).gpuProbe?.probedAt).toBe('2026-07-10T00:00:00.000Z')
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
    updateSettings(db, { lastBenchmark: { profile: 'FAST_LOCAL' } as never })
    expect(getSettings(db).lastBenchmark?.profile).toBe('FAST_LOCAL')
    // …an over-cap payload is dropped, leaving the prior value untouched.
    const huge = { profile: 'FAST_LOCAL', junk: 'x'.repeat(MAX_SETTINGS_OBJECT_BYTES + 1) }
    updateSettings(db, { lastBenchmark: huge as never })
    expect(getSettings(db).lastBenchmark?.profile).toBe('FAST_LOCAL')
    expect((getSettings(db).lastBenchmark as unknown as { junk?: string }).junk).toBeUndefined()
  })

  it('drops an oversized checksumCache blob and rejects an ARRAY for the object-default key', () => {
    const db = freshDb()
    // Array slips through `typeof [] === 'object'` for the non-null object default — reject it.
    updateSettings(db, { checksumCache: [{ size: 1, mtimeMs: 2, sha256: 'a' }] as never })
    expect(getSettings(db).checksumCache).toEqual({})
    // A healthy map persists…
    updateSettings(db, { checksumCache: { '/w.gguf': { size: 1, mtimeMs: 2, sha256: 'abc' } } })
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc')
    // …but an over-cap map is dropped (prior value survives).
    const bloat: Record<string, { size: number; mtimeMs: number; sha256: string }> = {}
    for (let i = 0; bloat && JSON.stringify(bloat).length <= MAX_SETTINGS_OBJECT_BYTES; i++) {
      bloat[`/weight-${i}.gguf`] = { size: i, mtimeMs: i, sha256: 'f'.repeat(64) }
    }
    updateSettings(db, { checksumCache: bloat })
    expect(getSettings(db).checksumCache['/w.gguf']?.sha256).toBe('abc') // unchanged; the bloat was dropped
    expect(getSettings(db).checksumCache['/weight-0.gguf']).toBeUndefined()
  })

  it('gpuProbe honours the same serialized-size cap', () => {
    const db = freshDb()
    const huge = { devices: [], probedAt: '2026-07-10T00:00:00.000Z', junk: 'y'.repeat(MAX_SETTINGS_OBJECT_BYTES) }
    updateSettings(db, { gpuProbe: huge as never })
    expect(getSettings(db).gpuProbe).toBeNull()
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

  it('rejects mistyped values (booleans/number only; null never clobbers)', () => {
    // Whole-patch cast, not `as never` (the F-41 ratchet): these are deliberately-wrong
    // renderer payloads crossing the IPC boundary.
    type JunkPatch = Record<string, unknown>
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
// whose output was not archived; this block is its inverted, durable form.
describe('settings write gate — inherited keys are not settings (#251)', () => {
  function rowFor(db: Db, key: string): string | undefined {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row?.value_json
  }
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
    expect(rowFor(db, '__proto__')).toBeUndefined()
  })

  it('B: Object.prototype is untouched and the read-back carries no junk (control)', () => {
    const db = freshDb()
    updateSettings(db, protoPatch('{"__proto__": {"polluted": 1}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const s = getSettings(db) as unknown as Record<string, unknown>
    expect(s.polluted).toBeUndefined()
    expect(Object.hasOwn(s, 'polluted')).toBe(false)
  })

  it('C: a known key cannot be overridden through the prototype chain on a later read (control)', () => {
    const db = freshDb()
    updateSettings(db, protoPatch('{"__proto__": {"theme": "PWNED", "allowNetwork": false}}'))
    const s = getSettings(db)
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(s.allowNetwork).toBe(true)
  })

  it('D: a `constructor` payload writes no row and pollutes nothing', () => {
    const db = freshDb()
    updateSettings(db, { constructor: { prototype: { polluted2: 1 } } } as unknown as Partial<AppSettings>)
    expect(rowFor(db, 'constructor')).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined()
  })

  it('E: a 2 MB `__proto__` value is not stored (it used to persist unbounded)', () => {
    const db = freshDb()
    const patch = JSON.parse('{"__proto__": null}') as Record<string, unknown>
    Object.defineProperty(patch, '__proto__', {
      value: { junk: 'x'.repeat(2_000_000) },
      enumerable: true,
      writable: true,
      configurable: true
    })
    expect(Object.hasOwn(patch, '__proto__')).toBe(true)
    updateSettings(db, patch as Partial<AppSettings>)
    expect(rowFor(db, '__proto__')).toBeUndefined()
  })

  it('a `__proto__` row left by an older build is ignored on read and sets no prototype', () => {
    const db = freshDb()
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      '__proto__',
      '{"theme":"PWNED","polluted":1}',
      new Date().toISOString()
    )
    const s = getSettings(db)
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme)
    expect((s as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype)
  })

  it('F: the settings still read back after all of that (smoke)', () => {
    const db = freshDb()
    updateSettings(db, protoPatch('{"__proto__": {"polluted": 1}}'))
    updateSettings(db, { constructor: {} } as unknown as Partial<AppSettings>)
    const s = getSettings(db)
    expect(s).toBeDefined()
    expect(s.localApiPort).toBe(4980)
  })

  it('the byte cap covers every non-primitive write, not only the three named object keys', () => {
    const db = freshDb()
    updateSettings(db, { skillInfoSeen: ['x'.repeat(MAX_SETTINGS_OBJECT_BYTES + 1)] })
    expect(getSettings(db).skillInfoSeen).toEqual([])
    updateSettings(db, { skillInfoSeen: ['a', 'b'] })
    expect(getSettings(db).skillInfoSeen).toEqual(['a', 'b'])
  })
})
