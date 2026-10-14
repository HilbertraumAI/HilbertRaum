// The OCR fakes for the OCR suites: a recognizer, the hidden-window rasterizer, scan imports through the real
// pipeline, a temp drive with language files. Pure: no electron import (the rasterizer type is a type-only import).
// Every temp root comes from `tempRoot` (the swept prefix).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { createQueuedDocument, processDocument, type IngestionDeps } from '../../src/main/services/ingestion'
import { PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import type { OcrAvailability, OcrEngine } from '../../src/main/services/ocr'
import type { RasterizePdf } from '../../src/main/services/ocr/rasterizer'
import { tempRoot } from './db-fixtures'
import type { DocTaskWorld } from './doctask-fixtures'
import { makeScanOnlyPdf } from './fixtures'

export interface FakeOcrEngineOptions {
  /** Recognized text; a function gets the page number — the image's first byte, as `fakeRasterizer` encodes it. Default ''. */
  text?: string | ((page: number) => string)
  /** Default 90. */
  confidence?: number
  /** Default ['deu', 'eng']. */
  languages?: readonly string[]
  /** Default 'fake-tesseract'. */
  id?: string
  /** The starting `availability()`. Default 'available' (a dev engine). */
  state?: OcrAvailability
  /** What `probe()` proves, like the real engine (#232): true (default) settles 'available', false 'unavailable'. */
  probeOk?: boolean
}

export interface FakeOcrEngine extends OcrEngine {
  /** `recognize()` calls so far. */
  calls: number
  availability: () => OcrAvailability
  probe: Mock<() => Promise<boolean>>
  stop: Mock<() => Promise<void>>
  suspend: Mock<() => Promise<void>>
}

/** A fake recognizer that counts its readings; its probe settles `availability()` the way the real one does. */
export function fakeOcrEngine(o: FakeOcrEngineOptions = {}): FakeOcrEngine {
  let state: OcrAvailability = o.state ?? 'available'
  const engine: FakeOcrEngine = {
    id: o.id ?? 'fake-tesseract',
    languages: [...(o.languages ?? ['deu', 'eng'])],
    calls: 0,
    recognize: async (image) => {
      engine.calls += 1
      const text = typeof o.text === 'function' ? o.text(image[0]) : (o.text ?? '')
      return { text, confidence: o.confidence ?? 90 }
    },
    availability: () => state,
    probe: vi.fn(async () => {
      const ok = o.probeOk !== false
      state = ok ? 'available' : 'unavailable'
      return ok
    }),
    stop: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined)
  }
  return engine
}

export interface FakeRasterizerOptions {
  /** The document's page count (default 2). The walk is `RasterizePdfOptions.pages` when given (#575), else 1..pages. */
  pages?: number
  /** Awaited before each page's `onPage` (a gate the test releases). */
  gate?: () => Promise<void>
  /** Records every page walked, in order (pushed before the abort check). */
  walked?: number[]
  /** Records every PDF the rasterizer is handed (the decrypted bytes for an encrypted store). */
  pdfs?: Buffer[]
}

/** A fake hidden-window rasterizer: each "PNG" is `Buffer.from([page])`; reports `onPageCount(walk.length)`, honours `pages`
 *  (#575) and the abort signal before each page like the real one; resolves `{ pageCount: pages }`. */
export function fakeRasterizer(o: FakeRasterizerOptions = {}): RasterizePdf {
  const pages = o.pages ?? 2
  return async (pdf, r) => {
    o.pdfs?.push(pdf)
    const walk = r.pages ? [...r.pages] : Array.from({ length: pages }, (_, i) => i + 1)
    r.onPageCount?.(walk.length)
    for (const n of walk) {
      o.walked?.push(n)
      if (r.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      await o.gate?.()
      await r.onPage(n, Buffer.from([n]))
    }
    return { pageCount: pages }
  }
}

export interface ImportScanOptions {
  /** Page count (default 2). */
  pages?: number
  /** The source file name under the root (default `scan.pdf`, or `scan-<pages>.pdf` for any other count). */
  name?: string
  /** Ingestion deps for the import (default none). */
  deps?: IngestionDeps
}

/** Import an N-page image-only PDF through the real pipeline; asserts it ends `failed` with `PDF_SCAN_DETECTED_MESSAGE`
 *  and `scanDetected` (step 0). Returns the id. */
export async function importScan(w: DocTaskWorld, o: ImportScanOptions = {}): Promise<string> {
  const pages = o.pages ?? 2
  const p = join(w.root, o.name ?? (pages === 2 ? 'scan.pdf' : `scan-${pages}.pdf`))
  writeFileSync(p, makeScanOnlyPdf(pages))
  const info = createQueuedDocument(w.db, p)
  const done = await processDocument(w.db, w.storeDir, info.id, o.deps ?? {})
  expect(done.status).toBe('failed')
  expect(done.errorMessage).toBe(PDF_SCAN_DETECTED_MESSAGE)
  expect(done.scanDetected).toBe(true)
  return info.id
}

/** A temp drive root whose `ocr/` holds `<lang>.traineddata.gz` (content `<lang>-bytes`) per language; no `ocr/` at all
 *  without languages. */
export function ocrDrive(langs: readonly string[] = []): string {
  const root = tempRoot('ocr-drive')
  if (langs.length > 0) {
    mkdirSync(join(root, 'ocr'), { recursive: true })
    for (const lang of langs) writeFileSync(join(root, 'ocr', `${lang}.traineddata.gz`), `${lang}-bytes`)
  }
  return root
}
