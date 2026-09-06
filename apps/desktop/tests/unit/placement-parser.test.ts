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
// landed. Lines arrive as arbitrary stderr chunks; devices named CPU* — and the backends'
// pinned `<Backend>_Host` buffers — are the CPU side.
//
// The fixtures below are handwritten from the log shapes the pinned build prints (a captured
// real verbosity-4 log is tracked as a separate follow-up issue).

const LOG = [
  '0.00.132.667 I device_info:',
  '0.00.137.024 I   - Vulkan0 : NVIDIA GeForce RTX 3090 (24822 MiB, 22900 MiB free)',
  '0.00.137.033 I   - CPU     : Intel(R) Core(TM) i9-9900X CPU @ 3.50GHz (128493 MiB, 128493 MiB free)',
  'load_tensors: offloading 41 repeating layers to GPU',
  'load_tensors: offloaded 41/41 layers to GPU',
  'load_tensors:   CUDA0 model buffer size = 5500.25 MiB',
  'load_tensors:   CPU_Mapped model buffer size =   400.00 MiB',
  'llama_kv_cache: CUDA0 KV buffer size = 640.00 MiB',
  'sched_reserve:      CUDA0 compute buffer size =  2860.00 MiB',
  'sched_reserve:   CUDA_Host compute buffer size =    40.00 MiB',
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
      metalMaxWorkingSetMb: 51540,
      // The first GPU row of device_info, never the CPU row.
      gpuFreeAtStartMb: 22900,
      // GPU-side working buffers only (the host compute buffer is not card memory).
      gpuComputeMb: 2860,
      // Every GPU row of device_info, label ↔ name (DR2). The compute buffer is filed by LABEL:
      // this handwritten fixture's buffer lines say CUDA0, a label the device block never
      // listed, so nothing is filed on Vulkan0 — the summed figure above still counts it.
      devices: [{ label: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 22900, computeMb: null }]
    })
  })

  it('keeps every GPU row of a hybrid device_info block with its own compute buffer, by label (DR2)', () => {
    const p = createPlacementParser()
    p.onStderrData(
      [
        '0.00.132.667 I device_info:',
        '0.00.137.024 I   - Vulkan0 : Intel(R) Iris(R) Xe Graphics (16384 MiB, 15000 MiB free)',
        '0.00.137.030 I   - Vulkan1 : NVIDIA GeForce RTX 3090 (24822 MiB, 2703 MiB free)',
        '0.00.137.033 I   - CPU     : Intel(R) Core(TM) i7-1260P (16077 MiB, 9000 MiB free)',
        'load_tensors: offloaded 62/66 layers to GPU',
        'sched_reserve:      Vulkan1 compute buffer size =  2860.00 MiB',
        'sched_reserve:      Vulkan0 compute buffer size =   300.00 MiB',
        'sched_reserve:  Vulkan_Host compute buffer size =    40.00 MiB',
        ''
      ].join('\n')
    )
    const r = p.reading()
    expect(r.devices).toEqual([
      { label: 'Vulkan0', name: 'Intel(R) Iris(R) Xe Graphics', totalMb: 16384, freeMb: 15000, computeMb: 300 },
      { label: 'Vulkan1', name: 'NVIDIA GeForce RTX 3090', totalMb: 24822, freeMb: 2703, computeMb: 2860 }
    ])
    // The legacy summary fields keep their meaning: the FIRST row's free figure, the sum over
    // every GPU device — which is exactly why a hybrid box needs the rows (the dGPU's spill
    // must not be explained with the iGPU's 15 GB free).
    expect(r.gpuFreeAtStartMb).toBe(15000)
    expect(r.gpuComputeMb).toBe(3160)
    // A name with its own parentheses survives the row parse.
    const q = createPlacementParser()
    q.onStderrData('  - Vulkan0 : Intel(R) UHD Graphics 630 (CFL GT2) (8000 MiB, 7000 MiB free)\n')
    expect(q.reading().devices).toEqual([{ label: 'Vulkan0', name: 'Intel(R) UHD Graphics 630 (CFL GT2)', totalMb: 8000, freeMb: 7000, computeMb: null }])
  })

  it('reassembles lines split across chunks and sums several devices', () => {
    const p = createPlacementParser()
    const text = [
      'llm_load_tensors: offloaded 30/41 layers to GPU',
      'llm_load_tensors: Vulkan0 model buffer size = 3000.00 MiB',
      'llm_load_tensors: Vulkan1 model buffer size = 1000.00 MiB',
      'llm_load_tensors: CPU model buffer size = 1500.50 MiB',
      'llm_load_tensors: Vulkan_Host model buffer size = 400.00 MiB',
      'llama_kv_cache_unified: Vulkan0 KV buffer size = 400.00 MiB',
      'llama_kv_cache_unified: CPU KV buffer size = 240.00 MiB',
      ''
    ].join('\n')
    for (let i = 0; i < text.length; i += 7) p.onStderrData(text.slice(i, i + 7))
    const r = p.reading()
    expect(r.gpuLayers).toBe(30)
    expect(r.totalLayers).toBe(41)
    expect(r.gpuModelMb).toBe(4000)
    // CPU, CPU_Mapped and the backends' *_Host pinned buffers are all the CPU side.
    expect(r.cpuModelMb).toBe(1900.5)
    expect(r.gpuKvMb).toBe(400)
    expect(r.cpuKvMb).toBe(240)
    expect(r.metalMaxWorkingSetMb).toBeNull()
    expect(r.gpuFreeAtStartMb).toBeNull()
    expect(r.gpuComputeMb).toBeNull()
  })

  it('reads the pinned build\'s timestamped, level-tagged lines (verbosity 4 output, 2026-09-05)', () => {
    const p = createPlacementParser()
    p.onStderrData([
      '0.01.437.299 I load_tensors: offloaded 25/25 layers to GPU',
      '0.01.437.304 I load_tensors:   CPU_Mapped model buffer size =   397.85 MiB',
      '0.01.437.305 I load_tensors:      Vulkan0 model buffer size =  1267.23 MiB',
      '0.01.819.714 I llama_kv_cache:    Vulkan0 KV buffer size =    24.00 MiB',
      ''
    ].join('\n'))
    expect(p.reading()).toMatchObject({ gpuLayers: 25, totalLayers: 25, gpuModelMb: 1267.23, cpuModelMb: 397.85, gpuKvMb: 24 })
  })

  it('files the GPU backend\'s _Host KV buffer under the CPU side (the partial-offload spill)', () => {
    // ggml names a backend's pinned host buffer type "<Backend>_Host" (the pinned Windows
    // build's ggml-vulkan.dll carries the literal "Vulkan_Host"). llama.cpp puts the context
    // cache of the NON-offloaded layers there, so a partial offload spills into it: counting
    // it as GPU memory would overstate what is on the card.
    const p = createPlacementParser()
    p.onStderrData([
      'load_tensors: offloaded 30/41 layers to GPU',
      'load_tensors:   Vulkan0 model buffer size =  4000.00 MiB',
      'load_tensors:   CPU_Mapped model buffer size =  1900.00 MiB',
      'llama_kv_cache: Vulkan0 KV buffer size = 400.00 MiB',
      'llama_kv_cache: Vulkan_Host KV buffer size = 240.00 MiB',
      'llama_kv_cache: CUDA_Host KV buffer size = 60.00 MiB',
      ''
    ].join('\n'))
    const r = p.reading()
    expect(r.gpuKvMb).toBe(400)
    expect(r.cpuKvMb).toBe(300)
    expect(r.gpuModelMb).toBe(4000)
    expect(r.cpuModelMb).toBe(1900)
  })

  it('files a CUDA_Host model buffer (--no-mmap CPU-side weights) under the CPU side', () => {
    const p = createPlacementParser()
    p.onStderrData('load_tensors: CUDA_Host model buffer size = 1900.00 MiB\n')
    expect(p.reading().cpuModelMb).toBe(1900)
    expect(p.reading().gpuModelMb).toBeNull()
  })

  it('stays all-null on a log without those lines (a forced-CPU start), with no device rows', () => {
    const p = createPlacementParser()
    p.onStderrData('main: server is listening on http://127.0.0.1:1234\n')
    const { devices, ...figures } = p.reading()
    expect(devices).toEqual([])
    expect(Object.values(figures).every((v) => v === null)).toBe(true)
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
