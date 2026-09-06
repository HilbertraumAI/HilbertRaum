import { MAX_BENCHMARK_HISTORY } from '../../shared/types'
import type { AppSettings, BenchmarkResult, EffectiveReadSample } from '../../shared/types'
import { upsertSlowReadWarning } from './benchmark'
import { findMachine, machineKey, type MachineFields } from './performance'
import { preferCandidate } from './read-speed'

// The persistence rules for a benchmark result and its effective-read sample on a drive that
// TRAVELS (benchmark.md "Persistence" / "History per machine"; PR #303 audit M2/M4/M6/L2).
// Pure helpers — no DB, no IPC, no I/O — composed by registerModelIpc (the read-speed
// observer) and registerBenchmarkIpc (the run + the moved-drive check), so the tests drive
// them directly and the later `performance:changed` notifier (P3) can hook the IPC-layer
// side effects without touching these.
//
// Identity BEFORE ranking. A persisted sample is only ever a candidate for THIS machine when
// the machine identities on both sides allow it (`sampleEligible`); only then does the
// source ranking (`preferCandidate`: model_load beats checksum, else the newer sample) get a
// say. Without the gate a drive moved to a new computer inherited the old computer's drive
// figure — its MB/s, `at`, `modelId` and its slow-read warning — into the new computer's
// first benchmark (M2).

/**
 * G3 — whether a result (or a bare machine key) counts as "this machine" for carrying a
 * sample. Eligible when EITHER key is unknown (`null`: a legacy blob, a failed detection) or
 * both are equal; known, unequal keys are foreign. The unknown case is a COMPATIBILITY
 * policy, not proof of provenance: an old workspace keeps behaving as before, and an
 * unkeyed result never acquires a fabricated key or a history entry.
 */
export function sampleEligible(
  resultOrKey: MachineFields | string | null | undefined,
  hereKey: string | null
): boolean {
  const key = typeof resultOrKey === 'string' ? resultOrKey : machineKey(resultOrKey)
  return key == null || hereKey == null || key === hereKey
}

/** Newest first; a `model_load` sample outranks any `checksum` sample regardless of age. */
function rankSamples(candidates: ReadonlyArray<EffectiveReadSample | null | undefined>): EffectiveReadSample | null {
  const present = candidates.filter((s): s is EffectiveReadSample => s != null)
  present.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  let best: EffectiveReadSample | null = null
  for (const c of present) {
    if (!best || !preferCandidate(best, c)) best = c
  }
  return best
}

/**
 * The persisted effective-read sample THIS machine may carry forward: `lastBenchmark`'s
 * when that result is eligible (same or unknown machine), and this machine's own history
 * entry's (which is the same result, or an older one of ours, on a same-machine
 * `lastBenchmark`; the only same-machine record when `lastBenchmark` is foreign). Both are
 * ranked together; a foreign `lastBenchmark` sample is never a candidate.
 */
export function eligiblePersistedSample(
  settings: Pick<AppSettings, 'lastBenchmark' | 'benchmarkHistory'>,
  hereKey: string | null
): EffectiveReadSample | null {
  const last = settings.lastBenchmark
  const local = findMachine(settings.benchmarkHistory, hereKey)
  return rankSamples([last && sampleEligible(last, hereKey) ? last.effectiveRead : null, local?.effectiveRead])
}

/** True when `a` is a strictly newer observation than `b`: a later run, or the same run
 *  carrying a later sample (`ranAt` is unchanged by sample-only updates). */
function newerObservation(a: BenchmarkResult, b: BenchmarkResult): boolean {
  if (a.ranAt !== b.ranAt) return a.ranAt > b.ranAt
  const sa = a.effectiveRead?.at ?? ''
  const sb = b.effectiveRead?.at ?? ''
  return sa > sb
}

/**
 * Cap the history at `MAX_BENCHMARK_HISTORY` by evicting the OLDEST entries (by `ranAt`)
 * that are not this machine's, so a restore or a backfill at capacity never drops the entry
 * being restored. The list is newest-first on input and stays so.
 */
function capProtecting(history: BenchmarkResult[], hereKey: string | null): BenchmarkResult[] {
  const kept = [...history]
  while (kept.length > MAX_BENCHMARK_HISTORY) {
    let victim = -1
    for (let i = kept.length - 1; i >= 0; i--) {
      if (machineKey(kept[i]) === hereKey) continue
      if (victim === -1 || kept[i].ranAt < kept[victim].ranAt) victim = i
    }
    if (victim === -1) break // every entry is protected (cannot happen: one entry per key)
    kept.splice(victim, 1)
  }
  return kept
}

/**
 * Seed an OUTGOING `lastBenchmark` into the history before something replaces it — the
 * upgrade backfill (M4): a workspace from before the history existed carries the previous
 * computer's result only in `lastBenchmark`, and the first run (or restore) on another
 * computer used to discard it. Rules: an unkeyed outgoing result is never filed (it could
 * not be matched again); a history observation for that machine that is already as new or
 * newer is never overwritten with the older outgoing copy; the entry lands at its `ranAt`
 * position (newest first); and the cap evicts the oldest OTHER machine, never this one
 * (`hereKey`). Returns a fresh array either way; the elements are shared, so an unchanged
 * history compares element-wise equal (`historyEquals`).
 */
export function backfillOutgoing(
  history: readonly BenchmarkResult[],
  outgoing: BenchmarkResult | null | undefined,
  hereKey: string | null
): BenchmarkResult[] {
  const key = machineKey(outgoing)
  if (!outgoing || key == null) return [...history]
  const existing = findMachine(history, key)
  if (existing && !newerObservation(outgoing, existing)) return [...history]
  const others = history.filter((entry) => machineKey(entry) !== key)
  const at = others.findIndex((entry) => entry.ranAt < outgoing.ranAt)
  const merged = at === -1 ? [...others, outgoing] : [...others.slice(0, at), outgoing, ...others.slice(at)]
  return capProtecting(merged, hereKey)
}

/** Element-wise identity of two histories (the helpers above return fresh arrays). */
export function historyEquals(a: readonly BenchmarkResult[], b: readonly BenchmarkResult[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

/**
 * A result carrying `sample` as its effective read, with the ONE warning that tracks the
 * sample re-keyed (`upsertSlowReadWarning`) and every other warning untouched. `ranAt` is
 * unchanged: a sample-only update is not a new run. The same result object comes back when
 * the sample is null or already the one it carries.
 */
export function mergeSampleIntoResult(
  result: BenchmarkResult,
  sample: EffectiveReadSample | null | undefined
): BenchmarkResult {
  if (!sample || result.effectiveRead?.at === sample.at) return result
  return {
    ...result,
    effectiveRead: sample,
    warnings: upsertSlowReadWarning(result.warnings ?? [], sample.mbps)
  }
}

/**
 * The settings patch that writes `sample` to EVERY eligible destination (L2): `lastBenchmark`
 * when it is this machine's (same or unknown key), and this machine's history entry when one
 * exists. Each destination is compared on its own — a `lastBenchmark` that already carries
 * the sample does not excuse a stale history entry, and a destination whose sample outranks
 * this one (`preferCandidate`) keeps it. Returns null when NO destination is eligible (a
 * foreign `lastBenchmark` and no local history, or no result at all): the caller must then
 * leave the sample un-handled so a later call retries. An empty patch means every eligible
 * destination already holds this sample or a better one — handled, nothing to write.
 */
export function effectiveReadPatch(
  settings: Pick<AppSettings, 'lastBenchmark' | 'benchmarkHistory'>,
  sample: EffectiveReadSample,
  hereKey: string | null
): Partial<Pick<AppSettings, 'lastBenchmark' | 'benchmarkHistory'>> | null {
  const last = settings.lastBenchmark && sampleEligible(settings.lastBenchmark, hereKey) ? settings.lastBenchmark : null
  const local = findMachine(settings.benchmarkHistory, hereKey)
  if (!last && !local) return null
  const patch: Partial<Pick<AppSettings, 'lastBenchmark' | 'benchmarkHistory'>> = {}
  const wants = (dest: BenchmarkResult): boolean =>
    dest.effectiveRead?.at !== sample.at && preferCandidate(sample, dest.effectiveRead)
  if (last && wants(last)) patch.lastBenchmark = mergeSampleIntoResult(last, sample)
  if (local && wants(local)) {
    const merged = mergeSampleIntoResult(local, sample)
    patch.benchmarkHistory = settings.benchmarkHistory.map((entry) => (entry === local ? merged : entry))
  }
  return patch
}
