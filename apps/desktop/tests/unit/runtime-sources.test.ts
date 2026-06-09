import { describe, it, expect } from 'vitest'
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
})
