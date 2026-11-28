import { guardedChannels, guardedHandleFor, releaseGuardedHandlers, type TrustedSenders } from './guarded-handle'
import { registerLogCopyHandlers } from './log-copy'
import { registerUpdatesIpc } from './registerUpdatesIpc'
import { IPC } from '../../shared/ipc'
import type { BackendStartFailure, WorkspaceStateInfo } from '../../shared/types'
import type { UpdateServiceGetter } from '../backend-start'
import { safeFailureForLog } from '../services/failure-for-log'
import { log } from '../services/logging'
import type { ResolvedPaths } from '../services/workspace'
import { startFailedState } from '../services/start-failure'

/**
 * #1024: everything the failure state's channels may use. Built by `main/backend-start.ts` without any service: the back
 * end that `initBackend` was building is not there, and nothing here may reach for it. The one exception is the update
 * service (app-update W-82), which `initBackend` builds before anything that can throw a start and which never throws
 * itself: the getter answers the one `initBackend` built, or builds it now.
 */
export interface StartFailureContext {
  /** The main window's sender set (`index.ts`); `createWindow` adds the window after this registration. */
  trustedSenders: TrustedSenders
  failure: BackendStartFailure
  /** The drive layout `initBackend` resolved before it threw (`resolvePaths` cannot throw), or null. The update channels
   *  find the drive's `updates/` folder through it. */
  paths: ResolvedPaths | null
  isDev: boolean
  /** This app's version (`app.getVersion()`), for the update channels' narrow context. */
  appVersion: string
  /** The process's one update service for a layout (`backend-start.ts`'s `oneUpdateService`, index.ts's
   *  `updateServiceFor`): the one `initBackend` built, or built now, start step included, when the start threw before
   *  that (app-update W-82; docs/app-updates.md §3.5 "The service and its start"). */
  updates: UpdateServiceGetter
}

/**
 * #1024: the IPC of a run whose back-end start threw. `initBackend` registers every channel at its end, so a throw before
 * that left the window with no handler at all and the renderer's first `getWorkspaceState` refused. This registers what
 * the gate needs to say why, and nothing that needs the back end:
 * - `getWorkspaceState`: the `start_failed` state, with the cause and the code (`services/start-failure.ts`);
 * - `getLogTail` and `writeClipboard`: "Copy details for support" (owner call OQ-1 (b)), the session's log lines as
 *   Diagnostics' Copy hands them out (redacted, #975). Before an unlock they are the start's own lines, held in memory;
 * - app-update W-82 (F-14): the update channels (`registerUpdatesIpc`), so a release that cannot start can still be
 *   repaired by an update. On the narrow context built here from this one (the senders, the layout, `isDev`, the app
 *   version), never `AppContext`, which does not exist in this state; the same registrar call serves the normal start.
 *   On the process's one update service, from this context's own layout. Registered last, in a `try` of their own: a
 *   throw in them (a service that cannot be built, Electron's second-handler refusal of a channel kept from before the
 *   start) cannot take the card with it, is logged by a fixed reason, and leaves none of their channels registered.
 *
 * Every other channel has no handler, so Electron refuses its invoke with "No handler registered for '<channel>'",
 * which names only the channel. In this state the renderer shows the gate's card and calls nothing else today (the
 * update import on the card is PR-6b's); the one other call at its start, the engine-problems read (`getAppStatus`),
 * already takes a refusal. P7's hand-off channel joins `registerUpdatesIpc`.
 */
export function registerStartFailureIpc(fctx: StartFailureContext): void {
  const handle = guardedHandleFor(fctx)
  handle(IPC.getWorkspaceState, (): WorkspaceStateInfo => startFailedState(fctx.failure))
  registerLogCopyHandlers(handle)
  const beforeUpdates = guardedChannels()
  try {
    registerUpdatesIpc(
      { trustedSenders: fctx.trustedSenders, paths: fctx.paths, isDev: fctx.isDev, appVersion: fctx.appVersion },
      fctx.updates(fctx.paths)
    )
  } catch (error) {
    // All or none: a throw part-way leaves no update channel of this registration answering. Released before the line
    // is written, so the all-or-none holds even if writing it throws.
    releaseGuardedHandlers(beforeUpdates)
    log.error('Backend start: the update channels could not be registered', safeFailureForLog(error))
  }
}
