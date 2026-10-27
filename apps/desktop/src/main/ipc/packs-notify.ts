import { BrowserWindow } from 'electron'
import { EVENTS } from '../../shared/ipc'
import type { KnowledgePacksChangedEvent } from '../../shared/types'

// The knowledge-pack set's update broadcast (#301 P3b, finding L7; plan §9.17 (e)3): the
// `notify` seam `ZimService` calls after a reconciliation starts or ends and after every
// mutation (register / remove / enable), sent as `packs:changed` to every window. Its own module,
// like `performance-notify.ts`, so the main-to-renderer hop can be tested without the app entry.

/** Send one pack-set change to every window — guarded per window, since a change can land
 *  between a window closing and its `BrowserWindow` leaving `getAllWindows()`. */
export function notifyKnowledgePacksChanged(event: KnowledgePacksChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVENTS.knowledgePacksChanged, event)
  }
}
