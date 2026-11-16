import { vi, type Mock } from 'vitest'
import { createAppProtocolHandler, printPages } from '../../src/main/app-protocol'

// The fake electron boundary for the evidence-pack print harness (review + export test campaign, commit H): a
// constructible hidden `BrowserWindow` whose `loadURL` fetches its URL through the app's REAL scheme handler (the way
// Chromium would, #563) and whose `printToPDF` prints what it was served, plus the `app.once` / `removeListener` pair
// the harness hooks `before-quit` with. Everything above the boundary stays the shipped code: the real
// `printEvidencePackHtmlToPdf`, the real handler and print-page registry. Replaces the three local fakes at 27bd0b0d:
// unit/evidence-pack-print-pdf.test.ts:57-130, integration/evidence-pack-export-concurrent.test.ts:63-104 and
// integration/evidence-reviews-ipc.test.ts:32-88.
//
// Use (the state must exist before the hoisted mock runs, so it is a `vi.hoisted` literal typed with these interfaces):
//   const state = vi.hoisted((): FakePrintElectronState => ({ windows: [], appListeners: new Map() }))
//   vi.mock('electron', async () =>
//     (await import('../helpers/fake-print-window')).fakePrintElectron(state, { ipcMain, dialog }))
// Reset `windows`, `appListeners` and the knobs in the suite's own `beforeEach`. No module state lives here.

/**
 * A page fetcher over the app's real scheme handler and the app's one `printPages` registry (the pair
 * install-app-protocol.ts wires), with no app files: only the print host answers. Replaces the
 * `createAppProtocolHandler({ files: new Set(), readFile: throw, printPages })` copies at 27bd0b0d:
 * unit/evidence-pack-print-pdf.test.ts:150-156, integration/evidence-pack-export-concurrent.test.ts:115-121 and
 * integration/evidence-reviews-ipc.test.ts:37-43.
 */
export function realPrintFetch(): (url: string) => Promise<Response> {
  const handler = createAppProtocolHandler({
    files: new Set(),
    readFile: async () => {
      throw new Error('no app files in this test')
    },
    printPages
  })
  return (url) => handler(new Request(url))
}

/** One fake hidden print window, as the suite reads it back off `state.windows`. */
export interface FakePrintWindow {
  /** The constructor options (show, skipTaskbar, webPreferences …). */
  opts: Record<string, unknown>
  /** The URL the harness loaded; null until `loadURL` ran. */
  loadedUrl: string | null
  /** What the handler served this window at load time (status + body + headers), like a renderer's document. */
  served: { status: number; body: string; headers: Headers } | null
  /** What `printToPDF` printed: the body served with status 200, or `'<<nothing-served>>'` when none was. */
  printedContent: string | null
  destroyed: boolean
  loadURL: Mock<(url: string) => Promise<void>>
  /** Kept only so a suite can assert the harness never loads a FILE again (#563). */
  loadFile: Mock<() => Promise<void>>
  webContents: {
    setWindowOpenHandler: Mock
    on: Mock
    executeJavaScript: Mock<(code: string) => Promise<boolean>>
    printToPDF: Mock<(options: unknown) => Promise<Uint8Array>>
  }
  isDestroyed(): boolean
  destroy(): void
}

/** The suite-owned state the fake reads at call time (so a `beforeEach` may replace any field). */
export interface FakePrintElectronState {
  /** Every window constructed, in order (the index `afterFetch` receives). */
  windows: FakePrintWindow[]
  /** Runs AFTER the window fetched its page; may throw, or park the load until the suite releases it. */
  afterFetch?: (url: string, index: number) => Promise<void>
  /** When set, the load fails BEFORE anything is fetched (a did-fail-load with no request). */
  failBeforeFetch?: Error
  /** The printer: gets the served 200 body (null when none) and the print options. Default: the served document's
   *  bytes (`printedContent`, UTF-8). */
  printToPDF?: (served: string | null, options: unknown) => Promise<Uint8Array>
  /** `app.once` listeners by event (the harness's `before-quit` hook); fire one with
   *  `for (const fn of [...(state.appListeners.get(event) ?? [])]) fn()`. */
  appListeners: Map<string, Array<(...a: unknown[]) => void>>
}

/**
 * The `electron` module for a `vi.mock` factory: `BrowserWindow` (the fake above; `getFocusedWindow()` is null) and
 * `app` (`getVersion()` `'0.0.0-test'`, `once` / `removeListener` over `state.appListeners`), then `extra` spread
 * last (`ipcMain`, `dialog`, or an override). `destroy()` rejects the window's pending prints with
 * `'Object has been destroyed'`, like a real killed window.
 */
export function fakePrintElectron(
  state: FakePrintElectronState,
  extra: Record<string, unknown> = {}
): { BrowserWindow: unknown; app: unknown } & Record<string, unknown> {
  const fetchPage = realPrintFetch()
  class BrowserWindow implements FakePrintWindow {
    static getFocusedWindow(): null {
      return null
    }
    opts: Record<string, unknown>
    loadedUrl: string | null = null
    served: FakePrintWindow['served'] = null
    printedContent: string | null = null
    destroyed = false
    webContents: FakePrintWindow['webContents']
    private readonly index: number
    /** This window's in-flight print rejectors; `destroy()` rejects them. */
    private readonly pendingPrints: Array<(e: Error) => void> = []
    // The renderer side of a navigation: fetch the URL through the scheme handler, keep what it served.
    loadURL = vi.fn(async (url: string): Promise<void> => {
      this.loadedUrl = url
      if (state.failBeforeFetch) throw state.failBeforeFetch
      const res = await fetchPage(url)
      this.served = { status: res.status, body: await res.text(), headers: res.headers }
      await (state.afterFetch?.(url, this.index) ?? Promise.resolve())
    })
    loadFile = vi.fn(async (): Promise<void> => {})
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.index = state.windows.length
      this.webContents = {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        executeJavaScript: vi.fn(async (_code: string) => true),
        printToPDF: vi.fn(
          (options: unknown) =>
            new Promise<Uint8Array>((resolve, reject) => {
              this.pendingPrints.push(reject)
              const document = this.served?.status === 200 ? this.served.body : null
              this.printedContent = document ?? '<<nothing-served>>'
              const printed = state.printToPDF
                ? state.printToPDF(document, options)
                : Promise.resolve(new TextEncoder().encode(this.printedContent))
              void printed.then(resolve, reject)
            })
        )
      }
      state.windows.push(this)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
      // A destroyed window rejects its in-flight print, like real Electron.
      for (const reject of this.pendingPrints.splice(0)) reject(new Error('Object has been destroyed'))
    }
  }
  const app = {
    getVersion: () => '0.0.0-test',
    once: (event: string, fn: (...a: unknown[]) => void) => {
      const list = state.appListeners.get(event) ?? []
      // `once` semantics: a self-removing wrapper (the harness also removes it explicitly).
      const wrapped = (...a: unknown[]): void => {
        state.appListeners.set(
          event,
          (state.appListeners.get(event) ?? []).filter((f) => f !== wrapped)
        )
        fn(...a)
      }
      ;(wrapped as unknown as { orig: unknown }).orig = fn
      list.push(wrapped)
      state.appListeners.set(event, list)
    },
    removeListener: (event: string, fn: (...a: unknown[]) => void) => {
      state.appListeners.set(
        event,
        (state.appListeners.get(event) ?? []).filter(
          (f) => f !== fn && (f as unknown as { orig: unknown }).orig !== fn
        )
      )
    }
  }
  return { BrowserWindow, app, ...extra }
}
