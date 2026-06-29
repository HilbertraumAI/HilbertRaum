import { describe, it, expect } from 'vitest'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  COMPATIBILITY_MODE_NOTICE,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { UnexpectedExitInfo } from '../../src/main/services/runtime/sidecar'
import type { GpuDevice } from '../../src/shared/types'

// Phase 15 start ladder (architecture.md GPU record §5.2/§11.1). Zero binaries, zero GPUs:
// everything runs through the injected makeLlama/makeMock/probe seams.

const opts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

const RTX: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3080 Ti', totalMb: 12300, freeMb: 11511 }

interface LadderCall {
  binPath: string
  extraArgs: string[]
  onUnexpectedExit: (info: UnexpectedExitInfo) => void
}

/** Build a factory whose first `failFirst` llama attempts throw at start(). */
function ladderHarness(config: {
  failFirst?: number
  /** Message thrown by the failing rungs (default `rung N failed to start`). */
  failMessage?: string
  probe?: GpuDevice[]
  gpuMode?: 'auto' | 'off'
  gpuAutoDisabled?: boolean
  cpuBin?: string | null
  resolveBin?: string | null
}) {
  const calls: LadderCall[] = []
  const failures: string[] = []
  const selected: Array<{ kind: string; reason: string }> = []
  const crashes: Array<{ opts: RuntimeStartOptions; info: UnexpectedExitInfo }> = []
  let mockMade = false

  const makeLlama = (o: RuntimeStartOptions, binPath: string, rung?: LlamaRungOptions): ModelRuntime => {
    const index = calls.length
    calls.push({ binPath, extraArgs: rung?.extraArgs ?? [], onUnexpectedExit: rung!.onUnexpectedExit })
    return {
      modelId: o.modelId,
      start: async () => {
        if (index < (config.failFirst ?? 0)) {
          throw new Error(config.failMessage ?? `rung ${index + 1} failed to start`)
        }
      },
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 5000 + index }),
      chatStream: async function* () {}
    }
  }
  const makeMock = (o: RuntimeStartOptions): ModelRuntime => {
    mockMade = true
    return {
      modelId: o.modelId,
      backend: 'mock',
      gpuName: null,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'mock', port: null }),
      chatStream: async function* () {}
    }
  }

  const factory = createSelectingRuntimeFactory({
    rootPath: '/root',
    resolveBin: () => (config.resolveBin === undefined ? '/bin/llama-server' : config.resolveBin),
    modelExists: () => true,
    makeLlama,
    makeMock,
    onSelect: (kind, _o, reason) => selected.push({ kind, reason }),
    gpu: {
      getGpuMode: () => config.gpuMode ?? 'auto',
      getGpuAutoDisabled: () => config.gpuAutoDisabled ?? false,
      onGpuFailure: (reason) => failures.push(reason),
      probeDevices: async () => config.probe ?? [],
      resolveCpuBin: () => (config.cpuBin === undefined ? '/bin/cpu/llama-server' : config.cpuBin),
      onGpuCrash: (o, info) => crashes.push({ opts: o, info })
    }
  })

  return { factory, calls, failures, selected, crashes, wasMock: () => mockMade }
}

describe('the GPU start ladder', () => {
  it('rung 1 passes NO -ngl and NO --device args; backend = gpu per a non-empty probe', async () => {
    const h = ladderHarness({ probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].binPath).toBe('/bin/llama-server')
    expect(h.calls[0].extraArgs).toEqual([]) // upstream ngl=auto + fit=on do the work
    expect(h.calls[0].extraArgs.join(' ')).not.toContain('-ngl')
    expect(runtime.backend).toBe('gpu')
    expect(runtime.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
    expect(h.failures).toEqual([])
  })

  it('rung 1 success with an EMPTY probe reads as cpu (GPU-less machine)', async () => {
    const h = ladderHarness({ probe: [] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.backend).toBe('cpu')
    expect(runtime.gpuName).toBeNull()
  })

  it('rung 1 failure → rung 2 respawns the SAME binary with exactly --device none and persists the failure', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].binPath).toBe('/bin/llama-server')
    expect(h.calls[1].extraArgs).toEqual(['--device', 'none'])
    expect(runtime.backend).toBe('cpu')
    // The failure was recorded so the NEXT start skips the GPU health timeout.
    expect(h.failures).toHaveLength(1)
    expect(h.failures[0]).toContain('rung 1 failed')
  })

  it('does NOT persist gpuAutoDisabled when rung 1 fails on a port-bind race (REL-1)', async () => {
    // A rung-1 start that died because its port was already taken is a transient TOCTOU
    // race (LlamaServer already retried once), NOT a device/driver fault. Persisting
    // gpuAutoDisabled here would disable GPU for the whole session over one port collision.
    const h = ladderHarness({
      failFirst: 1,
      probe: [RTX],
      failMessage:
        'llama-server exited before becoming healthy (code 1) — last output: error: bind: address already in use'
    })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2) // fell through to rung 2 (forced CPU)
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toEqual([]) // a port race is not a GPU signal → nothing auto-disables
  })

  it('rungs 1–2 failing land on the rung-3 pure-CPU safety-net build', async () => {
    const h = ladderHarness({ failFirst: 2, probe: [RTX] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2].binPath).toBe('/bin/cpu/llama-server')
    expect(h.calls[2].extraArgs).toEqual([])
    expect(runtime.backend).toBe('cpu')
    // Only the rung-1 (GPU) failure is persisted; rung-2's is not a GPU signal.
    expect(h.failures).toHaveLength(1)
  })

  it('all rungs failing falls back to the mock (rung 4 — never stuck)', async () => {
    const h = ladderHarness({ failFirst: 3 })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.wasMock()).toBe(true)
    expect(runtime.backend).toBe('mock')
    expect(h.selected.at(-1)?.kind).toBe('mock')
    expect(h.selected.at(-1)?.reason).toContain('all llama-server start attempts failed')
  })

  it('gpuMode "off" starts at rung 2 (--device none) and its failure is NOT a GPU failure', async () => {
    const h = ladderHarness({ gpuMode: 'off', failFirst: 1 })
    const runtime = h.factory(opts)
    await runtime.start()
    // First attempt is already the forced-CPU rung; the safety net catches its failure.
    expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
    expect(h.calls[1].binPath).toBe('/bin/cpu/llama-server')
    expect(h.failures).toEqual([]) // no GPU attempt → nothing auto-disables
    expect(runtime.backend).toBe('cpu')
  })

  it('gpuAutoDisabled skips rung 1 the same way', async () => {
    const h = ladderHarness({ gpuAutoDisabled: true })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
    expect(runtime.backend).toBe('cpu')
  })

  it('omits rung 3 when the drive ships no cpu safety net', async () => {
    const h = ladderHarness({ failFirst: 2, cpuBin: null })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2) // rungs 1 + 2 only, then mock
    expect(runtime.backend).toBe('mock')
  })

  it('still falls back to the mock at CREATION when binary or weights are absent (Phase-10 rule unchanged)', () => {
    const h = ladderHarness({ resolveBin: null })
    const runtime = h.factory(opts)
    expect(runtime.backend).toBe('mock')
    expect(h.selected[0]).toEqual({ kind: 'mock', reason: 'no llama-server binary on the drive' })
  })

  it('routes a mid-session crash to onGpuCrash ONLY when the backend landed on gpu', async () => {
    const info: UnexpectedExitInfo = { exitCode: 1, exitSignal: null, stderrTail: 'boom' }

    const gpu = ladderHarness({ probe: [RTX] })
    const gpuRuntime = gpu.factory(opts)
    await gpuRuntime.start()
    gpu.calls[0].onUnexpectedExit(info)
    expect(gpu.crashes).toHaveLength(1)
    expect(gpu.crashes[0].opts.modelId).toBe('m')

    const cpu = ladderHarness({ probe: [] }) // same start, but the probe says no GPU
    const cpuRuntime = cpu.factory(opts)
    await cpuRuntime.start()
    cpu.calls[0].onUnexpectedExit(info)
    expect(cpu.crashes).toHaveLength(0) // CPU crashes keep today's behavior
  })

  it('reports backend through RuntimeManager.status()', async () => {
    const h = ladderHarness({ probe: [RTX] })
    const mgr = new RuntimeManager(h.factory)
    const status = await mgr.start(opts)
    expect(status.backend).toBe('gpu')
    expect(status.gpuName).toBe('NVIDIA GeForce RTX 3080 Ti')
    await mgr.stop()
    expect(mgr.status().backend).toBeUndefined()
  })
})

describe('createGpuCrashAutoFallback (§5.3)', () => {
  const info: UnexpectedExitInfo = { exitCode: 134, exitSignal: null, stderrTail: 'vk error' }

  it('persists the failure, notifies with the friendly copy, and restarts ONCE', async () => {
    const restarts: RuntimeStartOptions[] = []
    const persisted: string[] = []
    const notices: string[] = []
    let release: () => void = () => {}
    const restartGate = new Promise<void>((r) => (release = r))
    const handler = createGpuCrashAutoFallback({
      restart: async (o) => {
        restarts.push(o)
        await restartGate
      },
      persistFailure: (reason) => persisted.push(reason),
      notify: (m) => notices.push(m)
    })

    handler(opts, info)
    handler(opts, info) // a second crash report while the restart is in flight → ignored
    release()
    await new Promise((r) => setTimeout(r, 0))

    expect(restarts).toHaveLength(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toContain('code 134')
    expect(persisted[0]).toContain('vk error')
    // §11.4 copy: compatibility mode, never "GPU failed" / "your hardware is bad".
    expect(notices).toEqual([COMPATIBILITY_MODE_NOTICE])
    expect(COMPATIBILITY_MODE_NOTICE).not.toMatch(/fail|crash|bad|broken/i)
  })

  it('a failed CPU restart does not throw (surfaces on the next manual start)', async () => {
    const handler = createGpuCrashAutoFallback({
      restart: async () => {
        throw new Error('restart failed')
      },
      persistFailure: () => {}
    })
    expect(() => handler(opts, info)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })

  // M-C3: a SYNCHRONOUS throw from restart() (before it returns a promise) must not
  // wedge the re-entrancy guard `restarting=true` forever — a later crash must still
  // be able to trigger a fresh fallback.
  it('re-arms after a SYNCHRONOUS throw from restart() so future crashes still fall back', () => {
    let calls = 0
    const handler = createGpuCrashAutoFallback({
      restart: () => {
        calls++
        throw new Error('sync boom') // throws before returning a promise
      },
      persistFailure: () => {}
    })
    expect(() => handler(opts, info)).not.toThrow()
    // A second, later crash report is NOT suppressed — the guard reset, so restart runs again.
    expect(() => handler(opts, info)).not.toThrow()
    expect(calls).toBe(2)
  })
})
