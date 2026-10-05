// OCR handler — "Make searchable (OCR)" (DX-1 split, full-audit-2026-06-29 follow-up Phase 8).
// Relocated VERBATIM from `manager.ts`; `this.deps` became `ctx.deps` and the private
// `readStoredPdfBytes` became a module-local function taking `ctx`. Behavior unchanged.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tMain } from '../../i18n'
import {
  getDocument,
  getDocumentScannedPages,
  reindexDocument,
  setDocumentOcr
} from '../../ingestion'
import type { OcrPage, OcrTurn } from '../../ocr'
import { readUpright } from '../../ocr/upright'
import { shredFile } from '../../workspace-vault'
import { resolveStoredCopy } from '../../ingestion/stored-copy'
import { isAbortError } from '../../chat'
import { log } from '../../logging'
import type { DocTaskCtx, InternalTask } from '../context'

/**
 * The OCR task ("Make searchable (OCR)", never automatic): rasterize the stored
 * PDF page by page in the hidden window, recognize each page PNG main-side with
 * the local engine, persist the recognition (`documents.ocr_json`, content → DB
 * only), then re-ingest — the PdfParser's ocrPages hook turns the recognition into
 * one segment per page, so page citations work unchanged.
 * Progress = pages recognized + the final re-ingest step.
 *
 * Each page is read the right way up (#538, `readUpright`): the turn that worked for the previous
 * page is tried first, and the page's confidence and turn are kept with its text.
 *
 * A TEXT PDF with scanned pages (#575) has only those pages read; the re-ingest merges their
 * recognition with the text layer of the others. Such a reading is persisted even when it found
 * no text (blank backs of a scanned attachment) — the pages were read, and the offer must not
 * come back; a whole scan with no text still fails as before (it would index nothing).
 *
 * Cancel contract (GAP-7, full-audit 2026-07-11 — decided deliberately): a cancel landing
 * anywhere BEFORE the persist point (`setDocumentOcr`) persists NOTHING — the rasterize loop,
 * each per-page recognition, and the last pre-persist check below all honour the signal, and the
 * document stays a detected scan. A cancel landing AFTER the persist point (i.e. during the
 * signal-less, minutes-long re-ingest) is deliberately IGNORED: the recognition is already
 * persisted and the chunks/index are being rebuilt from it, so the task completes and reports
 * 'done' — claiming "cancelled, nothing happened" about a now-searchable document would lie about
 * persisted work (the B2 lesson from the skill seams).
 */
export async function runOcr(task: InternalTask, ctx: DocTaskCtx): Promise<string> {
  const engine = ctx.deps.getOcrEngine?.()
  const rasterize = ctx.deps.rasterizePdf
  if (!engine || !rasterize) throw new Error(tMain('main.task.needsOcr'))
  // Mirrors the manager's admission guard for a task queued before the recognizer proved it
  // cannot run in this build (#232).
  if (engine.availability?.() === 'unavailable') throw new Error(tMain('main.task.ocrUnavailable'))
  const db = ctx.deps.getDb()
  const documentId = task.status.documentIds[0]
  const doc = getDocument(db, documentId)
  if (!doc) throw new Error(tMain('main.task.ocrNotAScan'))
  const signal = task.controller.signal
  // #575: a text PDF's scanned pages, or null — a whole scan reads every page.
  const scannedPages = doc.scanDetected ? null : getDocumentScannedPages(db, documentId)

  const pdf = await readStoredPdfBytes(documentId, ctx)
  const pages: OcrPage[] = []
  let lastTurn: OcrTurn = 0
  try {
    await rasterize(pdf, {
      signal,
      ...(scannedPages ? { pages: scannedPages } : {}),
      onPageCount: (n) => {
        // pages + persist/re-ingest as the final step.
        task.status.progress.stepsTotal = n + 1
      },
      onPage: async (pageNumber, png) => {
        // Backpressure: recognitions serialize; the rasterizer keeps at most a 1-deep
        // render look-ahead (ING-5).
        const reading = await readUpright(engine, png, { signal, first: lastTurn })
        lastTurn = reading.turn
        pages.push({
          pageNumber,
          text: reading.text.trim(),
          ...(reading.confidence != null ? { confidence: reading.confidence } : {}),
          ...(reading.turn !== 0 ? { turn: reading.turn } : {})
        })
        task.status.progress.stepsDone += 1
        if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
      }
    })
  } catch (err) {
    if (isAbortError(err, signal)) throw err
    // §11.4: raw render/recognition errors go to the local log only.
    log.warn('OCR task failed while reading the scan', {
      documentId,
      error: err instanceof Error ? err.message : String(err)
    })
    throw new Error(tMain('main.task.ocrFailed'))
  }
  // GAP-7: the LAST pre-persist abort check — a cancel that landed by the end of recognition
  // actually cancels (nothing persisted). There is no await between here and `setDocumentOcr`,
  // so past this line the task is committed to completing (see the header's cancel contract).
  if (signal.aborted) throw new DOMException('Document task cancelled', 'AbortError')
  // A reading with no text is kept only for a text PDF's scanned pages read for the FIRST time (so
  // the offer goes away); a re-run never replaces an earlier reading with nothing, and a run that
  // read no page at all (every scanned page past the page cap) persists nothing (#575).
  const foundText = pages.some((p) => p.text.length > 0)
  if (!foundText && (!scannedPages || doc.ocr != null || pages.length === 0)) {
    throw new Error(tMain('main.task.ocrNoText'))
  }

  // Persist the recognition, then re-ingest through the normal pipeline (chunks,
  // embeddings, FTS — the document becomes a first-class searchable corpus member).
  // The re-ingest may rewrite a legacy plaintext stored copy to `.enc`, so it holds
  // the vault lease like every sidecar writer (VaultBusyError → friendly fail).
  setDocumentOcr(db, documentId, {
    pages,
    engineId: engine.id,
    languages: [...engine.languages]
  })
  const release = ctx.deps.beginDocumentWork()
  try {
    const result = await reindexDocument(
      db,
      ctx.deps.getStoreDir(),
      documentId,
      ctx.deps.getIngestionDeps()
    )
    if (result.status !== 'indexed') {
      // The recognition stays persisted (it is real work); the document row keeps
      // the re-ingest failure message — Re-index retries with the stored pages.
      log.error('OCR re-ingest did not reach indexed', {
        documentId,
        status: result.status,
        error: result.errorMessage
      })
      throw new Error(tMain('main.task.ocrFailed'))
    }
  } finally {
    release()
  }
  // GAP-7: the deliberate post-persist re-check — a cancel that landed during the (signal-less)
  // re-ingest arrives with the work already persisted and the index rebuilt. Log it (ids only) and
  // complete as 'done'; the manager maps a clean return to 'done' even under an aborted signal,
  // which is exactly the honest outcome here (see the header's cancel contract).
  if (signal.aborted) {
    log.info('OCR task cancel landed after the persist point — completing as done', { documentId })
  }
  task.status.progress.stepsDone += 1
  return documentId
}

/**
 * Read the stored PDF's plaintext bytes for rasterization. Encrypted copies decrypt
 * to a `.parse-ocr.pdf` transient (covered by the startup crash sweep) that is
 * shredded before returning — only the in-memory Buffer leaves this method.
 */
async function readStoredPdfBytes(documentId: string, ctx: DocTaskCtx): Promise<Buffer> {
  const db = ctx.deps.getDb()
  const row = db
    .prepare('SELECT id, title, stored_path, stored_name, original_path FROM documents WHERE id = ?')
    .get(documentId) as unknown as
    | {
        id: string
        title: string
        stored_path: string | null
        stored_name: string | null
        original_path: string | null
      }
    | undefined
  if (!row) throw new Error(tMain('main.task.sourceUnreadable'))
  const ingestionDeps = ctx.deps.getIngestionDeps()
  const cipher = ingestionDeps.cipher ?? null
  const storeDir = ctx.deps.getStoreDir()
  try {
    // ING-8 (perf audit 2026-06-18): read the (potentially huge, up to ~1 GiB) PDF with async
    // `readFile` so the bytes stream off the main event loop instead of a blocking `readFileSync`.
    // #188: located through the shared resolver, so "Make searchable" still finds the stored PDF
    // after the drive comes back under a different mount point.
    const stored = resolveStoredCopy(db, storeDir, row)
    if (stored) {
      if (stored.encrypted) {
        if (!cipher) throw new Error(tMain('main.task.sourceUnreadable'))
        const transient = join(storeDir, `${documentId}.parse-ocr.pdf`)
        // #237: registered so a lock/quit that outlasts the doc-task settle still sweeps it.
        const op = ingestionDeps.plaintextOps?.register('doc-task')
        op?.track(transient)
        try {
          await cipher.decryptFileAsync(stored.path, transient) // PERF-1: yields between chunks
          return await readFile(transient)
        } finally {
          shredFile(transient)
          op?.release()
        }
      }
      return await readFile(stored.path)
    }
    if (row.original_path && existsSync(row.original_path)) {
      return await readFile(row.original_path)
    }
  } catch (err) {
    log.warn('OCR source read failed', {
      documentId,
      error: err instanceof Error ? err.message : String(err)
    })
    throw new Error(tMain('main.task.sourceUnreadable'))
  }
  throw new Error(tMain('main.task.sourceUnreadable'))
}
