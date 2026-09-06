import { describe, it, expect } from 'vitest'
import {
  displayDevice,
  eligibleGpuProbe,
  GPU_BUMP_MIN_VRAM_MB,
  gpuUsefulForProfile,
  isUsefulDevice,
  looksIntegrated,
  primaryUsefulDevice,
  USABLE_VRAM_MB
} from '../../src/shared/gpu-rules'
import {
  GPU_BUMP_MIN_VRAM_MB as runtimeMinVram,
  gpuUsefulForProfile as runtimeGate,
  looksIntegrated as runtimeLooksIntegrated
} from '../../src/main/services/runtime/gpu'
import type { GpuDevice, GpuProbeResult } from '../../src/shared/types'

// The ONE "usable graphics card" rule (PR #303 audit M8 / N3, owner decisions G3 / G4): which
// device counts, which one is shown, whether a persisted probe may speak for this machine —
// shared by the profile bump, the memory class, the snapshot and the Performance screen. The
// `looksIntegrated` table moved here from gpu.test.ts with the implementation; the runtime
// module re-exports the same bindings, pinned below so the two can never drift.

const dev = (id: string, name: string, totalMb: number): GpuDevice => ({ id, name, totalMb, freeMb: totalMb })
const IRIS = dev('Vulkan0', 'Intel(R) Iris(R) Xe Graphics', 16_384)
const RTX = dev('Vulkan1', 'NVIDIA GeForce RTX 3090', 24_576)
const RX = dev('Vulkan0', 'AMD Radeon RX 6700 XT', 12_272)
const GTX = dev('Vulkan0', 'NVIDIA GeForce GTX 1650', 4096)

describe('looksIntegrated', () => {
  it.each([
    // Integrated → true (the bump must NOT fire)
    ['Intel(R) Iris(R) Xe Graphics', true],
    ['Intel(R) UHD Graphics 630', true],
    ['Intel(R) HD Graphics 520', true],
    ['AMD Radeon(TM) Graphics', true],
    ['AMD Radeon Vega 8', true],
    // Audit fix: names real Linux/RADV + Meteor-Lake drivers report (these used to
    // slip through and could bump the profile on shared-memory APUs).
    ['AMD Radeon Graphics (RADV REMBRANDT)', true],
    ['AMD Radeon(TM) 780M Graphics', true],
    ['AMD Radeon Vega 8 Graphics (RADV RAVEN)', true],
    ['Intel(R) Arc(TM) Graphics', true],
    // Discrete → false (eligible for the bump)
    ['NVIDIA GeForce RTX 3080 Ti', false],
    ['AMD Radeon RX 6700 XT', false],
    ['NVIDIA GeForce GTX 1660', false],
    ['AMD Radeon RX 7800 XT (RADV NAVI32)', false],
    ['Intel(R) Arc(TM) A770 Graphics', false]
  ])('%s → %s', (name, integrated) => {
    expect(looksIntegrated(name)).toBe(integrated)
  })
})

describe('isUsefulDevice — the single predicate', () => {
  it('needs BOTH 6 GiB and a discrete-looking name', () => {
    expect(isUsefulDevice(RTX)).toBe(true)
    expect(isUsefulDevice(RX)).toBe(true)
    // 16 GB of SHARED memory is not a card (M8.1).
    expect(isUsefulDevice(IRIS)).toBe(false)
    // A discrete card below the gate is not usable either.
    expect(isUsefulDevice(GTX)).toBe(false)
  })

  it('the gate is inclusive at exactly 6 GiB and is the profile bump’s constant', () => {
    expect(USABLE_VRAM_MB).toBe(6144)
    expect(GPU_BUMP_MIN_VRAM_MB).toBe(USABLE_VRAM_MB)
    expect(isUsefulDevice({ name: 'NVIDIA GeForce RTX 2060', totalMb: 6144 })).toBe(true)
    expect(isUsefulDevice({ name: 'NVIDIA GeForce RTX 2060', totalMb: 6143 })).toBe(false)
  })
})

describe('gpuUsefulForProfile — unchanged semantics (G4)', () => {
  it('answers "some device is useful"', () => {
    expect(gpuUsefulForProfile([])).toBe(false)
    expect(gpuUsefulForProfile([IRIS])).toBe(false)
    expect(gpuUsefulForProfile([GTX])).toBe(false)
    expect(gpuUsefulForProfile([RTX])).toBe(true)
    expect(gpuUsefulForProfile([IRIS, RTX])).toBe(true)
  })

  it('the runtime module re-exports these very bindings', () => {
    expect(runtimeGate).toBe(gpuUsefulForProfile)
    expect(runtimeLooksIntegrated).toBe(looksIntegrated)
    expect(runtimeMinVram).toBe(GPU_BUMP_MIN_VRAM_MB)
  })
})

describe('primaryUsefulDevice — the device every figure comes from', () => {
  it('is null with no device, an integrated-only list, or a small card', () => {
    expect(primaryUsefulDevice([])).toBeNull()
    expect(primaryUsefulDevice([IRIS])).toBeNull()
    expect(primaryUsefulDevice([GTX])).toBeNull()
  })

  it('is the discrete card, and on a hybrid [iGPU, dGPU] box the dGPU — never devices[0] (M8.2)', () => {
    expect(primaryUsefulDevice([RTX])).toBe(RTX)
    expect(primaryUsefulDevice([IRIS, RTX])).toBe(RTX)
    expect(primaryUsefulDevice([GTX, IRIS, RTX])).toBe(RTX)
  })

  it('with two usable cards the first listed wins', () => {
    expect(primaryUsefulDevice([RX, RTX])).toBe(RX)
  })
})

describe('displayDevice — what a screen may show', () => {
  it('is the useful device with useful: true', () => {
    expect(displayDevice([RTX])).toEqual({ device: RTX, useful: true })
    expect(displayDevice([IRIS, RTX])).toEqual({ device: RTX, useful: true })
  })

  it('names an integrated or small device with useful: false, so the copy never implies acceleration', () => {
    expect(displayDevice([IRIS])).toEqual({ device: IRIS, useful: false })
    expect(displayDevice([GTX])).toEqual({ device: GTX, useful: false })
    // The first listed one when none is useful — its name and memory stay one pair.
    expect(displayDevice([GTX, IRIS])).toEqual({ device: GTX, useful: false })
  })

  it('is null with no device', () => {
    expect(displayDevice([])).toBeNull()
  })
})

describe('eligibleGpuProbe — which persisted probe may speak for this machine (G3)', () => {
  const here = 'win32|x64|Intel Core i7-1260P|12|16'
  const probe = (machineKey?: string | null): GpuProbeResult =>
    machineKey === undefined
      ? { devices: [RTX], probedAt: '2026-09-05T00:00:00Z' }
      : { devices: [RTX], probedAt: '2026-09-05T00:00:00Z', machineKey }

  it('no probe → null', () => {
    expect(eligibleGpuProbe(null, here)).toBeNull()
    expect(eligibleGpuProbe(undefined, here)).toBeNull()
  })

  it('an unstamped legacy probe is eligible (unverifiable until a local refresh replaces it)', () => {
    const legacy = probe()
    expect(eligibleGpuProbe(legacy, here)).toBe(legacy)
  })

  it('a probe stamped with this machine, or with an unknown identity, is eligible', () => {
    const mine = probe(here)
    expect(eligibleGpuProbe(mine, here)).toBe(mine)
    const unknown = probe(null)
    expect(eligibleGpuProbe(unknown, here)).toBe(unknown)
  })

  it('a probe stamped with ANOTHER machine supplies nothing', () => {
    expect(eligibleGpuProbe(probe('linux|x64|Some Other CPU|32|64'), here)).toBeNull()
  })

  it('an unknown local identity cannot prove foreignness, so a stamped probe stays eligible', () => {
    const stamped = probe('linux|x64|Some Other CPU|32|64')
    expect(eligibleGpuProbe(stamped, null)).toBe(stamped)
  })
})
