import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// #1024: a back-end start that throws. `initBackend` (main/index.ts) builds everything and registers the IPC handlers at
// its end, so a throw before that left the window with no handler at all: the renderer's `getWorkspaceState` was refused
// ("No handler registered"), the screen pointed at a `logs/app.log` an encrypted workspace does not write before an
// unlock, and the one log line was `String(err)`, the drive's paths included (#956's rule broken).
//
// `index.ts` cannot be imported under vitest (it is the whole Electron main process), so these rows drive the runner it
// starts `initBackend` through (`runBackendStart`, main/backend-start.ts) over the same calls `initBackend` makes on a
// real drive: `resolvePaths` + `ensureWorkspaceDirs`, and the workspace controller's start. The wiring itself is pinned
// in tests/unit/backend-start-wiring.test.ts.

// The IPC transport, as Electron's: `ipcMain.handle` refuses a second handler for a channel (Electron throws "Attempted
// to register a second handler for '<channel>'"), so a failure state registered over a channel the partial start had
// already taken fails here as it would in the app.
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => {
      if (ipcState.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      ipcState.handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  clipboard: { writeText: () => {} }
}))

// #1024 review L-4: the failure context is what the update plan's channels (P6, W-82) are built from, so the registrar's
// call is watched (calling through to the real registrar) to hold that the runner hands it the layout the start
// resolved, and the app version and the update service's getter.
const { registerSpy } = vi.hoisted(() => ({ registerSpy: vi.fn() }))
vi.mock('../../src/main/ipc/registerStartFailureIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ipc/registerStartFailureIpc')>()
  registerSpy.mockImplementation(actual.registerStartFailureIpc)
  return { ...actual, registerStartFailureIpc: registerSpy }
})

import { oneUpdateService, runBackendStart } from '../../src/main/backend-start'
import { guardedHandle, releaseGuardedHandlers } from '../../src/main/ipc/guarded-handle'
import { registerUpdatesIpc } from '../../src/main/ipc/registerUpdatesIpc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { initLogging, readLogTail } from '../../src/main/services/logging'
import { DEFAULT_POLICY, readUpdatePolicy } from '../../src/main/services/policy'
import { readDriveRelease, rootApps } from '../../src/main/services/updates/drive-release'
import { readKitSupport } from '../../src/main/services/updates/kit-support'
import { createUpdateService, NODE_BUNDLE_FS, NODE_START_FS, type UpdateService } from '../../src/main/services/updates/service'
import { NODE_STAGING_FS } from '../../src/main/services/updates/staging'
import { appendUpdateLogLine } from '../../src/main/services/updates/update-log'
import { ensureWorkspaceDirs, resolvePaths, type ResolvedPaths } from '../../src/main/services/workspace'
import { WorkspaceController, vaultPathsFrom } from '../../src/main/services/workspace-vault'
import type { AppContext } from '../../src/main/services/context'
import { IPC } from '../../src/shared/ipc'
import type { WorkspaceStateInfo } from '../../src/shared/types'
import { tempRoot } from '../helpers/db-fixtures'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { denyNewFolders } from '../helpers/unreadable-dir'
import { hostOf, keySet, semver } from '../helpers/update-inputs'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

const handlers = ipcState.handlers as unknown as IpcHandlers

const UPDATES_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates')
/** F-14's update channels: PR-6a's four, the golden list T6.0b wrote from the record (updates-ipc.test.ts's R1). */
const F14_CHANNELS = (JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f14-locked-channels.json'), 'utf8')) as { pr6a: string[] }).pr6a
/** The gate's state and the "Copy details for support" pair. */
const GATE_CHANNELS = [IPC.getLogTail, IPC.getWorkspaceState, IPC.writeClipboard]

/** What the failure state answers on, and nothing more: the gate's channels, and F-14's update channels (app-update
 *  W-82), so a release that cannot start can still take the update that repairs it. */
const FAILURE_CHANNELS = [...GATE_CHANNELS, ...F14_CHANNELS].sort()

/** The update service where a row is not about it: fixed answers, no drive read. */
const STAND_IN_SERVICE: UpdateService = {
  importFile: async () => ({ kind: 'closed' }),
  status: async () => ({ runningVersion: '0.1.66', available: false, import: { state: 'idle' }, buildDate: null, drive: { kind: 'none' } }),
  cancel: async () => ({ kind: 'idle' }),
  discardStaged: async () => ({ kind: 'not-staged' }),
  setAuditHook: () => undefined
}

/** The runner's dependencies as `index.ts` hands them over (the paths are the seam for the update plan's P6; the
 *  version goes into the failed-start line of `update.log`, W-14; the update service's getter, W-82). */
const deps = { trustedSenders: ANY_SENDER, isDev: false, appVersion: '0.1.66', paths: () => null, updates: () => STAND_IN_SERVICE }

/** The first two steps of `initBackend` over `root`: resolve the layout, create its four folders. */
function startOver(root: string): () => void {
  return () => {
    ensureWorkspaceDirs(resolvePaths({ envRoot: root, fallbackRoot: root }))
  }
}

async function gateState(): Promise<WorkspaceStateInfo> {
  return (await invoke(handlers, IPC.getWorkspaceState)).result as WorkspaceStateInfo
}

/** The log lines "Copy details for support" hands out (the redacted tail; this file registers no redaction roots). */
async function copiedLines(): Promise<string[]> {
  return (await invoke(handlers, IPC.getLogTail)).result as string[]
}

/** The failure line, by its message (the text support greps for), and its fields. */
function failureLine(lines: string[]): { line: string; fields: Record<string, unknown> } {
  const line = lines.find((l) => l.includes('[ERROR] Backend initialization failed'))
  if (!line) throw new Error(`no failure line in: ${lines.join('\n')}`)
  return { line, fields: JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown> }
}

/** The line names no part of `root`. A log line is JSON, which doubles every backslash of a Windows path, so the root is
 *  looked for as JSON writes it, and by its own folder name, which has none (review L-4: a raw `C:\…` never matched). */
function expectNoPath(line: string, root: string): void {
  expect(line).not.toContain(JSON.stringify(root).slice(1, -1))
  expect(line).not.toContain(basename(root))
}

beforeEach(() => {
  releaseGuardedHandlers()
  handlers.clear()
  registerSpy.mockClear()
  initLogging(join(tempRoot('backend-start-logs'), 'logs')) // a fresh, empty in-memory buffer
})

describe('a back-end start that throws answers the gate with the failure state (#1024)', () => {
  // POSIX root ignores a folder's mode, so it cannot be refused a folder there (`denyNewFolders` would throw).
  it.skipIf(process.getuid?.() === 0)(
    'a drive that refuses new folders: the gate hears drive_not_writable and its code, the log line names no path',
    async () => {
      const root = tempRoot('backend-start-refused')
      const undo = denyNewFolders(root)
      let failure
      try {
        failure = runBackendStart(startOver(root), deps)
      } finally {
        undo()
      }
      const code = process.platform === 'win32' ? 'EPERM' : 'EACCES'
      expect(failure).toEqual({ cause: 'drive_not_writable', code })
      expect(await gateState()).toEqual({
        state: 'start_failed',
        mode: null,
        plaintextAllowed: false,
        encryptionRequired: true,
        startFailure: { cause: 'drive_not_writable', code }
      })
      // Exactly the failure state's channels: none of the back end's, which was never built.
      expect([...handlers.keys()].sort()).toEqual(FAILURE_CHANNELS)
      const { line, fields } = failureLine(await copiedLines())
      expect(fields).toEqual({ error: 'Error', code, syscall: 'mkdir' })
      expectNoPath(line, root)
    }
  )

  // Runs on every OS and as any user (CI's POSIX root too): a file at the name refuses the folder for everyone.
  it('a file where a folder should be: the gate hears other with EEXIST, the log line names no path', async () => {
    const root = tempRoot('backend-start-file-at-name')
    writeFileSync(join(root, 'workspace'), 'not a folder')
    expect(runBackendStart(startOver(root), deps)).toEqual({ cause: 'other', code: 'EEXIST' })
    expect((await gateState()).startFailure).toEqual({ cause: 'other', code: 'EEXIST' })
    const { line, fields } = failureLine(await copiedLines())
    expect(fields).toEqual({ error: 'Error', code: 'EEXIST', syscall: 'mkdir' })
    expectNoPath(line, root)
  })

  it('a plaintext dev workspace whose database cannot be opened: the gate hears SQLite’s code, the log names no path', async () => {
    const root = tempRoot('backend-start-plaintext')
    const paths = resolvePaths({ envRoot: root, fallbackRoot: root })
    ensureWorkspaceDirs(paths)
    writeFileSync(paths.dbPath, Buffer.alloc(8192, 0x41)) // not a database; no workspace.json, so the start opens plaintext
    const start = (): void => {
      new WorkspaceController(vaultPathsFrom(paths), DEFAULT_POLICY, true).init()
    }
    expect(runBackendStart(start, { ...deps, isDev: true })).toEqual({ cause: 'other', code: 'SQLITE_26' })
    expect((await gateState()).startFailure).toEqual({ cause: 'other', code: 'SQLITE_26' })
    const { line, fields } = failureLine(await copiedLines())
    // SQLite's text is fixed and names no file: the whole of what is logged.
    expect(fields).toEqual({
      error: 'Error',
      message: 'file is not a database',
      code: 'ERR_SQLITE_ERROR',
      sqliteCode: 26,
      sqlite: 'file is not a database'
    })
    expectNoPath(line, root)
  })

  it('a throw after some channels were registered: only the failure state answers, the workspace channels are gone', async () => {
    const ctx = { trustedSenders: ANY_SENDER, workspace: workspaceStandIn({ unlocked: false }) } as unknown as AppContext
    const start = (): void => {
      registerWorkspaceIpc(ctx) // takes getWorkspaceState, unlock, create, lock, the password change
      throw new TypeError('a fault in a later step')
    }
    expect(runBackendStart(start, deps)).toEqual({ cause: 'other', code: null })
    expect([...handlers.keys()].sort()).toEqual(FAILURE_CHANNELS)
    expect((await gateState()).state).toBe('start_failed')
    const lines = await copiedLines()
    // A fault keeps its message (#956: only a file error's message names paths).
    expect(failureLine(lines).fields).toMatchObject({ error: 'TypeError', message: 'a fault in a later step' })
    // How many the start had registered: support reads a late throw (a back end half started behind the card) from it.
    expect(lines.some((l) => l.endsWith('Backend start: removed the channels the partial start had registered {"released":5}'))).toBe(true)
  })

  // #1024 final round: the release takes back only what the partial start registered. A channel registered before the
  // start began (the update plan's hand-off channel may be one) keeps answering after a late throw.
  it('a channel registered before the start keeps answering after a late throw', async () => {
    guardedHandle('updates:handOff', () => 'still here', { trustedSenders: ANY_SENDER })
    const ctx = { trustedSenders: ANY_SENDER, workspace: workspaceStandIn({ unlocked: false }) } as unknown as AppContext
    const start = (): void => {
      registerWorkspaceIpc(ctx)
      throw new TypeError('a fault in a later step')
    }
    runBackendStart(start, deps)
    expect((await invoke(handlers, 'updates:handOff')).result).toBe('still here')
    expect([...handlers.keys()].sort()).toEqual([...FAILURE_CHANNELS, 'updates:handOff'].sort())
  })

  it('a failure state that cannot be registered: the runner still returns and says so in the log', async () => {
    const start = (): void => {
      throw new TypeError('a fault')
    }
    const noSenders = { ...deps, trustedSenders: undefined as unknown as typeof ANY_SENDER }
    expect(runBackendStart(start, noSenders)).toEqual({ cause: 'other', code: null })
    expect(handlers.has(IPC.getWorkspaceState)).toBe(false)
    expect(readLogTail().some((l) => l.includes('[ERROR] Backend start: the failure state could not be registered'))).toBe(
      true
    )
  })

  // #1024 review L-1: reading what was thrown cannot throw out of the runner. `String()` of an object with no prototype
  // throws (in the log line), and so does a getter on `code` (in the log line and in the cause); either used to escape
  // the runner's catch, so the start ended with no failure state (and no window: the `whenReady` callback rejected).
  it.each<[string, () => unknown]>([
    ['an object with no prototype', () => Object.create(null)],
    [
      'an error whose code getter throws',
      () =>
        Object.defineProperty(new Error('x'), 'code', {
          get() {
            throw new Error('no code for you')
          }
        })
    ]
  ])('a thrown %s: the failure state still answers, with a fixed log line', async (_label, thrown) => {
    const start = (): void => {
      throw thrown()
    }
    expect(runBackendStart(start, deps)).toEqual({ cause: 'other', code: null })
    expect((await gateState()).startFailure).toEqual({ cause: 'other', code: null })
    expect(failureLine(await copiedLines()).fields).toEqual({ error: 'unreadable' })
  })

  // #1024 review L-4: the update plan's channels (W-82, P6) will find the drive's `updates/` folder through the failure
  // context's `paths`; the runner must hand over the layout the start resolved before it threw.
  it('hands the failure state the drive layout the start resolved', () => {
    const root = tempRoot('backend-start-layout')
    const layout = resolvePaths({ envRoot: root, fallbackRoot: root })
    const start = (): void => {
      throw new TypeError('a fault after the layout was resolved')
    }
    runBackendStart(start, { ...deps, isDev: true, paths: () => layout })
    expect(registerSpy).toHaveBeenCalledTimes(1)
    // App-update W-82: also the app version and the update service's getter, which the update channels' narrow context
    // and their service are made from.
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ paths: layout, isDev: true, failure: { cause: 'other', code: null }, appVersion: '0.1.66', updates: deps.updates })
    )
  })
})

// App-update W-82 (F-14, frozen; T6.3): the four update channels answer in the failure state too, on the process's one
// update service: the one `initBackend` built when the start threw after it (the channels the partial start registered
// are removed with the rest, then registered again), or built there, start step included, when the throw came before
// it (record §3.5 "The service and its start"). The update part is registered last, in a `try` of its own, so nothing
// in it can take the gate's card with it. The three throw points of the T6.3 sheet's answer 9: before the service,
// after its channels were registered, and inside the update part itself. The service is the real one, on a scratch
// prepared drive, with the golden update file and its public key set.
const GOLDEN_KEYS = keySet((JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'golden-keys.json'), 'utf8')) as { keys: string[] }).keys)
const GOLDEN_VERSION = (
  JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f5-staged.json'), 'utf8')) as { staged: Array<{ file: string; version: string }> }
).staged.find((s) => s.file === 'golden.hrupdate')!.version
/** The case table's win32 host (cases.json `schema.host`): the system, the versions and the clock of these rows. */
const WIN32 = hostOf({ id: 'the failure state\u{2019}s update channels', host: 'win32' })

/** The update service as index.ts builds it, with the win32 host and its clock and a dialog that answers `file`; `build`
 *  counts the builds, and `updates` is the one-service getter the runner is handed (backend-start.ts). */
function realUpdates(file: string | null) {
  const build = vi.fn((layout: ResolvedPaths | null) =>
    createUpdateService({
      paths: layout,
      keys: GOLDEN_KEYS,
      runningVersion: semver(WIN32.runningVersion),
      host: { platform: WIN32.os, osVersion: () => WIN32.osVersion, glibc: () => WIN32.glibc, uiLanguage: () => WIN32.uiLanguage },
      clock: { now: () => Date.parse(WIN32.now), monotonic: () => performance.now() },
      reads: { policy: readUpdatePolicy, driveRelease: readDriveRelease, rootApps, kitSupport: readKitSupport, buildDate: () => null },
      chooseFile: async () => file,
      appendLog: appendUpdateLogLine,
      fs: { bundle: NODE_BUNDLE_FS, staging: NODE_STAGING_FS, start: NODE_START_FS }
    })
  )
  return { build, updates: oneUpdateService(build) }
}

/** A prepared drive as the win32 host has it (its drive-release record and its root app). */
function updatableLayout(root: string): ResolvedPaths {
  const layout = preparedLayout(root)
  writeFileSync(join(root, 'config', 'drive-release.json'), JSON.stringify({ format: 1, app_version: WIN32.driveAppVersion }))
  for (const name of WIN32.rootApps ?? []) writeFileSync(join(root, name), '')
  return layout
}

/** The golden update file, copied off the drive. */
function goldenCopy(): string {
  const path = join(tempRoot('backend-start-update-file'), 'golden.hrupdate')
  writeFileSync(path, readFileSync(join(UPDATES_FIXTURES, 'golden.hrupdate')))
  return path
}

const updateLogEvents = (root: string): string[] =>
  readFileSync(join(root, 'updates', 'update.log'), 'latin1')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split(' ')[2]!)

/** The update part's own failure line, by its fixed reason, and its fields. */
function updatePartLines(lines: string[]): Array<{ line: string; fields: Record<string, unknown> }> {
  return lines
    .filter((l) => l.includes('[ERROR] Backend start: the update channels could not be registered'))
    .map((line) => ({ line, fields: JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown> }))
}

describe('a back-end start that throws still answers the update channels, on the one update service (W-82, F-14)', () => {
  it('a throw before the service: the failure state builds it once, on its layout, and an import stages the golden file', async () => {
    const root = tempRoot('backend-start-updates-before')
    const layout = updatableLayout(root)
    writeFileSync(join(root, 'workspace'), 'not a folder')
    const { build, updates } = realUpdates(goldenCopy())
    expect(runBackendStart(startOver(root), { ...deps, paths: () => layout, updates })).toEqual({ cause: 'other', code: 'EEXIST' })
    expect([...handlers.keys()].sort()).toEqual(FAILURE_CHANNELS)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build.mock.calls[0]![0]).toBe(layout)
    expect((await invoke(handlers, IPC.updatesImportFile)).result).toMatchObject({ kind: 'staged', update: { version: GOLDEN_VERSION } })
    expect(existsSync(join(root, 'updates', 'staging', GOLDEN_VERSION, 'staged.json'))).toBe(true)
    expect(updateLogEvents(root)).toEqual(['start-failed', 'import-staged'])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('a throw after the channels were registered: removed with the partial start, registered again on the service built once', async () => {
    const root = tempRoot('backend-start-updates-after')
    const layout = updatableLayout(root)
    ensureWorkspaceDirs(layout)
    writeFileSync(layout.dbPath, Buffer.alloc(8192, 0x41)) // not a database; no workspace.json, so the start opens plaintext
    const { build, updates } = realUpdates(null)
    const start = (): void => {
      // initBackend's order: the service and its channels right after the Update keys line, the workspace's start later.
      registerUpdatesIpc({ trustedSenders: ANY_SENDER, paths: layout, isDev: true, appVersion: '0.1.66' }, updates(layout))
      new WorkspaceController(vaultPathsFrom(layout), DEFAULT_POLICY, true).init()
    }
    expect(runBackendStart(start, { ...deps, isDev: true, paths: () => layout, updates })).toEqual({ cause: 'other', code: 'SQLITE_26' })
    expect([...handlers.keys()].sort()).toEqual(FAILURE_CHANNELS)
    expect(build).toHaveBeenCalledTimes(1)
    const lines = await copiedLines()
    expect(lines.some((l) => l.endsWith('Backend start: removed the channels the partial start had registered {"released":4}'))).toBe(true)
    // Electron's second-handler refusal never met: nothing failed to register.
    expect(lines.filter((l) => l.includes('could not be registered'))).toEqual([])
    expect((await invoke(handlers, IPC.updatesStatus)).result).toMatchObject({
      runningVersion: WIN32.runningVersion,
      available: true,
      drive: { kind: 'prepared', staged: null, sweeping: false }
    })
  })

  it('an update service that cannot be built: the card keeps its state and Copy details, no update channel, one fixed line', async () => {
    const root = tempRoot('backend-start-updates-throw')
    const updates = vi.fn((): UpdateService => {
      throw Object.assign(new Error(`EIO: i/o error, scandir '${root}'`), { code: 'EIO', syscall: 'scandir', path: root })
    })
    const start = (): void => {
      throw new TypeError('a fault')
    }
    expect(runBackendStart(start, { ...deps, updates })).toEqual({ cause: 'other', code: null })
    expect(updates).toHaveBeenCalledTimes(1)
    expect([...handlers.keys()].sort()).toEqual([...GATE_CHANNELS].sort())
    expect((await gateState()).state).toBe('start_failed')
    const lines = await copiedLines()
    const failed = updatePartLines(lines)
    expect(failed.map((f) => f.fields)).toEqual([{ error: 'Error', code: 'EIO', syscall: 'scandir' }])
    expectNoPath(failed[0]!.line, root)
    expect(lines.filter((l) => l.includes('the failure state could not be registered'))).toEqual([])
  })

  // P7's carried fact CF-58: a channel registered before the start survives the release, so the failure state's second
  // registration of it meets Electron's second-handler refusal. The update part then leaves none of its own channels.
  it('a second-handler refusal inside the update part: the card stays, and the update part leaves none of its channels', async () => {
    guardedHandle(IPC.updatesDiscardStaged, () => 'registered before the start', { trustedSenders: ANY_SENDER })
    const start = (): void => {
      throw new TypeError('a fault')
    }
    expect(runBackendStart(start, deps)).toEqual({ cause: 'other', code: null })
    expect([...handlers.keys()].sort()).toEqual([...GATE_CHANNELS, IPC.updatesDiscardStaged].sort())
    expect((await gateState()).state).toBe('start_failed')
    const lines = await copiedLines()
    expect(updatePartLines(lines).map((f) => f.fields)).toEqual([
      { error: 'Error', message: `Attempted to register a second handler for '${IPC.updatesDiscardStaged}'`, code: null, sqliteCode: null, sqlite: null }
    ])
    expect(lines.filter((l) => l.includes('the failure state could not be registered'))).toEqual([])
  })
})

// App-update W-14 (F-11; decision row 3): a start that throws on a prepared drive appends its failed-start line to
// `<drive>/updates/update.log`, the one trace of it that outlives the quit before an unlock. The line is the golden's
// (tests/fixtures/readers/f11-update-log/vectors.json, written by hand; the token rules are tests/unit/update-log.test.ts).
// Best-effort: the drive may be what failed, and nothing about the line may stop the runner from serving the gate.
interface F11Golden {
  emit: { start_failed: { base: { now: string }; vectors: Array<{ name: string; line: string }> } }
}
const F11 = JSON.parse(
  readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors.json'), 'utf8')
) as F11Golden
/** The golden's failed-start line, with this machine's OS token (the golden's are written on win32). */
const failedStartLine = (name: string): string =>
  F11.emit.start_failed.vectors.find((v) => v.name === name)!.line.replace(/^r1-app win32 /, `r1-app ${process.platform} `)

/** A prepared drive at `root` (config/drive.json = {}), resolved as the start resolves it. */
function preparedLayout(root: string): ReturnType<typeof resolvePaths> {
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'drive.json'), '{}')
  return resolvePaths({ envRoot: root, fallbackRoot: root })
}
const updateLog = (root: string): string => join(root, 'updates', 'update.log')

/** Run with the golden's clock, so the line's time is the golden's. */
function atGoldenTime<T>(run: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(F11.emit.start_failed.base.now))
  try {
    return run()
  } finally {
    vi.useRealTimers()
  }
}

describe('a back-end start that throws on a prepared drive leaves its failed-start line in update.log (W-14, F-11)', () => {
  it('a file where a folder should be: the line with the cause, the code and the system call (golden f01)', () => {
    const root = tempRoot('backend-start-update-log')
    const layout = preparedLayout(root)
    writeFileSync(join(root, 'workspace'), 'not a folder')
    const failure = atGoldenTime(() => runBackendStart(startOver(root), { ...deps, paths: () => layout }))
    expect(failure).toEqual({ cause: 'other', code: 'EEXIST' })
    expect(readFileSync(updateLog(root))).toEqual(Buffer.from(`\n${failedStartLine('f01')}\n`, 'utf8'))
  })

  it('a drive root whose path holds non-ASCII text: the line is the same, and holds no byte of the path', () => {
    const root = join(tempRoot('backend-start-non-ascii'), 'Ärger 日本', 'HilbertRaum')
    mkdirSync(root, { recursive: true })
    const layout = preparedLayout(root)
    writeFileSync(join(root, 'workspace'), 'not a folder')
    atGoldenTime(() => runBackendStart(startOver(root), { ...deps, paths: () => layout }))
    const bytes = readFileSync(updateLog(root))
    expect(bytes).toEqual(Buffer.from(`\n${failedStartLine('f01')}\n`, 'utf8'))
    expect(bytes.every((b) => b < 0x80)).toBe(true)
  })

  // T3.2 review 1, m-6: libuv's code for a Windows error it does not map (seen on failing USB media). The gate shows
  // no such code (start-failure.ts's rule, unchanged); the line keeps it, as the literal it is.
  it('a start that throws libuv’s UNKNOWN: the gate shows no code, the line carries err=UNKNOWN (golden f15)', async () => {
    const root = tempRoot('backend-start-update-log-unknown')
    const layout = preparedLayout(root)
    const start = (): void => {
      const path = join(root, 'workspace')
      throw Object.assign(new Error(`UNKNOWN: unknown error, read '${path}'`), { code: 'UNKNOWN', errno: -4094, syscall: 'read', path })
    }
    const failure = atGoldenTime(() => runBackendStart(start, { ...deps, paths: () => layout }))
    expect(failure).toEqual({ cause: 'other', code: null })
    expect((await gateState()).startFailure).toEqual({ cause: 'other', code: null })
    expect(readFileSync(updateLog(root))).toEqual(Buffer.from(`\n${failedStartLine('f15')}\n`, 'utf8'))
  })

  // POSIX root ignores a folder's mode, so it cannot be refused a folder there (`denyNewFolders` would throw).
  it.skipIf(process.getuid?.() === 0)(
    'a prepared drive that refuses new folders: no line, the skip in app.log, and the gate still answers',
    async () => {
      const root = tempRoot('backend-start-update-log-refused')
      const layout = preparedLayout(root)
      const undo = denyNewFolders(root)
      let failure
      try {
        failure = runBackendStart(startOver(root), { ...deps, paths: () => layout })
      } finally {
        undo()
      }
      expect(failure).toEqual({ cause: 'drive_not_writable', code: process.platform === 'win32' ? 'EPERM' : 'EACCES' })
      expect(existsSync(join(root, 'updates'))).toBe(false)
      expect((await gateState()).state).toBe('start_failed')
      const skip = (await copiedLines()).find((l) => l.includes('Update log: line skipped'))
      expect(skip).toBeDefined()
      expect(JSON.parse(skip!.slice(skip!.indexOf('{')))).toMatchObject({ event: 'start-failed', reason: 'write-failed', syscall: 'mkdir' })
      expectNoPath(skip!, root)
    }
  )

  it('a root that is no prepared drive gets no update.log', () => {
    const root = tempRoot('backend-start-not-prepared')
    const layout = resolvePaths({ envRoot: root, fallbackRoot: root })
    writeFileSync(join(root, 'workspace'), 'not a folder')
    expect(runBackendStart(startOver(root), { ...deps, paths: () => layout })).toEqual({ cause: 'other', code: 'EEXIST' })
    expect(existsSync(join(root, 'updates'))).toBe(false)
  })

  // Review L-1 with the new line: nothing in the catch may throw out of it, the layout getter included.
  it('a layout getter that throws: the runner still returns the failure', () => {
    const start = (): void => {
      throw new TypeError('a fault')
    }
    const throwingPaths = (): never => {
      throw new Error('no layout')
    }
    expect(runBackendStart(start, { ...deps, paths: throwingPaths })).toEqual({ cause: 'other', code: null })
  })
})
