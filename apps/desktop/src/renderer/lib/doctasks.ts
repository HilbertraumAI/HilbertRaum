import type { DocTaskKind, DocTaskStatus } from '@shared/types'

// Renderer-side watcher for the single active document task (the backend allows at
// most one at a time).
//
// Lives at MODULE level, not inside a screen component: a summary/translation keeps
// running in the main process while the user navigates away, so the busy/progress
// state (and its polling loop) must survive screen unmounts. Screens subscribe via
// `useSyncExternalStore(subscribeDocTask, getActiveDocTask)`; the chat screen's
// "task is busy" banner uses `cancelActiveDocTask()`. ONE store covers every task
// kind — at most one task exists anyway.
//
// Lifecycle: start → poll every POLL_MS → terminal status stays visible (so a screen
// the user returns to can show the outcome) until a screen acknowledges it with
// `acknowledgeDocTask()`.

export interface ActiveDocTask {
  jobId: string
  kind: DocTaskKind
  /**
   * The SOURCE documents the task runs over (summary/translation: one; compare: two,
   * in A/B order) — the rows that show the busy state.
   */
  documentIds: string[]
  /** Latest polled status; null until the first poll lands. */
  status: DocTaskStatus | null
  /** CODE-6: true after MAX_POLL_FAILURES consecutive poll errors — live state unknown, task kept. */
  stateUnknown: boolean
}

const POLL_MS = 400

// CODE-6 (full-audit 2026-07-11) — the skillruns SKA-40 tolerance, ported: how many CONSECUTIVE
// poll failures the active task tolerates before the store gives up polling it. On give-up it
// keeps a labelled "state unknown" task (never silently dropping a live task — today ONE
// transient IPC error nulled the store: the busy/Cancel UI vanished while the task still ran,
// `anyTaskActive` flipped false so re-enabled actions hit backend busy-rejects, and the
// done-task effect never fired, so a finished task's outcome was never surfaced).
const MAX_POLL_FAILURES = 3

let active: ActiveDocTask | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** CODE-6: consecutive poll-failure counter for the active task; any successful poll resets it. */
let pollFailures = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

function setActive(next: ActiveDocTask | null): void {
  active = next
  notify()
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function subscribeDocTask(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — a fresh object per change, stable between. */
export function getActiveDocTask(): ActiveDocTask | null {
  return active
}

export function isDocTaskTerminal(status: DocTaskStatus | null): boolean {
  return status != null && (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled')
}

/**
 * PF-7b (full-audit 2026-07-10): the fields whose change means subscribers must re-render —
 * an identical 400 ms poll tick skips the set entirely (the skillruns `sameRun` precedent,
 * SKA-39), so a long-running task no longer re-renders every subscribed screen ~2.5×/s.
 */
function sameStatus(a: DocTaskStatus | null, b: DocTaskStatus): boolean {
  return (
    a != null &&
    a.state === b.state &&
    a.progress.stepsDone === b.progress.stepsDone &&
    a.progress.stepsTotal === b.progress.stepsTotal &&
    (a.error ?? null) === (b.error ?? null) &&
    (a.resultRef?.documentId ?? null) === (b.resultRef?.documentId ?? null)
  )
}

/**
 * Start a document task over one document (summary/translation) or two (compare,
 * A/B order) and begin polling. Throws the backend's friendly error when the task is
 * refused (chat streaming, no runtime, bad params, …).
 */
export async function startTask(
  kind: DocTaskKind,
  documentIds: string | string[],
  params?: Record<string, unknown>
): Promise<void> {
  const ids = Array.isArray(documentIds) ? documentIds : [documentIds]
  const { jobId } = await window.api.startDocTask({ kind, documentIds: ids, params })
  stopPolling()
  pollFailures = 0 // CODE-6: the counter tracks the CURRENT task's polling run
  setActive({ jobId, kind, documentIds: ids, status: null, stateUnknown: false })
  // The id this timer is watching. Reassigned when a chained follow-up task is adopted
  // (deep-index tree → extract, #38), so the same loop keeps polling through both passes.
  let watchedJobId = jobId
  timer = setInterval(() => {
    void (async () => {
      const current = active
      if (!current || current.jobId !== watchedJobId) {
        stopPolling()
        return
      }
      try {
        const status = await window.api.getDocTask(watchedJobId)
        pollFailures = 0 // CODE-6: only CONSECUTIVE failures count — any success resets
        if (status.state === 'done' && params?.withExtract === true) {
          // Chain adoption (#38): "Build deep index" starts a 'tree' task (withExtract) that
          // chains a backend 'extract' task over the same document. When the tree completes,
          // adopt the running follow-up task so the row busy state and the chat task banner
          // stay truthful through both passes. No follow-up (chain dropped: chat streaming /
          // runtime gone) or a foreign task over other documents keeps the ordinary terminal
          // handling — the backend ran or dropped the extract either way.
          const next = await window.api.getActiveDocTask?.().catch(() => null)
          if (
            next &&
            next.jobId !== watchedJobId &&
            !isDocTaskTerminal(next) &&
            next.documentIds.some((id) => current.documentIds.includes(id))
          ) {
            watchedJobId = next.jobId
            setActive({ jobId: next.jobId, kind: next.kind, documentIds: next.documentIds, status: next, stateUnknown: false })
            return
          }
        }
        // PF-7b: an unchanged tick sets nothing — subscribers keep the same snapshot object.
        // (CODE-6: a recovered poll also clears a stateUnknown flag, mirroring skillruns.)
        if (!sameStatus(current.status, status) || current.stateUnknown) {
          setActive({ ...current, status, stateUnknown: false })
        }
        if (isDocTaskTerminal(status)) stopPolling()
      } catch {
        // CODE-6 (full-audit 2026-07-11; SKA-40 port): tolerate transient IPC errors; give up
        // only after MAX_POLL_FAILURES in a row, and KEEP a labelled "state unknown" task
        // rather than silently dropping a live one (one flaky poll used to null the store).
        // Below the max the snapshot stays untouched, so subscribers see no churn at all.
        pollFailures += 1
        if (pollFailures >= MAX_POLL_FAILURES) {
          stopPolling()
          const cur = active
          if (cur && cur.jobId === watchedJobId && !cur.stateUnknown) {
            setActive({ ...cur, stateUnknown: true })
          }
        }
      }
    })()
  }, POLL_MS)
}

/** Cancel the currently active task (running or queued). */
export async function cancelActiveDocTask(): Promise<void> {
  await window.api.cancelDocTask()
}

/**
 * Clear a finished (terminal) task after a screen has handled its outcome. A state-unknown
 * task (CODE-6 give-up) is dismissible the same way — mirroring skillruns' acknowledge —
 * so a task whose live state the store could no longer learn is never stuck forever.
 */
export function acknowledgeDocTask(): void {
  if (active && (isDocTaskTerminal(active.status) || active.stateUnknown)) {
    setActive(null)
  }
}

/** Test-only: drop the module-level state between renderer tests. */
export function resetDocTaskStoreForTests(): void {
  stopPolling()
  active = null
  pollFailures = 0
  listeners.clear()
}
