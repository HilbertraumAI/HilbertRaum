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
import type { DocumentInfo, IngestionStatus } from '../../../shared/types'
import { sha256File } from '../models'
import { selectParser, supportedExtensions } from './parsers'
import { chunkSegments } from './chunker'

// Ingestion service (spec §7.7). Owns the document lifecycle:
//   queued → extracting → chunking → embedding → indexed   (failed on error)
// Persists to the `documents` and `chunks` tables (spec §8). Embeddings are written in
// Phase 5 — the `embedding` step is a pass-through here, so a document reaches `indexed`
// without vectors. Each file is COPIED into the workspace (`workspace/documents/`) so the
// drive is self-contained; both the workspace copy (`stored_path`) and the user's
// original location (`original_path`) are recorded. A failed file never crashes the run —
// it lands in `failed` with an `error_message`.

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

function rowToInfo(row: DocumentRow, chunkCount: number): DocumentInfo {
  return {
    id: row.id,
    title: row.title,
    originalPath: row.original_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: toStatus(row.status),
    errorMessage: row.error_message,
    chunkCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
  documentId: string
): Promise<DocumentInfo> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)

  try {
    setStatus(db, documentId, 'extracting')

    // Ensure a self-contained workspace copy exists (`stored_path`).
    let storedPath = row.stored_path
    if (!storedPath || !existsSync(storedPath)) {
      const origin = row.original_path
      if (!origin || !existsSync(origin)) {
        throw new Error('Source file not found on disk.')
      }
      storedPath = join(storeDir, documentId + extname(row.title).toLowerCase())
      copyFileSync(origin, storedPath)
      const sha = await sha256File(storedPath)
      const size = statSync(storedPath).size
      db.prepare('UPDATE documents SET stored_path = ?, sha256 = ?, size_bytes = ? WHERE id = ?').run(
        storedPath,
        sha,
        size,
        documentId
      )
    }

    const parser = selectParser(row.title)
    if (!parser) {
      throw new Error(`Unsupported file type: ${extname(row.title) || '(none)'}`)
    }
    db.prepare('UPDATE documents SET mime_type = ? WHERE id = ?').run(parser.mimeType, documentId)

    const parsed = await parser.parse(storedPath)

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

    // Embedding step is a pass-through in Phase 4; vectors are written in Phase 5.
    setStatus(db, documentId, 'embedding')

    setStatus(db, documentId, 'indexed')
    return rowToInfo(getRow(db, documentId) as DocumentRow, chunkCountFor(db, documentId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setStatus(db, documentId, 'failed', message)
    return rowToInfo(getRow(db, documentId) as DocumentRow, chunkCountFor(db, documentId))
  }
}

/** Re-run ingestion for an existing document (re-parse the stored copy). */
export async function reindexDocument(
  db: Db,
  storeDir: string,
  documentId: string
): Promise<DocumentInfo> {
  const row = getRow(db, documentId)
  if (!row) throw new Error(`Unknown document: ${documentId}`)
  setStatus(db, documentId, 'queued')
  return processDocument(db, storeDir, documentId)
}

/** List all non-deleted documents, newest first, with their chunk counts. */
export function listDocuments(db: Db): DocumentInfo[] {
  const rows = db
    .prepare("SELECT * FROM documents WHERE status != 'deleted' ORDER BY created_at DESC, rowid DESC")
    .all() as unknown as DocumentRow[]
  return rows.map((r) => rowToInfo(r, chunkCountFor(db, r.id)))
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
