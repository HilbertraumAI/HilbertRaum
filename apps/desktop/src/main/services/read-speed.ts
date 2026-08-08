import { statSync } from 'node:fs'
import type { EffectiveReadSample } from '../../shared/types'

// Honest effective read throughput (issue #108), measured as a BYPRODUCT of the real
// multi-GB sequential reads the app already performs — never by new probe I/O:
//
//   - the model-load window: GGUF file size over the ladder's first-rung
//     spawn-to-healthy elapsed (`LadderRuntime.start`). Later rungs re-read a file the
//     failed attempt just pulled through the page cache, so only the FIRST attempt of a
//     ladder walk is honest and only it is recorded.
//   - a checksum pass (#106): bytes hashed over elapsed. On fast media the SHA-256 is
//     CPU-bound (a few hundred MB/s), so a checksum sample can UNDER-report the medium;
//     it therefore only ever fills absence and is replaced — never the other way
//     around — by a `model_load` sample.
//
// The 8 MB benchmark probe cannot produce this number (F-35: its read leg is served
// from the page cache — RAM speed, ~100× inflated on slow media). This figure is what
// the user actually felt: on a RAM-constrained machine even a warm start re-reads the
// full file at media speed (issue #107), and on a big-RAM machine a warm start reads
// the page cache — both are the honest effective rate of that load.
//
// Module-level session latch (precedent: `checksumCacheStats` in models.ts). The IPC
// layer persists the latest sample onto `settings.lastBenchmark.effectiveRead`
// (registerModelIpc) and injects it into `runBenchmark` (registerBenchmarkIpc) — this
// module stays free of DB/settings imports.

/** Below this byte count the timing is dominated by fixed costs, not throughput. */
export const MIN_READ_SAMPLE_BYTES = 64 * 1024 * 1024
/** Below this elapsed time the clock resolution + fixed costs dominate. */
export const MIN_READ_SAMPLE_MS = 250

let latest: EffectiveReadSample | null = null

/** MB/s (MB = 1e6 bytes, matching benchmark.ts `throughputMbps`), one decimal. */
function mbpsOf(bytes: number, ms: number): number {
  return Math.round((bytes / 1e6 / (ms / 1000) + Number.EPSILON) * 10) / 10
}

function record(
  bytes: number,
  ms: number,
  source: EffectiveReadSample['source'],
  modelId: string | null
): void {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms)) return
  if (bytes < MIN_READ_SAMPLE_BYTES || ms < MIN_READ_SAMPLE_MS) return
  if (source === 'checksum' && latest?.source === 'model_load') return
  latest = { mbps: mbpsOf(bytes, ms), bytes, ms: Math.round(ms), source, modelId, at: new Date().toISOString() }
}

/**
 * Record a model-load window read: `modelPath`'s on-disk size over the elapsed
 * spawn-to-healthy ms. A stat failure records nothing (the sample is an optional
 * byproduct — it must never throw into a runtime start).
 */
export function recordModelLoadRead(modelPath: string, ms: number, modelId: string | null): void {
  let bytes: number
  try {
    bytes = statSync(modelPath).size
  } catch {
    return
  }
  record(bytes, ms, 'model_load', modelId)
}

/** Record a completed full-file checksum read (#106 instrumentation feeds this). */
export function recordChecksumRead(bytes: number, ms: number, modelId: string | null): void {
  record(bytes, ms, 'checksum', modelId)
}

/** The latest honest sample of this session, or null before the first qualifying read. */
export function latestEffectiveRead(): EffectiveReadSample | null {
  return latest
}

/** Test seam: clear the session latch. */
export function resetEffectiveReadForTests(): void {
  latest = null
}
