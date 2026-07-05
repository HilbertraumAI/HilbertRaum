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
  buildModelList,
  clearChecksumCache,
  checksumCacheStats,
  createSettingsHashStore,
  invalidateChecksum,
  recommendModelId,
  recommendModelIdByRam,
  discoverManifests,
  selectModel,
  resolveManifestsDir,
  weightPath
} from '../../src/main/services/models'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import type { ModelVerifyProgress } from '../../src/shared/types'

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
    const dir = tempDir('hilbertraum-hash-')
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
    const res = await verifyChecksum(join(tempDir('hilbertraum-hash-'), 'nope.bin'), 'f'.repeat(64))
    expect(res).toEqual({ exists: false, matched: null, actual: null })
  })

  it('returns matched=null for a placeholder hash', async () => {
    const dir = tempDir('hilbertraum-hash-')
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
    const dir = tempDir('hilbertraum-hash-')
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
    const dir = tempDir('hilbertraum-hash-')
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
    const db = openDatabase(join(tempDir('hilbertraum-db-'), 'cache.sqlite'))
    seedSettings(db)
    return { store: createSettingsHashStore(db), db }
  }

  it('serves the hash from the DB after a simulated restart (no re-hash)', async () => {
    clearChecksumCache()
    const { store, db } = makeStore()
    const file = join(tempDir('hilbertraum-hash-'), 'weight.bin')
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
    const file = join(tempDir('hilbertraum-hash-'), 'weight.bin')
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
    const file = join(tempDir('hilbertraum-hash-'), 'weight.bin')
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
    // weightPath keeps its OWN runtime escape guard (defense in depth). validateManifest now
    // rejects such a path up front (vuln-scan 2026-06-21), so build the manifest object
    // directly to exercise weightPath's independent guard rather than the validation layer.
    const escaping: ModelManifest = { ...asManifest(), localPath: '../../etc/passwd' }
    expect(() => weightPath('/drive', escaping)).toThrow(/escapes the drive root/)
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
    const root = tempDir('hilbertraum-root-')
    mkdirSync(join(root, 'models', 'chat'), { recursive: true })
    writeFileSync(join(root, 'models', 'chat', 'qwen3-4b-instruct-q4.gguf'), content)
    return root
  }

  it('is missing when the weight file is absent', async () => {
    const root = tempDir('hilbertraum-root-')
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
    const root = tempDir('hilbertraum-root-')
    const state = await computeInstallState(asManifest({ runtime: 'onnx' }), root, {
      developerMode: true
    })
    expect(state).toBe('unsupported')
  })

  // Phase 36 fix: the support gate is a runtime↔format PAIR check. The whisper
  // transcriber (whisper_cpp + ggml) is supported — it used to fall through the
  // llama-only whitelist and show "Unsupported" on the AI Model screen, which also
  // hid its in-app download (the download offer requires state 'missing').
  it('supports the whisper transcriber pair (whisper_cpp + ggml)', async () => {
    const root = tempDir('hilbertraum-root-')
    const whisper = asManifest({
      id: 'whisper-small-multilingual',
      role: 'transcriber',
      runtime: 'whisper_cpp',
      format: 'ggml',
      local_path: 'models/transcriber/ggml-small.bin'
    })
    // Absent weights → 'missing' (downloadable), NOT 'unsupported'.
    expect(await computeInstallState(whisper, root, { developerMode: false })).toBe('missing')

    // Present + matching hash → installed.
    mkdirSync(join(root, 'models', 'transcriber'), { recursive: true })
    writeFileSync(join(root, 'models', 'transcriber', 'ggml-small.bin'), 'ggml-weights')
    const hash = createHash('sha256').update('ggml-weights').digest('hex')
    const verified = asManifest({
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
    const root = tempDir('hilbertraum-root-')
    const cases = [
      { runtime: 'whisper_cpp', format: 'gguf' },
      { runtime: 'llama_cpp', format: 'ggml' }
    ]
    for (const c of cases) {
      expect(
        await computeInstallState(asManifest(c), root, { developerMode: true }),
        `${c.runtime}+${c.format}`
      ).toBe('unsupported')
    }
  })
})

// Image-understanding plan §8.2: a vision model is TWO files (GGUF + mmproj); install state
// requires BOTH present + verified.
describe('computeInstallState — vision (both files verified)', () => {
  function visionManifest(overrides: Record<string, unknown> = {}): ModelManifest {
    return asManifest({
      id: 'qwen2.5-vl-3b-instruct-q4',
      role: 'vision',
      family: 'qwen2.5-vl',
      local_path: 'models/vision/vl.gguf',
      mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'REPLACE_WITH_REAL_HASH' },
      ...overrides
    })
  }
  function writeFile(root: string, rel: string, content: string): void {
    const dest = join(root, ...rel.split('/'))
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, content)
  }

  it('is missing when the GGUF is present but the mmproj is absent', async () => {
    const root = tempDir('hilbertraum-vision-')
    writeFile(root, 'models/vision/vl.gguf', 'lm')
    expect(await computeInstallState(visionManifest(), root, { developerMode: true })).toBe('missing')
  })

  it('is installed (dev) when both files are present with placeholder hashes', async () => {
    const root = tempDir('hilbertraum-vision-')
    writeFile(root, 'models/vision/vl.gguf', 'lm')
    writeFile(root, 'models/vision/mmproj.gguf', 'proj')
    expect(await computeInstallState(visionManifest(), root, { developerMode: true })).toBe('installed')
  })

  it('is installed when both files are present and BOTH hashes match', async () => {
    const root = tempDir('hilbertraum-vision-')
    writeFile(root, 'models/vision/vl.gguf', 'lm-bytes')
    writeFile(root, 'models/vision/mmproj.gguf', 'proj-bytes')
    const m = visionManifest({
      sha256: createHash('sha256').update('lm-bytes').digest('hex'),
      mmproj: {
        local_path: 'models/vision/mmproj.gguf',
        sha256: createHash('sha256').update('proj-bytes').digest('hex')
      }
    })
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('installed')
  })

  it('is checksum_failed when the mmproj hash does NOT match (the GGUF is fine)', async () => {
    const root = tempDir('hilbertraum-vision-')
    writeFile(root, 'models/vision/vl.gguf', 'lm-bytes')
    writeFile(root, 'models/vision/mmproj.gguf', 'proj-bytes')
    const m = visionManifest({
      sha256: createHash('sha256').update('lm-bytes').digest('hex'),
      mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'a'.repeat(64) }
    })
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('checksum_failed')
  })
})

// TG-1: the `translation` role is a plain single-file GGUF (llama_cpp), so install-state is
// role-agnostic — present + verified ⇒ installed, exactly like a chat weight. Guards the claim
// that discovery/install-state need no per-role code for the new role.
describe('computeInstallState — translation role (TG-1)', () => {
  function translationManifest(overrides: Record<string, unknown> = {}): ModelManifest {
    return asManifest({
      id: 'translategemma-12b-it-q4',
      role: 'translation',
      family: 'translategemma',
      license: 'gemma',
      local_path: 'models/translation/tg.gguf',
      ...overrides
    })
  }

  it('is missing when the weight is absent', async () => {
    const root = tempDir('hilbertraum-tg-')
    expect(await computeInstallState(translationManifest(), root, { developerMode: false })).toBe('missing')
  })

  it('is installed when the weight is present and its hash matches', async () => {
    const root = tempDir('hilbertraum-tg-')
    mkdirSync(join(root, 'models', 'translation'), { recursive: true })
    writeFileSync(join(root, 'models', 'translation', 'tg.gguf'), 'tg-weights')
    const hash = createHash('sha256').update('tg-weights').digest('hex')
    expect(
      await computeInstallState(translationManifest({ sha256: hash }), root, { developerMode: false })
    ).toBe('installed')
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

// Post-MVP: "which model do we recommend?" is a RAM question first. Best fit = the
// LARGEST model that runs comfortably (recommended_ram_gb fits); if nothing fits
// comfortably, the lightest model that at least meets its minimum; else null.
describe('recommendModelIdByRam', () => {
  const small = asManifest({
    id: 'small',
    size_on_disk_gb: 2.7,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16
  })
  const medium = asManifest({
    id: 'medium',
    size_on_disk_gb: 5.5,
    recommended_min_ram_gb: 16,
    recommended_ram_gb: 32
  })
  const large = asManifest({
    id: 'large',
    size_on_disk_gb: 9.5,
    recommended_min_ram_gb: 32,
    recommended_ram_gb: 64
  })
  const embed = asManifest({
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
    const winner = asManifest({ id: 'winner', size_on_disk_gb: 5.2, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 2 })
    const loser = asManifest({ id: 'loser', size_on_disk_gb: 5.3, recommended_min_ram_gb: 12, recommended_ram_gb: 16, recommendation_rank: 0 })
    // 16 GB: both comfortable + tie on recommended_ram_gb; rank picks the (smaller) winner,
    // where the old disk-size tiebreak would have picked the bigger loser.
    expect(recommendModelIdByRam([winner, loser], 16)).toBe('winner')
  })

  it('applies the rank tiebreak in the lightest-runnable fallback too', () => {
    const keep = asManifest({ id: 'keep', size_on_disk_gb: 2.7, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 2 })
    const alt = asManifest({ id: 'alt', size_on_disk_gb: 2.5, recommended_min_ram_gb: 8, recommended_ram_gb: 16, recommendation_rank: 1 })
    // 8 GB: neither comfortable; both runnable at min 8. Rank keeps the preferred 'keep' ahead
    // of the smaller 'alt' (e.g. the thinking-capable default over the instruct-only refresh).
    expect(recommendModelIdByRam([keep, alt], 8)).toBe('keep')
  })
})

describe('buildModelList — RAM gate', () => {
  function manifestsDirWith(...objs: Array<Record<string, unknown>>): string {
    const dir = tempDir('hilbertraum-manifests-')
    for (const [i, o] of objs.entries()) writeFileSync(join(dir, `m${i}.yaml`), stringify(o))
    return dir
  }

  it('flags models above the machine RAM and recommends the best RAM fit', async () => {
    const dir = manifestsDirWith(
      manifestObj({ id: 'fits', recommended_min_ram_gb: 8, recommended_ram_gb: 16 }),
      manifestObj({ id: 'too-big', recommended_min_ram_gb: 64, recommended_ram_gb: 128 })
    )
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: tempDir('hilbertraum-root-'),
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

  it('keeps the legacy profile-based behavior when machine RAM is not provided', async () => {
    const dir = manifestsDirWith(manifestObj({ id: 'lite-model', recommended_profiles: ['LITE'] }))
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: tempDir('hilbertraum-root-'),
      profile: 'LITE',
      developerMode: true
    })
    expect(models[0].recommended).toBe(true)
    expect(models[0].insufficientRam).toBe(false)
  })
})

// RT-3 lazy verification (the chat path): on a cold cache, the chat path
// (`onlyVerifyModelId`) must hash ONLY the active model, while the Models-screen path
// (no `onlyVerifyModelId`) hashes the full set. Inactive present weights are still reported
// `installed` (display-only — the start gate re-verifies what it launches).
describe('buildModelList — RT-3 lazy verification', () => {
  function manifestsDirWith(...objs: Array<Record<string, unknown>>): string {
    const dir = tempDir('hilbertraum-manifests-')
    for (const [i, o] of objs.entries()) writeFileSync(join(dir, `m${i}.yaml`), stringify(o))
    return dir
  }
  function writeWeight(rootPath: string, relPath: string, content: string): string {
    const p = join(rootPath, relPath)
    mkdirSync(parse(p).dir, { recursive: true })
    writeFileSync(p, content)
    return createHash('sha256').update(content).digest('hex')
  }
  function twoModels(): { dir: string; root: string } {
    const root = tempDir('hilbertraum-root-')
    const hA = writeWeight(root, 'models/chat/a.gguf', 'AAAA')
    const hB = writeWeight(root, 'models/chat/b.gguf', 'BBBBBBBB')
    const dir = manifestsDirWith(
      manifestObj({ id: 'a', local_path: 'models/chat/a.gguf', sha256: hA }),
      manifestObj({ id: 'b', local_path: 'models/chat/b.gguf', sha256: hB })
    )
    return { dir, root }
  }

  it('chat path (cold cache) hashes ONLY the active model; both still report installed', async () => {
    const { dir, root } = twoModels()
    clearChecksumCache()
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      onlyVerifyModelId: 'a' // the active model on the chat path
    })
    // Exactly one weight (the active 'a') was hashed — not the full set.
    expect(checksumCacheStats.computed).toBe(before + 1)
    const byId = Object.fromEntries(models.map((m) => [m.id, m.state]))
    expect(byId['a']).toBe('installed') // hashed + verified
    expect(byId['b']).toBe('installed') // present, reported without hashing (display-only)
  })

  it('Models-screen path (cold cache) hashes the FULL set', async () => {
    const { dir, root } = twoModels()
    clearChecksumCache()
    const before = checksumCacheStats.computed
    await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false
      // onlyVerifyModelId omitted ⇒ full hash
    })
    expect(checksumCacheStats.computed).toBe(before + 2)
  })

  it('lazy with no active model (null) hashes nothing', async () => {
    const { dir, root } = twoModels()
    clearChecksumCache()
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      onlyVerifyModelId: null
    })
    expect(checksumCacheStats.computed).toBe(before)
    expect(models.every((m) => m.state === 'installed')).toBe(true)
  })

  it('still serves a cached hash for an inactive model (honest checksum_failed)', async () => {
    const { dir, root } = twoModels()
    clearChecksumCache()
    // Warm the cache for both (full pass), then corrupt 'b' on disk WITHOUT changing the
    // cache: a later lazy pass should still surface the cached hash for free (and 'b' is
    // installed because its cached hash matched at warm time).
    await buildModelList({ manifestsDir: dir, rootPath: root, profile: 'UNKNOWN', developerMode: false })
    const before = checksumCacheStats.computed
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      onlyVerifyModelId: 'a'
    })
    // Cache hits ⇒ no new hashing for either model.
    expect(checksumCacheStats.computed).toBe(before)
    expect(models.find((m) => m.id === 'b')?.state).toBe('installed')
  })
})

// First-run verification progress (architecture.md "Model verification progress"): the
// `listModels`/`buildModelList` path streams a byte-weighted progress signal so the gate +
// Models screen can show a determinate bar instead of an opaque spinner while multi-GB
// weights hash for the first time.
describe('buildModelList — verification progress', () => {
  function manifestsDirWith(...objs: Array<Record<string, unknown>>): string {
    const dir = tempDir('hilbertraum-manifests-')
    for (const [i, o] of objs.entries()) writeFileSync(join(dir, `m${i}.yaml`), stringify(o))
    return dir
  }
  /** Write a weight at `<root>/<relPath>` and return its real SHA-256. */
  function writeWeight(rootPath: string, relPath: string, content: string): string {
    const p = join(rootPath, relPath)
    mkdirSync(parse(p).dir, { recursive: true })
    writeFileSync(p, content)
    return createHash('sha256').update(content).digest('hex')
  }

  it('emits a final exact-total progress event when a weight is hashed', async () => {
    clearChecksumCache()
    const file = join(tempDir('hilbertraum-hash-'), 'weight.bin')
    writeFileSync(file, 'progress payload')
    const seen: number[] = []
    await sha256File(file, (b) => seen.push(b))
    // Small file < the 64 MB throttle ⇒ exactly one (final flush) call with the byte total.
    expect(seen).toEqual([Buffer.byteLength('progress payload')])
  })

  it('reports byte-weighted progress across the models that hash', async () => {
    clearChecksumCache()
    const root = tempDir('hilbertraum-root-')
    const h1 = writeWeight(root, 'models/chat/a.gguf', 'AAAA') // 4 bytes
    const h2 = writeWeight(root, 'models/chat/b.gguf', 'BBBBBBBB') // 8 bytes
    const dir = manifestsDirWith(
      manifestObj({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h1 }),
      manifestObj({ id: 'b', local_path: 'models/chat/b.gguf', sha256: h2 })
    )
    const events: ModelVerifyProgress[] = []
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: false,
      onProgress: (p) => events.push(p)
    })
    expect(models.every((m) => m.state === 'installed')).toBe(true)

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
    clearChecksumCache()
    const root = tempDir('hilbertraum-root-')
    const h = writeWeight(root, 'models/chat/a.gguf', 'cached weights')
    const dir = manifestsDirWith(manifestObj({ id: 'a', local_path: 'models/chat/a.gguf', sha256: h }))
    const db = openDatabase(join(tempDir('hilbertraum-db-'), 'c.sqlite'))
    seedSettings(db)
    const store = createSettingsHashStore(db)

    const opts = { manifestsDir: dir, rootPath: root, profile: 'UNKNOWN' as const, developerMode: false, hashStore: store }
    await buildModelList(opts) // warm the cache
    const events: ModelVerifyProgress[] = []
    await buildModelList({ ...opts, onProgress: (p) => events.push(p) })
    expect(events).toEqual([])
  })

  it('excludes missing and placeholder-hash weights from the byte denominator', async () => {
    clearChecksumCache()
    const root = tempDir('hilbertraum-root-')
    const real = writeWeight(root, 'models/chat/real.gguf', 'REAL') // 4 bytes, will hash
    // placeholder hash (default fixture) → never hashed; missing file → never hashed.
    const dir = manifestsDirWith(
      manifestObj({ id: 'real', local_path: 'models/chat/real.gguf', sha256: real }),
      manifestObj({ id: 'placeholder', local_path: 'models/chat/placeholder.gguf' }),
      manifestObj({ id: 'missing', local_path: 'models/chat/missing.gguf', sha256: 'f'.repeat(64) })
    )
    const events: ModelVerifyProgress[] = []
    await buildModelList({
      manifestsDir: dir,
      rootPath: root,
      profile: 'UNKNOWN',
      developerMode: true, // placeholder counts as installed, still not hashed
      onProgress: (p) => events.push(p)
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.overallBytesTotal === 4)).toBe(true)
    expect(events.every((e) => e.modelCount === 1)).toBe(true)
  })
})

describe('discoverManifests', () => {
  function writeManifest(dir: string, name: string, obj: unknown): void {
    writeFileSync(join(dir, name), stringify(obj))
  }

  it('parses valid manifests and reports invalid ones', () => {
    const dir = tempDir('hilbertraum-manifests-')
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
    const dir = tempDir('hilbertraum-manifests-')
    writeManifest(dir, 'a.yaml', manifestObj())
    writeManifest(dir, 'b.yaml', manifestObj())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
    expect(res.errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })

  it('recurses into subdirectories', () => {
    const dir = tempDir('hilbertraum-manifests-')
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeManifest(join(dir, 'chat'), 'm.yaml', manifestObj())
    const res = discoverManifests(dir)
    expect(res.manifests.length).toBe(1)
  })
})

describe('resolveManifestsDir', () => {
  it('honours an explicit override that exists', () => {
    const dir = tempDir('hilbertraum-manifests-')
    expect(resolveManifestsDir('/somewhere', dir)).toBe(dir)
  })
  it('falls back to the walk-up when the override path is missing (M21)', () => {
    const root = tempDir('hilbertraum-up-fallback-')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    expect(resolveManifestsDir(root, join(root, 'no-such-dir'))).toBe(mdir)
  })
  it('finds model-manifests by walking up', () => {
    const root = tempDir('hilbertraum-up-')
    const mdir = join(root, 'model-manifests')
    mkdirSync(mdir, { recursive: true })
    const deep = join(root, 'apps', 'desktop', 'out', 'main')
    mkdirSync(deep, { recursive: true })
    expect(resolveManifestsDir(deep)).toBe(mdir)
  })
  it('returns null when nothing is found', () => {
    expect(resolveManifestsDir(tempDir('hilbertraum-empty-'))).toBe(null)
  })
})

describe('selectModel', () => {
  function setup(): { dbPath: string; manifestsDir: string } {
    const manifestsDir = tempDir('hilbertraum-manifests-')
    writeFileSync(join(manifestsDir, 'chat.yaml'), stringify(manifestObj()))
    writeFileSync(
      join(manifestsDir, 'embed.yaml'),
      stringify(manifestObj({ id: 'embed', role: 'embeddings' }))
    )
    const dbPath = join(tempDir('hilbertraum-db-'), 'test.sqlite')
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

  // Phase 36 fix: availability-driven roles have no settings slot. The old
  // role-else-chat fallback would have written a transcriber/reranker id into
  // activeModelId — the CHAT slot — and broken chat.
  it('refuses transcriber/reranker selections and leaves both slots untouched', () => {
    const { dbPath, manifestsDir } = setup()
    writeFileSync(
      join(manifestsDir, 'transcriber.yaml'),
      stringify(
        manifestObj({
          id: 'whisper-small-multilingual',
          role: 'transcriber',
          runtime: 'whisper_cpp',
          format: 'ggml',
          local_path: 'models/transcriber/ggml-small.bin'
        })
      )
    )
    const db = openDatabase(dbPath)
    seedSettings(db)
    expect(() => selectModel(db, manifestsDir, 'whisper-small-multilingual')).toThrow(
      /used automatically/
    )
    expect(getSettings(db).activeModelId).toBe(null)
    expect(getSettings(db).activeEmbeddingModelId).toBe(null)
  })

  // TG-1: the translation role is availability-driven too (like reranker/transcriber/vision) —
  // it has no settings slot, so selectModel must refuse it and leave both slots untouched.
  it('refuses a translation selection and leaves both slots untouched', () => {
    const { dbPath, manifestsDir } = setup()
    writeFileSync(
      join(manifestsDir, 'translation.yaml'),
      stringify(
        manifestObj({
          id: 'translategemma-12b-it-q4',
          role: 'translation',
          family: 'translategemma',
          license: 'gemma',
          local_path: 'models/translation/translategemma-12b-it.Q4_K_M.gguf'
        })
      )
    )
    const db = openDatabase(dbPath)
    seedSettings(db)
    expect(() => selectModel(db, manifestsDir, 'translategemma-12b-it-q4')).toThrow(/used automatically/)
    expect(getSettings(db).activeModelId).toBe(null)
    expect(getSettings(db).activeEmbeddingModelId).toBe(null)
  })
})
