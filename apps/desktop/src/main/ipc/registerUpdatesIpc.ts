import { guardedHandleFor, type TrustedSenders } from './guarded-handle'
import { IPC } from '../../shared/ipc'
import { log } from '../services/logging'
import type { UpdateService } from '../services/updates/service'
import type { ResolvedPaths } from '../services/workspace'

// App-update F-14 (frozen; T6.3; docs/app-updates.md §3.5 "The channels' values"): the update channels callable while
// the workspace is locked. PR-6a's four are `updates:importFile`, `updates:status`, `updates:cancel` and
// `updates:discardStaged`, each the update service's method of that name (services/updates/service.ts, built once per
// process in index.ts). PR-6b adds the "Copy details for support" channel here and P7 the hand-off channel: every F-14
// channel stays in this one registrar, which index.ts calls inside `initBackend` and `registerStartFailureIpc` calls
// again in a start that failed (W-82). A channel registered before the start would survive that start's release and
// then meet Electron's second-handler refusal in the failure state (CF-58).
//
// What each channel does and does not do:
// - it goes through `guardedHandle` (#252): an untrusted sender reaches no method;
// - it calls no `requireUnlocked()` and has no lock gate of any kind: the import must work exactly when the app is broken,
//   before an unlock and on the refusal screens. It takes the narrow context below, never `AppContext`, so it cannot
//   reach the workspace or the database; the service writes only under the drive's `updates/` and reads nothing under a
//   root that is no prepared drive (F-21);
// - it hands the renderer's argument on untouched (the service reads only an own `confirmToken` of importFile's
//   argument and an own string `version` of discardStaged's, never as a path), and the calling event to importFile as
//   the caller main's file dialog is parented to; status and cancel take none;
// - a rejection of a service method (only a handed read or hook that throws can cause one, its message possibly
//   naming a path) reaches the renderer as `UpdateChannelError`, with no message, and app.log gets one fixed reason with
//   the channel and the error's code alone. Every method already waits for the start step's sweep (10 s at most), so a
//   channel adds no wait of its own.
// The registrar's dedicated test is tests/integration/updates-ipc.test.ts (F-14's list as a golden row); its place in
// both starts is backend-start-wiring.test.ts's and backend-start-failure.test.ts's.

/**
 * Everything the update channels may use (record §3.5 "The service and its start"): the main window's sender set, the
 * drive layout or null (a failure state that has none), whether this is a development run, and the app version, which
 * the full app context lacks, so `AppContext` can never be handed in. Both callers write it as an object literal of
 * these four fields. In PR-6a the handlers read only the senders; the others are there for PR-6b's and P7's channels.
 */
export interface UpdatesIpcContext {
  readonly trustedSenders: TrustedSenders
  readonly paths: ResolvedPaths | null
  readonly isDev: boolean
  readonly appVersion: string
}

/** The service's four channel methods: the registrar cannot reach its audit sink (`setAuditHook`). */
export type UpdateChannels = Pick<UpdateService, 'importFile' | 'status' | 'cancel' | 'discardStaged'>

/** What the renderer is answered when a service method rejected: no message, no code, no path (T6.3 sheet answer 8). */
export class UpdateChannelError extends Error {
  constructor() {
    super('')
    this.name = 'UpdateChannelError'
  }
}

/** An error's code when it is one (an errno or a Node code, never a message): the service's own rule. */
function codeOf(error: unknown): string | null {
  try {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : null
  } catch {
    return null
  }
}

/** The method's answer, or `UpdateChannelError` with the fixed app.log line (a synchronous throw lands here too). */
async function answer<T>(channel: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    try {
      log.warn('Update channel: a call failed', { channel, code: codeOf(error) })
    } catch {
      /* the log is best-effort */
    }
    throw new UpdateChannelError()
  }
}

/** F-14's channels over `service`, on the narrow context `uctx` (never `AppContext`). */
export function registerUpdatesIpc(uctx: UpdatesIpcContext, service: UpdateChannels): void {
  // The guard gets a literal of its own, so no other field of what a caller hands in (a `log`) reaches it.
  const handle = guardedHandleFor({ trustedSenders: uctx.trustedSenders })
  handle(IPC.updatesImportFile, (event, argument: unknown) => answer(IPC.updatesImportFile, () => service.importFile(argument, event)))
  handle(IPC.updatesStatus, () => answer(IPC.updatesStatus, () => service.status()))
  handle(IPC.updatesCancel, () => answer(IPC.updatesCancel, () => service.cancel()))
  handle(IPC.updatesDiscardStaged, (_event, argument: unknown) => answer(IPC.updatesDiscardStaged, () => service.discardStaged(argument)))
}
