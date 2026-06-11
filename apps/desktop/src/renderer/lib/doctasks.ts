import type { DocTaskKind, DocTaskStatus } from '@shared/types'

// Renderer-side watcher for the (single, D26) active document task — Phase 33/34.
//
// Lives at MODULE level, not inside a screen component: a summary/translation keeps
// running in the main process while the user navigates away, so the busy/progress
// state (and its polling loop) must survive screen unmounts. Screens subscribe via
// `useSyncExternalStore(subscribeDocTask, getActiveDocTask)`; the chat screen's
// "task is busy" banner uses `cancelActiveDocTask()`. ONE store for every task kind
// (Phase 34 generalized `startSummaryTask` into `startTask` rather than adding a
// second store) — D26 guarantees at most one task exists anyway.
//
// Lifecycle: start → poll every POLL_MS → terminal status stays visible (so a screen
// the user returns to can show the outcome) until a screen acknowledges it with
// `acknowledgeDocTask()`.

export interface ActiveDocTask {
  jobId: string
  kind: DocTaskKind
  /** The SOURCE document the task runs over (summary: summarized; translation: translated). */
  documentId: string
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
 * Start a document task over one document and begin polling. Throws the backend's
 * friendly error when the task is refused (chat streaming, no runtime, bad params, …).
 */
export async function startTask(
  kind: DocTaskKind,
  documentId: string,
  params?: Record<string, unknown>
): Promise<void> {
  const { jobId } = await window.api.startDocTask({ kind, documentIds: [documentId], params })
  stopPolling()
  setActive({ jobId, kind, documentId, status: null })
  timer = setInterval(() => {
    void (async () => {
      const current = active
      if (!current || current.jobId !== jobId) {
        stopPolling()
        return
      }
      try {
        const status = await window.api.getDocTask(jobId)
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
