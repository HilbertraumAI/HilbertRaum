import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planCommercialDrive,
  formatPlan,
  assertCommercialDrive
} from '../../src/main/services/commercial-drive'
import { buildPolicyJson } from '../../src/main/services/drive'
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

describe('planCommercialDrive', () => {
  it('produces the ordered build steps with signing flagged manual', () => {
    const steps = planCommercialDrive({ target: 'E:\\', acceptLicense: true })
    expect(steps.map((s) => s.id)).toEqual([
      'prepare',
      'fetch-models',
      'fetch-runtime',
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

    const mac = planCommercialDrive({ target: '/Volumes/PAID', os: 'mac' })
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
    const root = tempDir('paid-commercial-ok-')
    writePolicy(root, buildPolicyJson()) // commercial default
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const embed = writeVerifiedWeight(root, 'embed', 'models/embeddings/e5.gguf', 'embed-weights')

    const res = await assertCommercialDrive(root, [chat, embed])

    expect(res.ok).toBe(true)
    expect(res.problems).toEqual([])
    expect(res.checks).toEqual({
      policyCommercial: true,
      networkDenied: true,
      weightsVerified: true,
      noUserData: true
    })
  })

  it('fails when the policy allows network', async () => {
    const root = tempDir('paid-commercial-net-')
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
    const root = tempDir('paid-commercial-plain-')
    writePolicy(root, buildPolicyJson({ dev: true })) // plaintext + unverified allowed
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.policyCommercial).toBe(false)
    expect(res.problems.some((p) => /plaintext/i.test(p))).toBe(true)
  })

  it('fails when a weight is a placeholder (cannot verify)', async () => {
    const root = tempDir('paid-commercial-weight-')
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
    const root = tempDir('paid-commercial-mismatch-')
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

  it('fails when there are no weights to verify (a sold drive ships weights pre-loaded)', async () => {
    const root = tempDir('paid-commercial-noweights-')
    writePolicy(root, buildPolicyJson())
    const res = await assertCommercialDrive(root, [])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.problems.some((p) => /no model weights/i.test(p))).toBe(true)
  })

  it('fails when user data is present (a sold drive must ship empty)', async () => {
    const root = tempDir('paid-commercial-userdata-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    // Simulate an already-initialised workspace.
    mkdirSync(join(root, 'workspace'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'paid.sqlite.enc'), 'encrypted-db')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /user data/i.test(p))).toBe(true)
  })

  // Each user-data artifact independently flips noUserData (matrix), incl. the WAL/SHM
  // sidecars a crash can leave behind (the P1 fix) and a non-empty documents dir.
  it.each([
    ['plaintext DB', 'workspace/paid.sqlite'],
    ['vault descriptor', 'config/workspace.json'],
    ['WAL sidecar', 'workspace/paid.sqlite-wal'],
    ['SHM sidecar', 'workspace/paid.sqlite-shm']
  ])('flags a %s as user data', async (_label, rel) => {
    const root = tempDir('paid-commercial-ud-')
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
    const root = tempDir('paid-commercial-docs-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'documents', 'contract.pdf'), 'imported')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /documents/i.test(p))).toBe(true)
  })

  it('an EMPTY workspace/documents/ directory is NOT user data', async () => {
    const root = tempDir('paid-commercial-emptydocs-')
    writePolicy(root, buildPolicyJson())
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true }) // empty
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(true)
    expect(res.checks.noUserData).toBe(true)
  })
})
