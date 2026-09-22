import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { tMain } from './i18n'
import type { MessageKey } from '../../shared/i18n'
import type {
  OcrInstallJob,
  OcrInstallLanguage,
  OcrInstallStatus,
  OcrRefreshOutcome
} from '../../shared/types'
import { validateRuntimeSources, type OcrSources } from '../../shared/runtime-sources'
import {
  downloadToFile,
  planOcrDownloads,
  verifyDownloadedFile,
  type FetchFn,
  type OcrFileTask
} from './assets'
import { assertDownloadAllowed, type DownloadGates } from './downloads'
import { ocrAssetsDir } from './ocr/factory'

// In-app installer for the OCR language files (#410). OCR is deliberately NOT an engine family
// (`RuntimeFamily` / `SIDECAR_FAMILY_SPECS` are archive-shaped: download → verify → clean →
// extract → flatten → marker); the language files are a handful of plain, hash-verified files
// where the hash IS the install state. So this is its own narrow service, composed from the same
// audited parts the drive builder and the engine installer use:
//
// - WHAT is installed is anchored in CODE (`OCR_PINS`: language, sha256, exact size), drift-tested
//   against the committed `model-manifests/runtime-sources.yaml`. The drive's user-writable yaml
//   contributes ONLY the download URL of each pinned language — a yaml whose sha256 differs from
//   the pin is refused, its `dest` is ignored (the destination is always `ocr/<lang>.traineddata.gz`
//   under the drive root) and its other languages are ignored. So the yaml can at most redirect the
//   host (the accepted trust-by-location residual, security-model.md S4), never choose the bytes or
//   the path. No URL literal lives in `src/` (the R-O2 no-CDN sentinel in tests/unit/ocr.test.ts).
// - Sources: the drive's `model-manifests/` first; when that yaml offers no usable `ocr:` block
//   (none, or the file does not validate as a whole), the app-bundled copy (a bare portable exe
//   reads the bundled one anyway). Neither → unavailable. A VALID drive block that pins other
//   files is refused, never "fixed" by the fallback.
// - `planOcrDownloads` decides what to fetch, so a present file matching its pin is skipped — the
//   same hash-is-state rule `prepare-drive` / `fetch-runtime --family ocr` and the sell gate use.
// - Per file: `<dest>.part` → `downloadToFile` (https-only per hop, private-host deny, ≤5 redirects,
//   `maxBytes` = the pinned size + 1 MiB) → `verifyDownloadedFile` against the PIN → rename over
//   `<dest>` (the effective cap is the pinned size + 2 MiB: this 1 MiB headroom plus
//   `downloadToFile`'s own margin). A mismatch deletes the `.part` and leaves an existing file
//   untouched. Nothing else in `ocr/` is ever listed, deleted or modified (a user-added third
//   language survives).
// - `ocr/` is created when missing and refused when it is a symlink/junction or resolves outside the
//   drive root — checked at start and again before every write.
// - After ALL files are in place, the caller's `activate` (the engine-slot refresh,
//   `refreshOcrSlot`) runs and its outcome lands on the job; the job reaches 'done' only after it.
// - Gates are the model downloader's (`assertDownloadAllowed`: policy ceiling ∧ the allowNetwork
//   setting), re-checked on every start. One install at a time (a synchronous latch — the
//   downloads.ts precedent). Jobs live in memory for the session. Logs carry language codes, byte
//   counts and outcomes only — never URLs, paths or error text.

/** The licence of the tesseract language data (approved, docs/model-policy.md). Code-side. */
export const OCR_LICENSE = 'Apache-2.0'

/** One pinned OCR language file: what the app installs, anchored in code (#410). */
export interface OcrPin {
  /** Traineddata language code — also the file name (`<lang>.traineddata.gz`). */
  lang: string
  /** SHA-256 of the file AS DOWNLOADED (the gzip), lower-case hex. */
  sha256: string
  /** Exact byte size of that file. */
  sizeBytes: number
}

/**
 * The pinned language bundle (D6: `deu` + `eng`, installed together). Hashes = the committed
 * `runtime-sources.yaml` `ocr:` block (drift-tested); sizes measured from the pinned files
 * themselves on 2026-09-22 (`@tesseract.js-data/{deu,eng}@1.0.0`, `4.0.0_best_int` — 1.27 / 2.82 MB
 * in docs/model-policy.md "The OCR asset class").
 */
export const OCR_PINS: readonly OcrPin[] = [
  { lang: 'deu', sha256: '306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b', sizeBytes: 1_333_102 },
  { lang: 'eng', sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91', sizeBytes: 2_952_873 }
]

/** Headroom over a pinned size for the download body cap (the file is exact; this is framing). */
export const OCR_SIZE_CAP_HEADROOM = 1024 * 1024

/** The fixed, drive-relative destination of a pinned language (the yaml's `dest` is ignored). */
export function ocrPinRelPath(lang: string): string {
  return `ocr/${lang}.traineddata.gz`
}

/** Where a pinned language lands on this drive. */
function ocrPinDest(rootPath: string, lang: string): string {
  return join(ocrAssetsDir(rootPath), `${lang}.traineddata.gz`)
}

/** A user-facing refusal: the message is the localized copy for `key`. */
class OcrInstallError extends Error {
  constructor(readonly key: MessageKey) {
    super(tMain(key))
    this.name = 'OcrInstallError'
  }
}

/**
 * Validate the renderer's `ocr:install` arguments (#410): the install takes NO payload. Anything
 * but "nothing" is refused with friendly copy — the argument is never inspected further or echoed.
 */
export function assertNoOcrInstallPayload(args: readonly unknown[]): void {
  if (args.some((a) => a !== undefined)) throw new OcrInstallError('main.ocr.badRequest')
}

/** The yaml `ocr:` block of one manifests dir, or null when absent/unreadable/invalid. */
function loadOcrBlock(manifestsDir: string): OcrSources | null {
  const path = join(manifestsDir, 'runtime-sources.yaml')
  if (!existsSync(path)) return null
  try {
    const result = validateRuntimeSources(parseYaml(readFileSync(path, 'utf8')))
    return result.ok ? (result.ocr ?? null) : null
  } catch {
    return null
  }
}

export type OcrSourceResolution =
  | { kind: 'ok'; urls: ReadonlyMap<string, string> }
  | { kind: 'none' }
  | { kind: 'mismatch' }

/**
 * Where to download each pinned language from: the drive's yaml first, the app-bundled one only
 * when the drive's offers no usable `ocr:` block (none, or a file that does not validate). A
 * valid block that does not carry EVERY pinned language with the pinned sha256 is a mismatch
 * (version skew or tampering) — refused, never "fixed" by falling back. Either way the bytes are
 * the code pins': the yaml only ever chooses the host.
 */
export function resolveOcrSources(
  manifestsDir: string | null,
  bundledManifestsDir: string | null,
  pins: readonly OcrPin[] = OCR_PINS
): OcrSourceResolution {
  const dirs = [manifestsDir, bundledManifestsDir].filter(
    (d, i, all): d is string => typeof d === 'string' && d !== '' && all.indexOf(d) === i
  )
  for (const dir of dirs) {
    const block = loadOcrBlock(dir)
    if (!block) continue
    const urls = new Map<string, string>()
    for (const pin of pins) {
      const file = block.files.find((f) => f.lang === pin.lang)
      if (!file || file.sha256 !== pin.sha256) return { kind: 'mismatch' }
      urls.set(pin.lang, file.url)
    }
    return { kind: 'ok', urls }
  }
  return { kind: 'none' }
}

/** The pins as `planOcrDownloads` input: the code's hash + fixed destination, the yaml's URL. */
function pinnedSources(pins: readonly OcrPin[], urls: ReadonlyMap<string, string> | null): OcrSources {
  return {
    version: 'pinned',
    files: pins.map((pin) => ({
      lang: pin.lang,
      url: urls?.get(pin.lang) ?? '',
      sha256: pin.sha256,
      dest: ocrPinRelPath(pin.lang)
    }))
  }
}

/** The distinct hosts of the pinned URLs, for the confirmation dialog ("From"). */
function sourceHosts(urls: ReadonlyMap<string, string>): string | null {
  const hosts: string[] = []
  for (const url of urls.values()) {
    try {
      const host = new URL(url).host
      if (!hosts.includes(host)) hosts.push(host)
    } catch {
      /* the validator only admits https URLs; an unparsable one names no host */
    }
  }
  return hosts.length > 0 ? hosts.join(', ') : null
}

/**
 * Make sure `<root>/ocr` is an ordinary folder inside the drive root before anything is written
 * into it (#410): created when missing; refused when it is a symlink/junction, not a directory,
 * or resolves (realpath) outside the root. Returns the folder path.
 */
export async function prepareOcrFolder(rootPath: string): Promise<string> {
  const dir = ocrAssetsDir(rootPath)
  try {
    await lstat(dir)
  } catch {
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      throw new OcrInstallError('main.ocr.writeFailed')
    }
  }
  let unsafe = false
  try {
    const st = await lstat(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      unsafe = true
    } else {
      const [realRoot, realDir] = await Promise.all([realpath(rootPath), realpath(dir)])
      const rel = relative(realRoot, realDir)
      unsafe = rel === '' || rel.startsWith('..') || isAbsolute(rel)
    }
  } catch {
    throw new OcrInstallError('main.ocr.writeFailed')
  }
  if (unsafe) throw new OcrInstallError('main.ocr.unsafeFolder')
  return dir
}

/** Where the install sources live — the drive's manifests dir and the app-bundled one. */
export interface OcrInstallSourceOptions {
  rootPath: string
  /** The resolved (drive or env-override) `model-manifests/` dir, or null. */
  manifestsDir: string | null
  /** The app-bundled `model-manifests/` (no env override), or null. */
  bundledManifestsDir: string | null
}

export interface StartOcrInstallOptions extends OcrInstallSourceOptions {
  gates: DownloadGates
  /**
   * Bring the engine slot up to date once every file is in place (`refreshOcrSlot`). Its outcome
   * is the job's `outcome`. Expected never to reject; a rejection reads as `'startFailed'`.
   */
  activate: () => Promise<OcrRefreshOutcome>
}

export interface OcrInstallDeps {
  fetchImpl?: FetchFn
  /** Injected downloader (default `downloadToFile`) — tests capture the size cap. */
  downloadImpl?: typeof downloadToFile
  /** Injected verifier (default `verifyDownloadedFile`) — tests gate it to pin cancel-in-verify. */
  verifyImpl?: typeof verifyDownloadedFile
  /** The pinned bundle (default `OCR_PINS`); tests pass pins that hash their fake bodies. */
  pins?: readonly OcrPin[]
  /** Content-free log sink (language codes, byte counts, outcomes). */
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

const LIVE: ReadonlySet<OcrInstallJob['status']> = new Set([
  'queued',
  'downloading',
  'verifying',
  'activating'
])

const MAX_TERMINAL_JOBS = 10

/** Filesystem error codes: a download that failed on these failed on the DRIVE, not the network. */
const DISK_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY', 'EIO', 'ENOENT', 'EISDIR', 'ENOTDIR'])

function isDiskError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && DISK_ERROR_CODES.has(code)
}

/** A content-free label for a download failure (never the message — it carries the URL). */
function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (err instanceof Error && err.name === 'AbortError') return 'aborted'
  if (isDiskError(err)) return 'write'
  if (/size cap/.test(message)) return 'size-cap'
  const http = /HTTP (\d{3})/.exec(message)
  if (http) return `http-${http[1]}`
  if (/redirect/i.test(message)) return 'redirect'
  if (/Refusing/.test(message)) return 'refused-url'
  return 'network'
}

/**
 * Owns the in-app OCR install job (#410). One at a time; a single job fetches every pinned
 * language that is missing or does not match its pin, then activates the engine slot. The
 * renderer polls `get(jobId)`.
 */
export class OcrInstallManager {
  private readonly jobs = new Map<string, OcrInstallJob>()
  private active: { jobId: string; controller: AbortController } | null = null
  /** Synchronous single-flight latch over the awaits inside `start()` (the downloads.ts rule). */
  private starting = false
  /** False while a `run()` is still settling — a cancelled job's activation may still be running. */
  private runSettled = true
  private readonly pins: readonly OcrPin[]

  constructor(private readonly deps: OcrInstallDeps = {}) {
    this.pins = deps.pins ?? OCR_PINS
  }

  /**
   * What the confirmation dialog states and whether the action can be offered: per pinned
   * language its size and whether it is on the drive AND matches its pin; the bytes still to
   * download; the source host from the yaml URL; the code-side licence. Never throws.
   */
  async status(opts: OcrInstallSourceOptions): Promise<OcrInstallStatus> {
    const resolved = resolveOcrSources(opts.manifestsDir, opts.bundledManifestsDir, this.pins)
    const urls = resolved.kind === 'ok' ? resolved.urls : null
    let tasks: OcrFileTask[] = []
    try {
      tasks = await planOcrDownloads(opts.rootPath, pinnedSources(this.pins, urls))
    } catch {
      tasks = []
    }
    const languages: OcrInstallLanguage[] = this.pins.map((pin) => ({
      lang: pin.lang,
      sizeBytes: pin.sizeBytes,
      installed: tasks.find((t) => t.lang === pin.lang)?.status === 'present-verified'
    }))
    return {
      available: resolved.kind === 'ok',
      languages,
      totalBytes: languages.filter((l) => !l.installed).reduce((sum, l) => sum + l.sizeBytes, 0),
      sourceHost: urls ? sourceHosts(urls) : null,
      license: OCR_LICENSE
    }
  }

  /**
   * Check the gates and the sources, plan the files, and start the install in the background.
   * Throws a friendly, cause-specific error when a gate is closed, an install is already running,
   * no usable source list exists, every file is already in place, or `ocr/` is unsafe.
   */
  async start(opts: StartOcrInstallOptions): Promise<OcrInstallJob> {
    this.pruneTerminalJobs()
    assertDownloadAllowed(opts.gates)
    if (this.activeJob() !== null || this.starting) {
      throw new OcrInstallError('main.ocr.alreadyRunning')
    }
    this.starting = true
    try {
      const resolved = resolveOcrSources(opts.manifestsDir, opts.bundledManifestsDir, this.pins)
      if (resolved.kind === 'none') throw new OcrInstallError('main.ocr.noSources')
      if (resolved.kind === 'mismatch') throw new OcrInstallError('main.ocr.sourcesMismatch')
      let tasks: OcrFileTask[]
      try {
        // Hashes a present file — an AV lock or an ACL can make that read fail; never surface the
        // raw error (it names the drive path).
        tasks = await planOcrDownloads(opts.rootPath, pinnedSources(this.pins, resolved.urls))
      } catch {
        throw new OcrInstallError('main.ocr.readFailed')
      }
      const toFetch = tasks.filter((t) => t.status === 'download')
      if (toFetch.length === 0) throw new OcrInstallError('main.ocr.alreadyInstalled')
      await prepareOcrFolder(opts.rootPath)

      const plan = toFetch.map((task) => ({
        task,
        pin: this.pins.find((p) => p.lang === task.lang) as OcrPin
      }))
      const job: OcrInstallJob = {
        jobId: randomUUID(),
        status: 'queued',
        receivedBytes: 0,
        totalBytes: plan.reduce((sum, p) => sum + p.pin.sizeBytes, 0),
        outcome: null,
        error: null
      }
      this.jobs.set(job.jobId, job)
      const controller = new AbortController()
      this.active = { jobId: job.jobId, controller }
      this.runSettled = false
      this.deps.log?.('OCR install started', {
        jobId: job.jobId,
        languages: plan.map((p) => p.pin.lang),
        bytes: job.totalBytes
      })
      void this.run(job, plan, opts, controller).finally(() => {
        this.runSettled = true
        if (this.active?.jobId === job.jobId) this.active = null
      })
      return { ...job }
    } finally {
      this.starting = false
    }
  }

  get(jobId: string): OcrInstallJob {
    const job = this.jobs.get(jobId)
    if (job) return { ...job }
    return {
      jobId: typeof jobId === 'string' ? jobId : '',
      status: 'failed',
      receivedBytes: 0,
      totalBytes: 0,
      outcome: null,
      error: tMain('main.ocr.unknownJob')
    }
  }

  /**
   * Cancel an install in ANY live state. A cancel during a download or the hash discards that
   * file's `.part`; files already renamed into place stay (they are verified). A cancel during
   * 'activating' marks the job cancelled, but the slot refresh itself is bounded and runs to its
   * end — the renderer re-reads the app status on every terminal state, so it shows the truth.
   */
  cancel(jobId: string): OcrInstallJob {
    const job = this.jobs.get(jobId)
    if (!job) return this.get(jobId)
    if (LIVE.has(job.status)) {
      job.status = 'cancelled'
      if (this.active?.jobId === jobId) this.active.controller.abort()
      this.deps.log?.('OCR install cancelled', { jobId })
    }
    return { ...job }
  }

  /** The live job's id — also while a cancelled job's run is still settling. */
  activeJob(): string | null {
    if (!this.active) return null
    const job = this.jobs.get(this.active.jobId)
    if (!job) return null
    return LIVE.has(job.status) || !this.runSettled ? this.active.jobId : null
  }

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()].filter((j) => !LIVE.has(j.status))
    for (const job of terminal.slice(0, Math.max(0, terminal.length - MAX_TERMINAL_JOBS))) {
      this.jobs.delete(job.jobId)
    }
  }

  private fail(job: OcrInstallJob, key: MessageKey, meta: Record<string, unknown>): void {
    // A cancel that landed during the cleanup await wins: the user asked to stop.
    if (job.status === 'cancelled') return
    job.status = 'failed'
    job.error = tMain(key)
    this.deps.log?.('OCR install failed', { jobId: job.jobId, ...meta })
  }

  private async run(
    job: OcrInstallJob,
    plan: Array<{ task: OcrFileTask; pin: OcrPin }>,
    opts: StartOcrInstallOptions,
    controller: AbortController
  ): Promise<void> {
    const signal = controller.signal
    const download = this.deps.downloadImpl ?? downloadToFile
    const verify = this.deps.verifyImpl ?? verifyDownloadedFile
    // Every abort path ends here: the `.part` (if any) is removed and the job reads 'cancelled'
    // — set explicitly, because a status assignment may have raced the synchronous cancel().
    const aborted = async (part: string | null): Promise<void> => {
      if (part) await rm(part, { force: true }).catch(() => undefined)
      job.status = 'cancelled'
    }
    let doneBytes = 0
    for (const { task, pin } of plan) {
      if (signal.aborted) return aborted(null)
      const dest = ocrPinDest(opts.rootPath, pin.lang)
      const part = `${dest}.part`
      try {
        await prepareOcrFolder(opts.rootPath)
        // A planted `.part` symlink must not redirect the write: remove whatever sits there first
        // (rm unlinks a link, never its target), then the download creates a fresh file.
        await rm(part, { force: true })
      } catch (err) {
        if (signal.aborted) return aborted(null)
        const key = err instanceof OcrInstallError ? err.key : 'main.ocr.writeFailed'
        this.fail(job, key, { lang: pin.lang, reason: 'folder' })
        return
      }
      if (signal.aborted) return aborted(part)

      job.status = 'downloading'
      try {
        await download(task.url, part, {
          fetchImpl: this.deps.fetchImpl,
          signal,
          maxBytes: pin.sizeBytes + OCR_SIZE_CAP_HEADROOM,
          onProgress: (received) => {
            job.receivedBytes = doneBytes + received
          }
        })
      } catch (err) {
        if (signal.aborted) return aborted(part)
        await rm(part, { force: true }).catch(() => undefined)
        // A full or write-protected drive must not be reported as "check the internet".
        this.fail(job, isDiskError(err) ? 'main.ocr.writeFailed' : 'main.ocr.downloadFailed', {
          lang: pin.lang,
          reason: failureReason(err)
        })
        return
      }
      if (signal.aborted) return aborted(part)

      job.status = 'verifying'
      let result: Awaited<ReturnType<typeof verifyDownloadedFile>>
      try {
        result = await verify(part, pin.sha256)
      } catch {
        if (signal.aborted) return aborted(part)
        await rm(part, { force: true }).catch(() => undefined)
        this.fail(job, 'main.ocr.writeFailed', { lang: pin.lang, reason: 'verify' })
        return
      }
      if (signal.aborted) return aborted(part)
      if (!result.ok) {
        // Mismatch, missing, or (a mis-authored pin) a placeholder: never trusted. The existing
        // `<dest>` — if any — is untouched: only the `.part` is removed.
        await rm(part, { force: true }).catch(() => undefined)
        this.fail(job, 'main.ocr.checksumMismatch', {
          lang: pin.lang,
          reason: result.reason ?? 'mismatch'
        })
        return
      }

      try {
        await prepareOcrFolder(opts.rootPath)
        if (signal.aborted) return aborted(part)
        await rename(part, dest)
      } catch (err) {
        await rm(part, { force: true }).catch(() => undefined)
        if (signal.aborted) return aborted(null)
        const key = err instanceof OcrInstallError ? err.key : 'main.ocr.writeFailed'
        this.fail(job, key, { lang: pin.lang, reason: 'rename' })
        return
      }
      doneBytes += pin.sizeBytes
      job.receivedBytes = doneBytes
      this.deps.log?.('OCR language file installed', { lang: pin.lang, bytes: pin.sizeBytes })
    }
    if (signal.aborted) return aborted(null)

    // Every file is in place: bring the engine slot up to date (#410 D2). The job is 'done' only
    // after the outcome is known, so the renderer can say "ready" or "restart" definitely.
    job.status = 'activating'
    let outcome: OcrRefreshOutcome
    try {
      outcome = await opts.activate()
    } catch {
      outcome = 'startFailed'
    }
    this.deps.log?.('OCR install finished', { jobId: job.jobId, outcome, cancelled: signal.aborted })
    if (signal.aborted) return aborted(null)
    job.outcome = outcome
    job.status = 'done'
  }
}
