import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { getVisionStatus } from '../../src/main/services/vision/status'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import type { AppContext } from '../../src/main/services/context'

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
  overrides: Record<string, unknown> = {}
): void {
  mkdirSync(join(manifestsDir, 'vision'), { recursive: true })
  writeFileSync(
    join(manifestsDir, 'vision', 'vision-model.yaml'),
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
    paths: { rootPath },
    manifestsDir,
    isDev: true,
    // Locked → status stays workspace-agnostic and never touches the DB (PROD-2).
    workspace: { isUnlocked: () => false }
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
})
