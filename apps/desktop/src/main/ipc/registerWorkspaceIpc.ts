import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { VaultBusyError, WrongPasswordError } from '../services/workspace-vault'
import { maybeRunFirstBenchmark } from './registerBenchmarkIpc'
import { maybeAutoStartActiveModel } from './registerModelIpc'
import { inFlightStreams } from './inflight'
import { applyUiLanguageSetting, tMain } from '../services/i18n'
import { getSettings } from '../services/settings'
import { log, attachVaultKey, detachVaultKey, usesPlaintextLog, rekeyVaultLog } from '../services/logging'
import type {
  WorkspaceActionResult,
  WorkspaceMode,
  WorkspaceStateInfo
} from '../../shared/types'

// IPC for the encrypted-workspace lock/unlock lifecycle (spec §7.9).
// A wrong password or a policy refusal is a NORMAL result (`{ ok: false, reason }`),
// not a thrown error, so the unlock gate can re-prompt cleanly.

/** Minimum password length for a new encrypted vault — the at-rest key is only as strong
 * as the password (the salt + KDF params live in the unencrypted descriptor). */
const MIN_PASSWORD_LENGTH = 8

/** Settings just became readable (unlock/create) → re-resolve the main-side UI
 *  language from the real `uiLanguage` setting. Best-effort: a settings read must
 *  never break an unlock. */
function refreshUiLanguage(ctx: AppContext): void {
  try {
    applyUiLanguageSetting(getSettings(ctx.db).uiLanguage)
  } catch {
    /* keep the current (OS-locale) language */
  }
}

/**
 * Point the diagnostics log at the now-resolved workspace. Encrypted → adopt the live vault
 * key so `app.log.enc` is encrypted at rest under the same key as the DB. Plaintext_dev →
 * switch to the plain `app.log` (no key exists). Best-effort: a logging hiccup must never
 * break an unlock/create.
 */
function attachLogKey(ctx: AppContext): void {
  try {
    const key = ctx.workspace.encryptionKey()
    if (key) attachVaultKey(key)
    else usesPlaintextLog()
  } catch {
    /* logging is best-effort */
  }
}

export function registerWorkspaceIpc(ctx: AppContext): void {
  ipcMain.handle(IPC.getWorkspaceState, (): WorkspaceStateInfo => ctx.workspace.getState())

  ipcMain.handle(IPC.unlockWorkspace, (_e, password: string): WorkspaceActionResult => {
    // The renderer is the untrusted boundary in Electron (M-S2): args are TS-typed but
    // arrive unvalidated. A non-string password would throw deep in the vault; reject it
    // here as a clean wrong-password result instead.
    if (typeof password !== 'string') {
      return { ok: false, reason: 'wrong_password', message: tMain('main.workspace.wrongPassword') }
    }
    try {
      const state = ctx.workspace.unlock(password)
      // The vault key is live now — adopt it for the diagnostics log so it is encrypted at
      // rest like the DB, and fold in this session's pre-unlock buffer + any prior history.
      attachLogKey(ctx)
      log.info('Workspace unlocked')
      // Audit: writing this also flushes events buffered while locked —
      // which is how the unlock_failed events below ever reach the log. NEVER the
      // password, in any branch.
      ctx.audit?.('workspace_unlocked', 'Workspace unlocked')
      // Settings are readable now — main-side emissions follow the user's language.
      refreshUiLanguage(ctx)
      // First unlock of a never-benchmarked workspace → background benchmark.
      maybeRunFirstBenchmark(ctx)
      // Bring the selected model's runtime back up in the background.
      maybeAutoStartActiveModel(ctx)
      return { ok: true, state }
    } catch (err) {
      // instanceof PLUS the name: the production rollup bundle can contain a second,
      // tree-shaken copy of workspace-vault (module-id quirk), and the class thrown by
      // the vault is then not the class this file imported — instanceof alone made the
      // friendly wrong-password message unreachable in the built app (vitest runs
      // unbundled and never sees this).
      if (err instanceof WrongPasswordError || (err instanceof Error && err.name === 'WrongPasswordError')) {
        ctx.audit?.('workspace_unlock_failed', 'Workspace unlock failed (wrong password)')
        // §7 voice: describe the problem and the next step, no jargon. Localized at
        // emission (D-L5) — ephemeral, never persisted; English value unchanged.
        return {
          ok: false,
          reason: 'wrong_password',
          message: tMain('main.workspace.wrongPassword')
        }
      }
      log.error('Workspace unlock failed', String(err))
      ctx.audit?.('workspace_unlock_failed', 'Workspace unlock failed')
      return { ok: false, reason: 'error', message: tMain('main.workspace.openFailed') }
    }
  })

  ipcMain.handle(
    IPC.createWorkspace,
    (_e, password: string, mode: WorkspaceMode): WorkspaceActionResult => {
      // M-S2: validate the renderer-supplied shapes FIRST. `password.length` used to be
      // read OUTSIDE the try/catch, so a non-string password was an unhandled TypeError
      // at the IPC boundary instead of a clean refusal. `mode` must be a known enum too.
      if (mode !== 'encrypted' && mode !== 'plaintext_dev') {
        return { ok: false, reason: 'error', message: tMain('main.workspace.createFailed') }
      }
      if (typeof password !== 'string') {
        return {
          ok: false,
          reason: 'refused',
          message: tMain('main.workspace.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
        }
      }
      if (mode === 'encrypted' && password.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          reason: 'refused',
          message: tMain('main.workspace.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
        }
      }
      try {
        const state = ctx.workspace.create(password, mode)
        // Encrypted: adopt the fresh vault key for the log. Plaintext_dev: switch the log to
        // the plain file (`attachLogKey` dispatches on the workspace mode).
        attachLogKey(ctx)
        log.info('Workspace created', { mode })
        ctx.audit?.('workspace_created', 'Workspace created', { mode })
        // Settings are readable now — main-side emissions follow the user's language.
        refreshUiLanguage(ctx)
        // A fresh workspace has never been benchmarked → background benchmark.
        maybeRunFirstBenchmark(ctx)
        // A fresh workspace has no active model yet; this is a no-op then, but covers
        // re-created vaults that restored settings.
        maybeAutoStartActiveModel(ctx)
        return { ok: true, state }
      } catch (err) {
        // Plaintext refused by policy, and create-over-an-existing-vault (would wipe
        // the user's data), are expected refusals — surface the real message.
        const message = err instanceof Error ? err.message : String(err)
        if (/not permitted|already exists/i.test(message)) {
          return { ok: false, reason: 'refused', message }
        }
        log.error('Workspace create failed', message)
        return { ok: false, reason: 'error', message: tMain('main.workspace.createFailed') }
      }
    }
  )

  // Change the vault password. Runs UNLOCKED only; a wrong current password
  // is a NORMAL failure result audited in the existing unlock-failure class (never a
  // new event, never the password). On a legacy v1 vault the first change runs the
  // one-time journaled migration to the v2 envelope — it can take a while on a big
  // document corpus, so the renderer shows honest progress copy while this resolves.
  ipcMain.handle(
    IPC.changeWorkspacePassword,
    (_e, currentPassword: string, nextPassword: string): WorkspaceActionResult => {
      // M-S2: a non-string current password would throw in the vault verifier — treat it
      // as a wrong-current-password result (the new-password shape is validated below).
      if (typeof currentPassword !== 'string') {
        return { ok: false, reason: 'wrong_password', message: tMain('main.workspace.wrongCurrentPassword') }
      }
      if (typeof nextPassword !== 'string' || nextPassword.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          reason: 'refused',
          message: tMain('main.workspace.newPasswordTooShort', { min: MIN_PASSWORD_LENGTH })
        }
      }
      if (!ctx.workspace.isUnlocked()) {
        return {
          ok: false,
          reason: 'refused',
          message: tMain('main.workspace.unlockBeforeChange')
        }
      }
      try {
        const state = ctx.workspace.changePassword(currentPassword, nextPassword)
        // A v1→v2 migration swaps in a NEW data key and zeroes the old one (v2 keeps the same
        // key). Re-seal the diagnostics log under the now-current key, carrying the in-memory
        // buffer across unchanged — `rekeyVaultLog` deliberately does NOT re-load from disk,
        // which would discard history under a rotated key or double it under an unchanged one.
        const key = ctx.workspace.encryptionKey()
        if (key) rekeyVaultLog(key)
        log.info('Workspace password changed') // never the passwords, in any branch
        // Audit: id-free, content-free, success only.
        ctx.audit?.('workspace_password_changed', 'Workspace password changed')
        return { ok: true, state }
      } catch (err) {
        // The change did not commit, so the vault still holds the ORIGINAL key and the log was
        // never detached — nothing to re-adopt; it keeps writing under the unchanged key.
        // instanceof PLUS the name — same bundle-duplication quirk as unlockWorkspace.
        if (err instanceof WrongPasswordError || (err instanceof Error && err.name === 'WrongPasswordError')) {
          ctx.audit?.('workspace_unlock_failed', 'Workspace password change failed (wrong current password)')
          return {
            ok: false,
            reason: 'wrong_password',
            message: tMain('main.workspace.wrongCurrentPassword')
          }
        }
        if (err instanceof VaultBusyError || (err instanceof Error && err.name === 'VaultBusyError')) {
          return { ok: false, reason: 'refused', message: err.message }
        }
        log.error('Workspace password change failed', String(err))
        return {
          ok: false,
          reason: 'error',
          message: tMain('main.workspace.changeFailed')
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
    // `suspend()` (not `stop()`): the sidecars must come back lazily
    // after unlock — `stop()` latches permanently for the will-quit path and used to
    // leave every post-lock/unlock embed failing with "Embedder is stopped".
    await Promise.allSettled([
      ctx.runtime.stop(),
      ctx.embedder.suspend?.() ?? ctx.embedder.stop?.() ?? Promise.resolve(),
      ctx.reranker?.suspend?.() ?? Promise.resolve(),
      // Kill any in-flight whisper-cli child (it is reading decrypted audio;
      // the failing parse marks that document `failed`, and processDocument's finally
      // shreds the decrypted transient). Per-file CLI — next use just respawns.
      ctx.transcriber?.suspend?.() ?? Promise.resolve()
    ])
    // Recorded BEFORE the vault closes — afterwards the DB is unreachable.
    ctx.audit?.('workspace_locked', 'Workspace locked')
    // Flush the encrypted diagnostics log while the key is still live, then drop it —
    // lock() zeroes the key, after which the log can no longer be persisted. The next
    // unlock re-attaches and continues the same `app.log.enc`.
    detachVaultKey()
    const state = ctx.workspace.lock()
    log.info('Workspace locked (sidecars stopped)')
    return state
  })
}
