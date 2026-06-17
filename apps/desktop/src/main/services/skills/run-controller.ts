import { randomUUID } from 'node:crypto'
import type { SkillRunState } from '../../../shared/types'

// The app-orchestrated tool-run lifecycle controller (skills plan §12.2, Phase S11b). It is the
// GENERIC, content-free state machine the IPC layer polls: it knows nothing about banks, documents,
// or persistence — it owns only the single active run's {state, progress, counts} snapshot, an
// AbortController for Cancel, and the merge of the tool's `onProgress` into that snapshot (the
// doc-task polling precedent — no new event channel). The bank/tool specifics live in the
// `tool-runs.ts` dispatch + the `run.ts` seam (§13); they are handed in as an opaque `ToolRunner`.
//
// One run at a time (the doc-task one-at-a-time precedent): starting while a run is active throws a
// friendly error. A terminal run stays readable until the renderer acknowledges it (`clear`).

/** The content-free outcome a runner resolves to — counts only, never the extracted rows. */
export interface ToolRunOutcome {
  ok: boolean
  /** A COUNT the run touched (rows extracted/categorized/summarized/saved, or rows not reconciling). */
  transactionCount?: number
  /**
   * A small, content-free outcome discriminator the renderer maps to copy when a count alone is
   * ambiguous (e.g. `validate_statement_balances` → 'reconciled' | 'unreconciled' | 'unchecked').
   * Generic: the controller treats it as an opaque token — the bank meaning lives in the renderer's
   * copy map, never here (§13). Unset for tools whose result is just a count.
   */
  resultKind?: string
  /**
   * True when the run ended because it was CANCELLED rather than failing — e.g. the user dismissed
   * the CSV save dialog, or Cancel landed before the work persisted. The seam is the authority here;
   * `finish` surfaces it directly so a benign cancel is never shown as a failure (B1) and a cancel
   * that lands AFTER the work committed is reported by its true outcome, not as "cancelled" (B2).
   */
  cancelled?: boolean
  /** A content-free reason CODE the renderer maps to localized copy (the seam stays i18n-free). */
  errorCode?: string
  /** A friendly, content-free reason on failure (English; kept for logs — renderer prefers code). */
  error?: string
}

/**
 * Runs the actual tool. Receives the controller's cancellation `signal` and a `onProgress` that
 * merges into the polled state. The runner OWNS persistence + the ids/counts-only audit (it closes
 * over the right seam); the controller never touches content.
 */
export type ToolRunner = (deps: {
  signal: AbortSignal
  onProgress: (p: { done: number; total: number }) => void
}) => Promise<ToolRunOutcome>

export interface StartRunArgs {
  skillInstallId: string
  toolName: string
  documentCount: number
  runner: ToolRunner
}

interface ActiveRun {
  state: SkillRunState
  controller: AbortController
}

const TERMINAL: ReadonlySet<SkillRunState['state']> = new Set(['done', 'failed', 'cancelled'])

export class SkillRunController {
  private active: ActiveRun | null = null

  /** True while a run is running (not terminal) — the one-at-a-time + busy guard. */
  isRunning(): boolean {
    return this.active != null && !TERMINAL.has(this.active.state.state)
  }

  /**
   * Start a run. Throws a friendly error if one is already running (one-at-a-time). Kicks the runner
   * off WITHOUT awaiting (the renderer polls `get`); returns the initial `running` snapshot.
   */
  start(args: StartRunArgs): SkillRunState {
    if (this.isRunning()) {
      throw new Error('A skill is already working. Let it finish or cancel it first.')
    }
    const controller = new AbortController()
    const state: SkillRunState = {
      runHandle: randomUUID(),
      skillInstallId: args.skillInstallId,
      toolName: args.toolName,
      documentCount: args.documentCount,
      state: 'running',
      progress: { done: 0, total: 0 }
    }
    this.active = { state, controller }
    const handle = state.runHandle

    void args
      .runner({
        signal: controller.signal,
        onProgress: (p) => {
          // Merge progress only while THIS run is the active one (a late callback after the next
          // run started must not clobber it).
          if (this.active?.state.runHandle === handle && !TERMINAL.has(this.active.state.state)) {
            this.active.state.progress = { done: p.done, total: p.total }
          }
        }
      })
      .then((outcome) => this.finish(handle, controller, outcome))
      .catch(() => this.finish(handle, controller, { ok: false }))

    return { ...state, progress: { ...state.progress } }
  }

  /**
   * Map a runner outcome to the terminal state. The SEAM is the authority on what actually happened
   * to the data, so a successful outcome is reported `done` even if Cancel landed late (the work
   * persisted — claiming "cancelled, nothing changed" would be a lie; B2). A non-ok outcome is
   * `cancelled` when the seam says so (`outcome.cancelled`, e.g. a dismissed save dialog; B1) — or
   * as a fallback when the runner threw mid-abort (no outcome flag, but the signal is aborted) — and
   * `failed` otherwise.
   */
  private finish(handle: string, controller: AbortController, outcome: ToolRunOutcome): void {
    if (this.active?.state.runHandle !== handle) return // a newer run replaced it
    const s = this.active.state
    if (outcome.ok) {
      s.state = 'done'
      s.transactionCount = outcome.transactionCount
      s.resultKind = outcome.resultKind
    } else if (outcome.cancelled || controller.signal.aborted) {
      s.state = 'cancelled'
    } else {
      s.state = 'failed'
      s.errorCode = outcome.errorCode
      s.error = outcome.error ?? 'This tool could not finish. Nothing was changed.'
    }
  }

  /** Poll a run by handle (a copy — the renderer never shares mutable engine state). */
  get(runHandle: string): SkillRunState | null {
    if (!this.active || this.active.state.runHandle !== runHandle) return null
    return { ...this.active.state, progress: { ...this.active.state.progress } }
  }

  /** Cancel a run by handle (or the active run when no handle is given). Aborts its signal. */
  cancel(runHandle?: string | null): void {
    if (!this.active) return
    if (runHandle && this.active.state.runHandle !== runHandle) return
    if (TERMINAL.has(this.active.state.state)) return
    this.active.controller.abort()
  }

  /** Drop a terminal run once the renderer has shown its outcome (the acknowledge precedent). */
  clear(runHandle?: string | null): void {
    if (!this.active) return
    if (runHandle && this.active.state.runHandle !== runHandle) return
    if (TERMINAL.has(this.active.state.state)) this.active = null
  }
}
