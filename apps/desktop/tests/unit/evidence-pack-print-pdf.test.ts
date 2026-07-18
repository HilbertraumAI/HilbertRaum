import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// EP-1 Phase 6 (plan §11 item 1) — the PDF print harness against a FAKE electron: the
// D-1 option set is pinned LITERALLY (a dropped `preferCSSPageSize` or a footer
// `@font-face` would otherwise ship green — the D-1 pitfall list is the whole reason
// these literals exist), and the lifecycle discipline is driven end to end: hidden
// sandboxed preload-free window, deny-all navigation, print only after load + fonts,
// destroy in `finally` on success AND failure AND app quit, transient print-source file
// always removed, before-quit listener never leaked. What a fake electron CANNOT prove —
// that Chromium really honors the options — is the env-gated real-Electron smoke's job
// (evidence-pack-pdf-smoke.test.ts).

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
  loadFile: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
}

const fake = vi.hoisted(() => {
  const state = {
    windows: [] as FakeWin[],
    appListeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    /** Behavior knobs, reset per test. */
    loadFile: undefined as ((path: string) => Promise<void>) | undefined,
    printToPDF: undefined as ((options: unknown) => Promise<Uint8Array>) | undefined,
    /** Pending printToPDF rejectors — destroy() rejects them like a real killed window. */
    pendingPrintRejects: [] as Array<(e: Error) => void>
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
    loadFile = vi.fn(async (path: string) => {
      await (fake.state.loadFile?.(path) ?? Promise.resolve())
    })
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
import { SECURE_WINDOW_WEB_PREFERENCES } from '../../src/main/window-security'

const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>pack</body></html>'
const PACK_ID = '00000000-0000-4000-8000-00000000e9a1'

let root = ''
let sourceHtmlPath = ''

beforeEach(() => {
  fake.state.windows = []
  fake.state.appListeners = new Map()
  fake.state.loadFile = undefined
  fake.state.printToPDF = undefined
  fake.state.pendingPrintRejects = []
  root = mkdtempSync(join(tmpdir(), 'hilbertraum-printpdf-'))
  sourceHtmlPath = join(root, 'pack.pdf.print.tmp.html')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
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

describe('print flow (hidden window lifecycle)', () => {
  it('writes the source html, loads it, waits for fonts, prints, tears everything down', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // "%PDF-"
    let htmlOnDiskAtLoad = ''
    fake.state.loadFile = async (path) => {
      // The print source must exist ON DISK with the verbatim html BEFORE the load.
      htmlOnDiskAtLoad = readFileSync(path, 'utf8')
    }
    fake.state.printToPDF = async () => pdfBytes

    const result = await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })

    expect(Buffer.compare(result, Buffer.from(pdfBytes))).toBe(0)
    const win = lastWin()
    expect(win.loadFile).toHaveBeenCalledWith(sourceHtmlPath)
    expect(htmlOnDiskAtLoad).toBe(HTML)
    // did-finish-load (the loadFile await) THEN fonts THEN print — D-1 order.
    expect(win.webContents.executeJavaScript).toHaveBeenCalledWith(
      'document.fonts.ready.then(() => true)'
    )
    expect(win.webContents.printToPDF).toHaveBeenCalledWith(
      buildEvidencePackPrintOptions(PACK_ID)
    )
    // Teardown: window destroyed, transient source removed, quit hook detached.
    expect(win.destroyed).toBe(true)
    expect(existsSync(sourceHtmlPath)).toBe(false)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('creates a hidden, sandboxed, preload-FREE window and denies every navigation', async () => {
    await printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
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

  it('a print failure tears down the window AND the source file, then rethrows', async () => {
    fake.state.printToPDF = async () => {
      throw new Error('printToPDF failed')
    }
    await expect(
      printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
    ).rejects.toThrow('printToPDF failed')
    expect(lastWin().destroyed).toBe(true)
    expect(existsSync(sourceHtmlPath)).toBe(false)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a load failure (did-fail-load) cleans up the same way', async () => {
    fake.state.loadFile = async () => {
      throw new Error('ERR_FILE_NOT_FOUND')
    }
    await expect(
      printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
    ).rejects.toThrow('ERR_FILE_NOT_FOUND')
    expect(lastWin().destroyed).toBe(true)
    expect(existsSync(sourceHtmlPath)).toBe(false)
  })

  it('app quit mid-print destroys the hidden window and fails the print (kill-mid-print)', async () => {
    // A print that never settles on its own — only the destroy can end it.
    fake.state.printToPDF = () => new Promise<Uint8Array>(() => {})
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
    // Let the flow reach the pending printToPDF, then quit the app.
    await vi.waitFor(() => {
      expect(lastWin().webContents.printToPDF).toHaveBeenCalled()
    })
    fake.emitApp('before-quit')
    await expect(printing).rejects.toThrow('Object has been destroyed')
    expect(lastWin().destroyed).toBe(true)
    expect(existsSync(sourceHtmlPath)).toBe(false)
    expect(fake.state.appListeners.get('before-quit') ?? []).toHaveLength(0)
  })

  it('a wedged renderer fails the step timeout instead of hanging the export', async () => {
    vi.useFakeTimers()
    fake.state.loadFile = () => new Promise<void>(() => {}) // never finishes loading
    const printing = printEvidencePackHtmlToPdf(HTML, { packId: PACK_ID, sourceHtmlPath })
    const failed = expect(printing).rejects.toThrow(/load step took too long/)
    await vi.advanceTimersByTimeAsync(PRINT_STEP_TIMEOUT_MS + 1)
    await failed
    expect(lastWin().destroyed).toBe(true)
    expect(existsSync(sourceHtmlPath)).toBe(false)
  })
})
