import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { VaultBusyError, WrongPasswordError } from '../services/workspace-vault'
import { maybeRunFirstBenchmark } from './registerBenchmarkIpc'
import { maybeAutoStartActiveModel } from './registerModelIpc'
import { inFlightStreams } from './inflight'
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
      // Audit (Phase 19): writing this also flushes events buffered while locked —
      // which is how the unlock_failed events below ever reach the log. NEVER the
      // password, in any branch.
      ctx.audit?.('workspace_unlocked', 'Workspace unlocked')
      // First unlock of a never-benchmarked workspace → background benchmark (M12).
      maybeRunFirstBenchmark(ctx)
      // Bring the selected model's runtime back up in the background (post-MVP polish).
      maybeAutoStartActiveModel(ctx)
      return { ok: true, state }
    } catch (err) {
      // instanceof PLUS the name: the production rollup bundle can contain a second,
      // tree-shaken copy of workspace-vault (module-id quirk), and the class thrown by
      // the vault is then not the class this file imported — instanceof alone made the
      // friendly wrong-password message unreachable in the built app (found by the
      // Phase-27 eyeball walk; vitest runs unbundled and never sees it).
      if (err instanceof WrongPasswordError || (err instanceof Error && err.name === 'WrongPasswordError')) {
        ctx.audit?.('workspace_unlock_failed', 'Workspace unlock failed (wrong password)')
        // §7 voice: describe the problem and the next step, no jargon.
        return {
          ok: false,
          reason: 'wrong_password',
          message: "That password didn't unlock your workspace. Check it and try again."
        }
      }
      log.error('Workspace unlock failed', String(err))
      ctx.audit?.('workspace_unlock_failed', 'Workspace unlock failed')
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
        ctx.audit?.('workspace_created', 'Workspace created', { mode })
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

  // Phase 32: change the vault password. Runs UNLOCKED only; a wrong current password
  // is a NORMAL failure result audited in the existing unlock-failure class (never a
  // new event, never the password). On a legacy v1 vault the first change runs the
  // one-time journaled migration to the v2 envelope — it can take a while on a big
  // document corpus, so the renderer shows honest progress copy while this resolves.
  ipcMain.handle(
    IPC.changeWorkspacePassword,
    (_e, currentPassword: string, nextPassword: string): WorkspaceActionResult => {
      if (typeof nextPassword !== 'string' || nextPassword.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          reason: 'refused',
          message: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`
        }
      }
      if (!ctx.workspace.isUnlocked()) {
        return {
          ok: false,
          reason: 'refused',
          message: 'Unlock the workspace before changing its password.'
        }
      }
      try {
        const state = ctx.workspace.changePassword(currentPassword, nextPassword)
        log.info('Workspace password changed') // never the passwords, in any branch
        // Audit (additive Phase-32 event): id-free, content-free, success only.
        ctx.audit?.('workspace_password_changed', 'Workspace password changed')
        return { ok: true, state }
      } catch (err) {
        // instanceof PLUS the name — same bundle-duplication quirk as unlockWorkspace.
        if (err instanceof WrongPasswordError || (err instanceof Error && err.name === 'WrongPasswordError')) {
          ctx.audit?.('workspace_unlock_failed', 'Workspace password change failed (wrong current password)')
          return {
            ok: false,
            reason: 'wrong_password',
            message: "That doesn't match your current password. Check it and try again."
          }
        }
        if (err instanceof VaultBusyError || (err instanceof Error && err.name === 'VaultBusyError')) {
          return { ok: false, reason: 'refused', message: err.message }
        }
        log.error('Workspace password change failed', String(err))
        return {
          ok: false,
          reason: 'error',
          message: 'Could not change the password. Your current password still works.'
        }
      }
    }
  )

  ipcMain.handle(IPC.lockWorkspace, async (): Promise<WorkspaceStateInfo> => {
    // "Lock now" must leave nothing user-derived running: a llama-server sidecar keeps
    // recent prompts in its in-memory KV cache (the reranker additionally saw recent
    // questions + chunk text), so ALL sidecars are stopped BEFORE the vault re-encrypts.
    // In-flight generations are aborted first (their partial replies persist while the
    // DB is still open); the E5 embedder + reranker restart lazily on next use, and the
    // chat runtime comes back via the unlock auto-start.
    for (const controller of inFlightStreams.values()) controller.abort()
    // `suspend()` (not `stop()`, Phase 21 fix): the sidecars must come back lazily
    // after unlock — `stop()` latches permanently for the will-quit path and used to
    // leave every post-lock/unlock embed failing with "Embedder is stopped".
    await Promise.allSettled([
      ctx.runtime.stop(),
      ctx.embedder.suspend?.() ?? ctx.embedder.stop?.() ?? Promise.resolve(),
      ctx.reranker?.suspend?.() ?? Promise.resolve(),
      // Phase 36: kill any in-flight whisper-cli child (it is reading decrypted audio;
      // the failing parse marks that document `failed`, and processDocument's finally
      // shreds the decrypted transient). Per-file CLI — next use just respawns.
      ctx.transcriber?.suspend?.() ?? Promise.resolve()
    ])
    // Recorded BEFORE the vault closes — afterwards the DB is unreachable.
    ctx.audit?.('workspace_locked', 'Workspace locked')
    const state = ctx.workspace.lock()
    log.info('Workspace locked (sidecars stopped)')
    return state
  })
}
