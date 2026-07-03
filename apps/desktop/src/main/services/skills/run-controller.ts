import { randomUUID } from 'node:crypto'
import type { SkillRunState } from '../../../shared/types'

// The app-orchestrated tool-run lifecycle controller (skills plan §12.2, Phase S11b). It is the
// GENERIC, content-free state machine the IPC layer polls: it knows nothing about banks, documents,
// or persistence — it owns only the active runs' {state, progress, counts} snapshots, an
// AbortController for Cancel per run, and the merge of the tool's `onProgress` into that snapshot (the
// doc-task polling precedent — no new event channel). The bank/tool specifics live in the
// `tool-runs.ts` dispatch + the `run.ts` seam (§13); they are handed in as an opaque `ToolRunner`.
//
// One run PER DOCUMENT (audit §6.2). The controller used to hold a single app-wide active run, so
// "A skill is already working" fired across UNRELATED conversations/documents. Concurrency is now
// keyed by `documentId`: a second run on the SAME document is refused (the document-lock already
// serializes the true conflict — two extractions racing the same rows); runs on DIFFERENT documents
// proceed in parallel. A terminal run stays readable until the renderer acknowledges it (`clear`).

/** The content-free outcome a runner resolves to — counts only, never the extracted rows. */
export interface ToolRunOutcome {
  ok: boolean
  /**
   * The generic COUNT the run touched (rows extracted/categorized/summarized/saved, line items,
   * redactions, or rows not reconciling). A2 renamed the bank-shaped `transactionCount` to this
   * domain-neutral field (audit §6.2 — the outcome channel carried invoice line-item and redaction
   * counts under a `transactionCount` name).
   */
  count?: number
  /** @deprecated alias for `count`, kept one release for callers not yet migrated. Producers set
   *  `count`; `finish` reads `count ?? transactionCount`. */
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
  /** The document this run acts on — the per-document concurrency key (content-free id, U-1). */
  documentId: string
  documentCount: number
  runner: ToolRunner
}

interface ActiveRun {
  state: SkillRunState
  controller: AbortController
  /** The document this run is keyed by (its concurrency slot in `runs`). */
  documentId: string
}

const TERMINAL: ReadonlySet<SkillRunState['state']> = new Set(['done', 'failed', 'cancelled'])

export class SkillRunController {
  // Keyed by documentId: unrelated documents/conversations never collide. At most one non-terminal
  // run per document; a terminal run lingers in its slot until the renderer `clear`s it (or the next
  // run on that document replaces it).
  private runs = new Map<string, ActiveRun>()

  /**
   * True while a run is running (not terminal). With a `documentId`, scoped to THAT document's slot;
   * without one, true if ANY document has a run in flight.
   */
  isRunning(documentId?: string): boolean {
    if (documentId !== undefined) {
      const r = this.runs.get(documentId)
      return r != null && !TERMINAL.has(r.state.state)
    }
    for (const r of this.runs.values()) if (!TERMINAL.has(r.state.state)) return true
    return false
  }

  /**
   * Start a run. Throws a friendly error if a run is already in flight ON THE SAME DOCUMENT
   * (per-document one-at-a-time — a different document runs concurrently). Kicks the runner off
   * WITHOUT awaiting (the renderer polls `get`); returns the initial `running` snapshot.
   */
  start(args: StartRunArgs): SkillRunState {
    if (this.isRunning(args.documentId)) {
      throw new Error('A skill is already working on this document. Let it finish or cancel it first.')
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
    // Replace this document's slot (a lingering terminal run, if any — the next run supersedes it).
    this.runs.set(args.documentId, { state, controller, documentId: args.documentId })
    const handle = state.runHandle

    void args
      .runner({
        signal: controller.signal,
        onProgress: (p) => {
          // Merge progress only while THIS run still owns its slot (a late callback after the next
          // run replaced it, or after it went terminal, must not clobber anything).
          const entry = this.findByHandle(handle)
          if (entry && !TERMINAL.has(entry.state.state)) {
            entry.state.progress = { done: p.done, total: p.total }
          }
        }
      })
      .then((outcome) => this.finish(handle, controller, outcome))
      .catch(() => this.finish(handle, controller, { ok: false }))

    return { ...state, progress: { ...state.progress } }
  }

  /** Find the active-run entry that owns a poll/cancel handle (handles are unique across slots). */
  private findByHandle(runHandle: string): ActiveRun | undefined {
    for (const r of this.runs.values()) if (r.state.runHandle === runHandle) return r
    return undefined
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
    const entry = this.findByHandle(handle)
    if (!entry) return // a newer run replaced this slot, or it was already cleared
    const s = entry.state
    if (outcome.ok) {
      s.state = 'done'
      // Migration: producers set `count`; `transactionCount` stays as a deprecated read alias so any
      // not-yet-updated consumer keeps working. Mirror the resolved value onto both.
      const n = outcome.count ?? outcome.transactionCount
      s.count = n
      s.transactionCount = n
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
    const r = this.findByHandle(runHandle)
    return r ? { ...r.state, progress: { ...r.state.progress } } : null
  }

  /**
   * Cancel a run by handle. With no handle, cancels every in-flight run (a convenience for a
   * single-run caller; with per-document concurrency the renderer passes the specific handle).
   */
  cancel(runHandle?: string | null): void {
    if (runHandle) {
      const r = this.findByHandle(runHandle)
      if (r && !TERMINAL.has(r.state.state)) r.controller.abort()
      return
    }
    for (const r of this.runs.values()) if (!TERMINAL.has(r.state.state)) r.controller.abort()
  }

  /**
   * Drop a terminal run once the renderer has shown its outcome (the acknowledge precedent). With no
   * handle, drops every terminal run. A still-running handle is a no-op.
   */
  clear(runHandle?: string | null): void {
    if (runHandle) {
      const r = this.findByHandle(runHandle)
      if (r && TERMINAL.has(r.state.state)) this.runs.delete(r.documentId)
      return
    }
    for (const [key, r] of this.runs) if (TERMINAL.has(r.state.state)) this.runs.delete(key)
  }
}
