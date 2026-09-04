import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSelectingRuntimeFactory,
  createGpuCrashAutoFallback,
  createSpeculativeCrashAutoFallback,
  clearSpeculativeSuppression,
  isSpeculativeSuppressed,
  COMPATIBILITY_MODE_NOTICE,
  SPEED_UP_DISABLED_NOTICE,
  MTP_SERVER_ARGS,
  WARMUP_MAX_TOKENS,
  WARMUP_PROMPT,
  type LlamaRungOptions
} from '../../src/main/services/runtime/factory'
import {
  isNextModelLoadSuppressed,
  latestEffectiveRead,
  MIN_READ_SAMPLE_MS,
  resetEffectiveReadForTests,
  suppressNextModelLoadSample
} from '../../src/main/services/read-speed'
import type { ModelPrefetch, PrefetchOutcome } from '../../src/main/services/runtime/prefetch'
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
  /** Dev build flag + environment for the dev-only HILBERTRAUM_LLAMA_EXTRA_ARGS override. */
  isDev?: boolean
  env?: NodeJS.ProcessEnv
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
  /** #114: the fake prefetch settles 'failed' immediately (a read error). */
  prefetchFails?: boolean
}) {
  const calls: LadderCall[] = []
  const failures: string[] = []
  const selected: Array<{ kind: string; reason: string }> = []
  const crashes: Array<{ opts: RuntimeStartOptions; info: UnexpectedExitInfo }> = []
  const warmups: Array<{ event: string; detail?: string }> = []
  const chatCalls: Array<{ content: string; maxTokens?: number; mode?: string; hasSignal: boolean }> = []
  // #114: every prefetch the ladder created (recorded fake — no real file IO in this suite).
  const prefetches: Array<{ paths: string[]; aborted: boolean }> = []
  const prefetchEvents: Array<{ event: string; detail?: string }> = []
  const speculative: Array<{ event: string; detail?: string }> = []
  const specCrashes: Array<{ opts: RuntimeStartOptions; info: UnexpectedExitInfo }> = []
  let mockMade = false

  const makePrefetch = (paths: string[]): ModelPrefetch => {
    const entry = { paths, aborted: false }
    prefetches.push(entry)
    let settle!: (o: PrefetchOutcome) => void
    const done = new Promise<PrefetchOutcome>((r) => (settle = r))
    if (config.prefetchFails) settle('failed')
    return {
      done,
      abort: () => {
        entry.aborted = true
        settle('aborted')
      }
    }
  }

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
    isDev: config.isDev,
    env: config.env ?? {},
    resolveBin: () => (config.resolveBin === undefined ? '/bin/llama-server' : config.resolveBin),
    modelExists: () => true,
    makeLlama,
    makeMock,
    onSelect: (kind, _o, reason) => selected.push({ kind, reason }),
    onWarmup: (_o, event, detail) => warmups.push({ event, detail }),
    warmupTimeoutMs: config.warmupTimeoutMs,
    onPrefetch: (_o, event, detail) => prefetchEvents.push({ event, detail }),
    onSpeculative: (_o, event, detail) => speculative.push({ event, detail }),
    makePrefetch,
    gpu: {
      getGpuMode: () => config.gpuMode ?? 'auto',
      getGpuAutoDisabled: () => config.gpuAutoDisabled ?? false,
      onGpuFailure: (reason) => failures.push(reason),
      probeDevices: async () => config.probe ?? [],
      resolveCpuBin: () => (config.cpuBin === undefined ? '/bin/cpu/llama-server' : config.cpuBin),
      onGpuCrash: (o, info) => crashes.push({ opts: o, info }),
      onSpeculativeCrash: (o, info) => specCrashes.push({ opts: o, info })
    }
  })

  return {
    factory,
    calls,
    failures,
    selected,
    crashes,
    warmups,
    chatCalls,
    prefetches,
    prefetchEvents,
    speculative,
    specCrashes,
    wasMock: () => mockMade
  }
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
  it('dev build: HILBERTRAUM_LLAMA_EXTRA_ARGS is appended to the GPU rung only', async () => {
    const env = { HILBERTRAUM_LLAMA_EXTRA_ARGS: ' -ncmoe 40  -ot ple_ngram_embd=CPU -fa on ' }
    const h = ladderHarness({ probe: [RTX], isDev: true, env, failFirst: 1 })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].extraArgs).toEqual(['-ncmoe', '40', '-ot', 'ple_ngram_embd=CPU', '-fa', 'on'])
    // The forced-CPU rung is untouched: the override is for GPU placement experiments only.
    expect(h.calls[1].extraArgs).toEqual(['--device', 'none'])
  })

  it('packaged build: HILBERTRAUM_LLAMA_EXTRA_ARGS is ignored', async () => {
    const env = { HILBERTRAUM_LLAMA_EXTRA_ARGS: '-ncmoe 40' }
    const h = ladderHarness({ probe: [RTX], isDev: false, env })
    const runtime = h.factory(opts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual([])
  })

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
    // #114: the prefetch must join the CODE-2 cancel contract (recorded fake).
    const prefetches: Array<{ paths: string[]; aborted: boolean }> = []
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
      makePrefetch: (paths) => {
        const entry = { paths, aborted: false }
        prefetches.push(entry)
        return {
          done: new Promise<PrefetchOutcome>(() => {}),
          abort: () => {
            entry.aborted = true
          }
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
      prefetches,
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
    // #114: the prefetch reader joined the cancel — it must not keep the drive busy.
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].aborted).toBe(true)

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

// #108: the ladder records an honest effective-read sample (window bytes / elapsed) from
// the FIRST rung of a walk only — a later rung re-reads a file the failed attempt
// already pulled through the page cache, so its number would be inflated. `weightBytes`
// (from the caller's manifest — covers a vision model's mmproj too) stands in for a
// floor-sized on-disk fixture.
describe('effective-read sample capture (#108)', () => {
  const WEIGHT_BYTES = 6_000_000_000

  beforeEach(() => resetEffectiveReadForTests())

  it('a successful first-rung start records a model_load sample', async () => {
    const h = ladderHarness({ probe: [RTX], startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    const runtime = h.factory({
      modelId: 'm',
      modelPath: '/w.gguf',
      contextTokens: 2048,
      weightBytes: WEIGHT_BYTES
    })
    await runtime.start()

    const sample = latestEffectiveRead()
    expect(sample).not.toBeNull()
    expect(sample?.source).toBe('model_load')
    expect(sample?.modelId).toBe('m')
    expect(sample?.bytes).toBe(WEIGHT_BYTES)
    expect(sample?.ms).toBeGreaterThanOrEqual(MIN_READ_SAMPLE_MS)
  })

  it('a start that succeeds on a LATER rung records nothing (page-cache-warm re-read)', async () => {
    const h = ladderHarness({
      probe: [RTX],
      failFirst: 1,
      startDelayMs: MIN_READ_SAMPLE_MS + 60
    })
    const runtime = h.factory({
      modelId: 'm',
      modelPath: '/w.gguf',
      contextTokens: 2048,
      weightBytes: WEIGHT_BYTES
    })
    await runtime.start()

    expect(h.calls).toHaveLength(2) // rung 1 failed, rung 2 carried the start
    expect(latestEffectiveRead()).toBeNull()
  })

  it('a missing weight path with no byte total records nothing and never disturbs the start', async () => {
    const h = ladderHarness({ probe: [RTX], startDelayMs: MIN_READ_SAMPLE_MS + 60 })
    const runtime = h.factory({ modelId: 'm', modelPath: '/no/such/w.gguf', contextTokens: 2048 })
    await runtime.start()
    expect(latestEffectiveRead()).toBeNull()
  })
})

// #114: the concurrent sequential weight prefetch that rides the first rung's load
// window. Evidence for the design (measured cold-start wins, the skip rules, the
// rejection of --no-mmap) lives in prefetch.ts's header + issue #114; these tests pin
// the CONTRACT: first rung only, skip-when-just-hashed, abort at window end + on a
// CODE-2 stop, and total isolation of the start from any prefetch outcome.
describe('concurrent weight prefetch (#114)', () => {
  beforeEach(() => resetEffectiveReadForTests())

  it('rides the first rung: started with the load, aborted when the window ends', async () => {
    const h = ladderHarness({})
    await h.factory(opts).start()
    expect(h.prefetches).toHaveLength(1)
    // No weightPaths supplied → the bare modelPath is the file set.
    expect(h.prefetches[0].paths).toEqual([opts.modelPath])
    // The load finished → the window closed and the reader was told to stop.
    expect(h.prefetches[0].aborted).toBe(true)
    await until(() => h.prefetchEvents.length >= 2)
    expect(h.prefetchEvents.map((e) => e.event)).toEqual(['started', 'aborted'])
  })

  it('prefetches the full weightPaths file set (vision: GGUF + mmproj)', async () => {
    const h = ladderHarness({})
    await h.factory({ ...opts, weightPaths: ['/w.gguf', '/mm.proj'] }).start()
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].paths).toEqual(['/w.gguf', '/mm.proj'])
  })

  it('skipped when the install-state pass just hashed the weights (page-cache-warm)', async () => {
    suppressNextModelLoadSample()
    const h = ladderHarness({})
    await h.factory(opts).start()
    expect(h.prefetches).toHaveLength(0)
    expect(h.prefetchEvents.map((e) => e.event)).toEqual(['skipped'])
    // The peek did NOT consume the #108 suppression — recordModelLoadRead did, as before.
    expect(isNextModelLoadSuppressed()).toBe(false)
    expect(latestEffectiveRead()).toBeNull()
  })

  it('first rung only: a failed rung 1 does not re-prefetch on rung 2', async () => {
    const h = ladderHarness({ failFirst: 1 })
    await h.factory(opts).start()
    expect(h.calls).toHaveLength(2) // rung 1 failed, rung 2 carried the start
    expect(h.prefetches).toHaveLength(1) // …but only rung 1 got a prefetch
    expect(h.prefetches[0].aborted).toBe(true) // ended on the rung-1 failure path
  })

  it('a prefetch read failure never affects the start', async () => {
    const h = ladderHarness({ prefetchFails: true })
    await h.factory(opts).start() // resolves ready — nothing to catch
    await until(() => h.prefetchEvents.some((e) => e.event === 'failed'))
    expect(h.prefetchEvents[0]?.event).toBe('started')
    expect(h.wasMock()).toBe(false)
  })

  it('the mock fallback (no binary) never prefetches', async () => {
    const h = ladderHarness({ resolveBin: null })
    await h.factory(opts).start()
    expect(h.wasMock()).toBe(true)
    expect(h.prefetches).toHaveLength(0)
    expect(h.prefetchEvents).toHaveLength(0)
  })
})

// Issue #182 — MTP speculative decoding (rung 1a). Design record: architecture.md
// "MTP speculative decoding"; measured evidence: model-benchmarks.md §9.4 addendum.
//
// The shape under test: the manifest OPTS IN, the ladder DECIDES. Every "don't know" answers
// no, because a skipped rung costs nothing while a wrong yes costs a silent partial offload.
describe('MTP speculative decoding (#182)', () => {
  /** 1 GiB of weights ⇒ 1024 + MTP_VRAM_HEADROOM_MB = 4608 MiB of free VRAM needed. */
  const WEIGHT_BYTES = 1024 * 1024 * 1024
  const mtpOpts: RuntimeStartOptions = {
    modelId: 'qwen3.8-27b-q4',
    modelPath: '/w.gguf',
    contextTokens: 8192,
    weightBytes: WEIGHT_BYTES,
    speculativeDecoding: 'mtp'
  }
  /** Roomy enough for the weight + the draft head. */
  const BIG: GpuDevice = { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3090', totalMb: 24576, freeMb: 23000 }
  /** Holds the weight, but not the ~2 GiB draft head on top of it. */
  const TIGHT: GpuDevice = { id: 'Vulkan0', name: 'Small card', totalMb: 8192, freeMb: 4000 }

  beforeEach(() => clearSpeculativeSuppression())

  it('starts rung 1a with EXACTLY the code-owned flag pair when the machine can hold it', async () => {
    const h = ladderHarness({ probe: [BIG] })
    const runtime = h.factory(mtpOpts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual(['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'])
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS])
    expect(runtime.backend).toBe('gpu')
    expect(h.speculative).toEqual([{ event: 'enabled', detail: undefined }])
    expect(h.selected[0].reason).toContain('rung 1a')
  })

  it('adds NO rung for a model that did not opt in', async () => {
    const h = ladderHarness({ probe: [BIG] })
    await h.factory({ ...mtpOpts, speculativeDecoding: null }).start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual([])
    expect(h.speculative).toEqual([])
  })

  // The three "don't know / can't" refusals. All three SKIP the rung — no spawn, no failure,
  // no wasted multi-GB load — and land on exactly today's plain GPU start.
  it('skips the rung without spawning when the probe finds no GPU', async () => {
    const h = ladderHarness({ probe: [] })
    const runtime = h.factory(mtpOpts)
    await runtime.start()
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].extraArgs).toEqual([])
    expect(runtime.backend).toBe('cpu')
    expect(h.speculative[0].event).toBe('skipped')
    expect(h.speculative[0].detail).toContain('no GPU device')
    expect(h.failures).toEqual([]) // a skip is never a GPU fault
  })

  it('skips the rung when no single device has the weight + 3.5 GiB of free VRAM', async () => {
    const h = ladderHarness({ probe: [TIGHT] })
    await h.factory(mtpOpts).start()
    expect(h.calls[0].extraArgs).toEqual([])
    expect(h.speculative[0].event).toBe('skipped')
    expect(h.speculative[0].detail).toContain('not enough free VRAM')
  })

  it('never sums free VRAM across devices — one card must hold all of it', async () => {
    // Two cards, 4000 MiB free each: 8000 total would clear the 4608 MiB bar, one card cannot.
    const h = ladderHarness({ probe: [TIGHT, { ...TIGHT, id: 'Vulkan1' }] })
    await h.factory(mtpOpts).start()
    expect(h.calls[0].extraArgs).toEqual([])
    expect(h.speculative[0].event).toBe('skipped')
  })

  it('skips the rung when the weight size is unknown (the VRAM check cannot be made)', async () => {
    const h = ladderHarness({ probe: [BIG] })
    await h.factory({ ...mtpOpts, weightBytes: null }).start()
    expect(h.calls[0].extraArgs).toEqual([])
    expect(h.speculative[0].detail).toContain('weight size unknown')
  })

  it('is never offered at all when GPU is off or auto-disabled', async () => {
    for (const config of [{ gpuMode: 'off' as const }, { gpuAutoDisabled: true }]) {
      const h = ladderHarness({ ...config, probe: [BIG] })
      await h.factory(mtpOpts).start()
      expect(h.calls[0].extraArgs).toEqual(['--device', 'none'])
      expect(h.speculative).toEqual([])
    }
  })

  // The safety net that makes enabling this survivable: an older runtime that rejects the flag,
  // a weight without the draft head, a driver that refuses — rung 1 is next in the walk.
  it('falls through to the plain GPU rung on failure, and never blames the GPU', async () => {
    const h = ladderHarness({
      failFirst: 1,
      probe: [BIG],
      failMessage: 'error: unknown argument: --spec-type'
    })
    const runtime = h.factory(mtpOpts)
    await runtime.start()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS])
    expect(h.calls[1].extraArgs).toEqual([]) // plain rung 1 — GPU, not CPU
    expect(runtime.backend).toBe('gpu')
    // The whole point: `gpuAutoDisabled` is NOT persisted, so one bad flag cannot exile a
    // working GPU to CPU for every later start.
    expect(h.failures).toEqual([])
    expect(h.speculative.map((e) => e.event)).toEqual(['enabled', 'failed'])
    expect(h.speculative[1].detail).toContain('--spec-type')
  })

  it('latches the model off for the session after one failure — no repeat doomed load', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [BIG] })
    await h.factory(mtpOpts).start()
    expect(h.calls).toHaveLength(2)
    await h.factory(mtpOpts).start()
    expect(h.calls).toHaveLength(3) // one attempt, not two
    expect(h.calls[2].extraArgs).toEqual([])
    expect(h.speculative.at(-1)).toEqual({
      event: 'skipped',
      detail: 'latched off for this session by an earlier attempt'
    })
    // …and "Try GPU again" re-arms it (the user asking for the accelerated path back).
    clearSpeculativeSuppression()
    await h.factory(mtpOpts).start()
    expect(h.calls.at(-1)!.extraArgs).toEqual([...MTP_SERVER_ARGS])
  })

  it('keeps the forced-CPU rungs free of the flags when the whole GPU half fails', async () => {
    const h = ladderHarness({ failFirst: 2, probe: [BIG] })
    const runtime = h.factory(mtpOpts)
    await runtime.start()
    expect(h.calls).toHaveLength(3)
    expect(h.calls[0].extraArgs).toEqual([...MTP_SERVER_ARGS]) // rung 1a
    expect(h.calls[1].extraArgs).toEqual([]) // rung 1
    expect(h.calls[2].extraArgs).toEqual(['--device', 'none']) // rung 2 — exactly, nothing more
    expect(runtime.backend).toBe('cpu')
    expect(h.failures).toHaveLength(1) // only the PLAIN GPU rung's failure is a GPU fault
  })

  // A mid-session crash of rung 1a routes to the speculative handler, NOT the §5.3 GPU one:
  // the device is not the suspect, and persisting `gpuAutoDisabled` would need a Diagnostics
  // visit to undo. The model restarts on the GPU with MTP latched off.
  it('routes a mid-session crash to the speculative handler, never to the GPU auto-disable', async () => {
    const h = ladderHarness({ probe: [BIG] })
    const runtime = h.factory(mtpOpts)
    await runtime.start()
    h.calls[0].onUnexpectedExit({ exitCode: 1, exitSignal: null, stderrTail: 'vk out of memory' })
    expect(h.specCrashes).toHaveLength(1)
    expect(h.crashes).toEqual([])
    expect(isSpeculativeSuppressed(mtpOpts.modelId)).toBe(true)
    expect(h.speculative.at(-1)!.event).toBe('crashed')
    expect(h.speculative.at(-1)!.detail).toContain('vk out of memory')
  })

  it('leaves a PLAIN GPU rung crash on the §5.3 path untouched', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [BIG] })
    await h.factory(mtpOpts).start()
    h.calls[1].onUnexpectedExit({ exitCode: 1, exitSignal: null, stderrTail: 'device lost' })
    expect(h.crashes).toHaveLength(1)
    expect(h.specCrashes).toEqual([])
  })

  // Regression guard for the trap this wave walked into: the #108 read sample and the #114
  // prefetch used to be gated on `rungs[0]`, and a SKIPPED rung 1a consumes index 0 without
  // opening a load window — which would have switched both off on every machine that skips it.
  it('still prefetches and samples the load when rung 1a is skipped', async () => {
    const h = ladderHarness({ probe: [] })
    await h.factory({ ...mtpOpts, weightPaths: ['/w.gguf', '/mmproj.gguf'] }).start()
    expect(h.prefetches).toHaveLength(1)
    expect(h.prefetches[0].paths).toEqual(['/w.gguf', '/mmproj.gguf'])
    expect(h.prefetchEvents[0].event).toBe('started')
  })

  it('does NOT re-prefetch for the plain rung after rung 1a actually opened a load window', async () => {
    const h = ladderHarness({ failFirst: 1, probe: [BIG] })
    await h.factory(mtpOpts).start()
    expect(h.calls).toHaveLength(2)
    expect(h.prefetches).toHaveLength(1) // the failed attempt already warmed the page cache
  })
})

describe('createSpeculativeCrashAutoFallback (#182)', () => {
  const info: UnexpectedExitInfo = { exitCode: 1, exitSignal: null, stderrTail: 'ggml assert' }
  const startOpts: RuntimeStartOptions = { modelId: 'm', modelPath: '/w.gguf', contextTokens: 2048 }

  it('restarts once and notifies WITHOUT the compatibility-mode (slower answers) copy', async () => {
    const restarts: RuntimeStartOptions[] = []
    const notices: string[] = []
    const reasons: string[] = []
    const handler = createSpeculativeCrashAutoFallback({
      restart: async (o) => void restarts.push(o),
      onCrash: (r) => reasons.push(r),
      notify: (m) => notices.push(m)
    })
    handler(startOpts, info)
    handler(startOpts, info) // re-entrancy guard: one restart, never a loop
    await until(() => restarts.length > 0)
    expect(restarts).toHaveLength(1)
    expect(notices).toEqual([SPEED_UP_DISABLED_NOTICE])
    expect(notices[0]).not.toBe(COMPATIBILITY_MODE_NOTICE)
    expect(reasons[0]).toContain('ggml assert')
  })

  it('re-arms after a restart that throws synchronously (the M-C3 class)', async () => {
    let calls = 0
    const handler = createSpeculativeCrashAutoFallback({
      restart: () => {
        calls++
        throw new Error('sync boom')
      }
    })
    handler(startOpts, info)
    handler(startOpts, info)
    expect(calls).toBe(2)
  })
})
