import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { stringify } from 'yaml'
import { openDatabase } from '../../src/main/services/db'
import { seedSettings, getSettings } from '../../src/main/services/settings'
import {
  sha256File,
  verifyChecksum,
  computeInstallState,
  clearChecksumCache,
  checksumCacheStats,
  createSettingsHashStore,
  invalidateChecksum,
  recommendModelId,
  discoverManifests,
  selectModel,
  resolveManifestsDir,
  weightPath
} from '../../src/main/services/models'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function manifestObj(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'qwen3-4b-instruct-q4',
    display_name: 'Qwen3 4B Instruct Q4',
    family: 'qwen3',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    size_on_disk_gb: 2.7,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16,
    recommended_context_tokens: 4096,
    local_path: 'models/chat/qwen3-4b-instruct-q4.gguf',
    sha256: 'REPLACE_WITH_REAL_HASH',
    recommended_profiles: ['LITE'],
    license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' },
    ...overrides
  }
}

function asManifest(overrides: Record<string, unknown> = {}): ModelManifest {
  const res = validateManifest(manifestObj(overrides))
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

describe('checksum verification', () => {
  it('hashes a file and matches its own SHA-256', async () => {
    const dir = tempDir('paid-hash-')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'hello world')
    const expected = createHash('sha256').update('hello world').digest('hex')

    expect(await sha256File(file)).toBe(expected)

    const ok = await verifyChecksum(file, expected)
    expect(ok).toEqual({ exists: true, matched: true, actual: expected })

    const bad = await verifyChecksum(file, 'f'.repeat(64))
    expect(bad.matched).toBe(false)
  })

  it('reports a missing file', async () => {
    const res = await verifyChecksum(join(tempDir('paid-hash-'), 'nope.bin'), 'f'.repeat(64))
    expect(res).toEqual({ exists: false, matched: null, actual: null })
  })

  it('returns matched=null for a placeholder hash', async () => {
    const dir = tempDir('paid-hash-')
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
    clearChecksumCache()
    const dir = tempDir('paid-hash-')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'big model weights')
    const expected = createHash('sha256').update('big model weights').digest('hex')

    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)

    // Second + third verification: cache hit, no re-hash, same result.
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect((await verifyChecksum(file, expected)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('re-hashes when the file changes, so a swapped weight is still detected', async () => {
    clearChecksumCache()
    const dir = tempDir('paid-hash-')
    const file = join(dir, 'weight.bin')
    writeFileSync(file, 'original')
    const originalHash = createHash('sha256').update('original').digest('hex')
    expect((await verifyChecksum(file, originalHash)).matched).toBe(true)

    const before = checksumCacheStats.computed
    writeFileSync(file, 'tampered-or-updated') // different size → cache invalid
    const res = await verifyChecksum(file, originalHash)
    expect(res.matched).toBe(false)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })
})

// Post-MVP: the in-memory cache dies with the session, so the FIRST Models/Chat visit
// after every app start still re-hashed multi-GB weights. The settings-backed store
// persists (path, size, mtime, sha256) inside the DB so an unchanged file is hashed
// once EVER; size/mtime changes and the explicit "Verify checksum" force a real re-hash.
describe('persistent checksum cache (settings hash store)', () => {
  function makeStore(): { store: ReturnType<typeof createSettingsHashStore>; db: ReturnType<typeof openDatabase> } {
    const db = openDatabase(join(tempDir('paid-db-'), 'cache.sqlite'))
    seedSettings(db)
    return { store: createSettingsHashStore(db), db }
  }

  it('serves the hash from the DB after a simulated restart (no re-hash)', async () => {
    clearChecksumCache()
    const { store, db } = makeStore()
    const file = join(tempDir('paid-hash-'), 'weight.bin')
    writeFileSync(file, 'persisted weights')
    const expected = createHash('sha256').update('persisted weights').digest('hex')

    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
    expect(getSettings(db).checksumCache[file]?.sha256).toBe(expected)

    clearChecksumCache() // simulate an app restart (in-memory L1 gone, DB survives)
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1) // served from the store
  })

  it('re-hashes when the file content/size changed since the persisted entry', async () => {
    clearChecksumCache()
    const { store } = makeStore()
    const file = join(tempDir('paid-hash-'), 'weight.bin')
    writeFileSync(file, 'original')
    const originalHash = createHash('sha256').update('original').digest('hex')
    expect((await verifyChecksum(file, originalHash, store)).matched).toBe(true)

    clearChecksumCache()
    writeFileSync(file, 'replaced with another model') // different size → entry invalid
    const before = checksumCacheStats.computed
    const res = await verifyChecksum(file, originalHash, store)
    expect(res.matched).toBe(false)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })

  it('invalidateChecksum drops memory + store so the next verify truly re-hashes', async () => {
    clearChecksumCache()
    const { store, db } = makeStore()
    const file = join(tempDir('paid-hash-'), 'weight.bin')
    writeFileSync(file, 'weights')
    const expected = createHash('sha256').update('weights').digest('hex')
    await verifyChecksum(file, expected, store)
    expect(getSettings(db).checksumCache[file]).toBeDefined()

    invalidateChecksum(file, store)
    expect(getSettings(db).checksumCache[file]).toBeUndefined()
    const before = checksumCacheStats.computed
    expect((await verifyChecksum(file, expected, store)).matched).toBe(true)
    expect(checksumCacheStats.computed).toBe(before + 1)
  })
})

describe('weightPath', () => {
  it('resolves a normal relative local_path under the drive root', () => {
    const p = weightPath('/drive', asManifest())
    expect(p).toBe(join('/drive', 'models/chat/qwen3-4b-instruct-q4.gguf'))
  })

  it('rejects a local_path that escapes the drive root', () => {
    expect(() => weightPath('/drive', asManifest({ local_path: '../../etc/passwd' }))).toThrow(
      /escapes the drive root/
    )
  })

  it('accepts a bare drive/filesystem root that already ends in a separator', () => {
    // A portable drive is launched from a bare root (e.g. `D:\`). resolve() keeps the
    // trailing separator there, so a naive `base + sep` containment check would double it
    // (`D:\\`) and wrongly reject every weight. Regression for the D:\ launch bug.
    const root = parse(process.cwd()).root // `C:\` on Windows, `/` on POSIX
    expect(() => weightPath(root, asManifest())).not.toThrow()
    expect(weightPath(root, asManifest())).toBe(join(root, 'models/chat/qwen3-4b-instruct-q4.gguf'))
  })
})

describe('computeInstallState', () => {
  function rootWithWeight(content: string): string {
    const root = tempDir('paid-root-')
    mkdirSync(join(root, 'models', 'chat'), { recursive: true })
    writeFileSync(join(root, 'models', 'chat', 'qwen3-4b-instruct-q4.gguf'), content)
    return root
  }

  it('is missing when the weight file is absent', async () => {
    const root = tempDir('paid-root-')
    const state = await computeInstallState(asManifest(), root, { developerMode: true })
    expect(state).toBe('missing')
  })

  it('is installed when present and the hash matches', async () => {
    const root = rootWithWeight('weights')
    const hash = createHash('sha256').update('weights').digest('hex')
    const state = await computeInstallState(asManifest({ sha256: hash }), root, {
      developerMode: false
    })
    expect(state).toBe('installed')
  })

  it('is checksum_failed when the hash mismatches', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(asManifest({ sha256: 'a'.repeat(64) }), root, {
      developerMode: false
    })
    expect(state).toBe('checksum_failed')
  })

  it('treats a placeholder hash as installed in developer mode', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(asManifest(), root, { developerMode: true })
    expect(state).toBe('installed')
  })

  it('treats a placeholder hash as checksum_failed outside developer mode', async () => {
    const root = rootWithWeight('weights')
    const state = await computeInstallState(asManifest(), root, { developerMode: false })
    expect(state).toBe('checksum_failed')
  })

  it('never hashes a placeholder-hash weight (H5: pure wasted I/O on a multi-GB file)', async () => {
    clearChecksumCache()
    const root = rootWithWeight('weights')
    const before = checksumCacheStats.computed
    await computeInstallState(asManifest(), root, { developerMode: true })
    await computeInstallState(asManifest(), root, { developerMode: false })
    expect(checksumCacheStats.computed).toBe(before)
  })

  it('is unsupported for an unknown runtime/format', async () => {
    const root = tempDir('paid-root-')
    const state = await computeInstallState(asManifest({ runtime: 'onnx' }), root, {
      developerMode: true
    })
    expect(state).toBe('unsupported')
  })
})

describe('recommendModelId', () => {
  const tiny = asManifest({ id: 'tiny', recommended_profiles: ['TINY', 'UNKNOWN'] })
  const lite = asManifest({ id: 'lite', recommended_profiles: ['LITE'] })
  const embed = asManifest({
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

describe('discoverManifests', () => {
  function writeManifest(dir: string, name: string, obj: unknown): void {
    writeFileSync(join(dir, name), stringify(obj))
  }

  it('parses valid manifests and reports invalid ones', () => {
    const dir = tempDir('paid-manifests-')
    writeManifest(dir, 'good.yaml', manifestObj())
    writeManifest(dir, 'embed.yml', manifestObj({ id: 'embed', role: 'embeddings' }))
    writeManifest(dir, 'bad.yaml', { id: 'broken' }) // missing required fields
    writeFileSync(join(dir, 'notes.txt'), 'ignored') // non-manifest file skipped

    const res = discoverManifests(dir)
    expect(res.manifests.map((m) => m.manifest.id).sort()).toEqual(['embed', 'qwen3-4b-instruct-q4'])
    expect(res.errors.length).toBe(1)
    expect(res.errors[0]).toContain('bad.yaml')
  })

  it('flags duplicate ids', () => {
    const dir = tempDir('paid-manifests-')
    writeManifest(dir, 'a.yaml', manifestObj())
    writeManifest(dir, 'b.yaml', manifestObj())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
    expect(res.errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })

  it('recurses into subdirectories', () => {
    const dir = tempDir('paid-manifests-')
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeManifest(join(dir, 'chat'), 'm.yaml', manifestObj())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
  })
})

describe('resolveManifestsDir', () => {
  it('honours an explicit override that exists', () => {
    const dir = tempDir('paid-manifests-')
    expect(resolveManifestsDir('/somewhere', dir)).toBe(dir)
  })
  it('falls back to the walk-up when the override path is missing (M21)', () => {
    const root = tempDir('paid-up-fallback-')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    expect(resolveManifestsDir(root, join(root, 'no-such-dir'))).toBe(mdir)
  })
  it('finds model-manifests by walking up', () => {
    const root = tempDir('paid-up-')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    const deep = join(root, 'apps', 'desktop', 'out', 'main')
    mkdirSync(deep, { recursive: true })
    expect(resolveManifestsDir(deep)).toBe(mdir)
  })
  it('returns null when nothing is found', () => {
    expect(resolveManifestsDir(tempDir('paid-empty-'))).toBe(null)
  })
})

describe('selectModel', () => {
  function setup(): { dbPath: string; manifestsDir: string } {
    const manifestsDir = tempDir('paid-manifests-')
    writeFileSync(join(manifestsDir, 'chat.yaml'), stringify(manifestObj()))
    writeFileSync(
      join(manifestsDir, 'embed.yaml'),
      stringify(manifestObj({ id: 'embed', role: 'embeddings' }))
    )
    const dbPath = join(tempDir('paid-db-'), 'test.sqlite')
    return { dbPath, manifestsDir }
  }

  it('persists a chat selection to activeModelId', () => {
    const { dbPath, manifestsDir } = setup()
    const db = openDatabase(dbPath)
    seedSettings(db)
    const res = selectModel(db, manifestsDir, 'qwen3-4b-instruct-q4')
    expect(res.activeModelId).toBe('qwen3-4b-instruct-q4')
    expect(getSettings(db).activeModelId).toBe('qwen3-4b-instruct-q4')
  })

  it('persists an embedding selection to activeEmbeddingModelId', () => {
    const { dbPath, manifestsDir } = setup()
    const db = openDatabase(dbPath)
    seedSettings(db)
    const res = selectModel(db, manifestsDir, 'embed')
    expect(res.activeEmbeddingModelId).toBe('embed')
    expect(getSettings(db).activeModelId).toBe(null) // chat slot untouched
  })

  it('throws on an unknown model id', () => {
    const { dbPath, manifestsDir } = setup()
    const db = openDatabase(dbPath)
    seedSettings(db)
    expect(() => selectModel(db, manifestsDir, 'nope')).toThrow()
  })
})
