import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { WrongPasswordError } from '../services/workspace-vault'
import { maybeRunFirstBenchmark } from './registerBenchmarkIpc'
import { maybeAutoStartActiveModel } from './registerModelIpc'
import { log } from '../services/logging'
import type {
  WorkspaceActionResult,
  WorkspaceMode,
  WorkspaceStateInfo
} from '../../shared/types'

// Phase 9 IPC: the encrypted-workspace lock/unlock lifecycle (spec §7.9).
// A wrong password or a policy refusal is a NORMAL result (`{ ok: false, reason }`),
// not a thrown error, so the unlock gate can re-prompt cleanly.

/** Minimum password length for a new encrypted vault — the at-rest key is only as strong
 * as the password (the salt + KDF params live in the unencrypted descriptor). */
const MIN_PASSWORD_LENGTH = 8

export function registerWorkspaceIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.getWorkspaceState, (): WorkspaceStateInfo => ctx.workspace.getState())

  ipcMain.handle(IPC.unlockWorkspace, (_e, password: string): WorkspaceActionResult => {
    try {
      const state = ctx.workspace.unlock(password)
      log.info('Workspace unlocked')
      // First unlock of a never-benchmarked workspace → background benchmark (M12).
      maybeRunFirstBenchmark(ctx)
      // Bring the selected model's runtime back up in the background (post-MVP polish).
      maybeAutoStartActiveModel(ctx)
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
      if (mode === 'encrypted' && password.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          reason: 'refused',
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
        }
      }
      try {
        const state = ctx.workspace.create(password, mode)
        log.info('Workspace created', { mode })
        // A fresh workspace has never been benchmarked → background benchmark (M12).
        maybeRunFirstBenchmark(ctx)
        // A fresh workspace has no active model yet; this is a no-op then, but covers
        // re-created vaults that restored settings.
        maybeAutoStartActiveModel(ctx)
        return { ok: true, state }
      } catch (err) {
        // Plaintext refused by policy, and create-over-an-existing-vault (H4: would wipe
        // the user's data), are expected refusals — surface the real message.
        const message = err instanceof Error ? err.message : String(err)
        if (/not permitted|already exists/i.test(message)) {
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
