import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createQueuedDocument,
  ENCRYPTED_DOC_SUFFIX,
  extractDocumentPreview,
  getDocument,
  getDocumentOcrPages,
  processDocument,
  reindexDocument
} from '../../src/main/services/ingestion'
import {
  TASK_DOCUMENT_BUSY_INGESTING_MESSAGE,
  TASK_NEEDS_OCR_MESSAGE,
  TASK_OCR_NOT_A_SCAN_MESSAGE,
  TASK_OCR_NO_TEXT_MESSAGE,
  TASK_REFUSED_CHAT_STREAMING_MESSAGE,
  TASK_SOURCE_UNREADABLE_MESSAGE,
  type DocTaskDeps,
  type DocTaskManager
} from '../../src/main/services/doctasks'
import type { OcrEngine } from '../../src/main/services/ocr'
import type { RasterizePdf } from '../../src/main/services/ocr/rasterizer'
import { pagesToWalk, pipelinePages } from '../../src/main/services/ocr/pipeline'
import { createPlaintextOps, type PlaintextOpsRegistry } from '../../src/main/services/ingestion/plaintext-ops'
import { createMockEmbedder } from '../../src/main/services/embeddings'
import { retrieve } from '../../src/main/services/rag'
import { listAuditEvents } from '../../src/main/services/audit'
import { log } from '../../src/main/services/logging'
import { shredStalePlaintext, vaultPathsFrom, type DocumentCipher } from '../../src/main/services/workspace-vault'
import { t } from '../../src/shared/i18n'
import { matchesSmartView } from '../../src/shared/types'
import { makeMixedPdf, makePdf, TINY_PNG } from '../helpers/fixtures'
import { until } from '../helpers/hang-budget'
import {
  dbAudit,
  docTaskManager,
  docTaskRuntime,
  docTaskWorld,
  waitTerminal,
  type DocTaskWorld
} from '../helpers/doctask-fixtures'
import { fakeOcrEngine, fakeRasterizer, importScan } from '../helpers/ocr-fixtures'
import { recordingCipher, testCipher } from '../helpers/test-cipher'
import {
  IMAGE_NEEDS_OCR_MESSAGE,
  IMAGE_OCR_UNAVAILABLE_MESSAGE
} from '../../src/main/services/ingestion/parsers/image'

// Phase 38 — the OCR document task end to end on the CI posture (zero network, zero
// models, zero Electron): a FAKE engine + FAKE rasterizer behind the same seams the
// app injects (the embedder/transcriber precedent). Covers: scan detection on import,
// "Make searchable" → recognition → persisted ocr_json → re-ingest with per-page
// chunks → page citations via the REAL retrieval path, preview from stored pages,
// re-index reuse (no re-OCR), the encrypted stored copy, cancel-persists-nothing, and
// the D26 guards.

let w: DocTaskWorld

beforeEach(() => {
  w = docTaskWorld('ocr-task')
})

/** The OCR task's manager: the mock embedder for the re-ingest, the engine and rasterizer seams. */
function ocrManager(
  engine: OcrEngine | null,
  rasterizePdf?: RasterizePdf,
  extra: Partial<DocTaskDeps> = {}
): DocTaskManager {
  return docTaskManager(w, {
    getIngestionDeps: () => ({ embedder: createMockEmbedder() }),
    getOcrEngine: () => engine,
    ...(rasterizePdf ? { rasterizePdf } : {}),
    ...extra
  })
}

describe('Make searchable (OCR) end to end', () => {
  it('recognizes pages, persists ocr_json, re-ingests with page numbers, audits ids-only', async () => {
    const docId = await importScan(w)
    const engine = fakeOcrEngine({
      text: (n) =>
        n === 1
          ? 'Erste Seite über Auftragsbestätigung und Lieferung.'
          : 'Zweite Seite über Rechnungen und Zahlungen.'
    })
    const manager = ocrManager(engine, fakeRasterizer(), { audit: dbAudit(w.db) })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(status.resultRef?.documentId).toBe(docId)
    // pages + the final re-ingest step
    expect(status.progress).toEqual({ stepsDone: 3, stepsTotal: 3 })

    const doc = getDocument(w.db, docId)
    expect(doc?.status).toBe('indexed')
    expect(doc?.scanDetected).toBe(false)
    expect(doc?.ocr?.pageCount).toBe(2)
    expect(doc?.ocr?.languages).toEqual(['deu', 'eng'])
    expect(doc?.chunkCount).toBeGreaterThan(0)

    // Per-page chunks → page numbers preserved.
    const rows = w.db
      .prepare('SELECT text, page_number FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(docId) as Array<{ text: string; page_number: number | null }>
    expect(rows.map((r) => r.page_number)).toEqual([1, 2])

    // The audit trail carries ids/kinds only — never recognized text.
    const events = listAuditEvents(w.db, { limit: 50 })
    const completed = events.find((e) => e.type === 'document_task_completed')
    expect(completed).toBeDefined()
    const blob = JSON.stringify(events)
    expect(blob).not.toContain('Auftragsbestätigung')
    expect(blob).not.toContain('Rechnungen')
  })

  it('page citations work end to end through the real retrieval path', async () => {
    const docId = await importScan(w)
    const engine = fakeOcrEngine({
      text: (n) => (n === 1 ? 'The kangaroo protocol handles marsupial logistics.' : 'Unrelated second page.')
    })
    const manager = ocrManager(engine, fakeRasterizer())
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')

    const embedder = createMockEmbedder()
    const { chunks } = await retrieve(w.db, embedder, 'kangaroo protocol marsupial', {
      topKInitial: 4,
      topKFinal: 2,
      maxContextTokens: 500,
      minSimilarity: 0
    })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].pageNumber).toBe(1)
  })

  it('preview shows the recognized per-page text and re-index reuses it (no re-OCR)', async () => {
    const docId = await importScan(w)
    const engine = fakeOcrEngine({ text: (n) => `Seite ${n} erkannt.` })
    const manager = ocrManager(engine, fakeRasterizer())
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')
    const callsAfterTask = engine.calls
    expect(callsAfterTask).toBe(2)

    const preview = await extractDocumentPreview(w.db, w.storeDir, docId, {})
    expect(preview.segments.map((s) => s.pageNumber)).toEqual([1, 2])
    expect(preview.segments[0].text).toBe('Seite 1 erkannt.')

    // Re-index: parses the stored PDF again, finds no text, uses the STORED pages.
    const re = await reindexDocument(w.db, w.storeDir, docId, { embedder: createMockEmbedder() })
    expect(re.status).toBe('indexed')
    expect(engine.calls).toBe(callsAfterTask) // never re-recognized
    expect(getDocumentOcrPages(w.db, docId)?.length).toBe(2)
  })

  // Audit test-gap #5: the handler decrypts an encrypted scan to a transient beside the store and relies on
  // the startup crash sweep to shred it if a crash lands before its own shred.
  it('reads an ENCRYPTED stored scan through a transient the crash sweep covers, and shreds it after the read (audit test-gap #5)', async () => {
    const rec = recordingCipher()
    const docId = await importScan(w, { deps: { cipher: rec.cipher } }) // the stored copy is `<id>.pdf.enc`
    const pdfs: Buffer[] = []
    const manager = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n} erkannt.` }), fakeRasterizer({ pdfs }), {
      getIngestionDeps: () => ({ embedder: createMockEmbedder(), cipher: rec.cipher })
    })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')
    // Real AES: the rasterizer got the decrypted PDF, not the ciphertext.
    expect(pdfs[0].subarray(0, 5).toString('latin1')).toBe('%PDF-')
    // The handler's decrypt comes first (the import parsed the source; the re-ingest's own parse
    // transient follows), inside the store…
    const [transient] = rec.asyncDecrypts
    expect(dirname(transient)).toBe(w.storeDir)
    // …and is shredded after the read: only the encrypted copy is left.
    expect(existsSync(transient)).toBe(false)
    expect(readdirSync(w.storeDir)).toEqual([`${docId}.pdf${ENCRYPTED_DOC_SUFFIX}`])
    // A crash before that shred: the startup sweep must find the file at the very path the handler writes.
    writeFileSync(transient, 'plaintext page bytes')
    shredStalePlaintext(
      vaultPathsFrom({ configPath: join(w.root, 'config'), dbPath: join(dirname(w.storeDir), 'hilbertraum.sqlite') })
    )
    expect(existsSync(transient)).toBe(false)
  })

  // #687: an encrypted stored copy with no cipher in the deps (no unlocked vault behind the task) is refused before
  // anything is decrypted — no plaintext operation is registered, nothing is rendered or recognized, no transient lands.
  it('an encrypted stored scan with no cipher fails sourceUnreadable before any decrypt — no plaintext op, no transient (#687)', async () => {
    const docId = await importScan(w, { deps: { cipher: testCipher() } }) // the stored copy is `<id>.pdf.enc`
    const ops = createPlaintextOps()
    const kinds: string[] = []
    // Every registry member named (the lock-admission-race idiom): one added later is a compile error here.
    const recording: PlaintextOpsRegistry = {
      register: (kind, parent) => {
        kinds.push(kind)
        return ops.register(kind, parent)
      },
      size: () => ops.size(),
      abortAll: () => ops.abortAll(),
      awaitSettled: (ms) => ops.awaitSettled(ms),
      sweepRegistered: () => ops.sweepRegistered()
    }
    const pdfs: Buffer[] = []
    const engine = fakeOcrEngine({ text: 'never read' })
    const manager = ocrManager(engine, fakeRasterizer({ pdfs }), {
      getIngestionDeps: () => ({ embedder: createMockEmbedder(), plaintextOps: recording })
    })
    const status = await waitTerminal(manager, manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_SOURCE_UNREADABLE_MESSAGE)
    expect(kinds).toEqual([])
    expect(pdfs).toEqual([])
    expect(engine.calls).toBe(0)
    expect(readdirSync(w.storeDir)).toEqual([`${docId}.pdf${ENCRYPTED_DOC_SUFFIX}`])
  })

  // #237 / #687: the decrypted transient is registered with the plaintext-op registry for as long as it exists, so a
  // lock or quit that outlasts the doc-task settle shreds it under the still-running task; the task then finds its
  // transient gone and fails calmly, and its registration is released.
  it('#237: a lock sweep during the decrypt shreds the registered transient; the task fails sourceUnreadable and releases (#687)', async () => {
    const base = testCipher()
    const docId = await importScan(w, { deps: { cipher: base } })
    const ops = createPlaintextOps()
    let parked = false
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // The first decrypt (the handler's own) writes its transient, then parks with it on disk.
    const cipher: DocumentCipher = {
      ...base,
      decryptFileAsync: async (src, dest) => {
        await base.decryptFileAsync(src, dest)
        if (parked) return
        parked = true
        await gate
      }
    }
    const pdfs: Buffer[] = []
    const engine = fakeOcrEngine({ text: 'never read' })
    const manager = ocrManager(engine, fakeRasterizer({ pdfs }), {
      getIngestionDeps: () => ({ embedder: createMockEmbedder(), cipher, plaintextOps: ops })
    })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    await until(() => parked, 'the decrypt parking with its transient on disk')
    const transients = readdirSync(w.storeDir).filter((n) => n.includes('.parse'))
    expect(transients).toHaveLength(1)
    expect(ops.size()).toBe(1)
    // The lock/quit sweep (registered paths only) removes the plaintext under the parked task…
    expect(ops.sweepRegistered()).toBe(1)
    expect(existsSync(join(w.storeDir, transients[0]))).toBe(false)
    release()
    // …which then cannot read it: a calm failure, never a render of stale bytes, and the operation is released.
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_SOURCE_UNREADABLE_MESSAGE)
    expect(ops.size()).toBe(0)
    expect(pdfs).toEqual([])
    expect(engine.calls).toBe(0)
  })

  it('cancel persists nothing — the document stays a detected scan', async () => {
    const docId = await importScan(w)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    // Flag set the moment the OCR task PARKS in the rasterizer (genuinely mid-flight) — lets the
    // cancel land deterministically once the task is running, instead of a fixed `sleep(30)` that
    // could cancel before the task even started under CPU starvation (T5).
    let rasterizeReached = false
    const engine = fakeOcrEngine({ text: 'never persisted' })
    const manager = ocrManager(
      engine,
      fakeRasterizer({
        gate: () => {
          rasterizeReached = true
          return gate
        }
      })
    )
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    await until(() => rasterizeReached, 'the OCR task parking in the rasterizer')
    manager.cancelDocTask(jobId)
    release()
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    // The walk stopped at the cancel: page 2 is never read. Page 1, released after the cancel, may be (the row below
    // owns the pre-persist check).
    expect(engine.calls).toBeLessThan(2)
    expect(getDocumentOcrPages(w.db, docId)).toBeNull()
    expect(getDocument(w.db, docId)?.scanDetected).toBe(true)
  })

  // GAP-7 (full-audit 2026-07-11) — the decided cancel contract, both halves:
  //   before the persist point → a calm cancel that persists NOTHING;
  //   after it (during the signal-less re-ingest) → the task completes as 'done' (the work is real).
  it("GAP-7: a cancel after the LAST page but before the persist still cancels — nothing persisted", async () => {
    const docId = await importScan(w)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let recognitionDone = false
    const engine = fakeOcrEngine({ text: 'never persisted' })
    // A rasterizer that parks AFTER the last onPage — the cancel lands in the recognition→persist
    // window, exactly where the pre-persist abort check must catch it.
    const rasterize: RasterizePdf = async (_pdf, o) => {
      o.onPageCount?.(2)
      for (let n = 1; n <= 2; n++) await o.onPage(n, Buffer.from([n]))
      recognitionDone = true
      await gate
      return { pageCount: 2 }
    }
    const manager = ocrManager(engine, rasterize)
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    await until(() => recognitionDone, 'the last page recognized')
    manager.cancelDocTask(jobId)
    release()
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('cancelled')
    expect(getDocumentOcrPages(w.db, docId)).toBeNull() // nothing persisted
    expect(getDocument(w.db, docId)?.scanDetected).toBe(true)
  })

  it("GAP-7: a cancel during the re-ingest completes as 'done' — the persisted work is reported honestly", async () => {
    const docId = await importScan(w)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let embedReached = false
    const base = createMockEmbedder()
    // A gated embedder parks the RE-INGEST (recognition already persisted) so the cancel lands in
    // the post-persist window — the deliberately-ignored one (see the handler's cancel contract).
    const embedder = {
      id: base.id,
      dimensions: base.dimensions,
      embed: async (texts: string[]) => {
        embedReached = true
        await gate
        return base.embed(texts)
      }
    }
    const manager = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n} erkannt.` }), fakeRasterizer(), {
      getIngestionDeps: () => ({ embedder })
    })
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    await until(() => embedReached, 'the re-ingest reaching the embedder')
    manager.cancelDocTask(jobId) // lands mid-re-ingest, after setDocumentOcr persisted
    release()
    const status = await waitTerminal(manager, jobId)
    // The recognition + index are real, persisted work — reported 'done', never "cancelled, nothing
    // happened" about a now-searchable document (the decided GAP-7 contract).
    expect(status.state).toBe('done')
    expect(getDocumentOcrPages(w.db, docId)?.length).toBe(2)
    expect(getDocument(w.db, docId)?.status).toBe('indexed')
  })

  // #538 — every page is read the right way up, the turn that worked for the previous page is tried
  // first (a sideways scan is usually sideways throughout), and each page keeps the reading's
  // confidence and turn. Pages 1–2 here are sideways (readable at a 270° turn), page 3 is upright.
  it('reads sideways pages upright, tries the previous turn first, keeps confidence and turn (#538)', async () => {
    const docId = await importScan(w, { pages: 3 })
    const calls: string[] = []
    const rightTurn = (page: number): number => (page <= 2 ? 270 : 0)
    const engine: OcrEngine = {
      id: 'fake-tesseract',
      languages: ['deu'],
      recognize: async (image, opts) => {
        const page = image[0]
        const turn = opts?.turn ?? 0
        calls.push(`p${page}@${turn}`)
        const right = turn === rightTurn(page)
        return { text: right ? `Seite ${page} lesbar.` : 'xq vv ‚l', confidence: right ? 93 : 50 }
      },
      detectOrientation: async (image) => {
        calls.push(`p${image[0]}?`)
        return { turn: rightTurn(image[0]) as 0 | 270, confidence: 3 }
      }
    }
    const manager = ocrManager(engine, fakeRasterizer({ pages: 3 }))
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')

    expect(calls).toEqual([
      'p1@0', 'p1?', 'p1@270', // unsure upright → OSD → read at its turn
      'p2@270', // the previous page's turn first: one reading
      'p3@270', 'p3?', 'p3@0' // upright again: OSD finds it
    ])
    expect(getDocumentOcrPages(w.db, docId)).toEqual([
      { pageNumber: 1, text: 'Seite 1 lesbar.', confidence: 93, turn: 270 },
      { pageNumber: 2, text: 'Seite 2 lesbar.', confidence: 93, turn: 270 },
      { pageNumber: 3, text: 'Seite 3 lesbar.', confidence: 93 }
    ])
    expect(getDocument(w.db, docId)?.ocr).toMatchObject({ pageCount: 3, textPageCount: 3, lowConfidencePageCount: 0 })
  })

  it('fails friendly when every recognized page is empty', async () => {
    const docId = await importScan(w)
    const manager = ocrManager(fakeOcrEngine({ text: '   ' }), fakeRasterizer())
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_OCR_NO_TEXT_MESSAGE)
    expect(getDocumentOcrPages(w.db, docId)).toBeNull()
  })

  // #687: a render or recognition fault fails the task with the friendly copy; the raw reason reaches the LOCAL log
  // only (§11.4) — never the task status, never the audit trail — and nothing is persisted.
  it('a scan that cannot be read fails with the ocrFailed copy; the raw reason reaches only the local log (#687)', async () => {
    const docId = await importScan(w)
    const engine = fakeOcrEngine({ text: 'never persisted' })
    const rasterize: RasterizePdf = async () => {
      throw new Error('bad xref RAW-DETAIL')
    }
    const warn = vi.spyOn(log, 'warn')
    try {
      const manager = ocrManager(engine, rasterize, { audit: dbAudit(w.db) })
      const status = await waitTerminal(manager, manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)
      expect(status.state).toBe('failed')
      expect(status.error).toBe(t('en', 'main.task.ocrFailed'))
      expect(warn).toHaveBeenCalledWith('OCR task failed while reading the scan', {
        documentId: docId,
        error: 'bad xref RAW-DETAIL'
      })
    } finally {
      warn.mockRestore()
    }
    const events = listAuditEvents(w.db, { limit: 50 })
    expect(events.map((e) => e.type)).toContain('document_task_failed')
    expect(JSON.stringify(events)).not.toContain('RAW-DETAIL')
    expect(engine.calls).toBe(0)
    expect(getDocumentOcrPages(w.db, docId)).toBeNull()
    expect(getDocument(w.db, docId)?.scanDetected).toBe(true)
  })

  // #687: the recognition is persisted before the re-ingest; a re-ingest that does not reach `indexed` fails the task
  // with the friendly copy but keeps the pages (Re-index retries from them), and the document-work lease is returned.
  it('a re-ingest that does not reach indexed fails with the ocrFailed copy, keeps the pages, and releases the lease (#687)', async () => {
    const docId = await importScan(w)
    const failingEmbedder = { ...createMockEmbedder(), embed: async () => Promise.reject(new Error('embed down')) }
    const lease = { taken: 0, held: 0 }
    const error = vi.spyOn(log, 'error')
    try {
      const manager = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n} erkannt.` }), fakeRasterizer(), {
        getIngestionDeps: () => ({ embedder: failingEmbedder }),
        beginDocumentWork: () => {
          lease.taken += 1
          lease.held += 1
          return () => {
            lease.held -= 1
          }
        }
      })
      const status = await waitTerminal(manager, manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)
      expect(status.state).toBe('failed')
      expect(status.error).toBe(t('en', 'main.task.ocrFailed'))
      expect(error).toHaveBeenCalledWith(
        'OCR re-ingest did not reach indexed',
        expect.objectContaining({ documentId: docId, status: 'failed' })
      )
    } finally {
      error.mockRestore()
    }
    expect(getDocumentOcrPages(w.db, docId)?.map((p) => p.text)).toEqual(['Seite 1 erkannt.', 'Seite 2 erkannt.'])
    expect(getDocument(w.db, docId)?.status).toBe('failed')
    expect(lease).toEqual({ taken: 1, held: 0 })
  })

  it("guards: no engine, not a scan (a text PDF; an OCR'd photo), chat streaming, a recognizer that cannot run (#232)", async () => {
    const docId = await importScan(w)
    // No engine (no OCR files on the drive).
    expect(() => ocrManager(null).startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      TASK_NEEDS_OCR_MESSAGE
    )
    const manager = ocrManager(fakeOcrEngine({ text: 'x' }), fakeRasterizer({ pages: 1 }))
    // Not a scan: an ordinary text PDF (no scan marker — only the marker clause refuses it)…
    writeFileSync(join(w.root, 'letter.pdf'), makePdf('An ordinary text page with plenty of readable words on it.'))
    const text = await processDocument(w.db, w.storeDir, createQueuedDocument(w.db, join(w.root, 'letter.pdf')).id)
    expect(text.scanDetected).toBe(false)
    expect(text.scannedPages ?? null).toBeNull()
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [text.id] })).toThrow(
      TASK_OCR_NOT_A_SCAN_MESSAGE
    )
    // …and a photo read by OCR on import (#574: it carries OCR metadata — only the PDF check refuses it).
    writeFileSync(join(w.root, 'receipt.png'), TINY_PNG)
    const photo = await processDocument(w.db, w.storeDir, createQueuedDocument(w.db, join(w.root, 'receipt.png')).id, {
      ocrEngine: fakeOcrEngine({ text: 'Quittung über 42 Euro.' })
    })
    expect(photo.ocr).toBeTruthy()
    expect(() => manager.startDocTask({ kind: 'ocr', documentIds: [photo.id] })).toThrow(
      TASK_OCR_NOT_A_SCAN_MESSAGE
    )
    // The D26 chat guard holds for OCR too.
    const busy = ocrManager(fakeOcrEngine({ text: 'x' }), fakeRasterizer({ pages: 1 }), {
      isChatStreaming: () => true
    })
    expect(() => busy.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      TASK_REFUSED_CHAT_STREAMING_MESSAGE
    )
    // #232: an engine that exists but cannot run in this build is
    // refused at admission with the "could not start" copy — not the "files missing" copy, and
    // never a worker spawn attempt.
    const unavailable = ocrManager(fakeOcrEngine({ text: 'x', state: 'unavailable' }), fakeRasterizer({ pages: 1 }))
    expect(() => unavailable.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      /could not start/
    )
  })

  // OCR-R P1 (BE-1, ocr-audit 2026-07-18): task admission must mirror the docs IPC
  // `requireNoActiveTask` guard — refuse EVERY kind while the ingestion layer reports the
  // target document mid-import/re-index (an OCR task admitted mid-re-index would interleave
  // two chunk DELETE/INSERT transactions + two embed phases on one document). The predicate
  // is optional: absent/unwired ⇒ admission unchanged. Watched fail pre-fix.
  it('BE-1: refuses to start ANY kind while the target document is mid-import/re-index', async () => {
    const docId = await importScan(w)
    // A runtime so the summary path reaches the NEW guard, not the no-model refusal.
    const busy = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n}.` }), fakeRasterizer(), {
      getRuntime: () => docTaskRuntime(),
      isDocumentProcessing: () => true
    })
    expect(() => busy.startDocTask({ kind: 'ocr', documentIds: [docId] })).toThrow(
      TASK_DOCUMENT_BUSY_INGESTING_MESSAGE
    )
    expect(() => busy.startDocTask({ kind: 'summary', documentIds: [docId] })).toThrow(
      TASK_DOCUMENT_BUSY_INGESTING_MESSAGE
    )
    // A false predicate admits normally — the guard must never refuse outside a live ingestion.
    const idle = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n}.` }), fakeRasterizer(), {
      getRuntime: () => docTaskRuntime(),
      isDocumentProcessing: () => false
    })
    const { jobId } = idle.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(idle, jobId)).state).toBe('done')
  })

  it('re-running OCR on an already-recognized PDF is allowed and overwrites', async () => {
    const docId = await importScan(w)
    const first = ocrManager(fakeOcrEngine({ text: 'Alte Erkennung.' }), fakeRasterizer())
    const r1 = first.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(first, r1.jobId)).state).toBe('done')

    const second = ocrManager(fakeOcrEngine({ text: 'Neue Erkennung.' }), fakeRasterizer())
    const r2 = second.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(second, r2.jobId)).state).toBe('done')
    expect(getDocumentOcrPages(w.db, docId)?.[0].text).toBe('Neue Erkennung.')
  })

  // OCR-R test-gap #3 residual (BUILD_STATE §5 item 15(f)) / #687: two OCR tasks queued on ONE document. There is no
  // same-kind dedupe, so both are admitted; the queue runs them one after the other (the second never starts reading
  // while the first runs), and the later reading replaces the earlier one — the D33 redo — indexed once.
  it('two OCR tasks on one document run one after the other; the later reading wins and is indexed once (#687)', async () => {
    const docId = await importScan(w)
    let run = 0
    let active = 0
    let maxActive = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const engine = fakeOcrEngine({ text: (n) => `Lauf ${run} Seite ${n}.` })
    const walk = fakeRasterizer()
    // What task 1 was when task 2 read its first page.
    const firstStateAtSecondRead: string[] = []
    let firstJob = ''
    const rasterize: RasterizePdf = async (pdf, o) => {
      const mine = ++run
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (mine === 1) await gate
        const onPage: typeof o.onPage = (n, png) => {
          if (mine === 2 && n === 1) firstStateAtSecondRead.push(manager.getDocTask(firstJob).state)
          return o.onPage(n, png)
        }
        return await walk(pdf, { ...o, onPage })
      } finally {
        active -= 1
      }
    }
    const manager = ocrManager(engine, rasterize)
    firstJob = manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId
    const secondJob = manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId
    expect(secondJob).not.toBe(firstJob)
    await until(() => run >= 1, 'task 1 parking in the rasterizer')
    expect(manager.getDocTask(secondJob).state).toBe('queued')
    expect(run).toBe(1)
    release()
    expect((await waitTerminal(manager, firstJob)).state).toBe('done')
    expect((await waitTerminal(manager, secondJob)).state).toBe('done')
    expect(maxActive).toBe(1)
    expect(firstStateAtSecondRead).toEqual(['done'])
    expect(engine.calls).toBe(4)
    expect(getDocumentOcrPages(w.db, docId)?.map((p) => p.text)).toEqual(['Lauf 2 Seite 1.', 'Lauf 2 Seite 2.'])
    // One chunk set — the second re-ingest replaced the first, it did not add to it.
    const pages = w.db
      .prepare('SELECT page_number FROM chunks WHERE document_id = ? ORDER BY chunk_index')
      .all(docId) as Array<{ page_number: number | null }>
    expect(pages.map((r) => r.page_number)).toEqual([1, 2])
    expect(getDocument(w.db, docId)?.status).toBe('indexed')
  })
})

// #575 — a typed letter with scanned pages: import keeps its text page searchable AND says which
// pages are scans; "Make searchable (OCR)" reads just those pages and merges them in, page by page.
describe('a text PDF with scanned pages (#575)', () => {
  async function importLetter(): Promise<string> {
    const p = join(w.root, 'letter.pdf')
    writeFileSync(
      p,
      makeMixedPdf([
        { kind: 'text', lines: ['Sehr geehrte Damen und Herren, anbei die unterschriebene Vereinbarung.'] },
        { kind: 'image' },
        { kind: 'image' }
      ])
    )
    const info = await processDocument(w.db, w.storeDir, createQueuedDocument(w.db, p).id, {
      embedder: createMockEmbedder()
    })
    expect(info.status).toBe('indexed')
    expect(info.scannedPages).toEqual({ count: 2, pageCount: 3 })
    expect(matchesSmartView(info, 'ocr')).toBe(true)
    return info.id
  }

  it('reads only the scanned pages and merges them into the document, cited by page', async () => {
    const docId = await importLetter()
    const walked: number[] = []
    const engine = fakeOcrEngine({ text: (n) => `Seite ${n}: Unterschrift und Anlage.` })
    const manager = ocrManager(engine, fakeRasterizer({ pages: 3, walked }))
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('done')
    expect(walked).toEqual([2, 3])
    expect(status.progress.stepsTotal).toBe(3) // two pages + the re-ingest

    const preview = await extractDocumentPreview(w.db, w.storeDir, docId, {})
    expect(preview.segments.map((s) => [s.pageNumber, s.text])).toEqual([
      [1, 'Sehr geehrte Damen und Herren, anbei die unterschriebene Vereinbarung.'],
      [2, 'Seite 2: Unterschrift und Anlage.'],
      [3, 'Seite 3: Unterschrift und Anlage.']
    ])
    expect(getDocument(w.db, docId)?.ocr).toMatchObject({ pageCount: 2, textPageCount: 2 })
    expect(getDocument(w.db, docId)?.scannedPages).toEqual({ count: 2, pageCount: 3 })
  })

  it('a re-run that finds no text never replaces an earlier reading of the scanned pages', async () => {
    const docId = await importLetter()
    const first = ocrManager(fakeOcrEngine({ text: (n) => `Seite ${n} gelesen.` }), fakeRasterizer({ pages: 3 }))
    expect((await waitTerminal(first, first.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)).state).toBe('done')
    const rerun = ocrManager(fakeOcrEngine({ text: '' }), fakeRasterizer({ pages: 3 }))
    const status = await waitTerminal(rerun, rerun.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_OCR_NO_TEXT_MESSAGE)
    expect(getDocumentOcrPages(w.db, docId)?.map((p) => p.text)).toEqual(['Seite 2 gelesen.', 'Seite 3 gelesen.'])
  })

  it('a reading that finds no text on the scanned pages is kept — the pages were read, the offer goes', async () => {
    const docId = await importLetter()
    const manager = ocrManager(fakeOcrEngine({ text: '' }), fakeRasterizer({ pages: 3 }))
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    expect((await waitTerminal(manager, jobId)).state).toBe('done')
    const doc = getDocument(w.db, docId)
    expect(doc?.status).toBe('indexed') // its text page still searchable
    expect(doc?.ocr).toMatchObject({ pageCount: 2, textPageCount: 0 })
  })

  // #687: unlike the row above, a run that read NO page at all — every scanned page lies past the page cap — has read
  // nothing to keep: it fails with the no-text copy, persists nothing, and the offer stays.
  it('a run that reads none of the scanned pages (all past the page cap) persists nothing — the offer stays (#687)', async () => {
    const docId = await importLetter()
    const engine = fakeOcrEngine({ text: 'never read' })
    // The real rasterizer's walk under a one-page cap: pages 2 and 3 of 3 are both past it.
    const rasterize: RasterizePdf = async (_pdf, o) => {
      o.onPageCount?.(pagesToWalk(3, { maxPages: 1, pages: o.pages }).length)
      await pipelinePages(3, async (n) => Buffer.from([n]), o.onPage, { maxPages: 1, pages: o.pages, signal: o.signal })
      return { pageCount: 1 }
    }
    const manager = ocrManager(engine, rasterize)
    const status = await waitTerminal(manager, manager.startDocTask({ kind: 'ocr', documentIds: [docId] }).jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toBe(TASK_OCR_NO_TEXT_MESSAGE)
    expect(engine.calls).toBe(0)
    expect(getDocumentOcrPages(w.db, docId)).toBeNull()
    const doc = getDocument(w.db, docId)
    expect(doc?.ocr ?? null).toBeNull()
    expect(doc?.scannedPages).toEqual({ count: 2, pageCount: 3 })
  })
})

describe('photo import through the real pipeline', () => {
  // #574 — a photo read by OCR carries OCR metadata like a scanned PDF (the preview caveat, the
  // `ocr` view, "Read again (OCR)"), but no separately stored text: its text lives only in its
  // chunks. A re-read that fails takes the claim away again.
  it('#574: a photo read by OCR carries its OCR metadata, without stored text; a failed re-read clears it', async () => {
    const p = join(w.root, 'receipt.jpg')
    writeFileSync(p, TINY_PNG)
    const queued = createQueuedDocument(w.db, p)
    const done = await processDocument(w.db, w.storeDir, queued.id, {
      embedder: createMockEmbedder(),
      ocrEngine: fakeOcrEngine({ text: 'Quittung über 42 Euro.' })
    })
    expect(done.status).toBe('indexed')
    expect(done.chunkCount).toBe(1)
    expect(done.ocr).toEqual({
      pageCount: 1,
      textPageCount: 1,
      lowConfidencePageCount: 0,
      languages: ['deu', 'eng'],
      engineId: 'fake-tesseract',
      createdAt: expect.any(String)
    })
    expect(matchesSmartView(done, 'ocr')).toBe(true)
    expect(getDocumentOcrPages(w.db, queued.id)).toBeNull()

    const reread = await reindexDocument(w.db, w.storeDir, queued.id, { embedder: createMockEmbedder() })
    expect(reread.status).toBe('failed')
    expect(getDocument(w.db, queued.id)?.ocr ?? null).toBeNull()

    // Read fine, but its embedding failed: the row ends failed and claims no recognized text either.
    const failingEmbedder = { ...createMockEmbedder(), embed: async () => Promise.reject(new Error('embed down')) }
    const second = createQueuedDocument(w.db, p)
    const embedFailed = await processDocument(w.db, w.storeDir, second.id, {
      embedder: failingEmbedder,
      ocrEngine: fakeOcrEngine({ text: 'Quittung über 42 Euro.' })
    })
    expect(embedFailed.status).toBe('failed')
    expect(getDocument(w.db, second.id)?.ocr ?? null).toBeNull()
  })

  // #232 / #219: the OCR files are on the drive but the
  // packaged recognizer cannot run — the photo is stored (a re-index recognizes it later) and
  // its row carries the "could not run in this build" note, never the "files missing" copy and
  // never a crash. The engine is not even asked. Without OCR files at all, the photo is stored
  // the same way with the "files missing" note.
  it.each([
    { case: 'no OCR files on the drive', state: null, note: IMAGE_NEEDS_OCR_MESSAGE },
    // (Case labels stay under vitest's 40-character display cut, so the titles print whole.)
    { case: 'a recognizer that cannot run (#232)', state: 'unavailable' as const, note: IMAGE_OCR_UNAVAILABLE_MESSAGE }
  ])('a photo with $case is stored and fails with its own note, never a crash', async ({ state, note }) => {
    const p = join(w.root, 'photo.png')
    writeFileSync(p, TINY_PNG)
    const engine = state ? fakeOcrEngine({ state, text: 'must not be recognized' }) : null
    const info = await processDocument(w.db, w.storeDir, createQueuedDocument(w.db, p).id, {
      embedder: createMockEmbedder(),
      ...(engine ? { ocrEngine: engine } : {})
    })
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toBe(note)
    expect(engine?.calls ?? 0).toBe(0) // an engine that cannot run is not even asked
    // The row keeps its type and a stored copy (processDocument stores before parsing), so
    // "re-index once OCR is available" is a real path — no scan offer (PDF-only).
    expect(info.mimeType).toBe('image/png')
    expect(readdirSync(w.storeDir).length).toBeGreaterThan(0) // the stored copy landed before the parse
    expect(info.scanDetected).toBe(false)
  })
})

describe('#232 dequeue-time guard (#232)', () => {
  // The engine was available at admission and became unavailable before the queued task ran
  // (the worker died under a photo import in between). The handler's guard must surface the
  // "could not start" copy — which therefore has to pass the manager's friendly-error filter,
  // not be swallowed into `main.task.genericFailure` (PR #268 review).
  it('a task admitted before the recognizer became unavailable fails with the ocrUnavailable copy, not the generic one', async () => {
    const docId = await importScan(w)
    // Available for the admission check (first read), unavailable for every later read — the
    // handler's dequeue-time read sees the flip however eagerly the manager starts the run.
    let reads = 0
    const engine: OcrEngine = {
      ...fakeOcrEngine({ text: 'x' }),
      availability: () => (reads++ === 0 ? 'available' : 'unavailable')
    }
    const manager = ocrManager(engine, fakeRasterizer({ pages: 1 }))
    const { jobId } = manager.startDocTask({ kind: 'ocr', documentIds: [docId] })
    const status = await waitTerminal(manager, jobId)
    expect(status.state).toBe('failed')
    expect(status.error).toMatch(/could not start/)
    expect(status.error).not.toMatch(/Something went wrong/)
  })
})
