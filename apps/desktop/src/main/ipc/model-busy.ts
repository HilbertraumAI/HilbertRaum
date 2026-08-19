import { inFlightStreams } from './inflight'
import type { AppContext } from '../services/context'
import type { ModelBusyLane, OccupancyLane } from '../services/runtime/occupancy'

export { modelBusyMessageKey } from '../services/runtime/occupancy'
export type { ModelBusyLane } from '../services/runtime/occupancy'

// The ONE composed answer to "is anything already using the chat model, and what?" for the
// lanes that must refuse to start on top of each other (issues #185/#186).
//
// It composes rather than duplicates. Each lane already owns the authoritative record of its
// own state, and this reads each at its source:
//
//   chat        `inFlightStreams` — the same registry the doc-task admission guard has read
//               since wave 3. Chat is not an occupancy span (see `runtime/occupancy.ts`).
//   doc-task    `DocTaskManager.hasActiveTask()` — queued OR running. A queued task does not
//               occupy the model yet, but it will the moment the pump frees, so a benchmark
//               or a skill run admitted "into the queue's shadow" would collide seconds later.
//               (The RUNNING half also holds an occupancy span, which is what makes a doc task
//               visible to the external local-API lane through `isExternallyBusy`.)
//   skill-run   an occupancy span — the SkillRunController is per-document bookkeeping, not a
//               global busy signal, which is exactly what #186 reported.
//   benchmark   an occupancy span — the benchmark had no registry at all (#185).
//
// This lives in the IPC layer because `inFlightStreams` does: `main/index.ts` already passes it
// INTO the doc-task manager (`isChatStreaming`) rather than letting a service import upward, and
// that direction is kept. The doc-task manager therefore does not call this — it keeps its own
// chat check with its own pinned copy, and consults only the occupancy half.

/** The context slice this needs — a `Pick` so a test can pass a two-field literal. */
export type ModelBusyContext = Pick<AppContext, 'runtime' | 'docTasks'>

/**
 * The lane currently holding the model, or null when nothing is. Checked in refusal-copy
 * priority: chat first (the one the user is most likely watching), then the doc-task queue,
 * then the remaining spans oldest-first.
 *
 * `ignore` lets a caller exclude a lane where overlap is legitimate. The benchmark
 * deliberately does NOT ignore its own lane — a second benchmark seeing the first is exactly
 * the re-entrancy guard #185 asked for.
 */
export function modelBusyLane(
  ctx: ModelBusyContext,
  opts?: { ignore?: readonly ModelBusyLane[] }
): ModelBusyLane | null {
  const ignore = opts?.ignore ?? []
  if (!ignore.includes('chat') && inFlightStreams.size > 0) return 'chat'
  if (!ignore.includes('doc-task') && (ctx.docTasks?.hasActiveTask() ?? false)) return 'doc-task'
  // `doc-task` is answered above (its span is the RUNNING subset of `hasActiveTask`), so it is
  // always excluded here — otherwise a deliberately ignored doc task would leak back in through
  // the span half and the `ignore` option would silently not work for that lane.
  const spanIgnore = [...ignore, 'doc-task'].filter(
    (lane): lane is OccupancyLane => lane !== 'chat'
  )
  // Optional-chained on purpose: partial test contexts build a fake `runtime` with just the
  // methods they need, and an unwired registry means "never occupied" — the same posture as
  // `ctx.docTasks?` above and every other late-bound probe on the context.
  return ctx.runtime?.occupancy?.heldLane(spanIgnore) ?? null
}
