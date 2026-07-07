import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain } from 'electron'
import { OCR_RASTER } from '../../../shared/ipc'
import { log } from '../logging'
import { installNavigationGuard } from '../navigation-guard'
import { assertPageWithinByteCap } from './page-cap'
import { pipelinePages } from './pipeline'

// ESM main bundle — `__dirname` doesn't exist; reconstruct from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url))

// PDF → page-PNG rasterizer: rendering a PDF page
// to pixels needs a canvas, the main process has none, node-canvas
// is a native dep (avoided by policy), and Electron's utilityProcess has NO
// OffscreenCanvas (probed). So a HIDDEN BrowserWindow does exactly this one job:
// open the PDF with the pinned pdfjs, render one page at a time on request, return
// PNG bytes. Recognition stays main-side; the window is created per task and
// destroyed afterwards (or on cancel).
//
// Bounded 1-deep look-ahead (ING-5): render (pdfjs in the hidden window) and recognize
// (the caller's `onPage`, e.g. WASM tesseract) are different engines, so page N+1 is
// rendered WHILE page N is recognized — the two pipeline instead of running strictly
// serially. Memory stays bounded: at most one extra page PNG is resident (the just-rendered
// N+1 while N recognizes), so a 500-page scan never queues 500 images. Recognitions stay
// serial and in order (one engine, one in flight), so progress %, ordering, and cancellation
// are unchanged from the old strictly-serial loop. See `pipelinePages`.

export interface RasterizePdfOptions {
  /** Called once, as soon as the page count is known. */
  onPageCount?: (pageCount: number) => void
  /**
   * Called per page, in order, recognitions serialized. The rasterizer renders ONE page
   * ahead while this promise is pending (1-deep look-ahead), but never starts the next
   * `onPage` until this one resolves — so memory holds at most one extra PNG. A throw
   * aborts the run.
   */
  onPage: (pageNumber: number, png: Buffer) => void | Promise<void>
  /** Abort: destroys the hidden window; the promise rejects with AbortError. */
  signal?: AbortSignal
}

/** The rasterizer seam the OCR task uses — fakeable in tests (no Electron). */
export type RasterizePdf = (
  pdf: Buffer,
  opts: RasterizePdfOptions
) => Promise<{ pageCount: number }>

/** Per-page render+open timeout — a wedged renderer must fail the task, not hang it. */
const RASTER_STEP_TIMEOUT_MS = 60_000

function abortError(): DOMException {
  return new DOMException('PDF rasterization aborted', 'AbortError')
}

/**
 * The hidden window's single-slot reply waiter. The rasterize protocol keeps exactly ONE request in
 * flight at a time (open, then page-by-page), so there is normally never a second `expect()` before
 * the prior settles. R6 (full-audit-2026-06-30, Phase C) hardens the slot regardless: a fresh
 * `expect()` while a prior waiter is still unsettled REJECTS the prior ('superseded') instead of
 * silently overwriting it — an overwritten waiter would otherwise orphan and hang to its 60 s
 * `withTimeout` (the symptom a duplicate reply frame or a future refactor could trigger). Extracted
 * from the per-run closure so the supersede guard is unit-testable without Electron.
 */
export class RasterReplySlot {
  private waiter: { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void } | null = null
  private channel: string | null = null

  /** Arm for `channel` and return the reply promise, superseding any still-pending prior waiter (R6). */
  expect(channel: string): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.waiter) this.waiter.reject(new Error('superseded'))
      this.waiter = { resolve, reject }
      this.channel = channel
    })
  }

  /** True iff a reply on `channel` is the one currently awaited (the `expectChannel` gate). */
  awaits(channel: string): boolean {
    return this.channel === channel
  }

  /** Resolve the current waiter with `payload` and clear the slot (no-op if none pending). */
  deliver(payload: Record<string, unknown>): void {
    const w = this.waiter
    this.waiter = null
    w?.resolve(payload)
  }

  /** Reject the current waiter (error frame / abort) and clear it; returns whether one was pending. */
  fail(err: Error): boolean {
    const w = this.waiter
    this.waiter = null
    if (!w) return false
    w.reject(err)
    return true
  }
}

/**
 * Rasterize `pdf` page by page through a hidden window. One run at a time per
 * process (the DocTaskManager serializes tasks anyway; a second concurrent call
 * fails fast rather than crosstalking on the shared channels).
 */
let inUse = false

export async function rasterizePdfWithHiddenWindow(
  pdf: Buffer,
  opts: RasterizePdfOptions
): Promise<{ pageCount: number }> {
  if (inUse) throw new Error('PDF rasterizer is busy')
  if (opts.signal?.aborted) throw abortError()
  inUse = true

  // Window construction can throw (resource exhaustion, mid-quit). Reset the busy
  // flag if it does, or the rasterizer wedges to "busy" for the rest of the session
  // (the `finally` below only runs once we are past this point).
  let win: BrowserWindow
  try {
    win = new BrowserWindow({
      show: false,
      // Never steal focus or appear in any window list UX; it is a worker, not a UI.
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/ocr.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })
  } catch (err) {
    inUse = false
    throw err
  }
  // Untrusted PDF bytes render here — deny any navigation/window-open the page attempts
  // (defence in depth on top of the shared-session CSP), matching the main window. SEC-3
  // (backend-audit-2026-06-27): the guard covers `will-redirect` alongside `will-navigate`
  // (a server/<meta> redirect reaches a remote origin via `will-redirect` without firing
  // `will-navigate`). This worker page only ever loads ocr.html, so ALL navigation is denied.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  installNavigationGuard(win.webContents, () => false)

  // Collect replies addressed from OUR window only (defence in depth — the channels
  // are not exposed on the main window's bridge at all). One request in flight at a time (R6).
  const slot = new RasterReplySlot()

  const onMessage =
    (channel: string) =>
    (event: Electron.IpcMainEvent, payload: Record<string, unknown>): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      if (channel === OCR_RASTER.error) {
        const message = typeof payload?.message === 'string' ? payload.message : 'render failed'
        // No request in flight (e.g. the error raced a timeout/abort that already cleared the
        // waiter) — don't drop it silently; the next expect() would otherwise hang to its timeout
        // with no trace of the real cause.
        if (!slot.fail(new Error(message))) {
          log.warn('OCR rasterizer error frame arrived with no request in flight', { message })
        }
        return
      }
      if (!slot.awaits(channel)) return
      slot.deliver(payload ?? {})
    }

  const listeners: Array<[string, ReturnType<typeof onMessage>]> = [
    [OCR_RASTER.opened, onMessage(OCR_RASTER.opened)],
    [OCR_RASTER.page, onMessage(OCR_RASTER.page)],
    [OCR_RASTER.error, onMessage(OCR_RASTER.error)]
  ]
  for (const [ch, fn] of listeners) ipcMain.on(ch, fn)

  const onAbort = (): void => {
    slot.fail(abortError())
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const withTimeout = async (p: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The page took too long to render')),
            RASTER_STEP_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    // Load the window's page: dev server in dev, the bundled file in prod (the main
    // window's exact pattern).
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      await win.loadURL(`${devUrl}/ocr.html`)
    } else {
      await win.loadFile(join(__dirname, '../renderer/ocr.html'))
    }
    if (opts.signal?.aborted) throw abortError()

    const openedP = slot.expect(OCR_RASTER.opened)
    win.webContents.send(OCR_RASTER.open, { pdf: new Uint8Array(pdf) })
    const opened = await withTimeout(openedP)
    const pageCount = Number(opened.pageCount)
    if (!Number.isInteger(pageCount) || pageCount <= 0) {
      throw new Error('The PDF could not be opened for rendering')
    }
    opts.onPageCount?.(pageCount)

    // ING-5: render page N+1 while page N recognizes (1-deep look-ahead). The render itself
    // stays sequential on the shared channel (one `expect`/`send` in flight); only render and
    // recognize — different engines — overlap. See `pipelinePages`.
    await pipelinePages(
      pageCount,
      async (pageNumber) => {
        const pageP = slot.expect(OCR_RASTER.page)
        win.webContents.send(OCR_RASTER.render, { pageNumber })
        const msg = await withTimeout(pageP)
        const png = msg.png
        if (!(png instanceof Uint8Array)) throw new Error('The rendered page was empty')
        // REL-4: reject an over-cap page before it is handed to recognition or held resident
        // behind the 1-deep look-ahead.
        assertPageWithinByteCap(png)
        return Buffer.from(png)
      },
      opts.onPage,
      { signal: opts.signal, abortError }
    )
    return { pageCount }
  } finally {
    inUse = false
    opts.signal?.removeEventListener('abort', onAbort)
    for (const [ch, fn] of listeners) ipcMain.removeListener(ch, fn)
    if (!win.isDestroyed()) win.destroy()
  }
}
