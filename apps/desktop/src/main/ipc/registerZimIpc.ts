import { BrowserWindow, dialog } from 'electron'
import { guardedHandleFor } from './guarded-handle'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  KnowledgePack,
  KnowledgePackAddFailureReason,
  KnowledgePackAddResult,
  KnowledgePackStatus
} from '../../shared/types'
import type { PackArticle } from '../services/zim'
import { ArticlePathError } from '../services/zim/client'
import { KiwixManageError } from '../services/zim/tools'
import { ZimHeaderError } from '../services/zim/identity'
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

/**
 * Map a per-file registration failure to a reason CODE — never the raw message or a path (#301
 * P5, finding L1, plan §9.19 (c)1). `ZimHeaderError` ⇒ the file is not a readable ZIM archive;
 * the "kiwix-tools is not installed" refusal (`ZimService.packDeps`) ⇒ tools missing;
 * `KiwixManageError` or the header/manager identity disagreement (`packs.ts registerPack`) ⇒
 * a manager problem; anything else ⇒ 'other'.
 */
function classifyAddFailure(err: unknown): KnowledgePackAddFailureReason {
  if (err instanceof ZimHeaderError) return 'not-a-zim'
  if (err instanceof KiwixManageError) return 'manager'
  if (err instanceof Error && /kiwix-tools is not installed/.test(err.message)) return 'tools-missing'
  if (err instanceof Error && /reported a different archive identity/.test(err.message)) return 'manager'
  return 'other'
}

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

  ipcHandle(IPC.getKnowledgePackStatus, (): KnowledgePackStatus => {
    const svc = ctx.zim
    if (!svc) return { toolsInstalled: false, refreshing: false, revision: 0, excluded: null }
    // In-memory reads only — this is the ONE lock-exempt `packs:*` channel. `excluded` (#340,
    // D-Z16) is the service's last computed collision list, copied for the wire.
    const excluded = svc.excluded()
    return {
      toolsInstalled: svc.toolsInstalled(),
      refreshing: svc.refreshing(),
      revision: svc.revision(),
      excluded: excluded === null ? null : excluded.map((e) => ({ packId: e.packId, collidesWith: e.collidesWith }))
    }
  })

  // Kick off a background reconciliation pass (#301 P3b, finding L7, plan §9.17 (e)2). Never
  // awaited here — the handler returns at once and completion arrives via the `packs:changed`
  // event, so a slow drive-file pass never blocks the "Refresh" click. Best-effort: a reconcile
  // failure is logged, not thrown, because the caller already got its `{ started: true }`.
  ipcHandle(IPC.refreshKnowledgePacks, (): { started: boolean } => {
    requireUnlocked()
    zim()
      .reconcile(ctx.db)
      .catch((err) => {
        log.warn('Knowledge-pack refresh failed', String(err))
      })
    return { started: true }
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

  ipcHandle(IPC.addKnowledgePacks, async (): Promise<KnowledgePackAddResult> => {
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
        // for a workspace that no longer admits them. A late/lock-mid-batch outcome REJECTS —
        // it is not one of the admitted outcomes the DTO below represents (#301 P5, finding L1).
        throw new Error(tMain('main.docs.locked'))
      }
      if (result.canceled || result.filePaths.length === 0) {
        return { outcome: 'cancelled', added: [], failed: 0, failureReason: null }
      }
      const added: KnowledgePack[] = []
      let failed = 0
      let failureReason: KnowledgePackAddFailureReason | null = null
      for (const path of result.filePaths) {
        try {
          // Every file of one "Add packs" runs under the SAME operation, so one abort stops
          // the whole batch rather than only the file in flight.
          const pack = await svc.registerPack(ctx.db, path, op)
          added.push(pack)
          // Audit records only ACTUALLY ADDED packs (ids/counts only) — never a failed file.
          ctx.audit?.('knowledge_pack_added', 'Knowledge pack registered', {
            packId: pack.id,
            sizeBytes: pack.sizeBytes,
            articleCount: pack.articleCount
          })
        } catch (err) {
          // A cancellation is NOT a per-archive failure: the workspace stopped admitting this
          // add while the manager was running, so it wears the locked copy like the late
          // picker above rather than becoming one more entry in the DTO's `failed` count.
          try {
            op.assert()
          } catch {
            throw new Error(tMain('main.docs.locked'))
          }
          failed++
          const reason = classifyAddFailure(err)
          if (failureReason === null) failureReason = reason
          // Protected diagnostic ONLY: the error class + reason code, never the message or the
          // path (#301 P5, finding L1) — the manager's own stderr can carry an absolute path.
          log.warn('Knowledge pack registration failed', {
            reason,
            error: err instanceof Error ? err.constructor.name : 'UnknownError'
          })
        }
      }
      const outcome: KnowledgePackAddResult['outcome'] =
        added.length === 0 ? 'failure' : failed === 0 ? 'success' : 'partial'
      // #340 (D-Z15): confirm the new packs' full-text capability in the background — ONCE per
      // batch, after the loop, never per file. Scheduled, so the result below returns first.
      if (added.length > 0) svc.scheduleSearchabilityProbe(() => ctx.db)
      return { outcome, added, failed, failureReason }
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
    const changed = zim().setPackEnabled(ctx.db, id, enabled)
    // #340 (D-Z15): a pack enabled after the session's reconcile was skipped by that probe
    // (it covers enabled ∧ available rows only), so it would stay unknown until a Refresh.
    if (changed && enabled) zim().scheduleSearchabilityProbe(() => ctx.db)
  })

  ipcHandle(
    IPC.getPackArticle,
    async (_e, packId: string, articlePath: string): Promise<PackArticle | null> => {
      requireUnlocked()
      if (typeof packId !== 'string' || typeof articlePath !== 'string') return null
      try {
        return await zim().getArticle(ctx.db, packId, articlePath)
      } catch (err) {
        // The viewer shows an honest "unavailable" state. Only the error CLASS NAME (plus an
        // ArticlePathError's reason code) goes to the log — never `String(err)`, whose message
        // could carry a path for some other error class (#301 P5, finding L5).
        log.warn('Pack article read failed', {
          error: err instanceof Error ? err.constructor.name : 'UnknownError',
          reason: err instanceof ArticlePathError ? err.reason : undefined
        })
        return null
      }
    }
  )
}
