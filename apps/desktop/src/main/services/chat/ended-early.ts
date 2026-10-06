import type { EndedEarly } from '../../../shared/types'

// #600 / #612 — the abort reasons that say WHY an answer ended before it was finished. Four things
// abort an in-flight answer, and each mints its own reason:
//   - 'model' — the user stopped or switched the chat model (`RuntimeManager`'s model-stop hook,
//     `ipc/model-stop.ts`), which ends the answers FIRST and then kills the sidecar (#600);
//   - 'user'  — the chat's own Stop button (`chat:stop`, `registerChatIpc.ts`) (#612);
//   - 'lock'  — "Lock now" and quit, which end every answer before they stop the sidecars and
//     re-encrypt the workspace (`runLockTeardown`, `performShutdown`) (#612).
// A crash mints none: it is not an abort, and its partial is dropped (F-02).
//
// The places that persist or restore an answer read the cause back from the turn's signal:
//   - `persistAssistantMessage` stamps the partial `endedEarly: <cause>` ("Reply stopped");
//   - `withRegenerateGuard` keeps the previous complete answer for 'model' and 'lock' (the user acted
//     on the model or the workspace, not on the answer), and the partial for 'user';
//   - the same guard marks a question that got no answer at all ("Not answered").
// The first abort wins: a lock after a Stop leaves the turn 'user', and lock's own `runtime.stop()`
// fires the model-stop hook against turns that are already aborted, which changes nothing.
//
// Each reason is an `AbortError`-named DOMException — what `fetch` rejects with when its signal
// aborts, and what `isAbortError` already recognises — tagged through a WeakMap, so no string match
// is involved and a reason minted elsewhere (a bare `controller.abort()`) carries no cause.

const causes = new WeakMap<object, EndedEarly>()

const MESSAGES: Record<EndedEarly, string> = {
  model: 'The AI model was stopped or switched.',
  user: 'The answer was stopped.',
  lock: 'The workspace was locked or the app was closed.'
}

/** A fresh abort reason that records why the answer ended early. */
export function endedEarlyAbortReason(cause: EndedEarly): DOMException {
  const reason = new DOMException(MESSAGES[cause], 'AbortError')
  causes.set(reason, cause)
  return reason
}

/** Why `signal` ended the answer early, or undefined when it is not aborted or carries no cause. */
export function endedEarlyCause(signal: AbortSignal | undefined | null): EndedEarly | undefined {
  if (!signal?.aborted) return undefined
  const reason: unknown = signal.reason
  return typeof reason === 'object' && reason !== null ? causes.get(reason) : undefined
}

/** Read a stored `ended_early` value (the column, an evidence snapshot): a known cause, or undefined. */
export function parseEndedEarly(raw: unknown): EndedEarly | undefined {
  return raw === 'model' || raw === 'user' || raw === 'lock' ? raw : undefined
}
