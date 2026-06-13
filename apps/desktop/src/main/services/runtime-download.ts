import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { tMain } from './i18n'
import type { EngineDownloadJob, EngineStatus } from '../../shared/types'
import {
  validateRuntimeSources,
  type RuntimeOs,
  type RuntimeBuild,
  type RuntimeSources
} from '../../shared/runtime-sources'
import { llamaOsDir, llamaServerBinaryName } from './runtime/sidecar'
import {
  downloadToFile,
  planRuntimeDownload,
  runtimeInstallCurrent,
  selectRuntimeBuild,
  verifyDownloadedFile,
  writeRuntimeMarker,
  type FetchFn,
  type RuntimeDownloadPlan
} from './assets'
import { assertDownloadAllowed, type DownloadGates } from './downloads'

// In-app engine (llama.cpp sidecar) downloader. The model downloader fetches WEIGHTS;
// without the `llama-server` binary a started model falls back to the built-in demo
// runtime (services/runtime/factory.ts — "no llama-server binary on the drive"). This
// service fetches + SHA-256-verifies + extracts the host's prebuilt build from
// model-manifests/runtime-sources.yaml into runtime/llama.cpp/<os>/, so the next model
// start lands on the REAL runtime. It mirrors the canonical fetch-runtime scripts
// (download → verify → clean → extract → flatten → install marker), with the network and
// extraction behind injected seams so the unit suite stays zero-network and zero-shell.
//
// Gates are identical to the model downloader (policy ceiling ∧ the allowNetwork setting),
// re-checked here in the main process. One engine download runs at a time.

/** Map the Node platform to a runtime-sources OS key (mirrors `llamaOsDir`). */
export function hostRuntimeOs(platform: NodeJS.Platform = process.platform): RuntimeOs {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  return 'linux'
}

/** Map the Node arch to a runtime-sources arch key (the catalog ships x64 + arm64). */
export function hostRuntimeArch(arch: string = process.arch): string {
  return arch === 'arm64' ? 'arm64' : 'x64'
}

/**
 * Load + validate `runtime-sources.yaml` from a manifests dir. Returns null (never throws)
 * when the file is absent or malformed — the caller degrades to "engine not fetchable".
 */
export function loadRuntimeSources(manifestsDir: string): RuntimeSources | null {
  const path = join(manifestsDir, 'runtime-sources.yaml')
  if (!existsSync(path)) return null
  try {
    const result = validateRuntimeSources(parseYaml(readFileSync(path, 'utf8')))
    return result.ok && result.sources ? result.sources : null
  } catch {
    return null
  }
}

/** Resolve the host's `llama-server` build from runtime-sources (null when none matches). */
export function selectHostBuild(
  sources: RuntimeSources,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeBuild | null {
  return selectRuntimeBuild(sources, { os: hostRuntimeOs(platform), arch: hostRuntimeArch(arch) })
}

/** Absolute path of the host's on-drive `llama-server` binary. */
function hostBinaryPath(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(rootPath, 'runtime', 'llama.cpp', llamaOsDir(platform), llamaServerBinaryName(platform))
}

/**
 * Read-only status for the renderer's "install the engine" surface: is the binary already
 * present, and is there a host build to fetch (with its pinned version/backend)?
 */
export function engineStatus(
  rootPath: string,
  manifestsDir: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): EngineStatus {
  const installed = existsSync(hostBinaryPath(rootPath, platform))
  const sources = manifestsDir ? loadRuntimeSources(manifestsDir) : null
  const build = sources ? selectHostBuild(sources, platform, arch) : null
  return {
    installed,
    available: build !== null,
    version: sources?.version ?? null,
    backend: build?.backend ?? null
  }
}

/** Extract a release archive into `destDir`. Injected so tests never shell out. */
export type ExtractFn = (archivePath: string, destDir: string) => Promise<void>

/**
 * Default extractor: `tar -xf <archive> -C <dir>`. One command covers every host because
 * each platform's archive is one its `tar` understands — Windows 10+ ships bsdtar (handles
 * the .zip release assets), macOS bsdtar + GNU tar both auto-detect the .tar.gz gzip. The
 * DIY scripts use the same native tools (unzip/ditto/tar); this is the in-app equivalent.
 */
export const extractWithTar: ExtractFn = (archivePath, destDir) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`tar exited with code ${code}`))
    )
  })

export interface EngineDownloadDeps {
  fetchImpl?: FetchFn
  extractImpl?: ExtractFn
  log?: (msg: string, meta?: unknown) => void
}

export interface StartEngineDownloadOptions {
  rootPath: string
  manifestsDir: string | null
  gates: DownloadGates
  platform?: NodeJS.Platform
  arch?: string
}

const MAX_TERMINAL_JOBS = 10

/**
 * Owns the in-app engine-download job. One at a time; the job lives in memory for the
 * session (the durable truth is the extracted binary + its `.hilbertraum-runtime.json`
 * marker on disk). The renderer polls `get(jobId)`.
 */
export class EngineDownloadManager {
  private jobs = new Map<string, EngineDownloadJob>()
  private active: { jobId: string; controller: AbortController } | null = null

  constructor(private readonly deps: EngineDownloadDeps = {}) {}

  /**
   * Validate the gates, resolve the host build, and start fetching in the background.
   * Throws a friendly, cause-specific error when a gate is closed, another download is
   * running, there is no host build, or the engine is already installed + current.
   */
  async start(opts: StartEngineDownloadOptions): Promise<EngineDownloadJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    if (this.activeJob() !== null) {
      throw new Error(tMain('main.engine.alreadyRunning'))
    }
    const sources = opts.manifestsDir ? loadRuntimeSources(opts.manifestsDir) : null
    if (!sources) {
      throw new Error(tMain('main.engine.noSources'))
    }
    const build = selectHostBuild(sources, opts.platform, opts.arch)
    if (!build) {
      throw new Error(tMain('main.engine.noHostBuild'))
    }
    const plan = planRuntimeDownload(opts.rootPath, build, sources.version)
    if (runtimeInstallCurrent(plan)) {
      throw new Error(tMain('main.engine.alreadyInstalled'))
    }

    const job: EngineDownloadJob = {
      jobId: randomUUID(),
      status: 'queued',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      binaryPath: null,
      error: null
    }
    this.jobs.set(job.jobId, job)
    const controller = new AbortController()
    this.active = { jobId: job.jobId, controller }
    this.deps.log?.('Engine download started', {
      jobId: job.jobId,
      build: `${build.os}/${build.arch}/${build.backend}`,
      version: sources.version
    })
    void this.run(job, plan, controller).finally(() => {
      if (this.active?.jobId === job.jobId) this.active = null
    })
    return { ...job }
  }

  get(jobId: string): EngineDownloadJob {
    const job = this.jobs.get(jobId)
    if (job) return { ...job }
    return {
      jobId,
      status: 'failed',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      binaryPath: null,
      error: tMain('main.engine.unknownJob')
    }
  }

  cancel(jobId: string): EngineDownloadJob {
    const job = this.jobs.get(jobId)
    if (!job) return this.get(jobId)
    if (job.status === 'queued' || job.status === 'downloading') {
      job.status = 'cancelled'
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('Engine download cancelled', { jobId })
    }
    return { ...job }
  }

  activeJob(): string | null {
    if (!this.active) return null
    const job = this.jobs.get(this.active.jobId)
    if (!job) return null
    const live =
      job.status === 'queued' ||
      job.status === 'downloading' ||
      job.status === 'verifying' ||
      job.status === 'extracting'
    return live ? this.active.jobId : null
  }

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter(
      (j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
    )
    for (const job of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))) {
      this.jobs.delete(job.jobId)
    }
  }

  private async run(
    job: EngineDownloadJob,
    plan: RuntimeDownloadPlan,
    controller: AbortController
  ): Promise<void> {
    try {
      await mkdir(plan.extractTo, { recursive: true })
      // Fetch the release archive. No Range resume (an engine zip is far smaller than a
      // multi-GB weight, and a corrupt partial must never be extracted) — a fresh archive
      // each attempt; a stale one from a cancelled run is overwritten.
      job.status = 'downloading'
      const result = await downloadToFile(plan.url, plan.zipDest, {
        fetchImpl: this.deps.fetchImpl,
        signal: controller.signal,
        onResponse: ({ contentLength }) => {
          if (contentLength != null) job.totalBytes = contentLength
        },
        onProgress: (received) => {
          job.receivedBytes = received
        }
      })
      if (controller.signal.aborted) {
        await rm(plan.zipDest, { force: true })
        return
      }
      this.deps.log?.('Engine archive downloaded, verifying', {
        status: result.status,
        bytes: job.receivedBytes
      })

      job.status = 'verifying'
      const verify = await verifyDownloadedFile(plan.zipDest, plan.sha256)
      if (verify.reason === 'mismatch') {
        await rm(plan.zipDest, { force: true })
        job.status = 'failed'
        job.error = tMain('main.engine.checksumMismatch')
        this.deps.log?.('Engine archive checksum mismatch — discarded', {
          expected: plan.sha256,
          actual: verify.actual
        })
        return
      }
      if (verify.reason === 'missing') {
        job.status = 'failed'
        job.error = tMain('main.engine.fileMissing')
        return
      }
      // ok (verified) or placeholder (cannot verify): the bytes are complete either way.
      job.unverified = verify.reason === 'placeholder'

      job.status = 'extracting'
      await this.install(plan)
      await rm(plan.zipDest, { force: true })

      if (!existsSync(plan.binaryPath)) {
        job.status = 'failed'
        job.error = tMain('main.engine.binaryMissing')
        this.deps.log?.('Engine extraction finished but the binary is missing', {
          extractTo: plan.extractTo
        })
        return
      }
      if (plan.os !== 'win') {
        try {
          chmodSync(plan.binaryPath, 0o755)
        } catch {
          /* best-effort; a non-executable bit surfaces on the next start */
        }
      }
      writeRuntimeMarker(plan.extractTo, {
        version: plan.version,
        backend: plan.backend,
        os: plan.os,
        arch: plan.arch
      })
      job.binaryPath = plan.binaryPath
      job.status = 'done'
      this.deps.log?.('Engine installed', {
        binaryPath: plan.binaryPath,
        verified: !job.unverified
      })
    } catch (err) {
      if (job.status === 'cancelled') {
        await rm(plan.zipDest, { force: true })
        return
      }
      job.status = 'failed'
      job.error = friendlyEngineError(err)
      this.deps.log?.('Engine download failed', { error: String(err) })
      await rm(plan.zipDest, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Clean a stale prior install, extract the archive, then flatten so `llama-server`
   * lands at the extract-dir root (the macOS/Linux tarballs nest under a release folder).
   * Mirrors the fetch-runtime scripts' extract + flatten steps.
   */
  private async install(plan: RuntimeDownloadPlan): Promise<void> {
    // Remove the previous install before extracting so two builds never mix — but keep the
    // just-downloaded archive and the `cpu/` safety-net subdir (audit fix: the cpu→vulkan
    // upgrade path; a stale root binary would otherwise satisfy the flatten guard).
    const archiveName = basename(plan.zipDest)
    for (const entry of await readdir(plan.extractTo)) {
      if (entry === archiveName || entry === 'cpu') continue
      await rm(join(plan.extractTo, entry), { recursive: true, force: true })
    }

    const extract = this.deps.extractImpl ?? extractWithTar
    await extract(plan.zipDest, plan.extractTo)

    // Flatten: when the binary is nested (release-folder tarballs), move its directory's
    // contents up to the extract root, where services/runtime/sidecar.ts resolves it. The
    // `cpu/` subdir is excluded from the search so a re-fetch of the DEFAULT build never
    // mistakes the safety net for the freshly extracted nested binary.
    if (existsSync(plan.binaryPath)) return
    const binName = basename(plan.binaryPath)
    const found = await findBinary(plan.extractTo, binName, join(plan.extractTo, 'cpu'))
    if (!found) return
    const srcDir = join(found, '..')
    if (resolveSame(srcDir, plan.extractTo)) return
    for (const entry of await readdir(srcDir)) {
      await rename(join(srcDir, entry), join(plan.extractTo, entry))
    }
  }
}

/** Depth-first search for a file named `binName` under `dir`, skipping `skipDir`. */
async function findBinary(dir: string, binName: string, skipDir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return null
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (resolveSame(full, skipDir)) continue
      const nested = await findBinary(full, binName, skipDir)
      if (nested) return nested
    } else if (e.name === binName) {
      return full
    }
  }
  return null
}

/** Cheap path-equality for the flatten guard (normalizes the `dir/..` join form). */
function resolveSame(a: string, b: string): boolean {
  return join(a) === join(b)
}

function friendlyEngineError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/HTTP \d+/.test(raw)) {
    return tMain('main.engine.httpFailed', { reason: raw.replace(/^Download failed: /, '') })
  }
  if (/tar exited|extract/i.test(raw)) {
    return tMain('main.engine.extractFailed')
  }
  return tMain('main.engine.interrupted', { reason: raw })
}

/** Re-export the binary path resolver for the IPC status handler + tests. */
export { hostBinaryPath }

/** Statvalue helper kept tiny for tests that assert a downloaded archive's presence. */
export function archivePresent(plan: Pick<RuntimeDownloadPlan, 'zipDest'>): boolean {
  return existsSync(plan.zipDest) && statSync(plan.zipDest).isFile()
}
