import type { App, BrowserWindow, Dialog, OpenDialogOptions, WebContents } from 'electron'
import { mainUiLanguage, tMain } from './services/i18n'
import { log } from './services/logging'
import { readUpdatePolicy } from './services/policy'
import { embeddedBuildDate } from './services/updates/build-date'
import { readDriveRelease, rootApps } from './services/updates/drive-release'
import { embeddedKeySet } from './services/updates/keys'
import { readKitSupport } from './services/updates/kit-support'
import { NODE_BUNDLE_FS, NODE_START_FS, type UpdateServiceDeps } from './services/updates/service'
import { NODE_STAGING_FS } from './services/updates/staging'
import { appendUpdateLogLine } from './services/updates/update-log'
import { parseSemver, type Semver } from './services/updates/version'
import type { ResolvedPaths } from './services/workspace'

// App-update W-4 (F-14; docs/app-updates.md §3.5 "The service and its start", "Who picks the file"; T6.2's notes-2 "What
// T6.3 hands in"): what main hands the process's one update service. Kept out of index.ts (which pulls in the whole
// Electron main process) and handed Electron's parts as arguments, so its rows can run without Electron:
// tests/unit/update-service-deps.test.ts. index.ts makes it once, at module scope, and builds the service from it and
// from nothing else (backend-start-wiring.test.ts).

/** The parts of `process` the glibc hook reads: the system, and Node's diagnostic report, typed loosely because the
 *  hook checks at run time that the report and its `getReport` are there (T6.3 review M-1). */
export interface GlibcProcess {
  readonly platform: NodeJS.Platform
  readonly report?: unknown
}

/** What index.ts hands in: Electron's `app`, `dialog`, `BrowserWindow` and `process`, as far as the service needs them. */
export interface UpdateServiceEnv {
  readonly app: Pick<App, 'getVersion'>
  readonly dialog: Pick<Dialog, 'showOpenDialog'>
  readonly BrowserWindow: Pick<typeof BrowserWindow, 'fromWebContents'>
  readonly process: GlibcProcess & { getSystemVersion(): string }
}

/** The running version of a build whose own version does not parse: that build embeds no key (fail closed). */
const UNPARSED_VERSION: Semver = { text: '0.0.0', major: '0', minor: '0', patch: '0', prerelease: [], build: [] }

/** Why the runtime glibc could not be read: a closed list, the one field of its app.log line. */
type GlibcUnread = 'no-report' | 'no-get-report' | 'report-threw' | 'no-glibc-field'

/**
 * The service's dependencies for a layout, from Electron's parts. Made once per process (index.ts, module scope), so
 * the glibc hook it holds reads once per process. For each layout: the embedded key set and this app's version (a
 * version that does not parse fails closed: no key, so every update file answers UPD-NOT-AVAILABLE, and one fixed
 * app.log line; T6.3 sheet answer 4), the computer (CF-50), the clock, the drive's own readers, the build date this
 * build embeds (build-date.ts, record §5.10; `updates:status` answers it), main's dialog, the update.log appender and
 * node:fs. Not handed: P7's start hook, and an audit sink (PR-6b's T6.10b sets that on the service). Never throws.
 */
export function updateServiceDepsFor(env: UpdateServiceEnv): (layout: ResolvedPaths | null) => UpdateServiceDeps {
  const glibc = runtimeGlibcHook(env.process, glibcUnread)
  return (layout) => {
    const running = parseSemver(env.app.getVersion())
    if (running === null) log.warn('Update service: the app version does not parse, so no update file is accepted')
    return {
      paths: layout,
      keys: running === null ? [] : embeddedKeySet.keys,
      runningVersion: running ?? UNPARSED_VERSION,
      host: {
        platform: env.process.platform,
        osVersion: () => env.process.getSystemVersion(),
        glibc,
        uiLanguage: mainUiLanguage
      },
      clock: { now: () => Date.now(), monotonic: () => performance.now() },
      reads: { policy: readUpdatePolicy, driveRelease: readDriveRelease, rootApps, kitSupport: readKitSupport, buildDate: () => embeddedBuildDate },
      chooseFile: (caller) => chooseUpdateFile(env, caller),
      appendLog: appendUpdateLogLine,
      fs: { bundle: NODE_BUNDLE_FS, staging: NODE_STAGING_FS, start: NODE_START_FS }
    }
  }
}

/**
 * Main's own dialog for an update file (record §3.5 "Who picks the file"): parented to the window that called (a window
 * driven without focus gets it too; unparented when the caller has none), one file, the update file filter and "All
 * files", no default folder, titled in main's language at each call. One path, or null for a dialog that was cancelled
 * or answered anything else. A dialog that cannot open (a caller whose window is gone, no display) counts as closed
 * here as it does in the service. The picked path never leaves main.
 */
async function chooseUpdateFile(env: UpdateServiceEnv, caller: unknown): Promise<string | null> {
  try {
    const sender = (caller as { sender?: WebContents } | null | undefined)?.sender
    const parent = sender ? env.BrowserWindow.fromWebContents(sender) : null
    const options: OpenDialogOptions = {
      title: tMain('main.dialog.importUpdate'),
      properties: ['openFile'],
      filters: [
        { name: tMain('main.dialog.filterUpdate'), extensions: ['hrupdate'] },
        { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
      ]
    }
    const picked = parent ? await env.dialog.showOpenDialog(parent, options) : await env.dialog.showOpenDialog(options)
    return picked.canceled || picked.filePaths.length !== 1 ? null : picked.filePaths[0]!
  } catch {
    return null // counted as closed
  }
}

/** The glibc hook's app.log line: a fixed reason and a closed-list field, never an error's message. */
function glibcUnread(reason: GlibcUnread): void {
  try {
    log.warn('Update service: the runtime glibc could not be read', { reason })
  } catch {
    /* the log is best-effort */
  }
}

/**
 * CF-50: the runtime glibc on Linux (T6.3 review M-1, m-4), null on every other system without a report. Read at the
 * first call and kept for the process: the runtime's glibc cannot change while it runs, and the report is built
 * synchronously on the main thread (tens of milliseconds). A null first answer is kept too: no report object, no
 * getReport function and a header without the field (a runtime with no glibc) are facts of this runtime, and a report
 * that threw would stall the main thread again at each later call for the same refusal; so every update that names a
 * Linux floor answers UPD-CANT-CHECK-LINUX-FLOOR until the app starts again, and the line is written once. The service
 * still asks once per import. Never throws.
 */
function runtimeGlibcHook(proc: GlibcProcess, unread: (reason: GlibcUnread) => void): () => string | null {
  let kept: { readonly glibc: string | null } | null = null
  return () => {
    if (proc.platform !== 'linux') return null
    kept ??= { glibc: readRuntimeGlibc(proc, unread) }
    return kept.glibc
  }
}

/** One read of Node's report: its network part left out for the call when the setting is a boolean (T6.3 sheet answer
 *  5), and the setting put back in the same synchronous step, a throw included. */
function readRuntimeGlibc(proc: GlibcProcess, unread: (reason: GlibcUnread) => void): string | null {
  try {
    const report = proc.report as { excludeNetwork?: unknown; getReport?: unknown } | null | undefined
    if (typeof report !== 'object' || report === null) {
      unread('no-report')
      return null
    }
    if (typeof report.getReport !== 'function') {
      unread('no-get-report')
      return null
    }
    const previous = report.excludeNetwork
    const exclude = typeof previous === 'boolean'
    if (exclude) report.excludeNetwork = true
    let header: unknown
    try {
      header = (report.getReport() as { header?: unknown } | null)?.header
    } finally {
      if (exclude) report.excludeNetwork = previous
    }
    const glibc = typeof header === 'object' && header !== null ? (header as { glibcVersionRuntime?: unknown }).glibcVersionRuntime : null
    if (typeof glibc === 'string' && glibc !== '') return glibc
    unread('no-glibc-field')
    return null
  } catch {
    unread('report-threw')
    return null
  }
}
