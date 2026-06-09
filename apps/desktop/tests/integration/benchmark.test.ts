import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'
import { buildModelList, discoverManifests, resolveManifestsDir } from '../../src/main/services/models'
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

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-bench-')), 'test.sqlite'))
}
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'paid-bench-ws-'))
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

  it('bumps one step toward PRO when a useful GPU is present (capped at PRO)', () => {
    expect(classifyProfile(8, { gpu: 'NVIDIA RTX' })).toBe('LITE')
    expect(classifyProfile(64, { gpu: 'NVIDIA RTX' })).toBe('PRO')
  })

  it('returns UNKNOWN when RAM detection failed (invalid value)', () => {
    expect(classifyProfile(0)).toBe('UNKNOWN')
    expect(classifyProfile(Number.NaN)).toBe('UNKNOWN')
    expect(classifyProfile(-4)).toBe('UNKNOWN')
  })
})

// ---- Recommendation selection per profile (real manifests) ----------------------

describe('recommendation per profile', () => {
  it('selects the right chat model from the committed manifests', () => {
    const manifests = realManifests()
    // Mapping table (spec §7.3): TINY→1.7b, LITE→4b, BALANCED→8b, PRO→14b, UNKNOWN→1.7b.
    // Each profile is claimed by exactly ONE chat model, so the first-match recommendation
    // is unambiguous regardless of manifest discovery order.
    expect(pick(manifests, 'TINY')).toBe('qwen3-1.7b-instruct-q4')
    expect(pick(manifests, 'LITE')).toBe('qwen3-4b-instruct-q4')
    expect(pick(manifests, 'BALANCED')).toBe('qwen3-8b-instruct-q4')
    expect(pick(manifests, 'PRO')).toBe('qwen3-14b-instruct-q4')
    expect(pick(manifests, 'UNKNOWN')).toBe('qwen3-1.7b-instruct-q4')
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
    const speed = await measureDriveSpeed(join(tmpdir(), 'paid-does-not-exist-xyz', 'nope'))
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
    expect(w.join(' ')).toContain('Fast Mode')
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

    // buildModelList consumes the same persisted profile (no electron needed).
    const dir = resolveManifestsDir(process.cwd())!
    const { models } = await buildModelList({
      manifestsDir: dir,
      rootPath: workspace(),
      profile: persistedProfile,
      developerMode: true
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
