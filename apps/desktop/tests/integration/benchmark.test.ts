import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {
  discoverManifests,
  resolveManifestsDir,
  recommendModelId,
  recommendModelIdByRam
} from '../../src/main/services/models'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { ModelManifest } from '../../src/shared/manifest'
import {
  detectSystem,
  classifyProfile,
  measureDriveSpeed,
  measureTokensPerSecond,
  buildWarnings,
  runBenchmark,
  upsertSlowReadWarning,
  SLOW_EFFECTIVE_READ_MBPS,
  BENCHMARK_TOKEN_TARGET
} from '../../src/main/services/benchmark'
import { t } from '../../src/shared/i18n'
import type { BenchmarkProgressStep } from '../../src/shared/types'
import type { ModelRuntime, RuntimeTimings } from '../../src/main/services/runtime'
import { stubChatRuntime } from '../helpers/chat-runtime-stub'

// A switchable OS pin. The RAM is a KNOWN input wherever a row reads a profile or a pick, not the
// host's (PR #308 audit plan T-item 3; the switch is null elsewhere and the mock passes through to
// the real `totalmem`). `failing` makes the probes `detectSystem` calls throw.
const osState = vi.hoisted(() => ({ totalmemBytes: null as number | null, failing: false }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const guarded = <T>(real: () => T) => (): T => {
    if (osState.failing) throw new Error('os probe failed')
    return real()
  }
  return {
    ...actual,
    platform: guarded(actual.platform),
    arch: guarded(actual.arch),
    cpus: guarded(actual.cpus),
    totalmem: guarded(() => osState.totalmemBytes ?? actual.totalmem())
  }
})
const pinRam = (gb: number): void => {
  osState.totalmemBytes = gb * 1024 ** 3
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-bench-ws-'))
}
function realManifests(): ModelManifest[] {
  const dir = resolveManifestsDir(process.cwd())
  if (!dir) throw new Error('could not locate model-manifests from the repo')
  return discoverManifests(dir).manifests.map((m) => m.manifest)
}
function runtime() {
  return createMockRuntime({ modelId: 'mock-chat', modelPath: '/m.gguf', contextTokens: 2048 })
}
/**
 * A stream on a hand-driven clock: each chunk costs `msPerChunk`, nothing really waits, and the
 * final chunk reports `timings` (none when omitted). perf_hooks' `performance` is the global's.
 */
function clockedRuntime(chunks: string[], msPerChunk: number, timings?: RuntimeTimings): ModelRuntime {
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  return {
    ...stubChatRuntime(),
    async *chatStream(_m, options) {
      for (const chunk of chunks) {
        clock += msPerChunk
        yield chunk
      }
      options?.onFinish?.('length', timings)
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  osState.totalmemBytes = null
  osState.failing = false
})

// ---- System detection -----------------------------------------------------------

describe('detectSystem', () => {
  it('returns a well-formed shape and never throws (GPU null, no native probe)', () => {
    const sys = detectSystem()
    expect(typeof sys.os).toBe('string')
    expect(typeof sys.arch).toBe('string')
    expect(typeof sys.cpuModel).toBe('string')
    expect(sys.cpuCores).toBeGreaterThan(0)
    expect(sys.ramGb).toBeGreaterThan(0)
    expect(sys.gpu).toBeNull()

    osState.failing = true
    const failed = detectSystem()
    osState.failing = false
    expect(failed).toEqual({ os: '', arch: '', cpuModel: '', cpuCores: 0, ramGb: 0, gpu: null })
    expect(classifyProfile(failed.ramGb)).toBe('UNKNOWN')
  })
})

// ---- Profile classification (spec §11.3) ----------------------------------------

describe('classifyProfile', () => {
  it('maps RAM at the boundaries: ≤8 TINY, ≤16 LITE, ≤32 BALANCED, else PRO', () => {
    expect(classifyProfile(8)).toBe('TINY')
    expect(classifyProfile(4)).toBe('TINY')
    expect(classifyProfile(8.5)).toBe('LITE')
    expect(classifyProfile(16)).toBe('LITE')
    expect(classifyProfile(16.1)).toBe('BALANCED')
    expect(classifyProfile(32)).toBe('BALANCED')
    expect(classifyProfile(32.1)).toBe('PRO')
    expect(classifyProfile(64)).toBe('PRO')
  })

  it('downgrades one step when tokens/sec is very low (never below TINY)', () => {
    expect(classifyProfile(16, { tokensPerSecond: 2.9 })).toBe('TINY')
    expect(classifyProfile(16, { tokensPerSecond: 3 })).toBe('LITE') // exactly the threshold is not "very low"
    expect(classifyProfile(16, { tokensPerSecond: 0 })).toBe('LITE') // no reading
    expect(classifyProfile(64, { tokensPerSecond: 0.5 })).toBe('BALANCED')
    // TINY cannot go lower.
    expect(classifyProfile(8, { tokensPerSecond: 0.5 })).toBe('TINY')
    // A healthy rate leaves the RAM-based profile intact.
    expect(classifyProfile(16, { tokensPerSecond: 80 })).toBe('LITE')
  })

  // Phase 16 (architecture.md GPU record §8): the bump fires only on a PRE-QUALIFIED gpuUseful
  // hint (at or above USABLE_VRAM_MB dedicated + not integrated-looking — computed by
  // gpuUsefulForProfile; the floor is 5 GiB since #321),
  // never on a merely truthy GPU name.
  it('bumps one step toward PRO when the GPU is pre-qualified useful (capped at PRO)', () => {
    expect(classifyProfile(8, { gpuUseful: true })).toBe('LITE')
    expect(classifyProfile(64, { gpuUseful: true })).toBe('PRO')
    expect(classifyProfile(8, { gpuUseful: false })).toBe('TINY')
    expect(classifyProfile(8, {})).toBe('TINY')
  })

  it('returns UNKNOWN when RAM detection failed (invalid value)', () => {
    expect(classifyProfile(0)).toBe('UNKNOWN')
    expect(classifyProfile(Number.NaN)).toBe('UNKNOWN')
    expect(classifyProfile(-4)).toBe('UNKNOWN')
  })
})

describe('runBenchmark GPU injection (Phase 16)', () => {
  it('carries the injected probe summary into the result + profile', async () => {
    pinRam(16)
    const ws = workspace()
    const result = await runBenchmark({
      workspacePath: ws,
      manifests: [],
      gpu: { name: 'NVIDIA GeForce RTX 3080 Ti', useful: true }
    })
    expect(result.gpu).toBe('NVIDIA GeForce RTX 3080 Ti')
    // One step above the pure-RAM classification (16 GiB alone is LITE).
    expect(result.profile).toBe('BALANCED')
  })

  it('an un-useful (or absent) GPU changes nothing', async () => {
    pinRam(16)
    const ws = workspace()
    const withIgpu = await runBenchmark({
      workspacePath: ws,
      manifests: [],
      gpu: { name: 'Intel(R) Iris(R) Xe Graphics', useful: false }
    })
    const without = await runBenchmark({ workspacePath: ws, manifests: [] })
    expect(withIgpu.profile).toBe('LITE')
    expect(without.profile).toBe('LITE')
    expect(withIgpu.gpu).toBe('Intel(R) Iris(R) Xe Graphics') // name still surfaces
    expect(without.gpu).toBeNull()
  })
})

// ---- Recommendation selection per profile (real manifests) ----------------------

// §6.6 rule C (PR #308 audit): the benchmark feeds the picker the budget device's BUDGET
// (`GpuBenchmarkInput.budgetMb` = free memory, else total − 1,024), never the total — the total
// stays the graphics tile's figure (`gpuVramMb`). RAM is PINNED to 32 GB here so every
// expectation is unconditional (the earlier host-conditional `if (ramGb >= …)` pair hid the
// assertions on small CI hosts).
describe('runBenchmark picks by graphics memory on a discrete card (§6.6 rule C; RAM pinned to 32 GB)', () => {
  beforeEach(() => {
    pinRam(32)
  })

  it('24 GB card → the 27B Q5 since -np 1 (#319); 8 GB card → the 4B; no class → the RAM pick', async () => {
    const manifests = realManifests()
    const base = { workspacePath: workspace(), manifests, runtime: null }
    // RTX 3090 as the Windows rig reports it (24,822 total); a probe without a free figure →
    // total − 1,024 = 23,798 MiB, which clears Q5's 22,877 (committed-catalog pins the threshold), so
    // the RAM pick stands. #318 leg 1 measured this card: Q5 66/66 at 51.0 tok/s with `-np 1`.
    // An idle 8 GB card: 7,168 MiB free is under the 9B's 7,285 → the 4B. It would hold the 9B by its
    // total, which makes this the row that tells budget from total.
    const big = await runBenchmark({ ...base, gpu: { name: 'RTX 3090', useful: true, totalMb: 24_822, budgetMb: 24_822 - 1024, memoryClass: 'discrete' } })
    const small = await runBenchmark({ ...base, gpu: { name: 'RTX 3050', useful: true, totalMb: 8192, budgetMb: 7168, memoryClass: 'discrete' } })
    const none = await runBenchmark({ ...base, gpu: null })
    expect(big.ramGb).toBe(32)
    expect(big.recommendedModelId).toBe('qwen3.8-27b-ud-q5km')
    expect(small.recommendedModelId).toBe('qwen3.5-4b-ud-q4kxl')
    expect(none.recommendedModelId).toBe('qwen3.8-27b-ud-q5km')
    expect(none.recommendedModelId).toBe(recommendModelIdByRam(manifests, 32, 'chat'))
    // The tile keeps the TOTAL; the pick used the budget.
    expect(big.gpuVramMb).toBe(24_822)
    expect(small.gpuVramMb).toBe(8192)
  })

  it('a discrete class without a budget figure, or a cpu class with one, is the RAM pick (byte-identical)', async () => {
    const manifests = realManifests()
    const base = { workspacePath: workspace(), manifests, runtime: null }
    // An 8 GiB card, because the 3090's card pick is the RAM pick since #319 and could not tell the two apart.
    const noBudget = await runBenchmark({ ...base, gpu: { name: 'RTX 3070', useful: true, totalMb: 8192, memoryClass: 'discrete' } })
    const cpuWithBudget = await runBenchmark({ ...base, gpu: { name: 'RTX 3070', useful: true, totalMb: 8192, budgetMb: 7168, memoryClass: 'cpu' } })
    expect(noBudget.recommendedModelId).toBe('qwen3.8-27b-ud-q5km')
    expect(cpuWithBudget.recommendedModelId).toBe('qwen3.8-27b-ud-q5km')
    expect(noBudget.gpuVramMb).toBe(8192)
  })
})

describe('recommendation per profile', () => {
  it('selects the right chat model from the committed manifests', () => {
    const manifests = realManifests()
    // Mapping table (spec §7.3): TINY→4b, LITE→4b, BALANCED→8b, PRO→14b, UNKNOWN→4b.
    // 1.7b was dropped 2026-06-10 (no official Q4_K_M), so 4b — the smallest bundled chat
    // model — now also covers TINY + UNKNOWN. Each profile is still claimed by exactly one
    // chat model, so the first-match recommendation is unambiguous.
    expect(recommendModelId(manifests, 'TINY', 'chat')).toBe('qwen3-4b-instruct-q4')
    expect(recommendModelId(manifests, 'LITE', 'chat')).toBe('qwen3-4b-instruct-q4')
    expect(recommendModelId(manifests, 'BALANCED', 'chat')).toBe('qwen3-8b-instruct-q4')
    expect(recommendModelId(manifests, 'PRO', 'chat')).toBe('qwen3-14b-instruct-q4')
    expect(recommendModelId(manifests, 'UNKNOWN', 'chat')).toBe('qwen3-4b-instruct-q4')
  })

  it('does not auto-recommend the 30B-A3B MoE model for any profile (opt-in only)', () => {
    const manifests = realManifests()
    const moe = manifests.find((m) => m.id === 'qwen3-30b-a3b-q4')
    expect(moe).toBeDefined()
    expect(moe!.recommendedProfiles).toEqual([])
    for (const profile of ['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN'] as const) {
      expect(recommendModelId(manifests, profile, 'chat')).not.toBe('qwen3-30b-a3b-q4')
    }
  })

  // Newest-Qwen promotion (owner decision 2026-07-12, model-benchmarks.md §6.4): the picker
  // recommends the newest-generation Qwen model per RAM tier. The Phase-29 winners (Ministral,
  // Gemma 4 12B) keep their ranks and stay selectable but lose the tiebreaks to the rank-3
  // promoted set. Issue #48's honest-RAM recalibration (12-14B tier at 24) is unchanged; the
  // Qwen3.6 27B Q4 joins that 24 GB capacity group and wins it on rank.
  // E2B promotion (owner decision 2026-08-09, issue #153, model-benchmarks.md §6.5): the
  // 12 GB point moves from the runnable-stage qwen3.5-4b fallback to gemma4-e2b (rank 3,
  // rec-RAM retuned to 12 — the first ranked capacity band below 16); 8 GB stays the
  // runnable-stage 4B (disk-asc tiebreak among the min-8 rank-3s).
  it('recommends the newest-Qwen promoted model per machine RAM (real manifests)', () => {
    const m = realManifests()
    expect(recommendModelIdByRam(m, 8, 'chat')).toBe('qwen3.5-4b-ud-q4kxl') // low-end pick
    expect(recommendModelIdByRam(m, 12, 'chat')).toBe('gemma4-e2b-it-qat-q4') // #153 sub-16 band
    expect(recommendModelIdByRam(m, 16, 'chat')).toBe('qwen3.5-9b-ud-q4kxl') // 8B-class tier
    expect(recommendModelIdByRam(m, 20, 'chat')).toBe('qwen3.5-9b-ud-q4kxl') // 24 GB tier starts at 24
    expect(recommendModelIdByRam(m, 24, 'chat')).toBe('qwen3.8-27b-ud-q4km') // #196 wave, owner-ratified handover
    expect(recommendModelIdByRam(m, 32, 'chat')).toBe('qwen3.8-27b-ud-q5km') // #196 wave, owner-ratified handover
  })
})

// ---- Drive speed probe ----------------------------------------------------------

describe('measureDriveSpeed', () => {
  it('writes a temp file INSIDE the workspace and cleans it up afterward', async () => {
    const ws = workspace()
    const speed = await measureDriveSpeed(ws)
    expect(speed.error).toBeUndefined()
    expect(speed.readMbps).not.toBeNull()
    expect(speed.writeMbps).not.toBeNull()
    expect(speed.readMbps!).toBeGreaterThan(0)
    expect(speed.writeMbps!).toBeGreaterThan(0)
    // No leftover temp file — the workspace is exactly as clean as before.
    expect(readdirSync(ws)).toHaveLength(0)
  })

  it('returns null Mbps + an error (no throw) when the workspace is not writable', async () => {
    const speed = await measureDriveSpeed(join(tmpdir(), 'hilbertraum-does-not-exist-xyz', 'nope'))
    expect(speed.readMbps).toBeNull()
    expect(speed.writeMbps).toBeNull()
    expect(speed.error).toBeTruthy()
  })
})

// ---- Tokens/sec probe -----------------------------------------------------------

describe('measureTokensPerSecond', () => {
  it('is null when no runtime is running (optional in the mock era)', async () => {
    expect(await measureTokensPerSecond(null)).toBeNull()
    expect(await measureTokensPerSecond(undefined)).toBeNull()
  })

  // #291 — the runtime's own decode timings win over the chunk count. The stream reports `timings`
  // on its final chunk (the llama-server shape via PR 1's onFinish hand-up).
  it('reports the runtime timings’ predicted_per_second (decode only) when the final chunk carries them', async () => {
    // Three chunks carrying more tokens each (an accepted MTP draft run rides one chunk), and a
    // clock that would read 1 chunk/s: the server's figure wins over both.
    const reading = await measureTokensPerSecond(
      clockedRuntime(['one two three', 'four five', 'six seven eight'], 1000, {
        prompt_n: 12,
        prompt_ms: 900, // a long prefill that a wall-clock window would have paid for
        predicted_n: 64,
        predicted_ms: 1336,
        predicted_per_second: 47.9,
        prompt_per_second: 13.3
      })
    )
    expect(reading).toEqual({ tokensPerSecond: 47.9, basis: 'timings', tokens: 64 })
  })

  it('falls back to the chunk count over wall time when the stream carries no timings', async () => {
    const reading = await measureTokensPerSecond(clockedRuntime(['a', 'b', 'c', 'd'], 500))
    expect(reading).toEqual({ tokensPerSecond: 2, basis: 'chunks', tokens: 4 })
  })

  it.each<[string, RuntimeTimings]>([
    ['no figure at all', { prompt_n: 3 }],
    ['a zero figure', { predicted_n: 2, predicted_per_second: 0 }],
    ['an infinite figure', { predicted_n: 2, predicted_per_second: Number.POSITIVE_INFINITY }]
  ])('ignores a timings block without a usable predicted_per_second (falls back, flagged): %s', async (_label, timings) => {
    const reading = await measureTokensPerSecond(clockedRuntime(['a', 'b'], 500, timings))
    expect(reading).toEqual({ tokensPerSecond: 2, basis: 'chunks', tokens: 2 })
  })

  it('consumes the whole capped stream so the final (timings) chunk is never cancelled away', async () => {
    // Trap 1 (#291): the old probe broke out on the 64th chunk, cancelling the reader before the
    // finish chunk arrived. Exactly BENCHMARK_TOKEN_TARGET chunks then the finish → timings land.
    const chunks = Array.from({ length: BENCHMARK_TOKEN_TARGET }, (_, i) => `t${i} `)
    const reading = await measureTokensPerSecond(
      stubChatRuntime({ chunks, perSecond: 38.4, predictedN: BENCHMARK_TOKEN_TARGET })
    )
    expect(reading).toEqual({ tokensPerSecond: 38.4, basis: 'timings', tokens: BENCHMARK_TOKEN_TARGET })
  })

  it('sends the paragraph prompt under the 64-token cap', async () => {
    let seen: { prompt: string; maxTokens?: number } | null = null
    const spy: ModelRuntime = {
      ...stubChatRuntime(),
      async *chatStream(messages, options) {
        seen = { prompt: messages[0].content, maxTokens: options?.maxTokens }
        yield 'x'
        options?.onFinish?.('stop')
      }
    }
    await measureTokensPerSecond(spy)
    expect(seen).toEqual({ prompt: 'Write a short paragraph about privacy.', maxTokens: 64 })
  })

  // #393 — the REJECTING stream. A model start that stopped the sidecar mid-stream makes the
  // iterator throw instead of delivering another chunk, so the per-chunk busy check never fires
  // and the probe lands in the `catch`. It must still say WHY the reading is missing when
  // something is busy — and stay silent when nothing is (a plain probe failure).
  /** One chunk, then the stop: the second `next()` REJECTS instead of yielding. */
  function throwingRuntime(): ModelRuntime {
    return stubChatRuntime({ chunks: ['a'], rejectAfterHook: true })
  }

  it('a stream that THROWS while the model is busy reports the skip (#393)', async () => {
    const onBusySkip = vi.fn()
    let stopped = false
    const killed: ModelRuntime = {
      ...stubChatRuntime(),
      async *chatStream() {
        yield 'a'
        stopped = true // the stop lands between chunks: the next `next()` rejects, no per-chunk check runs
        throw new Error('model stopped')
      }
    }
    const reading = await measureTokensPerSecond(killed, { modelBusy: () => stopped, onBusySkip })
    expect(reading).toBeNull()
    expect(onBusySkip).toHaveBeenCalledTimes(1)
  })

  it('a stream that THROWS with nothing busy stays silent — a plain probe failure (#393)', async () => {
    const onBusySkip = vi.fn()
    const reading = await measureTokensPerSecond(throwingRuntime(), { modelBusy: () => false, onBusySkip })
    expect(reading).toBeNull()
    expect(onBusySkip).not.toHaveBeenCalled()
  })

  // #606 — a CANCELLED probe: lock and quit abort the leg before they stop the model. The aborted
  // stream ends cleanly with the chunks it had (the SSE reader returns on an abort), rejects (the kill
  // landing too), or still hands over a chunk it had buffered. None is a reading, and a cancel is no
  // busy skip — although the busy predicate reads true by then (the teardown has taken the model away).
  it.each(['ends cleanly', 'rejects', 'still delivers a chunk'] as const)(
    'a cancelled probe whose stream %s after the abort is no reading and no busy skip (#606)',
    async (shape) => {
      const cancel = new AbortController()
      const onBusySkip = vi.fn()
      const rt: ModelRuntime = {
        ...stubChatRuntime(),
        async *chatStream() {
          yield 'a'
          yield 'b'
          cancel.abort() // the teardown's cancel lands mid-stream
          if (shape === 'rejects') throw new TypeError('terminated')
          if (shape === 'still delivers a chunk') yield 'c'
        }
      }
      const reading = await measureTokensPerSecond(rt, {
        signal: cancel.signal,
        modelBusy: () => cancel.signal.aborted,
        onBusySkip
      })
      expect(reading).toBeNull()
      expect(onBusySkip).not.toHaveBeenCalled()
    }
  )

  it('never throws when the busy predicate itself throws in the catch (#393)', async () => {
    // The catch runs at the moment the runtime is dying, so the predicate it consults can blow
    // up (a manager tearing down under it). The function is documented "never throws".
    const onBusySkip = vi.fn()
    let calls = 0
    const reading = await measureTokensPerSecond(throwingRuntime(), {
      modelBusy: () => {
        // Admitted at the pre-stream check (outside the try), then gone.
        if (calls++ === 0) return false
        throw new Error('runtime gone')
      },
      onBusySkip
    })
    expect(reading).toBeNull()
    expect(onBusySkip).not.toHaveBeenCalled()
  })
})

// ---- Warnings (spec §11.3 + §11.4 friendly copy) --------------------------------

describe('buildWarnings', () => {
  it('uses encouraging language for weak hardware (never "your hardware is bad")', () => {
    const w = buildWarnings({ profile: 'TINY', driveReadMbps: 500, driveWriteMbps: 500 })
    expect(w.join(' ')).toContain('smallest, quickest model')
    expect(w.join(' ').toLowerCase()).not.toContain('bad')
  })

  // Issue #52: the tok/s profile downgrade used to be completely silent. When it fires, the
  // warning must NAME the model the probe streamed through — the downgrade is evidence about
  // that model on this machine, not about the hardware tier in the abstract.
  it('names the measured model when the very-low tok/s reading stepped the profile down (issue #52)', () => {
    const w = buildWarnings({
      profile: 'LITE',
      driveReadMbps: 500,
      driveWriteMbps: 500,
      tokensDowngraded: true,
      measuredModelId: 'qwen3-30b-a3b-q4'
    })
    expect(w.some((m) => m.includes('(qwen3-30b-a3b-q4)') && m.includes('stepped down'))).toBe(true)
  })

  it('stays silent when the reading did not move the profile, or no measured model is known', () => {
    const base = { profile: 'BALANCED' as const, driveReadMbps: 500, driveWriteMbps: 500 }
    expect(buildWarnings({ ...base, tokensDowngraded: false, measuredModelId: 'mock-chat' })).toEqual([])
    expect(buildWarnings({ ...base, tokensDowngraded: true, measuredModelId: null })).toEqual([])
  })

  // §6.5 (issue #95): the recommendation-lowered sibling warning — persisted canonical
  // ENGLISH (the exact catalog string), naming the measured model AND the figure.
  it('emits the exact §6.5 recommendation-lowered warning with model + figure (issue #95)', () => {
    const base = { profile: 'BALANCED' as const, driveReadMbps: 500, driveWriteMbps: 500 }
    const w = buildWarnings({
      ...base,
      recommendationLowered: true,
      measuredModelId: 'qwen3.6-27b-q4',
      tokensPerSecond: 2.2
    })
    expect(w).toEqual([
      t('en', 'main.benchmark.warnRecommendationLowered', { tps: 2.2, model: 'qwen3.6-27b-q4' })
    ])
    expect(w[0]).toContain('2.2 tokens per second')
    expect(w[0]).toContain('(qwen3.6-27b-q4)')
    expect(w[0]).toContain('moved down one size tier')
  })

  it('stays silent when the pick did not move, or the pairing is incomplete (§6.5)', () => {
    const base = { profile: 'BALANCED' as const, driveReadMbps: 500, driveWriteMbps: 500 }
    expect(
      buildWarnings({ ...base, recommendationLowered: false, measuredModelId: 'x', tokensPerSecond: 2 })
    ).toEqual([])
    expect(
      buildWarnings({ ...base, recommendationLowered: true, measuredModelId: null, tokensPerSecond: 2 })
    ).toEqual([])
    expect(
      buildWarnings({ ...base, recommendationLowered: true, measuredModelId: 'x', tokensPerSecond: null })
    ).toEqual([])
  })

  // #110: the PRIMARY drive warning keys on the honest effective READ figure (what model
  // starts actually feel); the write gate stays as the secondary broken-media check. The
  // full {slow read, fast read, no data} × {slow write, fast write} matrix, so the gate
  // can never silently rot into a vacuous fixture (the pre-#110 tests set only the two
  // probe fields and would stay green with the read gate broken).
  it('warns on slow effective read × write matrix — read is primary, write secondary, no data never warns', () => {
    const slowRead = t('en', 'main.benchmark.warnSlowRead', { mbps: 70 })
    const slowWrite = t('en', 'main.benchmark.warnSlowDrive')
    const cell = (effectiveReadMbps: number | null, driveWriteMbps: number): string[] =>
      buildWarnings({
        profile: 'BALANCED',
        driveReadMbps: 2000, // the page-cached probe leg — must never gate anything
        driveWriteMbps,
        effectiveReadMbps
      })

    expect(cell(70.4, 7)).toEqual([slowRead, slowWrite]) // both slow → both warn
    expect(cell(70.4, 400)).toEqual([slowRead]) // the stick case: fine write, painful read
    expect(cell(500, 7)).toEqual([slowWrite]) // broken-media write check still fires alone
    expect(cell(500, 400)).toEqual([]) // healthy on both axes
    expect(cell(null, 7)).toEqual([slowWrite]) // no read data → never a read warning
    expect(cell(null, 400)).toEqual([]) // fresh install, healthy write → silent
    // Boundary: exactly the threshold is NOT slow.
    expect(cell(SLOW_EFFECTIVE_READ_MBPS, 400)).toEqual([])
    expect(cell(SLOW_EFFECTIVE_READ_MBPS - 0.1, 400)).toHaveLength(1)
    // The write gate's own boundary (benchmark.md: < 30 MB/s).
    expect(cell(null, 29.9)).toEqual([slowWrite])
    expect(cell(null, 30)).toEqual([])
  })

  it('the read warning rides an errored probe (independent branches) and names the consequence', () => {
    const w = buildWarnings({
      profile: 'BALANCED',
      driveReadMbps: null,
      driveWriteMbps: null,
      driveError: 'EACCES',
      effectiveReadMbps: 42
    })
    expect(w).toEqual([
      t('en', 'main.benchmark.warnSlowRead', { mbps: 42 }),
      t('en', 'main.benchmark.warnDriveProbe')
    ])
    expect(w[0]).toContain('model starts will be slow')
    expect(w[0]).toContain('42 MB/s')
  })

  it('names a FLOORED speed, so the copy can never claim the threshold it warns under', () => {
    const w = buildWarnings({
      profile: 'BALANCED',
      driveReadMbps: null,
      driveWriteMbps: 400,
      effectiveReadMbps: 99.6 // < 100 gates, but Math.round would name "about 100 MB/s"
    })
    expect(w).toEqual([t('en', 'main.benchmark.warnSlowRead', { mbps: 99 })])
  })

  // #110 + adversarial review: the sample is updated in place between benchmark runs
  // (`persistEffectiveRead`), and the ONLY automatic benchmark runs before any model
  // exists — so the slow-read warning must be re-keyable against a fresh sample without
  // recomputing the whole set.
  it('upsertSlowReadWarning adds, replaces, and removes the one warning it owns — nothing else', () => {
    const others = [
      t('en', 'main.benchmark.warnTiny'),
      t('en', 'main.benchmark.warnSlowDrive'),
      t('en', 'main.benchmark.warnVeryLowTokens', { model: 'qwen3-9b' })
    ]

    // Absent + slow sample → appended; every other warning untouched.
    const added = upsertSlowReadWarning(others, 70.4)
    expect(added).toEqual([...others, t('en', 'main.benchmark.warnSlowRead', { mbps: 70 })])

    // A newer slow sample REPLACES the stale one (never two slow-read lines, and the
    // named mbps always matches the current sample).
    const replaced = upsertSlowReadWarning(added, 42)
    expect(replaced.filter((w) => w.includes('model starts will be slow'))).toHaveLength(1)
    expect(replaced.at(-1)).toBe(t('en', 'main.benchmark.warnSlowRead', { mbps: 42 }))

    // A fast sample REMOVES it (the drive moved to an SSD must not keep warning).
    expect(upsertSlowReadWarning(replaced, 480)).toEqual(others)

    // Threshold boundary: exactly 100 is not slow.
    expect(upsertSlowReadWarning(others, 100)).toEqual(others)
  })
})

// ---- runBenchmark + persistence + downstream reads ------------------------------

describe('runBenchmark', () => {
  it('persists HOW the speed was measured next to the figure (#291 speedBasis)', async () => {
    const timed = stubChatRuntime({ modelId: 'qwen3-9b', chunks: ['a'], perSecond: 47.9, predictedN: 64 })
    const result = await runBenchmark({ workspacePath: workspace(), manifests: [], runtime: timed })
    expect(result.tokensPerSecond).toBe(47.9)
    expect(result.speedBasis).toEqual({ basis: 'timings', tokens: 64 })
    expect(result.measuredModelId).toBe('qwen3-9b')
    // The mock (no timings) records the chunk fallback; no runtime records null.
    const mock = await runBenchmark({ workspacePath: workspace(), manifests: [], runtime: runtime() })
    expect(mock.speedBasis?.basis).toBe('chunks')
    const none = await runBenchmark({ workspacePath: workspace(), manifests: [] })
    expect(none.speedBasis).toBeNull()
  })

  it('assembles a complete BenchmarkResult', async () => {
    pinRam(16)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'))
    // The stub, not the mock: the mock's real per-token delay can read under 3 tok/s on a starved
    // runner and step the profile.
    const result = await runBenchmark({ workspacePath: workspace(), manifests: realManifests(), runtime: stubChatRuntime() })
    expect(result).toEqual({
      os: process.platform,
      arch: process.arch,
      cpuModel: expect.any(String),
      cpuCores: expect.any(Number),
      ramGb: 16,
      gpu: null,
      gpuVramMb: null,
      driveReadMbps: expect.any(Number),
      driveWriteMbps: expect.any(Number),
      tokensPerSecond: 20,
      speedBasis: { basis: 'timings', tokens: 2 },
      speedIdentity: { memoryClass: 'cpu', deviceName: null, contextTokens: null, backend: null },
      measuredModelId: 'stub-chat', // issue #52: WHICH model produced the tok/s number
      effectiveRead: null,
      profile: 'LITE',
      recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
      warnings: expect.any(Array), // the drive's own speed decides `warnSlowDrive` on a loaded runner
      ranAt: '2026-06-09T00:00:00.000Z'
    })
  })

  it('records no measured model when no runtime was running (issue #52)', async () => {
    const result = await runBenchmark({ workspacePath: workspace(), manifests: [] })
    expect(result.tokensPerSecond).toBeNull()
    expect(result.measuredModelId).toBeNull()
  })

  // #108: the honest read figure is INJECTED (a byproduct of real loads/hashes,
  // read-speed.ts) — the benchmark itself never measures it, and a fresh install
  // without a sample carries an explicit null.
  it('embeds the injected effective-read sample; null when none exists yet', async () => {
    const sample = {
      mbps: 70.4,
      bytes: 6_000_000_000,
      ms: 85_200,
      source: 'model_load' as const,
      modelId: 'qwen3-9b',
      at: '2026-08-08T10:00:00.000Z'
    }
    const withSample = await runBenchmark({
      workspacePath: workspace(),
      manifests: [],
      effectiveRead: sample
    })
    expect(withSample.effectiveRead).toEqual(sample)

    const without = await runBenchmark({ workspacePath: workspace(), manifests: [] })
    expect(without.effectiveRead).toBeNull()
  })

  // End-to-end wiring of the issue-#52 downgrade warning: named exactly when the tok/s hint moved
  // the profile, which a machine already on the lowest rung cannot.
  it('emits the named very-low-tokens warning exactly when the profile stepped down (issue #52)', async () => {
    const crawl = () => stubChatRuntime({ modelId: 'oversized-27b', perSecond: 2.2 })
    const stepped = t('en', 'main.benchmark.warnVeryLowTokens', { model: 'oversized-27b' })
    pinRam(16)
    const lite = await runBenchmark({ workspacePath: workspace(), manifests: realManifests(), runtime: crawl() })
    expect(lite.tokensPerSecond).toBe(2.2)
    expect(lite.measuredModelId).toBe('oversized-27b')
    expect(lite.profile).toBe('TINY')
    expect(lite.warnings).toContain(stepped)
    // Already on the lowest rung: the reading moved nothing, so nothing is claimed.
    pinRam(8)
    const tiny = await runBenchmark({ workspacePath: workspace(), manifests: realManifests(), runtime: crawl() })
    expect(tiny.profile).toBe('TINY')
    expect(tiny.warnings).not.toContain(stepped)
  })

  // §6.5 (issue #95): runBenchmark applies the SAME signal-aware picker rule as listModels,
  // with the just-measured values — so the Diagnostics card and the Models screen ★ can
  // never disagree. The named warning appears exactly when the signal moved the pick.
  it('applies the §6.5 speed signal to its own recommendation, consistently with the picker (issue #95)', async () => {
    const manifests = realManifests()
    pinRam(32)
    const q5 = 'qwen3.8-27b-ud-q5km'
    const moved = await runBenchmark({ workspacePath: workspace(), manifests, runtime: stubChatRuntime({ modelId: q5, perSecond: 2.2 }) })
    expect(moved.recommendedModelId).toBe('qwen3.8-27b-ud-q4km')
    expect(moved.warnings).toContain(t('en', 'main.benchmark.warnRecommendationLowered', { tps: 2.2, model: q5 }))
    // No lower ranked tier at 8 GB: the pick keeps, and the warning stays away.
    pinRam(8)
    const fourB = 'qwen3.5-4b-ud-q4kxl'
    const kept = await runBenchmark({ workspacePath: workspace(), manifests, runtime: stubChatRuntime({ modelId: fourB, perSecond: 2.2 }) })
    expect(kept.recommendedModelId).toBe(fourB)
    expect(kept.warnings).not.toContain(t('en', 'main.benchmark.warnRecommendationLowered', { tps: 2.2, model: fourB }))
  })

  it('an unresolvable measured model never moves the recommendation (§6.5 predicate)', async () => {
    pinRam(32)
    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests: realManifests(),
      runtime: stubChatRuntime({ modelId: 'mock-not-in-catalog', perSecond: 2.2 })
    })
    expect(result.recommendedModelId).toBe('qwen3.8-27b-ud-q5km')
    expect(result.warnings).not.toContain(
      t('en', 'main.benchmark.warnRecommendationLowered', { tps: 2.2, model: 'mock-not-in-catalog' })
    )
  })
})

describe('runBenchmark progress: a step ticks only when it succeeded (L3 / T4)', () => {
  const run = async (
    over: Partial<Parameters<typeof runBenchmark>[0]>,
    workspacePath = workspace()
  ): Promise<BenchmarkProgressStep[]> => {
    const steps: BenchmarkProgressStep[] = []
    await runBenchmark({ workspacePath, manifests: [], onProgress: (s) => steps.push(s), ...over })
    return steps
  }

  it('no runtime: system, drive, done', async () => {
    expect(await run({})).toEqual(['system', 'drive', 'done'])
  })

  it('a runtime that produced a reading: system, drive, speed, done', async () => {
    expect(await run({ runtime: stubChatRuntime() })).toEqual(['system', 'drive', 'speed', 'done'])
  })

  it('a runtime that was busy elsewhere (the leg skipped, #185): no speed step', async () => {
    expect(await run({ runtime: stubChatRuntime(), modelBusy: () => true })).toEqual(['system', 'drive', 'done'])
  })

  it('a speed probe that failed (the stream threw): no speed step', async () => {
    const failing: ModelRuntime = {
      ...stubChatRuntime(),
      async *chatStream() {
        throw new Error('sidecar gone')
      }
    }
    expect(await run({ runtime: failing })).toEqual(['system', 'drive', 'done'])
  })

  it('a drive probe that failed (unwritable workspace): no drive step, and no later step implies it', async () => {
    const missing = join(workspace(), 'does-not-exist', 'workspace')
    const steps = await run({ runtime: stubChatRuntime() }, missing)
    expect(steps).toEqual(['system', 'speed', 'done'])
  })

  it('a throwing onProgress never fails the run', async () => {
    const seen: BenchmarkProgressStep[] = []
    const fresh = await runBenchmark({
      workspacePath: workspace(),
      manifests: [],
      onProgress: (s) => {
        seen.push(s)
        throw new Error('renderer gone')
      }
    })
    expect(seen).toEqual(['system', 'drive', 'done'])
    expect(fresh.profile).toBeTruthy()
  })
})

// ---- No-network guarantee across the whole benchmark path ------------------------

describe('offline guarantee (benchmark path)', () => {
  it('makes zero network calls across detection + drive + tokens/sec + recommend', async () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests: realManifests(),
      runtime: runtime()
    })
    expect(result.profile).toBeTruthy()

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
