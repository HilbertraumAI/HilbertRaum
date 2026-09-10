import type { GpuDevice, GpuProbeResult } from './types'

// The ONE definition of "a graphics card the app can use" (PR #303 audit M8 / N3, owner
// decisions G3 / G4). Shared and PURE — no node:, no electron, no DB — so the runtime's
// profile-bump gate (`services/runtime/gpu.ts` re-exports these), the snapshot builder (main)
// and the Performance screen (renderer) can never disagree about which device counts, which one
// is shown, and what its memory figure means. Before this module there were three rules: the
// runtime gate (a VRAM floor AND not integrated), the graphics tile (the floor alone) and `devices[0]`
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
 * rating all read this one constant: **5 GiB since 2026-09-07** (issue #321, owner decision;
 * 6 GiB = 6,144 before that).
 *
 * Why it moved. Every 6 GB laptop card the project has seen reports BELOW 6,144 on the Vulkan
 * backend — GTX 1660 SUPER **5,746**, RTX 4050 Laptop **5,921**, RTX 3060 Laptop **5,994** — while
 * an RTX 2060 reports exactly 6,144. That is not a driver quirk to be corrected: the RTX 3060
 * Laptop exposes ONE 5,994 MiB device-local heap and the probe reports exactly it (`nvidia-smi`'s
 * round 6,144 is the marketing figure). So the common 6 GB laptop was classed `cpu` and got the RAM
 * pick. #318 leg 4 measured what that costs: the gate changes nothing about PLACEMENT — llama.cpp's
 * fit put the RAM pick fully on the sub-gate card (E2B 36/36, 86 tok/s) — it only changes which
 * model is starred. The case that bites is the 16 GB gaming laptop, whose RAM pick is the 9B, and
 * the 9B on that card measured **18/33 layers at 5.2 tok/s**. With the gate at 5,120 the card path
 * stars the 4B instead, fully offloaded at card speed.
 *
 * Why 5,120 and not lower — the reason RESTATED 2026-09-08 (owner decision on #321), because the
 * original one went void; its arithmetic was corrected again 2026-09-10 (#413). #321 argued that
 * keeping 4 GB cards (≈ 4,096) out costs nothing "since nothing ranked fits them anyway". That
 * arithmetic died with the estimate fixes: the E2B now needs 2,271 MiB (#319 + #321 + the
 * host-mapped BASE fix), so a 4 GB card CAN hold a ranked model. The floor stays for a different,
 * measured reason: at the budget such a card actually produces the E2B is the ONLY ranked model
 * that fits, so admitting 4 GB cards would star it at every RAM size — demoting the 9B at 16 GB and
 * the 27B Q5 at 32 GB to the smallest model in the catalog. That is the same trade #321 made at
 * 6 GB, but there it was backed by a measurement (the 9B at 18/33 layers, 5.2 tok/s, against the 4B
 * fully offloaded) and here there is NONE — no 4 GB card has ever been measured in this project.
 * Lowering the floor on an unmeasured guess would risk the #318 leg-4 mistake in reverse.
 *
 * What "the budget such a card actually produces" is (#413, 2026-09-10). The 2026-09-08 text put it
 * at ~3,900 MiB free, which #391 then undercut: the 4B's measured host-mapped weights moved its need
 * 4,410 → 3,838, and 3,900 clears that. But 3,900 was never a measurement — it is a TEST FIXTURE
 * invented alongside this constant's own change, and no 4 GB card has ever been probed. Every card
 * that HAS been probed idles with the same reserve, set by the desktop rather than by the size of
 * the card: 768 MiB on the RTX 3060 Laptop (5,994 → 5,226), 769 on the GTX 1070 Ti (8,273 → 7,504),
 * 768 on the RTX 3080 Ti (12,084 → 11,316), 1,014 on the RTX 3090 — and those are FLOORS, the same
 * 1070 Ti having been seen at 1,686 used. So `graphicsBudgetMib` on a 4 GB card is ≈ 4,096 − 768 =
 * 3,328, not 3,900, and the 4B does not fit it: a card would have to REPORT ≥ 4,606 MiB for that.
 * Both budget forms — the probe's free figure and the no-free-figure total − 1,024 = 3,072 — still
 * collapse to the E2B alone, and both are pinned in `committed-catalog.test.ts`.
 *
 * Decided 2026-09-11 (owner, #413): the floor stays, with NO 4 GB measurement planned (the project
 * owns no such card). Keeping it is the side that corrects itself: the floor never moves placement,
 * so a 4 GB-card machine gets the RAM pick partly offloaded onto its card, and a crawl on that pick
 * steps the ★ down (§6.5, `applySpeedSignal`). A lowered floor would pin the E2B at every RAM size,
 * and nothing steps a pick back up.
 *
 * What reopens it: a 4 GB card measured on the protocol, by anyone who has one. Note that 4,096 is
 * NOT the floor value to lower to — reported totals do not track nominal capacity and the four
 * measured cards split both ways (3080 Ti 12,084 of 12,288 and 3060 Laptop 5,994 of 6,144, against
 * 1070 Ti 8,273 of 8,192 and 3090 24,822 of 24,576, the latter two summing a second BAR heap).
 * Choosing off the nominal figure is the #321 mistake this constant exists to record. Above the
 * floor, 5,120 admits all three measured 6 GB cards with room for driver variance.
 *
 * Blast radius, accepted by the owner: the profile bump moves such a laptop one step up (label + the
 * RAM-unknown fallback picker only), and the graphics tile reads "Usable" for these cards — which
 * matches what the fit does with them. Record: `model-benchmarks.md` §6.6 N8.
 */
export const USABLE_VRAM_MB = 5120
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
  // PR #308 audit (decision 9, finding R6) — the current-generation integrated names the
  // pinned b9849 Vulkan build reports, none of which the patterns above matched (so a hybrid
  // laptop's 11–36 GiB of SHARED memory read as a discrete card on every consumer):
  //   - "Intel(R) Graphics (ARL)" / "(LNL)"   (Arrow/Lunar-Lake iGPU: the bare "Graphics"
  //     form with the platform code in parentheses)
  //   - "Intel(R) Arc(TM) 140V GPU (16GB)"    (Lunar-Lake "Arc 1xxV" iGPU; a discrete Arc is
  //     "Arc(TM) A770" / "A750" and must NOT match)
  //   - "AMD Radeon 780M Graphics (RADV PHOENIX)", "890M … (RADV GFX1150)" (RADV APU names
  //     WITHOUT "(TM)" and WITH a trailing driver tag, which `radeon.*graphics$` misses) and
  //     the Strix Halo "AMD Radeon 8060S Graphics (RADV GFX1151)"; the discrete laptop
  //     "AMD Radeon RX 7700S" carries "RX" and no "Graphics" and must NOT match
  // Owner decision 2026-09-07 (#320, after the #318 hardware session):
  //   - "Intel(R) Graphics"                   the BARE Arrow/Lunar-Lake name with NO platform
  //     code — the `intel\(r\) graphics \(` alternative above needs the "(ARL)"/"(LNL)" suffix,
  //     so this form read as DISCRETE and a 16–36 GiB shared-memory iGPU could become the
  //     budget device (a false NEGATIVE — the one direction the bias note forbids). The
  //     alternative is ANCHORED to the whole trimmed string so a discrete Arc that carries its
  //     model number ("Intel(R) Arc(TM) A770 Graphics", "B580") still does NOT match.
  // Why the app still passes no `--device` to exclude an iGPU at launch (#320 (j), decided
  // 2026-09-07 — the "the fit spreads layers over every listed device" premise was MEASURED
  // FALSE on b9849): on the desktop hybrid the fit logged both devices in `device_info` and
  // then "using device Vulkan0" only (`eval/results/hardware/i9-14900k-rtx-3080-ti-12gb-64gb/
  // leg5-baseline.*`); on the APU-first laptop, where the iGPU is listed FIRST, every GPU
  // buffer landed on the RTX and the fit's own device list never contained the iGPU — its
  // "device 0" was Vulkan1 (`…/ryzen-7-5800h-rtx-3060-laptop-6gb-14gb/leg5-device-landing.comment.md`).
  // llama.cpp drops the integrated device BY TYPE before the filling pass, so an app-side
  // `--device` would change nothing, would break the ladder's contract that `--device none` is
  // the only device argument, and would add a name→device mapping that must survive driver renames.
  return /iris|uhd|intel\(r\) (hd|arc.*integrated)|intel\(r\) graphics \(|^\s*intel\(r\) graphics\s*$|arc\(tm\) graphics|arc\(tm\) 1\d{2}v|radeon(\(tm\))? graphics|radeon(\(tm\))? \d{3,4}[ms] graphics|radeon.*graphics$|vega \d+/i.test(
    name
  )
}

/**
 * At or above `USABLE_VRAM_MB` AND not integrated-looking: a device a model can actually be
 * accelerated on (the floor is 5 GiB since #321, 2026-09-07 — see the constant). The
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
 * The device every recorded figure is taken from — the BUDGET device: the LARGEST useful
 * device (PR #308 audit decision 9, `selectBudgetDevice` in `services/performance.ts` is this
 * very function), or null when none is useful. On a hybrid `[iGPU, dGPU]` box this is the
 * dGPU — the old `devices[0]` was the iGPU's shared figure (M8.2) — and with two usable cards
 * the bigger one, whichever the driver listed first (the PR #303 P5 rule took the first useful
 * device; the two were unified at the #303/#308 merge so the tile, `currentGpu`, the benchmark
 * record, the placement budget and the Models ★ have exactly one answer to "which card"). Its
 * `name` and `totalMb` are always paired: a reader never combines one device's name with
 * another's memory.
 */
export function primaryUsefulDevice<T extends GpuDeviceLike>(devices: readonly T[]): T | null {
  let best: T | null = null
  for (const device of devices) {
    if (!isUsefulDevice(device)) continue
    if (best == null || device.totalMb > best.totalMb) best = device
  }
  return best
}

/**
 * What a screen may SHOW — the device the graphics tile names (`PerformanceSnapshot.graphicsDevice`)
 * and a GPU start is labelled with: the primary useful device (`useful: true`); else the LARGEST
 * device that does not look integrated (`useful: false` — a discrete card under the gate, such as
 * a 4 GB card, or a 6 GB one whose driver reports it under 5,120 MiB); else the first
 * listed device (`useful: false` — an integrated-only machine). An unusable device is named with
 * its OWN memory figure so the copy can say "small" or "integrated, shared memory" honestly, never
 * implying acceleration — on a hybrid laptop the old `devices[0]` fallback named the iGPU's shared
 * figure while the real card went unmentioned. Whether the card is USED is the budget device's
 * question (`primaryUsefulDevice`), never this one's (owner decision 2026-09-07: the tile shows
 * the real card and its memory regardless of the gate). Null with no device at all. The snapshot's
 * `currentGpu`, the benchmark record, the placement budget and the Models ★ keep naming the
 * budget device only (`nextStartMemory`, null with no usable card or the GPU switched off).
 */
export function displayDevice<T extends GpuDeviceLike>(devices: readonly T[]): { device: T; useful: boolean } | null {
  const primary = primaryUsefulDevice(devices)
  if (primary) return { device: primary, useful: true }
  let discrete: T | null = null
  for (const device of devices) {
    if (looksIntegrated(device.name)) continue
    if (discrete == null || device.totalMb > discrete.totalMb) discrete = device
  }
  if (discrete) return { device: discrete, useful: false }
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
