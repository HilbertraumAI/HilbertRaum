import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { OCR_RASTER } from '../../../shared/ipc'
import { log } from '../logging'

// PDF → page-PNG rasterizer: rendering a PDF page
// to pixels needs a canvas, the main process has none, node-canvas
// is a native dep (avoided by policy), and Electron's utilityProcess has NO
// OffscreenCanvas (probed). So a HIDDEN BrowserWindow does exactly this one job:
// open the PDF with the pinned pdfjs, render one page at a time on request, return
// PNG bytes. Recognition stays main-side; the window is created per task and
// destroyed afterwards (or on cancel).
//
// Pull-based backpressure: the next page is only requested after the caller's
// `onPage` (the recognition of the previous page) has finished — a 500-page scan
// never queues 500 page images in memory.

export interface RasterizePdfOptions {
  /** Called once, as soon as the page count is known. */
  onPageCount?: (pageCount: number) => void
  /**
   * Called per page, in order. The NEXT page is not rendered until the returned
   * promise resolves (backpressure). A throw aborts the run.
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

  const win = new BrowserWindow({
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

  // Collect replies addressed from OUR window only (defence in depth — the channels
  // are not exposed on the main window's bridge at all).
  type Waiter = { resolve: (msg: Record<string, unknown>) => void; reject: (e: Error) => void }
  let waiter: Waiter | null = null
  const expect = (channel: string): Promise<Record<string, unknown>> =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      waiter = {
        resolve: (msg) => resolve(msg),
        reject
      }
      expectChannel = channel
    })
  let expectChannel: string | null = null

  const onMessage =
    (channel: string) =>
    (event: Electron.IpcMainEvent, payload: Record<string, unknown>): void => {
      if (win.isDestroyed() || event.sender !== win.webContents) return
      if (channel === OCR_RASTER.error) {
        const message = typeof payload?.message === 'string' ? payload.message : 'render failed'
        if (waiter) {
          waiter.reject(new Error(message))
          waiter = null
        } else {
          // No request in flight (e.g. the error raced a timeout/abort that already
          // cleared the waiter) — don't drop it silently; the next expect() would
          // otherwise hang to its timeout with no trace of the real cause.
          log.warn('OCR rasterizer error frame arrived with no request in flight', { message })
        }
        return
      }
      if (channel !== expectChannel) return
      const w = waiter
      waiter = null
      w?.resolve(payload ?? {})
    }

  const listeners: Array<[string, ReturnType<typeof onMessage>]> = [
    [OCR_RASTER.opened, onMessage(OCR_RASTER.opened)],
    [OCR_RASTER.page, onMessage(OCR_RASTER.page)],
    [OCR_RASTER.error, onMessage(OCR_RASTER.error)]
  ]
  for (const [ch, fn] of listeners) ipcMain.on(ch, fn)

  const onAbort = (): void => {
    waiter?.reject(abortError())
    waiter = null
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

    const openedP = expect(OCR_RASTER.opened)
    win.webContents.send(OCR_RASTER.open, { pdf: new Uint8Array(pdf) })
    const opened = await withTimeout(openedP)
    const pageCount = Number(opened.pageCount)
    if (!Number.isInteger(pageCount) || pageCount <= 0) {
      throw new Error('The PDF could not be opened for rendering')
    }
    opts.onPageCount?.(pageCount)

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (opts.signal?.aborted) throw abortError()
      const pageP = expect(OCR_RASTER.page)
      win.webContents.send(OCR_RASTER.render, { pageNumber })
      const msg = await withTimeout(pageP)
      const png = msg.png
      if (!(png instanceof Uint8Array)) throw new Error('The rendered page was empty')
      await opts.onPage(pageNumber, Buffer.from(png))
    }
    return { pageCount }
  } finally {
    inUse = false
    opts.signal?.removeEventListener('abort', onAbort)
    for (const [ch, fn] of listeners) ipcMain.removeListener(ch, fn)
    if (!win.isDestroyed()) win.destroy()
  }
}
