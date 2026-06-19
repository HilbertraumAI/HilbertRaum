import type {
  ChatMessage,
  HealthStatus,
  ModelRuntime,
  RuntimeChatOptions,
  RuntimeStartOptions
} from './index'

// Mock runtime (spec decision: mock-first). Lets the whole app run with zero model
// files and zero network. health() returns ok immediately; chatStream emits a
// deterministic reply token-by-token (with a small delay) so the renderer's
// streaming + stop path is fully exercised without a real model. The real
// llama.cpp runtime swaps in behind the same interface.

/** Per-token delay (ms). Small enough to keep tests fast, slow enough to stream visibly. */
const TOKEN_DELAY_MS = 12

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

export class MockRuntime implements ModelRuntime {
  readonly modelId: string
  readonly backend = 'mock' as const
  readonly gpuName = null
  private started = false

  constructor(private readonly opts: RuntimeStartOptions) {
    this.modelId = opts.modelId
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  /** The configured context window (§L0) — the mock reports its `--ctx-size` like a real runtime. */
  contextWindow(): number {
    return this.opts.contextTokens
  }

  async health(): Promise<HealthStatus> {
    return {
      healthy: this.started,
      // No real server: the mock binds nothing, so there is no port to expose.
      port: null,
      message: this.started
        ? `Mock runtime ready for ${this.modelId} (ctx ${this.opts.contextTokens})`
        : 'Mock runtime stopped'
    }
  }

  /**
   * Stream a simulated reply one token at a time. Honours `options.signal`: when
   * the caller aborts, the generator stops promptly (the consumer keeps whatever
   * was emitted so far).
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: RuntimeChatOptions
  ): AsyncGenerator<string, void, unknown> {
    const signal = options?.signal
    for (const token of this.mockTokens(messages)) {
      if (signal?.aborted) return
      yield token
      await delay(TOKEN_DELAY_MS, signal)
    }
  }

  /** Build the deterministic mock reply, split into whitespace-preserving tokens. */
  private mockTokens(messages: ChatMessage[]): string[] {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content.trim() ?? ''
    const echo = lastUser.length > 0 ? `You said: “${lastUser}”. ` : ''
    const reply =
      `${echo}I am HilbertRaum running locally on the mock runtime for ` +
      `${this.modelId}, so this reply is simulated and fully offline. Real on-device ` +
      `answers arrive once a llama.cpp model is loaded.`
    // Keep the trailing space on each token so the stream reassembles verbatim.
    return reply.match(/\S+\s*/g) ?? [reply]
  }
}

/** Factory used by the runtime selector when no real binary/weights are available. */
export function createMockRuntime(opts: RuntimeStartOptions): MockRuntime {
  return new MockRuntime(opts)
}
