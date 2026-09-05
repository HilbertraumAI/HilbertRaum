import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPlacementParser,
  latestModelPlacement,
  recordModelPlacement,
  resetModelPlacementForTests,
  setModelPlacementObserver
} from '../../src/main/services/runtime/placement'
import type { ModelPlacement } from '../../src/shared/types'

// benchmark.md "Your model": the chat runtime reads llama.cpp's load log for where the model
// landed. Lines arrive as arbitrary stderr chunks; devices named CPU* are the CPU side.

const LOG = [
  'load_tensors: offloading 41 repeating layers to GPU',
  'load_tensors: offloaded 41/41 layers to GPU',
  'load_tensors:   CUDA0 model buffer size = 5500.25 MiB',
  'load_tensors:   CPU_Mapped model buffer size =   400.00 MiB',
  'llama_kv_cache: CUDA0 KV buffer size = 640.00 MiB',
  'ggml_metal_init: recommendedMaxWorkingSetSize = 51539.61 MB',
  ''
].join('\n')

describe('createPlacementParser', () => {
  it('reads the layer split, the per-device weights, the context cache and the Metal budget', () => {
    const p = createPlacementParser()
    p.onStderrData(LOG)
    expect(p.reading()).toEqual({
      gpuLayers: 41,
      totalLayers: 41,
      gpuModelMb: 5500.25,
      cpuModelMb: 400,
      gpuKvMb: 640,
      cpuKvMb: null,
      metalMaxWorkingSetMb: 51540
    })
  })

  it('reassembles lines split across chunks and sums several devices', () => {
    const p = createPlacementParser()
    const text = [
      'llm_load_tensors: offloaded 30/41 layers to GPU',
      'llm_load_tensors: Vulkan0 model buffer size = 3000.00 MiB',
      'llm_load_tensors: Vulkan1 model buffer size = 1000.00 MiB',
      'llm_load_tensors: CPU model buffer size = 1900.50 MiB',
      'llama_kv_cache_unified: Vulkan0 KV buffer size = 400.00 MiB',
      'llama_kv_cache_unified: CPU KV buffer size = 240.00 MiB',
      ''
    ].join('\n')
    for (let i = 0; i < text.length; i += 7) p.onStderrData(text.slice(i, i + 7))
    const r = p.reading()
    expect(r.gpuLayers).toBe(30)
    expect(r.totalLayers).toBe(41)
    expect(r.gpuModelMb).toBe(4000)
    expect(r.cpuModelMb).toBe(1900.5)
    expect(r.gpuKvMb).toBe(400)
    expect(r.cpuKvMb).toBe(240)
    expect(r.metalMaxWorkingSetMb).toBeNull()
  })

  it('stays all-null on a log without those lines (a forced-CPU start)', () => {
    const p = createPlacementParser()
    p.onStderrData('main: server is listening on http://127.0.0.1:1234\n')
    expect(Object.values(p.reading()).every((v) => v === null)).toBe(true)
  })
})

describe('placement latch + observer', () => {
  beforeEach(() => resetModelPlacementForTests())
  const sample: ModelPlacement = {
    modelId: 'm', contextTokens: 8192, backend: 'gpu', gpuLayers: 41, totalLayers: 41,
    gpuModelMb: 5500, cpuModelMb: 400, gpuKvMb: 640, cpuKvMb: null, metalMaxWorkingSetMb: null,
    machineKey: 'k', at: '2026-09-05T00:00:00Z'
  }

  it('hands each record to the observer and keeps the latest; an observer error never escapes', () => {
    const seen: ModelPlacement[] = []
    setModelPlacementObserver((p) => {
      seen.push(p)
      throw new Error('persist failed')
    })
    expect(() => recordModelPlacement(sample)).not.toThrow()
    expect(seen).toEqual([sample])
    expect(latestModelPlacement()).toEqual(sample)
  })
})
