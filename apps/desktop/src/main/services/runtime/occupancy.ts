// Model occupancy — the shared "a background job is holding the model" span registry
// (issues #185/#186; architecture.md "Model occupancy — design record").
//
// WHY IT IS NOT THE GENERATION GATE. The `RuntimeManager` gate (index.ts) counts in-flight
// `chatStream` pulls, which is exactly the right answer for the question it was built for
// ("may an EXTERNAL request issue right now?") and exactly the wrong one for "is a background
// job using the model?". A doc task, a skill run, and the benchmark are all multi-step: they
// generate, do local work, then generate again. Between two calls the gate reads IDLE, so a
// guard riding the raw gate would admit a second job into the gap and the two would then
// interleave on the one llama-server slot. A SPAN closes the gaps: the job holds it from its
// first model call to its last.
//
// WHICH LANES HOLD A SPAN. The three background lanes only:
//
//   doc-task    the DocTaskManager's RUNNING task (queued tasks do not occupy the model; the
//               chat-side guard reads `hasActiveTask()`, which covers queued + running)
//   skill-run   a skill run whose tool streams on the chat runtime directly — the
//               `modelLane: 'direct'` descriptors (redact_document / apply_document_edits).
//               `categorize_transactions` is `modelLane: 'doctask'` and takes NO span: its
//               model call happens inside an enqueued doc task, which holds its own span.
//               A categorize run that took one would refuse its own task (D26 deadlock).
//   benchmark   the whole `runAndPersistBenchmark`, which is also its re-entrancy guard
//
// CHAT IS DELIBERATELY NOT A LANE. It already has `inFlightStreams` — the registry the
// doc-task admission guard has always read — and duplicating it here would be a second
// source of truth for the same fact. Chat is also the FOREGROUND: it is refused only by the
// rules that predate this registry (an active doc task) plus the one this wave adds (a direct
// skill run, #186), never by the benchmark. Guards that need "chat too" compose the two
// sources; `ipc/model-busy.ts` holds that one composition.
//
// LEAK POSTURE. Every `begin()` is paired with a release in a `finally`, and the returned
// release is idempotent (a double call is a no-op, not an under-count). A leaked span would
// make background lanes — and external local-API admission, which folds this in — refuse
// until the app restarts, so the release must never sit behind a conditional.

import type { MessageKey } from '../../../shared/i18n'

/** A background lane that can occupy the one chat runtime. Chat is not one — see the header. */
export type OccupancyLane = 'doc-task' | 'skill-run' | 'benchmark'

/** A lane that can be holding the model, including the foreground chat lane (`inFlightStreams`). */
export type ModelBusyLane = 'chat' | OccupancyLane

/**
 * The friendly, content-free refusal copy for a busy lane. ONE message per lane, shared by
 * every surface that refuses (benchmark, skill run, doc task, chat) — a per-surface × per-lane
 * matrix would be twelve strings saying the same four things. Each names the affordance the
 * user actually has right now (stop the answer, cancel the task, cancel the run in the bar).
 *
 * The doc-task manager's pre-existing chat refusal keeps `main.task.refusedChatStreaming`
 * (renderer- and test-pinned since wave 3); it is deliberately NOT migrated onto this map.
 */
export function modelBusyMessageKey(lane: ModelBusyLane): MessageKey {
  switch (lane) {
    case 'chat':
      return 'main.busy.chat'
    case 'doc-task':
      return 'main.busy.docTask'
    case 'skill-run':
      return 'main.busy.skillRun'
    case 'benchmark':
      return 'main.busy.benchmark'
  }
}

interface Span {
  lane: OccupancyLane
  /** Epoch ms the span was taken — diagnostics only (a stuck lane is visible in a log line). */
  since: number
}

/**
 * The span registry. One instance per `RuntimeManager` (the manager is the authority on who
 * has the model: the gate answers "right now", this answers "for the duration of a job").
 * Pure in-process bookkeeping — no timers, no I/O, nothing to tear down.
 */
export class ModelOccupancy {
  private readonly spans = new Map<symbol, Span>()

  /**
   * Take a span for `lane`. Returns an IDEMPOTENT release — call it in a `finally` on every
   * exit path (success, throw, abort). Re-entrant by construction: two spans of the same lane
   * simply coexist, and the lane reads busy until both release.
   */
  begin(lane: OccupancyLane): () => void {
    const token = Symbol(lane)
    this.spans.set(token, { lane, since: Date.now() })
    let released = false
    return () => {
      if (released) return
      released = true
      this.spans.delete(token)
    }
  }

  /** True while at least one span of `lane` is held. */
  held(lane: OccupancyLane): boolean {
    for (const span of this.spans.values()) if (span.lane === lane) return true
    return false
  }

  /**
   * The lane of the OLDEST span currently held, ignoring the lanes in `ignore` — the one the
   * caller names in its refusal copy. Insertion order is held order (Map preserves it), so the
   * job that has been waiting on the model longest is the one reported, not an arbitrary one.
   * Null when nothing (relevant) is held.
   */
  heldLane(ignore: readonly OccupancyLane[] = []): OccupancyLane | null {
    for (const span of this.spans.values()) {
      if (!ignore.includes(span.lane)) return span.lane
    }
    return null
  }

  /** True while ANY span is held. The external-admission read (`isExternallyBusy`). */
  isBusy(): boolean {
    return this.spans.size > 0
  }

  /** Held spans, oldest first — for a diagnostic log line. Never used for control flow. */
  snapshot(): Array<{ lane: OccupancyLane; heldMs: number }> {
    const now = Date.now()
    return [...this.spans.values()].map((s) => ({ lane: s.lane, heldMs: now - s.since }))
  }
}
