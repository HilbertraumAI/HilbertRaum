import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import {
  EngineDownloadManager,
  engineStatus,
  hostRuntimeArch,
  hostRuntimeOs,
  loadRuntimeSources,
  selectHostBuild,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { runtimeMarkerPath } from '../../src/main/services/assets'
import type { FetchFn } from '../../src/main/services/assets'
import type { EngineDownloadJob } from '../../src/shared/types'

// In-app engine (llama.cpp sidecar) downloader: the gates (a closed gate never reaches the
// network seam), the verify-before-trust flow (placeholder honesty, mismatch discard), the
// extract → flatten → marker install, and the host build selection. The network + the
// extraction are injected (a fake fetch + a fake extractor that drops the binary) so the
// suite stays zero-network and never shells out.

const BODY = 'llama-server-release-archive-bytes'
const REAL_SHA = createHash('sha256').update(BODY).digest('hex')

const HOST_OS = hostRuntimeOs()
const HOST_ARCH = hostRuntimeArch()
const BIN_NAME = llamaServerBinaryName()

/** A temp drive root + a manifests dir whose runtime-sources.yaml pins the host build. */
function makeDrive(sha = REAL_SHA): { rootPath: string; manifestsDir: string } {
  const rootPath = mkdtempSync(join(tmpdir(), 'hr-engine-root-'))
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-engine-manifests-'))
  const yaml = stringify({
    llama_cpp: {
      version: 'btest',
      builds: [
        {
          os: HOST_OS,
          arch: HOST_ARCH,
          backend: 'cpu',
          url: 'https://example.test/llama-server.zip',
          sha256: sha,
          extract_to: `runtime/llama.cpp/${HOST_OS}`
        }
      ]
    }
  })
  writeFileSync(join(manifestsDir, 'runtime-sources.yaml'), yaml)
  return { rootPath, manifestsDir }
}

const okFetch = (async () =>
  new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })) as unknown as FetchFn

/** A fake extractor that materializes the binary at the extract-dir root (no nesting). */
const fakeExtract: ExtractFn = async (_archive, destDir) => {
  await writeFile(join(destDir, BIN_NAME), 'binary')
}

/** A fake extractor that nests the binary under a release folder (exercises flatten). */
const nestingExtract: ExtractFn = async (_archive, destDir) => {
  const nested = join(destDir, 'llama-btest')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, BIN_NAME), 'binary')
  await writeFile(join(nested, 'libllama.so'), 'lib')
}

const ALLOW = { policyAllows: true, settingAllows: true }

async function runToEnd(mgr: EngineDownloadManager, jobId: string): Promise<EngineDownloadJob> {
  const start = Date.now()
  for (;;) {
    const job = mgr.get(jobId)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    if (Date.now() - start > 5000) throw new Error('engine job never finished')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('engineStatus + host build selection', () => {
  it('reports not-installed but available when a host build exists and no binary is present', () => {
    const { rootPath, manifestsDir } = makeDrive()
    const status = engineStatus(rootPath, manifestsDir)
    expect(status.installed).toBe(false)
    expect(status.available).toBe(true)
    expect(status.version).toBe('btest')
    expect(status.backend).toBe('cpu')
  })

  it('reports installed once the binary is on the drive', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const dir = join(rootPath, 'runtime', 'llama.cpp', HOST_OS)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, BIN_NAME), 'binary')
    expect(engineStatus(rootPath, manifestsDir).installed).toBe(true)
  })

  it('reports not-available when there are no engine sources', () => {
    const { rootPath } = makeDrive()
    const empty = mkdtempSync(join(tmpdir(), 'hr-engine-empty-'))
    expect(engineStatus(rootPath, empty).available).toBe(false)
    expect(loadRuntimeSources(empty)).toBeNull()
  })

  it('selectHostBuild matches the current host', () => {
    const { manifestsDir } = makeDrive()
    const sources = loadRuntimeSources(manifestsDir)!
    const build = selectHostBuild(sources)
    expect(build?.os).toBe(HOST_OS)
    expect(build?.arch).toBe(HOST_ARCH)
  })
})

describe('EngineDownloadManager gates (offline guarantee — closed gate never fetches)', () => {
  it('refuses when the policy ceiling denies downloads — fetch never called', async () => {
    const fetchSpy = vi.fn()
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: { policyAllows: false, settingAllows: true } })
    ).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses when the allowNetwork setting is off — fetch never called', async () => {
    const fetchSpy = vi.fn()
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: { policyAllows: true, settingAllows: false } })
    ).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses when there is no host build', async () => {
    const { rootPath } = makeDrive()
    const empty = mkdtempSync(join(tmpdir(), 'hr-engine-nobuild-'))
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch })
    await expect(mgr.start({ rootPath, manifestsDir: empty, gates: ALLOW })).rejects.toThrow()
  })
})

describe('EngineDownloadManager install flow', () => {
  it('downloads, verifies, extracts, and writes the install marker', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: fakeExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(job.unverified).toBe(false)
    const binPath = join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME)
    expect(job.binaryPath).toBe(binPath)
    expect(existsSync(binPath)).toBe(true)
    // Marker records the pinned build so a re-install is idempotent + Diagnostics can read it.
    const marker = JSON.parse(
      readFileSync(runtimeMarkerPath(join(rootPath, 'runtime', 'llama.cpp', HOST_OS)), 'utf8')
    )
    expect(marker).toMatchObject({ version: 'btest', backend: 'cpu', os: HOST_OS })
    // The archive is removed after extraction.
    expect(engineStatus(rootPath, manifestsDir).installed).toBe(true)
  })

  it('flattens a nested release folder so the binary lands at the extract root', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: nestingExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(true)
  })

  it('completes but marks UNVERIFIED when the sources hash is a placeholder', async () => {
    const { rootPath, manifestsDir } = makeDrive('REPLACE_WITH_REAL_HASH')
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: fakeExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(job.unverified).toBe(true)
  })

  it('fails and discards the archive on a checksum mismatch', async () => {
    const wrong = createHash('sha256').update('something-else').digest('hex')
    const { rootPath, manifestsDir } = makeDrive(wrong)
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: fakeExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('failed')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(false)
  })

  it('refuses a second start when the engine is already installed + current', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: fakeExtract })
    await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW })).jobId)
    await expect(mgr.start({ rootPath, manifestsDir, gates: ALLOW })).rejects.toThrow()
  })
})
