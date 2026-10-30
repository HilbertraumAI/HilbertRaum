import { createSelectingRuntimeFactory, type LlamaRungOptions } from '../../src/main/services/runtime/factory'
import { createMockRuntime } from '../../src/main/services/runtime/mock'
import type { ModelPrefetch, PrefetchOutcome } from '../../src/main/services/runtime/prefetch'
import type { ModelRuntime, RuntimeStartOptions } from '../../src/main/services/runtime'
import type { UnexpectedExitInfo } from '../../src/main/services/runtime/sidecar'
import type { EngineProblem, GpuDevice } from '../../src/shared/types'

// The start-ladder harness shared by `tests/unit/runtime-ladder.test.ts` (the ladder's own
// contract) and `tests/integration/placement-wiring.test.ts` (the ladder → placement latch →
// persister wiring). Zero binaries, zero GPUs: the REAL `createSelectingRuntimeFactory` walks
// its rungs over injected makeLlama / makeMock / makePrefetch / probe seams, and every hook the
// ladder raises is recorded. The fake llama emits its per-attempt stderr from INSIDE `start()`
// through the very `rung.onStderrData` the ladder handed it, before it resolves or throws.
//
// Deliberately NOT for suites whose rungs are the real `LlamaRuntime`
// (`runtime-ladder-exit-wiring.test.ts`) or that drive the manager's own start harnesses
// (`runtime-manager.test.ts`).

export interface LadderCall {
  binPath: string
  extraArgs: string[]
  onUnexpectedExit: (info: UnexpectedExitInfo) => void
  /** The parser feed THIS attempt was handed — its identity is the one-parser-per-attempt proof. */
  onStderrData?: (text: string) => void
}

/** Build a factory whose first `failFirst` llama attempts throw at start(). */
export function ladderHarness(config: {
  failFirst?: number
  /** Message thrown by the failing rungs (default `rung N failed to start`). */
  failMessage?: string
  /** #312: per-attempt override of `failMessage` (index = spawn order across all models). */
  failMessages?: string[]
  /** #530: per-attempt ERROR to throw instead (an `EngineCannotRunError`), index = spawn order. */
  failErrors?: Array<Error | undefined>
  /** #312: fired at the top of every fake start(), before the fail check (cancel windows). */
  onStart?: (index: number) => void | Promise<void>
  /** #312: `onGpuFailure` also flips the auto-disable signal — stands in for persistGpuFailure. */
  latchGpuFailures?: boolean
  /** #312: rung 4 uses the REAL mock runtime, so its disclosed reply can be streamed. */
  realMock?: boolean
  /** The injected probe's answer. `null` is UNKNOWN (its kill-timeout, #380); a promise lets a
   *  case settle it only AFTER the fake server started. Omitted ⇒ `[]`. */
  probe?: GpuDevice[] | null | Promise<GpuDevice[] | null>
  /** #380 / T11: stderr the Nth attempt emits from inside `start()`, through the ladder's own
   *  parser feed — the order a real load prints it in. A missing entry means that attempt printed
   *  nothing. */
  stderr?: string[]
  gpuMode?: 'auto' | 'off'
  gpuAutoDisabled?: boolean
  cpuBin?: string | null
  resolveBin?: string | null
  /** The factory's weights check (default: every path exists). */
  modelExists?: (modelPath: string) => boolean
  /** The machine identity the placement record is stamped with (omitted ⇒ the record says null). */
  machineKey?: () => string | null
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
  /** #312: every `onModelLoadFailure` the ladder raised (the model blamed, not the device). */
  const modelLoadFailures: Array<{ modelId: string; reason: string }> = []
  /** #530: every `onEngineCannotRun` the ladder raised (the engine named, neither GPU nor model). */
  const engineFailures: Array<{ modelId: string; problem: EngineProblem }> = []
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
  /** #312: what `persistGpuFailure` would have written, as the ladder's next-start signal. */
  let autoDisabled = false

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
    calls.push({
      binPath,
      extraArgs: rung?.extraArgs ?? [],
      onUnexpectedExit: rung!.onUnexpectedExit,
      onStderrData: rung?.onStderrData
    })
    return {
      modelId: o.modelId,
      start: async () => {
        const stderr = config.stderr?.[index]
        if (stderr != null) rung?.onStderrData?.(stderr)
        await config.onStart?.(index)
        if (index < (config.failFirst ?? 0)) {
          const custom = config.failErrors?.[index]
          if (custom) throw custom
          throw new Error(
            config.failMessages?.[index] ?? config.failMessage ?? `rung ${index + 1} failed to start`
          )
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
    if (config.realMock) return createMockRuntime(o)
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
    machineKey: config.machineKey,
    resolveBin: () => (config.resolveBin === undefined ? '/bin/llama-server' : config.resolveBin),
    modelExists: config.modelExists ?? (() => true),
    makeLlama,
    makeMock,
    onSelect: (kind, _o, reason) => selected.push({ kind, reason }),
    onWarmup: (_o, event, detail) => warmups.push({ event, detail }),
    warmupTimeoutMs: config.warmupTimeoutMs,
    onPrefetch: (_o, event, detail) => prefetchEvents.push({ event, detail }),
    onSpeculative: (_o, event, detail) => speculative.push({ event, detail }),
    onModelLoadFailure: (o, reason) => modelLoadFailures.push({ modelId: o.modelId, reason }),
    onEngineCannotRun: (o, problem) => engineFailures.push({ modelId: o.modelId, problem }),
    makePrefetch,
    gpu: {
      getGpuMode: () => config.gpuMode ?? 'auto',
      getGpuAutoDisabled: () => (config.gpuAutoDisabled ?? false) || autoDisabled,
      onGpuFailure: (reason) => {
        failures.push(reason)
        if (config.latchGpuFailures) autoDisabled = true
      },
      // `?? []` would turn a deliberate `null` (UNKNOWN, #380) back into "no device".
      probeDevices: async () => (config.probe === undefined ? [] : await config.probe),
      resolveCpuBin: () => (config.cpuBin === undefined ? '/bin/cpu/llama-server' : config.cpuBin),
      onGpuCrash: (o, info) => crashes.push({ opts: o, info }),
      onSpeculativeCrash: (o, info) => specCrashes.push({ opts: o, info })
    }
  })

  return {
    factory,
    calls,
    failures,
    modelLoadFailures,
    engineFailures,
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

/** A promise plus its resolver — lets a case settle an injected answer at a chosen moment. */
export { deferred } from './deferred'
