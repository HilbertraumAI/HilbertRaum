import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// EP-1 Phase 6 (plan §11 item 1) — the PDF print harness against a FAKE electron: the
// D-1 option set is pinned LITERALLY (a dropped `preferCSSPageSize` or a footer
// `@font-face` would otherwise ship green — the D-1 pitfall list is the whole reason
// these literals exist), and the lifecycle discipline is driven end to end: hidden
// sandboxed preload-free window, deny-all navigation, print only after load + fonts,
// destroy in `finally` on success AND failure AND app quit, before-quit listener never leaked.
//
// #563: the page is served FROM MEMORY on `hilbertraum://print/<token>` — no file is written.
// The fake window's `loadURL` fetches its URL through the REAL scheme handler
// (`createAppProtocolHandler` over the app's one `printPages` registry), the way Chromium would,
// so these tests see exactly what the handler serves: the verbatim pack at load time, a 404
// afterwards, and an empty registry once every print has ended, however it ended. What a fake
// electron CANNOT prove — that Chromium really honors the options and loads the scheme — is the
// env-gated real-Electron smoke's job (evidence-pack-pdf-smoke.test.ts).

interface FakeWebContents {
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  printToPDF: ReturnType<typeof vi.fn>
}

interface FakeWin {
  opts: Record<string, unknown>
  webContents: FakeWebContents
  destroyed: boolean
  /** What the handler served this window at load time (status + body), like a renderer's document. */
  served: { status: number; body: string; headers: Headers } | null
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
}

const fake = vi.hoisted(() => {
  const state = {
    windows: [] as FakeWin[],
    appListeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    /** Behavior knobs, reset per test. Runs AFTER the page was fetched; may throw or park. */
    afterFetch: undefined as ((url: string) => Promise<void>) | undefined,
    /** When set, the load fails BEFORE anything is fetched (a did-fail-load with no request). */
    failBeforeFetch: undefined as Error | undefined,
    printToPDF: undefined as ((options: unknown) => Promise<Uint8Array>) | undefined,
    /** Pending printToPDF rejectors — destroy() rejects them like a real killed window. */
    pendingPrintRejects: [] as Array<(e: Error) => void>,
    /** The page fetcher — the real handler, installed below once the module is importable. */
    fetchPage: undefined as ((url: string) => Promise<Response>) | undefined
  }
  const emitApp = (event: string): void => {
    for (const fn of [...(state.appListeners.get(event) ?? [])]) fn()
  }
  return { state, emitApp }
})

vi.mock('electron', () => {
  const { state } = fake
  class BrowserWindow {
    opts: Record<string, unknown>
    webContents: FakeWebContents
    destroyed = false
    served: FakeWin['served'] = null
    // The renderer side of a navigation: fetch the URL through the scheme handler, keep the body.
    loadURL = vi.fn(async (url: string) => {
      if (state.failBeforeFetch) throw state.failBeforeFetch
      const res = await state.fetchPage!(url)
      this.served = { status: res.status, body: await res.text(), headers: res.headers }
      await (state.afterFetch?.(url) ?? Promise.resolve())
    })
    // Kept only so a test can assert the harness never loads a FILE again (#563).
    loadFile = vi.fn(async () => {})
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.webContents = {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        executeJavaScript: vi.fn(async () => true),
        printToPDF: vi.fn(
          (options: unknown) =>
            new Promise<Uint8Array>((resolve, reject) => {
              fake.state.pendingPrintRejects.push(reject)
              void (fake.state.printToPDF?.(options) ?? Promise.resolve(new Uint8Array())).then(
                resolve,
                reject
              )
            })
        )
      }
      state.windows.push(this as unknown as FakeWin)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
      // A destroyed window rejects its in-flight print, like real Electron.
      for (const reject of fake.state.pendingPrintRejects.splice(0)) {
        reject(new Error('Object has been destroyed'))
      }
    }
  }
  return {
    BrowserWindow,
    app: {
      once: (event: string, fn: (...a: unknown[]) => void) => {
        const list = state.appListeners.get(event) ?? []
        // `once` semantics: self-removing wrapper (the harness also removes explicitly).
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
  }
})

import {
  buildEvidencePackPrintOptions,
  printEvidencePackHtmlToPdf,
  PRINT_STEP_TIMEOUT_MS
} from '../../src/main/services/evidence-pack/print-pdf'
import {
  createAppProtocolHandler,
  printPages,
  PRINT_MAX_PENDING
} from '../../src/main/app-protocol'
import { EVIDENCE_PACK_CSP, SECURE_WINDOW_WEB_PREFERENCES } from '../../src/main/window-security'

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>pack</body></html>'
const PACK_ID = '00000000-0000-4000-8000-00000000e9a1'
const PRINT_URL = /^hilbertraum:\/\/print\/[0-9a-f]{64}$/

// The app's real handler over the app's real registry — the same pair install-app-protocol.ts
// wires. No app files: only the print host matters here.
const handler = createAppProtocolHandler({
  files: new Set(),
  readFile: async () => {
    throw new Error('no app files in this test')
  },
  printPages
})
const fetchPage = (url: string): Promise<Response> => handler(new Request(url))

beforeEach(() => {
  fake.state.windows = []
  fake.state.appListeners = new Map()
  fake.state.afterFetch = undefined
  fake.state.failBeforeFetch = undefined
  fake.state.printToPDF = undefined
  fake.state.pendingPrintRejects = []
  fake.state.fetchPage = fetchPage
})

afterEach(() => {
  vi.useRealTimers()
  // Every print, however it ended, gave its slot back.
  expect(printPages.pending).toBe(0)
})

const lastWin = (): FakeWin => {
  const win = fake.state.windows.at(-1)
  if (!win) throw new Error('no window was created')
  return win
}

describe('D-1 print option set (pinned literals)', () => {
  it('carries the full spec §17.1 set the installed Electron 37 supports', () => {
    const opts = buildEvidencePackPrintOptions(PACK_ID)
    expect(opts.pageSize).toBe('A4')
    expect(opts.preferCSSPageSize).toBe(true) // the template @page rule is authoritative
    expect(opts.printBackground).toBe(true)
    expect(opts.displayHeaderFooter).toBe(true)
    expect(opts.generateDocumentOutline).toBe(true) // h1→h2→h3 tree becomes bookmarks
    expect(opts.generateTaggedPDF).toBe(true) // experimental — best-effort, never PDF/UA
    // The default Chromium header (print date + title) is suppressed — footer only.
    expect(opts.headerTemplate).toBe('<span></span>')
  })

  it('footer = pack ID + pageNumber/totalPages, system fonts + inline styles ONLY', () => {
    const opts = buildEvidencePackPrintOptions(PACK_ID)
    const footer = opts.footerTemplate!
    expect(footer).toContain(PACK_ID)
    expect(footer).toContain('class="pageNumber"')
    expect(footer).toContain('class="totalPages"')
    // Chromium's template default font-size is unusable — must be explicit.
    expect(footer).toContain('font-size')
    expect(footer).toContain('system-ui')
    // D-1 pitfalls: a template @font-face fails the whole print; remote refs are banned.
    for (const template of [footer, opts.headerTemplate!]) {
      expect(template).not.toContain('@font-face')
      expect(template).not.toContain('@import')
      expect(template).not.toContain('url(')
      expect(template).not.toContain('<link')
      expect(template).not.toContain('<script')
    }
  })

  it('escapes a hostile pack id before it enters the footer markup', () => {
    const footer = buildEvidencePackPrintOptions('<img src=x onerror=y>"&\'')!.footerTemplate!
    expect(footer).not.toContain('<img')
    expect(footer).toContain('&lt;img src=x onerror=y&gt;&quot;&amp;&#39;')
  })
})

describe('print flow (hidden window lifecycle, page served from memory — #563)', () => {
  it('loads the page from memory, waits for fonts, prints, tears everything down', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"
    fake.state.printToPDF = async () => pdfBytes

    const result = await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })

    expect(Buffer.compare(result, Buffer.from(pdfBytes))).toBe(0)
    const win = lastWin()
    // One load, of a print-host URL carrying a random token — never a file.
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    const url = String(win.loadURL.mock.calls[0]![0])
    expect(url).toMatch(PRINT_URL)
    expect(url).not.toContain(PACK_ID)
    expect(win.loadFile).not.toHaveBeenCalled()
    // The handler served the VERBATIM pack at load time, under the pack's own policy.
    expect(win.served?.status).toBe(200)
    expect(win.served?.body).toBe(HTML)
    expect(win.served?.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(win.served?.headers.get('Content-Security-Policy')).toBe(EVIDENCE_PACK_CSP)
    expect(win.served?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(win.served?.headers.get('Cache-Control')).toBe('no-store')
    // did-finish-load (the loadURL await) THEN fonts THEN print — D-1 order.
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
      'document.fonts.ready.then(() => true)'
    )
    expect(win.webContents.printToPDF).toHaveBeenCalledWith(
      buildEvidencePackPrintOptions(PACK_ID)
    )
    // Teardown: window destroyed, the page gone (a second request is a 404), quit hook detached.
    expect(win.destroyed).toBe(true)
    expect((await fetchPage(url)).status).toBe(404)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('serves the page at most once: a second request during the print is a 404', async () => {
    let second: number | null = null
    fake.state.afterFetch = async (url) => {
      second = (await fetchPage(url)).status
    }
    await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    expect(lastWin().served?.status).toBe(200)
    expect(second).toBe(404)
  })

  it('creates a hidden, sandboxed, preload-FREE window and denies every navigation', async () => {
    await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    const win = lastWin()
    expect(win.opts.show).toBe(false)
    expect(win.opts.skipTaskbar).toBe(true)
    // The shared hardening object, spread verbatim — and NO preload key at all: this
    // window has no IPC surface (plan §11: "sandbox, no preload, no node").
    expect(win.opts.webPreferences).toEqual({ ...SECURE_WINDOW_WEB_PREFERENCES })
    expect(win.opts.webPreferences).not.toHaveProperty('preload')
    // Window-open denied…
    const openHandler = win.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => {
      action: string
    }
    expect(openHandler()).toEqual({ action: 'deny' })
    // …and BOTH navigation events guarded (SEC-3), both cancelling.
    const guarded = new Map(
      win.webContents.on.mock.calls.map((c) => [c[0], c[1]]) as Array<
        [string, (e: { preventDefault: () => void }, url: string) => void]
      >
    )
    for (const event of ['will-navigate', 'will-redirect']) {
      const listener = guarded.get(event)
      expect(listener, `${event} must be guarded`).toBeDefined()
      const preventDefault = vi.fn()
      listener!({ preventDefault }, 'https://example.com/')
      expect(preventDefault).toHaveBeenCalled()
    }
  })

  it('a print failure tears down the window and drops the page, then rethrows', async () => {
    fake.state.printToPDF = async () => {
      throw new Error('printToPDF failed')
    }
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'printToPDF failed'
    )
    expect(lastWin().destroyed).toBe(true)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a load failure before any request (did-fail-load) releases the never-served page', async () => {
    fake.state.failBeforeFetch = new Error('ERR_UNKNOWN_URL_SCHEME')
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'ERR_UNKNOWN_URL_SCHEME'
    )
    const win = lastWin()
    expect(win.destroyed).toBe(true)
    // The page was never fetched, and the finally dropped it: its URL is a 404 now.
    expect((await fetchPage(String(win.loadURL.mock.calls[0]![0]))).status).toBe(404)
  })

  it('app quit mid-print destroys the hidden window and fails the print (kill-mid-print)', async () => {
    // A print that never settles on its own — only the destroy can end it.
    fake.state.printToPDF = () => new Promise<Uint8Array>(() => {})
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    // Let the flow reach the pending printToPDF, then quit the app.
    await vi.waitFor(() => {
      expect(lastWin().webContents.printToPDF).toHaveBeenCalled()
    })
    fake.emitApp('before-quit')
    await expect(printing).rejects.toThrow('Object has been destroyed')
    expect(lastWin().destroyed).toBe(true)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a wedged renderer fails the step timeout instead of hanging the export', async () => {
    vi.useFakeTimers()
    fake.state.afterFetch = () => new Promise<void>(() => {}) // never finishes loading
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    const failed = expect(printing).rejects.toThrow(/load step took too long/)
    // No file is written any more (#563), so the window and its load-step timer exist as soon
    // as the load has started — no real-time wait for a disk write.
    await vi.waitFor(() => expect(lastWin().loadURL).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(PRINT_STEP_TIMEOUT_MS + 1)
    await failed
    expect(lastWin().destroyed).toBe(true)
  })
})

describe('the print-page registry around the harness (#563)', () => {
  it(`two concurrent prints get two tokens, and each window loads its own pack (AUD-17, in memory)`, async () => {
    const gates: Array<() => void> = []
    fake.state.afterFetch = () => new Promise<void>((resolve) => gates.push(resolve))
    const a = printEvidencePackHtmlToPdf('<p>ALPHA</p>', { packId: 'A' })
    const b = printEvidencePackHtmlToPdf('<p>BRAVO</p>', { packId: 'B' })
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    const [winA, winB] = fake.state.windows
    expect(winA!.loadURL.mock.calls[0]![0]).not.toBe(winB!.loadURL.mock.calls[0]![0])
    expect(winA!.served?.body).toBe('<p>ALPHA</p>')
    expect(winB!.served?.body).toBe('<p>BRAVO</p>')
    for (const g of gates) g()
    await Promise.all([a, b])
  })

  it(`over ${PRINT_MAX_PENDING} prints at once, the next fails before any window or held page`, async () => {
    const gates: Array<() => void> = []
    fake.state.afterFetch = () => new Promise<void>((resolve) => gates.push(resolve))
    const running = Array.from({ length: PRINT_MAX_PENDING }, (_, i) =>
      printEvidencePackHtmlToPdf(`<p>${i}</p>`, { packId: String(i) })
    )
    await vi.waitFor(() => expect(gates).toHaveLength(PRINT_MAX_PENDING))
    expect(printPages.pending).toBe(PRINT_MAX_PENDING)
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'too many prints at once'
    )
    expect(fake.state.windows).toHaveLength(PRINT_MAX_PENDING) // no window for the refused one
    for (const g of gates) g()
    await Promise.all(running)
    // The slots came back: a fresh print runs again.
    fake.state.afterFetch = undefined
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).resolves.toBeInstanceOf(
      Buffer
    )
  })
})
