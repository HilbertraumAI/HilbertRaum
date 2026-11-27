import { beforeEach, describe, expect, it, vi } from 'vitest'

// The four update channels callable while the workspace is locked (app-update T6.3; F-14, W-82, F-21's refusal;
// docs/app-updates.md §3.5 "The channels' values"): `registerUpdatesIpc` (src/main/ipc/registerUpdatesIpc.ts) registers
// `updates:importFile`, `updates:status`, `updates:cancel` and `updates:discardStaged` over the update service's four
// methods (services/updates/service.ts, whose own rows are updates-service.test.ts). This file is the registrar's
// dedicated test that ipc-lock-coverage.test.ts's COVERED_ELSEWHERE names: F-14's list as a golden row (the channels are
// exactly tests/fixtures/updates/import/f14-locked-channels.json's `pr6a`, written by T6.0b from the record), each
// channel through the sender guard, on the narrow context and never AppContext (by type and at run time), with no lock
// gate, the renderer's argument handed on untouched, a rejection turned into a fixed error with no message, and no
// channel reaching `workspace/` or, off a prepared drive, anything under the root. Where the real service runs, it runs
// on a scratch drive with the golden update file and its public key set (no key is written). That the same channels
// answer in a start that threw is backend-start-failure.test.ts's (W-82); their place in index.ts is
// backend-start-wiring.test.ts's.
//
// The IPC transport is Electron's as far as these rows need it: `ipcMain.handle` records each handler and refuses a
// second one for a channel, as Electron does.
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => {
      if (ipcState.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      ipcState.handlers.set(channel, fn)
    },
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import * as ts from 'typescript'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { guardedChannels, releaseGuardedHandlers, UntrustedSenderError } from '../../src/main/ipc/guarded-handle'
import { registerUpdatesIpc, UpdateChannelError, type UpdateChannels, type UpdatesIpcContext } from '../../src/main/ipc/registerUpdatesIpc'
import type { AppContext } from '../../src/main/services/context'
import { initLogging, readLogTail } from '../../src/main/services/logging'
import { readUpdatePolicy } from '../../src/main/services/policy'
import { readDriveRelease, rootApps } from '../../src/main/services/updates/drive-release'
import type { UpdateKey } from '../../src/main/services/updates/envelope'
import { readKitSupport } from '../../src/main/services/updates/kit-support'
import { createUpdateService, NODE_BUNDLE_FS, NODE_START_FS, type UpdateServiceDeps } from '../../src/main/services/updates/service'
import { NODE_STAGING_FS } from '../../src/main/services/updates/staging'
import { appendUpdateLogLine } from '../../src/main/services/updates/update-log'
import { parseSemver } from '../../src/main/services/updates/version'
import { resolvePaths, type ResolvedPaths } from '../../src/main/services/workspace'
import { IPC } from '../../src/shared/ipc'
import { tempRoot } from '../helpers/db-fixtures'
import { ANY_SENDER, invokeWithEvent, makeEvent, type FakeIpcEvent, type IpcHandlers } from '../helpers/ipc'
import { DESKTOP_ROOT } from '../helpers/repo-files'
import { hostOf, keySet, semver } from '../helpers/update-inputs'

const handlers = ipcState.handlers as unknown as IpcHandlers
const UPDATES_FIXTURES = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates')
/** F-14's golden list (PR-6a's four), as T6.0b wrote it from the record. */
const F14 = JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f14-locked-channels.json'), 'utf8')) as { pr6a: string[] }
const PR6A = [...F14.pr6a].sort()
/** The golden update file's public key set and its staged version (F-5's f5-staged.json). */
const GOLDEN_KEYS = keySet((JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'golden-keys.json'), 'utf8')) as { keys: string[] }).keys)
const GOLDEN_VERSION = (
  JSON.parse(readFileSync(join(UPDATES_FIXTURES, 'import', 'f5-staged.json'), 'utf8')) as { staged: Array<{ file: string; version: string }> }
).staged.find((s) => s.file === 'golden.hrupdate')!.version
/** The case table's win32 host (cases.json `schema.host`): the system, the version and the clock the service is handed. */
const WIN32 = hostOf({ id: 'the update channels', host: 'win32' })

beforeEach(() => {
  releaseGuardedHandlers()
  handlers.clear()
  initLogging(join(tempRoot('updates-ipc-logs'), 'logs')) // a fresh, empty in-memory buffer
})

// ---- the registrar over a recording stand-in of the service

type Method = keyof UpdateChannels
const ANSWERS = {
  importFile: { kind: 'closed' },
  status: { runningVersion: '1.0.0', available: true, import: { state: 'idle' }, buildDate: null, drive: { kind: 'none' } },
  cancel: { kind: 'idle' },
  discardStaged: { kind: 'not-staged' }
} as const satisfies { [K in Method]: Awaited<ReturnType<UpdateChannels[K]>> }

/** A service whose four methods record every argument they get and answer ANSWERS, or what `fail` makes of the call. */
function recordingService(fail?: () => Promise<never>): { service: UpdateChannels; calls: Array<{ method: Method; args: unknown[] }> } {
  const calls: Array<{ method: Method; args: unknown[] }> = []
  const answer = <M extends Method>(method: M) => (...args: unknown[]) => {
    calls.push({ method, args })
    return fail ? fail() : Promise.resolve(ANSWERS[method])
  }
  return {
    calls,
    service: { importFile: answer('importFile'), status: answer('status'), cancel: answer('cancel'), discardStaged: answer('discardStaged') }
  }
}

const context = (over: Partial<UpdatesIpcContext> = {}): UpdatesIpcContext => ({
  trustedSenders: ANY_SENDER,
  paths: null,
  isDev: false,
  appVersion: '1.0.0',
  ...over
})

/** An invoke as Electron makes it: the handler runs inside a promise, so a throw of the guard rejects too. */
const call = (channel: string, event: FakeIpcEvent = makeEvent(), ...args: unknown[]): Promise<unknown> =>
  Promise.resolve().then(() => invokeWithEvent(handlers, channel, event, ...args))

describe('registerUpdatesIpc: the channels F-14 lists, on the narrow context (T6.3)', () => {
  it('registers exactly F-14\u{2019}s PR-6a list (golden row: f14-locked-channels.json)', () => {
    registerUpdatesIpc(context(), recordingService().service)
    expect([...handlers.keys()].sort()).toEqual(PR6A)
  })

  it('each channel goes through guardedHandle: the guard holds the four, and a sender it does not trust reaches no method', async () => {
    const before = guardedChannels()
    const { service, calls } = recordingService()
    registerUpdatesIpc(context({ trustedSenders: { isTrusted: () => false } }), service)
    expect([...guardedChannels()].filter((channel) => !before.has(channel)).sort()).toEqual(PR6A)
    for (const channel of PR6A) await expect(call(channel, makeEvent(7), {}), channel).rejects.toBeInstanceOf(UntrustedSenderError)
    expect(calls).toEqual([])
  })

  it('takes the narrow context, never AppContext: by type, and at run time no handler reads another field of it', async () => {
    // By type (npm run typecheck checks the tests): AppContext has no `appVersion`, so the full app context, the one that
    // reaches the workspace and the database, cannot be handed to the registrar (record §3.5 "The service and its start").
    const byType = (app: AppContext, service: UpdateChannels): void => {
      // @ts-expect-error the registrar takes UpdatesIpcContext, which AppContext is not
      registerUpdatesIpc(app, service)
    }
    void byType
    // At run time: a context that holds the four fields and throws on any other read, with no workspace anywhere.
    const NARROW = new Set<PropertyKey>(['trustedSenders', 'paths', 'isDev', 'appVersion'])
    const read = new Set<PropertyKey>()
    const narrow = new Proxy(context(), {
      get(target, key, receiver) {
        read.add(key)
        if (!NARROW.has(key)) throw new Error(`the registrar read ${String(key)} of its context`)
        return Reflect.get(target, key, receiver)
      }
    })
    const { service } = recordingService()
    registerUpdatesIpc(narrow, service)
    // With no workspace and no lock state in reach, every channel answers what the service answered.
    expect(await call(IPC.updatesImportFile, makeEvent(), {})).toEqual(ANSWERS.importFile)
    expect(await call(IPC.updatesStatus)).toEqual(ANSWERS.status)
    expect(await call(IPC.updatesCancel)).toEqual(ANSWERS.cancel)
    expect(await call(IPC.updatesDiscardStaged, makeEvent(), { version: GOLDEN_VERSION })).toEqual(ANSWERS.discardStaged)
    expect([...read].filter((key) => !NARROW.has(key))).toEqual([])
  })

  it('never a lock gate: the registrar names no lock check, no workspace and no database, and loads only the guard, the registry and the log', () => {
    const file = join(DESKTOP_ROOT, 'src', 'main', 'ipc', 'registerUpdatesIpc.ts')
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const LOCK_OR_WORKSPACE = new Set(['requireUnlocked', 'workspaceAdmitsWork', 'isUnlocked', 'isLocking', 'AppContext', 'workspace', 'db'])
    const named: string[] = []
    const values: string[] = []
    const typesOnly: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && LOCK_OR_WORKSPACE.has(n.text)) named.push(n.text)
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        ;(n.importClause?.isTypeOnly ? typesOnly : values).push(n.moduleSpecifier.text)
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
    expect(named).toEqual([])
    expect(values.sort()).toEqual(['../../shared/ipc', '../services/logging', './guarded-handle'])
    expect(typesOnly.sort()).toEqual(['../services/updates/service', '../services/workspace'])
  })

  it('hands the renderer\u{2019}s argument on untouched, importFile its caller, and status and cancel nothing', async () => {
    const { service, calls } = recordingService()
    registerUpdatesIpc(context(), service)
    const event = makeEvent()
    const confirmation = { confirmToken: 'a-token' }
    const discard = { version: GOLDEN_VERSION }
    await call(IPC.updatesImportFile, event, confirmation, 'a second value')
    await call(IPC.updatesImportFile, event)
    await call(IPC.updatesStatus, event, 'ignored', { any: 'thing' })
    await call(IPC.updatesCancel, event, 'ignored')
    await call(IPC.updatesDiscardStaged, event, discard, 'a second value')
    expect(calls.map((c) => [c.method, c.args.length])).toEqual([
      ['importFile', 2],
      ['importFile', 2],
      ['status', 0],
      ['cancel', 0],
      ['discardStaged', 1]
    ])
    expect(calls[0]!.args[0]).toBe(confirmation)
    expect(calls[0]!.args[1]).toBe(event)
    expect(calls[1]!.args).toEqual([undefined, event])
    expect(calls[1]!.args[1]).toBe(event)
    expect(calls[4]!.args[0]).toBe(discard)
  })
})

// A service method rejects only when a handed read or hook throws (notes-2 F8): with the error as thrown, whose message
// can name a path (review B P4b: `EIO: i/o error, open 'E:\config\policy.json'`). Electron puts a rejected error's text
// into the renderer's, so the registrar answers a fixed error with no message, and app.log gets one fixed reason with the
// channel and the error's code alone (answer 8).
describe('registerUpdatesIpc: a rejected call reaches the renderer as a fixed error and app.log as its code', () => {
  const root = tempRoot('updates-ipc-rejection')
  const policyPath = join(root, 'config', 'policy.json')
  const throwing = (get: () => unknown): Error =>
    Object.defineProperty(new Error(`EIO: i/o error, open '${policyPath}'`), 'code', { get })
  const thrown: Array<[string, () => unknown, string | null]> = [
    ['a file error naming a path', () => Object.assign(new Error(`EIO: i/o error, open '${policyPath}'`), { code: 'EIO', syscall: 'open', path: policyPath }), 'EIO'],
    [
      'an error whose code getter throws',
      () =>
        throwing(() => {
          throw new Error('no code for you')
        }),
      null
    ],
    ['an error whose code is a path', () => Object.assign(new Error('x'), { code: policyPath }), null],
    ['a thrown string naming a path', () => `EIO: i/o error, open '${policyPath}'`, null]
  ]

  it.each(thrown)('%s: each channel rejects with UpdateChannelError and no message; one line with the channel and the code', async (_label, make, code) => {
    for (const [how, fail] of [
      ['rejects', () => Promise.reject(make())],
      [
        'throws',
        () => {
          throw make()
        }
      ]
    ] as Array<[string, () => Promise<never>]>) {
      initLogging(join(tempRoot('updates-ipc-rejection-logs'), 'logs'))
      releaseGuardedHandlers()
      handlers.clear()
      registerUpdatesIpc(context(), recordingService(fail).service)
      for (const channel of PR6A) {
        const error = await call(channel, makeEvent(), {}).then(
          () => null,
          (e: unknown) => e
        )
        expect(error, `${channel} ${how}`).toBeInstanceOf(UpdateChannelError)
        expect((error as Error).message).toBe('')
        // The text the renderer's rejection carries after Electron's "Error invoking remote method '<channel>': ".
        expect(String(error)).toBe('UpdateChannelError')
      }
      const lines = readLogTail().filter((line) => line.includes('Update channel'))
      expect(lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))) as unknown)).toEqual(PR6A.map((channel) => ({ channel, code })))
      for (const line of lines) {
        expect(line).toContain('[WARN] Update channel: a call failed {')
        expect(line).not.toContain(JSON.stringify(root).slice(1, -1))
        expect(line).not.toContain(basename(root))
        expect(line).not.toContain('i/o error')
      }
    }
  })
})

// ---- the real service on a scratch drive

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A tree as lstat sees it, never through a link. */
function snapshot(path: string): unknown {
  let info
  try {
    info = lstatSync(path)
  } catch {
    return 'absent'
  }
  if (info.isSymbolicLink()) return { link: readlinkSync(path) }
  if (info.isDirectory()) return { dir: readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) }
  return { file: sha256(readFileSync(path)), size: info.size }
}

const under = (folder: string, path: string): boolean => {
  const rel = relative(folder, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Every path a set of calls is handed, recorded before the real call runs. */
function recording<T extends object>(real: T, seen: string[]): T {
  return Object.fromEntries(
    Object.entries(real).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        for (const arg of args) if (typeof arg === 'string') seen.push(arg)
        return (fn as (...a: unknown[]) => unknown)(...args)
      }
    ])
  ) as T
}

interface Seen {
  /** Every path handed to the service's file-system calls and readers, and the root of every update.log line. */
  paths: string[]
  /** The update.log events handed to the appender. */
  appended: string[]
  dialogs: number
}

/** The service's dependencies as index.ts builds them, over recorders: the win32 host and clock of the case table, the
 *  real readers and node:fs, the real appender, and a dialog that answers `file`. */
function serviceDeps(layout: ResolvedPaths | null, keys: readonly UpdateKey[], file: string | null, seen: Seen): UpdateServiceDeps {
  return {
    paths: layout,
    keys,
    runningVersion: semver(WIN32.runningVersion),
    host: { platform: WIN32.os, osVersion: () => WIN32.osVersion, glibc: () => WIN32.glibc, uiLanguage: () => WIN32.uiLanguage },
    clock: { now: () => Date.parse(WIN32.now), monotonic: () => performance.now() },
    reads: recording({ policy: readUpdatePolicy, driveRelease: readDriveRelease, rootApps, kitSupport: readKitSupport, buildDate: () => null }, seen.paths),
    chooseFile: async () => {
      seen.dialogs++
      return file
    },
    appendLog: (paths, event, fields) => {
      seen.paths.push(paths.rootPath)
      seen.appended.push(event)
      return appendUpdateLogLine(paths, event, fields)
    },
    fs: { bundle: recording(NODE_BUNDLE_FS, seen.paths), staging: recording(NODE_STAGING_FS, seen.paths), start: recording(NODE_START_FS, seen.paths) }
  }
}

describe('the channels over the real service: nothing under workspace/, nothing under a root that is no prepared drive', () => {
  // What this row proves, and what it does not (T6.3 review m-6). It covers every call made through the objects the
  // service is handed: the paths given to the `fs` objects' calls (the bundle reader's, staging's and the start step's),
  // the root or config folder given to the four readers, and the root of every update.log line given to the appender;
  // none lies under `workspace/`. The lstat snapshot then shows that nothing under `workspace/` changed. It does not see a
  // read a module makes through its own node:fs (the containment check of the start step and of the appender,
  // workspace-vault.ts's folderContainment; the appender's and the readers' own opens under the folder they are handed):
  // that none of those builds a path under `workspace/` rests on reading their code, not on this row.
  it('on a prepared drive, an import that stages, a status, a cancel and a discard read and write nothing under workspace/ (F-14)', async () => {
    const dir = tempRoot('updates-ipc-drive')
    const root = join(dir, 'drive')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    writeFileSync(join(root, 'config', 'drive-release.json'), JSON.stringify({ format: 1, app_version: WIN32.driveAppVersion }))
    for (const name of WIN32.rootApps ?? []) writeFileSync(join(root, name), '')
    // The workspace a locked app keeps: a database, its key file and a folder, each a sentinel that must stay as it is.
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'documents'), { recursive: true })
    writeFileSync(join(workspace, 'hilbertraum.sqlite.enc'), 'sentinel database')
    writeFileSync(join(workspace, 'workspace.json'), '{"mode":"encrypted"}')
    writeFileSync(join(workspace, 'documents', 'a.txt'), 'sentinel document')
    const source = join(dir, 'download', 'golden.hrupdate')
    mkdirSync(join(dir, 'download'))
    writeFileSync(source, readFileSync(join(UPDATES_FIXTURES, 'golden.hrupdate')))
    const layout = resolvePaths({ envRoot: root, fallbackRoot: root })
    expect(layout.isPreparedDrive).toBe(true)
    const before = snapshot(workspace)
    const seen: Seen = { paths: [], appended: [], dialogs: 0 }
    registerUpdatesIpc(context({ paths: layout }), createUpdateService(serviceDeps(layout, GOLDEN_KEYS, source, seen)))

    expect(await call(IPC.updatesImportFile)).toMatchObject({ kind: 'staged', update: { version: GOLDEN_VERSION } })
    expect(await call(IPC.updatesStatus)).toMatchObject({ drive: { kind: 'prepared', staged: { version: GOLDEN_VERSION } } })
    expect(await call(IPC.updatesCancel)).toEqual({ kind: 'idle' })
    expect(await call(IPC.updatesDiscardStaged, makeEvent(), { version: GOLDEN_VERSION })).toEqual({ kind: 'discarded', version: GOLDEN_VERSION })

    expect(seen.appended).toEqual(['import-staged', 'staging-discarded'])
    expect(seen.paths.filter((path) => under(root, path)).length, 'the recorders saw the drive').toBeGreaterThan(0)
    expect(seen.paths.filter((path) => under(workspace, path))).toEqual([])
    expect(snapshot(workspace)).toEqual(before)
  })

  // F-21 (frozen): with `isPreparedDrive` false (the user-data fallback root) or a failure state with no layout, nothing
  // is read or written under the root, whatever the call (record §3.5 "A root that is no prepared drive").
  it.each<[string, boolean, readonly UpdateKey[], unknown]>([
    ['a root that is no prepared drive, a build that embeds a key', true, GOLDEN_KEYS, { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: WIN32.runningVersion } }],
    ['a root that is no prepared drive, a build that embeds none', true, [], { code: 'UPD-NOT-AVAILABLE', params: {} }],
    ['a failure state with no layout, a build that embeds a key', false, GOLDEN_KEYS, { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: WIN32.runningVersion } }],
    ['a failure state with no layout, a build that embeds none', false, [], { code: 'UPD-NOT-AVAILABLE', params: {} }]
  ])('%s: status has no drive, the import and the discard refuse, cancel is idle; no read, no write, no dialog (F-21)', async (_label, withLayout, keys, importRefusal) => {
    const root = tempRoot('updates-ipc-user-data')
    // What a user-data root holds: an updates/ folder, a staged-looking entry and a workspace, none of which may be read.
    mkdirSync(join(root, 'updates', 'staging', GOLDEN_VERSION), { recursive: true })
    writeFileSync(join(root, 'updates', 'staging', GOLDEN_VERSION, 'staged.json'), '{}')
    mkdirSync(join(root, 'config'))
    mkdirSync(join(root, 'workspace'))
    const layout = withLayout ? resolvePaths({ envRoot: root, fallbackRoot: root }) : null
    expect(layout?.isPreparedDrive ?? false).toBe(false)
    const before = snapshot(root)
    const seen: Seen = { paths: [], appended: [], dialogs: 0 }
    registerUpdatesIpc(context({ paths: layout }), createUpdateService(serviceDeps(layout, keys, join(root, 'x.hrupdate'), seen)))

    expect(await call(IPC.updatesStatus)).toEqual({
      runningVersion: WIN32.runningVersion,
      available: keys.length > 0,
      import: { state: 'idle' },
      buildDate: null,
      drive: { kind: 'none' }
    })
    expect(await call(IPC.updatesImportFile)).toEqual({ kind: 'refused', refusal: importRefusal })
    expect(await call(IPC.updatesDiscardStaged, makeEvent(), { version: GOLDEN_VERSION })).toEqual({
      kind: 'refused',
      refusal: { code: 'UPD-NOT-A-DRIVE', params: { runningVersion: WIN32.runningVersion } }
    })
    expect(await call(IPC.updatesCancel)).toEqual({ kind: 'idle' })
    expect(seen).toEqual({ paths: [], appended: [], dialogs: 0 })
    expect(snapshot(root)).toEqual(before)
  })
})

// Answer 4 (T6.3 sheet question 4): index.ts builds the service with `parseSemver(app.getVersion())` and, should the
// version not parse, fails closed with no key (every update file answers UPD-NOT-AVAILABLE). A packaged build's
// `app.getVersion()` is apps/desktop/package.json's `version`, so the closed branch is never met by a build of this tree.
describe('the app version a build of this tree runs as', () => {
  it('parses under the version rule, so the update service is never built closed (answer 4)', () => {
    const { version } = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as { version: unknown }
    expect(typeof version).toBe('string')
    expect(parseSemver(version)?.text).toBe(version)
  })
})
