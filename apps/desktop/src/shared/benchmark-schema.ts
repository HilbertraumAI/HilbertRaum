import {
  MAX_BENCHMARK_HISTORY,
  type BenchmarkResult,
  type EffectiveReadSample,
  type HardwareProfile,
  type ModelPlacement
} from './types'

// Structural validation for the persisted benchmark records (PR #303 audit H1 / L8, owner
// decision G7). PURE and SHARED — no node:, no electron, no DB — so the settings store
// (main), the snapshot builder (main) and the screens (renderer) all agree on one definition
// of "a record a reader may trust".
//
// Why this exists. `AppSettings.lastBenchmark`, `benchmarkHistory` and `modelPlacements` are
// stored as JSON rows and were `JSON.parse`d straight over the defaults with NO element
// validation, while `updateSettings` gated only the TOP-LEVEL shape ("a non-null non-array
// object", "an array of those"). So `{}` was a valid history entry: it reached the startup
// fingerprinting, `maybeRunFirstBenchmark`, the #107 start-estimate memo, Diagnostics and the
// Performance screen, where `fmt1(undefined)` threw and took the whole screen down (H1). A
// `{ m: {} }` placement map was stored the same way and a `{}` record reached
// `placementVerdict` (L8). Validation now runs on WRITE (garbage is never persisted) and on
// READ (a row written by an older build, a hand-edited DB or a partially written blob can
// never crash a reader) — reads repair in memory only and never rewrite the DB.
//
// Tolerance policy. The goal is to reject `{}`-class garbage, not to discard a user's real
// history: every field that can be repaired IS repaired (an unusable number becomes `null`,
// an unusable identity becomes the "unknown machine" value), and only a record with nothing
// meaningful left is dropped. Absence is preserved for the optional legacy fields — the
// screens read "absent" as "not recorded" and say so in their copy, so fabricating a `null`
// there would turn "we never measured this" into "we measured nothing".
//
// P5 slots `normalizeGpuProbe`/`normalizeGpuDevice` in beside these (`settings.gpuProbe` still
// passes through the top-level object gate only); the helpers below are shaped for it.

/** Every `HardwareProfile` value as a runtime set — the type alone cannot validate JSON. */
const HARDWARE_PROFILES: ReadonlySet<string> = new Set<HardwareProfile>([
  'TINY',
  'LITE',
  'BALANCED',
  'PRO',
  'UNKNOWN'
])

/** True for a value that is one of the five `HardwareProfile` members. */
export function isHardwareProfile(value: unknown): value is HardwareProfile {
  return typeof value === 'string' && HARDWARE_PROFILES.has(value)
}

/**
 * The `ranAt` a record carries when its own timestamp is missing or unparseable: the EMPTY
 * string, never "now". A fabricated date would present a legacy blob as a fresh measurement
 * and would re-order the history around a run that never happened. Readers render an
 * unparseable date as their "unknown" copy (Diagnostics "Last run", the Performance screen's
 * date formatters), and string comparison sorts it oldest, which is what an undated record is.
 */
export const UNKNOWN_RAN_AT = ''

/** The fields of a result that identify the computer it was measured on. */
type MachineIdentity = Pick<BenchmarkResult, 'os' | 'arch' | 'cpuModel' | 'cpuCores' | 'ramGb'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite number >= 0, else null — NaN, Infinity, negatives and non-numbers are "unknown". */
function figure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** A whole count >= 0 (floored), else null. */
function count(value: unknown): number | null {
  const n = figure(value)
  return n == null ? null : Math.floor(n)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The string when it parses as a date, else null. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  return Number.isNaN(new Date(value).getTime()) ? null : value
}

/**
 * Whether a result carries an identity `machineKey` can key on: a non-empty `cpuModel` AND a
 * positive `ramGb`. The single definition of "usable identity", so the fingerprint and the
 * validator can never disagree about which records are keyed.
 */
export function hasMachineIdentity(fields: MachineIdentity | null | undefined): boolean {
  if (!fields) return false
  return (
    typeof fields.cpuModel === 'string' &&
    fields.cpuModel.length > 0 &&
    typeof fields.ramGb === 'number' &&
    fields.ramGb > 0
  )
}

/**
 * Fingerprint of the computer a result belongs to: OS, arch, CPU model + cores, and RAM
 * rounded to whole GB (`os.totalmem()` can drift by a few MB between boots of the same
 * machine; the Models screen rounds the same way). Returns null when the result carries no
 * usable identity (a detection failure, or a blob persisted before these fields were reliably
 * filled), so callers treat "unknown" as "keep what we have", never as "moved".
 *
 * Lives here rather than in `services/performance.ts` (which re-exports it, so every existing
 * import site is unchanged) because the history validator has to key on exactly this and the
 * renderer must be able to import the module.
 */
export function machineKey(fields: MachineIdentity | null | undefined): string | null {
  if (!fields || !hasMachineIdentity(fields)) return null
  return [fields.os, fields.arch, fields.cpuModel, fields.cpuCores, Math.round(fields.ramGb)].join('|')
}

/**
 * `BenchmarkResult.speedBasis` (#291) — `{ basis: 'timings' | 'chunks', tokens: <whole >= 0> }`
 * or null. Callers preserve ABSENCE themselves: a result persisted before the field existed
 * has no basis at all, which the screens render as "approximate", so it must not be
 * fabricated as `null`.
 */
export function normalizeSpeedBasis(raw: unknown): { basis: 'timings' | 'chunks'; tokens: number } | null {
  if (!isRecord(raw)) return null
  const basis = raw.basis
  if (basis !== 'timings' && basis !== 'chunks') return null
  const tokens = count(raw.tokens)
  return tokens == null ? null : { basis, tokens }
}

/**
 * An `EffectiveReadSample` (#108) or null. Every field is load-bearing — the Drive tile prints
 * the throughput, the GB and the date, and `preferCandidate` ranks on `source` and `at` — so a
 * sample missing any of them is dropped rather than half-rendered.
 */
export function normalizeEffectiveRead(raw: unknown): EffectiveReadSample | null {
  if (!isRecord(raw)) return null
  const source = raw.source
  if (source !== 'model_load' && source !== 'checksum') return null
  const mbps = figure(raw.mbps)
  const bytes = figure(raw.bytes)
  const ms = figure(raw.ms)
  const at = isoOrNull(raw.at)
  if (mbps == null || bytes == null || ms == null || at == null) return null
  return { mbps, bytes, ms, source, modelId: textOrNull(raw.modelId), at }
}

/**
 * A `BenchmarkResult` or null.
 *
 * MINIMUM VALIDITY (the rule that rejects `{}`): the raw value must be a plain object that
 * carries EITHER a parseable `ranAt` (it is a dated observation) OR a valid `HardwareProfile`
 * in `profile` (the legacy profile-only blob — see below). An object with neither says nothing
 * about any machine and is dropped.
 *
 * LEGACY POLICY (owner decision G3): `{ profile: 'BALANCED' }` — the shape an old workspace's
 * `lastBenchmark` can still hold — MUST survive as a valid record with an UNKNOWN identity, so
 * that "unknown identity counts as this machine" keeps behaving as it always has. It
 * normalizes to `os`/`arch`/`cpuModel` = `''`, `cpuCores`/`ramGb` = 0, `gpu` and every numeric
 * figure = null, `warnings` = [], `ranAt` = `UNKNOWN_RAN_AT`, `profile` kept. `machineKey` then
 * returns null for it: it is never filed in the history and never fabricates a key.
 *
 * FIELD RULES: identity fields present but malformed (a non-string `cpuModel`, negative/NaN
 * cores or RAM) normalize to the unknown values, never to half an identity; every numeric
 * figure is finite and >= 0 or null (`cpuCores` a whole count); an unknown/mistyped `profile`
 * on a dated record reads as `'UNKNOWN'` rather than dropping a real measurement; `warnings`
 * keeps its string elements only. The optional fields `gpuVramMb`, `speedBasis`,
 * `measuredModelId` and `effectiveRead` are set ONLY when the raw object has the key — absence
 * carries meaning for the screens' "approximate" / "not recorded" copy.
 */
export function normalizeBenchmarkResult(raw: unknown): BenchmarkResult | null {
  if (!isRecord(raw)) return null
  const ranAt = isoOrNull(raw.ranAt)
  const declared = isHardwareProfile(raw.profile) ? raw.profile : null
  if (ranAt == null && declared == null) return null
  const result: BenchmarkResult = {
    os: text(raw.os),
    arch: text(raw.arch),
    cpuModel: text(raw.cpuModel),
    cpuCores: count(raw.cpuCores) ?? 0,
    ramGb: figure(raw.ramGb) ?? 0,
    gpu: textOrNull(raw.gpu),
    driveReadMbps: figure(raw.driveReadMbps),
    driveWriteMbps: figure(raw.driveWriteMbps),
    tokensPerSecond: figure(raw.tokensPerSecond),
    profile: declared ?? 'UNKNOWN',
    recommendedModelId: textOrNull(raw.recommendedModelId),
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [],
    ranAt: ranAt ?? UNKNOWN_RAN_AT
  }
  if ('gpuVramMb' in raw) result.gpuVramMb = figure(raw.gpuVramMb)
  if ('speedBasis' in raw) result.speedBasis = normalizeSpeedBasis(raw.speedBasis)
  if ('measuredModelId' in raw) result.measuredModelId = textOrNull(raw.measuredModelId)
  if ('effectiveRead' in raw) result.effectiveRead = normalizeEffectiveRead(raw.effectiveRead)
  return result
}

/**
 * `AppSettings.benchmarkHistory` — the per-computer list (benchmark.md "History per machine").
 * A non-array is an empty history. Each element is normalized; invalid ones are dropped, and
 * so are UNKEYED ones (`machineKey` null): the history is addressed by machine, so an entry
 * that can never be matched again is not an entry. One record per key survives (the newest
 * `ranAt` wins; a tie keeps the one listed first, which is already the newest-first
 * convention), the list is ordered newest first, and it is capped at `MAX_BENCHMARK_HISTORY`.
 */
export function normalizeBenchmarkHistory(raw: unknown): BenchmarkResult[] {
  if (!Array.isArray(raw)) return []
  const byMachine = new Map<string, BenchmarkResult>()
  for (const element of raw) {
    const entry = normalizeBenchmarkResult(element)
    if (!entry) continue
    const key = machineKey(entry)
    if (key == null) continue
    const held = byMachine.get(key)
    if (!held || held.ranAt < entry.ranAt) byMachine.set(key, entry)
  }
  return [...byMachine.values()]
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0))
    .slice(0, MAX_BENCHMARK_HISTORY)
}

/**
 * One `ModelPlacement` (benchmark.md "Your model") or null. The REQUIRED fields are the ones
 * the row is addressed and dated by — a non-empty `modelId` (matching `expectedModelId` when
 * the caller passes the map key it was filed under), a `'gpu' | 'cpu'` backend, a positive
 * whole `contextTokens` (the context the cache figures are for) and a parseable `at`. The
 * layer/buffer readings are optional MEASUREMENTS: each is finite >= 0 or null, and an
 * ALL-NULL reading with valid required fields is VALID — a forced-CPU start prints no offload
 * line and `placementVerdict` renders that as `unknown` (L7), which is the honest answer. A
 * reading that contradicts itself (`gpuLayers > totalLayers`) is not repairable, so the whole
 * record is rejected. `machineKey` is a string or null (null = an unknown machine, G3).
 * `gpuFreeAtStartMb`/`gpuComputeMb` are set only when the raw object has the key (absence =
 * "the log did not print it on the build that recorded this").
 */
export function normalizeModelPlacement(raw: unknown, expectedModelId?: string): ModelPlacement | null {
  if (!isRecord(raw)) return null
  const modelId = typeof raw.modelId === 'string' && raw.modelId.length > 0 ? raw.modelId : null
  if (modelId == null) return null
  if (expectedModelId !== undefined && expectedModelId !== modelId) return null
  const backend = raw.backend
  if (backend !== 'gpu' && backend !== 'cpu') return null
  const contextTokens = count(raw.contextTokens)
  if (contextTokens == null || contextTokens <= 0) return null
  const at = isoOrNull(raw.at)
  if (at == null) return null
  const gpuLayers = count(raw.gpuLayers)
  const totalLayers = count(raw.totalLayers)
  if (gpuLayers != null && totalLayers != null && gpuLayers > totalLayers) return null
  const placement: ModelPlacement = {
    modelId,
    contextTokens,
    backend,
    gpuLayers,
    totalLayers,
    gpuModelMb: figure(raw.gpuModelMb),
    cpuModelMb: figure(raw.cpuModelMb),
    gpuKvMb: figure(raw.gpuKvMb),
    cpuKvMb: figure(raw.cpuKvMb),
    metalMaxWorkingSetMb: figure(raw.metalMaxWorkingSetMb),
    machineKey: textOrNull(raw.machineKey),
    at
  }
  if ('gpuFreeAtStartMb' in raw) placement.gpuFreeAtStartMb = figure(raw.gpuFreeAtStartMb)
  if ('gpuComputeMb' in raw) placement.gpuComputeMb = figure(raw.gpuComputeMb)
  return placement
}

/**
 * `AppSettings.modelPlacements` — the `modelId → ModelPlacement` map. A non-object is an empty
 * map; every entry must normalize AND be filed under its own `modelId` (a mismatched key would
 * hand one model's measurement to another). `__proto__` is skipped for the #251 reason: a
 * `JSON.parse`d key of that name is an own property here but assigning it would reach the
 * prototype setter instead of the map.
 */
export function normalizeModelPlacements(raw: unknown): Record<string, ModelPlacement> {
  if (!isRecord(raw)) return {}
  const placements: Record<string, ModelPlacement> = {}
  for (const [modelId, value] of Object.entries(raw)) {
    if (modelId === '__proto__') continue
    const placement = normalizeModelPlacement(value, modelId)
    if (placement) placements[modelId] = placement
  }
  return placements
}
