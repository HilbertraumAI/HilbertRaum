import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EffectiveReadSample } from '../../shared/types'

// Honest effective read throughput (issue #108), measured as a BYPRODUCT of the real
// multi-GB sequential reads the app already performs — never by new probe I/O:
//
//   - the model-load window: GGUF (+ mmproj) bytes over the ladder's first-rung
//     spawn-to-healthy elapsed (`LadderRuntime.start`). Later rungs re-read a file the
//     failed attempt just pulled through the page cache, so only the FIRST attempt of a
//     ladder walk is honest and only it is recorded — and a start over a file ANY hash of
//     this session already pulled through the page cache is suppressed the same way, since
//     on a big-RAM machine the load window would then read RAM and record an F-35-class
//     inflated figure. Two mechanisms, deliberately different in scope (#392): the one-shot
//     `suppressNextModelLoadSample` (the start's OWN install-state pass hashed) and the
//     per-path `checksumWarmedPaths` set below (hashed anywhere this session — the Models
//     screen, a background verify). Only the one-shot flag also skips the #114 prefetch.
//   - a checksum pass (#106): bytes hashed over elapsed — but never the verify of a file
//     the app just WROTE (the download `.part` verify reads its own dirty pages back from
//     the cache: hash-CPU speed, not media; models.ts excludes the 'download' label).
//     On fast media the SHA-256 is CPU-bound (a few hundred MB/s), so a cold checksum
//     sample can UNDER-report the medium; it therefore only ever fills absence and is
//     replaced — never the other way around — by a `model_load` sample.
//
// The 8 MB benchmark probe cannot produce this number (F-35: its read leg is served
// from the page cache — RAM speed, ~100× inflated on slow media). This figure is what
// the user actually felt: on a RAM-constrained machine even a warm start re-reads the
// full file at media speed (issue #107), and on a big-RAM machine a warm start reads
// the page cache — both are the honest effective rate of that load.
//
// Module-level session latch (precedent: `checksumCacheStats` in models.ts). The IPC
// layer persists the latest sample onto the benchmark result for THIS machine — the
// `effectiveRead` of `settings.lastBenchmark` when that is this machine's result, and of
// this machine's `settings.benchmarkHistory` entry (`persistEffectiveRead` in
// registerModelIpc, notified via the observer below so a sample recorded by ANY
// producer — including a background download's cold-file hash — persists without each
// producer remembering to call it) and injects it into `runBenchmark`
// (registerBenchmarkIpc) — this module stays free of DB/settings imports. The samples
// this module latches are always LOCAL (measured on the running computer); a persisted
// sample is only carried forward when its machine identity allows it
// (services/benchmark-persistence.ts — identity before the ranking below).

/** Below this byte count the timing is dominated by fixed costs, not throughput. */
export const MIN_READ_SAMPLE_BYTES = 64 * 1024 * 1024
/** Below this elapsed time the clock resolution + fixed costs dominate. */
export const MIN_READ_SAMPLE_MS = 250
/**
 * `model_load` samples additionally require this many bytes: the spawn-to-healthy window
 * includes non-read fixed costs (GGUF parse, KV-cache allocation, graph init), which for
 * a small model with a large context override can dominate and push the implied MB/s
 * under the #110 threshold on perfectly healthy media. At ≥ 2 GiB the read dominates on
 * every medium the warning distinguishes; smaller models still contribute honest
 * `checksum` samples.
 */
export const MIN_MODEL_LOAD_SAMPLE_BYTES = 2 * 1024 ** 3

let latest: EffectiveReadSample | null = null
/** The newest sample PER SOURCE, unranked: the Performance screen shows the last model
 *  start and the last file check side by side, where the ranked `latest` would hide a
 *  checksum behind any model-load sample. */
const latestBySource: Record<EffectiveReadSample['source'], EffectiveReadSample | null> = {
  model_load: null,
  checksum: null
}
let suppressNextModelLoad = false
/**
 * #392: absolute paths THIS process is known to have pulled through the OS page cache — a
 * completed at-or-above-floor hash (`recordChecksumRead`) or a file the app itself wrote and
 * left in place (`noteWeightWarmed`). A later model-load window over such a file measures RAM
 * on a big-RAM machine — the #108 mechanism, but the one-shot flag above only covers a start
 * whose OWN install check hashed. On the default first-run journey the Models screen hashes the
 * corpus first (#382), the start hits the size+mtime cache (`cacheHit: true`) and nothing
 * suppressed the RAM figure (#334 leg B1: 589 MB/s persisted for a 28 MB/s stick).
 * Never cleared inside the process: the page cache is OS-level and survives a workspace lock.
 * Consulted ONLY by `recordModelLoadRead`, never by the #114 prefetch peek — see the note there.
 *
 * Nothing is starved by the HASH entries: that session's `checksum` sample IS the honest figure
 * for the file. The one deliberate exception is `noteWeightWarmed` — the download verify behind
 * it is excluded from sampling by design (it reads bytes the app just wrote), so a start right
 * after an in-app download now records nothing at all. That is honest absence rather than a
 * wrong figure; the next cold start measures the medium.
 */
const checksumWarmedPaths = new Set<string>()
/**
 * Set key for a path. `resolve` normalises separators, `.`/`..` and a relative spelling, but on
 * Windows it folds neither the drive letter nor the case (`path.resolve('d:\\x')` stays `d:\x`),
 * so win32 keys are lower-cased. A junction or `subst` alias of the same file is deliberately NOT
 * `realpath`'d: both sides of every comparison descend from the one `ctx.paths.rootPath`, so this
 * is a safety net against spelling drift, not a requirement the feature rests on.
 */
const pathKey = (p: string): string =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
let observer: (() => void) | null = null
/**
 * The clock a sample's `at` comes from. A sample is identified by that ISO timestamp (millisecond
 * resolution) everywhere downstream — the persister's per-destination "already carries this
 * sample" check, the handled memo, the ranking's tie order — so two samples recorded within ONE
 * millisecond would read as one. Real loads and hashes take seconds; a test recording two in a
 * row on a fast runner does not (PR #303 P5 CI: the fast sample after a slow one was ignored
 * on ubuntu/Node 24). `nextSampleAt` therefore never hands out a repeated `at` (A-D4, below);
 * tests that need to READ specific timestamps still install a clock through the seam below.
 */
let clock: () => Date = () => new Date()
/**
 * The previous ACCEPTED sample's `at`, epoch ms (PR #303 audit A-D4). Because `at` is the
 * sample's identity, two samples must never share one: a clock that repeats or runs backwards
 * (a coarse timer, a time step, a checksum landing in the same millisecond as a model load) is
 * bumped to the previous sample's `at` + 1 ms — strictly increasing for the life of the process,
 * whatever the clock says. A sample the floors reject never advances it.
 */
let lastAcceptedAtMs: number | null = null

/** The next sample's `at`: the clock, bumped past the previous accepted sample when it repeats or runs backwards. */
function nextSampleAt(): string {
  let ms = clock().getTime()
  if (lastAcceptedAtMs != null && ms <= lastAcceptedAtMs) ms = lastAcceptedAtMs + 1
  lastAcceptedAtMs = ms
  return new Date(ms).toISOString()
}

/** MB/s from a byte count + elapsed ms (MB = 1e6 bytes), one decimal — the single
 *  definition shared with `measureDriveSpeed` (benchmark.ts imports it from here).
 *  null when the timing is unusable. */
export function throughputMbps(bytes: number, ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round((bytes / 1e6 / (ms / 1000) + Number.EPSILON) * 10) / 10
}

/**
 * The source-ranking rule, in one place (also applied by `persistEffectiveRead` against
 * each PERSISTED destination, so a fresh session's checksum sample can never overwrite
 * last session's model-load sample): a candidate loses only when it is a `checksum` sample
 * and the incumbent is a `model_load` one; otherwise the newer candidate wins. Applied
 * only among samples of the SAME machine — a foreign persisted sample is excluded before
 * this rule runs (benchmark-persistence.ts `sampleEligible`).
 */
export function preferCandidate(
  candidate: EffectiveReadSample,
  incumbent: EffectiveReadSample | null | undefined
): boolean {
  if (!incumbent) return true
  return !(candidate.source === 'checksum' && incumbent.source === 'model_load')
}

function record(
  bytes: number,
  ms: number,
  source: EffectiveReadSample['source'],
  modelId: string | null
): void {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms)) return
  if (bytes < MIN_READ_SAMPLE_BYTES || ms < MIN_READ_SAMPLE_MS) return
  const mbps = throughputMbps(bytes, ms)
  if (mbps == null) return
  const candidate: EffectiveReadSample = {
    mbps,
    bytes,
    ms: Math.round(ms),
    source,
    modelId,
    at: nextSampleAt()
  }
  latestBySource[source] = candidate
  if (preferCandidate(candidate, latest)) latest = candidate
  // The observer fires for EVERY accepted sample, including one that lost the ranked `latest`
  // selection (a checksum after a model load): the per-source latch above still moved, and the
  // Performance screen's observed rows read that one. The persister behind the observer reads
  // the ranked `latest` and applies `preferCandidate` per destination, so a lower-ranked sample
  // notifies without ever overwriting a better persisted one.
  try {
    observer?.()
  } catch {
    /* persistence is an observer concern — it must never throw into a hash/start */
  }
}


/**
 * Record a model-load window read: the window's byte total over the elapsed
 * spawn-to-healthy ms. `bytesTotal` (when the caller knows it — the manifest's full
 * file set) beats a bare `modelPath` stat, which under-counts a vision model's mmproj.
 * A stat failure records nothing; a suppressed window (the same call just hashed the
 * file — page-cache-warm) consumes the suppression and records nothing.
 *
 * #392: `weightPaths` (the same file set the #114 prefetch reads; `modelPath` when the caller
 * has no list) is checked against `checksumWarmedPaths` as well — ANY intersection suppresses.
 * A vision model whose mmproj alone was hashed counts as warm: conservative, and it costs
 * nothing, because that session's `checksum` sample is the honest figure. Unlike the one-shot
 * flag this is never consumed: every later start of a hashed weight stays suppressed.
 */
export function recordModelLoadRead(
  modelPath: string,
  ms: number,
  modelId: string | null,
  bytesTotal?: number | null,
  weightPaths?: readonly string[] | null
): void {
  const wasSuppressed = suppressNextModelLoad
  suppressNextModelLoad = false
  if (wasSuppressed) return
  const files = weightPaths?.length ? weightPaths : [modelPath]
  if (files.some((p) => checksumWarmedPaths.has(pathKey(p)))) return
  let bytes: number
  if (bytesTotal != null) {
    bytes = bytesTotal
  } else {
    try {
      bytes = statSync(modelPath).size
    } catch {
      return
    }
  }
  if (bytes < MIN_MODEL_LOAD_SAMPLE_BYTES) return
  record(bytes, ms, 'model_load', modelId)
}

/**
 * #108/F-35: the NEXT model-load window will read a file this call just pulled through
 * the page cache (a real install-state hash ran) — its elapsed would measure RAM, not
 * the medium. One-shot; consumed (or overwritten) by the next `recordModelLoadRead`.
 */
export function suppressNextModelLoadSample(): void {
  suppressNextModelLoad = true
}

/**
 * #114: peek — without consuming — whether the next model-load window follows a real
 * hash. The same fact that makes the load sample dishonest (the file is page-cache-warm)
 * makes the ladder's concurrent prefetch pointless, so `LadderRuntime.start` skips it.
 * `recordModelLoadRead` still consumes the flag afterwards.
 *
 * Deliberately tied to the ONE-SHOT flag only, never to `checksumWarmedPaths` (#392): "hashed
 * some time this session" is a weaker warmth signal than "hashed microseconds ago" — on a
 * RAM-constrained machine those pages may have been evicted since (the #107 mechanism) — and
 * the asymmetry decides. Dropping one possibly-honest load SAMPLE costs nothing (that session's
 * checksum sample is the honest figure), while skipping the PREFETCH on a cache that has gone
 * cold again forfeits the measured −49 % cold-start win on a 23.5 MB/s stick (prefetch.ts
 * header). So the sample rule is broader than the prefetch skip, on purpose.
 */
export function isNextModelLoadSuppressed(): boolean {
  return suppressNextModelLoad
}

/**
 * Record a completed full-file checksum read (#106 instrumentation feeds this — cold
 * files only; the download verify is excluded at the call site).
 *
 * `filePath` (#392) is the file that was hashed to completion (models.ts gates this call on
 * `ok`); it joins `checksumWarmedPaths` so a later model-load window over it records nothing.
 * Registered only at or above the BYTE floor: a sub-64 MiB file cannot move a ≥ 2 GiB load
 * window (under 3 % of it), and registering it would risk leaving the session with a warm mark
 * and no sample behind it. The elapsed floor is deliberately not part of the condition — a
 * floor-sized file hashed in under 250 ms was itself served from the cache, so it IS warm.
 * Null/absent for a caller that has no path — the download verify passes null on purpose (it
 * hashes a `.part` that is renamed away, so its path must never enter the set; the file's final
 * path is registered by `noteWeightWarmed` instead).
 */
export function recordChecksumRead(
  bytes: number,
  ms: number,
  modelId: string | null,
  filePath?: string | null
): void {
  if (filePath && Number.isFinite(bytes) && bytes >= MIN_READ_SAMPLE_BYTES) {
    checksumWarmedPaths.add(pathKey(filePath))
  }
  record(bytes, ms, 'checksum', modelId)
}

/**
 * #392: register a weight the APP ITSELF pulled through the page cache without hashing it as a
 * sample — today the in-app downloader, whose bytes are cache-resident from the write and whose
 * verify primes the checksum store (`finishVerifiedFile`), so nothing ever re-hashes the file
 * and no `checksum` sample exists for it. A model start right after such a download would
 * otherwise time a RAM read. Records no sample, only the warm mark: the honest figure for that
 * medium arrives at the next cold start. Absolute path expected (the file's FINAL location,
 * never the staged `.part`).
 */
export function noteWeightWarmed(filePath: string): void {
  if (filePath) checksumWarmedPaths.add(pathKey(filePath))
}

/** The latest honest sample of this session, or null before the first qualifying read. */
export function latestEffectiveRead(): EffectiveReadSample | null {
  return latest
}

/** The newest sample of ONE source this session (no ranking), or null. */
export function latestEffectiveReadBySource(
  source: EffectiveReadSample['source']
): EffectiveReadSample | null {
  return latestBySource[source]
}

/**
 * Register the single sample observer (the IPC layer's persister + Performance-screen
 * notifier). Persistence is a property of RECORDING, not of each producing call site — a
 * sample recorded by a background download's cold-file hash persists even if no model IPC
 * runs afterwards. Fires once per ACCEPTED sample of either source, whether or not it won the
 * ranked `latest` slot (see `record`). Last registration wins (one persister per process);
 * never throws into producers.
 */

export function setEffectiveReadObserver(cb: (() => void) | null): void {
  observer = cb
}

/** Test seam: the clock every recorded sample is stamped with (null restores the wall clock). */
export function setReadSpeedClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date())
}

/** Test seam: clear the session latch, the timestamp memo, both suppression mechanisms (the
 *  one-shot flag and the #392 warmed-path set), clock and observer. */
export function resetEffectiveReadForTests(): void {
  clock = () => new Date()
  lastAcceptedAtMs = null
  latest = null
  latestBySource.model_load = null
  latestBySource.checksum = null
  suppressNextModelLoad = false
  checksumWarmedPaths.clear()
  observer = null
}
