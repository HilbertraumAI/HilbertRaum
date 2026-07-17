import { randomUUID } from 'node:crypto'
import type {
  AnswerBlockKind,
  CoverageInfo,
  EvidenceExportFormat,
  EvidenceExportRecord,
  EvidenceGenerationSnapshot,
  EvidenceLink,
  EvidenceLinkInput,
  EvidenceReadyGate,
  EvidenceReview,
  EvidenceReviewDetail,
  EvidenceReviewItem,
  EvidenceReviewItemPatch,
  EvidenceReviewPatch,
  EvidenceReviewStatus,
  EvidenceReviewSummary,
  EvidenceSelectionInput,
  EvidenceSourceSnapshot,
  ReviewDecision
} from '../../shared/types'
import { prepareCached, type Db } from './db'
import { parseCoverage } from './chat'

// Evidence Pack / Review Mode — storage CRUD + tolerant row→DTO parsing (EP-1 plan §5,
// Phase 0). NO IPC, NO UI, NO export pipeline, NO snapshot builder here — those are later
// phases; this module is the persisted layer the rest of the feature stands on.
//
// Contracts (docs/data-contracts.md "Evidence Pack / Review Mode"):
//  - One ACTIVE review per assistant message (v1) — enforced HERE in service code, not by a
//    UNIQUE constraint, so the spec's later relaxation stays additive.
//  - Every JSON column is parsed tolerantly (the chat.ts `parseCitations` idiom): malformed
//    payloads degrade to safe defaults — [] / null / the honest enum default — NEVER a throw,
//    NEVER an invented value. Safe defaults always point AWAY from unearned confidence:
//    unknown decision → 'not_reviewed', unknown status → 'draft', unknown link origin →
//    'reviewer' (never claim the answer cited something), unknown identity → 'unresolved'.
//  - `outdated` is DERIVED (spec §18.4) — Phase 0 has no freshness engine, so every read
//    reports `false`; Phase 4 computes it at open time. It is never stored, so it can never
//    erase a persisted 'ready'.
//  - All review text is CONTENT: titles, notes, snapshots and reviewer labels never reach
//    logs or audit events (those stay ids/counts — enforced later at the IPC layer).

function nowIso(): string {
  return new Date().toISOString()
}

/** Stringify defensively (the `serializeCoverage` idiom): a value that cannot stringify
 *  degrades to NULL rather than failing the whole write. */
function safeJson(value: unknown): string | null {
  if (value == null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Tolerant enum normalizers (row → DTO). Each returns the honest safe default
// for anything it does not recognize — see the module header for the rationale.
// ---------------------------------------------------------------------------

const DECISIONS: ReadonlySet<string> = new Set([
  'supported',
  'partly_supported',
  'not_supported',
  'follow_up',
  'not_reviewed',
  'not_applicable'
])

function normalizeDecision(v: unknown): ReviewDecision {
  return typeof v === 'string' && DECISIONS.has(v) ? (v as ReviewDecision) : 'not_reviewed'
}

function normalizeStatus(v: unknown): EvidenceReviewStatus {
  // 'ready' only when literally recorded — never claim completion from a malformed value.
  return v === 'ready' ? 'ready' : 'draft'
}

function normalizeItemKind(v: unknown): 'block' | 'selection' {
  // Unknown kind → 'block': the stricter reading (a block can gate readiness; a phantom
  // "selection" would silently drop the row from the required set).
  return v === 'selection' ? 'selection' : 'block'
}

const BLOCK_KINDS: ReadonlySet<string> = new Set([
  'paragraph',
  'list_item',
  'heading',
  'fence',
  'table',
  'blockquote'
])

function normalizeBlockKind(v: unknown): AnswerBlockKind | null {
  // Unknown → null = "unclassified", which the D-7 gate treats as REQUIRED — a corrupted
  // kind can never exempt a block from review (only a literal 'heading' can).
  return typeof v === 'string' && BLOCK_KINDS.has(v) ? (v as AnswerBlockKind) : null
}

function normalizeLinkOrigin(v: unknown): EvidenceLink['origin'] {
  // Unknown origin → 'reviewer': never present a link as "cited by the answer" (the
  // honesty-load-bearing claim, spec §13.3) unless that is literally what was stored.
  return v === 'answer_marker' ? 'answer_marker' : 'reviewer'
}

const RELATIONS: ReadonlySet<string> = new Set(['supports', 'qualifies', 'contradicts', 'context'])

function normalizeRelation(v: unknown): 'supports' | 'qualifies' | 'contradicts' | 'context' | null {
  return typeof v === 'string' && RELATIONS.has(v)
    ? (v as 'supports' | 'qualifies' | 'contradicts' | 'context')
    : null
}

function normalizeFormat(v: unknown): EvidenceExportFormat {
  // The plan ships 'html' (Phase 3) then 'pdf' (Phase 6); unknown → 'html' (display-only —
  // the recorded hash/file name stay exact regardless).
  return v === 'pdf' ? 'pdf' : 'html'
}

// ---------------------------------------------------------------------------
// Tolerant JSON-column parsers (the parseCitations idiom: element-validated,
// malformed → safe default, never a throw).
// ---------------------------------------------------------------------------

function isSourceSnapshot(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return typeof s.key === 'string' && s.key.length > 0 && typeof s.documentTitle === 'string'
}

const SOURCE_KINDS: ReadonlySet<string> = new Set([
  'direct_excerpt',
  'whole_document_provenance',
  'structured_record'
])

/**
 * Parse `evidence_reviews.source_snapshot_json`: a JSON array of `EvidenceSourceSnapshot`s,
 * else `[]`. Elements missing the required `key`/`documentTitle` are dropped; optional fields
 * are kept only when correctly typed. `kind` defaults to 'whole_document_provenance' — the
 * WEAKEST claim (provenance, not a direct citation) — and `identity` to 'unresolved' (cannot
 * verify), so a corrupted snapshot never gains evidential strength from the repair.
 */
export function parseSourceSnapshots(json: string | null): EvidenceSourceSnapshot[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    if (!Array.isArray(v)) return []
    return v.filter(isSourceSnapshot).map((raw) => {
      const s = raw as Record<string, unknown>
      const identity = s.identity === 'resolved' ? 'resolved' : 'unresolved'
      const availability =
        s.availabilityAtCreation === 'available' || s.availabilityAtCreation === 'missing'
          ? s.availabilityAtCreation
          : null
      return {
        key: s.key as string,
        machineLabel: typeof s.machineLabel === 'string' ? s.machineLabel : null,
        kind:
          typeof s.kind === 'string' && SOURCE_KINDS.has(s.kind)
            ? (s.kind as EvidenceSourceSnapshot['kind'])
            : 'whole_document_provenance',
        identity,
        documentId: typeof s.documentId === 'string' ? s.documentId : null,
        documentTitle: s.documentTitle as string,
        documentSha256: typeof s.documentSha256 === 'string' ? s.documentSha256 : null,
        mimeType: typeof s.mimeType === 'string' ? s.mimeType : null,
        pageNumber: typeof s.pageNumber === 'number' ? s.pageNumber : null,
        sectionLabel: typeof s.sectionLabel === 'string' ? s.sectionLabel : null,
        snippet: typeof s.snippet === 'string' ? s.snippet : null,
        sourceChunkId: typeof s.sourceChunkId === 'string' ? s.sourceChunkId : null,
        availabilityAtCreation: identity === 'resolved' ? availability : null
      }
    })
  } catch {
    return []
  }
}

/**
 * Parse `evidence_reviews.generation_snapshot_json`: field-tolerant — each field survives
 * only when correctly typed; a malformed payload degrades to null (rendered "Unavailable",
 * spec §20.2 — absent, never invented).
 */
export function parseGenerationSnapshot(json: string | null): EvidenceGenerationSnapshot | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    const g = v as Record<string, unknown>
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
    const modes: ReadonlySet<string> = new Set(['relevance', 'tree', 'capped', 'extract', 'unknown'])
    return {
      generatedAt: str(g.generatedAt),
      modelId: str(g.modelId),
      modelDisplayName: str(g.modelDisplayName),
      skillId: str(g.skillId),
      skillDisplayName: str(g.skillDisplayName),
      appVersion: str(g.appVersion),
      answerTruncated: typeof g.answerTruncated === 'boolean' ? g.answerTruncated : null,
      answerMode:
        typeof g.answerMode === 'string' && modes.has(g.answerMode)
          ? (g.answerMode as EvidenceGenerationSnapshot['answerMode'])
          : null
    }
  } catch {
    return null
  }
}

/** Parse `evidence_exports.options_json`: a JSON object else null. */
function parseExportOptions(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Row shapes + row → DTO
// ---------------------------------------------------------------------------

interface ReviewRow {
  id: string
  conversation_id: string
  message_id: string
  question_message_id: string | null
  title: string
  status: string
  reviewer_label: string | null
  general_note: string | null
  answer_snapshot: string
  question_snapshot: string
  source_snapshot_json: string | null
  coverage_snapshot_json: string | null
  generation_snapshot_json: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ItemRow {
  id: string
  review_id: string
  ordinal: number
  kind: string
  block_key: string
  block_kind: string | null
  start_offset: number | null
  end_offset: number | null
  text_snapshot: string
  decision: string
  reviewer_note: string | null
  created_at: string
  updated_at: string
}

interface LinkRow {
  review_item_id: string
  evidence_key: string
  link_origin: string
  reviewer_relation: string | null
}

interface ExportRow {
  id: string
  review_id: string
  format: string
  schema_version: number
  file_name: string
  file_sha256: string
  options_json: string | null
  created_at: string
}

function rowToReview(r: ReviewRow): EvidenceReview {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    questionMessageId: r.question_message_id,
    title: r.title,
    status: normalizeStatus(r.status),
    // Derived overlay (spec §18.4) — no freshness engine exists until Phase 4, so Phase 0/1
    // honestly report "not known to be outdated" (false), never a guess.
    outdated: false,
    reviewerLabel: r.reviewer_label,
    generalNote: r.general_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at
  }
}

function rowToItem(r: ItemRow, links: EvidenceLink[]): EvidenceReviewItem {
  return {
    id: r.id,
    reviewId: r.review_id,
    ordinal: r.ordinal,
    kind: normalizeItemKind(r.kind),
    blockKey: r.block_key,
    blockKind: normalizeBlockKind(r.block_kind),
    startOffset: r.start_offset,
    endOffset: r.end_offset,
    textSnapshot: r.text_snapshot,
    decision: normalizeDecision(r.decision),
    reviewerNote: r.reviewer_note,
    links,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function rowToExport(r: ExportRow): EvidenceExportRecord {
  return {
    id: r.id,
    reviewId: r.review_id,
    format: normalizeFormat(r.format),
    schemaVersion: r.schema_version,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    options: parseExportOptions(r.options_json),
    createdAt: r.created_at
  }
}

// ---------------------------------------------------------------------------
// D-7 ready-gate derivation (pure — unit-tested as a matrix)
// ---------------------------------------------------------------------------

/**
 * Derive the ready gate over a review's items (D-7): required = block items that are not
 * headings (`blockKind === 'heading'` exempt; null/unknown counts as REQUIRED — an
 * unclassified block never silently skips review); selections never gate. Decided = any
 * decision other than 'not_reviewed' ('not_applicable' COUNTS as decided — headings arrive
 * defaulted to it, spec §12.2). `eligible` = every required item decided (vacuously true for
 * an item-less review — there is nothing to review).
 */
export function deriveReadyGate(
  items: ReadonlyArray<Pick<EvidenceReviewItem, 'kind' | 'blockKind' | 'decision'>>
): EvidenceReadyGate {
  let requiredTotal = 0
  let decidedTotal = 0
  for (const item of items) {
    if (item.kind !== 'block' || item.blockKind === 'heading') continue
    requiredTotal += 1
    if (item.decision !== 'not_reviewed') decidedTotal += 1
  }
  return { eligible: decidedTotal === requiredTotal, requiredTotal, decidedTotal }
}

// ---------------------------------------------------------------------------
// Internal reads
// ---------------------------------------------------------------------------

function readReviewRow(db: Db, reviewId: string): ReviewRow | undefined {
  return prepareCached(db, 'SELECT * FROM evidence_reviews WHERE id = ?').get(reviewId) as
    | ReviewRow
    | undefined
}

function readItemRows(db: Db, reviewId: string): ItemRow[] {
  return prepareCached(
    db,
    'SELECT * FROM evidence_review_items WHERE review_id = ? ORDER BY ordinal, created_at, id'
  ).all(reviewId) as unknown as ItemRow[]
}

function readLinksByItem(db: Db, reviewId: string): Map<string, EvidenceLink[]> {
  const rows = prepareCached(
    db,
    `SELECT l.review_item_id, l.evidence_key, l.link_origin, l.reviewer_relation
     FROM evidence_review_links l
     JOIN evidence_review_items i ON i.id = l.review_item_id
     WHERE i.review_id = ?
     ORDER BY l.created_at, l.id`
  ).all(reviewId) as unknown as LinkRow[]
  const byItem = new Map<string, EvidenceLink[]>()
  for (const r of rows) {
    const list = byItem.get(r.review_item_id) ?? []
    list.push({
      evidenceKey: r.evidence_key,
      origin: normalizeLinkOrigin(r.link_origin),
      relation: normalizeRelation(r.reviewer_relation)
    })
    byItem.set(r.review_item_id, list)
  }
  return byItem
}

function readItems(db: Db, reviewId: string): EvidenceReviewItem[] {
  const links = readLinksByItem(db, reviewId)
  return readItemRows(db, reviewId).map((r) => rowToItem(r, links.get(r.id) ?? []))
}

function readItemRowById(db: Db, itemId: string): ItemRow | undefined {
  return prepareCached(db, 'SELECT * FROM evidence_review_items WHERE id = ?').get(itemId) as
    | ItemRow
    | undefined
}

function readItemById(db: Db, itemId: string): EvidenceReviewItem | null {
  const row = readItemRowById(db, itemId)
  if (!row) return null
  const links = prepareCached(
    db,
    `SELECT review_item_id, evidence_key, link_origin, reviewer_relation
     FROM evidence_review_links WHERE review_item_id = ? ORDER BY created_at, id`
  ).all(itemId) as unknown as LinkRow[]
  return rowToItem(
    row,
    links.map((l) => ({
      evidenceKey: l.evidence_key,
      origin: normalizeLinkOrigin(l.link_origin),
      relation: normalizeRelation(l.reviewer_relation)
    }))
  )
}

/** Bump the head row's activity stamp (item/link mutations count as review activity). */
function touchReview(db: Db, reviewId: string, now: string): void {
  prepareCached(db, 'UPDATE evidence_reviews SET updated_at = ? WHERE id = ?').run(now, reviewId)
}

// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------

/** Input for the storage-level create. Phase 1's snapshot builder assembles these from the
 *  message/conversation/catalog; Phase-0 tests build them directly. */
export interface CreateEvidenceReviewInput {
  messageId: string
  /** Review title (D-6) — callers pass the conversation title as the default. */
  title: string
  questionMessageId?: string | null
  answerSnapshot: string
  questionSnapshot: string
  sources?: EvidenceSourceSnapshot[]
  coverageSnapshot?: CoverageInfo | null
  generationSnapshot?: EvidenceGenerationSnapshot | null
  reviewerLabel?: string | null
}

/**
 * Create a draft review for one assistant message. The conversation id is read from the
 * message row (never trusted from the caller). Throws on an unknown message and on a message
 * that already has a review (one ACTIVE review per message in v1 — the spec-mandated
 * service-code enforcement; callers check `getEvidenceReviewForMessage` first). Error
 * messages carry ids only — never content.
 */
export function createEvidenceReview(db: Db, input: CreateEvidenceReviewInput): EvidenceReview {
  const msg = prepareCached(db, 'SELECT id, conversation_id FROM messages WHERE id = ?').get(
    input.messageId
  ) as { id: string; conversation_id: string } | undefined
  if (!msg) {
    throw new Error(`evidence review: message not found (${input.messageId})`)
  }
  const existing = prepareCached(
    db,
    'SELECT id FROM evidence_reviews WHERE message_id = ? LIMIT 1'
  ).get(input.messageId) as { id: string } | undefined
  if (existing) {
    throw new Error(`evidence review: a review already exists for message ${input.messageId}`)
  }
  const now = nowIso()
  const review: EvidenceReview = {
    id: randomUUID(),
    conversationId: msg.conversation_id,
    messageId: input.messageId,
    questionMessageId: input.questionMessageId ?? null,
    title: input.title,
    status: 'draft',
    outdated: false,
    reviewerLabel: input.reviewerLabel ?? null,
    generalNote: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  }
  prepareCached(
    db,
    `INSERT INTO evidence_reviews
       (id, conversation_id, message_id, question_message_id, title, status, reviewer_label,
        general_note, answer_snapshot, question_snapshot, source_snapshot_json,
        coverage_snapshot_json, generation_snapshot_json, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    review.id,
    review.conversationId,
    review.messageId,
    review.questionMessageId ?? null,
    review.title,
    review.status,
    review.reviewerLabel ?? null,
    review.generalNote ?? null,
    input.answerSnapshot,
    input.questionSnapshot,
    safeJson(input.sources && input.sources.length > 0 ? input.sources : null),
    safeJson(input.coverageSnapshot ?? null),
    safeJson(input.generationSnapshot ?? null),
    review.createdAt,
    review.updatedAt,
    review.completedAt ?? null
  )
  return review
}

/** The full review read-model, or null when the id is unknown. Never throws on stored data —
 *  every JSON column degrades tolerantly (see module header). */
export function getEvidenceReview(db: Db, reviewId: string): EvidenceReviewDetail | null {
  const row = readReviewRow(db, reviewId)
  if (!row) return null
  const items = readItems(db, reviewId)
  const exports = listEvidenceExports(db, reviewId)
  return {
    ...rowToReview(row),
    answerSnapshot: row.answer_snapshot,
    questionSnapshot: row.question_snapshot,
    sources: parseSourceSnapshots(row.source_snapshot_json),
    coverageSnapshot: parseCoverage(row.coverage_snapshot_json) ?? null,
    generationSnapshot: parseGenerationSnapshot(row.generation_snapshot_json),
    items,
    exports,
    gate: deriveReadyGate(items)
  }
}

/** The entry-point read (chat action row): the message's review as a light summary, or null. */
export function getEvidenceReviewForMessage(db: Db, messageId: string): EvidenceReviewSummary | null {
  const row = prepareCached(
    db,
    'SELECT * FROM evidence_reviews WHERE message_id = ? LIMIT 1'
  ).get(messageId) as ReviewRow | undefined
  if (!row) return null
  const head = rowToReview(row)
  return {
    id: head.id,
    conversationId: head.conversationId,
    messageId: head.messageId,
    title: head.title,
    status: head.status,
    outdated: head.outdated,
    gate: deriveReadyGate(readItemRows(db, row.id).map((r) => rowToItem(r, []))),
    updatedAt: head.updatedAt
  }
}

/** How many reviews a conversation's messages carry (the D-2 delete-confirm count). */
export function countEvidenceReviewsForConversation(db: Db, conversationId: string): number {
  const row = prepareCached(
    db,
    'SELECT COUNT(*) AS n FROM evidence_reviews WHERE conversation_id = ?'
  ).get(conversationId) as { n: number } | undefined
  return row?.n ?? 0
}

/** Patch head fields (title rename D-6, reviewer label D-3, general note). A title that
 *  trims empty is ignored (a review is never left unnamed). Returns null on unknown id. */
export function updateEvidenceReview(
  db: Db,
  reviewId: string,
  patch: EvidenceReviewPatch
): EvidenceReview | null {
  const row = readReviewRow(db, reviewId)
  if (!row) return null
  const title =
    patch.title !== undefined && patch.title.trim().length > 0 ? patch.title.trim() : row.title
  const reviewerLabel = patch.reviewerLabel !== undefined ? patch.reviewerLabel : row.reviewer_label
  const generalNote = patch.generalNote !== undefined ? patch.generalNote : row.general_note
  const now = nowIso()
  prepareCached(
    db,
    'UPDATE evidence_reviews SET title = ?, reviewer_label = ?, general_note = ?, updated_at = ? WHERE id = ?'
  ).run(title, reviewerLabel, generalNote, now, reviewId)
  return rowToReview({ ...row, title, reviewer_label: reviewerLabel, general_note: generalNote, updated_at: now })
}

/**
 * Mark a review ready (spec §18.4) — only when the D-7 gate is met; otherwise the review is
 * returned unchanged with the gate so callers can say exactly why ("N of M decided"). Null on
 * unknown id.
 */
export function markEvidenceReviewReady(
  db: Db,
  reviewId: string
): { review: EvidenceReview; gate: EvidenceReadyGate } | null {
  const row = readReviewRow(db, reviewId)
  if (!row) return null
  const gate = deriveReadyGate(readItemRows(db, reviewId).map((r) => rowToItem(r, [])))
  if (!gate.eligible) {
    return { review: rowToReview(row), gate }
  }
  const now = nowIso()
  prepareCached(
    db,
    "UPDATE evidence_reviews SET status = 'ready', completed_at = ?, updated_at = ? WHERE id = ?"
  ).run(now, now, reviewId)
  return { review: rowToReview({ ...row, status: 'ready', completed_at: now, updated_at: now }), gate }
}

/** Manually reopen a ready review (spec §18.4: back to draft, completion stamp cleared). */
export function reopenEvidenceReview(db: Db, reviewId: string): EvidenceReview | null {
  const row = readReviewRow(db, reviewId)
  if (!row) return null
  const now = nowIso()
  prepareCached(
    db,
    "UPDATE evidence_reviews SET status = 'draft', completed_at = NULL, updated_at = ? WHERE id = ?"
  ).run(now, reviewId)
  return rowToReview({ ...row, status: 'draft', completed_at: null, updated_at: now })
}

/** Delete a review; items/links/exports go with it via FK CASCADE (foreign_keys is ON). */
export function deleteEvidenceReview(db: Db, reviewId: string): boolean {
  const result = prepareCached(db, 'DELETE FROM evidence_reviews WHERE id = ?').run(reviewId)
  return Number(result.changes) > 0
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

/** Storage-level item input (Phase 1's segmenter output; Phase-0 tests build these directly). */
export interface NewEvidenceReviewItemInput {
  kind: 'block' | 'selection'
  blockKey: string
  blockKind?: AnswerBlockKind | null
  startOffset?: number | null
  endOffset?: number | null
  textSnapshot: string
  /** Defaults to 'not_reviewed' — callers set 'not_applicable' for headings (spec §12.2). */
  decision?: ReviewDecision
  reviewerNote?: string | null
  /** Explicit render position; defaults to appending after the current max ordinal. */
  ordinal?: number
}

/**
 * Insert a batch of items in ONE transaction (a crash mid-insert must not leave a
 * half-itemed review — the deleteConversation REL-4 wrap). Returns the created items in
 * input order. Throws on an unknown review id.
 */
export function createEvidenceReviewItems(
  db: Db,
  reviewId: string,
  inputs: NewEvidenceReviewItemInput[]
): EvidenceReviewItem[] {
  const review = readReviewRow(db, reviewId)
  if (!review) {
    throw new Error(`evidence review: review not found (${reviewId})`)
  }
  if (inputs.length === 0) return []
  const maxRow = prepareCached(
    db,
    'SELECT MAX(ordinal) AS m FROM evidence_review_items WHERE review_id = ?'
  ).get(reviewId) as { m: number | null } | undefined
  let nextOrdinal = (maxRow?.m ?? -1) + 1
  const now = nowIso()
  const created: EvidenceReviewItem[] = []
  db.exec('BEGIN')
  try {
    for (const input of inputs) {
      const item: EvidenceReviewItem = {
        id: randomUUID(),
        reviewId,
        ordinal: input.ordinal ?? nextOrdinal++,
        kind: input.kind,
        blockKey: input.blockKey,
        blockKind: input.blockKind ?? null,
        startOffset: input.startOffset ?? null,
        endOffset: input.endOffset ?? null,
        textSnapshot: input.textSnapshot,
        decision: input.decision ?? 'not_reviewed',
        reviewerNote: input.reviewerNote ?? null,
        links: [],
        createdAt: now,
        updatedAt: now
      }
      prepareCached(
        db,
        `INSERT INTO evidence_review_items
           (id, review_id, ordinal, kind, block_key, block_kind, start_offset, end_offset,
            text_snapshot, decision, reviewer_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        item.id,
        item.reviewId,
        item.ordinal,
        item.kind,
        item.blockKey,
        item.blockKind ?? null,
        item.startOffset ?? null,
        item.endOffset ?? null,
        item.textSnapshot,
        item.decision,
        item.reviewerNote ?? null,
        item.createdAt,
        item.updatedAt
      )
      created.push(item)
    }
    touchReview(db, reviewId, now)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure as the thrown error */
    }
    throw err
  }
  return created
}

/** Patch one item's decision/note; bumps the item AND the head activity stamp. Null on unknown id. */
export function updateEvidenceReviewItem(
  db: Db,
  itemId: string,
  patch: EvidenceReviewItemPatch
): EvidenceReviewItem | null {
  const row = readItemRowById(db, itemId)
  if (!row) return null
  // A note-only patch keeps the stored decision byte-identical (even a malformed one is
  // only normalized on READ — an unrelated write never silently rewrites it).
  const decision: string = patch.decision !== undefined ? patch.decision : row.decision
  const reviewerNote = patch.reviewerNote !== undefined ? patch.reviewerNote : row.reviewer_note
  const now = nowIso()
  prepareCached(
    db,
    'UPDATE evidence_review_items SET decision = ?, reviewer_note = ?, updated_at = ? WHERE id = ?'
  ).run(decision, reviewerNote, now, itemId)
  touchReview(db, row.review_id, now)
  return readItemById(db, itemId)
}

/**
 * Create a reviewer selection (spec §12.1) carved from one existing BLOCK item: offsets are
 * UTF-16 code-unit indexes into that block's `text_snapshot` (exclusive end); the selection's
 * own snapshot is the exact slice. Returns null when the review or block is unknown or the
 * offsets are out of range — never a clamped/fabricated selection.
 */
export function createEvidenceSelection(
  db: Db,
  reviewId: string,
  input: EvidenceSelectionInput
): EvidenceReviewItem | null {
  const block = prepareCached(
    db,
    "SELECT * FROM evidence_review_items WHERE review_id = ? AND block_key = ? AND kind = 'block' LIMIT 1"
  ).get(reviewId, input.blockKey) as ItemRow | undefined
  if (!block) return null
  const { startOffset, endOffset } = input
  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > block.text_snapshot.length
  ) {
    return null
  }
  const [item] = createEvidenceReviewItems(db, reviewId, [
    {
      kind: 'selection',
      blockKey: block.block_key,
      blockKind: normalizeBlockKind(block.block_kind),
      startOffset,
      endOffset,
      textSnapshot: block.text_snapshot.slice(startOffset, endOffset)
    }
  ])
  return item
}

/** Delete a reviewer SELECTION. Block items are structural (the gate counts them) and are
 *  never deleted here — returns false for them and for unknown ids. */
export function deleteEvidenceSelection(db: Db, itemId: string): boolean {
  const row = readItemRowById(db, itemId)
  if (!row || normalizeItemKind(row.kind) !== 'selection') return false
  prepareCached(db, 'DELETE FROM evidence_review_items WHERE id = ?').run(itemId)
  touchReview(db, row.review_id, nowIso())
  return true
}

// ---------------------------------------------------------------------------
// Link CRUD
// ---------------------------------------------------------------------------

/**
 * Upsert one link (item → source `evidenceKey`): at most one row per (item, key) — a second
 * set updates origin/relation in place. The key must name a source present in the review's
 * snapshot (links to nothing are refused — the table has no FK into the JSON). Returns the
 * refreshed item, or null on unknown item/key.
 */
export function setEvidenceLink(
  db: Db,
  itemId: string,
  evidenceKey: string,
  input: EvidenceLinkInput
): EvidenceReviewItem | null {
  const item = readItemRowById(db, itemId)
  if (!item) return null
  const review = readReviewRow(db, item.review_id)
  if (!review) return null
  const known = parseSourceSnapshots(review.source_snapshot_json).some((s) => s.key === evidenceKey)
  if (!known) return null
  const origin = normalizeLinkOrigin(input.origin)
  const relation = normalizeRelation(input.relation)
  const now = nowIso()
  const existing = prepareCached(
    db,
    'SELECT id FROM evidence_review_links WHERE review_item_id = ? AND evidence_key = ? LIMIT 1'
  ).get(itemId, evidenceKey) as { id: string } | undefined
  if (existing) {
    prepareCached(
      db,
      'UPDATE evidence_review_links SET link_origin = ?, reviewer_relation = ? WHERE id = ?'
    ).run(origin, relation, existing.id)
  } else {
    prepareCached(
      db,
      `INSERT INTO evidence_review_links (id, review_item_id, evidence_key, link_origin, reviewer_relation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), itemId, evidenceKey, origin, relation, now)
  }
  touchReview(db, item.review_id, now)
  return readItemById(db, itemId)
}

/** Remove one link by (item, key). Returns true when a row was deleted. */
export function removeEvidenceLink(db: Db, itemId: string, evidenceKey: string): boolean {
  const item = readItemRowById(db, itemId)
  if (!item) return false
  const result = prepareCached(
    db,
    'DELETE FROM evidence_review_links WHERE review_item_id = ? AND evidence_key = ?'
  ).run(itemId, evidenceKey)
  if (Number(result.changes) === 0) return false
  touchReview(db, item.review_id, nowIso())
  return true
}

// ---------------------------------------------------------------------------
// Export records (D-8: metadata + hash only — the file itself is never kept)
// ---------------------------------------------------------------------------

export interface RecordEvidenceExportInput {
  reviewId: string
  format: EvidenceExportFormat
  schemaVersion: number
  /** Bare file name (no directory — the destination path is deliberately not persisted). */
  fileName: string
  fileSha256: string
  options?: Record<string, unknown> | null
}

/** Record one completed export. Returns null on an unknown review (no orphan rows). */
export function recordEvidenceExport(
  db: Db,
  input: RecordEvidenceExportInput
): EvidenceExportRecord | null {
  const review = readReviewRow(db, input.reviewId)
  if (!review) return null
  const record: EvidenceExportRecord = {
    id: randomUUID(),
    reviewId: input.reviewId,
    format: input.format,
    schemaVersion: input.schemaVersion,
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    options: input.options ?? null,
    createdAt: nowIso()
  }
  prepareCached(
    db,
    `INSERT INTO evidence_exports (id, review_id, format, schema_version, file_name, file_sha256, options_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.reviewId,
    record.format,
    record.schemaVersion,
    record.fileName,
    record.fileSha256,
    safeJson(record.options),
    record.createdAt
  )
  return record
}

/** A review's export history, newest first. */
export function listEvidenceExports(db: Db, reviewId: string): EvidenceExportRecord[] {
  const rows = prepareCached(
    db,
    'SELECT * FROM evidence_exports WHERE review_id = ? ORDER BY created_at DESC, id'
  ).all(reviewId) as unknown as ExportRow[]
  return rows.map(rowToExport)
}
