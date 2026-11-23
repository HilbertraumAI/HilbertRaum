import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #1024: the start's failure state exists only if `index.ts` runs `initBackend` through the runner that serves it
// (`runBackendStart`, main/backend-start.ts; its rows: tests/integration/backend-start-failure.test.ts). A plain
// `try { initBackend() } catch { log }` compiles, starts, and leaves the window with no handler again, so nothing else
// in the suite would notice. A source-text wiring pin, as for the other `index.ts` call sites
// (log-redact-wiring.test.ts, offline-tripwire-posture.test.ts): index.ts pulls in the whole Electron main process and
// cannot be imported under vitest. Each pin also runs over a mutated copy, which must fail it.
//
// What it holds, inside the `app.whenReady()` callback:
// - `initBackend` runs through `runBackendStart`, and nothing in the file calls it directly;
// - a start that failed installs the offline tripwire with a posture that always reads offline: `initBackend` installs
//   it as its last step, so a start that threw never did;
// - (review M-2) the protocol, the menu and the window start inside `runWindowStart`, whose rows are
//   tests/integration/window-start-failure.test.ts;
// - and, outside the callback (review L-3), the crash and rejection lines log `safeFailureForLog`.

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const indexSrc = stripComments(readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8'))

/** The `app.whenReady().then(` callback, up to the `activate` listener it registers last. */
function whenReady(src: string): string {
  const at = src.indexOf('app.whenReady().then(')
  const end = src.indexOf("app.on('activate'", at)
  return at === -1 || end === -1 ? '' : src.slice(at, end)
}

/** The argument text of the first `name(` call at or after `from`, or null. */
function callArgs(src: string, name: string, from = 0): { at: number; args: string } | null {
  const at = src.indexOf(`${name}(`, from)
  if (at === -1) return null
  let depth = 0
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return { at, args: src.slice(at + name.length + 1, i) }
  }
  return null
}

/** `initBackend` runs through the runner, and no direct call is left (its declaration aside). */
function startsThroughRunner(src: string): boolean {
  const run = callArgs(whenReady(src), 'runBackendStart')
  return run !== null && /^\s*initBackend\s*,/.test(run.args) && !/(?<!function\s+)\binitBackend\(\s*\)/.test(src)
}

/** After the runner, an `if` on its answer installs the tripwire with an always-offline posture, and only when
 *  `initBackend` did not get as far as installing it (final round: two guards log every remote connect twice). */
function failureInstallsTripwire(src: string): boolean {
  const body = whenReady(src)
  const run = body.match(/const\s+(\w+)\s*=\s*runBackendStart\(/)
  if (!run || run.index === undefined) return false
  const guard = body.indexOf(`if (${run[1]} && !offlineGuardInstalled())`, run.index)
  if (guard === -1) return false
  const tripwire = callArgs(body, 'assertOfflinePosture', guard)
  return tripwire !== null && /readPosture:\s*\(\)\s*=>\s*\(\{\s*offlineMode:\s*true\b/.test(tripwire.args)
}

/** #1024 review M-2: the steps after the back end (the protocol, the menu, the window) run inside `runWindowStart(`,
 *  which is handed the native error box and an exit that runs the emergency lock first. */
function windowStepsGuarded(src: string): boolean {
  const body = whenReady(src)
  const guard = callArgs(body, 'runWindowStart')
  if (!guard) return false
  const steps = ['installAppProtocol(', 'Menu.setApplicationMenu(', 'createWindow()']
  return (
    steps.every((s) => guard.args.includes(s)) &&
    steps.every((s) => body.split(s).length - 1 === 1) && // nowhere else in the callback
    /showErrorBox:\s*\([^)]*\)\s*=>\s*dialog\.showErrorBox\(/.test(guard.args) &&
    // the exit reaps what the back end started (the crash path's emergency lock) before it ends the app
    /exit:\s*\(code\)\s*=>\s*\{[\s\S]*?emergencyLock\(ctx\)[\s\S]*?app\.exit\(code\)/.test(guard.args)
  )
}

/** #1024 review L-3 (b): the crash and rejection lines log what `safeFailureForLog` keeps, never `String(…)` (a path,
 *  and a throw of its own for an object with no prototype, which skipped the emergency lock after it). */
function crashLinesContentFree(src: string): boolean {
  const crash = src.slice(src.indexOf("process.on('uncaughtException'"), src.indexOf("process.on('unhandledRejection'"))
  const rejection = src.slice(src.indexOf("process.on('unhandledRejection'"))
  return (
    /log\.error\('Uncaught exception',\s*safeFailureForLog\(err\)\)/.test(crash) &&
    /log\.warn\('Unhandled rejection',\s*safeFailureForLog\(reason\)\)/.test(rejection) &&
    !/String\((err|reason)\)/.test(crash + rejection.slice(0, rejection.indexOf('})') + 2))
  )
}

describe('wiring pin: index.ts starts the back end through the failure-state runner (#1024)', () => {
  it('the protocol, the menu and the window start inside runWindowStart, with the error box and the exit (review M-2)', () => {
    expect(windowStepsGuarded(indexSrc)).toBe(true)
    // The control: the window started after the guard, as before the review, must fail the pin.
    const mutated = indexSrc.replace(/(\n\s*)createWindow\(\)\n/, '$1void 0\n') + '\ncreateWindow()\n'
    expect(mutated).not.toBe(indexSrc)
    expect(windowStepsGuarded(mutated)).toBe(false)
  })

  it('the crash and rejection lines log safeFailureForLog, never String(…) (review L-3)', () => {
    expect(crashLinesContentFree(indexSrc)).toBe(true)
    const mutated = indexSrc.replace(/safeFailureForLog\(err\)/, 'String(err)')
    expect(mutated).not.toBe(indexSrc)
    expect(crashLinesContentFree(mutated)).toBe(false)
  })

  it('initBackend runs through runBackendStart, and nothing calls it directly', () => {
    expect(startsThroughRunner(indexSrc)).toBe(true)
    // The control: the pre-#1024 shape (a bare call in a try that only logs) must fail the pin.
    const mutated = indexSrc.replace(/runBackendStart\(\s*initBackend\s*,/, 'void (initBackend(), ')
    expect(mutated).not.toBe(indexSrc)
    expect(startsThroughRunner(mutated)).toBe(false)
  })

  it('a start that failed installs the offline tripwire, once, with a posture that reads offline', () => {
    expect(failureInstallsTripwire(indexSrc)).toBe(true)
    const mutated = indexSrc.replace(/offlineMode:\s*true\b/, 'offlineMode: false')
    expect(mutated).not.toBe(indexSrc)
    expect(failureInstallsTripwire(mutated)).toBe(false)
    const twice = indexSrc.replace(/ && !offlineGuardInstalled\(\)/, '')
    expect(twice).not.toBe(indexSrc)
    expect(failureInstallsTripwire(twice)).toBe(false)
  })
})
