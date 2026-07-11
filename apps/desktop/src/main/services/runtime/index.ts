import type { ChatDepthMode, JsonSchema, RuntimeStatus } from '../../../shared/types'

// Runtime manager (spec §7.5). Defines the swappable ModelRuntime interface so the
// mock runtime and the real llama.cpp sidecar are interchangeable behind the same
// contract. The manager owns exactly one active runtime and restarts it on model
// switch. Real runtimes MUST bind 127.0.0.1 only.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface RuntimeChatOptions {
  /** Explicit caps/sampling; when set they WIN over anything `mode` would derive. */
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * Answer-depth mode (spec §10.3). Real runtimes map it to the model's thinking
   * switch + sampling (see `requestParamsForMode` in `llama.ts`); the mock runtime
   * ignores it. Omitted = 'balanced'.
   */
  mode?: ChatDepthMode
  /**
   * Receives reasoning ("thinking") deltas, which stream SEPARATELY from the answer
   * tokens the generator yields (llama-server `--reasoning-format deepseek` puts them
   * in `delta.reasoning_content`). Live-display affordance only — reasoning is never
   * part of the yielded content and is never persisted (architecture.md "Chat & streaming").
   */
  onReasoning?: (delta: string) => void
  /**
   * Receives the completion's `finish_reason` once, when the model stops: 'stop' (EOS / a stop
   * token — a complete reply), 'length' (the reply hit the token/context ceiling and is CUT OFF),
   * or another server-defined reason. Lets the chat service flag a length-truncated answer so the
   * UI can say the reply was cut off instead of stopping mid-word silently. Never fired on a user
   * abort (an aborted request carries no final chunk). The mock runtime reports 'stop' on a clean
   * finish; a runtime that can't report one simply never calls it (callers treat that as 'stop').
   */
  onFinish?: (finishReason: string) => void
  /**
   * Grammar-constrained decoding (D55): when set, the runtime constrains the model's output to
   * this JSON Schema via llama-server's OpenAI-compatible `response_format: { type: 'json_schema' }`,
   * so the completion is GUARANTEED to be JSON matching the schema (the model cannot emit an
   * off-schema token). The bank-statement LLM categorizer is the first consumer — it constrains the
   * reply to a fixed category enum so a category is never invented. Loopback-only, offline; the mock
   * runtime ignores it. `responseSchemaName` is the schema's label llama-server echoes (cosmetic).
   */
  responseSchema?: JsonSchema
  responseSchemaName?: string
}

export interface RuntimeStartOptions {
  modelId: string
  /** Absolute path to the weight file. */
  modelPath: string
  contextTokens: number
}

export interface HealthStatus {
  healthy: boolean
  message: string
  /** Local port the runtime listens on, or null for runtimes without a server. */
  port: number | null
}

/** Which inference backend a runtime landed on (the start ladder in factory.ts). */
export type RuntimeBackend = 'gpu' | 'cpu' | 'mock'

/**
 * Backend reported for a runtime that carries no label. Only a bare `LlamaRuntime`
 * (injected directly in tests) lacks one — the production factory always returns the
 * labelled ladder runtime or the mock — and a bare LlamaRuntime with no GPU args
 * runs on the CPU.
 */
const UNLABELLED_BACKEND: RuntimeBackend = 'cpu'

/** The contract every inference backend implements (spec §9.2). */
export interface ModelRuntime {
  readonly modelId: string
  /** Backend label after start() (ladder/probe-derived); optional for bare runtimes. */
  readonly backend?: RuntimeBackend
  /** Probed GPU name when backend === 'gpu'. */
  readonly gpuName?: string | null
  start(): Promise<void>
  stop(): Promise<void>
  health(): Promise<HealthStatus>
  /** Stream assistant tokens (answer text only — reasoning goes via `onReasoning`). */
  chatStream(messages: ChatMessage[], options?: RuntimeChatOptions): AsyncGenerator<string, void, unknown>
  /**
   * The token window the runtime was launched with (llama-server's `--ctx-size`) — the
   * real budget chat/RAG assembly trims against (context-compaction record §L0). Optional:
   * a runtime that can't report one (e.g. a bare test stub) lets callers fall back to
   * `settings.contextTokens` via `effectiveContextWindow`. The three production runtimes
   * (llama, mock, ladder) all report it; it is fixed for a runtime's lifetime (the window
   * is set at start and never changes without a restart).
   */
  contextWindow?(): number
  /**
   * Whether this runtime has already streamed at least one REAL model generation since it
   * started (#39): the first generation after a model start/switch pays the one-time costs
   * (weights into memory, the long system-prompt prefill that `cache_prompt` then reuses),
   * so the Chat screen shows a calm "warming up" hint only while this is still false.
   * Flips on the first streamed chunk (answer token OR reasoning delta — either proves the
   * prefill is done). Optional: a bare test stub without it reports no `warmedUp` status
   * and the hint simply never shows. Deterministic no-model answers (routing/refusal/
   * listing) never call `chatStream`, so they leave this untouched.
   */
  warmedUp?(): boolean
}

export type RuntimeFactory = (opts: RuntimeStartOptions) => ModelRuntime

/** The CODE-3 latch refusal — content-free; auto-start logs it, users never see it. */
function shutdownError(): Error {
  return new Error('Runtime manager is shut down (the app is quitting)')
}

/**
 * Holds the single active runtime. The factory lets us swap mock → llama.cpp
 * without touching callers (the IPC layer just sees start/stop/status).
 */
export class RuntimeManager {
  private current: ModelRuntime | null = null
  private last: HealthStatus | null = null
  /**
   * Serializes every start/stop. A real GGUF start can take up to the health timeout;
   * without this, a second `start()` in that window saw `current == null`, skipped the
   * stop, and spawned a SECOND llama-server the manager never stopped (an orphan), and
   * a `stop()` during an in-flight start was a no-op the start then overrode. Queueing
   * makes those calls wait for the in-flight operation and act on its committed result.
   */
  private op: Promise<unknown> = Promise.resolve()
  /**
   * The model id whose start is currently in flight (set synchronously when `start()` is
   * called, cleared when that start settles). Surfaced via `status().startingModelId` so
   * the UI can show a disabled "Starting…" state across screen remounts, and used to make
   * `start()` idempotent — a second start for the SAME model (a double-click or a revisit
   * while the first is still loading) must not stop-and-restart the runtime.
   */
  private startingModelId: string | null = null
  /**
   * The runtime instance a start is currently bringing up INSIDE the queue (full-audit
   * 2026-07-11 CODE-2) — set by `doStart` before `next.start()`, cleared when that await
   * settles. `stop()` uses it to cancel the in-flight start directly: the queue
   * deliberately runs stop AFTER start settles (that ordering prevents orphans), but a
   * start loading a 20 GB GGUF — or walking a failing ladder for up to ~9 min of serial
   * health timeouts — used to be uncancellable, so quit and "Lock now" froze behind it.
   */
  private startingRuntime: ModelRuntime | null = null
  /**
   * Permanent shutdown latch (full-audit 2026-07-11 CODE-3), mirroring
   * `TranslationRuntime.stopped`: armed by `shutdown()` at the very top of the quit
   * teardown (`performShutdown`) and never cleared. Without it, a background auto-start
   * that spends a long pre-start window hashing a multi-GB weight (`startModelRuntime`)
   * could complete DURING the teardown and enqueue a fresh start AFTER the stop —
   * `app.exit(0)` then kills the parent mid-start and the child survives as an orphan
   * (loopback port + GBs of RAM held, especially on Windows). Once set,
   * `start()`/`forceRestart()` reject WITHOUT invoking the factory, and a start already
   * sitting in the queue refuses inside `doStart` before it can spawn.
   */
  private stopped = false

  constructor(private readonly factory: RuntimeFactory) {}

  /**
   * Arm the permanent shutdown latch (CODE-3). Synchronous and latch-only so the quit
   * teardown can set it before anything else runtime-related without disturbing the
   * queue's stop-in-progress semantics — `performShutdown` still calls `stop()` (which
   * also cancels an in-flight start, CODE-2) in its awaited sidecar-stop block.
   */
  shutdown(): void {
    this.stopped = true
  }

  /** True once `shutdown()` ran. Long pre-start work re-checks this (CODE-3). */
  isShutdown(): boolean {
    return this.stopped
  }

  /** Run `task` after every previously queued start/stop, success or failure. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.op.then(task, task)
    this.op = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async start(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // CODE-3: after shutdown() nothing may spawn — reject before the queue/factory.
    if (this.stopped) throw shutdownError()
    // Idempotent for the same model: if it is already running, or a start for it is
    // already in flight (a double-click, or a revisit to the AI Model screen before the
    // GGUF finished loading), do NOT stop-and-restart it — just resolve with the
    // current/forthcoming status once the queue drains. The old behavior spawned a
    // disruptive restart (two "Start runtime" log lines, two backend selections).
    if (this.startingModelId === opts.modelId || this.current?.modelId === opts.modelId) {
      return this.enqueue(() => Promise.resolve(this.status()))
    }
    // Set synchronously so a concurrent caller sees the in-flight model immediately.
    this.startingModelId = opts.modelId
    try {
      return await this.enqueue(() => this.doStart(opts))
    } finally {
      // Only clear if no newer start (a switch) has since claimed the slot.
      if (this.startingModelId === opts.modelId) this.startingModelId = null
    }
  }

  async stop(): Promise<void> {
    // CODE-2 (full-audit 2026-07-11): cancel an in-flight start so it settles PROMPTLY
    // instead of holding the queue for the remaining health timeouts. The queue semantics
    // stay untouched (the doStop below still runs only after the start settles and acts on
    // its committed result) — and never a bare timeout race, which would orphan the loading
    // child (report §2.3). `LadderRuntime.stop()` aborts the ladder walk and forwards to the
    // in-flight `LlamaServer.stop()`, whose exit check unblocks `waitForHealthy`.
    const starting = this.startingRuntime
    if (starting) {
      // Fire-and-forget is safe: the enqueued doStop already awaits the start's settle,
      // and the ladder's own failure path re-stops its inner runtime idempotently.
      void Promise.resolve()
        .then(() => starting.stop())
        .catch(() => undefined)
    }
    return this.enqueue(() => this.doStop())
  }

  /**
   * Crash-only restart that DELIBERATELY bypasses the same-model idempotency guard in
   * `start()` (REL-1, audit 2026-06-28). `start()` no-ops when the requested model is
   * already `this.current` — correct for a double-click or an AI-Model-screen revisit, but
   * fatal for the GPU mid-session crash auto-fallback (architecture.md GPU record §5.3): the
   * crashed `LadderRuntime` is still `this.current` (the manager never observes the child's
   * exit — it caches `this.last` at start and never re-polls), so wiring the crash restart to
   * `start(sameModel)` early-returns a stale status read, never stops-and-restarts, and leaves
   * `status()` reporting the DEAD server as running/healthy while the next chat/RAG turn routes
   * to it and fails.
   *
   * `forceRestart` instead does `doStop()` (if a runtime is live) then `doStart(opts)` inside
   * ONE enqueued op (`doStart` already stops a live `current` first), so `current`/`last` are
   * cleared atomically — no concurrent queued op can interleave between the stop and the start,
   * and `doStop` nulls `this.last` so `status()` immediately stops reporting the dead server as
   * healthy. `startingModelId` is set synchronously (exactly as `start()` does) so a concurrent
   * user `start(sameModel)` JOINS this restart via the idempotency guard rather than queueing a
   * second one. Normal `start()` idempotency is untouched — only this crash path bypasses it.
   *
   * Retry bound (no restart loop): the caller (`createGpuCrashAutoFallback`) persists
   * `gpuAutoDisabled` BEFORE invoking this, so the ladder rebuilt inside `doStart` skips rung 1
   * and lands on CPU; a later CPU crash does NOT route through `onGpuCrash` (LadderRuntime gates
   * it on `backend === 'gpu'`, factory.ts:137-139), so a GPU session auto-falls-back at most once.
   */
  async forceRestart(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // CODE-3: a crash restart racing the quit teardown must not respawn either.
    if (this.stopped) throw shutdownError()
    this.startingModelId = opts.modelId
    try {
      return await this.enqueue(() => this.doStart(opts))
    } finally {
      if (this.startingModelId === opts.modelId) this.startingModelId = null
    }
  }

  private async doStart(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // CODE-3: a start that was already IN the queue when shutdown() armed the latch
    // (e.g. enqueued behind an in-flight start/stop) must not spawn either — re-check
    // before touching anything, so the factory is never invoked past the latch.
    if (this.stopped) throw shutdownError()
    // Restart cleanly on a model switch (spec §7.5).
    if (this.current) await this.doStop()
    // Commit to `this.current`/`this.last` only on a FULLY successful start. A failed
    // start (e.g. the real sidecar's health timeout) must not leave a half-started
    // runtime as "active" — callers gate chat/RAG on `active() != null`, so a stale
    // `current` would route requests to a server that never came up. Clean up + reset.
    const next = this.factory(opts)
    // Visible to stop() so a quit/lock can cancel this start while it is in flight (CODE-2).
    this.startingRuntime = next
    try {
      await next.start()
      const health = await next.health()
      this.current = next
      this.last = health
    } catch (err) {
      try {
        await next.stop()
      } catch {
        /* best-effort cleanup; the start error is what matters */
      }
      this.current = null
      this.last = null
      throw err
    } finally {
      this.startingRuntime = null
    }
    return this.status()
  }

  private async doStop(): Promise<void> {
    if (!this.current) return
    const stopping = this.current
    this.current = null
    this.last = null
    await stopping.stop()
  }

  activeModelId(): string | null {
    return this.current?.modelId ?? null
  }

  /** The active runtime instance (used by the chat service). */
  active(): ModelRuntime | null {
    return this.current
  }

  status(): RuntimeStatus {
    const startingModelId = this.startingModelId
    if (!this.current) {
      return {
        running: false,
        modelId: null,
        port: null,
        healthy: false,
        message: startingModelId ? 'Starting' : 'Stopped',
        startingModelId
      }
    }
    return {
      running: true,
      modelId: this.current.modelId,
      port: this.last?.port ?? null,
      healthy: this.last?.healthy ?? false,
      message: this.last?.message ?? 'Running',
      backend: this.current.backend ?? UNLABELLED_BACKEND,
      gpuName: this.current.gpuName ?? null,
      // The real launched context window (§L0) — the budget chat/RAG assembly trims
      // against. Absent for a runtime that can't report one.
      contextWindow: this.current.contextWindow?.(),
      // #39: false until the FIRST real generation streams after this start (a model
      // switch/restart builds a fresh runtime instance, so it resets naturally). Absent
      // for a runtime that can't report one — the Chat warm-up hint then never shows.
      warmedUp: this.current.warmedUp?.(),
      // A start in flight for a DIFFERENT model than the running one = a switch underway.
      startingModelId: startingModelId !== this.current.modelId ? startingModelId : null
    }
  }
}
