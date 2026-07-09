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
}

const POLL_MS = 400

let active: ActiveDocTask | null = null
let timer: ReturnType<typeof setInterval> | null = null
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
  setActive({ jobId, kind, documentIds: ids, status: null })
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
            setActive({ jobId: next.jobId, kind: next.kind, documentIds: next.documentIds, status: next })
            return
          }
        }
        setActive({ ...current, status })
        if (isDocTaskTerminal(status)) stopPolling()
      } catch {
        // Polling failed (e.g. workspace locked) — surface a terminal-ish stop.
        stopPolling()
        setActive(null)
      }
    })()
  }, POLL_MS)
}

/** Cancel the currently active task (running or queued). */
export async function cancelActiveDocTask(): Promise<void> {
  await window.api.cancelDocTask()
}

/** Clear a finished (terminal) task after a screen has handled its outcome. */
export function acknowledgeDocTask(): void {
  if (active && isDocTaskTerminal(active.status)) {
    setActive(null)
  }
}

/** Test-only: drop the module-level state between renderer tests. */
export function resetDocTaskStoreForTests(): void {
  stopPolling()
  active = null
  listeners.clear()
}
