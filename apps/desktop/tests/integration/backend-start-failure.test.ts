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

// #1024 review L-4: the failure context is what the update plan's channels (P6) are built from, and nothing in the
// state reads its `paths` yet, so the registrar's call is watched (calling through to the real registrar) to hold that the
// runner hands it the layout the start resolved.
const { registerSpy } = vi.hoisted(() => ({ registerSpy: vi.fn() }))
vi.mock('../../src/main/ipc/registerStartFailureIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ipc/registerStartFailureIpc')>()
  registerSpy.mockImplementation(actual.registerStartFailureIpc)
  return { ...actual, registerStartFailureIpc: registerSpy }
})

import { runBackendStart } from '../../src/main/backend-start'
import { guardedHandle, releaseGuardedHandlers } from '../../src/main/ipc/guarded-handle'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { initLogging, readLogTail } from '../../src/main/services/logging'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { ensureWorkspaceDirs, resolvePaths } from '../../src/main/services/workspace'
import { WorkspaceController, vaultPathsFrom } from '../../src/main/services/workspace-vault'
import type { AppContext } from '../../src/main/services/context'
import { IPC } from '../../src/shared/ipc'
import type { WorkspaceStateInfo } from '../../src/shared/types'
import { tempRoot } from '../helpers/db-fixtures'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { denyNewFolders } from '../helpers/unreadable-dir'
import { workspaceStandIn } from '../helpers/workspace-stand-in'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** What the failure state answers on, and nothing more: the gate's state, and the "Copy details for support" pair. */
const FAILURE_CHANNELS = [IPC.getLogTail, IPC.getWorkspaceState, IPC.writeClipboard].sort()

/** The runner's dependencies as `index.ts` hands them over (the paths are the seam for the update plan's P6; the
 *  version goes into the failed-start line of `update.log`, W-14). */
const deps = { trustedSenders: ANY_SENDER, isDev: false, appVersion: '0.1.66', paths: () => null }

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
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ paths: layout, isDev: true, failure: { cause: 'other', code: null } })
    )
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
