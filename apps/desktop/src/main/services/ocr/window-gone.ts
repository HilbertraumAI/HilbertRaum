// What it means when the OCR rasterizer's hidden window goes away in the middle of a run (#910).
//
// A window that goes away emits `destroyed`, never `render-process-gone` (measured on Electron 43.8.6), so before #910
// the page in flight waited out its 60 s step timeout. Two cases:
//
// - **A quit closed it.** Every quit fires `before-quit` and then closes every window, this one included. Whether the
//   quit's own cancel (`will-quit` → `cancelAllDocTasks`) comes before the next task depends on the quit: after an X it
//   does (the main window is already gone), but a quit the close guard holds while the main window saves (Ctrl+Q on
//   Linux, ⌘Q or Dock Quit on macOS, File → Exit in a development build) closes this window first and reaches
//   `will-quit` only after the save, or never (Keep open). So a window gone after a quit was asked ends the run as an
//   abort: the OCR task ends `cancelled` on every quit path, with nothing persisted and no failure recorded, as before
//   #910 (follow-ups wave 3 review, SF-1; measured with the real close guard).
// - **Nothing asked to quit** (the window was closed some other way): the run fails at once, with its own message.
//
// Either way the outcome waits one task: after an X the quit's `will-quit` runs between the window's `destroyed` and
// that task (measured), so its cancel, which also empties the task queue, comes first, and the queue does not start its
// next task into the quit. On a quit the guard holds the run ends before `will-quit`, so a task queued behind it can
// start while the window saves; that quit's `will-quit` then cancels it (a residual: the queue cannot tell a quit is
// coming).
//
// Electron-free, so tests/helpers/closeGuardSmokeRunner.ts can bundle it into a real-Electron run; the rasterizer
// is its production caller.

/** The `app` surface the watch uses (`before-quit`). */
export interface QuitSignalSource {
  on(event: 'before-quit', listener: () => void): unknown
  removeListener(event: 'before-quit', listener: () => void): unknown
}

/** The window's `webContents` surface the watch uses (`destroyed`). */
export interface DestroyedSignalSource {
  on(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export interface RunWindowGoneDeps {
  app: QuitSignalSource
  webContents: DestroyedSignalSource
  /** `win.isDestroyed()`: the `destroyed` listener is removed only from a window that still exists. */
  isWindowDestroyed(): boolean
  /** Reject the page in flight with `err`; true when one was waiting (`RasterReplySlot.fail`). */
  failPage(err: Error): boolean
  /** The run's abort error (an `AbortError`, which the OCR task reads as `cancelled`). */
  abortError(): Error
  log: { warn(message: string): void }
}

/** The message of a run whose window went away with no quit asked (raw: it reaches the local log only). */
export const RASTER_WINDOW_GONE_MESSAGE = 'The rasterizer window closed while rendering the PDF'

/** Watch one run's window; `dispose()` in the run's `finally`, before the run destroys the window itself. */
export function watchRunWindowGone(deps: RunWindowGoneDeps): { dispose(): void } {
  let quitAsked = false
  const onBeforeQuit = (): void => {
    quitAsked = true
  }
  const onDestroyed = (): void => {
    setImmediate(() => {
      if (quitAsked) {
        deps.failPage(deps.abortError())
        return
      }
      if (deps.failPage(new Error(RASTER_WINDOW_GONE_MESSAGE))) {
        deps.log.warn('OCR rasterizer window closed during the run')
      }
    })
  }
  deps.app.on('before-quit', onBeforeQuit)
  deps.webContents.on('destroyed', onDestroyed)
  return {
    dispose: () => {
      deps.app.removeListener('before-quit', onBeforeQuit)
      if (!deps.isWindowDestroyed()) deps.webContents.removeListener('destroyed', onDestroyed)
    }
  }
}
