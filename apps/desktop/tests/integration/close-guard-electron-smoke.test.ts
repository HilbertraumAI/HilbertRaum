import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { testBudgetMs } from '../helpers/hang-budget'

// #888 on real Electron: the close guard (`src/main/close-guard.ts`), bundled from source into
// `tests/helpers/closeGuardSmokeRunner.ts`, drives a real BrowserWindow, the real `ipcMain` and the
// real quit sequence, one Electron child per scenario. The unit suite (tests/unit/close-guard.test.ts)
// pins the guard's decisions over fakes; what only Chromium can show lives here: that a prevented
// close really cancels a quit and the guard's `app.quit()` really ends the app, that the close the
// guard starts is the one that goes through, and that `event.sender` is the window's own
// `webContents` (a second window's answer is ignored). Electron 43.8.6 measured this order on
// Windows 11 (follow-ups wave 2, research A §3.2); this file keeps it measured.
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

async function runScenario(scenario: string): Promise<SmokeResult> {
  const resultPath = join(root, `${scenario}.json`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // must launch as Electron, never as plain node
  // An isolated profile per child (the pdf smoke's lesson: a shared default profile's singleton lock
  // crashes startup when another Electron runs).
  const args = [`--user-data-dir=${join(root, `profile-${scenario}`)}`, runnerPath, resultPath, scenario]
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  const stderr: string[] = []
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(ELECTRON_BIN!, args, { env, windowsHide: true })
    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    child.on('error', reject)
    child.on('exit', (c) => resolve(c ?? -1))
  })
  if (!existsSync(resultPath)) throw new Error(`${scenario}: no result (exit ${code})\n${stderr.join('')}`)
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as SmokeResult
  expect(result.outcome, `${scenario}: ${JSON.stringify(result.events)}\n${stderr.join('')}`).toBe('quit')
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
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
  }, testBudgetMs(30_000))

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
  }, testBudgetMs(30_000))

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
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
  }, testBudgetMs(30_000))

  it('a window that never answers closes at the bound', async () => {
    const r = await runScenario('hang')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:none',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
    expect(at(r, 'answer:none') - at(r, 'ask')).toBeGreaterThanOrEqual(1_500)
  }, testBudgetMs(30_000))

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
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
  }, testBudgetMs(30_000))

  it('a window still loading its page is not asked and closes at once', async () => {
    const r = await runScenario('loading')
    expect(names(r)).toEqual([
      'ask',
      'close#1:held',
      'answer:none',
      'guard:closeWindow',
      'close#2:through',
      'closed',
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
    expect(at(r, 'answer:none') - at(r, 'ask')).toBeLessThan(500)
  }, testBudgetMs(30_000))

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
      'window-all-closed',
      'before-quit',
      'will-quit'
    ])
  }, testBudgetMs(30_000))
})
