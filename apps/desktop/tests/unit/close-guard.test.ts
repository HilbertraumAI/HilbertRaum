import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseWindow, Dialog, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import {
  CLOSE_SAVE_BOUND_MS,
  createCloseGuard,
  createMainWindowCloseGuard,
  createUnsavedCloseConfirm,
  createWindowSaveRequest,
  trackQuitRequests,
  type ConfirmWindow,
  type UnsavedCloseChoice
} from '../../src/main/close-guard'
import { REVIEW_LOCK_FLUSH_BOUND_MS } from '../../src/renderer/lib/reviewSession'
import { BEFORE_CLOSE_SAVE_BOUND_MS } from '../../src/renderer/lib/beforeClose'
import { EVENTS, IPC } from '../../src/shared/ipc'
import { t } from '../../src/shared/i18n'
import type { SaveBeforeCloseResult } from '../../src/shared/types'
import { deferred, type Deferred } from '../helpers/deferred'

// #888: closing or quitting the app saves the window's pending edits first. Before this, the main
// window had no `close` handler and the renderer no unload hook: an X, File → Exit or Cmd+Q dropped
// a review edit inside its 600 ms pause, and one whose save had failed, without a word. The guard is
// electron-free (`index.ts` cannot be imported under vitest); its window, `ipcMain` and dialog are
// fakes here. The event order these fakes model (a prevented close cancels a quit; `win.close()`
// emits `close` again) was measured on Electron 43.8.6 (follow-ups wave 2, research A §3.2).

const quiet = { info: () => undefined, warn: () => undefined }

/** One macrotask turn (real timers): every promise reaction queued before it has run. */
const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
/** Lets the guard run to its next wait: its reactions, then the task it defers its close to. */
const settle = async (): Promise<void> => {
  await nextTask()
  await nextTask()
}
/** Runs every queued promise reaction (and the ones they queue), without letting a macrotask run. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

interface GuardHarnessOptions {
  /** `before-quit` fired before the first close (File → Exit, Cmd+Q). */
  quitFirst?: boolean
  /** A lock has begun (a quit teardown or a session end). */
  shuttingDown?: boolean
  /** The real request instead of a hand-settled answer. */
  ask?: () => Promise<SaveBeforeCloseResult | null>
  /** The save request throws instead of answering (a bug, a destroyed window). */
  askThrows?: boolean
}

/**
 * One guard over fakes that record each step. `close()` is one `close` event as Electron emits it;
 * the guard's `closeWindow` and `quit` each make Electron emit `close` again (measured), which the
 * fakes model by calling `close()`.
 */
function guardHarness(opts: GuardHarnessOptions = {}) {
  const steps: string[] = []
  const asks: Array<Deferred<SaveBeforeCloseResult | null>> = []
  const dialogs: Array<Deferred<UnsavedCloseChoice>> = []
  let quitRequested = opts.quitFirst === true
  let shuttingDown = opts.shuttingDown === true
  const guard = createCloseGuard({
    askWindowToSave: () => {
      steps.push('ask')
      if (opts.askThrows) throw new Error('the window is gone')
      if (opts.ask) return opts.ask()
      const answer = deferred<SaveBeforeCloseResult | null>()
      asks.push(answer)
      return answer.promise
    },
    confirmUnsaved: () => {
      steps.push('dialog')
      const choice = deferred<UnsavedCloseChoice>()
      dialogs.push(choice)
      return choice.promise
    },
    closeWindow: () => {
      steps.push('closeWindow')
      close()
    },
    quit: () => {
      steps.push('quit')
      close()
    },
    consumeQuitRequest: () => {
      const asked = quitRequested
      quitRequested = false
      return asked
    },
    isShuttingDown: () => shuttingDown,
    log: quiet
  })
  function close(): boolean {
    let held = false
    guard.onClose({ preventDefault: () => (held = true) })
    steps.push(held ? 'close:held' : 'close:through')
    return held
  }
  return {
    steps,
    asks,
    dialogs,
    close,
    requestQuit: () => (quitRequested = true),
    /** A session end locked the workspace (macOS `powerMonitor 'shutdown'`). */
    beginLock: () => (shuttingDown = true)
  }
}

describe('close guard — the window saves before it closes (#888)', () => {
  it('holds the first close, asks the window once, and a saved answer closes it exactly once', async () => {
    const h = guardHarness()
    expect(h.close()).toBe(true)
    expect(h.steps).toEqual(['ask', 'close:held'])
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    // The close the guard itself starts goes through (it is not held, nothing is asked again).
    expect(h.steps).toEqual(['ask', 'close:held', 'closeWindow', 'close:through'])
  })

  it('a second close while the window is saving is held and ignored: one ask, one close', async () => {
    const h = guardHarness()
    h.close()
    expect(h.close()).toBe(true) // the user clicks X again
    expect(h.steps).toEqual(['ask', 'close:held', 'close:held'])
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['ask', 'close:held', 'close:held', 'closeWindow', 'close:through'])
  })

  it('a close that came from a quit quits again after the save, and never only closes the window', async () => {
    const h = guardHarness({ quitFirst: true })
    h.close()
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    // The held close cancelled that quit: closing the window alone would leave macOS running windowless.
    expect(h.steps).toEqual(['ask', 'close:held', 'quit', 'close:through'])
  })

  it('a quit asked while the window is saving (Cmd+Q after the X) quits at the end', async () => {
    const h = guardHarness()
    h.close()
    h.requestQuit() // before-quit…
    h.close() // …then Electron closes the windows
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['ask', 'close:held', 'close:held', 'quit', 'close:through'])
  })

  it('once a lock has begun (a quit teardown, a session end), a close is not held and nothing is asked', () => {
    const h = guardHarness({ shuttingDown: true })
    expect(h.close()).toBe(false)
    expect(h.steps).toEqual(['close:through'])
  })

  // Code review round 3 (item 2): Electron drains the microtask queue before it reads the `close` event's
  // preventDefault, so a close the guard starts in a microtask still runs inside that event (a re-entrant
  // `win.close()`). Every outcome, the fast ones included, waits for a later task.
  it.each<[string, GuardHarnessOptions]>([
    ['the save request throws', { askThrows: true }],
    ['the window answers null at once (gone, crashed, loading)', { ask: () => Promise.resolve(null) }],
    ['the window answers saved at once', { ask: () => Promise.resolve({ unsaved: false }) }]
  ])('when %s, the window is closed in a later task, never inside the close event', async (_what, opts) => {
    const h = guardHarness(opts)
    h.close()
    await drainMicrotasks()
    expect(h.steps).toEqual(['ask', 'close:held'])
    await nextTask()
    expect(h.steps).toEqual(['ask', 'close:held', 'closeWindow', 'close:through'])
  })

  describe('a change that could not be saved asks first (owner call G-2)', () => {
    it('Keep open keeps the window, and the next close asks the window again', async () => {
      const h = guardHarness()
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog'])
      h.dialogs[0]!.resolve('keep')
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog'])
      h.close()
      h.asks[1]!.resolve({ unsaved: false })
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'ask', 'close:held', 'closeWindow', 'close:through'])
    })

    it('Close anyway closes the window exactly once', async () => {
      const h = guardHarness()
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      h.dialogs[0]!.resolve('close')
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'closeWindow', 'close:through'])
    })

    it('Try again asks the window again, asks the user again while it still fails, and closes once it is saved', async () => {
      const h = guardHarness()
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      h.dialogs[0]!.resolve('retry')
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'ask'])
      h.asks[1]!.resolve({ unsaved: true }) // the drive is still full
      await settle()
      h.dialogs[1]!.resolve('retry')
      await settle()
      h.asks[2]!.resolve({ unsaved: false }) // space freed meanwhile
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'ask', 'dialog', 'ask', 'closeWindow', 'close:through'])
    })

    it('Keep open after a quit cancels the quit too: a later X closes the window and does not quit', async () => {
      const h = guardHarness({ quitFirst: true })
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      h.dialogs[0]!.resolve('keep')
      await settle()
      h.close()
      h.asks[1]!.resolve({ unsaved: false })
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'ask', 'close:held', 'closeWindow', 'close:through'])
    })
  })

  it('main waits longer than the window’s own save bound, so a hung write is answered by the window first', () => {
    expect(CLOSE_SAVE_BOUND_MS).toBeGreaterThan(REVIEW_LOCK_FLUSH_BOUND_MS)
  })

  // Review round 2 (N3): a minimized window's timers can fire about a second late (background throttling), so the
  // window's bridge answers well before main gives up, and after the review store has answered itself.
  it('the bounds nest: the review store, then the window’s bridge, then main, with more than a second to spare', () => {
    expect(BEFORE_CLOSE_SAVE_BOUND_MS).toBeGreaterThan(REVIEW_LOCK_FLUSH_BOUND_MS)
    expect(CLOSE_SAVE_BOUND_MS - BEFORE_CLOSE_SAVE_BOUND_MS).toBeGreaterThan(1_000)
  })

  // Review round 2 (S2): a session end can lock the workspace while the save is out (macOS `powerMonitor 'shutdown'`
  // after the quit's close, #226). The write is then refused and the window answers unsaved; Try again can never
  // succeed, so the guard closes without asking.
  describe('a lock that began meanwhile closes without asking', () => {
    it('during the save: no dialog, the window closes once', async () => {
      const h = guardHarness()
      h.close()
      h.beginLock()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'closeWindow', 'close:through'])
    })

    it('during Try again’s save: no second dialog, the window closes once', async () => {
      const h = guardHarness()
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      h.dialogs[0]!.resolve('retry')
      await settle()
      h.beginLock()
      h.asks[1]!.resolve({ unsaved: true })
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'ask', 'closeWindow', 'close:through'])
    })

    it('while the dialog is up: even Keep open closes the window once', async () => {
      const h = guardHarness()
      h.close()
      h.asks[0]!.resolve({ unsaved: true })
      await settle()
      h.beginLock()
      h.dialogs[0]!.resolve('keep')
      await settle()
      expect(h.steps).toEqual(['ask', 'close:held', 'dialog', 'closeWindow', 'close:through'])
    })
  })

  // Review round 2 (S3): the guard's own catch. Without it a throw would leave the guard saving for good, and every
  // later close would be held and ignored: a window that can never be closed.
  it.each<[string]>([['the save request throws'], ['the dialog fails']])(
    'when %s, the window still closes exactly once',
    async (what) => {
      const h = guardHarness({ askThrows: what === 'the save request throws' })
      h.close()
      h.asks[0]?.resolve({ unsaved: true })
      await settle()
      h.dialogs[0]?.reject(new Error('dialog failed'))
      await settle()
      expect(h.steps.filter((s) => s === 'closeWindow')).toHaveLength(1)
      expect(h.steps.at(-1)).toBe('close:through')
    }
  )

  it('a window that never answers is closed once at the bound, and not before', async () => {
    vi.useFakeTimers()
    const w = fakeWindow()
    const h = guardHarness({ ask: createWindowSaveRequest({ ipc: w.ipc, webContents: w.webContents }) })
    h.close()
    expect(w.webContents.sent).toEqual([[EVENTS.saveBeforeClose, 1]])
    await vi.advanceTimersByTimeAsync(CLOSE_SAVE_BOUND_MS - 1)
    expect(h.steps).toEqual(['ask', 'close:held'])
    await vi.advanceTimersByTimeAsync(1)
    await drainMicrotasks() // the guard reaches its wait for a later task (code review round 3)…
    await vi.runOnlyPendingTimersAsync() // …and closes in it (a zero-millisecond advance does not run that task)
    expect(h.steps).toEqual(['ask', 'close:held', 'closeWindow', 'close:through'])
    expect(w.ipc.listenerCount(IPC.saveBeforeCloseDone)).toBe(0)
  })
})

interface FakeWindowState {
  destroyed?: boolean
  crashed?: boolean
  loading?: boolean
}

/** `ipcMain` and the main window's `webContents` as EventEmitters; `reply` is a preload's answer arriving. */
function fakeWindow(state: FakeWindowState = {}) {
  const ipc = new EventEmitter()
  const sent: unknown[][] = []
  const webContents = Object.assign(new EventEmitter(), {
    sent,
    send: (channel: string, ...args: unknown[]) => void sent.push([channel, ...args]),
    isDestroyed: () => state.destroyed === true,
    isCrashed: () => state.crashed === true,
    isLoading: () => state.loading === true
  })
  const reply = (payload: unknown, sender: unknown = webContents): void => {
    ipc.emit(IPC.saveBeforeCloseDone, { sender }, payload)
  }
  const listeners = (): number =>
    ipc.listenerCount(IPC.saveBeforeCloseDone) + webContents.listenerCount('render-process-gone')
  return { ipc, webContents, reply, listeners }
}

describe('close guard — the save request to the window (#888)', () => {
  it('takes only this window’s answer to this request: another sender and an earlier request are ignored', async () => {
    vi.useFakeTimers()
    const w = fakeWindow()
    const ask = createWindowSaveRequest({ ipc: w.ipc, webContents: w.webContents })
    const first = ask()
    await vi.advanceTimersByTimeAsync(CLOSE_SAVE_BOUND_MS) // the window gave no answer in time
    expect(await first).toBeNull()

    let answer: SaveBeforeCloseResult | null | undefined
    void ask().then((a) => (answer = a))
    expect(w.webContents.sent).toEqual([
      [EVENTS.saveBeforeClose, 1],
      [EVENTS.saveBeforeClose, 2]
    ])
    w.reply({ requestId: 2, unsaved: false }, new EventEmitter()) // another window
    w.reply({ requestId: 1, unsaved: false }) // the late answer to the first request
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toBeUndefined()
    w.reply({ requestId: 2, unsaved: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toEqual({ unsaved: true })
    expect(w.listeners()).toBe(0)
  })

  it.each<[string, boolean, unknown]>([
    ['unsaved: false', false, { unsaved: false }],
    ['unsaved: true', true, { unsaved: true }],
    ['no unsaved field', true, {}],
    ['a string', true, { unsaved: 'false' }]
  ])('an answer with %s reads as unsaved = %s (only an explicit false skips the question)', async (_what, unsaved, fields) => {
    const w = fakeWindow()
    const answer = createWindowSaveRequest({ ipc: w.ipc, webContents: w.webContents })()
    w.reply({ requestId: 1, ...(fields as object) })
    expect(await answer).toEqual({ unsaved })
  })

  it('answers null at once when the renderer process goes away mid-request, and removes both listeners', async () => {
    const w = fakeWindow()
    const answer = createWindowSaveRequest({ ipc: w.ipc, webContents: w.webContents })()
    expect(w.listeners()).toBe(2)
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(await answer).toBeNull()
    expect(w.listeners()).toBe(0)
  })

  it.each<[string, FakeWindowState]>([
    ['gone', { destroyed: true }],
    ['crashed', { crashed: true }],
    ['still loading', { loading: true }]
  ])('a window that is %s is not asked: null at once', async (_what, state) => {
    const w = fakeWindow(state)
    expect(await createWindowSaveRequest({ ipc: w.ipc, webContents: w.webContents })()).toBeNull()
    expect(w.webContents.sent).toEqual([])
    expect(w.listeners()).toBe(0)
  })
})

describe('close guard — the "could not be saved" dialog (#888, owner call G-2)', () => {
  function dialogHarness(opts: { response?: number; reject?: boolean; minimized?: boolean } = {}) {
    const steps: string[] = []
    const shown: Array<{ parent: BaseWindow | null; options: MessageBoxOptions }> = []
    const window: ConfirmWindow = {
      isDestroyed: () => false,
      isMinimized: () => opts.minimized === true,
      restore: () => void steps.push('restore'),
      show: () => void steps.push('show'),
      focus: () => void steps.push('focus')
    }
    const dialog: Pick<Dialog, 'showMessageBox'> = {
      async showMessageBox(a: BaseWindow | MessageBoxOptions, b?: MessageBoxOptions): Promise<MessageBoxReturnValue> {
        steps.push('dialog')
        shown.push(b ? { parent: a as BaseWindow, options: b } : { parent: null, options: a as MessageBoxOptions })
        if (opts.reject) throw new Error('dialog failed')
        return { response: opts.response ?? 1, checkboxChecked: false }
      }
    }
    const confirm = createUnsavedCloseConfirm({ dialog, window, t: (key) => t('de', key), log: quiet })
    return { confirm, steps, shown, window }
  }

  it('Try again is the default, Keep open answers Esc, Close anyway is never the default; modal, in the user’s language', async () => {
    const h = dialogHarness()
    await h.confirm()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]!.parent).toBe(h.window)
    expect(h.shown[0]!.options).toMatchObject({
      title: t('de', 'main.dialog.unsavedReview.title'),
      message: t('de', 'main.dialog.unsavedReview.message'),
      detail: t('de', 'main.dialog.unsavedReview.detail'),
      buttons: [
        t('de', 'main.dialog.unsavedReview.tryAgain'),
        t('de', 'main.dialog.unsavedReview.keepOpen'),
        t('de', 'main.dialog.unsavedReview.closeAnyway')
      ],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
  })

  it.each<[number, UnsavedCloseChoice]>([
    [0, 'retry'],
    [1, 'keep'],
    [2, 'close']
  ])('button %i answers %s', async (response, choice) => {
    expect(await dialogHarness({ response }).confirm()).toBe(choice)
  })

  it('restores a minimized window and brings it to the front before it asks', async () => {
    const h = dialogHarness({ minimized: true })
    await h.confirm()
    expect(h.steps).toEqual(['restore', 'show', 'focus', 'dialog'])
  })

  it('a dialog that fails closes the window rather than leaving it impossible to close', async () => {
    expect(await dialogHarness({ reject: true }).confirm()).toBe('close')
  })
})

describe('close guard — the main window wiring (#888)', () => {
  // Review round 2 (S4): what `index.ts` hands every main window, driven through the same composition it calls
  // (`createMainWindowCloseGuard` over the app-level `trackQuitRequests(app)`). Fakes stand for `app`, the window
  // and `ipcMain`; `app.quit()` fires `before-quit` and then closes the window, as Electron does.
  function wiring(dialogResponses: number[] = []) {
    const steps: string[] = []
    const w = fakeWindow()
    const app = Object.assign(new EventEmitter(), {
      quit: () => {
        steps.push('app.quit')
        app.emit('before-quit')
        close()
      }
    })
    const window = {
      webContents: w.webContents,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => undefined,
      show: () => undefined,
      focus: () => undefined,
      close: () => {
        steps.push('win.close')
        close()
      }
    }
    const dialog: Pick<Dialog, 'showMessageBox'> = {
      showMessageBox: async () => ({ response: dialogResponses.shift() ?? 1, checkboxChecked: false })
    }
    const guard = createMainWindowCloseGuard({
      window,
      app,
      ipc: w.ipc,
      dialog,
      t: (key) => key,
      quitRequests: trackQuitRequests(app),
      isShuttingDown: () => false,
      log: quiet
    })
    function close(): void {
      let held = false
      guard.onClose({ preventDefault: () => (held = true) })
      steps.push(held ? 'close:held' : 'close:through')
    }
    /** The window answers request `requestId`. */
    const answer = (requestId: number, unsaved: boolean): void => w.reply({ requestId, unsaved })
    return { steps, app, close, answer }
  }

  it('a quit (File → Exit, Cmd+Q) that reached the close quits again through app.quit after the save', async () => {
    const h = wiring()
    h.app.emit('before-quit')
    h.close()
    h.answer(1, false)
    await settle()
    expect(h.steps).toEqual(['close:held', 'app.quit', 'close:through'])
  })

  it('an X closes the window after the save and does not quit', async () => {
    const h = wiring()
    h.close()
    h.answer(1, false)
    await settle()
    expect(h.steps).toEqual(['close:held', 'win.close', 'close:through'])
  })

  it('Keep open after a quit clears that quit: the next X closes the window and does not quit', async () => {
    const h = wiring([1]) // Keep open
    h.app.emit('before-quit')
    h.close()
    h.answer(1, true)
    await settle()
    h.close()
    h.answer(2, false)
    await settle()
    expect(h.steps).toEqual(['close:held', 'close:held', 'win.close', 'close:through'])
  })

  it('index.ts gives every main window that guard and a `closed` reset, over one app-level quit flag', () => {
    // Source-text pin (the shutdown.test.ts idiom) — index.ts cannot be imported under vitest.
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(src).toContain('const quitRequests = trackQuitRequests(app)')
    expect(src).toMatch(
      /const closeGuard = createMainWindowCloseGuard\(\{\s*window: win,\s*app,\s*ipc: ipcMain,\s*dialog,\s*t: tMain,\s*quitRequests,\s*isShuttingDown: \(\) => lifecycle\.isShuttingDown\(\),\s*log\s*\}\)/
    )
    expect(src).toContain("win.on('close', closeGuard.onClose)")
    // S-5: a closed window's sender id is dropped and `mainWindow` stops pointing at it.
    expect(src).toMatch(/win\.on\('closed', \(\) => \{\s*trustedSenders\.delete\(senderId\)\s*if \(mainWindow === win\) mainWindow = null/)
  })
})
