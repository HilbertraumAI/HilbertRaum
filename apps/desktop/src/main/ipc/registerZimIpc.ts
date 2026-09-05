import { BrowserWindow, dialog } from 'electron'
import { guardedHandleFor } from './guarded-handle'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { KnowledgePack } from '../../shared/types'
import type { PackArticle } from '../services/zim'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { workspaceAdmitsWork } from '../services/workspace-vault'

// IPC for knowledge packs (ZIM wave). All registration state lives in the workspace DB
// (requireUnlocked); the archives themselves are plain read-only files.
//
// Path-trust rule: there is NO channel that accepts a renderer-supplied archive path.
// `packs:add` opens the native dialog AND registers the chosen files inside one main-side
// handler (stricter than the docs pickerToken pattern — packs need no two-phase preflight,
// so the path never crosses the bridge at all).
//
// Audit privacy: pack ids (archive UUIDs) + sizes/counts only. The pack TITLE and FILENAME
// name what the user reads — content by the export rule, like project names (sentinel-grep
// enforced in tests/integration/audit-ipc.test.ts).

export function registerZimIpc(ctx: AppContext): void {
  const ipcHandle = guardedHandleFor(ctx)
  const requireUnlocked = (): void => {
    // AUD-02: workspaceAdmitsWork, never a bare isUnlocked() (see registerCollectionsIpc).
    if (!workspaceAdmitsWork(ctx.workspace)) {
      throw new Error(tMain('main.docs.locked'))
    }
  }
  const zim = (): NonNullable<AppContext['zim']> => {
    if (!ctx.zim) throw new Error(tMain('main.zim.unavailable'))
    return ctx.zim
  }

  ipcHandle(IPC.getKnowledgePackStatus, (): { toolsInstalled: boolean } => {
    return { toolsInstalled: ctx.zim?.toolsInstalled() ?? false }
  })

  // DATABASE-ONLY (#301 P3b, finding L7). This handler used to run a full drive discovery
  // first — one `kiwix-manage` spawn with a 30 s timeout per unknown file — on Chat mount, on
  // panel open and after every toggle. Reconciliation is now a serialized background pass at
  // session start and on an explicit Refresh; the list is a pure read of the registry, with no
  // filesystem probe and no availability UPDATE.
  ipcHandle(IPC.listKnowledgePacks, (): KnowledgePack[] => {
    requireUnlocked()
    return zim().listPacks(ctx.db)
  })

  ipcHandle(IPC.addKnowledgePacks, async (): Promise<KnowledgePack[] | null> => {
    requireUnlocked()
    const svc = zim()
    // H4 — the PICKER WAIT is itself a registered operation, opened BEFORE the dialog is
    // awaited. The OS dialog cannot be cancelled, so a user who clicks "Lock now" with the
    // file browser open still gets a resolution here seconds (or minutes) later, against a
    // workspace that has locked — or locked and unlocked again into a NEW session with a NEW
    // database. The operation belongs to the SERVICE, so the lock/quit `zimOps.abortAll()`
    // reaches it, and `assert()` on the dialog result is what refuses the late completion.
    const op = svc.beginRegistration()
    try {
      const options = {
        title: tMain('main.zim.dialogTitle'),
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [
          { name: tMain('main.zim.filterZim'), extensions: ['zim'] },
          { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
        ]
      }
      const win = BrowserWindow.getFocusedWindow()
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      try {
        op.assert()
      } catch {
        // The same friendly locked copy every other refused surface uses: the user chose files
        // for a workspace that no longer admits them.
        throw new Error(tMain('main.docs.locked'))
      }
      if (result.canceled || result.filePaths.length === 0) return null
      const added: KnowledgePack[] = []
      const failures: string[] = []
      for (const path of result.filePaths) {
        try {
          // Every file of one "Add packs" runs under the SAME operation, so one abort stops
          // the whole batch rather than only the file in flight.
          const pack = await svc.registerPack(ctx.db, path, op)
          added.push(pack)
          ctx.audit?.('knowledge_pack_added', 'Knowledge pack registered', {
            packId: pack.id,
            sizeBytes: pack.sizeBytes,
            articleCount: pack.articleCount
          })
        } catch (err) {
          // A cancellation is NOT a per-archive failure: the workspace stopped admitting this
          // add while the manager was running, so it wears the locked copy like the late
          // picker above rather than "the archive could not be added".
          try {
            op.assert()
          } catch {
            throw new Error(tMain('main.docs.locked'))
          }
          failures.push(err instanceof Error ? err.message : String(err))
        }
      }
      if (added.length === 0 && failures.length > 0) {
        throw new Error(tMain('main.zim.addFailed', { reason: failures[0] }))
      }
      return added
    } finally {
      op.release()
    }
  })

  ipcHandle(IPC.removeKnowledgePack, (_e, id: string): void => {
    requireUnlocked()
    if (zim().removePack(ctx.db, id)) {
      ctx.audit?.('knowledge_pack_removed', 'Knowledge pack removed', { packId: id })
    }
  })

  ipcHandle(IPC.setKnowledgePackEnabled, (_e, id: string, enabled: boolean): void => {
    requireUnlocked()
    zim().setPackEnabled(ctx.db, id, enabled)
  })

  ipcHandle(
    IPC.getPackArticle,
    async (_e, packId: string, articlePath: string): Promise<PackArticle | null> => {
      requireUnlocked()
      if (typeof packId !== 'string' || typeof articlePath !== 'string') return null
      try {
        return await zim().getArticle(ctx.db, packId, articlePath)
      } catch (err) {
        // The viewer shows an honest "unavailable" state; the reason goes to the log only.
        log.warn('Pack article read failed', String(err))
        return null
      }
    }
  )
}
