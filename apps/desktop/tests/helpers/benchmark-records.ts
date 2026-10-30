import type { BenchmarkResult, EffectiveReadSample, ModelPlacement } from '../../src/shared/types'

// Typed record builders for the benchmark and Performance suites. Pure: type-only imports, so a
// jsdom suite or a unit suite can use them, which `performance-fixture.ts` (it loads main modules)
// is not for. Plain data only: nothing here reads the host, so a record for THIS machine is the
// caller's to build (`hereResult`, or `machineKey: hereKey()`, in `performance-fixture.ts`).

/**
 * A result from some OTHER computer: an RTX 3090 / PRO machine, a fingerprint no test host carries.
 * Replaces `performance-fixture`'s `result` body (`result` is now this function, re-exported).
 * Leaves the optional fields absent; for every field set, see `completeBenchmarkResult`.
 */
export function benchmarkResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'win32',
    arch: 'x64',
    cpuModel: 'Some Other CPU',
    cpuCores: 32,
    ramGb: 64,
    gpu: 'NVIDIA GeForce RTX 3090',
    driveReadMbps: null,
    driveWriteMbps: 900,
    tokensPerSecond: 41,
    measuredModelId: 'qwen3.8-27b-ud-q4km',
    effectiveRead: null,
    profile: 'PRO',
    recommendedModelId: 'qwen3.8-27b-ud-q4km',
    warnings: [],
    ranAt: '2026-09-02T10:00:00Z',
    ...over
  }
}

/**
 * A healthy result with every optional field set: the shape a real run persists. Replaces
 * unit/benchmark-schema's `complete`. It is not `benchmarkResult` plus the optional fields: the CPU,
 * the RAM, the model and the warnings differ too, so a row must not assume the two share a machine.
 */
export function completeBenchmarkResult(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'win32',
    arch: 'x64',
    cpuModel: 'Intel Core i7-1260P',
    cpuCores: 12,
    ramGb: 15.7,
    gpu: 'NVIDIA GeForce RTX 3090',
    gpuVramMb: 24576,
    driveReadMbps: 1200,
    driveWriteMbps: 900,
    tokensPerSecond: 41,
    speedBasis: { basis: 'timings', tokens: 64 },
    speedIdentity: { memoryClass: 'discrete', deviceName: 'NVIDIA GeForce RTX 3090', contextTokens: 8192, backend: 'gpu' },
    measuredModelId: 'qwen3.5-9b-ud-q4kxl',
    effectiveRead: { mbps: 430, bytes: 5_800_000_000, ms: 13_500, source: 'model_load', modelId: 'qwen', at: '2026-09-04T12:00:00Z' },
    profile: 'PRO',
    recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
    warnings: ['something happened'],
    ranAt: '2026-09-05T00:00:00Z',
    ...over
  }
}

/**
 * A 300 MB/s model-load sample (3 GB in 10 s). Replaces unit/benchmark-persistence's `sample`. It
 * is a stored record: it does not feed `read-speed`'s observer, which `loadSample` in
 * `performance-fixture.ts` does.
 */
export function effectiveReadSample(over: Partial<EffectiveReadSample> = {}): EffectiveReadSample {
  return {
    mbps: 300,
    bytes: 3_000_000_000,
    ms: 10_000,
    source: 'model_load',
    modelId: 'm',
    at: '2026-09-01T00:00:00Z',
    ...over
  }
}

/**
 * A fully-offloaded GPU placement (unit/benchmark-schema's `placement`, the richest of the local
 * copies). Its `machineKey` is a literal of no real host, so a record the snapshot must admit as
 * observed passes `machineKey: hereKey()` and the launch `contextTokens`. Not a processor record:
 * the `cpu` literals in performance-ipc and performance-notify override `backend` and the MiB fields.
 */
export function modelPlacement(over: Partial<ModelPlacement> = {}): ModelPlacement {
  return {
    modelId: 'qwen',
    contextTokens: 8192,
    backend: 'gpu',
    gpuLayers: 41,
    totalLayers: 41,
    gpuModelMb: 5500,
    cpuModelMb: 400,
    gpuKvMb: 640,
    cpuKvMb: null,
    metalMaxWorkingSetMb: null,
    machineKey: 'win32|x64|CPU|8|16',
    at: '2026-09-05T14:00:00Z',
    ...over
  }
}
