import { arch as osArch, cpus, platform as osPlatform, totalmem } from 'node:os'
import {
  closeSync,
  fsyncSync,
  openSync,
  readSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomFillSync } from 'node:crypto'
import { t } from '../../shared/i18n'
import type { ModelManifest } from '../../shared/manifest'
import type { BenchmarkResult, HardwareProfile } from '../../shared/types'
import type { ModelRuntime } from './runtime'
import { recommendModelId, recommendModelIdByRam } from './models'

// Hardware benchmarker (spec §7.3, §11). Detects RAM/CPU/OS, measures drive
// read/write speed with a small temp file in the workspace, optionally estimates
// tokens/sec when a runtime is running, classifies a hardware profile, and
// recommends a chat model. STRICTLY LOCAL: only node:os + node:fs + node:crypto —
// no network, no telemetry, no child_process. Every measurement is independently
// resilient: a failed step yields a null value + a friendly warning, never a throw.

/** Tokens/sec at or below this count as "very low" and downgrade the profile one step (spec §11.3). */
export const VERY_LOW_TOKENS_PER_SECOND = 3
/** Drive throughput below this (MB/s) earns a non-blocking "slow drive" warning (spec §11.3). */
export const SLOW_DRIVE_MBPS = 30
/** Size of the temp file written to probe drive speed. Small + bounded so the UI never hangs. */
export const DRIVE_PROBE_BYTES = 8 * 1024 * 1024 // 8 MB
/** Bytes per gigabyte (GiB) used to convert total memory for classification + display. */
const BYTES_PER_GB = 1024 ** 3

const PROFILE_STEPS = ['TINY', 'LITE', 'BALANCED', 'PRO'] as const

export interface SystemInfo {
  os: string
  arch: string
  cpuModel: string
  cpuCores: number
  /** Total physical RAM in GiB (0 when detection fails). */
  ramGb: number
  /** Best-effort GPU description; null on this machine (no network/native probe). */
  gpu: string | null
}

/**
 * Detect OS / arch / CPU / RAM via Node built-ins only. Never throws: any failing
 * probe falls back to a safe default (empty string / 0 / null) so the caller still
 * gets a well-formed SystemInfo that classifies to a valid profile.
 */
export function detectSystem(): SystemInfo {
  let os = ''
  let arch = ''
  let cpuModel = ''
  let cpuCores = 0
  let ramGb = 0
  try {
    os = osPlatform()
  } catch {
    /* keep default */
  }
  try {
    arch = osArch()
  } catch {
    /* keep default */
  }
  try {
    const list = cpus()
    cpuCores = Array.isArray(list) ? list.length : 0
    cpuModel = list?.[0]?.model?.trim() ?? ''
  } catch {
    /* keep defaults */
  }
  try {
    const bytes = totalmem()
    ramGb = bytes > 0 ? Math.round((bytes / BYTES_PER_GB) * 10) / 10 : 0
  } catch {
    /* keep default */
  }
  // GPU detection stays out of this module (zero `child_process` — see header): the
  // real probe (`runtime/gpu.ts` `--list-devices`) runs in the IPC layer and is
  // INJECTED via `RunBenchmarkDeps.gpu`; detectSystem itself always reports null.
  return { os, arch, cpuModel, cpuCores, ramGb, gpu: null }
}

export interface ClassifyHints {
  /** Measured tokens/sec, if a runtime ran. */
  tokensPerSecond?: number | null
  /**
   * True only when the probed GPU passes the conservative gate (≥ 6 GiB VRAM and not
   * integrated-looking — see `gpuUsefulForProfile` in runtime/gpu.ts). Deliberately
   * NOT "any truthy gpu string bumps": an Iris Xe reporting shared RAM must never
   * push a laptop into a bigger model.
   */
  gpuUseful?: boolean
}

/**
 * Map RAM (GiB) + hints to a hardware profile (spec §11.3 pseudocode):
 *   ≤8 → TINY, ≤16 → LITE, ≤32 → BALANCED, else PRO.
 * A useful GPU bumps one step toward PRO; very low tokens/sec downgrades one step
 * (never below TINY). Invalid RAM (detection failure) → UNKNOWN.
 */
export function classifyProfile(ramGb: number, hints: ClassifyHints = {}): HardwareProfile {
  if (!Number.isFinite(ramGb) || ramGb <= 0) return 'UNKNOWN'

  let idx = ramGb <= 8 ? 0 : ramGb <= 16 ? 1 : ramGb <= 32 ? 2 : 3
  if (hints.gpuUseful === true) idx = Math.min(idx + 1, PROFILE_STEPS.length - 1)
  const tps = hints.tokensPerSecond
  if (tps != null && tps > 0 && tps < VERY_LOW_TOKENS_PER_SECOND) {
    idx = Math.max(idx - 1, 0)
  }
  return PROFILE_STEPS[idx]
}

export interface DriveSpeed {
  readMbps: number | null
  writeMbps: number | null
  /** Set when the probe failed (drive not measurable); the values are then null. */
  error?: string
}

/**
 * Measure sequential write then read throughput by round-tripping a small temp file
 * INSIDE the workspace (always writable + self-contained). The file is always removed,
 * even on error (try/finally), and the probe is bounded (DRIVE_PROBE_BYTES) so it never
 * hangs the UI. A failure returns null Mbps + an error string rather than throwing.
 */
export async function measureDriveSpeed(workspacePath: string): Promise<DriveSpeed> {
  const file = join(workspacePath, `.hilbertraum-benchmark-${process.pid}-${Date.now()}.tmp`)
  const payload = Buffer.allocUnsafe(DRIVE_PROBE_BYTES)
  randomFillSync(payload) // avoid filesystem compression skewing the numbers
  try {
    // ---- write ----
    const wfd = openSync(file, 'w')
    let writeMs: number
    try {
      const t0 = performance.now()
      writeSync(wfd, payload, 0, payload.length, 0)
      fsyncSync(wfd) // flush to the device so we time real I/O, not the page cache
      writeMs = performance.now() - t0
    } finally {
      closeSync(wfd)
    }

    // ---- read ----
    // F-35 (audit 2026-07-16): this reads back the 8 MB file we JUST wrote, which is still resident in
    // the OS page cache (fsync flushes dirty pages to the device but does NOT evict them), so the timing
    // reflects RAM, not the drive — readMbps runs ~100× inflated on slow media. node:fs exposes no
    // unbuffered/cache-bypassing read, so a genuine cold read is not measurable here. Kept as a rough
    // "(cached)" figure (labelled as such in Diagnostics); the honest drive signal is the fsync-bound
    // WRITE leg, which is what buildWarnings gates the slow-drive warning on.
    const rfd = openSync(file, 'r')
    let readMs: number
    try {
      const dest = Buffer.allocUnsafe(DRIVE_PROBE_BYTES)
      const t1 = performance.now()
      readSync(rfd, dest, 0, dest.length, 0)
      readMs = performance.now() - t1
    } finally {
      closeSync(rfd)
    }

    return {
      writeMbps: throughputMbps(DRIVE_PROBE_BYTES, writeMs),
      readMbps: throughputMbps(DRIVE_PROBE_BYTES, readMs)
    }
  } catch (err) {
    return { readMbps: null, writeMbps: null, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
      /* best-effort cleanup; the temp file lives under the workspace either way */
    }
  }
}

/** MB/s from a byte count + elapsed ms (MB = 1e6 bytes). null when the timing is unusable. */
function throughputMbps(bytes: number, ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round(((bytes / 1e6 / (ms / 1000)) + Number.EPSILON) * 10) / 10
}

/** Prompt used for the short tokens/sec probe (spec §11.2 step 7). */
export const BENCHMARK_PROMPT = 'Write one sentence about privacy.'
/** How many tokens to time before stopping the probe. */
export const BENCHMARK_TOKEN_TARGET = 64

/**
 * Estimate tokens/sec by running a short prompt through the active runtime
 * (spec §11.2 step 7). Returns null when no runtime is running, so it is fully
 * optional in the mock era. Never throws.
 *
 * APPROXIMATION: this counts **stream chunks**, not true tokens — one `chatStream`
 * yield is one mock word-fragment or one real SSE delta (which may be sub- or
 * multi-token), so the number is a coarse "throughput", not an exact token rate. It feeds
 * the `VERY_LOW_TOKENS_PER_SECOND` downgrade, which only needs an order-of-magnitude signal.
 */
export async function measureTokensPerSecond(
  runtime: ModelRuntime | null | undefined,
  opts?: { signal?: AbortSignal }
): Promise<number | null> {
  if (!runtime) return null
  try {
    const t0 = performance.now()
    let count = 0
    for await (const _token of runtime.chatStream(
      [{ role: 'user', content: BENCHMARK_PROMPT }],
      { maxTokens: BENCHMARK_TOKEN_TARGET, signal: opts?.signal }
    )) {
      count++
      if (count >= BENCHMARK_TOKEN_TARGET) break
    }
    const seconds = (performance.now() - t0) / 1000
    if (count === 0 || seconds <= 0) return null
    return Math.round((count / seconds) * 10) / 10
  } catch {
    return null
  }
}

export interface WarningInputs {
  profile: HardwareProfile
  driveReadMbps: number | null
  driveWriteMbps: number | null
  driveError?: string
  /**
   * True when the very-low tokens/sec reading ACTUALLY stepped the profile down (issue #52) —
   * computed by the caller as "profile with the tps hint ≠ profile without it", so a TINY
   * machine (which can't go lower) never claims a downgrade that didn't happen.
   */
  tokensDowngraded?: boolean
  /** Model the tokens/sec probe streamed through — named in the downgrade warning (issue #52). */
  measuredModelId?: string | null
}

/**
 * Build the user-facing warnings (spec §11.3 + §11.4). Always encouraging, never
 * judgmental — weak hardware is framed as "best suited for the smallest, quickest model", never
 * "your hardware is bad". Slow drives warn but do not block.
 *
 * Persist-canonical English (i18n record §3.3 rule 1): these warnings are persisted
 * inside `settings.lastBenchmark` (BenchmarkResult.warnings), so they are written as
 * the explicit ENGLISH catalog values — the renderer display map translates them at
 * display time (D-L4). Preflight reuses the slow-drive warning the same way.
 */
export function buildWarnings(input: WarningInputs): string[] {
  const warnings: string[] = []

  if (input.profile === 'TINY') {
    warnings.push(t('en', 'main.benchmark.warnTiny'))
  } else if (input.profile === 'UNKNOWN') {
    warnings.push(t('en', 'main.benchmark.warnUnknown'))
  }

  // Issue #52: the tok/s downgrade used to be completely silent — a crawl measured on an
  // oversized loaded model shifted the profile (and with it the recommendation) without the
  // card ever naming the model that produced the number. The warning names it.
  if (input.tokensDowngraded && input.measuredModelId) {
    warnings.push(t('en', 'main.benchmark.warnVeryLowTokens', { model: input.measuredModelId }))
  }

  if (input.driveError) {
    warnings.push(t('en', 'main.benchmark.warnDriveProbe'))
  } else if (input.driveWriteMbps != null && input.driveWriteMbps < SLOW_DRIVE_MBPS) {
    // F-35 (audit 2026-07-16): gate on the fsync-bound WRITE figure only. The read probe reads back a
    // page-cached file (RAM speed, ~100× inflated on slow media), so a `min(read, write)` gate never
    // fired on the read leg anyway — using write alone makes the code match the honest "(cached)" read
    // label and the documented "write < SLOW_DRIVE_MBPS" condition (benchmark.md).
    warnings.push(t('en', 'main.benchmark.warnSlowDrive'))
  }

  return warnings
}

/** The GPU probe summary INJECTED into the benchmark (architecture.md GPU record §5.1/§8). */
export interface GpuBenchmarkInput {
  /** Display name of the primary probed device (→ `BenchmarkResult.gpu`). */
  name: string | null
  /** Pre-computed bump eligibility (`gpuUsefulForProfile` over the probed devices). */
  useful: boolean
}

export interface RunBenchmarkDeps {
  /** Workspace directory the drive probe writes its temp file into. */
  workspacePath: string
  /** Manifests used to resolve the recommended chat model for the detected profile. */
  manifests: ModelManifest[]
  /** Active runtime for the optional tokens/sec probe; null/undefined → skipped. */
  runtime?: ModelRuntime | null
  /**
   * GPU probe summary, injected by the caller (registerBenchmarkIpc runs the cached
   * `--list-devices` probe). NEVER probed in here — this module keeps its zero-
   * `child_process` purity (and with it the strictly-local guarantee).
   */
  gpu?: GpuBenchmarkInput | null
  /** Injectable clock for deterministic `ranAt` in tests. */
  now?: () => Date
}

/**
 * Run the full benchmark and assemble a BenchmarkResult (spec §9.1 `runBenchmark`).
 * Orchestrates detection + drive probe + (optional) tokens/sec + classification +
 * recommendation + warnings. Resilient end-to-end: a machine where every measurement
 * fails still yields a valid (UNKNOWN) result.
 */
export async function runBenchmark(deps: RunBenchmarkDeps): Promise<BenchmarkResult> {
  const sys = detectSystem()
  const drive = await measureDriveSpeed(deps.workspacePath)
  const tokensPerSecond = await measureTokensPerSecond(deps.runtime ?? null)
  // Issue #52: record WHICH model produced the tok/s number — the currently loaded one,
  // which is often not the recommended one. null whenever nothing was measured.
  const measuredModelId = tokensPerSecond != null ? (deps.runtime?.modelId ?? null) : null

  const gpuName = deps.gpu?.name ?? sys.gpu
  const gpuUseful = deps.gpu?.useful ?? false
  const profile = classifyProfile(sys.ramGb, { tokensPerSecond, gpuUseful })
  // Issue #52: did the tok/s reading actually move the profile? (A TINY machine can't go
  // lower, so "tps < threshold" alone would over-claim.) Feeds the named downgrade warning.
  const tokensDowngraded = profile !== classifyProfile(sys.ramGb, { gpuUseful })
  // RAM-best-fit first — rounded to whole GB, the SAME rounding the Models screen's
  // gate uses (`machineRamGb`), so the two surfaces can never disagree at boundary
  // values like 15.7 GiB. The profile-table lookup remains the fallback when RAM
  // could not be detected.
  const recommendedModelId =
    recommendModelIdByRam(deps.manifests, Math.round(sys.ramGb), 'chat') ??
    recommendModelId(deps.manifests, profile, 'chat')
  const warnings = buildWarnings({
    profile,
    driveReadMbps: drive.readMbps,
    driveWriteMbps: drive.writeMbps,
    driveError: drive.error,
    tokensDowngraded,
    measuredModelId
  })

  return {
    os: sys.os,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    cpuCores: sys.cpuCores,
    ramGb: sys.ramGb,
    gpu: gpuName,
    driveReadMbps: drive.readMbps,
    driveWriteMbps: drive.writeMbps,
    tokensPerSecond,
    measuredModelId,
    profile,
    recommendedModelId,
    warnings,
    ranAt: (deps.now?.() ?? new Date()).toISOString()
  }
}
