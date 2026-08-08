import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  COMPATIBILITY_MODE_NOTICE,
  WARMUP_MAX_TOKENS,
  WARMUP_PROMPT,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import {
  latestEffectiveRead,
  MIN_READ_SAMPLE_BYTES,
  MIN_READ_SAMPLE_MS,
  resetEffectiveReadForTests
} from '../../src/main/services/read-speed'
import { RuntimeManager } from '../../src/main/services/runtime'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { UnexpectedExitInfo } from '../../src/main/services/runtime/sidecar'
import type { GpuDevice } from '../../src/shared/types'

// Phase 15 start ladder (architecture.md GPU record §5.2). Zero binaries, zero GPUs:
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
  /** Tokens the fake llama runtime streams per chatStream call (default none). */
  tokens?: string[]
  /** Reasoning delta the fake fires via options.onReasoning before any token (#39 deep mode). */
  reasoningDelta?: string
  /** #109: fired at the top of every chatStream call (observe ordering, e.g. vs labeling). */
  onChat?: () => void
  /** #109: chatStream awaits this before streaming — holds the warm-up window open. */
  chatGate?: Promise<void>
  /** #109: chatStream throws this after the gate — warm-up failure/cancel paths. */
  chatError?: Error
  /** #109: chatStream never streams and rejects only when options.signal aborts (cap expiry). */
  chatHangsUntilAbort?: boolean
  /** #109 cap override forwarded to the factory (avoid real 90 s waits in tests). */
  warmupTimeoutMs?: number
  /** #108: successful starts await this long, so the load window passes the sample floor. */
  startDelayMs?: number
}) {
  const calls: LadderCall[] = []
  const failures: string[] = []
  const selected: Array<{ kind: string; reason: string }> = []
  const crashes: Array<{ opts: RuntimeStartOptions; info: UnexpectedExitInfo }> = []
  const warmups: Array<{ event: string; detail?: string }> = []
  const chatCalls: Array<{ content: string; maxTokens?: number; mode?: string; hasSignal: boolean }> = []
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
        if (config.startDelayMs) await new Promise((r) => setTimeout(r, config.startDelayMs))
      },
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 5000 + index }),
      chatStream: async function* (messages, options) {
        chatCalls.push({
          content: messages[messages.length - 1]?.content ?? '',
          maxTokens: options?.maxTokens,
          mode: options?.mode,
          hasSignal: options?.signal != null
        })
        config.onChat?.()
        if (config.chatHangsUntilAbort) {
          await new Promise<never>((_resolve, reject) => {
            const abort = (): void => reject(abortError())
            if (options?.signal?.aborted) abort()
            else options?.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        if (config.chatGate) await config.chatGate
        if (config.chatError) throw config.chatError
        if (config.reasoningDelta) options?.onReasoning?.(config.reasoningDelta)
        for (const tok of config.tokens ?? []) yield tok
      }
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
    onWarmup: (_o, event, detail) => warmups.push({ event, detail }),
    warmupTimeoutMs: config.warmupTimeoutMs,
    gpu: {
      getGpuMode: () => config.gpuMode ?? 'auto',
      getGpuAutoDisabled: () => config.gpuAutoDisabled ?? false,
      onGpuFailure: (reason) => failures.push(reason),
      probeDevices: async () => config.probe ?? [],
      resolveCpuBin: () => (config.cpuBin === undefined ? '/bin/cpu/llama-server' : config.cpuBin),
      onGpuCrash: (o, info) => crashes.push({ opts: o, info })
    }
  })

  return { factory, calls, failures, selected, crashes, warmups, chatCalls, wasMock: () => mockMade }
}

/** An `AbortError`-named rejection — what a signal-aborted fetch/stream read raises in prod. */
function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** Resolve once `cond` holds (micro/macro-task polling; injected budgets keep this fast). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error('condition not reached')
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

// CODE-2 (full-audit 2026-07-11): stop() during the ladder walk CANCELS the start — the walk
// aborts between rungs instead of paying the remaining rungs' health timeouts, the in-flight
// rung's runtime is stopped directly (which unblocks a real `waitForHealthy` via its exit
// check), a killed attempt is never persisted as a GPU fault, and the rung-4 mock is NOT
// started for a cancelled start (it would commit a runtime the queued stop must then undo).
describe('ladder start cancellation (full-audit 2026-07-11 CODE-2)', () => {
  function cancellableHarness() {
    const failures: string[] = []
    const rungStops: number[] = []
    let mockMade = false
    let rungStarts = 0
    let failInFlight: (err: Error) => void = () => {
      throw new Error('rung start not in flight yet')
    }
    const makeLlama = (o: RuntimeStartOptions): ModelRuntime => {
      const index = rungStarts++
      return {
        modelId: o.modelId,
        start: () =>
          new Promise<void>((_resolve, reject) => {
            failInFlight = reject
          }),
        stop: async () => {
          rungStops.push(index)
        },
        health: async () => ({ healthy: true, message: '', port: 1 }),
        chatStream: async function* () {}
      }
    }
    const factory = createSelectingRuntimeFactory({
      rootPath: '/root',
      resolveBin: () => '/bin/llama-server',
      modelExists: () => true,
      makeLlama,
      makeMock: (o) => {
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
      },
      gpu: {
        probeDevices: async () => [],
        onGpuFailure: (reason) => failures.push(reason),
        resolveCpuBin: () => '/bin/cpu/llama-server'
      }
    })
    return {
      runtime: factory(opts),
      failures,
      rungStops,
      wasMock: () => mockMade,
      rungStartCount: () => rungStarts,
      failInFlight: (err: Error) => failInFlight(err)
    }
  }

  it('stop() mid-rung aborts the walk: rung stopped, no next rung, no mock, no gpuAutoDisabled', async () => {
    const h = cancellableHarness()
    const startP = h.runtime.start()
    startP.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 0)) // rung 1's start() is now in flight

    const stopP = h.runtime.stop() // sets the cancel flag + forwards stop to the in-flight rung
    await stopP
    expect(h.rungStops).toContain(0) // the loading rung's runtime WAS stopped (kill reached it)

    // The killed child's start() rejects (in prod: waitForHealthy's exit-check throw)…
    h.failInFlight(new Error('llama-server exited before becoming healthy (code 0)'))
    await expect(startP).rejects.toThrow(/cancelled/i)

    // …and the walk aborted rather than falling through the remaining rungs.
    expect(h.rungStartCount()).toBe(1) // rung 2 / rung 3 never attempted
    expect(h.wasMock()).toBe(false) // no mock fallback for a cancelled start
    expect(h.failures).toEqual([]) // a killed rung-1 attempt is NOT a GPU fault
  })

  it('a stop() BEFORE start() aborts the walk without ever invoking a rung', async () => {
    const h = cancellableHarness()
    await h.runtime.stop() // e.g. quit lands between factory() and the queued start
    await expect(h.runtime.start()).rejects.toThrow(/cancelled/i)
    expect(h.rungStartCount()).toBe(0)
    expect(h.wasMock()).toBe(false)
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

// #39: warm-up tracking. The ladder runtime reports `warmedUp() === false` until the FIRST
// real generation streams a chunk after start() — the Chat screen shows its calm "the first
// answer takes a little longer" hint only in that state. A model switch builds a fresh
// LadderRuntime, so the flag resets naturally. Deterministic no-model answers (routing/
// refusal/listing) never call chatStream and therefore never mark the runtime warm.
describe('warm-up tracking (#39)', () => {
  const chat = [{ role: 'user' as const, content: 'hi' }]

  it('is cold after start, flips on the first streamed token, and RuntimeManager.status() carries it', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['Hello', ' world'] })
    const manager = new RuntimeManager(h.factory)
    await manager.start(opts)
    const runtime = manager.active()!
    expect(runtime.warmedUp?.()).toBe(false)
    expect(manager.status().warmedUp).toBe(false)

    // Consume only the FIRST token (then early-exit): one chunk is proof the prefill is done.
    for await (const _tok of runtime.chatStream(chat)) break
    expect(runtime.warmedUp?.()).toBe(true)
    expect(manager.status().warmedUp).toBe(true)
  })

  it('a Deep-mode reasoning delta (before any answer token) also marks the runtime warm', async () => {
    // tokens: [] — the generation "streams" only reasoning, which equally proves the prefill ran.
    const h = ladderHarness({ probe: [RTX], tokens: [], reasoningDelta: 'thinking…' })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(runtime.warmedUp?.()).toBe(false)

    const seen: string[] = []
    for await (const _tok of runtime.chatStream(chat, { onReasoning: (d) => seen.push(d) })) {
      /* no answer tokens */
    }
    expect(seen).toEqual(['thinking…'])
    expect(runtime.warmedUp?.()).toBe(true)
  })

  it('the wrapped stream still forwards reasoning deltas to the caller unchanged', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['a', 'b'], reasoningDelta: 'r1' })
    const runtime = h.factory(opts)
    await runtime.start()
    const reasoning: string[] = []
    const tokens: string[] = []
    for await (const tok of runtime.chatStream(chat, { onReasoning: (d) => reasoning.push(d) })) {
      tokens.push(tok)
    }
    expect(tokens).toEqual(['a', 'b'])
    expect(reasoning).toEqual(['r1'])
  })

  it('a model switch resets warm-up: the fresh runtime instance is cold again', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['x'] })
    const manager = new RuntimeManager(h.factory)
    await manager.start(opts)
    for await (const _tok of manager.active()!.chatStream(chat)) break
    expect(manager.status().warmedUp).toBe(true)

    await manager.start({ ...opts, modelId: 'm2' })
    expect(manager.status().warmedUp).toBe(false)
  })

  it('a generation that streams NOTHING leaves the runtime cold (an aborted prefill pays again)', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: [] })
    const runtime = h.factory(opts)
    await runtime.start()
    for await (const _tok of runtime.chatStream(chat)) {
      /* zero chunks */
    }
    expect(runtime.warmedUp?.()).toBe(false)
  })
})

// #109: the hidden warm-up generation. After a real rung turns healthy (and its backend
// label is set), start() runs one tiny content-free generation against the INNER runtime
// and discards the output, so "ready" only reports once the one-time prefill/graph
// warm-up cost is paid. The #39 `served` flag deliberately does NOT flip — the real first
// prompt still pays the full system-prompt prefill (no shared cache_prompt prefix), so
// the warm-up hint stays armed as a safety net.
describe('hidden warm-up generation (#109)', () => {
  it('runs AFTER backend labeling on the winning rung and completes BEFORE start() resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const backendsAtWarmup: string[] = []
    let ladder: ModelRuntime
    const h = ladderHarness({
      probe: [RTX],
      chatGate: gate,
      onChat: () => backendsAtWarmup.push(ladder.backend ?? 'unset')
    })
    ladder = h.factory(opts)
    let started = false
    const startP = ladder.start().then(() => {
      started = true
    })

    await until(() => h.chatCalls.length === 1)
    // The label was already set when the warm-up fired — a GPU crash inside this window
    // routes through the §5.3 onGpuCrash auto-fallback (gated on backend === 'gpu').
    expect(backendsAtWarmup).toEqual(['gpu'])
    // …and the "started via rung" selection was logged before the warm-up window.
    expect(h.selected.at(-1)?.reason).toContain('rung 1')
    expect(started).toBe(false) // ready is NOT reported while the warm-up is still running

    release()
    await startP
    expect(started).toBe(true)
    expect(h.warmups).toEqual([{ event: 'done', detail: undefined }])
  })

  it('the request is content-free, thinking-off (no mode), tiny-capped, abortable — and leaves #39 cold', async () => {
    const h = ladderHarness({ probe: [RTX], tokens: ['warm', 'up'] })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.chatCalls).toHaveLength(1)
    expect(h.chatCalls[0]).toEqual({
      content: WARMUP_PROMPT,
      maxTokens: WARMUP_MAX_TOKENS,
      mode: undefined, // omitted = 'balanced' → enable_thinking: false (requestParamsForMode)
      hasSignal: true // the cap can abort it
    })
    expect(WARMUP_MAX_TOKENS).toBeLessThanOrEqual(8)
    // The warm-up called inner.chatStream directly: the #39 served flag did NOT flip, so
    // the warm-up hint stays armed for the real first prompt (its full-prefill safety net).
    expect(runtime.warmedUp?.()).toBe(false)
  })

  it('the rung-4 mock never warms up (zero-assets starts stay instant)', async () => {
    // All real rungs fail → mock commit: no chatStream call is ever made.
    const allFail = ladderHarness({ failFirst: 3 })
    const mockRuntime = allFail.factory(opts)
    await mockRuntime.start()
    expect(mockRuntime.backend).toBe('mock')
    expect(allFail.chatCalls).toHaveLength(0)
    expect(allFail.warmups).toEqual([])

    // No binary on the drive → the mock is returned at creation: same guarantee.
    const noBin = ladderHarness({ resolveBin: null })
    const direct = noBin.factory(opts)
    await direct.start()
    expect(noBin.chatCalls).toHaveLength(0)
  })

  it('a warm-up failure that is NOT a cancel never fails the start (the server IS healthy)', async () => {
    const h = ladderHarness({ probe: [RTX], chatError: new Error('slot busy') })
    const runtime = h.factory(opts)
    await runtime.start() // resolves despite the failed warm-up
    expect(runtime.backend).toBe('gpu')
    expect(h.warmups).toEqual([{ event: 'failed', detail: 'slot busy' }])
    // Not a rung failure: nothing persisted gpuAutoDisabled, no fallback walk, no mock.
    expect(h.failures).toEqual([])
    expect(h.calls).toHaveLength(1)
    expect(h.wasMock()).toBe(false)
  })

  it('cap expiry aborts the warm-up request and proceeds to ready (never doubles the start)', async () => {
    const h = ladderHarness({ probe: [RTX], chatHangsUntilAbort: true, warmupTimeoutMs: 25 })
    const runtime = h.factory(opts)
    await runtime.start() // a pathological warm-up cannot hold the start hostage
    expect(runtime.backend).toBe('gpu')
    expect(h.warmups).toHaveLength(1)
    expect(h.warmups[0].event).toBe('timeout')
    expect(h.chatCalls[0].hasSignal).toBe(true)
  })

  it('stop() during the warm-up window settles as CANCELLED: no rung walk, no mock, no GPU fault', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // The killed server makes the warm-up stream error — model the same shape here.
    const h = ladderHarness({ probe: [RTX], chatGate: gate, chatError: new Error('socket closed') })
    const runtime = h.factory(opts)
    const startP = runtime.start()
    startP.catch(() => undefined)
    await until(() => h.chatCalls.length === 1)

    await runtime.stop() // quit / "Lock now" / manual stop lands mid-warm-up
    release()
    await expect(startP).rejects.toThrow(/cancelled/i)

    expect(h.calls).toHaveLength(1) // the walk aborted — rung 2/3 never attempted
    expect(h.wasMock()).toBe(false) // no mock commit for a cancelled start
    expect(h.failures).toEqual([]) // a cancel is not a GPU fault
    expect(h.warmups).toEqual([]) // …and is not logged as a warm-up fault either
  })

  it('a warm-up that completes cleanly despite a racing stop() still settles as CANCELLED', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = ladderHarness({ probe: [RTX], chatGate: gate, tokens: ['x'] })
    const runtime = h.factory(opts)
    const startP = runtime.start()
    startP.catch(() => undefined)
    await until(() => h.chatCalls.length === 1)

    await runtime.stop()
    release() // the stream finishes normally — the cancel must STILL win over ready
    await expect(startP).rejects.toThrow(/cancelled/i)
    expect(h.wasMock()).toBe(false)
  })

  it('RuntimeManager.status() stays "Starting" through the warm-up window; ready reports warmedUp=false', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = ladderHarness({ probe: [RTX], chatGate: gate })
    const mgr = new RuntimeManager(h.factory)
    const startP = mgr.start(opts)
    await until(() => h.chatCalls.length === 1)

    // The server is already healthy, but the user-facing state is still "Starting" — that
    // is the whole point: ready means warmed.
    expect(mgr.status().running).toBe(false)
    expect(mgr.status().message).toBe('Starting')
    expect(mgr.status().startingModelId).toBe('m')

    release()
    const status = await startP
    expect(status.running).toBe(true)
    expect(status.healthy).toBe(true)
    expect(status.backend).toBe('gpu')
    expect(status.warmedUp).toBe(false) // the #39 hint stays armed as the safety net
  })

  it('manager stop() during the warm-up settles promptly; the CODE-3 shutdown latch is respected', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const h = ladderHarness({ probe: [RTX], chatGate: gate, chatError: new Error('socket closed') })
    const mgr = new RuntimeManager(h.factory)
    const startP = mgr.start(opts)
    startP.catch(() => undefined)
    await until(() => h.chatCalls.length === 1)

    mgr.shutdown() // quit teardown arms the latch first…
    const stopP = mgr.stop() // …then stops; the cancel reaches the warm-up window
    release()
    await stopP
    await expect(startP).rejects.toThrow(/cancelled/i)

    expect(mgr.active()).toBeNull() // never committed
    expect(mgr.status().running).toBe(false)
    // The latch holds: a late auto-start cannot spawn a fresh warm-up/runtime.
    await expect(mgr.start(opts)).rejects.toThrow(/shut down/i)
    expect(h.calls).toHaveLength(1)
  })
})

// #108: the ladder records an honest effective-read sample (file size / elapsed) from the
// FIRST rung attempt of a walk only — a later rung re-reads a file the failed attempt
// already pulled through the page cache, so its number would be inflated.
describe('effective-read sample capture (#108)', () => {
  let weightFile = ''

  beforeAll(() => {
    // A real file above the sample floor; the ladder's recorder stats it itself.
    const dir = mkdtempSync(join(tmpdir(), 'hr-ladder-read-'))
    weightFile = join(dir, 'weights.gguf')
    writeFileSync(weightFile, Buffer.alloc(MIN_READ_SAMPLE_BYTES))
  })

  beforeEach(() => resetEffectiveReadForTests())

  it('a successful first-rung start records a model_load sample', async () => {
    const h = ladderHarness({ probe: [RTX], startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    const runtime = h.factory({ modelId: 'm', modelPath: weightFile, contextTokens: 2048 })
    await runtime.start()

    const sample = latestEffectiveRead()
    expect(sample).not.toBeNull()
    expect(sample?.source).toBe('model_load')
    expect(sample?.modelId).toBe('m')
    expect(sample?.bytes).toBe(MIN_READ_SAMPLE_BYTES)
    expect(sample?.ms).toBeGreaterThanOrEqual(MIN_READ_SAMPLE_MS)
  })

  it('a start that succeeds on a LATER rung records nothing (page-cache-warm re-read)', async () => {
    const h = ladderHarness({
      probe: [RTX],
      failFirst: 1,
      startDelayMs: MIN_READ_SAMPLE_MS + 60
    })
    const runtime = h.factory({ modelId: 'm', modelPath: weightFile, contextTokens: 2048 })
    await runtime.start()

    expect(h.calls).toHaveLength(2) // rung 1 failed, rung 2 carried the start
    expect(latestEffectiveRead()).toBeNull()
  })

  it('a missing weight path records nothing and never disturbs the start', async () => {
    const h = ladderHarness({ probe: [RTX], startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    const runtime = h.factory({ modelId: 'm', modelPath: '/no/such/w.gguf', contextTokens: 2048 })
    await runtime.start()
    expect(latestEffectiveRead()).toBeNull()
  })
})
