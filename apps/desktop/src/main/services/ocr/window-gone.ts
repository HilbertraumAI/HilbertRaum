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
// The outcome is latched: it is what the run ends as, whatever step it was on when the window went. A page that was
// waiting is failed with it; a step that starts later (the next page request, after a recognition that was still
// running) and a step the window's end cut short (the page load) end as it too, through `outcomeIfGone()` (code
// review: only a waiting page used to; the next request's send to the destroyed window threw a plain error).
//
// Either way the outcome waits one task: after an X the quit's `will-quit` runs between the window's `destroyed` and
// that task (measured), so its cancel, which also empties the task queue, comes first, and the queue does not start its
// next task into the quit. On a quit the guard holds the run ends before `will-quit`, while the window saves; the queue
// starts nothing then either, because the quit holds it (#936: `holdQueueOnQuit` at `before-quit` and the close guard,
// `close-guard.ts`; only the guard's Keep open releases it), and that quit's `will-quit` cancels what waits.
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

export interface RunWindowGoneWatch {
  /** Remove the listeners. In the run's `finally`, before the run destroys the window itself. */
  dispose(): void
  /**
   * After a step of the run failed: the outcome when the window is gone (it resolves one task after the window's
   * `destroyed`), or null when the window is still there and the failure is the step's own.
   */
  outcomeIfGone(): Promise<Error | null>
}

/** Watch one run's window. */
export function watchRunWindowGone(deps: RunWindowGoneDeps): RunWindowGoneWatch {
  let quitAsked = false
  /** The latched outcome, from the window's `destroyed` on (or from the first look that finds it destroyed). */
  let outcome: Promise<Error> | null = null
  const onBeforeQuit = (): void => {
    quitAsked = true
  }
  const gone = (): Promise<Error> => {
    if (!outcome) {
      outcome = new Promise<Error>((resolve) => {
        setImmediate(() => {
          const err = quitAsked ? deps.abortError() : new Error(RASTER_WINDOW_GONE_MESSAGE)
          if (!quitAsked) deps.log.warn('OCR rasterizer window closed during the run')
          deps.failPage(err)
          resolve(err)
        })
      })
    }
    return outcome
  }
  const onDestroyed = (): void => {
    void gone()
  }
  deps.app.on('before-quit', onBeforeQuit)
  deps.webContents.on('destroyed', onDestroyed)
  return {
    dispose: () => {
      deps.app.removeListener('before-quit', onBeforeQuit)
      if (!deps.isWindowDestroyed()) deps.webContents.removeListener('destroyed', onDestroyed)
    },
    outcomeIfGone: () => outcome ?? (deps.isWindowDestroyed() ? gone() : Promise.resolve(null))
  }
}
