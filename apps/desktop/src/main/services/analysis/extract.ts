import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { buildScopeFilter } from '../retrieval-scope'
import {
  EXTRACT_RECORD_TYPES,
  type ExtractionListing,
  type ExtractionListingItem,
  type ExtractRecordType,
  type JsonSchema,
  type RetrievalScope
} from '../../../shared/types'
import type { ModelSlotArbiter } from './model-slot-arbiter'

// The ingest-time structured extract-then-aggregate pass (whole-document-analysis plan §4.2,
// Phase 3). For each level-0 chunk, ONE model call surfaces items of the fixed v1 type set as
// a JSON array; the items are stored in `extraction_records` with per-chunk provenance and a
// normalized dedup key. A later "list every X" answer is then a pure query-time GROUP BY
// (0 model calls) over those rows — `aggregateExtractions`.
//
// Honesty (H7): this is EXHAUSTIVE OVER INDEXED SECTIONS WITH PER-ITEM PROVENANCE, NOT a
// guaranteed-complete list. A chunk whose reply is unparseable after one retry is recorded as
// an `unparsed` scan marker, never silently dropped — the listing's coverage line reads
// "across N sections scanned (k unparsed)". Per-chunk model recall, normalized_value
// over/under-merge, and items split across the ~80-token chunk overlap stay explicit caveats.
//
// Invariants this file upholds (mirrors tree-build.ts):
//   - YIELDING (H3/H9/H10): one chunk per transaction, and at each chunk boundary the pass
//     checks the model-slot arbiter — if chat asked for the slot it parks on
//     `arbiter.reacquire()` (it does NOT return) until chat releases, then continues.
//   - PER-CHUNK TRANSACTION with ROLLBACK (H11): the chunk's marker + item rows write in one
//     `BEGIN…COMMIT`; a thrown insert ROLLBACKs so the shared connection is never poisoned.
//   - CONTENT CACHE / RESUME: each scanned chunk gets exactly one `__scan__` marker row keyed
//     by (chunk_id, content_hash); a re-run/resume SKIPS any chunk that already has a matching
//     `ok` marker FOR THE CURRENT MODEL (0 model calls). An `unparsed` marker is NOT a cache
//     hit (#50): the chunk is retried on the next explicit run, so one bad model run cannot
//     poison the document until re-import. A MODEL SWAP is also NOT a cache hit (F-01, audit
//     2026-07-16): the hit lookup carries `AND model_id = ?`, mirroring the tree cache's M12
//     posture, so an explicit re-run under a different model re-extracts (rows replaced by
//     commitChunk — never a mixed-model set). Re-index changes chunk ids and cascades the rows
//     away (H1), so the cache is correctly cold after the text changes.
//   - CONTENT NEVER LOGGED: value_text/normalized_value are content — never logged/audited.

/** The fixed type-set version — folded into the per-chunk content hash so a future type-set
 *  change invalidates the cache without a manual migration. */
const TYPE_SET_VERSION = 'v1'

/** Reserved `record_type` of the per-chunk bookkeeping row: the scan outcome + the cache key.
 *  Excluded from every listing aggregation (listings query a real type). */
export const SCAN_MARKER_TYPE = '__scan__'
/** `normalized_value` of a marker for a chunk that parsed OK (0 or more items). */
const SCAN_OK = 'ok'
/** `normalized_value` of a marker for a chunk that was unparseable after one retry. */
const SCAN_UNPARSED = 'unparsed'

const EXTRACT_OUTPUT_TOKENS = 384
/** The escalated cap for the retry attempt (#50): a reasoning model can spend the whole first
 *  budget on `reasoning_content` (discarded by the manager's generate) and return empty content
 *  — at temperature 0 an identical retry is byte-identical, so the retry must raise the cap to
 *  fit reasoning + the emitted array. A cap, not a target: non-reasoning models never pay it
 *  (their attempt 1 parses), and EOS still ends the reply early. */
const EXTRACT_RETRY_OUTPUT_TOKENS = 2048
const EXTRACT_TEMPERATURE = 0

const EXTRACT_SYSTEM_PROMPT =
  'You extract structured items from a passage of a document. You reply ONLY with JSON — ' +
  'never prose, never code fences, never explanation.'

/** The grammar contract for one chunk (STR-1 §5.1, review 2026-07-19): the reply is constrained
 *  to a top-level array of `{type, value}` via the same D55 `responseSchema` → llama-server
 *  `response_format:{type:'json_schema',strict:true}` plumbing the bank categorizer uses, so the
 *  prose/code-fence/unparseable failure class is eliminated AT THE SOURCE on the real runtime
 *  (the mock runtime ignores the schema — the unparsed path stays exercisable in CI). Top-level
 *  ARRAY by design: the wire shape stays byte-compatible with the shipped prompt and with
 *  `parseExtraction`/`salvageTruncatedArray` (the first top-level-array schema in the app — every
 *  prior D55 consumer wraps in an object; the plumbing forwards either verbatim). The `type` enum
 *  tracks `EXTRACT_RECORD_TYPES`, so a type-set change cannot drift the schema. NOTE the prompt
 *  below still DESCRIBES the shape: llama-server does not inject the schema into the prompt.
 *  Grammar guarantees syntax, not values — the tolerant parse + coercion stays as re-validation,
 *  and the #50 ladder stays entirely: a thinking model can still burn the cap on
 *  `reasoning_content` (empty reply), and the token cap can still cut a grammatical array
 *  mid-object (salvage). */
export const EXTRACT_RESPONSE_SCHEMA_NAME = 'extraction_items'
export const EXTRACT_RESPONSE_SCHEMA: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['type', 'value'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: [...EXTRACT_RECORD_TYPES] },
      value: { type: 'string', minLength: 1 }
    }
  }
}

/** The strict per-chunk prompt (plan §4.2 step 1). */
function extractPrompt(chunkText: string): string {
  return (
    'From the passage below, extract every notable item of these types:\n' +
    '- "date": any date or deadline\n' +
    '- "amount": any monetary amount, fee, or price\n' +
    '- "party": any named person or organization\n' +
    '- "obligation": any duty, requirement, or clause ("must", "shall", …)\n' +
    '- "generic": any other salient item worth listing\n\n' +
    'Reply with ONLY a JSON array of objects {"type": <one of the above>, "value": <short text>}. ' +
    'If the passage has none, reply with exactly []. No other text.\n\n' +
    `Passage:\n${chunkText}`
  )
}

export interface ExtractDeps {
  db: Db
  /** The pinned chat model id for this pass — recorded on each row AND part of the cache-hit
   *  lookup (content + model keyed, F-01): a re-run under a different model re-extracts. */
  modelId: string
  signal: AbortSignal
  arbiter: ModelSlotArbiter
  jobId: string
  /** One model call (the manager's `generate` over the locked chatStream contract). The
   *  optional trailing `schema` carries the D55 grammar constraint (STR-1 §5.1). */
  generate: (
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal,
    schema?: { responseSchema: JsonSchema; responseSchemaName?: string }
  ) => Promise<string>
  /** Reports scanned/total chunk counts for the DocTask progress display. */
  onProgress?: (stepsDone: number, stepsTotal: number) => void
}

interface ExtractedItem {
  type: ExtractRecordType
  value: string
}

/** sha256(chunk text + NUL + type-set version) — the per-chunk cache/resume key. The `\u0000`
 *  domain separator is written as an ESCAPE, never a literal NUL byte: a literal 0x00 makes git
 *  treat this file as binary (unreviewable diffs, ripgrep skips it, a formatter could silently
 *  strip the byte and invalidate every persisted extraction-cache hash). Byte-identical to the
 *  literal form, so no cache invalidates. Exported for the byte-identity pin in
 *  `analysis-extract-hash.test.ts` (full-audit 2026-07-11 CODE-24/DOC-12). */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(`${text}\u0000${TYPE_SET_VERSION}`).digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Recover the complete leading objects of an UNTERMINATED array (#50): a reply cut off at the
 * token cap ends mid-object or mid-string. Step back to each previous `}` and try to close the
 * array there — items are flat `{type, value}` objects, so the longest parseable prefix is a
 * safe partial recovery. Returns null when not even one complete object can be recovered.
 */
function salvageTruncatedArray(text: string): unknown[] | null {
  let pos = text.length
  for (let i = 0; i < 64; i++) {
    const brace = text.lastIndexOf('}', pos - 1)
    if (brace <= 0) return null
    try {
      const candidate: unknown = JSON.parse(`${text.slice(0, brace + 1)}]`)
      if (Array.isArray(candidate)) return candidate
    } catch {
      // A `}` inside a string value — step further back.
    }
    pos = brace
  }
  return null
}

/**
 * Tolerantly parse a model reply into extracted items. Returns null when no JSON array can be
 * recovered (the caller retries once, then records an `unparsed` marker — never drops the
 * chunk). An empty array `[]` is a VALID parse (the chunk genuinely had nothing), distinct
 * from unparseable. Unknown types coerce to `generic`; empty values are dropped.
 *
 * `salvageTruncated` (#50) additionally recovers the complete leading items of an array cut
 * off at the token cap. FINAL-attempt only: salvaging attempt 1 would commit a silently
 * partial list as a permanent `ok` when the honest escalated retry could have parsed it whole.
 */
export function parseExtraction(
  reply: string,
  opts: { salvageTruncated?: boolean } = {}
): ExtractedItem[] | null {
  // Recover the first top-level JSON array, tolerating code fences / leading prose.
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1) return null
  let parsed: unknown = null
  if (end > start) {
    try {
      parsed = JSON.parse(reply.slice(start, end + 1))
    } catch {
      parsed = null
    }
  }
  if (!Array.isArray(parsed) && opts.salvageTruncated) {
    parsed = salvageTruncatedArray(reply.slice(start))
  }
  if (!Array.isArray(parsed)) return null
  const items: ExtractedItem[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    const value = typeof rec.value === 'string' ? rec.value.trim() : ''
    if (value.length === 0) continue
    const t = typeof rec.type === 'string' ? rec.type.toLowerCase().trim() : ''
    const type = (EXTRACT_RECORD_TYPES as readonly string[]).includes(t)
      ? (t as ExtractRecordType)
      : 'generic'
    items.push({ type, value })
  }
  return items
}

/** Lowercased/trimmed dedup key for an item value (plan §3.3 normalized_value). */
function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Run (or resume) the structured-extract pass for one document. Throws on abort (the parked
 * `reacquire` rejecting, or the signal aborting) so the caller's run() lands it in
 * `cancelled`/`failed`; on abort/error the document is left `extract_status='extracting'`
 * (resumable — reconcileStuckExtracts flips it to 'pending' on next startup). On success the
 * document is `extract_status='ready'`. Returns the documentId.
 */
export async function extractDocument(documentId: string, deps: ExtractDeps): Promise<string> {
  const { db, modelId, signal, arbiter, jobId, generate } = deps

  const chunkRows = db
    .prepare('SELECT id, text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ id: string; text: string }>
  const chunks = chunkRows.filter((r) => r.text.trim().length > 0)
  if (chunks.length === 0) {
    throw new Error(`Extract: document ${documentId} has no chunks`)
  }

  db.prepare('UPDATE documents SET extract_status = ?, updated_at = ? WHERE id = ?').run(
    'extracting',
    nowIso(),
    documentId
  )

  const stepsTotal = chunks.length
  let stepsDone = 0
  deps.onProgress?.(stepsDone, stepsTotal)

  // Only an OK scan is a cache hit (#50): an `unparsed` marker stays visible in the coverage
  // accounting but is RETRIED on the next run — one bad model run (e.g. a reasoning model that
  // returned only reasoning tokens) must not poison the document until re-import. commitChunk
  // deletes the chunk's prior rows, so the retried chunk's marker is replaced, never doubled.
  // F-01 (audit 2026-07-16): the hit is ALSO keyed by the CURRENT pass's model_id — the same
  // model-switch invalidation the sibling tree cache has (tree-build.ts M12, "a model-switch
  // can't yield a mixed-model tree") — so an explicit re-run after a chat-model swap
  // re-extracts under the new model instead of serving the old model's rows forever. The
  // model id lives in the LOOKUP predicate, never in contentHashOf: the hash is pinned
  // byte-identical (analysis-extract-hash.test.ts) and persisted rows must stay addressable.
  const markerExists = db.prepare(
    `SELECT 1 FROM extraction_records
     WHERE chunk_id = ? AND record_type = ? AND content_hash = ? AND normalized_value = ?
       AND model_id = ? LIMIT 1`
  )
  const deleteChunkRows = db.prepare('DELETE FROM extraction_records WHERE chunk_id = ?')
  const insertRow = db.prepare(
    `INSERT INTO extraction_records
       (id, document_id, chunk_id, record_type, value_text, normalized_value, attributes_json,
        model_id, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  )

  /** Write a chunk's marker + item rows atomically (H11: ROLLBACK on any throw). */
  const commitChunk = (
    chunkId: string,
    hash: string,
    items: ExtractedItem[] | null
  ): void => {
    db.exec('BEGIN')
    try {
      // Replace any prior rows for this chunk (defensive — a cache miss means no matching
      // marker, but a leftover under a different hash must not accumulate).
      deleteChunkRows.run(chunkId)
      const created = nowIso()
      // The scan marker: exactly one per scanned chunk — the scan outcome + the cache key.
      insertRow.run(
        randomUUID(),
        documentId,
        chunkId,
        SCAN_MARKER_TYPE,
        '',
        items === null ? SCAN_UNPARSED : SCAN_OK,
        modelId,
        hash,
        created
      )
      if (items) {
        for (const item of items) {
          insertRow.run(
            randomUUID(),
            documentId,
            chunkId,
            item.type,
            item.value,
            normalize(item.value),
            modelId,
            hash,
            created
          )
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
  }

  /** Park at a chunk boundary if chat asked for the slot; rejects (throws) on abort. */
  const maybeYield = async (): Promise<void> => {
    if (signal.aborted) throw new DOMException('Extract cancelled', 'AbortError')
    if (arbiter.shouldYield()) {
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowIso(), documentId)
      try {
        await arbiter.reacquire(jobId)
      } catch {
        throw new DOMException('Extract cancelled', 'AbortError')
      }
      if (signal.aborted) throw new DOMException('Extract cancelled', 'AbortError')
    }
  }

  for (const chunk of chunks) {
    if (signal.aborted) throw new DOMException('Extract cancelled', 'AbortError')
    const hash = contentHashOf(chunk.text)
    // Resume/cache: skip a chunk already scanned OK under this exact content AND this exact
    // model (0 model calls) — a different model's ok scan is a MISS (F-01).
    const cached = markerExists.get(chunk.id, SCAN_MARKER_TYPE, hash, SCAN_OK, modelId) as unknown as
      | { 1: number }
      | undefined
    if (!cached) {
      // One call; retry once on an unparseable reply (the generateWithRetry precedent), then
      // record an unparsed marker — never silently drop the chunk (H7). The retry raises the
      // token cap (#50: a reasoning model can burn the whole first budget before any content)
      // and, as the last resort, salvages the leading items of a cap-truncated array.
      let items: ExtractedItem[] | null = null
      for (let attempt = 1; attempt <= 2 && items === null; attempt++) {
        const reply = await generate(
          EXTRACT_SYSTEM_PROMPT,
          extractPrompt(chunk.text),
          attempt === 1 ? EXTRACT_OUTPUT_TOKENS : EXTRACT_RETRY_OUTPUT_TOKENS,
          EXTRACT_TEMPERATURE,
          signal,
          // Grammar on EVERY attempt (STR-1 §5.1) — the retry exists for reasoning-burn and
          // truncation, which the grammar does not prevent; the wire format is constrained on
          // both attempts alike.
          { responseSchema: EXTRACT_RESPONSE_SCHEMA, responseSchemaName: EXTRACT_RESPONSE_SCHEMA_NAME }
        )
        items = parseExtraction(reply, { salvageTruncated: attempt === 2 })
        if (signal.aborted) throw new DOMException('Extract cancelled', 'AbortError')
      }
      commitChunk(chunk.id, hash, items)
    }
    stepsDone += 1
    deps.onProgress?.(stepsDone, stepsTotal)
    await maybeYield()
  }

  db.prepare('UPDATE documents SET extract_status = ?, updated_at = ? WHERE id = ?').run(
    'ready',
    nowIso(),
    documentId
  )
  return documentId
}

interface ItemRow {
  nv: string
  rep: string
  cnt: number
  chunks: string | null
}

/**
 * Aggregate the precomputed extraction rows for `recordType` within `scope` into a
 * provenance-backed listing (plan §4.2 step 2). ZERO model calls — a pure GROUP BY over
 * `extraction_records`, scoped through the shared `buildScopeFilter` (M3 — membership/id
 * UNION + archived exclusion), so collection/archived semantics match the rest of the app.
 * The `__scan__` markers feed the honest coverage line (scanned / total / unparsed).
 */
export function aggregateExtractions(
  db: Db,
  scope: RetrievalScope | null,
  recordType: ExtractRecordType
): ExtractionListing {
  const recFilter = buildScopeFilter(scope, 'document_id')
  const recWhere = recFilter ? ` AND ${recFilter.sql}` : ''
  const recParams = recFilter ? recFilter.params : []

  const itemRows = db
    .prepare(
      `SELECT normalized_value AS nv, MIN(value_text) AS rep, COUNT(*) AS cnt,
              GROUP_CONCAT(chunk_id) AS chunks
       FROM extraction_records
       WHERE record_type = ?${recWhere}
       GROUP BY normalized_value
       ORDER BY cnt DESC, nv ASC`
    )
    .all(recordType, ...recParams) as unknown as ItemRow[]

  const items: ExtractionListingItem[] = itemRows.map((r) => ({
    value: r.rep,
    count: r.cnt,
    sourceChunkIds: r.chunks ? [...new Set(r.chunks.split(','))] : []
  }))

  const scannedChunks = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT chunk_id) AS n FROM extraction_records
         WHERE record_type = ?${recWhere}`
      )
      .get(SCAN_MARKER_TYPE, ...recParams) as unknown as { n: number }
  ).n
  const unparsedChunks = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT chunk_id) AS n FROM extraction_records
         WHERE record_type = ? AND normalized_value = ?${recWhere}`
      )
      .get(SCAN_MARKER_TYPE, SCAN_UNPARSED, ...recParams) as unknown as { n: number }
  ).n

  const chunkFilter = buildScopeFilter(scope, 'c.document_id')
  const chunkWhere = chunkFilter ? ` WHERE ${chunkFilter.sql}` : ''
  const totalChunks = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM chunks c${chunkWhere}`)
      .get(...(chunkFilter ? chunkFilter.params : [])) as unknown as { n: number }
  ).n

  // fullyChunked: no in-scope indexed document is missing the `fully_chunked` marker (C4).
  const docFilter = buildScopeFilter(scope, 'd.id')
  const docWhere = docFilter ? ` AND ${docFilter.sql}` : ''
  const notFullyChunked = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents d
         WHERE d.status = 'indexed' AND d.fully_chunked IS NULL${docWhere}`
      )
      .get(...(docFilter ? docFilter.params : [])) as unknown as { n: number }
  ).n

  return {
    recordType,
    items,
    scannedChunks,
    unparsedChunks,
    totalChunks,
    fullyChunked: notFullyChunked === 0
  }
}
