import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { t } from '../../../shared/i18n'
import { tMain } from '../i18n'
import { type Db, prepareCached } from '../db'
import type {
  DocumentCollectionMembership,
  DocumentInfo,
  DocumentOcrInfo,
  DocumentOrigin,
  DocumentPreview,
  DocumentSummary,
  GeneratedProvenance,
  ImportDestination,
  IngestionStatus,
  ExtractStatus,
  TreeBuildStatus
} from '../../../shared/types'
import { sha256File } from '../models'
import { docLifecycle, fileFromPendingDestination } from '../collections'
import { type Embedder, encodeVector, invalidateResidentVectors } from '../embeddings'
import { ENCRYPTED_DOC_SUFFIX, shredFile, type DocumentCipher } from '../workspace-vault'
import { purgeSkillDataForDocument } from '../skills/run'
import type { Transcriber } from '../transcriber'
import type { OcrEngine, OcrPage } from '../ocr'
import {
  isAudioPath,
  isPdfPath,
  selectParser,
  supportedExtensions,
  type DocumentParser,
  type ParseContext,
  type ParsedDocument
} from './parsers'
import { PDF_SCAN_DETECTED_MESSAGE } from './parsers/pdf'
import { chunkSegments, MAX_CHUNKS_PER_DOCUMENT } from './chunker'
import { resolveIngestionLimits, withParseTimeout, type IngestionLimits } from './limits'

// Ingestion service (spec §7.7). Owns the document lifecycle:
//   queued → extracting → chunking → embedding → indexed   (failed on error)
// Persists to the `documents`, `chunks`, and `embeddings` tables (spec §8). Each file is
// COPIED into the workspace (`workspace/documents/`) so the drive is self-contained; both
// the workspace copy (`stored_path`) and the user's original location (`original_path`)
// are recorded. A failed file never crashes the run — it lands in `failed` with an
// `error_message`.
//
// The `embedding` step writes one vector per chunk into the `embeddings` table when an
// `Embedder` is supplied. It is optional: with no embedder the step is a pass-through
// (a document still reaches `indexed` with chunks but no vectors), so embedders can be
// swapped — or absent — without changing the pipeline.

/** Optional pipeline dependencies: embedding, encrypted storage, transcription, OCR. */
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
   * Transcriber for audio imports. Optional AND nullable: absent/null means an audio
   * FILE fails friendly with the download-the-model copy — text ingestion is
   * unaffected (graceful-fallback rule).
   */
  transcriber?: Transcriber | null
  /**
   * Coarse transcription progress (0–100) per document, surfaced by the IPC layer as
   * "Transcribing… N%" on the documents table polling path (import AND re-index).
   */
  onTranscribeProgress?: (documentId: string, percent: number) => void
  /**
   * OCR engine for photo imports. Optional AND nullable: absent/null means a photo
   * FILE fails friendly with the needs-the-OCR-files copy — text ingestion is
   * unaffected.
   */
  ocrEngine?: OcrEngine | null
  /**
   * Resource caps applied before a parser runs (security audit M-1/M-2/M-3): a
   * pre-parse byte ceiling, a parse wall-clock timeout, a PDF page cap, and a DOCX
   * inflated-size ceiling. Omit to use `resolveIngestionLimits()` (env-overridable
   * defaults). Injected mainly so tests can dial the caps down.
   */
  limits?: IngestionLimits
  /**
   * Cancellation for the parse phase (REL-1). Threaded to `ParseContext.signal` so an
   * aborted import KILLS an in-flight audio transcription mid-flight (the import loop
   * aborts this when the workspace locks mid-job). Optional: text parsers ignore it and
   * are bounded by `withParseTimeout`; the transcriber's inactivity watchdog still bounds
   * a wedged whisper child when no signal is supplied.
   */
  signal?: AbortSignal
}

// Canonical home of the `.enc` suffix is workspace-vault (the password change
// re-encrypts these sidecars); re-exported here for the existing import sites.
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
  // Audio — exactly the formats the pinned whisper-cli decodes.
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  // Photos — OCR'd on import (small, single image; PDFs need the explicit OCR task).
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
  lifecycle: string | null
  source_folder_label: string | null
  tree_status: string | null
  tree_meta_json: string | null
  fully_chunked: string | null
  extract_status: string | null
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
        truncated: v.truncated === true,
        // Coverage tier when the summary came from a ready deep index (1/2/3), else absent.
        ...(v.tier === 1 || v.tier === 2 || v.tier === 3 ? { tier: v.tier } : {})
      }
    }
  } catch {
    // fall through to null
  }
  return null
}

/** The valid `GeneratedProvenance.kind` values (used to narrow a parsed string). */
const GENERATED_KINDS = ['summary', 'translation', 'compare', 'transcript', 'other'] as const

/** Parse a stored origin (generated-document provenance); malformed JSON reads as null. */
function parseOrigin(json: string | null | undefined): DocumentOrigin | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown> | null
    if (!v || typeof v !== 'object') return null
    // NEW structured provenance (GeneratedProvenance, plan §15.1): a `kind` discriminator
    // plus `sourceDocumentIds`. Checked FIRST — new translation/compare rows carry no
    // legacy `type`/`translatedFrom`/`comparedFrom` fields, so they only match here.
    if (typeof v.kind === 'string' && Array.isArray(v.sourceDocumentIds)) {
      const kind = GENERATED_KINDS.find((k) => k === v.kind)
      const sourceDocumentIds = v.sourceDocumentIds.filter(
        (x): x is string => typeof x === 'string' && x.length > 0
      )
      if (!kind || sourceDocumentIds.length === 0) return null
      const out: GeneratedProvenance = {
        kind,
        sourceDocumentIds,
        // createdAt is tolerated when absent/odd (parseOcr precedent) — provenance must
        // still render; only the later staleness phase consumes it.
        createdAt: typeof v.createdAt === 'string' ? v.createdAt : ''
      }
      if (Array.isArray(v.sourceCollectionIds)) {
        const ids = v.sourceCollectionIds.filter(
          (x): x is string => typeof x === 'string' && x.length > 0
        )
        if (ids.length > 0) out.sourceCollectionIds = ids
      }
      if (typeof v.modelId === 'string' && v.modelId.length > 0) out.modelId = v.modelId
      return out
    }
    // Comparison provenance: both source ids, A/B order.
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
    // Translation provenance. Older rows persisted WITHOUT the `type` field
    // (translation was the only shape then) — they parse as 'translation' unchanged.
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
 * The stored OCR recognition: full per-page text (CONTENT — DB only, never
 * logs/audit) plus the surface metadata `DocumentInfo.ocr` exposes.
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
    // DERIVED scan marker: failed with the exact scan notice. The OCR task targets
    // exactly these rows (plus already-OCR'd PDFs for a re-run).
    scanDetected: row.status === 'failed' && row.error_message === PDF_SCAN_DETECTED_MESSAGE,
    ocr: ocrInfoOf(parseOcr(row.ocr_json)),
    // Document-organization (plan §8.2/§16): retention lifecycle (NULL ⇒ permanent) +
    // folder-import display label. Collection memberships are merged in by listDocuments
    // (it has the db handle for the join); getDocument/createQueuedDocument leave it absent.
    lifecycle: docLifecycle(row.lifecycle),
    sourceFolderLabel: row.source_folder_label,
    // Deep-index (summary-tree) state (whole-document-analysis plan §3.2/§5.2). Additive +
    // optional — old callers that never read these are byte-identical. `treeLevels` comes
    // from the ready tree's `tree_meta_json` (tolerant parse: a malformed blob ⇒ undefined).
    treeStatus: treeStatusOf(row.tree_status),
    fullyChunked: row.fully_chunked != null,
    treeLevels: treeLevelsOf(row.tree_meta_json),
    // Structured-extract pass state (Phase 3); same NULL-sentinel coalescing as tree_status.
    extractStatus: extractStatusOf(row.extract_status),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const TREE_BUILD_STATES: ReadonlySet<string> = new Set<TreeBuildStatus>([
  'pending',
  'building',
  'ready',
  'stale',
  'failed'
])

/** Coalesce the stored `tree_status` to the typed union (unknown/NULL ⇒ undefined). */
function treeStatusOf(raw: string | null): TreeBuildStatus | undefined {
  return raw && TREE_BUILD_STATES.has(raw) ? (raw as TreeBuildStatus) : undefined
}

const EXTRACT_STATES: ReadonlySet<string> = new Set<ExtractStatus>([
  'pending',
  'extracting',
  'ready',
  'stale',
  'failed'
])

/** Coalesce the stored `extract_status` to the typed union (unknown/NULL ⇒ undefined). */
function extractStatusOf(raw: string | null): ExtractStatus | undefined {
  return raw && EXTRACT_STATES.has(raw) ? (raw as ExtractStatus) : undefined
}

/** Levels from a ready tree's `tree_meta_json` (tolerant: malformed/absent ⇒ undefined). */
function treeLevelsOf(raw: string | null): number | undefined {
  if (!raw) return undefined
  try {
    const meta = JSON.parse(raw) as { levels?: unknown }
    return typeof meta.levels === 'number' && Number.isFinite(meta.levels) ? meta.levels : undefined
  } catch {
    return undefined
  }
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
 * Options for `createQueuedDocument` (document-organization plan §11.3, Phase C). All
 * optional; a bare string is accepted as a shorthand for `{ displayTitle }` so the
 * doctasks materialized-document caller stays unchanged.
 */
export interface CreateQueuedDocumentOptions {
  /**
   * Overrides the filename-derived title for app-GENERATED files imported from a transient
   * path (e.g. a materialized translation) — the title drives parser selection, the stored
   * copy's extension, and citation source labels, so it must be set BEFORE processing and
   * must keep a supported extension.
   */
  displayTitle?: string
  /**
   * Where this import should land (plan §11.3). Persisted into `pending_destination_json`
   * at queue time (M1) so a crash-and-restart re-files to the intended destination instead
   * of being swept into Library by the migration backfill. Applied on indexing SUCCESS via
   * `fileFromPendingDestination`. Omit ⇒ no recorded intent ⇒ Library default.
   */
  destination?: ImportDestination
  /**
   * Provenance for an app-GENERATED document (translation/comparison/transcript, plan
   * §15.1, D3/N1). Stamped into `origin_json` AT QUEUE TIME, before the row can ever be
   * `indexed`, so the Library backfill's `origin_json IS NULL` guard (db.ts) holds even if
   * the process is killed mid-import — a half-born work-product is never swept into Library
   * (DM-2). A generated row also gets NO membership; both together keep it explicit-id only.
   */
  origin?: DocumentOrigin
  /** Folder-import display metadata (N12; display-only). */
  sourceRelativePath?: string | null
  sourceFolderLabel?: string | null
}

/**
 * Insert a `queued` document row for `filePath` and return its DocumentInfo. The resolved
 * import destination + folder metadata are persisted on the row immediately (plan §11.3,
 * M1), before parse/embed.
 */
export function createQueuedDocument(
  db: Db,
  filePath: string,
  opts: string | CreateQueuedDocumentOptions = {}
): DocumentInfo {
  const o: CreateQueuedDocumentOptions = typeof opts === 'string' ? { displayTitle: opts } : opts
  const now = nowIso()
  const id = randomUUID()
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(filePath).size
  } catch {
    sizeBytes = null
  }
  const title = o.displayTitle ?? basename(filePath)
  db.prepare(
    `INSERT INTO documents
       (id, title, original_path, stored_path, mime_type, size_bytes, sha256, status, error_message,
        pending_destination_json, origin_json, source_relative_path, source_folder_label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    filePath,
    null,
    guessMime(title),
    sizeBytes,
    null,
    'queued',
    null,
    o.destination ? JSON.stringify(o.destination) : null,
    // Generated provenance is stamped HERE (before `indexed`) so the Library backfill never
    // sweeps a crash-interrupted work-product in (DM-2). original_path stays set — the parser
    // still needs the transient source on first index; setDocumentOrigin nulls it post-success.
    o.origin ? JSON.stringify(o.origin) : null,
    o.sourceRelativePath ?? null,
    o.sourceFolderLabel ?? null,
    now,
    now
  )
  return rowToInfo(getRow(db, id) as DocumentRow, 0)
}

/**
 * Result of the parse+chunk phase (`prepareDocument`), the front half of the ING-3 import
 * pipeline. `ready: true` ⇒ chunks are persisted and the document is in `embedding`; the
 * embed phase (`finalizeDocument`) may proceed. `ready: false` ⇒ prepare already captured a
 * failure on the row (`failed` + `error_message`), so the embed phase must be skipped.
 */
export interface PreparedDocument {
  documentId: string
  ready: boolean
}

/**
 * THE single parse-with-caps enforcement point (MAINT-4 / REL-5). Every parse entry point —
 * ingest (`prepareDocument`), the renderer preview (`extractDocumentPreview`), and the paged
 * preview (`extractDocumentPreviewPage`, via the former) — routes through here, so the resource
 * cap stack can never silently diverge per path again. REL-5 was exactly that divergence: the
 * preview re-parse threaded NONE of the caps (only `maxPages` in layout mode), so a 4000-page
 * PDF that import would have killed could wedge the main process on a user-triggered preview.
 *
 * It (1) injects the per-parser caps (M-2 `maxPages` / M-3 `maxInflatedBytes`) from `limits`
 * onto the context — a caller-set value (e.g. the layout seam's own page cap) WINS — and
 * (2) races the parse against the wall-clock timeout (M-2), EXCEPT for audio: a long recording
 * legitimately transcribes for many minutes and the whisper child manages its own lifecycle
 * (its inactivity watchdog + the caller's `signal`), so killing the wait would orphan the child
 * and reject valid imports. The caller's `signal` (REL-1 cancellation) and every other
 * caller-set field (transcriber, ocrEngine, ocrPages, onProgress, layout, …) are carried
 * through untouched.
 *
 * NOTE — the pre-parse BYTE ceiling (M-1) is intentionally NOT applied here: it is a cheap stat
 * the ingest path runs before parser selection, and the preview reads the already-import-capped
 * stored copy, so the byte ceiling is in force on both paths without a re-stat. The default
 * `timeoutMessage` is the persist-canonical English the ingest path writes to `error_message`;
 * the preview path overrides it with the localized `tMain(...)` emission (it is never persisted).
 */
export function parseWithLimits(
  parser: DocumentParser,
  source: string,
  ctx: ParseContext,
  limits: IngestionLimits,
  timeoutMessage: string = t('en', 'main.ingest.parseTimeout')
): Promise<ParsedDocument> {
  const cappedCtx: ParseContext = {
    ...ctx,
    maxPages: ctx.maxPages ?? limits.pdfMaxPages,
    maxInflatedBytes: ctx.maxInflatedBytes ?? limits.docxMaxInflatedBytes
  }
  if (isAudioPath(source)) return parser.parse(source, cappedCtx)
  return withParseTimeout(parser.parse(source, cappedCtx), limits.parseTimeoutMs, timeoutMessage)
}

/**
 * Parse + chunk phase (ING-3 pipeline, front half). Runs setup → parse → chunk → persist
 * chunks, leaving the document in `embedding`. CPU- and disk-bound; independent of the embed
 * sidecar (the embed phase reads the chunks back from the DB), so the import loop overlaps
 * one file's `prepareDocument` with the previous file's `finalizeDocument`. Never throws: a
 * failure is captured on the row and returned as `ready: false`.
 *
 * Splitting `processDocument` here is behavior-preserving: `processDocument` is just
 * `prepareDocument` then `finalizeDocument` back-to-back, and the split point is the
 * already-DB-mediated chunk↔embed boundary. Transient decrypted copies are shredded at the
 * end of THIS phase (the embed phase needs only the DB), strictly reducing plaintext lifetime.
 */
export async function prepareDocument(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: IngestionDeps = {}
): Promise<PreparedDocument> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)

  // Transient PLAINTEXT files created below (decrypted working copies in an encrypted
  // workspace). Always shredded on the way out — success or failure — so no decrypted
  // document content lingers on the drive.
  const transients: string[] = []

  const limits = deps.limits ?? resolveIngestionLimits()

  try {
    setStatus(db, documentId, 'extracting')

    // Pre-parse byte ceiling (M-1): reject an oversized file BEFORE any copy/decrypt/parse
    // work, using the size recorded at queue time. A friendly, persist-canonical message
    // lands on the row (display-mapped at render). A null size_bytes falls through to the
    // authoritative pre-parse stat below.
    if (row.size_bytes != null && row.size_bytes > limits.maxBytes) {
      throw new Error(t('en', 'main.ingest.fileTooLarge'))
    }

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
        // Persist-canonical English (i18n record §3.3 rule 1): the catch below writes
        // this into documents.error_message; the display map translates it (D-L4).
        throw new Error(t('en', 'main.ingest.sourceMissing'))
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

    // Authoritative pre-parse byte ceiling (M-1): the file the parser will actually read
    // (the decrypted transient in an encrypted workspace, or the source when size_bytes
    // was unknown at queue time). Cheap `statSync`; a stat failure here is non-fatal — the
    // parser will surface its own read error.
    try {
      if (statSync(parseSource).size > limits.maxBytes) {
        throw new Error(t('en', 'main.ingest.fileTooLarge'))
      }
    } catch (err) {
      if (err instanceof Error && err.message === t('en', 'main.ingest.fileTooLarge')) throw err
    }

    const parser = selectParser(row.title)
    if (!parser) {
      // Persist-canonical English (i18n record §3.3 rule 1): the catch writes it into
      // documents.error_message; the renderer display map localizes it (interpolated {ext}).
      throw new Error(t('en', 'main.ingest.unsupportedType', { ext: extname(row.title) || '(none)' }))
    }
    // Prefer the per-extension MIME (identical to parser.mimeType for the text formats;
    // gives audio its real type — audio/wav vs the AudioParser's `audio/*` fallback).
    db.prepare('UPDATE documents SET mime_type = ? WHERE id = ?').run(
      guessMime(row.title) ?? parser.mimeType,
      documentId
    )

    // Parse context (additive — text parsers ignore it): the injected
    // transcriber + OCR engine, the documents dir for content transients, per-document
    // progress, and — for a previously-OCR'd PDF — the stored per-page recognition so
    // a re-index reuses it instead of failing scan detection again.
    const parseCtx: ParseContext = {
      transcriber: deps.transcriber,
      ocrEngine: deps.ocrEngine,
      ocrPages: isPdfPath(row.title) ? getDocumentOcrPages(db, documentId) : null,
      workDir: storeDir,
      onProgress: (percent) => deps.onTranscribeProgress?.(documentId, percent),
      // REL-1: cancellation for an unbounded audio transcription. Audio stays EXEMPT from
      // the wall-clock parse timeout, so the signal (+ the transcriber's own idle watchdog)
      // is the only way to stop a wedged/cancelled whisper child.
      signal: deps.signal
      // Per-parser caps (M-2/M-3) and the audio-exempt wall-clock timeout are applied by
      // parseWithLimits — the ONE cap-enforcement point shared with the preview path (MAINT-4).
    }
    const parsed = await parseWithLimits(parser, parseSource, parseCtx, limits)

    setStatus(db, documentId, 'chunking')
    // Over-cap gate (whole-document-analysis plan C1/C2/M13). Chunk with cap + 1 so an
    // over-cap document is DETECTABLE, then reject it BEFORE the destructive chunk
    // replacement below. Failing first keeps a re-index of an over-cap document (the C4
    // legacy-re-index flow) from deleting its existing searchable chunks and ending up
    // `failed`/zero-chunk — the gate fails CLOSED, preserving the prior index. A document
    // that passes is fully chunked (the whole document), recorded by `fully_chunked` on
    // indexing success below.
    const chunks = chunkSegments(parsed.segments, { maxChunks: MAX_CHUNKS_PER_DOCUMENT + 1 })
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      // Clear any stale `fully_chunked` from a PRIOR successful index: the document now
      // exceeds the cap, so its preserved (older, smaller) chunks are no longer "the whole
      // document" — keeping the marker would let a future consumer over-claim coverage (C4).
      // The throw fires before the chunk DELETE, so the old chunks stay searchable (M13).
      db.prepare('UPDATE documents SET fully_chunked = NULL WHERE id = ?').run(documentId)
      // Persist-canonical English (i18n record §3.3 rule 1): the catch writes it into
      // documents.error_message; the renderer display map translates it (D-L4).
      throw new Error(t('en', 'main.ingest.tooManyChunks'))
    }

    // Replace any prior chunks (supports re-indexing) then insert fresh. DB-1: wrap the whole
    // delete-then-insert phase in ONE transaction. With WAL + synchronous=NORMAL each bare
    // run() is otherwise its own fsync'd auto-commit, and every chunk also fires the
    // `chunks_fts_ai` FTS trigger inside that commit — up to ~1000 chunk inserts + their FTS
    // writes = ~2000 individually fsync'd commits per document on USB. One BEGIN…COMMIT
    // collapses that to a single commit. Pattern: tree-build.ts:148-164 / node-vectors.ts:156
    // (synchronous inserts only inside; the async embed await stays outside, below).
    db.exec('BEGIN')
    try {
      db.prepare(
        'DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)'
      ).run(documentId)
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
      // Tear down a now-orphaned summary tree (whole-document-analysis plan H1/H2): re-index
      // recreates chunks with fresh ids, so the tree's polymorphic chunk edges would dangle.
      // Deleting the nodes cascades the edges (FK on parent_id); the expensive model output
      // survives in `summary_cache` (keyed by text, not chunk id), so the next build reuses
      // every unchanged group. `tree_status` → 'stale' when a tree existed (UI offers a
      // rebuild), else clear it. extraction_records self-cascade via chunk_id (Phase 3).
      // ING-7 (perf audit 2026-06-18): read tree_status + extract_status in ONE SELECT and reset
      // both in ONE UPDATE, instead of a separate read+write per column (four statements → two)
      // inside this hot re-index transaction. The structured-extract rows (Phase 3) self-cascade
      // via chunk_id ON DELETE CASCADE when the chunks are deleted above (H1 free win) — no manual
      // DELETE needed. Each status → 'stale' when one existed (UI offers a rebuild/re-extract over
      // the now-empty pass) rather than a stale 'ready' over zero rows, else clear it.
      const prev = db
        .prepare('SELECT tree_status, extract_status FROM documents WHERE id = ?')
        .get(documentId) as unknown as
        | { tree_status: string | null; extract_status: string | null }
        | undefined
      db.prepare('DELETE FROM tree_nodes WHERE document_id = ?').run(documentId)
      db.prepare('UPDATE documents SET tree_status = ?, extract_status = ? WHERE id = ?').run(
        prev?.tree_status ? 'stale' : null,
        prev?.extract_status ? 'stale' : null,
        documentId
      )

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
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* connection may already be clean */
      }
      throw err
    }
    // RAG-6 (Wave P4) belt: the chunk-phase transaction above DELETEd this doc's stale
    // embeddings (re-index path), so drop the resident decoded-vector cache. The signature
    // check would also catch it; this is the explicit hook that closes the delete-then-equal-
    // reinsert blind spot and keeps the cache robust to any write through this path.
    invalidateResidentVectors(db)

    // ING-3 pipeline boundary: chunks are now persisted and the document is in `embedding`.
    // The embed phase (finalizeDocument) reads the chunks back from the DB, so this phase is
    // independent of the embed sidecar — the import loop overlaps prepare(N+1) with
    // finalizeDocument(N). The DELETE above already cleared stale vectors, so a re-index
    // re-embeds cleanly.
    setStatus(db, documentId, 'embedding')
    return { documentId, ready: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus(db, documentId, 'failed', message)
    return { documentId, ready: false }
  } finally {
    // Shred transient decrypted copies whether parse succeeded or failed — the embed phase
    // reads chunk text from the DB, not these files, so they are no longer needed.
    for (const t of transients) shredFile(t)
  }
}

/**
 * Embed + finalize phase (ING-3 pipeline, back half). Embeds the chunks `prepareDocument`
 * persisted (the embed sidecar is the single contended resource — never run two of these
 * concurrently) and marks the document `indexed`. Never throws: an embed failure is captured
 * on the row as `failed` + `error_message`. A `prepared.ready === false` input means prepare
 * already failed the document, so this is a no-op that returns the failed info.
 */
export async function finalizeDocument(
  db: Db,
  documentId: string,
  deps: IngestionDeps,
  prepared: PreparedDocument
): Promise<DocumentInfo> {
  if (!prepared.ready) return infoOrDeleted(db, documentId)
  try {
    // Embedding step: vectorize each chunk and persist to `embeddings`. prepareDocument's
    // DELETE already cleared stale vectors, so re-index re-embeds cleanly.
    if (deps.embedder) {
      await embedChunks(db, documentId, deps.embedder, deps.embeddingModelId ?? deps.embedder.id)
    }

    setStatus(db, documentId, 'indexed')
    // C4: mark the document fully chunked. This is the ONE indexing-success site (every
    // path — import loop, reindexDocument, OCR re-ingest, materializeDocument — funnels
    // through here), and a success now always passed the over-cap gate above, so the
    // marker proves "the stored chunks ARE the whole document". A NULL marker means a
    // legacy (pre-Phase-1, maybe silently truncated) index; deep-index / 100%-coverage
    // are gated on it (a legacy doc re-indexes first, which sets it or fails over-cap).
    const indexedAt = nowIso()
    db.prepare('UPDATE documents SET fully_chunked = ?, updated_at = ? WHERE id = ?').run(
      indexedAt,
      indexedAt,
      documentId
    )
    return infoOrDeleted(db, documentId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus(db, documentId, 'failed', message)
    return infoOrDeleted(db, documentId)
  }
}

/**
 * Run the full ingestion pipeline for one already-`queued` document. Never throws:
 * any failure is captured on the document row as `failed` + `error_message`, and the
 * resulting DocumentInfo is returned so the caller can report it.
 *
 * Single-shot composition of the two ING-3 phases (`prepareDocument` then
 * `finalizeDocument`); behavior-identical to the pre-split monolith. The import loop calls
 * the two phases directly to pipeline them; reindex / OCR re-ingest / materialize use this.
 */
export async function processDocument(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: IngestionDeps = {}
): Promise<DocumentInfo> {
  const prepared = await prepareDocument(db, storeDir, documentId, deps)
  return finalizeDocument(db, documentId, deps, prepared)
}

/**
 * Resolve the final DocumentInfo, tolerating a row that vanished mid-pipeline (e.g. the
 * document was deleted while processing). `processDocument` promises to never throw, so
 * a missing row yields a synthetic `deleted` info instead of a TypeError.
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

  // The async embed runs OUTSIDE the transaction (node-vectors.ts:156 precedent) — only the
  // synchronous inserts go inside. DB-1: one BEGIN…COMMIT collapses up to ~1000 individually
  // fsync'd embedding-insert auto-commits into a single commit (the dominant USB import cost).
  const vectors = await embedder.embed(rows.map((r) => r.text))
  const insert = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const created = nowIso()
  db.exec('BEGIN')
  try {
    for (let i = 0; i < rows.length; i++) {
      const vec = vectors[i]
      insert.run(rows[i].id, embeddingModelId, encodeVector(vec), vec.length, created)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* connection may already be clean */
    }
    throw err
  }
  // RAG-6 (Wave P4) belt: fresh vectors were just INSERTed — drop the resident decoded-vector
  // cache so the next search rebuilds it including them (the signature check also catches the
  // raised row count / maxRowid; this is the explicit hook).
  invalidateResidentVectors(db)
}

/**
 * Read-only in-app preview: re-extract the document's text segments from the
 * self-contained stored copy (falling back to the original file if the copy is gone).
 * Re-parses instead of reading the `chunks` table because chunks OVERLAP (~80 tokens) —
 * concatenating them would duplicate text at every boundary. In an encrypted workspace
 * the stored `.enc` copy is decrypted to a transient working file that is shredded on
 * the way out (same pattern as re-indexing; the `.parse` infix keeps it covered by the
 * startup `shredStalePlaintext` crash sweep). Never writes to the DB; the plaintext
 * never leaves the main process except as extracted text over IPC.
 */
/**
 * Re-extraction options (PDF geometry-extraction plan §3.1/§3.3). Additive — the renderer preview,
 * translate, and compare callers omit it and get byte-unchanged reading-order text. Only the
 * bank-statement analysis seam sets `layout` (D58) to request geometry-aware row/column reconstruction.
 */
export interface ExtractPreviewOptions {
  /** Reconstruct visual rows/columns from PDF word coordinates (bank-statement only, D58/D51). */
  layout?: boolean
  /** Page cap for the layout path (plan §3.1) — threaded only when `layout` is set. */
  maxPages?: number
  /**
   * Resource caps for the preview re-parse (REL-5). The preview now enforces the SAME cap stack
   * as ingest, via `parseWithLimits`. Omit → `resolveIngestionLimits()` (env-overridable
   * defaults). Injected mainly so tests can dial the caps down to prove the preview is bounded.
   */
  limits?: IngestionLimits
}

export async function extractDocumentPreview(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: Pick<IngestionDeps, 'cipher' | 'ocrEngine'> = {},
  opts: ExtractPreviewOptions = {}
): Promise<DocumentPreview> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  const parser = selectParser(row.title)
  if (!parser) {
    // Emission (§3.3 rule 2): an IPC throw, never persisted — localized via tMain.
    throw new Error(tMain('main.ingest.unsupportedType', { ext: extname(row.title) || '(none)' }))
  }

  // Audio: re-extraction reads the stored CHUNKS, not the file — re-parsing
  // would re-run the whole transcription (minutes of CPU) just to show text. Exact by
  // construction: every audio chunk is one packed transcript segment, verbatim, with no
  // overlap (AudioParser caps packed segments below the chunk window), so unlike the
  // overlapping text-format chunks these concatenate losslessly. This also serves the
  // doc-task re-extraction path (translate/compare a transcript without re-transcribing).
  if (isAudioPath(row.title)) {
    const segments = audioSegmentsFromChunks(db, documentId)
    if (segments.length === 0) {
      // Emission (§3.3 rule 2): an IPC throw, never persisted — localized via tMain.
      throw new Error(tMain('main.docs.noStoredTranscript'))
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
        // Emission (§3.3 rule 2): IPC throws below are transient — localized via tMain.
        throw new Error(tMain('main.docs.previewEncrypted'))
      } else {
        parseSource = row.stored_path
      }
    } else if (row.original_path && existsSync(row.original_path)) {
      parseSource = row.original_path
    } else {
      throw new Error(tMain('main.docs.previewGone'))
    }

    // An OCR'd PDF previews its STORED recognition (the same ocrPages hook
    // re-index uses — never a silent re-OCR); a photo re-recognizes the stored copy
    // (one small image, the audio-preview trade-off inverted: cheap enough to redo).
    const previewCtx: ParseContext = {
      ocrEngine: deps.ocrEngine,
      ocrPages: isPdfPath(row.title) ? getDocumentOcrPages(db, documentId) : null,
      // Geometry-aware layout reconstruction (plan §3.1, D51) — opt-in, bank-statement-only (D58).
      // In layout mode the caller passes its own page cap; otherwise parseWithLimits injects the
      // default `pdfMaxPages` below — REL-5: the preview path now caps too (it formerly ran uncapped).
      ...(opts.layout ? { layout: true, maxPages: opts.maxPages } : {})
    }
    // REL-5 / MAINT-4: route the preview re-parse through the SAME cap stack as ingest
    // (`maxPages` + `maxInflatedBytes` + a wall-clock timeout). A pathological-but-indexed file can
    // no longer wedge the main process on a "Show more". The timeout message is a TRANSIENT IPC
    // emission (§3.3 rule 2) — localized via tMain, never persisted (unlike the ingest path's English).
    const parsed = await parseWithLimits(
      parser,
      parseSource,
      previewCtx,
      opts.limits ?? resolveIngestionLimits(),
      tMain('main.ingest.parseTimeout')
    )
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

/** FE-6: default preview page size — segments returned per renderer-facing page request. */
export const DEFAULT_PREVIEW_PAGE_SIZE = 50

/**
 * FE-6 (perf audit 2026-06-18, Wave P5): the RENDERER-facing preview reader — returns a BOUNDED
 * page of segments (`offset .. offset+limit`) plus a cursor, so a large PDF/transcript no longer
 * crosses the IPC bridge as one giant JSON blob nor mounts every segment at once. Internal
 * full-text callers (skills, compare/translate) keep using `extractDocumentPreview` and get ALL
 * segments — this is a thin paging wrapper around it and changes nothing for them.
 *
 * TRADE-OFF (documented): there is no partial parse, so each page request re-extracts the whole
 * document and slices. The common case — a user glancing at the first page — is strictly better
 * than before (same single parse, tiny payload); only a user reading a huge document page-by-page
 * pays a re-parse per "show more", bounded to one parse per interaction (what the old code paid
 * up front anyway). `requireNotProcessing` guards the doc against concurrent re-ingestion, and the
 * parse is deterministic, so `totalSegments` and the slices are stable across page calls.
 */
export async function extractDocumentPreviewPage(
  db: Db,
  storeDir: string,
  documentId: string,
  offset: number,
  limit: number,
  deps: Pick<IngestionDeps, 'cipher' | 'ocrEngine'> = {},
  opts: ExtractPreviewOptions = {}
): Promise<DocumentPreview> {
  // REL-5: forward the cap stack so EACH "Show more" page re-parse is bounded (the whole-document
  // re-extract this paging wrapper does per call now enforces maxPages/maxInflatedBytes + timeout).
  const full = await extractDocumentPreview(db, storeDir, documentId, deps, opts)
  const safeOffset = Math.max(0, Math.floor(offset))
  const safeLimit = Math.max(1, Math.floor(limit))
  const end = safeOffset + safeLimit
  return {
    id: full.id,
    title: full.title,
    mimeType: full.mimeType,
    segments: full.segments.slice(safeOffset, end),
    totalSegments: full.segments.length,
    nextOffset: end < full.segments.length ? end : null
  }
}

/**
 * A transcript document's segments, rebuilt from its stored chunks (see the audio
 * branch in `extractDocumentPreview` for why this is exact for audio only).
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
 * confirmation: how many supported files the selection expands to,
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
 * persisted summary FIRST: a re-index means the content may have changed, so a
 * summary derived from the old chunks must not survive — even if the re-parse then
 * fails. For AUDIO documents a re-index is a FULL RE-TRANSCRIPTION of the stored
 * copy (the transcript is not cached separately; documented in
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
  const info = await processDocument(db, storeDir, documentId, deps)
  // M1 crash-resume: a crash-interrupted import is re-driven to `indexed` through HERE (the
  // user clicks Re-index on the reconciled `failed` row), NOT through the in-session import
  // loop. So filing-by-pending-destination must happen on this path too, or the doc loses
  // its Project/Temporary/conversation intent and the next backfill sweeps it into Library.
  // `fileFromPendingDestination` is idempotent (Library is unfiled-guarded, pending cleared
  // on first success, generated docs skipped), so a normal re-index of an already-filed doc
  // is a no-op — making this a true single indexing-success entry point.
  if (info.status === 'indexed') fileFromPendingDestination(db, documentId)
  return info
}

/**
 * Persist (or clear, with null) a document's one-click summary.
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
  // DB-8 (perf audit 2026-06-18): project ONLY `summary_json` — the targeted getters must not
  // pull the whole wide row (esp. the potentially large `ocr_json`) just to read one TEXT field.
  const row = db
    .prepare('SELECT summary_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as { summary_json: string | null } | undefined
  return row ? parseSummary(row.summary_json) : null
}

/**
 * Persist (or clear, with null) a document's OCR recognition. The pages
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
  // DB-8: project ONLY `ocr_json` (this getter is the one that genuinely needs the big column;
  // projecting still avoids reading summary_json/origin_json/… alongside it).
  const row = db
    .prepare('SELECT ocr_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as { ocr_json: string | null } | undefined
  const stored = row ? parseOcr(row.ocr_json) : null
  return stored ? stored.pages : null
}

/**
 * Record a generated document's provenance: `origin_json`
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
  // DB-8: project ONLY `origin_json` — `getDocumentOrigin` is on per-compare/per-doc paths and
  // never needs the wide row (the old `SELECT *` pulled `ocr_json` for nothing).
  const row = db
    .prepare('SELECT origin_json FROM documents WHERE id = ?')
    .get(documentId) as unknown as { origin_json: string | null } | undefined
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
 * Read a TEXT document's stored content for export: materialized
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
    // Emission (§3.3 rule 2): IPC throws below are transient — localized via tMain.
    throw new Error(tMain('main.docs.exportTextOnly'))
  }

  const cipher = deps.cipher ?? null
  const transients: string[] = []
  try {
    let source: string
    if (row.stored_path && existsSync(row.stored_path)) {
      if (row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)) {
        if (!cipher) {
          throw new Error(tMain('main.docs.exportEncrypted'))
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
      throw new Error(tMain('main.docs.exportGone'))
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
    // Persist-canonical English (i18n record §3.3 rule 1) — display-mapped at render.
    .run(t('en', 'main.ingest.interrupted'), nowIso(), beforeIso)
  return Number(res.changes ?? 0)
}

/**
 * Reset summary trees left `building` by a previous run (the app was killed or the
 * workspace locked mid-build) to `pending` so the build can resume (discard the partial
 * tree + rebuild from the warm `summary_cache`). Mirror of `reconcileStuckDocuments`:
 * only rows last touched BEFORE `beforeIso` are affected, so a live in-session build —
 * which bumps `updated_at` when it persists `building` — is protected, and the caller
 * additionally gates on "no active task" (whole-document-analysis plan §3.2/§4.1).
 * Returns the number reset. Content-free (ids/counts only).
 */
export function reconcileStuckTrees(db: Db, beforeIso: string): number {
  const res = db
    .prepare(
      `UPDATE documents SET tree_status = 'pending', updated_at = ?
       WHERE tree_status = 'building' AND updated_at < ?`
    )
    .run(nowIso(), beforeIso)
  return Number(res.changes ?? 0)
}

/**
 * Reset structured-extract passes left `extracting` by a previous run (killed/locked
 * mid-pass) to `pending` so the pass can resume — the per-chunk extract pass is resumable
 * (already-scanned chunks are skipped via their `__scan__` marker, 0 model calls; plan §3.3/
 * §4.2, Phase 3). Mirror of `reconcileStuckTrees`: only rows last touched BEFORE `beforeIso`
 * are affected (a live in-session pass bumps `updated_at`), and the caller gates on "no active
 * task". Returns the number reset. Content-free (ids/counts only).
 */
export function reconcileStuckExtracts(db: Db, beforeIso: string): number {
  const res = db
    .prepare(
      `UPDATE documents SET extract_status = 'pending', updated_at = ?
       WHERE extract_status = 'extracting' AND updated_at < ?`
    )
    .run(nowIso(), beforeIso)
  return Number(res.changes ?? 0)
}

/**
 * List all non-deleted documents, newest first, with their chunk counts. When
 * `activeEmbeddingModelId` is provided, each indexed document is flagged `staleEmbeddings`
 * if it has chunks but none embedded under the active model (an embedder switch left it
 * unsearchable until re-indexed).
 */
export function listDocuments(db: Db, activeEmbeddingModelId?: string | null): DocumentInfo[] {
  const rows = prepareCached(
    db,
    "SELECT * FROM documents WHERE status != 'deleted' ORDER BY created_at DESC, rowid DESC"
  ).all() as unknown as DocumentRow[]
  // One join for every membership (document-organization plan §16/§18 — one extra indexed
  // join, not N+1), grouped by document for the per-row `collections` chips.
  const memberships = new Map<string, DocumentCollectionMembership[]>()
  const memberRows = prepareCached(
    db,
    `SELECT dc.document_id AS documentId, c.id AS id, c.name AS name, c.type AS type, dc.role AS role
       FROM document_collections dc JOIN collections c ON c.id = dc.collection_id`
  ).all() as Array<{ documentId: string; id: string; name: string; type: string; role: string }>
  for (const m of memberRows) {
    const list = memberships.get(m.documentId) ?? []
    list.push({
      id: m.id,
      name: m.name,
      type: m.type as DocumentCollectionMembership['type'],
      role: m.role as DocumentCollectionMembership['role']
    })
    memberships.set(m.documentId, list)
  }
  // DB-3/ING-2 (perf audit 2026-06-18): chunk counts + the per-doc stale-embeddings check in TWO
  // grouped queries loaded into Maps, NOT a per-row COUNT + COUNT-JOIN (the old 1+2N pattern,
  // polled during import) — mirroring the memberships join just above. A document absent from a
  // map has zero (no chunks / nothing embedded under the active model).
  const chunkCounts = new Map<string, number>()
  for (const c of prepareCached(
    db,
    'SELECT document_id AS documentId, COUNT(*) AS n FROM chunks GROUP BY document_id'
  ).all() as Array<{ documentId: string; n: number }>) {
    chunkCounts.set(c.documentId, c.n)
  }
  const embeddedCounts = new Map<string, number>()
  if (activeEmbeddingModelId) {
    for (const e of prepareCached(
      db,
      `SELECT c.document_id AS documentId, COUNT(*) AS n
         FROM embeddings e JOIN chunks c ON e.chunk_id = c.id
         WHERE e.embedding_model_id = ?
         GROUP BY c.document_id`
    ).all(activeEmbeddingModelId) as Array<{ documentId: string; n: number }>) {
      embeddedCounts.set(e.documentId, e.n)
    }
  }
  return rows.map((r) => {
    const chunkCount = chunkCounts.get(r.id) ?? 0
    let stale: boolean | undefined
    if (activeEmbeddingModelId && r.status === 'indexed' && chunkCount > 0) {
      stale = (embeddedCounts.get(r.id) ?? 0) === 0
    }
    return { ...rowToInfo(r, chunkCount, stale), collections: memberships.get(r.id) ?? [] }
  })
}

export function getDocument(db: Db, id: string): DocumentInfo | null {
  const row = getRow(db, id)
  return row ? rowToInfo(row, chunkCountFor(db, id)) : null
}

/**
 * Delete every DB row DERIVED from a document, in FK order, EXCEPT the `documents` row itself
 * (the caller deletes that last, inside the same transaction). This is the single authoritative
 * list of "everything hanging off a document" (audit MAINT-1) so a teardown can't miss a table the
 * way `deleteDocument` historically missed the bank/invoice tables (audit DATA-1):
 *
 *   embeddings → chunks → tree_nodes → bank/invoice extraction rows (`purgeSkillDataForDocument`).
 *
 * Tables that declare `ON DELETE CASCADE` to `documents` (`document_collections`,
 * `conversation_documents`, `extraction_records`, and `tree_nodes` on fresh schemas) need no manual
 * delete — the final `DELETE FROM documents` removes them. `tree_nodes` is cleared explicitly here
 * anyway, mirroring the re-index teardown, so this list stays complete on every drive. The
 * bank/invoice tables carry no documents-CASCADE on drives created before the DATA-1 fix, so their
 * ordered delete is load-bearing there, not a belt. ids only — content is never logged/audited.
 */
function purgeDocumentDerivatives(db: Db, id: string): void {
  db.prepare(
    'DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)'
  ).run(id)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
  // Summary-tree nodes cascade their edges (FK on parent_id); cleared explicitly to keep the list
  // complete (on fresh schemas tree_nodes also cascades from documents — harmless double-cover).
  db.prepare('DELETE FROM tree_nodes WHERE document_id = ?').run(id)
  // Tier-2 skill content tables (bank_statements/invoices + children): NO documents-CASCADE on
  // existing drives, so this ordered delete is what closes DATA-1.
  purgeSkillDataForDocument(db, id)
}

/**
 * Delete a document and everything derived from it: its chunks, embeddings, summary tree, any
 * bank/invoice extraction rows, the workspace copy on disk, and the row itself. The original file
 * (the user's own location) is never touched.
 *
 * Atomicity (audit DATA-1): all DB deletes run in ONE transaction so a future FK miss rolls back
 * instead of half-committing. The on-disk shred runs ONLY AFTER the DB commit — never destroy the
 * workspace copy while the row delete could still fail, which is exactly the window that left a
 * corrupt, undeletable document when a bank/invoice extraction blocked the (un-transacted) delete.
 */
export function deleteDocument(db: Db, id: string): void {
  const row = getRow(db, id)
  if (!row) return
  db.exec('BEGIN')
  try {
    purgeDocumentDerivatives(db, id)
    // Membership (document_collections) + chat-attachment (conversation_documents) +
    // extraction_records rows cascade away via ON DELETE CASCADE (plan C4 / H1) — no manual
    // cleanup needed here.
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure as the thrown error */
    }
    throw err
  }
  // The DB delete committed. Now shred (overwrite-then-unlink) the workspace copy rather than a bare
  // unlink (plan M5). Best-effort: a locked/missing copy must not resurrect the already-deleted DB
  // rows. Shredding AFTER the commit closes the DATA-1 window where the file was destroyed before a
  // failing delete left a row with no chunks and no stored file.
  if (row.stored_path && existsSync(row.stored_path)) {
    shredFile(row.stored_path)
  }
  // RAG-6 (Wave P4) belt: this doc's vectors were just DELETEd — drop the resident
  // decoded-vector cache (closes the delete-then-equal-reinsert signature blind spot).
  invalidateResidentVectors(db)
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

  // ING-4 (perf audit 2026-06-18, Wave P5): walk with `withFileTypes` so dir-vs-file is known
  // from the readdir syscall itself — ONE syscall per entry instead of readdir + a per-entry
  // statSync. On USB each statSync is a real seek, so for a large tree this halves the walk's
  // syscalls (the common, non-symlink case). SUBTLETY: a Dirent does NOT follow symlinks (a
  // symlink reports isSymbolicLink(), never isDirectory()/isFile()), whereas the old statSync
  // DID follow them — a symlink to a directory was walked, a symlink to a supported file was
  // added (intentional, audit L3/L5). So only plain dirs/files use the cheap Dirent type;
  // anything else (a symlink, or a special entry) falls back to statSync(full) to reproduce the
  // exact follow-the-link expansion set. Net: same set of files, fewer syscalls in the common case.
  // REL-9: real paths of the directories on the CURRENT recursion path — the cycle guard.
  // A symlinked directory can resolve back into one of its own ancestors (`a/loop -> ..`), and
  // the link-following fallback below would then recurse on it forever → stack overflow on a
  // hostile/looped tree (user-initiated, but a self-referential tree hangs the walk). Skipping a
  // dir whose real path already appears on the path defeats EXACTLY the cycle while leaving every
  // terminating (acyclic) walk's expansion set byte-identical: a symlink to a DISTINCT directory
  // is not an ancestor, so it is still followed (the intended ING-4 link-following behaviour).
  const onPath = new Set<string>()
  const walk = (dir: string): void => {
    // realpathSync collapses the link chain to the cycle's identity; a failure (race/permission)
    // falls back to the literal path so a normal dir is still walked.
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      real = dir
    }
    if (onPath.has(real)) return
    onPath.add(real)
    try {
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          if (supported.has(extname(full).toLowerCase())) add(full)
        } else {
          // Symlink or special entry — resolve it the old (link-following) way so the expanded
          // set is byte-identical to the pre-ING-4 statSync walk.
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
    } finally {
      onPath.delete(real)
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

/** An expanded file with its folder-import display metadata (plan §11.2, N12). */
export interface ExpandedFile {
  path: string
  /** Path relative to the picked top-level folder root, or null for a picked file. */
  sourceRelativePath: string | null
  /** The picked top-level folder's name, or null for a picked file. */
  sourceFolderLabel: string | null
}

/**
 * Expand a selection like `expandPaths`, additionally capturing folder-import display
 * metadata (plan §11.2): for a picked DIRECTORY, `sourceFolderLabel` is that directory's
 * name and `sourceRelativePath` is each walked file's path relative to it; a picked FILE
 * carries no metadata. **Display-only** (the stored copy is always
 * `workspace/documents/<id><ext>`); never used for any file I/O.
 *
 * L3 symlink/basename fallback: `expandPaths`/`statSync` follow symlinks, so a symlinked
 * entry can resolve outside the picked root and produce a relative path with `..` or a
 * different drive root. When the relative path can't be cleanly computed, fall back to the
 * bare basename. The order matches `expandPaths` (dedup by absolute path; first wins).
 */
export function expandPathsWithSource(paths: string[]): ExpandedFile[] {
  const flat = expandPaths(paths)
  // Map each picked DIRECTORY to its label, longest-prefix-first so a nested pick wins.
  const roots: Array<{ dir: string; label: string }> = []
  for (const p of paths) {
    try {
      if (statSync(p).isDirectory()) roots.push({ dir: p, label: basename(p) || p })
    } catch {
      // Unreadable pick — its files never made it into `flat` anyway.
    }
  }
  roots.sort((a, b) => b.dir.length - a.dir.length)

  const cleanRelative = (root: string, file: string): string => {
    const rel = relative(root, file)
    // A `..` escape or an absolute result (different drive on Windows) ⇒ basename fallback.
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return basename(file)
    return rel
  }

  return flat.map((path) => {
    // Match on a separator boundary, not a raw string prefix, so a file under `…\taxes`
    // can't false-attribute its folder label to a sibling picked root `…\tax` (DM-3).
    const root = roots.find((r) => path === r.dir || path.startsWith(r.dir + sep))
    return root
      ? { path, sourceRelativePath: cleanRelative(root.dir, path), sourceFolderLabel: root.label }
      : { path, sourceRelativePath: null, sourceFolderLabel: null }
  })
}
