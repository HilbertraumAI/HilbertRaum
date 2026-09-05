import { log } from '../logging'
import { workspaceAdmitsWork } from '../workspace-vault'
import type { AppContext } from '../context'

// The knowledge-pack SESSION-START seam (#301 P3b, finding L7; owner ruling D3).
//
// Three seams open a session — the unlock handler, the create handler and the plaintext-dev
// startup — and each one calls this right after `maybeStartLocalApi(ctx)`, whose shape it
// mirrors. Two things happen per session and only per session:
//
//   1. the workspace's own `zim-transient/` directory is cleaned (whatever a crash, an
//      unconfirmed child or a previous lock left behind), and
//   2. the drive folder is reconciled once in the background.
//
// D3: NEVER on the unlock/create critical path. The `setTimeout(0)` puts the whole pass after
// the handler's promise has resolved and the UI is admitted, so a 30 s manager spawn can never
// sit between the user's password and their workspace. The pass re-checks admission when it
// finally runs (an unlock immediately followed by a lock must do nothing), and the
// reconciliation is itself a registered `zim-reconcile` operation, so a lock aborts it and a
// new epoch rejects its late writes.

/**
 * Schedule this session's knowledge-pack pass. Fire-and-forget and fully best-effort: nothing
 * here may reject into an unlock, and nothing here blocks it.
 */
export function startKnowledgePackSession(ctx: AppContext): void {
  const timer = setTimeout(() => {
    void runSessionPass(ctx)
  }, 0)
  // Never hold the event loop open for this (quit must not wait on a scheduled reconcile).
  timer.unref?.()
}

async function runSessionPass(ctx: AppContext): Promise<void> {
  try {
    // The unlock may already have been followed by a lock — or by a lock that failed and left
    // the workspace open under the SAME epoch. Admission is the gate either way.
    if (!workspaceAdmitsWork(ctx.workspace)) return
    const zim = ctx.zim
    if (!zim) return
    const report = zim.cleanupTransients('session-start')
    if (report.confirmed) {
      log.info('Session start: ZIM transients cleaned', { removed: report.removed })
    } else {
      // Counts only — never a pack title, never a path (the sentinel rule).
      log.warn('Session start: ZIM cleanup NOT confirmed', {
        kept: report.kept,
        unknownEntries: report.unknownEntries,
        unsettledOps: report.unsettledOps,
        unconfirmedChildren: report.unconfirmedChildren
      })
    }
    // Step 2 of P3b replaces this with `reconcile(ctx.db)`; the seam, the timing and the
    // operation kind are what this file owns.
    await zim.discoverDrivePacks(ctx.db)
  } catch (err) {
    log.warn('Knowledge-pack session start failed (non-fatal)', String(err))
  }
}
