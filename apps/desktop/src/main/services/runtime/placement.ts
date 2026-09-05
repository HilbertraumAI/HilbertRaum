import type { ModelPlacement } from '../../../shared/types'

// Where a model's start actually put it (benchmark.md "Your model"). llama.cpp's load log
// is the only place the real outcome of `--fit` is reported: the layer split, the bytes each
// device holds for the weights, and the context-cache buffers. The translation sidecar
// already reads the offload line for its device hint; this parser reads the whole set for
// the chat runtime and hands one observation per successful start to the observer below
// (the read-speed.ts idiom: a module-level latch plus one persister registered by the IPC
// layer, so producers never touch settings).
//
// Lines, across the naming drift between builds (`llm_load_tensors:` / `load_tensors:`,
// `llama_kv_cache_unified:` / `llama_kv_cache:`):
//   load_tensors: offloaded 65/65 layers to GPU
//   load_tensors:   CUDA0 model buffer size = 18942.52 MiB
//   load_tensors:   CPU_Mapped model buffer size =   400.00 MiB
//   llama_kv_cache: CUDA0 KV buffer size = 1360.00 MiB
//   ggml_metal_init: recommendedMaxWorkingSetSize = 51539.61 MB
// A device whose name starts with "CPU" (CPU, CPU_Mapped) or ends in "_Host" (Vulkan_Host,
// CUDA_Host: pinned host memory the backend keeps CPU-side) is the CPU side; everything else
// is a GPU. The lines are printed from log verbosity 4 up (`-lv 4`, CHAT_SERVER_ARGS).

const OFFLOAD_RE = /offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU/
const MODEL_BUFFER_RE = /(\S+) model buffer size\s*=\s*([\d.]+)\s*MiB/
const KV_BUFFER_RE = /(\S+) KV buffer size\s*=\s*([\d.]+)\s*MiB/
/** `sched_reserve:    Vulkan0 compute buffer size =  2860.00 MiB` (the working buffers). */
const COMPUTE_BUFFER_RE = /(\S+) compute buffer size\s*=\s*([\d.]+)\s*MiB/
const METAL_BUDGET_RE = /recommendedMaxWorkingSetSize\s*=\s*([\d.]+)\s*MB/
/** `device_info` rows: `  - Vulkan0 : NVIDIA GeForce RTX 3090 (24822 MiB, 2703 MiB free)`. */
const DEVICE_INFO_RE = /-\s+(\S+)\s+:\s+.*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/

/** What one start's log said; every figure null until its line is seen. */
export interface PlacementReading {
  gpuLayers: number | null
  totalLayers: number | null
  gpuModelMb: number | null
  cpuModelMb: number | null
  gpuKvMb: number | null
  cpuKvMb: number | null
  metalMaxWorkingSetMb: number | null
  /** Free MiB on the first GPU device when the server started (the `device_info` block). */
  gpuFreeAtStartMb: number | null
  /** Working (compute) buffers reserved on GPU devices, MiB summed. */
  gpuComputeMb: number | null
}

export interface PlacementParser {
  /** Feed a stderr chunk (chunks can split lines; the parser reassembles them). */
  onStderrData: (text: string) => void
  /** The reading so far. */
  reading: () => PlacementReading
}

function isCpuDevice(name: string): boolean {
  const upper = name.toUpperCase()
  return upper.startsWith('CPU') || upper.endsWith('_HOST')
}

/** One parser per start attempt: a retried rung gets a fresh reading. */
export function createPlacementParser(): PlacementParser {
  const r: PlacementReading = {
    gpuLayers: null,
    totalLayers: null,
    gpuModelMb: null,
    cpuModelMb: null,
    gpuKvMb: null,
    cpuKvMb: null,
    metalMaxWorkingSetMb: null,
    gpuFreeAtStartMb: null,
    gpuComputeMb: null
  }
  let pending = ''
  const add = (key: 'gpuModelMb' | 'cpuModelMb' | 'gpuKvMb' | 'cpuKvMb' | 'gpuComputeMb', mb: number): void => {
    r[key] = Math.round(((r[key] ?? 0) + mb) * 100) / 100
  }
  const line = (text: string): void => {
    const off = OFFLOAD_RE.exec(text)
    if (off) {
      r.gpuLayers = Number(off[1])
      r.totalLayers = Number(off[2])
      return
    }
    const model = MODEL_BUFFER_RE.exec(text)
    if (model) {
      add(isCpuDevice(model[1]) ? 'cpuModelMb' : 'gpuModelMb', Number(model[2]))
      return
    }
    const kv = KV_BUFFER_RE.exec(text)
    if (kv) {
      add(isCpuDevice(kv[1]) ? 'cpuKvMb' : 'gpuKvMb', Number(kv[2]))
      return
    }
    const compute = COMPUTE_BUFFER_RE.exec(text)
    if (compute) {
      if (!isCpuDevice(compute[1])) add('gpuComputeMb', Number(compute[2]))
      return
    }
    const metal = METAL_BUDGET_RE.exec(text)
    if (metal) {
      r.metalMaxWorkingSetMb = Math.round(Number(metal[1]))
      return
    }
    // The FIRST GPU device's free figure: the fit works against what was free right then.
    const dev = DEVICE_INFO_RE.exec(text)
    if (dev && !isCpuDevice(dev[1]) && r.gpuFreeAtStartMb == null) r.gpuFreeAtStartMb = Number(dev[3])
  }
  return {
    onStderrData: (text) => {
      pending += text
      let nl = pending.indexOf('\n')
      while (nl >= 0) {
        line(pending.slice(0, nl))
        pending = pending.slice(nl + 1)
        nl = pending.indexOf('\n')
      }
    },
    reading: () => ({ ...r })
  }
}

let latest: ModelPlacement | null = null
let observer: ((placement: ModelPlacement) => void) | null = null

/** Record one successful start's placement (the ladder calls this once the rung is healthy). */
export function recordModelPlacement(placement: ModelPlacement): void {
  latest = placement
  try {
    observer?.(placement)
  } catch {
    /* persistence is an observer concern; it must never throw into a start */
  }
}

/** The last placement recorded this session, or null. */
export function latestModelPlacement(): ModelPlacement | null {
  return latest
}

/** Register the single persister (the IPC layer). Last registration wins. */
export function setModelPlacementObserver(cb: ((placement: ModelPlacement) => void) | null): void {
  observer = cb
}

/** Test seam. */
export function resetModelPlacementForTests(): void {
  latest = null
  observer = null
}
