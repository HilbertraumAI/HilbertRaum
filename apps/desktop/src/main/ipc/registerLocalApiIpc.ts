import { ipcMain, clipboard } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import { workspaceAdmitsWork } from '../services/workspace-vault'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { getOrCreateToken, maskToken, readToken, rotateToken } from '../services/local-api/token'
import { localApiServerAddress } from '../../shared/local-api'
import { DEFAULT_SETTINGS, type LocalApiConnectionInfo } from '../../shared/types'
import { getSettings } from '../services/settings'

// IPC for the local API's access key (local-api wave P4). Everything else about the
// endpoint rides `settings:update` (the toggles + port) and `app:getAppStatus` (live
// state); these three channels exist for ONE reason: the full key must never cross to
// the renderer. It is minted, masked, copied, and rotated main-side only.

/** Best-effort clipboard clear (PRIV-M5): a synced/history-backed clipboard can carry the
 *  key off the device, so a copy does not sit there forever. Only clears if the clipboard
 *  STILL holds the same key — never stomps on whatever the user copied since. */
const CLIPBOARD_CLEAR_MS = 60_000

export function registerLocalApiIpc(ctx: AppContext): void {
  // AUD-02: the token store lives in the workspace DB, so every handler here needs the
  // admits-work predicate (unlocked ∧ not locking), never a bare isUnlocked().
  const requireUnlocked = (): void => {
    if (!workspaceAdmitsWork(ctx.workspace)) throw new Error(tMain('main.settings.locked'))
  }

  /** The port to advertise: the one actually bound when the server runs, else the saved
   *  setting — so the address is correct before the first start and after a re-port. */
  const advertisedPort = (): number => {
    const running = ctx.localApi?.status().port
    if (running != null) return running
    return getSettings(ctx.db).localApiPort ?? DEFAULT_SETTINGS.localApiPort
  }

  ipcMain.handle(IPC.localApiConnectionInfo, (): LocalApiConnectionInfo => {
    requireUnlocked()
    const settings = getSettings(ctx.db)
    // Mint on demand only when a key is actually required; with auth off we show the
    // existing key if one was ever made, and write nothing.
    const token = settings.localApiTokenRequired ? getOrCreateToken(ctx.db) : readToken(ctx.db)
    return {
      serverAddress: localApiServerAddress(advertisedPort()),
      maskedKey: token != null ? maskToken(token) : null
    }
  })

  ipcMain.handle(IPC.localApiCopyKey, (): boolean => {
    requireUnlocked()
    try {
      const token = getOrCreateToken(ctx.db)
      clipboard.writeText(token)
      const timer = setTimeout(() => {
        try {
          if (clipboard.readText() === token) clipboard.clear()
        } catch {
          // A clipboard owned by another app / an unavailable one is not an error here.
        }
      }, CLIPBOARD_CLEAR_MS)
      // Never hold quit open for the clear — an exiting app takes its clipboard copy with it.
      timer.unref?.()
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.localApiRegenerateToken, (): LocalApiConnectionInfo => {
    requireUnlocked()
    const token = rotateToken(ctx.db)
    // The old key is dead the instant rotateToken returns — but auth is checked ONCE at
    // admission, so an already-streaming request would outlive it and make the card's
    // "apps using the old key stop working" claim false (SEC-F6). Kill them here.
    ctx.localApi?.abortExternalRequests('access key regenerated')
    log.info('Local API access key regenerated')
    return {
      serverAddress: localApiServerAddress(advertisedPort()),
      maskedKey: maskToken(token)
    }
  })
}
