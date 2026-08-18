// A hand-cranked async token source for runtime/gate/admission tests: the test controls
// exactly when tokens flow, end, or fail, and the stream honours an AbortSignal the way
// the real runtimes do (an abort ends the stream cleanly on the next wait/pull).
// Shared by runtime-manager.test.ts and local-api-admission.test.ts — the wake/abort
// race here is subtle (re-check `aborted` after every wake), so there must be ONE copy.

export interface ManualSource {
  push(value: string): void
  end(): void
  fail(error: unknown): void
  stream(signal?: AbortSignal): AsyncGenerator<string, void, unknown>
}

export function manualSource(): ManualSource {
  const queue: Array<{ value?: string; done?: boolean; error?: unknown }> = []
  let notify: (() => void) | null = null
  const wake = (): void => {
    const n = notify
    notify = null
    n?.()
  }
  return {
    push(value: string) {
      queue.push({ value })
      wake()
    },
    end() {
      queue.push({ done: true })
      wake()
    },
    fail(error: unknown) {
      queue.push({ error })
      wake()
    },
    async *stream(signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
      for (;;) {
        while (queue.length === 0) {
          if (signal?.aborted) return
          await new Promise<void>((resolve) => {
            notify = resolve
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          if (signal?.aborted) return
        }
        const item = queue.shift()!
        if (item.error) throw item.error
        if (item.done) return
        if (signal?.aborted) return
        yield item.value!
      }
    }
  }
}
