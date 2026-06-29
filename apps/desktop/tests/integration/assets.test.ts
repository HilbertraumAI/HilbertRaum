import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  planModelDownloads,
  selectRuntimeBuild,
  selectRuntimeBuilds,
  planRuntimeDownload,
  verifyDownloadedFile,
  downloadToFile,
  fetchAndVerify,
  formatAssetPlan,
  runtimeBinaryName,
  readRuntimeMarker,
  writeRuntimeMarker,
  runtimeInstallCurrent,
  runtimeMarkerPath,
  isPrivateOrLoopbackHost,
  effectiveDownloadCap,
  modelWeightMaxBytes,
  ENGINE_DOWNLOAD_MAX_BYTES,
  type FetchFn
} from '../../src/main/services/assets'
import { validateManifest, isRealSha256, type ModelManifest } from '../../src/shared/manifest'
import { validateRuntimeSources, type RuntimeSources } from '../../src/shared/runtime-sources'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function manifest(overrides: Record<string, unknown> = {}): ModelManifest {
  const raw: Record<string, unknown> = {
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
    download: {
      url: 'https://example.test/qwen3-4b.gguf',
      sha256: 'REPLACE_WITH_REAL_HASH',
      size_bytes: 2700000000,
      license_url: 'https://example.test/license'
    },
    ...overrides
  }
  const res = validateManifest(raw)
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

function writeWeight(root: string, m: ModelManifest, content: string): void {
  const dest = join(root, ...m.localPath.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, content)
}

/** A `role: vision` manifest (GGUF + mmproj projector, each with its own download — DIST-1). */
function visionManifest(overrides: Record<string, unknown> = {}): ModelManifest {
  const raw: Record<string, unknown> = {
    id: 'test-vlm',
    display_name: 'Test VLM',
    family: 'qwen2.5-vl',
    role: 'vision',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    size_on_disk_gb: 3.3,
    recommended_min_ram_gb: 8,
    recommended_ram_gb: 16,
    recommended_context_tokens: 4096,
    local_path: 'models/vision/vlm.gguf',
    sha256: 'REPLACE_WITH_REAL_HASH',
    license_review: { status: 'approved', reviewed_by: 'me', reviewed_at: '2026-01-01', notes: '' },
    download: {
      url: 'https://example.test/vlm.gguf',
      sha256: 'REPLACE_WITH_REAL_HASH',
      size_bytes: 1_930_000_000,
      license_url: 'https://example.test/license'
    },
    mmproj: {
      local_path: 'models/vision/vlm-mmproj.gguf',
      sha256: 'REPLACE_WITH_REAL_HASH',
      download: {
        url: 'https://example.test/vlm-mmproj.gguf',
        sha256: 'REPLACE_WITH_REAL_HASH',
        size_bytes: 1_340_000_000
      }
    },
    ...overrides
  }
  const res = validateManifest(raw)
  if (!res.manifest) throw new Error('vision fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

const runtimeSources = (): RuntimeSources => {
  const res = validateRuntimeSources({
    llama_cpp: {
      version: 'b9196',
      builds: [
        {
          os: 'win',
          arch: 'x64',
          backend: 'cpu-avx2',
          url: 'https://example.test/win-avx2.zip',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/win'
        },
        {
          os: 'win',
          arch: 'x64',
          backend: 'cuda',
          url: 'https://example.test/win-cuda.zip',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/win'
        },
        {
          os: 'mac',
          arch: 'arm64',
          backend: 'metal',
          url: 'https://example.test/mac-arm64.zip',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/mac'
        }
      ]
    }
  })
  if (!res.sources) throw new Error('runtime-sources fixture invalid: ' + res.errors.join(', '))
  return res.sources
}

describe('planModelDownloads', () => {
  it('excludes manifests with no download block', async () => {
    const root = tempDir('hilbertraum-assets-')
    const noDownload = manifest({ id: 'nodl', download: undefined, local_path: 'models/chat/nodl.gguf' })
    const tasks = await planModelDownloads(root, [noDownload])
    expect(tasks).toHaveLength(0)
  })

  it('plans a download for a missing weight (license accepted)', async () => {
    const root = tempDir('hilbertraum-assets-')
    const tasks = await planModelDownloads(root, [manifest()], { acceptLicense: true })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('download')
    expect(tasks[0].url).toBe('https://example.test/qwen3-4b.gguf')
    expect(tasks[0].placeholderHash).toBe(true)
    expect(tasks[0].dest.endsWith(join('models', 'chat', 'qwen3-4b-instruct-q4.gguf'))).toBe(true)
  })

  it('blocks a download whose license is not approved without --accept-license', async () => {
    const root = tempDir('hilbertraum-assets-')
    const tasks = await planModelDownloads(root, [manifest()])
    expect(tasks[0].status).toBe('license-blocked')
    expect(tasks[0].licenseApproved).toBe(false)
  })

  it('plans a download for an approved license with no override', async () => {
    const root = tempDir('hilbertraum-assets-')
    const approved = manifest({
      license_review: { status: 'approved', reviewed_by: 'me', reviewed_at: '2026-01-01', notes: '' }
    })
    const tasks = await planModelDownloads(root, [approved])
    expect(tasks[0].status).toBe('download')
    expect(tasks[0].licenseApproved).toBe(true)
  })

  it('skips a present + verified weight (real hash matches)', async () => {
    const root = tempDir('hilbertraum-assets-')
    const content = 'real-weights'
    const hash = sha256(content)
    const m = manifest({ sha256: hash, download: { url: 'https://x/y.gguf', sha256: hash, size_bytes: 1, license_url: null } })
    writeWeight(root, m, content)
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('present-verified')
  })

  it('skips a present weight with a placeholder hash as present-unverified', async () => {
    const root = tempDir('hilbertraum-assets-')
    const m = manifest()
    writeWeight(root, m, 'whatever')
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('present-unverified')
  })

  it('re-plans a download when a present weight mismatches a real hash', async () => {
    const root = tempDir('hilbertraum-assets-')
    const m = manifest({ sha256: 'a'.repeat(64), download: { url: 'https://x/y.gguf', sha256: 'a'.repeat(64), size_bytes: 1, license_url: null } })
    writeWeight(root, m, 'wrong-content')
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('download')
  })

  it('honours the --only filter', async () => {
    const root = tempDir('hilbertraum-assets-')
    const a = manifest({ id: 'a', local_path: 'models/chat/a.gguf' })
    const b = manifest({ id: 'b', local_path: 'models/chat/b.gguf' })
    const tasks = await planModelDownloads(root, [a, b], { acceptLicense: true, only: 'b' })
    expect(tasks.map((t) => t.id)).toEqual(['b'])
  })

  // DIST-1: a vision model is TWO DownloadJobs sharing one modelId (GGUF + mmproj projector).
  it('plans BOTH the GGUF and the mmproj projector for a vision model (two tasks, one modelId)', async () => {
    const root = tempDir('hilbertraum-assets-')
    const tasks = await planModelDownloads(root, [visionManifest()], { acceptLicense: true })
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.id)).toEqual(['test-vlm', 'test-vlm'])
    expect(tasks.map((t) => t.relPath)).toEqual([
      'models/vision/vlm.gguf',
      'models/vision/vlm-mmproj.gguf'
    ])
    expect(tasks[1].url).toBe('https://example.test/vlm-mmproj.gguf')
    expect(tasks[1].dest).toBe(join(root, 'models', 'vision', 'vlm-mmproj.gguf'))
    // The projector inherits the model's (approved) license.
    expect(tasks[1].license).toBe('apache-2.0')
    expect(tasks[1].status).toBe('download')
  })

  it('plans the mmproj download even when the GGUF is already present + verified', async () => {
    const root = tempDir('hilbertraum-assets-')
    const content = 'vlm-gguf-bytes'
    const hash = sha256(content)
    const m = visionManifest({
      sha256: hash,
      download: { url: 'https://example.test/vlm.gguf', sha256: hash, size_bytes: 1, license_url: null }
    })
    writeWeight(root, m, content) // GGUF present + verified; mmproj still absent
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks).toHaveLength(2)
    expect(tasks[0].status).toBe('present-verified') // GGUF
    expect(tasks[1].status).toBe('download') // mmproj must still be fetched
    expect(tasks[1].relPath).toBe('models/vision/vlm-mmproj.gguf')
  })
})

describe('selectRuntimeBuild', () => {
  it('selects the default (first) CPU build for the host os/arch when no backend given', () => {
    const build = selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'x64' })
    expect(build?.backend).toBe('cpu-avx2')
  })

  it('honours a backend override', () => {
    const build = selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'x64', backend: 'cuda' })
    expect(build?.backend).toBe('cuda')
  })

  it('returns null when nothing matches the host', () => {
    expect(selectRuntimeBuild(runtimeSources(), { os: 'linux', arch: 'x64' })).toBeNull()
    expect(selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'arm64' })).toBeNull()
  })
})

// Phase 14: vulkan-first yaml ordering + the cpu safety net (architecture.md GPU record §6/§9).
const vulkanFirstSources = (): RuntimeSources => {
  const res = validateRuntimeSources({
    llama_cpp: {
      version: 'b9585',
      builds: [
        {
          os: 'win',
          arch: 'x64',
          backend: 'vulkan',
          url: 'https://example.test/win-vulkan.zip',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/win'
        },
        {
          os: 'win',
          arch: 'x64',
          backend: 'cpu',
          url: 'https://example.test/win-cpu.zip',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/win/cpu'
        },
        {
          os: 'mac',
          arch: 'arm64',
          backend: 'metal',
          url: 'https://example.test/mac-arm64.tar.gz',
          sha256: 'REPLACE_WITH_REAL_HASH',
          extract_to: 'runtime/llama.cpp/mac'
        }
      ]
    }
  })
  if (!res.sources) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.sources
}

describe('selectRuntimeBuild (vulkan-first default, Phase 14)', () => {
  it('defaults to the vulkan build when it is listed first', () => {
    const build = selectRuntimeBuild(vulkanFirstSources(), { os: 'win', arch: 'x64' })
    expect(build?.backend).toBe('vulkan')
    expect(build?.extractTo).toBe('runtime/llama.cpp/win')
  })

  it('backend=cpu selects the safety net extracting into <os>/cpu', () => {
    const build = selectRuntimeBuild(vulkanFirstSources(), { os: 'win', arch: 'x64', backend: 'cpu' })
    expect(build?.backend).toBe('cpu')
    expect(build?.extractTo).toBe('runtime/llama.cpp/win/cpu')
  })
})

describe('selectRuntimeBuilds (commercial pipeline, Phase 14)', () => {
  it('returns every build an OS ships, default first', () => {
    const builds = selectRuntimeBuilds(vulkanFirstSources(), { os: 'win' })
    expect(builds.map((b) => b.backend)).toEqual(['vulkan', 'cpu'])
  })

  it('returns only the metal build for mac (no cpu safety net there)', () => {
    const builds = selectRuntimeBuilds(vulkanFirstSources(), { os: 'mac' })
    expect(builds.map((b) => b.backend)).toEqual(['metal'])
  })

  it('filters by arch when given', () => {
    expect(selectRuntimeBuilds(vulkanFirstSources(), { os: 'win', arch: 'arm64' })).toEqual([])
  })
})

describe('runtime install marker (.hilbertraum-runtime.json, Phase 14)', () => {
  function planFor(root: string, backend?: string) {
    const build = selectRuntimeBuild(vulkanFirstSources(), { os: 'win', arch: 'x64', backend })!
    return planRuntimeDownload(root, build, 'b9585')
  }

  it('round-trips a marker through write + read', () => {
    const root = tempDir('hilbertraum-marker-')
    writeRuntimeMarker(root, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
    expect(readRuntimeMarker(root)).toEqual({
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64'
    })
  })

  it('round-trips a marker WITH per-binary hashes (vuln-scan B)', () => {
    const root = tempDir('hilbertraum-marker-')
    writeRuntimeMarker(root, {
      version: 'b9585',
      backend: 'vulkan',
      os: 'win',
      arch: 'x64',
      binaries: { 'llama-server.exe': 'a'.repeat(64), 'cpu/llama-server.exe': 'b'.repeat(64) }
    })
    expect(readRuntimeMarker(root)?.binaries).toEqual({
      'llama-server.exe': 'a'.repeat(64),
      'cpu/llama-server.exe': 'b'.repeat(64)
    })
  })

  it('readRuntimeMarker drops a malformed `binaries` field (tamper-tolerant)', () => {
    const root = tempDir('hilbertraum-marker-')
    // Non-string values are dropped; an all-bad map leaves `binaries` absent entirely.
    writeFileSync(
      runtimeMarkerPath(root),
      JSON.stringify({ version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64', binaries: { x: 5, y: 'ok' } })
    )
    expect(readRuntimeMarker(root)?.binaries).toEqual({ y: 'ok' })
    writeFileSync(
      runtimeMarkerPath(root),
      JSON.stringify({ version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64', binaries: ['not', 'a', 'map'] })
    )
    expect(readRuntimeMarker(root)?.binaries).toBeUndefined()
  })

  it('readRuntimeMarker never throws: missing or malformed → null', () => {
    const root = tempDir('hilbertraum-marker-')
    expect(readRuntimeMarker(root)).toBeNull()
    writeFileSync(runtimeMarkerPath(root), 'not-json')
    expect(readRuntimeMarker(root)).toBeNull()
    writeFileSync(runtimeMarkerPath(root), JSON.stringify({ version: 'b9585' })) // incomplete
    expect(readRuntimeMarker(root)).toBeNull()
  })

  it('runtimeInstallCurrent is false with no binary', () => {
    const root = tempDir('hilbertraum-marker-')
    expect(runtimeInstallCurrent(planFor(root))).toBe(false)
  })

  it('a present binary WITHOUT a marker is NOT current (CPU-era drive → vulkan re-fetches)', () => {
    const root = tempDir('hilbertraum-marker-')
    const plan = planFor(root)
    mkdirSync(plan.extractTo, { recursive: true })
    writeFileSync(plan.binaryPath, 'old-cpu-era-binary')
    expect(runtimeInstallCurrent(plan)).toBe(false)
  })

  it('a marker recording a DIFFERENT backend or version is NOT current', () => {
    const root = tempDir('hilbertraum-marker-')
    const plan = planFor(root)
    mkdirSync(plan.extractTo, { recursive: true })
    writeFileSync(plan.binaryPath, 'binary')
    writeRuntimeMarker(plan.extractTo, { version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64' })
    expect(runtimeInstallCurrent(plan)).toBe(false)
    writeRuntimeMarker(plan.extractTo, { version: 'b9000', backend: 'vulkan', os: 'win', arch: 'x64' })
    expect(runtimeInstallCurrent(plan)).toBe(false)
  })

  it('binary + matching marker → current (idempotent skip)', () => {
    const root = tempDir('hilbertraum-marker-')
    const plan = planFor(root)
    mkdirSync(plan.extractTo, { recursive: true })
    writeFileSync(plan.binaryPath, 'binary')
    writeRuntimeMarker(plan.extractTo, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
    expect(runtimeInstallCurrent(plan)).toBe(true)
  })

  // Phase 36: the whisper family rides the exact same marker logic — its plan just
  // points at whisper-cli under runtime/whisper.cpp/<os>/. Version+backend skips hold.
  describe('whisper family (binaryBase = whisper-cli)', () => {
    const whisperBuild = {
      os: 'win' as const,
      arch: 'x64',
      backend: 'cpu',
      url: 'https://example.test/whisper-bin-x64.zip',
      sha256: 'REPLACE_WITH_REAL_HASH',
      extractTo: 'runtime/whisper.cpp/win'
    }
    const whisperPlan = (root: string) => planRuntimeDownload(root, whisperBuild, 'v1.8.6', 'whisper-cli')

    it('plans the whisper-cli binary path under runtime/whisper.cpp/<os>/', () => {
      const root = tempDir('hilbertraum-whisper-marker-')
      const plan = whisperPlan(root)
      expect(plan.extractTo).toBe(join(root, 'runtime', 'whisper.cpp', 'win'))
      expect(plan.binaryPath).toBe(join(root, 'runtime', 'whisper.cpp', 'win', 'whisper-cli.exe'))
    })

    it('skips only on a MATCHING version+backend marker; stale/absent re-fetches', () => {
      const root = tempDir('hilbertraum-whisper-marker-')
      const plan = whisperPlan(root)
      expect(runtimeInstallCurrent(plan)).toBe(false) // no binary
      mkdirSync(plan.extractTo, { recursive: true })
      writeFileSync(plan.binaryPath, 'whisper-binary')
      expect(runtimeInstallCurrent(plan)).toBe(false) // binary, no marker
      writeRuntimeMarker(plan.extractTo, { version: 'v1.7.0', backend: 'cpu', os: 'win', arch: 'x64' })
      expect(runtimeInstallCurrent(plan)).toBe(false) // version bump re-fetches
      writeRuntimeMarker(plan.extractTo, { version: 'v1.8.6', backend: 'cpu', os: 'win', arch: 'x64' })
      expect(runtimeInstallCurrent(plan)).toBe(true) // current → idempotent skip
    })
  })
})

// The COMMITTED runtime-sources.yaml is the actual pin a drive is provisioned from —
// assert the Phase-14 shape directly against it (mirrors the committed-manifest tests).
describe('committed model-manifests/runtime-sources.yaml (Phase 14 pin)', () => {
  const committed = (): RuntimeSources => {
    const raw = parse(
      readFileSync(join(process.cwd(), '..', '..', 'model-manifests', 'runtime-sources.yaml'), 'utf8')
    )
    const res = validateRuntimeSources(raw)
    if (!res.sources) throw new Error('committed yaml invalid: ' + res.errors.join(', '))
    return res.sources
  }

  it('validates (incl. the duplicate-triple check)', () => {
    expect(committed().version).toBe('b9585')
  })

  it('is vulkan-first on win/linux with the cpu safety net at <os>/cpu', () => {
    const sources = committed()
    const winDefault = selectRuntimeBuild(sources, { os: 'win', arch: 'x64' })
    expect(winDefault?.backend).toBe('vulkan')
    expect(winDefault?.extractTo).toBe('runtime/llama.cpp/win')
    const linuxDefault = selectRuntimeBuild(sources, { os: 'linux', arch: 'x64' })
    expect(linuxDefault?.backend).toBe('vulkan')
    expect(linuxDefault?.extractTo).toBe('runtime/llama.cpp/linux')
    expect(selectRuntimeBuilds(sources, { os: 'win' }).map((b) => b.backend)).toEqual([
      'vulkan',
      'cpu'
    ])
    expect(selectRuntimeBuild(sources, { os: 'win', arch: 'x64', backend: 'cpu' })?.extractTo).toBe(
      'runtime/llama.cpp/win/cpu'
    )
    expect(
      selectRuntimeBuild(sources, { os: 'linux', arch: 'x64', backend: 'cpu' })?.extractTo
    ).toBe('runtime/llama.cpp/linux/cpu')
    // mac is unchanged: Metal-only, no cpu net (Metal failure falls back inside llama.cpp).
    expect(selectRuntimeBuilds(sources, { os: 'mac' }).map((b) => b.backend)).toEqual(['metal'])
  })

  it('every build carries a REAL sha256 (no placeholders in the committed pin)', () => {
    for (const b of committed().builds) {
      expect(isRealSha256(b.sha256), `${b.os}/${b.arch}/${b.backend}`).toBe(true)
    }
  })

  // Phase 36: the committed whisper pin (the second family) — win CPU prebuilt only
  // (R-W1: upstream ships no mac/linux CLI binaries), real hash, own extract tree.
  it('pins the whisper_cpp family at v1.8.6 with a real hash', () => {
    const raw = parse(
      readFileSync(join(process.cwd(), '..', '..', 'model-manifests', 'runtime-sources.yaml'), 'utf8')
    )
    const res = validateRuntimeSources(raw)
    expect(res.ok).toBe(true)
    expect(res.whisper?.version).toBe('v1.8.6')
    expect(res.whisper?.builds).toHaveLength(1)
    const win = res.whisper!.builds[0]
    expect(win.os).toBe('win')
    expect(win.backend).toBe('cpu')
    expect(win.extractTo).toBe('runtime/whisper.cpp/win')
    expect(isRealSha256(win.sha256)).toBe(true)
  })
})

describe('planRuntimeDownload', () => {
  it('resolves the extraction dir + binary path under the drive root', () => {
    const root = tempDir('hilbertraum-rt-')
    const build = selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'x64' })!
    const plan = planRuntimeDownload(root, build, 'b9196')
    expect(plan.extractTo).toBe(join(root, 'runtime', 'llama.cpp', 'win'))
    expect(plan.binaryPath).toBe(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'))
    // The archive name follows the URL basename (fixture url ends win-avx2.zip).
    expect(plan.zipDest).toContain('win-avx2.zip')
    expect(plan.placeholderHash).toBe(true)
  })

  it('keeps a .tar.gz archive name from the URL (macOS/Linux release assets)', () => {
    const root = tempDir('hilbertraum-rt-')
    const build = selectRuntimeBuild(
      {
        version: 'b9585',
        builds: [
          {
            os: 'linux',
            arch: 'x64',
            backend: 'cpu',
            url: 'https://example.test/llama-b9585-bin-ubuntu-x64.tar.gz',
            sha256: 'REPLACE_WITH_REAL_HASH',
            extractTo: 'runtime/llama.cpp/linux'
          }
        ]
      },
      { os: 'linux', arch: 'x64' }
    )!
    const plan = planRuntimeDownload(root, build, 'b9585')
    expect(plan.zipDest.endsWith('llama-b9585-bin-ubuntu-x64.tar.gz')).toBe(true)
  })

  it('rejects an extract_to that escapes the drive root', () => {
    const root = tempDir('hilbertraum-rt-')
    const build = { os: 'win' as const, arch: 'x64', backend: 'cpu', url: 'https://x', sha256: 'x', extractTo: '../evil' }
    expect(() => planRuntimeDownload(root, build, 'b1')).toThrow(/escapes the drive root/)
  })

  it('maps the binary name per OS', () => {
    expect(runtimeBinaryName('win')).toBe('llama-server.exe')
    expect(runtimeBinaryName('mac')).toBe('llama-server')
    expect(runtimeBinaryName('linux')).toBe('llama-server')
  })
})

describe('verifyDownloadedFile', () => {
  it('verifies a present file against a real hash', async () => {
    const root = tempDir('hilbertraum-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const ok = await verifyDownloadedFile(file, sha256('abc'))
    expect(ok.ok).toBe(true)
    expect(ok.actual).toBe(sha256('abc'))
  })

  it('reports a mismatch', async () => {
    const root = tempDir('hilbertraum-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const res = await verifyDownloadedFile(file, 'a'.repeat(64))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('mismatch')
  })

  it('reports a placeholder hash as not-a-pass', async () => {
    const root = tempDir('hilbertraum-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const res = await verifyDownloadedFile(file, 'REPLACE_WITH_REAL_HASH')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('placeholder')
  })

  it('reports a missing file', async () => {
    const root = tempDir('hilbertraum-verify-')
    const res = await verifyDownloadedFile(join(root, 'gone.gguf'), sha256('abc'))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing')
  })
})

describe('downloadToFile + fetchAndVerify (injected fetch — no real network)', () => {
  const fakeFetch = (body: string, ok = true): FetchFn =>
    (async () => new Response(ok ? body : null, { status: ok ? 200 : 404 })) as unknown as FetchFn

  it('streams a response body to disk via the injected fetch', async () => {
    const root = tempDir('hilbertraum-dl-')
    const dest = join(root, 'models', 'chat', 'x.gguf')
    let progress = 0
    await downloadToFile('https://example.test/x.gguf', dest, {
      fetchImpl: fakeFetch('hello-weights'),
      onProgress: (n) => (progress = n)
    })
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('hello-weights')
    expect(progress).toBe('hello-weights'.length)
  })

  it('throws on a non-OK HTTP status', async () => {
    const root = tempDir('hilbertraum-dl-')
    const dest = join(root, 'x.gguf')
    await expect(
      downloadToFile('https://example.test/missing', dest, { fetchImpl: fakeFetch('', false) })
    ).rejects.toThrow(/HTTP 404/)
  })

  it('refuses a non-HTTPS URL before fetching (L-2)', async () => {
    const root = tempDir('hilbertraum-dl-')
    const dest = join(root, 'x.gguf')
    const spy = vi.fn()
    await expect(
      downloadToFile('http://example.test/x.gguf', dest, {
        fetchImpl: (async (...a: unknown[]) => {
          spy(...a)
          return new Response('x')
        }) as unknown as FetchFn
      })
    ).rejects.toThrow(/non-HTTPS/)
    // The guard fires BEFORE any fetch — nothing was requested in cleartext.
    expect(spy).not.toHaveBeenCalled()
  })

  it('fetchAndVerify passes for a matching real hash', async () => {
    const root = tempDir('hilbertraum-dl-')
    const dest = join(root, 'w.gguf')
    const body = 'verified-bytes'
    const res = await fetchAndVerify(
      { url: 'https://example.test/w.gguf', dest, expectedSha256: sha256(body) },
      { fetchImpl: fakeFetch(body) }
    )
    expect(res.ok).toBe(true)
  })

  it('fetchAndVerify deletes the partial and throws on a mismatch', async () => {
    const root = tempDir('hilbertraum-dl-')
    const dest = join(root, 'w.gguf')
    await expect(
      fetchAndVerify(
        { url: 'https://example.test/w.gguf', dest, expectedSha256: 'a'.repeat(64) },
        { fetchImpl: fakeFetch('not-the-expected-bytes') }
      )
    ).rejects.toThrow(/mismatch/)
    expect(existsSync(dest)).toBe(false)
  })

  // D3 (vuln-scan-2026-06-21): redirects are followed MANUALLY and re-validated per hop, and the
  // body is size-capped — so a hostile/compromised origin can't SSRF to the LAN, downgrade to
  // http, or fill the drive.
  describe('D3 — redirect re-validation + size cap', () => {
    /** A fetch fake that dispatches by URL (so a redirect target gets a different response). */
    const routeFetch = (route: (url: string) => Response): FetchFn =>
      (async (u: unknown) => route(String(u))) as unknown as FetchFn
    const redirectTo = (location: string, status = 302): Response =>
      new Response(null, { status, headers: { location } })

    it('follows an https redirect to a public host and writes the final body', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      await downloadToFile('https://cdn.example.test/a', dest, {
        fetchImpl: routeFetch((url) =>
          url.endsWith('/a') ? redirectTo('https://cdn.example.test/b') : new Response('final-bytes')
        )
      })
      expect(readFileSync(dest, 'utf8')).toBe('final-bytes')
    })

    it('refuses a redirect that downgrades to http:// (L-2)', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      await expect(
        downloadToFile('https://cdn.example.test/a', dest, {
          fetchImpl: routeFetch(() => redirectTo('http://cdn.example.test/b'))
        })
      ).rejects.toThrow(/non-HTTPS/)
      expect(existsSync(dest)).toBe(false)
    })

    it('refuses a redirect to a private/loopback host (SSRF)', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      await expect(
        downloadToFile('https://cdn.example.test/a', dest, {
          // The classic cloud-metadata SSRF target.
          fetchImpl: routeFetch(() => redirectTo('https://169.254.169.254/latest/meta-data'))
        })
      ).rejects.toThrow(/private\/loopback/)
      expect(existsSync(dest)).toBe(false)
    })

    it('gives up after too many redirects', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      let n = 0
      await expect(
        downloadToFile('https://cdn.example.test/r0', dest, {
          fetchImpl: routeFetch(() => redirectTo(`https://cdn.example.test/r${++n}`))
        })
      ).rejects.toThrow(/too many redirects/)
    })

    it('rejects a body that streams past the maxBytes cap (disk-fill)', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      // 2 MiB body but the manifest planned only a few bytes → over the cap (+1 MiB margin).
      const big = 'z'.repeat(2 * 1024 * 1024)
      await expect(
        downloadToFile('https://cdn.example.test/big', dest, {
          fetchImpl: routeFetch(() => new Response(big)),
          maxBytes: 100
        })
      ).rejects.toThrow(/size cap/)
    })

    // F15 (audit-postmerge-2026-06-29): the WHATWG URL parser canonicalizes an IPv4-mapped IPv6
    // literal to the hex-compressed form (`[::ffff:127.0.0.1]` → host `::ffff:7f00:1`), which the
    // old dotted-decimal-only regex (`^::ffff:(\d+\.\d+\.\d+\.\d+)$`) never matched — so mapped
    // loopback / RFC-1918 / 169.254.169.254 slipped the deny-list. The fix denies the mapped form.
    it('blocks a redirect to a mapped-IPv6 loopback address (F15 SSRF bypass)', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      await expect(
        downloadToFile('https://cdn.example.test/a', dest, {
          fetchImpl: routeFetch(() => redirectTo('https://[::ffff:127.0.0.1]/x'))
        })
      ).rejects.toThrow(/private\/loopback/)
      expect(existsSync(dest)).toBe(false)
    })

    it('blocks a redirect to the mapped-IPv6 cloud-metadata address (F15)', async () => {
      const root = tempDir('hilbertraum-dl-')
      const dest = join(root, 'x.gguf')
      await expect(
        downloadToFile('https://cdn.example.test/a', dest, {
          fetchImpl: routeFetch(() => redirectTo('https://[::ffff:169.254.169.254]/latest/meta-data'))
        })
      ).rejects.toThrow(/private\/loopback/)
      expect(existsSync(dest)).toBe(false)
    })
  })

  // F15 — direct unit coverage on the host classifier. Feed it exactly what the enforcement seam
  // feeds it: `new URL(raw).hostname` (the canonicalized host), not the raw bracketed literal.
  describe('isPrivateOrLoopbackHost — IPv4-mapped IPv6 deny-list (F15)', () => {
    const hostOf = (raw: string): string => new URL(raw).hostname

    it('denies mapped-IPv6 loopback / private / link-local in every spelling', () => {
      // All of these canonicalize to `::ffff:<hex>:<hex>` and were NOT blocked before the fix.
      expect(isPrivateOrLoopbackHost(hostOf('https://[::ffff:127.0.0.1]/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost(hostOf('https://[::ffff:169.254.169.254]/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost(hostOf('https://[::ffff:10.0.0.1]/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost(hostOf('https://[::ffff:192.168.1.1]/x'))).toBe(true)
      // The fully-expanded long form canonicalizes to the same `::ffff:7f00:1`.
      expect(isPrivateOrLoopbackHost(hostOf('https://[0:0:0:0:0:ffff:127.0.0.1]/x'))).toBe(true)
    })

    it('still denies the pre-existing IPv4 + bare-IPv6 cases', () => {
      expect(isPrivateOrLoopbackHost(hostOf('https://127.0.0.1/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost(hostOf('https://169.254.169.254/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost(hostOf('https://10.0.0.5/x'))).toBe(true)
      expect(isPrivateOrLoopbackHost('::1')).toBe(true)
      expect(isPrivateOrLoopbackHost('localhost')).toBe(true)
    })

    it('still passes a legitimate public https host (positive control — no over-block)', () => {
      expect(isPrivateOrLoopbackHost(hostOf('https://huggingface.co/x'))).toBe(false)
      expect(isPrivateOrLoopbackHost(hostOf('https://cdn-lfs.huggingface.co/x'))).toBe(false)
      expect(isPrivateOrLoopbackHost(hostOf('https://8.8.8.8/x'))).toBe(false)
    })
  })
})

// F17 (audit-postmerge-2026-06-29): the body size cap must always be BOUNDED — a redirected /
// Content-Length-less endpoint must never fall through to a multi-GiB disk-fill. The hard backstop
// is now only reached when NOTHING bounds the body, and both in-app downloaders always pass a cap.
describe('download size caps (F17)', () => {
  const GiB = 1024 * 1024 * 1024
  const MARGIN = 1024 * 1024

  it('effectiveDownloadCap composes the smallest known bound + margin', () => {
    // Content-Length only.
    expect(effectiveDownloadCap(500, undefined)).toBe(500 + MARGIN)
    // maxBytes only.
    expect(effectiveDownloadCap(null, 100)).toBe(100 + MARGIN)
    // Both → the smaller wins.
    expect(effectiveDownloadCap(900, 100)).toBe(100 + MARGIN)
    expect(effectiveDownloadCap(100, 900)).toBe(100 + MARGIN)
  })

  it('effectiveDownloadCap falls back to a FINITE backstop (never unbounded) when nothing bounds the body', () => {
    const cap = effectiveDownloadCap(null, undefined)
    expect(Number.isFinite(cap)).toBe(true)
    expect(cap).toBeGreaterThan(0)
    // The backstop was lowered toward a realistic max single weight (≤ the old 64 GiB).
    expect(cap).toBeLessThanOrEqual(64 * GiB)
  })

  it('modelWeightMaxBytes uses the exact size when known, else a bounded per-role default', () => {
    // Known size → exact (the tight cap).
    expect(modelWeightMaxBytes('chat', 1234)).toBe(1234)
    // Absent size → a bounded role default (never null/unbounded), below the hard backstop.
    const chatDefault = modelWeightMaxBytes('chat', null)
    expect(chatDefault).toBeGreaterThan(0)
    expect(chatDefault).toBeLessThan(64 * GiB)
    // The small roles get a TIGHTER ceiling than chat/vision.
    expect(modelWeightMaxBytes('embeddings', null)).toBeLessThan(chatDefault)
    expect(modelWeightMaxBytes('reranker', null)).toBeLessThan(chatDefault)
  })

  it('ENGINE_DOWNLOAD_MAX_BYTES is bounded well below the hard backstop', () => {
    expect(ENGINE_DOWNLOAD_MAX_BYTES).toBeGreaterThan(0)
    expect(ENGINE_DOWNLOAD_MAX_BYTES).toBeLessThan(64 * GiB)
  })
})

describe('formatAssetPlan', () => {
  it('renders model tasks + the runtime plan', async () => {
    const root = tempDir('hilbertraum-fmt-')
    const tasks = await planModelDownloads(root, [manifest()], { acceptLicense: true })
    const build = selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'x64' })!
    const plan = planRuntimeDownload(root, build, 'b9196')
    const report = formatAssetPlan(tasks, plan)
    expect(report).toContain('Model weights:')
    expect(report).toContain('qwen3-4b-instruct-q4')
    expect(report).toContain('Runtime (llama.cpp sidecar):')
    expect(report).toContain('win/x64 cpu-avx2')
  })

  it('notes when no runtime build matched', () => {
    const report = formatAssetPlan([], null)
    expect(report).toContain('no matching build')
  })
})
