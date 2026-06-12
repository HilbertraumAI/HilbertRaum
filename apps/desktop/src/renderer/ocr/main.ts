// Hidden OCR rasterizer window: the ONLY context
// with a canvas, so the only place a PDF page can become pixels without native deps.
// Protocol (shared/ipc.ts OCR_RASTER, pull-based): main sends the PDF bytes, we report
// the page count, then main requests one page at a time and we answer with PNG bytes.
// Recognition itself runs MAIN-side (tesseract.js Node mode) — no tesseract code here.
//
// pdfjs is the SAME pinned package — and the SAME LEGACY build — the main-process
// PdfParser uses, with its bundled worker (a local asset — never a CDN; the page CSP
// enforces same-origin anyway). The legacy build matters: the modern v6 build calls
// Uint8Array.prototype.toHex (an ES proposal Electron 37's Chromium lacks) and fails
// on the very first document open.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/**
 * Target render resolution: 300 DPI equivalent (PDF user units are 72/inch) — the
 * classic OCR sweet spot (probed at confidence 94+). Pages whose 300-DPI
 * raster would exceed MAX_RENDER_PIXELS on a side are scaled down to fit (canvas
 * memory bound: an A4 page at 300 DPI is 2550×3301 ≈ 33 MB RGBA).
 */
const TARGET_DPI = 300
const MAX_RENDER_PIXELS = 4096

declare global {
  interface Window {
    ocrRaster: {
      onOpen(cb: (req: { pdf: Uint8Array }) => void): void
      onRender(cb: (req: { pageNumber: number }) => void): void
      opened(pageCount: number): void
      page(pageNumber: number, png: Uint8Array): void
      error(message: string): void
    }
  }
}

let doc: PDFDocumentProxy | null = null

async function renderPage(pageNumber: number): Promise<Uint8Array> {
  if (!doc) throw new Error('No document is open')
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const targetScale = TARGET_DPI / 72
  const cap = MAX_RENDER_PIXELS / Math.max(base.width, base.height)
  const viewport = page.getViewport({ scale: Math.min(targetScale, cap) })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  // pdfjs v6 takes the canvas itself (it derives the 2D context).
  await page.render({ canvas, viewport }).promise

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

window.ocrRaster.onOpen((req) => {
  void (async () => {
    try {
      // Copy into a SAME-REALM Uint8Array: the bytes arrive through the contextBridge
      // from the preload's isolated world, and pdf.js's instanceof checks reject a
      // cross-realm typed array ("hashOriginal.toHex is not a function").
      const task = pdfjs.getDocument({ data: new Uint8Array(req.pdf) })
      doc = await task.promise
      window.ocrRaster.opened(doc.numPages)
    } catch (e) {
      window.ocrRaster.error(e instanceof Error ? e.message : String(e))
    }
  })()
})

window.ocrRaster.onRender((req) => {
  void (async () => {
    try {
      const png = await renderPage(req.pageNumber)
      window.ocrRaster.page(req.pageNumber, png)
    } catch (e) {
      window.ocrRaster.error(e instanceof Error ? e.message : String(e))
    }
  })()
})
