import { describe, it, expect } from 'vitest'
import { validateManifest, isRealSha256 } from '../../src/shared/manifest'

// A minimal valid raw manifest (snake_case, as parsed from YAML).
function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('validateManifest', () => {
  it('accepts a well-formed manifest and camelCases fields', () => {
    const res = validateManifest(rawManifest())
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.manifest?.id).toBe('qwen3-4b-instruct-q4')
    expect(res.manifest?.displayName).toBe('Qwen3 4B Instruct Q4')
    expect(res.manifest?.recommendedContextTokens).toBe(4096)
    expect(res.manifest?.recommendedProfiles).toEqual(['LITE'])
    expect(res.manifest?.licenseReview.status).toBe('pending')
  })

  it('rejects a non-object', () => {
    const res = validateManifest('nope')
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it('reports a missing required field', () => {
    const raw = rawManifest()
    delete raw.id
    const res = validateManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"id"'))).toBe(true)
  })

  it('rejects an invalid role', () => {
    const res = validateManifest(rawManifest({ role: 'wizard' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('role'))).toBe(true)
  })

  it('rejects a non-numeric size', () => {
    const res = validateManifest(rawManifest({ size_on_disk_gb: 'big' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('size_on_disk_gb'))).toBe(true)
  })

  it('requires the license_review block', () => {
    const raw = rawManifest()
    delete raw.license_review
    const res = validateManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('license_review'))).toBe(true)
  })

  it('rejects bad recommended_profiles', () => {
    const res = validateManifest(rawManifest({ recommended_profiles: ['HUGE'] }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('recommended_profiles'))).toBe(true)
  })

  it('defaults recommended_profiles to empty when omitted', () => {
    const raw = rawManifest()
    delete raw.recommended_profiles
    const res = validateManifest(raw)
    expect(res.ok).toBe(true)
    expect(res.manifest?.recommendedProfiles).toEqual([])
  })
})

describe('validateManifest — optional download block (Phase 12)', () => {
  const downloadBlock = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true',
    sha256: 'REPLACE_WITH_REAL_HASH',
    size_bytes: 2700000000,
    license_url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE',
    ...overrides
  })

  it('stays valid when the download block is absent (existing manifests)', () => {
    const res = validateManifest(rawManifest())
    expect(res.ok).toBe(true)
    expect(res.manifest?.download).toBeUndefined()
  })

  it('accepts a well-formed download block and camelCases its fields', () => {
    const res = validateManifest(rawManifest({ download: downloadBlock() }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.download?.url).toContain('Qwen3-4B-Q4_K_M.gguf')
    expect(res.manifest?.download?.sha256).toBe('replace_with_real_hash')
    expect(res.manifest?.download?.sizeBytes).toBe(2700000000)
    expect(res.manifest?.download?.licenseUrl).toContain('LICENSE')
  })

  it('treats size_bytes + license_url as optional within the block', () => {
    const res = validateManifest(
      rawManifest({ download: downloadBlock({ size_bytes: undefined, license_url: undefined }) })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.download?.sizeBytes).toBeNull()
    expect(res.manifest?.download?.licenseUrl).toBeNull()
  })

  it('rejects a download block missing a url', () => {
    const res = validateManifest(rawManifest({ download: downloadBlock({ url: '' }) }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('download.url'))).toBe(true)
  })

  it('rejects a non-mapping download block', () => {
    const res = validateManifest(rawManifest({ download: 'http://x' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"download"'))).toBe(true)
  })

  it('rejects a negative size_bytes', () => {
    const res = validateManifest(rawManifest({ download: downloadBlock({ size_bytes: -5 }) }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('download.size_bytes'))).toBe(true)
  })

  it('rejects a real download.sha256 that differs from a real top-level sha256', () => {
    const res = validateManifest(
      rawManifest({ sha256: 'a'.repeat(64), download: downloadBlock({ sha256: 'b'.repeat(64) }) })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('download.sha256'))).toBe(true)
  })

  it('accepts matching real hashes on both levels', () => {
    const hash = 'c'.repeat(64)
    const res = validateManifest(rawManifest({ sha256: hash, download: downloadBlock({ sha256: hash }) }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.download?.sha256).toBe(hash)
  })
})

describe('isRealSha256', () => {
  it('accepts a 64-char lower-case hex string', () => {
    expect(isRealSha256('a'.repeat(64))).toBe(true)
  })
  it('rejects placeholders and wrong lengths', () => {
    expect(isRealSha256('REPLACE_WITH_REAL_HASH')).toBe(false)
    expect(isRealSha256('abc')).toBe(false)
    expect(isRealSha256('A'.repeat(64))).toBe(false) // upper-case not allowed
  })
})
