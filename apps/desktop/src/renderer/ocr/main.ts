// Hidden OCR rasterizer window: the ONLY context
// with a canvas, so the only place a PDF page can become pixels without native deps.
// Protocol (shared/ipc.ts OCR_RASTER, pull-based): main sends the PDF bytes, we report
// the page count, then main requests one page at a time and we answer with PNG bytes.
// Recognition itself runs MAIN-side (tesseract.js Node mode) — no tesseract code here.
//
// pdfjs is the SAME pinned package — and the SAME LEGACY build — the main-process
// PdfParser uses. Its worker code is bundled into this page's chunk and run in-page (below),
// never a CDN. Historical note: the legacy build was originally forced by
// Uint8Array.prototype.toHex (the modern v6 build called it; Electron 37's Chromium 138
// lacked it and the very first document open failed). Chromium 142 (Electron 39) shipped toHex
// and pdfjs 6.2's modern build no longer references it — the legacy build is retained for
// one-build-everywhere consistency with the main-process parser, no longer out of necessity.
// Still true on Chromium 150 (Electron 43, wave DEP-4): the motive stays expired, and moving
// further forward can only keep it that way.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
// Run pdf.js IN THIS PAGE, not in a worker (fix/ocr-pdfjs-in-page). Importing the worker
// module for its side effect sets `globalThis.pdfjsWorker`; pdf.js then uses its in-page
// "fake worker" (PDFWorker #initialize) and starts no Worker. A dedicated `file://` worker
// escapes the renderer CSP entirely — Chromium gives it no policy of its own and the
// session CSP header never reaches it — so parsing untrusted PDF bytes there ran outside
// every network/script control. On the page thread all of pdf.js sits under the page's
// header ∩ meta CSP (measured, security-model.md). We therefore set NO `workerSrc`.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
// pdf.js decodes CCITT fax, JBIG2 and JPEG 2000 images only through modules it loads at run
// time as `${wasmUrl}<file name>`: a wasm build, then a plain-JS build if the wasm fails.
// Without `wasmUrl` such a scan (the usual black-and-white office scan is CCITT G4) rendered
// blank and OCR found no text (#551). The page CSP has no `'wasm-unsafe-eval'` (and must not),
// so we force the JS build — `useWasm: false` below — and ship ONLY the `*_nowasm_fallback.js`
// decoders. `DECODERS_URL` is the directory they sit in; the build keeps their names
// (electron.vite.config.ts); tests/integration/ocr-decoder-assets.test.ts pins both.
import jbig2FallbackUrl from 'pdfjs-dist/wasm/jbig2_nowasm_fallback.js?url'
import 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const DECODERS_URL = new URL('./', new URL(jbig2FallbackUrl, document.baseURI)).href

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
  try {
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
  } finally {
    // BE-7 (ocr-audit 2026-07-18): release the page's pdfjs caches (fonts, operator lists,
    // decoded image data) as soon as it is encoded. Across a long image-heavy scan the hidden
    // renderer otherwise grows until an OOM turns each remaining step into a 60 s timeout stall.
    page.cleanup()
  }
}

window.ocrRaster.onOpen((req) => {
  void (async () => {
    try {
      // Copy into a SAME-REALM Uint8Array: the bytes arrive through the contextBridge
      // from the preload's isolated world, and pdf.js's instanceof checks reject a
      // cross-realm typed array ("hashOriginal.toHex is not a function").
      const task = pdfjs.getDocument({ data: new Uint8Array(req.pdf), wasmUrl: DECODERS_URL, useWasm: false })
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
