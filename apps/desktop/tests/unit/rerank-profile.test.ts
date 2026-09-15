import { describe, it, expect } from 'vitest'
import {
  CPU_HI_MIN_THREADS,
  GPU_RERANK_SCOPE,
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

  it('cpu-hi: no usable card, threads at the threshold, opt-in ON → top48, cpu device', () => {
    const i = input({ probeDevices: [], threads: CPU_HI_MIN_THREADS, wideScopeOptIn: true })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('cpu-hi')
    expect(rerankScopeFor(profile, i)).toBe('top48')
    expect(rerankerDeviceFor(profile)).toBe('cpu')
  })

  it('cpu-hi: the SAME machine with the opt-in OFF stays capped (default off — no effect until opted in)', () => {
    const i = input({ probeDevices: [], threads: CPU_HI_MIN_THREADS, wideScopeOptIn: false })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('cpu-hi')
    expect(rerankScopeFor(profile, i)).toBe('capped')
    expect(rerankerDeviceFor(profile)).toBe('cpu')
  })

  it('default: no usable card, below the thread threshold → capped, cpu device', () => {
    const i = input({ probeDevices: [], threads: 4 })
    const profile = resolveRerankProfile(i)
    expect(profile).toBe('default')
    expect(rerankScopeFor(profile, i)).toBe('capped')
    expect(rerankerDeviceFor(profile)).toBe('cpu')
  })

  it('gpuMode "off" with a usable card present → never gpu', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'off', threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
    expect(resolveRerankProfile(i)).toBe('cpu-hi')
  })

  it('gpuAutoDisabled with a usable card present → never gpu', () => {
    const i = input({ probeDevices: [RTX_3080_TI], gpuMode: 'auto', gpuAutoDisabled: true, threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
    expect(resolveRerankProfile(i)).toBe('cpu-hi')
  })

  it('probe null (unknown — never "no device", never "usable") with threads 16 → cpu-hi, never gpu', () => {
    const i = input({ probeDevices: null, gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    expect(resolveRerankProfile(i)).toBe('cpu-hi')
  })

  it('an integrated-only probe never counts as usable → not gpu', () => {
    const i = input({ probeDevices: [IRIS_XE], gpuMode: 'auto', gpuAutoDisabled: false, threads: 16 })
    expect(resolveRerankProfile(i)).not.toBe('gpu')
    expect(resolveRerankProfile(i)).toBe('cpu-hi')
  })

  it('rerankerAvailable false → capped on every profile, regardless of hardware', () => {
    const gpuInput = input({ probeDevices: [RTX_3080_TI], threads: 16, rerankerAvailable: false })
    const cpuHiInput = input({ probeDevices: [], threads: CPU_HI_MIN_THREADS, wideScopeOptIn: true, rerankerAvailable: false })
    const defaultInput = input({ probeDevices: [], threads: 4, rerankerAvailable: false })
    expect(rerankScopeFor(resolveRerankProfile(gpuInput), gpuInput)).toBe('capped')
    expect(rerankScopeFor(resolveRerankProfile(cpuHiInput), cpuHiInput)).toBe('capped')
    expect(rerankScopeFor(resolveRerankProfile(defaultInput), defaultInput)).toBe('capped')
  })

  it('the thread boundary: CPU_HI_MIN_THREADS - 1 → default, CPU_HI_MIN_THREADS → cpu-hi', () => {
    const below = input({ probeDevices: [], threads: CPU_HI_MIN_THREADS - 1 })
    const at = input({ probeDevices: [], threads: CPU_HI_MIN_THREADS })
    expect(resolveRerankProfile(below)).toBe('default')
    expect(resolveRerankProfile(at)).toBe('cpu-hi')
  })
})
