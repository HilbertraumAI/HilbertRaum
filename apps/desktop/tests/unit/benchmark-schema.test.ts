import { describe, it, expect } from 'vitest'
import {
  hasMachineIdentity,
  isHardwareProfile,
  machineKey,
  normalizeBenchmarkHistory,
  normalizeBenchmarkResult,
  normalizeEffectiveRead,
  normalizeGpuDevice,
  normalizeGpuProbe,
  normalizeModelPlacement,
  normalizeModelPlacements,
  normalizePlacementDevice,
  normalizeSpeedBasis,
  UNKNOWN_RAN_AT
} from '../../src/shared/benchmark-schema'
import {
  MAX_BENCHMARK_HISTORY,
  type BenchmarkResult,
  type GpuDevice,
  type GpuProbeResult,
  type ModelPlacement
} from '../../src/shared/types'

// The structural validators for the persisted benchmark records (PR #303 audit H1 / L8, owner
// decision G7). These pin the two rules everything else rests on:
//
//  - MINIMUM VALIDITY: a record must carry a parseable `ranAt` OR a real `HardwareProfile`.
//    `{}` — the shape the old write gate accepted, which reached the Performance screen and
//    threw in `fmt1(undefined)` — is not a benchmark result.
//  - LEGACY SURVIVAL (G3): `{ profile: 'BALANCED' }` stays a valid record with an UNKNOWN
//    identity and an UNKNOWN date, so an old workspace keeps behaving exactly as it did.
//
// Everything else is repair-not-reject: a figure that cannot be trusted becomes null, an
// identity that cannot be trusted becomes the unknown one (so `machineKey` returns null rather
// than half a key — B-G1 requires os, arch, cpuModel and ramGb together), and the optional
// legacy fields keep their ABSENCE, which the screens read as "not recorded".

/** A complete, healthy result — the shape a real run persists. */
function complete(over: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    os: 'win32',
    arch: 'x64',
    cpuModel: 'Intel Core i7-1260P',
    cpuCores: 12,
    ramGb: 15.7,
    gpu: 'NVIDIA GeForce RTX 3090',
    gpuVramMb: 24576,
    driveReadMbps: 1200,
    driveWriteMbps: 900,
    tokensPerSecond: 41,
    speedBasis: { basis: 'timings', tokens: 64 },
    measuredModelId: 'qwen3.5-9b-ud-q4kxl',
    effectiveRead: { mbps: 430, bytes: 5_800_000_000, ms: 13_500, source: 'model_load', modelId: 'qwen', at: '2026-09-04T12:00:00Z' },
    profile: 'PRO',
    recommendedModelId: 'qwen3.5-9b-ud-q4kxl',
    warnings: ['something happened'],
    ranAt: '2026-09-05T00:00:00Z',
    ...over
  }
}

/** A complete, healthy placement record. */
function placement(over: Partial<ModelPlacement> = {}): ModelPlacement {
  return {
    modelId: 'qwen',
    contextTokens: 8192,
    backend: 'gpu',
    gpuLayers: 41,
    totalLayers: 41,
    gpuModelMb: 5500,
    cpuModelMb: 400,
    gpuKvMb: 640,
    cpuKvMb: null,
    metalMaxWorkingSetMb: null,
    machineKey: 'win32|x64|CPU|8|16',
    at: '2026-09-05T14:00:00Z',
    ...over
  }
}

describe('normalizeBenchmarkResult — minimum validity', () => {
  it('rejects everything that is not an object, and the empty object itself', () => {
    for (const raw of [null, undefined, 3, 'x', true, [], [{}], {}, { nothing: true }]) {
      expect(normalizeBenchmarkResult(raw)).toBeNull()
    }
  })

  it('rejects a blob whose only claim is an invented profile name', () => {
    // 'FAST_LOCAL' is not one of the five HardwareProfile values, and there is no date either:
    // the object says nothing about any machine.
    expect(normalizeBenchmarkResult({ profile: 'FAST_LOCAL' })).toBeNull()
    expect(isHardwareProfile('FAST_LOCAL')).toBe(false)
  })

  it('accepts a dated record with no profile, reading the profile as UNKNOWN', () => {
    const r = normalizeBenchmarkResult({ ranAt: '2026-09-05T00:00:00Z', cpuModel: 'CPU', ramGb: 8 })
    expect(r).not.toBeNull()
    expect(r?.profile).toBe('UNKNOWN')
    expect(r?.ranAt).toBe('2026-09-05T00:00:00Z')
  })

  it('reads an unrecognised profile on a DATED record as UNKNOWN rather than dropping the run', () => {
    expect(normalizeBenchmarkResult({ ranAt: '2026-09-05T00:00:00Z', profile: 'FAST_LOCAL' })?.profile).toBe('UNKNOWN')
  })

  it('rejects a record whose only date is unparseable', () => {
    expect(normalizeBenchmarkResult({ ranAt: 'not-a-date', cpuModel: 'CPU', ramGb: 8 })).toBeNull()
    expect(normalizeBenchmarkResult({ ranAt: 12345, cpuModel: 'CPU', ramGb: 8 })).toBeNull()
  })
})

describe('normalizeBenchmarkResult — the legacy profile-only blob (G3)', () => {
  it('keeps it as a valid record with an unknown identity and an unknown date', () => {
    const r = normalizeBenchmarkResult({ profile: 'BALANCED' })
    expect(r).toEqual({
      os: '',
      arch: '',
      cpuModel: '',
      cpuCores: 0,
      ramGb: 0,
      gpu: null,
      driveReadMbps: null,
      driveWriteMbps: null,
      tokensPerSecond: null,
      profile: 'BALANCED',
      recommendedModelId: null,
      warnings: [],
      ranAt: UNKNOWN_RAN_AT
    })
    // The sentinel is the EMPTY string, never a fabricated "now": readers print "unknown".
    expect(UNKNOWN_RAN_AT).toBe('')
    expect(Number.isNaN(new Date(r!.ranAt).getTime())).toBe(true)
    // Unknown identity ⇒ no key ⇒ it is never filed under a machine and never fabricates one.
    expect(machineKey(r)).toBeNull()
    expect(hasMachineIdentity(r)).toBe(false)
  })
})

// B-G1 (PR #303 audit remediation): identity is all-or-nothing. `hasMachineIdentity` used to
// ask only for `cpuModel` + `ramGb`, so a record with no `os`/`arch` normalized to `os: ''`,
// `arch: ''` and keyed as `'||x|0|16'` — a phantom the history filed and kept forever, because
// `detectSystem` always reports a real platform and arch, so no living computer could produce
// that key to match or replace it.
describe('hasMachineIdentity — every field a real detection fills, or none (B-G1)', () => {
  it('a record without os/arch has no identity: machineKey null, dropped from history, kept as an unkeyed current record', () => {
    const half = { ranAt: '2026-09-05T00:00:00Z', cpuModel: 'x', ramGb: 16 }
    const r = normalizeBenchmarkResult(half)
    // Still a VALID record — the tolerance policy keeps a dated observation (G3) …
    expect(r).not.toBeNull()
    expect(r).toMatchObject({ os: '', arch: '', cpuModel: 'x', ramGb: 16 })
    // … but it identifies no machine, so it can never be keyed on.
    expect(hasMachineIdentity(r)).toBe(false)
    expect(machineKey(r)).toBeNull()
    // And it never enters the per-machine history beside the real computers.
    const history = normalizeBenchmarkHistory([half, complete()])
    expect(history.map((e) => e.cpuModel)).toEqual([complete().cpuModel])
  })

  it('each identity field is required on its own — os, arch, cpuModel, ramGb', () => {
    expect(hasMachineIdentity(complete())).toBe(true)
    for (const missing of [{ os: '' }, { arch: '' }, { cpuModel: '' }, { ramGb: 0 }]) {
      expect(hasMachineIdentity(complete(missing))).toBe(false)
      expect(machineKey(complete(missing))).toBeNull()
    }
  })

  it('a zero core count still identifies a machine: os.cpus() can legitimately be empty', () => {
    // The one detected field that may be 0 on a real computer, so it must not disqualify one —
    // it still takes part in the key, it just cannot veto it.
    expect(hasMachineIdentity(complete({ cpuCores: 0 }))).toBe(true)
    expect(machineKey(complete({ cpuCores: 0 }))).toBe('win32|x64|Intel Core i7-1260P|0|16')
  })
})

describe('normalizeBenchmarkResult — field repair', () => {
  it('round-trips a complete result unchanged', () => {
    const r = complete()
    expect(normalizeBenchmarkResult(structuredClone(r))).toEqual(r)
  })

  it('normalizes a malformed identity to the unknown one, never half a key', () => {
    const r = normalizeBenchmarkResult({ ...complete(), cpuModel: 42, ramGb: -8, cpuCores: Number.NaN, os: null })
    expect(r).toMatchObject({ os: '', cpuModel: '', ramGb: 0, cpuCores: 0 })
    expect(machineKey(r)).toBeNull()
  })

  it('nulls every unusable figure and keeps the usable ones', () => {
    const r = normalizeBenchmarkResult({
      ...complete(),
      tokensPerSecond: Number.NaN,
      driveReadMbps: Number.POSITIVE_INFINITY,
      driveWriteMbps: -1,
      gpuVramMb: '24576',
      gpu: 7
    })
    expect(r).toMatchObject({ tokensPerSecond: null, driveReadMbps: null, driveWriteMbps: null, gpuVramMb: null, gpu: null })
    expect(r?.ramGb).toBe(15.7)
  })

  it('floors a fractional core count and keeps warnings to strings only', () => {
    const r = normalizeBenchmarkResult({ ...complete(), cpuCores: 12.9, warnings: ['a', 3, null, { b: 1 }, 'c'] })
    expect(r?.cpuCores).toBe(12)
    expect(r?.warnings).toEqual(['a', 'c'])
    expect(normalizeBenchmarkResult({ ...complete(), warnings: 'nope' })?.warnings).toEqual([])
  })
})

describe('normalizeBenchmarkResult — the optional legacy fields keep their absence', () => {
  it('never fabricates a field the stored record does not have', () => {
    const old = complete()
    delete old.gpuVramMb
    delete old.speedBasis
    delete old.measuredModelId
    delete old.effectiveRead
    const r = normalizeBenchmarkResult(structuredClone(old))!
    // ABSENT, not null: the screen renders an absent basis as "approximate" and an absent
    // sample as "not measured yet" — a null would claim the field was recorded as empty.
    expect('gpuVramMb' in r).toBe(false)
    expect('speedBasis' in r).toBe(false)
    expect('measuredModelId' in r).toBe(false)
    expect('effectiveRead' in r).toBe(false)
    expect(r).toEqual(old)
  })

  it('keeps a present-but-unusable optional field as null (it WAS recorded, as nothing)', () => {
    const r = normalizeBenchmarkResult({ ...complete(), speedBasis: { basis: 'guess', tokens: 5 }, effectiveRead: {} })!
    expect(r.speedBasis).toBeNull()
    expect(r.effectiveRead).toBeNull()
    expect('speedBasis' in r).toBe(true)
  })
})

describe('normalizeSpeedBasis / normalizeEffectiveRead', () => {
  it('accepts the two bases with a whole token count, rejects anything else', () => {
    expect(normalizeSpeedBasis({ basis: 'timings', tokens: 64 })).toEqual({ basis: 'timings', tokens: 64 })
    expect(normalizeSpeedBasis({ basis: 'chunks', tokens: 10.7 })).toEqual({ basis: 'chunks', tokens: 10 })
    for (const raw of [null, {}, { basis: 'timings' }, { basis: 'guess', tokens: 1 }, { basis: 'chunks', tokens: -1 }]) {
      expect(normalizeSpeedBasis(raw)).toBeNull()
    }
  })

  it('requires the whole sample: source enum, three finite figures and a parseable date', () => {
    const good = { mbps: 430, bytes: 5_800_000_000, ms: 13_500, source: 'model_load', modelId: null, at: '2026-09-04T12:00:00Z' }
    expect(normalizeEffectiveRead(good)).toEqual(good)
    expect(normalizeEffectiveRead({ ...good, modelId: 7 })?.modelId).toBeNull()
    for (const bad of [
      { ...good, source: 'guess' },
      { ...good, mbps: Number.NaN },
      { ...good, bytes: -1 },
      { ...good, ms: 'fast' },
      { ...good, at: 'whenever' }
    ]) {
      expect(normalizeEffectiveRead(bad)).toBeNull()
    }
  })
})

describe('normalizeBenchmarkHistory', () => {
  const entry = (cpuModel: string, ranAt: string, over: Partial<BenchmarkResult> = {}): BenchmarkResult =>
    complete({ cpuModel, ranAt, ...over })

  it('is empty for a non-array, and drops invalid and unkeyed elements', () => {
    expect(normalizeBenchmarkHistory(null)).toEqual([])
    expect(normalizeBenchmarkHistory({ 0: entry('a', '2026-09-01T00:00:00Z') })).toEqual([])
    const kept = normalizeBenchmarkHistory([
      {},
      'nope',
      42,
      null,
      ['no'],
      { profile: 'BALANCED' }, // valid, but UNKEYED: it could never be matched again
      entry('a', '2026-09-01T00:00:00Z')
    ])
    expect(kept.map((e) => e.cpuModel)).toEqual(['a'])
  })

  it('keeps one record per machine — the newest ranAt wins — and orders newest first', () => {
    const history = normalizeBenchmarkHistory([
      entry('a', '2026-08-01T00:00:00Z', { tokensPerSecond: 1 }),
      entry('b', '2026-09-05T00:00:00Z'),
      entry('a', '2026-09-01T00:00:00Z', { tokensPerSecond: 9 })
    ])
    expect(history.map((e) => e.cpuModel)).toEqual(['b', 'a'])
    expect(history.find((e) => e.cpuModel === 'a')?.tokensPerSecond).toBe(9)
  })

  it('caps the list at MAX_BENCHMARK_HISTORY, keeping the newest', () => {
    const many = Array.from({ length: MAX_BENCHMARK_HISTORY + 4 }, (_, i) =>
      entry(`cpu-${i}`, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`)
    )
    const capped = normalizeBenchmarkHistory(many)
    expect(capped).toHaveLength(MAX_BENCHMARK_HISTORY)
    expect(capped[0].cpuModel).toBe(`cpu-${MAX_BENCHMARK_HISTORY + 3}`)
    expect(capped.some((e) => e.cpuModel === 'cpu-0')).toBe(false)
  })

  it('preserves the given order for entries that share a timestamp (a stable pass, not a reshuffle)', () => {
    const same = '2026-09-05T00:00:00Z'
    expect(normalizeBenchmarkHistory([entry('a', same), entry('b', same)]).map((e) => e.cpuModel)).toEqual(['a', 'b'])
  })
})

describe('normalizeModelPlacement', () => {
  it('round-trips a complete record and rejects the empty object', () => {
    const p = placement()
    expect(normalizeModelPlacement(structuredClone(p))).toEqual(p)
    expect(normalizeModelPlacement({})).toBeNull()
    expect(normalizeModelPlacement('x')).toBeNull()
  })

  it('requires a model id, a known backend, a positive context and a parseable date', () => {
    for (const bad of [
      { ...placement(), modelId: '' },
      { ...placement(), modelId: 7 },
      { ...placement(), backend: 'npu' },
      { ...placement(), contextTokens: 0 },
      { ...placement(), contextTokens: -4096 },
      { ...placement(), contextTokens: 'big' },
      { ...placement(), at: 'x' }
    ]) {
      expect(normalizeModelPlacement(bad)).toBeNull()
    }
  })

  it('rejects a record filed under another model id', () => {
    expect(normalizeModelPlacement(placement(), 'qwen')).not.toBeNull()
    expect(normalizeModelPlacement(placement(), 'other')).toBeNull()
  })

  it('rejects a self-contradicting layer split, and nulls an unusable count', () => {
    expect(normalizeModelPlacement({ ...placement(), gpuLayers: 50, totalLayers: 41 })).toBeNull()
    expect(normalizeModelPlacement({ ...placement(), gpuLayers: -1 })?.gpuLayers).toBeNull()
    expect(normalizeModelPlacement({ ...placement(), totalLayers: Number.NaN })?.totalLayers).toBeNull()
  })

  it('accepts an ALL-NULL reading with valid required fields (a forced-CPU start prints none)', () => {
    const bare = placement({
      backend: 'cpu',
      gpuLayers: null,
      totalLayers: null,
      gpuModelMb: null,
      cpuModelMb: null,
      gpuKvMb: null,
      cpuKvMb: null,
      machineKey: null
    })
    expect(normalizeModelPlacement(structuredClone(bare))).toEqual(bare)
  })

  it('keeps the optional buffer fields absent when the record has none', () => {
    const p = normalizeModelPlacement(placement())!
    expect('gpuFreeAtStartMb' in p).toBe(false)
    expect('gpuComputeMb' in p).toBe(false)
    const withFree = normalizeModelPlacement({ ...placement(), gpuFreeAtStartMb: 20_000, gpuComputeMb: 'x' })!
    expect(withFree.gpuFreeAtStartMb).toBe(20_000)
    expect(withFree.gpuComputeMb).toBeNull()
  })

  it('keeps the device rows (DR2): valid rows survive, junk rows drop, absence stays absent, a non-array reads as none', () => {
    const rtx = { label: 'Vulkan1', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_822, freeMb: 2703, computeMb: 2860 }
    expect('devices' in normalizeModelPlacement(placement())!).toBe(false)
    const rows = normalizeModelPlacement({
      ...placement(),
      devices: [rtx, {}, { label: 'Vulkan0' }, { label: 'x', name: 'y', totalMb: 'lots', freeMb: -1, computeMb: null }, 'nope']
    })!
    expect(rows.devices).toEqual([rtx, { label: 'x', name: 'y', totalMb: null, freeMb: null, computeMb: null }])
    expect(normalizeModelPlacement({ ...placement(), devices: 'x' })!.devices).toEqual([])
  })
})

describe('normalizeGpuDevice / normalizeGpuProbe (P5: settings.gpuProbe)', () => {
  const rtx: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24_576, freeMb: 20_000 }

  it('a device needs a non-empty name and a finite total; id and free are repaired', () => {
    expect(normalizeGpuDevice(rtx)).toEqual(rtx)
    expect(normalizeGpuDevice({ name: 'x', totalMb: 1 })).toEqual({ id: '', name: 'x', totalMb: 1, freeMb: 0 })
    for (const junk of [null, 'x', {}, { name: '', totalMb: 1 }, { name: 'x' }, { name: 'x', totalMb: 'big' }, { name: 'x', totalMb: -1 }]) {
      expect(normalizeGpuDevice(junk)).toBeNull()
    }
  })

  it('drops junk devices and keeps the real ones; an all-junk list is an EMPTY probe, not no probe', () => {
    const probe = normalizeGpuProbe({ devices: [{}, rtx, 'x', { name: 'y', totalMb: NaN }], probedAt: '2026-09-05T00:00:00Z' })
    expect(probe).toEqual({ devices: [rtx], probedAt: '2026-09-05T00:00:00Z' })
    expect(normalizeGpuProbe({ devices: [{}, 42], probedAt: '2026-09-05T00:00:00Z' })).toEqual({ devices: [], probedAt: '2026-09-05T00:00:00Z' })
  })

  it('is null for anything without a devices array; an unparseable date reads as unknown', () => {
    for (const junk of [null, 'x', {}, { devices: 'x' }, { devices: { 0: rtx } }, []]) {
      expect(normalizeGpuProbe(junk)).toBeNull()
    }
    expect(normalizeGpuProbe({ devices: [rtx], probedAt: 'yesterday-ish' })?.probedAt).toBe(UNKNOWN_RAN_AT)
  })

  it('G3: a legacy unstamped probe stays UNSTAMPED — never acquires a key', () => {
    const legacy: GpuProbeResult = { devices: [rtx], probedAt: '2026-06-01T00:00:00Z' }
    const out = normalizeGpuProbe(legacy)!
    expect('machineKey' in out).toBe(false)
    expect(out).toEqual(legacy)
  })

  it('keeps a foreign stamp as data (the reader decides eligibility), and a malformed one as null', () => {
    const foreign = normalizeGpuProbe({ devices: [rtx], probedAt: '2026-06-01T00:00:00Z', machineKey: 'linux|x64|Other|8|16' })!
    expect(foreign.machineKey).toBe('linux|x64|Other|8|16')
    expect(normalizeGpuProbe({ devices: [], probedAt: '2026-06-01T00:00:00Z', machineKey: 42 })!.machineKey).toBeNull()
    expect(normalizeGpuProbe({ devices: [], probedAt: '2026-06-01T00:00:00Z', machineKey: null })!.machineKey).toBeNull()
  })
})

describe('normalizePlacementDevice', () => {
  it('requires the two join keys and repairs the figures', () => {
    expect(normalizePlacementDevice({ label: 'Vulkan0', name: 'Card', totalMb: 1, freeMb: 'x', computeMb: 2.5 })).toEqual({
      label: 'Vulkan0',
      name: 'Card',
      totalMb: 1,
      freeMb: null,
      computeMb: 2.5
    })
    for (const junk of [null, 'x', {}, { label: 'Vulkan0' }, { name: 'Card' }, { label: '', name: 'Card' }]) {
      expect(normalizePlacementDevice(junk)).toBeNull()
    }
  })
})

describe('normalizeModelPlacements', () => {
  it('is empty for a non-object and drops records that do not validate (L8)', () => {
    expect(normalizeModelPlacements(null)).toEqual({})
    expect(normalizeModelPlacements([placement()])).toEqual({})
    expect(normalizeModelPlacements({ m: {} })).toEqual({})
    expect(normalizeModelPlacements({ m: 'x' })).toEqual({})
  })

  it('requires the map key to be the record’s own model id', () => {
    expect(normalizeModelPlacements({ qwen: placement() })).toEqual({ qwen: placement() })
    expect(normalizeModelPlacements({ other: placement() })).toEqual({})
  })

  it('keeps the valid entries beside the invalid ones and never writes through __proto__', () => {
    const map = normalizeModelPlacements({ qwen: placement(), broken: {}, ['__proto__']: placement({ modelId: '__proto__' }) })
    expect(Object.keys(map)).toEqual(['qwen'])
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
  })
})
