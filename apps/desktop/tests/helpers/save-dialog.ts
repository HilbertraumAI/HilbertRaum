// The `dialog.showSaveDialog` fake for the suites that script or read the native save dialog (#898). Its only import
// is a type, so a hoisted `vi.mock('electron', …)` factory can use it. Create it in an ASYNC `vi.hoisted` and close the
// (sync or async) mock factory over it, then reset it in `beforeEach`:
//
//   const saveDialog = await vi.hoisted(async () => (await import('../helpers/save-dialog')).saveDialogFake())
//   vi.mock('electron', () => ({ dialog: { showSaveDialog: saveDialog.showSaveDialog } }))
//   beforeEach(() => saveDialog.reset())
//
// Never call `reset()` inside a row (it also puts `result` back to cancelled): a row that must show a dialog did NOT
// open reads `calls.length` before and after. A suite whose fake only ever cancels keeps its one-line literal, and
// `ipc-lock-coverage.test.ts` keeps its own counter (one count over the open AND the save dialog).
import type { SaveDialogOptions } from 'electron'

export interface SaveDialogAnswer {
  canceled: boolean
  filePath?: string
}

export interface SaveDialogFake {
  /** What every dialog answers until the row changes it. Default: cancelled. A free object: a row may answer
   *  `{ canceled: true, filePath }` (a cancel that still carries a path). */
  result: SaveDialogAnswer
  /** Set to hold every dialog open until the promise settles (a run genuinely in flight). */
  gate: Promise<void> | undefined
  /** The options of every dialog opened since the last `reset()`, in order (the window argument dropped). */
  readonly calls: readonly SaveDialogOptions[]
  /** The newest of `calls`; undefined when no dialog opened. */
  readonly lastOptions: SaveDialogOptions | undefined
  /** Cancelled, no gate, no calls: call it from the suite's `beforeEach`. */
  reset(): void
  /** The fake: `dialog: { showSaveDialog: fake.showSaveDialog }`. Takes `(options)` and `(window, options)`, records
   *  the options BEFORE it awaits the gate, then answers `result`. */
  showSaveDialog(...args: unknown[]): Promise<SaveDialogAnswer>
}

export function saveDialogFake(): SaveDialogFake {
  const calls: SaveDialogOptions[] = []
  const fake: SaveDialogFake = {
    result: { canceled: true },
    gate: undefined,
    calls,
    get lastOptions() {
      return calls.at(-1)
    },
    reset() {
      calls.length = 0
      fake.result = { canceled: true }
      fake.gate = undefined
    },
    async showSaveDialog(...args: unknown[]) {
      calls.push((args.length > 1 ? args[1] : args[0]) as SaveDialogOptions)
      if (fake.gate) await fake.gate
      return fake.result
    }
  }
  return fake
}
