// Minimal ambient typings for the pdfjs-dist legacy build. pdfjs-dist ships no
// `exports` map, so importing the legacy path does not surface its bundled types;
// we declare just the slices of the API we use: text extraction (the PdfParser, plain
// Node, no worker — validated in Phase 4, BUILD_STATE R3) and page rendering (the
// Phase-38 hidden OCR rasterizer window, which deliberately uses the SAME legacy
// build — one build everywhere; the original motive (the modern build's
// Uint8Array.prototype.toHex, missing from Electron 37's Chromium) expired with
// pdfjs 6.2 + Chromium 142, and stays expired on Chromium 150 / Electron 43 (wave DEP-4)
// — see the DEP-3 and DEP-4 records in docs/architecture.md. Only the
// node program (src/main) resolves this declaration — the web program resolves the
// package's real pdf.d.mts — so `canvas` is structurally typed (no DOM lib here).
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface TextItem {
    str: string
    hasEOL?: boolean
  }
  export interface TextContent {
    items: Array<TextItem | Record<string, unknown>>
  }
  export interface PageViewport {
    readonly width: number
    readonly height: number
  }
  export interface RenderTask {
    readonly promise: Promise<void>
  }
  export interface PDFPageProxy {
    getTextContent(): Promise<TextContent>
    getViewport(params: { scale: number }): PageViewport
    /** `canvas` is an HTMLCanvasElement; typed loosely — no DOM lib in the node program. */
    render(params: { canvas: { width: number; height: number }; viewport: PageViewport }): RenderTask
  }
  export interface PDFDocumentProxy {
    readonly numPages: number
    getPage(pageNumber: number): Promise<PDFPageProxy>
  }
  export interface PDFDocumentLoadingTask {
    readonly promise: Promise<PDFDocumentProxy>
    destroy(): Promise<void>
  }
  export function getDocument(src: {
    data?: Uint8Array
    [key: string]: unknown
  }): PDFDocumentLoadingTask
  export const GlobalWorkerOptions: { workerSrc: string }
}

// The rasterizer page imports the legacy worker as a bundled asset URL (vite `?url`).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs?url' {
  const url: string
  export default url
}
