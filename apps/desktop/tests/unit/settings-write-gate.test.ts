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
