import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Db } from '../db'
import type {
  DocumentInfo,
  DocumentOcrInfo,
  DocumentOrigin,
  DocumentPreview,
  DocumentSummary,
  IngestionStatus
} from '../../../shared/types'
import { sha256File } from '../models'
import { type Embedder, encodeVector } from '../embeddings'
import { ENCRYPTED_DOC_SUFFIX, shredFile, type DocumentCipher } from '../workspace-vault'
import type { Transcriber } from '../transcriber'
import type { OcrEngine, OcrPage } from '../ocr'
import {
  isAudioPath,
  isPdfPath,
  selectParser,
  supportedExtensions,
  type ParseContext
} from './parsers'
import { PDF_SCAN_DETECTED_MESSAGE } from './parsers/pdf'
import { chunkSegments } from './chunker'

// Ingestion service (spec §7.7). Owns the document lifecycle:
//   queued → extracting → chunking → embedding → indexed   (failed on error)
// Persists to the `documents`, `chunks`, and `embeddings` tables (spec §8). Each file is
// COPIED into the workspace (`workspace/documents/`) so the drive is self-contained; both
// the workspace copy (`stored_path`) and the user's original location (`original_path`)
// are recorded. A failed file never crashes the run — it lands in `failed` with an
// `error_message`.
//
// The `embedding` step writes one vector per chunk into the `embeddings` table when an
// `Embedder` is supplied (Phase 5). It is optional: with no embedder the step is a
// pass-through (a document still reaches `indexed` with chunks but no vectors), which keeps
// the Phase-4 callers/tests valid and lets the real embedder swap in unchanged (Phase 10).

/** Optional dependencies for the embedding step (Phase 5) + encrypted storage (H1). */
export interface IngestionDeps {
  /** Embedder used to vectorize chunks. Omit to skip the embedding step. */
  embedder?: Embedder
  /** Model id tag for `embeddings.embedding_model_id`; falls back to `embedder.id`. */
  embeddingModelId?: string | null
  /**
   * When present (encrypted workspace), the stored document copy is written ENCRYPTED
   * (`<id><ext>.enc`, vault-key AES-GCM) instead of a plaintext copy — spec §3.5
   * requires the document cache to be encrypted, not just the database. Re-indexing
   * decrypts to a transient working file and shreds it afterwards.
   */
  cipher?: DocumentCipher | null
  /**
   * Transcriber for audio imports (Phase 36, the embedder-injection precedent).
   * Optional AND nullable: absent/null means an audio FILE fails friendly with the
   * download-the-model copy — text ingestion is unaffected (graceful-fallback rule).
   */
  transcriber?: Transcriber | null
  /**
   * Coarse transcription progress (0–100) per document, surfaced by the IPC layer as
   * "Transcribing… N%" on the documents table polling path (import AND re-index).
   */
  onTranscribeProgress?: (documentId: string, percent: number) => void
  /**
   * OCR engine for photo imports (Phase 38, the transcriber pattern). Optional AND
   * nullable: absent/null means a photo FILE fails friendly with the
   * needs-the-OCR-files copy — text ingestion is unaffected.
   */
  ocrEngine?: OcrEngine | null
}

// Canonical home of the `.enc` suffix moved to workspace-vault (Phase 32 — the password
// change re-encrypts these sidecars); re-exported here for the existing import sites.
export { ENCRYPTED_DOC_SUFFIX }

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdown': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.tsv': 'text/csv',
  // Audio (Phase 36) — exactly the formats the pinned whisper-cli decodes (R-W2).
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  // Photos (Phase 38) — OCR'd on import (D33 asymmetry: small, single image).
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

function nowIso(): string {
  return new Date().toISOString()
}

function guessMime(filePath: string): string | null {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? null
}

/** Directory that holds workspace copies of imported files. Created on demand. */
export function documentsDir(workspacePath: string): string {
  const dir = join(workspacePath, 'documents')
  mkdirSync(dir, { recursive: true })
  return dir
}

interface DocumentRow {
  id: string
  title: string
  original_path: string | null
  stored_path: string | null
  mime_type: string | null
  size_bytes: number | null
  sha256: string | null
  status: string
  error_message: string | null
  summary_json: string | null
  origin_json: string | null
  ocr_json: string | null
  created_at: string
  updated_at: string
}

const VALID_STATUSES: ReadonlySet<string> = new Set<IngestionStatus>([
  'queued',
  'extracting',
  'chunking',
  'embedding',
  'indexed',
  'failed',
  'deleted'
])

function toStatus(value: string): IngestionStatus {
  return (VALID_STATUSES.has(value) ? value : 'failed') as IngestionStatus
}

/** Parse a stored summary; malformed JSON must never break a document listing. */
function parseSummary(json: string | null | undefined): DocumentSummary | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<DocumentSummary> | null
    if (v && typeof v.text === 'string' && v.text.length > 0) {
      return {
        text: v.text,
        modelId: typeof v.modelId === 'string' ? v.modelId : 'unknown',
        createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
        truncated: v.truncated === true
      }
    }
  } catch {
    // fall through to null
  }
  return null
}

/** Parse a stored origin (Phase 34/35 provenance); malformed JSON reads as null. */
function parseOrigin(json: string | null | undefined): DocumentOrigin | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return null
    // Comparison provenance (Phase 35): both source ids, A/B order.
    if (v.type === 'compare') {
      const from = v.comparedFrom
      if (
        Array.isArray(from) &&
        from.length === 2 &&
        from.every((x) => typeof x === 'string' && x.length > 0)
      ) {
        return { type: 'compare', comparedFrom: [from[0] as string, from[1] as string] }
      }
      return null
    }
    // Translation provenance. Phase-34 rows persisted WITHOUT the `type` field (it was
    // the only shape then) — they parse as 'translation' unchanged.
    if (
      typeof v.translatedFrom === 'string' &&
      v.translatedFrom.length > 0 &&
      (v.targetLang === 'de' || v.targetLang === 'en')
    ) {
      return { type: 'translation', translatedFrom: v.translatedFrom, targetLang: v.targetLang }
    }
  } catch {
    // fall through to null
  }
  return null
}

/**
 * The stored OCR recognition (Phase 38): full per-page text (CONTENT — DB only,
 * never logs/audit) plus the surface metadata `DocumentInfo.ocr` exposes.
 */
interface StoredOcr {
  pages: OcrPage[]
  engineId: string
  languages: string[]
  createdAt: string
}

/** Parse a stored OCR result; malformed JSON must never break a document listing. */
function parseOcr(json: string | null | undefined): StoredOcr | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<StoredOcr> | null
    if (!v || !Array.isArray(v.pages)) return null
    const pages: OcrPage[] = []
    for (const p of v.pages) {
      const pageNumber = (p as OcrPage)?.pageNumber
      const text = (p as OcrPage)?.text
      if (typeof pageNumber === 'number' && Number.isInteger(pageNumber) && typeof text === 'string') {
        pages.push({ pageNumber, text })
      }
    }
    if (pages.length === 0) return null
    return {
      pages,
      engineId: typeof v.engineId === 'string' ? v.engineId : 'unknown',
      languages: Array.isArray(v.languages) ? v.languages.filter((l) => typeof l === 'string') : [],
      createdAt: typeof v.createdAt === 'string' ? v.createdAt : ''
    }
  } catch {
    return null
  }
}

/** Metadata-only view of a stored OCR result (never the recognized text). */
function ocrInfoOf(stored: StoredOcr | null): DocumentOcrInfo | null {
  if (!stored) return null
  return {
    pageCount: stored.pages.length,
    languages: stored.languages,
    engineId: stored.engineId,
    createdAt: stored.createdAt
  }
}

function rowToInfo(row: DocumentRow, chunkCount: number, staleEmbeddings?: boolean): DocumentInfo {
  return {
    id: row.id,
    title: row.title,
    originalPath: row.original_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: toStatus(row.status),
    errorMessage: row.error_message,
    chunkCount,
    staleEmbeddings,
    summary: parseSummary(row.summary_json),
    origin: parseOrigin(row.origin_json),
    // DERIVED scan marker (Phase 38 step 0): failed with the exact scan notice. The
    // OCR task targets exactly these rows (plus already-OCR'd PDFs for a re-run).
    scanDetected: row.status === 'failed' && row.error_message === PDF_SCAN_DETECTED_MESSAGE,
    ocr: ocrInfoOf(parseOcr(row.ocr_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Count a document's chunks that carry a vector under `modelId`. Used to detect an
 * embedding-model mismatch: an indexed document with chunks but zero vectors under the
 * active model is unreachable by search until re-indexed.
 */
function chunksEmbeddedUnder(db: Db, documentId: string, modelId: string): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
       WHERE c.document_id = ? AND e.embedding_model_id = ?`
    )
    .get(documentId, modelId) as unknown as { n: number }
  return r.n
}

function getRow(db: Db, id: string): DocumentRow | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  return row ?? null
}

function chunkCountFor(db: Db, id: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(id) as unknown as {
    n: number
  }
  return r.n
}

function setStatus(db: Db, id: string, status: IngestionStatus, errorMessage: string | null = null): void {
  db.prepare('UPDATE documents SET status = ?, error_message = ?, updated_at = ? WHERE id = ?').run(
    status,
    errorMessage,
    nowIso(),
    id
  )
}

/**
 * Insert a `queued` document row for `filePath` and return its DocumentInfo.
 * `displayTitle` (Phase 34) overrides the filename-derived title for app-GENERATED
 * files imported from a transient path (e.g. a materialized translation) — the title
 * drives parser selection, the stored copy's extension, and citation source labels,
 * so it must be set BEFORE processing and must keep a supported extension.
 */
export function createQueuedDocument(db: Db, filePath: string, displayTitle?: string): DocumentInfo {
  const now = nowIso()
  const id = randomUUID()
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(filePath).size
  } catch {
    sizeBytes = null
  }
  const title = displayTitle ?? basename(filePath)
  db.prepare(
    `INSERT INTO documents
       (id, title, original_path, stored_path, mime_type, size_bytes, sha256, status, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title, filePath, null, guessMime(title), sizeBytes, null, 'queued', null, now, now)
  return rowToInfo(getRow(db, id) as DocumentRow, 0)
}

/**
 * Run the full ingestion pipeline for one already-`queued` document. Never throws:
 * any failure is captured on the document row as `failed` + `error_message`, and the
 * resulting DocumentInfo is returned so the caller can report it.
 */
export async function processDocument(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: IngestionDeps = {}
): Promise<DocumentInfo> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)

  // Transient PLAINTEXT files created below (decrypted working copies in an encrypted
  // workspace). Always shredded on the way out — success or failure — so no decrypted
  // document content lingers on the drive.
  const transients: string[] = []

  try {
    setStatus(db, documentId, 'extracting')

    const ext = extname(row.title).toLowerCase()
    const cipher = deps.cipher ?? null

    // Ensure a self-contained workspace copy exists (`stored_path`). In an encrypted
    // workspace the copy rests ENCRYPTED (`<id><ext>.enc`); `sha256`/`size_bytes`
    // describe the plaintext content in both modes.
    let storedPath = row.stored_path
    /** The plaintext file the parser reads. */
    let parseSource: string

    if (!storedPath || !existsSync(storedPath)) {
      const origin = row.original_path
      if (!origin || !existsSync(origin)) {
        throw new Error('Source file not found on disk.')
      }
      const sha = await sha256File(origin)
      const size = statSync(origin).size
      if (cipher) {
        storedPath = join(storeDir, documentId + ext + ENCRYPTED_DOC_SUFFIX)
        cipher.encryptFile(origin, storedPath)
        // Parse the original directly (it is still on disk) — no decrypt round-trip.
        parseSource = origin
      } else {
        storedPath = join(storeDir, documentId + ext)
        copyFileSync(origin, storedPath)
        parseSource = storedPath
      }
      db.prepare('UPDATE documents SET stored_path = ?, sha256 = ?, size_bytes = ? WHERE id = ?').run(
        storedPath,
        sha,
        size,
        documentId
      )
    } else if (cipher && !storedPath.endsWith(ENCRYPTED_DOC_SUFFIX)) {
      // Legacy migration: this document was imported before the encrypted document cache
      // existed (or in plaintext mode). Re-indexing in an encrypted workspace upgrades
      // the stored copy: encrypt it, point the row at the `.enc`, parse the old
      // plaintext one last time, then shred it.
      const encPath = `${storedPath}${ENCRYPTED_DOC_SUFFIX}`
      cipher.encryptFile(storedPath, encPath)
      db.prepare('UPDATE documents SET stored_path = ? WHERE id = ?').run(encPath, documentId)
      parseSource = storedPath
      transients.push(storedPath)
      storedPath = encPath
    } else if (cipher) {
      // Encrypted stored copy: decrypt to a transient working file for the parser.
      parseSource = join(storeDir, `${documentId}.parse${ext}`)
      cipher.decryptFile(storedPath, parseSource)
      transients.push(parseSource)
    } else {
      parseSource = storedPath
    }

    const parser = selectParser(row.title)
    if (!parser) {
      throw new Error(`Unsupported file type: ${extname(row.title) || '(none)'}`)
    }
    // Prefer the per-extension MIME (identical to parser.mimeType for the text formats;
    // gives audio its real type — audio/wav vs the AudioParser's `audio/*` fallback).
    db.prepare('UPDATE documents SET mime_type = ? WHERE id = ?').run(
      guessMime(row.title) ?? parser.mimeType,
      documentId
    )

    // Parse context (Phase 36/38, additive — text parsers ignore it): the injected
    // transcriber + OCR engine, the documents dir for content transients, per-document
    // progress, and — for a previously-OCR'd PDF — the stored per-page recognition so
    // a re-index reuses it instead of failing scan detection again.
    const parseCtx: ParseContext = {
      transcriber: deps.transcriber,
      ocrEngine: deps.ocrEngine,
      ocrPages: isPdfPath(row.title) ? getDocumentOcrPages(db, documentId) : null,
      workDir: storeDir,
      onProgress: (percent) => deps.onTranscribeProgress?.(documentId, percent)
    }
    const parsed = await parser.parse(parseSource, parseCtx)

    setStatus(db, documentId, 'chunking')
    const chunks = chunkSegments(parsed.segments)

    // Replace any prior chunks (supports re-indexing) then insert fresh.
    db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(
      documentId
    )
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)

    const insert = db.prepare(
      `INSERT INTO chunks
         (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const created = nowIso()
    for (const c of chunks) {
      insert.run(
        randomUUID(),
        documentId,
        c.chunkIndex,
        c.text,
        row.title,
        c.pageNumber,
        c.sectionLabel,
        c.tokenCount,
        created
      )
    }

    // Embedding step: vectorize each chunk and persist to `embeddings` (Phase 5).
    // The DELETE above already cleared stale vectors, so re-index re-embeds cleanly.
    setStatus(db, documentId, 'embedding')
    if (deps.embedder) {
      await embedChunks(db, documentId, deps.embedder, deps.embeddingModelId ?? deps.embedder.id)
    }

    setStatus(db, documentId, 'indexed')
    return infoOrDeleted(db, documentId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus(db, documentId, 'failed', message)
    return infoOrDeleted(db, documentId)
  } finally {
    // Shred transient decrypted copies whether the pipeline succeeded or failed.
    for (const t of transients) shredFile(t)
  }
}

/**
 * Resolve the final DocumentInfo, tolerating a row that vanished mid-pipeline (e.g. the
 * document was deleted while processing). `processDocument` promises to never throw, so
 * a missing row yields a synthetic `deleted` info instead of a TypeError (M3).
 */
function infoOrDeleted(db: Db, documentId: string): DocumentInfo {
  const row = getRow(db, documentId)
  if (row) return rowToInfo(row, chunkCountFor(db, documentId))
  const now = nowIso()
  return {
    id: documentId,
    title: '(deleted)',
    originalPath: null,
    mimeType: null,
    sizeBytes: null,
    status: 'deleted',
    errorMessage: null,
    chunkCount: 0,
    createdAt: now,
    updatedAt: now
  }
}

/**
 * Embed every chunk of a document and persist the vectors. Chunks are embedded as a
 * single batch (the 1000-chunk-per-file cap bounds the work); the BLOB holds the raw
 * Float32 bytes (`encodeVector`). Tagged with `embeddingModelId` so re-embedding on a
 * model change is detectable. Assumes prior vectors for the document were already deleted.
 */
async function embedChunks(
  db: Db,
  documentId: string,
  embedder: Embedder,
  embeddingModelId: string
): Promise<void> {
  const rows = db
    .prepare('SELECT id, text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ id: string; text: string }>
  if (rows.length === 0) return

  const vectors = await embedder.embed(rows.map((r) => r.text))
  const insert = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const created = nowIso()
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i]
    insert.run(rows[i].id, embeddingModelId, encodeVector(vec), vec.length, created)
  }
}

/**
 * Read-only in-app preview (post-MVP): re-extract the document's text segments from the
 * self-contained stored copy (falling back to the original file if the copy is gone).
 * Re-parses instead of reading the `chunks` table because chunks OVERLAP (~80 tokens) —
 * concatenating them would duplicate text at every boundary. In an encrypted workspace
 * the stored `.enc` copy is decrypted to a transient working file that is shredded on
 * the way out (same pattern as re-indexing; the `.parse` infix keeps it covered by the
 * startup `shredStalePlaintext` crash sweep). Never writes to the DB; the plaintext
 * never leaves the main process except as extracted text over IPC.
 */
export async function extractDocumentPreview(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: Pick<IngestionDeps, 'cipher' | 'ocrEngine'> = {}
): Promise<DocumentPreview> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  const parser = selectParser(row.title)
  if (!parser) {
    throw new Error(`Unsupported file type: ${extname(row.title) || '(none)'}`)
  }

  // Audio (Phase 36): re-extraction reads the stored CHUNKS, not the file — re-parsing
  // would re-run the whole transcription (minutes of CPU) just to show text. Exact by
  // construction: every audio chunk is one packed transcript segment, verbatim, with no
  // overlap (AudioParser caps packed segments below the chunk window), so unlike the
  // overlapping text-format chunks these concatenate losslessly. This also serves the
  // doc-task re-extraction path (translate/compare a transcript without re-transcribing).
  if (isAudioPath(row.title)) {
    const segments = audioSegmentsFromChunks(db, documentId)
    if (segments.length === 0) {
      throw new Error(
        'No transcript is stored for this recording yet. Re-index it to transcribe again.'
      )
    }
    return { id: row.id, title: row.title, mimeType: row.mime_type, segments }
  }

  const cipher = deps.cipher ?? null
  const transients: string[] = []
  try {
    let parseSource: string
    if (row.stored_path && existsSync(row.stored_path)) {
      if (cipher && row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
        const ext = extname(row.title).toLowerCase()
        parseSource = join(storeDir, `${documentId}.parse-preview${ext}`)
        cipher.decryptFile(row.stored_path, parseSource)
        transients.push(parseSource)
      } else if (!cipher && row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
        throw new Error('This document is encrypted; unlock the workspace to preview it.')
      } else {
        parseSource = row.stored_path
      }
    } else if (row.original_path && existsSync(row.original_path)) {
      parseSource = row.original_path
    } else {
      throw new Error('The document file is no longer on disk. Re-import it to preview.')
    }

    // Phase 38: an OCR'd PDF previews its STORED recognition (the same ocrPages hook
    // re-index uses — never a silent re-OCR); a photo re-recognizes the stored copy
    // (one small image, the audio-preview trade-off inverted: cheap enough to redo).
    const parsed = await parser.parse(parseSource, {
      ocrEngine: deps.ocrEngine,
      ocrPages: isPdfPath(row.title) ? getDocumentOcrPages(db, documentId) : null
    })
    return {
      id: row.id,
      title: row.title,
      mimeType: row.mime_type,
      segments: parsed.segments.map((s) => ({
        text: s.text,
        pageNumber: s.pageNumber ?? null,
        sectionLabel: s.sectionLabel ?? null
      }))
    }
  } finally {
    for (const t of transients) shredFile(t)
  }
}

/**
 * A transcript document's segments, rebuilt from its stored chunks (Phase 36 — see
 * the audio branch in `extractDocumentPreview` for why this is exact for audio only).
 */
function audioSegmentsFromChunks(
  db: Db,
  documentId: string
): Array<{ text: string; pageNumber: number | null; sectionLabel: string | null }> {
  const rows = db
    .prepare(
      'SELECT text, section_label FROM chunks WHERE document_id = ? ORDER BY chunk_index'
    )
    .all(documentId) as unknown as Array<{ text: string; section_label: string | null }>
  return rows.map((r) => ({ text: r.text, pageNumber: null, sectionLabel: r.section_label }))
}

/**
 * Per-path summary of a pending import for the renderer's size-aware audio
 * confirmation (Phase 36, D35): how many supported files the selection expands to,
 * how many are audio, and the audio bytes (a stored copy + a full transcription are
 * real costs the user should consciously accept for large recordings).
 */
export interface ImportPreflight {
  fileCount: number
  audioFileCount: number
  audioBytes: number
}

export function summarizeImportPaths(paths: string[]): ImportPreflight {
  const files = expandPaths(paths)
  let audioFileCount = 0
  let audioBytes = 0
  for (const f of files) {
    if (!isAudioPath(f)) continue
    audioFileCount += 1
    try {
      audioBytes += statSync(f).size
    } catch {
      // Unreadable file: it will fail per-file during import; size 0 here.
    }
  }
  return { fileCount: files.length, audioFileCount, audioBytes }
}

/**
 * Re-run ingestion for an existing document (re-parse the stored copy). Clears any
 * persisted summary FIRST (Phase 33, D25): a re-index means the content may have
 * changed, so a summary derived from the old chunks must not survive — even if the
 * re-parse then fails. For AUDIO documents a re-index is a FULL RE-TRANSCRIPTION of
 * the stored copy (D35 — the transcript is not cached separately; documented in
 * known-limitations.md), with the same "Transcribing…" progress as the import.
 */
export async function reindexDocument(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: IngestionDeps = {}
): Promise<DocumentInfo> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  setDocumentSummary(db, documentId, null)
  setStatus(db, documentId, 'queued')
  return processDocument(db, storeDir, documentId, deps)
}

/**
 * Persist (or clear, with null) a document's one-click summary (Phase 33, D25).
 * The summary is CONTENT: it lives only in this (possibly encrypted) DB column —
 * callers must never put it into logs or the audit trail.
 */
export function setDocumentSummary(db: Db, documentId: string, summary: DocumentSummary | null): void {
  db.prepare('UPDATE documents SET summary_json = ?, updated_at = ? WHERE id = ?').run(
    summary ? JSON.stringify(summary) : null,
    nowIso(),
    documentId
  )
}

/** Read a document's persisted summary, or null (missing document included). */
export function getDocumentSummary(db: Db, documentId: string): DocumentSummary | null {
  const row = getRow(db, documentId)
  return row ? parseSummary(row.summary_json) : null
}

/**
 * Persist (or clear, with null) a document's OCR recognition (Phase 38). The pages
 * are CONTENT: they live only in this (possibly encrypted) DB column — callers must
 * never put them into logs or the audit trail. Survives re-index deliberately (like
 * `origin_json`: it states where the text CAME from; re-running the OCR task is the
 * explicit way to redo it).
 */
export function setDocumentOcr(
  db: Db,
  documentId: string,
  ocr: { pages: OcrPage[]; engineId: string; languages: string[] } | null
): void {
  const json = ocr
    ? JSON.stringify({
        pages: ocr.pages,
        engineId: ocr.engineId,
        languages: ocr.languages,
        createdAt: nowIso()
      })
    : null
  db.prepare('UPDATE documents SET ocr_json = ?, updated_at = ? WHERE id = ?').run(
    json,
    nowIso(),
    documentId
  )
}

/** Read a document's stored per-page recognition, or null. The text is CONTENT. */
export function getDocumentOcrPages(db: Db, documentId: string): OcrPage[] | null {
  const row = getRow(db, documentId)
  const stored = row ? parseOcr(row.ocr_json) : null
  return stored ? stored.pages : null
}

/**
 * Record a generated document's provenance (Phase 34 D27 / Phase 35 D28): `origin_json`
 * holds a `DocumentOrigin` (translation or compare). Also clears `original_path` — a materialized
 * document's "original" was a transient generated file that is shredded after import,
 * so a dangling path must not linger in the row. Provenance survives re-index
 * deliberately (it states where the document CAME from, not that it is in sync).
 */
export function setDocumentOrigin(db: Db, documentId: string, origin: DocumentOrigin): void {
  db.prepare(
    'UPDATE documents SET origin_json = ?, original_path = NULL, updated_at = ? WHERE id = ?'
  ).run(JSON.stringify(origin), nowIso(), documentId)
}

/** Read a document's provenance, or null (missing document / malformed JSON included). */
export function getDocumentOrigin(db: Db, documentId: string): DocumentOrigin | null {
  const row = getRow(db, documentId)
  return row ? parseOrigin(row.origin_json) : null
}

/** Plain-text formats `readStoredDocumentText` can export as-is (no layout re-render). */
const EXPORTABLE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.mdown',
  '.txt',
  '.text',
  '.log',
  '.csv',
  '.tsv'
])

/**
 * Read a TEXT document's stored content for export (Phase 34): materialized
 * translations are Markdown, so saving the stored copy verbatim IS the export. Only
 * plain-text formats are exportable this way (a PDF/DOCX stored copy is the original
 * binary, not text). In an encrypted workspace the `.enc` copy is decrypted to a
 * transient working file (`.parse` infix — covered by the startup crash sweep) that is
 * shredded on the way out; the plaintext leaves the main process only as the returned
 * string, which the caller writes to the user-chosen destination.
 */
export function readStoredDocumentText(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: Pick<IngestionDeps, 'cipher'> = {}
): { title: string; text: string } {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  const ext = extname(row.title).toLowerCase()
  if (!EXPORTABLE_TEXT_EXTENSIONS.has(ext)) {
    throw new Error('Only text documents (Markdown, TXT, CSV) can be exported this way.')
  }

  const cipher = deps.cipher ?? null
  const transients: string[] = []
  try {
    let source: string
    if (row.stored_path && existsSync(row.stored_path)) {
      if (row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
        if (!cipher) {
          throw new Error('This document is encrypted; unlock the workspace to export it.')
        }
        source = join(storeDir, `${documentId}.parse-export${ext}`)
        cipher.decryptFile(row.stored_path, source)
        transients.push(source)
      } else {
        source = row.stored_path
      }
    } else if (row.original_path && existsSync(row.original_path)) {
      source = row.original_path
    } else {
      throw new Error('The document file is no longer on disk. Re-import it to export.')
    }
    return { title: row.title, text: readFileSync(source, 'utf8') }
  } finally {
    for (const t of transients) shredFile(t)
  }
}

/**
 * Reset documents left in a non-terminal status by a previous run (the app was killed
 * mid-ingestion) to `failed`, so the UI never shows a perpetual "in progress" with no
 * running job. Only rows last touched BEFORE `beforeIso` are affected — a live in-session
 * job continuously bumps `updated_at` past process start, so its rows are protected.
 * Returns the number reset.
 */
export function reconcileStuckDocuments(db: Db, beforeIso: string): number {
  const res = db
    .prepare(
      `UPDATE documents SET status = 'failed', error_message = ?, updated_at = ?
       WHERE status IN ('queued','extracting','chunking','embedding') AND updated_at < ?`
    )
    .run('Ingestion was interrupted before it finished. Re-index to try again.', nowIso(), beforeIso)
  return Number(res.changes ?? 0)
}

/**
 * List all non-deleted documents, newest first, with their chunk counts. When
 * `activeEmbeddingModelId` is provided, each indexed document is flagged `staleEmbeddings`
 * if it has chunks but none embedded under the active model (an embedder switch left it
 * unsearchable until re-indexed).
 */
export function listDocuments(db: Db, activeEmbeddingModelId?: string | null): DocumentInfo[] {
  const rows = db
    .prepare("SELECT * FROM documents WHERE status != 'deleted' ORDER BY created_at DESC, rowid DESC")
    .all() as unknown as DocumentRow[]
  return rows.map((r) => {
    const chunkCount = chunkCountFor(db, r.id)
    let stale: boolean | undefined
    if (activeEmbeddingModelId && r.status === 'indexed' && chunkCount > 0) {
      stale = chunksEmbeddedUnder(db, r.id, activeEmbeddingModelId) === 0
    }
    return rowToInfo(r, chunkCount, stale)
  })
}

export function getDocument(db: Db, id: string): DocumentInfo | null {
  const row = getRow(db, id)
  return row ? rowToInfo(row, chunkCountFor(db, id)) : null
}

/**
 * Delete a document and everything derived from it: its chunks, embeddings, the
 * workspace copy on disk, and the row itself. The original file is never touched.
 */
export function deleteDocument(db: Db, id: string): void {
  const row = getRow(db, id)
  if (!row) return
  if (row.stored_path && existsSync(row.stored_path)) {
    try {
      rmSync(row.stored_path)
    } catch {
      // Best-effort: a locked/missing workspace copy must not block the DB cleanup.
    }
  }
  db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(id)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

/**
 * Expand a user selection (files and/or folders) into a flat list of files to import.
 * Folders are walked recursively, keeping only supported extensions; explicitly-picked
 * files are always included (an unsupported one surfaces later as a `failed` document).
 */
export function expandPaths(paths: string[]): string[] {
  const supported = new Set(supportedExtensions())
  const out: string[] = []
  const seen = new Set<string>()

  const add = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }

  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(full)
      else if (supported.has(extname(full).toLowerCase())) add(full)
    }
  }

  for (const p of paths) {
    let stat
    try {
      stat = statSync(p)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(p)
    else add(p)
  }
  return out
}
