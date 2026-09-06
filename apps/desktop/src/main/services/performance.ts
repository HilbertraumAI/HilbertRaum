import { MAX_BENCHMARK_HISTORY } from '../../shared/types'
import type { AnswerSpeed } from '../../shared/ipc'
import type {
  BenchmarkResult,
  GpuDevice,
  MemoryClass,
  ModelPlacement,
  ObservedAnswerSpeed,
  PlacementVerdict,
  ResidentModelRow
} from '../../shared/types'
import { machineKey } from '../../shared/benchmark-schema'
import { gpuUsefulForProfile } from '../../shared/gpu-rules'

// The Performance screen's model (benchmark.md "Performance screen"): one benchmark result
// per COMPUTER the drive has been used on, and the session's observed figures. Pure
// helpers plus one module-level session latch (precedent: `latestEffectiveRead` in
// read-speed.ts): no DB, no IPC, no I/O, so the IPC layer composes them and the tests
// drive them directly.

/** The fields of a result that identify the computer it was measured on. */
export type MachineFields = Pick<BenchmarkResult, 'os' | 'arch' | 'cpuModel' | 'cpuCores' | 'ramGb'>

/**
 * Fingerprint of the computer a result belongs to (OS, arch, CPU model + cores, RAM rounded
 * to whole GB), null for a result with no usable identity. The implementation moved to
 * `shared/benchmark-schema.ts` with the PR #303 audit H1 validators — the history validator
 * has to key on exactly this and the renderer must be able to import it — and is re-exported
 * here so every existing `services/performance` import site is unchanged.
 */
export { machineKey }

/**
 * The history after a fresh result: the entry for the same machine is replaced, the
 * newest result leads, and the list is capped at `MAX_BENCHMARK_HISTORY` (the oldest
 * OTHER machines fall off; this machine's entry always survives). A result with no
 * machine identity is not recorded: it could never be matched again.
 */
export function upsertHistory(history: readonly BenchmarkResult[], result: BenchmarkResult): BenchmarkResult[] {
  const key = machineKey(result)
  if (key == null) return [...history]
  const others = history.filter((entry) => machineKey(entry) !== key)
  return [result, ...others].slice(0, MAX_BENCHMARK_HISTORY)
}

/** The history entry measured on the machine `key` names, or null. */
export function findMachine(history: readonly BenchmarkResult[], key: string | null): BenchmarkResult | null {
  if (key == null) return null
  return history.find((entry) => machineKey(entry) === key) ?? null
}

/** Every history entry EXCEPT the one for `key` (the "other computers" list), newest first. */
export function otherMachines(history: readonly BenchmarkResult[], key: string | null): BenchmarkResult[] {
  return history
    .filter((entry) => key == null || machineKey(entry) !== key)
    .sort((a, b) => (a.ranAt < b.ranAt ? 1 : a.ranAt > b.ranAt ? -1 : 0))
}

// ---- Session latch: the last finished chat answer's speed (#290 payload + context) ----

let lastAnswer: ObservedAnswerSpeed | null = null

/** Record a finished answer's speed (called by the chat-stream observer in index.ts). */
export function recordAnswerSpeed(speed: AnswerSpeed, modelId: string | null, now: () => Date = () => new Date()): void {
  lastAnswer = {
    tokensPerSecond: speed.tokensPerSecond,
    ttftMs: speed.ttftMs,
    tokens: speed.tokens,
    modelId,
    at: now().toISOString()
  }
}

/** The last finished answer of this session, or null before the first one. */
export function latestAnswerSpeed(): ObservedAnswerSpeed | null {
  return lastAnswer
}

/** Test seam. */
export function resetPerformanceForTests(): void {
  lastAnswer = null
}

// ---- "Your model": memory class, budget, and the fit verdict (benchmark.md) ----

/** Share of RAM Metal lets the GPU take when the load log has not said (Apple's default working-set cap). */
export const UNIFIED_BUDGET_SHARE = 0.75
/** Headroom kept back from VRAM/RAM before a weights-only estimate is called a fit (drivers, compute buffers). */
export const ESTIMATE_HEADROOM = 0.92

/**
 * How this computer's memory is organised for a model. Apple Silicon (darwin + arm64) is one
 * unified pool; a usable discrete card (the runtime's own 6 GiB, not-integrated gate — the
 * shared `gpuUsefulForProfile`, unchanged by the PR #303 audit, G4) has its own memory;
 * everything else runs from RAM. The HARDWARE class: the caller passes the effective class
 * (`cpu` when the configuration forces the processor) to `placementVerdict` itself.
 */
export function memoryClassOf(platform: string, arch: string, devices: GpuDevice[]): MemoryClass {
  if (platform === 'darwin' && arch === 'arm64') return 'unified'
  return gpuUsefulForProfile(devices) ? 'discrete' : 'cpu'
}

/**
 * The free-at-start and working-buffer figures of ONE device — the SELECTED one (PR #303
 * audit DR2). The parser keeps the `device_info` rows (`ModelPlacement.devices`, label ↔ name)
 * with the compute buffer reserved on each. A record with a single GPU row, or one persisted
 * before the rows existed, attributes exactly as before (the first row's free figure, the
 * summed compute). With several rows the figures belong to the row whose name is the selected
 * device's; when that device is not in the log — or none was selected — both stay null,
 * because a dGPU's spill must never be explained with the iGPU's free memory.
 */
export function attributedGpuFigures(
  observed: ModelPlacement,
  gpuName: string | null
): { freeAtStartMb: number | null; workingMb: number | null } {
  const rows = observed.devices
  if (rows == null || rows.length < 2) {
    return { freeAtStartMb: observed.gpuFreeAtStartMb ?? null, workingMb: observed.gpuComputeMb ?? null }
  }
  const row = gpuName == null ? undefined : rows.find((d) => d.name === gpuName)
  return { freeAtStartMb: row?.freeMb ?? null, workingMb: row?.computeMb ?? null }
}

/** The memory the fit question is asked against, MiB. */
export function memoryBudgetMb(
  memoryClass: MemoryClass,
  ramMb: number | null,
  vramMb: number | null,
  observed: ModelPlacement | null
): number | null {
  if (memoryClass === 'discrete') return vramMb
  if (memoryClass === 'unified') {
    if (observed?.metalMaxWorkingSetMb != null) return observed.metalMaxWorkingSetMb
    return ramMb != null ? Math.round(ramMb * UNIFIED_BUDGET_SHARE) : null
  }
  return ramMb
}

const sum = (...xs: Array<number | null>): number | null => {
  const known = xs.filter((x): x is number => x != null)
  return known.length === 0 ? null : Math.round(known.reduce((a, b) => a + b, 0))
}

/**
 * The verdict. OBSERVED (the model has started on this machine): the log says where the
 * weights and the context cache landed, so the outcome is read off, not computed: every
 * layer on the GPU is 'gpu' (unified memory reads the same way), fewer is 'partial' with
 * the CPU-side bytes as the spill, a CPU backend is 'cpu', and a GPU start whose log carried
 * no offload line is 'unknown' rather than a guess. ESTIMATED (no start yet): the
 * weights alone against the budget with headroom; a discrete card that cannot hold them
 * still runs the model if RAM can take the rest ('partial'), and beyond RAM + VRAM it is
 * 'too_large'. A model larger than RAM on a CPU or unified machine is 'too_large' as well.
 *
 * `memoryClass` is the EFFECTIVE class: the caller passes `cpu` when the configuration forces
 * the processor (`gpuMode: 'off'`, `gpuAutoDisabled`), so the estimate never promises the card
 * a start would not use (PR #303 audit DR1). `gpuName` names the selected device so the
 * observed free/working figures are attributed to it (`attributedGpuFigures`, DR2).
 */
export function placementVerdict(input: {
  memoryClass: MemoryClass
  ramMb: number | null
  vramMb: number | null
  sizeOnDiskGb: number | null
  observed: ModelPlacement | null
  gpuName?: string | null
}): PlacementVerdict {
  const { memoryClass, ramMb, vramMb, sizeOnDiskGb, observed } = input
  const budgetMb = memoryBudgetMb(memoryClass, ramMb, vramMb, observed)
  if (observed) {
    const needMb = sum(observed.gpuModelMb, observed.cpuModelMb, observed.gpuKvMb, observed.cpuKvMb)
    const figures = attributedGpuFigures(observed, input.gpuName ?? null)
    const base = {
      needMb,
      estimated: false,
      budgetMb,
      freeAtStartMb: figures.freeAtStartMb,
      workingMb: figures.workingMb,
      gpuLayers: observed.gpuLayers,
      totalLayers: observed.totalLayers
    }
    if (observed.backend === 'cpu') return { ...base, kind: 'cpu', spillMb: null }
    // A GPU start whose log carried no offload line (a build logging below verbosity 4) is
    // NOT "all on the GPU": say so, never claim a split the log did not report.
    if (observed.gpuLayers == null || observed.totalLayers == null) {
      return { ...base, kind: 'unknown', spillMb: null }
    }
    if (observed.gpuLayers >= observed.totalLayers) return { ...base, kind: 'gpu', spillMb: null }
    return { ...base, kind: 'partial', spillMb: sum(observed.cpuModelMb, observed.cpuKvMb) }
  }
  const est = { estimated: true, budgetMb, freeAtStartMb: null, workingMb: null, gpuLayers: null, totalLayers: null, spillMb: null }
  if (sizeOnDiskGb == null || sizeOnDiskGb <= 0) return { ...est, kind: 'unknown', needMb: null }
  const needMb = Math.round(sizeOnDiskGb * 1024)
  if (budgetMb == null) return { ...est, kind: 'unknown', needMb }
  const fits = needMb <= budgetMb * ESTIMATE_HEADROOM
  if (memoryClass === 'discrete') {
    if (fits) return { ...est, kind: 'gpu', needMb }
    const total = ramMb != null ? ramMb + budgetMb : null
    if (total != null && needMb <= total * ESTIMATE_HEADROOM) {
      return { ...est, kind: 'partial', needMb, spillMb: Math.max(0, needMb - Math.round(budgetMb * ESTIMATE_HEADROOM)) }
    }
    return { ...est, kind: 'too_large', needMb }
  }
  if (fits) return { ...est, kind: memoryClass === 'unified' ? 'gpu' : 'cpu', needMb }
  return { ...est, kind: 'too_large', needMb }
}

/**
 * What everything loadable at once would take from the PROCESSOR's memory, MiB (benchmark.md
 * "Models on this computer"; PR #303 audit DR5, owner ruling). The old figure summed every
 * row, so on a graphics-card machine the chat and translation weights that live ON THE CARD
 * were counted against RAM and the pill said "Too much at once" for a machine that was fine.
 *
 *  - `cpu` class: every row runs from RAM — the plain sum.
 *  - `discrete`: the rows that run on the processor (pinned by design, or `'cpu'` by
 *    configuration/observation) at full size, plus what the card-resident rows spill: the
 *    active model's OBSERVED partial-offload spill (`verdict.spillMb`, the CPU-side model +
 *    cache bytes of a measured partial start; an estimate, a full offload and an unknown split
 *    contribute 0) and the translation sidecar's live spill (size × the share of layers off the
 *    card, from its reported split; not live, no split, or every layer on the card → 0).
 *  - `unified`: one pool, so the full sum — the copy says "memory" and the pill compares
 *    against the unified budget, not RAM.
 *
 * null when no row has a size (nothing installed).
 */
export function loadedAtOnceMb(input: {
  memoryClass: MemoryClass
  rows: readonly ResidentModelRow[]
  verdict: PlacementVerdict
}): number | null {
  const { memoryClass, rows, verdict } = input
  let total: number | null = null
  for (const row of rows) {
    if (row.sizeOnDiskGb == null) continue
    const sizeMb = row.sizeOnDiskGb * 1024
    let mb: number
    if (memoryClass === 'unified' || row.device === 'cpu') {
      mb = sizeMb
    } else if (row.role === 'chat') {
      mb = verdict.kind === 'partial' && !verdict.estimated ? (verdict.spillMb ?? 0) : 0
    } else if (row.role === 'translation') {
      const onCard =
        row.loaded && row.gpuLayers != null && row.totalLayers != null && row.totalLayers > 0
          ? Math.min(1, row.gpuLayers / row.totalLayers)
          : null
      mb = onCard == null ? 0 : sizeMb * (1 - onCard)
    } else {
      mb = sizeMb
    }
    total = (total ?? 0) + mb
  }
  return total == null ? null : Math.round(total)
}
