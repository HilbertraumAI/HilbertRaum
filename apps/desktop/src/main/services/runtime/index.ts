import type { RuntimeStatus } from '../../../shared/types'

// Runtime manager (spec §7.5). Defines the swappable ModelRuntime interface so the
// mock runtime (Phase 2/3) and the real llama.cpp sidecar (Phase 10) are
// interchangeable behind the same contract. The manager owns exactly one active
// runtime and restarts it on model switch. Real runtimes MUST bind 127.0.0.1 only.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface RuntimeChatOptions {
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
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

/** The contract every inference backend implements (spec §9.2). */
export interface ModelRuntime {
  readonly modelId: string
  start(): Promise<void>
  stop(): Promise<void>
  health(): Promise<HealthStatus>
  /** Stream assistant tokens. Full streaming semantics land in Phase 3. */
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

  constructor(private readonly factory: RuntimeFactory) {}

  async start(opts: RuntimeStartOptions): Promise<RuntimeStatus> {
    // Restart cleanly on a model switch (spec §7.5).
    if (this.current) await this.stop()
    this.current = this.factory(opts)
    await this.current.start()
    this.last = await this.current.health()
    return this.status()
  }

  async stop(): Promise<void> {
    if (!this.current) return
    await this.current.stop()
    this.current = null
    this.last = null
  }

  activeModelId(): string | null {
    return this.current?.modelId ?? null
  }

  /** The active runtime instance (used by the chat service in Phase 3). */
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
      message: this.last?.message ?? 'Running'
    }
  }
}
