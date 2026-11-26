import { guardedChannels, releaseGuardedHandlers, type TrustedSenders } from './ipc/guarded-handle'
import { registerStartFailureIpc } from './ipc/registerStartFailureIpc'
import { safeFailureForLog } from './services/failure-for-log'
import { tMain } from './services/i18n'
import { log } from './services/logging'
import { startFailureFrom } from './services/start-failure'
import { writeStartFailedLine } from './services/updates/update-log'
import type { ResolvedPaths } from './services/workspace'
import type { BackendStartFailure } from '../shared/types'

// #1024: the app's start in `app.whenReady` (main/index.ts), and what a start that throws leaves behind. Two steps:
//
// 1. The back end (`runBackendStart`). `initBackend` builds the workspace controller and every service and registers the
//    IPC handlers only at its end, so a throw before that (a drive that refuses the app's folders, a plaintext dev
//    database that cannot be opened, a fault in this version) used to leave the window with nothing to talk to: the
//    renderer's first `getWorkspaceState` was refused, the screen pointed at a `logs/app.log` that an encrypted
//    workspace does not write before an unlock, and the line logged was `String(err)`, the drive's paths included.
// 2. The window (`runWindowStart`, review M-2): the app protocol over the app's own renderer files, the menu, the window.
//    A throw there used to reject the callback's promise and open no window at all, while the process held the
//    single-instance lock against every later launch.
//
// Kept out of index.ts (which pulls in the whole Electron main process) so the integration rows can drive them:
// tests/integration/backend-start-failure.test.ts and window-start-failure.test.ts.

export interface BackendStartDeps {
  /** The main window's sender set (index.ts, module scope). */
  trustedSenders: TrustedSenders
  isDev: boolean
  /** This app's version (`app.getVersion()`), for the failed-start line of `updates/update.log` (W-14). */
  appVersion: string
  /** The drive layout the start resolved before it threw, or null; read only after a throw. */
  paths: () => ResolvedPaths | null
}

/** What the gate is told when even the thrown value cannot be read (a getter that throws on `code`). */
const UNREADABLE_FAILURE: BackendStartFailure = { cause: 'other', code: null }

/**
 * Run `start` (production passes `initBackend`). On a throw:
 * - one log line with `safeFailureForLog` (#956: a file error logs its code and system call, never its message, which
 *   names paths; any other error keeps its message; a value that cannot be read logs a fixed line);
 * - every handler the partial start had registered is removed (a throw after some registrars ran), and their count is
 *   logged, so a late throw (a back end half started behind the card) can be told apart; a channel registered before
 *   the start began stays (final round);
 * - the failure state's channels are registered (`registerStartFailureIpc`), so the gate shows why, in its language.
 * Returns the failure, or null when the start went through. Never throws: nothing in the catch may throw out of it
 * (review L-1), and a failure state that cannot be registered is logged too, and the window still opens onto the
 * renderer's fatal screen.
 */
export function runBackendStart(start: () => void, deps: BackendStartDeps): BackendStartFailure | null {
  const registeredBefore = guardedChannels()
  try {
    start()
    return null
  } catch (err) {
    let failure: BackendStartFailure
    try {
      failure = startFailureFrom(err)
    } catch {
      failure = UNREADABLE_FAILURE
    }
    log.error('Backend initialization failed', safeFailureForLog(err))
    // App-update W-14 (F-11): the failed-start line in the drive's `updates/update.log`, the one trace of this start that
    // outlives a quit before any unlock. Best-effort (the drive may be what failed): the cause, the code and the bare
    // system call, content-free by the line's grammar; nothing on a root that is no prepared drive. In a `try` of its
    // own, so neither the writer nor the layout getter can keep the failure state below from being registered.
    try {
      writeStartFailedLine(deps.paths(), { appVersion: deps.appVersion, thrown: err, failure })
    } catch {
      /* the writer never throws; the getter is the caller's */
    }
    try {
      const released = releaseGuardedHandlers(registeredBefore)
      if (released > 0) log.info('Backend start: removed the channels the partial start had registered', { released })
      registerStartFailureIpc({
        trustedSenders: deps.trustedSenders,
        failure,
        paths: deps.paths(),
        isDev: deps.isDev
      })
    } catch (registerErr) {
      log.error('Backend start: the failure state could not be registered', safeFailureForLog(registerErr))
    }
    return failure
  }
}

export interface WindowStartDeps {
  /** Electron's `dialog.showErrorBox`: a native box that needs no window (and no renderer). */
  showErrorBox: (title: string, body: string) => void
  /** `app.exit`: ends the process now, which releases the single-instance lock for the next launch. */
  exit: (code: number) => void
}

/**
 * #1024 review M-2: run the steps after the back end (production passes the rest of the `whenReady` callback). A throw
 * there leaves no window to show anything in, so: one log line with `safeFailureForLog`, a native error box in main's
 * language with fixed text (the card's own title, its general text and its help line: never the error), then
 * `exit(1)`. A box that cannot be shown (no display) still ends the app.
 */
export function runWindowStart(steps: () => void, deps: WindowStartDeps): void {
  try {
    steps()
  } catch (err) {
    log.error('App start failed after the back end', safeFailureForLog(err))
    try {
      deps.showErrorBox(
        tMain('app.fatal.title'),
        `${tMain('gate.startFailed.other')}\n\n${tMain('gate.startFailed.help')}`
      )
    } catch {
      /* no box (a Linux session with no display): the exit below still ends the app */
    }
    deps.exit(1)
  }
}
