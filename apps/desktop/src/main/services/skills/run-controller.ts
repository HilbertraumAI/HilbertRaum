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
  /**
   * The conversation that started this run (SKA-6/SKA-17, U6). A content-free id, threaded onto the
   * run state so the renderer's per-run store can gate the run bar to the launching conversation and
   * re-adopt the right conversation after a reload. Optional (tests omit it); the real IPC passes it.
   */
  conversationId?: string
  /**
   * #606: true when the run streams on the CHAT MODEL itself — a `modelLane: 'direct'` tool started
   * with a model running (the redaction / document-edit locate passes). A stop or switch of the model
   * cancels exactly these runs (`cancelModelRuns`). Unset for a run that never touches the model,
   * and for categorize, whose model call happens inside a document task (#600 leaves those to fail).
   */
  usesModel?: boolean
  runner: ToolRunner
}

interface ActiveRun {
  state: SkillRunState
  controller: AbortController
  /** The document this run is keyed by (its concurrency slot in `runs`). */
  documentId: string
  /** #606: see `StartRunArgs.usesModel`. */
  usesModel: boolean
  /** #606: resolves once the runner has settled and `finish` has run (never rejects). */
  settled: Promise<void>
  /** Epoch ms when the run went terminal — drives the TTL sweep (SKA-17). Unset while running. */
  finishedAt?: number
}

const TERMINAL: ReadonlySet<SkillRunState['state']> = new Set(['done', 'failed', 'cancelled'])

// SKA-17 (skills audit 2026-07-03, U6): a terminal run lingers in its slot until the renderer
// acknowledges it (so a finished run's outcome is never lost to a quick unmount / reload). But a
// renderer that CLOSES without acknowledging would leak the entry forever, so a never-acknowledged
// terminal run is swept after this TTL — the Map stays bounded. Generous (a reloaded renderer
// re-adopts + acknowledges well within it); the entry is only an ids/counts snapshot regardless.
const TERMINAL_TTL_MS = 30 * 60 * 1000

export class SkillRunController {
  // Keyed by documentId: unrelated documents/conversations never collide. At most one non-terminal
  // run per document; a terminal run lingers in its slot until the renderer `clear`s it (or the next
  // run on that document replaces it).
  private runs = new Map<string, ActiveRun>()

  /** True while a run on THAT document's slot is running (not terminal). */
  isRunning(documentId: string): boolean {
    const r = this.runs.get(documentId)
    return r != null && !TERMINAL.has(r.state.state)
  }

  /**
   * Start a run. Throws a friendly error if a run is already in flight ON THE SAME DOCUMENT
   * (per-document one-at-a-time — a different document runs concurrently). Kicks the runner off
   * WITHOUT awaiting (the renderer polls `get`); returns the initial `running` snapshot.
   */
  start(args: StartRunArgs): SkillRunState {
    this.sweepTerminal()
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
      progress: { done: 0, total: 0 },
      // SKA-6/SKA-17 (U6): carry the launching conversation + target document onto the content-free
      // run state so the renderer's per-run store can gate the bar to the right conversation and
      // re-adopt/re-pin after a reload. Both are ids (never titles) — the ids/counts posture holds.
      conversationId: args.conversationId,
      documentId: args.documentId
    }
    // Replace this document's slot (a lingering terminal run, if any — the next run supersedes it).
    const entry: ActiveRun = {
      state,
      controller,
      documentId: args.documentId,
      usesModel: args.usesModel === true,
      settled: Promise.resolve()
    }
    this.runs.set(args.documentId, entry)
    const handle = state.runHandle

    entry.settled = args
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
    entry.finishedAt = Date.now() // SKA-17: start the TTL clock for a never-acknowledged terminal run
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
   * The current run on a document's slot (running OR terminal-unacknowledged), or null (SKA-6/SKA-17).
   * Used to surface the RUNNING handle in a busy refusal so the renderer can re-adopt the orphaned run
   * (a reload lost its own store) instead of being stuck with "cancel it first" and nothing to cancel.
   */
  getByDocument(documentId: string): SkillRunState | null {
    const r = this.runs.get(documentId)
    return r ? { ...r.state, progress: { ...r.state.progress } } : null
  }

  /**
   * Every run the controller holds — running AND terminal-but-unacknowledged (SKA-17). A freshly
   * reloaded renderer re-adopts these so an in-flight run keeps its bar and a finished run's outcome
   * is still shown/acknowledgeable. Copies only (never the mutable engine state); ids/counts only.
   */
  list(): SkillRunState[] {
    this.sweepTerminal()
    return Array.from(this.runs.values()).map((r) => ({ ...r.state, progress: { ...r.state.progress } }))
  }

  /** Drop terminal runs a renderer never acknowledged past the TTL, so the Map stays bounded (SKA-17). */
  private sweepTerminal(): void {
    const now = Date.now()
    for (const [key, r] of this.runs) {
      if (TERMINAL.has(r.state.state) && r.finishedAt != null && now - r.finishedAt > TERMINAL_TTL_MS) {
        this.runs.delete(key)
      }
    }
  }

  /** Cancel one run by handle (SKA-25: the IPC boundary requires a non-empty handle). */
  cancel(runHandle: string): void {
    const r = this.findByHandle(runHandle)
    if (r && !TERMINAL.has(r.state.state)) r.controller.abort()
  }

  // ---- #606: the teardown owners' handle ------------------------------------------------------
  //
  // Lock, quit and a model stop or switch kill the chat model under whatever runs on it. A redaction
  // or document-edit run whose OWN signal was still live then took its failure path: redaction fell
  // back to the rule-based floor and opened the save dialog (over the lock screen, after a lock), and
  // an edit ended `editFailed`. Aborting the run's signal first turns the killed request into a cancel
  // the seams already handle (`isAbortError(e, signal)`): nothing is written, the run reads
  // "Stopped. Nothing was saved." An abort cannot close a save dialog that is already open; a user
  // who saves anyway gets `done` (owner decision, #606).
  //
  // Main-side only. SKA-25 removed the renderer's no-arg cancel-all — one window must never stop
  // every run — and the IPC still requires a handle; these are reachable only from the teardowns.

  /** Lock and quit: cancel every running run, whatever its tool. */
  cancelAll(): void {
    for (const r of this.runs.values()) if (!TERMINAL.has(r.state.state)) r.controller.abort()
  }

  /** A stop or switch of the chat model: cancel the runs streaming on it (`StartRunArgs.usesModel`). */
  cancelModelRuns(): void {
    for (const r of this.runs.values()) {
      if (r.usesModel && !TERMINAL.has(r.state.state)) r.controller.abort()
    }
  }

  /**
   * Wait until every run that is still running has settled — its seam recorded the outcome in
   * `skill_runs` — or `timeoutMs` passed. The lock and quit teardowns await it after cancelling, so
   * the cancel is recorded while the database is still open. True when everything settled.
   */
  async awaitSettled(timeoutMs: number): Promise<boolean> {
    const pending = [...this.runs.values()].filter((r) => !TERMINAL.has(r.state.state)).map((r) => r.settled)
    if (pending.length === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.allSettled(pending).then(() => true), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Drop a terminal run once the renderer has shown its outcome (the acknowledge precedent). A still-running handle is a no-op. */
  clear(runHandle: string): void {
    const r = this.findByHandle(runHandle)
    if (r && TERMINAL.has(r.state.state)) this.runs.delete(r.documentId)
  }
}
