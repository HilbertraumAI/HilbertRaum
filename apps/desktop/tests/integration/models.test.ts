import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { openDatabase } from '../../src/main/services/db'
import { seedSettings, getSettings } from '../../src/main/services/settings'
import {
  sha256File,
  verifyChecksum,
  computeInstallState,
  recommendModelId,
  discoverManifests,
  selectModel,
  resolveManifestsDir
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
