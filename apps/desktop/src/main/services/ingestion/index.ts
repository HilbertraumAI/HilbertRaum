import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Db } from '../db'
import type { DocumentInfo, DocumentPreview, IngestionStatus } from '../../../shared/types'
import { sha256File } from '../models'
import { type Embedder, encodeVector } from '../embeddings'
import { ENCRYPTED_DOC_SUFFIX, shredFile, type DocumentCipher } from '../workspace-vault'
import { selectParser, supportedExtensions } from './parsers'
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
  '.tsv': 'text/csv'
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

/** Insert a `queued` document row for `filePath` and return its DocumentInfo. */
export function createQueuedDocument(db: Db, filePath: string): DocumentInfo {
  const now = nowIso()
  const id = randomUUID()
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(filePath).size
  } catch {
    sizeBytes = null
  }
  db.prepare(
    `INSERT INTO documents
       (id, title, original_path, stored_path, mime_type, size_bytes, sha256, status, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, basename(filePath), filePath, null, guessMime(filePath), sizeBytes, null, 'queued', null, now, now)
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
    db.prepare('UPDATE documents SET mime_type = ? WHERE id = ?').run(parser.mimeType, documentId)

    const parsed = await parser.parse(parseSource)

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
  deps: Pick<IngestionDeps, 'cipher'> = {}
): Promise<DocumentPreview> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  const parser = selectParser(row.title)
  if (!parser) {
    throw new Error(`Unsupported file type: ${extname(row.title) || '(none)'}`)
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

    const parsed = await parser.parse(parseSource)
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

/** Re-run ingestion for an existing document (re-parse the stored copy). */
export async function reindexDocument(
  db: Db,
  storeDir: string,
  documentId: string,
  deps: IngestionDeps = {}
): Promise<DocumentInfo> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  setStatus(db, documentId, 'queued')
  return processDocument(db, storeDir, documentId, deps)
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
