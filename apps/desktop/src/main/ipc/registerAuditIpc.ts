import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { AuditEvent } from '../../shared/types'
import { AUDIT_MAX_ROWS, listAuditEvents } from '../services/audit'
import { log } from '../services/logging'
import { tMain } from '../services/i18n'
import { saveTextExport } from './save-export'

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
    const filePath = await saveTextExport(
      {
        title: tMain('main.dialog.exportAudit'),
        defaultPath: 'activity-log.json',
        filters: [
          { name: 'JSON', extensions: ['json'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      },
      JSON.stringify(events, null, 2)
    )
    if (!filePath) return null
    log.info('Activity log exported', { events: events.length })
    return filePath
  })
}
