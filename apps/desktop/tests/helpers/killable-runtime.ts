// A fake ModelRuntime that behaves like the llama-server sidecar under a KILL — the shape the teardown
// suites (#600 model stop, #606 lock / quit / model stop under a skill run or the benchmark) depend
// on. Pure: no electron import. One copy, because the point is the exact kill-versus-abort contract.
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

/**
 * Streams `tokens`, then parks on the next read and calls `onParked`. `stop()` kills it: the pending
 * read REJECTS with undici's `TypeError: terminated` — measured on Windows (Electron 43.7.7, undici
 * 7.29.1), and not an abort, so a caller whose own signal is still live takes its failure path. If the
 * caller's signal aborts first, the read ends CLEANLY instead, as `readChatSSE` does on an abort.
 * `signals` collects the signal of every request (a request without one is not recorded).
 */
export function killableRuntime(o: {
  modelId?: string
  tokens?: readonly string[]
  onParked: () => void
  signals?: AbortSignal[]
}): ModelRuntime {
  let kill: (() => void) | null = null
  return {
    modelId: o.modelId ?? 'mock',
    async start() {},
    async stop() {
      kill?.()
    },
    contextWindow: () => 4096,
    async health() {
      return { healthy: true, port: null, message: 'ok' }
    },
    async *chatStream(_messages: ChatMessage[], options?: RuntimeChatOptions) {
      if (options?.signal) o.signals?.push(options.signal)
      for (const t of o.tokens ?? []) yield t
      if (options?.signal?.aborted) return // an abort before the read ends it at once, like the reader
      await new Promise<void>((resolve, reject) => {
        kill = () => reject(new TypeError('terminated'))
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        o.onParked()
      })
    }
  }
}
