import type { AppContext } from '../services/context'
import { endedEarlyAbortReason } from '../services/chat/ended-early'
import { inFlightStreams } from './inflight'

/**
 * #600 — what a deliberate stop or switch of the chat model ends FIRST. `RuntimeManager` calls this
 * through its model-stop hook (registered in `main/index.ts`) right after it marks the model stopped
 * and right before it kills the sidecar, for every stop and switch except the crash restart. Lock
 * and quit end their work themselves first, which makes this a no-op for them.
 *
 * Before this, a stop or switch killed the sidecar under whatever was running: the answer failed
 * with a raw "terminated" / "fetch failed", its partial text was thrown away, and the local API's
 * client got 502 `runtime_unresponsive` — a crash, from the outside.
 *
 * Document tasks are NOT ended here (owner decision, #600): a running summary or comparison then
 * fails with "The task could not be finished. Make sure the model is still running" — true and
 * visible — where a cancel would vanish without a word (the Documents screen shows nothing for a
 * cancelled task). The same holds for a categorize skill run, whose model call is a document task.
 */
export function endWorkOnModelStop(
  ctx: Pick<AppContext, 'localApi' | 'docTasks' | 'skillRuns'>,
  kind: 'stop' | 'switch'
): void {
  // 1. The local API's request — FIRST: a chat turn aborted inside its compaction pre-pass re-enters
  //    the runtime gate, and the request must already carry this reason by then (`model_starting`
  //    when a switch brings the next model up, `model_not_loaded` after a plain stop).
  try {
    ctx.localApi?.endForModelChange(kind === 'switch' ? 'model_starting' : 'model_not_loaded')
  } catch {
    /* best-effort: the stop must proceed */
  }
  // 2. A deep-index build. The stop/switch handlers already abort it at the click, but a switch
  //    first checks the new model's files (minutes on a slow drive) and a build can start meanwhile.
  try {
    ctx.docTasks?.abortActiveBuild()
  } catch {
    /* best-effort */
  }
  // 3. Chat and document answers: each ends as a clean stop, its partial kept and marked
  //    "Reply stopped" (`persistAssistantMessage`); a re-asked answer's predecessor restored and a
  //    question with no answer at all marked (`withRegenerateGuard`).
  const reason = endedEarlyAbortReason('model')
  for (const controller of inFlightStreams.values()) {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  // 4. #606: the redaction and document-edit runs streaming on the model. Left running, a redaction
  //    fell back to the rule-based floor, dropped what the model had found and opened the save
  //    dialog; an edit ended "could not be completed". Cancelled, each reads "Stopped. Nothing was
  //    saved." A save dialog already open stays open; saving there still writes (owner, #606).
  try {
    ctx.skillRuns?.cancelModelRuns()
  } catch {
    /* best-effort */
  }
}
