// #600 — the abort reason that marks "the user stopped or switched the chat model", as opposed to
// the Stop button, a lock/quit teardown, or a crash. When the user stops or switches the model,
// `RuntimeManager` ends the in-flight answers FIRST (its model-stop hook) with this reason, then
// kills the sidecar, so each answer ends as a clean stop instead of a dead-socket error, and the
// places that persist or restore an answer can tell this case apart:
//   - `persistAssistantMessage` stamps the partial `endedEarly: 'model'` ("Reply stopped");
//   - `withRegenerateGuard` keeps the previous complete answer instead of the partial;
//   - `withChatStream` marks a question that got no answer at all.
//
// The reason is an `AbortError`-named DOMException — what `fetch` rejects with when its signal
// aborts, and what `isAbortError` already recognises — tagged through a WeakSet so no string
// match is involved and a reason minted elsewhere can never pass for it.

const modelStopReasons = new WeakSet<object>()

/** A fresh abort reason meaning "the AI model was stopped or switched by the user". */
export function modelStopAbortReason(): DOMException {
  const reason = new DOMException('The AI model was stopped or switched.', 'AbortError')
  modelStopReasons.add(reason)
  return reason
}

/** True when `signal` was aborted because the user stopped or switched the model (#600). */
export function isModelStopAbort(signal: AbortSignal | undefined | null): boolean {
  if (!signal?.aborted) return false
  const reason: unknown = signal.reason
  return typeof reason === 'object' && reason !== null && modelStopReasons.has(reason)
}
