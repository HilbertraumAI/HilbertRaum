import type {
  Citation,
  CoverageInfo,
  EvidenceGenerationSnapshot,
  EvidenceReviewDetail,
  EvidenceSourceSnapshot
} from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { prepareCached, type Db } from '../db'
import { parseCitations, parseCoverage } from '../chat'
import {
  createEvidenceReview,
  getEvidenceReview,
  insertEvidenceReviewItems,
  setEvidenceLink,
  type NewEvidenceReviewItemInput
} from '../evidence-reviews'
import { segmentAnswerBlocks } from './segment'

// Evidence Pack / Review Mode — snapshot builder (EP-1 plan §6.3): assemble a complete,
// honest, deterministic DRAFT review for one persisted assistant message, from PERSISTED
// data only. No model call, no network, no re-retrieval — ever (spec FR-2/FR-12; the
// no-model/no-network test assertions pin it). Everything the review will later render or
// export is FROZEN here: the answer/question text, the source identities, the generation
// metadata. Honesty rules:
//  - Source identity is resolved, never guessed: a citation's `documentId` (post-Phase-0
//    answers) pins the row; a legacy citation resolves by EXACT title match only when the
//    match is unique — zero or multiple matches → `identity: 'unresolved'` (distinct from
//    a resolved-but-deleted source, which is `availabilityAtCreation: 'missing'`).
//  - Generation metadata is synthesized from the conversation row + injected app/catalog
//    facts (plan §1.3); every field optional — absent renders "Unavailable", never invented
//    (spec §20.2/§25.5).
//  - Auto-links land ONLY for direct-excerpt (relevance-path) answers, marker → citation by
//    machine label; whole-document answers get ZERO auto-links (spec §13.3 — hard rule).

/** Facts the builder cannot read from the workspace DB, injected by the IPC layer so this
 *  module stays electron-free and deterministic under test. */
export interface EvidenceSnapshotDeps {
  /** `AppStatus.appVersion` (electron `app.getVersion()`); absent → null, never invented. */
  appVersion?: string | null
  /** Resolve a model id to its LIVE catalog display name (`findManifestById(...).displayName`);
   *  absent/unresolvable → null (the id still records). */
  modelDisplayName?: (modelId: string) => string | null
}

// Persist-canonical English (i18n boundary rule 1, the chat.ts DEFAULT_TITLE precedent):
// the fallback review title is written into `evidence_reviews.title` in canonical English;
// the renderer display map translates it at render time (D-L4).
const DEFAULT_REVIEW_TITLE = t('en', 'main.evidenceReviews.defaultTitle')

interface SnapshotMessageRow {
  rid: number
  id: string
  conversation_id: string
  role: string
  content: string
  created_at: string
  citations_json: string | null
  coverage_json: string | null
  truncated: number | null
  skill_id: string | null
  skill_title: string | null
}

interface DocumentRow {
  id: string
  title: string
  sha256: string | null
  mime_type: string | null
}

/**
 * Map an answer's coverage mode to the source honesty class (plan §6.3).
 *
 * - ABSENT mode (legacy pre-D72 rows — the relevance path stamped nothing before #24) reads
 *   as the relevance path, exactly like the renderer's established fallback
 *   (`SourcesDisclosure`'s `isProvenance = mode != null && mode !== 'relevance'`): those
 *   answers' persisted citations ARE labeled excerpts supplied to the model, and presenting
 *   them as "derived through whole-document analysis" would be the invented claim. The
 *   GENERATION snapshot still records `answerMode: 'unknown'` for them.
 * - A PRESENT-but-unrecognized mode string (reachable: `parseCoverage` accepts any string,
 *   so a portable workspace written by a NEWER app version can carry a mode this build has
 *   never heard of) maps to the WEAKEST claim, `whole_document_provenance` — no machine
 *   labels, ZERO auto-links (Phase-1 review FIX-1: the repo's tolerant-default direction;
 *   an unknown mode must never mint "cited by the answer" claims). The `never` assignment
 *   keeps the switch compile-time exhaustive: a NEW `CoverageMode` member reds this
 *   function until it is mapped deliberately.
 */
export function sourceKindForMode(
  mode: CoverageInfo['mode'] | undefined
): EvidenceSourceSnapshot['kind'] {
  if (mode === undefined) return 'direct_excerpt'
  switch (mode) {
    case 'relevance':
      return 'direct_excerpt'
    case 'tree':
    case 'capped':
      return 'whole_document_provenance'
    case 'extract':
      return 'structured_record'
    default: {
      // Compile-time: exhaustive over the known union — a new CoverageMode member fails
      // this assignment. Runtime: an unknown stored string lands here → weakest claim.
      const unknownMode: never = mode
      void unknownMode
      return 'whole_document_provenance'
    }
  }
}

/**
 * Freeze one source snapshot per persisted citation. `key` is the citation's machine label
 * (uniquified `label.N` on a duplicate — defensive; labels are unique by construction);
 * `machineLabel` is set ONLY for direct excerpts (spec §18.2: absent for provenance-only
 * sources — a whole-document answer's `[Sn]` provenance labels are never citation markers,
 * rag-design §14.4 M2), which also makes marker auto-linking structurally impossible for
 * whole-document answers. Exported for the per-class integration tests.
 */
export function buildEvidenceSourceSnapshots(
  db: Db,
  citations: Citation[],
  kind: EvidenceSourceSnapshot['kind']
): EvidenceSourceSnapshot[] {
  const byId = prepareCached(db, 'SELECT id, title, sha256, mime_type FROM documents WHERE id = ?')
  const byTitle = prepareCached(
    db,
    'SELECT id, title, sha256, mime_type FROM documents WHERE title = ? LIMIT 2'
  )
  const usedKeys = new Set<string>()
  return citations.map((c, index) => {
    let key = c.label && c.label.length > 0 ? c.label : `src${index + 1}`
    if (usedKeys.has(key)) key = `${key}.${index + 1}`
    usedKeys.add(key)

    let identity: EvidenceSourceSnapshot['identity'] = 'unresolved'
    let availability: 'available' | 'missing' | null = null
    let documentId: string | null = null
    let documentTitle = c.sourceTitle
    let documentSha256: string | null = null
    let mimeType: string | null = null

    if (c.documentId) {
      // Post-Phase-0 citation: the id pins identity even when the row is gone (a deleted
      // source is a RESOLVED identity that is missing — spec §25.2, never "unresolved").
      identity = 'resolved'
      documentId = c.documentId
      const row = byId.get(c.documentId) as DocumentRow | undefined
      if (row) {
        availability = 'available'
        documentTitle = row.title
        documentSha256 = row.sha256
        mimeType = row.mime_type
      } else {
        availability = 'missing'
      }
    } else {
      // Legacy citation: EXACT title match, accepted only when UNIQUE — zero or multiple
      // matches stay 'unresolved' (never guess which document was meant; plan §1.2).
      const rows = byTitle.all(c.sourceTitle) as unknown as DocumentRow[]
      if (rows.length === 1) {
        identity = 'resolved'
        availability = 'available'
        documentId = rows[0]!.id
        documentTitle = rows[0]!.title
        documentSha256 = rows[0]!.sha256
        mimeType = rows[0]!.mime_type
      }
    }

    return {
      key,
      machineLabel: kind === 'direct_excerpt' ? c.label : null,
      kind,
      identity,
      documentId,
      documentTitle,
      documentSha256,
      mimeType,
      pageNumber: c.pageNumber ?? null,
      sectionLabel: c.section ?? null,
      snippet: c.snippet ?? null,
      sourceChunkId: c.chunkId ?? null,
      availabilityAtCreation: identity === 'resolved' ? availability : null
    }
  })
}

/**
 * Create the complete draft review for `messageId` (plan §6 goal): head + frozen snapshots,
 * one block item per deterministic answer segment (headings default 'not_applicable',
 * `block_kind` persisted on EVERY item), and `origin: 'answer_marker'` links for
 * direct-excerpt answers only. Reads persisted rows exclusively. Throws (ids-only messages)
 * on an unknown message, a non-assistant message, or an already-reviewed message — the IPC
 * layer pre-checks the latter via `getEvidenceReviewForMessage`.
 */
export function createEvidenceReviewFromMessage(
  db: Db,
  messageId: string,
  deps: EvidenceSnapshotDeps = {}
): EvidenceReviewDetail {
  const msg = prepareCached(
    db,
    `SELECT m.rowid AS rid, m.id, m.conversation_id, m.role, m.content, m.created_at,
            m.citations_json, m.coverage_json, m.truncated, m.skill_id, s.title AS skill_title
       FROM messages m LEFT JOIN skills s ON s.install_id = m.skill_id
      WHERE m.id = ?`
  ).get(messageId) as SnapshotMessageRow | undefined
  if (!msg) {
    throw new Error(`evidence review: message not found (${messageId})`)
  }
  if (msg.role !== 'assistant') {
    throw new Error(`evidence review: message is not an assistant answer (${messageId})`)
  }
  const conv = prepareCached(db, 'SELECT title, model_id FROM conversations WHERE id = ?').get(
    msg.conversation_id
  ) as { title: string; model_id: string | null } | undefined

  // The question turn: the nearest PRECEDING user message (compaction artifacts excluded,
  // the listMessages filter). None identifiable → null id + '' snapshot, never invented.
  const question = prepareCached(
    db,
    `SELECT id, content FROM messages
      WHERE conversation_id = ? AND role = 'user' AND kind IS NOT 'compaction' AND rowid < ?
      ORDER BY rowid DESC LIMIT 1`
  ).get(msg.conversation_id, msg.rid) as { id: string; content: string } | undefined

  const citations = parseCitations(msg.citations_json) ?? []
  const coverage = parseCoverage(msg.coverage_json) ?? null
  const kind = sourceKindForMode(coverage?.mode)
  const sources = buildEvidenceSourceSnapshots(db, citations, kind)

  const modelId = conv?.model_id ?? null
  const generation: EvidenceGenerationSnapshot = {
    generatedAt: msg.created_at,
    modelId,
    modelDisplayName: (modelId ? deps.modelDisplayName?.(modelId) : null) ?? null,
    skillId: msg.skill_id,
    skillDisplayName: msg.skill_title,
    appVersion: deps.appVersion ?? null,
    // Positive flag only: 1 = honestly recorded as cut off; NULL/0 = no truncation recorded
    // (null, not false — a pre-migration row never gains a "complete" claim).
    answerTruncated: msg.truncated === 1 ? true : null,
    answerMode: coverage?.mode ?? 'unknown'
  }

  const blocks = segmentAnswerBlocks(msg.content)

  // ONE transaction around head + items + links (Phase-1 review FIX-2): a draft is
  // all-or-nothing — a thrown error rolls everything back (the swallowed-rollback nesting
  // keeps the ORIGINAL failure as the thrown error, the deleteConversation REL-4 shape),
  // and a process crash leaves an uncommitted journal SQLite discards on the next open. A
  // half-built review must never persist: the idempotent IPC create would adopt it forever
  // (zero items ⇒ a vacuously eligible gate ⇒ an empty review could be marked ready).
  let reviewId: string
  db.exec('BEGIN')
  try {
    const review = createEvidenceReview(db, {
      messageId,
      // D-6: conversation title default; a title that trims empty falls back to the
      // persist-canonical English default so a review is never unnamed.
      title: (conv?.title ?? '').trim().length > 0 ? conv!.title : DEFAULT_REVIEW_TITLE,
      questionMessageId: question?.id ?? null,
      answerSnapshot: msg.content,
      questionSnapshot: question?.content ?? '',
      sources,
      coverageSnapshot: coverage,
      generationSnapshot: generation
    })
    reviewId = review.id

    // Items FIRST, links AFTER — `setEvidenceLink` validates keys against the review's
    // already-written source snapshot (Phase-0 contract), so the order is load-bearing.
    // `insertEvidenceReviewItems` is the NON-transactional core: this function owns the
    // transaction (SQLite refuses nested BEGIN).
    const items = insertEvidenceReviewItems(
      db,
      review.id,
      blocks.map(
        (b): NewEvidenceReviewItemInput => ({
          kind: 'block',
          blockKey: b.blockKey,
          blockKind: b.blockKind,
          textSnapshot: b.text,
          ordinal: b.ordinal,
          // Spec §12.2: headings default 'not_applicable' (still re-decidable); everything
          // else starts honestly undecided.
          decision: b.blockKind === 'heading' ? 'not_applicable' : 'not_reviewed'
        })
      )
    )

    // Auto-links (spec §13.1/§13.3): DIRECT-EXCERPT answers only — marker → source by
    // machine label. Whole-document/structured/unknown-mode answers get ZERO auto-links:
    // their kinds carry no `machineLabel`, and this branch never runs for them (belt and
    // braces).
    if (kind === 'direct_excerpt') {
      const keyByLabel = new Map<string, string>()
      for (const s of sources) {
        if (s.machineLabel && !keyByLabel.has(s.machineLabel)) keyByLabel.set(s.machineLabel, s.key)
      }
      for (let i = 0; i < items.length; i++) {
        for (const label of blocks[i]!.markers) {
          const key = keyByLabel.get(label)
          if (!key) continue // a marker with no persisted citation links nothing — never invent
          const linked = setEvidenceLink(db, items[i]!.id, key, { origin: 'answer_marker' })
          if (!linked) {
            throw new Error(`evidence review: auto-link failed (${review.id})`)
          }
        }
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* keep the original failure as the thrown error */
    }
    throw err
  }

  const detail = getEvidenceReview(db, reviewId)
  if (!detail) {
    throw new Error(`evidence review: draft readback failed (${reviewId})`)
  }
  return detail
}
