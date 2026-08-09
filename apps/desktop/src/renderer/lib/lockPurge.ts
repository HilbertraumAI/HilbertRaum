import { clearTranslateSession } from './translateSession'
import { clearFileTranslate } from './fileTranslateSession'
import { clearVisionSession } from './visionSession'
import { purgeReviewSession } from './reviewSession'
import { clearDocTaskSession } from './doctasks'
import { clearSkillRunSession } from './skillruns'
import { clearSkillDetailRequest } from './skillDetailRequest'

// The single renderer lock seam (TA-2 / H3). The Translate text/document stores and the vision
// store are module-level ON PURPOSE — a running job keeps streaming when you navigate away and
// back, so they deliberately OUTLIVE screen unmounts and are NOT purged by React lifecycle.
//
// Workspace lock unmounts every screen the instant `lockWorkspace` resolves (App swaps the whole
// shell to WorkspaceGate). So the old per-screen purge effects gated on a component-state `locked`
// flag could NEVER observe `locked === true` before their screen was gone — dead code that left
// the source text, streamed translation, materialized preview, and image/answer resident in
// renderer memory for the whole locked period (contradicting each store's "dropped on lock"
// contract). This helper moves the purge to where the lock actually happens: every lock initiator
// (today only `App.lockNow`) calls it AFTER main has aborted the jobs, purged its maps, and
// re-encrypted the vault — so the resident plaintext here is dropped in lockstep with main.

/** Drop all resident per-session renderer content at the real workspace-lock seam. */
export function purgeSessionStores(): void {
  clearTranslateSession()
  clearFileTranslate()
  clearVisionSession()
  // Evidence review (EP-1 plan §7.5): decrypted answer/source snapshots + notes. Pending
  // auto-save edits were already flushed by App.lockNow BEFORE lockWorkspace (the vault
  // must still be writable for the flush); this drops the resident copy in lockstep.
  purgeReviewSession()
  // SH-4 (#149, subsumes DOC-9): the ids/counts-only WATCHER stores. Content-wise the seam
  // above was already complete, but these kept their 400 ms intervals firing IPC against the
  // locked workspace until the give-up parked `stateUnknown` rows that SURVIVED into the next
  // unlock for tasks/runs main had already aborted; the skill-detail mailbox could pop a
  // stale modal on the next Skills visit.
  clearDocTaskSession()
  clearSkillRunSession()
  clearSkillDetailRequest()
}
