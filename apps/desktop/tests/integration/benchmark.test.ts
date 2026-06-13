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
  VERY_LOW_TOKENS_PER_SECOND,
  SLOW_DRIVE_MBPS
} from '../../src/main/services/benchmark'
import { gpuUsefulForProfile } from '../../src/main/services/runtime/gpu'
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

// ---- GPU profile-bump gate (Phase 16, architecture.md GPU record §8/§11.1) -----------------

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

  // Phase-29: the RAM-best-fit picker is now quality-aware (recommendation_rank). It recommends
  // the BENCHMARK WINNER for each machine size, not the biggest-on-disk model.
  it('recommends the Phase-29 benchmark winner per machine RAM (real manifests)', () => {
    const m = realManifests()
    expect(recommendModelIdByRam(m, 8, 'chat')).toBe('qwen3-4b-instruct-q4') // default 4B (Deep)
    expect(recommendModelIdByRam(m, 12, 'chat')).toBe('qwen3-4b-instruct-q4')
    expect(recommendModelIdByRam(m, 16, 'chat')).toBe('ministral3-8b-instruct-2512-q4') // best 8B
    expect(recommendModelIdByRam(m, 32, 'chat')).toBe('gemma4-12b-it-qat-q4') // best 12-14B
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

  it('returns a positive estimate from a running (mock) runtime', async () => {
    const tps = await measureTokensPerSecond(runtime())
    expect(tps).not.toBeNull()
    expect(tps!).toBeGreaterThan(0)
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
})

// ---- runBenchmark + persistence + downstream reads ------------------------------

describe('runBenchmark', () => {
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
    expect(Array.isArray(result.warnings)).toBe(true)
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
