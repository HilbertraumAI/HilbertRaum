import type { GpuDevice, GpuProbeResult } from './types'

// The ONE definition of "a graphics card the app can use" (PR #303 audit M8 / N3, owner
// decisions G3 / G4). Shared and PURE — no node:, no electron, no DB — so the runtime's
// profile-bump gate (`services/runtime/gpu.ts` re-exports these), the snapshot builder (main)
// and the Performance screen (renderer) can never disagree about which device counts, which one
// is shown, and what its memory figure means. Before this module there were three rules: the
// runtime gate (≥ 6 GiB AND not integrated), the graphics tile (≥ 6144 alone) and `devices[0]`
// for every recorded figure — so an Intel Iris Xe reporting 16 GB of SHARED memory rendered
// "16.0 GB VRAM · Usable" beside "Will run on the processor", and a hybrid `[iGPU, dGPU]` box
// took its class from the dGPU but its budget, VRAM and name from the iGPU.
//
// What this module does NOT decide (G4): what the runtime does. The start ladder, `--fit`, the
// "never -ngl" policy and `gpuUsefulForProfile`'s bump semantics are unchanged — this is
// presentation and estimate eligibility only.

/** The device fields the rules read: every probe row and every parser row carries at least these. */
export type GpuDeviceLike = Pick<GpuDevice, 'name' | 'totalMb'>

/**
 * Minimum dedicated memory (MiB) before a device counts as usable. The profile bump
 * (`gpuUsefulForProfile`), the memory class, the VRAM budget and the graphics tile's "Usable"
 * rating all read this one constant: 6 GiB.
 */
export const USABLE_VRAM_MB = 6144
/** The profile-bump gate's historical name for the same constant (GPU record §8). */
export const GPU_BUMP_MIN_VRAM_MB = USABLE_VRAM_MB

/**
 * Name-based heuristic for "this is an integrated GPU sharing system RAM" — used to keep
 * classifyProfile's GPU bump conservative (GPU record §8) and, since the PR #303 audit, to
 * rate the graphics tile. Deliberately biased toward matching (NOT bumping): an Iris Xe
 * reporting 16 GB of *shared* memory must never push a laptop a profile step up and get
 * recommended a model it cannot run. A false positive only costs a too-small
 * recommendation, never a too-big one.
 */
export function looksIntegrated(name: string): boolean {
  // Patterns cover the names real Vulkan drivers report (including Linux/RADV APUs
  // and Meteor-Lake Intel, which a name-only "Iris/UHD" check would miss):
  //   - "Intel(R) Iris(R) Xe Graphics", "Intel(R) UHD Graphics 770", "Intel(R) HD ..."
  //   - "Intel(R) Arc(TM) Graphics"          (Meteor/Lunar-Lake iGPU — NO model number;
  //     discrete is "Arc(TM) A770 Graphics" and must NOT match)
  //   - "AMD Radeon(TM) Graphics" / "AMD Radeon Graphics (RADV REMBRANDT)"  (APUs)
  //   - "AMD Radeon(TM) 780M Graphics" and other "...Graphics"-suffixed APU names
  //   - "AMD Radeon Vega 8 Graphics", "Vega 11" APUs (also catches old discrete
  //     RX Vega 56/64 — an accepted false positive; see the bias note above)
  return /iris|uhd|intel\(r\) (hd|arc.*integrated)|arc\(tm\) graphics|radeon(\(tm\))? graphics|radeon.*graphics$|vega \d+/i.test(
    name
  )
}

/**
 * ≥ 6 GiB AND not integrated-looking: a device a model can actually be accelerated on. The
 * single predicate behind every "usable" answer in the app.
 */
export function isUsefulDevice(device: GpuDeviceLike): boolean {
  return device.totalMb >= USABLE_VRAM_MB && !looksIntegrated(device.name)
}

/**
 * The conservative profile-bump gate (GPU record §8): bump only when SOME probed device is
 * useful. An iGPU reporting 16 GB of *shared* RAM must never push a laptop a profile step up;
 * a false negative only costs a too-small model recommendation, never a too-big one. Semantics
 * unchanged by the PR #303 audit (G4) — `memoryClassOf` reads it too.
 */
export function gpuUsefulForProfile(devices: readonly GpuDeviceLike[]): boolean {
  return devices.some(isUsefulDevice)
}

/**
 * The device every recorded figure is taken from: the FIRST useful device in enumeration
 * order, or null when none is useful. On a hybrid `[iGPU, dGPU]` box this is the dGPU — the
 * old `devices[0]` was the iGPU's shared figure (M8.2). Its `name` and `totalMb` are always
 * paired: a reader never combines one device's name with another's memory.
 */
export function primaryUsefulDevice<T extends GpuDeviceLike>(devices: readonly T[]): T | null {
  return devices.find(isUsefulDevice) ?? null
}

/**
 * What a screen may SHOW: the primary useful device (`useful: true`), else the first listed
 * device with `useful: false` — an integrated or small device is named with its memory figure
 * so the copy can say "integrated, shared memory" honestly, never implying acceleration. Null
 * with no device at all.
 */
export function displayDevice<T extends GpuDeviceLike>(devices: readonly T[]): { device: T; useful: boolean } | null {
  const primary = primaryUsefulDevice(devices)
  if (primary) return { device: primary, useful: true }
  return devices.length > 0 ? { device: devices[0], useful: false } : null
}

/**
 * The probe a reader may take this machine's devices from (owner decision G3): one stamped
 * with THIS machine's `machineKey`, or an UNSTAMPED one — persisted before the stamp existed,
 * its origin unverifiable until a successful local refresh replaces it, and treating it as
 * local is the compatibility policy every other unkeyed record follows. A probe stamped with
 * ANOTHER machine's key is known-foreign and supplies NOTHING: null here reads exactly like
 * "no probe" (no class beyond cpu/unified, no VRAM budget, no `currentGpu`, no fold-in). An
 * unknown `hereKey` (identity detection failed) cannot prove foreignness, so the probe stays
 * eligible — the same call `currentMachine` makes for a benchmark result.
 */
export function eligibleGpuProbe(probe: GpuProbeResult | null | undefined, hereKey: string | null): GpuProbeResult | null {
  if (!probe) return null
  const stamped = probe.machineKey ?? null
  return stamped == null || hereKey == null || stamped === hereKey ? probe : null
}
