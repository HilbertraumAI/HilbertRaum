import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isHttpsUrl, isRealSha256, type DownloadSpec, type ModelManifest } from '../../shared/manifest'
import type { OcrSources, RuntimeBuild, RuntimeOs, RuntimeSources } from '../../shared/runtime-sources'
import { mmprojPath, sha256File, verifyChecksum, weightPath, type HashStore } from './models'

// Asset loader — the CANONICAL, unit-tested reference for the DIY `fetch-*` scripts
// (see docs/packaging.md).
//
// Mirrors services/drive.ts: this module holds the pure/testable planning + selection +
// verification logic, and `scripts/fetch-models.{ps1,sh}` + `scripts/fetch-runtime.
// {ps1,sh}` re-implement the SAME plan natively so a drive can be provisioned on a fresh
// machine with no Node/npm. Keep the two in sync; this file is the source of truth.
//
// NETWORK IS EXPLICIT, NEVER AUTOMATIC: the scripts run on the drive-builder's online
// machine at build time, and the in-app downloader (`downloads.ts`) drives the
// injected-`fetchImpl` seam below only after its gates pass (policy ceiling ∧ the
// default-off user setting ∧ a per-download confirmation). The app never auto-downloads.
// Planning/selection/verify here are network-free (only fs + hashing), so the vitest
// suite makes ZERO network calls.

// ---- Model download planning -------------------------------------------------------

export type ModelTaskStatus =
  | 'download' // weight absent (or mismatched) → fetch
  | 'present-verified' // present + real expected hash matches → skip
  | 'present-unverified' // present but the manifest carries a placeholder hash → skip + warn
  | 'license-blocked' // needs fetch but license not approved and no override → refuse

export interface ModelDownloadTask {
  id: string
  url: string
  /** Absolute destination on the drive (via `weightPath`, escape-guarded). */
  dest: string
  /** Drive-relative weight path (forward slashes, from the manifest). */
  relPath: string
  /** Expected SHA-256 to verify against (the manifest top-level hash). */
  expectedSha256: string
  /** True when the expected hash is still a placeholder (cannot verify after fetch). */
  placeholderHash: boolean
  sizeBytes: number | null
  license: string
  licenseUrl: string | null
  licenseApproved: boolean
  status: ModelTaskStatus
}

export interface PlanModelOptions {
  /** Fetch only this model id (the `--only` flag). */
  only?: string
  /** Override the license-review gate (the `--accept-license` flag). */
  acceptLicense?: boolean
  /** Optional persistent hash cache so a present multi-GB weight is not re-hashed. */
  hashStore?: HashStore
}

/**
 * Plan the model downloads for a drive root. Only manifests carrying a `download` block
 * are considered (the rest have no upstream source). Filesystem is read (to skip
 * present+verified weights) but the NETWORK IS NOT touched. The license gate refuses to
 * plan a fetch whose manifest `license_review.status` is not `approved` unless
 * `acceptLicense` is set; a present-but-placeholder weight is skipped with a warning.
 */
export async function planModelDownloads(
  rootPath: string,
  manifests: ModelManifest[],
  opts: PlanModelOptions = {}
): Promise<ModelDownloadTask[]> {
  const tasks: ModelDownloadTask[] = []
  for (const manifest of manifests) {
    if (opts.only && manifest.id !== opts.only) continue

    // The language GGUF (top-level `download`).
    if (manifest.download) {
      tasks.push(
        await planOneFile(
          rootPath,
          manifest,
          weightPath(rootPath, manifest),
          manifest.localPath,
          manifest.sha256,
          manifest.download,
          opts
        )
      )
    }

    // DIST-1: the mmproj projector is the SECOND DownloadJob of a vision model — same modelId,
    // its own URL/path/hash (image-understanding plan §8.3). The install side already requires
    // both files (`manifestFiles`/`computeInstallState`); without this the projector could never
    // be fetched through the planner and a vision model could never reach `installed`.
    if (manifest.mmproj?.download) {
      tasks.push(
        await planOneFile(
          rootPath,
          manifest,
          mmprojPath(rootPath, manifest),
          manifest.mmproj.localPath,
          manifest.mmproj.sha256,
          manifest.mmproj.download,
          opts
        )
      )
    }
  }
  return tasks
}

/**
 * Plan one downloadable file (the GGUF, or a vision model's mmproj projector). Shared by both
 * jobs of the two-file vision topology so the license gate + present/verified/placeholder state
 * machine has ONE definition. The license is the MODEL's (a vision projector inherits the same
 * `license_review` as its GGUF — they are one model).
 */
async function planOneFile(
  rootPath: string,
  manifest: ModelManifest,
  dest: string,
  relPath: string,
  expectedSha256: string,
  download: DownloadSpec,
  opts: PlanModelOptions
): Promise<ModelDownloadTask> {
  const placeholderHash = !isRealSha256(expectedSha256)
  const licenseApproved = manifest.licenseReview.status === 'approved'

  // Is the file already present + verifiable?
  const check = await verifyChecksum(dest, expectedSha256, opts.hashStore)
  let status: ModelTaskStatus
  if (check.exists && check.matched === true) {
    status = 'present-verified'
  } else if (check.exists && check.matched === null) {
    // Present but the manifest hash is a placeholder — can't verify, don't re-fetch.
    status = 'present-unverified'
  } else {
    // Absent, or present-but-mismatched → must (re)fetch. Gate on the license first.
    status = licenseApproved || opts.acceptLicense ? 'download' : 'license-blocked'
  }

  return {
    id: manifest.id,
    url: download.url,
    dest,
    relPath,
    expectedSha256,
    placeholderHash,
    sizeBytes: download.sizeBytes,
    license: manifest.license,
    licenseUrl: download.licenseUrl,
    licenseApproved,
    status
  }
}

// ---- Runtime build selection -------------------------------------------------------

export interface RuntimeSelector {
  os: RuntimeOs
  arch: string
  /** Optional backend override; default = the first build listed for the os/arch (vulkan/metal). */
  backend?: string
}

/**
 * Select the `llama-server` build matching the host OS/arch (and optional backend
 * override). With no backend override the FIRST os/arch match wins — runtime-sources.yaml
 * lists the DEFAULT build first per OS (the Vulkan full build on win/linux, which
 * contains every CPU backend and degrades to CPU on GPU-less machines; Metal on
 * mac). `--backend cpu` selects the pure-CPU safety-net build (`<os>/cpu/`).
 */
export function selectRuntimeBuild(
  sources: RuntimeSources,
  sel: RuntimeSelector
): RuntimeBuild | null {
  const candidates = sources.builds
    .filter((b) => b.os === sel.os)
    .filter((b) => b.arch === sel.arch)
    .filter((b) => (sel.backend ? b.backend === sel.backend : true))
  return candidates[0] ?? null
}

/**
 * Select EVERY build a shipped drive needs for one OS — the default (vulkan/metal)
 * build plus the pure-CPU safety net where one exists (architecture.md GPU record §6).
 * Used by the commercial pipeline, which must provision all of them; yaml order is
 * preserved (default first). With no arch the OS's builds are taken as listed
 * (cross-provisioning another OS's dir from the build host).
 */
export function selectRuntimeBuilds(
  sources: RuntimeSources,
  sel: { os: RuntimeOs; arch?: string }
): RuntimeBuild[] {
  return sources.builds
    .filter((b) => b.os === sel.os)
    .filter((b) => (sel.arch ? b.arch === sel.arch : true))
}

export interface RuntimeDownloadPlan {
  version: string
  os: RuntimeOs
  arch: string
  backend: string
  url: string
  /** Absolute path to download the release archive (.zip/.tar.gz) to; deleted after extraction. */
  zipDest: string
  /** Absolute dir to extract into (`runtime/llama.cpp/<os>`). */
  extractTo: string
  /** Absolute path of the extracted `llama-server[.exe]`. */
  binaryPath: string
  /** Expected SHA-256 of the zip (may be a placeholder). */
  sha256: string
  /** True when the zip hash is still a placeholder. */
  placeholderHash: boolean
}

/** Platform-specific executable name for a sidecar family's base name. */
export function sidecarBinaryName(base: string, os: RuntimeOs): string {
  return os === 'win' ? `${base}.exe` : base
}

/** Platform-specific `llama-server` executable name, keyed by the runtime-sources OS. */
export function runtimeBinaryName(os: RuntimeOs): string {
  return sidecarBinaryName('llama-server', os)
}

/** The whisper family's CLI binary (`runtime/whisper.cpp/<os>/`). */
export const WHISPER_BINARY_BASE = 'whisper-cli'

/** Resolve a drive-relative dir, rejecting `..`/absolute escapes (like `weightPath`). */
function resolveWithinRoot(rootPath: string, relPath: string): string {
  const full = join(rootPath, ...relPath.split('/'))
  const base = resolve(rootPath)
  const resolved = resolve(full)
  // A bare drive root (e.g. `D:\`) already ends in the separator, so `base + sep` would
  // double it (`D:\\`) and reject every legitimate path. Only append a separator when the
  // base does not already end in one.
  const prefix = base.endsWith(sep) ? base : base + sep
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new Error(`Path escapes the drive root: ${relPath}`)
  }
  return full
}

/**
 * Plan the runtime (sidecar) download for a selected build. Resolves the extraction dir
 * + the final binary path under the drive root (escape-guarded). No network or I/O.
 * `binaryBase` selects the sidecar family's executable: default
 * `llama-server`; the whisper family passes `whisper-cli` (`WHISPER_BINARY_BASE`).
 */
export function planRuntimeDownload(
  rootPath: string,
  build: RuntimeBuild,
  version: string,
  binaryBase = 'llama-server'
): RuntimeDownloadPlan {
  const extractTo = resolveWithinRoot(rootPath, build.extractTo)
  // Name the downloaded archive after the URL's basename so a .tar.gz (the format the
  // macOS/Linux release assets use in current llama.cpp releases) is not saved — and
  // mis-extracted — as a .zip. Synthetic fallback for URLs without a usable basename.
  const urlBase = build.url.split('/').pop()?.split('?')[0]?.trim()
  const zipDest = join(extractTo, urlBase || `${binaryBase}-${version}-${build.os}-${build.arch}.zip`)
  const binaryPath = join(extractTo, sidecarBinaryName(binaryBase, build.os))
  return {
    version,
    os: build.os,
    arch: build.arch,
    backend: build.backend,
    url: build.url,
    zipDest,
    extractTo,
    binaryPath,
    sha256: build.sha256,
    placeholderHash: !isRealSha256(build.sha256)
  }
}

// ---- OCR language files (the `ocr:` asset class) ------------------------------------

export type OcrTaskStatus = 'download' | 'present-verified' | 'present-unverified'

export interface OcrFileTask {
  lang: string
  url: string
  /** Absolute destination on the drive (escape-guarded). */
  dest: string
  /** Drive-relative destination (forward slashes, from the yaml). */
  relPath: string
  expectedSha256: string
  placeholderHash: boolean
  status: OcrTaskStatus
}

/**
 * Plan the OCR language-file downloads for a drive root. Plain verified files — no
 * extraction, no markers: idempotency IS the hash (a present file matching its real
 * sha256 is skipped; mismatched/absent is re-fetched). Filesystem read only; the
 * network is never touched here (the scripts / in-app downloader seam do the fetching).
 */
export async function planOcrDownloads(rootPath: string, ocr: OcrSources): Promise<OcrFileTask[]> {
  const tasks: OcrFileTask[] = []
  for (const file of ocr.files) {
    const dest = resolveWithinRoot(rootPath, file.dest)
    const placeholderHash = !isRealSha256(file.sha256)
    let status: OcrTaskStatus = 'download'
    if (existsSync(dest)) {
      if (placeholderHash) {
        status = 'present-unverified'
      } else {
        status = (await sha256File(dest)) === file.sha256 ? 'present-verified' : 'download'
      }
    }
    tasks.push({
      lang: file.lang,
      url: file.url,
      dest,
      relPath: file.dest,
      expectedSha256: file.sha256,
      placeholderHash,
      status
    })
  }
  return tasks
}

// ---- Verification + download (injected fetch → no real network in tests) -----------

export interface VerifyResult {
  ok: boolean
  /** The computed SHA-256 of the file. */
  actual: string | null
  /** Reason when not ok: 'missing' | 'mismatch' | 'placeholder'. */
  reason?: 'missing' | 'mismatch' | 'placeholder'
}

/**
 * Verify a downloaded file against an expected SHA-256. A placeholder expected hash is
 * NOT a pass (returns `ok:false, reason:'placeholder'`) so an unverified artifact is
 * never silently trusted — capture the real hash with `verify-models --generate`.
 */
export async function verifyDownloadedFile(
  filePath: string,
  expectedSha256: string
): Promise<VerifyResult> {
  if (!existsSync(filePath)) return { ok: false, actual: null, reason: 'missing' }
  const actual = await sha256File(filePath)
  if (!isRealSha256(expectedSha256)) return { ok: false, actual, reason: 'placeholder' }
  if (actual === expectedSha256) return { ok: true, actual }
  return { ok: false, actual, reason: 'mismatch' }
}

export type FetchFn = typeof fetch

export interface DownloadDeps {
  /** Injected fetch — tests supply a fake; production passes the global `fetch`. */
  fetchImpl?: FetchFn
  /** Progress callback (bytes received so far BY THIS CALL — excludes a resumed prefix). */
  onProgress?: (received: number) => void
  /** Abort signal — cancels the request + stream (in-app cancel). */
  signal?: AbortSignal
  /** Extra request headers (`Range` resume). */
  headers?: Record<string, string>
  /**
   * Resume mode: when true AND the server answered 206 Partial Content, the
   * response is APPENDED to `dest`; a 200 (server ignored the Range header) truncates
   * and restarts. Default false = always truncate.
   */
  append?: boolean
  /** Called once with the response metadata before any body bytes stream. */
  onResponse?: (info: { status: number; contentLength: number | null }) => void
  /**
   * D3 (vuln-scan-2026-06-21) — hard ceiling on the COMPLETE file size (bytes). Pass the
   * manifest's planned size so a redirected/hostile endpoint can't stream past it and fill the
   * drive. The effective per-response cap is the smallest of {this, the response Content-Length}
   * plus a small margin; with neither known a generous global backstop applies.
   */
  maxBytes?: number
}

export interface DownloadToFileResult {
  /** HTTP status (206 = the server honoured a `Range` request). */
  status: number
  /** Bytes written by THIS call (excludes a resumed `.part` prefix). */
  received: number
  /** The response's Content-Length (bytes in THIS response), or null when absent. */
  contentLength: number | null
}

// D3 (vuln-scan-2026-06-21) — redirect/SSRF + disk-fill hardening for `downloadToFile`.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Max redirect hops before giving up (a redirect loop / chain-to-internal-host defence). */
const MAX_REDIRECTS = 5
/** Tolerance over the known size for header rounding / multipart framing. */
const SIZE_CAP_MARGIN = 1024 * 1024
/** Backstop when NOTHING bounds the body (no Content-Length AND no caller `maxBytes`). */
const DOWNLOAD_HARD_MAX_BYTES = 64 * 1024 * 1024 * 1024

/**
 * True for a hostname that must never be a download target: loopback, RFC-1918 private ranges,
 * link-local (incl. the `169.254.169.254` cloud-metadata IP), and the IPv6 equivalents. Literal
 * host matching only (no DNS resolution — DNS-rebinding is out of scope), which is enough to stop
 * a hostile redirect `Location: http://169.254.169.254/...` or `http://router.local/`.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 127 || a === 10) return true // this-host / loopback / private
    if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
    if (a === 192 && b === 168) return true // private
    if (a === 172 && b >= 16 && b <= 31) return true // private
    return false
  }
  if (h === '::1' || h === '::') return true // IPv6 loopback / unspecified
  if (h.startsWith('fe80:')) return true // IPv6 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 unique-local fc00::/7
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isPrivateOrLoopbackHost(mapped[1])
  return false
}

/**
 * Re-validate a download URL — the INITIAL request AND every redirect target (D3). L-2: must be
 * https (cleartext leaks which asset is fetched + is downgrade-friendly); plus a loopback/
 * private-range deny so a 30x can't redirect the desktop host into an SSRF GET against its LAN.
 */
function assertSafeDownloadUrl(raw: string): void {
  if (!isHttpsUrl(raw)) {
    throw new Error(`Refusing a non-HTTPS download URL: ${raw}`)
  }
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    throw new Error(`Refusing a malformed download URL: ${raw}`)
  }
  if (isPrivateOrLoopbackHost(host)) {
    throw new Error(`Refusing a download to a private/loopback host: ${host}`)
  }
}

/**
 * Stream a URL to a destination file (creating parent dirs). This is the network seam;
 * the DIY scripts use the OS-native downloader instead, while the in-app downloader
 * (`downloads.ts`) and the tests drive this with an injected `fetchImpl`.
 * Throws on a non-OK HTTP status. Overwrites by default; see `DownloadDeps.append` for
 * the Range-resume mode (the native scripts resume via `curl -C -` instead).
 *
 * D3: redirects are followed MANUALLY (`redirect: 'manual'`) so every hop is re-validated by
 * `assertSafeDownloadUrl` (no auto-follow to http:// or a LAN/loopback address), and the body is
 * capped so a hostile endpoint can't stream unbounded bytes onto the drive.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  deps: DownloadDeps = {}
): Promise<DownloadToFileResult> {
  const doFetch = deps.fetchImpl ?? fetch
  let currentUrl = url
  let res!: Awaited<ReturnType<FetchFn>>
  for (let hop = 0; ; hop++) {
    // Re-validate scheme + host on the INITIAL URL and on EACH redirect target before fetching.
    assertSafeDownloadUrl(currentUrl)
    res = await doFetch(currentUrl, {
      redirect: 'manual',
      ...(deps.headers ? { headers: deps.headers } : {}),
      ...(deps.signal ? { signal: deps.signal } : {})
    })
    if (!REDIRECT_STATUSES.has(res.status)) break
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Download failed: too many redirects for ${url}`)
    }
    const location = res.headers?.get?.('location')
    if (!location) {
      throw new Error(`Download failed: redirect with no Location for ${currentUrl}`)
    }
    // Resolve a relative Location against the current URL; the loop re-validates it next.
    currentUrl = new URL(location, currentUrl).toString()
  }
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  }
  if (!res.body) {
    throw new Error(`Download failed: empty response body for ${url}`)
  }
  const lengthHeader = res.headers?.get?.('content-length')
  const contentLength = lengthHeader != null && /^\d+$/.test(lengthHeader)
    ? Number(lengthHeader)
    : null
  deps.onResponse?.({ status: res.status, contentLength })
  // Effective cap for THIS response body: the smallest known bound + a margin, else the global
  // backstop. (For a 206 resume, contentLength is the remaining bytes and `received` excludes the
  // on-disk prefix, so capping `received` against the smaller of the two bounds is correct.)
  const bounds: number[] = []
  if (contentLength != null) bounds.push(contentLength)
  if (typeof deps.maxBytes === 'number' && deps.maxBytes > 0) bounds.push(deps.maxBytes)
  const cap = bounds.length > 0 ? Math.min(...bounds) + SIZE_CAP_MARGIN : DOWNLOAD_HARD_MAX_BYTES
  await mkdir(dirname(dest), { recursive: true })
  // Append only when the caller asked to resume AND the server actually honoured the
  // Range request — appending a full 200 body onto a partial file would corrupt it.
  const append = deps.append === true && res.status === 206
  const out = createWriteStream(dest, { flags: append ? 'a' : 'w' })
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    // On any failure (abort, stream error, OR the size cap), close BOTH streams so no fd stays
    // open on the partial file — a later resume/rename must not contend with a stale handle.
    // `end()` (not `destroy()`) flushes the bytes that DID arrive: they are the resume prefix.
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      nodeStream.destroy()
      out.end()
      reject(err)
    }
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > cap) {
        fail(new Error(`Download exceeded the ${cap}-byte size cap for ${currentUrl}`))
        return
      }
      deps.onProgress?.(received)
    })
    nodeStream.on('error', fail)
    out.on('error', (err) => {
      nodeStream.destroy()
      fail(err)
    })
    out.on('finish', () => {
      if (!settled) resolvePromise()
    })
    nodeStream.pipe(out)
  })
  return { status: res.status, received, contentLength }
}

/**
 * Download a model weight and verify it against the manifest hash. On a verification
 * MISMATCH the partial file is removed and the call throws (mirrors the scripts'
 * delete-partial-and-fail behaviour). A placeholder hash downloads the file but reports
 * it unverified (never a silent pass). Returns the verify result.
 */
export async function fetchAndVerify(
  task: Pick<ModelDownloadTask, 'url' | 'dest' | 'expectedSha256'>,
  deps: DownloadDeps = {}
): Promise<VerifyResult> {
  await downloadToFile(task.url, task.dest, deps)
  const result = await verifyDownloadedFile(task.dest, task.expectedSha256)
  if (result.reason === 'mismatch') {
    await rm(task.dest, { force: true })
    throw new Error(
      `Checksum mismatch for ${task.url}: expected ${task.expectedSha256}, got ${result.actual}`
    )
  }
  return result
}

/** Compute the SHA-256 of an in-memory buffer (used by tests + size sanity checks). */
export function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---- Dry-run report ----------------------------------------------------------------

/** Render the asset plan (models + optional runtime) as a human-readable dry-run report. */
export function formatAssetPlan(
  modelTasks: ModelDownloadTask[],
  runtime: RuntimeDownloadPlan | null
): string {
  const lines: string[] = []
  lines.push('Model weights:')
  if (modelTasks.length === 0) {
    lines.push('  (no manifests carry a download block)')
  }
  for (const t of modelTasks) {
    const note =
      t.status === 'present-verified'
        ? 'present + verified — skip'
        : t.status === 'present-unverified'
          ? 'present (placeholder hash — cannot verify) — skip'
          : t.status === 'license-blocked'
            ? `BLOCKED: license "${t.license}" not approved (use --accept-license)`
            : t.placeholderHash
              ? `fetch (⚠ placeholder hash — verify with verify-models --generate)`
              : 'fetch + verify'
    lines.push(`  · ${t.id}  [${t.status}]`)
    lines.push(`      url:  ${t.url}`)
    lines.push(`      dest: ${t.relPath}`)
    lines.push(`      ${note}`)
  }
  lines.push('')
  lines.push('Runtime (llama.cpp sidecar):')
  if (!runtime) {
    lines.push('  (no matching build for this host — pass --os/--arch/--backend)')
  } else {
    lines.push(`  · ${runtime.os}/${runtime.arch} ${runtime.backend} @ ${runtime.version}`)
    lines.push(`      url:        ${runtime.url}`)
    lines.push(`      extract to: ${runtime.extractTo}`)
    lines.push(`      binary:     ${runtime.binaryPath}`)
    if (runtime.placeholderHash) {
      lines.push('      ⚠ placeholder hash — verify the zip hash after a real release bump')
    }
  }
  return lines.join('\n')
}

/** True when a runtime binary is already extracted at the planned path (idempotent skip). */
export function runtimeBinaryPresent(plan: RuntimeDownloadPlan): boolean {
  return existsSync(plan.binaryPath) && statSync(plan.binaryPath).isFile()
}

// ---- Runtime install marker (.hilbertraum-runtime.json) ------------------------------------
//
// "Binary exists" alone is a broken idempotency signal: upgrading a drive from the old
// CPU default to the Vulkan default would silently keep the CPU build (the binary name
// is identical). After extraction the fetchers write a marker recording exactly which
// build is installed; the skip decision requires the marker to MATCH (version + backend).
// The marker also tells the app/Diagnostics which build a drive carries.
// The fetch-runtime scripts mirror this logic natively — keep them in sync.

export const RUNTIME_MARKER_FILE = '.hilbertraum-runtime.json'

export interface RuntimeInstallMarker {
  version: string
  backend: string
  os: RuntimeOs
  arch: string
}

/** Path of the install marker inside a build's extraction dir. */
export function runtimeMarkerPath(extractTo: string): string {
  return join(extractTo, RUNTIME_MARKER_FILE)
}

/** Read + parse an install marker. Never throws: missing/malformed → null. */
export function readRuntimeMarker(extractTo: string): RuntimeInstallMarker | null {
  const path = runtimeMarkerPath(extractTo)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (
      typeof raw.version === 'string' &&
      typeof raw.backend === 'string' &&
      typeof raw.os === 'string' &&
      typeof raw.arch === 'string'
    ) {
      return {
        version: raw.version,
        backend: raw.backend,
        os: raw.os as RuntimeOs,
        arch: raw.arch
      }
    }
    return null
  } catch {
    return null
  }
}

/** Write the install marker after a successful extraction (UTF-8, single line). */
export function writeRuntimeMarker(extractTo: string, marker: RuntimeInstallMarker): void {
  writeFileSync(runtimeMarkerPath(extractTo), JSON.stringify(marker), 'utf8')
}

/**
 * Marker-based idempotency: true only when the binary is present AND the install marker
 * records the SAME version + backend as the plan. A present binary with no/stale marker
 * (e.g. a CPU-era drive being upgraded to the Vulkan default) must be re-fetched.
 */
export function runtimeInstallCurrent(plan: RuntimeDownloadPlan): boolean {
  if (!runtimeBinaryPresent(plan)) return false
  const marker = readRuntimeMarker(plan.extractTo)
  return marker !== null && marker.version === plan.version && marker.backend === plan.backend
}
