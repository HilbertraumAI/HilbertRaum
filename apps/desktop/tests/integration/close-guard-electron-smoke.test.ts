import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { runSmokeChild } from '../helpers/electron-smoke-child'
import { testBudgetMs } from '../helpers/hang-budget'

// #888 on real Electron: the close guard (`src/main/close-guard.ts`), bundled from source into
// `tests/helpers/closeGuardSmokeRunner.ts`, drives a real BrowserWindow, the real `ipcMain` and the
// real quit sequence, one Electron child per scenario. The unit suite (tests/unit/close-guard.test.ts)
// pins the guard's decisions over fakes; what only Chromium can show lives here: that a prevented
// close really cancels a quit and the guard's `app.quit()` really ends the app, that the close the
// guard starts is the one that goes through, and that `event.sender` is the window's own
// `webContents` (a second window's answer is ignored). Electron 43.8.6 measured this order on
// Windows 11 (follow-ups wave 2, research A §3.2); this file keeps it measured. Since #910 the runner's
// `closed` runs the production quit rule (`createAppLifecycleHandlers(...).onMainWindowClosed`, bundled
// from `src/main/shutdown.ts`): an X quits from the window's own `closed`, so `window-all-closed` never
// fires, and a hidden helper window open at the X (the OCR rasterizer's shape) no longer keeps the app
// running with no window.
//
// SKIPS where the Electron binary is absent (CI installs none) and on Linux without a display, like
// tests/integration/evidence-pack-pdf-smoke.test.ts.

const req = createRequire(__filename)

function electronBinaryPath(): string | null {
  try {
    const pkgDir = dirname(req.resolve('electron/package.json'))
    const bin = join(pkgDir, 'dist', readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim())
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

const ELECTRON_BIN = electronBinaryPath()
const displayReachable = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const enabled = ELECTRON_BIN !== null && displayReachable

interface SmokeResult {
  scenario: string
  outcome: 'quit' | 'timeout'
  events: Array<{ ms: number; event: string }>
}

let root = ''
let runnerPath = ''

// A row takes 2-4 s alone; under a 12-thread CPU load up to 31 s, of which the runner used up to 15 s (W8). The
// child's bounds come from this budget (tests/helpers/electron-smoke-child.ts): deadline 60 s, runner self-timeout
// 50 s, so a hang reports itself by name inside the row.
const ROW_BUDGET_MS = testBudgetMs(70_000)

async function runScenario(scenario: string): Promise<SmokeResult> {
  const { result, stderr } = await runSmokeChild<SmokeResult>({
    what: scenario,
    bin: ELECTRON_BIN!,
    runnerPath,
    resultPath: join(root, `${scenario}.json`),
    profileDir: join(root, `profile-${scenario}`),
    rowBudgetMs: ROW_BUDGET_MS
  })
  expect(result.outcome, `${scenario}: ${JSON.stringify(result.events)}\n${stderr}`).toBe('quit')
  return result
}

const names = (r: SmokeResult): string[] => r.events.map((e) => e.event).filter((e) => e !== 'loaded')
const at = (r: SmokeResult, event: string): number => r.events.find((e) => e.event === event)!.ms

describe.skipIf(!enabled)('close guard on real Electron (#888; skips where the Electron binary is absent, e.g. CI)', () => {
  beforeAll(async () => {
    root = tempRoot('closeguard')
    runnerPath = join(root, 'close-guard-smoke-runner.cjs')
    const esbuild = await import('esbuild')
    await esbuild.build({
      entryPoints: [join(__dirname, '..', 'helpers', 'closeGuardSmokeRunner.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      outfile: runnerPath,
      logLevel: 'silent'
    })
  }, testBudgetMs(60_000))

  it('an X: held once, saved, then the guard’s own close goes through and the app quits', async () => {
    const r = await runScenario('x')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:saved',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)

  it('a quit: the held close cancels it, and the guard’s quit after the save ends the app', async () => {
    const r = await runScenario('quit')
    expect(names(r)).toEqual([
      'before-quit',
      'ask',
      'close#1:held',
      'answer:saved',
      'guard:quit',
      'before-quit',
      'close#2:through',
      'closed',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)

  it('a second X while saving is held and ignored: one save, one close', async () => {
    const r = await runScenario('xx')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'close#2:held',
      'answer:saved',
      'guard:closeWindow',
      'close#3:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)

  it('a window that never answers closes at the bound', async () => {
    const r = await runScenario('hang')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:none',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
    expect(at(r, 'answer:none') - at(r, 'ask')).toBeGreaterThanOrEqual(1_500)
  }, ROW_BUDGET_MS)

  it('Keep open keeps the window; the next close asks again and closes once it is saved', async () => {
    const r = await runScenario('keep')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:unsaved',
      'show',
      'focus',
      'dialog#1',
      'ask',
      'close#2:held',
      'answer:saved',
      'guard:closeWindow',
      'close#3:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)

  it('a window still loading its page is not asked and closes at once', async () => {
    const r = await runScenario('loading')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:none',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
    expect(at(r, 'answer:none') - at(r, 'ask')).toBeLessThan(500)
  }, ROW_BUDGET_MS)

  // #910: before, the X closed the main window and the app went on running with no window (the runner timed out),
  // the workspace unlocked, until the helper went.
  it('an X with a hidden helper window open quits: the quit closes the helper, then will-quit', async () => {
    const r = await runScenario('helper')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:saved',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'before-quit',
      'helper:closed',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)

  // #910 review SF-1: a quit the guard holds (Ctrl+Q on Linux, ⌘Q or Dock Quit on macOS, File → Exit in a development
  // build) closes the helper window while the main window still saves, so a run there ends before `will-quit` — the
  // quit's own cancel. It must end as an abort (the OCR task: cancelled), not as a failure (an audit "failed" entry).
  it('a quit the guard holds with a helper window open: the run there ends as an abort before will-quit', async () => {
    const r = await runScenario('quit-helper')
    expect(names(r).filter((e) => !e.startsWith('helper:run-'))).toEqual([
      'before-quit',
      'ask',
      'close#1:held',
      'helper:closed',
      'answer:saved',
      'guard:quit',
      'before-quit',
      'close#2:through',
      'closed',
      'will-quit'
    ])
    const runs = names(r).filter((e) => e.startsWith('helper:run-'))
    expect(runs).toEqual(['helper:run-aborted'])
    expect(names(r).indexOf('helper:run-aborted')).toBeLessThan(names(r).indexOf('will-quit'))
  }, ROW_BUDGET_MS)

  it('another window’s answer to the same request is ignored: the main window’s “unsaved” brings the dialog', async () => {
    const r = await runScenario('other-sender')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:unsaved',
      'show',
      'focus',
      'dialog#1',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'before-quit',
      'will-quit'
    ])
  }, ROW_BUDGET_MS)
})
