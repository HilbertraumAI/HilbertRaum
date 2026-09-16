import { describe, it, expect } from 'vitest'
import {
  CPU_HI_MIN_THREADS,
  GPU_RERANK_SCOPE,
  meetsThreadThreshold,
  resolveRerankProfile,
  rerankScopeFor,
  rerankerDeviceFor,
  type RerankProfileInput
} from '../../src/main/services/rag/rerank-profile'
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

describe('resolveRerankProfile / rerankScopeFor / rerankerDeviceFor', () => {
  it('gpu: a usable card, auto mode, not auto-disabled → gpu profile, GPU_RERANK_SCOPE, gpu device', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('gpu')
    expect(rerankScopeFor(profile, i)).toBe(GPU_RERANK_SCOPE)
    expect(rerankerDeviceFor(profile)).toBe('gpu')
  })

  // Run L froze this by NAME (Frozen parameters: "pinned by name, updated in the run-L commit").
  // `rerankScopeFor(profile, i)).toBe(GPU_RERANK_SCOPE)` above is true for ANY value the constant
  // takes (it compares the function's own output against the constant), so it does not, on its
  // own, catch a future edit to the constant's VALUE — this pins the value itself.
  it('GPU_RERANK_SCOPE is frozen at \'all\' (run L, 2026-09-15) — changing this invalidates run A3\'s gpu-profile acceptance read', () => {
    expect(GPU_RERANK_SCOPE).toBe('all')
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

  it('the cpu-hi BRANCH (forced profile, as run A3\'s --profile=cpu-hi and a future re-measurement would use it): opt-in ON → top48, cpu device; opt-in OFF → capped', () => {
    const onInput = input({ probeDevices: [], threads: 8, wideScopeOptIn: true })
    expect(rerankScopeFor('cpu-hi', onInput)).toBe('top48')
    expect(rerankerDeviceFor('cpu-hi')).toBe('cpu')
    const offInput = input({ probeDevices: [], threads: 8, wideScopeOptIn: false })
    expect(rerankScopeFor('cpu-hi', offInput)).toBe('capped')
  })

  it('default: no usable card, a realistic thread count → capped, cpu device (cpu-hi is unreachable — CPU_HI_MIN_THREADS is Infinity)', () => {
    const i = input({ probeDevices: [], threads: 4 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('default')
    expect(rerankScopeFor(profile, i)).toBe('capped')
    expect(rerankerDeviceFor(profile)).toBe('cpu')
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

  it('rerankerAvailable false → capped on every profile, regardless of hardware (checked before any profile branch)', () => {
    const gpuInput = input({ probeDevices: [RTX_3080_TI], threads: 16, rerankerAvailable: false })
    const defaultInput = input({ probeDevices: [], threads: 4, rerankerAvailable: false })
    expect(rerankScopeFor(resolveRerankProfile(gpuInput), gpuInput)).toBe('capped')
    expect(rerankScopeFor(resolveRerankProfile(defaultInput), defaultInput)).toBe('capped')
    // The cpu-hi branch itself, forced (unreachable via resolveRerankProfile today, but the
    // function must still fail safe to capped with no reranker provisioned).
    expect(rerankScopeFor('cpu-hi', { ...defaultInput, wideScopeOptIn: true, rerankerAvailable: false })).toBe('capped')
  })
})
