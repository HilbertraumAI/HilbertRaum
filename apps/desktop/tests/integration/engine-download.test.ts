import { describe, it, expect, vi } from 'vitest'
// The manager itself never touches electron; this mock exists only so `chatEngineInUse`
// (exported by registerEngineIpc.ts, whose module top imports ipcMain) is importable here.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { isRealSha256 } from '../../src/shared/manifest'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'
import {
  EngineDownloadManager,
  engineStatus,
  hostRuntimeArch,
  hostRuntimeOs,
  loadRuntimeSources,
  resolveTarBinary,
  selectHostBuild,
  type ExtractFn
} from '../../src/main/services/runtime-download'
import {
  llamaServerBinaryName,
  registerSidecarChild,
  unregisterSidecarChild,
  killRegisteredSidecarChildren
} from '../../src/main/services/runtime/sidecar'
import {
  runtimeMarkerPath,
  verifyDownloadedFile,
  writeRuntimeMarker,
  ENGINE_DOWNLOAD_MAX_BYTES,
  SIDECAR_FAMILY_SPECS
} from '../../src/main/services/assets'
import type { FetchFn } from '../../src/main/services/assets'
import {
  _resetBinaryVerificationForTests,
  initBinaryVerification,
  verifyBinaryBeforeSpawn
} from '../../src/main/services/binary-verifier'
import { chatEngineInUse, llamaSidecarInUse, whisperSidecarInUse } from '../../src/main/ipc/registerEngineIpc'
import type { RuntimeManager } from '../../src/main/services/runtime'
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

/** A drive whose runtime-sources.yaml pins BOTH the chat (llama) and voice (whisper) engines. */
function makeMultiFamilyDrive(): { rootPath: string; manifestsDir: string } {
  const rootPath = mkdtempSync(join(tmpdir(), 'hr-engine-root-'))
  const manifestsDir = mkdtempSync(join(tmpdir(), 'hr-engine-manifests-'))
  const build = (backend: string, family: string) => ({
    os: HOST_OS,
    arch: HOST_ARCH,
    backend,
    url: `https://example.test/${family}.zip`,
    sha256: REAL_SHA,
    extract_to: `runtime/${family === 'whisper_cpp' ? 'whisper.cpp' : 'llama.cpp'}/${HOST_OS}`
  })
  const yaml = stringify({
    llama_cpp: { version: 'btest', builds: [build('cpu', 'llama_cpp')] },
    whisper_cpp: { version: 'wtest', builds: [build('cpu', 'whisper_cpp')] }
  })
  writeFileSync(join(manifestsDir, 'runtime-sources.yaml'), yaml)
  return { rootPath, manifestsDir }
}

const WHISPER_BIN = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'

const okFetch = (async () =>
  new Response(BODY, { status: 200, headers: { 'content-length': String(BODY.length) } })) as unknown as FetchFn

/** A fake extractor that drops the family-correct binary (keyed off the extract dir). */
const familyExtract: ExtractFn = async (_archive, destDir) => {
  const name = destDir.includes('whisper.cpp') ? WHISPER_BIN : BIN_NAME
  await writeFile(join(destDir, name), 'binary')
}

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
    expect(status.missingFamilies).toContain('llama_cpp')
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
    // vuln-scan B: the marker also records the extracted binary's own SHA-256 (keyed by
    // its name relative to the extract dir) so it can be re-hashed before spawn. fakeExtract
    // writes the bytes 'binary'.
    expect(marker.binaries).toEqual({ [BIN_NAME]: createHash('sha256').update('binary').digest('hex') })
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

  // F17 (audit-postmerge-2026-06-29): the engine downloader passed NO maxBytes, so a redirected /
  // Content-Length-less archive endpoint fell through to the multi-GiB backstop. Assert it now
  // applies the bounded per-family ceiling.
  it('applies the bounded ENGINE_DOWNLOAD_MAX_BYTES cap to the archive download (F17)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const GiB = 1024 * 1024 * 1024
    let captured: unknown = 'unset'
    const mgr = new EngineDownloadManager({
      extractImpl: fakeExtract,
      downloadImpl: async (_url, dest, deps) => {
        captured = deps?.maxBytes
        writeFileSync(dest, BODY) // matches REAL_SHA so verify passes
        return { status: 200, received: BODY.length, contentLength: BODY.length }
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(captured).toBe(ENGINE_DOWNLOAD_MAX_BYTES)
    expect(captured as number).toBeGreaterThan(0)
    expect(captured as number).toBeLessThan(64 * GiB)
  })

  it('FAILS CLOSED on a placeholder hash — nothing extracted, no marker (RT-02)', async () => {
    // A placeholder (non-real) hash means the archive cannot be verified. This installs
    // EXECUTABLE code, so it must be refused rather than installed-as-unverified — independent
    // of the accepted trust-by-location signing residual (security-model.md S4 / §22-M2). The
    // committed pin never carries a placeholder (guarded by assets.test.ts), so this only fires
    // on a mis-authored or tampered source, which is exactly when it should.
    let extracted = false
    const { rootPath, manifestsDir } = makeDrive('REPLACE_WITH_REAL_HASH')
    const mgr = new EngineDownloadManager({
      fetchImpl: okFetch,
      extractImpl: async (...args: Parameters<typeof fakeExtract>) => {
        extracted = true
        return fakeExtract(...args)
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('failed')
    expect(extracted).toBe(false)
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(false)
    expect(existsSync(runtimeMarkerPath(join(rootPath, 'runtime', 'llama.cpp', HOST_OS)))).toBe(false)
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

  it('installs ALL missing engine families (chat llama + voice whisper) in one job', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    expect(engineStatus(rootPath, manifestsDir).missingFamilies.sort()).toEqual([
      'llama_cpp',
      'whisper_cpp'
    ])
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: familyExtract })
    const job = await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW })).jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(true)
    expect(existsSync(join(rootPath, 'runtime', 'whisper.cpp', HOST_OS, WHISPER_BIN))).toBe(true)
    // Both engines now present → installed, nothing missing.
    const status = engineStatus(rootPath, manifestsDir)
    expect(status.installed).toBe(true)
    expect(status.missingFamilies).toEqual([])
  })

  it('can install just one requested family (voice engine only)', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: familyExtract })
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      families: ['whisper_cpp']
    })
    await runToEnd(mgr, started.jobId)
    expect(existsSync(join(rootPath, 'runtime', 'whisper.cpp', HOST_OS, WHISPER_BIN))).toBe(true)
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(false)
    // The chat engine is still missing.
    expect(engineStatus(rootPath, manifestsDir).missingFamilies).toEqual(['llama_cpp'])
  })
})

// ---- Phase C riders (full-audit 2026-07-11): CODE-13 cancel + upgrade guard, CODE-12 cache ----

describe('cancel during verify/extract + upgrade-while-running (full-audit 2026-07-11 CODE-13)', () => {
  const markerFor = (rootPath: string): string =>
    runtimeMarkerPath(join(rootPath, 'runtime', 'llama.cpp', HOST_OS))

  /** Poll until the job reports `status` (the manager runs the install in the background). */
  async function waitForStatus(
    mgr: EngineDownloadManager,
    jobId: string,
    status: EngineDownloadJob['status']
  ): Promise<void> {
    const start = Date.now()
    while (mgr.get(jobId).status !== status) {
      if (Date.now() - start > 5000) throw new Error(`job never reached ${status}`)
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  it('a cancel DURING the archive hash is honoured — job cancelled, nothing extracted, no marker (BE-4 mirror)', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    let releaseVerify: () => void = () => undefined
    const verifyGate = new Promise<void>((r) => (releaseVerify = r))
    let extracted = false
    const mgr = new EngineDownloadManager({
      fetchImpl: okFetch,
      extractImpl: async () => {
        extracted = true
      },
      // Gate the injected verifier so the cancel lands deterministically mid-hash
      // (the downloads.ts BE-4 test pattern).
      verifyImpl: async (path, sha) => {
        await verifyGate
        return verifyDownloadedFile(path, sha)
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    await waitForStatus(mgr, started.jobId, 'verifying')
    mgr.cancel(started.jobId) // pre-fix: dropped — 'verifying' was not a cancellable state
    releaseVerify()
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('cancelled')
    expect(extracted).toBe(false) // the verify result was never acted on
    expect(existsSync(markerFor(rootPath))).toBe(false)
    expect(engineStatus(rootPath, manifestsDir).installed).toBe(false)
  })

  it('a cancel DURING extraction is honoured — no marker write, install stays non-current', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    let releaseExtract: () => void = () => undefined
    const extractGate = new Promise<void>((r) => (releaseExtract = r))
    const mgr = new EngineDownloadManager({
      fetchImpl: okFetch,
      extractImpl: async (_archive, destDir) => {
        await extractGate
        await writeFile(join(destDir, BIN_NAME), 'binary')
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    await waitForStatus(mgr, started.jobId, 'extracting')
    mgr.cancel(started.jobId) // pre-fix: dropped — 'extracting' was not a cancellable state
    releaseExtract()
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('cancelled')
    // The binary may have landed, but WITHOUT a marker the install is not "current":
    // the next install re-runs cleanly and the pre-spawn verifier treats it as legacy.
    expect(existsSync(markerFor(rootPath))).toBe(false)
  })

  it('refuses a chat-engine install while a model runtime is running — fetch never called', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const fetchSpy = vi.fn()
    const mgr = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    // install() pre-cleans the LIVE llama_cpp dir (Windows: confusing lock failure;
    // POSIX: silent under-swap of the running binary) — refused with friendly copy.
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: ALLOW, chatRuntimeActive: true })
    ).rejects.toThrow(/while a model is running/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // CODE-13 review follow-up: `activeModelId()` alone is null during a multi-GB model START
  // (the manager commits `current` only after health), but the loading child is ALREADY
  // executing from the llama_cpp dir — the IPC predicate must also consult the in-flight
  // `status().startingModelId` so an engine install begun mid-start is refused too.
  it('chatEngineInUse is true while a model is RUNNING or still STARTING (CODE-13 follow-up)', () => {
    const rt = (active: string | null, starting: string | null): Pick<RuntimeManager, 'activeModelId' | 'status'> =>
      ({
        activeModelId: () => active,
        status: () => ({ startingModelId: starting })
      }) as unknown as Pick<RuntimeManager, 'activeModelId' | 'status'>
    expect(chatEngineInUse(rt('m', null))).toBe(true) // running
    expect(chatEngineInUse(rt(null, 'm'))).toBe(true) // still loading — dir already in use
    expect(chatEngineInUse(rt('m', 'm2'))).toBe(true) // a switch underway
    expect(chatEngineInUse(rt(null, null))).toBe(false) // idle — install may proceed
  })

  it('a voice-only install still proceeds while a model runs (llama_cpp already current)', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: familyExtract })
    // Chat engine installed first (nothing running yet)…
    await runToEnd(
      mgr,
      (await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['llama_cpp'] })).jobId
    )
    // …then, with a model running, the missing WHISPER engine must still be installable —
    // the refusal is scoped to jobs that would touch the live llama_cpp dir.
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, chatRuntimeActive: true })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'whisper.cpp', HOST_OS, WHISPER_BIN))).toBe(true)
  })
})

// F-33 (full-audit 2026-07-16): extractWithTar was the only unbounded child in the repo. A cancel
// during 'extracting' only flipped job.status and aborted the fetch controller — nothing reached
// tar — and because activeJob() reported null for a 'cancelled' job, a retry could launch a SECOND
// installOne into the SAME extractTo while the wedged tar was still writing. The fix threads the
// abort signal into ExtractFn (default extractWithTar gains a deadline + SIGKILL escalation) and
// makes a not-yet-settled run() count as busy.
describe('extraction bounds + concurrency (F-33)', () => {
  async function waitForStatus(
    mgr: EngineDownloadManager,
    jobId: string,
    status: EngineDownloadJob['status']
  ): Promise<void> {
    const start = Date.now()
    while (mgr.get(jobId).status !== status) {
      if (Date.now() - start > 5000) throw new Error(`job never reached ${status}`)
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  it('threads the job cancel into the extractor so a signal-aware extract settles at once', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    let sawSignal: AbortSignal | undefined
    // An extract that hangs until its abort signal fires — proves the signal is threaded through.
    const signalAwareExtract: ExtractFn = (_a, _d, signal) =>
      new Promise<void>((_res, rej) => {
        sawSignal = signal
        if (signal?.aborted) return rej(new Error('extract cancelled'))
        signal?.addEventListener('abort', () => rej(new Error('extract cancelled')), { once: true })
      })
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: signalAwareExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    await waitForStatus(mgr, started.jobId, 'extracting')
    // Gate on the extractor being ENTERED, not just the status flip: runOne sets 'extracting'
    // BEFORE awaiting install() (which pre-cleans the dest dir before calling extract), so under
    // CPU starvation the status poll can win that race (observed once at the Phase-10 full-run
    // gate). TS-1 rule: gate on the observable state the assertion needs.
    const entered = Date.now()
    while (sawSignal === undefined) {
      if (Date.now() - entered > 5000) throw new Error('extractor never entered')
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(sawSignal).toBeDefined() // the extractor received the job's abort signal…
    expect(sawSignal!.aborted).toBe(false)
    mgr.cancel(started.jobId) // …and the cancel reaches it (pre-fix: nothing reached tar)
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('cancelled')
  })

  it('a cancelled-but-unsettled run() still counts as busy — a second start is refused', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    let releaseExtract: () => void = () => undefined
    const wedged = new Promise<void>((r) => (releaseExtract = r))
    // A wedged tar that ignores the signal and only settles when we let it.
    const neverExtract: ExtractFn = async (_a, destDir) => {
      await wedged
      await writeFile(join(destDir, BIN_NAME), 'binary')
    }
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: neverExtract })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW })
    await waitForStatus(mgr, started.jobId, 'extracting')
    mgr.cancel(started.jobId) // status → cancelled, but run() is still awaiting the wedged extract
    expect(mgr.get(started.jobId).status).toBe('cancelled')
    // Pre-fix: activeJob() returned null for a 'cancelled' job while run() was in flight, so a
    // retry launched a SECOND install into the same extractTo. Now the unsettled run is busy.
    expect(mgr.activeJob()).toBe(started.jobId)
    await expect(mgr.start({ rootPath, manifestsDir, gates: ALLOW })).rejects.toThrow(/already downloading/i)
    // Let the wedged extract finish so run() settles and the slot frees (no dangling promise).
    releaseExtract()
    const freeBy = Date.now()
    while (mgr.activeJob() !== null) {
      if (Date.now() - freeBy > 5000) throw new Error('slot never freed after run() settled')
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(mgr.get(started.jobId).status).toBe('cancelled')
  })
})

describe('re-install invalidates the binary-verifier session cache (full-audit 2026-07-11 CODE-12)', () => {
  it('a pre-install mismatch verdict does not stick to the freshly installed binary', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const dir = join(rootPath, 'runtime', 'llama.cpp', HOST_OS)
    const binPath = join(dir, BIN_NAME)
    // A tampered pre-existing install: on-disk bytes that do NOT match the marker's hash
    // (an old version string keeps `runtimeInstallCurrent` false so the re-install runs).
    await mkdir(dir, { recursive: true })
    await writeFile(binPath, 'tampered-bytes')
    writeRuntimeMarker(dir, {
      version: 'old',
      backend: 'cpu',
      os: HOST_OS,
      arch: HOST_ARCH,
      binaries: { [BIN_NAME]: createHash('sha256').update('binary').digest('hex') }
    })
    _resetBinaryVerificationForTests()
    initBinaryVerification(false) // packaged build: enforce + session-cache the verdicts
    try {
      // The tamper is detected and the verdict lands in the session cache.
      await expect(verifyBinaryBeforeSpawn(binPath)).resolves.toBe('mismatch')
      // Repair: re-install the engine in-app (fresh bytes + fresh marker hash).
      const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: fakeExtract })
      const job = await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW })).jobId)
      expect(job.status).toBe('done')
      // Pre-fix: the cached 'mismatch' stuck until app restart (silent MockRuntime after a
      // repair). installOne now evicts the entry, so the next spawn re-hashes → ok.
      await expect(verifyBinaryBeforeSpawn(binPath)).resolves.toBe('ok')
    } finally {
      _resetBinaryVerificationForTests()
    }
  })
})

// ---- #339 P8-1 — kiwix_tools, the OPTIONAL two-executable family (T20-a) --------------------
//
// The contract this suite pins: an optional family is NEVER in the default install selection
// (the argument-less `downloadEngine` must not be able to fetch a copyleft, separately-consented
// family), never counted in readiness; an install must produce EVERY declared file (serve,
// manage, search + the Windows ICU DLLs) and hash every one of them into the marker, so both
// spawn seams verify (R-1 closes) and the sell gate can check the runtime files. Fake fetch +
// fake extract as above; the fixture yaml is ours, so it declares `runtime_files` on every
// host (the committed yaml keeps them win-only) — the DLL legs then run on the Linux CI leg too.

const KIWIX_DIR = (rootPath: string): string => join(rootPath, 'runtime', 'kiwix-tools', HOST_OS)
const hostName = (base: string): string => (HOST_OS === 'win' ? `${base}.exe` : base)
const KIWIX_SERVE = hostName('kiwix-serve')
const KIWIX_MANAGE = hostName('kiwix-manage')
const KIWIX_SEARCH = hostName('kiwix-search')
const KIWIX_DLLS = ['icudt74.dll', 'icuuc74.dll']
const KIWIX_FILES = [KIWIX_SERVE, KIWIX_MANAGE, KIWIX_SEARCH, ...KIWIX_DLLS]

/** A drive whose yaml pins the chat engine AND the optional kiwix_tools family for this host. */
function makeKiwixDrive(opts: { optionalKey?: boolean; executables?: string[] } = {}): {
  rootPath: string
  manifestsDir: string
} {
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
          sha256: REAL_SHA,
          extract_to: `runtime/llama.cpp/${HOST_OS}`
        }
      ]
    },
    kiwix_tools: {
      version: '3.8.1',
      ...(opts.optionalKey === false ? {} : { optional: true }),
      executables: opts.executables ?? ['kiwix-serve', 'kiwix-manage', 'kiwix-search'],
      builds: [
        {
          os: HOST_OS,
          arch: HOST_ARCH,
          backend: 'cpu',
          url: 'https://example.test/kiwix-tools.zip',
          sha256: REAL_SHA,
          extract_to: `runtime/kiwix-tools/${HOST_OS}`,
          runtime_files: KIWIX_DLLS
        }
      ]
    }
  })
  writeFileSync(join(manifestsDir, 'runtime-sources.yaml'), yaml)
  return { rootPath, manifestsDir }
}

/** The flat-zip shape: every file at the extract root; `omit` drops one (a broken bundle). */
const kiwixExtract =
  (omit: string | null = null): ExtractFn =>
  async (_archive, destDir) => {
    if (destDir.includes('llama.cpp')) {
      await writeFile(join(destDir, BIN_NAME), 'binary')
      return
    }
    for (const f of KIWIX_FILES) {
      if (f === omit) continue
      await writeFile(join(destDir, f), `bytes of ${f}`)
    }
  }

/** The tarball shape: one top folder holding the three executables (no runtime files). */
const nestedKiwixExtract: ExtractFn = async (_archive, destDir) => {
  const nested = join(destDir, `kiwix-tools_${HOST_OS}-x86_64-3.8.1`)
  await mkdir(nested, { recursive: true })
  for (const f of [KIWIX_SERVE, KIWIX_MANAGE, KIWIX_SEARCH]) await writeFile(join(nested, f), `bytes of ${f}`)
  for (const f of KIWIX_DLLS) await writeFile(join(nested, f), `bytes of ${f}`)
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

async function installKiwix(
  rootPath: string,
  manifestsDir: string,
  extractImpl: ExtractFn = kiwixExtract()
): Promise<EngineDownloadJob> {
  const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl })
  const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['kiwix_tools'] })
  return runToEnd(mgr, started.jobId)
}

describe('kiwix_tools — the optional two-executable family (#339 P8-1, T20-a)', () => {
  it('T20 kiwix_tools family: both executable hashes checked, the optional family never breaks core-engine readiness, per-platform artifacts / digests / notices / source record complete, script-drift matrices green', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    // Readiness before anything is installed: the chat engine is what is missing; kiwix is
    // reported apart, never as a prerequisite.
    const before = engineStatus(rootPath, manifestsDir)
    expect(before.installed).toBe(false)
    expect(before.missingFamilies).toEqual(['llama_cpp'])
    expect(before.missingOptionalFamilies).toEqual(['kiwix_tools'])

    // The DEFAULT install (the argument-less IPC's shape) fetches the chat engine only.
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: kiwixExtract() })
    const defaultJob = await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW })).jobId)
    expect(defaultJob.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(true)
    expect(existsSync(join(KIWIX_DIR(rootPath), KIWIX_SERVE))).toBe(false)
    const afterChat = engineStatus(rootPath, manifestsDir)
    expect(afterChat.installed).toBe(true) // ready WITHOUT the optional family
    expect(afterChat.missingFamilies).toEqual([])
    expect(afterChat.missingOptionalFamilies).toEqual(['kiwix_tools'])
    // …and a second default run has nothing left to do — it does not reach for kiwix.
    await expect(mgr.start({ rootPath, manifestsDir, gates: ALLOW })).rejects.toThrow(/already installed/i)

    // The explicit request installs it: every declared file lands and every one is hashed.
    const job = await installKiwix(rootPath, manifestsDir)
    expect(job.status).toBe('done')
    const dir = KIWIX_DIR(rootPath)
    for (const f of KIWIX_FILES) expect(existsSync(join(dir, f)), f).toBe(true)
    const marker = JSON.parse(readFileSync(runtimeMarkerPath(dir), 'utf8'))
    expect(marker).toMatchObject({ version: '3.8.1', backend: 'cpu', os: HOST_OS })
    expect(marker.binaries).toEqual(Object.fromEntries(KIWIX_FILES.map((f) => [f, sha(`bytes of ${f}`)])))

    // BOTH spawn seams now verify against a recorded hash — no skip-legacy (R-1 closes).
    _resetBinaryVerificationForTests()
    initBinaryVerification(false)
    try {
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_SERVE))).resolves.toBe('ok')
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_MANAGE))).resolves.toBe('ok')
    } finally {
      _resetBinaryVerificationForTests()
    }
    const after = engineStatus(rootPath, manifestsDir)
    expect(after.installed).toBe(true)
    expect(after.missingFamilies).toEqual([])
    expect(after.missingOptionalFamilies).toEqual([])

    // The COMMITTED pin: four per-platform artifacts with real digests, the family optional in
    // the yaml exactly as the code spec says, and the notices carrying the family + its
    // corresponding-source record (the drift and notices suites pin the matrices and the text).
    const repoRoot = join(__dirname, '..', '..', '..', '..')
    const shipped = validateRuntimeSources(parseYaml(readFileSync(join(repoRoot, 'model-manifests', 'runtime-sources.yaml'), 'utf8')))
    expect(shipped.errors).toEqual([])
    const kiwix = shipped.families?.kiwix_tools
    expect(kiwix?.version).toBe('3.8.1')
    expect(kiwix?.optional).toBe(true)
    expect(kiwix?.executables).toEqual(['kiwix-serve', 'kiwix-manage', 'kiwix-search'])
    expect(kiwix?.builds.map((b) => `${b.os}/${b.arch}`)).toEqual(['win/x64', 'mac/arm64', 'mac/x64', 'linux/x64'])
    for (const b of kiwix?.builds ?? []) {
      expect(isRealSha256(b.sha256), b.url).toBe(true)
      expect(b.url.startsWith('https://download.kiwix.org/release/kiwix-tools/')).toBe(true)
    }
    expect(kiwix?.builds[0]?.runtimeFiles).toEqual(['icudt74.dll', 'icuin74.dll', 'icuio74.dll', 'icutu74.dll', 'icuuc74.dll'])
    expect(SIDECAR_FAMILY_SPECS.find((s) => s.family === 'kiwix_tools')?.optional).toBe(true)
    const notices = readFileSync(join(repoRoot, 'DRIVE-NOTICES.md'), 'utf8')
    expect(notices).toContain('runtime-family: kiwix_tools 3.8.1')
    expect(notices).toContain('### kiwix-tools 3.8.1 — GPL-3.0-or-later')
    expect(notices).toContain('#### Complete corresponding source')
  })

  it('whisper_cpp keeps its non-optional semantics (a missing whisper-cli still makes installed false)', () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const status = engineStatus(rootPath, manifestsDir)
    expect(status.installed).toBe(false)
    expect(status.missingFamilies.sort()).toEqual(['llama_cpp', 'whisper_cpp'])
    expect(status.missingOptionalFamilies).toEqual([])
  })

  it('a drive yaml that drops optional:true still cannot put kiwix_tools in the default selection (the code-side floor)', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive({ optionalKey: false })
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: kiwixExtract() })
    const job = await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW })).jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(KIWIX_DIR(rootPath), KIWIX_SERVE))).toBe(false)
    expect(engineStatus(rootPath, manifestsDir).missingOptionalFamilies).toEqual(['kiwix_tools'])
  })

  it.each([KIWIX_SERVE, KIWIX_MANAGE, KIWIX_DLLS[0]!])(
    'a kiwix_tools install fails when %s is missing from the archive — no marker, nothing current',
    async (missing) => {
      const { rootPath, manifestsDir } = makeKiwixDrive()
      const job = await installKiwix(rootPath, manifestsDir, kiwixExtract(missing))
      expect(job.status).toBe('failed')
      expect(job.error).toMatch(/engine/i)
      expect(existsSync(runtimeMarkerPath(KIWIX_DIR(rootPath)))).toBe(false)
      // Still installable: the next request runs again rather than "already installed".
      const again = await installKiwix(rootPath, manifestsDir)
      expect(again.status).toBe('done')
    }
  )

  it('a kiwix_tools archive whose SHA-256 does not match installs nothing and writes no marker', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    const badFetch = (async () =>
      new Response('not the pinned bytes', { status: 200 })) as unknown as FetchFn
    const mgr = new EngineDownloadManager({ fetchImpl: badFetch, extractImpl: kiwixExtract() })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['kiwix_tools'] })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('failed')
    expect(existsSync(join(KIWIX_DIR(rootPath), KIWIX_SERVE))).toBe(false)
    expect(existsSync(runtimeMarkerPath(KIWIX_DIR(rootPath)))).toBe(false)
  })

  it('a cancel during a kiwix_tools extraction leaves no marker and the next job re-installs cleanly', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const mgr = new EngineDownloadManager({
      fetchImpl: okFetch,
      extractImpl: async (archive, destDir) => {
        await gate
        await kiwixExtract()(archive, destDir)
      }
    })
    const started = await mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['kiwix_tools'] })
    const start = Date.now()
    while (mgr.get(started.jobId).status !== 'extracting') {
      if (Date.now() - start > 5000) throw new Error('never extracting')
      await new Promise((r) => setTimeout(r, 2))
    }
    mgr.cancel(started.jobId)
    release()
    expect((await runToEnd(mgr, started.jobId)).status).toBe('cancelled')
    expect(existsSync(runtimeMarkerPath(KIWIX_DIR(rootPath)))).toBe(false)
    const again = await installKiwix(rootPath, manifestsDir)
    expect(again.status).toBe('done')
    expect(existsSync(runtimeMarkerPath(KIWIX_DIR(rootPath)))).toBe(true)
  })

  it('re-installing kiwix_tools after a tamper re-hashes every executable and clears the verifier cache for both', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    const dir = KIWIX_DIR(rootPath)
    await mkdir(dir, { recursive: true })
    for (const f of KIWIX_FILES) await writeFile(join(dir, f), 'tampered')
    writeRuntimeMarker(dir, {
      version: 'old',
      backend: 'cpu',
      os: HOST_OS,
      arch: HOST_ARCH,
      binaries: Object.fromEntries(KIWIX_FILES.map((f) => [f, sha(`bytes of ${f}`)]))
    })
    _resetBinaryVerificationForTests()
    initBinaryVerification(false)
    try {
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_SERVE))).resolves.toBe('mismatch')
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_MANAGE))).resolves.toBe('mismatch')
      expect((await installKiwix(rootPath, manifestsDir)).status).toBe('done')
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_SERVE))).resolves.toBe('ok')
      await expect(verifyBinaryBeforeSpawn(join(dir, KIWIX_MANAGE))).resolves.toBe('ok')
    } finally {
      _resetBinaryVerificationForTests()
    }
  })

  it('the kiwix_tools tarball shape is flattened so all three executables and the runtime files land at the extract root', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    const job = await installKiwix(rootPath, manifestsDir, nestedKiwixExtract)
    expect(job.status).toBe('done')
    for (const f of KIWIX_FILES) expect(existsSync(join(KIWIX_DIR(rootPath), f)), f).toBe(true)
    expect(existsSync(join(KIWIX_DIR(rootPath), `kiwix-tools_${HOST_OS}-x86_64-3.8.1`, KIWIX_SERVE))).toBe(false)
  })

  it('a hashing failure writes the marker with no binaries map at all, never a partial one', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    // `kiwix-search` lands as a DIRECTORY: it exists, so the completeness check passes, but
    // hashing it throws — the whole map must then be dropped, not just that entry.
    const job = await installKiwix(rootPath, manifestsDir, async (archive, destDir) => {
      await kiwixExtract(KIWIX_SEARCH)(archive, destDir)
      if (!destDir.includes('llama.cpp')) await mkdir(join(destDir, KIWIX_SEARCH), { recursive: true })
    })
    expect(job.status).toBe('done')
    const marker = JSON.parse(readFileSync(runtimeMarkerPath(KIWIX_DIR(rootPath)), 'utf8'))
    expect(marker).toEqual({ version: '3.8.1', backend: 'cpu', os: HOST_OS, arch: HOST_ARCH })
  })

  it('a kiwix_tools install is refused while a kiwix_tools sidecar child is registered', async () => {
    const { rootPath, manifestsDir } = makeKiwixDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: kiwixExtract() })
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['kiwix_tools'], kiwixToolsActive: true })
    ).rejects.toThrow(/knowledge-pack tools/i)
    // The chat engine is unaffected by that flag.
    const job = await runToEnd(mgr, (await mgr.start({ rootPath, manifestsDir, gates: ALLOW, kiwixToolsActive: true })).jobId)
    expect(job.status).toBe('done')
  })
})

describe('resolveTarBinary (CWD-binary-planting hardening, vuln-scan 2026-06-21)', () => {
  it('pins the absolute System32 tar.exe on Windows (never a bare, CWD-resolvable name)', () => {
    const resolved = resolveTarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => true)
    expect(resolved).toBe('C:\\Windows\\System32\\tar.exe')
    // Critically, it must contain a path separator so libuv never searches the CWD first.
    expect(resolved).toContain('\\')
  })

  it('pins the absolute /usr/bin/tar on POSIX hosts', () => {
    expect(resolveTarBinary('linux', {}, (p) => p === '/usr/bin/tar')).toBe('/usr/bin/tar')
    expect(resolveTarBinary('darwin', {}, (p) => p === '/usr/bin/tar')).toBe('/usr/bin/tar')
    // Falls through to /bin/tar when /usr/bin/tar is absent.
    expect(resolveTarBinary('linux', {}, (p) => p === '/bin/tar')).toBe('/bin/tar')
  })

  it('falls back to the bare name only when no known absolute tar exists (exotic host)', () => {
    expect(resolveTarBinary('linux', {}, () => false)).toBe('tar')
    expect(resolveTarBinary('win32', { SystemRoot: 'C:\\Windows' }, () => false)).toBe('tar')
  })
})

// F-32 (full-audit 2026-07-16): the in-use guard covered only the CHAT runtime — but the
// embedder/reranker/vision/translation sidecars all execute the SAME runtime/llama.cpp/<os>/
// binary an install pre-cleans, and whisper-cli runs for hours mid-import from
// runtime/whisper.cpp/<os>/. The guard is now widened per family.
describe('engine in-use guard, widened per family (F-32)', () => {
  it('llamaSidecarInUse / whisperSidecarInUse read the per-family PID registry', () => {
    killRegisteredSidecarChildren(() => undefined) // isolate leftovers from other suites
    expect(llamaSidecarInUse()).toBe(false)
    expect(whisperSidecarInUse()).toBe(false)
    registerSidecarChild(7001, 'llama_cpp') // e.g. a live E5 embedder / translation sidecar
    expect(llamaSidecarInUse()).toBe(true)
    expect(whisperSidecarInUse()).toBe(false) // still no transcription child
    registerSidecarChild(7002, 'whisper_cpp')
    expect(whisperSidecarInUse()).toBe(true)
    unregisterSidecarChild(7001)
    unregisterSidecarChild(7002)
    expect(llamaSidecarInUse()).toBe(false)
    expect(whisperSidecarInUse()).toBe(false)
  })

  it('refuses a llama_cpp install while a NON-chat llama sidecar is live — fetch never called', async () => {
    const { rootPath, manifestsDir } = makeDrive()
    const fetchSpy = vi.fn()
    const mgr = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    // chatRuntimeActive false (no chat model), but an embedder/translation sidecar is up.
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: ALLOW, llamaSidecarActive: true })
    ).rejects.toThrow(/while a model is running/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a whisper_cpp install mid-transcription — fetch never called', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const fetchSpy = vi.fn()
    const mgr = new EngineDownloadManager({ fetchImpl: fetchSpy as unknown as FetchFn })
    await expect(
      mgr.start({ rootPath, manifestsDir, gates: ALLOW, families: ['whisper_cpp'], whisperActive: true })
    ).rejects.toThrow(/transcrib/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a whisper_cpp install still proceeds while a llama sidecar runs (other-family scoping)', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: familyExtract })
    // A llama sidecar is live, but the whisper-only install touches a different dir → allowed.
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      families: ['whisper_cpp'],
      llamaSidecarActive: true
    })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'whisper.cpp', HOST_OS, WHISPER_BIN))).toBe(true)
  })

  it('a llama_cpp install still proceeds mid-transcription (other-family scoping)', async () => {
    const { rootPath, manifestsDir } = makeMultiFamilyDrive()
    const mgr = new EngineDownloadManager({ fetchImpl: okFetch, extractImpl: familyExtract })
    const started = await mgr.start({
      rootPath,
      manifestsDir,
      gates: ALLOW,
      families: ['llama_cpp'],
      whisperActive: true
    })
    const job = await runToEnd(mgr, started.jobId)
    expect(job.status).toBe('done')
    expect(existsSync(join(rootPath, 'runtime', 'llama.cpp', HOST_OS, BIN_NAME))).toBe(true)
  })
})
