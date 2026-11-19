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

// The shared fake electron boundary (tests/helpers/fake-print-window.ts): a constructible hidden window whose
// `loadURL` fetches through the REAL scheme handler and whose `printToPDF` prints what it was served.
const state = vi.hoisted((): FakePrintElectronState => ({ windows: [], appListeners: new Map() }))
vi.mock('electron', async () => (await import('../helpers/fake-print-window')).fakePrintElectron(state))

import {
  buildEvidencePackPrintOptions,
  printEvidencePackHtmlToPdf,
  PRINT_STEP_TIMEOUT_MS
} from '../../src/main/services/evidence-pack/print-pdf'
import { printPages, PRINT_MAX_PENDING } from '../../src/main/app-protocol'
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../src/main/window-security'
import { deferred } from '../helpers/deferred'
import {
  realPrintFetch,
  type FakePrintElectronState,
  type FakePrintWindow
} from '../helpers/fake-print-window'
import { hangBudgetMs, until } from '../helpers/hang-budget'

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>pack</body></html>'
const PACK_ID = '00000000-0000-4000-8000-00000000e9a1'
const PRINT_URL = /^hilbertraum:\/\/print\/[0-9a-f]{64}$/

// The app's real handler over the app's real registry — the same pair install-app-protocol.ts
// wires (a second request for a page, as Chromium would make it).
const fetchPage = realPrintFetch()

/** Fire an `app` event the harness listens to (`before-quit`). */
const emitApp = (event: string): void => {
  for (const fn of [...(state.appListeners.get(event) ?? [])]) fn()
}

beforeEach(() => {
  state.windows = []
  state.appListeners = new Map()
  state.afterFetch = undefined
  state.failBeforeFetch = undefined
  state.printToPDF = undefined
})

afterEach(() => {
  vi.useRealTimers()
  // Every print, however it ended, gave its slot back.
  expect(printPages.pending).toBe(0)
})

const lastWin = (): FakePrintWindow => {
  const win = state.windows.at(-1)
  if (!win) throw new Error('no window was created')
  return win
}

describe('D-1 print option set (pinned literals)', () => {
  it('carries the full spec §17.1 D-1 option set', () => {
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
    state.printToPDF = async () => pdfBytes
    // The pack id is IN the page: a token derived from the page would carry it into the URL.
    const html = HTML.replace('pack', PACK_ID)
    const loaded = deferred()
    state.afterFetch = () => loaded.promise

    const printing = printEvidencePackHtmlToPdf(html, { packId: PACK_ID })
    // D-1 order, step by step: the page is fetched, but did-finish-load (the loadURL await) has not
    // resolved yet, so no font wait has started…
    await until(() => state.windows.at(-1)?.served != null, 'the page was fetched')
    const win = lastWin()
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled()
    const fonts = deferred<boolean>()
    win.webContents.executeJavaScript.mockImplementationOnce(() => fonts.promise)
    loaded.resolve()
    // …the fonts wait starts only after the load…
    await until(() => win.webContents.executeJavaScript.mock.calls.length === 1, 'the fonts wait started')
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith('document.fonts.ready.then(() => true)')
    // …and the print only after the fonts.
    expect(win.webContents.printToPDF).not.toHaveBeenCalled()
    fonts.resolve(true)
    const result = await printing

    expect(Buffer.compare(result, Buffer.from(pdfBytes))).toBe(0)
    // One load, of a print-host URL carrying a random token — never a file, never the pack id.
    expect(win.loadURL).toHaveBeenCalledTimes(1)
    const url = String(win.loadedUrl)
    expect(url).toMatch(PRINT_URL)
    expect(url).not.toContain(PACK_ID)
    expect(url).not.toContain(PACK_ID.replace(/-/g, ''))
    expect(win.loadFile).not.toHaveBeenCalled()
    // The handler served the VERBATIM pack at load time (its headers: app-protocol.test.ts).
    expect(win.served?.status).toBe(200)
    expect(win.served?.body).toBe(html)
    expect(win.webContents.printToPDF).toHaveBeenCalledWith(buildEvidencePackPrintOptions(PACK_ID))
    // Teardown: window destroyed, the page gone (a second request is a 404), quit hook detached.
    expect(win.destroyed).toBe(true)
    expect((await fetchPage(url)).status).toBe(404)
    expect(state.appListeners.get('before-quit') ?? []).toHaveLength(0)
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
    state.printToPDF = async () => {
      throw new Error('printToPDF failed')
    }
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'printToPDF failed'
    )
    expect(lastWin().destroyed).toBe(true)
    expect(state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a load failure before any request (did-fail-load) releases the never-served page', async () => {
    state.failBeforeFetch = new Error('ERR_UNKNOWN_URL_SCHEME')
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'ERR_UNKNOWN_URL_SCHEME'
    )
    const win = lastWin()
    expect(win.destroyed).toBe(true)
    // The page was never fetched, and the finally dropped it: its URL is a 404 now.
    expect((await fetchPage(String(win.loadedUrl))).status).toBe(404)
  })

  it('app quit mid-print destroys the hidden window and fails the print (kill-mid-print)', async () => {
    // A print that never settles on its own — only the destroy can end it.
    state.printToPDF = () => new Promise<Uint8Array>(() => {})
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    // Let the flow reach the pending printToPDF, then quit the app.
    await vi.waitFor(() => {
      expect(lastWin().webContents.printToPDF).toHaveBeenCalled()
    }, { timeout: hangBudgetMs(5000) })
    emitApp('before-quit')
    await expect(printing).rejects.toThrow('Object has been destroyed')
    expect(lastWin().destroyed).toBe(true)
    expect(state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a wedged renderer fails the step timeout instead of hanging the export', async () => {
    expect(PRINT_STEP_TIMEOUT_MS).toBe(60_000) // the shipped bound (design record §5 "60 s step timeouts")
    vi.useFakeTimers()
    state.afterFetch = () => new Promise<void>(() => {}) // never finishes loading
    let settled = false
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })
    void printing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    const failed = expect(printing).rejects.toThrow(/load step took too long/)
    // No file is written any more (#563), so the window and its load-step timer exist as soon
    // as the load has started. A real-time poll: `vi.waitFor` would advance the fake clock while
    // it retries and spoil the just-short arithmetic below.
    await until(() => state.windows.length === 1, 'the print window opened')
    await vi.advanceTimersByTimeAsync(PRINT_STEP_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(lastWin().destroyed).toBe(true)
  })
})

describe('the print-page registry around the harness (#563)', () => {
  it(`over ${PRINT_MAX_PENDING} prints at once, the next fails before any window or held page`, async () => {
    const gates: Array<() => void> = []
    state.afterFetch = () => new Promise<void>((resolve) => gates.push(resolve))
    const running = Array.from({ length: PRINT_MAX_PENDING }, (_, i) =>
      printEvidencePackHtmlToPdf(`<p>${i}</p>`, { packId: String(i) })
    )
    await vi.waitFor(() => expect(gates).toHaveLength(PRINT_MAX_PENDING), { timeout: hangBudgetMs(5000) })
    expect(printPages.pending).toBe(PRINT_MAX_PENDING)
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).rejects.toThrow(
      'too many prints at once'
    )
    expect(state.windows).toHaveLength(PRINT_MAX_PENDING) // no window for the refused one
    for (const g of gates) g()
    await Promise.all(running)
    // The slots came back: a fresh print runs again.
    state.afterFetch = undefined
    await expect(printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID })).resolves.toBeInstanceOf(
      Buffer
    )
  })
})
