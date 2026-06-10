import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  parseListDevices,
  looksIntegrated,
  probeGpuDevices,
  createCachedGpuProbe
} from '../../src/main/services/runtime/gpu'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'

// Phase 15 GPU probe (gpu-support-plan §5.1/§11.1). Zero GPUs, zero binaries: the
// probe is driven entirely through the fake-spawn seam.

// The REAL output captured from the b9585 Vulkan build on the dev machine.
const RTX_3080TI_OUTPUT = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)
`

describe('parseListDevices', () => {
  it('parses the real single-GPU fixture', () => {
    expect(parseListDevices(RTX_3080TI_OUTPUT)).toEqual([
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }
    ])
  })

  it('parses multiple devices in order', () => {
    const out = parseListDevices(
      'Available devices:\n' +
        '  Vulkan0: AMD Radeon RX 6700 XT (12272 MiB, 12000 MiB free)\n' +
        '  Vulkan1: Intel(R) Iris(R) Xe Graphics (16000 MiB, 15000 MiB free)\n'
    )
    expect(out.map((d) => d.id)).toEqual(['Vulkan0', 'Vulkan1'])
    expect(out[0].name).toBe('AMD Radeon RX 6700 XT')
    expect(out[1].name).toBe('Intel(R) Iris(R) Xe Graphics')
    expect(out[1].totalMb).toBe(16000)
  })

  it('returns [] for an empty device list (CPU build / no usable Vulkan)', () => {
    expect(parseListDevices('Available devices:\n')).toEqual([])
    expect(parseListDevices('')).toEqual([])
  })

  it('ignores garbage and non-device noise', () => {
    const out = parseListDevices(
      'ggml_vulkan: Found 1 Vulkan devices:\n' +
        'random warning text\n' +
        'error: something (not a device)\n' +
        '  Vulkan0: NVIDIA GeForce RTX 3080 Ti (12300 MiB, 11511 MiB free)\n' +
        'trailing line\n'
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('Vulkan0')
  })

  it('handles odd device names (parentheses, unicode, registered marks)', () => {
    const out = parseListDevices(
      '  Vulkan0: Intel(R) UHD Graphics 630 (CFL GT2) (8000 MiB, 7000 MiB free)\n' +
        '  Metal0: Apple M2 Pro — GPU (21845 MiB, 20000 MiB free)\n'
    )
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe('Intel(R) UHD Graphics 630 (CFL GT2)')
    expect(out[1].name).toBe('Apple M2 Pro — GPU')
  })
})

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

// ---- probeGpuDevices (fake spawn — no real binary, no GPU) -------------------------

class FakeProbeChild extends EventEmitter implements ChildProcessLike {
  pid = 9
  killed = false
  stdout = new EventEmitter()
  kill(): boolean {
    this.killed = true
    return true
  }
}

function probeSpawn(behavior: (child: FakeProbeChild) => void): {
  spawn: SpawnFn
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const child = new FakeProbeChild()
    queueMicrotask(() => behavior(child))
    return child
  }
  return { spawn, calls }
}

describe('probeGpuDevices', () => {
  it('parses devices from a successful probe and passes --list-devices', async () => {
    const { spawn, calls } = probeSpawn((child) => {
      child.stdout.emit('data', RTX_3080TI_OUTPUT)
      child.emit('close', 0, null)
    })
    const devices = await probeGpuDevices('/bin/llama-server', { spawn })
    expect(devices).toHaveLength(1)
    expect(devices[0].name).toBe('NVIDIA GeForce RTX 3080 Ti')
    expect(calls[0].args).toEqual(['--list-devices'])
  })

  it('waits for stdout drained after exit ("close"), so late data is not truncated', async () => {
    // Audit fix regression: Node can fire 'exit' BEFORE pending stdout data is
    // delivered. Resolving there would parse a truncated (often empty) device list.
    const { spawn } = probeSpawn((child) => {
      child.emit('exit', 0, null) // process gone, pipe not drained yet
      child.stdout.emit('data', RTX_3080TI_OUTPUT) // late-delivered output
      child.emit('close', 0, null) // stdio drained — only NOW may we parse
    })
    const devices = await probeGpuDevices('/bin/llama-server', { spawn })
    expect(devices).toHaveLength(1)
    expect(devices[0].name).toBe('NVIDIA GeForce RTX 3080 Ti')
  })

  it('resolves [] on a non-zero exit', async () => {
    const { spawn } = probeSpawn((child) => {
      child.stdout.emit('data', 'some error-ish output')
      child.emit('close', 1, null)
    })
    expect(await probeGpuDevices('/bin/llama-server', { spawn })).toEqual([])
  })

  it('resolves [] on a spawn error (missing binary) — never rejects', async () => {
    const { spawn } = probeSpawn((child) => {
      child.emit('error', new Error('ENOENT'))
    })
    expect(await probeGpuDevices('/missing/llama-server', { spawn })).toEqual([])
  })

  it('kills a hung probe on timeout and resolves []', async () => {
    let child!: FakeProbeChild
    const spawn: SpawnFn = () => {
      child = new FakeProbeChild() // never exits on its own
      return child
    }
    const devices = await probeGpuDevices('/bin/llama-server', { spawn, timeoutMs: 20 })
    expect(devices).toEqual([])
    expect(child.killed).toBe(true)
  })

  it('resolves [] when spawn itself throws', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('spawn EACCES')
    }
    expect(await probeGpuDevices('/bin/llama-server', { spawn })).toEqual([])
  })
})

describe('createCachedGpuProbe', () => {
  function countingSpawn(): { spawn: SpawnFn; count: () => number } {
    let spawned = 0
    const spawn: SpawnFn = () => {
      spawned += 1
      const child = new FakeProbeChild()
      queueMicrotask(() => {
        child.stdout.emit('data', RTX_3080TI_OUTPUT)
        child.emit('close', 0, null)
      })
      return child
    }
    return { spawn, count: () => spawned }
  }

  it('probes once per binary per session and caches the promise', async () => {
    const { spawn, count } = countingSpawn()
    const probe = createCachedGpuProbe({ spawn })
    const [a, b] = await Promise.all([probe('/bin/x'), probe('/bin/x')])
    await probe('/bin/x')
    expect(count()).toBe(1)
    expect(a).toEqual(b)
    // A different binary is its own cache entry.
    await probe('/bin/y')
    expect(count()).toBe(2)
  })

  it('invalidate() drops the cache so the next call re-probes (Try GPU again)', async () => {
    const { spawn, count } = countingSpawn()
    const probe = createCachedGpuProbe({ spawn })
    await probe('/bin/x')
    expect(count()).toBe(1)
    probe.invalidate()
    await probe('/bin/x')
    expect(count()).toBe(2)
  })
})
