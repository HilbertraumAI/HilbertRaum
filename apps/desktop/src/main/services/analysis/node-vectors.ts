import type { Db } from '../db'
import type { Embedder } from '../embeddings'
import { encodeVector, decodeVector, cosineSimilarity } from '../embeddings'

// Lazy node embeddings + node-cosine search for the deep-index summary tree
// (whole-document-analysis plan §3.1/§4.3 → rag-design §14.6). Node vectors are stored NULL by
// the tree build [L6]; symmetric compare is their FIRST and only consumer, so they are embedded
// HERE, lazily, the first time a compare needs a tree's nodes.
//
// Discipline:
//   - SIDECAR, NOT CHAT: node summaries are embedded on the CPU embedder sidecar
//     (getIngestionDeps().embedder), NOT the chat runtime — so this is not a chat-slot job.
//     It runs INSIDE the (non-yielding) compare DocTask, so it is still one model job at a
//     time (chat is refused while compare runs).
//   - H5 STALENESS: node vectors are scoped by embedding_model_id. A node whose vector is
//     under a different embedder than the active one is RE-EMBEDDED (cheap, no chat call) —
//     a mixed-embedder alignment never silently happens.
//   - CACHE REUSE: each node carries a (content_hash, model_id) into summary_cache; once a
//     summary's vector is computed it is written back to summary_cache, so a rebuild (which
//     mints fresh node rows with NULL vectors) refills them from the cache — 0 sidecar calls.
//   - CONTENT: summary_text is content — never logged/audited; node search reads tree_nodes
//     only, never the chunk `embeddings` table (so citation-grade retrieval is untouched, §3.6).

export interface NodeVector {
  id: string
  ordinal: number
  summaryText: string
  vec: Float32Array
}

interface NodeRow {
  id: string
  ordinal: number
  summary_text: string
  content_hash: string
  model_id: string | null
  embedding_blob: Uint8Array | null
  dimensions: number | null
  embedding_model_id: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Record the active embedder on tree_meta_json so the H5 staleness guard can read it. */
function stampMetaEmbedder(db: Db, documentId: string, embeddingModelId: string): void {
  const row = db.prepare('SELECT tree_meta_json FROM documents WHERE id = ?').get(documentId) as
    | { tree_meta_json: string | null }
    | undefined
  if (!row?.tree_meta_json) return
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(row.tree_meta_json) as Record<string, unknown>
  } catch {
    return
  }
  if (meta.embeddingModelId === embeddingModelId) return
  meta.embeddingModelId = embeddingModelId
  db.prepare('UPDATE documents SET tree_meta_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(meta),
    nowIso(),
    documentId
  )
}

interface Pending {
  row: NodeRow
  blob: Buffer
  dims: number
}

/**
 * Ensure every tree node of `documentId` carries a vector under the ACTIVE embedder, embedding
 * lazily — and reusing summary_cache — only the nodes that need it. Returns the number of nodes
 * actually sent to the embedder sidecar (0 when everything was already current/cached — the
 * "reuse" assertion). Stamps tree_meta_json.embeddingModelId to the active embedder.
 *
 * No-op-cheap on the warm path: a second call after the first embeds nothing. The await on the
 * embedder happens OUTSIDE the write transaction (the transaction body is synchronous).
 */
export async function ensureNodeEmbeddings(
  db: Db,
  documentId: string,
  embedder: Embedder,
  signal?: AbortSignal
): Promise<number> {
  const activeId = embedder.id
  const rows = db
    .prepare(
      `SELECT id, ordinal, summary_text, content_hash, model_id, embedding_blob, dimensions,
              embedding_model_id
       FROM tree_nodes WHERE document_id = ? ORDER BY level, ordinal`
    )
    .all(documentId) as unknown as NodeRow[]
  if (rows.length === 0) return 0

  const cacheGet = db.prepare(
    `SELECT embedding_blob, dimensions, embedding_model_id FROM summary_cache
     WHERE content_hash = ? AND model_id = ?`
  )

  // Classify each node: already current / fillable from the content cache / needs the sidecar.
  const fromCache: Pending[] = []
  const needEmbed: NodeRow[] = []
  for (const row of rows) {
    if (row.embedding_blob && row.embedding_model_id === activeId && row.dimensions) {
      continue // already under the active embedder (H5)
    }
    if (row.model_id) {
      const cached = cacheGet.get(row.content_hash, row.model_id) as unknown as
        | { embedding_blob: Uint8Array | null; dimensions: number | null; embedding_model_id: string | null }
        | undefined
      if (cached?.embedding_blob && cached.embedding_model_id === activeId && cached.dimensions) {
        fromCache.push({ row, blob: Buffer.from(cached.embedding_blob), dims: cached.dimensions })
        continue
      }
    }
    needEmbed.push(row)
  }

  // Embed the misses in one sidecar batch (await is OUTSIDE the transaction below — H9).
  const embedded: Pending[] = []
  if (needEmbed.length > 0) {
    const vectors = await embedder.embed(
      needEmbed.map((r) => r.summary_text),
      { signal }
    )
    // The embedder contract is one vector per input; fail loudly and locally if it isn't,
    // rather than letting an undefined `v` throw opaquely inside `encodeVector` below.
    if (vectors.length !== needEmbed.length) {
      throw new Error(
        `Node embedder returned ${vectors.length} vectors for ${needEmbed.length} summaries`
      )
    }
    for (let i = 0; i < needEmbed.length; i++) {
      const v = vectors[i]
      embedded.push({ row: needEmbed[i], blob: encodeVector(v), dims: v.length })
    }
  }
  if (signal?.aborted) throw new DOMException('Document task cancelled', 'AbortError')

  const all = [...fromCache, ...embedded]
  if (all.length === 0) {
    stampMetaEmbedder(db, documentId, activeId)
    return 0
  }

  const setNode = db.prepare(
    `UPDATE tree_nodes SET embedding_blob = ?, dimensions = ?, embedding_model_id = ? WHERE id = ?`
  )
  const setCache = db.prepare(
    `UPDATE summary_cache SET embedding_blob = ?, dimensions = ?, embedding_model_id = ?
     WHERE content_hash = ? AND model_id = ?`
  )
  db.exec('BEGIN')
  try {
    for (const e of all) {
      setNode.run(e.blob, e.dims, activeId, e.row.id)
      if (e.row.model_id) {
        // Persist the vector back to the content cache so a rebuild refills from it (0 calls).
        setCache.run(e.blob, e.dims, activeId, e.row.content_hash, e.row.model_id)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original error */
    }
    throw err
  }
  stampMetaEmbedder(db, documentId, activeId)
  return embedded.length
}

/**
 * Load all of one document's nodes at `level` that carry a vector under `embeddingModelId`,
 * in ordinal order. Reads ONLY tree_nodes (never the chunk `embeddings` table).
 */
export function loadNodeVectors(
  db: Db,
  documentId: string,
  level: number,
  embeddingModelId: string
): NodeVector[] {
  const rows = db
    .prepare(
      `SELECT id, ordinal, summary_text, embedding_blob, dimensions FROM tree_nodes
       WHERE document_id = ? AND level = ? AND embedding_model_id = ? AND embedding_blob IS NOT NULL
       ORDER BY ordinal`
    )
    .all(documentId, level, embeddingModelId) as unknown as Array<{
    id: string
    ordinal: number
    summary_text: string
    embedding_blob: Uint8Array
    dimensions: number
  }>
  const out: NodeVector[] = []
  for (const r of rows) {
    if (!r.dimensions || r.embedding_blob.length < r.dimensions * 4) continue
    out.push({
      id: r.id,
      ordinal: r.ordinal,
      summaryText: r.summary_text,
      vec: decodeVector(r.embedding_blob, r.dimensions)
    })
  }
  return out
}

/**
 * Cosine search over one document's nodes at `level` (the H4 node-vector helper named in the
 * plan). Reuses decodeVector + cosineSimilarity; scoped by embedding_model_id [H5]. Returns the
 * top `topK` {nodeId, score} descending. This is NOT VectorIndex (which scans only chunk
 * vectors) — node vectors stay out of ordinary citation-grade chunk retrieval (§3.6).
 */
export function nodeVectorSearch(
  db: Db,
  documentId: string,
  level: number,
  queryVec: Float32Array,
  embeddingModelId: string,
  topK: number
): Array<{ nodeId: string; score: number }> {
  if (topK <= 0) return []
  const nodes = loadNodeVectors(db, documentId, level, embeddingModelId)
  const hits: Array<{ nodeId: string; score: number }> = []
  for (const n of nodes) {
    if (n.vec.length !== queryVec.length) continue
    hits.push({ nodeId: n.id, score: cosineSimilarity(queryVec, n.vec) })
  }
  hits.sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1))
  return hits.slice(0, topK)
}
