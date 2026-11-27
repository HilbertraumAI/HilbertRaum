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
//
// App-update T6.3 (F-14, W-82; docs/app-updates.md §3.5 "The service and its start", "Who picks the file"): the update
// service is built once per process, by one factory, inside `initBackend` right after the `Update keys` line and before
// the policy and the workspace's start, and its four channels are registered right after it on a narrow context written
// as an object literal, never `ctx`; the runner is handed the same factory for the failure state; and (fix round 1, F2)
// the service's dependencies are update-service-deps.ts's, handed Electron's `app`, `dialog`, `BrowserWindow` and
// `process`, and nothing else: index.ts adds no dependency of its own and sets no audit sink. What each dependency is
// (main's dialog, the host, the glibc hook, the readers, the fail-closed version) is tests/unit/update-service-deps.test.ts;
// what the channels do is updates-ipc.test.ts; the failure state's use of the factory, backend-start-failure.test.ts.

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

/** The body of `function initBackend(`, up to the next top-level function. */
function initBackendBody(src: string): string {
  const at = src.indexOf('\nfunction initBackend(')
  const end = src.indexOf('\nfunction ', at + 1)
  return at === -1 ? '' : src.slice(at, end === -1 ? undefined : end)
}

/** T6.3: the file's one `createUpdateService(` inside its one factory (`updateServiceFor = oneUpdateService(…)`, at module
 *  scope above initBackend); inside initBackend one call of the factory, after the Update keys line and before the
 *  policy and the workspace's start (record §3.5). */
function oneServiceInItsPlace(src: string): boolean {
  if (src.split('createUpdateService(').length - 1 !== 1 || src.split('oneUpdateService(').length - 1 !== 1) return false
  const factory = src.match(/\nconst updateServiceFor = oneUpdateService\(/)
  const initAt = src.indexOf('\nfunction initBackend(')
  if (!factory || factory.index === undefined || initAt === -1 || factory.index > initAt) return false
  const made = callArgs(src, 'oneUpdateService', factory.index)
  if (made === null || !made.args.includes('createUpdateService(')) return false
  const body = initBackendBody(src)
  const calls = [...body.matchAll(/\bupdateServiceFor\(/g)]
  if (calls.length !== 1) return false
  const at = calls[0]!.index!
  const keys = body.indexOf("log.info('Update keys'")
  return keys !== -1 && keys < at && ['loadPolicy(', 'workspace.init()'].every((s) => body.indexOf(s) > at)
}

/** T6.3: the file's one `registerUpdatesIpc(`, the statement right after the factory's call in initBackend, handed an
 *  object literal of the narrow context's four fields (never `ctx`) and that service. */
function channelsOnTheNarrowContext(src: string): boolean {
  if (src.split('registerUpdatesIpc(').length - 1 !== 1) return false
  const body = initBackendBody(src)
  const made = body.match(/const (\w+) = updateServiceFor\(paths\)\n\s*registerUpdatesIpc\(/)
  if (!made || made.index === undefined) return false
  const register = callArgs(body, 'registerUpdatesIpc', made.index)
  const literal = /^\{\s*trustedSenders,\s*paths,\s*isDev,\s*appVersion:\s*app\.getVersion\(\)\s*\},\s*(\w+)$/
  return register !== null && literal.exec(register.args.trim())?.[1] === made[1]
}

/** T6.3 (W-82): the runner is handed the same factory, so a failed start gets the one service or builds it there. */
function runnerHandedTheFactory(src: string): boolean {
  const run = callArgs(whenReady(src), 'runBackendStart')
  return run !== null && /^\s*initBackend\s*,/.test(run.args) && /\bupdates:\s*updateServiceFor\s*\}\s*$/.test(run.args)
}

/** T6.3 fix round 1 (F2, review m-2): the service's dependencies are update-service-deps.ts's, made once at module scope
 *  from Electron's `app`, `dialog`, `BrowserWindow` and `process` and above the factory, which hands the service exactly
 *  what they build for the layout; index.ts names no dependency of its own (no dialog, no report, no reader, no
 *  appender, no node:fs object, no start hook) and sets no audit sink (answer 3; T6.10b's, PR-6b). */
function serviceBuiltThroughTheDepsModule(src: string): boolean {
  const made = src.match(/\nconst updateServiceDeps = updateServiceDepsFor\(\{ app, dialog, BrowserWindow, process \}\)\n/)
  const factory = src.match(/\nconst updateServiceFor = oneUpdateService\(\(layout\) => createUpdateService\(updateServiceDeps\(layout\)\)\)\n/)
  return (
    /\nimport \{ updateServiceDepsFor \} from '\.\/update-service-deps'\n/.test(src) &&
    made?.index !== undefined &&
    factory?.index !== undefined &&
    made.index < factory.index &&
    src.split('updateServiceDepsFor(').length - 1 === 1 &&
    src.split('updateServiceDeps(').length - 1 === 1 &&
    !/\b(UpdateServiceDeps|chooseFile|showOpenDialog|getReport|getSystemVersion|readUpdatePolicy|readDriveRelease|rootApps|readKitSupport|appendUpdateLogLine|NODE_BUNDLE_FS|NODE_STAGING_FS|NODE_START_FS|startHook|setAuditHook)\b/.test(src)
  )
}

describe('wiring pin: index.ts builds the update service once and registers its channels on the narrow context (T6.3)', () => {
  it('one factory, called once in initBackend after the Update keys line and before the policy and the workspace start', () => {
    expect(oneServiceInItsPlace(indexSrc)).toBe(true)
    // Controls: the service built after the workspace's start (a start that throws there would have none) ...
    const late = indexSrc
      .replace(/\n(\s*)const updates = updateServiceFor\(paths\)\n/, '\n')
      .replace(/\n(\s*)workspace\.init\(\)\n/, '\n$1workspace.init()\n$1const updates = updateServiceFor(paths)\n')
    expect(late).not.toBe(indexSrc)
    expect(oneServiceInItsPlace(late)).toBe(false)
    // ... and a second service built for the failure state (its start step would run twice).
    const second = indexSrc.replace(/\bupdates:\s*updateServiceFor\b/, 'updates: oneUpdateService((layout) => createUpdateService(updateServiceDeps(layout)))')
    expect(second).not.toBe(indexSrc)
    expect(oneServiceInItsPlace(second)).toBe(false)
  })

  it('the four channels registered right after it, on an object literal of the narrow context, never ctx', () => {
    expect(channelsOnTheNarrowContext(indexSrc)).toBe(true)
    const full = indexSrc.replace(/registerUpdatesIpc\(\{[^}]*\}/, 'registerUpdatesIpc(ctx')
    expect(full).not.toBe(indexSrc)
    expect(channelsOnTheNarrowContext(full)).toBe(false)
    const later = indexSrc.replace(/(updateServiceFor\(paths\)\n)(\s*)registerUpdatesIpc\(/, '$1$2void 0\n$2registerUpdatesIpc(')
    expect(later).not.toBe(indexSrc)
    expect(channelsOnTheNarrowContext(later)).toBe(false)
  })

  it('the runner is handed the same factory for the failure state (W-82)', () => {
    expect(runnerHandedTheFactory(indexSrc)).toBe(true)
    const none = indexSrc.replace(/,\s*updates:\s*updateServiceFor\b/, '')
    expect(none).not.toBe(indexSrc)
    expect(runnerHandedTheFactory(none)).toBe(false)
  })

  it('the dependencies are update-service-deps.ts\u{2019}s, handed Electron\u{2019}s parts, and nothing else: no field of index.ts\u{2019}s own, no audit sink', () => {
    expect(serviceBuiltThroughTheDepsModule(indexSrc)).toBe(true)
    // Controls: a dependency written over in index.ts (the review's example: an appender that writes nothing) ...
    const over = indexSrc.replace('createUpdateService(updateServiceDeps(layout))', 'createUpdateService({ ...updateServiceDeps(layout), appendLog: () => false })')
    expect(over).not.toBe(indexSrc)
    expect(serviceBuiltThroughTheDepsModule(over)).toBe(false)
    // ... a P7 start hook added in index.ts ...
    const hook = indexSrc.replace('createUpdateService(updateServiceDeps(layout))', 'createUpdateService({ ...updateServiceDeps(layout), startHook: () => undefined })')
    expect(hook).not.toBe(indexSrc)
    expect(serviceBuiltThroughTheDepsModule(hook)).toBe(false)
    // ... a part of Electron that is not Electron's ...
    const stand = indexSrc.replace('updateServiceDepsFor({ app, dialog, BrowserWindow, process })', 'updateServiceDepsFor({ app, dialog, BrowserWindow: { fromWebContents: () => null }, process })')
    expect(stand).not.toBe(indexSrc)
    expect(serviceBuiltThroughTheDepsModule(stand)).toBe(false)
    // ... and an audit sink set from index.ts in PR-6a.
    const audit = indexSrc.replace(/(\n\s*)(registerUpdatesIpc\()/, '$1updates.setAuditHook(() => undefined)$1$2')
    expect(audit).not.toBe(indexSrc)
    expect(serviceBuiltThroughTheDepsModule(audit)).toBe(false)
  })
})

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
