import { ModelOccupancy } from '../../src/main/services/runtime/occupancy'
import type {
  ChatMessage,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeManager,
  RuntimeStartOptions,
  RuntimeTimings
} from '../../src/main/services/runtime'
import type { RuntimeStatus } from '../../src/shared/types'

// The speed leg's chat runtime stub. It imports no IPC registrar, so a pure service suite can use it
// without an `electron` mock; `performance-fixture.ts` re-exports these for its own suites.

/** A stopped chat runtime's status (the fixture's default `runtime.status()`). */
export function stoppedStatus(): RuntimeStatus {
  return { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }
}

/** What `startModelRuntime` asks the manager around its `start`: a request with nothing to release, and no quit. */
export const START_READS: Pick<RuntimeManager, 'beginStartRequest' | 'isShutdown'> = {
  beginStartRequest: () => () => {},
  isShutdown: () => false
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
  /** The finish reason the stream reports. Default `'length'`, how a benchmark run ends. A reply a caller reads
   *  (a skill's locate pass, a document task) passes `'stop'`: `'length'` tells those it was cut off. */
  finish?: string
  /** `status()` of the manager half (see `StubChatRuntime`). Default `stoppedStatus`. */
  status?: () => RuntimeStatus
  /** `occupancy` of the manager half. Default: a new, idle `ModelOccupancy`. */
  occupancy?: ModelOccupancy
}

/**
 * The runtime `measureTokensPerSecond` reads, plus the manager members a benchmark or a start reads off
 * `ctx.runtime` (`occupancy`, `active`, `status`, `START_READS`), so one object serves both
 * `runBenchmark({ runtime })` and `ctxWith(root, db, { runtime })`. `active()` hands out the object it
 * is called on, so a spread copy with a replaced method is what the benchmark measures.
 */
export interface StubChatRuntime extends ModelRuntime, Pick<RuntimeManager, 'beginStartRequest' | 'isShutdown'> {
  occupancy: ModelOccupancy
  active(): ModelRuntime | null
  status(): RuntimeStatus
}

/**
 * A chat runtime whose stream is enough for the speed leg.
 *
 * It never sleeps: a slow reading is `perSecond`, and a wall-clock reading stubs the clock over
 * `timings: null`. To replace a method (a stream that throws at once, one that records its prompt),
 * spread it: `{ ...stubChatRuntime(), async *chatStream() { … } }`. A generation gate and the abort
 * signal are not modelled.
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
      options?.onFinish?.(opts.finish ?? 'length', timings)
    },
    occupancy: opts.occupancy ?? new ModelOccupancy(),
    active() {
      return this
    },
    status: opts.status ?? stoppedStatus,
    ...START_READS
  }
  return stub
}

/** A healthy manager's status with `modelId` committed (null: nothing is), and no start in flight. */
function committedStatus(modelId: string | null): RuntimeStatus {
  return {
    running: modelId !== null,
    modelId,
    port: null,
    healthy: modelId !== null,
    message: 'ok',
    startingModelId: null
  }
}

/** The manager reads an ask or a skill makes off `ctx.runtime`, over one running model. */
export function runningManager(runtime: ModelRuntime): Pick<RuntimeManager, 'active' | 'activeModelId' | 'status'> {
  return {
    active: () => runtime,
    activeModelId: () => runtime.modelId,
    status: () => committedStatus(runtime.modelId)
  }
}

/**
 * The runtime manager's commit surface for `startModelRuntime`: `start` commits the model it was
 * given, and `activeModelId()` follows, as the real `RuntimeManager.doStart` does (it never touches
 * `settings.activeModelId`).
 * `commit(id)` sets the model by hand, for an `over.start` that commits on its own terms. `status()`
 * says no start is in flight; a row about one passes `over.status`. `active()` is null, so no launched
 * window or backend is known; a row about those passes `over.active`. `over` wins over every member.
 * There is no gate or queue: a suite that parks a start keeps its own fake.
 */
export function committingRuntime(
  initial: string | null = null,
  over: Partial<RuntimeManager> = {}
): Pick<RuntimeManager, 'activeModelId' | 'active' | 'status' | 'start' | 'beginStartRequest' | 'isShutdown'> & {
  commit(id: string): void
} {
  let committed = initial
  return {
    activeModelId: () => committed,
    active: () => null,
    status: () => committedStatus(committed),
    ...START_READS,
    start: async (opts: RuntimeStartOptions) => {
      committed = opts.modelId
      return { running: true, modelId: committed, port: null, healthy: true, message: 'ok' }
    },
    commit: (id: string) => {
      committed = id
    },
    ...over
  }
}
