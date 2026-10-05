// Document seeding for the skills suites (rows only, except `seedStoredTextDoc`, which also writes a real .txt).
// Constraint: a stored-file root is minted via `tempRoot`, so it carries the swept `hilbertraum-` prefix.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import { tempRoot } from './db-fixtures'

export interface ChunkSeed {
  text: string
  page: number | null
}

/**
 * One 'indexed' document + chunks (`source_label 'p'`). A string is ONE chunk on page 1; an array seeds one chunk per
 * entry with its own page. Defaults: title 'Statement', mime 'application/pdf'.
 */
export function seedDocWithChunks(
  db: Db,
  content: string | ChunkSeed[],
  opts: { title?: string; mimeType?: string } = {}
): string {
  const chunks: ChunkSeed[] = typeof content === 'string' ? [{ text: content, page: 1 }] : content
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?, ?)`
  ).run(docId, opts.title ?? 'Statement', opts.mimeType ?? 'application/pdf', now, now)
  chunks.forEach((c, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'p', ?, ?)`
    ).run(randomUUID(), docId, i, c.text, c.page, now)
  })
  return docId
}

/**
 * An indexed document with ONE chunk per entry of `lines` (so citations resolve against real rows).
 * Defaults: title 'Statement', mime 'application/pdf', source_label = title, page 1, fully_chunked NULL.
 */
export function seedLineChunkDoc(
  db: Db,
  lines: string[],
  opts: {
    title?: string
    mimeType?: string
    sourceLabel?: string
    page?: number | null
    fullyChunked?: boolean
  } = {}
): string {
  const title = opts.title ?? 'Statement'
  const label = opts.sourceLabel ?? title
  const page = opts.page === undefined ? 1 : opts.page
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?, ?, ?)`
  ).run(docId, title, opts.mimeType ?? 'application/pdf', opts.fullyChunked ? now : null, now, now)
  lines.forEach((line, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), docId, i, line, label, page, now)
  })
  return docId
}

/**
 * An indexed `text/plain` document backed by a REAL stored `.txt` (the run seam re-extracts verbatim from
 * `stored_path`), plus one chunk row. `label` names the temp root (`hilbertraum-<label>-`).
 */
export function seedStoredTextDoc(
  db: Db,
  text: string,
  opts: { title?: string; createdAt?: string; label?: string } = {}
): string {
  const now = opts.createdAt ?? new Date().toISOString()
  const docId = randomUUID()
  const storedPath = join(tempRoot(opts.label ?? 'stored-doc'), 'document.txt')
  writeFileSync(storedPath, text, 'utf8')
  db.prepare(
    `INSERT INTO documents (id, title, stored_path, status, mime_type, created_at, updated_at)
     VALUES (?, ?, ?, 'indexed', 'text/plain', ?, ?)`
  ).run(docId, opts.title ?? 'document.txt', storedPath, now, now)
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, 0, ?, 'p', 1, ?)`
  ).run(randomUUID(), docId, text, now)
  return docId
}
