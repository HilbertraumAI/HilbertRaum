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
// The conversation that started the active run. Kept module-level (like `active`) so it SURVIVES a
// screen unmount: navigating away mid-run and back must re-attach to the running document chat, not
// drop the user onto a fresh empty chat while the badge still spins. It is the id the renderer itself
// passed to `startSkillRun` — NOT sourced from the content-free `SkillRunState`/IPC (which carries
// ids/counts only), so the ids/counts privacy boundary is unchanged.
let activeConversationId: string | null = null
// The document the active run targets (U3, audit ux-6). Kept module-level alongside `active` so it
// SURVIVES a screen unmount: the routed-run relay (Summarize/Categorize → a real chat answer) pins
// `askDocuments` to THIS document, so a multi-document scope can't scatter the answer across the
// wrong documents. It is the resolved id the renderer passed to `startSkillRun` — NOT sourced from
// the content-free `SkillRunState`/IPC (ids/counts only), so the privacy boundary is unchanged.
let activeDocumentId: string | null = null
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

/**
 * The conversation that owns the active run, or null when no run is active. A screen re-selects it on
 * remount so an in-flight run (e.g. a "categorize transactions" doctask) keeps the user on its document
 * chat instead of a new empty one. Renderer-only (the id the renderer passed to `startSkillRun`).
 */
export function getActiveSkillRunConversationId(): string | null {
  return active ? activeConversationId : null
}

/**
 * The document the active run targets, or null when no run is active / none was resolved (U3, audit
 * ux-6). The routed-run relay pins its chat answer to this id so a Summarize/Categorize result can't
 * scatter across a multi-document scope. Renderer-only (the resolved id the renderer passed to
 * `startSkillRun`), so the ids/counts privacy boundary is unchanged.
 */
export function getActiveSkillRunDocumentId(): string | null {
  return active ? activeDocumentId : null
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
  activeConversationId = req.conversationId
  activeDocumentId = req.documentId ?? null
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
    activeConversationId = null
    activeDocumentId = null
    void window.api.clearSkillRun(handle)
  }
}

/** Test-only: drop module-level state between renderer tests. */
export function resetSkillRunStoreForTests(): void {
  stopPolling()
  active = null
  activeConversationId = null
  activeDocumentId = null
  listeners.clear()
}
