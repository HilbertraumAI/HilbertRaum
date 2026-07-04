import type { SkillRunState, StartSkillRunRequest } from '@shared/types'

// Renderer-side watcher for the app's Tier-2 tool runs (skills plan §12.2, S11b — the `doctasks.ts`
// precedent). Module-level (not inside a screen) so runs survive a screen unmount, driven by polling
// `getSkillRun` per live handle (the run's `onProgress` is merged into that status main-side — no new
// event channel). Runs carry ids/counts ONLY (never the extracted rows).
//
// SKA-6 (skills audit 2026-07-03, U6) — MULTI-RUN store keyed by `runHandle`, mirroring A2's
// per-document controller. The store was a single module-level `active` slot: a second run silently
// abandoned the first (its outcome never shown, never acknowledged), and ChatScreen rendered that one
// app-wide run in EVERY conversation. Now each live/terminal run is a first-class entry carrying its
// {run, conversationId, documentId}; every live handle is polled on its own timer; the screen gates the
// run bar to the run whose `conversationId === activeId` and shows a quiet chip for runs in OTHER chats.
//
// Lifecycle per entry: start/adopt → poll every POLL_MS → a terminal state stays visible until a screen
// dismisses it with `acknowledgeSkillRun(handle)` (the calm result row), so the outcome isn't lost on a
// quick unmount. SKA-17: `adoptSkillRuns()` re-adopts main's runs on a fresh mount (a reload destroyed
// the module state; main kept the runs) — including terminal-unacknowledged ones so a finished run's
// outcome is finally shown/acknowledgeable after a reload.

const POLL_MS = 400

// SKA-40: how many CONSECUTIVE poll failures a live run tolerates before the store gives up polling it.
// On give-up it keeps a labelled "state unknown" row (never silently dropping a live run — today ONE
// transient IPC error orphaned it), so the user can still dismiss it.
const MAX_POLL_FAILURES = 3

/** One tracked run: the content-free state plus the ids the store needs to gate/pin/re-adopt it. */
export interface SkillRunEntry {
  run: SkillRunState
  /** The conversation that started the run (gates the run bar to the launching conversation). */
  conversationId: string
  /** The run's target document (routed-relay pin + cross-scope categorize refusal). Null if unknown. */
  documentId: string | null
  /** SKA-40: true after MAX_POLL_FAILURES consecutive poll errors — live state unknown, row kept. */
  stateUnknown: boolean
}

interface InternalEntry extends SkillRunEntry {
  timer: ReturnType<typeof setInterval> | null
  pollFailures: number
}

const entries = new Map<string, InternalEntry>()
// The immutable snapshot handed to `useSyncExternalStore`. Rebuilt ONLY when something actually changed
// (SKA-39 shallow-compare gates that), so the reference stays stable between changes and the 400 ms poll
// no longer re-renders ChatScreen ~2.5×/s for a run's whole duration.
let snapshot: readonly SkillRunEntry[] = []
const listeners = new Set<() => void>()

function project(e: InternalEntry): SkillRunEntry {
  return { run: e.run, conversationId: e.conversationId, documentId: e.documentId, stateUnknown: e.stateUnknown }
}

function rebuildSnapshot(): void {
  snapshot = Array.from(entries.values()).map(project)
}

function notify(): void {
  rebuildSnapshot()
  for (const fn of listeners) fn()
}

function stopTimer(e: InternalEntry): void {
  if (e.timer) {
    clearInterval(e.timer)
    e.timer = null
  }
}

export function subscribeSkillRuns(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Snapshot for useSyncExternalStore — a stable reference between changes (SKA-39). */
export function getSkillRunsSnapshot(): readonly SkillRunEntry[] {
  return snapshot
}

export function isSkillRunTerminal(run: SkillRunState | null): boolean {
  return run != null && (run.state === 'done' || run.state === 'failed' || run.state === 'cancelled')
}

/**
 * The run to show in the run bar for a conversation: the MOST-RECENTLY-started entry whose
 * `conversationId` matches (there is at most one live run per document; a multi-doc scope could hold
 * several, and the newest is the one the user just acted on). Null when the conversation has no run.
 */
export function pickConversationRun(runs: readonly SkillRunEntry[], conversationId: string | null): SkillRunEntry | null {
  if (!conversationId) return null
  let found: SkillRunEntry | null = null
  for (const e of runs) if (e.conversationId === conversationId) found = e // last match = most recent
  return found
}

/** True when a run is RUNNING in some OTHER conversation (drives the "working in another chat" chip). */
export function hasRunningRunElsewhere(runs: readonly SkillRunEntry[], conversationId: string | null): boolean {
  return runs.some((e) => e.conversationId !== conversationId && e.run.state === 'running')
}

/**
 * A conversation to re-attach a fresh mount to (SKA-17): prefer a RUNNING run's conversation, else any
 * tracked run's, so a user who reloaded mid-run lands back on the running document chat instead of a
 * new empty one. Null when nothing is tracked.
 */
export function getReattachConversationId(): string | null {
  let fallback: string | null = null
  for (const e of entries.values()) {
    if (e.conversationId === '') continue
    if (e.run.state === 'running') return e.conversationId
    fallback ??= e.conversationId
  }
  return fallback
}

/** SKA-39: the fields whose change means the run bar must re-render — anything else is a no-op poll. */
function sameRun(a: SkillRunState, b: SkillRunState): boolean {
  return (
    a.state === b.state &&
    a.count === b.count &&
    a.transactionCount === b.transactionCount &&
    a.resultKind === b.resultKind &&
    a.errorCode === b.errorCode &&
    a.progress.done === b.progress.done &&
    a.progress.total === b.progress.total
  )
}

/** Add/replace a tracked run and (if live) begin polling it; refresh its full state once immediately. */
function adopt(run: SkillRunState, conversationId: string, documentId: string | null): void {
  const prev = entries.get(run.runHandle)
  if (prev) stopTimer(prev)
  const e: InternalEntry = { run, conversationId, documentId, stateUnknown: false, timer: null, pollFailures: 0 }
  entries.set(run.runHandle, e)
  if (!isSkillRunTerminal(run)) {
    e.timer = setInterval(() => void pollOnce(run.runHandle), POLL_MS)
  }
  notify()
  // One immediate poll refreshes a just-adopted terminal run's count/resultKind (SKA-17 re-adopt) and
  // speeds the first live update; harmless for a fresh 'running' run the timer will also poll.
  void pollOnce(run.runHandle)
}

async function pollOnce(handle: string): Promise<void> {
  const before = entries.get(handle)
  if (!before) return // acknowledged / replaced since the tick was scheduled
  let next: SkillRunState | null
  try {
    next = await window.api.getSkillRun(handle)
  } catch {
    const e = entries.get(handle)
    if (!e) return
    e.pollFailures += 1
    // SKA-40: tolerate transient IPC errors; give up only after N in a row, and KEEP a labelled
    // "state unknown" row rather than silently dropping a live run (today one error orphaned it).
    if (e.pollFailures >= MAX_POLL_FAILURES) {
      stopTimer(e)
      if (!e.stateUnknown) {
        e.stateUnknown = true
        notify()
      }
    }
    return
  }
  const e = entries.get(handle)
  if (!e) return
  e.pollFailures = 0
  if (next) {
    if (!sameRun(e.run, next) || e.stateUnknown) {
      e.run = { ...next, conversationId: e.conversationId, documentId: e.documentId ?? undefined }
      e.stateUnknown = false
      if (isSkillRunTerminal(next)) stopTimer(e)
      notify() // SKA-39: only when a tracked field actually changed
    }
  } else {
    // A null poll means the run was cleared/replaced/LOST main-side (a swept slot, or a main restart).
    // Stop polling and keep the entry — but if it was still 'running', mark it state-unknown so the row
    // stays DISMISSIBLE: a running row shows only Cancel, and cancelling a run main no longer holds is a
    // dead no-op, which would strand the bar spinning until a reload (SKA-40 sibling).
    stopTimer(e)
    if (!isSkillRunTerminal(e.run) && !e.stateUnknown) {
      e.stateUnknown = true
      notify()
    }
  }
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
 * Ask main to start a run from a user action (DS4). On success, tracks the run + begins polling. Never
 * throws for the expected refusals — returns the structured outcome instead. On a BUSY refusal that
 * carries the running handle (SKA-17), RE-ADOPTS that orphaned run so a reloaded renderer recovers it.
 */
export async function startSkillRun(req: StartSkillRunRequest): Promise<StartSkillRunOutcome> {
  const result = await window.api.startSkillRun(req)
  if (!result.started) {
    if ('needsConfirmation' in result) return { started: false, needsConfirmation: true }
    if ('runningHandle' in result && typeof result.runningHandle === 'string' && result.runningHandle) {
      void adoptHandle(result.runningHandle)
    }
    return { started: false, error: result.error }
  }
  adopt(result.run, req.conversationId, req.documentId ?? null)
  return { started: true }
}

/** Re-adopt a single run by handle, learning its conversation/document from the polled state (SKA-17). */
async function adoptHandle(handle: string): Promise<void> {
  if (entries.has(handle)) return
  let state: SkillRunState | null
  try {
    state = await window.api.getSkillRun(handle)
  } catch {
    return
  }
  if (!state) return
  adopt(state, state.conversationId ?? '', state.documentId ?? null)
}

/**
 * Re-adopt every run main currently holds on a fresh mount (SKA-17): a reload destroyed the module
 * state but main kept the runs (the controller lives in the main process). Includes terminal-but-
 * unacknowledged runs so a finished run's outcome is finally shown/acknowledgeable after a reload.
 */
export async function adoptSkillRuns(): Promise<void> {
  let runs: SkillRunState[]
  try {
    runs = (await window.api.listSkillRuns?.()) ?? []
  } catch {
    return
  }
  for (const run of runs) {
    if (entries.has(run.runHandle)) continue
    adopt(run, run.conversationId ?? '', run.documentId ?? null)
  }
}

/** Cancel a run by handle (the busy row's Cancel). A non-empty handle is required (SKA-25). */
export async function cancelSkillRun(runHandle: string): Promise<void> {
  if (runHandle) await window.api.cancelSkillRun(runHandle)
}

/**
 * Dismiss a finished (terminal or state-unknown) run after a screen has shown its outcome. Also
 * releases the terminal run main-side (the acknowledge handshake) so the controller doesn't hold
 * stale state. A no-op on a still-running, known run.
 */
export function acknowledgeSkillRun(runHandle: string): void {
  const e = entries.get(runHandle)
  if (!e) return
  if (!isSkillRunTerminal(e.run) && !e.stateUnknown) return
  stopTimer(e)
  entries.delete(runHandle)
  notify()
  void window.api.clearSkillRun?.(runHandle)
}

/** Test-only: drop module-level state between renderer tests. */
export function resetSkillRunStoreForTests(): void {
  for (const e of entries.values()) stopTimer(e)
  entries.clear()
  snapshot = []
  listeners.clear()
}
