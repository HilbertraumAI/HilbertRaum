import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions, RuntimeTimings } from '../../src/main/services/runtime'
import type { RuntimeStatus } from '../../src/shared/types'

// The speed leg's chat runtime stub. It imports no IPC registrar, so a pure service suite can use it
// without an `electron` mock; `performance-fixture.ts` re-exports both functions for its own suites.

/** A stopped chat runtime's status (the fixture's default `runtime.status()`). */
export function stoppedStatus(): RuntimeStatus {
  return { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }
}

/** Options for `stubChatRuntime`; every default reproduces the speed-leg stub the suites shared. */
export interface StubChatRuntimeOptions {
  /** Default `'stub-chat'`. */
  modelId?: string
  /** Default `['a', 'b']`. */
  chunks?: string[]
  /** `predicted_per_second` of the final timings block. Default 20. */
  perSecond?: number
  /** `predicted_n` of the final timings block. Default: the number of chunks. */
  predictedN?: number
  /** The whole timings block, replacing `perSecond` + `predictedN`. `null`: the stream reports none. */
  timings?: RuntimeTimings | null
  /**
   * Runs between two chunks: once for the default stream, the window in which a manual "Use model"
   * lands beside a running benchmark (#393). With `rejectAfterHook`, it runs after the first chunk.
   */
  onChunk?: () => void
  /**
   * After the first chunk the stream THROWS `model stopped`: the killed sidecar, whose iterator
   * rejects rather than delivering another chunk (the realistic #334 leg S5 timing).
   */
  rejectAfterHook?: boolean
  /** `status()` of the manager half (see `StubChatRuntime`). Default `stoppedStatus`. */
  status?: () => RuntimeStatus
  /** `occupancy` of the manager half. Default: a new, idle `ModelOccupancy`. */
  occupancy?: ModelOccupancy
}

/**
 * The runtime `measureTokensPerSecond` reads, plus the three manager members the benchmark reads off
 * `ctx.runtime` (`occupancy`, `active`, `status`), so one object serves both `runBenchmark({ runtime })`
 * and `ctxWith(root, db, { runtime })`. `active()` hands out the object it is called on, so a spread
 * copy with a replaced method is what the benchmark measures.
 */
export interface StubChatRuntime extends ModelRuntime {
  occupancy: ModelOccupancy
  active(): ModelRuntime | null
  status(): RuntimeStatus
}

/**
 * A chat runtime whose stream is enough for the speed leg.
 *
 * It never sleeps: a slow reading is `perSecond`, and a wall-clock reading stubs the clock over
 * `timings: null`. To replace a method (a stream that throws at once, one that records its prompt),
 * spread it: `{ ...stubChatRuntime(), async *chatStream() { … } }`. A generation gate, the abort
 * signal and the finish reason (always `'length'`) are not modelled.
 */
export function stubChatRuntime(opts: StubChatRuntimeOptions = {}): StubChatRuntime {
  const chunks = opts.chunks ?? ['a', 'b']
  const timings =
    opts.timings === null
      ? undefined
      : (opts.timings ?? { predicted_n: opts.predictedN ?? chunks.length, predicted_per_second: opts.perSecond ?? 20 })
  const stub: StubChatRuntime = {
    modelId: opts.modelId ?? 'stub-chat',
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: '', port: null }
    },
    async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
      for (const [i, chunk] of chunks.entries()) {
        yield chunk
        if (opts.rejectAfterHook) {
          opts.onChunk?.()
          throw new Error('model stopped')
        }
        if (i < chunks.length - 1) opts.onChunk?.()
      }
      options?.onFinish?.('length', timings)
    },
    occupancy: opts.occupancy ?? new ModelOccupancy(),
    active() {
      return this
    },
    status: opts.status ?? stoppedStatus
  }
  return stub
}
