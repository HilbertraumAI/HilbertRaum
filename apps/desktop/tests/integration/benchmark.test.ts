import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'
import {
  buildModelList,
  discoverManifests,
  resolveManifestsDir,
  recommendModelIdByRam,
  SLOW_PICK_TOKENS_PER_SECOND
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
  VERY_LOW_TOKENS_PER_SECOND,
  SLOW_DRIVE_MBPS,
  SLOW_EFFECTIVE_READ_MBPS,
  BENCHMARK_PROMPT,
  BENCHMARK_TOKEN_TARGET
} from '../../src/main/services/benchmark'
import { t } from '../../src/shared/i18n'
import { gpuUsefulForProfile } from '../../src/main/services/runtime/gpu'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeTimings
} from '../../src/main/services/runtime'
import type { GpuDevice } from '../../src/shared/types'

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-bench-')), 'test.sqlite'))
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
 * A runtime that generates BELOW `VERY_LOW_TOKENS_PER_SECOND` (issue #52): two chunks at
 * ~450 ms each → ≈2.2 tok/s. The timers ARE the simulated slow generation — tok/s is
 * wall-clock-counted, so the fixed delay is the semantics here, not a sync point
 * (CONTRIBUTING "no fixed sleeps" simulation exception, like ingestion-limits' slow parse).
 */
function slowRuntime(modelId: string): ModelRuntime {
  return {
    modelId,
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream() {
      for (const chunk of ['one', 'two']) {
        await new Promise((resolve) => setTimeout(resolve, 450))
        yield chunk
      }
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
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
    expect(classifyProfile(16, { tokensPerSecond: VERY_LOW_TOKENS_PER_SECOND - 1 })).toBe('TINY')
    expect(classifyProfile(64, { tokensPerSecond: 0.5 })).toBe('BALANCED')
    // TINY cannot go lower.
    expect(classifyProfile(8, { tokensPerSecond: 0.5 })).toBe('TINY')
    // A healthy rate leaves the RAM-based profile intact.
    expect(classifyProfile(16, { tokensPerSecond: 80 })).toBe('LITE')
  })

  // Phase 16 (architecture.md GPU record §8): the bump fires only on a PRE-QUALIFIED gpuUseful
  // hint (≥ 6 GiB dedicated + not integrated-looking — computed by gpuUsefulForProfile),
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

// ---- GPU profile-bump gate (Phase 16, architecture.md GPU record §8) -----------------

describe('gpuUsefulForProfile', () => {
  const dev = (name: string, totalMb: number): GpuDevice => ({ id: 'Vulkan0', name, totalMb, freeMb: totalMb })

  it('qualifies a discrete GPU with ≥ 6 GiB', () => {
    expect(gpuUsefulForProfile([dev('NVIDIA GeForce RTX 3080 Ti', 12300)])).toBe(true)
    expect(gpuUsefulForProfile([dev('AMD Radeon RX 6700 XT', 12272)])).toBe(true)
  })

  it('an iGPU reporting 16 GB of SHARED memory does NOT qualify (the §8 case)', () => {
    expect(gpuUsefulForProfile([dev('Intel(R) Iris(R) Xe Graphics', 16000)])).toBe(false)
    expect(gpuUsefulForProfile([dev('AMD Radeon(TM) Graphics', 16000)])).toBe(false)
  })

  it('a small discrete GPU (< 6 GiB) does not qualify', () => {
    expect(gpuUsefulForProfile([dev('NVIDIA GeForce GTX 1650', 4096)])).toBe(false)
  })

  it('no devices → not useful', () => {
    expect(gpuUsefulForProfile([])).toBe(false)
  })

  it('any one qualifying device among several is enough', () => {
    expect(
      gpuUsefulForProfile([
        dev('Intel(R) UHD Graphics 630', 16000),
        dev('NVIDIA GeForce RTX 3080 Ti', 12300)
      ])
    ).toBe(true)
  })
})

describe('runBenchmark GPU injection (Phase 16)', () => {
  it('carries the injected probe summary into the result + profile', async () => {
    const ws = workspace()
    const result = await runBenchmark({
      workspacePath: ws,
      manifests: [],
      gpu: { name: 'NVIDIA GeForce RTX 3080 Ti', useful: true }
    })
    expect(result.gpu).toBe('NVIDIA GeForce RTX 3080 Ti')
    // The profile is one step above the pure-RAM classification (capped at PRO).
    const ramOnly = classifyProfile(result.ramGb)
    const steps = ['TINY', 'LITE', 'BALANCED', 'PRO']
    expect(steps.indexOf(result.profile)).toBe(Math.min(steps.indexOf(ramOnly) + 1, 3))
  })

  it('an un-useful (or absent) GPU changes nothing', async () => {
    const ws = workspace()
    const withIgpu = await runBenchmark({
      workspacePath: ws,
      manifests: [],
      gpu: { name: 'Intel(R) Iris(R) Xe Graphics', useful: false }
    })
    const without = await runBenchmark({ workspacePath: ws, manifests: [] })
    expect(withIgpu.profile).toBe(without.profile)
    expect(withIgpu.gpu).toBe('Intel(R) Iris(R) Xe Graphics') // name still surfaces
    expect(without.gpu).toBeNull()
  })
})

// ---- Recommendation selection per profile (real manifests) ----------------------

describe('recommendation per profile', () => {
  it('selects the right chat model from the committed manifests', () => {
    const manifests = realManifests()
    // Mapping table (spec §7.3): TINY→4b, LITE→4b, BALANCED→8b, PRO→14b, UNKNOWN→4b.
    // 1.7b was dropped 2026-06-10 (no official Q4_K_M), so 4b — the smallest bundled chat
    // model — now also covers TINY + UNKNOWN. Each profile is still claimed by exactly one
    // chat model, so the first-match recommendation is unambiguous.
    expect(pick(manifests, 'TINY')).toBe('qwen3-4b-instruct-q4')
    expect(pick(manifests, 'LITE')).toBe('qwen3-4b-instruct-q4')
    expect(pick(manifests, 'BALANCED')).toBe('qwen3-8b-instruct-q4')
    expect(pick(manifests, 'PRO')).toBe('qwen3-14b-instruct-q4')
    expect(pick(manifests, 'UNKNOWN')).toBe('qwen3-4b-instruct-q4')
  })

  it('does not auto-recommend the 30B-A3B MoE model for any profile (opt-in only)', () => {
    const manifests = realManifests()
    const moe = manifests.find((m) => m.id === 'qwen3-30b-a3b-q4')
    expect(moe).toBeDefined()
    expect(moe!.recommendedProfiles).toEqual([])
    for (const profile of ['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN'] as const) {
      expect(pick(manifests, profile)).not.toBe('qwen3-30b-a3b-q4')
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

  it('never auto-recommends the opt-in 30B MoE or the benchmark-loser Granite (real manifests)', () => {
    const m = realManifests()
    for (const ram of [8, 12, 16, 24, 32, 64]) {
      const id = recommendModelIdByRam(m, ram, 'chat')
      expect(id).not.toBe('qwen3-30b-a3b-q4')
      expect(id).not.toBe('granite-4.1-8b-q4')
    }
  })
})

function pick(manifests: ModelManifest[], profile: 'TINY' | 'LITE' | 'BALANCED' | 'PRO' | 'UNKNOWN'): string | null {
  const match = manifests.find((m) => m.role === 'chat' && m.recommendedProfiles.includes(profile))
  return match?.id ?? null
}

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

  it('returns a positive estimate from a running (mock) runtime — the chunk fallback, flagged', async () => {
    const reading = await measureTokensPerSecond(runtime())
    expect(reading).not.toBeNull()
    expect(reading!.tokensPerSecond).toBeGreaterThan(0)
    // The mock sends no `timings`, so the reading is the approximate chunk count over wall time.
    expect(reading!.basis).toBe('chunks')
    expect(reading!.tokens).toBeGreaterThan(0)
  })

  // #291 — the runtime's own decode timings win over the chunk count. A fake runtime whose
  // stream reports `timings` on its final chunk (the llama-server shape via PR 1's onFinish
  // hand-up); the wall clock plays no part in the timings-based figure.
  function timedRuntime(
    chunks: string[],
    timings: RuntimeTimings | undefined,
    perChunkDelayMs = 0
  ): ModelRuntime {
    return {
      modelId: 'timed',
      async start() {},
      async stop() {},
      async health() {
        return { healthy: true, message: '', port: null }
      },
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        for (const c of chunks) {
          if (perChunkDelayMs > 0) await new Promise((r) => setTimeout(r, perChunkDelayMs))
          yield c
        }
        options?.onFinish?.('length', timings)
      }
    }
  }

  it('reports the runtime timings’ predicted_per_second (decode only) when the final chunk carries them', async () => {
    const reading = await measureTokensPerSecond(
      timedRuntime(['a', 'b', 'c'], {
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

  it('does NOT undercount MTP-style multi-token chunks when timings are present', async () => {
    // Three SSE chunks carrying eight tokens (an accepted draft run rides one chunk each);
    // 25 ms per chunk ⇒ a chunk-rate reading would be ~40 chunks/s, the server says 106 tok/s.
    const reading = await measureTokensPerSecond(
      timedRuntime(['one two three', 'four five', 'six seven eight'], {
        predicted_n: 8,
        predicted_ms: 75.5,
        predicted_per_second: 106
      }, 25)
    )
    expect(reading).toEqual({ tokensPerSecond: 106, basis: 'timings', tokens: 8 })
  })

  it('falls back to the chunk count over wall time when the stream carries no timings', async () => {
    const reading = await measureTokensPerSecond(timedRuntime(['a', 'b', 'c', 'd'], undefined, 5))
    expect(reading).not.toBeNull()
    expect(reading!.basis).toBe('chunks')
    expect(reading!.tokens).toBe(4)
    expect(reading!.tokensPerSecond).toBeGreaterThan(0)
  })

  it('ignores a timings block without a usable predicted_per_second (falls back, flagged)', async () => {
    const reading = await measureTokensPerSecond(timedRuntime(['a', 'b'], { prompt_n: 3 }, 5))
    expect(reading!.basis).toBe('chunks')
    expect(reading!.tokens).toBe(2)
  })

  it('consumes the whole capped stream so the final (timings) chunk is never cancelled away', async () => {
    // Trap 1 (#291): the old probe broke out on the 64th chunk, cancelling the reader before the
    // finish chunk arrived. Exactly BENCHMARK_TOKEN_TARGET chunks then the finish → timings land.
    const chunks = Array.from({ length: BENCHMARK_TOKEN_TARGET }, (_, i) => `t${i} `)
    const reading = await measureTokensPerSecond(
      timedRuntime(chunks, { predicted_n: BENCHMARK_TOKEN_TARGET, predicted_per_second: 38.4 })
    )
    expect(reading).toEqual({ tokensPerSecond: 38.4, basis: 'timings', tokens: BENCHMARK_TOKEN_TARGET })
  })

  it('sends the paragraph prompt under the 64-token cap', async () => {
    let seen: { prompt: string; maxTokens?: number } | null = null
    const spy: ModelRuntime = {
      ...timedRuntime(['x'], undefined),
      async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
        seen = { prompt: messages[0].content, maxTokens: options?.maxTokens }
        yield 'x'
        options?.onFinish?.('stop')
      }
    }
    await measureTokensPerSecond(spy)
    expect(seen).toEqual({ prompt: BENCHMARK_PROMPT, maxTokens: BENCHMARK_TOKEN_TARGET })
    expect(BENCHMARK_PROMPT).toMatch(/paragraph/)
  })
})

// ---- Warnings (spec §11.3 + §11.4 friendly copy) --------------------------------

describe('buildWarnings', () => {
  it('uses encouraging language for weak hardware (never "your hardware is bad")', () => {
    const w = buildWarnings({ profile: 'TINY', driveReadMbps: 500, driveWriteMbps: 500 })
    expect(w.join(' ')).toContain('smallest, quickest model')
    expect(w.join(' ').toLowerCase()).not.toContain('bad')
  })

  it('warns (without blocking) on a slow drive', () => {
    const w = buildWarnings({
      profile: 'BALANCED',
      driveReadMbps: SLOW_DRIVE_MBPS - 1,
      driveWriteMbps: SLOW_DRIVE_MBPS - 1
    })
    expect(w.some((m) => m.toLowerCase().includes('slower'))).toBe(true)
  })

  it('notes when drive speed could not be measured', () => {
    const w = buildWarnings({
      profile: 'BALANCED',
      driveReadMbps: null,
      driveWriteMbps: null,
      driveError: 'EACCES'
    })
    expect(w.some((m) => m.toLowerCase().includes('drive speed could not be measured'))).toBe(true)
  })

  it('is empty for a healthy mid-tier machine', () => {
    expect(buildWarnings({ profile: 'BALANCED', driveReadMbps: 500, driveWriteMbps: 500 })).toEqual([])
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
    const timed: ModelRuntime = {
      modelId: 'qwen3-9b',
      async start() {},
      async stop() {},
      async health() {
        return { healthy: true, message: '', port: null }
      },
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        yield 'a'
        options?.onFinish?.('length', { predicted_n: 64, predicted_per_second: 47.9 })
      }
    }
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
    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests: realManifests(),
      runtime: runtime(),
      now: () => new Date('2026-06-09T00:00:00.000Z')
    })
    expect(result.ranAt).toBe('2026-06-09T00:00:00.000Z')
    expect(result.ramGb).toBeGreaterThan(0)
    expect(['TINY', 'LITE', 'BALANCED', 'PRO', 'UNKNOWN']).toContain(result.profile)
    expect(result.recommendedModelId).toBeTruthy()
    expect(result.tokensPerSecond).not.toBeNull()
    // Issue #52: the result records WHICH model produced the tok/s number.
    expect(result.measuredModelId).toBe('mock-chat')
    expect(Array.isArray(result.warnings)).toBe(true)
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

  // End-to-end wiring of the issue-#52 downgrade warning. The profile downgrade itself
  // depends on this machine's real RAM (a ≤8 GB box is already TINY and can't step down),
  // so the assertion pins CONSISTENCY: the named warning appears exactly when the tok/s
  // hint moved the profile relative to the same classification without it.
  it('emits the named very-low-tokens warning exactly when the profile stepped down (issue #52)', async () => {
    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests: realManifests(),
      runtime: slowRuntime('oversized-27b')
    })
    expect(result.tokensPerSecond).not.toBeNull()
    expect(result.tokensPerSecond!).toBeLessThan(VERY_LOW_TOKENS_PER_SECOND)
    expect(result.measuredModelId).toBe('oversized-27b')
    const downgraded = result.profile !== classifyProfile(result.ramGb, { gpuUseful: false })
    expect(result.warnings.some((w) => w.includes('(oversized-27b)'))).toBe(downgraded)
  })

  // §6.5 (issue #95): runBenchmark applies the SAME signal-aware picker rule as listModels,
  // with the just-measured values — so the Diagnostics card and the Models screen ★ can
  // never disagree. Whether the step actually fires depends on this machine's real RAM
  // (the measured model must be right-sized for the tier), so the pin is CONSISTENCY, plus
  // "warning present exactly when the pick moved" — the #52 test's pattern.
  it('applies the §6.5 speed signal to its own recommendation, consistently with the picker (issue #95)', async () => {
    const manifests = realManifests()
    // A crawl "measured on" the machine's own no-signal pick: the predicate applies at
    // every RAM level, so on any CI box the recommendation follows the stepped rule.
    const ownPick = recommendModelIdByRam(manifests, Math.round(detectSystem().ramGb), 'chat')
    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests,
      runtime: slowRuntime(ownPick ?? 'none-installed')
    })
    expect(result.tokensPerSecond).not.toBeNull()
    expect(result.tokensPerSecond!).toBeLessThan(SLOW_PICK_TOKENS_PER_SECOND)
    const ram = Math.round(result.ramGb)
    const expected = recommendModelIdByRam(manifests, ram, 'chat', {
      tokensPerSecond: result.tokensPerSecond,
      measuredModelId: result.measuredModelId
    })
    expect(result.recommendedModelId).toBe(expected)
    // The named §6.5 warning appears exactly when the signal moved the pick.
    const moved = expected !== recommendModelIdByRam(manifests, ram, 'chat')
    const warning = t('en', 'main.benchmark.warnRecommendationLowered', {
      tps: result.tokensPerSecond!,
      model: result.measuredModelId!
    })
    expect(result.warnings.includes(warning)).toBe(moved)
  })

  it('an unresolvable measured model never moves the recommendation (§6.5 predicate)', async () => {
    const manifests = realManifests()
    const result = await runBenchmark({
      workspacePath: workspace(),
      manifests,
      runtime: slowRuntime('mock-not-in-catalog')
    })
    expect(result.recommendedModelId).toBe(
      recommendModelIdByRam(manifests, Math.round(result.ramGb), 'chat')
    )
    expect(result.warnings.some((w) => w.includes('moved down one size tier'))).toBe(false)
  })

  it('persists to settings; getAppStatus + buildModelList then read the real profile', async () => {
    const db = freshDb()
    seedSettings(db)
    // Before any benchmark, the persisted profile is UNKNOWN.
    expect(getSettings(db).lastBenchmark).toBeNull()

    const result = await runBenchmark({ workspacePath: workspace(), manifests: realManifests() })
    updateSettings(db, { lastBenchmark: result })

    // getAppStatus reads `lastBenchmark.profile`.
    const persistedProfile = getSettings(db).lastBenchmark?.profile ?? 'UNKNOWN'
    expect(persistedProfile).toBe(result.profile)

    // buildModelList consumes the same persisted profile + machine RAM, exactly like
    // the production listModels wiring — the RAM-best-fit recommendation must agree
    // with the benchmark's (same rule, same whole-GB rounding).
    const dir = resolveManifestsDir(process.cwd())!
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: workspace(),
      profile: persistedProfile,
      developerMode: true,
      machineRamGb: Math.round(result.ramGb)
    })
    const recommended = models.filter((m) => m.recommended).map((m) => m.id)
    if (result.recommendedModelId) {
      expect(recommended).toContain(result.recommendedModelId)
    }
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
