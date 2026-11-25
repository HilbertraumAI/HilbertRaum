import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// App-update W-14 (F-11; the T3.2 sheet's (d)): every start of a prepared drive writes one startup line to
// `updates/update.log`, and a start that throws also writes its failed-start line. Where the call sits is the contract:
// - after the drive root joined the log redaction (#975) and after `initLogging`, so a skip of the writer reaches
//   app.log, and after the "Workspace resolved" line;
// - before `loadPolicy` and the workspace's start (`workspace.init()`, the step that throws most), so a start that
//   throws there leaves both lines;
// - inside `initBackend`, which only the primary instance runs, so a second launch writes nothing;
// - handed the app's own version and its own bundled manifests folder (#842), resolved once, before the line.
// And `runBackendStart` is handed the app version for the failed-start line. A source-text pin with a mutated-copy
// control per rule, as backend-start-wiring.test.ts and log-redact-wiring.test.ts do: index.ts pulls in the whole
// Electron main process and cannot be loaded under vitest. What the writer does is update-log-drive.test.ts; the failed
// start's line in the runner, backend-start-failure.test.ts.

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const indexSrc = stripComments(readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8'))

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

/** The body of `function initBackend(`, up to the next top-level function. */
function initBackendBody(src: string): string {
  const at = src.indexOf('function initBackend(')
  const end = src.indexOf('\nfunction ', at + 1)
  return at === -1 ? '' : src.slice(at, end === -1 ? undefined : end)
}

/** The startup line: one call in initBackend, in its place in the order, with the app's version and bundled folder. */
function startupLineWired(src: string): boolean {
  if (src.split('writeStartupLine(').length - 1 !== 1) return false // once in the file, so nowhere else
  const body = initBackendBody(src)
  const call = callArgs(body, 'writeStartupLine')
  if (call === null) return false
  const after = ['addLogRedactionRoots(', 'initLogging(paths.logsPath)', "log.info('Workspace resolved'", 'resolveBundledManifestsDir(']
  const before = ['loadPolicy(', 'workspace.init()']
  return (
    after.every((s) => body.indexOf(s) !== -1 && body.indexOf(s) < call.at) &&
    before.every((s) => body.indexOf(s) > call.at) &&
    /^\s*paths\s*,/.test(call.args) &&
    /\bappVersion:\s*app\.getVersion\(\)/.test(call.args) &&
    /\bbundledManifestsDir\b/.test(call.args) &&
    body.split('resolveBundledManifestsDir(').length - 1 === 1 // resolved once, and the engine steps reuse it
  )
}

/** The failed-start line: the runner is handed the app's version. */
function runnerHasVersion(src: string): boolean {
  const run = callArgs(src, 'runBackendStart')
  return run !== null && /^\s*initBackend\s*,/.test(run.args) && /\bappVersion:\s*app\.getVersion\(\)/.test(run.args)
}

describe('wiring pin: index.ts writes the update.log startup line in its place in the start (W-14, F-11)', () => {
  it('one call inside initBackend, after the log exists and before the policy and the workspace start', () => {
    expect(startupLineWired(indexSrc)).toBe(true)
    // Controls: the call after the workspace's start (a start that throws there would leave no startup line) ...
    const late = indexSrc
      .replace(/\n(\s*)writeStartupLine\(/, '\n$1void (')
      .replace(/\n(\s*)workspace\.init\(\)\n/, '\n$1workspace.init()\n$1writeStartupLine(paths, { appVersion: app.getVersion(), bundledManifestsDir })\n')
    expect(late).not.toBe(indexSrc)
    expect(startupLineWired(late)).toBe(false)
    // ... before logging exists (a skip could not be reported) ...
    const early = indexSrc
      .replace(/\n(\s*)writeStartupLine\(/, '\n$1void (')
      .replace(/\n(\s*)ensureWorkspaceDirs\(paths\)\n/, '\n$1writeStartupLine(paths, { appVersion: app.getVersion(), bundledManifestsDir })\n$1ensureWorkspaceDirs(paths)\n')
    expect(early).not.toBe(indexSrc)
    expect(startupLineWired(early)).toBe(false)
    // ... and no call at all.
    const none = indexSrc.replace(/writeStartupLine\(/, 'void (')
    expect(none).not.toBe(indexSrc)
    expect(startupLineWired(none)).toBe(false)
  })

  it('the start runner is handed the app version for the failed-start line', () => {
    expect(runnerHasVersion(indexSrc)).toBe(true)
    const mutated = indexSrc.replace(/(runBackendStart\(initBackend,[^)]*?)\bappVersion:\s*app\.getVersion\(\),?\s*/, '$1')
    expect(mutated).not.toBe(indexSrc)
    expect(runnerHasVersion(mutated)).toBe(false)
  })
})
