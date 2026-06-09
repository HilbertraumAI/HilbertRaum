// Minimal ambient typings for the pdfjs-dist legacy build. pdfjs-dist ships no
// `exports` map, so importing the legacy path does not surface its bundled types;
// we declare just the slice of the API the PdfParser uses. The legacy build runs in
// plain Node with no worker — validated in Phase 4 (BUILD_STATE R3).
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface TextItem {
    str: string
    hasEOL?: boolean
  }
  export interface TextContent {
    items: Array<TextItem | Record<string, unknown>>
  }
  export interface PDFPageProxy {
    getTextContent(): Promise<TextContent>
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
