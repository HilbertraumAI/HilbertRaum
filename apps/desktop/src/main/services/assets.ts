import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isRealSha256, type ModelManifest } from '../../shared/manifest'
import type { RuntimeBuild, RuntimeOs, RuntimeSources } from '../../shared/runtime-sources'
import { sha256File, verifyChecksum, weightPath } from './models'

// Asset loader — the CANONICAL, unit-tested reference for the DIY `fetch-*` scripts
// (Phase 12; see docs/provisioning-and-distribution-plan.md §12 + packaging.md).
//
// Mirrors services/drive.ts: this module holds the pure/testable planning + selection +
// verification logic, and `scripts/fetch-models.{ps1,sh}` + `scripts/fetch-runtime.
// {ps1,sh}` re-implement the SAME plan natively so a drive can be provisioned on a fresh
// machine with no Node/npm. Keep the two in sync; this file is the source of truth.
//
// BUILD-TIME NETWORK, NOT RUNTIME: the actual download runs on the drive-builder's
// online machine (in the scripts, or via the injected `fetchImpl` below). The app itself
// never auto-downloads — the optional in-app path (§12.3) stays policy-gated +
// deny-by-default. Planning/selection/verify here are network-free (only fs + hashing),
// so the vitest suite makes ZERO network calls.

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
    if (!manifest.download) continue
    if (opts.only && manifest.id !== opts.only) continue

    const dest = weightPath(rootPath, manifest)
    const expectedSha256 = manifest.sha256
    const placeholderHash = !isRealSha256(expectedSha256)
    const licenseApproved = manifest.licenseReview.status === 'approved'

    // Is the weight already present + verifiable?
    const check = await verifyChecksum(dest, expectedSha256)
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

    tasks.push({
      id: manifest.id,
      url: manifest.download.url,
      dest,
      relPath: manifest.localPath,
      expectedSha256,
      placeholderHash,
      sizeBytes: manifest.download.sizeBytes,
      license: manifest.license,
      licenseUrl: manifest.download.licenseUrl,
      licenseApproved,
      status
    })
  }
  return tasks
}

// ---- Runtime build selection -------------------------------------------------------

export interface RuntimeSelector {
  os: RuntimeOs
  arch: string
  /** Optional backend override; default = the first build listed for the os/arch (vulkan/metal since Phase 14). */
  backend?: string
}

/**
 * Select the `llama-server` build matching the host OS/arch (and optional backend
 * override). With no backend override the FIRST os/arch match wins — runtime-sources.yaml
 * lists the DEFAULT build first per OS (since Phase 14 that is the Vulkan full build on
 * win/linux, which contains every CPU backend and degrades to CPU on GPU-less machines;
 * Metal on mac). `--backend cpu` selects the pure-CPU safety-net build (`<os>/cpu/`).
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
 * build plus the pure-CPU safety net where one exists (Phase 14, gpu-support-plan §9).
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

/** Platform-specific `llama-server` executable name, keyed by the runtime-sources OS. */
export function runtimeBinaryName(os: RuntimeOs): string {
  return os === 'win' ? 'llama-server.exe' : 'llama-server'
}

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
 */
export function planRuntimeDownload(
  rootPath: string,
  build: RuntimeBuild,
  version: string
): RuntimeDownloadPlan {
  const extractTo = resolveWithinRoot(rootPath, build.extractTo)
  // Name the downloaded archive after the URL's basename so a .tar.gz (the format the
  // macOS/Linux release assets use in current llama.cpp releases) is not saved — and
  // mis-extracted — as a .zip. Synthetic fallback for URLs without a usable basename.
  const urlBase = build.url.split('/').pop()?.split('?')[0]?.trim()
  const zipDest = join(extractTo, urlBase || `llama-${version}-${build.os}-${build.arch}.zip`)
  const binaryPath = join(extractTo, runtimeBinaryName(build.os))
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
  /** Progress callback (bytes received so far). */
  onProgress?: (received: number) => void
}

/**
 * Stream a URL to a destination file (creating parent dirs). This is the network seam;
 * the DIY scripts use the OS-native downloader instead, but a future in-app downloader
 * (§12.3) and the tests drive this with an injected `fetchImpl`. Throws on a non-OK HTTP
 * status. NOTE: this overwrites — resume is handled by the native scripts (`curl -C -`).
 */
export async function downloadToFile(
  url: string,
  dest: string,
  deps: DownloadDeps = {}
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(url)
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  }
  if (!res.body) {
    throw new Error(`Download failed: empty response body for ${url}`)
  }
  await mkdir(dirname(dest), { recursive: true })
  const out = createWriteStream(dest)
  let received = 0
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  await new Promise<void>((resolvePromise, reject) => {
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      deps.onProgress?.(received)
    })
    nodeStream.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolvePromise)
    nodeStream.pipe(out)
  })
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

// ---- Runtime install marker (.paid-runtime.json) ------------------------------------
//
// "Binary exists" alone is a broken idempotency signal: upgrading a drive from the old
// CPU default to the Vulkan default would silently keep the CPU build (the binary name
// is identical). After extraction the fetchers write a marker recording exactly which
// build is installed; the skip decision requires the marker to MATCH (version + backend).
// The marker also tells the app/Diagnostics which build a drive carries (Phase 16).
// The fetch-runtime scripts mirror this logic natively — keep them in sync.

export const RUNTIME_MARKER_FILE = '.paid-runtime.json'

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
