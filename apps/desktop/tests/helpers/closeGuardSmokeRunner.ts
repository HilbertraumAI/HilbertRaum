import { app, BrowserWindow, ipcMain, session, type Dialog, type MessageBoxReturnValue } from 'electron'
import {
  createCloseGuard,
  createStopWorkConfirm,
  createUnsavedCloseConfirm,
  createWindowSaveRequest,
  holdQueueOnQuit,
  stoppingWorkFrom,
  type ConfirmWindow,
  type StoppingWork
} from '../../src/main/close-guard'
import { createAppLifecycleHandlers } from '../../src/main/shutdown'
import { watchRunWindowGone } from '../../src/main/services/ocr/window-gone'
import { EVENTS, IPC } from '../../src/shared/ipc'
import type { DocTaskStatus } from '../../src/shared/types'
import { writeSmokeResult } from './electron-smoke-child'

// REAL-Electron smoke runner for #888 — NOT a test file. `tests/integration/close-guard-electron-smoke.test.ts`
// bundles this entry with esbuild and spawns it under the locally installed Electron binary, once per scenario.
// It wires the REAL close guard (`src/main/close-guard.ts`, bundled from source) to a real BrowserWindow, the
// real `ipcMain` and the real `app` quit sequence, and records every lifecycle event in order into a result
// JSON. What the unit suite's fakes model (a prevented close cancels a quit, `win.close()` emits `close` again,
// `event.sender` is the window's own `webContents`), this proves on Chromium.
//
// #910: the window's `closed` runs the PRODUCTION rule, `createAppLifecycleHandlers(...).onMainWindowClosed`
// (`src/main/shutdown.ts`, bundled from source; only that handler is used): on Windows and Linux the main window's
// last close quits, so an X ends in `closed → before-quit → will-quit`, and Electron's `window-all-closed` (kept
// below as index.ts keeps it, a fallback) never fires during that quit.
//
// The helper window stands in for the OCR rasterizer's: the PRODUCTION `watchRunWindowGone`
// (`src/main/services/ocr/window-gone.ts`) watches it, and `helper:run-aborted` / `helper:run-failed` records how a
// run there would end. The result is written at `will-quit`, so an outcome that comes after it is not listed.
//
// The page stands in for the preload: it answers `app:saveBeforeClose` on `app:saveBeforeCloseDone` with
// `{ requestId, unsaved }` (the preload's own reply is tests/unit/preload-save-before-close.test.ts's). The
// dialog is a stand-in that records and answers per scenario; the window calls the dialog makes (restore /
// show / focus) are recorded and not run, so no window appears on the desk.
//
// argv (last three): <resultPath> <selfTimeoutMs> <scenario> (tests/helpers/electron-smoke-child.ts sets the timeout)
//   x              win.close(); the page answers saved after 300 ms
//   quit            app.quit() (File → Exit, Cmd+Q); answered saved after 300 ms
//   xx              win.close() twice, the second 50 ms into the save
//   hang            the page never answers (bound 1.5 s here; the app's is CLOSE_SAVE_BOUND_MS)
//   keep            answered unsaved → Keep open; then win.close() again, answered saved
//   other-sender    a second window answers "saved" for the same request first; the main window answers
//                   unsaved after 300 ms → the dialog must appear (Close anyway)
//   loading         win.close() in the same tick `loadURL()` resolves, while `isLoading()` is still true:
//                   not asked (a page still loading holds no edit), closed at once
//   helper          as x, with a hidden, skip-taskbar helper window open at the X (the OCR rasterizer's and the
//                   print window's shape, #910): the quit the close starts closes it
//   quit-helper     as quit, with that helper open: the quit closes it while the guard still holds the main
//                   window for its save, so the run ends before `will-quit` (review SF-1)
//   stop-keep       #935: as helper, with an OCR run "in" the helper and a summary waiting behind it. The X asks
//                   "A document task is not finished yet." first (Keep open), nothing closes; the runner closes again
//                   200 ms later and answers Close anyway; then the hold, the save and the quit
//   quit-hold       #936: as quit-helper, with that OCR run and the waiting summary: the quit's belt
//                   (`holdQueueOnQuit`) and the guard hold the queue, so the summary does not start during the save
//
// In stop-keep and quit-hold a stand-in queue models DocTaskManager: the OCR run ends when the watch fails its page,
// and its end pumps the queue, which starts the summary unless a hold is set (`manager.ts` `pump`). `will-quit` records
// the summary's state (the teardown's `cancelAllDocTasks` would cancel it there). The guard gets the production
// running-task predicate (`stoppingWorkFrom`) and question (`createStopWorkConfirm`, over the recording dialog).

const [resultPath, selfTimeoutMs, scenario] = process.argv.slice(-3)
const t0 = Date.now()
const events: Array<{ ms: number; event: string }> = []
const log = (event: string): void => void events.push({ ms: Date.now() - t0, event })
let written = false
/** Final at `will-quit` (the test ends the row once it appears; nothing after `will-quit` is part of any row). */
function writeResult(outcome: string): void {
  if (written) return
  written = true
  writeSmokeResult(resultPath!, { scenario, outcome, events })
}

app.commandLine.appendSwitch('no-proxy-server')
let quitRequested = false
app.on('before-quit', () => {
  log('before-quit')
  quitRequested = true
})
app.on('window-all-closed', () => {
  log('window-all-closed')
  app.quit()
})
/** #935/#936 scenarios: the stand-in queue (an OCR run in the helper, a summary waiting behind it). */
const queued = scenario === 'stop-keep' || scenario === 'quit-hold'
let ocrRun: 'running' | 'ended' = 'running'
let summary: 'queued' | 'started' = 'queued'
let queueHeld = false
/** `manager.ts` `pump`: the next task starts unless a quit holds the queue. */
function pump(): void {
  if (queueHeld) {
    log('pump:held')
    return
  }
  if (summary !== 'queued') return
  summary = 'started'
  log('summary:started')
}
function holdQueue(by: string): void {
  log(`${by}:hold`)
  queueHeld = true
}
const activeTasks = (): DocTaskStatus[] => {
  const status = (kind: 'ocr' | 'summary', state: DocTaskStatus['state']): DocTaskStatus => ({
    jobId: kind,
    kind,
    documentIds: [kind],
    state,
    progress: { stepsDone: 0, stepsTotal: 0 }
  })
  return [...(ocrRun === 'running' ? [status('ocr', 'running')] : []), ...(summary === 'queued' ? [status('summary', 'queued')] : [])]
}
app.on('will-quit', () => {
  if (queued) log(`summary:${summary}`)
  log('will-quit')
  writeResult('quit')
})
// A hang names itself (the events so far), inside the test's child deadline and row budget: the test derives this
// timeout from the row budget. A scenario took up to 15 s from here under a 12-thread load (W8).
setTimeout(() => {
  log('runner-timeout')
  writeResult('timeout')
  app.exit(2)
}, Number(selfTimeoutMs)).unref()

/** The page's answer to request n (1-based): 'saved' | 'unsaved' | null (never answers). */
function answerFor(n: number): 'saved' | 'unsaved' | null {
  if (scenario === 'hang') return null
  if (scenario === 'keep') return n === 1 ? 'unsaved' : 'saved'
  if (scenario === 'other-sender') return 'unsaved'
  return 'saved'
}

function page(reply: string): string {
  return 'data:text/html,' + encodeURIComponent(`<script>${reply}</script>`)
}

app.whenReady().then(async () => {
  session.defaultSession.setSpellCheckerEnabled(false)
  const webPreferences = { nodeIntegration: true, contextIsolation: false, sandbox: false }
  const win = new BrowserWindow({ show: false, webPreferences })
  const withHelper = scenario === 'helper' || scenario === 'quit-helper' || queued
  let helperAlive = (): boolean => false
  if (withHelper) {
    const helper = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences })
    helper.on('closed', () => log('helper:closed'))
    helperAlive = () => !helper.isDestroyed()
    await helper.loadURL(page(''))
    watchRunWindowGone({
      app,
      webContents: helper.webContents,
      isWindowDestroyed: () => helper.isDestroyed(),
      failPage: (err) => {
        log(`helper:run-${err.name === 'AbortError' ? 'aborted' : 'failed'}`)
        if (queued) {
          // The OCR task unwinds and its dispatch's `finally` pumps the queue (a later microtask).
          void Promise.resolve().then(() => {
            ocrRun = 'ended'
            pump()
          })
        }
        return true
      },
      abortError: () => new DOMException('PDF rasterization aborted', 'AbortError'),
      log: console
    })
  }
  // The production quit rule (#910). Only `onMainWindowClosed` is used; the runner's own `will-quit` above ends it.
  const lifecycle = createAppLifecycleHandlers({
    performShutdown: async () => undefined,
    emergencyLock: () => undefined,
    exit: (code) => app.exit(code),
    createWindow: () => undefined,
    mainWindowCount: () => (win.isDestroyed() ? 0 : 1),
    platform: process.platform,
    quit: () => app.quit(),
    killSidecarChildren: () => undefined,
    log: console
  })
  let intruder: BrowserWindow | null = null
  const dropIntruder = (): void => {
    if (intruder && !intruder.isDestroyed()) intruder.destroy()
  }
  if (scenario === 'other-sender') {
    intruder = new BrowserWindow({ show: false, webPreferences })
    await intruder.loadURL(
      page(`require('electron').ipcRenderer.on('intrude', (_e, requestId) =>
        require('electron').ipcRenderer.send(${JSON.stringify(IPC.saveBeforeCloseDone)}, { requestId, unsaved: false }))`)
    )
  }
  const answers = JSON.stringify([null, ...[1, 2, 3, 4].map(answerFor)])
  await win.loadURL(
    page(`const { ipcRenderer } = require('electron'); const answers = ${answers};
      ipcRenderer.on(${JSON.stringify(EVENTS.saveBeforeClose)}, (_e, requestId) => {
        const a = answers[requestId];
        if (a === null) return;
        setTimeout(() => ipcRenderer.send(${JSON.stringify(IPC.saveBeforeCloseDone)}, { requestId, unsaved: a === 'unsaved' }), 300);
      });`)
  )
  // Measured on 43.8.6: `isLoading()` is still true when `loadURL()` resolves and turns false at
  // `did-stop-loading`, about 1 ms later. Every scenario but `loading` closes after that.
  if (scenario !== 'loading' && win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once('did-stop-loading', () => resolve()))
  }
  log('loaded')

  const request = createWindowSaveRequest({
    ipc: ipcMain,
    webContents: win.webContents,
    boundMs: scenario === 'hang' ? 1_500 : undefined
  })
  let dialogs = 0
  const dialog: Pick<Dialog, 'showMessageBox'> = {
    async showMessageBox(): Promise<MessageBoxReturnValue> {
      dialogs += 1
      log(`dialog#${dialogs}`)
      dropIntruder()
      // keep: Keep open (1) the first time; other-sender: Close anyway (2).
      return { response: scenario === 'keep' ? 1 : 2, checkboxChecked: false }
    }
  }
  // #935: the running-task question's dialog. stop-keep: Keep open (0) the first time, then Close anyway (1).
  let stopDialogs = 0
  const stopDialog: Pick<Dialog, 'showMessageBox'> = {
    async showMessageBox(): Promise<MessageBoxReturnValue> {
      stopDialogs += 1
      // The OCR window is still there while the question is up: a Keep open loses nothing.
      log(`stop-dialog#${stopDialogs}:helper-${helperAlive() ? 'alive' : 'gone'}`)
      return { response: stopDialogs === 1 ? 0 : 1, checkboxChecked: false }
    }
  }
  const recordOnly: ConfirmWindow = {
    isDestroyed: () => win.isDestroyed(),
    isMinimized: () => win.isMinimized(),
    restore: () => log('restore'),
    show: () => log('show'),
    focus: () => log('focus')
  }
  let closes = 0
  const guard = createCloseGuard({
    askWindowToSave: () => {
      log('ask')
      const answer = request()
      intruder?.webContents.send('intrude', 1)
      return answer.then((a) => {
        log(`answer:${a === null ? 'none' : a.unsaved ? 'unsaved' : 'saved'}`)
        return a
      })
    },
    confirmUnsaved: async () => {
      const choice = await createUnsavedCloseConfirm({ dialog, window: recordOnly, t: (key) => key, log: console })()
      if (choice === 'keep') setTimeout(() => win.close(), 200) // the user closes again later
      return choice
    },
    closeWindow: () => {
      log('guard:closeWindow')
      dropIntruder() // whatever happened, it is not needed any more (the quit would close it too, #910)
      if (!win.isDestroyed()) win.close()
    },
    quit: () => {
      log('guard:quit')
      app.quit()
    },
    consumeQuitRequest: () => {
      const asked = quitRequested
      quitRequested = false
      return asked
    },
    isShuttingDown: () => false,
    ...(queued
      ? {
          closeQuits: process.platform !== 'darwin',
          stoppingWork: () => stoppingWorkFrom(activeTasks()),
          confirmStopWork: async (work: StoppingWork) => {
            const choice = await createStopWorkConfirm({ dialog: stopDialog, window: recordOnly, t: (key) => key, log: console })(work)
            if (choice === 'keep') setTimeout(() => win.close(), 200) // the user closes again later
            return choice
          },
          holdWork: () => holdQueue('guard'),
          releaseWork: () => {
            log('guard:release')
            queueHeld = false
            pump()
          }
        }
      : {}),
    log: console
  })
  // #936: the belt, as index.ts wires it: every un-prevented quit holds the queue.
  if (queued) holdQueueOnQuit(app, () => holdQueue('belt'))
  win.on('close', (e) => {
    closes += 1
    let held = false
    guard.onClose({ preventDefault: () => ((held = true), e.preventDefault()) })
    log(`close#${closes}:${held ? 'held' : 'through'}`)
  })
  win.on('closed', () => {
    log('closed')
    lifecycle.onMainWindowClosed(guard.closedForQuit())
  })

  if (scenario === 'quit' || scenario === 'quit-helper' || scenario === 'quit-hold') app.quit()
  else win.close()
  if (scenario === 'xx') setTimeout(() => win.close(), 50)
})
