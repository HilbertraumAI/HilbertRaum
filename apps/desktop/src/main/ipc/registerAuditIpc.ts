import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { AuditEvent } from '../../shared/types'
import { AUDIT_MAX_ROWS, listAuditEvents } from '../services/audit'
import { log } from '../services/logging'

// IPC for the Diagnostics "Activity" panel over the audit log (spec §7.11).
// Read-only + export-to-file; recording happens at the other IPC modules' call sites
// (see services/audit.ts). The log is FOR THE USER and strictly local — listing and
// exporting are the only ways it leaves the workspace DB, both user actions.

export function registerAuditIpc(ctx: AppContext): void {
  // Newest-first page; `beforeId` is the pagination cursor ("Load more"). The type
  // filter lives in the renderer (client-side over loaded pages).
  ipcMain.handle(
    IPC.getAuditEvents,
    (_e, limit?: number, beforeId?: string | null): AuditEvent[] =>
      listAuditEvents(ctx.db, { limit, beforeId })
  )

  // Save the whole retained log to a user-chosen file (the exportConversation
  // precedent: dialog in MAIN, returns the path or null on cancel). JSON — the log is
  // structured data; a compliance reader wants machine-readable.
  ipcMain.handle(IPC.exportAuditLog, async (): Promise<string | null> => {
    const events = listAuditEvents(ctx.db, { limit: AUDIT_MAX_ROWS })
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Export activity log',
      defaultPath: 'activity-log.json',
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'Text', extensions: ['txt'] }
      ]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, JSON.stringify(events, null, 2), 'utf8')
    log.info('Activity log exported', { events: events.length })
    return result.filePath
  })
}
