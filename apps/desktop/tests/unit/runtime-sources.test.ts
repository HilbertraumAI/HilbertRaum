import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'

function build(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    os: 'win',
    arch: 'x64',
    backend: 'cpu-avx2',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b9196/llama-b9196-bin-win-avx2-x64.zip',
    sha256: 'REPLACE_WITH_REAL_HASH',
    extract_to: 'runtime/llama.cpp/win',
    ...overrides
  }
}

function sources(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llama_cpp: {
      version: 'b9196',
      builds: [build()],
      ...overrides
    }
  }
}

describe('validateRuntimeSources', () => {
  it('accepts a well-formed file and camelCases extract_to', () => {
    const res = validateRuntimeSources(sources())
    expect(res.ok).toBe(true)
    expect(res.sources?.version).toBe('b9196')
    expect(res.sources?.builds).toHaveLength(1)
    expect(res.sources?.builds[0].extractTo).toBe('runtime/llama.cpp/win')
    expect(res.sources?.builds[0].sha256).toBe('replace_with_real_hash')
  })

  it('rejects a non-object', () => {
    expect(validateRuntimeSources('nope').ok).toBe(false)
  })

  it('requires the llama_cpp block', () => {
    const res = validateRuntimeSources({ foo: 'bar' })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('llama_cpp'))).toBe(true)
  })

  it('requires a version', () => {
    const res = validateRuntimeSources({ llama_cpp: { builds: [build()] } })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('requires a non-empty builds list', () => {
    const res = validateRuntimeSources({ llama_cpp: { version: 'b1', builds: [] } })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('builds'))).toBe(true)
  })

  it('rejects an invalid os', () => {
    const res = validateRuntimeSources(sources({ builds: [build({ os: 'solaris' })] }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('os'))).toBe(true)
  })

  it('reports a build missing required fields', () => {
    const res = validateRuntimeSources(sources({ builds: [build({ url: '', extract_to: '' })] }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('url'))).toBe(true)
    expect(res.errors.some((e) => e.includes('extract_to'))).toBe(true)
  })

  // SEC-4 (full-audit-2026-06-29-followup, Phase 8): extract_to is a drive-relative
  // target into the user-writable model-manifests/ tree, so a traversal/absolute/
  // drive-letter form must be rejected at PARSE time — mirroring the sibling OCR `dest`
  // check — not left to the downstream resolveWithinRoot containment alone.
  it('rejects an extract_to with .. traversal (POSIX form)', () => {
    const res = validateRuntimeSources(sources({ builds: [build({ extract_to: '../../escape' })] }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('extract_to') && e.includes('drive-relative'))).toBe(true)
  })

  it('rejects an extract_to with .. traversal (Windows backslash form)', () => {
    const res = validateRuntimeSources(sources({ builds: [build({ extract_to: '..\\..\\escape' })] }))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('extract_to') && e.includes('drive-relative'))).toBe(true)
  })

  it('rejects an absolute or drive-letter extract_to', () => {
    expect(validateRuntimeSources(sources({ builds: [build({ extract_to: '/etc/evil' })] })).ok).toBe(false)
    expect(validateRuntimeSources(sources({ builds: [build({ extract_to: 'C:\\Windows' })] })).ok).toBe(false)
  })

  it('still accepts a normal drive-relative extract_to', () => {
    const res = validateRuntimeSources(sources({ builds: [build({ extract_to: 'runtime/llama.cpp/win' })] }))
    expect(res.ok).toBe(true)
    expect(res.sources?.builds[0].extractTo).toBe('runtime/llama.cpp/win')
  })

  it('accepts multiple builds across OSes', () => {
    const res = validateRuntimeSources(
      sources({
        builds: [
          build(),
          build({ os: 'mac', arch: 'arm64', backend: 'metal', extract_to: 'runtime/llama.cpp/mac' }),
          build({ os: 'linux', arch: 'x64', backend: 'cpu', extract_to: 'runtime/llama.cpp/linux' })
        ]
      })
    )
    expect(res.ok).toBe(true)
    expect(res.sources?.builds.map((b) => b.os)).toEqual(['win', 'mac', 'linux'])
  })

  // Phase 14: "first match wins" selection makes a duplicate (os, arch, backend) triple
  // ambiguous — it must be rejected, not silently shadowed.
  it('rejects duplicate (os, arch, backend) triples', () => {
    const res = validateRuntimeSources(
      sources({
        builds: [
          build({ backend: 'vulkan' }),
          build({ backend: 'vulkan', url: 'https://example.test/other.zip' })
        ]
      })
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('duplicate') && e.includes('win/x64/vulkan'))).toBe(true)
  })

  it('accepts the same os/arch with DIFFERENT backends (vulkan default + cpu safety net)', () => {
    const res = validateRuntimeSources(
      sources({
        builds: [
          build({ backend: 'vulkan', extract_to: 'runtime/llama.cpp/win' }),
          build({ backend: 'cpu', extract_to: 'runtime/llama.cpp/win/cpu' })
        ]
      })
    )
    expect(res.ok).toBe(true)
    expect(res.sources?.builds.map((b) => b.backend)).toEqual(['vulkan', 'cpu'])
  })

  // ---- Phase 36: the optional whisper_cpp second family ------------------------------

  function whisperBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return build({
      backend: 'cpu',
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip',
      extract_to: 'runtime/whisper.cpp/win',
      ...overrides
    })
  }

  it('parses the optional whisper_cpp block alongside llama_cpp', () => {
    const res = validateRuntimeSources({
      ...sources(),
      whisper_cpp: { version: 'v1.8.6', builds: [whisperBuild()] }
    })
    expect(res.ok).toBe(true)
    expect(res.sources?.version).toBe('b9196')
    expect(res.whisper?.version).toBe('v1.8.6')
    expect(res.whisper?.builds[0].extractTo).toBe('runtime/whisper.cpp/win')
  })

  // The forward-compat property the wave-3 plan verified: a yaml WITHOUT the new block
  // (a pre-Phase-36 drive) parses exactly as before, with `whisper` simply absent.
  it('leaves whisper undefined when the block is absent (older-drive compatibility)', () => {
    const res = validateRuntimeSources(sources())
    expect(res.ok).toBe(true)
    expect(res.whisper).toBeUndefined()
  })

  it('rejects a malformed whisper_cpp block loudly (never fetch the wrong thing)', () => {
    const res = validateRuntimeSources({ ...sources(), whisper_cpp: { builds: [] } })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('whisper_cpp.version'))).toBe(true)
    expect(res.errors.some((e) => e.includes('whisper_cpp.builds'))).toBe(true)
  })

  it('rejects duplicate triples WITHIN the whisper family', () => {
    const res = validateRuntimeSources({
      ...sources(),
      whisper_cpp: {
        version: 'v1.8.6',
        builds: [whisperBuild(), whisperBuild({ url: 'https://example.test/other.zip' })]
      }
    })
    expect(res.ok).toBe(false)
    expect(
      res.errors.some((e) => e.includes('duplicate whisper_cpp build') && e.includes('win/x64/cpu'))
    ).toBe(true)
  })

  // The families are independent pins: the same (os, arch, backend) triple may exist
  // in BOTH (they extract to different trees) without tripping the duplicate guard.
  it('allows the same triple across the two families', () => {
    const res = validateRuntimeSources({
      llama_cpp: { version: 'b9196', builds: [build({ backend: 'cpu' })] },
      whisper_cpp: { version: 'v1.8.6', builds: [whisperBuild()] }
    })
    expect(res.ok).toBe(true)
  })

  // The download layer already refuses cleartext at fetch time; the parser now refuses it at
  // validation time too, so a tampered manifest never reaches the planner (#245).
  it('rejects a non-https url in every family (#245)', () => {
    const llama = validateRuntimeSources(sources({ builds: [build({ url: 'http://example.test/llama.zip' })] }))
    expect(llama.ok).toBe(false)
    expect(llama.errors.some((e) => e.includes('builds[0].url') && e.includes('https'))).toBe(true)

    const whisper = validateRuntimeSources({
      ...sources(),
      whisper_cpp: { version: 'v1', builds: [build({ url: 'ftp://example.test/w.zip' })] }
    })
    expect(whisper.ok).toBe(false)
    expect(whisper.errors.some((e) => e.includes('whisper_cpp.builds[0].url'))).toBe(true)

    const ocr = validateRuntimeSources({
      ...sources(),
      ocr: {
        version: '4',
        files: [{ lang: 'deu', url: 'http://example.test/deu.traineddata.gz', sha256: 'x', dest: 'ocr/deu.traineddata' }]
      }
    })
    expect(ocr.ok).toBe(false)
    expect(ocr.errors.some((e) => e.includes('ocr.files[0].url'))).toBe(true)
  })

  // #339 P8-1: the third family — optional, multi-executable, per-build runtime files.
  describe('kiwix_tools family block (#339 P8-1)', () => {
    const kiwixBuild = {
      os: 'win',
      arch: 'x64',
      backend: 'cpu',
      url: 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-3.8.1.zip',
      sha256: 'fcd01ed2b93e9a68632c7863c83b9f66bf64406a66357be1df7b8b75596f3e45',
      extract_to: 'runtime/kiwix-tools/win',
      runtime_files: ['icudt74.dll', 'icuuc74.dll']
    }
    const base = () => ({
      llama_cpp: {
        version: 'b1',
        builds: [{ os: 'win', arch: 'x64', backend: 'cpu', url: 'https://x.test/l.zip', sha256: 'a'.repeat(64), extract_to: 'runtime/llama.cpp/win' }]
      }
    })

    it('validates a kiwix_tools family block (optional, executables, per-build runtime_files)', () => {
      const res = validateRuntimeSources({
        ...base(),
        kiwix_tools: {
          version: '3.8.1',
          optional: true,
          executables: ['kiwix-serve', 'kiwix-manage', 'kiwix-search'],
          builds: [kiwixBuild, { ...kiwixBuild, os: 'mac', arch: 'arm64', url: 'https://x.test/m.tar.gz', extract_to: 'runtime/kiwix-tools/mac', runtime_files: undefined }]
        }
      })
      expect(res.errors).toEqual([])
      const k = res.families?.kiwix_tools
      expect(k?.version).toBe('3.8.1')
      expect(k?.optional).toBe(true)
      expect(k?.executables).toEqual(['kiwix-serve', 'kiwix-manage', 'kiwix-search'])
      expect(k?.builds[0]?.runtimeFiles).toEqual(['icudt74.dll', 'icuuc74.dll'])
      expect(k?.builds[1]?.runtimeFiles).toBeUndefined()
    })

    it('rejects an executables list that is empty, duplicated, or carries a separator or extension', () => {
      for (const executables of [[], ['kiwix-serve', 'kiwix-serve'], ['bin/kiwix-serve'], ['kiwix-serve.exe'], ['icu.dll'], ['..']]) {
        const res = validateRuntimeSources({ ...base(), kiwix_tools: { version: '3.8.1', executables, builds: [kiwixBuild] } })
        expect(res.ok, JSON.stringify(executables)).toBe(false)
        expect(res.errors.some((e) => e.includes('kiwix_tools.executables')), JSON.stringify(executables)).toBe(true)
      }
    })

    it('rejects a runtime_files entry that is not a plain filename or duplicates a required file', () => {
      for (const runtime_files of [['sub/icu.dll'], ['..'], ['icuuc74.dll', 'icuuc74.dll'], ['kiwix-serve'], ['kiwix-serve.exe'], 'icuuc74.dll']) {
        const res = validateRuntimeSources({
          ...base(),
          kiwix_tools: { version: '3.8.1', executables: ['kiwix-serve', 'kiwix-manage'], builds: [{ ...kiwixBuild, runtime_files }] }
        })
        expect(res.ok, JSON.stringify(runtime_files)).toBe(false)
        expect(res.errors.some((e) => e.includes('runtime_files')), JSON.stringify(runtime_files)).toBe(true)
      }
    })

    it('rejects a non-boolean optional flag and a non-mapping block', () => {
      const bad = validateRuntimeSources({ ...base(), kiwix_tools: { version: '3.8.1', optional: 'yes', builds: [kiwixBuild] } })
      expect(bad.ok).toBe(false)
      expect(bad.errors.some((e) => e.includes('kiwix_tools.optional'))).toBe(true)
      const notMap = validateRuntimeSources({ ...base(), kiwix_tools: 'x' })
      expect(notMap.ok).toBe(false)
      expect(notMap.errors[0]).toContain('"kiwix_tools" must be a mapping')
    })

    it('exposes every build family through result.families, with sources/whisper as the same objects', () => {
      const res = validateRuntimeSources({
        ...base(),
        whisper_cpp: { version: 'w1', builds: [{ os: 'win', arch: 'x64', backend: 'cpu', url: 'https://x.test/w.zip', sha256: 'b'.repeat(64), extract_to: 'runtime/whisper.cpp/win' }] },
        kiwix_tools: { version: '3.8.1', optional: true, executables: ['kiwix-serve', 'kiwix-manage'], builds: [kiwixBuild] }
      })
      expect(res.ok).toBe(true)
      expect(Object.keys(res.families ?? {}).sort()).toEqual(['kiwix_tools', 'llama_cpp', 'whisper_cpp'])
      expect(res.families?.llama_cpp).toBe(res.sources)
      expect(res.families?.whisper_cpp).toBe(res.whisper)
      // No kiwix block → no key, and the two aliases still hold.
      const two = validateRuntimeSources(base())
      expect(Object.keys(two.families ?? {})).toEqual(['llama_cpp'])
      expect(two.families?.llama_cpp).toBe(two.sources)
    })
  })

  it('every entry of the shipped runtime-sources.yaml still validates', () => {
    const file = join(__dirname, '..', '..', '..', '..', 'model-manifests', 'runtime-sources.yaml')
    const res = validateRuntimeSources(parse(readFileSync(file, 'utf8')))
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    // #339 P8-1: the shipped kiwix_tools block is optional with all four pinned builds.
    expect(res.families?.kiwix_tools?.optional).toBe(true)
    expect(res.families?.kiwix_tools?.builds).toHaveLength(4)
  })
})
