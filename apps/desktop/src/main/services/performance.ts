import { MAX_BENCHMARK_HISTORY } from '../../shared/types'
import type { AnswerSpeed } from '../../shared/ipc'
import type {
  AppSettings,
  BenchmarkResult,
  GpuDevice,
  MemoryClass,
  ModelPlacement,
  ObservedAnswerSpeed,
  PlacementVerdict,
  ResidentModelRow
} from '../../shared/types'
import type { ModelManifest } from '../../shared/manifest'
import { machineKey } from '../../shared/benchmark-schema'
import { estimateGraphicsNeedMib } from './models'
import { eligibleGpuProbe, primaryUsefulDevice } from '../../shared/gpu-rules'

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
/**
 * Headroom kept back from RAM (cpu) and the unified budget before a weights-only estimate is
 * called a fit (drivers, compute buffers), and from RAM + VRAM before a discrete spill is called
 * 'too_large'. The discrete card fit itself is the picker's (`estimateGraphicsNeedMib`), not this.
 */
export const ESTIMATE_HEADROOM = 0.92

/**
 * The BUDGET device (PR #308 audit, decision 9): the one card whose memory the chat pick,
 * the placement verdict and the graphics tile are measured against. The LARGEST device that
 * passes the ONE usable-card rule (`isUsefulDevice` in `shared/gpu-rules.ts`: ≥ 6 GiB and
 * not integrated by name), never `devices[0]`: the pinned Vulkan build lists an integrated
 * GPU beside the discrete one in DRIVER order, so on a hybrid laptop the first device is as
 * often the iGPU reporting 11–36 GiB of shared RAM as it is the card. Null when no device
 * passes (an integrated-only laptop, a sub-6 GiB card, an empty probe). The implementation IS
 * `primaryUsefulDevice` (the #303 P5 name; the two rules were unified at the #303/#308 merge),
 * kept under this name because the #308 records cite it.
 */
export function selectBudgetDevice(devices: readonly GpuDevice[]): GpuDevice | null {
  return primaryUsefulDevice(devices)
}

/** What `nextStartMemory` needs: the platform, the probed devices and the two GPU flags. */
export interface NextStartMemoryInput {
  platform: string
  arch: string
  devices: readonly GpuDevice[]
  /** The user's Settings toggle (`AppSettings.gpuMode`). */
  gpuMode: AppSettings['gpuMode']
  /** The ladder's crash-fallback latch (`AppSettings.gpuAutoDisabled`). */
  gpuAutoDisabled: boolean
}

/** How the NEXT model start will see this computer's memory: the class and the budget device. */
export interface NextStartMemory {
  memoryClass: MemoryClass
  /**
   * The budget device (`selectBudgetDevice`) on a `discrete` machine; the Metal pool's device
   * (the largest one listed) on `unified`; null on `cpu` — including when a card IS present
   * but the next start will not use it (GPU off, auto-disabled).
   */
  device: GpuDevice | null
  /**
   * The configuration FORCED the processor (`gpuMode: 'off'` or `gpuAutoDisabled`): the ladder
   * skips every GPU rung, so no GPU observation can be repeated by the next start. False on a
   * `cpu` class that merely has no usable card — the ladder may still put layers on an iGPU or
   * a small card under 'auto', so an observed GPU start there is evidence the row keeps
   * (`buildPlacement`'s configuration match reads this, PR #303 P4/P5 over a second read of
   * the flags).
   */
  cpuForced: boolean
}

/**
 * How this computer's memory is organised for the NEXT model start (PR #308 audit, decisions
 * 6 and 9): Apple Silicon (darwin + arm64) is one unified pool; with the GPU switched off in
 * Settings or auto-disabled after a crash the ladder skips every GPU rung, so the next start
 * runs from RAM whatever the probe lists (class `cpu`, no device); otherwise a usable discrete
 * card — the budget device — has its own memory, and everything else runs from RAM.
 *
 * This is the ONE place class and device are decided; `probeAndPersistGpu`, `listModels`,
 * `buildPlacement` and the graphics tile all read it, so the Performance screen and the Models
 * screen can never name different cards. Observed placements are NOT rewritten here — this
 * describes the next start only; whether a stored GPU observation still COUNTS for the row
 * under a forced-CPU configuration is `buildPlacement`'s configuration match (PR #303 P4,
 * `placement.observedMismatch`): the record is kept, the row estimates.
 */
export function nextStartMemory(input: NextStartMemoryInput): NextStartMemory {
  const { platform, arch, devices, gpuMode, gpuAutoDisabled } = input
  if (platform === 'darwin' && arch === 'arm64') {
    // One Metal device is the pool itself; the gate below (a "not integrated" name check)
    // does not apply to it, so name the largest device listed, without the gate.
    let pool: GpuDevice | null = null
    for (const device of devices) {
      if (pool == null || device.totalMb > pool.totalMb) pool = device
    }
    return { memoryClass: 'unified', device: pool, cpuForced: false }
  }
  if (gpuMode === 'off' || gpuAutoDisabled) return { memoryClass: 'cpu', device: null, cpuForced: true }
  const device = selectBudgetDevice(devices)
  return device ? { memoryClass: 'discrete', device, cpuForced: false } : { memoryClass: 'cpu', device: null, cpuForced: false }
}

/**
 * The memory class with the GPU flags at their defaults (GPU on, not auto-disabled) — a thin
 * wrapper over `nextStartMemory` for callers that hold no settings. Production consumers pass
 * the flags through `nextStartMemory` instead, so a switched-off card never classes a machine
 * `discrete`.
 */
export function memoryClassOf(platform: string, arch: string, devices: readonly GpuDevice[]): MemoryClass {
  return nextStartMemory({ platform, arch, devices, gpuMode: 'auto', gpuAutoDisabled: false }).memoryClass
}

/**
 * The devices this machine may take from the persisted probe (PR #303 audit M8.3, owner
 * decision G3): those of `settings.gpuProbe` when it is stamped with THIS machine's key or
 * unstamped (a legacy probe, unverifiable until a local refresh replaces it); NOTHING when it
 * is stamped with another machine's key (`eligibleGpuProbe`). `hereKey` is
 * `machineKey(detectSystem())` — null when identity detection failed, which cannot prove
 * foreignness, so the probe stays eligible.
 */
export function eligibleDevicesFor(settings: AppSettings, hereKey: string | null): GpuDevice[] {
  return eligibleGpuProbe(settings.gpuProbe, hereKey)?.devices ?? []
}

/**
 * `nextStartMemory` for the app's settings: the ELIGIBLE probe's devices, the platform the app
 * runs on and the two GPU flags. The ONE call `pickerMemoryFor` (the Models ★ and the live
 * recommendation), `buildPerformanceSnapshot` (the tile, `currentGpu`, the placement budget)
 * and the picker seam tests make, so a probe stamped elsewhere supplies nothing to any of them.
 */
export function nextStartMemoryFor(settings: AppSettings, hereKey: string | null): NextStartMemory {
  return nextStartMemory({
    platform: process.platform,
    arch: process.arch,
    devices: eligibleDevicesFor(settings, hereKey),
    gpuMode: settings.gpuMode,
    gpuAutoDisabled: settings.gpuAutoDisabled
  })
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

/** What `placementVerdict` is asked: the memory, the model and what the last start said. */
export interface PlacementVerdictInput {
  memoryClass: MemoryClass
  ramMb: number | null
  /** The budget device's TOTAL, MiB — the figure the card's memory is quoted at (`budgetMb` on a discrete verdict); null without a card. */
  vramMb: number | null
  /**
   * The picker's graphics budget for the same device, MiB (`graphicsBudgetMib`: the probe's free
   * figure, else total − 1024); the discrete pre-start estimate is judged against it, exactly as
   * the Models ★ is. Null without a card.
   */
  graphicsBudgetMb: number | null
  /** The active model's weights in GiB, UNROUNDED (`weightsMib(m) / 1024`); null when unknown. */
  sizeOnDiskGb: number | null
  /** The active model's manifest — the discrete estimate's cache term (`estimateGraphicsNeedMib`); null when it is not in the catalog. */
  manifest: ModelManifest | null
  observed: ModelPlacement | null
  /**
   * The budget device's name (`nextStartMemory().device`), so an observed start's free/working
   * figures are attributed to it (`attributedGpuFigures`, PR #303 audit DR2); null or absent
   * without a card — a multi-row record then attributes nothing.
   */
  gpuName?: string | null
}

/**
 * The verdict. OBSERVED (the model has started on this machine): the log says where the
 * weights and the context cache landed, so the outcome is read off, not computed: every
 * layer on the GPU is 'gpu' (unified memory reads the same way), fewer is 'partial' with
 * the CPU-side bytes as the spill, a CPU backend is 'cpu', and a GPU start whose log carried
 * no offload line is 'unknown' rather than a guess. ESTIMATED (no start yet): on a discrete
 * card the picker's own fit (`estimateGraphicsNeedMib` — unrounded weights × 1.15 + the
 * model's context-cache term + the fit's 1 GiB margin — against the picker's budget, PR #308
 * audit decision 8, finding §4.1), so this row and the Models ★ can never call the same
 * (model, card) pair differently; a card that cannot hold it still runs the model if RAM can
 * take the rest ('partial', the spill being the estimated need over the budget), and beyond
 * RAM + VRAM it is 'too_large'. On unified and cpu machines the weights alone against the
 * budget with `ESTIMATE_HEADROOM` (unchanged); a model larger than that is 'too_large'.
 * `needMb` on an estimate is always the weights alone (the copy says the cache is measured).
 *
 * `memoryClass` is the EFFECTIVE class of the NEXT start (`nextStartMemory`: already `cpu` when
 * the configuration forces the processor — `gpuMode: 'off'`, `gpuAutoDisabled` — and passed as
 * `cpu` by `buildPlacement` when the matching observed start landed on the CPU backend), so the
 * estimate never promises the card a start would not use (PR #303 audit DR1). `gpuName` names
 * the budget device so the observed free/working figures are attributed to it (DR2).
 */
export function placementVerdict(input: PlacementVerdictInput): PlacementVerdict {
  const { memoryClass, ramMb, vramMb, graphicsBudgetMb, sizeOnDiskGb, manifest, observed } = input
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
  if (memoryClass === 'discrete') {
    // A model outside the catalog has no cache term; without the picker's budget there is no
    // card to fit against. Neither is a guess worth showing.
    if (manifest == null || graphicsBudgetMb == null) return { ...est, kind: 'unknown', needMb }
    const needOnCardMb = estimateGraphicsNeedMib(manifest)
    if (needOnCardMb <= graphicsBudgetMb) return { ...est, kind: 'gpu', needMb }
    const total = ramMb != null ? ramMb + budgetMb : null
    if (total != null && needMb <= total * ESTIMATE_HEADROOM) {
      // What the card cannot take of the estimated need runs from RAM — never more than the weights.
      return { ...est, kind: 'partial', needMb, spillMb: Math.min(needMb, Math.max(0, Math.round(needOnCardMb - graphicsBudgetMb))) }
    }
    return { ...est, kind: 'too_large', needMb }
  }
  const fits = needMb <= budgetMb * ESTIMATE_HEADROOM
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
