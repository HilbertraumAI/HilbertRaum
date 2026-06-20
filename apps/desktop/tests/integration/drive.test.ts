import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DRIVE_OS_DIRS,
  driveLayoutDirs,
  buildDriveJson,
  buildPolicyJson,
  buildChecksumsJson,
  verifyDriveModels,
  planPrepareDrive
} from '../../src/main/services/drive'
import { resolvePaths } from '../../src/main/services/workspace'
import { parsePolicy, mergePolicyObject, DEFAULT_POLICY } from '../../src/main/services/policy'
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

/** Create a weight file under the drive root from its manifest local_path. */
function writeWeight(root: string, manifest: ModelManifest, content: string): void {
  const dest = join(root, ...manifest.localPath.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, content)
}

describe('drive layout', () => {
  it('lays out the directories the code reads, with win/mac/linux sidecar dirs', () => {
    const root = join(tmpdir(), 'hilbertraum-drive-x')
    const dirs = driveLayoutDirs(root)
    const rels = dirs.map((d) => d.slice(root.length + 1).replace(/\\/g, '/'))
    expect(rels).toContain('workspace')
    expect(rels).toContain('models/chat')
    expect(rels).toContain('models/embeddings')
    expect(rels).toContain('models/reranker') // Phase 21
    expect(rels).toContain('models/vision') // image-understanding §8.4
    expect(rels).toContain('model-manifests')
    expect(rels).toContain('model-manifests/vision') // image-understanding §8.4
    expect(rels).toContain('logs')
    expect(rels).toContain('config')
    for (const os of DRIVE_OS_DIRS) {
      expect(rels).toContain(`runtime/llama.cpp/${os}`)
    }
    // Must NOT use the spec's prose names (windows/macos/linux) — code uses win/mac/linux.
    expect(rels).not.toContain('runtime/llama.cpp/windows')
    expect(rels).not.toContain('runtime/llama.cpp/macos')
  })
})

describe('config generators', () => {
  it('drive.json is a valid prepared-drive marker resolvePaths detects', () => {
    const root = tempDir('hilbertraum-drive-')
    mkdirSync(join(root, 'config'), { recursive: true })
    const drive = buildDriveJson({ createdAt: '2026-06-09T00:00:00Z' })
    expect(drive.product).toBe('HilbertRaum')
    expect(drive.offline_by_default).toBe(true)
    expect(drive.allow_network_by_default).toBe(false)
    writeFileSync(join(root, 'config', 'drive.json'), JSON.stringify(drive))
    const paths = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'fallback') })
    expect(paths.isPreparedDrive).toBe(true)
  })

  it('policy.json (commercial default) denies network and is accepted by parsePolicy', () => {
    const json = buildPolicyJson()
    expect(json.network.allow_model_downloads).toBe(false)
    expect(json.network.allow_update_checks).toBe(false)
    // No `allow_telemetry` field — the app has no telemetry, so the knob is gone.
    expect('allow_telemetry' in json.network).toBe(false)
    expect(json.workspace.encryption_required).toBe(true)
    expect(json.workspace.allow_plaintext_dev_mode).toBe(false)
    expect(json.models.require_sha256_match).toBe(true)

    const policy = parsePolicy(JSON.stringify(json))
    expect(policy.network.allowModelDownloads).toBe(false)
    expect(policy.workspace.encryptionRequired).toBe(true)
    expect(policy.models.requireSha256Match).toBe(true)
  })

  it('policy.json (dev) allows plaintext + unverified but STILL denies network', () => {
    const json = buildPolicyJson({ dev: true })
    expect(json.workspace.allow_plaintext_dev_mode).toBe(true)
    expect(json.models.allow_unverified_models).toBe(true)
    // The non-negotiable guarantee: network is off even in dev.
    expect(json.network.allow_model_downloads).toBe(false)
    expect(json.network.allow_update_checks).toBe(false)

    const policy = mergePolicyObject(DEFAULT_POLICY, json)
    expect(policy.workspace.allowPlaintextDevMode).toBe(true)
    expect(policy.network.allowModelDownloads).toBe(false)
  })
})

describe('planPrepareDrive (dry-run)', () => {
  it('produces the full layout, config files, and weight destinations', () => {
    const root = tempDir('hilbertraum-plan-')
    const manifests = [asManifest(), asManifest({ id: 'embed', role: 'embeddings', local_path: 'models/embeddings/e5.gguf' })]
    const plan = planPrepareDrive(root, manifests, { createdAt: '2026-06-09T00:00:00Z' })

    expect(plan.dirsToCreate).toEqual(driveLayoutDirs(root))
    expect(plan.filesToWrite.map((f) => f.relPath)).toEqual(['config/drive.json', 'config/policy.json'])
    expect(plan.manifestsToCopy.sort()).toEqual(['embed.yaml', 'qwen3-4b-instruct-q4.yaml'])
    expect(plan.weightDestinations).toContain('models/chat/qwen3-4b-instruct-q4.gguf')
    expect(plan.weightDestinations).toContain('models/embeddings/e5.gguf')
    // No app-skills source supplied → nothing listed to copy (the scripts copy wholesale).
    expect(plan.appSkillsToCopy).toEqual([])
    expect(plan.configWouldOverwrite).toBe(false)
    // Generated JSON parses + round-trips.
    const drive = JSON.parse(plan.filesToWrite[0].contents)
    expect(drive.drive_format_version).toBe(1)
  })

  it('flags an existing config as would-overwrite', () => {
    const root = tempDir('hilbertraum-plan-')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    const plan = planPrepareDrive(root, [asManifest()])
    expect(plan.configWouldOverwrite).toBe(true)
  })

  // S9: when the repo app-skills/ source is supplied, the plan lists its product skills to copy
  // (a folder with a SKILL.md). A bare folder with no SKILL.md is not a skill and is skipped.
  it('lists app skills to copy from the supplied app-skills source', () => {
    const root = tempDir('hilbertraum-plan-')
    const appSkillsDir = join(tempDir('hilbertraum-appskills-'), 'app-skills')
    for (const id of ['bank-statement', 'contract-review']) {
      mkdirSync(join(appSkillsDir, id), { recursive: true })
      writeFileSync(join(appSkillsDir, id, 'SKILL.md'), `---\nid: ${id}\ntitle: ${id}\ndescription: d\nversion: 1.0.0\n---\nb`)
    }
    mkdirSync(join(appSkillsDir, 'not-a-skill'), { recursive: true }) // no SKILL.md → skipped
    const plan = planPrepareDrive(root, [asManifest()], { appSkillsDir })
    expect(plan.appSkillsToCopy).toEqual(['bank-statement', 'contract-review'])
  })
})

describe('verifyDriveModels', () => {
  it('reports missing / placeholder / verified / mismatch / unsupported honestly', async () => {
    const root = tempDir('hilbertraum-verify-')
    const real = asManifest({ id: 'real', local_path: 'models/chat/real.gguf' })
    const placeholder = asManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })
    const mismatch = asManifest({
      id: 'mm',
      local_path: 'models/chat/mm.gguf',
      sha256: 'a'.repeat(64)
    })
    const missing = asManifest({ id: 'gone', local_path: 'models/chat/gone.gguf' })
    const unsupported = asManifest({ id: 'onnx', runtime: 'onnx', local_path: 'models/chat/x.onnx' })

    writeWeight(root, placeholder, 'data')
    writeWeight(root, mismatch, 'data')
    const realContent = 'real-weights'
    writeWeight(root, real, realContent)
    const realHash = createHash('sha256').update(realContent).digest('hex')
    const realFixed = asManifest({ id: 'real', local_path: 'models/chat/real.gguf', sha256: realHash })

    const results = await verifyDriveModels(root, [realFixed, placeholder, mismatch, missing, unsupported])
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]))
    expect(byId.real).toBe('verified')
    expect(byId.ph).toBe('unverified_placeholder')
    expect(byId.mm).toBe('mismatch')
    expect(byId.gone).toBe('missing')
    expect(byId.onnx).toBe('unsupported')
  })
})

describe('buildChecksumsJson (generate mode)', () => {
  it('captures real hashes for present weights and null for absent', async () => {
    const root = tempDir('hilbertraum-sums-')
    const present = asManifest({ id: 'present', local_path: 'models/chat/present.gguf' })
    const absent = asManifest({ id: 'absent', local_path: 'models/chat/absent.gguf' })
    writeWeight(root, present, 'abc')
    const expected = createHash('sha256').update('abc').digest('hex')

    const sums = await buildChecksumsJson(root, [present, absent], '2026-06-09T00:00:00Z')
    expect(sums.algorithm).toBe('sha256')
    const presentEntry = sums.entries.find((e) => e.id === 'present')!
    expect(presentEntry.present).toBe(true)
    expect(presentEntry.sha256).toBe(expected)
    expect(presentEntry.size_bytes).toBe(3)
    const absentEntry = sums.entries.find((e) => e.id === 'absent')!
    expect(absentEntry.present).toBe(false)
    expect(absentEntry.sha256).toBe(null)
  })
})
