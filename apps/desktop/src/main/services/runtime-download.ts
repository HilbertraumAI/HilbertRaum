import { chmodSync, existsSync, readFileSync } from 'node:fs'
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
  type RuntimeSources,
  type RuntimeSourcesResult
} from '../../shared/runtime-sources'
import { llamaOsDir } from './runtime/sidecar'
import {
  downloadToFile,
  markerBinaryKey,
  planRuntimeDownload,
  runtimeInstallCurrent,
  selectRuntimeBuild,
  verifyDownloadedFile,
  writeRuntimeMarker,
  WHISPER_BINARY_BASE,
  type FetchFn,
  type RuntimeDownloadPlan
} from './assets'
import { sha256File } from './models'
import { assertDownloadAllowed, type DownloadGates } from './downloads'

// In-app engine (prebuilt sidecar binary) downloader. The model downloader fetches model
// WEIGHTS; the ENGINE binaries (the llama.cpp chat server, the whisper.cpp transcriber)
// are separate assets normally provisioned at drive-build time by `fetch-runtime`. Without
// them a started chat model falls back to the demo runtime (services/runtime/factory.ts —
// "no llama-server binary on the drive") and voice dictation never appears (no transcriber).
// This service fetches + SHA-256-verifies + extracts the host's prebuilt build for EACH
// engine family from model-manifests/runtime-sources.yaml into runtime/<family>/<os>/,
// mirroring the canonical fetch-runtime scripts (download → verify → clean → extract →
// flatten → install marker). The network (`fetchImpl`) and extraction (`extractImpl`,
// default `tar -xf`) are injected seams so the unit suite stays zero-network/zero-shell.
//
// FAMILIES: today llama_cpp (chat) + whisper_cpp (transcription). To add a future engine,
// list it in `ENGINE_FAMILIES` with its runtime-sources block name + binary base name and
// add the matching `<family>:` block to runtime-sources.yaml — everything else (status,
// install, the Models-screen banner) generalizes automatically. (See docs/packaging.md.)
//
// Gates are identical to the model downloader (policy ceiling ∧ the allowNetwork setting),
// re-checked here in the main process. One engine download (covering all missing families)
// runs at a time.

/** The engine families this installer knows how to fetch. */
export type EngineFamily = 'llama_cpp' | 'whisper_cpp'

interface FamilySpec {
  family: EngineFamily
  /** The sidecar's executable base name (`llama-server` / `whisper-cli`). */
  binaryBase: string
}

// Order matters: llama_cpp (the chat engine — the one whose absence forces demo mode) is
// installed first, then whisper_cpp. `engineStatus.version/backend` report the first family.
const ENGINE_FAMILIES: FamilySpec[] = [
  { family: 'llama_cpp', binaryBase: 'llama-server' },
  { family: 'whisper_cpp', binaryBase: WHISPER_BINARY_BASE }
]

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

/** Read + validate `runtime-sources.yaml`; null (never throws) when absent or malformed. */
function loadSourcesResult(manifestsDir: string): RuntimeSourcesResult | null {
  const path = join(manifestsDir, 'runtime-sources.yaml')
  if (!existsSync(path)) return null
  try {
    const result = validateRuntimeSources(parseYaml(readFileSync(path, 'utf8')))
    return result.ok ? result : null
  } catch {
    return null
  }
}

/** The `{ version, builds }` block for one family (llama_cpp → `sources`, whisper_cpp → `whisper`). */
function familyBlock(result: RuntimeSourcesResult, family: EngineFamily): RuntimeSources | undefined {
  return family === 'whisper_cpp' ? result.whisper : result.sources
}

/**
 * Load + validate the llama.cpp engine sources from a manifests dir (the chat engine block).
 * Returns null when absent/malformed. Kept for callers/tests that only need llama_cpp.
 */
export function loadRuntimeSources(manifestsDir: string): RuntimeSources | null {
  const result = loadSourcesResult(manifestsDir)
  return result?.sources ?? null
}

/** Resolve the host's build from a sources block (null when none matches this os/arch). */
export function selectHostBuild(
  sources: RuntimeSources,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): RuntimeBuild | null {
  return selectRuntimeBuild(sources, { os: hostRuntimeOs(platform), arch: hostRuntimeArch(arch) })
}

/** One installable engine family resolved for this host (build + plan). */
interface EnginePlan {
  family: EngineFamily
  version: string
  build: RuntimeBuild
  plan: RuntimeDownloadPlan
}

/**
 * Every engine family that HAS a prebuilt build for this host (so it is fetchable). A
 * family with no host build (e.g. whisper.cpp on macOS/Linux, which ships Windows-only
 * prebuilt binaries) is simply absent — the drive builder compiles those from source.
 */
function availableEngines(
  rootPath: string,
  manifestsDir: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): EnginePlan[] {
  const result = manifestsDir ? loadSourcesResult(manifestsDir) : null
  if (!result) return []
  const out: EnginePlan[] = []
  for (const spec of ENGINE_FAMILIES) {
    const sources = familyBlock(result, spec.family)
    if (!sources) continue
    const build = selectHostBuild(sources, platform, arch)
    if (!build) continue
    const plan = planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase)
    out.push({ family: spec.family, version: sources.version, build, plan })
  }
  return out
}

/**
 * Read-only status for the renderer's "install the engine" surface. `installed` is true
 * only when EVERY fetchable engine's binary is present; `missingFamilies` lists the rest.
 * `version`/`backend` report the chat engine (llama_cpp) for the banner copy.
 */
export function engineStatus(
  rootPath: string,
  manifestsDir: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): EngineStatus {
  const engines = availableEngines(rootPath, manifestsDir, platform, arch)
  const missing = engines.filter((e) => !existsSync(e.plan.binaryPath))
  const llama = engines.find((e) => e.family === 'llama_cpp') ?? engines[0]
  return {
    installed: engines.length > 0 && missing.length === 0,
    available: engines.length > 0,
    version: llama?.version ?? null,
    backend: llama?.build.backend ?? null,
    missingFamilies: missing.map((e) => e.family)
  }
}

/** Extract a release archive into `destDir`. Injected so tests never shell out. */
export type ExtractFn = (archivePath: string, destDir: string) => Promise<void>

/**
 * Resolve `tar` to an ABSOLUTE path. A BARE `spawn('tar', …)` is unsafe on Windows: libuv
 * resolves a command name without a path separator against the process CURRENT DIRECTORY
 * BEFORE System32/PATH, so a malicious `tar.exe` planted in the app's CWD (plausible for a
 * portable-drive app whose CWD may be the drive or a world-writable launch dir) would run in
 * our place with the main process's privileges — arbitrary code execution on an engine
 * install (vuln-scan 2026-06-21 [rce]). The archive SHA-256 protects the CONTENTS, not the
 * `tar` interpreter. We pin the OS-provided bsdtar/GNU tar at its known absolute location;
 * only when none of those exist (an exotic host) do we fall back to the bare name so install
 * still works there. Mirrors the absolute-path discipline already used for the sidecar spawns.
 */
export function resolveTarBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync
): string {
  const candidates =
    platform === 'win32'
      ? [join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe')]
      : ['/usr/bin/tar', '/bin/tar']
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  return 'tar'
}

/**
 * Default extractor: `tar -xf <archive> -C <dir>` via the OS's pinned `tar` (see
 * `resolveTarBinary`). One command covers every host because each platform's archive is one
 * its `tar` understands — Windows 10+ ships bsdtar (handles the .zip release assets), macOS
 * bsdtar + GNU tar both auto-detect the .tar.gz gzip. The DIY scripts use the same native
 * tools (unzip/ditto/tar); this is the in-app equivalent.
 */
export const extractWithTar: ExtractFn = (archivePath, destDir) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolveTarBinary(), ['-xf', archivePath, '-C', destDir], {
      stdio: 'ignore',
      // Don't inherit a possibly attacker-influenced CWD for the child; the archive path is
      // absolute so this only pins where the (absolute) interpreter is launched from.
      cwd: destDir,
      windowsHide: true
    })
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
  /** Restrict the install to these families (default: every missing, fetchable family). */
  families?: EngineFamily[]
  platform?: NodeJS.Platform
  arch?: string
}

const MAX_TERMINAL_JOBS = 10

/**
 * Owns the in-app engine-download job. One at a time; a single job installs every missing
 * engine family in sequence. The job lives in memory for the session (the durable truth is
 * the extracted binaries + their `.hilbertraum-runtime.json` markers). The renderer polls
 * `get(jobId)`.
 */
export class EngineDownloadManager {
  private jobs = new Map<string, EngineDownloadJob>()
  private active: { jobId: string; controller: AbortController } | null = null

  constructor(private readonly deps: EngineDownloadDeps = {}) {}

  /**
   * Validate the gates, resolve which engine families are missing, and start fetching them
   * in the background. Throws a friendly, cause-specific error when a gate is closed,
   * another download is running, there are no engine sources / host build, or everything is
   * already installed + current.
   */
  async start(opts: StartEngineDownloadOptions): Promise<EngineDownloadJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    if (this.activeJob() !== null) {
      throw new Error(tMain('main.engine.alreadyRunning'))
    }
    if (!opts.manifestsDir || !loadSourcesResult(opts.manifestsDir)) {
      throw new Error(tMain('main.engine.noSources'))
    }
    const engines = availableEngines(opts.rootPath, opts.manifestsDir, opts.platform, opts.arch)
    if (engines.length === 0) {
      throw new Error(tMain('main.engine.noHostBuild'))
    }
    // Install the requested families (default: all), minus any already current per marker.
    const wanted = opts.families
    const installs = engines.filter(
      (e) => (!wanted || wanted.includes(e.family)) && !runtimeInstallCurrent(e.plan)
    )
    if (installs.length === 0) {
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
      families: installs.map((e) => `${e.family}:${e.build.os}/${e.build.arch}/${e.build.backend}`)
    })
    void this.run(job, installs, controller).finally(() => {
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

  /** Install every requested family in sequence; the first failure fails the whole job. */
  private async run(
    job: EngineDownloadJob,
    installs: EnginePlan[],
    controller: AbortController
  ): Promise<void> {
    let firstBinary: string | null = null
    for (const engine of installs) {
      // Each family is a fresh download — reset the per-file progress counters.
      job.receivedBytes = 0
      job.totalBytes = null
      const outcome = await this.installOne(job, engine.plan, controller)
      if (outcome === 'aborted') return // a cancel; the partial archive was cleaned
      if (outcome === 'failed') return // job.status/error already set
      if (!firstBinary) firstBinary = engine.plan.binaryPath
    }
    job.binaryPath = firstBinary
    job.status = 'done'
  }

  /**
   * Download → verify → clean → extract → flatten → marker for ONE family. Returns the
   * outcome; on 'failed' it sets `job.status`/`job.error`. `job.unverified` is sticky (set
   * if ANY family's hash is a placeholder).
   */
  private async installOne(
    job: EngineDownloadJob,
    plan: RuntimeDownloadPlan,
    controller: AbortController
  ): Promise<'done' | 'failed' | 'aborted'> {
    try {
      await mkdir(plan.extractTo, { recursive: true })
      // Fetch the release archive. No Range resume (an engine archive is far smaller than a
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
        return 'aborted'
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
        return 'failed'
      }
      if (verify.reason === 'missing') {
        job.status = 'failed'
        job.error = tMain('main.engine.fileMissing')
        return 'failed'
      }
      // ok (verified) or placeholder (cannot verify): the bytes are complete either way.
      if (verify.reason === 'placeholder') job.unverified = true

      job.status = 'extracting'
      await this.install(plan)
      await rm(plan.zipDest, { force: true })

      if (!existsSync(plan.binaryPath)) {
        job.status = 'failed'
        job.error = tMain('main.engine.binaryMissing')
        this.deps.log?.('Engine extraction finished but the binary is missing', {
          extractTo: plan.extractTo
        })
        return 'failed'
      }
      if (plan.os !== 'win') {
        try {
          chmodSync(plan.binaryPath, 0o755)
        } catch {
          /* best-effort; a non-executable bit surfaces on the next start */
        }
      }
      // Record the extracted binary's own SHA-256 so it can be re-hashed before spawn
      // (vuln-scan B). Best-effort: a hashing failure must not fail an otherwise-good
      // install — the marker is simply written without the hash (→ verifier skip-legacy).
      let binaries: Record<string, string> | undefined
      try {
        binaries = { [markerBinaryKey(plan.extractTo, plan.binaryPath)]: await sha256File(plan.binaryPath) }
      } catch (err) {
        this.deps.log?.('Could not hash the installed binary for the marker', { error: String(err) })
      }
      writeRuntimeMarker(plan.extractTo, {
        version: plan.version,
        backend: plan.backend,
        os: plan.os,
        arch: plan.arch,
        ...(binaries ? { binaries } : {})
      })
      this.deps.log?.('Engine installed', { binaryPath: plan.binaryPath })
      return 'done'
    } catch (err) {
      if (job.status === 'cancelled') {
        await rm(plan.zipDest, { force: true })
        return 'aborted'
      }
      job.status = 'failed'
      job.error = friendlyEngineError(err)
      this.deps.log?.('Engine download failed', { error: String(err) })
      await rm(plan.zipDest, { force: true }).catch(() => undefined)
      return 'failed'
    }
  }

  /**
   * Clean a stale prior install, extract the archive, then flatten so the binary lands at
   * the extract-dir root (the macOS/Linux tarballs + the whisper Windows zip nest under a
   * release/Release folder). Mirrors the fetch-runtime scripts' extract + flatten steps.
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

    // Flatten: when the binary is nested, move its directory's contents up to the extract
    // root, where services/runtime/sidecar.ts resolves it. The `cpu/` subdir is excluded
    // from the search so a re-fetch of the DEFAULT build never mistakes the safety net for
    // the freshly extracted nested binary.
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

/** Absolute path of the host's on-drive `llama-server` binary (chat engine; tests/diag). */
export function hostLlamaBinaryPath(
  rootPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const name = platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return join(rootPath, 'runtime', 'llama.cpp', llamaOsDir(platform), name)
}
