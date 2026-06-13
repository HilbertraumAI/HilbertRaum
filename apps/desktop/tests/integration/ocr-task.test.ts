import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  extractDocumentPreview,
  getDocument,
  getDocumentOcrPages,
  processDocument,
  reindexDocument
} from '../../src/main/services/ingestion'
import {
  DocTaskManager,
  TASK_NEEDS_OCR_MESSAGE,
  TASK_OCR_NOT_A_SCAN_MESSAGE,
  TASK_OCR_NO_TEXT_MESSAGE,
  TASK_REFUSED_CHAT_STREAMING_MESSAGE
} from '../../src/main/services/doctasks'
import type { OcrEngine } from '../../src/main/services/ocr'
import type { RasterizePdf } from '../../src/main/services/ocr/rasterizer'
import { createMockEmbedder } from '../../src/main/services/embeddings'
import { retrieve } from '../../src/main/services/rag'
import { recordEvent, listAuditEvents } from '../../src/main/services/audit'
import type { AuditEventType } from '../../src/shared/types'
import { makeScanOnlyPdf, TINY_PNG } from '../helpers/fixtures'
import { PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import { IMAGE_NEEDS_OCR_MESSAGE } from '../../src/main/services/ingestion/parsers/image'

// Phase 38 — the OCR document task end to end on the CI posture (zero network, zero
// models, zero Electron): a FAKE engine + FAKE rasterizer behind the same seams the
// app injects (the embedder/transcriber precedent). Covers: scan detection on import,
// "Make searchable" → recognition → persisted ocr_json → re-ingest with per-page
// chunks → page citations via the REAL retrieval path, preview from stored pages,
// re-index reuse (no re-OCR), cancel-persists-nothing, and the D26 guards.

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-ocr-task-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

/** Import a 2-page image-only PDF → failed with the scan notice (step 0). */
async function importScan(): Promise<string> {
  const p = join(tmp, 'scan.pdf')
  writeFileSync(p, makeScanOnlyPdf(2))
  const info = createQueuedDocument(db, p)
  const done = await processDocument(db, storeDir, info.id)
  expect(done.status).toBe('failed')
  expect(done.errorMessage).toBe(PDF_SCAN_DETECTED_MESSAGE)
  expect(done.scanDetected).toBe(true)
  return info.id
}

function fakeEngine(textForPage: (n: number) => string): OcrEngine & { calls: number } {
  const engine = {
    id: 'fake-tesseract',
    languages: ['deu', 'eng'],
    calls: 0,
    recognize: async (image: Buffer) => {
      engine.calls += 1
      // The fake rasterizer encodes the page number as the buffer's first byte.
      return { text: textForPage(image[0]), confidence: 90 }
    }
  }
  return engine
}

/** A fake rasterizer: N pages, each "PNG" = Buffer([pageNumber]). */
function fakeRasterizer(pages = 2, opts: { gate?: () => Promise<void> } = {}): RasterizePdf {
  return async (_pdf, o) => {
    o.onPageCount?.(pages)
    for (let n = 1; n <= pages; n++) {
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      await opts.gate?.()
      await o.onPage(n, Buffer.from([n]))
    }
    return { pageCount: pages }
  }
}

interface ManagerOpts {
  engine?: OcrEngine | null
  rasterize?: RasterizePdf
  chatStreaming?: boolean
  audit?: boolean
}

function makeManager(opts: ManagerOpts = {}): DocTaskManager {
  return new DocTaskManager({
    getDb: () => db,
    getRuntime: () => null, // OCR must not need the chat runtime
    isChatStreaming: () => opts.chatStreaming ?? false,
    getContextTokens: () => 4096,
    getStoreDir: () => storeDir,
    getIngestionDeps: () => ({ embedder: createMockEmbedder() }),
    beginDocumentWork: () => () => {},
    getOcrEngine: () => (opts.engine === undefined ? null : opts.engine),
    rasterizePdf: opts.rasterize,
    audit: opts.audit
      ? (type, message, metadata) => recordEvent(db, type as AuditEventType, message, metadata)
      : undefined
  })
}

async function waitTerminal(manager: DocTaskManager, jobId: string) {
  const start = Date.now()
  for (;;) {
    const status = manager.getDocTask(jobId)
    if (['done', 'failed', 'cancelled'].includes(status.state)) return status
    if (Date.now() - start > 10_000) throw new Error(`task never finished: ${status.state}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('Make searchable (OCR) end to end', () => {
  it('recognizes pages, persists ocr_json, re-ingests with page numbers, audits ids-only', async () => {
    const docId = await importScan()
    const engine = fakeEngine((n) =>
      n === 1
        ? 'Erste Seite über Auftragsbestätigung und Lieferung.'
        : 'Zweite Seite über Rechnungen und Zahlungen.'
    )
    const manager = makeManager({ engine, rasterize: fakeRasterizer(2), audit: true })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef?.documentId).toBe(docId)
    // pages + the final re-ingest step
    expect(status.progress).toEqual({ stepsDone: 3, stepsTotal: 3 })

    const doc = getDocument(db, docId)
    expect(doc?.status).toBe('indexed')
    expect(doc?.scanDetected).toBe(false)
    expect(doc?.ocr?.pageCount).toBe(2)
    expect(doc?.ocr?.languages).toEqual(['deu', 'eng'])
    expect(doc?.chunkCount).toBeGreaterThan(0)

    // Per-page chunks → page numbers preserved.
    const rows = db
      .prepare('SELECT text, page_number FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(docId) as Array<{ text: string; page_number: number | null }>
    expect(rows.map((r) => r.page_number)).toEqual([1, 2])

    // The audit trail carries ids/kinds only — never recognized text.
    const events = listAuditEvents(db, { limit: 50 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed).toBeDefined()
    const blob = JSON.stringify(events)
    expect(blob).not.toContain('Auftragsbestätigung')
    expect(blob).not.toContain('Rechnungen')
  })

  it('page citations work end to end through the real retrieval path', async () => {
    const docId = await importScan()
    const engine = fakeEngine((n) =>
      n === 1 ? 'The kangaroo protocol handles marsupial logistics.' : 'Unrelated second page.'
    )
    const manager = makeManager({ engine, rasterize: fakeRasterizer(2) })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')

    const embedder = createMockEmbedder()
    const { chunks } = await retrieve(db, embedder, 'kangaroo protocol marsupial', {
      topKInitial: 4,
      topKFinal: 2,
      maxContextTokens: 500,
      minSimilarity: 0
    })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].pageNumber).toBe(1)
  })

  it('preview shows the recognized per-page text and re-index reuses it (no re-OCR)', async () => {
    const docId = await importScan()
    const engine = fakeEngine((n) => `Seite ${n} erkannt.`)
    const manager = makeManager({ engine, rasterize: fakeRasterizer(2) })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')
    const callsAfterTask = engine.calls
    expect(callsAfterTask).toBe(2)

    const preview = await extractDocumentPreview(db, storeDir, docId, {})
    expect(preview.segments.map((s) => s.pageNumber)).toEqual([1, 2])
    expect(preview.segments[0].text).toBe('Seite 1 erkannt.')

    // Re-index: parses the stored PDF again, finds no text, uses the STORED pages.
    const re = await reindexDocument(db, storeDir, docId, { embedder: createMockEmbedder() })
    expect(re.status).toBe('indexed')
    expect(engine.calls).toBe(callsAfterTask) // never re-recognized
    expect(getDocumentOcrPages(db, docId)?.length).toBe(2)
  })

  it('cancel persists nothing — the document stays a detected scan', async () => {
    const docId = await importScan()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const engine = fakeEngine(() => 'never persisted')
    const manager = makeManager({
      engine,
      rasterize: fakeRasterizer(2, { gate: () => gate })
    })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    await new Promise((r) => setTimeout(r, 30))
    manager.cancelDocTask(jobId)
    release()
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(getDocumentOcrPages(db, docId)).toBeNull()
    expect(getDocument(db, docId)?.scanDetected).toBe(true)
  })

  it('fails friendly when every recognized page is empty', async () => {
    const docId = await importScan()
    const manager = makeManager({ engine: fakeEngine(() => '   '), rasterize: fakeRasterizer(2) })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_OCR_NO_TEXT_MESSAGE)
    expect(getDocumentOcrPages(db, docId)).toBeNull()
  })

  it('guards: no engine, not a scan, chat streaming', async () => {
    const docId = await importScan()
    // No engine (no OCR files on the drive).
    expect(() => makeManager({}).startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      TASK_NEEDS_OCR_MESSAGE
    )
    // Not a scan: a plain text document refuses.
    const p = join(tmp, 'plain.txt')
    writeFileSync(p, 'just text '.repeat(50))
    const info = createQueuedDocument(db, p)
    await processDocument(db, storeDir, info.id)
    const manager = makeManager({ engine: fakeEngine(() => 'x'), rasterize: fakeRasterizer(1) })
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [info.id] })).toThrow(
      TASK_OCR_NOT_A_SCAN_MESSAGE
    )
    // The D26 chat guard holds for OCR too.
    const busy = makeManager({
      engine: fakeEngine(() => 'x'),
      rasterize: fakeRasterizer(1),
      chatStreaming: true
    })
    expect(() => busy.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      TASK_REFUSED_CHAT_STREAMING_MESSAGE
    )
  })

  it('re-running OCR on an already-recognized PDF is allowed and overwrites', async () => {
    const docId = await importScan()
    const first = makeManager({ engine: fakeEngine(() => 'Alte Erkennung.'), rasterize: fakeRasterizer(2) })
    const r1 = first.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(first, r1.jobId)).state).toBe('done')

    const second = makeManager({ engine: fakeEngine(() => 'Neue Erkennung.'), rasterize: fakeRasterizer(2) })
    const r2 = second.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(second, r2.jobId)).state).toBe('done')
    expect(getDocumentOcrPages(db, docId)?.[0].text).toBe('Neue Erkennung.')
  })
})

describe('photo import through the real pipeline', () => {
  it('indexes a photo via the injected engine; fails friendly without one', async () => {
    const p = join(tmp, 'note.png')
    writeFileSync(p, TINY_PNG)
    const engine = fakeEngine(() => 'Handwritten note about quarterly numbers.')
    const withEngine = createQueuedDocument(db, p)
    const done = await processDocument(db, storeDir, withEngine.id, {
      embedder: createMockEmbedder(),
      ocrEngine: engine
    })
    expect(done.status).toBe('indexed')
    expect(done.chunkCount).toBe(1)
    expect(done.mimeType).toBe('image/png')

    const without = createQueuedDocument(db, p)
    const failed = await processDocument(db, storeDir, without.id, {
      embedder: createMockEmbedder()
    })
    expect(failed.status).toBe('failed')
    expect(failed.errorMessage).toBe(IMAGE_NEEDS_OCR_MESSAGE)
    expect(failed.scanDetected).toBe(false) // the OCR offer is PDF-only
  })
})
