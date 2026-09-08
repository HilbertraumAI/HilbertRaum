import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
// Two kinds of fixture, and the difference matters (#329):
//
//   REAL — `tests/fixtures/placement-b9849-*.txt`, four verbosity-4 load logs captured from the
//   PINNED build (b9849 799fcc04a) on real hardware and committed byte-for-byte: a 20/33 and an
//   18/33 partial offload on a hybrid Radeon-iGPU + RTX-3060 laptop, a 62/66 start with an MTP
//   draft context on an RTX 3090, and a 49/49 full offload of Gemma (its SWA cache prints TWO KV
//   buffers). Every figure asserted against them is grep-checkable in the file. They are what
//   found the two parser gaps this change fixes: the `RS buffer size` line matched no regex, and
//   an MTP start's draft-context compute buffer was summed a third time when llama.cpp reprints
//   its unchanged size on the speculative re-reserve.
//
//   HANDWRITTEN — the LOG constant and the small cases below, kept because NO captured log
//   witnesses their shapes: CUDA and Metal devices (every capture is Vulkan on Windows/Linux),
//   the legacy `llm_load_tensors:` / `llama_kv_cache_unified:` prefixes, chunk reassembly at
//   pathological boundaries, two GPUs both holding weights, and a `<Backend>_Host` KV buffer —
//   a real partial offload spills its cache into a plain `CPU KV` buffer instead, so that branch
//   stays convention-pinned (docs/benchmark.md M7).
//
// benchmark.md "Your model" reads all of it; devices named CPU* — and the backends' pinned
// `<Backend>_Host` buffers — are the CPU side.

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')

/** Feed a whole log through the parser in 4 KiB chunks — line reassembly stays exercised. */
const feed = (text: string): ReturnType<typeof createPlacementParser> => {
  const p = createPlacementParser()
  for (let i = 0; i < text.length; i += 4096) p.onStderrData(text.slice(i, i + 4096))
  return p
}

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
      // No `RS buffer size` line: a dense transformer has no recurrent state (#329).
      gpuRsMb: null,
      cpuRsMb: null,
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

  // ── Captured real logs from the pinned build (#329) ────────────────────────────────────────

  it('reads a REAL 20/33 partial offload on a hybrid iGPU + dGPU laptop, whole reading (b9849)', () => {
    const r = feed(fixture('placement-b9849-partial-20of33-hybrid.txt')).reading()
    // Every figure below is one grep away in the fixture:
    //   198 `load_tensors: offloaded 20/33 layers to GPU`
    //   199 `load_tensors:   CPU_Mapped model buffer size =  2286.14 MiB`
    //   200 `load_tensors:      Vulkan1 model buffer size =  3393.11 MiB`
    //   221 `llama_kv_cache:        CPU KV buffer size =    96.00 MiB`   <- a real partial
    //   222 `llama_kv_cache:    Vulkan1 KV buffer size =   160.00 MiB`      offload spills into
    //   226 `llama_memory_recurrent:        CPU RS buffer size =    20.94 MiB`  a PLAIN `CPU KV`
    //   227 `llama_memory_recurrent:    Vulkan1 RS buffer size =    29.31 MiB`  buffer, not `_Host`
    //   234 `sched_reserve:    Vulkan1 compute buffer size =   498.00 MiB`
    //   235 `sched_reserve: Vulkan_Host compute buffer size =   128.16 MiB`  <- dropped: host memory
    expect(r).toEqual({
      gpuLayers: 20,
      totalLayers: 33,
      gpuModelMb: 3393.11,
      cpuModelMb: 2286.14,
      gpuKvMb: 160,
      cpuKvMb: 96,
      // The hybrid Gated-DeltaNet model's per-sequence recurrent state, at `-np 1`. Counted
      // since #329: the ESTIMATE side has always included it (`estimatedContextCacheGib` =
      // "KV + recurrent state"), so leaving it out made the OBSERVED figure the low one.
      gpuRsMb: 29.31,
      cpuRsMb: 20.94,
      metalMaxWorkingSetMb: null,
      // DR2, pinned as-is: the summary field is the FIRST `device_info` row, which on this box
      // is the Radeon iGPU (8441 MiB free) while every buffer landed on the RTX. The snapshot
      // attributes through `devices` instead; fixing the summary field is out of scope here.
      gpuFreeAtStartMb: 8441,
      gpuComputeMb: 498,
      devices: [
        { label: 'Vulkan0', name: 'AMD Radeon(TM) Graphics', totalMb: 8886, freeMb: 8441, computeMb: null },
        { label: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060 Laptop GPU', totalMb: 5994, freeMb: 5226, computeMb: 498 }
      ]
    })
  })

  it('reads the REAL 18/33 four-slot control: the RS buffer is PER SEQUENCE, the rest is not', () => {
    const r = feed(fixture('placement-b9849-partial-18of33-np4.txt')).reading()
    // Same model, same box, same context — `-np 4` instead of `-np 1`. The RS buffers grow
    // (227/228: `CPU RS buffer size = 100.50 MiB`, `Vulkan1 RS buffer size = 100.50 MiB`,
    // against 20.94/29.31 at one slot) while the KV buffers do not (222/223: 96 and 160, the
    // same figures) — a unified KV cache is sliced, the recurrent state is allocated per slot.
    // That is exactly why the RS pair is its OWN field and not folded into `gpuKvMb`.
    expect(r).toMatchObject({
      gpuLayers: 18,
      totalLayers: 33,
      gpuRsMb: 100.5,
      cpuRsMb: 100.5,
      gpuKvMb: 160,
      cpuKvMb: 96,
      // 236 `sched_reserve:    Vulkan1 compute buffer size =   424.03 MiB` (one context).
      gpuComputeMb: 424.03
    })
  })

  it('counts an MTP start\'s compute buffer ONCE PER CONTEXT: the re-reserve reprint is not a third buffer', () => {
    const r = feed(fixture('placement-b9849-partial-62of66-mtp.txt')).reading()
    // `--spec-type draft-mtp` constructs TWO llama_contexts and prints THREE reserve blocks:
    //   208 `llama_context: constructing llama_context`   <- main context
    //   237 `sched_reserve:    Vulkan0 compute buffer size =   625.22 MiB`
    //   244 `llama_context: constructing llama_context`   <- draft context
    //   268 `sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB`
    //   275 `spec common_specu: adding speculative implementation 'draft-mtp'`
    //   279 `sched_reserve:    Vulkan0 compute buffer size =   520.06 MiB`  <- SAME buffer, re-reserved
    // llama.cpp keeps one compute buffer per context per backend and only GROWS it on a
    // re-reserve, so the allocation is 625.22 + 520.06 = 1145.28, not the 1665.34 a plain sum
    // reports. Per-context MAX (not "skip an identical block") is what the next test pins.
    expect(r.gpuComputeMb).toBe(1145.28)
    expect(r.devices[0].computeMb).toBe(1145.28)
    // Two REAL cache allocations, one per context: 224 `Vulkan0 KV buffer size = 480.00 MiB`
    // (main) + 259 `Vulkan0 KV buffer size = 32.00 MiB` (draft) — those DO sum.
    expect(r.gpuKvMb).toBe(512)
    expect(r.cpuKvMb).toBe(32)
    // 229 `Vulkan0 RS buffer size =  1683.28 MiB` — 1.6 GiB of card memory that went uncounted
    // until #329, on a start whose parsed total otherwise missed the measured VRAM by that much.
    expect(r.gpuRsMb).toBe(1683.28)
    expect(r.cpuRsMb).toBe(112.22)
    expect(r.gpuLayers).toBe(62)
    expect(r.totalLayers).toBe(66)
  })

  it('reads a REAL 49/49 full offload with Gemma\'s SWA cache pair, and no RS buffer at all', () => {
    const r = feed(fixture('placement-b9849-full-49of49-swa.txt')).reading()
    // A sliding-window model prints TWO KV buffers for the ONE context — 182 `Vulkan0 KV buffer
    // size =   128.00 MiB` (the SWA layers) and 187 `Vulkan0 KV buffer size =  1920.00 MiB` (the
    // full-attention layers) — and both are real allocations, so KV sums where compute maxes.
    expect(r.gpuKvMb).toBe(2048)
    // A FULL offload still carries a CPU_Mapped model buffer (161: 787.50 MiB — the weights
    // llama.cpp leaves mapped host-side), so `cpuModelMb > 0` is NOT a partial offload.
    expect(r.gpuLayers).toBe(49)
    expect(r.totalLayers).toBe(49)
    expect(r.cpuModelMb).toBe(787.5)
    expect(r.gpuModelMb).toBe(6637.63)
    // A dense transformer has no recurrent state: absent stays null, never 0.
    expect(r.gpuRsMb).toBeNull()
    expect(r.cpuRsMb).toBeNull()
    expect(r.gpuComputeMb).toBe(541.07)
  })

  it('takes the MAX per context per device, so a re-reserve that GREW the buffer is counted right', () => {
    // The rule is llama.cpp's own semantics, not "ignore a repeated line": a re-reserve may
    // print a LARGER figure (a bigger graph), and that is the buffer's size — while two
    // CONTEXTS each own one. 520 (max of 500/520) + 300 = 820; never 1320, never 800.
    const p = createPlacementParser()
    p.onStderrData([
      '0.11.141.935 I llama_context: constructing llama_context',
      '0.11.421.745 I sched_reserve:    Vulkan0 compute buffer size =   500.00 MiB',
      '0.11.850.342 I sched_reserve:    Vulkan0 compute buffer size =   520.00 MiB',
      '0.11.948.644 I llama_context: constructing llama_context',
      '0.11.994.730 I sched_reserve:    Vulkan0 compute buffer size =   300.00 MiB',
      ''
    ].join('\n'))
    expect(p.reading().gpuComputeMb).toBe(820)
    // `reading()` flushes the still-open context WITHOUT consuming it: calling twice is the
    // same answer (the ladder reads the parser more than once).
    expect(p.reading().gpuComputeMb).toBe(820)
    expect(p.reading().devices).toEqual([])
  })

  it('never sums the teardown warning, which reports a size with no "= N MiB" to read', () => {
    // 358 of the MTP fixture: `~llama_context:    Vulkan0 compute buffer size of 679.1215 MiB,
    // does not match expectation of 625.2188 MiB` — llama.cpp's destructor noting the buffer
    // grew past the reserve. It carries no `=`, so it matches nothing; this pins that.
    const p = createPlacementParser()
    p.onStderrData([
      '0.11.141.935 I llama_context: constructing llama_context',
      '0.11.421.745 I sched_reserve:    Vulkan0 compute buffer size =   625.22 MiB',
      '0.35.029.294 W ~llama_context:    Vulkan0 compute buffer size of 679.1215 MiB, does not match expectation of 625.2188 MiB',
      ''
    ].join('\n'))
    expect(p.reading().gpuComputeMb).toBe(625.22)
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

// PR #303 audit DR3, verified and now STANDING. Precisely what the fixtures show: verbosity 4
// raises llama.cpp's load-time AND per-request DIAGNOSTIC logging — slot ids, token counts,
// timings, sampler parameters and cache state, so every fixture DOES carry a complete request
// cycle's metadata (`launch_slot_`, `new prompt, n_ctx_slot = 8192 … task.n_tokens = 2015`,
// `print_timing`, `release`) — but no prompt or completion TEXT and no request body. "Verbosity 4
// does not log requests" would be false; what is true is that it logs no content.
//
// These four fixtures are committed to a PUBLIC repo, so the check runs on every suite and is a
// WHITELIST, not a blacklist: every line must fall into one of five known classes, so injected
// prose ANYWHERE in a future re-capture reddens here instead of shipping.
describe('the committed load logs carry no request or prompt content (DR3)', () => {
  const NAMES = [
    'placement-b9849-partial-20of33-hybrid.txt',
    'placement-b9849-partial-18of33-np4.txt',
    'placement-b9849-partial-62of66-mtp.txt',
    'placement-b9849-full-49of49-swa.txt'
  ]
  // Request lines, JSON bodies, and the home directories a path would be rooted in (the argv
  // header of each fixture is hand-redacted to `<drive>`).
  const FORBIDDEN = ['POST /', 'GET /', '"content"', '"messages"', 'C:' + String.fromCharCode(92) + 'Users', '/home/', '/Users/']
  // The ONLY conversational-looking text in a load log is llama.cpp's own canned template
  // probe — `chat template, example_format: '…'`, a fixed system/user/assistant exchange it
  // renders through the model's Jinja template at load time, BEFORE the server listens. It is
  // llama.cpp's string, not the user's, so it is allowed only INSIDE that block.
  const CANNED = ['You are a helpful assistant', 'Hello', 'Hi there', 'How are you?']
  /** `0.11.421.745 I ` — the prefix every real log line of the pinned build carries. */
  const TIMESTAMPED = /^\d+\.\d\d\.\d\d\d\.\d\d\d [IWE] /
  /** `print_info: LF token              = 107 '` — a token literal whose value IS a newline. */
  const OPEN_TOKEN_LITERAL = /token\s*=\s*\d+ '$/

  /**
   * The `example_format` block: from the line that opens it to the next line that is a lone
   * quote. The search starts AFTER the opening line on purpose — a lone `'` also occurs in
   * ordinary log content (the SWA fixture has one at line 152, closing
   * `print_info: LF token = 107 '` + a raw newline), and taking the first one in the file would
   * end the block before it began.
   */
  const blockOf = (lines: string[]): { open: number; close: number } => {
    const open = lines.findIndex((l) => l.includes('chat template, example_format:'))
    const rest = open < 0 ? -1 : lines.slice(open + 1).findIndex((l) => l.trim() === "'")
    return { open, close: rest < 0 ? -1 : open + 1 + rest }
  }

  it.each(NAMES)('%s', (name) => {
    const text = fixture(name)
    for (const needle of FORBIDDEN) expect(`${name}: ${text.includes(needle)}`).toBe(`${name}: false`)
    // Every slot line prints its conversation id; the app never sets one, so it is always empty.
    const ids = text.match(/conv_id=[^|,\n]*/g) ?? []
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(id.trim()).toBe('conv_id= (empty=1)')
    // The capture is the real thing: the verbosity the parser needs, and a load it can read.
    expect(text).toContain('verbosity = 4')
    expect(text).toMatch(/offloaded\s+\d+\/\d+\s+layers to GPU/)

    const lines = text.split('\n')
    const { open, close } = blockOf(lines)
    // The canned probe, and nothing like it, outside the block.
    lines.forEach((l, i) => {
      for (const c of CANNED) {
        if (l.includes(c)) expect(`${name}:${i + 1} ${c}`).toBe(`${name}:${i + 1} ${open >= 0 && i > open && i <= close ? c : 'OUTSIDE example_format'}`)
      }
    })

    // THE NET: every line is one of five classes. Anything else — a pasted prompt, a stray note,
    // an editor's comment — fails, naming the line.
    lines.forEach((l, i) => {
      const ok =
        (i === 0 && l.startsWith('# ')) || // (a) the hand-written `# <leg> — argv: …` header
        TIMESTAMPED.test(l) || // (b) a real log line
        (open >= 0 && i > open && i <= close) || // (c) inside the canned template block
        l.startsWith('\t') || // (d) a tab-indented sampler-params continuation
        (l === "'" && OPEN_TOKEN_LITERAL.test(lines[i - 1] ?? '')) || // (e) a newline token literal
        (i === lines.length - 1 && l === '') // the file's trailing newline
      expect(`${name}:${i + 1} ${ok ? 'classified' : JSON.stringify(l.slice(0, 80))}`).toBe(`${name}:${i + 1} classified`)
    })
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
