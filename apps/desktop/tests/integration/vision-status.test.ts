import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { getVisionStatus, pickVisionManifest, visionCandidates } from '../../src/main/services/vision/status'
import { computeInstallState, manifestFilesPresent } from '../../src/main/services/models'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import type { AppContext } from '../../src/main/services/context'
import { sha256, validManifest } from '../helpers/manifest-fixtures'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

// Vision availability detection (image-understanding plan §10/§17). All cases run with ZERO
// real weights (the green-gate posture): the binary + manifest + files are synthesized in a
// temp drive. `isDev:true` so placeholder hashes count as installed (no real GGUF to hash).

function makeDrive(): { rootPath: string; manifestsDir: string } {
  const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-vision-'))
  const manifestsDir = join(rootPath, 'model-manifests')
  mkdirSync(manifestsDir, { recursive: true })
  return { rootPath, manifestsDir }
}

/** Create the on-drive llama-server binary so `resolveLlamaServerPath` finds it. */
function writeBinary(rootPath: string): void {
  const dir = llamaServerDir(rootPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, llamaServerBinaryName()), 'stub-binary')
}

/** Write a file under the drive root from a manifest-relative path. */
function writeDriveFile(rootPath: string, relPath: string, content = 'x'): void {
  const dest = join(rootPath, ...relPath.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, content)
}

function writeVisionManifest(
  manifestsDir: string,
  overrides: Record<string, unknown> = {},
  fileName = 'vision-model.yaml'
): void {
  mkdirSync(join(manifestsDir, 'vision'), { recursive: true })
  writeFileSync(
    join(manifestsDir, 'vision', fileName),
    stringify({
      id: 'qwen2.5-vl-3b-instruct-q4',
      display_name: 'Qwen2.5-VL 3B Instruct Q4',
      family: 'qwen2.5-vl',
      role: 'vision',
      format: 'gguf',
      runtime: 'llama_cpp',
      license: 'apache-2.0',
      input_modalities: ['text', 'image'],
      size_on_disk_gb: 3.3,
      recommended_min_ram_gb: 12,
      recommended_ram_gb: 16,
      recommended_context_tokens: 4096,
      local_path: 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf',
      sha256: 'REPLACE_WITH_REAL_HASH',
      mmproj: {
        local_path: 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH'
      },
      license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' },
      ...overrides
    })
  )
}

function ctxFor(rootPath: string, manifestsDir: string | null): AppContext {
  return {
    // #913: the developer leniency reads the drive policy from configPath (none there: the dev defaults).
    paths: { rootPath, configPath: join(rootPath, 'config') },
    manifestsDir,
    isDev: true,
    // Locked → status stays workspace-agnostic and never touches the DB (PROD-2).
    workspace: workspaceStandIn({ unlocked: false })
  } as unknown as AppContext
}

describe('getVisionStatus', () => {
  it('reports no-runtime when no llama-server binary is on the drive', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeVisionManifest(manifestsDir)
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf')
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf')
    const status = await getVisionStatus(ctxFor(rootPath, manifestsDir))
    expect(status).toEqual({ available: false, reason: 'no-runtime' })
  })

  it('reports no-model when the binary is present but no vision manifest exists', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    const status = await getVisionStatus(ctxFor(rootPath, manifestsDir))
    expect(status).toEqual({ available: false, reason: 'no-model' })
  })

  it('reports no-model when the GGUF is present but the mmproj is MISSING', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    writeVisionManifest(manifestsDir)
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf')
    // Deliberately do NOT write the mmproj projector.
    const status = await getVisionStatus(ctxFor(rootPath, manifestsDir))
    expect(status.available).toBe(false)
    expect(status.reason).toBe('no-model')
  })

  it('reports available when the binary + GGUF + mmproj are all present', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    writeVisionManifest(manifestsDir)
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf')
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf')
    const status = await getVisionStatus(ctxFor(rootPath, manifestsDir))
    expect(status.available).toBe(true)
    expect(status.modelId).toBe('qwen2.5-vl-3b-instruct-q4')
    expect(status.modelDisplayName).toBe('Qwen2.5-VL 3B Instruct Q4')
    expect(status.reason).toBeUndefined()
  })

  it('reports incompatible when a vision manifest needs a runtime the engine cannot load', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    // A future-arch runtime the SUPPORTED_RUNTIME_FORMATS map does not know → unsupported.
    writeVisionManifest(manifestsDir, { runtime: 'llama_cpp_vision_next' })
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf')
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf')
    const status = await getVisionStatus(ctxFor(rootPath, manifestsDir))
    expect(status).toEqual({ available: false, reason: 'incompatible' })
  })

  it('reports no-model when there is no manifests dir at all', async () => {
    const { rootPath } = makeDrive()
    writeBinary(rootPath)
    const status = await getVisionStatus(ctxFor(rootPath, null))
    expect(status).toEqual({ available: false, reason: 'no-model' })
  })

  // #890: the flagged model is tried first; its files are on the drive but cannot verify (a placeholder hash outside
  // developer mode), so Images falls through to the next vision model on the drive, as master's walk did: it never goes
  // dark while another model would run.
  it('tries the flagged model first and falls through to the next one on the drive when it fails verification (#890)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    writeVisionManifest(
      manifestsDir,
      {
        id: 'a-vision',
        local_path: 'models/vision/a.gguf',
        sha256: sha256('a weights'),
        mmproj: { local_path: 'models/vision/a-mmproj.gguf', sha256: sha256('a projector') }
      },
      'a-vision.yaml'
    )
    writeDriveFile(rootPath, 'models/vision/a.gguf', 'a weights')
    writeDriveFile(rootPath, 'models/vision/a-mmproj.gguf', 'a projector')
    const zVision = {
      id: 'z-vision',
      local_path: 'models/vision/z.gguf',
      mmproj: { local_path: 'models/vision/z-mmproj.gguf', sha256: 'REPLACE_WITH_REAL_HASH' }
    }
    writeVisionManifest(manifestsDir, { ...zVision, default_for_role: true }, 'z-vision.yaml')
    writeDriveFile(rootPath, 'models/vision/z.gguf')
    writeDriveFile(rootPath, 'models/vision/z-mmproj.gguf')
    const ctx = { ...ctxFor(rootPath, manifestsDir), isDev: false } as AppContext // developer mode off

    expect(await getVisionStatus(ctx)).toMatchObject({ available: true, modelId: 'a-vision' })
    // With a-vision's projector gone, the flagged z-vision is the only candidate and fails its check: damaged (#913;
    // before, no-model, whose copy asks for a model the drive already has).
    rmSync(join(rootPath, 'models/vision/a-mmproj.gguf'))
    expect(await getVisionStatus(ctx)).toEqual({ available: false, reason: 'damaged' })
    writeDriveFile(rootPath, 'models/vision/a-mmproj.gguf', 'a projector')
    // The same drive with the flag taken off z-vision: a-vision is the pick, and it is available.
    writeVisionManifest(manifestsDir, zVision, 'z-vision.yaml')
    expect(await getVisionStatus(ctx)).toMatchObject({ available: true, modelId: 'a-vision' })
  })

  // #913 (S-913-1): "Check all model files" found the GGUF damaged and stopped there, so the projector has no cache
  // entry. Images must not run that model; on master the status said available and the next image question used it.
  it('is not available once a full check found the GGUF damaged, though the projector was never hashed (#913)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    writeVisionManifest(manifestsDir, {
      sha256: sha256('the real weights'),
      mmproj: { local_path: 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf', sha256: sha256('the projector') }
    })
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf', 'the real weightz') // a bit flip
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf', 'the projector')
    const ctx = ctxFor(rootPath, manifestsDir)
    const manifest = validManifest({
      id: 'qwen2.5-vl-3b-instruct-q4',
      role: 'vision',
      local_path: 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf',
      sha256: sha256('the real weights'),
      mmproj: { local_path: 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf', sha256: sha256('the projector') }
    })
    // The full check (what "Check all model files" runs): it hashes the GGUF, finds it damaged and stops.
    expect(await computeInstallState(manifest, rootPath, { developerMode: false })).toBe('checksum_failed')
    const status = await getVisionStatus(ctx)
    expect(status.available).toBe(false)
    expect(status.modelId).toBeUndefined()
    // #913 (d): the reason whose copy sends the user back to the AI Model screen to download it again.
    expect(status.reason).toBe('damaged')
  })

  // #913 (S-913-4): the images status takes the developer leniency every role uses, so the drive policy outranks a
  // dev build or the developer toggle, as it does for the chat start. Before, a placeholder-hash vision model counted
  // as installed on a commercial drive whenever developer mode was on.
  it('lets the drive policy refuse a placeholder-hash vision model even in developer mode (#913)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    writeBinary(rootPath)
    writeVisionManifest(manifestsDir) // placeholder hashes for both files
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf')
    writeDriveFile(rootPath, 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf')
    const ctx = ctxFor(rootPath, manifestsDir) // a dev build: developer mode on
    expect(await getVisionStatus(ctx)).toMatchObject({ available: true })
    mkdirSync(join(rootPath, 'config'), { recursive: true })
    writeFileSync(
      join(rootPath, 'config', 'policy.json'),
      JSON.stringify({ models: { allow_unverified_models: false, require_sha256_match: true } })
    )
    expect(await getVisionStatus(ctx)).toEqual({ available: false, reason: 'damaged' })
  })
})

// #890: the one vision pick the Performance row and `getVisionStatus` share. Synchronous: it checks presence and hashes
// nothing, so the snapshot can call it.
describe('pickVisionManifest', () => {
  it('picks the flagged vision model among those this engine can load with every file on the drive, else the first', () => {
    const { rootPath } = makeDrive()
    const vision = (id: string, o: Record<string, unknown> = {}) =>
      validManifest({
        id,
        role: 'vision',
        input_modalities: ['text', 'image'],
        local_path: `models/vision/${id}.gguf`,
        mmproj: { local_path: `models/vision/${id}-mmproj.gguf`, sha256: 'REPLACE_WITH_REAL_HASH' },
        ...o
      })
    const absent = vision('a-absent')
    const noProjector = vision('b-no-projector')
    writeDriveFile(rootPath, noProjector.localPath)
    const newerEngine = vision('c-newer-engine', { runtime: 'llama_cpp_vision_next' })
    writeDriveFile(rootPath, newerEngine.localPath)
    writeDriveFile(rootPath, newerEngine.mmproj!.localPath)
    const first = vision('d-first')
    writeDriveFile(rootPath, first.localPath)
    writeDriveFile(rootPath, first.mmproj!.localPath)
    const flaggedAbsent = vision('e-flagged-absent', { default_for_role: true })
    const flagged = vision('f-flagged', { default_for_role: true })
    writeDriveFile(rootPath, flagged.localPath)
    writeDriveFile(rootPath, flagged.mmproj!.localPath)
    // A flagged chat model on the drive: the Performance row passes the whole catalog, and only vision counts.
    const chat = validManifest({ id: 'g-chat', default_for_role: true })
    writeDriveFile(rootPath, chat.localPath)

    expect(pickVisionManifest([chat, absent, noProjector, newerEngine, first, flaggedAbsent], rootPath)?.id).toBe('d-first')
    expect(pickVisionManifest([chat, absent, noProjector, newerEngine, first, flaggedAbsent, flagged], rootPath)?.id).toBe(
      'f-flagged'
    )
    expect(pickVisionManifest([chat, absent, noProjector, newerEngine, flaggedAbsent], rootPath)).toBeUndefined()
    // The images service tries them in that order: the pick, then the rest on the drive in walk order.
    expect(visionCandidates([chat, absent, noProjector, newerEngine, first, flaggedAbsent, flagged], rootPath).map((m) => m.id)).toEqual([
      'f-flagged',
      'd-first'
    ])

    // The presence step is computeInstallState's own first two (runtime/format supported, every file there): a model
    // it would call unsupported or missing is never a candidate, and every other one is.
    return Promise.all(
      [absent, noProjector, newerEngine, first, flagged].map(async (m) => {
        const state = await computeInstallState(m, rootPath, { developerMode: true, skipHash: true })
        expect(manifestFilesPresent(rootPath, m), `${m.id}: ${state}`).toBe(state !== 'unsupported' && state !== 'missing')
      })
    )
  })
})
