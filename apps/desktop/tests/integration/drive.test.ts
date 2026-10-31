import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  driveLayoutDirs,
  buildDriveJson,
  buildPolicyJson,
  buildChecksumsJson,
  verifyDriveModels,
  planPrepareDrive
} from '../../src/main/services/drive'
import { resolvePaths } from '../../src/main/services/workspace'
import { parsePolicy, STRICT_POLICY } from '../../src/main/services/policy'
import type { ModelManifest } from '../../src/shared/manifest'
import { tempRoot } from '../helpers/db-fixtures'
import { sha256, validManifest, visionManifest, writeDriveFile } from '../helpers/manifest-fixtures'

describe('drive layout', () => {
  it('lays out the directories the code reads, with win/mac/linux sidecar dirs', () => {
    const root = join(tmpdir(), 'hilbertraum-drive-x')
    const dirs = driveLayoutDirs(root)
    const rels = dirs.map((d) => d.slice(root.length + 1).replace(/\\/g, '/'))
    // In creation order. The sidecar OS dirs are win/mac/linux, the keys llamaOsDir resolves, NOT the spec's windows/macos/linux.
    expect(rels).toEqual([
      'workspace',
      'app-skills',
      'user-skills',
      'models/chat',
      'models/embeddings',
      'models/reranker',
      'models/transcriber',
      'models/vision',
      'models/translation',
      'model-manifests',
      'model-manifests/vision',
      'model-manifests/translation',
      'runtime/llama.cpp/win',
      'runtime/llama.cpp/mac',
      'runtime/llama.cpp/linux',
      'runtime/whisper.cpp/win',
      'runtime/whisper.cpp/mac',
      'runtime/whisper.cpp/linux',
      'runtime/kiwix-tools/win',
      'runtime/kiwix-tools/mac',
      'runtime/kiwix-tools/linux',
      'ocr',
      'zim',
      'logs',
      'config',
      'docs'
    ])
  })
})

describe('config generators', () => {
  it("the generated drive.json has the marker's exact shape and path, and resolvePaths detects it", () => {
    const root = tempRoot('drive')
    mkdirSync(join(root, 'config'), { recursive: true })
    const drive = buildDriveJson({ createdAt: '2026-06-09T00:00:00Z' })
    expect(drive).toEqual({
      product: 'HilbertRaum',
      drive_format_version: 1,
      created_at: '2026-06-09T00:00:00Z',
      edition: 'lite',
      offline_by_default: true,
      models_dir: 'models',
      workspace_dir: 'workspace',
      allow_network_by_default: false
    })
    writeFileSync(join(root, 'config', 'drive.json'), JSON.stringify(drive))
    const paths = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'fallback') })
    expect(paths.isPreparedDrive).toBe(true)
  })

  it('policy.json (commercial default) permits model downloads but no phone-home, and is accepted by parsePolicy', () => {
    const json = buildPolicyJson()
    // Model downloads are a permitted, user-initiated, per-download-confirmed action (still
    // gated by the allowNetwork setting); update-checks stay off — the app never phones home.
    expect(json.network.allow_model_downloads).toBe(true)
    expect(json.network.allow_update_checks).toBe(false)
    // No `allow_telemetry` field — the app has no telemetry, so the knob is gone.
    expect('allow_telemetry' in json.network).toBe(false)
    expect(json.workspace.encryption_required).toBe(true)
    expect(json.workspace.allow_plaintext_dev_mode).toBe(false)
    expect(json.models.require_sha256_match).toBe(true)

    // Local API: commercial drives write an EXPLICIT false (owner decision O4).
    expect(json.network.allow_local_api).toBe(false)

    const policy = parsePolicy(JSON.stringify(json))
    expect(policy.network.allowModelDownloads).toBe(true)
    expect(policy.workspace.encryptionRequired).toBe(true)
    expect(policy.models.requireSha256Match).toBe(true)
    // The producer→consumer key coupling: what buildPolicyJson writes, parsePolicy reads.
    expect(policy.network.allowLocalApi).toBe(false)
  })

  it('policy.json (dev) allows plaintext + unverified; model downloads permitted, no phone-home', () => {
    const json = buildPolicyJson({ dev: true })
    expect(json.workspace.allow_plaintext_dev_mode).toBe(true)
    expect(json.models.allow_unverified_models).toBe(true)
    // Downloads permitted in both postures; update-checks stay off (the app never phones home).
    expect(json.network.allow_model_downloads).toBe(true)
    expect(json.network.allow_update_checks).toBe(false)
    // Dev drives leave the local-API ceiling open (setting still default-off).
    expect(json.network.allow_local_api).toBe(true)

    // A packaged build reading a dev drive: STRICT differs on every value, so each one proves the file was read.
    const policy = parsePolicy(JSON.stringify(json), undefined, STRICT_POLICY)
    expect(policy.workspace.allowPlaintextDevMode).toBe(true)
    expect(policy.workspace.encryptionRequired).toBe(false)
    expect(policy.models.allowUnverifiedModels).toBe(true)
    expect(policy.models.requireSha256Match).toBe(false)
    expect(policy.network.allowModelDownloads).toBe(true)
    expect(policy.network.allowLocalApi).toBe(true)
  })
})

describe('planPrepareDrive (dry-run)', () => {
  it('produces the full layout, config files, and weight destinations', () => {
    const root = tempRoot('plan')
    const manifests = [validManifest(), validManifest({ id: 'embed', role: 'embeddings', local_path: 'models/embeddings/e5.gguf' })]
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
    const root = tempRoot('plan')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    const plan = planPrepareDrive(root, [validManifest()])
    expect(plan.configWouldOverwrite).toBe(true)
  })

  // S9: when the repo app-skills/ source is supplied, the plan lists its product skills to copy
  // (a folder with a SKILL.md). A bare folder with no SKILL.md is not a skill and is skipped.
  it('lists app skills to copy from the supplied app-skills source', () => {
    const root = tempRoot('plan')
    const appSkillsDir = join(tempRoot('appskills'), 'app-skills')
    for (const id of ['bank-statement', 'contract-review']) {
      mkdirSync(join(appSkillsDir, id), { recursive: true })
      writeFileSync(join(appSkillsDir, id, 'SKILL.md'), `---\nid: ${id}\ntitle: ${id}\ndescription: d\nversion: 1.0.0\n---\nb`)
    }
    mkdirSync(join(appSkillsDir, 'not-a-skill'), { recursive: true }) // no SKILL.md → skipped
    const plan = planPrepareDrive(root, [validManifest()], { appSkillsDir })
    expect(plan.appSkillsToCopy).toEqual(['bank-statement', 'contract-review'])
  })
})

describe('verifyDriveModels', () => {
  it('reports missing / placeholder / verified / mismatch / unsupported honestly', async () => {
    const root = tempRoot('verify')
    const real = validManifest({ id: 'real', local_path: 'models/chat/real.gguf' })
    const placeholder = validManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })
    const mismatch = validManifest({
      id: 'mm',
      local_path: 'models/chat/mm.gguf',
      sha256: 'a'.repeat(64)
    })
    const missing = validManifest({ id: 'gone', local_path: 'models/chat/gone.gguf' })
    const unsupported = validManifest({ id: 'onnx', runtime: 'onnx', local_path: 'models/chat/x.onnx' })
    // Phase 36 fix: the bundled ggml/whisper_cpp transcriber has a real sha256 and MUST verify
    // by hash (not be falsely UNSUPPORTED, which would fail the ship gate). Mirrors the
    // computeInstallState pair-check + verify-models.{ps1,sh} gate (script-drift.test.ts).
    const whisperContent = 'ggml-whisper-weights'
    const whisper = validManifest({
      id: 'whisper',
      runtime: 'whisper_cpp',
      format: 'ggml',
      local_path: 'models/transcriber/ggml-small.bin',
      sha256: sha256(whisperContent)
    })

    writeDriveFile(root, placeholder.localPath, 'data')
    writeDriveFile(root, mismatch.localPath, 'data')
    writeDriveFile(root, whisper.localPath, whisperContent)
    const realHash = writeDriveFile(root, real.localPath, 'real-weights')
    const realFixed = validManifest({ id: 'real', local_path: 'models/chat/real.gguf', sha256: realHash })

    const results = await verifyDriveModels(root, [realFixed, placeholder, mismatch, missing, unsupported, whisper])
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]))
    expect(byId.real).toBe('verified')
    expect(byId.ph).toBe('unverified_placeholder')
    expect(byId.mm).toBe('mismatch')
    expect(byId.gone).toBe('missing')
    expect(byId.onnx).toBe('unsupported')
    expect(byId.whisper).toBe('verified') // ggml/whisper_cpp now verifies by SHA-256
  })
})

// DIST-2: a vision model is GGUF + mmproj; the verify/generate side must iterate BOTH so a
// half-installed vision drive (good GGUF, missing/corrupt projector) cannot pass the sell gate.
describe('verifyDriveModels — vision two-file fold (DIST-2)', () => {
  it('FAILS the model when the GGUF verifies but the mmproj projector is missing', async () => {
    const root = tempRoot('verify-vision')
    const m = visionManifest('gguf', 'proj')
    writeDriveFile(root, m.localPath, 'gguf') // GGUF good; projector absent
    const [r] = await verifyDriveModels(root, [m])
    expect(r.status).toBe('missing') // the projector decides — not a false 'verified'
    expect(r.localPath).toBe('models/vision/vl-mmproj.gguf')
  })

  it('FAILS the model when the mmproj is present but its hash mismatches', async () => {
    const root = tempRoot('verify-vision')
    const m = visionManifest('gguf', 'proj')
    writeDriveFile(root, m.localPath, 'gguf')
    writeDriveFile(root, 'models/vision/vl-mmproj.gguf', 'wrong-projector-bytes')
    const [r] = await verifyDriveModels(root, [m])
    expect(r.status).toBe('mismatch')
    expect(r.localPath).toBe('models/vision/vl-mmproj.gguf')
  })

  it('VERIFIES the model only when BOTH files match', async () => {
    const root = tempRoot('verify-vision')
    const m = visionManifest('gguf', 'proj')
    writeDriveFile(root, m.localPath, 'gguf')
    writeDriveFile(root, 'models/vision/vl-mmproj.gguf', 'proj')
    const [r] = await verifyDriveModels(root, [m])
    expect(r.status).toBe('verified')
  })
})

// #310: the same fold over a shard set. The drive verifier keeps ONE row per model and names
// the FIRST offending file, so a drive carrying a quarter of a weight cannot pass the sell gate.
const SHARD = (n: number): string => `models/chat/big-${String(n).padStart(5, '0')}-of-00003.gguf`

function shardedManifest(shas: [string, string, string]): ModelManifest {
  return validManifest({
    id: 'sharded',
    local_path: SHARD(1),
    sha256: shas[0],
    files: [
      { local_path: SHARD(2), sha256: shas[1] },
      { local_path: SHARD(3), sha256: shas[2] }
    ]
  })
}
const shardBytes = (n: number): string => `shard-${n}`
const shardHash = (n: number): string => sha256(shardBytes(n))

describe('verifyDriveModels — multi-file weight fold (#310)', () => {
  it('FAILS the model when a declared shard is MISSING, naming that file', async () => {
    const root = tempRoot('verify-shards')
    const m = shardedManifest([shardHash(1), shardHash(2), shardHash(3)])
    writeDriveFile(root, SHARD(1), shardBytes(1))
    writeDriveFile(root, SHARD(3), shardBytes(3)) // shard 2 absent
    const rows = await verifyDriveModels(root, [m])
    expect(rows).toHaveLength(1) // one row per model, not per file
    expect(rows[0].status).toBe('missing')
    expect(rows[0].localPath).toBe(SHARD(2))
  })

  it('FAILS the model when a later shard is CORRUPT, naming that file', async () => {
    const root = tempRoot('verify-shards')
    const m = shardedManifest([shardHash(1), shardHash(2), shardHash(3)])
    writeDriveFile(root, SHARD(1), shardBytes(1))
    writeDriveFile(root, SHARD(2), shardBytes(2))
    writeDriveFile(root, SHARD(3), 'corrupt shard bytes')
    const [r] = await verifyDriveModels(root, [m])
    expect(r.status).toBe('mismatch')
    expect(r.localPath).toBe(SHARD(3))
  })

  it('VERIFIES the model only when EVERY shard matches', async () => {
    const root = tempRoot('verify-shards')
    const m = shardedManifest([shardHash(1), shardHash(2), shardHash(3)])
    for (const n of [1, 2, 3]) writeDriveFile(root, SHARD(n), shardBytes(n))
    const [r] = await verifyDriveModels(root, [m])
    expect(r.status).toBe('verified')
    expect(r.localPath).toBe(SHARD(1))
  })
})

describe('buildChecksumsJson (generate mode)', () => {
  // #310: one entry per declared file, in declaration order (the vision case below pins the
  // same rule for the GGUF + projector pair).
  it('captures every shard of a multi-file weight in declaration order', async () => {
    const root = tempRoot('sums-shards')
    const m = shardedManifest([shardHash(1), shardHash(2), shardHash(3)])
    for (const n of [1, 2]) writeDriveFile(root, SHARD(n), shardBytes(n)) // shard 3 absent
    const sums = await buildChecksumsJson(root, [m], '2026-09-07T00:00:00Z')
    expect(sums.entries.map((e) => e.local_path)).toEqual([SHARD(1), SHARD(2), SHARD(3)])
    expect(sums.entries.map((e) => e.id)).toEqual(['sharded', 'sharded', 'sharded'])
    expect(sums.entries.map((e) => e.present)).toEqual([true, true, false])
    expect(sums.entries[1].sha256).toBe(shardHash(2))
    expect(sums.entries[2].sha256).toBe(null)
  })

  it('captures BOTH the GGUF and the mmproj of a vision model (DIST-2)', async () => {
    const root = tempRoot('sums-vision')
    const m = visionManifest('gguf', 'proj')
    writeDriveFile(root, 'models/vision/vl.gguf', 'gguf')
    writeDriveFile(root, 'models/vision/vl-mmproj.gguf', 'proj')
    const sums = await buildChecksumsJson(root, [m], '2026-06-20T00:00:00Z')
    const paths = sums.entries.map((e) => e.local_path)
    expect(paths).toEqual(['models/vision/vl.gguf', 'models/vision/vl-mmproj.gguf'])
    expect(sums.entries.every((e) => e.present)).toBe(true)
    expect(sums.entries.find((e) => e.local_path.endsWith('mmproj.gguf'))!.sha256).toBe(sha256('proj'))
  })

  it('captures real hashes for present weights and null for absent', async () => {
    const root = tempRoot('sums')
    const present = validManifest({ id: 'present', local_path: 'models/chat/present.gguf' })
    const absent = validManifest({ id: 'absent', local_path: 'models/chat/absent.gguf' })
    const expected = writeDriveFile(root, present.localPath, 'abc')

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
