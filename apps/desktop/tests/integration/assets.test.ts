import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  planModelDownloads,
  selectRuntimeBuild,
  planRuntimeDownload,
  verifyDownloadedFile,
  downloadToFile,
  fetchAndVerify,
  formatAssetPlan,
  runtimeBinaryName,
  type FetchFn
} from '../../src/main/services/assets'
import { validateManifest, type ModelManifest } from '../../src/shared/manifest'
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
    const root = tempDir('paid-assets-')
    const noDownload = manifest({ id: 'nodl', download: undefined, local_path: 'models/chat/nodl.gguf' })
    const tasks = await planModelDownloads(root, [noDownload])
    expect(tasks).toHaveLength(0)
  })

  it('plans a download for a missing weight (license accepted)', async () => {
    const root = tempDir('paid-assets-')
    const tasks = await planModelDownloads(root, [manifest()], { acceptLicense: true })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe('download')
    expect(tasks[0].url).toBe('https://example.test/qwen3-4b.gguf')
    expect(tasks[0].placeholderHash).toBe(true)
    expect(tasks[0].dest.endsWith(join('models', 'chat', 'qwen3-4b-instruct-q4.gguf'))).toBe(true)
  })

  it('blocks a download whose license is not approved without --accept-license', async () => {
    const root = tempDir('paid-assets-')
    const tasks = await planModelDownloads(root, [manifest()])
    expect(tasks[0].status).toBe('license-blocked')
    expect(tasks[0].licenseApproved).toBe(false)
  })

  it('plans a download for an approved license with no override', async () => {
    const root = tempDir('paid-assets-')
    const approved = manifest({
      license_review: { status: 'approved', reviewed_by: 'me', reviewed_at: '2026-01-01', notes: '' }
    })
    const tasks = await planModelDownloads(root, [approved])
    expect(tasks[0].status).toBe('download')
    expect(tasks[0].licenseApproved).toBe(true)
  })

  it('skips a present + verified weight (real hash matches)', async () => {
    const root = tempDir('paid-assets-')
    const content = 'real-weights'
    const hash = sha256(content)
    const m = manifest({ sha256: hash, download: { url: 'https://x/y.gguf', sha256: hash, size_bytes: 1, license_url: null } })
    writeWeight(root, m, content)
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('present-verified')
  })

  it('skips a present weight with a placeholder hash as present-unverified', async () => {
    const root = tempDir('paid-assets-')
    const m = manifest()
    writeWeight(root, m, 'whatever')
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('present-unverified')
  })

  it('re-plans a download when a present weight mismatches a real hash', async () => {
    const root = tempDir('paid-assets-')
    const m = manifest({ sha256: 'a'.repeat(64), download: { url: 'https://x/y.gguf', sha256: 'a'.repeat(64), size_bytes: 1, license_url: null } })
    writeWeight(root, m, 'wrong-content')
    const tasks = await planModelDownloads(root, [m], { acceptLicense: true })
    expect(tasks[0].status).toBe('download')
  })

  it('honours the --only filter', async () => {
    const root = tempDir('paid-assets-')
    const a = manifest({ id: 'a', local_path: 'models/chat/a.gguf' })
    const b = manifest({ id: 'b', local_path: 'models/chat/b.gguf' })
    const tasks = await planModelDownloads(root, [a, b], { acceptLicense: true, only: 'b' })
    expect(tasks.map((t) => t.id)).toEqual(['b'])
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

describe('planRuntimeDownload', () => {
  it('resolves the extraction dir + binary path under the drive root', () => {
    const root = tempDir('paid-rt-')
    const build = selectRuntimeBuild(runtimeSources(), { os: 'win', arch: 'x64' })!
    const plan = planRuntimeDownload(root, build, 'b9196')
    expect(plan.extractTo).toBe(join(root, 'runtime', 'llama.cpp', 'win'))
    expect(plan.binaryPath).toBe(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'))
    expect(plan.zipDest).toContain('llama-b9196-win-x64.zip')
    expect(plan.placeholderHash).toBe(true)
  })

  it('rejects an extract_to that escapes the drive root', () => {
    const root = tempDir('paid-rt-')
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
    const root = tempDir('paid-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const ok = await verifyDownloadedFile(file, sha256('abc'))
    expect(ok.ok).toBe(true)
    expect(ok.actual).toBe(sha256('abc'))
  })

  it('reports a mismatch', async () => {
    const root = tempDir('paid-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const res = await verifyDownloadedFile(file, 'a'.repeat(64))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('mismatch')
  })

  it('reports a placeholder hash as not-a-pass', async () => {
    const root = tempDir('paid-verify-')
    const file = join(root, 'w.gguf')
    writeFileSync(file, 'abc')
    const res = await verifyDownloadedFile(file, 'REPLACE_WITH_REAL_HASH')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('placeholder')
  })

  it('reports a missing file', async () => {
    const root = tempDir('paid-verify-')
    const res = await verifyDownloadedFile(join(root, 'gone.gguf'), sha256('abc'))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing')
  })
})

describe('downloadToFile + fetchAndVerify (injected fetch — no real network)', () => {
  const fakeFetch = (body: string, ok = true): FetchFn =>
    (async () => new Response(ok ? body : null, { status: ok ? 200 : 404 })) as unknown as FetchFn

  it('streams a response body to disk via the injected fetch', async () => {
    const root = tempDir('paid-dl-')
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
    const root = tempDir('paid-dl-')
    const dest = join(root, 'x.gguf')
    await expect(
      downloadToFile('https://example.test/missing', dest, { fetchImpl: fakeFetch('', false) })
    ).rejects.toThrow(/HTTP 404/)
  })

  it('fetchAndVerify passes for a matching real hash', async () => {
    const root = tempDir('paid-dl-')
    const dest = join(root, 'w.gguf')
    const body = 'verified-bytes'
    const res = await fetchAndVerify(
      { url: 'https://example.test/w.gguf', dest, expectedSha256: sha256(body) },
      { fetchImpl: fakeFetch(body) }
    )
    expect(res.ok).toBe(true)
  })

  it('fetchAndVerify deletes the partial and throws on a mismatch', async () => {
    const root = tempDir('paid-dl-')
    const dest = join(root, 'w.gguf')
    await expect(
      fetchAndVerify(
        { url: 'https://example.test/w.gguf', dest, expectedSha256: 'a'.repeat(64) },
        { fetchImpl: fakeFetch('not-the-expected-bytes') }
      )
    ).rejects.toThrow(/mismatch/)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('formatAssetPlan', () => {
  it('renders model tasks + the runtime plan', async () => {
    const root = tempDir('paid-fmt-')
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
