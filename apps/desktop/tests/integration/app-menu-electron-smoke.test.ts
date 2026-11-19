import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { runSmokeChild } from '../helpers/electron-smoke-child'
import { testBudgetMs } from '../helpers/hang-budget'

// #912 on real Electron: the production application menu (`src/main/app-menu.ts`), the production menu-bar rule and
// the production DevTools switch (`devToolsAllowed`, `src/main/window-security.ts`), bundled from source into
// `tests/helpers/appMenuSmokeRunner.ts`, on a real shown window placed off screen, one Electron child per build kind.
// The keys are pressed with `webContents.sendInputEvent`, which reaches the menu's accelerators (a CDP key event does
// not; follow-ups wave 3, research A §1). The unit suite (tests/unit/app-menu.test.ts) pins the template; what only
// Chromium shows lives here: that Ctrl+R, Ctrl+Shift+R and Ctrl+Shift+I really do nothing in a released build (nor does
// `openDevTools()`), that the zoom and close keys still work with the bar hidden, and that Ctrl+= zooms in. A development
// build is the control: the same runner sees its reload and its DevTools. Every key step runs in the ACTIVE window (an
// inactive one reaches no accelerator) and runs again when another app takes the activation on the way (follow-ups
// wave 3 W8: another Electron app starting at the same time did, every time).
//
// SKIPS where the Electron binary is absent (CI installs none) and on Linux without a display, like
// tests/integration/close-guard-electron-smoke.test.ts. macOS (⌘ keys through native menu selectors) is owed by hand.

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
// The macOS menu is native (⌘C/⌘V are menu selectors, not keys this runner can check the same way): owed on a Mac.
const enabled = ELECTRON_BIN !== null && displayReachable && process.platform !== 'darwin'

interface MenuSmokeResult {
  build: string
  outcome: 'done' | 'error' | 'timeout'
  error?: string
  rows: Record<string, boolean>
  /** Key steps that found the window inactive and activated it first (a diagnosis, not a row). */
  reactivated?: string[]
  /** Key steps the runner ran again because the window lost the activation on the way (a diagnosis, not a row). */
  lostActivation?: string[]
}

let root = ''
let runnerPath = ''

// A released-build row takes about 7 s alone; under a 12-thread CPU load up to 43 s, Electron's teardown included (W8).
// The child's bounds come from this budget (tests/helpers/electron-smoke-child.ts): deadline 65 s, runner self-timeout
// 55 s, so a hang reports itself by name (the step, its attempt and the wait) inside the row.
const ROW_BUDGET_MS = testBudgetMs(75_000)

async function runBuild(build: 'packaged' | 'dev'): Promise<MenuSmokeResult> {
  const { result, stderr } = await runSmokeChild<MenuSmokeResult>({
    what: build,
    bin: ELECTRON_BIN!,
    runnerPath,
    resultPath: join(root, `${build}.json`),
    profileDir: join(root, `profile-${build}`),
    rowBudgetMs: ROW_BUDGET_MS
  })
  const activation = JSON.stringify({ reactivated: result.reactivated, lostActivation: result.lostActivation })
  const why = `${build}: ${result.error ?? ''} ${JSON.stringify(result.rows)} ${activation}\n${stderr}`
  expect(result.outcome, why).toBe('done')
  return result
}

describe.skipIf(!enabled)('the application menu on real Electron (#912; skips where the Electron binary is absent, e.g. CI)', () => {
  beforeAll(async () => {
    root = tempRoot('appmenu')
    runnerPath = join(root, 'app-menu-smoke-runner.cjs')
    const esbuild = await import('esbuild')
    await esbuild.build({
      entryPoints: [join(__dirname, '..', 'helpers', 'appMenuSmokeRunner.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      outfile: runnerPath,
      logLevel: 'silent'
    })
  }, testBudgetMs(60_000))

  it('a released build: no reload, no developer tools, no menu bar (Alt included); zoom (Ctrl+= too) and close work', async () => {
    const r = await runBuild('packaged')
    expect(r.rows).toEqual({
      menuBarVisible: false,
      'Ctrl+=': true,
      'Ctrl+Shift+=': true,
      'Ctrl+-': true,
      'Ctrl+0': true,
      'Ctrl+W': true,
      'Ctrl+R': false,
      'Ctrl+Shift+R': false,
      'Ctrl+Shift+I': false,
      openDevTools: false,
      'Alt, Alt+F/E/V/W': false
    })
  }, ROW_BUDGET_MS)

  it('a development build (the control): the same keys reload, open the developer tools and bring up the bar', async () => {
    const r = await runBuild('dev')
    expect(r.rows).toMatchObject({
      'Ctrl+=': true,
      'Ctrl+R': true,
      'Ctrl+Shift+R': true,
      'Ctrl+Shift+I': true,
      Alt: true
    })
  }, ROW_BUDGET_MS)
})
