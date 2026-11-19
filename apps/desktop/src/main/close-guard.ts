import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron'
import { EVENTS, IPC } from '../shared/ipc'
import type { MessageKey, MessageParams } from '../shared/i18n'
import type { SaveBeforeCloseResult } from '../shared/types'

// #888: closing or quitting the app saves the window's pending edits first. The review screen
// saves a decision or a note 600 ms after the last edit, and an edit whose save failed waits on
// screen for Try again (#837); a window close used to drop both without a word. Now the FIRST
// `close` of the main window is prevented, the window is asked to save (`app:saveBeforeClose` →
// `app:saveBeforeCloseDone`), and the window closes exactly once when it has answered or the
// bound has passed. A change that could not be saved asks first (owner call G-2): Try again (the
// default), Keep open (Esc) or Close anyway.
//
// Every quit closes the window before `will-quit` (File → Exit, Ctrl+Q, Cmd+Q, Dock Quit), and an X
// quits only after the window has closed (on Windows and Linux the main window's `closed` starts the
// quit, `lifecycle.onMainWindowClosed`, #910). `will-quit` is where the lock starts
// (`performShutdown` → `beginLock`), so a save this guard waits for always lands before the lock.
// A close that came from a quit (`before-quit` fired first) quits again after the save: the
// prevented close cancelled that quit, and on macOS the app would otherwise stay open with no
// window. The Windows `session-end`, macOS `powerMonitor 'shutdown'` and `uncaughtException`
// paths stay synchronous (`shutdown.ts`): the OS kills the process, nothing can wait there.
//
// Electron-free like `createAppLifecycleHandlers` (`index.ts` cannot be imported under vitest):
// the window, `ipcMain`, the dialog and the copy are injected, and `tests/unit/close-guard.test.ts`
// drives all three factories with fakes.

/**
 * How long main waits for the window's answer. Longer than the window's own bounds (the review
 * store's `REVIEW_LOCK_FLUSH_BOUND_MS`, 6 s, inside the bridge's `BEFORE_CLOSE_SAVE_BOUND_MS`,
 * 6.5 s), so a write that hangs is answered by the window itself ("unsaved") before main gives up,
 * with more than a second to spare for a minimized window whose timers are throttled (review round
 * 2). Main gives up only on a window that does not answer at all (hung JavaScript), and then closes,
 * because it cannot know what is unsaved.
 */
export const CLOSE_SAVE_BOUND_MS = 8_000

/** The user's answer to "Some review changes could not be saved." */
export type UnsavedCloseChoice = 'retry' | 'keep' | 'close'

/** The subset of Electron's window `close` event the guard uses. */
export interface CloseEventLike {
  preventDefault(): void
}

/** Content-free log lines only: the kind of outcome, never what was being saved. */
export interface CloseGuardLog {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
}

export interface CloseGuardDeps {
  /** Ask the window to save; its answer, or null when it gave none (bound, crash, still loading). */
  askWindowToSave(): Promise<SaveBeforeCloseResult | null>
  /** The native "could not be saved" dialog (`createUnsavedCloseConfirm`). */
  confirmUnsaved(): Promise<UnsavedCloseChoice>
  /** `win.close()`: Electron emits `close` again, and the guard lets that one through. */
  closeWindow(): void
  /** `app.quit()`. */
  quit(): void
  /** Read and clear the app-level "a quit was asked" flag (`before-quit`). */
  consumeQuitRequest(): boolean
  /** `lifecycle.isShuttingDown()`: a quit teardown or a session-end lock has begun. */
  isShuttingDown(): boolean
  log: CloseGuardLog
}

export interface CloseGuard {
  /** The main window's `close` listener. */
  onClose(event: CloseEventLike): void
}

/** Resolves in a later macrotask (after the current event and every microtask it queued). */
const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * One guard per window (a macOS `activate` window gets a fresh one). `open` → the first close is
 * prevented and the save starts (`saving`); any close during it is prevented and ignored, so a
 * second X click or a quit asked meanwhile closes nothing twice; the guard's own close
 * (`closing`) goes through. Keep open returns to `open`, so the next close asks again.
 */
export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  let phase: 'open' | 'saving' | 'closing' = 'open'
  /** The answer, or null for a request that throws or rejects (review round 2). */
  const askSafely = (): Promise<SaveBeforeCloseResult | null> => {
    try {
      return deps.askWindowToSave().catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }
  return {
    onClose(event: CloseEventLike): void {
      // Our own close, or a lock already ran (session end, a quit teardown): nothing to wait for.
      if (phase === 'closing' || deps.isShuttingDown()) return
      event.preventDefault()
      if (phase === 'saving') return // a second click (or a quit) while saving: the save decides
      phase = 'saving'
      // A quit that reached this close is cancelled by the preventDefault above: remember it.
      let fromQuit = deps.consumeQuitRequest()
      void (async () => {
        let choice: 'close' | 'keep' = 'close'
        try {
          for (;;) {
            const answer = await askSafely()
            // Every outcome (the dialog, the close, a quit) waits for a later task (code review round
            // 3). An answer can be there at once (a window gone, crashed or still loading, a request
            // that throws), and Electron drains the microtask queue before it reads this `close`
            // event's preventDefault: a close started in a microtask would run inside that event.
            await nextTask()
            if (answer === null) {
              deps.log.warn('close: the window gave no answer to the save request; closing')
              break
            }
            if (!answer.unsaved) break
            // A lock that began meanwhile (a session end, review round 2) refused the write: Try
            // again cannot succeed, and the system is shutting down. Close without asking.
            if (deps.isShuttingDown()) {
              deps.log.info('close: a lock began during the save; closing without asking')
              break
            }
            const asked = await deps.confirmUnsaved()
            deps.log.info('close: a change could not be saved', { choice: asked })
            if (deps.isShuttingDown()) break // the lock began while the dialog was up: close
            if (asked !== 'retry') {
              choice = asked
              break
            }
          }
        } catch (err) {
          // Never leave the guard in `saving`: the window could not be closed at all any more.
          deps.log.warn('close: the save before closing failed; closing', { error: String(err) })
        }
        fromQuit = deps.consumeQuitRequest() || fromQuit // a quit asked while saving
        if (choice === 'keep') {
          phase = 'open' // the window stays, and so does the quit's cancellation
          return
        }
        phase = 'closing'
        try {
          if (fromQuit) deps.quit()
          else deps.closeWindow()
        } catch (err) {
          deps.log.warn('close: closing the window failed', { error: String(err) })
        }
      })()
    }
  }
}

/** The `ipcMain` surface the save request uses (the reply is a one-way `send`, like `perf:mark`). */
export interface SaveReplyIpc {
  on(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown
  removeListener(channel: string, listener: (event: { sender: unknown }, payload: unknown) => void): unknown
}

/** The main window's `webContents` surface the save request uses. */
export interface SaveRequestWebContents {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
  isCrashed(): boolean
  isLoading(): boolean
  on(event: 'render-process-gone', listener: () => void): unknown
  removeListener(event: 'render-process-gone', listener: () => void): unknown
}

export interface WindowSaveRequestDeps {
  ipc: SaveReplyIpc
  webContents: SaveRequestWebContents
  /** Defaults to `CLOSE_SAVE_BOUND_MS`. */
  boundMs?: number
}

/**
 * `askWindowToSave` for one window. Each ask sends a fresh request id and accepts exactly one
 * reply: from THIS window's `webContents` (the rasterizer's identity check, `ocr/rasterizer.ts`)
 * carrying that id (an answer to an earlier ask that came after its bound is not this answer).
 * The channel is not behind `guardedHandle`: it is a one-way `send`, and it must answer while
 * the workspace is locked too (there is nothing to save then). Null at once for a window that is
 * gone, crashed or still loading (nothing could be edited yet, and nobody would answer), when the
 * renderer process goes away mid-ask, and at the bound. Every exit removes both listeners.
 * A reply that does not say `unsaved: false` counts as unsaved: the user is asked, never skipped.
 */
export function createWindowSaveRequest(deps: WindowSaveRequestDeps): () => Promise<SaveBeforeCloseResult | null> {
  const wc = deps.webContents
  let lastRequestId = 0
  return () =>
    new Promise<SaveBeforeCloseResult | null>((resolve) => {
      // `isLoading()` fails open on purpose: the renderer has no subframes, so it is true only during
      // the first load or a reload (measured on Electron 43.8.6: until `did-stop-loading`, about 1 ms
      // after `loadURL()` resolves), when the page holds nothing unsaved and nobody would answer.
      if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) {
        resolve(null)
        return
      }
      const requestId = ++lastRequestId
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (answer: SaveBeforeCloseResult | null): void => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        deps.ipc.removeListener(IPC.saveBeforeCloseDone, onReply)
        try {
          wc.removeListener('render-process-gone', onGone)
        } catch {
          /* a destroyed webContents: nothing left to listen to */
        }
        resolve(answer)
      }
      const onReply = (event: { sender: unknown }, payload: unknown): void => {
        if (event?.sender !== wc) return
        const reply = payload as { requestId?: unknown; unsaved?: unknown } | null | undefined
        if (reply?.requestId !== requestId) return
        settle({ unsaved: reply.unsaved !== false })
      }
      const onGone = (): void => settle(null)
      deps.ipc.on(IPC.saveBeforeCloseDone, onReply)
      wc.on('render-process-gone', onGone)
      timer = setTimeout(() => settle(null), deps.boundMs ?? CLOSE_SAVE_BOUND_MS)
      try {
        wc.send(EVENTS.saveBeforeClose, requestId)
      } catch {
        settle(null)
      }
    })
}

/** The main window's surface the dialog uses. */
export type ConfirmWindow = Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus'>

export interface UnsavedCloseConfirmDeps {
  dialog: Pick<Dialog, 'showMessageBox'>
  window: ConfirmWindow
  /** Main-side copy (`tMain`), in the user's interface language. */
  t: (key: MessageKey, params?: MessageParams) => string
  log: CloseGuardLog
}

/** Button order in the dialog: the index is the dialog's `response`. */
const TRY_AGAIN = 0
const KEEP_OPEN = 1
const CLOSE_ANYWAY = 2

/**
 * The native "Some review changes could not be saved." dialog, modal to the window (the
 * `external-open.ts` precedent): Try again is the default (Enter), Keep open is the Esc button
 * (`cancelId`, also what closing the dialog answers), Close anyway is never the default; plain
 * buttons (`noLink`). A minimized window is restored and brought to the front first, so a close
 * from the taskbar never waits on a dialog the user cannot see. A dialog that fails closes, as a
 * window that gives no answer does: main cannot ask, so it falls back to the close.
 */
export function createUnsavedCloseConfirm(deps: UnsavedCloseConfirmDeps): () => Promise<UnsavedCloseChoice> {
  return async () => {
    try {
      const win = deps.window
      const live = !win.isDestroyed()
      if (live) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      const options: MessageBoxOptions = {
        type: 'warning',
        title: deps.t('main.dialog.unsavedReview.title'),
        message: deps.t('main.dialog.unsavedReview.message'),
        detail: deps.t('main.dialog.unsavedReview.detail'),
        buttons: [
          deps.t('main.dialog.unsavedReview.tryAgain'),
          deps.t('main.dialog.unsavedReview.keepOpen'),
          deps.t('main.dialog.unsavedReview.closeAnyway')
        ],
        defaultId: TRY_AGAIN,
        cancelId: KEEP_OPEN,
        noLink: true
      }
      const { response } = live
        ? await deps.dialog.showMessageBox(win as BrowserWindow, options)
        : await deps.dialog.showMessageBox(options)
      if (response === TRY_AGAIN) return 'retry'
      if (response === CLOSE_ANYWAY) return 'close'
      return 'keep'
    } catch (err) {
      deps.log.warn('close: the unsaved-changes dialog failed; closing', { error: String(err) })
      return 'close'
    }
  }
}

/** The app-level "a quit was asked" flag the guards read (`app.on('before-quit')`). */
export interface QuitRequests {
  /** Was a quit asked since the last read? Reading clears it. */
  consume(): boolean
  /**
   * The same flag, read without clearing (#910, macOS): true at the main window's `closed` when the window closed
   * through a quit (the guard's own quit after the save sets it again, and nothing reads it after that).
   */
  pending(): boolean
}

/**
 * Records every quit (File → Exit, Ctrl+Q, Cmd+Q, Dock Quit): each fires `before-quit` before it
 * closes the windows. The quit an X starts on Windows and Linux (#910) fires it only after the main
 * window has closed, so no guard reads it. One per app (`index.ts`, module scope); every main
 * window's guard reads it. The print harness has its own `before-quit` hook (`print-pdf.ts`).
 */
export function trackQuitRequests(app: { on(event: 'before-quit', listener: () => void): unknown }): QuitRequests {
  let asked = false
  app.on('before-quit', () => {
    asked = true
  })
  return {
    consume: () => {
      const was = asked
      asked = false
      return was
    },
    pending: () => asked
  }
}

/** The main window's surface the composed guard uses. */
export type MainCloseWindow = ConfirmWindow & { close(): void; webContents: SaveRequestWebContents }

export interface MainWindowCloseGuardDeps {
  window: MainCloseWindow
  app: { quit(): void }
  ipc: SaveReplyIpc
  dialog: Pick<Dialog, 'showMessageBox'>
  t: (key: MessageKey, params?: MessageParams) => string
  quitRequests: QuitRequests
  /** `lifecycle.isShuttingDown()`. */
  isShuttingDown(): boolean
  log: CloseGuardLog
}

/**
 * The guard `index.ts` gives every main window: the save request over `ipcMain` and the window's
 * own `webContents`, the dialog modal to it, `win.close()` for an X, `app.quit()` again for a close
 * a quit started, the app-level quit flag and the lifecycle's lock flag. Composed here, not in
 * `index.ts`, so the wiring itself is driven by a test (review round 2, S4).
 */
export function createMainWindowCloseGuard(deps: MainWindowCloseGuardDeps): CloseGuard {
  const win = deps.window
  return createCloseGuard({
    askWindowToSave: createWindowSaveRequest({ ipc: deps.ipc, webContents: win.webContents }),
    confirmUnsaved: createUnsavedCloseConfirm({ dialog: deps.dialog, window: win, t: deps.t, log: deps.log }),
    closeWindow: () => {
      if (!win.isDestroyed()) win.close()
    },
    quit: () => deps.app.quit(),
    consumeQuitRequest: () => deps.quitRequests.consume(),
    isShuttingDown: () => deps.isShuttingDown(),
    log: deps.log
  })
}
