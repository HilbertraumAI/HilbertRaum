import type { ChatDepthMode, RuntimeStatus } from '../../../shared/types'

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
}

export type RuntimeFactory = (opts: RuntimeStartOptions) => ModelRuntime

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

  constructor(private readonly factory: RuntimeFactory) {}

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
    return this.enqueue(() => this.doStart(opts))
  }

  async stop(): Promise<void> {
    return this.enqueue(() => this.doStop())
  }

  private async doStart(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // Restart cleanly on a model switch (spec §7.5).
    if (this.current) await this.doStop()
    // Commit to `this.current`/`this.last` only on a FULLY successful start. A failed
    // start (e.g. the real sidecar's health timeout) must not leave a half-started
    // runtime as "active" — callers gate chat/RAG on `active() != null`, so a stale
    // `current` would route requests to a server that never came up. Clean up + reset.
    const next = this.factory(opts)
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
    if (!this.current) {
      return { running: false, modelId: null, port: null, healthy: false, message: 'Stopped' }
    }
    return {
      running: true,
      modelId: this.current.modelId,
      port: this.last?.port ?? null,
      healthy: this.last?.healthy ?? false,
      message: this.last?.message ?? 'Running',
      backend: this.current.backend ?? UNLABELLED_BACKEND,
      gpuName: this.current.gpuName ?? null
    }
  }
}
