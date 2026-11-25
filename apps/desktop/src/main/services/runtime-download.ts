import {
  chmodSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, rm, stat, statfs } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { mainUiLanguage, tMain } from './i18n'
import { fmt1, unitJoin } from '../../shared/format'
import type {
  EngineDownloadJob,
  EngineDownloadKind,
  EngineDownloadPreview,
  EngineDownloadPreviewItem,
  EngineStatus
} from '../../shared/types'
import {
  validateRuntimeSources,
  type RuntimeFamily,
  type RuntimeOs,
  type RuntimeBuild,
  type RuntimeSources,
  type RuntimeSourcesResult
} from '../../shared/runtime-sources'
import {
  downloadToFile,
  engineFolderComplete,
  engineSwapDirs,
  failureReason,
  flushToDeviceAsync,
  markerBinaryKey,
  planInFolder,
  planRuntimeDownload,
  readRuntimeMarker,
  readRuntimeMarkerState,
  recordedFilePath,
  requiredInstallFiles,
  runtimeBinaryPresent,
  runtimeInstallCurrent,
  runtimeInstallRelation,
  runtimeMarkerPath,
  selectRuntimeBuild,
  sidecarFamilySpec,
  verifyDownloadedFile,
  writeRuntimeMarker,
  ENGINE_DOWNLOAD_MAX_BYTES,
  NESTED_NET_FOLDERS,
  RUNTIME_MARKER_FILE,
  SIDECAR_FAMILY_SPECS,
  type EngineSwapDirs,
  type FetchFn,
  type SidecarFamilySpec,
  type RuntimeDownloadPlan
} from './assets'
import { archiveMemberSizes, archiveMembers, extractedArchiveBytes, isMacMetadataName } from './archive-size'
import { freeBytes } from './disk-space'
import { removeRetry, renameMayClear, renameWithRetry } from './fs-retry'
import { sha256File } from './models'
import { invalidateBinaryVerification } from './binary-verifier'
import { assertDownloadAllowed, NetworkSwitch, type DownloadGates } from './downloads'
import { holdEngineSpawns } from './runtime/spawn-gate'
import type { EngineProblemBuilds } from './runtime/engine-load'

// In-app engine (prebuilt sidecar binary) downloader. The model downloader fetches model
// WEIGHTS; the ENGINE binaries (the llama.cpp chat server, the whisper.cpp transcriber)
// are separate assets normally provisioned at drive-build time by `fetch-runtime`. Without
// them a started chat model falls back to the demo runtime (services/runtime/factory.ts —
// "no llama-server binary on the drive") and voice dictation never appears (no transcriber).
// This service fetches + SHA-256-verifies + extracts the host's prebuilt build for EACH
// engine family from model-manifests/runtime-sources.yaml into runtime/<family>/<os>/,
// mirroring the canonical fetch-runtime scripts (download → verify → extract → flatten →
// install marker). Since #986 the in-app install never deletes first: it builds and marks the
// new copy in `<os>.new/`, then swaps it in by rename, and the next start finishes or rolls
// back a swap a kill interrupted (`recoverEngineSwaps`; architecture.md "In-app engine
// updates" §6). Since #1000 every copy of a job is staged while the models keep running, and
// only the swaps happen under the update's pause (§7). The network (`fetchImpl`) and extraction (`extractImpl`,
// default `tar -xf`) are injected seams so the unit suite stays zero-network; only the #856
// rows in engine-download.test.ts run the OS's own tar.
//
// FAMILIES: llama_cpp (chat) + whisper_cpp (transcription) + kiwix_tools (the knowledge-pack
// tools, OPTIONAL — #339 P8-1). To add a future engine, list its spec in
// `SIDECAR_FAMILY_SPECS` (`services/assets.ts` — the ONE registry the installer and the
// commercial-drive gate share) and add the matching `<family>:` block to runtime-sources.yaml;
// a family that ships more than one file declares `executables` / `runtime_files` there.
// Status and install then cover it; the renderer surfaces do NOT — the Models-screen banners
// and the knowledge-pack tools row are hard-coded per family, so a new family needs its own
// copy and affordance. (See docs/packaging.md.) The OCR language files are not a family: they
// have their own installer (`services/ocr-install.ts`, #410).
//
// An OPTIONAL family is never part of the default install selection and never counted in
// readiness — `downloadEngine` takes no arguments, so "install everything missing" must not
// be able to reach a copyleft, separately-consented family. Only an explicit
// `families: ['kiwix_tools']` installs it; the consent surface that sends it is P8-2.
//
// Gates are identical to the model downloader (policy ceiling ∧ the allowNetwork setting),
// re-checked here in the main process. One engine download (covering all missing families)
// runs at a time.

/** The engine families this installer knows how to fetch (= the yaml's build families). */
export type EngineFamily = RuntimeFamily

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

/** The `{ version, builds }` block for one family — the keyed map, so this never enumerates. */
function familyBlock(result: RuntimeSourcesResult, family: EngineFamily): RuntimeSources | undefined {
  return result.families?.[family]
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
  /** From the CODE spec (`SIDECAR_FAMILY_SPECS`), never from the drive's yaml (#339 P8-1). */
  optional: boolean
  /** The code-side licence string an optional family's consent dialog shows (#339 P8-2). */
  license: string | null
  /**
   * #516: the family's pure-CPU safety net for this host — the yaml's `cpu` build when the default
   * build is another backend and lands in its own folder (`<os>/cpu/`, win + linux). Only an update
   * (when the drive carries it and it is older) and a reinstall (#678, when the OS refused it as
   * damaged) install it; the plain install never does.
   */
  cpuNet?: RuntimeDownloadPlan
  /** #843: the pin's `size_bytes` for the main build and the `cpu/` net (labels, never checked). */
  sizeBytes: number | null
  cpuNetSizeBytes: number | null
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
  for (const spec of SIDECAR_FAMILY_SPECS) {
    const sources = familyBlock(result, spec.family)
    if (!sources) continue
    const build = selectHostBuild(sources, platform, arch)
    if (!build) continue
    const files = {
      alsoRequired: spec.alsoRequired,
      declaredExecutables: sources.executables,
      neverInstalled: spec.neverInstalled
    }
    const plan = planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase, files)
    const cpuBuild =
      build.backend === 'cpu'
        ? null
        : selectRuntimeBuild(sources, { os: hostRuntimeOs(platform), arch: hostRuntimeArch(arch), backend: 'cpu' })
    const cpuNet =
      cpuBuild && cpuBuild.extractTo !== build.extractTo
        ? planRuntimeDownload(rootPath, cpuBuild, sources.version, spec.binaryBase, files)
        : undefined
    out.push({
      family: spec.family,
      version: sources.version,
      build,
      plan,
      optional: spec.optional === true,
      license: spec.license ?? null,
      ...(cpuNet ? { cpuNet } : {}),
      sizeBytes: build.sizeBytes ?? null,
      cpuNetSizeBytes: cpuNet ? (cpuBuild?.sizeBytes ?? null) : null
    })
  }
  return out
}

/**
 * Does `family` have a build for this host in runtime-sources.yaml (#527)? False when the yaml
 * is absent or malformed, or the family has no block or no build for this os/arch — i.e. the
 * in-app installer could never fetch it here. Reads the yaml only; the binary's presence is the
 * caller's own check.
 */
export function engineFamilyHasHostBuild(
  manifestsDir: string | null,
  family: EngineFamily,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  const result = manifestsDir ? loadSourcesResult(manifestsDir) : null
  const sources = result ? familyBlock(result, family) : undefined
  return sources != null && selectHostBuild(sources, platform, arch) != null
}

/**
 * Validate the renderer's `downloadEngine` payload (#339 P8-2). Renderer input is untrusted:
 * anything but "absent" or `{ families: [<known family>, …], reinstall?: boolean, update?: boolean }`
 * is rejected with friendly copy, and the parsed list is rebuilt from the code's own family names
 * (never the caller's strings echoed back). Absent / `{}` = the default install (`families`
 * undefined). `reinstall: true` (#532) and `update: true` (#516) each need an explicit list of
 * REQUIRED families and exclude each other: neither is ever the default selection or reaches a
 * separately consented optional family. Whether each named family really holds a "files damaged"
 * verdict is the IPC layer's check (`registerEngineIpc.ts`); which families are older, the manager's.
 */
export function parseEngineDownloadRequest(raw: unknown): {
  families?: EngineFamily[]
  reinstall?: true
  update?: true
} {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(tMain('main.engine.badRequest'))
  const reinstall = (raw as { reinstall?: unknown }).reinstall
  if (reinstall !== undefined && typeof reinstall !== 'boolean') throw new Error(tMain('main.engine.badRequest'))
  // #516: `update` follows the same rules as `reinstall`, and never rides with it.
  const update = (raw as { update?: unknown }).update
  if (update !== undefined && typeof update !== 'boolean') throw new Error(tMain('main.engine.badRequest'))
  if (reinstall === true && update === true) throw new Error(tMain('main.engine.badRequest'))
  const families = (raw as { families?: unknown }).families
  if (families === undefined) {
    if (reinstall === true || update === true) throw new Error(tMain('main.engine.badRequest'))
    return {}
  }
  if (!Array.isArray(families) || families.length === 0) {
    throw new Error(tMain('main.engine.badRequest'))
  }
  const out: EngineFamily[] = []
  for (const f of families) {
    const spec = SIDECAR_FAMILY_SPECS.find((s) => s.family === f)
    if (!spec || out.includes(spec.family)) throw new Error(tMain('main.engine.badRequest'))
    out.push(spec.family)
  }
  // A request never mixes an optional (separately consented) family with a required one: the
  // consent dialog sends the optional family alone, the engine button sends nothing. A mixed
  // payload is not an escalation (without `reinstall` a current family is never re-installed,
  // and `reinstall` refuses an optional family outright) but it would blur which request
  // carried the acknowledgement, so it is refused outright.
  const optional = out.filter((f) => SIDECAR_FAMILY_SPECS.find((s) => s.family === f)?.optional === true)
  if (optional.length > 0 && optional.length !== out.length) throw new Error(tMain('main.engine.badRequest'))
  if (reinstall === true || update === true) {
    if (optional.length > 0) throw new Error(tMain('main.engine.badRequest'))
    return reinstall === true ? { families: out, reinstall: true } : { families: out, update: true }
  }
  return { families: out }
}

/**
 * Read-only status for the renderer's "install the engine" surface. `installed` is true
 * only when EVERY fetchable REQUIRED engine's binary is present; `missingFamilies` lists the
 * required ones still missing. An OPTIONAL family (#339 P8-1, kiwix_tools) is never a
 * readiness prerequisite: it is reported in `missingOptionalFamilies` and nowhere else, so no
 * consumer of `missingFamilies` can ever offer to fetch it without its own consent step.
 * `version`/`backend` report the chat engine (llama_cpp) for the banner copy.
 */
export function engineStatus(
  rootPath: string,
  manifestsDir: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): EngineStatus {
  const engines = availableEngines(rootPath, manifestsDir, platform, arch)
  const required = engines.filter((e) => !e.optional)
  const missingRequired = required.filter((e) => !existsSync(e.plan.binaryPath))
  const missingOptional = engines.filter((e) => e.optional && !existsSync(e.plan.binaryPath))
  const llama = required.find((e) => e.family === 'llama_cpp') ?? required[0]
  return {
    installed: required.length > 0 && missingRequired.length === 0,
    available: required.length > 0,
    version: llama?.version ?? null,
    backend: llama?.build.backend ?? null,
    missingFamilies: missingRequired.map((e) => e.family),
    // #532: what an "Install … again" action could fetch — on the drive, and with a build here.
    reinstallableFamilies: required.filter((e) => existsSync(e.plan.binaryPath)).map((e) => e.family),
    // #516: every family on the drive against this app's pin (the update notice + Diagnostics).
    engineVersions: engines
      .filter((e) => existsSync(e.plan.binaryPath))
      .map((e) => {
        const marker = readRuntimeMarker(e.plan.extractTo)
        const net = e.cpuNet && existsSync(e.cpuNet.binaryPath) ? e.cpuNet : null
        const netMarker = net ? readRuntimeMarker(net.extractTo) : null
        return {
          family: e.family,
          optional: e.optional,
          installed: marker?.version ?? null,
          installedBackend: marker?.backend ?? null,
          pinned: e.version,
          pinnedBackend: e.build.backend,
          relation: runtimeInstallRelation(e.plan, marker),
          ...(net
            ? { cpuNet: { installed: netMarker?.version ?? null, pinned: e.version, relation: runtimeInstallRelation(net, netMarker) } }
            : {})
        }
      }),
    missingOptionalFamilies: missingOptional.map((e) => e.family),
    // #339 P8-2: what the consent dialog states, from the pin + the code-side spec — never copy.
    optionalFamilies: engines
      .filter((e) => e.optional)
      .map((e) => ({
        family: e.family,
        version: e.version,
        sizeBytes: e.build.sizeBytes ?? null,
        url: e.build.url,
        license: e.license ?? '',
        // EVERY declared file, not just the primary binary: the packs panel's own
        // `toolsInstalled` needs serve AND manage, and the consent surface must never say
        // "installed" while the panel says "missing" (review finding, 2026-09-06).
        installed: runtimeBinaryPresent(e.plan)
      }))
  }
}

/**
 * Extract a release archive into `destDir`, the folder it sits in (`extractWithTar` refuses any
 * other, #856). Injected so the install-flow tests never shell out. The optional
 * `signal` (F-33) lets a job cancel reach the child: without it `extractWithTar` was the only
 * unbounded child in the repo — a wedged tar pinned the job in 'extracting' with no way to stop
 * it, and a cancel merely flipped the status while tar kept writing. A stopped extraction settles
 * only once its child has exited (#999), or after a bound, which `log` reports.
 */
export type ExtractFn = (
  archivePath: string,
  destDir: string,
  signal?: AbortSignal,
  log?: (msg: string, meta?: unknown) => void
) => Promise<void>

/**
 * Hard ceiling on ONE archive extraction (F-33). tar is short-lived + local, but a child wedged
 * by a removed/failing USB drive or AV interference otherwise pins the engine job in 'extracting'
 * forever (recovery = app restart). Every other child in the repo is bounded (whisper 15-min
 * watchdog, GPU probe 10 s, llama-server 180 s health); this brings the extractor in line.
 * Env-overridable (`HILBERTRAUM_EXTRACT_DEADLINE_MS`) for tuning/tests.
 */
export const DEFAULT_EXTRACT_DEADLINE_MS = 5 * 60 * 1000
/** Grace after SIGTERM before escalating to SIGKILL on a wedged/cancelled tar (F-33; the whisper
 *  REL-2 killWithEscalation grace — native decode/IO code can ignore the polite signal). */
const EXTRACT_KILL_GRACE_MS = 2_000
/**
 * #999: how long a stopped extraction waits for its tar to exit after the SIGKILL, before it settles
 * anyway. Measured on Windows: TerminateProcess ends tar 2–5 ms after the kill. A tar wedged in kernel
 * I/O on a failing stick can outlive even SIGKILL, and must not pin the job (F-33's reason).
 */
const EXTRACT_GONE_BOUND_MS = 10_000

function extractDeadlineMs(): number {
  const raw = Number(process.env.HILBERTRAUM_EXTRACT_DEADLINE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXTRACT_DEADLINE_MS
}

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
  // Build the Windows candidate with win32 path semantics regardless of the HOST os, so the
  // absolute `…\System32\tar.exe` is always backslash-separated (the host `join` would emit
  // `C:\Windows/System32/tar.exe` when this runs on a posix host — e.g. the Linux CI leg, or a
  // drive-build script invoked cross-platform). The posix candidates are already absolute
  // literals, valid as-is on any host.
  const candidates =
    platform === 'win32'
      ? [win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe')]
      : ['/usr/bin/tar', '/bin/tar']
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate
  }
  return 'tar'
}

/**
 * The `tar` arguments for extracting `archivePath` into `destDir`, run with `cwd` = `destDir`
 * (#856). Windows' tar (bsdtar) converts the paths on its command line through the ANSI code
 * page, so under a Cyrillic or Japanese folder on a Western Windows an absolute archive path
 * failed with "Error opening archive" and a `-C` with "could not chdir"; the child's cwd reaches
 * tar intact. So there is no `-C` (the cwd is the target) and the archive goes as `./<name>`. The
 * `./` also keeps a name starting with `-` from meaning stdin, and one holding a `:` from meaning
 * GNU tar's `host:file`. The installer always downloads the archive into the target
 * (`planRuntimeDownload`); one kept anywhere else would need its path on the command line again,
 * so it is refused rather than left to fail on those machines only.
 */
function tarExtractArgs(archivePath: string, destDir: string): string[] {
  if (resolve(dirname(archivePath)) !== resolve(destDir)) {
    throw new Error('extractWithTar: the archive must sit in the folder it is extracted into')
  }
  return ['-xf', `./${basename(archivePath)}`]
}

/** What starts the extractor's child: `child_process.spawn`'s shape (a seam for the #999 rows). */
export type ExtractSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * #1045: tar ran to its end and failed (a non-zero exit code), as opposed to a child that was stopped (a cancel, the
 * deadline, a signal) or never started. Only this failure may be mended (`mendTarFailure`): a stopped tar may have cut
 * the member it was writing short.
 */
class TarExitError extends Error {
  constructor(readonly exitCode: number) {
    super(`tar exited with code ${exitCode}`)
  }
}

export interface TarExtractorOptions {
  /** Default `child_process.spawn`. */
  spawn?: ExtractSpawn
  /** After the polite kill, how long before SIGKILL (default 2 s). */
  graceMs?: number
  /** After the SIGKILL, how long the extraction waits for the child to exit before it settles anyway (default 10 s). */
  goneBoundMs?: number
}

/**
 * The default extractor's factory (#999): the OS's pinned `tar` (see `resolveTarBinary`),
 * `-xf ./<archive>` from inside `destDir` (`tarExtractArgs`). One command covers every host because
 * each platform's archive is one its `tar` understands — Windows 10+ ships bsdtar (handles the .zip
 * release assets), macOS bsdtar + GNU tar both auto-detect the .tar.gz gzip. The DIY scripts use the
 * same native tools (unzip/ditto/tar); this is the in-app equivalent.
 *
 * A cancel or the deadline kills the child: SIGTERM, then SIGKILL after `graceMs` (whisper REL-2; on
 * Windows both are TerminateProcess). The extraction rejects only once the child has exited, so the
 * job (`activeJob()`, the F-33 latch) stays busy while tar may still write, and the job's cleanup of
 * the staging folder never races it. A child that has not exited `goneBoundMs` after the SIGKILL (a
 * tar wedged in kernel I/O on a failing stick) is given up on with a log line, so it cannot pin the
 * job either.
 */
export function makeTarExtractor(options: TarExtractorOptions = {}): ExtractFn {
  const spawnChild = options.spawn ?? spawn
  const graceMs = options.graceMs ?? EXTRACT_KILL_GRACE_MS
  const goneBoundMs = options.goneBoundMs ?? EXTRACT_GONE_BOUND_MS
  return (archivePath, destDir, signal, log) =>
    new Promise<void>((resolvePromise, reject) => {
      const child = spawnChild(resolveTarBinary(), tarExtractArgs(archivePath, destDir), {
        stdio: 'ignore',
        // The target: the archive's `./` name resolves against it and the files land in it, and
        // the child never inherits a possibly attacker-influenced cwd.
        cwd: destDir,
        windowsHide: true
      })
      let settled = false
      /** Set once a cancel or the deadline asked the child to stop: the extraction then rejects with it. */
      let stopError: Error | null = null
      const timers: Array<ReturnType<typeof setTimeout>> = []
      const later = (ms: number, fn: () => void): void => {
        const timer = setTimeout(fn, ms)
        // Never let a timer keep Electron alive by itself (mirrors the whisper grace unref).
        timer.unref?.()
        timers.push(timer)
      }
      const onAbort = (): void => stopChild(new Error('tar extraction cancelled'))
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const stopChild = (err: Error): void => {
        if (settled || stopError) return
        stopError = err
        signal?.removeEventListener('abort', onAbort)
        later(graceMs, () => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          later(goneBoundMs, () => {
            log?.('tar did not exit after it was killed: the extraction is given up on', { graceMs, goneBoundMs })
            settle(() => reject(err))
          })
        })
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      const onGone = (): void => {
        if (stopError) {
          const err = stopError
          settle(() => reject(err))
        }
      }

      later(extractDeadlineMs(), () => stopChild(new Error(`tar extraction exceeded ${extractDeadlineMs()} ms; aborted`)))
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })

      child.on('exit', onGone)
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (!stopError) return settle(() => reject(err))
        // A kill that could not be delivered says nothing about whether tar is gone: the SIGKILL and the
        // bound settle it. A spawn that failed means there never was a child.
        if (typeof err.syscall === 'string' && err.syscall.startsWith('spawn')) onGone()
      })
      child.on('close', (code: number | null) => {
        if (stopError) return onGone()
        settle(() => {
          if (code === 0) resolvePromise()
          else reject(code === null ? new Error('tar exited with code null') : new TarExitError(code))
        })
      })
    })
}

/** The default extractor (`makeTarExtractor` with the real `spawn`). */
export const extractWithTar: ExtractFn = makeTarExtractor()

export interface EngineDownloadDeps {
  fetchImpl?: FetchFn
  /** Injected verifier (default `verifyDownloadedFile`) — tests gate it to pin the
   *  cancel-during-verify contract deterministically (full-audit 2026-07-11 CODE-13,
   *  mirroring the model downloader's BE-4 seam in downloads.ts). */
  verifyImpl?: typeof verifyDownloadedFile
  extractImpl?: ExtractFn
  log?: (msg: string, meta?: unknown) => void
}

export interface StartEngineDownloadOptions {
  rootPath: string
  /** The folder whose `runtime-sources.yaml` pins the engines: the app's own copy (#842). */
  manifestsDir: string | null
  gates: DownloadGates
  /** Restrict the install to these families (default: every missing, fetchable family). */
  families?: EngineFamily[]
  /**
   * #532: install `families` even when they are present and their marker is current — the repair
   * for engine files the OS loader found missing or damaged. Requires `families`; the IPC layer
   * admits it only for families holding a "files damaged" verdict. The flow is the ordinary one:
   * the drive's copy is replaced only after the new archive downloaded and matched its SHA-256.
   */
  reinstall?: boolean
  /**
   * #678: with `reinstall`, which of each family's builds to replace — the ones the OS refused
   * (`engineProblemBuilds`). A family not listed gets its main build only (#532). A `cpu/` net is
   * replaced when this host's pin has one, even if its program has gone since it was refused (a
   * failed earlier attempt); a refused `cpu/` net with no build here is skipped, and a job left with
   * nothing to install is `main.engine.noHostBuild`.
   */
  reinstallBuilds?: Partial<Record<EngineFamily, EngineProblemBuilds>>
  /**
   * #516: update `families` to this app's pin. Only an install whose relation is `older` is
   * replaced (never a newer or unrecorded one), plus the family's `cpu/` safety net when the drive
   * carries it and it is older too. Requires `families`; no family qualifying is
   * `main.engine.nothingToUpdate`.
   */
  update?: boolean
  /**
   * #516: awaited once, after EVERY archive of the job downloaded, verified and (#1000) was unpacked,
   * checked and marked in its staging folder, with the spawn gate held, and before the first installed
   * file is touched — the IPC layer pauses the engine's users here, so a model keeps answering through
   * the download and the unpack and stops only for the swap's renames. A throw fails the job with its
   * message (the staged copies are deleted, nothing was replaced). A job whose download or unpack fails
   * or is cancelled never calls it. With it, the in-use flags below are not checked at start: the hook
   * owns that check, after the pause.
   */
  beforeReplace?: () => Promise<void>
  /**
   * True when a chat model runtime is currently RUNNING off the llama_cpp install dir
   * (full-audit 2026-07-11 CODE-13). An engine (re-)install replaces that dir (since #986 by
   * a staged swap: the running binary would keep its old copy in `<os>.old/` open, so that
   * copy could not be deleted, and the next swap would fail on it) — so a job that would
   * touch llama_cpp is refused with
   * friendly copy while a model runs. Installs that only touch other families (e.g. a
   * missing whisper_cpp) are unaffected. The IPC layer passes `chatEngineInUse(ctx.runtime)`:
   * a model running or starting on the real engine, never the built-in demo runtime (#532).
   * #678: a job that replaces only the `cpu/` net is refused too — the chat ladder's rung 3 runs
   * from there, and the status cannot tell that rung from the main build's.
   */
  chatRuntimeActive?: boolean
  /**
   * F-32: true while ANY OTHER llama-server-backed sidecar — the E5 embedder, reranker, vision
   * or translation — has a live child. They all execute the SAME `runtime/llama.cpp/<os>/`
   * binary a llama_cpp (re-)install replaces, so the guard must refuse the install while any
   * of them runs, not just the chat runtime. The IPC layer passes
   * `registeredSidecarPids('llama_cpp').length > 0`. #678: none of them runs the `cpu/` net, so a
   * job that replaces only that is not refused for them.
   */
  llamaSidecarActive?: boolean
  /**
   * F-32: true while a whisper transcription/dictation child is executing from
   * `runtime/whisper.cpp/<os>/` (a legitimate audio import can run for hours). A whisper_cpp
   * install replaces that dir, so it is refused while one runs. The IPC layer passes
   * `registeredSidecarPids('whisper_cpp').length > 0`.
   */
  whisperActive?: boolean
  /**
   * #339 P8-1: true while a `kiwix-serve` / `kiwix-manage` child is executing from
   * `runtime/kiwix-tools/<os>/`. A kiwix_tools (re-)install replaces that dir — on Windows
   * the old copy could not be deleted under the live file lock (the F-32 precedent) — so it is refused while
   * one runs. The IPC layer passes `registeredSidecarPids('kiwix_tools').length > 0` (P8-2).
   */
  kiwixToolsActive?: boolean
  platform?: NodeJS.Platform
  arch?: string
}

const MAX_TERMINAL_JOBS = 10

/**
 * A completed-install subscriber (#323): the families installed, and each one's programs the job
 * put on the drive (#532) — the main build's primary program, then the `cpu/` net's when the job
 * replaced it too (#678).
 */
export type InstalledListener = (
  families: EngineFamily[],
  programs: Partial<Record<EngineFamily, string[]>>
) => void

/** One archive a job installs: a family's main build, or (#516 updates, #678 reinstalls) its `cpu/` net. */
export interface InstallStep {
  family: EngineFamily
  plan: RuntimeDownloadPlan
  /** The family's main build — the program every spawn site resolves; false for the `cpu/` net. */
  main: boolean
  /** #843: the pin's `size_bytes` for this archive, or null. The dialog's label; never checked. */
  sizeBytes: number | null
  /**
   * #986 review 2: for a main build, its family's `cpu/` net build on this host, whatever the job does with
   * it: the net's folder sits inside the main one, so the job recovers and guards it, and carries it over.
   */
  cpuNet?: RuntimeDownloadPlan
}

/** What selects a job's archives: `start()`'s request without the gates and the in-use flags. */
export type EngineStepRequest = Pick<
  StartEngineDownloadOptions,
  'rootPath' | 'manifestsDir' | 'families' | 'reinstall' | 'reinstallBuilds' | 'update' | 'platform' | 'arch'
>

/** The archives one engine job installs, in install order, and the kind of job (#843). */
export interface EngineJobSteps {
  kind: EngineDownloadKind
  steps: InstallStep[]
}

/**
 * THE step selection of an engine job (#843): which archives a request installs, or the friendly
 * refusal. `EngineDownloadManager.start()` runs it after its gates and its one-job check, and the
 * confirmation dialog's preview (`engine:plan`, {@link previewEngineDownload}) runs the same
 * function, so the dialog states what the job plans to fetch when it opens — the `cpu/` net an update
 * adds, the builds a reinstall replaces — and never offers a selection `start()` would refuse at that
 * moment (#516's rule for the update notice). It covers the selection only: the gates, the one-job
 * check, an engine in use (`main.engine.runtimeRunning`, `…transcriptionRunning`,
 * `…knowledgePackToolsRunning`) and an update's busy check (`main.engine.updateBusy`) stay `start()`'s
 * and the update handler's, so those refusals can arrive after Confirm, as the same friendly errors
 * (research C §1.8). Confirm sends the request unchanged and `start()` plans again. P8's in-app updater
 * extends this function, not a copy of it. Reads the yaml and the install markers only; fetches
 * nothing.
 */
export function planEngineSteps(opts: EngineStepRequest): EngineJobSteps {
  if (!opts.manifestsDir || !loadSourcesResult(opts.manifestsDir)) {
    throw new Error(tMain('main.engine.noSources'))
  }
  const engines = availableEngines(opts.rootPath, opts.manifestsDir, opts.platform, opts.arch)
  if (engines.length === 0) {
    throw new Error(tMain('main.engine.noHostBuild'))
  }
  // The DEFAULT selection is every MISSING required family — an OPTIONAL family (kiwix_tools,
  // #339 P8-1) is never in it: `downloadEngine` takes no arguments, so "install everything
  // missing" must not be able to reach a copyleft, separately-consented family. Only an
  // explicit `families: ['kiwix_tools']` installs it (the consent step is P8-2), and
  // `e.optional` comes from the CODE spec, never from the drive's user-writable yaml.
  // #516: "missing" means missing. It used to mean "not current by its marker", so on a drive
  // set up before a pin bump the "Install voice engine" button also re-installed the chat
  // engine — refused outright while a model ran, and a silent DOWNGRADE of a newer engine. An
  // engine that is on the drive changes only through an explicit update or reinstall.
  // An explicit `families` list (the consent step) installs the named families not yet current, never one
  // newer than the pin (T8.5c).
  // #532: a reinstall keeps the requested families even when current — and only those, so it
  // needs the explicit list; a family it names that has no build here cannot be repaired here.
  // #678: it replaces the builds the OS refused — the main build, the `cpu/` net, or both.
  const wanted = opts.families
  const reinstall = opts.reinstall === true
  const update = opts.update === true
  if ((reinstall || update) && (!wanted || wanted.length === 0)) {
    throw new Error(tMain('main.engine.badRequest'))
  }
  const main = (e: EnginePlan): InstallStep => ({
    family: e.family,
    plan: e.plan,
    main: true,
    sizeBytes: e.sizeBytes,
    ...(e.cpuNet ? { cpuNet: e.cpuNet } : {})
  })
  const net = (e: EnginePlan, plan: RuntimeDownloadPlan): InstallStep => ({
    family: e.family,
    plan,
    main: false,
    sizeBytes: e.cpuNetSizeBytes
  })
  let steps: InstallStep[]
  if (update) {
    steps = []
    for (const e of engines) {
      if (e.optional || !wanted?.includes(e.family)) continue
      // The same presence test `engineStatus().engineVersions` uses, so a notice can never
      // offer an update this refuses (a fresh copy also restores a missing secondary file).
      if (existsSync(e.plan.binaryPath) && runtimeInstallRelation(e.plan) === 'older') {
        steps.push(main(e))
      }
      if (e.cpuNet && existsSync(e.cpuNet.binaryPath) && runtimeInstallRelation(e.cpuNet) === 'older') {
        steps.push(net(e, e.cpuNet))
      }
    }
    if (steps.length === 0) throw new Error(tMain('main.engine.nothingToUpdate'))
  } else if (reinstall) {
    const named = engines.filter((e) => wanted?.includes(e.family))
    if (named.length < (wanted?.length ?? 0)) throw new Error(tMain('main.engine.noHostBuild'))
    steps = []
    for (const e of named) {
      const builds = opts.reinstallBuilds?.[e.family] ?? { main: true, cpuNet: false }
      if (builds.main) steps.push(main(e))
      if (builds.cpuNet && e.cpuNet) steps.push(net(e, e.cpuNet))
    }
    // Only a refused `cpu/` net that this host's pin has no build for is left (a main folder
    // provisioned as the processor build over an older Kit's `cpu/`): nothing here can replace it.
    if (steps.length === 0) throw new Error(tMain('main.engine.noHostBuild'))
  } else {
    const named = engines.filter((e) =>
      wanted ? wanted.includes(e.family) && !runtimeInstallCurrent(e.plan) : !e.optional && !runtimeBinaryPresent(e.plan)
    )
    // T8.5c (F-24: `newer` is never replaced): only a reinstall replaces an engine newer than this app's pin. A named
    // family's newer copy used to be replaced as "not current", and the default selection's when it lacked a file this
    // pin lists (a later release's layout). The update's presence test, so the two agree; a request left with nothing
    // to install that way gets the update's answer.
    const selected = named.filter((e) => !(existsSync(e.plan.binaryPath) && runtimeInstallRelation(e.plan) === 'newer'))
    if (selected.length === 0) {
      throw new Error(tMain(named.length > 0 ? 'main.engine.nothingToUpdate' : 'main.engine.alreadyInstalled'))
    }
    steps = selected.map(main)
  }
  return { kind: update ? 'update' : reinstall ? 'reinstall' : 'install', steps }
}

/** A tag the licence link may carry: a plain release name, never a path or a query (the yaml is data). */
const LICENSE_TAG_RULE = /^[A-Za-z0-9._-]{1,64}$/

/** The upstream `LICENSE` at the pinned tag (#843), or null when the family names no repository. */
function licenseUrlFor(spec: SidecarFamilySpec | undefined, version: string): string | null {
  if (!spec?.licenseRepo || !LICENSE_TAG_RULE.test(version)) return null
  return `${spec.licenseRepo}/blob/${version}/LICENSE`
}

/**
 * What a job's steps fetch, as the confirmation dialog states it (#843): per archive its version
 * (and the one installed there now), backend, full URL, size, and the code-side licence — never
 * copy and never the drive's yaml for the licence. `totalBytes` is null when any size is unknown.
 */
export function engineDownloadPreview(job: EngineJobSteps): EngineDownloadPreview {
  const items: EngineDownloadPreviewItem[] = job.steps.map((s) => {
    const spec = sidecarFamilySpec(s.family)
    return {
      family: s.family,
      version: s.plan.version,
      installed: readRuntimeMarker(s.plan.extractTo)?.version ?? null,
      backend: s.plan.backend,
      os: s.plan.os,
      arch: s.plan.arch,
      safetyNet: !s.main,
      url: s.plan.url,
      sizeBytes: s.sizeBytes,
      license: spec?.license ?? '',
      bundledLicense: spec?.bundledLicenses?.[s.plan.os] ?? null,
      licenseUrl: licenseUrlFor(spec, s.plan.version)
    }
  })
  const known = items.every((i) => i.sizeBytes != null)
  return {
    kind: job.kind,
    items,
    totalBytes: known ? items.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0) : null
  }
}

/**
 * The `engine:plan` answer (#843): what `start()` with the same request would fetch, or the same
 * friendly refusal it would throw. The gates and the one-job check are not part of it: the dialog
 * shows a closed gate itself (its confirm button is disabled), and `start()` checks both again.
 */
export function previewEngineDownload(opts: EngineStepRequest): EngineDownloadPreview {
  return engineDownloadPreview(planEngineSteps(opts))
}

/**
 * Why a job did not finish (#843), for its audit record: a content-free code, never the job's
 * `error` text. `cancelled` and `networkOff` (#782) are the stops; the rest name where it failed.
 * #986: `noSpace` — the drive had no room to unpack the archives, so nothing was touched;
 * `filesInUse` — the swap's rename was refused (a file held in the folder) and the installed copy
 * was put back.
 */
export type EngineJobEndReason =
  | 'cancelled'
  | 'networkOff'
  | 'checksumMismatch'
  | 'fileMissing'
  | 'placeholderHash'
  | 'download'
  | 'incomplete'
  | 'install'
  | 'notReplaced'
  | 'noSpace'
  | 'filesInUse'
  // A failure outside every step that records its own reason (an unexpected exception in the run).
  | 'internal'

/** #986: the room a job needed to unpack its archives on one volume, and what that volume had free. */
export interface EngineSpaceShortfall {
  neededBytes: number
  freeBytes: number
}

/** What a settled job's listeners learn beside its snapshot (#843). */
export interface EngineJobEnd {
  /** Null for a `done` job. */
  reason: EngineJobEndReason | null
  /** For `download`: the failure's content-free label (`failureReason`: `network`, `http-404`, …). */
  cause?: string
  /** #986: for `noSpace`, the byte counts its message names. */
  space?: EngineSpaceShortfall
  /** What the job set out to fetch (the same preview its dialog showed), or null if unknown. */
  preview: EngineDownloadPreview | null
}

/**
 * Owns the in-app engine-download job. One at a time; a single job installs every missing
 * engine family in sequence. The job lives in memory for the session (the durable truth is
 * the extracted binaries + their `.hilbertraum-runtime.json` markers). The renderer polls
 * `get(jobId)`.
 */
export class EngineDownloadManager {
  private jobs = new Map<string, EngineDownloadJob>()
  private active: { jobId: string; controller: AbortController } | null = null
  /** #782: the internet-access switch between this manager's gate checks. */
  private readonly network = new NetworkSwitch()
  /**
   * False while a `run()` promise is still in flight (F-33). `job.status` flips to 'cancelled'
   * the instant `cancel()` is called, but the `run()` — and the tar child it awaits — can still
   * be settling; `activeJob()` used to report null in that window, so a retry launched a SECOND
   * install into the same `extractTo` while the first tar kept writing (mixed build + a possible
   * valid marker). This latch keeps the manager busy until `run()` actually settles — #999: and the
   * extractor's promise, which `run()` awaits, settles only once its tar child has exited (or after a
   * bound past SIGKILL), so the latch means "tar is gone", not merely "asked to stop".
   */
  private runSettled = true
  /** Issue #323: told the families a finished job installed, AFTER `job.status = 'done'`. */
  private readonly installedListeners = new Set<InstalledListener>()
  /** #516: told every job's final snapshot once its run has settled — done, failed or cancelled. */
  private readonly settledListeners = new Set<(job: EngineDownloadJob, end: EngineJobEnd) => void>()
  /** #843: what each job set out to fetch (its dialog's preview) and why it stopped, for the audit. */
  private readonly previews = new Map<string, EngineDownloadPreview>()
  /**
   * #986 review 3: the job whose step has begun its swap's renames. A cancel then is too late for that step:
   * it stops what comes after, and the job's status does not flip to 'cancelled' and back.
   */
  private swapping: string | null = null
  /** #986 review 3: what a job's own recovery moved into an install folder, until the job tells its listeners. */
  private readonly recoveredSteps = new Map<string, InstallStep[]>()
  private readonly endReasons = new Map<
    string,
    { reason: EngineJobEndReason; cause?: string; space?: EngineSpaceShortfall }
  >

  constructor(private readonly deps: EngineDownloadDeps = {}) {}

  /**
   * Subscribe to settled jobs (#516): `cb` receives the job's final snapshot once its run has
   * finished, whatever the outcome — after any `onInstalled` call of a `'done'` job, and after the
   * manager is free for the next job — and (#843) why it ended and what it set out to fetch. A
   * listener fault is logged, never thrown. Returns the unsubscribe.
   */
  onSettled(cb: (job: EngineDownloadJob, end: EngineJobEnd) => void): () => void {
    this.settledListeners.add(cb)
    return () => {
      this.settledListeners.delete(cb)
    }
  }

  /**
   * Subscribe to completed installs (issue #323): `cb` receives the families a job installed,
   * once, after the job reached `'done'` — every binary is on the drive and every marker is
   * written by then. Never for a failed or cancelled job. A listener fault is logged and never
   * fails the finished job (the same rule as the model downloader's `onModelInstalled`, #40).
   * Returns the unsubscribe. The IPC layer wires this to the GPU-probe refresh: a benchmark
   * run before the chat engine existed persisted an empty probe, and installing the engine is
   * the moment that answer can change. `programs` (#532) names each installed family's primary
   * program, the path every spawn site resolves for it, and (#678) its `cpu/` net's when the job
   * replaced that too.
   */
  onInstalled(cb: InstalledListener): () => void {
    this.installedListeners.add(cb)
    return () => {
      this.installedListeners.delete(cb)
    }
  }

  /**
   * Validate the gates, resolve which engine families are missing, and start fetching them
   * in the background. Throws a friendly, cause-specific error when a gate is closed,
   * another download is running, there are no engine sources / host build, or everything is
   * already installed + current. A reinstall (#532, `reinstall: true`) installs the families it
   * names whether or not they are current — the builds `reinstallBuilds` names (#678).
   */
  async start(opts: StartEngineDownloadOptions): Promise<EngineDownloadJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    if (this.activeJob() !== null) {
      throw new Error(tMain('main.engine.alreadyRunning'))
    }
    // #843: the ONE step selection; the confirmation dialog's preview runs the same function.
    const planned = planEngineSteps(opts)
    const { steps } = planned
    const reinstall = opts.reinstall === true
    const update = opts.update === true
    const families = [...new Set(steps.map((s) => s.family))]
    // CODE-13 + F-32: refuse an install that would replace a dir a LIVE child executes from.
    // A llama_cpp install is refused while the chat runtime OR any other llama-server-backed
    // sidecar (embedder/reranker/vision/translation) is up; a whisper_cpp install while a
    // transcription/dictation runs. Installs touching only the OTHER family stay allowed.
    // #678: per build — the helpers run only the main build, so a job that replaces only the
    // `cpu/` net is refused for the chat runtime alone (rung 3 runs from there).
    // #516: an update that brings its own `beforeReplace` makes that check there, after its pause.
    if (!opts.beforeReplace) {
      const llamaMain = steps.some((s) => s.family === 'llama_cpp' && s.main)
      if (families.includes('llama_cpp') && (opts.chatRuntimeActive || (llamaMain && opts.llamaSidecarActive))) {
        throw new Error(tMain('main.engine.runtimeRunning'))
      }
      if (families.includes('whisper_cpp') && opts.whisperActive) {
        throw new Error(tMain('main.engine.transcriptionRunning'))
      }
      if (families.includes('kiwix_tools') && opts.kiwixToolsActive) {
        throw new Error(tMain('main.engine.knowledgePackToolsRunning'))
      }
    }

    const job: EngineDownloadJob = {
      jobId: randomUUID(),
      status: 'queued',
      receivedBytes: 0,
      totalBytes: null,
      unverified: false,
      binaryPath: null,
      error: null,
      families,
      reinstall,
      update
    }
    this.jobs.set(job.jobId, job)
    this.previews.set(job.jobId, engineDownloadPreview(planned))
    const controller = new AbortController()
    this.active = { jobId: job.jobId, controller }
    this.runSettled = false // F-33: busy until run() actually settles (not just until cancelled)
    this.deps.log?.('Engine download started', {
      jobId: job.jobId,
      families: steps.map((s) => `${s.family}:${s.plan.os}/${s.plan.arch}/${s.plan.backend}`),
      ...(reinstall ? { reinstall } : {}),
      ...(update ? { update } : {})
    })
    void this.run(job, steps, opts.rootPath, controller, opts.beforeReplace)
      // Every expected failure sets the status and its reason where it happens. An unexpected exception
      // (one no step catches) used to leave the job reading 'downloading' or 'extracting' for good — a
      // renderer polling it never saw an end — and an unhandled rejection. It ends the job instead.
      .catch((err: unknown) => this.failUnexpectedly(job, err))
      .finally(() => {
        this.runSettled = true
        if (this.active?.jobId === job.jobId) this.active = null
        // #986 review 3: a job that stopped before its phase 2 still moved what its recovery moved.
        const recovered = this.takeRecovered(job.jobId)
        if (recovered.length > 0) this.notifyInstalled(recovered)
        // #516: every outcome — the IPC layer resumes what an update paused, done or not.
        const settled = this.get(job.jobId)
        const end = this.jobEnd(settled)
        for (const listener of this.settledListeners) {
          try {
            listener(settled, end)
          } catch (err) {
            this.deps.log?.('Engine job settle listener failed', String(err))
          }
        }
      })
    return { ...job }
  }

  /** #843: what job `jobId` set out to fetch (the preview its dialog showed), or null when unknown. */
  jobPreview(jobId: string): EngineDownloadPreview | null {
    return this.previews.get(jobId) ?? null
  }

  /**
   * An exception no step of `run()` caught: the job fails (its message stays in the local log). It records
   * no reason, so `jobEnd` reports `internal`, never a guess at the step the job reached.
   */
  private failUnexpectedly(job: EngineDownloadJob, err: unknown): void {
    this.deps.log?.('Engine job failed unexpectedly', { jobId: job.jobId, error: String(err) })
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return
    job.status = 'failed'
    job.error = friendlyEngineError(err)
  }

  /** #843: why a settled job ended, for its audit record — content-free codes only. */
  private jobEnd(job: EngineDownloadJob): EngineJobEnd {
    const preview = this.jobPreview(job.jobId)
    if (job.status === 'done') return { reason: null, preview }
    const recorded = this.endReasons.get(job.jobId)
    // A stop records its reason when it lands; a failure where it happens. A job that read
    // `cancelled` without either (a cancel that won a race with a failure) is a cancel; any other
    // ending without one is `internal`, never a guess at the step it reached.
    const fallback: EngineJobEndReason = job.status === 'cancelled' ? 'cancelled' : 'internal'
    return {
      reason: recorded?.reason ?? fallback,
      ...(recorded?.cause ? { cause: recorded.cause } : {}),
      ...(recorded?.space ? { space: recorded.space } : {}),
      preview
    }
  }

  /** #843: record why `job` stops; the first reason recorded for a job stands. */
  private noteEnd(
    job: EngineDownloadJob,
    reason: EngineJobEndReason,
    cause?: string,
    space?: EngineSpaceShortfall
  ): void {
    if (!this.endReasons.has(job.jobId)) {
      this.endReasons.set(job.jobId, { reason, ...(cause ? { cause } : {}), ...(space ? { space } : {}) })
    }
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

  /**
   * Cancel an in-flight engine job. `verifying` and `extracting` are cancellable states
   * too (full-audit 2026-07-11 CODE-13 — the downloads.ts BE-4 precedent): the SHA-256
   * hash and the extraction of a tens-of-MB archive take real time on a USB drive, and a
   * cancel landing there used to be silently dropped (the job kept installing).
   * `fetchArchive` re-checks the abort signal after the verify, the stage after the extraction
   * (#999: which ends only once tar has exited), `run` between archives, between stages and
   * between its phases, and the swap right before its first rename (#986: a cancel is honoured
   * until then; after it the step finishes). #1000: a cancel before the swaps never pauses
   * anything, since the stage runs before the pause.
   */
  cancel(jobId: string): EngineDownloadJob {
    const job = this.jobs.get(jobId)
    if (!job) return this.get(jobId)
    // #986 review 3: once a step's swap has begun renaming, that step finishes (its status stays as it is).
    // The cancel still stops every step after it.
    if (this.swapping === jobId) {
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('Cancel arrived after the swap began: this step finishes, the rest is stopped', { jobId })
      return { ...job }
    }
    if (
      job.status === 'queued' ||
      job.status === 'downloading' ||
      job.status === 'verifying' ||
      job.status === 'extracting'
    ) {
      job.status = 'cancelled'
      this.noteEnd(job, 'cancelled')
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('Engine download cancelled', { jobId })
    }
    return { ...job }
  }

  /**
   * #782: internet access was switched off (`on` false) or back on. Off: an archive download in
   * progress stops at once; a job checking an archive finishes that check and stops before its next
   * download; one whose archives are all in (extracting) finishes its install. `onStopped` runs once,
   * when (and if) the job stops. On before that: the job carries on. No start straddles the switch:
   * `start()` makes its job before its first await.
   */
  networkSwitched(on: boolean, onStopped: () => void = () => undefined): void {
    if (on) return this.network.switchedOn()
    const active = this.active
    this.network.switchedOff(active?.controller ?? null, onStopped)
    const job = active ? this.jobs.get(active.jobId) : undefined
    if (active && job && (job.status === 'queued' || job.status === 'downloading')) {
      this.stopNetworkJob(job, active.controller)
    }
  }

  /** Stop `job` for #782: it reads `cancelled`, and its run discards what it fetched, as a cancel's does. */
  private stopNetworkJob(job: EngineDownloadJob, controller: AbortController): void {
    job.status = 'cancelled'
    this.noteEnd(job, 'networkOff')
    controller.abort()
    this.deps.log?.('Engine download stopped: internet access was switched off', { jobId: job.jobId })
    this.network.stopped(controller)
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
    // F-33: a cancelled-but-not-yet-settled run() still owns `extractTo` (the tar child may still
    // be writing), so treat it as busy regardless of `job.status` — `start()`'s single guard then
    // refuses a second install that would interleave with the late extraction.
    return live || !this.runSettled ? this.active.jobId : null
  }

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter(
      (j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
    )
    for (const job of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))) {
      this.jobs.delete(job.jobId)
      this.previews.delete(job.jobId)
      this.endReasons.delete(job.jobId)
    }
  }

  /**
   * Install every step; the first failure fails the whole job. Three phases (#516, #1000), and only the
   * last one touches an installed engine or stops anything:
   *  1. every archive is downloaded and verified (`fetchArchive`);
   *  2. after the room check (#986), every step is staged (`stageStep`: unpacked, checked and marked in
   *     `<live>.new/`), while the installed engine keeps running and the spawn gate stays open: nothing
   *     here reads or writes an install folder but the archive's move out of it;
   *  3. only then are spawns held, `beforeReplace` (the update's pause) runs, and each staged copy is
   *     swapped in (`swapStep`), which takes the renames' time.
   * A cancel before phase 3 replaces nothing, never pauses and never holds the gate. A step that fails
   * leaves its whole FAMILY as it was (round 1: the `cpu/` net with its main build) while the other families
   * still install; the first failure is the job's, and a job none of whose families staged never pauses.
   * Archives not yet staged when the job stops are deleted, and so is every copy the job staged and did not
   * swap in, whatever ends the job (the `finally`; un-marked at once). Each swap is a staged swap, so a step
   * that fails leaves its install as it was.
   */
  private async run(
    job: EngineDownloadJob,
    steps: InstallStep[],
    rootPath: string,
    controller: AbortController,
    beforeReplace?: () => Promise<void>
  ): Promise<void> {
    // #998 round 1: the deletes an earlier job queued (its replaced copies, the copies it staged and did not
    // swap in) finish first, so the recovery below never moves a copy that is about to be deleted into place
    // without the gate or the pause.
    await engineFolderDeletesSettled()
    // #986 review: an earlier attempt of this session can have left the only whole copies beside an
    // install (a swap whose old copy could not be moved back) or the only `cpu/` net in a `.old` (a
    // carry that was refused). Finish or roll that back first, with the start's own rule, main build
    // before its net, and before phase 1 makes the install folder again for its archive: a retry must
    // never delete what the last attempt kept. Renames only; the deletes run in the background.
    // #986 review 2: a main build's nested net folder too, whatever the job plans for it: a retry that plans
    // the main build alone must not move a net's unfinished swap (`<os>/cpu.new`, `cpu.old`) away with it.
    const logs: RecoveryLogs = { info: this.deps.log, warn: this.deps.log }
    const recovered: InstallStep[] = []
    for (const step of steps) {
      // T8.5c: as at the start, a marker it cannot read just now leaves the layout as it is; the leftover guard then
      // refuses the family (`holdsIrreplaceableLeftover`).
      const held = heldEngineMarker(rootPath, step.plan, step.main ? step.cpuNet : undefined)
      if (held) {
        this.deps.log?.(HELD_MARKER_NOTE, { family: step.family, ...held })
        continue
      }
      const folders: Array<[RuntimeDownloadPlan, boolean]> = [[step.plan, step.main]]
      if (step.main && step.cpuNet) folders.push([step.cpuNet, false])
      for (const [plan, main] of folders) {
        try {
          // #986 review 3: a copy moved in is a new program at those paths: its cached verdicts go now,
          // and the job's listeners hear of it when the job ends, whatever the outcome.
          for (const moved of recoverEngineFolder(rootPath, step.family, plan, main, logs, main ? step.cpuNet : undefined)) {
            for (const p of moved.binaryPaths) invalidateBinaryVerification(p)
            recovered.push({ family: step.family, plan: moved, main: moved === step.plan, sizeBytes: null })
          }
        } catch (err) {
          this.deps.log?.('Engine swap recovery failed', { family: step.family, error: String(err) })
        }
      }
    }
    if (recovered.length > 0) this.recoveredSteps.set(job.jobId, recovered)
    const fetched: RuntimeDownloadPlan[] = []
    const discard = async (plans: readonly RuntimeDownloadPlan[]): Promise<void> => {
      for (const p of plans) await rm(p.zipDest, { force: true }).catch(() => undefined)
    }
    for (const step of steps) {
      // Each archive is a fresh download — reset the per-file progress counters.
      job.receivedBytes = 0
      job.totalBytes = null
      const outcome = await this.fetchArchive(job, step.plan, controller)
      if (outcome !== 'ok') {
        await discard(fetched) // its own archive is already gone; job.status/error already set
        return
      }
      fetched.push(step.plan)
      // CODE-13 (the BE-4 shape): a cancel that landed in the window after this archive's
      // abort checks must stop the run here — the next fetch would otherwise overwrite the
      // `cancelled` status and start downloading the next archive.
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        await discard(fetched)
        return
      }
    }
    job.status = 'extracting'
    // #986: a drive without room to unpack the archives refuses the job here, with the figures:
    // before the pause (a refused update never stops the model) and before anything installed is
    // touched. A full drive used to fail half-way through the extraction, with the old copy deleted.
    const shortfall = await this.missingRoom(steps)
    if (controller.signal.aborted) {
      job.status = 'cancelled'
      await discard(fetched)
      return
    }
    if (shortfall) {
      job.status = 'failed'
      job.error = tMain('main.engine.notEnoughSpace', spaceFigures(shortfall))
      this.noteEnd(job, 'noSpace', undefined, shortfall)
      this.deps.log?.('Not enough free space to unpack the engine: nothing was replaced', shortfall)
      await discard(fetched)
      return
    }
    const order = installOrder(steps)
    const releases: Array<() => void> = []
    const replaced: InstallStep[] = []
    // #986: the replaced copies (`<live>.old/`), deleted once the gate is released.
    const replacedFolders: string[] = []
    // #1000: the copies this job staged (`<live>.new/`, from the moment a stage begins) and has not swapped
    // in: deleted in the `finally`, whatever ends the job — a failure, a cancel, a refused pause, a stop
    // part-way or an unexpected throw. One the swap kept as the only whole copy is taken off the list.
    const unswapped: string[] = []
    // #1000 round 1: each FAMILY is all or nothing up to its swaps (the `cpu/` net with its main build). A family
    // whose leftover guard, stage or swap fails is left as it is, the other families still install (a plain
    // "Install the AI engine" on a bare drive fetches the chat and the voice engine: a voice engine that cannot
    // be unpacked used to stop the chat engine too), and the FIRST failure is the job's, reported once at the end.
    const failedFamilies = new Set<EngineFamily>()
    const failure: { first: { error: unknown } | null } = { first: null }
    const fail = (family: EngineFamily, error: unknown): void => {
      failedFamilies.add(family)
      failure.first ??= { error }
    }
    let complete = false
    try {
      // #986 review: a leftover `run()`'s recovery could not move where it belongs, that is still the only
      // whole copy or holds a net the install lacks, is never deleted: that family stops with `filesInUse`,
      // nothing touched. #1000: every step's leftovers are judged before any step stages, so a net this job
      // staged (`<os>/cpu.new`) is never mistaken for one.
      for (const step of order) {
        if (failedFamilies.has(step.family)) continue
        try {
          if (holdsIrreplaceableLeftover(rootPath, step)) {
            fail(step.family, new EngineStepError('filesInUse', tMain('main.engine.filesInUse'), true))
          }
        } catch (err) {
          fail(step.family, err)
        }
      }
      // #1000: phase 2, stage every step while the installed engine keeps running and its spawns stay
      // open: nothing is paused and the gate is not held, so a stage that fails or is cancelled (or hangs
      // on a failing stick until the extractor's deadline) never stops a model.
      const staged = new Map<InstallStep, EngineSwapDirs>()
      for (const [i, step] of order.entries()) {
        if (controller.signal.aborted) {
          job.status = 'cancelled'
          await discard(order.slice(i).map((s) => s.plan))
          return
        }
        if (failedFamilies.has(step.family)) {
          await discard([step.plan])
          continue
        }
        // Its own archive is gone after the stage, whatever happened.
        const result = await this.stageStep(step, rootPath, controller, unswapped)
        if ('error' in result) fail(step.family, result.error)
        else staged.set(step, result)
      }
      // A cancel that landed after the last extraction (in a flatten, the hashing or the flush) stands.
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        return
      }
      const swapping = order.filter((s) => !failedFamilies.has(s.family))
      if (swapping.length > 0) {
        // Deletes the job's recovery queued settle outside the gate.
        await engineFolderDeletesSettled()
        // #516: from the pause to the last swap, no program of these families may start — a helper
        // restarting by itself, or a model start that was still hashing its weights, waits for the swap
        // (`spawn-gate.ts`) instead of holding a file in a folder the swap renames.
        for (const family of new Set(swapping.map((s) => s.family))) releases.push(holdEngineSpawns(family))
        if (beforeReplace) {
          try {
            await beforeReplace()
          } catch (err) {
            if (failure.first) {
              this.failStep(job, failure.first.error)
              return
            }
            job.status = 'failed'
            job.error = err instanceof Error ? err.message : String(err)
            this.noteEnd(job, 'notReplaced')
            return
          }
          if (controller.signal.aborted) {
            job.status = 'cancelled'
            return
          }
        }
        // Phase 3: the swaps.
        for (const [i, step] of swapping.entries()) {
          // An earlier swap of its family failed: the rest of that family is not swapped.
          if (failedFamilies.has(step.family)) continue
          const dirs = staged.get(step)
          if (!dirs) throw new Error('engine job: a step was never staged')
          const outcome = await this.swapStep(job, step, dirs, controller, replacedFolders, unswapped)
          if (outcome === 'done') replaced.push(step)
          else {
            // A cancel honoured before the swap's first rename ends the job; a swap that kept both copies is
            // reported as such, never hidden behind a cancel recorded while it ran (#986 review 3).
            const keep = outcome.error instanceof EngineStepError && outcome.error.keepStaging
            if ((job.status as EngineDownloadJob['status']) === 'cancelled' && !keep) return
            fail(step.family, outcome.error)
          }
          // A cancel stops what has not started; a swap it arrived too late to stop stays recorded.
          if (controller.signal.aborted && i < swapping.length - 1) {
            if (failure.first) this.failStep(job, failure.first.error)
            else job.status = 'cancelled'
            return
          }
        }
      }
      if (failure.first) {
        this.failStep(job, failure.first.error)
        return
      }
      complete = true
    } finally {
      for (const release of releases) release()
      // #986: in the background and marker first, after the gate: a helper that was waiting starts
      // on the new copy at once. The next swap waits for these deletes (`engineFolderDeletesSettled`).
      for (const dir of replacedFolders) deleteEngineFolderLater(dir, this.deps.log)
      // #998 round 1: a staged copy that is not swapped in loses its marker at once, before its delete waits in
      // the queue: no recovery may take it for a whole copy meanwhile, nor after a delete that is refused.
      for (const dir of unswapped) {
        unmarkEngineFolder(dir, this.deps.log)
        deleteEngineFolderLater(dir, this.deps.log)
      }
      // #516: a job that stopped part-way still replaced what it replaced — the consumers of a new
      // main build need the same re-arm and probe refresh as after a complete install. #678: so does
      // a `cpu/` net a reinstall replaced alone: its old verdict goes, and the fresh copy is known.
      if (!complete) {
        const told = [...replaced, ...this.takeRecovered(job.jobId)]
        if (told.length > 0) this.notifyInstalled(told)
      }
    }
    job.binaryPath = steps.find((s) => s.main)?.plan.binaryPath ?? steps[0]?.plan.binaryPath ?? null
    job.status = 'done'
    this.notifyInstalled([...steps, ...this.takeRecovered(job.jobId)])
  }

  /** #986 review 3: the steps a job's recovery moved in and has not told yet (and forget them). */
  private takeRecovered(jobId: string): InstallStep[] {
    const steps = this.recoveredSteps.get(jobId) ?? []
    this.recoveredSteps.delete(jobId)
    return steps
  }

  /**
   * Issue #323: tell the subscribers which families landed — every binary of `steps` is on the
   * drive with its marker. Each listener is isolated: a fault there must never fail the job.
   */
  private notifyInstalled(steps: readonly InstallStep[]): void {
    const families = [...new Set(steps.map((s) => s.family))]
    const programs: Partial<Record<EngineFamily, string[]>> = {}
    for (const s of steps) {
      const list = (programs[s.family] ??= [])
      if (!list.includes(s.plan.binaryPath)) list.push(s.plan.binaryPath)
    }
    for (const listener of this.installedListeners) {
      try {
        listener(families, programs)
      } catch (err) {
        this.deps.log?.('Engine install listener failed (install itself succeeded)', String(err))
      }
    }
  }

  /**
   * Phase 1 for ONE archive: download → verify. Returns 'ok' with the verified archive at
   * `plan.zipDest`; on 'failed' it sets `job.status`/`job.error`, and on anything but 'ok' the
   * archive is gone. The installed engine is not touched: the archive lands beside its files
   * (`plan.zipDest`, inside the install folder, which a first install creates here), and phase 2
   * moves it into the staging folder it is extracted in (#986). `job.unverified` stays false for
   * engines: RT-02 made a placeholder hash a hard FAILURE (the verify branch below), so there is
   * no "installed but unverified" engine state — unlike model weights.
   */
  private async fetchArchive(
    job: EngineDownloadJob,
    plan: RuntimeDownloadPlan,
    controller: AbortController
  ): Promise<'ok' | 'failed' | 'aborted'> {
    try {
      await mkdir(plan.extractTo, { recursive: true })
      // Fetch the release archive. No Range resume (an engine archive is far smaller than a
      // multi-GB weight, and a corrupt partial must never be extracted) — a fresh archive
      // each attempt; a stale one from a cancelled run is overwritten.
      // A stop that landed while the job was still queued (behind the mkdir above) stands: the
      // status below must not overwrite it, or the aborted fetch would read as a failure.
      if (controller.signal.aborted) return 'aborted'
      // #782: internet access went off while an earlier archive was checked: nothing new is fetched.
      if (this.network.stopsAt(controller)) {
        this.stopNetworkJob(job, controller)
        return 'aborted'
      }
      job.status = 'downloading'
      const result = await downloadToFile(plan.url, plan.zipDest, {
        fetchImpl: this.deps.fetchImpl,
        signal: controller.signal,
        // F17: engine archives are tens-to-low-hundreds of MB; pass a bounded per-family ceiling so
        // a redirected / Content-Length-less endpoint can't fall through to the multi-GiB backstop
        // and fill the drive (the archive SHA verify rejects wrong bytes afterwards).
        maxBytes: ENGINE_DOWNLOAD_MAX_BYTES,
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
      const verify = await (this.deps.verifyImpl ?? verifyDownloadedFile)(plan.zipDest, plan.sha256)
      // CODE-13 (mirrors downloads.ts BE-4): honour a cancel that landed DURING the hash —
      // before acting on the verify result. Nothing extracts, no marker is written, the
      // archive is discarded (the engine downloader never resumes partials). The status is
      // set explicitly because a cancel racing the `verifying` transition above could have
      // been overwritten.
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        await rm(plan.zipDest, { force: true })
        return 'aborted'
      }
      if (verify.reason === 'mismatch') {
        await rm(plan.zipDest, { force: true })
        job.status = 'failed'
        job.error = tMain('main.engine.checksumMismatch')
        this.noteEnd(job, 'checksumMismatch')
        this.deps.log?.('Engine archive checksum mismatch — discarded', {
          expected: plan.sha256,
          actual: verify.actual
        })
        return 'failed'
      }
      if (verify.reason === 'missing') {
        job.status = 'failed'
        job.error = tMain('main.engine.fileMissing')
        this.noteEnd(job, 'fileMissing')
        return 'failed'
      }
      // RT-02: fail CLOSED on a placeholder (non-real) hash. This installs EXECUTABLE code —
      // extract, chmod +x, and a marker that legitimizes later spawns — so an artifact that
      // cannot be verified must never be installed, independent of the accepted
      // trust-by-location signing residual (security-model.md S4 / §22-M2). The committed
      // runtime-sources entries all carry real hashes (guarded by a committed-sources test),
      // so this only ever fires on a mis-authored or tampered source, which is exactly when it
      // should. Unlike model-weight downloads, there is no "unverified but usable" state for a
      // binary we are about to execute.
      if (verify.reason === 'placeholder') {
        await rm(plan.zipDest, { force: true })
        job.status = 'failed'
        job.error = tMain('main.engine.unverifiablePlaceholder')
        this.noteEnd(job, 'placeholderHash')
        this.deps.log?.('Engine archive has a placeholder hash — refusing to install unverified executable', {
          extractTo: plan.extractTo
        })
        return 'failed'
      }
      return 'ok'
    } catch (err) {
      if (job.status === 'cancelled') {
        await rm(plan.zipDest, { force: true })
        return 'aborted'
      }
      job.status = 'failed'
      job.error = friendlyEngineError(err)
      this.noteEnd(job, 'download', failureReason(err))
      this.deps.log?.('Engine download failed', { error: String(err) })
      await rm(plan.zipDest, { force: true }).catch(() => undefined)
      return 'failed'
    }
  }

  /**
   * #986: the room the job's archives need unpacked, against the free space where they unpack. Each
   * archive's extracted size comes from the verified archive itself (`extractedArchiveBytes`, rounded
   * to the volume's allocation unit), plus a unit for its staging folder and one for its marker; the
   * replaced copies are deleted only after the job, so the steps on one volume add up. The staging
   * folder is a sibling of the install folder, so its parent's volume is the one that counts. Null
   * when there is room, and also when a figure is unknown (an archive the reader cannot size, a volume
   * that cannot say): then nothing is refused, as the model downloader's room check (#768) does.
   */
  private async missingRoom(steps: readonly InstallStep[]): Promise<EngineSpaceShortfall | null> {
    const volumes = new Map<number, { needed: number; free: number | null }>()
    for (const step of steps) {
      const parent = dirname(step.plan.extractTo)
      let dev: number
      let unit: number
      try {
        dev = (await stat(parent)).dev
        unit = Number((await statfs(parent)).bsize)
      } catch {
        return null
      }
      const unpacked = await extractedArchiveBytes(step.plan.zipDest, unit)
      if (unpacked === null) {
        this.deps.log?.('The engine archive could not be sized: no free-space check', {
          archive: basename(step.plan.zipDest)
        })
        return null
      }
      const volume = volumes.get(dev) ?? { needed: 0, free: await freeBytes(parent) }
      volume.needed += unpacked + 2 * unit
      volumes.set(dev, volume)
    }
    for (const { needed, free } of volumes.values()) {
      if (free !== null && needed > free) return { neededBytes: needed, freeBytes: free }
    }
    return null
  }

  /**
   * Phase 2 for ONE verified archive (#986, #1000): `stageEngineInstall` builds the new copy in `<live>.new/`
   * (extract, flatten, left-out files, link sweep, the archive's member check, required files, hashes,
   * every file flushed, the marker written last INSIDE `.new`), while the installed engine keeps running.
   * The staging folder joins `unswapped` before anything is written there, so `run()` deletes it whatever
   * happens next. Nothing installed is touched but the archive's move out of the install folder. Returns
   * the swap folders, or the error on a failure or cancel (`run()` decides what it means for the job, #1000
   * round 1). The archive is gone either way.
   */
  private async stageStep(
    step: InstallStep,
    rootPath: string,
    controller: AbortController,
    unswapped: string[]
  ): Promise<EngineSwapDirs | { error: unknown }> {
    const { plan } = step
    try {
      const dirs = engineSwapDirs(rootPath, plan.extractTo)
      unswapped.push(dirs.staging)
      // F-33: the job's abort signal reaches the extractor, so a cancel kills the tar child (and a
      // deadline bounds a wedged one); #999: the stage goes on only once that child has exited.
      await stageEngineInstall(plan, dirs.staging, {
        extract: this.deps.extractImpl,
        signal: controller.signal,
        log: this.deps.log
      })
      return dirs
    } catch (error) {
      await rm(plan.zipDest, { force: true, ...removeRetry() }).catch(() => undefined)
      return { error }
    }
  }

  /**
   * Phase 3 for ONE staged copy (#986, #1000), with the spawn gate held and after `beforeReplace`: the copy
   * is checked again (a scanner can take a fresh file after the stage: the antivirus case of #986), then
   * swapped in (`swapEngineFolder`: the install to `<live>.old/`, `.new` in, the old copy put back when the
   * second rename is refused). A cancel is honoured until the swap's first rename; after it the step
   * finishes. The main build then carries the `cpu/` net over from `.old`. `.old` joins `replacedFolders`,
   * deleted after the job. A copy that moved in, or that the swap kept as the only whole one (the install
   * folder gone for the moment), leaves `unswapped`. Returns 'done', or the error (`run()` decides what it
   * means for the job, #1000 round 1).
   */
  private async swapStep(
    job: EngineDownloadJob,
    step: InstallStep,
    dirs: EngineSwapDirs,
    controller: AbortController,
    replacedFolders: string[],
    unswapped: string[]
  ): Promise<'done' | { error: unknown }> {
    const { plan } = step
    const settled = (): void => {
      const at = unswapped.indexOf(dirs.staging)
      if (at >= 0) unswapped.splice(at, 1)
    }
    try {
      // #998: judged by the staged copy's own marker (`engineFolderComplete`): every file it records, so a
      // DLL a scanner took during the pause is caught too, not only the program. A marker with no map (a
      // hashing failure) falls back to the stage's own test, `existsSync` of the required files; a copy
      // whose marker went is not the copy the stage made.
      const marker = readRuntimeMarker(dirs.staging)
      const whole =
        marker !== null &&
        (marker.binaries
          ? engineFolderComplete(plan, dirs.staging)
          : requiredInstallFiles(planInFolder(plan, dirs.staging)).every((p) => existsSync(p)))
      if (!whole) {
        throw new EngineStepError('incomplete', tMain('main.engine.binaryMissing'))
      }
      try {
        await swapEngineFolder(dirs, this.deps.log, controller.signal, () => {
          this.swapping = job.jobId
        })
      } catch (err) {
        if (err instanceof EngineStepError && err.keepStaging) settled()
        throw err
      }
      settled()
      // The new copy is in place: from here a cancel is too late to stop anything.
      const carried = step.main ? await carryCpuNet(dirs.previous, dirs.live, this.deps.log, step.cpuNet) : true
      // #986 review 3: the carry can replace an incomplete `cpu/`: the net's cached verdicts go too.
      if (step.main) for (const p of step.cpuNet?.binaryPaths ?? []) invalidateBinaryVerification(p)
      // A `.old` whose net could not be carried stays for the next start to carry (`recoverEngineSwaps`).
      if (carried && present(dirs.previous)) replacedFolders.push(dirs.previous)
      // CODE-12 (full-audit 2026-07-11): drop the binary-verifier's session-cached verdict for every
      // executable we just replaced — a stale pre-install verdict (the `mismatch` after a tamper
      // repair, or an `ok` hashed from the OLD bytes) must not apply to the new binary until app
      // restart. The next spawn re-hashes against the fresh marker. The cache is keyed by the spawned
      // program, and each program's verdict covers every file of its copy (#1012), so the programs are
      // the whole list: runtime files are never spawned.
      for (const p of plan.binaryPaths) invalidateBinaryVerification(p)
      this.deps.log?.('Engine installed', { binaryPath: plan.binaryPath })
      return 'done'
    } catch (error) {
      return { error }
    } finally {
      if (this.swapping === job.jobId) this.swapping = null
    }
  }

  /**
   * A step that failed (#986): the job fails with the error's copy and audit reason, unless a cancel already
   * ended it ('aborted'). One that keeps the only whole copies (`EngineStepError.keepStaging`: a leftover
   * the job must not delete, or a swap that could not put the old copy back) is reported as such, never
   * hidden behind a cancel recorded while it ran (#986 review 3).
   */
  private failStep(job: EngineDownloadJob, err: unknown): 'failed' | 'aborted' {
    const keep = err instanceof EngineStepError && err.keepStaging
    if (job.status === 'cancelled' && !keep) return 'aborted'
    if (keep) this.endReasons.delete(job.jobId)
    job.status = 'failed'
    if (err instanceof EngineStepError) {
      job.error = err.message
      this.noteEnd(job, err.reason)
    } else {
      job.error = friendlyEngineError(err)
      this.noteEnd(job, 'install')
    }
    this.deps.log?.('Engine install failed', {
      error: String(err),
      ...(keep ? { kept: 'the only whole copies, for the next attempt or start' } : {})
    })
    return 'failed'
  }
}

/** A step failure with its own copy and audit reason (#986). */
class EngineStepError extends Error {
  constructor(
    readonly reason: EngineJobEndReason,
    message: string,
    /** A staged (or leftover) copy that is the only whole one: kept for the next attempt or start. */
    readonly keepStaging = false
  ) {
    super(message)
  }
}

type EngineLog = ((msg: string, meta?: unknown) => void) | undefined

/**
 * The order a job stages and swaps its steps in (#986 review; #1000: phases 2 and 3): per family, its `cpu/`
 * net BEFORE its main build. The net's folder sits inside the main one (`<os>/cpu/`) and its archive downloads into it, so
 * with the main build first its swap moved the net's archive to `<os>.old/cpu/`, and a refused carry
 * left the net step without it and the archive inside `cpu/` for good. Net first, the net's swap happens
 * inside the old install folder and the main build's carry takes the NEW net across; no archive is ever
 * inside a folder another step renames (since #1000 every archive has moved into its own `.new` before
 * the first swap anyway). Families keep their order; phase 1 keeps the plan's.
 */
function installOrder(steps: readonly InstallStep[]): InstallStep[] {
  const families = [...new Set(steps.map((s) => s.family))]
  return families.flatMap((f) => [
    ...steps.filter((s) => s.family === f && !s.main),
    ...steps.filter((s) => s.family === f && s.main)
  ])
}

/** Is there anything at `p`, a dangling link included. */
function present(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** A real folder at `p`: never a link (or a junction) posing as one. */
function isRealFolder(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The `needed`/`free` figures of `main.engine.notEnoughSpace`, by the model downloader's rules (#768). */
function spaceFigures({ neededBytes, freeBytes: free }: EngineSpaceShortfall): { needed: string; free: string } {
  const lang = mainUiLanguage()
  // The same rules as `assertRoomFor` in downloads.ts: both figures in the unit the size needs,
  // decimal, one decimal, joined the way the UI language joins a figure and its unit (#804); free
  // space rounds down to the tenth, the size as shown elsewhere unless that prints the same tenth,
  // and then up — which always differs, since needed > free.
  const [unit, label]: [number, string] =
    neededBytes >= 1e9 ? [1e9, 'GB'] : neededBytes >= 1e6 ? [1e6, 'MB'] : [1e3, 'KB']
  const shown = (bytes: number): string => `${fmt1(bytes / unit, lang)}${unitJoin(lang)}${label}`
  const tenth = unit / 10
  const freeShown = shown(Math.floor(free / tenth) * tenth)
  let neededShown = shown(neededBytes)
  if (neededShown === freeShown) neededShown = shown(Math.ceil(neededBytes / tenth) * tenth)
  return { needed: neededShown, free: freeShown }
}

// ---- The staged swap (#986; architecture.md "In-app engine updates" §6) -------------------------

/** The background deletes of replaced and abandoned copies, one after the other. */
let engineFolderDeletes: Promise<void> = Promise.resolve()

/**
 * Settles once every engine-folder delete queued so far has run (#986). The stage and the swap wait for
 * it, so a background delete never races a new `.new` or `.old` of the same name.
 */
export function engineFolderDeletesSettled(): Promise<void> {
  return engineFolderDeletes
}

/** Queue `dir` for deletion in the background (`removeEngineFolder`: marker first). */
function deleteEngineFolderLater(dir: string, log: EngineLog): void {
  engineFolderDeletes = engineFolderDeletes.then(async () => {
    await removeEngineFolder(dir, log)
  })
}

/**
 * Delete an engine copy, its marker FIRST (#986 gap 3): on exFAT a folder lists in creation order and
 * the marker is written last, so a delete cut short by a kill or an unplug would otherwise keep the
 * marker over missing files, and the start would take the copy for whole. A link (or junction) at
 * `dir` is unlinked, never entered. False, and logged, when anything is left.
 */
async function removeEngineFolder(dir: string, log: EngineLog): Promise<boolean> {
  try {
    if (!present(dir)) return true
    // `recursive`: whatever sits at the marker's name goes, a folder posing as it too.
    if (isRealFolder(dir)) await rm(runtimeMarkerPath(dir), { force: true, recursive: true, ...removeRetry() })
    // On Windows a scanner still reading a just-failed copy makes the delete EBUSY/EPERM for a moment:
    // Node retries within the rename's budget (`removeRetry`).
    await rm(dir, { recursive: true, force: true, ...removeRetry() })
    return true
  } catch (err) {
    log?.('Could not remove an engine folder', { folder: basename(dir), error: String(err) })
    return false
  }
}

/**
 * Remove the marker of the engine copy at `dir` now (#998 round 1), so nothing takes it for a whole copy while
 * its delete waits in the queue (or after a delete that is refused). A link (or junction) at `dir` is left
 * alone, as `removeEngineFolder` leaves it. A failure is logged; the queued delete tries again.
 */
function unmarkEngineFolder(dir: string, log: EngineLog): void {
  try {
    if (isRealFolder(dir)) rmSync(runtimeMarkerPath(dir), { force: true, recursive: true })
  } catch (err) {
    log?.('Could not remove an engine folder', { folder: basename(dir), error: String(err) })
  }
}

/**
 * {@link removeEngineFolder} on the start path (#986 review): synchronous, marker first, no retries (the
 * start never waits on a lock; what is left waits for the next start).
 */
function removeEngineFolderSync(dir: string, log: EngineLog): boolean {
  try {
    if (!present(dir)) return true
    if (isRealFolder(dir)) rmSync(runtimeMarkerPath(dir), { force: true, recursive: true })
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch (err) {
    log?.('Could not remove an engine folder', { folder: basename(dir), error: String(err) })
    return false
  }
}

/**
 * Is a leftover beside the install one a step must not delete (#986 review)? A `.new` or `.old` that is
 * complete while the install folder is not (the only whole copy), or one that holds a real `cpu/` net the
 * install folder lacks (a main build's carry that did not happen). `recoverEngineFolder` moves such a copy
 * where it belongs; one still there means a rename was refused.
 */
function irreplaceableLeftover(
  plan: RuntimeDownloadPlan,
  dirs: EngineSwapDirs,
  main: boolean,
  netPlan?: RuntimeDownloadPlan
): boolean {
  const liveWhole = engineFolderComplete(plan)
  const liveHasNet = netWhole(join(dirs.live, 'cpu'), netPlan)
  // #986 review 2: a net in the leftover's own `cpu/`, or in a net swap left inside it (`cpu.new`, `cpu.old`).
  const holdsNet = (dir: string): boolean =>
    netPlan
      ? NESTED_NET_FOLDERS.some((n) => netWhole(join(dir, n), netPlan))
      : isRealFolder(join(dir, 'cpu'))
  return [dirs.staging, dirs.previous].some(
    (dir) =>
      isRealFolder(dir) && ((!liveWhole && engineFolderComplete(plan, dir)) || (main && !liveHasNet && holdsNet(dir)))
  )
}

/**
 * Does `step` find a leftover it must not delete (#986 review, `irreplaceableLeftover`) beside its install
 * folder, or, for a main build, beside its `cpu/` net's? T8.5c: also when a marker there cannot be read just now
 * (`heldEngineMarker`): nothing is judged, so nothing is deleted. Throws when a folder lies outside the drive root.
 */
function holdsIrreplaceableLeftover(rootPath: string, step: InstallStep): boolean {
  if (heldEngineMarker(rootPath, step.plan, step.main ? step.cpuNet : undefined)) return true
  if (irreplaceableLeftover(step.plan, engineSwapDirs(rootPath, step.plan.extractTo), step.main, step.cpuNet)) return true
  if (!step.main || !step.cpuNet) return false
  return irreplaceableLeftover(step.cpuNet, engineSwapDirs(rootPath, step.cpuNet.extractTo), false)
}

/**
 * T8.5c (R2 M-1 = R1 F-5): the first marker of an engine family's swap layout that cannot be read just now
 * (`readRuntimeMarkerState`'s `unreadable`: an antivirus holding it, a denied read), or null. "Complete" reads such a
 * marker as none, so on it the start's recovery deleted the only whole copy, rolled an update back or replaced a whole
 * `cpu/` net; as at the pre-spawn check (#1012 round 6) it is no verdict, and the family is left as it is until the
 * next start or job (the start's recovery, a job's own, and its leftover guard). The layout is `plan`'s install folder
 * with its `.new` and `.old`, and with `netPlan` the `cpu/` net's folder names inside each of the three
 * (`NESTED_NET_FOLDERS`): every marker those may judge. Read only when a leftover lies beside the install or its
 * net, so a start with none reads nothing more. `marker` names the copy by its folder, relative to the family's
 * (`win.old/cpu`), and `code` is the read's errno code: content-free. Never throws.
 */
function heldEngineMarker(
  rootPath: string,
  plan: RuntimeDownloadPlan,
  netPlan?: RuntimeDownloadPlan
): { marker: string; code: string | null } | null {
  let units: EngineSwapDirs[]
  try {
    units = [engineSwapDirs(rootPath, plan.extractTo), ...(netPlan ? [engineSwapDirs(rootPath, netPlan.extractTo)] : [])]
  } catch {
    return null
  }
  if (!units.some((d) => present(d.staging) || present(d.previous))) return null
  const own = units[0]
  const copies = new Set<string>()
  for (const d of units) for (const dir of [d.live, d.staging, d.previous]) copies.add(dir)
  if (netPlan) {
    for (const dir of [own.live, own.staging, own.previous]) for (const n of NESTED_NET_FOLDERS) copies.add(join(dir, n))
  }
  for (const dir of copies) {
    const state = readRuntimeMarkerState(dir)
    if (state.kind === 'unreadable') return { marker: relative(dirname(own.live), dir).split(sep).join('/'), code: state.code }
  }
  return null
}

/** What the start and a job log for a family `heldEngineMarker` leaves as it is. */
const HELD_MARKER_NOTE = 'Engine swap recovery: a marker could not be read just now; this family is left as it is'

/**
 * Is the `cpu/` net at `dir` whole (#986 review 2): a real folder whose own marker is satisfied
 * (`engineFolderComplete`). With no net pinned for this host there is nothing to judge it by, and a folder
 * there counts, as before.
 */
function netWhole(dir: string, netPlan: RuntimeDownloadPlan | undefined): boolean {
  if (!netPlan) return present(dir)
  return isRealFolder(dir) && engineFolderComplete(netPlan, dir)
}

/**
 * Flush every file under `dir` to the device (#986: the marker decides, so what it covers must be on the disk),
 * one file at a time and off the main thread (#1000: the stage runs while the models answer).
 */
async function flushFolder(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) await flushFolder(p)
    else if (entry.isFile()) await flushToDeviceAsync(p)
  }
}

export interface StageEngineOptions {
  /** The extractor (default `extractWithTar`). */
  extract?: ExtractFn
  /** A cancel: it reaches the extractor, and a stage it lands on throws. */
  signal?: AbortSignal
  log?: (msg: string, meta?: unknown) => void
}

/** An archive name the link repair reads (#1045): a tar.gz, the macOS and Linux release format (fetch-runtime.sh's `case`). */
const TAR_GZ_NAME = /\.(tar\.gz|tgz)$/i

/** The most a link listing may print (#1045): a release lists some hundred members, this room tens of thousands. */
const LINK_LISTING_MAX_BYTES = 8 * 1024 * 1024

/** One link an archive lists: its name and its target, as the archive writes them; `hard` for a hard link. */
interface ArchiveLink {
  name: string
  target: string
  hard: boolean
}

/**
 * #1045: the links the tar.gz at `archivePath` lists, read with the OS's tar (`tar -tvzf -`) as fetch-runtime.sh
 * reads them: the archive goes in on stdin, so no path is on the command line (#767, #856) and the child holds no
 * file on the drive. GNU tar and bsdtar print a symbolic link as `l… <name> -> <target>` and a hard link as
 * `h… <name> link to <target>`; a name or a target holding white space is not read (as the script's `sed`). Null
 * when the listing fails, is cancelled, runs past the extractor's deadline or prints more than `LINK_LISTING_MAX_BYTES`.
 */
function listArchiveLinks(archivePath: string, cwd: string, signal?: AbortSignal): Promise<ArchiveLink[] | null> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess
    try {
      child = spawn(resolveTarBinary(), ['-tvzf', '-'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolvePromise(null)
    }
    const source = createReadStream(archivePath)
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (links: ArchiveLink[] | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      source.destroy()
      resolvePromise(links)
    }
    const stop = (): void => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(null)
    }
    const timer = setTimeout(stop, extractDeadlineMs())
    timer.unref?.()
    if (signal?.aborted) return stop()
    signal?.addEventListener('abort', stop, { once: true })
    source.on('error', stop)
    // tar may stop reading before the end (a broken archive): the pipe then closes under the stream.
    child.stdin?.on('error', () => undefined)
    if (child.stdin) source.pipe(child.stdin)
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > LINK_LISTING_MAX_BYTES) return stop()
      chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code: number | null) => {
      if (code !== 0) return finish(null)
      const links: ArchiveLink[] = []
      for (const line of Buffer.concat(chunks).toString('utf8').split(/\r?\n/)) {
        const m = /^l.*\s(\S+)\s->\s(\S+)$/.exec(line)
        const h = m ? null : /^h.*\s(\S+)\slink to\s(\S+)$/.exec(line)
        if (m) links.push({ name: m[1], target: m[2], hard: false })
        else if (h) links.push({ name: h[1], target: h[2], hard: true })
      }
      finish(links)
    })
  })
}

/**
 * #1045: does a link the archive lists leave the folder `dir` it is unpacked in, by its name or by its target (read
 * from the link's own folder)? fetch-runtime.sh's rule (`stays_inside`): an absolute name (`/`, `\`, a drive letter)
 * or a `..` that climbs above the folder. And, by this host's own path rules, a name that resolves outside `dir` (a
 * `\` is a separator on Windows), as every other key the app reads from an archive or a marker (`recordedFilePath`).
 */
function linkLeavesFolder(dir: string, link: ArchiveLink): boolean {
  const absolute = (p: string): boolean => /^([/\\]|[A-Za-z]:)/.test(p)
  const climbsOut = (p: string): boolean => {
    let depth = 0
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue
      depth += seg === '..' ? -1 : 1
      if (depth < 0) return true
    }
    return false
  }
  const target = `${posix.dirname(link.name)}/${link.target}`
  if (absolute(link.name) || absolute(link.target) || climbsOut(link.name) || climbsOut(target)) return true
  return recordedFilePath(dir, link.name) === null || recordedFilePath(dir, target) === null
}

/** A failed tar `mendTarFailure` mended: what `judgeMendedTar` needs for its verdict, after the flatten. */
interface MendedTar {
  failure: TarExitError
  /** The log lines' content-free fields: the pinned archive's name and tar's exit code. */
  at: { archive: string; exitCode: number }
  /** Each regular member's size in the archive (`archiveMemberSizes`). */
  sizes: Map<string, number>
  /** The members tar's own listing calls links (symbolic or hard). */
  links: Set<string>
  /** How many link copies were made. */
  copies: number
}

/**
 * #1045: mend a tar that ran to its end and failed (`TarExitError`) on a tar.gz, as fetch-runtime.sh does after its
 * extraction. The macOS and Linux release archives carry version links (`libllama.so` → `libllama.so.0` → …), and a
 * drive that holds no links (exFAT, the Kit's file system) makes tar fail each one; the loader needs only the names.
 * So every symbolic link the archive lists (`listArchiveLinks`) that is missing in `dir` becomes a copy of its target,
 * in up to four passes (links chain, listed before what they name). A link whose name or target leaves `dir`
 * (`linkLeavesFolder`) refuses the install: it throws, and the stage's caller deletes `dir`. No mend (null) when the
 * archive cannot be listed in-process (`members`) or sized per member (`archiveMemberSizes`), or tar cannot list its
 * links; the failure then stands. Runs before the flatten, so the names are the archive's; never writes through a
 * link tar did make (the SEC-2 sweep runs first). Whether the copy is whole is `judgeMendedTar`'s verdict, by the
 * member check's own rules after the flatten. Logs content-free (the pinned archive's name, tar's exit code).
 */
async function mendTarFailure(
  archivePath: string,
  dir: string,
  members: string[] | null,
  failure: TarExitError,
  opts: StageEngineOptions
): Promise<MendedTar | null> {
  const at = { archive: basename(archivePath), exitCode: failure.exitCode }
  const sizes = members === null ? null : await archiveMemberSizes(archivePath)
  const links = sizes === null ? null : await listArchiveLinks(archivePath, dir, opts.signal)
  if (members === null || sizes === null || links === null) {
    opts.log?.('tar failed and the archive could not be listed or sized: no link is copied', at)
    return null
  }
  const symlinks = links.filter((link) => !link.hard)
  for (const link of symlinks) {
    if (linkLeavesFolder(dir, link)) {
      throw new Error(`extracted archive member escapes the install dir: ${link.name} -> ${link.target}`)
    }
  }
  await assertExtractedSymlinksContained(dir)
  const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false)
  const listed = new Set(members)
  let copies = 0
  for (let pass = 0; pass < 4; pass++) {
    let unresolved = 0
    for (const link of symlinks) {
      const to = join(dir, ...link.name.split('/'))
      if (!listed.has(link.name) || (await exists(to))) continue
      const from = resolve(dir, ...posix.dirname(link.name).split('/'), ...link.target.split('/'))
      if (!(await stat(from).then((s) => s.isFile(), () => false))) {
        unresolved++
        continue
      }
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to, fsConstants.COPYFILE_EXCL)
      copies++
    }
    if (unresolved === 0) break
  }
  return { failure, at, sizes, links: new Set(links.map((link) => link.name)), copies }
}

/**
 * #1045: the verdict on a tar `mendTarFailure` mended, by the member check's own rules (#998): each member the archive
 * lists where the flatten put it (`stagedMemberKey`), less what the family leaves out (`leftOut`, removed by now) and
 * macOS metadata (never listed). A link is there as a link or as a copy of its target. Every other member must be a
 * file of exactly the size the archive gives (#1045 round 2): a member tar wrote short, on an I/O error or a full
 * drive, is there too, and would be recorded as the engine's; one the archive gives no size for, or with something
 * other than a file in its place, cannot be sized. A member whose name tar never writes where it says (absolute, or
 * with a `..` step) is not there: tar refused it. Anything missing or not whole: tar's own failure stands
 * (`mended.failure` is thrown), after a content-free log line per kind (a count and up to 20 member names).
 */
async function judgeMendedTar(
  dir: string,
  members: readonly string[],
  flattened: string,
  leftOut: ReadonlySet<string>,
  mended: MendedTar,
  opts: StageEngineOptions
): Promise<void> {
  const missing: string[] = []
  const unsized: string[] = []
  for (const member of members) {
    const key = stagedMemberKey(member, flattened)
    if (key !== null && leftOut.has(key.toLowerCase())) continue
    const st = key === null ? null : await lstat(join(dir, ...key.split('/'))).catch(() => null)
    if (!st) {
      missing.push(member)
      continue
    }
    const size = mended.sizes.get(member)
    if (size !== undefined) {
      if (!st.isFile() || st.size !== size) unsized.push(member)
    } else if (!mended.links.has(member) || (!st.isFile() && !st.isSymbolicLink())) {
      unsized.push(member)
    }
  }
  if (missing.length > 0) {
    opts.log?.('tar failed and files the archive lists are still missing after the link copies', {
      ...mended.at,
      count: missing.length,
      missing: missing.slice(0, 20)
    })
  }
  if (unsized.length > 0) {
    opts.log?.('tar failed and files the archive lists cannot be sized or are not the size it gives', {
      ...mended.at,
      count: unsized.length,
      files: unsized.slice(0, 20)
    })
  }
  if (missing.length > 0 || unsized.length > 0) throw mended.failure
  opts.log?.('tar failed, and every member the archive lists is there with its links copied', {
    ...mended.at,
    copies: mended.copies
  })
}

/**
 * Build a complete, checked, marked install of `plan` in `stagingDir` (#986), from the verified archive at
 * `plan.zipDest`, and return the plan rebased onto `stagingDir`. A leftover `stagingDir` goes first
 * (marker first; one that cannot go fails the stage). The archive is moved in (#856: tar is given only
 * `./<name>` and runs inside the folder), listed (#998: `archiveMembers`), extracted (#1045: on a drive that holds
 * no links, a tar.gz's links are made copies of their targets, `mendTarFailure`), flattened, cleared
 * of the family's left-out executables (#729), swept for escaping links (SEC-2), and deleted; then every
 * member the archive lists must be there (#998: an antivirus can take a fresh file; a listing that cannot
 * be read skips this with a log line), and every required file; the executables get their mode, EVERY
 * file of the copy is hashed into the marker (#998: the archive's members and what the folder holds; a
 * listed member that cannot be hashed fails the stage) and flushed (#1000: off the main thread), what the
 * marker records is checked once more, and the marker is written LAST, inside `stagingDir`, before anything
 * moves (W-67, lens F CE-F1). Nothing outside `stagingDir` is touched but the archive's move. Throws on any failure; the
 * caller deletes `stagingDir`. The engine job stages every step before its pause (#1000); the app-update
 * plan's install into a folder of its own (W-30, T8.5a) is meant to reuse it, without the swap.
 */
export async function stageEngineInstall(
  plan: RuntimeDownloadPlan,
  stagingDir: string,
  opts: StageEngineOptions = {}
): Promise<RuntimeDownloadPlan> {
  await engineFolderDeletesSettled()
  if (present(stagingDir) && !(await removeEngineFolder(stagingDir, opts.log))) {
    throw new EngineStepError('filesInUse', tMain('main.engine.filesInUse'))
  }
  await mkdir(stagingDir, { recursive: true })
  const staged = planInFolder(plan, stagingDir)
  await renameWithRetry(plan.zipDest, staged.zipDest)
  // #998: what the verified archive holds, read from the archive itself (as its size, #986).
  const members = await archiveMembers(staged.zipDest)
  /** #1045: a failed tar whose links were copied; the member check below gives its verdict. */
  let mended: MendedTar | null = null
  try {
    await (opts.extract ?? extractWithTar)(staged.zipDest, stagingDir, opts.signal, opts.log)
  } catch (err) {
    // #1045: a tar.gz's version links on a drive that holds none fail tar every time; their copies mend it
    // (`mendTarFailure`). Any other failure stands, and so does a tar that was stopped. The Windows archives are zips.
    if (!(err instanceof TarExitError) || opts.signal?.aborted || !TAR_GZ_NAME.test(staged.zipDest)) throw err
    mended = await mendTarFailure(staged.zipDest, stagingDir, members, err, opts)
    if (!mended) throw err
  }
  if (opts.signal?.aborted) throw new Error('engine install cancelled after the extraction')
  const flattened = await flattenNestedBinary(staged)
  // #729: what the family never keeps (`llama-connect`, the `--connect` tunnel) goes before
  // anything can start it. A file that cannot be removed fails the install like a bad archive.
  // `lstat`, not `existsSync`: a dangling link of that name must go too.
  for (const p of staged.excludedPaths) {
    const there = await lstat(p).then(
      () => true,
      () => false
    )
    await rm(p, { recursive: true, force: true, ...removeRetry() })
    if (there) opts.log?.('Left out of the engine install', { file: basename(p) })
  }
  // SEC-2 (full-audit 2026-07-12): post-extract containment sweep. The OS tar already refuses `..`
  // members and the archive hash is verified before extraction, but a SYMLINK member pointing outside
  // the install dir extracts fine and would be followed by any later read/write through it. Sweep the
  // FINAL layout (after flatten, so a relative link is checked where it will actually live) and refuse
  // the install if any link escapes. Legitimate engine archives carry no escaping links.
  await assertExtractedSymlinksContained(stagingDir)
  await rm(staged.zipDest, { force: true, ...removeRetry() })

  // #998: tar's exit code is not a completeness signal: a scanner can take a file it just saw written
  // (the silent cases: a missing `ggml-vulkan.dll` runs on the CPU and is remembered as "no graphics
  // card", missing CPU variants are blamed on the model). Every member the archive lists, where the
  // flatten put it and less what the family leaves out, must be in the copy as a file or a link (round 1:
  // a folder in a file's place fails too), or the step fails and the installed engine stays.
  /** The archive's members as the copy's keys; null when the listing could not be read. */
  let listed: Set<string> | null = null
  if (members === null) {
    opts.log?.('The engine archive could not be listed: no member check', { archive: basename(staged.zipDest) })
  } else {
    const leftOut = new Set(staged.excludedPaths.map((p) => markerBinaryKey(stagingDir, p).toLowerCase()))
    // #1045: a mended tar must also leave every regular member whole (its size), or tar's failure stands.
    if (mended) await judgeMendedTar(stagingDir, members, flattened, leftOut, mended, opts)
    listed = new Set()
    for (const member of members) {
      const key = stagedMemberKey(member, flattened)
      if (key !== null && !leftOut.has(key.toLowerCase())) listed.add(key)
    }
    const missing: string[] = []
    const notFiles: string[] = []
    for (const key of listed) {
      const st = await lstat(join(stagingDir, ...key.split('/'))).catch(() => null)
      if (!st) missing.push(key)
      else if (!st.isFile() && !st.isSymbolicLink()) notFiles.push(key)
    }
    if (missing.length > 0 || notFiles.length > 0) {
      opts.log?.('Engine extraction finished but files the archive lists are missing', {
        folder: basename(stagingDir),
        count: missing.length + notFiles.length,
        missing: missing.slice(0, 20),
        ...(notFiles.length > 0 ? { notFiles: notFiles.slice(0, 20) } : {})
      })
      throw new EngineStepError('incomplete', tMain('main.engine.extractFailed'))
    }
  }

  // #339 P8-1: the completeness check covers EVERY file the plan requires — the family's executables
  // (the code floor ∪ the yaml's `executables`) and the build's `runtime_files` — after the flatten, so
  // a tarball whose secondary executables were nested elsewhere fails loudly instead of installing half
  // a bundle. The basenames are pinned artifact names, never user content.
  const requiredFiles = requiredInstallFiles(staged)
  const missingFiles = requiredFiles.filter((p) => !existsSync(p))
  if (missingFiles.length > 0) {
    opts.log?.('Engine extraction finished but required files are missing', {
      folder: basename(stagingDir),
      missing: missingFiles.map((p) => basename(p))
    })
    throw new EngineStepError('incomplete', tMain('main.engine.binaryMissing'))
  }
  if (staged.os !== 'win') {
    for (const p of staged.binaryPaths) {
      try {
        chmodSync(p, 0o755)
      } catch {
        /* best-effort; a non-executable bit surfaces on the next start */
      }
    }
  }
  // Record every installed file's own SHA-256 so each executable can be re-hashed before spawn
  // (vuln-scan B) and the sell gate can check the runtime files too. #998: EVERY file of the copy (the
  // required ones first), so the copy's own marker says what "complete" is for it: the start's
  // recovery, the leftover guard and the swap's check (`engineFolderComplete`) and the sell gate judge
  // it by its keys, whatever a later pin lists. The keys are relative to the folder, so the ones recorded
  // here are the live folder's after the swap.
  // #998 round 1: the keys are the archive's members AND what the folder holds, so a member a scanner took
  // after the check above is not simply left out of the map. When the archive could be listed, a member
  // (or a required file) that cannot be hashed fails the step: the copy is not what the archive holds. Only
  // when it could not be listed does a required file that cannot be hashed leave the marker with NO map at
  // all (→ verifier skip-legacy; never a partial one, #339 P8-1), as before. Any other file that cannot be
  // read, or a link to something that is not a file, is not recorded (logged).
  const requiredKeys = new Set(requiredFiles.map((p) => markerBinaryKey(staged.extractTo, p)))
  const keys = new Set([...requiredKeys, ...(listed ?? []), ...(await installedFileKeys(stagingDir))])
  let binaries: Record<string, string> | undefined = {}
  for (const key of keys) {
    const p = join(stagingDir, ...key.split('/'))
    const kind = await recordedKind(p)
    let problem: string = kind
    if (kind === 'file') {
      try {
        binaries[key] = await sha256File(p)
        continue
      } catch (err) {
        problem = (err as NodeJS.ErrnoException).code ?? String(err)
      }
    } else if (kind === 'link-to-other' && !requiredKeys.has(key)) {
      opts.log?.('A link in the engine copy that is not a file is not recorded', { file: key })
      continue
    }
    if (listed !== null && (listed.has(key) || requiredKeys.has(key))) {
      opts.log?.('An engine file could not be read after the unpack', { folder: basename(stagingDir), file: key, problem })
      throw new EngineStepError('incomplete', tMain('main.engine.extractFailed'))
    }
    if (requiredKeys.has(key)) {
      opts.log?.('Could not hash the installed files for the marker', { file: key, problem })
      binaries = undefined
      break
    }
    opts.log?.('An engine file could not be read; it is not recorded', { file: key, problem })
  }
  // #986: the marker decides which copy the start trusts, so the files it covers reach the device
  // first (an exFAT stick has no journal), then the marker itself. #1000: asynchronously, file by file.
  await flushFolder(stagingDir)
  // #998 round 1: and a scanner can take a file during the hashing or the flush, so what the marker is about to
  // record is checked once more right before it is written (with no map: the required files, as above).
  const gone: string[] = []
  if (binaries) {
    for (const key of Object.keys(binaries)) {
      if ((await recordedKind(join(stagingDir, ...key.split('/')))) !== 'file') gone.push(key)
    }
  } else {
    for (const p of requiredFiles) if (!existsSync(p)) gone.push(markerBinaryKey(staged.extractTo, p))
  }
  if (gone.length > 0) {
    opts.log?.('Engine files went missing before the copy was marked', {
      folder: basename(stagingDir),
      count: gone.length,
      missing: gone.slice(0, 20)
    })
    throw new EngineStepError('incomplete', tMain('main.engine.extractFailed'))
  }
  writeRuntimeMarker(stagingDir, {
    version: plan.version,
    backend: plan.backend,
    os: plan.os,
    arch: plan.arch,
    ...(binaries ? { binaries } : {})
  })
  await flushToDeviceAsync(runtimeMarkerPath(stagingDir))
  return staged
}

/**
 * Swap a staged copy in (#986): delete a stale `.old` (marker first; Windows never renames onto an
 * existing folder, and POSIX would replace only an empty one), move the install folder to `.old` and
 * `.new` in. Each rename is tried again while Windows reports a held handle (`renameWithRetry`). A
 * stale `.old` that cannot go (a program of an earlier session still runs from it) or a refused first
 * rename fails before the install folder is touched; a refused second rename moves the old copy back.
 * Each of those is `filesInUse`, with the install folder as it was. Only when the old copy cannot be
 * moved back either are both copies kept (the install folder is gone meanwhile): the next attempt in this
 * session (its `recoverEngineFolder`) or the next start moves the new one in, so "try again" holds. A
 * cancel that landed while a stale `.old` was being deleted is honoured: `signal` is checked once more
 * right before the first rename.
 */
async function swapEngineFolder(
  dirs: EngineSwapDirs,
  log: EngineLog,
  signal?: AbortSignal,
  onFirstRename?: () => void
): Promise<void> {
  await engineFolderDeletesSettled()
  const inUse = (keepStaging = false): EngineStepError =>
    new EngineStepError('filesInUse', tMain('main.engine.filesInUse'), keepStaging)
  // #986 review 3: only a held handle is "files in use"; a drive that cannot be written (EROFS), another
  // volume (EXDEV), a full drive or a real permission refusal is the install error it is, with its own reason.
  const refused = (err: unknown, keepStaging = false): EngineStepError =>
    renameMayClear(err) ? inUse(keepStaging) : new EngineStepError('install', friendlyEngineError(err), keepStaging)
  if (present(dirs.previous) && !(await removeEngineFolder(dirs.previous, log))) throw inUse()
  if (signal?.aborted) throw new Error('engine install cancelled before the swap')
  // From here the step finishes: a cancel is too late (`EngineDownloadManager.cancel`).
  onFirstRename?.()
  const hadLive = present(dirs.live)
  if (hadLive) {
    try {
      await renameWithRetry(dirs.live, dirs.previous)
    } catch (err) {
      log?.('The installed engine could not be moved aside: nothing was replaced', { error: String(err) })
      throw refused(err)
    }
  }
  try {
    await renameWithRetry(dirs.staging, dirs.live)
  } catch (err) {
    log?.('The new engine copy could not be moved in', { error: String(err) })
    if (hadLive) {
      try {
        await renameWithRetry(dirs.previous, dirs.live)
      } catch (back) {
        log?.('The installed engine could not be moved back: both copies stay for the next attempt or start', {
          error: String(back)
        })
        throw refused(back, true)
      }
    }
    throw refused(err)
  }
}

/**
 * The `cpu/` safety net sits INSIDE the main install folder (`<os>/cpu/`), so the main build's swap moves
 * it to `.old` with the old copy (#986 gap 1). Carry it into the new copy when that has no WHOLE net
 * (`netWhole`: an empty or broken `cpu/` used to shadow the only net, which then went with `.old`; #986
 * review 2), the incomplete one deleted first. True when there was nothing to carry or it was carried;
 * false (logged) when it is still in `.old`, which must then stay for the start to carry.
 */
async function carryCpuNet(
  previous: string,
  live: string,
  log: EngineLog,
  netPlan?: RuntimeDownloadPlan
): Promise<boolean> {
  const from = join(previous, 'cpu')
  const to = join(live, 'cpu')
  if (!isRealFolder(from) || netWhole(to, netPlan)) return true
  try {
    if (present(to) && !(await removeEngineFolder(to, log))) return false
    await renameWithRetry(from, to)
    return true
  } catch (err) {
    log?.('The cpu/ safety net could not be carried into the new copy: the next start carries it', {
      error: String(err)
    })
    return false
  }
}

/** {@link carryCpuNet} on the start path: one synchronous rename, and the install folder made if gone. */
function carryCpuNetSync(
  previous: string,
  live: string,
  log: EngineLog,
  netPlan?: RuntimeDownloadPlan
): 'moved' | 'none' | 'failed' {
  const from = join(previous, 'cpu')
  const to = join(live, 'cpu')
  if (!isRealFolder(from) || netWhole(to, netPlan)) return 'none'
  try {
    if (present(to) && !removeEngineFolderSync(to, log)) return 'failed'
    mkdirSync(live, { recursive: true })
    renameSync(from, to)
    return 'moved'
  } catch (err) {
    log?.('Engine swap recovery: the cpu/ safety net could not be carried', { error: String(err) })
    return 'failed'
  }
}

/**
 * Finish or roll back the engine swaps a kill, an unplug, a sleep or a crash interrupted (#986), before
 * anything reads or starts an engine (index.ts calls it as soon as the pins are known). For every
 * family's build for this host, the main build before its nested `cpu/` net, and ONLY the exact names
 * `<live>.new` and `<live>.old` (never a pattern: the app-update plan's `<os>@<pin>/` folders beside them
 * are not this code's). "Complete" means the marker parses and every file it records is there
 * (`engineFolderComplete`, each copy by its own marker), never mere existence.
 *  - The install folder is complete: carry `.old/cpu` into it when it has no whole net (main build), then
 *    delete `.new` and `.old` (an update killed before its first rename keeps the old engine).
 *  - Else `.new` is complete: move the incomplete install folder to `.old`, move `.new` in, carry `cpu/`,
 *    delete `.old` (the swap is finished).
 *  - Else `.old` is complete: move the incomplete install folder to `.new`, move `.old` back, delete
 *    `.new` (rolled back).
 *  An incomplete copy already at that spare name is deleted first, synchronously and marker first (its
 *  `cpu/` net carried into the install folder before), so a broken install folder never stays broken.
 *  When the spare name holds a whole copy, the incomplete install folder itself is deleted (its net carried
 *  into the copy moving in first). Before carrying a net out of a copy, a net swap left inside that copy
 *  (`cpu.new`, `cpu.old`) is finished or rolled back there (#986 review 2).
 *  - Else neither copy is whole: carry `.old/cpu` (the net must not go with an incomplete `.old`), then
 *    delete `.new` and `.old`.
 * A family any of whose markers cannot be read just now (`heldEngineMarker`, T8.5c) is left as it is, net included,
 * with a warning: such a read is no verdict, and the next start decides.
 * Renames run here, synchronously, each once: a refusal is logged and the layout left as it is, never
 * made worse. Deletes run in the background, marker first. A rename refused because the drive cannot be
 * written is where the app-update plan's "run the complete copy where it lies" (CE-F10) would hook: the
 * family's resolver pointed at that copy. Not built (a non-goal of #986). An engine job runs the same
 * rule for each of its folders before it downloads, a main build's nested net folder included (#986 review). What it did goes to `log`; what it could
 * not do (a refused move or delete, a failure) to `warn` (default `log`).
 */
export function recoverEngineSwaps(
  rootPath: string,
  manifestsDir: string | null,
  opts: {
    platform?: NodeJS.Platform
    arch?: string
    log?: (msg: string, meta?: unknown) => void
    warn?: (msg: string, meta?: unknown) => void
  } = {}
): void {
  const logs: RecoveryLogs = { info: opts.log, warn: opts.warn ?? opts.log }
  // Never throws: the start goes on whatever a pin or a folder holds.
  const recover = (family: EngineFamily, plan: RuntimeDownloadPlan, main: boolean, net?: RuntimeDownloadPlan): void => {
    try {
      // #986 review 3: a copy moved in is a new program at those paths (the session cache is empty at the
      // start, but the rule is one: whatever moves a copy in drops its verdicts).
      for (const moved of recoverEngineFolder(rootPath, family, plan, main, logs, net)) {
        for (const p of moved.binaryPaths) invalidateBinaryVerification(p)
      }
    } catch (err) {
      logs.warn?.('Engine swap recovery failed', { family, error: String(err) })
    }
  }
  let engines: EnginePlan[]
  try {
    engines = availableEngines(rootPath, manifestsDir, opts.platform, opts.arch)
  } catch (err) {
    logs.warn?.('Engine swap recovery failed', { error: String(err) })
    return
  }
  for (const e of engines) {
    // T8.5c: a marker of the family's layout that cannot be read just now leaves all of it, main build and net, as it is.
    const held = heldEngineMarker(rootPath, e.plan, e.cpuNet)
    if (held) {
      logs.warn?.(HELD_MARKER_NOTE, { family: e.family, ...held })
      continue
    }
    recover(e.family, e.plan, true, e.cpuNet)
    if (e.cpuNet) recover(e.family, e.cpuNet, false)
  }
}

/** Where the recovery reports: what it did, and what it could not do. */
interface RecoveryLogs {
  info: EngineLog
  warn: EngineLog
}

function recoverEngineFolder(
  rootPath: string,
  family: EngineFamily,
  plan: RuntimeDownloadPlan,
  main: boolean,
  logs: RecoveryLogs,
  /** For a main build: its family's `cpu/` net build, to judge and resolve a net inside a copy. */
  netPlan?: RuntimeDownloadPlan
): RuntimeDownloadPlan[] {
  const { info, warn } = logs
  /** #986 review 3: the plans whose install folder now holds another copy (the caller drops their verdicts). */
  const changed: RuntimeDownloadPlan[] = []
  let dirs: EngineSwapDirs
  try {
    dirs = engineSwapDirs(rootPath, plan.extractTo)
  } catch {
    return changed
  }
  const leftovers = [dirs.staging, dirs.previous]
  if (!leftovers.some(present)) return changed
  const where = { family, folder: basename(dirs.live), backend: plan.backend }
  const whole = (dir: string): boolean => isRealFolder(dir) && engineFolderComplete(plan, dir)
  const move = (from: string, to: string): boolean => {
    try {
      renameSync(from, to)
      if (to === dirs.live && !changed.includes(plan)) changed.push(plan)
      return true
    } catch (err) {
      warn?.('Engine swap recovery: a folder could not be moved; left as it is', {
        ...where,
        from: basename(from),
        to: basename(to),
        error: String(err)
      })
      return false
    }
  }
  /**
   * Carry the `cpu/` net of `from` into `into` (main build only). A net swap left unfinished INSIDE `from`
   * (`from/cpu.new`, `from/cpu.old`) is finished or rolled back there first, so a whole net never goes with
   * `from` (#986 review 2).
   */
  const carryNet = (from: string, into: string = dirs.live): boolean => {
    if (!main) return true
    if (netPlan && isRealFolder(from)) recoverEngineFolder(rootPath, family, planInFolder(netPlan, join(from, 'cpu')), false, logs)
    const carried = carryCpuNetSync(from, into, warn, netPlan)
    if (carried === 'moved' && netPlan && !changed.includes(netPlan)) changed.push(netPlan)
    return carried !== 'failed'
  }
  /**
   * Make room for `incoming` at the install name: move an incomplete install folder to `spare`. An
   * incomplete copy already at `spare` goes first (its `cpu/` net carried into the install folder before).
   * When `spare` holds a whole copy, the incomplete install folder holds no engine and is the one to go
   * (#986 review 2: it used to be left, and every start and job after it too): its net is carried into
   * `incoming` first. Answers how the install folder went: moved to `spare`, deleted, or none was there.
   */
  const vacate = (spare: string, incoming: string): 'moved' | 'deleted' | 'none' | null => {
    if (!present(dirs.live)) return 'none'
    if (present(spare)) {
      if (whole(spare)) {
        if (!carryNet(dirs.live, incoming)) return null
        return removeEngineFolderSync(dirs.live, warn) ? 'deleted' : null
      }
      if (!carryNet(spare)) return null
      if (!removeEngineFolderSync(spare, warn)) return null
    }
    return move(dirs.live, spare) ? 'moved' : null
  }
  const drop = (dir: string): void => {
    if (present(dir)) deleteEngineFolderLater(dir, warn)
  }
  if (engineFolderComplete(plan)) {
    const carried = carryNet(dirs.previous)
    for (const dir of leftovers) if (dir !== dirs.previous || carried) drop(dir)
    info?.('Engine swap recovery: the install is complete; its leftovers are deleted', where)
    return changed
  }
  if (whole(dirs.staging)) {
    const vacated = vacate(dirs.previous, dirs.staging)
    if (vacated === null) return changed
    if (!move(dirs.staging, dirs.live)) {
      if (vacated === 'moved') move(dirs.previous, dirs.live)
      else if (whole(dirs.previous)) move(dirs.previous, dirs.live)
      return changed
    }
    const carried = carryNet(dirs.previous)
    if (carried) drop(dirs.previous)
    info?.('Engine swap recovery: the interrupted swap is finished', where)
    return changed
  }
  if (whole(dirs.previous)) {
    const vacated = vacate(dirs.staging, dirs.previous)
    if (vacated === null) return changed
    if (!move(dirs.previous, dirs.live)) {
      if (vacated === 'moved') move(dirs.staging, dirs.live)
      return changed
    }
    // A net in the incomplete folder just moved aside comes back when the restored copy has none.
    const carried = vacated === 'moved' ? carryNet(dirs.staging) : true
    if (carried) drop(dirs.staging)
    info?.('Engine swap recovery: the interrupted swap is rolled back', where)
    return changed
  }
  const carried = carryNet(dirs.previous)
  for (const dir of leftovers) if (dir !== dirs.previous || carried) drop(dir)
  info?.('Engine swap recovery: incomplete leftovers are deleted', where)
  return changed
}

/**
 * Flatten: when the binary is nested, move its directory's contents up to the extract root, where
 * services/runtime/sidecar.ts resolves it. A `cpu/` subdir is excluded from the search so a nested
 * folder of that name is never mistaken for the freshly extracted nested binary. Returns the folder it
 * emptied, relative to the root with `/` (`llama-b200`), or '' when nothing moved (#998: the archive's
 * members under it now lie at the root).
 */
async function flattenNestedBinary(plan: RuntimeDownloadPlan): Promise<string> {
  if (existsSync(plan.binaryPath)) return ''
  const binName = basename(plan.binaryPath)
  const found = await findBinary(plan.extractTo, binName, join(plan.extractTo, 'cpu'))
  if (!found) return ''
  const srcDir = join(found, '..')
  if (resolveSame(srcDir, plan.extractTo)) return ''
  for (const entry of await readdir(srcDir)) {
    await renameWithRetry(join(srcDir, entry), join(plan.extractTo, entry))
  }
  return markerBinaryKey(plan.extractTo, resolve(srcDir))
}

/**
 * Where an archive member lies in the staged copy (#998), `markerBinaryKey` form: its name without `./`
 * steps, and without the release folder the flatten emptied (`flattened`) when it sat under it. Null for a
 * name tar never writes where it says (absolute, or with a `..` step), which is then not expected.
 */
function stagedMemberKey(member: string, flattened: string): string | null {
  const parts = member.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || member.startsWith('/') || /^[A-Za-z]:/.test(member) || parts.includes('..')) return null
  const name = parts.join('/')
  return flattened && name.startsWith(`${flattened}/`) ? name.slice(flattened.length + 1) : name
}

/** What sits at a path an engine marker would record (#998 round 1): a regular file (or a link to one), or not. */
type RecordedKind = 'file' | 'link-to-other' | 'missing' | 'not-file'

async function recordedKind(p: string): Promise<RecordedKind> {
  const st = await lstat(p).catch(() => null)
  if (!st) return 'missing'
  if (st.isFile()) return 'file'
  if (!st.isSymbolicLink()) return 'not-file'
  const target = await stat(p).catch(() => null)
  return target?.isFile() ? 'file' : 'link-to-other'
}

/**
 * #998: every file of the engine copy in `dir`, `markerBinaryKey` form, sorted: files and links (a link by its
 * own name, never entered: the stage records it only when it resolves to a file, `recordedKind`), without the
 * marker, without macOS metadata (`isMacMetadataName`, round 1) and, at the top, without a nested net folder
 * (`NESTED_NET_FOLDERS`). Throws when a folder cannot be read.
 */
async function installedFileKeys(dir: string): Promise<string[]> {
  const keys: string[] = []
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!rel && (entry.name === RUNTIME_MARKER_FILE || NESTED_NET_FOLDERS.includes(entry.name))) continue
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (isMacMetadataName(key)) continue
      if (entry.isDirectory()) await walk(join(current, entry.name), key)
      else if (entry.isFile() || entry.isSymbolicLink()) keys.push(key)
    }
  }
  await walk(dir, '')
  return keys.sort()
}

/**
 * SEC-2 (full-audit 2026-07-12): walk the freshly extracted tree and throw when any
 * symlink (or Windows junction — Node reports both as symbolic links) resolves outside
 * `extractTo`. Lexical resolution via `readlink` (not `realpath`) so a BROKEN escaping
 * link is still caught, and no recursion THROUGH links (a link dirent is never a
 * directory dirent, so link cycles cannot loop the walk). The offending link is removed
 * best-effort before throwing — the install then deletes the whole staging folder (#986).
 * Exported for tests.
 */
export async function assertExtractedSymlinksContained(extractTo: string): Promise<void> {
  const root = resolve(extractTo)
  const sweep = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        // Junction targets may carry the `\\?\` long-path prefix on some Node/Windows
        // combinations; strip it so `relative` compares like with like.
        const target = (await readlink(p)).replace(/^\\\\\?\\/, '')
        const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(p), target)
        const rel = relative(root, resolved)
        const escapes = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
        if (escapes) {
          await rm(p, { force: true, recursive: false }).catch(() => undefined)
          throw new Error(`extracted archive member escapes the install dir: ${entry.name} -> ${target}`)
        }
      } else if (entry.isDirectory()) {
        await sweep(p)
      }
    }
  }
  await sweep(root)
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
