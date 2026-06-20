import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planCommercialDrive,
  formatPlan,
  assertCommercialDrive
} from '../../src/main/services/commercial-drive'
import { buildPolicyJson } from '../../src/main/services/drive'
import { writeRuntimeMarker } from '../../src/main/services/assets'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
import { validateRuntimeSources, type RuntimeSources } from '../../src/shared/runtime-sources'

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
    license_review: { status: 'approved', reviewed_by: 'legal', reviewed_at: '2026-06-09', notes: '' },
    ...overrides
  }
}

function asManifest(overrides: Record<string, unknown> = {}): ModelManifest {
  const res = validateManifest(manifestObj(overrides))
  if (!res.manifest) throw new Error('fixture invalid: ' + res.errors.join(', '))
  return res.manifest
}

/** Write a weight file + return a manifest whose sha256 matches its content (VERIFIED). */
function writeVerifiedWeight(root: string, id: string, relPath: string, content: string): ModelManifest {
  const dest = join(root, ...relPath.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  writeFileSync(dest, content)
  const sha = createHash('sha256').update(content).digest('hex')
  return asManifest({ id, local_path: relPath, sha256: sha })
}

function writePolicy(root: string, json: unknown): void {
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify(json))
}

/** Provision a trusted product skill under app-skills/ (skills plan S9) — a sold drive ships one. */
function provisionAppSkill(root: string, id = 'bank-statement'): void {
  const dir = join(root, 'app-skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    ['---', `id: ${id}`, `title: ${id}`, `description: ${id} skill`, 'version: 1.0.0', '---', 'Guidance.'].join('\n')
  )
}

describe('planCommercialDrive', () => {
  it('produces the ordered build steps with signing flagged manual', () => {
    const steps = planCommercialDrive({ target: 'E:\\', acceptLicense: true })
    expect(steps.map((s) => s.id)).toEqual([
      'prepare',
      'fetch-models',
      'fetch-runtime',
      'fetch-whisper',
      'fetch-ocr',
      'package',
      'copy-app',
      'verify',
      'assert'
    ])
    // Only the package (sign/notarize) step is manual.
    expect(steps.find((s) => s.id === 'package')!.manual).toBe(true)
    expect(steps.filter((s) => s.manual).map((s) => s.id)).toEqual(['package'])
    // --accept-license is threaded into fetch-models.
    expect(steps.find((s) => s.id === 'fetch-models')!.command).toContain('--accept-license')
  })

  it('omits --accept-license when not set and targets the requested OS for packaging', () => {
    const win = planCommercialDrive({ target: 'E:\\' })
    expect(win.find((s) => s.id === 'fetch-models')!.command).not.toContain('--accept-license')
    expect(win.find((s) => s.id === 'package')!.title).toMatch(/Windows/i)

    const mac = planCommercialDrive({ target: '/Volumes/HILBERTRAUM', os: 'mac' })
    expect(mac.find((s) => s.id === 'package')!.description).toMatch(/notarize/i)
  })

  it('targets the Linux AppImage when os=linux', () => {
    const linux = planCommercialDrive({ target: '/mnt/usb', os: 'linux' })
    const pkg = linux.find((s) => s.id === 'package')!
    expect(pkg.title).toMatch(/Linux AppImage/i)
    expect(pkg.command).toContain('--linux')
    expect(pkg.manual).toBe(true)
  })

  it('formatPlan renders ordered steps and marks the PACKAGE step (not another) manual', () => {
    const text = formatPlan(planCommercialDrive({ target: 'E:\\' }))
    expect(text).toMatch(/1\. Lay out the drive/)
    // The MANUAL tag must land on the package/sign line specifically.
    const manualLine = text.split('\n').find((l) => l.includes('[MANUAL'))!
    expect(manualLine).toMatch(/sign/i)
    // Non-manual steps are not tagged.
    expect(text).toMatch(/Lay out the drive[^\n]*$/m)
    expect(text.split('\n').find((l) => l.includes('Lay out the drive'))).not.toContain('[MANUAL')
  })
})

describe('assertCommercialDrive', () => {
  it('passes on a verified, commercial-posture drive with no user data', async () => {
    const root = tempDir('hilbertraum-commercial-ok-')
    writePolicy(root, buildPolicyJson()) // commercial default
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const embed = writeVerifiedWeight(root, 'embed', 'models/embeddings/e5.gguf', 'embed-weights')

    const res = await assertCommercialDrive(root, [chat, embed])

    expect(res.ok).toBe(true)
    expect(res.problems).toEqual([])
    expect(res.checks).toEqual({
      policyCommercial: true,
      networkDenied: true,
      weightsVerified: true,
      licensesApproved: true,
      noUserData: true,
      runtimeCurrent: true,
      ocrAssetsVerified: true,
      appSkillsPresent: true,
      userSkillsEmpty: true
    })
  })

  // Skills plan S9 / §14: a sold drive must ship at least one trusted product skill.
  it('fails when no app skills are provisioned', async () => {
    const root = tempDir('hilbertraum-commercial-noskill-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.appSkillsPresent).toBe(false)
    expect(res.problems.some((p) => /no app skills provisioned/i.test(p))).toBe(true)
  })

  // Skills plan S9 / §14: user-skills/ must ship empty (only trusted product skills are sold).
  it('fails when a user skill is present (user-skills/ must ship empty)', async () => {
    const root = tempDir('hilbertraum-commercial-userskill-')
    writePolicy(root, buildPolicyJson())
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'user-skills', 'my-imported'), { recursive: true })
    writeFileSync(join(root, 'user-skills', 'my-imported', 'SKILL.md'), 'x')
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.userSkillsEmpty).toBe(false)
    expect(res.checks.appSkillsPresent).toBe(true) // ONLY the user-skills gate failed
    expect(res.problems.some((p) => /user-skills\/my-imported/.test(p))).toBe(true)
  })

  // An empty user-skills/ directory (created by prepare-drive) is NOT a problem.
  it('an EMPTY user-skills/ directory is allowed', async () => {
    const root = tempDir('hilbertraum-commercial-emptyuser-')
    writePolicy(root, buildPolicyJson())
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'user-skills'), { recursive: true }) // empty
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(true)
    expect(res.checks.userSkillsEmpty).toBe(true)
  })

  // M11 (audit round 4): a sold drive requires every license_review APPROVED (spec §13).
  // --accept-license is download-time acceptance, never a substitute for the review.
  it('fails when a model license_review is not approved', async () => {
    const root = tempDir('hilbertraum-commercial-license-')
    writePolicy(root, buildPolicyJson())
    const pendingReview = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const notApproved = asManifest({
      id: pendingReview.id,
      local_path: pendingReview.localPath,
      sha256: pendingReview.sha256,
      license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
    })

    const res = await assertCommercialDrive(root, [notApproved])
    expect(res.ok).toBe(false)
    expect(res.checks.licensesApproved).toBe(false)
    expect(res.checks.weightsVerified).toBe(true) // ONLY the license gate failed
    expect(res.problems.some((p) => /license_review/.test(p))).toBe(true)
  })

  it('fails when the policy allows network', async () => {
    const root = tempDir('hilbertraum-commercial-net-')
    const policy = buildPolicyJson()
    policy.network.allow_model_downloads = true
    writePolicy(root, policy)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.networkDenied).toBe(false)
    expect(res.problems.some((p) => /network/i.test(p))).toBe(true)
  })

  it('fails when the policy allows a plaintext workspace', async () => {
    const root = tempDir('hilbertraum-commercial-plain-')
    writePolicy(root, buildPolicyJson({ dev: true })) // plaintext + unverified allowed
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.policyCommercial).toBe(false)
    expect(res.problems.some((p) => /plaintext/i.test(p))).toBe(true)
  })

  it('fails when a weight is a placeholder (cannot verify)', async () => {
    const root = tempDir('hilbertraum-commercial-weight-')
    writePolicy(root, buildPolicyJson())
    // Present file but the manifest carries the placeholder hash → unverified_placeholder.
    const dest = join(root, 'models', 'chat', 'ph.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'data')
    const placeholder = asManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })

    const res = await assertCommercialDrive(root, [placeholder])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.problems.some((p) => /not VERIFIED/i.test(p))).toBe(true)
  })

  it('fails when a weight has a real but MISMATCHED hash', async () => {
    const root = tempDir('hilbertraum-commercial-mismatch-')
    writePolicy(root, buildPolicyJson())
    const dest = join(root, 'models', 'chat', 'mm.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'actual-content')
    // A real (64-hex) hash that does NOT match the file content → mismatch.
    const mismatch = asManifest({ id: 'mm', local_path: 'models/chat/mm.gguf', sha256: 'a'.repeat(64) })

    const res = await assertCommercialDrive(root, [mismatch])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.modelResults[0].status).toBe('mismatch')
  })

  // DIST-2: a vision drive whose GGUF is fine but whose mmproj projector is missing/corrupt must
  // NOT pass the sell gate (it would ship a vision model that cannot start).
  it('fails a vision drive whose GGUF verifies but whose mmproj projector is MISSING', async () => {
    const root = tempDir('hilbertraum-commercial-vision-')
    writePolicy(root, buildPolicyJson())
    provisionAppSkill(root)
    const ggufContent = 'vlm-gguf'
    const dest = join(root, 'models', 'vision', 'vlm.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, ggufContent)
    const ggufSha = createHash('sha256').update(ggufContent).digest('hex')
    const vision = asManifest({
      id: 'vlm',
      role: 'vision',
      family: 'qwen2.5-vl',
      local_path: 'models/vision/vlm.gguf',
      sha256: ggufSha,
      // mmproj projector declared but its file never written → the model is half-installed.
      mmproj: { local_path: 'models/vision/vlm-mmproj.gguf', sha256: createHash('sha256').update('proj').digest('hex') }
    })

    const res = await assertCommercialDrive(root, [vision])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.modelResults[0].status).toBe('missing')
    expect(res.modelResults[0].localPath).toBe('models/vision/vlm-mmproj.gguf')
  })

  it('fails when there are no weights to verify (a sold drive ships weights pre-loaded)', async () => {
    const root = tempDir('hilbertraum-commercial-noweights-')
    writePolicy(root, buildPolicyJson())
    const res = await assertCommercialDrive(root, [])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.problems.some((p) => /no model weights/i.test(p))).toBe(true)
  })

  it('fails when user data is present (a sold drive must ship empty)', async () => {
    const root = tempDir('hilbertraum-commercial-userdata-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    // Simulate an already-initialised workspace.
    mkdirSync(join(root, 'workspace'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'hilbertraum.sqlite.enc'), 'encrypted-db')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /user data/i.test(p))).toBe(true)
  })

  // Each user-data artifact independently flips noUserData (matrix), incl. the WAL/SHM
  // sidecars a crash can leave behind (the P1 fix) and a non-empty documents dir.
  it.each([
    ['plaintext DB', 'workspace/hilbertraum.sqlite'],
    ['vault descriptor', 'config/workspace.json'],
    ['WAL sidecar', 'workspace/hilbertraum.sqlite-wal'],
    ['SHM sidecar', 'workspace/hilbertraum.sqlite-shm']
  ])('flags a %s as user data', async (_label, rel) => {
    const root = tempDir('hilbertraum-commercial-ud-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const dest = join(root, ...rel.split('/'))
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'x')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => p.includes(rel))).toBe(true)
  })

  it('flags a non-empty workspace/documents/ directory as user data', async () => {
    const root = tempDir('hilbertraum-commercial-docs-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'documents', 'contract.pdf'), 'imported')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /documents/i.test(p))).toBe(true)
  })

  it('an EMPTY workspace/documents/ directory is NOT user data', async () => {
    const root = tempDir('hilbertraum-commercial-emptydocs-')
    writePolicy(root, buildPolicyJson())
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true }) // empty
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(true)
    expect(res.checks.noUserData).toBe(true)
  })

  // Phase 14: when the runtime-sources pin is passed, every pinned build's
  // .hilbertraum-runtime.json install marker must match (version + backend).
  describe('runtime install markers (Phase 14)', () => {
    const sources = (): RuntimeSources => {
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
            }
          ]
        }
      })
      if (!res.sources) throw new Error('fixture invalid: ' + res.errors.join(', '))
      return res.sources
    }

    /** A marker alone is not an install (audit fix): write the binary too. */
    function writeInstall(dir: string, marker: Parameters<typeof writeRuntimeMarker>[1]): void {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'llama-server.exe'), 'fake-binary')
      writeRuntimeMarker(dir, marker)
    }

    function writeInstalls(root: string): void {
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      writeInstall(win, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
      writeInstall(join(win, 'cpu'), { version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64' })
    }

    it('passes when every pinned build has a binary + matching marker', async () => {
      const root = tempDir('hilbertraum-commercial-rt-ok-')
      writePolicy(root, buildPolicyJson())
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
    })

    it('fails when a pinned build has NO install marker', async () => {
      const root = tempDir('hilbertraum-commercial-rt-missing-')
      writePolicy(root, buildPolicyJson())
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      // Both binaries present, but only the win default has a marker.
      writeInstalls(root)
      rmSync(join(root, 'runtime', 'llama.cpp', 'win', 'cpu', '.hilbertraum-runtime.json'))
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /\.hilbertraum-runtime\.json/.test(p))).toBe(true)
    })

    it('fails when a marker exists but the binary is missing (half-deleted install)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-nobin-')
      writePolicy(root, buildPolicyJson())
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      rmSync(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'))
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /binary missing/.test(p))).toBe(true)
    })

    it('fails when a marker is STALE (CPU-era build under the vulkan pin)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-stale-')
      writePolicy(root, buildPolicyJson())
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      // Overwrite the win default marker with a cpu-era install.
      writeRuntimeMarker(join(root, 'runtime', 'llama.cpp', 'win'), {
        version: 'b9585',
        backend: 'cpu',
        os: 'win',
        arch: 'x64'
      })
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /does not match the pinned/.test(p))).toBe(true)
    })

    it('skips the marker check when no runtimeSources are passed (runtimeCurrent stays true)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-skip-')
      writePolicy(root, buildPolicyJson())
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      const res = await assertCommercialDrive(root, [chat])
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
    })

    // ---- Phase 36: the whisper family rides the same gate (binary = whisper-cli) ----

    const whisperSources = (): RuntimeSources => {
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
            }
          ]
        },
        whisper_cpp: {
          version: 'v1.8.6',
          builds: [
            {
              os: 'win',
              arch: 'x64',
              backend: 'cpu',
              url: 'https://example.test/whisper-bin-x64.zip',
              sha256: 'REPLACE_WITH_REAL_HASH',
              extract_to: 'runtime/whisper.cpp/win'
            }
          ]
        }
      })
      if (!res.whisper) throw new Error('fixture invalid: ' + res.errors.join(', '))
      return res.whisper
    }

    function writeWhisperInstall(root: string): void {
      const dir = join(root, 'runtime', 'whisper.cpp', 'win')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'whisper-cli.exe'), 'fake-whisper')
      writeRuntimeMarker(dir, { version: 'v1.8.6', backend: 'cpu', os: 'win', arch: 'x64' })
    }

    it('passes when the whisper pin has a whisper-cli binary + matching marker', async () => {
      const root = tempDir('hilbertraum-commercial-wh-ok-')
      writePolicy(root, buildPolicyJson())
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources())
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
    })

    it('fails when the whisper-cli binary is missing under the whisper pin', async () => {
      const root = tempDir('hilbertraum-commercial-wh-nobin-')
      writePolicy(root, buildPolicyJson())
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      rmSync(join(root, 'runtime', 'whisper.cpp', 'win', 'whisper-cli.exe'))
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /whisper-cli binary missing/.test(p))).toBe(true)
    })

    it('fails when the whisper marker version does not match the whisper pin', async () => {
      const root = tempDir('hilbertraum-commercial-wh-stale-')
      writePolicy(root, buildPolicyJson())
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      writeRuntimeMarker(join(root, 'runtime', 'whisper.cpp', 'win'), {
        version: 'v1.7.0',
        backend: 'cpu',
        os: 'win',
        arch: 'x64'
      })
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources())
      expect(res.ok).toBe(false)
      expect(res.problems.some((p) => /whisper build .*does not match the pinned v1\.8\.6/.test(p))).toBe(
        true
      )
    })
  })
})
