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
import { perfMark } from './perf'
import { throughputMbps } from './read-speed'
import type { ModelManifest } from '../../shared/manifest'
import type {
  BenchmarkProgressStep,
  BenchmarkResult,
  EffectiveReadSample,
  HardwareProfile,
  MemoryClass
} from '../../shared/types'
import type { ModelRuntime, RuntimeTimings } from './runtime'
import { recommendChatModelId, recommendModelId } from './models'

// Hardware benchmarker (spec §7.3, §11). Detects RAM/CPU/OS, measures drive
// read/write speed with a small temp file in the workspace, optionally estimates
// tokens/sec when a runtime is running, classifies a hardware profile, and
// recommends a chat model. STRICTLY LOCAL: only node:os + node:fs + node:crypto —
// no network, no telemetry, no child_process. Every measurement is independently
// resilient: a failed step yields a null value + a friendly warning, never a throw.

/** Tokens/sec at or below this count as "very low" and downgrade the profile one step (spec §11.3). */
export const VERY_LOW_TOKENS_PER_SECOND = 3
/** Drive WRITE throughput below this (MB/s) earns a non-blocking "slow drive" warning
 *  (spec §11.3). Calibrated against the fsync-bound write leg of the 8 MB probe; kept as
 *  the secondary check for genuinely broken media after #110 re-keyed the primary
 *  warning to the honest effective READ figure below. */
export const SLOW_DRIVE_MBPS = 30
/**
 * Effective READ throughput below this (MB/s) earns the slow-read warning (#110). The
 * felt cost of a slow drive is read-bound: every model start reads the whole GGUF at
 * media speed (on RAM-constrained machines even warm starts do — issue #107), measured
 * 88–99 s per 9B start at ~70 MB/s effective read vs 12–14 s from an SSD. 100 MB/s
 * separates the USB-stick class (~70) from SSDs (430+ measured) with margin on both
 * sides; checksum-pass samples are hash-CPU-bound at a few hundred MB/s and stay above
 * it on any healthy SSD (#108 measured 136 MB/s worst-case).
 */
export const SLOW_EFFECTIVE_READ_MBPS = 100
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

    const speed = {
      writeMbps: throughputMbps(DRIVE_PROBE_BYTES, writeMs),
      readMbps: throughputMbps(DRIVE_PROBE_BYTES, readMs)
    }
    // readMbps is the page-cache figure (F-35 above): reference only, never a drive claim.
    perfMark('drive_benchmark', speed)
    return speed
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

// `throughputMbps` (the single MB/s definition) lives in read-speed.ts — imported above
// so the probe figures and the effective-read samples can never disagree on what "MB/s"
// means. (The import direction matters: read-speed.ts is a leaf; importing this module
// from there would cycle through models.ts.)

/**
 * Prompt used for the short decode-speed probe (spec §11.2 step 7). Asks for a PARAGRAPH so the
 * `BENCHMARK_TOKEN_TARGET` cap fills reliably (#291): the earlier one-sentence prompt finished in
 * ~20 tokens, and a 20-token decode window is dominated by per-request overhead. Thinking is off
 * (balanced default), so no reasoning tokens inflate the window.
 */
export const BENCHMARK_PROMPT = 'Write a short paragraph about privacy.'
/** The `max_tokens` cap the probe sends — the decode window the figure is measured over. */
export const BENCHMARK_TOKEN_TARGET = 64

/** What the speed probe measured and how (#291). */
export interface SpeedReading {
  /** Tokens per second, one decimal. */
  tokensPerSecond: number
  /**
   * 'timings': llama-server's own `predicted_per_second` — decode only (prefill excluded),
   * TOKENS not chunks. 'chunks': the wall-clock chunk-count fallback for a runtime that sent no
   * `timings` (the mock) — approximate, includes prefill, and under-reads on an MTP model whose
   * chunks carry several tokens each.
   */
  basis: 'timings' | 'chunks'
  /** Tokens (basis 'timings') or chunks (basis 'chunks') the figure was measured over. */
  tokens: number
}

/**
 * Measure decode speed by running a short prompt through the active runtime (spec §11.2
 * step 7). Returns null when no runtime is running, so it is fully optional in the mock era.
 * Never throws.
 *
 * Since #291 the figure is the runtime's own `timings.predicted_per_second` whenever the
 * stream carries it (see `RuntimeTimings`): decode tokens over decode time — prefill and the
 * first-token latency are NOT in the window, and an MTP-accepted draft run counts as its
 * tokens, not as one chunk. Without `timings` the reading falls back to the old APPROXIMATION
 * — **stream chunks** over wall time from before the request — and says so (`basis: 'chunks'`).
 * The `VERY_LOW_TOKENS_PER_SECOND` downgrade and the §6.5 picker step-down were calibrated on
 * that chunk basis (the #153 figures); they now compare a decode-only figure, which reads
 * higher — both are order-of-magnitude gates and were deliberately NOT retuned.
 */
export async function measureTokensPerSecond(
  runtime: ModelRuntime | null | undefined,
  opts?: { signal?: AbortSignal; modelBusy?: () => boolean; onBusySkip?: () => void }
): Promise<SpeedReading | null> {
  if (!runtime) return null
  // #185: refuse to measure a CONTENDED model. The benchmark's own admission guard already
  // refused to start beside a chat answer or a document task, but the admission is followed by
  // a GPU probe and an 8 MB drive probe — seconds in which the user can send a message. A
  // reading taken while something else generates is not slow hardware, it is a shared slot, and
  // a low reading is not cosmetic: it steps the profile down (VERY_LOW_TOKENS_PER_SECOND) and
  // with it the recommended model, then PERSISTS that in `settings.lastBenchmark`. Null — the
  // same value a machine with no runtime yields — is the honest answer, and the caller turns it
  // into `warnSpeedSkipped` so the hole is never silent.
  if (opts?.modelBusy?.()) {
    opts.onBusySkip?.()
    return null
  }
  try {
    const t0 = performance.now()
    let count = 0
    let timings: RuntimeTimings | undefined
    // No early exit at the cap (#291): the server bounds the reply via `max_tokens`, and the
    // chunk that carries `timings` is the FINAL one — breaking out on the 64th chunk cancelled
    // the reader before it arrived, so the timings never reached the probe.
    for await (const _token of runtime.chatStream(
      [{ role: 'user', content: BENCHMARK_PROMPT }],
      {
        maxTokens: BENCHMARK_TOKEN_TARGET,
        signal: opts?.signal,
        onFinish: (_reason, tm) => {
          timings = tm
        }
      }
    )) {
      count++
      // …and DISCARD a reading that became contended mid-probe (a message sent while the 64
      // tokens stream). Returning runs the generator's `return()`, so the runtime manager's
      // generation gate decrements normally — an abandoned count is exactly what its epoch
      // guard exists to catch, and this path never creates one.
      if (opts?.modelBusy?.()) {
        opts.onBusySkip?.()
        return null
      }
    }
    const seconds = (performance.now() - t0) / 1000
    const tps = timings?.predicted_per_second
    if (typeof tps === 'number' && Number.isFinite(tps) && tps > 0) {
      const n = timings?.predicted_n
      return {
        tokensPerSecond: Math.round(tps * 10) / 10,
        basis: 'timings',
        tokens: typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : count
      }
    }
    if (count === 0 || seconds <= 0) return null
    return { tokensPerSecond: Math.round((count / seconds) * 10) / 10, basis: 'chunks', tokens: count }
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
  /**
   * True when the §6.5 speed signal stepped the RECOMMENDATION down one size tier
   * (model-benchmarks.md §6.5, issue #95) — computed by the caller as "RAM pick with the
   * signal ≠ RAM pick without it", so a keep (oversized crawl, no lower ranked tier) never
   * claims a step that didn't happen. Named warning needs `measuredModelId` + the figure.
   */
  recommendationLowered?: boolean
  /** The measured figure named in the recommendation-lowered warning. */
  tokensPerSecond?: number | null
  /**
   * True when the tokens/sec probe was DISCARDED because another lane was using the model
   * (#185). Distinct from a plain absent reading (no runtime at all), which stays silent —
   * this one says why the profile below has no speed input, so a re-run is an informed choice
   * rather than a mystery.
   */
  speedSkipped?: boolean
  /**
   * Honest effective read MB/s (#108/#110) — from a REAL model-load/checksum read, never
   * the probe's page-cached read leg. Gates the slow-read warning; null/absent (no
   * qualifying read yet — a fresh install) never warns. Preflight deliberately does not
   * supply it (its 8 MB probe has no honest read), so the slow-read warning can never
   * appear in the preflight note.
   */
  effectiveReadMbps?: number | null
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

  // #185: say so when the speed leg was skipped because the model was busy elsewhere. Placed
  // before the tok/s warnings below, which cannot fire in the same run (they all need a
  // measured figure), so the two never contradict each other on one card.
  if (input.speedSkipped) {
    warnings.push(t('en', 'main.benchmark.warnSpeedSkipped'))
  }

  // Issue #52: the tok/s downgrade used to be completely silent — a crawl measured on an
  // oversized loaded model shifted the profile (and with it the recommendation) without the
  // card ever naming the model that produced the number. The warning names it.
  if (input.tokensDowngraded && input.measuredModelId) {
    warnings.push(t('en', 'main.benchmark.warnVeryLowTokens', { model: input.measuredModelId }))
  }

  // Issue #95 (§6.5): the sibling warning fires when the measured crawl stepped the
  // RECOMMENDATION down one size tier — it names the measured model AND the figure, so
  // the lowered ★ pick is never a silent surprise.
  if (input.recommendationLowered && input.measuredModelId && input.tokensPerSecond != null) {
    warnings.push(
      t('en', 'main.benchmark.warnRecommendationLowered', {
        tps: input.tokensPerSecond,
        model: input.measuredModelId
      })
    )
  }

  // #110: the PRIMARY drive warning — keyed on the honest effective READ figure, which is
  // what the user actually feels (model starts read the whole file at this speed). Fires
  // independently of the probe branches below: the probe can fail while real loads still
  // produced a read sample. No sample (fresh install) → no warning, never a guess.
  if (input.effectiveReadMbps != null && input.effectiveReadMbps < SLOW_EFFECTIVE_READ_MBPS) {
    warnings.push(slowReadWarning(input.effectiveReadMbps))
  }

  if (input.driveError) {
    warnings.push(t('en', 'main.benchmark.warnDriveProbe'))
  } else if (input.driveWriteMbps != null && input.driveWriteMbps < SLOW_DRIVE_MBPS) {
    // F-35 (audit 2026-07-16): gate on the fsync-bound WRITE figure only — the probe's read
    // leg is page-cache-served (RAM speed) and never gates anything. Since #110 this write
    // gate is the SECONDARY check (genuinely broken media: fsync writes below 30 MB/s);
    // the primary felt-cost warning is the effective-read gate above.
    warnings.push(t('en', 'main.benchmark.warnSlowDrive'))
  }

  return warnings
}

/** The canonical slow-read warning string for a measured MB/s (#110). Math.floor, not
 *  round: a 99.6 sample must not warn "about 100 MB/s" while the gate documents
 *  "< 100" — the named figure always satisfies the condition the copy claims. */
function slowReadWarning(effectiveReadMbps: number): string {
  return t('en', 'main.benchmark.warnSlowRead', { mbps: Math.floor(effectiveReadMbps) })
}

/** Matches any persisted slow-read warning (whatever `{mbps}` it named) — the main-side
 *  twin of the renderer display map's template regex. */
const SLOW_READ_WARNING_RE = new RegExp(
  `^${t('en', 'main.benchmark.warnSlowRead', { mbps: '@@MBPS@@' })
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('@@MBPS@@', '\\d+')}$`
)

/**
 * Re-key the ONE warning that tracks `effectiveRead` against a fresh sample (#110):
 * drop any previously persisted slow-read warning and append the current one when the
 * sample is below the gate. `buildWarnings` computes the full set only at benchmark
 * time, but the sample is updated in place between runs (`persistEffectiveRead`) — on
 * the default journey the ONLY automatic benchmark runs before any model exists, so
 * without this the primary #110 warning would never appear (and a stale one could
 * contradict the freshly updated Diagnostics row above it). All other warnings are
 * benchmark-time facts and pass through untouched.
 */
export function upsertSlowReadWarning(warnings: string[], effectiveReadMbps: number): string[] {
  const kept = warnings.filter((w) => !SLOW_READ_WARNING_RE.test(w))
  if (effectiveReadMbps < SLOW_EFFECTIVE_READ_MBPS) kept.push(slowReadWarning(effectiveReadMbps))
  return kept
}

/** The GPU probe summary INJECTED into the benchmark (architecture.md GPU record §5.1/§8). */
export interface GpuBenchmarkInput {
  /** Display name of the primary probed device (→ `BenchmarkResult.gpu`). */
  name: string | null
  /** Pre-computed bump eligibility (`gpuUsefulForProfile` over the probed devices). */
  useful: boolean
  /** Total memory of the primary device in MiB (→ `BenchmarkResult.gpuVramMb`); absent/null = unknown. */
  totalMb?: number | null
  /**
   * The computer's memory class (services/performance.ts `memoryClassOf`): 'discrete' makes
   * the chat pick graphics-memory-best-fit (§6.6); absent → 'cpu', the RAM pick.
   */
  memoryClass?: MemoryClass
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
  /**
   * Latest honest effective-read sample (issue #108), injected by the caller
   * (registerBenchmarkIpc reads the session latch in services/read-speed.ts, falling
   * back to the previously persisted sample so a re-run never loses it). NEVER measured
   * in here — the sample is a byproduct of real model loads / checksum passes, and this
   * module keeps its zero-`child_process`, probe-only I/O posture.
   */
  effectiveRead?: EffectiveReadSample | null
  /**
   * True while ANOTHER lane is using the chat model (#185) — injected by the caller
   * (registerBenchmarkIpc binds it to `modelBusyLane`, ignoring the benchmark's own span).
   * Consulted immediately before the tokens/sec probe and again on every streamed chunk: a
   * contended reading measures a shared slot, not this computer, and it would be PERSISTED as
   * a stepped-down profile + recommendation. Absent ⇒ measure unconditionally (today's
   * behavior for every non-IPC caller, including the preflight harnesses).
   */
  modelBusy?: () => boolean
  /** Injectable clock for deterministic `ranAt` in tests. */
  now?: () => Date
  /**
   * Called as each step completes ('system', 'drive', then 'speed' ONLY when a runtime was
   * up to measure, then 'done'). The IPC layer forwards it to the renderer that started the
   * run so the Performance screen can show the steps; the first-run path passes nothing.
   * Never awaited, and a throwing callback never fails the run.
   */
  onProgress?: (step: BenchmarkProgressStep) => void
}

function report(deps: RunBenchmarkDeps, step: BenchmarkProgressStep): void {
  try {
    deps.onProgress?.(step)
  } catch {
    /* progress is a courtesy to the UI — never the run's problem */
  }
}

/**
 * Run the full benchmark and assemble a BenchmarkResult (spec §9.1 `runBenchmark`).
 * Orchestrates detection + drive probe + (optional) tokens/sec + classification +
 * recommendation + warnings. Resilient end-to-end: a machine where every measurement
 * fails still yields a valid (UNKNOWN) result.
 */
export async function runBenchmark(deps: RunBenchmarkDeps): Promise<BenchmarkResult> {
  const sys = detectSystem()
  report(deps, 'system')
  const drive = await measureDriveSpeed(deps.workspacePath)
  report(deps, 'drive')
  // #185: `speedSkipped` distinguishes "no runtime was up, nothing to measure" (silent, the
  // long-standing behavior) from "a runtime WAS up but something else was using it" (warned).
  let speedSkipped = false
  const reading = await measureTokensPerSecond(deps.runtime ?? null, {
    modelBusy: deps.modelBusy,
    onBusySkip: () => {
      speedSkipped = true
    }
  })
  if (deps.runtime) report(deps, 'speed')
  const tokensPerSecond = reading?.tokensPerSecond ?? null
  // #291: HOW the figure was measured — the runtime's decode timings, or the chunk fallback —
  // plus the token/chunk count it covers, so the card can mark a fallback as approximate.
  const speedBasis = reading ? { basis: reading.basis, tokens: reading.tokens } : null
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
  // could not be detected. The §6.5 speed signal (issue #95) applies with the
  // just-measured values — the SAME rule listModels applies with the persisted ones,
  // so the Diagnostics card and the Models screen ★ agree within one run.
  const ramRounded = Math.round(sys.ramGb)
  const speedSignal = { tokensPerSecond, measuredModelId }
  // §6.6: on a discrete card the pick is by graphics memory (the model has to fit the card
  // to run at card speed); unified memory and no-card machines keep the RAM pick.
  const memory = {
    memoryClass: deps.gpu?.memoryClass ?? 'cpu',
    ramGb: ramRounded,
    vramMb: deps.gpu?.totalMb ?? null
  } as const
  const ramPick = recommendChatModelId(deps.manifests, memory, speedSignal)
  // Did the signal actually move the pick? Feeds the named §6.5 warning below.
  const recommendationLowered = ramPick !== recommendChatModelId(deps.manifests, memory)
  const recommendedModelId = ramPick ?? recommendModelId(deps.manifests, profile, 'chat')
  const warnings = buildWarnings({
    profile,
    driveReadMbps: drive.readMbps,
    driveWriteMbps: drive.writeMbps,
    driveError: drive.error,
    tokensDowngraded,
    measuredModelId,
    recommendationLowered,
    tokensPerSecond,
    speedSkipped,
    effectiveReadMbps: deps.effectiveRead?.mbps ?? null
  })

  report(deps, 'done')
  return {
    os: sys.os,
    arch: sys.arch,
    cpuModel: sys.cpuModel,
    cpuCores: sys.cpuCores,
    ramGb: sys.ramGb,
    gpu: gpuName,
    gpuVramMb: deps.gpu?.totalMb ?? null,
    driveReadMbps: drive.readMbps,
    driveWriteMbps: drive.writeMbps,
    tokensPerSecond,
    speedBasis,
    measuredModelId,
    effectiveRead: deps.effectiveRead ?? null,
    profile,
    recommendedModelId,
    warnings,
    ranAt: (deps.now?.() ?? new Date()).toISOString()
  }
}
