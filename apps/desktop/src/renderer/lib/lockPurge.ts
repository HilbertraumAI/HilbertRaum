import { clearTranslateSession } from './translateSession'
import { clearFileTranslate } from './fileTranslateSession'
import { clearVisionSession } from './visionSession'

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
}
