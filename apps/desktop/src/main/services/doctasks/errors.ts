// Typed doc-task errors (issue #41).

/**
 * A model call was rejected because the assembled prompt exceeds the LAUNCHED context
 * window (llama-server `exceed_context_size_error`, HTTP 400). `DocTaskManager.generate`
 * maps the raw runtime error to this class so a yielding build can ADAPT — halve its
 * packing budget and retry (tree-build.ts) — instead of failing the whole task on the
 * first over-window group (issue #41: the words→tokens estimate can undershoot for
 * table/number-heavy documents). The message carries the same friendly
 * `main.model.contextExceeded` copy, so any handler that does NOT retry keeps today's
 * behavior: `isFriendlyTaskError` matches by message and passes it to the renderer.
 */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextOverflowError'
  }
}
