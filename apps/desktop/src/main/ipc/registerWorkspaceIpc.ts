import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { WrongPasswordError } from '../services/workspace-vault'
import { log } from '../services/logging'
import type {
  WorkspaceActionResult,
  WorkspaceMode,
  WorkspaceStateInfo
} from '../../shared/types'

// Phase 9 IPC: the encrypted-workspace lock/unlock lifecycle (spec §7.9).
// A wrong password or a policy refusal is a NORMAL result (`{ ok: false, reason }`),
// not a thrown error, so the unlock gate can re-prompt cleanly.
export function registerWorkspaceIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.getWorkspaceState, (): WorkspaceStateInfo => ctx.workspace.getState())

  ipcMain.handle(IPC.unlockWorkspace, (_e, password: string): WorkspaceActionResult => {
    try {
      const state = ctx.workspace.unlock(password)
      log.info('Workspace unlocked')
      return { ok: true, state }
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        return { ok: false, reason: 'wrong_password', message: 'Incorrect password. Try again.' }
      }
      log.error('Workspace unlock failed', String(err))
      return { ok: false, reason: 'error', message: 'Could not open the workspace.' }
    }
  })

  ipcMain.handle(
    IPC.createWorkspace,
    (_e, password: string, mode: WorkspaceMode): WorkspaceActionResult => {
      try {
        const state = ctx.workspace.create(password, mode)
        log.info('Workspace created', { mode })
        return { ok: true, state }
      } catch (err) {
        // Plaintext refused by policy is the expected non-throwing failure.
        const message = err instanceof Error ? err.message : String(err)
        if (/not permitted/i.test(message)) {
          return { ok: false, reason: 'refused', message }
        }
        log.error('Workspace create failed', message)
        return { ok: false, reason: 'error', message: 'Could not create the workspace.' }
      }
    }
  )

  ipcMain.handle(IPC.lockWorkspace, (): WorkspaceStateInfo => {
    const state = ctx.workspace.lock()
    log.info('Workspace locked')
    return state
  })
}
