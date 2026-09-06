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

  // Phase 20: supports_thinking_mode is now load-bearing (it gates the Deep answer mode).
  it('parses supports_thinking_mode, defaulting to false when omitted', () => {
    expect(validateManifest(rawManifest({ supports_thinking_mode: true })).manifest?.supportsThinkingMode).toBe(true)
    expect(validateManifest(rawManifest({ supports_thinking_mode: false })).manifest?.supportsThinkingMode).toBe(false)
    expect(validateManifest(rawManifest()).manifest?.supportsThinkingMode).toBe(false)
  })

  it('rejects a non-boolean supports_thinking_mode', () => {
    const res = validateManifest(rawManifest({ supports_thinking_mode: 'yes' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('supports_thinking_mode'))).toBe(true)
  })

  // PR #308 audit decision 11: the per-model context-cache term of the graphics-memory fit
  // estimate (model-benchmarks.md §6.6). Optional; absent → the picker's 0.5 GiB default, so
  // the parsed field is UNDEFINED, not 0.5 — the default is the picker's, not the manifest's.
  it('parses estimated_context_cache_gib, leaving it undefined when omitted', () => {
    expect(validateManifest(rawManifest({ estimated_context_cache_gib: 2.4 })).manifest?.estimatedContextCacheGib).toBe(2.4)
    expect(validateManifest(rawManifest({ estimated_context_cache_gib: 0 })).manifest?.estimatedContextCacheGib).toBe(0)
    const absent = validateManifest(rawManifest())
    expect(absent.ok).toBe(true)
    expect(absent.manifest?.estimatedContextCacheGib).toBeUndefined()
    expect('estimatedContextCacheGib' in (absent.manifest ?? {})).toBe(false)
  })

  it('rejects a negative or non-numeric estimated_context_cache_gib (the field moves a recommendation)', () => {
    for (const value of [-1, 'x', '2.4', true, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const res = validateManifest(rawManifest({ estimated_context_cache_gib: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('estimated_context_cache_gib')), String(value)).toBe(true)
    }
  })

  // Issue #182: `speculative_decoding` is a CLOSED enum on purpose — a free-form argument list
  // would let a hand-edited on-drive manifest inject any llama-server flag (`--host 0.0.0.0`
  // defeats the loopback-only invariant, since extras are appended last and a later flag wins).
  it('parses speculative_decoding: mtp, absent by default', () => {
    expect(
      validateManifest(rawManifest({ speculative_decoding: 'mtp' })).manifest?.speculativeDecoding
    ).toBe('mtp')
    expect(validateManifest(rawManifest()).manifest?.speculativeDecoding).toBeUndefined()
  })

  it('rejects any speculative_decoding value outside the closed enum', () => {
    for (const value of ['draft-mtp', 'MTP', true, 1, ['mtp'], '--spec-type draft-mtp', '']) {
      const res = validateManifest(rawManifest({ speculative_decoding: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('speculative_decoding')), String(value)).toBe(true)
    }
  })

  it('rejects speculative_decoding on a non-chat role (only the chat ladder consumes it)', () => {
    const res = validateManifest(rawManifest({ role: 'embeddings', speculative_decoding: 'mtp' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('role: chat'))).toBe(true)
  })

  // vuln-scan-2026-06-21 [path-traversal]: a hostile manifest's local_path is rejected at the
  // source so discoverManifests records it in errors and SKIPS it — the throw on the model-list
  // path (which broke the whole Models screen) can no longer be reached by these shapes.
  it('rejects a local_path that escapes the drive root (.. segment)', () => {
    const res = validateManifest(rawManifest({ local_path: '../../../../etc/passwd' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('local_path'))).toBe(true)
  })

  it('rejects an absolute local_path (POSIX and Windows drive-letter forms)', () => {
    expect(validateManifest(rawManifest({ local_path: '/etc/shadow' })).ok).toBe(false)
    expect(validateManifest(rawManifest({ local_path: 'C:/Windows/system32/x' })).ok).toBe(false)
    expect(validateManifest(rawManifest({ local_path: 'C:\\Windows\\system32\\x' })).ok).toBe(false)
  })

  it('still accepts a normal drive-relative local_path (forward slashes)', () => {
    const res = validateManifest(rawManifest({ local_path: 'models/chat/ok.gguf' }))
    expect(res.ok).toBe(true)
  })
})

describe('validateManifest — optional download block (Phase 12)', () => {
  const downloadBlock = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true',
    sha256: 'REPLACE_WITH_REAL_HASH',
    size_bytes: 2497280256,
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
    expect(res.manifest?.download?.sizeBytes).toBe(2497280256)
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

  it('rejects a non-https download.url (L-2)', () => {
    const res = validateManifest(
      rawManifest({ download: downloadBlock({ url: 'http://huggingface.co/x/y.gguf' }) })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('https'))).toBe(true)
  })

  // #236: `license_url` renders as a link in the download dialog, so it takes the same
  // https-only rule as `download.url` — a hostile manifest cannot plant an http: or
  // javascript: destination behind the fixed "read the license" label.
  it('rejects a non-https license_url (http:, javascript:, a bare host) — #236', () => {
    for (const bad of ['http://example.test/LICENSE', 'javascript:alert(1)', 'example.test/LICENSE', '']) {
      const res = validateManifest(rawManifest({ download: downloadBlock({ license_url: bad }) }))
      expect(res.ok, `license_url ${JSON.stringify(bad)} must be refused`).toBe(false)
      expect(res.errors.some((e) => e.includes('download.license_url') && e.includes('https'))).toBe(true)
    }
  })

  it('rejects a non-https mmproj.download.license_url too (#236)', () => {
    const hash = 'd'.repeat(64)
    const res = validateManifest(
      rawManifest({
        role: 'vision',
        mmproj: {
          local_path: 'models/vision/mmproj.gguf',
          sha256: hash,
          download: { url: 'https://x/y.gguf', sha256: hash, license_url: 'http://x/LICENSE' }
        }
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.download.license_url'))).toBe(true)
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

  // Issue #196: the publisher deleted the exact file a manifest pins. The block stays (it is the
  // provenance record of the weight existing drives carry); `withdrawn` marks the URL as dead so
  // no code path requests it.
  describe('download.withdrawn (issue #196)', () => {
    it('is absent by default — every existing manifest keeps a live source', () => {
      const res = validateManifest(rawManifest({ download: downloadBlock() }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.download?.withdrawn).toBeUndefined()
    })

    it('accepts a dated note and trims it', () => {
      const note = '2026-08-20: upstream deleted the file (Dynamic 3.0 restructure)'
      const res = validateManifest(rawManifest({ download: downloadBlock({ withdrawn: `  ${note}  ` }) }))
      expect(res.ok).toBe(true)
      expect(res.manifest?.download?.withdrawn).toBe(note)
    })

    it('rejects an empty note — "withdrawn" with no reason is worse than no field', () => {
      const res = validateManifest(rawManifest({ download: downloadBlock({ withdrawn: '   ' }) }))
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('download.withdrawn'))).toBe(true)
    })

    it('rejects a boolean — the note is shown to the user, not a flag', () => {
      const res = validateManifest(rawManifest({ download: downloadBlock({ withdrawn: true }) }))
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('download.withdrawn'))).toBe(true)
    })

    it('applies to an mmproj.download block too (one definition, both slots)', () => {
      const res = validateManifest(
        rawManifest({
          download: downloadBlock(),
          role: 'vision',
          mmproj: {
            local_path: 'models/vision/x-mmproj.gguf',
            sha256: 'REPLACE_WITH_REAL_HASH',
            download: downloadBlock({ withdrawn: 5 })
          }
        })
      )
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('mmproj.download.withdrawn'))).toBe(true)
    })
  })
})

describe('validateManifest — vision role + mmproj projector (image-understanding §8.1)', () => {
  const mmprojBlock = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    local_path: 'models/vision/qwen2.5-vl-3b-mmproj-f16.gguf',
    sha256: 'REPLACE_WITH_REAL_HASH',
    ...overrides
  })
  const visionRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    rawManifest({
      id: 'qwen2.5-vl-3b-instruct-q4',
      role: 'vision',
      family: 'qwen2.5-vl',
      local_path: 'models/vision/qwen2.5-vl-3b-instruct-q4.gguf',
      input_modalities: ['text', 'image'],
      mmproj: mmprojBlock(),
      ...overrides
    })

  it('accepts the vision role with a well-formed mmproj block and camelCases it', () => {
    const res = validateManifest(visionRaw())
    expect(res.ok).toBe(true)
    expect(res.manifest?.role).toBe('vision')
    expect(res.manifest?.mmproj?.localPath).toContain('mmproj')
    expect(res.manifest?.mmproj?.sha256).toBe('replace_with_real_hash')
    expect(res.manifest?.inputModalities).toEqual(['text', 'image'])
  })

  it('requires the mmproj block when role is vision', () => {
    const raw = visionRaw()
    delete raw.mmproj
    const res = validateManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj'))).toBe(true)
  })

  it('leaves non-vision manifests unaffected (no mmproj needed)', () => {
    const res = validateManifest(rawManifest())
    expect(res.ok).toBe(true)
    expect(res.manifest?.mmproj).toBeUndefined()
  })

  it('rejects an mmproj block with an empty local_path', () => {
    const res = validateManifest(visionRaw({ mmproj: mmprojBlock({ local_path: '' }) }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.local_path'))).toBe(true)
  })

  it('rejects an mmproj.local_path that escapes the drive root (vuln-scan 2026-06-21)', () => {
    const res = validateManifest(visionRaw({ mmproj: mmprojBlock({ local_path: '../../secret.gguf' }) }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.local_path'))).toBe(true)
  })

  it('rejects a non-mapping mmproj block', () => {
    const res = validateManifest(visionRaw({ mmproj: 'nope' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"mmproj"'))).toBe(true)
  })

  it('accepts an mmproj.download block and validates its https url', () => {
    const res = validateManifest(
      visionRaw({
        mmproj: mmprojBlock({
          download: {
            url: 'https://huggingface.co/ggml-org/x/resolve/main/mmproj-f16.gguf?download=true',
            sha256: 'REPLACE_WITH_REAL_HASH',
            size_bytes: 1338428128
          }
        })
      })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.mmproj?.download?.sizeBytes).toBe(1338428128)
  })

  it('rejects a non-https mmproj.download.url (L-2)', () => {
    const res = validateManifest(
      visionRaw({
        mmproj: mmprojBlock({ download: { url: 'http://x/y.gguf', sha256: 'REPLACE_WITH_REAL_HASH' } })
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.download.url'))).toBe(true)
  })

  it('rejects a real mmproj.download.sha256 that differs from a real mmproj.sha256', () => {
    const res = validateManifest(
      visionRaw({
        mmproj: mmprojBlock({
          sha256: 'a'.repeat(64),
          download: { url: 'https://x/y.gguf', sha256: 'b'.repeat(64) }
        })
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.download.sha256'))).toBe(true)
  })

  it('accepts matching real hashes on the mmproj file + its download', () => {
    const hash = 'd'.repeat(64)
    const res = validateManifest(
      visionRaw({
        mmproj: mmprojBlock({ sha256: hash, download: { url: 'https://x/y.gguf', sha256: hash } })
      })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.mmproj?.sha256).toBe(hash)
  })

  it('still ignores unknown keys on a vision manifest (forward-compatible)', () => {
    const res = validateManifest(visionRaw({ some_future_key: 'whatever' }))
    expect(res.ok).toBe(true)
  })

  it('rejects a non-list input_modalities', () => {
    const res = validateManifest(visionRaw({ input_modalities: 'text' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('input_modalities'))).toBe(true)
  })
})

// TG-1: the `translation` role (TranslateGemma). Unlike vision it is a single-file GGUF (no
// mmproj), so the only role-specific fact is that the role string is accepted; everything else
// rides the shared manifest schema. An older build that predates the role treats such a manifest
// as `unsupported` (validator rejects an unknown role) — the same forward-compatible rollout as
// vision/transcriber.
describe('validateManifest — translation role (TranslateGemma, TG-1)', () => {
  const translationRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    rawManifest({
      id: 'translategemma-12b-it-q4',
      role: 'translation',
      family: 'translategemma',
      local_path: 'models/translation/translategemma-12b-it.Q4_K_M.gguf',
      ...overrides
    })

  it('accepts the translation role (single-file GGUF, no mmproj required)', () => {
    const res = validateManifest(translationRaw())
    expect(res.ok).toBe(true)
    expect(res.manifest?.role).toBe('translation')
    expect(res.manifest?.mmproj).toBeUndefined()
  })

  it('accepts a translation manifest with a download block + pending license review', () => {
    const res = validateManifest(
      translationRaw({
        license: 'gemma',
        license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: 'Gemma Terms' },
        download: {
          url: 'https://huggingface.co/mradermacher/translategemma-12b-it-GGUF/resolve/main/translategemma-12b-it.Q4_K_M.gguf?download=true',
          sha256: 'b7aac4b4be7ab0c49b6556c29c4467e74313df7f1e95d9f9676bb2adf0afa528',
          size_bytes: 7300794112,
          license_url: 'https://ai.google.dev/gemma/terms'
        }
      })
    )
    expect(res.ok).toBe(true)
    expect(res.manifest?.licenseReview.status).toBe('pending')
    expect(res.manifest?.download?.sizeBytes).toBe(7300794112)
  })

  it('still rejects an unknown role (the pre-role build behaviour)', () => {
    const res = validateManifest(translationRaw({ role: 'translater' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('role'))).toBe(true)
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
