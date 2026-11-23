import { guardedHandleFor, type TrustedSenders } from './guarded-handle'
import { registerLogCopyHandlers } from './log-copy'
import { IPC } from '../../shared/ipc'
import type { BackendStartFailure, WorkspaceStateInfo } from '../../shared/types'
import type { ResolvedPaths } from '../services/workspace'
import { startFailedState } from '../services/start-failure'

/**
 * #1024: everything the failure state's channels may use. Built by `main/backend-start.ts` without any service: the back
 * end that `initBackend` was building is not there, and nothing here may reach for it.
 */
export interface StartFailureContext {
  /** The main window's sender set (`index.ts`); `createWindow` adds the window after this registration. */
  trustedSenders: TrustedSenders
  failure: BackendStartFailure
  /** The drive layout `initBackend` resolved before it threw (`resolvePaths` cannot throw), or null. Unused today: the
   *  update plan's channels (below) find the drive's `updates/` folder through it. */
  paths: ResolvedPaths | null
  isDev: boolean
}

/**
 * #1024: the IPC of a run whose back-end start threw. `initBackend` registers every channel at its end, so a throw before
 * that left the window with no handler at all and the renderer's first `getWorkspaceState` refused. This registers what
 * the gate needs to say why, and nothing that needs the back end:
 * - `getWorkspaceState`: the `start_failed` state, with the cause and the code (`services/start-failure.ts`);
 * - `getLogTail` and `writeClipboard`: "Copy details for support" (owner call OQ-1 (b)), the session's log lines as
 *   Diagnostics' Copy hands them out (redacted, #975). Before an unlock they are the start's own lines, held in memory.
 *
 * Every other channel has no handler, so Electron refuses its invoke with "No handler registered for '<channel>'",
 * which names only the channel. In this state the renderer shows the gate's card alone and calls nothing else; the one
 * other call at its start, the engine-problems read (`getAppStatus`), already takes a refusal.
 *
 * The update plan (W-82, its P6 task T6.3) registers F-14's update channels HERE, and P7 its hand-off channel, so that a
 * release that cannot start can still be repaired by an update. Their registrar must take a narrow context built from
 * this one (the senders, the drive root from `paths`, `isDev`, the app version), NEVER the full `AppContext`: that
 * context does not exist in this state, and the same registrar call must serve the normal start too.
 */
export function registerStartFailureIpc(fctx: StartFailureContext): void {
  const handle = guardedHandleFor(fctx)
  handle(IPC.getWorkspaceState, (): WorkspaceStateInfo => startFailedState(fctx.failure))
  registerLogCopyHandlers(handle)
}
