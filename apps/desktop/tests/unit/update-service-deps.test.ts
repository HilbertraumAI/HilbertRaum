import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, WebContents } from 'electron'

// What main hands the update service (app-update T6.3 fix round 1, F1 + F2; T6.3 review M-1, m-2, m-4):
// src/main/update-service-deps.ts builds `UpdateServiceDeps` from the parts of Electron and Node that index.ts hands it
// (`app`, `dialog`, `BrowserWindow`, `process`), so each field has a run-time row here, where index.ts itself cannot be
// loaded (backend-start-wiring.test.ts pins that index.ts builds the service through this module and nothing else):
// - main's own dialog for an update file (record §3.5 "Who picks the file"): parented to the window that called, one
//   file, the two filters, no default folder, titled in main's language at each call; one path or closed;
// - the computer (CF-50): the system, its version (Windows, macOS), the runtime glibc (Linux only, read once per process
//   from Node's diagnostic report, never a throw), main's UI language;
// - the clock, the drive's own readers, the update.log appender and node:fs, by identity; the build date, the
//   build-date reader's value (T6.4a; record §5.10);
// - the version this app runs as, and the keys: fail closed when the version does not parse (T6.3 sheet answer 4);
// - nothing else: no P7 start hook, no audit sink.
// That the service then uses these as recorded is updates-service.test.ts's and updates-ipc.test.ts's.

// The module takes Electron's parts as arguments and loads no Electron itself: a module of its graph that did would meet
// this mock and fail the file's load.
vi.mock('electron', () => {
  throw new Error('update-service-deps.ts loaded electron')
})

// A build that embeds a key: keys.json's production set stays empty until the owner's key ceremony (C15), so the
// embedded set stands in with the golden update file's public keys (tests/fixtures/updates/golden-keys.json; no private
// key anywhere). With an empty set "the keys" and "no key" could not be told apart.
vi.mock('../../src/main/services/updates/keys', async () => {
  const { readFileSync } = await import('node:fs')
  const { parseKeySet } = await import('../../src/main/services/updates/envelope')
  const { DESKTOP_ROOT } = await import('../helpers/repo-files')
  const { MARKER } = await import('../helpers/update-inputs')
  const { keys } = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'golden-keys.json'), 'utf8')) as { keys: string[] }
  const read = parseKeySet(MARKER + keys.join(','))
  return { embeddedKeySet: { keys: read.valid ? read.keys : [], valid: read.valid } }
})

// A build that carries a date: in a test run build-date.json is absent or a developer's leftover (record §5.10, "The
// build date's reader"), so the reader's value stands in with one, and "the date" cannot be told apart from "none".
const BUILD_DATE = '2027-03-15T09:30:00Z'
vi.mock('../../src/main/services/updates/build-date', () => ({ embeddedBuildDate: '2027-03-15T09:30:00Z' }))

import { updateServiceDepsFor, type UpdateServiceEnv } from '../../src/main/update-service-deps'
import { applyUiLanguageSetting, initMainI18n } from '../../src/main/services/i18n'
import { initLogging, log, readLogTail } from '../../src/main/services/logging'
import { readUpdatePolicy } from '../../src/main/services/policy'
import { readDriveRelease, rootApps } from '../../src/main/services/updates/drive-release'
import { embeddedKeySet } from '../../src/main/services/updates/keys'
import { readKitSupport } from '../../src/main/services/updates/kit-support'
import { NODE_BUNDLE_FS, NODE_START_FS } from '../../src/main/services/updates/service'
import { NODE_STAGING_FS } from '../../src/main/services/updates/staging'
import { appendUpdateLogLine } from '../../src/main/services/updates/update-log'
import { parseSemver } from '../../src/main/services/updates/version'
import { resolvePaths } from '../../src/main/services/workspace'
import { de, en, UI_LANGUAGE_CODES } from '../../src/shared/i18n'
import { tempRoot } from '../helpers/db-fixtures'

/** The window the calling renderer lives in, and its sender (the invoke event's `sender`). */
const WINDOW = { stands: 'for the window that called' } as unknown as BrowserWindow
const SENDER = { id: 7 } as unknown as WebContents
const CALLER = { sender: SENDER }
const PICKED = join('E:', 'downloads', 'hilbertraum-1.0.1.hrupdate')
const OTHER = join('E:', 'downloads', 'other.hrupdate')

/** The fixed reasons support greps app.log for. */
const VERSION_LINE = 'Update service: the app version does not parse, so no update file is accepted'
const GLIBC_LINE = 'Update service: the runtime glibc could not be read'

type Dialog = (...args: unknown[]) => Promise<OpenDialogReturnValue>
type WindowOf = (sender: WebContents) => BrowserWindow | null

/** Electron's parts as index.ts hands them, each a recording stand-in: the app's version, the dialog (by default it
 *  answers one picked path), the window of a sender, and a Windows process. */
function envOf(parts: { version?: string; process?: UpdateServiceEnv['process']; dialog?: Dialog; windowOf?: WindowOf } = {}) {
  const showOpenDialog = vi.fn<Dialog>(parts.dialog ?? (async () => ({ canceled: false, filePaths: [PICKED] })))
  const fromWebContents = vi.fn<WindowOf>(parts.windowOf ?? (() => WINDOW))
  const env: UpdateServiceEnv = {
    app: { getVersion: () => parts.version ?? '0.1.66' },
    dialog: { showOpenDialog },
    BrowserWindow: { fromWebContents },
    process: parts.process ?? { platform: 'win32', getSystemVersion: () => '10.0.26300' }
  }
  return { env, showOpenDialog, fromWebContents }
}

/** The options main's dialog is opened with, in one catalog's words. */
const dialogOptions = (catalog: typeof en | typeof de): OpenDialogOptions => ({
  title: catalog['main.dialog.importUpdate'],
  properties: ['openFile'],
  filters: [
    { name: catalog['main.dialog.filterUpdate'], extensions: ['hrupdate'] },
    { name: catalog['main.dialog.filterAll'], extensions: ['*'] }
  ]
})

/** The app.log lines with `reason`, as the fields each carries (or '' for a line with none). */
function linesOf(reason: string): unknown[] {
  return readLogTail()
    .filter((line) => line.includes(reason))
    .map((line) => {
      const at = line.indexOf('{')
      return at === -1 ? '' : (JSON.parse(line.slice(at)) as unknown)
    })
}

const layoutAt = (label: string) => {
  const root = tempRoot(label)
  return resolvePaths({ envRoot: root, fallbackRoot: root })
}

beforeEach(() => {
  initLogging(join(tempRoot('update-service-deps-logs'), 'logs')) // a fresh, empty in-memory buffer
  initMainI18n('en-US')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('update-service-deps: main\u{2019}s own dialog for an update file (record §3.5 "Who picks the file")', () => {
  it('parented to the window that called: one file, the two filters, no default folder, titled in main\u{2019}s language at each call', async () => {
    const { env, showOpenDialog, fromWebContents } = envOf()
    const deps = updateServiceDepsFor(env)(null)
    expect(await deps.chooseFile(CALLER)).toBe(PICKED)
    initMainI18n('de-DE') // main's language changes after the service was built: the next dialog speaks it
    expect(await deps.chooseFile(CALLER)).toBe(PICKED)
    expect(fromWebContents.mock.calls.map(([sender]) => sender === SENDER)).toEqual([true, true])
    // toStrictEqual: no other option (no `defaultPath`, no `multiSelections`), the window first.
    expect(showOpenDialog.mock.calls).toStrictEqual([
      [WINDOW, dialogOptions(en)],
      [WINDOW, dialogOptions(de)]
    ])
    expect(showOpenDialog.mock.calls.every(([parent]) => parent === WINDOW)).toBe(true)
  })

  it.each<[string, unknown, boolean]>([
    ['a sender with no window', CALLER, true],
    ['a caller with no sender', {}, false],
    ['no caller', undefined, false],
    ['a caller that is no object', 'a string', false]
  ])('%s: the dialog opens unparented, with the same options', async (_label, caller, asked) => {
    const { env, showOpenDialog, fromWebContents } = envOf({ windowOf: () => null })
    expect(await updateServiceDepsFor(env)(null).chooseFile(caller)).toBe(PICKED)
    expect(fromWebContents).toHaveBeenCalledTimes(asked ? 1 : 0)
    expect(showOpenDialog.mock.calls).toStrictEqual([[dialogOptions(en)]])
  })

  it.each<[string, OpenDialogReturnValue, string | null]>([
    ['one path: the service is handed that path', { canceled: false, filePaths: [PICKED] }, PICKED],
    ['cancelled: the service is handed null (closed)', { canceled: true, filePaths: [] }, null],
    ['cancelled with a path: the service is handed null (closed)', { canceled: true, filePaths: [PICKED] }, null],
    ['no path: the service is handed null (closed)', { canceled: false, filePaths: [] }, null],
    ['two paths: the service is handed null (closed)', { canceled: false, filePaths: [PICKED, OTHER] }, null]
  ])('the dialog answers %s', async (_label, picked, handed) => {
    const { env } = envOf({ dialog: async () => picked })
    expect(await updateServiceDepsFor(env)(null).chooseFile(CALLER)).toBe(handed)
  })

  it.each<[string, Parameters<typeof envOf>[0]]>([
    ['a dialog that rejects', { dialog: async () => Promise.reject(new Error(`EIO: i/o error, open '${PICKED}'`)) }],
    [
      'a dialog that throws',
      {
        dialog: () => {
          throw new Error('no display')
        }
      }
    ],
    [
      'a caller whose window is gone',
      {
        windowOf: () => {
          throw new TypeError('Object has been destroyed')
        }
      }
    ]
  ])('%s counts as closed: the service is handed null, never a rejection', async (_label, parts) => {
    const { env } = envOf(parts)
    await expect(updateServiceDepsFor(env)(null).chooseFile(CALLER)).resolves.toBeNull()
  })
})

describe('update-service-deps: the computer the update runs on (CF-50)', () => {
  it('the system and its version are Electron\u{2019}s process\u{2019}s, as it answers at each call', () => {
    const getSystemVersion = vi.fn<() => string>().mockReturnValueOnce('15.1.0').mockReturnValueOnce('15.2.0')
    const deps = updateServiceDepsFor(envOf({ process: { platform: 'darwin', getSystemVersion } }).env)(null)
    expect(deps.host.platform).toBe('darwin')
    expect([deps.host.osVersion(), deps.host.osVersion()]).toEqual(['15.1.0', '15.2.0'])
    expect(getSystemVersion).toHaveBeenCalledTimes(2)
  })

  it.each<NodeJS.Platform>(['win32', 'darwin'])('glibc only on Linux: on %s it is null, and no report is built', (platform) => {
    const getReport = vi.fn(() => ({ header: { glibcVersionRuntime: '2.39' } }))
    const deps = updateServiceDepsFor(envOf({ process: { platform, getSystemVersion: () => '1.0', report: { excludeNetwork: false, getReport } } }).env)(null)
    expect(deps.host.glibc()).toBeNull()
    expect(getReport).not.toHaveBeenCalled()
    expect(linesOf(GLIBC_LINE)).toEqual([])
  })

  it('the UI language is main\u{2019}s, one of the ten codes, as it is at each call', () => {
    const deps = updateServiceDepsFor(envOf().env)(null)
    expect(deps.host.uiLanguage()).toBe('en')
    for (const code of UI_LANGUAGE_CODES) {
      applyUiLanguageSetting(code)
      expect(deps.host.uiLanguage()).toBe(code)
    }
    initMainI18n('xx-YY') // a system language the app does not speak
    expect(deps.host.uiLanguage()).toBe('en')
    expect(UI_LANGUAGE_CODES).toHaveLength(10)
  })
})

describe('update-service-deps: the clock, the drive\u{2019}s readers, the appender and node:fs', () => {
  it('the clock is the wall clock and the monotonic one', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_764_201_600_000)
    vi.spyOn(performance, 'now').mockReturnValue(4242.5)
    const { clock } = updateServiceDepsFor(envOf().env)(null)
    expect([clock.now(), clock.monotonic()]).toEqual([1_764_201_600_000, 4242.5])
  })

  it('the reads are the drive\u{2019}s own readers, and the build date is the build-date reader\u{2019}s (T6.4a)', () => {
    const { reads } = updateServiceDepsFor(envOf().env)(null)
    expect(reads.policy).toBe(readUpdatePolicy)
    expect(reads.driveRelease).toBe(readDriveRelease)
    expect(reads.rootApps).toBe(rootApps)
    expect(reads.kitSupport).toBe(readKitSupport)
    expect(reads.buildDate()).toBe(BUILD_DATE)
  })

  it('update.log lines go through the one appender, and the files through node:fs as the service and staging export it', () => {
    const deps = updateServiceDepsFor(envOf().env)(null)
    expect(deps.appendLog).toBe(appendUpdateLogLine)
    expect(deps.fs.bundle).toBe(NODE_BUNDLE_FS)
    expect(deps.fs.staging).toBe(NODE_STAGING_FS)
    expect(deps.fs.start).toBe(NODE_START_FS)
  })

  it('the service is handed these fields and the layout it names, nothing else: no P7 start hook, no audit sink', () => {
    const depsFor = updateServiceDepsFor(envOf().env)
    const layout = layoutAt('update-service-deps-layout')
    const deps = depsFor(layout)
    expect(deps.paths).toBe(layout)
    expect(depsFor(null).paths).toBeNull()
    expect(Object.keys(deps).sort()).toEqual(['appendLog', 'chooseFile', 'clock', 'fs', 'host', 'keys', 'paths', 'reads', 'runningVersion'])
    expect(Object.keys(deps.host).sort()).toEqual(['glibc', 'osVersion', 'platform', 'uiLanguage'])
    expect(Object.keys(deps.clock).sort()).toEqual(['monotonic', 'now'])
    expect(Object.keys(deps.reads).sort()).toEqual(['buildDate', 'driveRelease', 'kitSupport', 'policy', 'rootApps'])
    expect(Object.keys(deps.fs).sort()).toEqual(['bundle', 'staging', 'start'])
  })
})

describe('update-service-deps: the version this app runs as, and the keys (T6.3 sheet answer 4: fail closed)', () => {
  it('a version that parses: the embedded keys and that version, and no line', () => {
    expect(embeddedKeySet.keys.length).toBeGreaterThan(0) // the stand-in build embeds a key
    const deps = updateServiceDepsFor(envOf({ version: '0.1.66' }).env)(null)
    expect(deps.keys).toBe(embeddedKeySet.keys)
    expect(deps.runningVersion).toEqual(parseSemver('0.1.66'))
    expect(linesOf(VERSION_LINE)).toEqual([])
  })

  it.each(['', 'not-a-version', '1.2', '01.2.3'])('a version that does not parse (%j): no key, 0.0.0, one fixed line per build', (version) => {
    const depsFor = updateServiceDepsFor(envOf({ version }).env)
    const deps = depsFor(null)
    expect(deps.keys).toEqual([])
    expect(deps.runningVersion).toEqual(parseSemver('0.0.0'))
    expect(linesOf(VERSION_LINE)).toEqual(['']) // the reason alone: no version text, no field
    depsFor(null)
    expect(linesOf(VERSION_LINE)).toEqual(['', ''])
  })

  // T6.9 lens 3 note: the module never throws, so the start and the failure state both get their service; the line is
  // best-effort, as the glibc hook's is.
  it('a logger that throws on that line changes nothing: the deps are built, no key, 0.0.0', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('the log is gone')
    })
    const deps = updateServiceDepsFor(envOf({ version: 'not-a-version' }).env)(null)
    expect({ keys: deps.keys, runningVersion: deps.runningVersion }).toEqual({ keys: [], runningVersion: parseSemver('0.0.0') })
  })
})

// T6.3 review M-1, m-4 (fix round 1, F1): the runtime glibc (CF-50) is `process.report.getReport().header
// .glibcVersionRuntime`, a full diagnostic report built synchronously on the main thread. The hook never throws: a runtime
// with no report, no getReport function, a report that throws or a header without the field answers null (every update
// that names a Linux floor then refuses UPD-CANT-CHECK-LINUX-FLOOR) and writes one fixed app.log line by a closed reason,
// never the error's message. It reads once per process and keeps that answer, null included; the service still asks it
// once per import. The report's network part is left out for the call when the setting is a boolean, and put back in the
// same synchronous step, a throw included.
describe('update-service-deps: the runtime glibc on Linux (CF-50; T6.3 review M-1, m-4)', () => {
  /** Node's diagnostic report as far as the hook reads it: getReport answers what `answer` makes (or throws it), and
   *  records the excludeNetwork setting each call ran under. */
  function reportOf(answer: () => unknown, setting: { excludeNetwork?: unknown } = { excludeNetwork: false }) {
    const ranWith: unknown[] = []
    const report: { excludeNetwork?: unknown; getReport: () => unknown } = {
      ...setting,
      getReport: vi.fn(() => {
        ranWith.push(report.excludeNetwork)
        return answer()
      })
    }
    return { report, ranWith }
  }
  const linux = (report?: unknown): UpdateServiceEnv['process'] => ({
    platform: 'linux',
    getSystemVersion: () => '6.6.87',
    ...(report === undefined ? {} : { report })
  })
  const glibcOf = (proc: UpdateServiceEnv['process']) => updateServiceDepsFor(envOf({ process: proc }).env)(null).host.glibc
  const GLIBC_2_39 = () => ({ header: { glibcVersionRuntime: '2.39', glibcVersionCompiler: '2.28', osName: 'Linux' } })
  const failing = () => {
    throw new Error("EIO: i/o error, open '/proc/self/maps'")
  }

  it.each([false, true])('reads the header\u{2019}s glibc with the network part left out, and puts the setting (%s) back', (setting) => {
    const { report, ranWith } = reportOf(GLIBC_2_39, { excludeNetwork: setting })
    expect(glibcOf(linux(report))()).toBe('2.39')
    expect(ranWith).toEqual([true])
    expect(report.excludeNetwork).toBe(setting)
    expect(linesOf(GLIBC_LINE)).toEqual([])
  })

  it('reads once per process: later calls, of this build or a later one, answer the first answer without a report', () => {
    const { report } = reportOf(GLIBC_2_39)
    const depsFor = updateServiceDepsFor(envOf({ process: linux(report) }).env)
    const first = depsFor(layoutAt('update-service-deps-glibc')).host.glibc
    const later = depsFor(null).host.glibc // a second build (the one service's build tried again)
    expect([first(), first(), later()]).toEqual(['2.39', '2.39', '2.39'])
    expect(report.getReport).toHaveBeenCalledTimes(1)
  })

  it('keeps a null first answer too: a report that failed once is not built again, and the line is written once', () => {
    const { report } = reportOf(failing)
    const glibc = glibcOf(linux(report))
    expect([glibc(), glibc(), glibc()]).toEqual([null, null, null])
    expect(report.getReport).toHaveBeenCalledTimes(1)
    expect(linesOf(GLIBC_LINE)).toEqual([{ reason: 'report-threw' }])
  })

  it.each<[string, () => UpdateServiceEnv['process'], string]>([
    ['no process.report', () => linux(), 'no-report'],
    ['a process.report that is null', () => linux(null), 'no-report'],
    ['a getReport that is no function', () => linux({ excludeNetwork: false, getReport: 'not a function' }), 'no-get-report'],
    ['a getReport that throws', () => linux(reportOf(failing).report), 'report-threw'],
    ['a header without the field (no glibc: musl)', () => linux(reportOf(() => ({ header: { osName: 'Linux' } })).report), 'no-glibc-field'],
    ['a report without a header', () => linux(reportOf(() => ({})).report), 'no-glibc-field'],
    ['a field that is no string', () => linux(reportOf(() => ({ header: { glibcVersionRuntime: 2.39 } })).report), 'no-glibc-field'],
    ['an empty field', () => linux(reportOf(() => ({ header: { glibcVersionRuntime: '' } })).report), 'no-glibc-field']
  ])('%s: null, no throw, one fixed line by its reason and never the error\u{2019}s text', (_label, proc, reason) => {
    expect(glibcOf(proc())()).toBeNull()
    expect(linesOf(GLIBC_LINE)).toEqual([{ reason }])
    for (const line of readLogTail()) expect(line).not.toContain('i/o error')
  })

  it.each([false, true])('a getReport that throws: the setting (%s) is put back all the same', (setting) => {
    const { report, ranWith } = reportOf(failing, { excludeNetwork: setting })
    expect(glibcOf(linux(report))()).toBeNull()
    expect(ranWith).toEqual([true])
    expect(report.excludeNetwork).toBe(setting)
  })

  it.each<[string, { excludeNetwork?: unknown }]>([
    ['no setting', {}],
    ['a setting that is no boolean', { excludeNetwork: 'no' }]
  ])('a report with %s: the setting is never written, and the report is still read', (_label, setting) => {
    const { report, ranWith } = reportOf(GLIBC_2_39, setting)
    expect(glibcOf(linux(report))()).toBe('2.39')
    expect(ranWith).toEqual([setting.excludeNetwork])
    expect(Object.hasOwn(report, 'excludeNetwork')).toBe('excludeNetwork' in setting)
    expect(report.excludeNetwork).toBe(setting.excludeNetwork)
  })

  // A Linux leg only (CI's ubuntu runner): Node's own report, through the same hook. Electron's main process on Linux is
  // the fix round's probe (impl/p6/T6.3/fix/linux-probe.out).
  it.runIf(process.platform === 'linux')('this runtime\u{2019}s own report: a glibc version, and the setting as it was', () => {
    const real = process.report as unknown as { excludeNetwork?: unknown }
    const before = real.excludeNetwork
    expect(glibcOf({ platform: process.platform, getSystemVersion: () => '', report: process.report })()).toMatch(/^\d+\.\d+/)
    expect(real.excludeNetwork).toBe(before)
  })
})
