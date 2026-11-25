import { describe, it, expect } from 'vitest'
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  validateManifest,
  isRealSha256,
  manifestNeedsNewerApp,
  pickManifestForRole,
  type ModelManifest,
  type ModelRole
} from '../../src/shared/manifest'
import { discoverManifests, setManifestAppVersion } from '../../src/main/services/models'
import { rawManifest } from '../helpers/manifest-fixtures'
import { DESKTOP_ROOT } from '../helpers/repo-files'

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
    // A manifest declaring none of the optional blocks stays valid, and each is absent (`files` absent, not empty).
    expect(res.manifest?.download).toBeUndefined()
    expect(res.manifest?.mmproj).toBeUndefined()
    expect(res.manifest).not.toHaveProperty('files')
  })

  it('rejects a non-object', () => {
    const res = validateManifest('nope')
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  it.each(['id', 'display_name', 'family', 'role', 'format', 'runtime', 'license', 'size_on_disk_gb', 'recommended_min_ram_gb', 'recommended_ram_gb', 'recommended_context_tokens', 'local_path', 'sha256'])('reports a missing required field: %s', (key) => {
    const raw = rawManifest()
    delete raw[key]
    const res = validateManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes(`"${key}"`))).toBe(true)
  })

  it('rejects an invalid role', () => {
    const res = validateManifest(rawManifest({ role: 'wizard' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('role'))).toBe(true)
  })

  it.each(['size_on_disk_gb', 'recommended_min_ram_gb', 'recommended_ram_gb', 'recommended_context_tokens'])('rejects a non-numeric or negative %s', (key) => {
    for (const value of ['big', -1, Number.NaN]) {
      const res = validateManifest(rawManifest({ [key]: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes(key)), String(value)).toBe(true)
    }
  })

  it('requires the license_review block and a known status', () => {
    const raw = rawManifest()
    delete raw.license_review
    const res = validateManifest(raw)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('license_review'))).toBe(true)
    const bad = validateManifest(rawManifest({ license_review: { status: 'nope' } }))
    expect(bad.ok).toBe(false)
    expect(bad.errors.some((e) => e.includes('license_review.status'))).toBe(true)
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

  // Phase 20: supports_thinking_mode gates the Deep answer mode. #766: bundled_on_preconfigured_drive picks what a Kit
  // preloads and the sell gate requires.
  it.each([
    ['supports_thinking_mode', 'supportsThinkingMode'],
    ['bundled_on_preconfigured_drive', 'bundledOnPreconfiguredDrive']
  ] as const)('parses %s, defaulting to false when omitted, and rejects a non-boolean', (key, field) => {
    expect(validateManifest(rawManifest({ [key]: true })).manifest?.[field]).toBe(true)
    expect(validateManifest(rawManifest({ [key]: false })).manifest?.[field]).toBe(false)
    expect(validateManifest(rawManifest()).manifest?.[field]).toBe(false)
    const res = validateManifest(rawManifest({ [key]: 'yes' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes(key))).toBe(true)
  })

  it('rejects a non-numeric recommendation_rank (the field moves a recommendation)', () => {
    for (const value of ['2', true, Number.NaN, null]) {
      const res = validateManifest(rawManifest({ recommendation_rank: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('recommendation_rank')), String(value)).toBe(true)
    }
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

  // #321: the measured host-mapped weight share, validated exactly like the cache term above —
  // it moves a recommendation too, so a typo must fail the manifest rather than silently widen
  // the estimate. Absent → `estimateGraphicsNeedMib` keeps its whole-file arithmetic.
  it('parses host_mapped_weights_mib, leaving it undefined when omitted (#321)', () => {
    expect(validateManifest(rawManifest({ host_mapped_weights_mib: 2152.5 })).manifest?.hostMappedWeightsMib).toBe(2152.5)
    expect(validateManifest(rawManifest({ host_mapped_weights_mib: 0 })).manifest?.hostMappedWeightsMib).toBe(0)
    const absent = validateManifest(rawManifest())
    expect(absent.ok).toBe(true)
    expect(absent.manifest?.hostMappedWeightsMib).toBeUndefined()
    expect('hostMappedWeightsMib' in (absent.manifest ?? {})).toBe(false)
  })

  it('rejects a negative or non-numeric host_mapped_weights_mib (#321)', () => {
    for (const value of [-1, 'x', '545.62', true, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const res = validateManifest(rawManifest({ host_mapped_weights_mib: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('host_mapped_weights_mib')), String(value)).toBe(true)
    }
  })

  // The processor-path fields (model-benchmarks.md §6.7): optional, and validated like the other
  // fields that move a recommendation. Absent leaves the manifest shape unchanged.
  it('parses recommendation_rank_cpu and step_down_to, leaving both undefined when omitted (§6.7)', () => {
    const both = validateManifest(rawManifest({ recommendation_rank_cpu: 0, step_down_to: ' lighter-model ' })).manifest
    expect(both?.recommendationRankCpu).toBe(0)
    expect(both?.stepDownTo).toBe('lighter-model')
    expect(validateManifest(rawManifest({ recommendation_rank_cpu: 3 })).manifest?.recommendationRankCpu).toBe(3)
    const absent = validateManifest(rawManifest())
    expect(absent.ok).toBe(true)
    expect('recommendationRankCpu' in (absent.manifest ?? {})).toBe(false)
    expect('stepDownTo' in (absent.manifest ?? {})).toBe(false)
  })

  it('rejects a negative or non-numeric recommendation_rank_cpu and an empty or non-string step_down_to (§6.7)', () => {
    for (const value of [-1, 'x', '3', true, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const res = validateManifest(rawManifest({ recommendation_rank_cpu: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('recommendation_rank_cpu')), String(value)).toBe(true)
    }
    for (const value of ['', '   ', 3, true, ['a'], null]) {
      const res = validateManifest(rawManifest({ step_down_to: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('step_down_to')), String(value)).toBe(true)
    }
  })

  // The card-path fields (model-benchmarks.md §6.8), validated the same way.
  it('parses recommendation_rank_gpu and projected_graphics_need_mib, leaving both undefined when omitted (§6.8)', () => {
    const both = validateManifest(rawManifest({ recommendation_rank_gpu: 0, projected_graphics_need_mib: 5919 })).manifest
    expect(both?.recommendationRankGpu).toBe(0)
    expect(both?.projectedGraphicsNeedMib).toBe(5919)
    const absent = validateManifest(rawManifest())
    expect('recommendationRankGpu' in (absent.manifest ?? {})).toBe(false)
    expect('projectedGraphicsNeedMib' in (absent.manifest ?? {})).toBe(false)
  })

  it('rejects a negative or non-numeric recommendation_rank_gpu or projected_graphics_need_mib (§6.8)', () => {
    for (const key of ['recommendation_rank_gpu', 'projected_graphics_need_mib']) {
      for (const value of [-1, 'x', '3', true, Number.NaN, Number.POSITIVE_INFINITY, null]) {
        const res = validateManifest(rawManifest({ [key]: value }))
        expect(res.ok, `${key}=${String(value)}`).toBe(false)
        expect(res.errors.some((e) => e.includes(key)), `${key}=${String(value)}`).toBe(true)
      }
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

  // Issue #512: `disable_prompt_cache` states a fact (this model cannot restore an evicted prompt on
  // the pinned runtime); the runtime maps true to the code-owned `--cache-ram 0`. Default false =
  // cache on, today's behaviour for every manifest without the field.
  it('parses disable_prompt_cache: true; false and absent both leave the field off', () => {
    expect(
      validateManifest(rawManifest({ disable_prompt_cache: true })).manifest?.disablePromptCache
    ).toBe(true)
    for (const raw of [rawManifest({ disable_prompt_cache: false }), rawManifest()]) {
      const res = validateManifest(raw)
      expect(res.ok).toBe(true)
      expect(res.manifest?.disablePromptCache).toBeUndefined()
    }
  })

  it('rejects a non-boolean disable_prompt_cache', () => {
    for (const value of ['true', 'yes', 1, 0, null, ['--cache-ram', '0'], { ram: 0 }]) {
      const res = validateManifest(rawManifest({ disable_prompt_cache: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('disable_prompt_cache')), String(value)).toBe(true)
    }
  })

  it('rejects disable_prompt_cache on a non-chat role (only the chat argv builder reads it)', () => {
    for (const role of ['embeddings', 'reranker', 'vision', 'translation']) {
      const res = validateManifest(rawManifest({ role, disable_prompt_cache: true }))
      expect(res.ok, role).toBe(false)
      expect(
        res.errors.some((e) => e.includes('disable_prompt_cache') && e.includes('role: chat')),
        role
      ).toBe(true)
    }
    // false on another role is also rejected: the key is chat-only, whatever its value.
    expect(validateManifest(rawManifest({ role: 'embeddings', disable_prompt_cache: false })).ok).toBe(false)
  })

  // #848: `default_for_role` names the manifest `resolveModelByRole` takes for its role ahead of walk order. A typo fails
  // the manifest like every optional field's; on chat it is inert (the active chat model is the user's pick) and accepted,
  // never rejected: a field this release reads must not make a later manifest vanish from it (D848-3).
  it('parses default_for_role: true; false and absent both leave the field off (#848)', () => {
    expect(validateManifest(rawManifest({ role: 'embeddings', default_for_role: true })).manifest?.defaultForRole).toBe(true)
    for (const raw of [rawManifest({ role: 'embeddings', default_for_role: false }), rawManifest({ role: 'embeddings' })]) {
      const res = validateManifest(raw)
      expect(res.ok).toBe(true)
      expect(res.manifest).not.toHaveProperty('defaultForRole')
    }
  })

  it('rejects a non-boolean default_for_role, and accepts the flag on chat, where nothing reads it (#848)', () => {
    for (const value of ['true', 'yes', 1, null, ['embeddings']]) {
      const res = validateManifest(rawManifest({ role: 'embeddings', default_for_role: value }))
      expect(res.ok, String(value)).toBe(false)
      expect(res.errors.some((e) => e.includes('default_for_role')), String(value)).toBe(true)
    }
    expect(validateManifest(rawManifest({ role: 'chat', default_for_role: true })).ok).toBe(true)
  })

  // vuln-scan-2026-06-21 [path-traversal]: a hostile manifest's local_path is rejected at the
  // source so discoverManifests records it in errors and SKIPS it — the throw on the model-list
  // path (which broke the whole Models screen) can no longer be reached by these shapes.
  it('rejects a local_path that escapes the drive root (.. segment)', () => {
    const res = validateManifest(rawManifest({ local_path: '../../../../etc/passwd' }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('local_path'))).toBe(true)
  })

  it('rejects an absolute local_path (POSIX, Windows drive-letter and UNC forms)', () => {
    for (const p of ['/etc/shadow', 'C:/Windows/system32/x', 'C:\\Windows\\system32\\x', '\\\\server\\share\\x.gguf']) {
      const res = validateManifest(rawManifest({ local_path: p }))
      expect(res.ok, p).toBe(false)
      expect(res.errors.some((e) => e.includes('"local_path"')), p).toBe(true)
    }
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

  it('accepts a well-formed download block and camelCases its fields', () => {
    const res = validateManifest(rawManifest({ download: downloadBlock() }))
    expect(res.ok).toBe(true)
    expect(res.manifest?.download?.url).toContain('Qwen3-4B-Q4_K_M.gguf')
    expect(res.manifest?.download?.sha256).toBe('replace_with_real_hash')
    expect(res.manifest?.download?.sizeBytes).toBe(2497280256)
    expect(res.manifest?.download?.licenseUrl).toContain('LICENSE')
    expect(res.manifest?.download?.withdrawn).toBeUndefined() // every existing manifest keeps a live source
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

  it('rejects a download block with no sha256 (every fetched file needs a hash or an explicit placeholder)', () => {
    const res = validateManifest(rawManifest({ download: downloadBlock({ sha256: undefined }) }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"download.sha256" is required and must be a string (hash or placeholder)')
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
  // javascript: destination behind the fixed "Read the license" label.
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

  it('rejects an mmproj block with an empty local_path', () => {
    const res = validateManifest(visionRaw({ mmproj: mmprojBlock({ local_path: '' }) }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.local_path'))).toBe(true)
  })

  it('rejects an mmproj block with no sha256', () => {
    const res = validateManifest(visionRaw({ mmproj: mmprojBlock({ sha256: undefined }) }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"mmproj.sha256" is required and must be a string (hash or placeholder)')
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

  /** The GGUF's own source: the two blocks are all-or-nothing, so every projector-source row needs it. */
  const WEIGHT_DOWNLOAD = { url: 'https://x/weight.gguf', sha256: 'REPLACE_WITH_REAL_HASH' }

  it('accepts an mmproj.download block and validates its https url', () => {
    const res = validateManifest(
      visionRaw({
        download: WEIGHT_DOWNLOAD,
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

  // Half the blocks is a clean multi-GB download of a model that stays `missing` (#752): the planner
  // fetches only what is declared. A hand-made manifest finds out here, not after the download.
  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'the GGUF has a source and the projector has none',
      { download: WEIGHT_DOWNLOAD },
      /"mmproj\.download" is required when the model declares a top-level "download"/
    ],
    [
      'the projector has a source and the GGUF has none',
      { mmproj: mmprojBlock({ download: { url: 'https://x/y.gguf', sha256: 'REPLACE_WITH_REAL_HASH' } }) },
      /"download" is required when "mmproj" declares one/
    ]
  ])('rejects a vision manifest where %s', (_title, overrides, message) => {
    const res = validateManifest(visionRaw(overrides))
    expect(res.ok).toBe(false)
    expect(res.errors.join('\n')).toMatch(message)
  })

  it('rejects a non-https mmproj.download.url (L-2)', () => {
    const res = validateManifest(
      visionRaw({
        download: WEIGHT_DOWNLOAD,
        mmproj: mmprojBlock({ download: { url: 'http://x/y.gguf', sha256: 'REPLACE_WITH_REAL_HASH' } })
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('mmproj.download.url'))).toBe(true)
  })

  it('rejects a real mmproj.download.sha256 that differs from a real mmproj.sha256', () => {
    const res = validateManifest(
      visionRaw({
        download: WEIGHT_DOWNLOAD,
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
        download: WEIGHT_DOWNLOAD,
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

  it('rejects an input_modalities that is not a list of strings', () => {
    for (const value of ['text', ['text', 1]]) {
      const res = validateManifest(visionRaw({ input_modalities: value }))
      expect(res.ok).toBe(false)
      expect(res.errors.some((e) => e.includes('input_modalities'))).toBe(true)
    }
  })
})

// TG-1: the `translation` role (TranslateGemma). Unlike vision it is a single-file GGUF (no
// mmproj), so the only role-specific fact is that the role string is accepted; everything else
// rides the shared manifest schema. A build that predates a role lists such a manifest as needing a
// newer HilbertRaum (#847: discovery routes an unknown role to `parseUnsupportedManifest`; the validator
// itself still rejects it); builds up to v0.1.65 reject it, so it vanishes there.
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
})

// #310: a weight that ships as several files (llama.cpp's `-00001-of-000NN` shard set, or any
// second file a model needs) is declared in an optional `files:` list — path + hash + optional
// source per file. The validator is fail-closed: a partial or inconsistent declaration is an
// error, never a silently-half-verified model.
describe('validateManifest — files: additional required files (#310)', () => {
  const SHARD1 = 'models/chat/big-00001-of-00004.gguf'
  const shardRaw = (files: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    rawManifest({ local_path: SHARD1, ...(files === undefined ? {} : { files }), ...overrides })
  const shard = (n: number, total = 4): string =>
    `models/chat/big-${String(n).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`
  const allShards = (): unknown[] =>
    [2, 3, 4].map((n) => ({ local_path: shard(n), sha256: 'REPLACE_WITH_REAL_HASH' }))

  it('accepts a complete shard set and camelCases every entry', () => {
    const res = validateManifest(shardRaw(allShards()))
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.manifest?.localPath).toBe(SHARD1)
    expect(res.manifest?.files?.map((f) => f.localPath)).toEqual([shard(2), shard(3), shard(4)])
    expect(res.manifest?.files?.every((f) => f.sha256 === 'replace_with_real_hash')).toBe(true)
  })

  it('accepts a NON-shard extra file (the field is generic, not shard-only)', () => {
    const res = validateManifest(
      rawManifest({ files: [{ local_path: 'models/chat/tokenizer.bin', sha256: 'a'.repeat(64) }] })
    )
    expect(res.errors).toEqual([])
    expect(res.manifest?.files).toEqual([
      { localPath: 'models/chat/tokenizer.bin', sha256: 'a'.repeat(64) }
    ])
  })

  it('round-trips a per-file download block', () => {
    const primary = 'b'.repeat(64)
    const second = 'c'.repeat(64)
    const res = validateManifest(
      rawManifest({
        local_path: shard(1, 2),
        sha256: primary,
        download: { url: 'https://x/1.gguf', sha256: primary, size_bytes: 10 },
        files: [
          {
            local_path: shard(2, 2),
            sha256: second,
            download: { url: 'https://x/2.gguf', sha256: second, size_bytes: 20 }
          }
        ]
      })
    )
    expect(res.errors).toEqual([])
    expect(res.manifest?.files?.[0].download).toEqual({
      url: 'https://x/2.gguf',
      sha256: second,
      sizeBytes: 20,
      licenseUrl: null
    })
  })

  it('rejects a non-list files:', () => {
    const res = validateManifest(rawManifest({ files: 'models/chat/x.gguf' }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files" must be a list of mappings (local_path/sha256/download)')
  })

  it('rejects an empty files: list', () => {
    const res = validateManifest(rawManifest({ files: [] }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files" must not be an empty list — omit it instead')
  })

  it('rejects a member that is not a mapping', () => {
    const res = validateManifest(rawManifest({ files: ['models/chat/x.gguf'] }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files[0]" must be a mapping (local_path/sha256/download)')
  })

  it('rejects a member with no local_path', () => {
    const res = validateManifest(rawManifest({ files: [{ sha256: 'a'.repeat(64) }] }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files[0].local_path" is required and must be a non-empty string')
  })

  it('rejects an escaping or absolute member path (the same guard as local_path)', () => {
    for (const p of ['../../etc/passwd', '/etc/passwd', 'C:/Windows/system32/x.gguf']) {
      const res = validateManifest(rawManifest({ files: [{ local_path: p, sha256: 'a'.repeat(64) }] }))
      expect(res.ok).toBe(false)
      expect(res.errors).toContain(
        '"files[0].local_path" must be a drive-relative path (no leading "/", drive letter, or ".." segment)'
      )
    }
  })

  it('rejects a member with no sha256', () => {
    const res = validateManifest(rawManifest({ files: [{ local_path: 'models/chat/x.gguf' }] }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files[0].sha256" is required and must be a string (hash or placeholder)')
  })

  it('rejects a member repeating the top-level local_path', () => {
    const res = validateManifest(
      rawManifest({ files: [{ local_path: 'models/chat/qwen3-4b-instruct-q4.gguf', sha256: 'a'.repeat(64) }] })
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"files[0].local_path" must not repeat a path the manifest already declares: models/chat/qwen3-4b-instruct-q4.gguf'
    )
  })

  it('rejects a member repeating the mmproj path', () => {
    const res = validateManifest(
      rawManifest({
        role: 'vision',
        mmproj: { local_path: 'models/vision/mmproj.gguf', sha256: 'a'.repeat(64) },
        files: [{ local_path: 'models/vision/mmproj.gguf', sha256: 'a'.repeat(64) }]
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"files[0].local_path" must not repeat a path the manifest already declares: models/vision/mmproj.gguf'
    )
  })

  it('rejects a duplicate WITHIN the list', () => {
    const res = validateManifest(
      rawManifest({
        files: [
          { local_path: 'models/chat/x.gguf', sha256: 'a'.repeat(64) },
          { local_path: 'models/chat/x.gguf', sha256: 'a'.repeat(64) }
        ]
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"files[1].local_path" must not repeat a path the manifest already declares: models/chat/x.gguf'
    )
  })

  it('rejects a top-level download with no download on an extra file', () => {
    const hash = 'd'.repeat(64)
    const res = validateManifest(
      shardRaw(allShards(), { sha256: hash, download: { url: 'https://x/1.gguf', sha256: hash } })
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"files[0].download" is required when the model declares a top-level "download" (a partial download plan would install a model that cannot start)'
    )
    // Every index is named, not just the first.
    expect(res.errors.filter((e) => e.includes('is required when the model declares'))).toHaveLength(3)
  })

  it('rejects a download on an extra file with no top-level download', () => {
    const hash = 'e'.repeat(64)
    const res = validateManifest(
      shardRaw([
        { local_path: shard(2), sha256: hash, download: { url: 'https://x/2.gguf', sha256: hash } },
        { local_path: shard(3), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: shard(4), sha256: 'REPLACE_WITH_REAL_HASH' }
      ])
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"download" is required when "files[0]" declares one (a partial download plan would install a model that cannot start)'
    )
  })

  it('rejects a per-file download whose real hash differs from the file hash', () => {
    const primary = 'a'.repeat(64)
    const fileSha = 'b'.repeat(64)
    const res = validateManifest(
      shardRaw(
        [
          { local_path: shard(2), sha256: fileSha, download: { url: 'https://x/2.gguf', sha256: 'c'.repeat(64) } },
          { local_path: shard(3), sha256: fileSha, download: { url: 'https://x/3.gguf', sha256: fileSha } },
          { local_path: shard(4), sha256: fileSha, download: { url: 'https://x/4.gguf', sha256: fileSha } }
        ],
        { sha256: primary, download: { url: 'https://x/1.gguf', sha256: primary } }
      )
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"files[0].download.sha256" must equal the "files[0].sha256" when both are real hashes'
    )
  })

  it('applies the https-only URL gate (L-2) to a per-file download', () => {
    const hash = 'f'.repeat(64)
    const res = validateManifest(
      shardRaw(
        [2, 3, 4].map((n) => ({
          local_path: shard(n),
          sha256: 'REPLACE_WITH_REAL_HASH',
          download: { url: 'http://x/plain.gguf', sha256: 'REPLACE_WITH_REAL_HASH' }
        })),
        { sha256: hash, download: { url: 'https://x/1.gguf', sha256: hash } }
      )
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"files[0].download.url" must be an https:// URL')
  })

  // The shard convention: `local_path` naming shard 1 of N is a promise that N-1 more files
  // exist. Nothing else in the app can discover them, so the manifest must declare them.
  it('rejects a shard-1 local_path with no files: list at all', () => {
    const res = validateManifest(shardRaw(undefined))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"local_path" names shard 1 of a multi-file weight but no "files" list declares the remaining shards'
    )
  })

  it('rejects a primary that is not the FIRST shard', () => {
    const res = validateManifest(rawManifest({ local_path: shard(2) }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(
      '"local_path" must name the first shard (00001) of a multi-file weight, not shard 00002 of 00004'
    )
  })

  it('names each missing sibling when the list is incomplete', () => {
    const res = validateManifest(shardRaw([{ local_path: shard(2), sha256: 'REPLACE_WITH_REAL_HASH' }]))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(`"files" is missing a required shard of this weight: ${shard(3)}`)
    expect(res.errors).toContain(`"files" is missing a required shard of this weight: ${shard(4)}`)
    expect(res.errors).not.toContain(`"files" is missing a required shard of this weight: ${shard(2)}`)
  })

  it('names a misnumbered sibling (and still reports the one it displaced)', () => {
    const res = validateManifest(
      shardRaw([
        { local_path: shard(2), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: shard(3), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: shard(5), sha256: 'REPLACE_WITH_REAL_HASH' }
      ])
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(`"files[2].local_path" does not name a shard of this weight: ${shard(5)}`)
    expect(res.errors).toContain(`"files" is missing a required shard of this weight: ${shard(4)}`)
  })

  it('names a shard of a DIFFERENT series listed as a sibling', () => {
    const other = 'models/chat/other-00002-of-00004.gguf'
    const res = validateManifest(
      shardRaw([
        { local_path: shard(2), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: shard(3), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: shard(4), sha256: 'REPLACE_WITH_REAL_HASH' },
        { local_path: other, sha256: 'REPLACE_WITH_REAL_HASH' }
      ])
    )
    expect(res.ok).toBe(false)
    expect(res.errors).toContain(`"files[3].local_path" does not name a shard of this weight: ${other}`)
  })

  it('accepts a single-shard set (`-00001-of-00001`) with no files: list', () => {
    const res = validateManifest(rawManifest({ local_path: 'models/chat/solo-00001-of-00001.gguf' }))
    expect(res.errors).toEqual([])
  })

  it('rejects an impossible shard count', () => {
    const res = validateManifest(rawManifest({ local_path: 'models/chat/x-00001-of-00000.gguf' }))
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('"local_path" must name a shard set of at least one shard, not "-of-00000"')
  })
})

// #847 (a+): the frozen comparator release 1 applies to every later manifest's `min_app_version`. The minimum must be
// exactly MAJOR.MINOR.PATCH; anything else counts as newer (the old reader cannot vouch for it). Parts compare as numbers.
// The app's own version may carry a pre-release suffix, which is OLDER than its release (semver), and build metadata,
// which is ignored. An app version this build cannot read counts as unknown, which is newer too.
describe('manifestNeedsNewerApp — the (a+) comparator (#847)', () => {
  it.each<[string, unknown, boolean]>([
    ['0.1.65', '0.1.65', false],
    ['0.1.65', '0.1.64', false],
    ['0.1.65', '0.1.66', true],
    ['0.1.9', '0.1.10', true], // multi-digit parts compare as numbers, not text
    ['0.1.10', '0.1.9', false],
    ['0.1.65', '0.1.100', true],
    ['0.2.0', '0.1.100', false],
    ['1.0.0', '0.99.99', false],
    ['0.1.66-beta.1', '0.1.66', true], // a pre-release app does not meet its own release
    ['0.1.66-beta.1', '0.1.65', false],
    ['0.1.66+build.7', '0.1.66', false],
    ['0.1.65', '0.1.0.9', true], // not exactly MAJOR.MINOR.PATCH: newer
    ['0.1.65', '00.01.000', true],
    ['0.1.65', '0.1.0x', true],
    ['0.1.65', '0.1.0-beta', true],
    ['0.1.65', 'v0.1.0', true],
    ['0.1.65', '0.1', true],
    ['0.1.65', ' 0.1.0', true],
    ['0.1.65', '', true],
    ['0.1.65', 0.1, true],
    ['0.1.65', false, true],
    ['', '0.0.1', true], // an app that does not know its version cannot vouch
    ['0.1', '0.0.1', true]
  ])('app %s, min_app_version %j: needs a newer app = %s', (app, min, expected) => {
    expect(manifestNeedsNewerApp({ min_app_version: min }, app)).toBe(expected)
  })

  it('an absent or null min_app_version never asks for a newer app, whatever the app version', () => {
    for (const app of ['0.1.65', '', 'junk']) {
      expect(manifestNeedsNewerApp({}, app)).toBe(false)
      expect(manifestNeedsNewerApp({ min_app_version: null }, app)).toBe(false)
    }
  })
})

// App-update wave T2.10 (W-62, F-23): release 1 is the oldest reader of every manifest a later release puts on a drive,
// for ever. The golden set `tests/fixtures/readers/f23-manifests/` holds files written from the contract, and
// `verdicts.json` says what release 1 does with each: accepts, lists ("Needs a newer HilbertRaum"), drops (logged) or
// ignores (never reads). The verdicts are data: these rows only compare them with what the real walk does. A later
// release may add files and lines, never change one (`golden-fixtures.sha256` locks the bytes).
type F23Verdict = 'accepts' | 'lists' | 'drops' | 'ignores'
interface F23Data {
  appVersion: string
  appVersions: string[]
  single: { dir: string; files: Array<{ file: string; id?: string; verdict: F23Verdict; at?: Record<string, F23Verdict>; sameAs?: string }> }
  /** Files whose bytes are no plain LF text (CRLF, a byte-order mark), held as base64 (T2.10 round 2). */
  escaped: Array<{ file: string; base64: string; id: string; verdict: F23Verdict; at?: Record<string, F23Verdict> }>
  scenarios: Array<{
    dir: string
    usable: Array<{ id: string; file: string }>
    newer: Array<{ id: string; file: string }>
    dropped: string[]
    pick?: Partial<Record<ModelRole, string>>
  }>
}

describe('F-23 golden manifests: what release 1 accepts, lists, drops and ignores (T2.10, W-62)', () => {
  const SET = join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f23-manifests')
  const data = JSON.parse(readFileSync(join(SET, 'verdicts.json'), 'utf8')) as F23Data
  /** The walk at `appVersion` (main sets it once from `app.getVersion()`; '' is an app that does not know its version). */
  const discoverAt = (dir: string, appVersion: string): ReturnType<typeof discoverManifests> => {
    setManifestAppVersion(appVersion)
    try {
      return discoverManifests(dir)
    } finally {
      setManifestAppVersion('')
    }
  }
  /** Every file under `dir`, `/`-separated and relative. */
  const filesOf = (dir: string, prefix = ''): string[] =>
    readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? filesOf(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
    )
  /** What one walk of `dir` made of each file in it. */
  function verdictsOf(dir: string, res: ReturnType<typeof discoverManifests>): Record<string, F23Verdict> {
    const full = (file: string): string => join(dir, ...file.split('/'))
    return Object.fromEntries(
      filesOf(dir).map((file): [string, F23Verdict] => {
        if (res.manifests.some((m) => m.sourceFile === full(file))) return [file, 'accepts']
        if (res.unsupported.some((u) => u.sourceFile === full(file))) return [file, 'lists']
        if (res.errors.some((e) => e.startsWith(`${full(file)}: `))) return [file, 'drops']
        return [file, 'ignores']
      })
    )
  }

  it('the set covers each verdict and every file in its folder has one', () => {
    const dir = join(SET, data.single.dir)
    expect(data.single.files.map((f) => f.file).sort()).toEqual(filesOf(dir).sort())
    expect(new Set(data.single.files.map((f) => f.verdict))).toEqual(new Set(['accepts', 'lists', 'drops', 'ignores']))
  })

  it.each(data.appVersions.map((v) => [JSON.stringify(v), v] as const))('each file of the single set, at app version %s', (_label, appVersion) => {
    const dir = join(SET, data.single.dir)
    const res = discoverAt(dir, appVersion)
    const expected = Object.fromEntries(data.single.files.map((f) => [f.file, f.at?.[appVersion] ?? f.verdict]))
    expect(verdictsOf(dir, res)).toEqual(expected)
    // A file that is used or listed is so under its own id.
    for (const f of data.single.files.filter((x) => x.id !== undefined)) {
      const found = [...res.manifests.map((m) => [m.sourceFile, m.manifest.id]), ...res.unsupported.map((u) => [u.sourceFile, u.manifest.id])]
      const entry = found.find(([source]) => source === join(dir, f.file))
      if (entry) expect(entry[1], f.file).toBe(f.id)
    }
  })

  // Round 2: the bytes of a manifest a later release saved on Windows (CRLF) or with a byte-order mark. They go into a temp
  // copy of the single set, so they are judged in the same walk as every other file.
  it.each(data.appVersions.map((v) => [JSON.stringify(v), v] as const))('each file held escaped, in a copy of the single set, at app version %s', (_label, appVersion) => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-f23-escaped-'))
    cpSync(join(SET, data.single.dir), dir, { recursive: true })
    for (const e of data.escaped) writeFileSync(join(dir, e.file), Buffer.from(e.base64, 'base64'))
    const res = discoverAt(dir, appVersion)
    const verdicts = verdictsOf(dir, res)
    expect(Object.fromEntries(data.escaped.map((e) => [e.file, verdicts[e.file]]))).toEqual(
      Object.fromEntries(data.escaped.map((e) => [e.file, e.at?.[appVersion] ?? e.verdict]))
    )
    const ids = new Map<string, string>([
      ...res.manifests.map((m): [string, string] => [m.sourceFile, m.manifest.id]),
      ...res.unsupported.map((u): [string, string] => [u.sourceFile, u.manifest.id])
    ])
    for (const e of data.escaped) if (ids.has(join(dir, e.file))) expect(ids.get(join(dir, e.file)), e.file).toBe(e.id)
  })

  it('unknown keys change nothing: a file that holds them reads exactly as its twin without them (identity aside)', () => {
    const dir = join(SET, data.single.dir)
    const pairs = data.single.files.filter((f) => f.sameAs !== undefined)
    expect(pairs.length).toBeGreaterThan(0)
    const read = (file: string): Record<string, unknown> => {
      const res = validateManifest(parseYaml(readFileSync(join(dir, file), 'utf8')))
      expect(res.errors, file).toEqual([])
      const { id: _id, displayName: _name, ...rest } = res.manifest as ModelManifest
      return rest
    }
    for (const f of pairs) expect(read(f.file), f.file).toEqual(read(f.sameAs as string))
  })

  it.each(data.scenarios.map((s) => [s.dir, s] as const))('scenario %s: the usable list, the newer list, what is dropped and the role pick', (_dir, s) => {
    const dir = join(SET, 'scenarios', s.dir)
    const res = discoverAt(dir, data.appVersion)
    const rel = (file: string): string => relative(dir, file).split(sep).join('/')
    expect(res.manifests.map((m) => ({ id: m.manifest.id, file: rel(m.sourceFile) }))).toEqual(s.usable)
    expect(res.unsupported.map((u) => ({ id: u.manifest.id, file: rel(u.sourceFile) }))).toEqual(s.newer)
    const verdicts = verdictsOf(dir, res)
    expect(Object.keys(verdicts).filter((file) => verdicts[file] === 'drops').sort()).toEqual([...s.dropped].sort())
    for (const [role, id] of Object.entries(s.pick ?? {})) {
      expect(pickManifestForRole(res.manifests.map((m) => m.manifest), role as ModelRole)?.id, role).toBe(id)
    }
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
