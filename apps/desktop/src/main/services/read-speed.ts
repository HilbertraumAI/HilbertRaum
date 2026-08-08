import { statSync } from 'node:fs'
import type { EffectiveReadSample } from '../../shared/types'

// Honest effective read throughput (issue #108), measured as a BYPRODUCT of the real
// multi-GB sequential reads the app already performs — never by new probe I/O:
//
//   - the model-load window: GGUF (+ mmproj) bytes over the ladder's first-rung
//     spawn-to-healthy elapsed (`LadderRuntime.start`). Later rungs re-read a file the
//     failed attempt just pulled through the page cache, so only the FIRST attempt of a
//     ladder walk is honest and only it is recorded — and a start whose install-state
//     pass just HASHED the file is suppressed the same way (`suppressNextModelLoadSample`;
//     the hash pulls the file through the page cache, so on a big-RAM machine the load
//     window would read RAM and record an F-35-class inflated figure).
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
// layer persists the latest sample onto `settings.lastBenchmark.effectiveRead`
// (registerModelIpc, notified via the observer below so a sample recorded by ANY
// producer — including a background download's cold-file hash — persists without each
// producer remembering to call it) and injects it into `runBenchmark`
// (registerBenchmarkIpc) — this module stays free of DB/settings imports.

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
let suppressNextModelLoad = false
let observer: (() => void) | null = null

/** MB/s from a byte count + elapsed ms (MB = 1e6 bytes), one decimal — the single
 *  definition shared with `measureDriveSpeed` (benchmark.ts imports it from here).
 *  null when the timing is unusable. */
export function throughputMbps(bytes: number, ms: number): number | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round((bytes / 1e6 / (ms / 1000) + Number.EPSILON) * 10) / 10
}

/**
 * The source-ranking rule, in one place (also applied by `persistEffectiveRead` against
 * the PERSISTED sample, so a fresh session's checksum sample can never overwrite last
 * session's model-load sample): a candidate loses only when it is a `checksum` sample
 * and the incumbent is a `model_load` one; otherwise the newer candidate wins.
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
    at: new Date().toISOString()
  }
  if (!preferCandidate(candidate, latest)) return
  latest = candidate
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
 */
export function recordModelLoadRead(
  modelPath: string,
  ms: number,
  modelId: string | null,
  bytesTotal?: number | null
): void {
  const wasSuppressed = suppressNextModelLoad
  suppressNextModelLoad = false
  if (wasSuppressed) return
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

/** Record a completed full-file checksum read (#106 instrumentation feeds this — cold
 *  files only; the download verify is excluded at the call site). */
export function recordChecksumRead(bytes: number, ms: number, modelId: string | null): void {
  record(bytes, ms, 'checksum', modelId)
}

/** The latest honest sample of this session, or null before the first qualifying read. */
export function latestEffectiveRead(): EffectiveReadSample | null {
  return latest
}

/**
 * Register the single sample observer (the IPC layer's persister). Persistence is a
 * property of RECORDING, not of each producing call site — a sample recorded by a
 * background download's cold-file hash persists even if no model IPC runs afterwards.
 * Last registration wins (one persister per process); never throws into producers.
 */
export function setEffectiveReadObserver(cb: (() => void) | null): void {
  observer = cb
}

/** Test seam: clear the session latch, suppression, and observer. */
export function resetEffectiveReadForTests(): void {
  latest = null
  suppressNextModelLoad = false
  observer = null
}
