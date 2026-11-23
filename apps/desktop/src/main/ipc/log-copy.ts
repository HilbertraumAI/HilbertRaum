import { clipboard } from 'electron'
import type { GuardedHandler } from './guarded-handle'
import { IPC } from '../../shared/ipc'
import { readLogTail } from '../services/logging'

// The two channels behind Diagnostics → Recent logs → Copy, and (#1024) behind the start-failure card's "Copy details
// for support" (`registerStartFailureIpc.ts`): the log's last lines and a clipboard write. Pre-unlock by design: they
// read no workspace, and the lines are redacted on the way out (#975, `readLogTail`). One body for both registrars, so
// the copy a support request gets is the same wherever it was made.
export function registerLogCopyHandlers(handle: (channel: string, handler: GuardedHandler) => void): void {
  // Spec §7.11 "show recent local logs" — read-only, local, never uploaded.
  handle(IPC.getLogTail, (): string[] => readLogTail())

  // Copy text to the OS clipboard. Done in MAIN because the sandboxed preload has no access
  // to Electron's `clipboard` module and `navigator.clipboard` is unreliable in the
  // packaged renderer (it threw the "can't copy" error). Returns false on failure so
  // the renderer can show a friendly message rather than throw.
  handle(IPC.writeClipboard, (_e, text: string): boolean => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
}
