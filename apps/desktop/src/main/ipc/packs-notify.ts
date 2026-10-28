import { BrowserWindow } from 'electron'
import { EVENTS } from '../../shared/ipc'
import type { KnowledgePacksChangedEvent } from '../../shared/types'

// The knowledge-pack set's update broadcast (#301 P3b, finding L7; plan §9.17 (e)3): the
// `notify` seam `ZimService` calls after a reconciliation starts or ends and after every
// mutation (register / remove / enable), sent as `packs:changed` to every window. Its own module,
// like `performance-notify.ts`, so the main-to-renderer hop can be tested without the app entry.
//
// Every send is isolated, as in `performance-notify.ts`: `ZimService` notifies AFTER its
// database write, so a recipient that throws must neither block the other windows nor turn a
// pack change that happened into a failed register / remove / enable.

/** Send one pack-set change to every live window. Never throws. */
export function notifyKnowledgePacksChanged(event: KnowledgePacksChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue
      win.webContents.send(EVENTS.knowledgePacksChanged, event)
    } catch {
      /* one dead recipient never blocks the next, nor the change that was announced */
    }
  }
}
