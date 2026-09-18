import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import {
  CPU_HI_MIN_THREADS,
  GPU_RERANK_SCOPE,
  RERANKER_HEADROOM_FLOOR_MIB,
  meetsThreadThreshold,
  resolveRerankProfile,
  rerankScopeFor,
  rerankerDeviceFor,
  type RerankProfileInput,
  type RerankerHeadroomInput
} from '../../src/main/services/rag/rerank-profile'
import { discoverManifests, estimateGraphicsNeedMib, graphicsBudgetMib } from '../../src/main/services/models'
import type { ModelManifest } from '../../src/shared/manifest'
import type { GpuDevice } from '../../src/shared/types'

// Phase 4 PR-B (step 4-4, Wave 4 ruling (a)). `resolveRerankProfile`/`rerankScopeFor`/
// `rerankerDeviceFor` are the ONE pure decision the per-ask candidate-scope wiring
// (`registerRagIpc.ts` → `zim/arm.ts`) and the sidecar's lazy-start device posture
// (`reranker/llama.ts` via `compose-services.ts`) both read, so the two can never disagree
// about which profile a settings snapshot resolves to. Every fixture below is a full
// `RerankProfileInput` so a change to the interface fails the fixture, not a silent `undefined`.
//
// Run L (2026-09-15, `artifacts/scope-selection.json`) froze `CPU_HI_MIN_THREADS` at `Infinity`
// (a MISS at both 8 and 16 threads — see the constant's own doc comment): the `cpu-hi` PROFILE
// is therefore unreachable by any finite thread count today. The fixtures below split
// accordingly: `resolveRerankProfile` fixtures use finite, realistic thread counts and expect
// `default` wherever the pre-run-L brief would have expected `cpu-hi`; the `cpu-hi` BRANCH of
// `rerankScopeFor`/`rerankerDeviceFor` is still exercised directly, with the profile forced —
// exactly how run A3's `--profile=cpu-hi` acceptance read (and a future re-measurement that
// lowers the constant back to a finite value) uses these functions.

const RTX_3080_TI: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
const IRIS_XE: GpuDevice = { id: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16384, freeMb: 16000 }

// step 4-5 (ruling (d), B2): the shipped manifests the headroom gate's fixtures are measured
// against — the SAME files `main/index.ts`'s `rerankerDevicePosture` seam resolves at runtime,
// loaded here (never hand-duplicated) so a manifest edit is caught by drift, not silently missed.
const MANIFESTS_DIR = join(__dirname, '..', '..', '..', '..', 'model-manifests')
function manifestById(id: string): ModelManifest {
  const found = discoverManifests(MANIFESTS_DIR)
    .manifests.map((m) => m.manifest)
    .find((m) => m.id === id)
  if (!found) throw new Error(`missing manifest ${id}`)
  return found
}
const CHAT_4B_MANIFEST = manifestById('qwen3.5-4b-ud-q4kxl')
const RERANKER_MANIFEST = manifestById('bge-reranker-v2-m3-f16')

function input(overrides: Partial<RerankProfileInput>): RerankProfileInput {
  return {
    gpuMode: 'auto',
    gpuAutoDisabled: false,
    probeDevices: [],
    threads: 4,
    rerankerAvailable: true,
    wideScopeOptIn: false,
    ...overrides
  }
}

describe('resolveRerankProfile / rerankScopeFor (device posture: see "rerankerDeviceFor (step 4-5" below)', () => {
  it('gpu: a usable card, auto mode, not auto-disabled → gpu profile, GPU_RERANK_SCOPE (posture gpu — the provable-headroom machine, unchanged)', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('gpu')
    expect(rerankScopeFor(profile, i, 'gpu')).toBe(GPU_RERANK_SCOPE)
  })

  // Run L froze this by NAME (Frozen parameters: "pinned by name, updated in the run-L commit").
  // `rerankScopeFor(profile, i, 'gpu')).toBe(GPU_RERANK_SCOPE)` above is true for ANY value the
  // constant takes (it compares the function's own output against the constant), so it does not,
  // on its own, catch a future edit to the constant's VALUE — this pins the value itself.
  it('GPU_RERANK_SCOPE is frozen at \'all\' (run L, 2026-09-15) — changing this invalidates run A3\'s gpu-profile acceptance read', () => {
    expect(GPU_RERANK_SCOPE).toBe('all')
  })

  // Wave 6 ruling (a) (scoped Opus review of step 4-5, finding C1): the coupling, required in
  // BOTH directions by ruling (c) — `gpu` profile + `gpu` posture → `all`; `gpu` profile + `cpu`
  // posture → `capped`. The small-card fixture is (ii) below (#318 RTX 3060 Laptop): a usable
  // card for the PROFILE bump (`gpuUsefulForProfile`, ≥ `USABLE_VRAM_MB`) but, per that same
  // fixture in the `rerankerDeviceFor` suite below, insufficient headroom for the POSTURE gate —
  // exactly the combination C1 named.
  it('Wave 6 ruling (a) — the coupling, both directions: gpu profile + gpu posture → all; gpu profile + cpu posture → capped', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('gpu')
    expect(rerankScopeFor(profile, i, 'gpu')).toBe(GPU_RERANK_SCOPE)
    expect(rerankScopeFor(profile, i, 'cpu')).toBe('capped')
  })

  // B12: the `threads >= CPU_HI_MIN_THREADS` comparator, exercised in BOTH directions via the
  // extracted helper — `resolveRerankProfile` alone cannot observe the `true` branch today
  // (`CPU_HI_MIN_THREADS` is `Infinity`), so a comparator inversion (`>` vs `>=`) would otherwise
  // be invisible until a future re-measurement lowers the constant.
  it('meetsThreadThreshold: the comparator is inclusive (>=), exercised at, above and below an injected threshold', () => {
    expect(meetsThreadThreshold(8, 8)).toBe(true) // at the threshold
    expect(meetsThreadThreshold(16, 8)).toBe(true) // above it
    expect(meetsThreadThreshold(7, 8)).toBe(false) // below it
    expect(meetsThreadThreshold(4, CPU_HI_MIN_THREADS)).toBe(false) // the real, frozen (Infinity) threshold
  })

  it('the cpu-hi BRANCH (forced profile, as run A3\'s --profile=cpu-hi and a future re-measurement would use it): opt-in ON → top48; opt-in OFF → capped (posture cpu — cpu-hi\'s only reachable posture)', () => {
    const onInput = input({ probeDevices: [], threads: 8, wideScopeOptIn: true })
    expect(rerankScopeFor('cpu-hi', onInput, 'cpu')).toBe('top48')
    const offInput = input({ probeDevices: [], threads: 8, wideScopeOptIn: false })
    expect(rerankScopeFor('cpu-hi', offInput, 'cpu')).toBe('capped')
  })

  // Wave 6 ruling (a)/(c) — the REGRESSION GUARD: the coupling must be a property of the `gpu`
  // BRANCH only, never the general rule "posture cpu ⇒ capped" (that general rule would also
  // capture `cpu-hi`, whose posture is ALWAYS `cpu` by construction — no usable GPU, so
  // `rerankerDeviceFor`'s first gate refuses it — and would permanently kill the `top48` opt-in
  // Wave 5 ruling (c) preserved behind `CPU_HI_MIN_THREADS`). `CPU_HI_MIN_THREADS` itself stays
  // `Infinity` at the top-level import every OTHER test in this file uses (unchanged — run L's
  // shipped-disabled miss).
  //
  // Scoped Opus review of step 4-6, finding D12: an earlier version of this test injected a
  // finite threshold into `meetsThreadThreshold` directly but forced the `cpu-hi` profile as a
  // string literal, so no finite `CPU_HI_MIN_THREADS` ever reached `resolveRerankProfile` — the
  // test's own name overstated what it proved. This version genuinely lowers the constant, via a
  // `vi.doMock` of `shared/rerank-rules` + a fresh dynamic import of `rerank-profile.ts` scoped to
  // THIS test only (`vi.resetModules()` before and after — the file's top-level, statically
  // imported bindings, used by every other test here, are untouched: they were already resolved
  // before this test body runs, against the real, unmocked module). `resolveRerankProfile` is
  // then asked to resolve the profile for real, not forced, standing in for a future
  // re-measurement that lowers the shipped constant.
  it('Wave 6 ruling (a) — the regression guard: with a genuinely finite CPU_HI_MIN_THREADS (module-mocked) the cpu-hi PROFILE actually resolves, and its opt-in still reaches top48 despite its cpu posture (proves the coupling is scoped to the gpu branch, not a general "posture cpu ⇒ capped" rule)', async () => {
    vi.resetModules()
    vi.doMock('../../src/shared/rerank-rules', () => ({ CPU_HI_MIN_THREADS: 8 }))
    try {
      const mod = await import('../../src/main/services/rag/rerank-profile')
      expect(mod.CPU_HI_MIN_THREADS).toBe(8) // the mock genuinely took — not Infinity
      expect(mod.CPU_HI_MIN_THREADS).not.toBe(CPU_HI_MIN_THREADS) // differs from the real, shipped constant

      const onInput: RerankProfileInput = { ...input({ probeDevices: [], threads: 8, wideScopeOptIn: true }) }
      const profile = mod.resolveRerankProfile(onInput)
      expect(profile).toBe('cpu-hi') // resolved for REAL — not forced as a string literal

      expect(mod.rerankScopeFor(profile, onInput, 'cpu')).toBe('top48')
      const offInput: RerankProfileInput = { ...input({ probeDevices: [], threads: 8, wideScopeOptIn: false }) }
      expect(mod.resolveRerankProfile(offInput)).toBe('cpu-hi')
      expect(mod.rerankScopeFor('cpu-hi', offInput, 'cpu')).toBe('capped')
      // Posture 'gpu' is unreachable in production for cpu-hi (no usable GPU by construction) but
      // must not throw, and must not change the outcome either — the branch never reads posture.
      expect(mod.rerankScopeFor('cpu-hi', onInput, 'gpu')).toBe('top48')
    } finally {
      vi.doUnmock('../../src/shared/rerank-rules')
      vi.resetModules()
    }
  })

  it('default: no usable card, a realistic thread count → capped (cpu-hi is unreachable — CPU_HI_MIN_THREADS is Infinity)', () => {
    const i = input({ probeDevices: [], threads: 4 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('default')
    expect(rerankScopeFor(profile, i, 'cpu')).toBe('capped')
  })

  // Wave 6 ruling (a) — the `default` profile is explicitly UNCHANGED by the coupling, on EITHER
  // posture (the truth table's row for `default`: `capped` regardless).
  it('Wave 6 ruling (a) — default profile unchanged on both postures (the coupling touches only the gpu branch)', () => {
    const i = input({ probeDevices: [], threads: 4 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('default')
    expect(rerankScopeFor(profile, i, 'cpu')).toBe('capped')
    expect(rerankScopeFor(profile, i, 'gpu')).toBe('capped')
  })

  it('no finite thread count reaches cpu-hi today (CPU_HI_MIN_THREADS = Infinity, run L\'s miss) — even a very high count resolves default', () => {
    for (const threads of [8, 16, 64, 128, Number.MAX_SAFE_INTEGER]) {
      const i = input({ probeDevices: [], threads })
      expect(resolveRerankProfile(i)).toBe('default')
    }
    expect(CPU_HI_MIN_THREADS).toBe(Infinity)
  })

  it('gpuMode "off" with a usable card present → never gpu (resolves default: cpu-hi is unreachable)', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'off', threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
    expect(resolveRerankProfile(i)).toBe('default')
  })

  it('gpuAutoDisabled with a usable card present → never gpu (resolves default: cpu-hi is unreachable)', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'auto', gpuAutoDisabled: true, threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
    expect(resolveRerankProfile(i)).toBe('default')
  })

  it('probe null (unknown — never "no device", never "usable") → never gpu, whatever the thread count', () => {
    const i = input({ probeDevices: null, gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
  })

  it('an integrated-only probe never counts as usable → not gpu', () => {
    const i = input({ probeDevices: [IRIS_XE], gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
  })

  it('rerankerAvailable false → capped on every profile, regardless of hardware or posture (checked before any profile/posture branch)', () => {
    const gpuInput = input({ probeDevices: [RTX_3080_TI], threads: 16, rerankerAvailable: false })
    const defaultInput = input({ probeDevices: [], threads: 4, rerankerAvailable: false })
    expect(rerankScopeFor(resolveRerankProfile(gpuInput), gpuInput, 'gpu')).toBe('capped')
    expect(rerankScopeFor(resolveRerankProfile(gpuInput), gpuInput, 'cpu')).toBe('capped')
    expect(rerankScopeFor(resolveRerankProfile(defaultInput), defaultInput, 'cpu')).toBe('capped')
    // The cpu-hi branch itself, forced (unreachable via resolveRerankProfile today, but the
    // function must still fail safe to capped with no reranker provisioned).
    expect(
      rerankScopeFor('cpu-hi', { ...defaultInput, wideScopeOptIn: true, rerankerAvailable: false }, 'cpu')
    ).toBe('capped')
  })
})

// Step 4-5 (ruling (d), B2, scoped Opus review of step 4-4): the reranker's device POSTURE is no
// longer read off `resolveRerankProfile`'s classification — it is gated on PROVABLE HEADROOM on
// the budget device, independent of `gpuUsefulForProfile`'s profile-bump predicate (which is
// measured only against the 5 GiB usable-card floor and says nothing about room for a SECOND
// resident model beside the chat model). The three fixtures below are named by machine, per the
// brief: (i) the measurement machine (provable headroom), (ii) the #318 RTX 3060 Laptop
// (insufficient headroom — this is the "small card" `docs/known-limitations.md` now discloses
// the gate cannot be validated on this project's own hardware), (iii) unknown in three different
// ways. Every fixture loads the REAL shipped manifests (`model-manifests/chat/qwen3.5-4b-ud-
// q4kxl.yaml`, `model-manifests/reranker/bge-reranker-v2-m3.yaml`) through the SAME
// `estimateGraphicsNeedMib`/`graphicsBudgetMib` the production seam (`main/index.ts`'s
// `rerankerDevicePosture`) calls — never a hand-duplicated number — so a manifest edit that
// silently moves the threshold is caught here, not missed.
describe('rerankerDeviceFor (step 4-5, ruling (d) — the headroom gate, B2)', () => {
  // The RTX 3060 Laptop of the #318 hardware session (model-benchmarks.md §6.6 / gpu-rules.ts's
  // own doc comment): reports ONE 5,994 MiB device-local heap, no `freeMb` in that record — the
  // `committed-catalog.test.ts` "noFree" idiom (`GpuDevice` itself declares `freeMb: number`
  // required; real probe data can still omit it, which `graphicsBudgetMib` handles at runtime).
  const RTX_3060_LAPTOP = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994 } as GpuDevice

  function headroom(overrides: Partial<RerankerHeadroomInput> = {}): RerankerHeadroomInput {
    return { probeDevices: [], budgetMib: null, chatModelNeedMib: null, ...overrides }
  }

  it('the reranker floor is the manifest\'s OWN estimateGraphicsNeedMib figure (~2.8 GiB), pinned by value', () => {
    const computed = estimateGraphicsNeedMib(RERANKER_MANIFEST)
    expect(RERANKER_HEADROOM_FLOOR_MIB).toBeCloseTo(computed, 6)
    expect(RERANKER_HEADROOM_FLOOR_MIB).toBeCloseTo(2808.2015380859375, 6)
    expect(RERANKER_HEADROOM_FLOOR_MIB / 1024).toBeCloseTo(2.74, 1) // "≈ 2.8 GiB", ruling (d)
  })

  it('(i) provable headroom — the measurement machine (RTX 3080 Ti, the shipped 4B chat model active) → gpu', () => {
    const budgetMib = graphicsBudgetMib(RTX_3080_TI)
    const chatModelNeedMib = estimateGraphicsNeedMib(CHAT_4B_MANIFEST)
    // Recorded per ruling (d): the computed headroom figures for this fixture.
    expect(budgetMib).toBe(11511) // the probe's own freeMb — used verbatim
    expect(chatModelNeedMib).toBeCloseTo(3837.397345214844, 6)
    expect(budgetMib! - chatModelNeedMib!).toBeGreaterThanOrEqual(RERANKER_HEADROOM_FLOOR_MIB)
    expect(rerankerDeviceFor(headroom({ probeDevices: [RTX_3080_TI], budgetMib, chatModelNeedMib }))).toBe('gpu')
  })

  it('(ii) insufficient headroom — the #318 RTX 3060 Laptop (no freeMb, the shipped 4B chat model active) → cpu', () => {
    const budgetMib = graphicsBudgetMib(RTX_3060_LAPTOP)
    const chatModelNeedMib = estimateGraphicsNeedMib(CHAT_4B_MANIFEST)
    // Recorded per ruling (d): no probed freeMb, so the budget falls back to totalMb minus the
    // idle-desktop allowance (`GRAPHICS_IDLE_ALLOWANCE_MIB`, 1,024) — 5,994 − 1,024 = 4,970.
    expect(budgetMib).toBe(5994 - 1024)
    expect(budgetMib! - chatModelNeedMib!).toBeLessThan(RERANKER_HEADROOM_FLOOR_MIB)
    expect(rerankerDeviceFor(headroom({ probeDevices: [RTX_3060_LAPTOP], budgetMib, chatModelNeedMib }))).toBe('cpu')
  })

  it('(iii) unknown, three ways — a null probe, an eligible probe with no useful device, and no active chat model → cpu in each', () => {
    const budgetMib = graphicsBudgetMib(RTX_3080_TI)
    const chatModelNeedMib = estimateGraphicsNeedMib(CHAT_4B_MANIFEST)
    // A null probe (the #380 semantics: unknown, never "usable").
    expect(rerankerDeviceFor(headroom({ probeDevices: null, budgetMib, chatModelNeedMib }))).toBe('cpu')
    // An eligible probe, but no device passes isUsefulDevice (an integrated-only machine).
    expect(
      rerankerDeviceFor(
        headroom({ probeDevices: [IRIS_XE], budgetMib: graphicsBudgetMib(IRIS_XE), chatModelNeedMib })
      )
    ).toBe('cpu')
    // No active chat model / an unresolvable manifest -> chatModelNeedMib is null.
    expect(
      rerankerDeviceFor(headroom({ probeDevices: [RTX_3080_TI], budgetMib, chatModelNeedMib: null }))
    ).toBe('cpu')
  })

  it('an empty probeDevices list (the caller\'s gpuMode-off/auto-disabled gate) is "not provable" too, whatever the figures', () => {
    // main/index.ts's rerankerDevicePosture passes `probeDevices: null` when gpuMode is 'off' or
    // gpuAutoDisabled — this pins that the pure function ALSO refuses an empty array (a probe
    // that came back with literally no devices), not only null, so a caller that passes `[]`
    // instead of `null` cannot accidentally earn `gpu` on huge budget/need numbers.
    expect(rerankerDeviceFor(headroom({ probeDevices: [], budgetMib: 999_999, chatModelNeedMib: 1 }))).toBe('cpu')
  })
})
