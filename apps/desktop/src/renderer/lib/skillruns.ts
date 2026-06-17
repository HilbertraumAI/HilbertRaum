import type { SkillRunState, StartSkillRunRequest } from '@shared/types'

// Renderer-side watcher for the single active Tier-2 tool run (skills plan §12.2, S11b — the
// `doctasks.ts` precedent). Module-level (not inside a screen) so a run survives a screen unmount,
// driven by polling `getSkillRun` (the run's `onProgress` is merged into that status main-side — no
// new event channel). The run carries ids/counts ONLY (never the extracted rows). Screens subscribe
// via `useSyncExternalStore(subscribeSkillRun, getActiveSkillRun)`.
//
// Lifecycle: start → poll every POLL_MS → terminal state stays visible until a screen dismisses it
// with `acknowledgeSkillRun()` (the calm result row), so the outcome isn't lost on a quick unmount.

const POLL_MS = 400

let active: SkillRunState | null = null
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

function setActive(next: SkillRunState | null): void {
  active = next
  notify()
}

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export function subscribeSkillRun(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — a fresh object per change, stable between. */
export function getActiveSkillRun(): SkillRunState | null {
  return active
}

export function isSkillRunTerminal(run: SkillRunState | null): boolean {
  return run != null && (run.state === 'done' || run.state === 'failed' || run.state === 'cancelled')
}

/**
 * What `startSkillRun` resolves to for the caller: `started` (the busy row now shows + polling
 * began), `needsConfirmation` (raise the confirm modal and retry with `confirmed:true`), or a
 * friendly `error` (surface on the banner). Mirrors the main-side `StartSkillRunResult`.
 */
export type StartSkillRunOutcome =
  | { started: true }
  | { started: false; needsConfirmation: true }
  | { started: false; error: string }

/**
 * Ask main to start a run from a user action (DS4). On success, sets the active run and begins
 * polling. Never throws for the expected refusals — returns the structured outcome instead.
 */
export async function startSkillRun(req: StartSkillRunRequest): Promise<StartSkillRunOutcome> {
  const result = await window.api.startSkillRun(req)
  if (!result.started) {
    return 'needsConfirmation' in result
      ? { started: false, needsConfirmation: true }
      : { started: false, error: result.error }
  }
  const run = result.run
  stopPolling()
  setActive(run)
  timer = setInterval(() => {
    void (async () => {
      const current = active
      if (!current || current.runHandle !== run.runHandle) {
        stopPolling()
        return
      }
      try {
        const next = await window.api.getSkillRun(run.runHandle)
        // A null poll means the run was cleared/replaced main-side — keep the last known snapshot
        // terminal-ish by stopping; otherwise adopt the fresh state.
        if (next) {
          setActive(next)
          if (isSkillRunTerminal(next)) stopPolling()
        } else {
          stopPolling()
        }
      } catch {
        stopPolling()
        setActive(null)
      }
    })()
  }, POLL_MS)
  return { started: true }
}

/** Cancel the active run (the busy row's Cancel). */
export async function cancelActiveSkillRun(): Promise<void> {
  if (active) await window.api.cancelSkillRun(active.runHandle)
}

/** Dismiss a finished (terminal) run after a screen has shown its outcome. Also releases the
 *  terminal run main-side (the acknowledge handshake) so the controller doesn't hold stale state. */
export function acknowledgeSkillRun(): void {
  if (active && isSkillRunTerminal(active)) {
    const handle = active.runHandle
    stopPolling()
    setActive(null)
    void window.api.clearSkillRun(handle)
  }
}

/** Test-only: drop module-level state between renderer tests. */
export function resetSkillRunStoreForTests(): void {
  stopPolling()
  active = null
  listeners.clear()
}
