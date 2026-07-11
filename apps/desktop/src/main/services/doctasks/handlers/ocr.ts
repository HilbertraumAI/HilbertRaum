// OCR handler — "Make searchable (OCR)" (DX-1 split, full-audit-2026-06-29 follow-up Phase 8).
// Relocated VERBATIM from `manager.ts`; `this.deps` became `ctx.deps` and the private
// `readStoredPdfBytes` became a module-local function taking `ctx`. Behavior unchanged.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tMain } from '../../i18n'
import { getDocument, reindexDocument, setDocumentOcr } from '../../ingestion'
import type { OcrPage } from '../../ocr'
import { ENCRYPTED_DOC_SUFFIX, shredFile } from '../../workspace-vault'
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
  const db = ctx.deps.getDb()
  const documentId = task.status.documentIds[0]
  const doc = getDocument(db, documentId)
  if (!doc) throw new Error(tMain('main.task.ocrNotAScan'))
  const signal = task.controller.signal

  const pdf = await readStoredPdfBytes(documentId, ctx)
  const pages: OcrPage[] = []
  try {
    await rasterize(pdf, {
      signal,
      onPageCount: (n) => {
        // pages + persist/re-ingest as the final step.
        task.status.progress.stepsTotal = n + 1
      },
      onPage: async (pageNumber, png) => {
        // Backpressure: the next page is not rendered until this recognition ends.
        const result = await engine.recognize(png, { signal })
        pages.push({ pageNumber, text: result.text.trim() })
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
  if (!pages.some((p) => p.text.length > 0)) {
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
    .prepare('SELECT title, stored_path, original_path FROM documents WHERE id = ?')
    .get(documentId) as unknown as
    | { title: string; stored_path: string | null; original_path: string | null }
    | undefined
  if (!row) throw new Error(tMain('main.task.sourceUnreadable'))
  const cipher = ctx.deps.getIngestionDeps().cipher ?? null
  try {
    // ING-8 (perf audit 2026-06-18): read the (potentially huge, up to ~1 GiB) PDF with async
    // `readFile` so the bytes stream off the main event loop instead of a blocking `readFileSync`.
    if (row.stored_path && existsSync(row.stored_path)) {
      if (row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
        if (!cipher) throw new Error(tMain('main.task.sourceUnreadable'))
        const transient = join(ctx.deps.getStoreDir(), `${documentId}.parse-ocr.pdf`)
        try {
          await cipher.decryptFileAsync(row.stored_path, transient) // PERF-1: yields between chunks
          return await readFile(transient)
        } finally {
          shredFile(transient)
        }
      }
      return await readFile(row.stored_path)
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
