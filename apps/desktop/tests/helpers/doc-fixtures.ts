// Document seeding for the skills, ZIM retrieval and RAG suites (rows only, except `seedStoredTextDoc`, which also writes a real
// .txt; `seedEmbeddedDoc` also writes real embedding vectors).
// Constraint: a stored-file root is minted via `tempRoot`, so it carries the swept `hilbertraum-` prefix.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addToCollection, createCollection, getBuiltinCollection } from '../../src/main/services/collections'
import type { Db } from '../../src/main/services/db'
import { encodeVector, type Embedder } from '../../src/main/services/embeddings'
import { approxTokenCount } from '../../src/main/services/ingestion/chunker'
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
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, ?, ?, 'p', ?, ?)`
  )
  chunks.forEach((c, i) => insertChunk.run(randomUUID(), docId, i, c.text, c.page, now))
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
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  lines.forEach((line, i) => insertChunk.run(randomUUID(), docId, i, line, label, page, now))
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

/** One chunk of `seedEmbeddedDoc`: a bare string is a chunk with no page and no section. */
export interface EmbeddedChunkSeed {
  text: string
  page?: number | null
  section?: string | null
}

export interface EmbeddedDocOptions {
  /** `embeddings.embedding_model_id`; default `embedder.id`. Another id seeds vectors a DIFFERENT embedder wrote
   *  (the visibility rule: `retrieve()` ignores them). */
  modelId?: string
  /** Stamp `documents.fully_chunked` (the #643 whole-read and coverage paths read it); default NULL. */
  fullyChunked?: boolean
  /** `documents.origin_json` (a generated document's provenance); default NULL. */
  origin?: string | null
}

/**
 * An indexed document whose chunks carry REAL embedding vectors from `embedder` (one chunk per entry of `chunks`,
 * source_label = title). `token_count` is `approxTokenCount(text)`, the estimate the production chunker persists.
 * `chunkIdsOf` reads the chunk ids back in chunk order.
 */
export async function seedEmbeddedDoc(
  db: Db,
  embedder: Embedder,
  title: string,
  chunks: Array<string | EmbeddedChunkSeed>,
  opts: EmbeddedDocOptions = {}
): Promise<string> {
  const seeds = chunks.map((c) => (typeof c === 'string' ? { text: c } : c))
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, fully_chunked, origin_json, created_at, updated_at)
     VALUES (?, ?, 'indexed', ?, ?, ?, ?)`
  ).run(docId, title, opts.fullyChunked ? now : null, opts.origin ?? null, now, now)
  const vectors = await embedder.embed(seeds.map((c) => c.text))
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertEmbedding = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  for (let i = 0; i < seeds.length; i++) {
    const c = seeds[i]!
    const chunkId = randomUUID()
    insertChunk.run(chunkId, docId, i, c.text, title, c.page ?? null, c.section ?? null, approxTokenCount(c.text), now)
    insertEmbedding.run(chunkId, opts.modelId ?? embedder.id, encodeVector(vectors[i]!), vectors[i]!.length, now)
  }
  return docId
}

/**
 * A ready single-level deep index, seeded by hand because a real build needs a model: one root holding `summary`, an
 * edge to each chunk in order, `tree_status` 'ready'. A blank `summary` is a ready tree with nothing to read; `modelId`
 * is the root's writer, which a Tier 1 summary reports.
 */
export function seedReadyTree(
  db: Db,
  docId: string,
  chunkIds: string[],
  opts: { summary?: string; modelId?: string } = {}
): void {
  const rootId = randomUUID()
  db.prepare(
    `INSERT INTO tree_nodes
       (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
        embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
     VALUES (?, ?, NULL, 1, 0, NULL, 1, ?, NULL, NULL, NULL, ?, ?, ?)`
  ).run(rootId, docId, opts.summary ?? 'Summary.', `hash-${rootId}`, opts.modelId ?? 'mock', new Date().toISOString())
  const edge = db.prepare('INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)')
  chunkIds.forEach((id, i) => edge.run(rootId, id, i))
  db.prepare("UPDATE documents SET tree_status = 'ready' WHERE id = ?").run(docId)
}

/**
 * A mixed corpus for the targeted document listings: every branch `rowToInfo`, the stale flag and the collections join
 * take. `att-a` is embedded under 'active-model' and filed in the Library and a project; `att-b` is embedded under
 * another model; `att-c` failed; `att-d` is deleted; `lib-x` is attached to nothing.
 */
export function seedMixedCorpus(db: Db): void {
  const now = new Date().toISOString()
  const insDoc = db.prepare(`INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insEmb = db.prepare(
    `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  insDoc.run('att-a', 'a.pdf', 'indexed', '2026-01-01T00:00:01Z', now)
  insChunk.run('ch-a1', 'att-a', 0, 'alpha text', 'a.pdf', now)
  insChunk.run('ch-a2', 'att-a', 1, 'beta text', 'a.pdf', now)
  insEmb.run('ch-a1', 'active-model', new Uint8Array(8), 2, now)
  insEmb.run('ch-a2', 'active-model', new Uint8Array(8), 2, now)
  insDoc.run('att-b', 'b.pdf', 'indexed', '2026-01-01T00:00:02Z', now)
  insChunk.run('ch-b1', 'att-b', 0, 'gamma text', 'b.pdf', now)
  insEmb.run('ch-b1', 'old-model', new Uint8Array(8), 2, now)
  insDoc.run('att-c', 'c.pdf', 'failed', '2026-01-01T00:00:03Z', now)
  insDoc.run('att-d', 'd.pdf', 'deleted', '2026-01-01T00:00:04Z', now)
  insDoc.run('lib-x', 'x.pdf', 'indexed', '2026-01-01T00:00:05Z', now)
  const lib = getBuiltinCollection(db, 'library')!
  const project = createCollection(db, 'P')
  addToCollection(db, ['att-a', 'lib-x'], lib.id)
  addToCollection(db, ['att-a'], project.id)
}

/** The document ids filed in a collection (`document_collections`), in no particular order. */
export function documentIdsInCollection(db: Db, collectionId: string): string[] {
  return (
    db.prepare('SELECT document_id FROM document_collections WHERE collection_id = ?').all(collectionId) as Array<{
      document_id: string
    }>
  ).map((r) => r.document_id)
}

/** A document's chunk ids in `chunk_index` order. */
export function chunkIdsOf(db: Db, docId: string): string[] {
  return (
    db.prepare('SELECT id FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(docId) as Array<{ id: string }>
  ).map((r) => r.id)
}
