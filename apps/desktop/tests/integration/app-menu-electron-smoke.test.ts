import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { testBudgetMs } from '../helpers/hang-budget'

// #912 on real Electron: the production application menu (`src/main/app-menu.ts`), the production menu-bar rule and
// the production DevTools switch (`devToolsAllowed`, `src/main/window-security.ts`), bundled from source into
// `tests/helpers/appMenuSmokeRunner.ts`, on a real shown window placed off screen, one Electron child per build kind.
// The keys are pressed with `webContents.sendInputEvent`, which reaches the menu's accelerators (a CDP key event does
// not; follow-ups wave 3, research A §1). The unit suite (tests/unit/app-menu.test.ts) pins the template; what only
// Chromium shows lives here: that Ctrl+R, Ctrl+Shift+R and Ctrl+Shift+I really do nothing in a released build (nor does
// `openDevTools()`), that the zoom and close keys still work with the bar hidden, and that Ctrl+= zooms in. A development
// build is the control: the same runner sees its reload and its DevTools.
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
}

let root = ''
let runnerPath = ''

async function runBuild(build: 'packaged' | 'dev'): Promise<MenuSmokeResult> {
  const resultPath = join(root, `${build}.json`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // must launch as Electron, never as plain node
  const args = [`--user-data-dir=${join(root, `profile-${build}`)}`, runnerPath, resultPath, build]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const stderr: string[] = []
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(ELECTRON_BIN!, args, { env, windowsHide: true })
    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    child.on('error', reject)
    child.on('exit', (c) => resolve(c ?? -1))
  })
  if (!existsSync(resultPath)) throw new Error(`${build}: no result (exit ${code})\n${stderr.join('')}`)
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as MenuSmokeResult
  expect(result.outcome, `${build}: ${result.error ?? ''} ${JSON.stringify(result.rows)}\n${stderr.join('')}`).toBe('done')
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

  it('a released build: no reload, no developer tools, no menu bar; zoom (Ctrl+= too) and close still work', async () => {
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
      openDevTools: false
    })
  }, testBudgetMs(45_000))

  it('a development build (the control): the same keys reload the window and open the developer tools', async () => {
    const r = await runBuild('dev')
    expect(r.rows).toMatchObject({ 'Ctrl+=': true, 'Ctrl+R': true, 'Ctrl+Shift+R': true, 'Ctrl+Shift+I': true })
  }, testBudgetMs(45_000))
})
