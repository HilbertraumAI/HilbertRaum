import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseWindow, Dialog, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import {
  CLOSE_SAVE_BOUND_MS,
  createCloseGuard,
  createMainWindowCloseGuard,
  createStopWorkConfirm,
  createUnsavedCloseConfirm,
  createWindowSaveRequest,
  holdQueueOnQuit,
  stoppingWorkFrom,
  trackQuitRequests,
  type ConfirmWindow,
  type StopWorkChoice,
  type StoppingWork,
  type UnsavedCloseChoice
} from '../../src/main/close-guard'
import { createAppLifecycleHandlers } from '../../src/main/shutdown'
import { REVIEW_LOCK_FLUSH_BOUND_MS } from '../../src/renderer/lib/reviewSession'
import { BEFORE_CLOSE_SAVE_BOUND_MS } from '../../src/renderer/lib/beforeClose'
import { EVENTS, IPC } from '../../src/shared/ipc'
import { t, UI_LANGUAGE_CODES, type MessageKey } from '../../src/shared/i18n'
import type { DocTaskKind, DocTaskState, DocTaskStatus, SaveBeforeCloseResult } from '../../src/shared/types'
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
  /**
   * #935/#936: wire the running-task question and the queue hold, each recorded as a step ('stop-dialog', 'hold',
   * 'release'). Absent: the #888 guard exactly as before (the rows above pass none of these deps).
   */
  work?: {
    /** Windows and Linux: this close ends the app. */
    closeQuits: boolean
    /** What `stoppingWork()` answers. */
    stopping: StoppingWork | null
    /** A dep that throws: the question, the task list or the hold. */
    throws?: 'question' | 'taskList' | 'hold'
    /**
     * Review SF-1: a dialog its abort signal does not close (by default it answers as Electron's does: cancelled, i.e.
     * `cancelId`, Keep open); the test answers it itself.
     */
    ignoresAbort?: boolean
  }
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
  const stopDialogs: Array<Deferred<StopWorkChoice>> = []
  const asked: StoppingWork[] = []
  let quitRequested = opts.quitFirst === true
  /** Review SF-1: who listens for a quit (`onQuitRequest`), and each abort the question saw. */
  const quitListeners = new Set<() => void>()
  let shuttingDown = opts.shuttingDown === true
  const work = opts.work
  const workDeps = work
    ? {
        closeQuits: work.closeQuits,
        stoppingWork: () => {
          if (work.throws === 'taskList') throw new Error('the task list is gone')
          return work.stopping
        },
        confirmStopWork: (what: StoppingWork, signal: AbortSignal) => {
          steps.push('stop-dialog')
          asked.push(what)
          if (work.throws === 'question') return Promise.reject(new Error('dialog failed'))
          const choice = deferred<StopWorkChoice>()
          stopDialogs.push(choice)
          signal.addEventListener('abort', () => {
            steps.push('stop-dialog:aborted')
            if (!work.ignoresAbort) choice.resolve('keep') // Electron: "as if it was cancelled by the user"
          })
          return choice.promise
        },
        onQuitRequest: (listener: () => void) => {
          quitListeners.add(listener)
          if (quitRequested) listener()
          return () => void quitListeners.delete(listener)
        },
        holdWork: () => {
          steps.push('hold')
          if (work.throws === 'hold') throw new Error('the queue is gone')
        },
        releaseWork: () => void steps.push('release')
      }
    : {}
  const guard = createCloseGuard({
    ...workDeps,
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
    stopDialogs,
    /** The work each running-task question was asked about. */
    asked,
    close,
    /** `before-quit`: the app-level flag, and every `onQuitRequest` listener (review SF-1). */
    requestQuit: () => {
      quitRequested = true
      for (const listener of [...quitListeners]) listener()
    },
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

/** A task as `listActiveDocTasks()` returns it. */
function task(kind: DocTaskKind, state: DocTaskState = 'running'): DocTaskStatus {
  return { jobId: `${kind}-${state}`, kind, documentIds: ['doc'], state, progress: { stepsDone: 0, stepsTotal: 0 } }
}

describe('close guard — what a quitting close asks about (#935)', () => {
  it.each<[string, StoppingWork | null, DocTaskStatus[]]>([
    ['nothing', null, []],
    ['an OCR run', 'ocr', [task('ocr')]],
    ['a waiting OCR run', 'ocr', [task('summary'), task('ocr', 'queued')]],
    ['a waiting document translation', 'translation', [task('tree'), task('translation', 'queued')]],
    ['an OCR run and a translation', 'several', [task('ocr'), task('translation', 'queued')]],
    ['two OCR runs', 'several', [task('ocr'), task('ocr', 'queued')]],
    [
      'a deep index, an extract pass, a summary, a comparison and a categorization',
      null,
      [task('tree'), task('extract', 'queued'), task('summary', 'queued'), task('compare', 'queued'), task('categorize', 'queued')]
    ],
    ['finished, failed and cancelled ones', null, [task('ocr', 'done'), task('translation', 'failed'), task('ocr', 'cancelled')]]
  ])('%s → %s', (_what, work, tasks) => {
    expect(stoppingWorkFrom(tasks)).toBe(work)
  })
})

describe('close guard — a close that would stop a document task asks first (#935, #936)', () => {
  const windows = { closeQuits: true, stopping: 'ocr' } as const

  it('with no task to ask about, a close that quits holds the queue and saves as before', async () => {
    const h = guardHarness({ work: { closeQuits: true, stopping: null } })
    h.close()
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['hold', 'ask', 'close:held', 'closeWindow', 'close:through'])
  })

  it('Keep open: nothing is saved, held or closed, and the next close asks again', async () => {
    const h = guardHarness({ work: windows })
    expect(h.close()).toBe(true)
    // The question waits for a later task: it never opens inside the `close` event (code review round 3).
    expect(h.steps).toEqual(['close:held'])
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog'])
    expect(h.asked).toEqual(['ocr'])
    h.stopDialogs[0]!.resolve('keep')
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog'])
    h.close()
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'close:held', 'stop-dialog'])
  })

  it('Close anyway: then the queue hold, the save and the close, exactly once', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    h.stopDialogs[0]!.resolve('close')
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'hold', 'ask'])
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'hold', 'ask', 'closeWindow', 'close:through'])
  })

  it('a second close while the question is up is held and ignored: one question', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    expect(h.close()).toBe(true)
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'close:held'])
    expect(h.stopDialogs).toHaveLength(1)
  })

  it('on macOS the red button asks nothing and holds nothing: the app and its tasks go on (#910)', async () => {
    const h = guardHarness({ work: { closeQuits: false, stopping: 'ocr' } })
    h.close()
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['ask', 'close:held', 'closeWindow', 'close:through'])
  })

  // An explicit quit command (Ctrl+Q on Linux, ⌘Q or Dock Quit on macOS) stops the tasks without asking (G-1 (c)-P0),
  // and its close holds the queue: the quit already closed the OCR window, and nothing may start while it saves.
  it.each<[string, boolean]>([
    ['Windows or Linux', true],
    ['macOS', false]
  ])('a close a quit started asks nothing but holds the queue before the save (%s)', async (_os, closeQuits) => {
    const h = guardHarness({ quitFirst: true, work: { closeQuits, stopping: 'ocr' } })
    h.close()
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['hold', 'ask', 'close:held', 'quit', 'close:through'])
  })

  it('Close anyway, then Keep open on the unsaved question: the hold is released once and the window stays', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    h.stopDialogs[0]!.resolve('close')
    await settle()
    h.asks[0]!.resolve({ unsaved: true })
    await settle()
    h.dialogs[0]!.resolve('keep')
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'hold', 'ask', 'dialog', 'release'])
  })

  it.each<[string, UnsavedCloseChoice, string[]]>([
    ['Keep open releases the hold: the quit is off', 'keep', ['hold', 'ask', 'close:held', 'dialog', 'release']],
    ['Close anyway never releases it', 'close', ['hold', 'ask', 'close:held', 'dialog', 'quit', 'close:through']]
  ])('a close a quit started, with a change it could not save: %s', async (_what, choice, steps) => {
    const h = guardHarness({ quitFirst: true, work: { closeQuits: false, stopping: null } })
    h.close()
    h.asks[0]!.resolve({ unsaved: true })
    await settle()
    h.dialogs[0]!.resolve(choice)
    await settle()
    expect(h.steps).toEqual(steps)
  })

  // Review SF-1: an explicit quit never asks (G-1). One asked while the question is up (Ctrl+Q or a SIGTERM on Linux)
  // closes the dialog and counts as Close anyway: the hold, the save, then the quit again (its own close was held).
  it('a quit asked while the question is up closes it: Close anyway, then the hold, the save and the quit', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    h.requestQuit() // before-quit…
    h.close() // …then the quit's close, held and ignored
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'stop-dialog:aborted', 'close:held', 'hold', 'ask'])
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps.slice(-2)).toEqual(['quit', 'close:through'])
    expect(h.steps).not.toContain('release')
  })

  // Review SF-3: a dialog the abort does not close (a platform where the signal does nothing): whatever the user then
  // picks, the quit already happened, so the close goes on and quits.
  it.each<[StopWorkChoice]>([['close'], ['keep']])(
    'a quit asked while the question is up, the dialog answered %s afterwards: the close still goes on and quits',
    async (late) => {
      const h = guardHarness({ work: { ...windows, ignoresAbort: true } })
      h.close()
      await settle()
      h.requestQuit()
      h.close()
      h.stopDialogs[0]!.resolve(late)
      await settle()
      h.asks[0]!.resolve({ unsaved: false })
      await settle()
      expect(h.steps).toEqual(['close:held', 'stop-dialog', 'stop-dialog:aborted', 'close:held', 'hold', 'ask', 'quit', 'close:through'])
    }
  )

  it('Keep open answered before any quit: a later quit is not asked about and quits after the save', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    h.stopDialogs[0]!.resolve('keep')
    await settle()
    h.requestQuit() // the question is gone: nothing listens any more
    h.close()
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'hold', 'ask', 'close:held', 'quit', 'close:through'])
  })

  it('a quit already pending when the question would open: nothing is asked', async () => {
    const h = guardHarness({ work: windows })
    h.close()
    h.requestQuit() // before the question's later task
    h.close()
    await settle()
    expect(h.steps).toEqual(['close:held', 'close:held', 'hold', 'ask'])
    expect(h.stopDialogs).toHaveLength(0)
  })

  // Review SF-3: macOS red button, then ⌘Q during the save, then Keep open on the unsaved question: the guard held
  // nothing (a plain close), the belt did; Keep open calls that quit off, so the queue is released.
  it('macOS: the red button, ⌘Q during the save, Keep open on the unsaved question: the belt’s hold is released', async () => {
    const h = guardHarness({ work: { closeQuits: false, stopping: 'ocr' } })
    h.close()
    h.requestQuit()
    h.close()
    h.asks[0]!.resolve({ unsaved: true })
    await settle()
    h.dialogs[0]!.resolve('keep')
    await settle()
    expect(h.steps).toEqual(['ask', 'close:held', 'close:held', 'dialog', 'release'])
  })

  it.each<[string, StopWorkChoice]>([
    ['Keep open', 'keep'],
    ['Close anyway', 'close']
  ])('a lock that began while the question was up closes without the save (%s)', async (_answer, answer) => {
    const h = guardHarness({ work: windows })
    h.close()
    await settle()
    h.beginLock() // a session end
    h.stopDialogs[0]!.resolve(answer)
    await settle()
    expect(h.steps).toEqual(['close:held', 'stop-dialog', 'hold', 'closeWindow', 'close:through'])
  })

  // As #888's dialog: main cannot ask, so it closes; and a dep that fails never costs the review save.
  it.each<[string, 'question' | 'taskList' | 'hold', string[]]>([
    ['the question fails', 'question', ['close:held', 'stop-dialog', 'hold', 'ask']],
    ['the task list cannot be read (nothing is asked)', 'taskList', ['hold', 'ask', 'close:held']],
    ['the queue hold throws (nothing to ask about)', 'hold', ['hold', 'ask', 'close:held']]
  ])('when %s, the window is still saved and closed once', async (_what, throws, before) => {
    const h = guardHarness({ work: { closeQuits: true, stopping: throws === 'hold' ? null : 'ocr', throws } })
    h.close()
    await settle()
    expect(h.steps).toEqual(before)
    h.asks[0]!.resolve({ unsaved: false })
    await settle()
    expect(h.steps).toEqual([...before, 'closeWindow', 'close:through'])
  })
})

// Review SF-1: what the running-task question listens to.
describe('close guard — the app-level quit flag tells its listeners (#935 review SF-1)', () => {
  it('a listener hears every quit, and at once one still pending; reading the flag stays the guard’s, and an unsubscribed one hears nothing', () => {
    const app = new EventEmitter()
    const requests = trackQuitRequests(app)
    const heard: string[] = []
    const stop = requests.onRequest(() => heard.push('first'))
    app.emit('before-quit')
    expect(heard).toEqual(['first'])
    requests.onRequest(() => heard.push('late')) // the quit is still pending (nobody read it)
    expect(heard).toEqual(['first', 'late'])
    stop()
    expect(requests.consume()).toBe(true) // listening never read the flag
    app.emit('before-quit')
    expect(heard).toEqual(['first', 'late', 'late'])
  })
})

describe('close guard — every quit holds the document-task queue (#936)', () => {
  it.each<[string, number, unknown]>([
    ['a quit nobody prevented', 1, { defaultPrevented: false }],
    ['a quit a listener prevented (it never begins)', 0, { defaultPrevented: true }],
    ['an event with no flag', 1, {}]
  ])('%s: holds %i time(s)', (_what, holds, event) => {
    const app = new EventEmitter()
    let held = 0
    holdQueueOnQuit(app, () => void held++)
    app.emit('before-quit', event)
    expect(held).toBe(holds)
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
    const deps = { dialog, window, t: (key: MessageKey) => t('de', key), log: quiet }
    const confirm = createUnsavedCloseConfirm(deps)
    /** #935: the running-task question over the same window and dialog (built per call: the #888 rows never use it). */
    const confirmStop = (work: StoppingWork, signal?: AbortSignal): Promise<StopWorkChoice> =>
      createStopWorkConfirm(deps)(work, signal)
    return { confirm, confirmStop, steps, shown, window }
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

  describe('the "A document task is not finished yet." question (#935)', () => {
    it.each<[StoppingWork, MessageKey]>([
      ['ocr', 'main.dialog.taskRunning.detailOcr'],
      ['translation', 'main.dialog.taskRunning.detailTranslation'],
      ['several', 'main.dialog.taskRunning.detailSeveral']
    ])('%s: Keep open is the default and answers Esc, Close anyway never is; modal, in the user’s language', async (work, detail) => {
      const h = dialogHarness({ response: 0 })
      await h.confirmStop(work)
      expect(h.shown).toHaveLength(1)
      expect(h.shown[0]!.parent).toBe(h.window)
      expect(h.shown[0]!.options).toEqual({
        type: 'warning',
        title: t('de', 'main.dialog.taskRunning.title'),
        message: t('de', 'main.dialog.taskRunning.message'),
        detail: t('de', detail),
        buttons: [t('de', 'main.dialog.taskRunning.keepOpen'), t('de', 'main.dialog.taskRunning.closeAnyway')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    })

    // The two close questions read alike: the same Keep open and Close anyway in every language.
    it.each(UI_LANGUAGE_CODES)('%s: its buttons are the unsaved question’s Keep open and Close anyway', (lang) => {
      expect(t(lang, 'main.dialog.taskRunning.keepOpen')).toBe(t(lang, 'main.dialog.unsavedReview.keepOpen'))
      expect(t(lang, 'main.dialog.taskRunning.closeAnyway')).toBe(t(lang, 'main.dialog.unsavedReview.closeAnyway'))
    })

    it.each<[number, StopWorkChoice]>([
      [0, 'keep'],
      [1, 'close']
    ])('button %i answers %s', async (response, choice) => {
      expect(await dialogHarness({ response }).confirmStop('ocr')).toBe(choice)
    })

    it('restores a minimized window and brings it to the front before it asks', async () => {
      const h = dialogHarness({ minimized: true, response: 0 })
      await h.confirmStop('translation')
      expect(h.steps).toEqual(['restore', 'show', 'focus', 'dialog'])
    })

    it('a dialog that fails closes (main cannot ask)', async () => {
      expect(await dialogHarness({ reject: true }).confirmStop('ocr')).toBe('close')
    })

    // Review SF-1: the guard closes the dialog through its signal when a quit is asked.
    it('hands the dialog the signal that closes it', async () => {
      const h = dialogHarness({ response: 0 })
      const quit = new AbortController()
      await h.confirmStop('ocr', quit.signal)
      expect(h.shown[0]!.options.signal).toBe(quit.signal)
    })
  })
})

describe('close guard — the main window wiring (#888)', () => {
  // Review round 2 (S4): what `index.ts` hands every main window, driven through the same composition it calls
  // (`createMainWindowCloseGuard` over the app-level `trackQuitRequests(app)`). Fakes stand for `app`, the window
  // and `ipcMain`; `app.quit()` fires `before-quit` and then closes the window, as Electron does.
  function wiring(
    dialogResponses: number[] = [],
    /**
     * #935/#936: the platform and the doc-task manager's active tasks (default: Windows, none). `dialogWaitsForAbort`:
     * the running-task dialog stays up until its signal fires, then answers as Electron does (`cancelId`).
     */
    more: { platform?: string; tasks?: DocTaskStatus[]; dialogWaitsForAbort?: boolean } = {}
  ) {
    const steps: string[] = []
    /** #936: the manager's queue calls, in order. */
    const queue: string[] = []
    /** The title (a key: `t` is the identity) and detail of every dialog shown. */
    const shown: Array<{ title?: string; detail?: string }> = []
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
      async showMessageBox(a: BaseWindow | MessageBoxOptions, b?: MessageBoxOptions): Promise<MessageBoxReturnValue> {
        const options = b ?? (a as MessageBoxOptions)
        shown.push({ title: options.title, detail: options.detail })
        const signal = options.signal
        if (more.dialogWaitsForAbort && signal) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          steps.push('dialog:aborted')
          return { response: options.cancelId ?? 0, checkboxChecked: false }
        }
        return { response: dialogResponses.shift() ?? 1, checkboxChecked: false }
      }
    }
    const quitRequests = trackQuitRequests(app)
    const guard = createMainWindowCloseGuard({
      window,
      app,
      ipc: w.ipc,
      dialog,
      t: (key) => key,
      quitRequests,
      isShuttingDown: () => false,
      platform: more.platform ?? 'win32',
      listActiveDocTasks: () => more.tasks ?? [],
      holdWork: () => void queue.push('hold'),
      releaseWork: () => void queue.push('release'),
      log: quiet
    })
    function close(): void {
      let held = false
      guard.onClose({ preventDefault: () => (held = true) })
      steps.push(held ? 'close:held' : 'close:through')
    }
    /** The window answers request `requestId`. */
    const answer = (requestId: number, unsaved: boolean): void => w.reply({ requestId, unsaved })
    return { steps, queue, shown, app, close, answer, quitRequests, guard }
  }

  // #935/#936: the composition over the manager's own task list, the platform and the queue calls (`index.ts` passes
  // `ctx.docTasks`' methods).
  it('an X on Windows with a document translation waiting asks first; Keep open keeps all, Close anyway holds, saves, closes', async () => {
    const h = wiring([0, 1], { tasks: [task('summary'), task('translation', 'queued')] }) // Keep open, then Close anyway
    h.close()
    await settle()
    expect(h.shown).toEqual([{ title: 'main.dialog.taskRunning.title', detail: 'main.dialog.taskRunning.detailTranslation' }])
    expect(h.steps).toEqual(['close:held'])
    expect(h.queue).toEqual([])
    h.close()
    await settle()
    expect(h.shown).toHaveLength(2)
    h.answer(1, false) // the save after Close anyway: the first request this window got
    await settle()
    expect(h.steps).toEqual(['close:held', 'close:held', 'win.close', 'close:through'])
    expect(h.queue).toEqual(['hold'])
  })

  it.each<[string, string, DocTaskStatus[]]>([
    ['on macOS (the red button) with an OCR run', 'darwin', [task('ocr')]],
    ['on Windows with only a deep index running', 'win32', [task('tree'), task('extract', 'queued')]]
  ])('an X %s asks nothing and saves at once', async (_what, platform, tasks) => {
    const h = wiring([], { platform, tasks })
    h.close()
    h.answer(1, false)
    await settle()
    expect(h.shown).toEqual([])
    expect(h.steps).toEqual(['close:held', 'win.close', 'close:through'])
    expect(h.queue).toEqual(platform === 'darwin' ? [] : ['hold'])
  })

  // Review SF-1 through the composition: `trackQuitRequests`' listener, the signal `createStopWorkConfirm` hands the
  // dialog, and Electron's answer to an aborted box (`cancelId`, Keep open) read as Close anyway.
  it('a quit asked while the running-task question is up closes the dialog; the window saves and the app quits', async () => {
    const h = wiring([], { tasks: [task('ocr')], dialogWaitsForAbort: true })
    h.close()
    await settle()
    expect(h.shown).toHaveLength(1)
    h.app.emit('before-quit') // Ctrl+Q or a SIGTERM on Linux…
    h.close() // …and the quit's close, held and ignored
    await settle()
    h.answer(1, false)
    await settle()
    expect(h.steps).toEqual(['close:held', 'close:held', 'dialog:aborted', 'app.quit', 'close:through'])
    expect(h.queue).toEqual(['hold'])
  })

  it('a quit with a change it could not save, then Keep open: the queue the quit held goes on', async () => {
    const h = wiring([1], { tasks: [task('ocr')] }) // Keep open on the unsaved question
    h.app.emit('before-quit')
    h.close()
    h.answer(1, true)
    await settle()
    expect(h.shown).toEqual([{ title: 'main.dialog.unsavedReview.title', detail: 'main.dialog.unsavedReview.detail' }])
    expect(h.queue).toEqual(['hold', 'release'])
  })

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

  // #910 review N-9 (macOS): the app stays open after the red button but not after ⌘Q or Dock Quit, and a Dock click
  // between the window's `closed` and that quit's `will-quit` must open nothing. What tells the two apart at `closed`
  // is the guard's own answer for this close (code review: not the app-level quit flag, which only a consume clears).
  it.each<[string, boolean, number[], (h: ReturnType<typeof wiring>) => Promise<void>]>([
    ['a quit the guard let go on', true, [], async (h) => {
      h.app.emit('before-quit')
      h.close()
      h.answer(1, false)
      await settle()
    }],
    ['an X', false, [], async (h) => {
      h.close()
      h.answer(1, false)
      await settle()
    }],
    ['an X after a quit was kept open', false, [1], async (h) => {
      h.app.emit('before-quit')
      h.close()
      h.answer(1, true)
      await settle()
      h.close()
      h.answer(2, false)
      await settle()
    }]
  ])('once the window closed through %s, its guard closed it for a quit: %s', async (_what, forQuit, dialog, run) => {
    const h = wiring(dialog)
    await run(h)
    expect(h.steps.at(-1)).toBe('close:through')
    expect(h.guard.closedForQuit()).toBe(forQuit)
  })

  // #910 code review: a `before-quit` that this window's guard never saw leaves the app-level flag set (only a guard's
  // consume clears it). Read at `closed`, as round 2 did, it made a later red-button close block every Dock click.
  it('a plain close with a stale app-level quit flag: on macOS a Dock click still opens the window (#910 code review)', async () => {
    const h = wiring()
    const order: string[] = []
    const lifecycle = createAppLifecycleHandlers({
      performShutdown: async () => undefined,
      emergencyLock: () => undefined,
      exit: () => undefined,
      createWindow: () => order.push('createWindow'),
      mainWindowCount: () => 0, // the window is gone
      platform: 'darwin',
      quit: () => order.push('quit'),
      killSidecarChildren: () => undefined,
      log: { ...quiet, error: () => undefined }
    })
    h.close() // the red button
    h.answer(1, false)
    await settle()
    h.app.emit('before-quit') // a quit request no close of this window saw: the flag stays set
    lifecycle.onMainWindowClosed(h.guard.closedForQuit()) // the window's `closed`, as index.ts wires it
    lifecycle.onActivate() // a Dock click
    expect(order).toEqual(['createWindow'])
    expect(h.quitRequests.consume()).toBe(true) // the scenario: the stale flag really was set
  })

  it('index.ts gives every main window that guard and a `closed` reset, over one app-level quit flag', () => {
    // Source-text pin (the shutdown.test.ts idiom) — index.ts cannot be imported under vitest.
    const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
    expect(src).toContain('const quitRequests = trackQuitRequests(app)')
    // #935/#936: the platform, the manager's task list and its queue hold, read live off `ctx` (null until the backend
    // is up, so no work then).
    expect(src).toMatch(
      /const closeGuard = createMainWindowCloseGuard\(\{\s*window: win,\s*app,\s*ipc: ipcMain,\s*dialog,\s*t: tMain,\s*quitRequests,\s*isShuttingDown: \(\) => lifecycle\.isShuttingDown\(\),\s*platform: process\.platform,\s*listActiveDocTasks: \(\) => ctx\?\.docTasks\?\.listActiveDocTasks\(\) \?\? \[\],\s*holdWork: \(\) => ctx\?\.docTasks\?\.holdQueueForQuit\(\),\s*releaseWork: \(\) => ctx\?\.docTasks\?\.releaseQueueHold\(\),\s*log\s*\}\)/
    )
    // #936: the belt — every un-prevented quit holds the queue, once per app.
    expect(src).toContain('holdQueueOnQuit(app, () => ctx?.docTasks?.holdQueueForQuit())')
    expect(src).toContain("win.on('close', closeGuard.onClose)")
    // S-5: a closed window's sender id is dropped and `mainWindow` stops pointing at it.
    expect(src).toMatch(/win\.on\('closed', \(\) => \{\s*trustedSenders\.delete\(senderId\)\s*if \(mainWindow === win\) mainWindow = null/)
    // #910 code review: the lifecycle hears this guard's own answer for the close.
    expect(src).toContain('lifecycle.onMainWindowClosed(closeGuard.closedForQuit())')
  })
})
