import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron'
import { EVENTS, IPC } from '../shared/ipc'
import type { MessageKey, MessageParams } from '../shared/i18n'
import type { DocTaskStatus, SaveBeforeCloseResult } from '../shared/types'

// #888: closing or quitting the app saves the window's pending edits first. The review screen
// saves a decision or a note 600 ms after the last edit, and an edit whose save failed waits on
// screen for Try again (#837); a window close used to drop both without a word. Now the FIRST
// `close` of the main window is prevented, the window is asked to save (`app:saveBeforeClose` →
// `app:saveBeforeCloseDone`), and the window closes exactly once when it has answered or the
// bound has passed. A change that could not be saved asks first (owner call G-2): Try again (the
// default), Keep open (Esc) or Close anyway.
//
// #935 (owner call G-1, (c)-P0): before that save, a close that will quit (Windows and Linux,
// where the window's last close ends the app, #910) and that no quit started asks first while an
// OCR run or a document translation is running or waiting: they keep nothing when stopped. Keep
// open (the default and Esc) leaves everything as it was; Close anyway goes on to the save. No
// question on the macOS red button (the app and its tasks go on), on a close a quit started (Ctrl+Q,
// ⌘Q, Dock Quit: explicit quit commands, which stop the tasks at once), on Lock now or on a session
// end. On the X path the OCR window lives until the main window's `closed` (measured, follow-ups
// wave 4 research B §0), so a Keep open loses nothing. A quit asked while the question is up (Ctrl+Q
// or a signal on Linux) closes it and counts as Close anyway (review SF-1): explicit quits never ask.
//
// #936: once the guard commits to a close that quits (after that question, or at once with
// nothing to ask), it holds the document-task queue (`holdWork`): a quit the guard holds closes
// the OCR window while the window saves, and the queue would otherwise start its next task into
// that gap, only for `will-quit` to cancel it. Keep open in either dialog releases it
// (`releaseWork`). `holdQueueOnQuit` holds it at every un-prevented `before-quit` too.
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

/** #935: what a quitting close would stop — an OCR run, a document translation, or more than one such task. */
export type StoppingWork = 'ocr' | 'translation' | 'several'

/** The user's answer to "A document task is not finished yet." */
export type StopWorkChoice = 'keep' | 'close'

/** A belt: `listActiveDocTasks()` already lists only running and queued tasks (review N-1). */
const NOT_ACTIVE: ReadonlySet<DocTaskStatus['state']> = new Set(['done', 'failed', 'cancelled'])

/**
 * #935: the document work a quit would stop that the close asks about, from `listActiveDocTasks()`: the OCR runs and
 * document translations that are running or waiting. They are user-started, run for minutes and keep nothing when
 * stopped. A deep index, an extract pass, a summary, a comparison or a categorization alone is not asked about (a deep
 * index often starts by itself after an import, and it resumes from its cache). Null when there is nothing to ask.
 */
export function stoppingWorkFrom(tasks: readonly DocTaskStatus[]): StoppingWork | null {
  const asked = tasks.filter((task) => (task.kind === 'ocr' || task.kind === 'translation') && !NOT_ACTIVE.has(task.state))
  if (asked.length === 0) return null
  if (asked.length > 1) return 'several'
  return asked[0]!.kind === 'ocr' ? 'ocr' : 'translation'
}

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
  // The #935/#936 deps below are optional with "no work" defaults here; `createMainWindowCloseGuard` requires them.
  /**
   * #935: this window's close ends the app (Windows and Linux, #910: `platform !== 'darwin'`). Default false: no
   * question and no hold for a plain close (the macOS red button leaves the app and its tasks running).
   */
  closeQuits?: boolean
  /** #935: the document work a quit would stop right now (`stoppingWorkFrom`), or null. Default: none. */
  stoppingWork?(): StoppingWork | null
  /**
   * #935: the native "A document task is not finished yet." dialog (`createStopWorkConfirm`). `signal` closes it (review
   * SF-1: a quit asked while it is up); the guard then reads the answer as Close anyway, whatever the dialog says.
   */
  confirmStopWork?(work: StoppingWork, signal: AbortSignal): Promise<StopWorkChoice>
  /**
   * #935 review SF-1: call `listener` on every quit asked from now on (`before-quit`), and at once when one is already
   * pending; returns the unsubscribe. `QuitRequests.onRequest`. Default: no quit is ever seen.
   */
  onQuitRequest?(listener: () => void): () => void
  /** #936: start no new document task: a close that quits is under way (`DocTaskManager.holdQueueForQuit`). */
  holdWork?(): void
  /** #936: the quit was called off: the document-task queue goes on (`DocTaskManager.releaseQueueHold`). */
  releaseWork?(): void
}

export interface CloseGuard {
  /** The main window's `close` listener. */
  onClose(event: CloseEventLike): void
  /**
   * #910 (macOS): did this guard let the window's close go through as part of a quit (⌘Q, Dock Quit: a quit asked
   * before or during the save, which the guard then re-ran)? Read at the window's `closed`; false for a plain close.
   */
  closedForQuit(): boolean
}

/** Resolves in a later macrotask (after the current event and every microtask it queued). */
const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * One guard per window (a macOS `activate` window gets a fresh one). `open` → the first close is
 * prevented and the save starts (`saving`); any close during it is prevented and ignored, so a
 * second X click or a quit asked meanwhile closes nothing twice; the guard's own close
 * (`closing`) goes through. Keep open returns to `open`, so the next close asks again.
 *
 * #935/#936: for a close that will quit and that no quit started, the running-task question
 * (when there is one) comes first, then the queue hold, then the save. Keep open on the task
 * question skips the save and the hold; Keep open on the unsaved question releases the hold.
 */
export function createCloseGuard(deps: CloseGuardDeps): CloseGuard {
  let phase: 'open' | 'saving' | 'closing' = 'open'
  /** The close the guard let through was for a quit (`closedForQuit`). */
  let closingForQuit = false
  const closeQuits = deps.closeQuits === true
  /** The answer, or null for a request that throws or rejects (review round 2). */
  const askSafely = (): Promise<SaveBeforeCloseResult | null> => {
    try {
      return deps.askWindowToSave().catch(() => null)
    } catch {
      return Promise.resolve(null)
    }
  }
  /**
   * #935: the user's answer; a question that throws or rejects closes (as #888's dialog does), the save still runs.
   * Review SF-1: an explicit quit never asks (owner call G-1), so a quit asked while the question is up (Ctrl+Q or a
   * SIGTERM on Linux, ⌘Q on macOS) closes the dialog and counts as Close anyway: that quit has already closed the OCR
   * window, and swallowing it would leave a signal quit waiting on someone to answer.
   */
  const askStopSafely = async (work: StoppingWork): Promise<StopWorkChoice> => {
    const quitAsked = new AbortController()
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = deps.onQuitRequest?.(() => quitAsked.abort()) ?? unsubscribe
      const answer = quitAsked.signal.aborted
        ? 'close' // a quit was already pending: nothing to ask
        : ((await deps.confirmStopWork?.(work, quitAsked.signal)) ?? 'close')
      if (!quitAsked.signal.aborted) return answer
      deps.log.info('close: a quit was asked during the running-task question; closing')
      return 'close'
    } catch (err) {
      deps.log.warn('close: the running-task question failed; closing', { error: String(err) })
      return 'close'
    } finally {
      unsubscribe()
    }
  }
  /** #935: the work this close would stop and that it asks about; never for a close a quit started. */
  const workToAskAbout = (fromQuit: boolean): StoppingWork | null => {
    if (fromQuit || !closeQuits) return null
    try {
      return deps.stoppingWork?.() ?? null
    } catch (err) {
      deps.log.warn('close: could not read the running document tasks; not asking', { error: String(err) })
      return null
    }
  }
  /** #936: a hook that throws must not cost the save. */
  const queueHook = (hook: (() => void) | undefined, what: string): void => {
    try {
      hook?.()
    } catch (err) {
      deps.log.warn(`close: could not ${what} the document-task queue`, { error: String(err) })
    }
  }
  /** The #888 save: ask the window, and ask the user about a change it could not save. Keep open or close. */
  const saveBeforeClosing = async (): Promise<'close' | 'keep'> => {
    for (;;) {
      const answer = await askSafely()
      // Every outcome (the dialog, the close, a quit) waits for a later task (code review round
      // 3). An answer can be there at once (a window gone, crashed or still loading, a request
      // that throws), and Electron drains the microtask queue before it reads this `close`
      // event's preventDefault: a close started in a microtask would run inside that event.
      await nextTask()
      if (answer === null) {
        deps.log.warn('close: the window gave no answer to the save request; closing')
        return 'close'
      }
      if (!answer.unsaved) return 'close'
      // A lock that began meanwhile (a session end, review round 2) refused the write: Try
      // again cannot succeed, and the system is shutting down. Close without asking.
      if (deps.isShuttingDown()) {
        deps.log.info('close: a lock began during the save; closing without asking')
        return 'close'
      }
      const asked = await deps.confirmUnsaved()
      deps.log.info('close: a change could not be saved', { choice: asked })
      if (deps.isShuttingDown()) return 'close' // the lock began while the dialog was up: close
      if (asked !== 'retry') return asked
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
        /** #936: this close took the queue hold. */
        let holding = false
        try {
          // #935: ask before stopping an OCR run or a document translation. Like every outcome, the
          // dialog waits for a later task: it must never open inside this `close` event.
          const work = workToAskAbout(fromQuit)
          let save = true
          if (work !== null) {
            await nextTask()
            const asked = await askStopSafely(work)
            deps.log.info('close: document work would stop', { work, choice: asked })
            if (deps.isShuttingDown()) {
              // A lock began while the dialog was up (a session end): close without the save, as the
              // unsaved dialog's rule does.
              deps.log.info('close: a lock began during the running-task question; closing')
              save = false
            } else if (asked === 'keep') {
              choice = 'keep'
            }
          }
          if (choice === 'close') {
            // #936: committed to a close that quits: nothing new starts in the queue from here on. With
            // nothing to ask this runs inside the `close` event, deliberately: on a quit the OCR window's
            // `destroyed` comes 3-6 ms later (research B §#936.4), and the hold must come first.
            if (fromQuit || closeQuits) {
              queueHook(deps.holdWork, 'hold')
              holding = true
            }
            if (save) choice = await saveBeforeClosing()
          }
        } catch (err) {
          // Never leave the guard in `saving`: the window could not be closed at all any more.
          deps.log.warn('close: the save before closing failed; closing', { error: String(err) })
        }
        fromQuit = deps.consumeQuitRequest() || fromQuit // a quit asked while saving
        if (choice === 'keep') {
          phase = 'open' // the window stays, and so does the quit's cancellation
          // #936: the quit is off (this close's own, or one asked meanwhile): the queue goes on.
          if (holding || fromQuit) queueHook(deps.releaseWork, 'release')
          return
        }
        phase = 'closing'
        closingForQuit = fromQuit
        try {
          if (fromQuit) deps.quit()
          else deps.closeWindow()
        } catch (err) {
          deps.log.warn('close: closing the window failed', { error: String(err) })
        }
      })()
    },
    closedForQuit: () => closingForQuit
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

/** What both close dialogs use: the unsaved question and the running-task question (#935). */
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
 * Both close dialogs: modal to the window (the `external-open.ts` precedent), after a minimized
 * window is restored and brought to the front, so a close from the taskbar never waits on a dialog
 * the user cannot see. The dialog's `response`.
 */
async function askModal(deps: UnsavedCloseConfirmDeps, options: MessageBoxOptions): Promise<number> {
  const win = deps.window
  const live = !win.isDestroyed()
  if (live) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  const { response } = live
    ? await deps.dialog.showMessageBox(win as BrowserWindow, options)
    : await deps.dialog.showMessageBox(options)
  return response
}

/**
 * The native "Some review changes could not be saved." dialog (`askModal`): Try again is the
 * default (Enter), Keep open is the Esc button (`cancelId`, also what closing the dialog answers),
 * Close anyway is never the default; plain buttons (`noLink`). A dialog that fails closes, as a
 * window that gives no answer does: main cannot ask, so it falls back to the close.
 */
export function createUnsavedCloseConfirm(deps: UnsavedCloseConfirmDeps): () => Promise<UnsavedCloseChoice> {
  return async () => {
    try {
      const response = await askModal(deps, {
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
      })
      if (response === TRY_AGAIN) return 'retry'
      if (response === CLOSE_ANYWAY) return 'close'
      return 'keep'
    } catch (err) {
      deps.log.warn('close: the unsaved-changes dialog failed; closing', { error: String(err) })
      return 'close'
    }
  }
}

/** The running-task dialog's buttons, in order: the index is the dialog's `response`. */
const STOP_KEEP_OPEN = 0
const STOP_CLOSE_ANYWAY = 1

/** #935: what the dialog says each kind of work loses. */
const STOP_WORK_DETAIL: Readonly<Record<StoppingWork, MessageKey>> = {
  ocr: 'main.dialog.taskRunning.detailOcr',
  translation: 'main.dialog.taskRunning.detailTranslation',
  several: 'main.dialog.taskRunning.detailSeveral'
}

/**
 * #935: the native "A document task is not finished yet." dialog (`askModal`, the unsaved
 * dialog's posture): Keep open is the default (Enter) and the Esc button (`cancelId`, also what
 * closing the dialog answers), Close anyway is never the default; plain buttons (`noLink`); the
 * detail says what the work loses, with no count (no plural forms). A dialog that fails closes
 * (#888's rule: main cannot ask, so it falls back to the close).
 */
export function createStopWorkConfirm(
  deps: UnsavedCloseConfirmDeps
): (work: StoppingWork, signal?: AbortSignal) => Promise<StopWorkChoice> {
  return async (work, signal) => {
    try {
      const response = await askModal(deps, {
        type: 'warning',
        title: deps.t('main.dialog.taskRunning.title'),
        message: deps.t('main.dialog.taskRunning.message'),
        detail: deps.t(STOP_WORK_DETAIL[work]),
        buttons: [deps.t('main.dialog.taskRunning.keepOpen'), deps.t('main.dialog.taskRunning.closeAnyway')],
        defaultId: STOP_KEEP_OPEN,
        cancelId: STOP_KEEP_OPEN,
        noLink: true,
        // Review SF-1: the guard closes it when a quit is asked (Electron answers it as cancelled: `cancelId`).
        ...(signal ? { signal } : {})
      })
      return response === STOP_CLOSE_ANYWAY ? 'close' : 'keep'
    } catch (err) {
      deps.log.warn('close: the running-task dialog failed; closing', { error: String(err) })
      return 'close'
    }
  }
}

/** The app-level "a quit was asked" flag the guards read (`app.on('before-quit')`). */
export interface QuitRequests {
  /** Was a quit asked since the last read? Reading clears it. */
  consume(): boolean
  /**
   * #935 review SF-1: call `listener` on every quit asked from now on, and at once when one is pending (asked and not
   * read yet). Reading nothing, clearing nothing. Returns the unsubscribe.
   */
  onRequest(listener: () => void): () => void
}

/**
 * Records every quit (File → Exit, Ctrl+Q, Cmd+Q, Dock Quit), and tells `onRequest` listeners (the
 * running-task question, review SF-1): each fires `before-quit` before it
 * closes the windows. The quit an X starts on Windows and Linux (#910) fires it only after the main
 * window has closed, so no guard reads it. One per app (`index.ts`, module scope); every main
 * window's guard reads it. The print harness has its own `before-quit` hook (`print-pdf.ts`).
 */
export function trackQuitRequests(app: { on(event: 'before-quit', listener: () => void): unknown }): QuitRequests {
  let asked = false
  const listeners = new Set<() => void>()
  app.on('before-quit', () => {
    asked = true
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* a listener that throws must not stop the others, nor the quit */
      }
    }
  })
  return {
    consume: () => {
      const was = asked
      asked = false
      return was
    },
    onRequest: (listener) => {
      listeners.add(listener)
      if (asked) listener()
      return () => void listeners.delete(listener)
    }
  }
}

/** The `before-quit` event's surface `holdQueueOnQuit` reads (Electron sets `defaultPrevented`). */
export interface BeforeQuitEventLike {
  readonly defaultPrevented?: boolean
}

/**
 * #936, the belt: every `before-quit` nobody prevented holds the document-task queue, so a quit no
 * guard holds (macOS ⌘Q with no window) or one asked while a guard is already saving (the red
 * button, then ⌘Q) starts no new task either. One-way: only a guard's Keep open and a successful unlock
 * release the hold (the places a begun quit is called off), and `will-quit` cancels every task anyway. Nothing
 * prevents `before-quit` today; a quit that is prevented never begins, so it holds nothing.
 */
export function holdQueueOnQuit(
  app: { on(event: 'before-quit', listener: (event: BeforeQuitEventLike) => void): unknown },
  holdWork: () => void
): void {
  app.on('before-quit', (event) => {
    if (event?.defaultPrevented !== true) holdWork()
  })
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
  /** `process.platform`: on every platform but macOS the window's close ends the app (#910, #935). */
  platform: string
  /** #935: `DocTaskManager.listActiveDocTasks()` (none while the backend is not up). */
  listActiveDocTasks(): readonly DocTaskStatus[]
  /** #936: `DocTaskManager.holdQueueForQuit()`. */
  holdWork(): void
  /** #936: `DocTaskManager.releaseQueueHold()`. */
  releaseWork(): void
  log: CloseGuardLog
}

/**
 * The guard `index.ts` gives every main window: the save request over `ipcMain` and the window's
 * own `webContents`, both dialogs modal to it, `win.close()` for an X, `app.quit()` again for a close
 * a quit started, the app-level quit flag, the lifecycle's lock flag, and the document-task queue
 * (#935, #936). Composed here, not in `index.ts`, so the wiring itself is driven by a test (review
 * round 2, S4).
 */
export function createMainWindowCloseGuard(deps: MainWindowCloseGuardDeps): CloseGuard {
  const win = deps.window
  const dialogDeps: UnsavedCloseConfirmDeps = { dialog: deps.dialog, window: win, t: deps.t, log: deps.log }
  return createCloseGuard({
    askWindowToSave: createWindowSaveRequest({ ipc: deps.ipc, webContents: win.webContents }),
    confirmUnsaved: createUnsavedCloseConfirm(dialogDeps),
    closeWindow: () => {
      if (!win.isDestroyed()) win.close()
    },
    quit: () => deps.app.quit(),
    consumeQuitRequest: () => deps.quitRequests.consume(),
    onQuitRequest: (listener) => deps.quitRequests.onRequest(listener),
    isShuttingDown: () => deps.isShuttingDown(),
    closeQuits: deps.platform !== 'darwin',
    stoppingWork: () => stoppingWorkFrom(deps.listActiveDocTasks()),
    confirmStopWork: createStopWorkConfirm(dialogDeps),
    holdWork: () => deps.holdWork(),
    releaseWork: () => deps.releaseWork(),
    log: deps.log
  })
}
