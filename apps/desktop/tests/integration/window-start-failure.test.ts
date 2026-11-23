import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// #1024 review M-2: what happens after the back end's start, in the rest of the `app.whenReady` callback (main/index.ts):
// the app protocol over the app's own renderer files, the menu, the window. A throw there used to reject the callback's
// promise: `unhandledRejection` logged a warning and no window ever opened, while the process held the single-instance
// lock, so every later launch only "focused" a window that did not exist. Now `index.ts` runs those steps through
// `runWindowStart` (main/backend-start.ts): a throw shows a native error box with fixed text in main's language, logs
// the error's code (never a path), and exits with code 1. `index.ts` cannot be imported under vitest; its wiring is
// pinned in tests/unit/backend-start-wiring.test.ts.

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  clipboard: { writeText: () => {} }
}))

import { runWindowStart } from '../../src/main/backend-start'
import { applyUiLanguageSetting } from '../../src/main/services/i18n'
import { initLogging, readLogTail } from '../../src/main/services/logging'
import { t } from '../../src/shared/i18n'
import { tempRoot } from '../helpers/db-fixtures'

/** What Node throws when the app's renderer folder cannot be listed: a file error whose message names the path. */
const RENDERER = 'C:\\Users\\someone\\AppData\\Local\\Temp\\hilbertraum-app\\resources\\app.asar\\out\\renderer'
const scandirError = (): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, scandir '${RENDERER}'`), { code: 'ENOENT', syscall: 'scandir' })

beforeEach(() => {
  initLogging(join(tempRoot('window-start-logs'), 'logs'))
  applyUiLanguageSetting('en')
})

describe('a throw after the back end’s start ends the app with a message, never a windowless process (#1024)', () => {
  it('a step that throws: one error box with the fixed text in main’s language, the code logged, exit 1', () => {
    const calls: string[] = []
    const showErrorBox = vi.fn((title: string, body: string) => {
      calls.push(`box:${title}|${body}`)
    })
    const exit = vi.fn((code: number) => {
      calls.push(`exit:${code}`)
    })
    applyUiLanguageSetting('de')
    runWindowStart(
      () => {
        throw scandirError()
      },
      { showErrorBox, exit }
    )
    const body = `${t('de', 'gate.startFailed.other')}\n\n${t('de', 'gate.startFailed.help')}`
    expect(calls).toEqual([`box:${t('de', 'app.fatal.title')}|${body}`, 'exit:1'])
    const line = readLogTail().find((l) => l.includes('[ERROR] App start failed after the back end'))
    expect(line).toBeDefined()
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toEqual({ error: 'Error', code: 'ENOENT', syscall: 'scandir' })
    expect(line).not.toContain('hilbertraum-app')
  })

  // On Linux the box needs a display; whatever stops it, the app must still end (a windowless process holds the
  // single-instance lock against every relaunch).
  it('an error box that throws still exits with code 1', () => {
    const exit = vi.fn()
    runWindowStart(
      () => {
        throw new TypeError('createWindow broke')
      },
      {
        showErrorBox: () => {
          throw new Error('no display')
        },
        exit
      }
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('steps that go through show nothing and exit nothing', () => {
    const showErrorBox = vi.fn()
    const exit = vi.fn()
    const steps = vi.fn()
    runWindowStart(steps, { showErrorBox, exit })
    expect(steps).toHaveBeenCalledTimes(1)
    expect(showErrorBox).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
