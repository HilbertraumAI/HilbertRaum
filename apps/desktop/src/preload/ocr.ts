import { contextBridge, ipcRenderer } from 'electron'

// Preload for the HIDDEN OCR rasterizer window. Deliberately tiny and separate from
// the main bridge: this window renders PDF pages to PNG bytes and nothing else — it
// gets exactly the five rasterizer channels, none of the app API. Never expose this
// bridge to the app window.
//
// The channel names are LITERALS, not an import of shared/ipc: a SANDBOXED preload
// must be a single file, and any shared import makes the multi-entry preload build
// split a common chunk the sandbox cannot `require`. A unit test asserts these stay
// identical to `OCR_RASTER` in shared/ipc.ts.
const OCR_RASTER = {
  open: 'ocr-raster:open',
  opened: 'ocr-raster:opened',
  render: 'ocr-raster:render',
  page: 'ocr-raster:page',
  error: 'ocr-raster:error'
} as const

export interface OcrOpenRequest {
  pdf: Uint8Array
}

export interface OcrRenderRequest {
  pageNumber: number
}

const ocrRaster = {
  onOpen: (cb: (req: OcrOpenRequest) => void): void => {
    ipcRenderer.on(OCR_RASTER.open, (_e, req: OcrOpenRequest) => cb(req))
  },
  onRender: (cb: (req: OcrRenderRequest) => void): void => {
    ipcRenderer.on(OCR_RASTER.render, (_e, req: OcrRenderRequest) => cb(req))
  },
  opened: (pageCount: number): void => {
    ipcRenderer.send(OCR_RASTER.opened, { pageCount })
  },
  page: (pageNumber: number, png: Uint8Array): void => {
    ipcRenderer.send(OCR_RASTER.page, { pageNumber, png })
  },
  error: (message: string): void => {
    ipcRenderer.send(OCR_RASTER.error, { message })
  }
}

export type OcrRasterBridge = typeof ocrRaster

contextBridge.exposeInMainWorld('ocrRaster', ocrRaster)
