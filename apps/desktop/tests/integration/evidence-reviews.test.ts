import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  appendMessage,
  createConversation,
  deleteConversation,
  listMessages
} from '../../src/main/services/chat'
import {
  countEvidenceReviewsForConversation,
  createEvidenceReview,
  createEvidenceReviewItems,
  createEvidenceSelection,
  deleteEvidenceReview,
  deleteEvidenceSelection,
  getEvidenceReview,
  getEvidenceReviewForMessage,
  listEvidenceExports,
  markEvidenceReviewReady,
  recordEvidenceExport,
  removeEvidenceLink,
  reopenEvidenceReview,
  setEvidenceLink,
  updateEvidenceReview,
  updateEvidenceReviewItem
} from '../../src/main/services/evidence-reviews'
import { computeEvidenceReviewFreshness } from '../../src/main/services/evidence-pack/freshness'
import { MockEmbedder } from '../../src/main/services/embeddings'
import {
  answerWholeDocFromChunks,
  ragSettingsFrom,
  retrieve,
  retrieveCompareDiff,
  retrieveWholeDocument
} from '../../src/main/services/rag'
import { documentLeafProvenance } from '../../src/main/services/analysis/coverage'
import type { ModelRuntime } from '../../src/main/services/runtime'
import { DEFAULT_SETTINGS, type EvidenceSourceSnapshot, type ReviewDecision } from '../../src/shared/types'
import { chunkIdsOf, seedEmbeddedDoc, seedReadyTree } from '../helpers/doc-fixtures'
import { freshWorkspaceDb, legacyDbPath, listTables } from '../helpers/db-fixtures'
import {
  seedAssistantAnswer,
  seedEvidenceReview,
  seedReviewChain,
  seedSourceDocument
} from '../helpers/evidence-fixtures'

// EP-1 Phase 0 (evidence-pack plan §5) — the persisted layer: schema creation, full
// round-trips through SQLite (incl. Unicode/markdown/hostile strings), tolerant parsing of
// malformed stored JSON, FK-cascade behavior through the REAL deleteConversation, the D-7
// ready gate over stored rows, and the additive Citation.documentId/chunkId enrichment.

const EVIDENCE_TABLES = [
  'evidence_reviews',
  'evidence_review_items',
  'evidence_review_links',
  'evidence_exports'
] as const

/** The assistant answer every review here is created on (`seedAssistantAnswer`, the REAL chat service). */
const ANSWER = 'The contract allows termination. [S1]'

const HOSTILE = {
  title: `Über-Prüfung 📋 <script>alert('x')</script> '; DROP TABLE evidence_reviews;--`,
  answer: [
    '# Findings 覚書 مرحبا',
    '',
    'Termination requires **30 days** notice. [S1]',
    '',
    '```sql',
    "DELETE FROM users; -- not real code',",
    '```',
    '',
    '> Quote with 👩‍👩‍👧‍👧 family emoji and `inline [S1] code`'
  ].join('\n'),
  question: 'Was gilt für Kündigungsfristen? § 5 & <b>Notice</b>',
  note: 'Reviewer note with\nnewlines\tand "quotes" and \\backslashes\\ and 𝔘𝔫𝔦𝔠𝔬𝔡𝔢'
}

const SOURCES: EvidenceSourceSnapshot[] = [
  {
    key: 'S1',
    machineLabel: 'S1',
    kind: 'direct_excerpt',
    identity: 'resolved',
    documentId: 'doc-abc',
    documentTitle: 'Vertrag — §5 Kündigung.pdf',
    documentSha256: 'deadbeef'.repeat(8),
    mimeType: 'application/pdf',
    pageNumber: 5,
    sectionLabel: '§5',
    snippet: 'Die Kündigungsfrist beträgt 30 Tage. <em>escaped later</em>',
    sourceChunkId: 'chunk-1',
    availabilityAtCreation: 'available'
  },
  {
    key: 'S2',
    machineLabel: null,
    kind: 'whole_document_provenance',
    identity: 'unresolved',
    documentTitle: 'legacy-title-only.txt'
  }
]

/** `evidence_reviews` as P0–P3 wrote it: every column except P4's freshness_ack_json. */
const P3_EVIDENCE_REVIEWS = `CREATE TABLE evidence_reviews (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, question_message_id TEXT,
  title TEXT NOT NULL, status TEXT NOT NULL, reviewer_label TEXT, general_note TEXT,
  answer_snapshot TEXT NOT NULL, question_snapshot TEXT NOT NULL, source_snapshot_json TEXT,
  coverage_snapshot_json TEXT, generation_snapshot_json TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, completed_at TEXT,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
)`

describe('schema (plan §5 item 3)', () => {
  it('re-opening an existing DB is idempotent and preserves review data across restarts', () => {
    const { db: first, root } = freshWorkspaceDb('epreviews')
    const fresh = listTables(first)
    for (const t of EVIDENCE_TABLES) expect(fresh).toContain(t) // A1: a fresh DB creates all four
    const { messageId } = seedAssistantAnswer(first, { content: ANSWER })
    const review = createEvidenceReview(first, {
      messageId,
      title: HOSTILE.title,
      answerSnapshot: HOSTILE.answer,
      questionSnapshot: HOSTILE.question,
      sources: SOURCES
    })
    // IP6 (moved from evidence-reviews-ipc): decided items, notes and the reviewer label survive the restart too.
    const [item] = createEvidenceReviewItems(first, review.id, [
      {
        kind: 'block',
        blockKey: 'b0-paragraph-restart',
        blockKind: 'paragraph',
        textSnapshot: 'Termination requires **30 days** notice. [S1]'
      }
    ])
    updateEvidenceReviewItem(first, item!.id, { decision: 'supported', reviewerNote: HOSTILE.note })
    updateEvidenceReview(first, review.id, { reviewerLabel: 'QA' })
    first.close()

    const db = openDatabase(join(root, 'test.sqlite')) // the restart: migrations re-run, IF NOT EXISTS must not clobber
    const tables = listTables(db)
    for (const t of EVIDENCE_TABLES) expect(tables).toContain(t)
    const detail = getEvidenceReview(db, review.id)
    expect(detail?.title).toBe(HOSTILE.title)
    expect(detail?.answerSnapshot).toBe(HOSTILE.answer)
    expect(detail?.reviewerLabel).toBe('QA')
    expect(detail?.sources[0]?.documentTitle).toBe(SOURCES[0]!.documentTitle)
    expect(detail?.items.map((i) => [i.id, i.decision, i.reviewerNote])).toEqual([[item!.id, 'supported', HOSTILE.note]])
  })

  it('a workspace written before EP-1 P4 (no freshness_ack_json) gains the acknowledge column on open', () => {
    const db = openDatabase(legacyDbPath('epreviews-p3', (raw) => raw.exec(P3_EVIDENCE_REVIEWS)))
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('evidence_reviews') WHERE name = 'freshness_ack_json'").get()
    ).toEqual({ n: 1 })
    // Every freshness read selects the column, so a review on the upgraded table opens with an honest verdict.
    const docId = seedSourceDocument(db, { title: 'contract.pdf' })
    const { messageId } = seedAssistantAnswer(db, {
      content: 'Claim. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'contract.pdf', documentId: docId }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const review = seedEvidenceReview(db, { messageId })
    expect(computeEvidenceReviewFreshness(db, review.id)).toMatchObject({ outdated: false, acknowledgedAt: null })
  })
})

describe('round-trip through SQLite (plan §5 tests — Unicode/markdown/hostile strings)', () => {
  it('review + items + links + exports round-trip byte-identically', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { conversationId, messageId } = seedAssistantAnswer(db, { content: ANSWER })

    const review = createEvidenceReview(db, {
      messageId,
      title: HOSTILE.title,
      answerSnapshot: HOSTILE.answer,
      questionSnapshot: HOSTILE.question,
      sources: SOURCES,
      coverageSnapshot: { mode: 'relevance', chunksCovered: 3, chunksTotal: 12 },
      generationSnapshot: {
        generatedAt: '2026-07-18T09:00:00.000Z',
        modelId: 'qwen3-4b-instruct-q4',
        appVersion: '0.1.52',
        answerTruncated: false,
        answerMode: 'relevance'
      },
      reviewerLabel: 'Dr. Käthe Müller-Lüdenscheidt'
    })
    expect(review.conversationId).toBe(conversationId)
    expect(review.status).toBe('draft')
    expect(review.outdated).toBe(false)

    const [para, heading] = createEvidenceReviewItems(db, review.id, [
      {
        kind: 'block',
        blockKey: 'b0:paragraph:abcd',
        blockKind: 'paragraph',
        textSnapshot: 'Termination requires **30 days** notice. [S1]'
      },
      {
        kind: 'block',
        blockKey: 'b1:heading:ef01',
        blockKind: 'heading',
        textSnapshot: '# Findings 覚書 مرحبا',
        decision: 'not_applicable'
      }
    ])
    const noted = updateEvidenceReviewItem(db, para.id, {
      decision: 'partly_supported',
      reviewerNote: HOSTILE.note
    })
    expect(noted?.decision).toBe('partly_supported')
    expect(noted?.reviewerNote).toBe(HOSTILE.note)

    // Selection carved from the paragraph (offsets against the SNAPSHOT text).
    const selection = createEvidenceSelection(db, review.id, {
      blockKey: para.blockKey,
      startOffset: 0,
      endOffset: 21
    })
    expect(selection?.kind).toBe('selection')
    expect(selection?.textSnapshot).toBe('Termination requires ')

    // Links: an answer-marker link and a reviewer link with a relation flag.
    expect(setEvidenceLink(db, para.id, 'S1', { origin: 'answer_marker' })?.links).toEqual([
      { evidenceKey: 'S1', origin: 'answer_marker', relation: null }
    ])
    setEvidenceLink(db, para.id, 'S2', { origin: 'reviewer', relation: 'contradicts' })
    // Upsert: re-setting the same (item, key) updates in place — never a duplicate row.
    setEvidenceLink(db, para.id, 'S2', { origin: 'reviewer', relation: 'qualifies' })
    // A link to an unknown source key is refused (no link to nothing).
    expect(setEvidenceLink(db, para.id, 'S99', { origin: 'reviewer' })).toBeNull()

    const exported = recordEvidenceExport(db, {
      reviewId: review.id,
      format: 'html',
      schemaVersion: 1,
      fileName: 'Prüfbericht — Vertrag §5 🧾.html',
      fileSha256: 'ab'.repeat(32),
      options: { includeNotes: true, includePaths: false }
    })
    expect(exported).not.toBeNull()

    const detail = getEvidenceReview(db, review.id)
    expect(detail).not.toBeNull()
    expect(detail?.title).toBe(HOSTILE.title)
    expect(detail?.answerSnapshot).toBe(HOSTILE.answer)
    expect(detail?.questionSnapshot).toBe(HOSTILE.question)
    expect(detail?.reviewerLabel).toBe('Dr. Käthe Müller-Lüdenscheidt')
    expect(detail?.sources).toEqual([
      { ...SOURCES[0], sourceKind: 'document', archiveTitle: null, packId: null, articlePath: null },
      {
        key: 'S2',
        machineLabel: null,
        kind: 'whole_document_provenance',
        identity: 'unresolved',
        documentId: null,
        documentTitle: 'legacy-title-only.txt',
        documentSha256: null,
        mimeType: null,
        pageNumber: null,
        sectionLabel: null,
        snippet: null,
        sourceChunkId: null,
        availabilityAtCreation: null,
        sourceKind: 'document',
        archiveTitle: null,
        packId: null,
        articlePath: null
      }
    ])
    expect(detail?.coverageSnapshot).toMatchObject({ mode: 'relevance', chunksCovered: 3, chunksTotal: 12 }) // parseCoverage is chat.ts's
    expect(detail?.generationSnapshot).toEqual({
      generatedAt: '2026-07-18T09:00:00.000Z',
      modelId: 'qwen3-4b-instruct-q4',
      modelDisplayName: null,
      skillId: null,
      skillDisplayName: null,
      appVersion: '0.1.52',
      answerTruncated: false,
      answerEndedEarly: null,
      answerMode: 'relevance'
    })
    expect(detail?.items).toHaveLength(3)
    expect(detail?.items.map((i) => i.ordinal)).toEqual([0, 1, 2])
    const roundPara = detail?.items.find((i) => i.id === para.id)
    expect(roundPara?.reviewerNote).toBe(HOSTILE.note)
    expect(roundPara?.links).toEqual([
      { evidenceKey: 'S1', origin: 'answer_marker', relation: null },
      { evidenceKey: 'S2', origin: 'reviewer', relation: 'qualifies' }
    ])
    expect(detail?.items.find((i) => i.id === heading.id)?.decision).toBe('not_applicable')
    expect(detail?.exports).toHaveLength(1)
    expect(detail?.exports[0]).toMatchObject({
      reviewId: review.id,
      format: 'html',
      schemaVersion: 1,
      fileName: 'Prüfbericht — Vertrag §5 🧾.html',
      fileSha256: 'ab'.repeat(32),
      options: { includeNotes: true, includePaths: false }
    })

    // Link removal + selection deletion behave; block items are structural (never deletable here).
    expect(removeEvidenceLink(db, para.id, 'S2')).toBe(true)
    expect(removeEvidenceLink(db, para.id, 'S2')).toBe(false)
    expect(deleteEvidenceSelection(db, selection!.id)).toBe(true)
    expect(deleteEvidenceSelection(db, para.id)).toBe(false)
  })

  it('same-millisecond inserts read back in INSERTION order — rowid tie-break, never the random id (PR #70 ubuntu CI)', () => {
    // Deterministic repro of the CI flake: two rows with IDENTICAL created_at and ids
    // chosen ADVERSE to insertion order — an `ORDER BY … id` tie-break would flip them;
    // the rowid tie-break must hold insertion order regardless of timing or uuid luck.
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 'Ordering',
      answerSnapshot: 'A [S1] [S2]',
      questionSnapshot: 'Q',
      sources: SOURCES
    })
    const [item] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0:paragraph:0001', blockKind: 'paragraph', textSnapshot: 'A [S1] [S2]' }
    ])
    const now = '2026-07-18T12:00:00.000Z'
    const insertLink = db.prepare(
      `INSERT INTO evidence_review_links (id, review_item_id, evidence_key, link_origin, reviewer_relation, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`
    )
    // First insert gets the LEXICALLY LATER id: an id tie-break would read [S2, S1].
    insertLink.run('zzzz-first-insert', item.id, 'S1', 'answer_marker', now)
    insertLink.run('aaaa-second-insert', item.id, 'S2', 'reviewer', now)
    const detail = getEvidenceReview(db, review.id)
    expect(detail?.items[0]?.links.map((l) => l.evidenceKey)).toEqual(['S1', 'S2'])
    // The per-item read path (mutation readbacks) orders identically.
    const refreshed = updateEvidenceReviewItem(db, item.id, { reviewerNote: 'note' })
    expect(refreshed?.links.map((l) => l.evidenceKey)).toEqual(['S1', 'S2'])
    // A relation edit UPDATEs in place — the link keeps its ORIGINAL insertion position.
    expect(
      setEvidenceLink(db, item.id, 'S1', { origin: 'reviewer', relation: 'supports' })?.links.map(
        (l) => l.evidenceKey
      )
    ).toEqual(['S1', 'S2'])

    // Exports, newest first: on a created_at tie the LAST insert is the newest — the id
    // alphabet must not decide (adverse the other way: first insert lexically FIRST).
    const insertExport = db.prepare(
      `INSERT INTO evidence_exports (id, review_id, format, schema_version, file_name, file_sha256, options_json, created_at)
       VALUES (?, ?, 'html', 1, ?, ?, NULL, ?)`
    )
    insertExport.run('aaaa-first-insert', review.id, 'first.html', 'aa'.repeat(32), now)
    insertExport.run('zzzz-second-insert', review.id, 'second.html', 'bb'.repeat(32), now)
    expect(listEvidenceExports(db, review.id).map((x) => x.fileName)).toEqual([
      'second.html',
      'first.html'
    ])
  })

  it('head patch: rename (D-6) + reviewer label (D-3) + note; empty title is ignored', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 'Initial',
      answerSnapshot: 'a',
      questionSnapshot: 'q'
    })
    const patched = updateEvidenceReview(db, review.id, {
      title: '  Neuer Titel 🔍  ',
      reviewerLabel: 'QA',
      generalNote: 'General observations'
    })
    expect(patched).toMatchObject({ title: 'Neuer Titel 🔍', reviewerLabel: 'QA', generalNote: 'General observations' })
    expect(updateEvidenceReview(db, review.id, { title: '   ' })?.title).toBe('Neuer Titel 🔍')
    expect(updateEvidenceReview(db, 'missing', {})).toBeNull()
  })

  it('one ACTIVE review per message (service-enforced, not a constraint)', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    createEvidenceReview(db, { messageId, title: 't', answerSnapshot: 'a', questionSnapshot: 'q' })
    expect(() =>
      createEvidenceReview(db, { messageId, title: 't2', answerSnapshot: 'a', questionSnapshot: 'q' })
    ).toThrow(/already exists/)
    // Deleting the review frees the slot again.
    const summary = getEvidenceReviewForMessage(db, messageId)
    expect(summary).not.toBeNull()
    expect(deleteEvidenceReview(db, summary!.id)).toBe(true)
    expect(getEvidenceReviewForMessage(db, messageId)).toBeNull()
    expect(() =>
      createEvidenceReview(db, { messageId, title: 't3', answerSnapshot: 'a', questionSnapshot: 'q' })
    ).not.toThrow()
  })

  it('creating a review for an unknown message throws (ids only in the error)', () => {
    const db = freshWorkspaceDb('epreviews').db
    const SENTINEL = 'SENTINEL-CONTENT-7f3a'
    let err: unknown
    try {
      createEvidenceReview(db, {
        messageId: 'nope',
        title: `${SENTINEL} title`,
        answerSnapshot: `${SENTINEL} answer`,
        questionSnapshot: `${SENTINEL} question`
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/message not found/)
    expect((err as Error).message).toContain('nope')
    expect((err as Error).message).not.toContain(SENTINEL)
  })

  it('the D-6 "never unnamed" invariant holds at birth: an empty/whitespace title is refused, a padded one is trimmed', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    expect(() =>
      createEvidenceReview(db, { messageId, title: '   ', answerSnapshot: 'a', questionSnapshot: 'q' })
    ).toThrow(/title must not be empty/)
    // The refused create left no half-written row — the message slot is still free.
    expect(getEvidenceReviewForMessage(db, messageId)).toBeNull()
    const review = createEvidenceReview(db, {
      messageId,
      title: '  Trimmed at birth  ',
      answerSnapshot: 'a',
      questionSnapshot: 'q'
    })
    expect(review.title).toBe('Trimmed at birth')
    expect(getEvidenceReview(db, review.id)?.title).toBe('Trimmed at birth')
  })

  it('write-side decision hygiene: a garbage PATCHED decision never enters storage', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, { messageId, title: 't', answerSnapshot: 'a', questionSnapshot: 'q' })
    const [item] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: 'a', decision: 'supported' }
    ])
    // The ReviewDecision type only guards compile time — simulate a buggy/hostile caller.
    const patched = updateEvidenceReviewItem(db, item.id, {
      decision: 'definitely_true' as unknown as ReviewDecision
    })
    expect(patched?.decision).toBe('not_reviewed') // normalized ON WRITE, not just on read…
    const raw = db
      .prepare('SELECT decision FROM evidence_review_items WHERE id = ?')
      .get(item.id) as { decision: string }
    expect(raw.decision).toBe('not_reviewed') // …so the stored literal is already honest
  })
})

describe('tolerant parsing of stored rows (malformed → safe defaults, never a throw)', () => {
  it('malformed snapshot JSON columns degrade to []/null and unknown enum values to honest defaults', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'a',
      questionSnapshot: 'q',
      sources: SOURCES,
      coverageSnapshot: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const [item] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: 'x', decision: 'supported' }
    ])
    setEvidenceLink(db, item.id, 'S1', { origin: 'answer_marker' })
    recordEvidenceExport(db, {
      reviewId: review.id,
      format: 'html',
      schemaVersion: 1,
      fileName: 'f.html',
      fileSha256: 'ff'.repeat(32)
    })

    // Corrupt every parsed surface the way a hand-edited/stale row could.
    db.prepare(
      `UPDATE evidence_reviews SET status = 'golden', source_snapshot_json = 'not json {',
        coverage_snapshot_json = '{"mode":42}', generation_snapshot_json = '"a string"' WHERE id = ?`
    ).run(review.id)
    db.prepare(
      `UPDATE evidence_review_items SET kind = 'weird', block_kind = 'chapter', decision = 'banana' WHERE id = ?`
    ).run(item.id)
    db.prepare(
      `UPDATE evidence_review_links SET link_origin = 'oracle', reviewer_relation = 'sometimes'`
    ).run()
    db.prepare(`UPDATE evidence_exports SET format = 'docx', options_json = '[1,2]'`).run()

    const detail = getEvidenceReview(db, review.id)
    expect(detail).not.toBeNull()
    expect(detail?.status).toBe('draft') // never claim ready from garbage
    expect(detail?.sources).toEqual([])
    expect(detail?.coverageSnapshot).toBeNull()
    expect(detail?.generationSnapshot).toBeNull()
    const parsedItem = detail!.items[0]
    expect(parsedItem.kind).toBe('block') // stricter reading — still gates
    expect(parsedItem.blockKind).toBeNull() // unknown class → REQUIRED, not exempt
    expect(parsedItem.decision).toBe('not_reviewed') // never an invented judgment
    expect(parsedItem.links).toEqual([{ evidenceKey: 'S1', origin: 'reviewer', relation: null }]) // claim-nothing origin
    // The stored format is passed through RAW — never repaired to a concrete format the
    // export may not have had (an unknown value would otherwise become a false 'html' claim).
    expect(detail?.exports[0].format).toBe('docx')
    expect(detail?.exports[0].options).toBeNull()
    // The corrupted-but-required block keeps the gate honest: not eligible.
    expect(detail?.gate).toEqual({ eligible: false, requiredTotal: 1, decidedTotal: 0 })
  })

  it('an archive snapshot round-trips its locator through the stored row but never gains a document identity from it (PR #294 review H2/M11)', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'a',
      questionSnapshot: 'q'
    })
    db.prepare('UPDATE evidence_reviews SET source_snapshot_json = ? WHERE id = ?').run(
      JSON.stringify([
        {
          // A stored archive snapshot that ALSO claims a resolved document identity — what a
          // pre-fix build, a hand-edited row or a hostile workspace could hold.
          key: 'S1',
          documentTitle: 'Treibhausgas',
          kind: 'direct_excerpt',
          identity: 'resolved',
          documentId: 'doc-1',
          documentSha256: 'aa'.repeat(32),
          mimeType: 'application/pdf',
          availabilityAtCreation: 'available',
          sourceKind: 'archive',
          archiveTitle: 'Wikipedia (DE)',
          packId: 'pack-climate',
          articlePath: 'A/Treibhausgas'
        },
        {
          // A document snapshot: unchanged behaviour, and the ABSENT sourceKind reads as
          // 'document' (pre-merge reviews are never migrated or re-classified).
          key: 'S2',
          documentTitle: 'Klimabericht.pdf',
          kind: 'direct_excerpt',
          identity: 'resolved',
          documentId: 'doc-2',
          documentSha256: 'bb'.repeat(32),
          mimeType: 'application/pdf',
          availabilityAtCreation: 'available'
        },
        // Mistyped locators drop to null; the marker counts only when it is literally 'archive'.
        { key: 'S3', documentTitle: 'x', sourceKind: 'ARCHIVE', archiveTitle: 7, packId: null }
      ]),
      review.id
    )
    const detail = getEvidenceReview(db, review.id)
    expect(detail?.sources).toHaveLength(3)
    expect(detail?.sources[0]).toMatchObject({
      key: 'S1',
      sourceKind: 'archive',
      // Repaired DOWN, never up: no identity, no id, no hash, no mime, no availability.
      identity: 'unresolved',
      documentId: null,
      documentSha256: null,
      mimeType: null,
      availabilityAtCreation: null,
      // The locator survives intact — display provenance is independent of identity.
      documentTitle: 'Treibhausgas',
      archiveTitle: 'Wikipedia (DE)',
      packId: 'pack-climate',
      articlePath: 'A/Treibhausgas'
    })
    expect(detail?.sources[1]).toMatchObject({
      key: 'S2',
      sourceKind: 'document',
      identity: 'resolved',
      documentId: 'doc-2',
      documentSha256: 'bb'.repeat(32),
      mimeType: 'application/pdf',
      availabilityAtCreation: 'available',
      archiveTitle: null,
      packId: null,
      articlePath: null
    })
    expect(detail?.sources[2]).toMatchObject({
      key: 'S3',
      sourceKind: 'document', // 'ARCHIVE' is not the literal marker
      archiveTitle: null,
      packId: null,
      articlePath: null
    })
  })
})

describe('cascade behavior (plan §5 tests — through the REAL deleteConversation)', () => {
  function tableCount(db: Db, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  /** One review chain with exactly one item, one link and one export (H's `seedReviewChain`). */
  function seedFullReview(db: Db): { conversationId: string; reviewId: string } {
    const { conversationId, messageId } = seedAssistantAnswer(db, { content: 'a [S1]' })
    const { reviewId } = seedReviewChain(db, messageId, { sources: SOURCES })
    return { conversationId, reviewId }
  }

  it('deleteConversation removes messages → reviews → items → links → exports; other conversations untouched', () => {
    const db = freshWorkspaceDb('epreviews').db
    const doomed = seedFullReview(db)
    const survivor = seedFullReview(db)
    expect(tableCount(db, 'evidence_reviews')).toBe(2)
    expect(tableCount(db, 'evidence_review_items')).toBe(2)
    expect(tableCount(db, 'evidence_review_links')).toBe(2)
    expect(tableCount(db, 'evidence_exports')).toBe(2)
    expect(countEvidenceReviewsForConversation(db, doomed.conversationId)).toBe(1)

    expect(deleteConversation(db, doomed.conversationId)).toBe(true)

    // The doomed conversation's whole chain is gone (messages first, then FK cascade)…
    expect(listMessages(db, doomed.conversationId)).toEqual([])
    expect(getEvidenceReview(db, doomed.reviewId)).toBeNull()
    expect(countEvidenceReviewsForConversation(db, doomed.conversationId)).toBe(0)
    // …and EXACTLY the survivor's rows remain in every table.
    expect(tableCount(db, 'evidence_reviews')).toBe(1)
    expect(tableCount(db, 'evidence_review_items')).toBe(1)
    expect(tableCount(db, 'evidence_review_links')).toBe(1)
    expect(tableCount(db, 'evidence_exports')).toBe(1)
    expect(getEvidenceReview(db, survivor.reviewId)).not.toBeNull()
  })

  it('deleteEvidenceReview cascades its own items/links/exports only', () => {
    const db = freshWorkspaceDb('epreviews').db
    const a = seedFullReview(db)
    const b = seedFullReview(db)
    expect(deleteEvidenceReview(db, a.reviewId)).toBe(true)
    expect(tableCount(db, 'evidence_reviews')).toBe(1)
    expect(tableCount(db, 'evidence_review_items')).toBe(1)
    expect(tableCount(db, 'evidence_review_links')).toBe(1)
    expect(tableCount(db, 'evidence_exports')).toBe(1)
    expect(getEvidenceReview(db, b.reviewId)).not.toBeNull()
    expect(deleteEvidenceReview(db, a.reviewId)).toBe(false)
  })
})

describe('status derivation through the service (D-7 + spec §18.4)', () => {
  it('mark-ready is refused while a required block is undecided, flips when decided, reopen clears', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: '# H\n\np1',
      questionSnapshot: 'q'
    })
    const [heading, para] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'heading', textSnapshot: '# H', decision: 'not_applicable' },
      { kind: 'block', blockKey: 'b1', blockKind: 'paragraph', textSnapshot: 'p1' }
    ])
    expect(heading.decision).toBe('not_applicable')

    // Undecided paragraph → the gate refuses; status stays draft, gate says why.
    const refused = markEvidenceReviewReady(db, review.id)
    expect(refused?.review.status).toBe('draft')
    expect(refused?.gate).toEqual({ eligible: false, requiredTotal: 1, decidedTotal: 0 })
    expect(refused?.review.completedAt).toBeNull()

    updateEvidenceReviewItem(db, para.id, { decision: 'supported' })
    const summary = getEvidenceReviewForMessage(db, messageId)
    expect(summary?.gate).toEqual({ eligible: true, requiredTotal: 1, decidedTotal: 1 })

    const marked = markEvidenceReviewReady(db, review.id)
    expect(marked?.review.status).toBe('ready')
    expect(marked?.review.completedAt).not.toBeNull()
    expect(getEvidenceReview(db, review.id)?.status).toBe('ready')

    // Manual reopen (spec §18.4): back to draft, completion stamp cleared.
    const reopened = reopenEvidenceReview(db, review.id)
    expect(reopened?.status).toBe('draft')
    expect(reopened?.completedAt).toBeNull()
    expect(getEvidenceReview(db, review.id)?.completedAt).toBeNull()
  })

  it('a READY review refuses every ITEM-LEVEL mutation until reopened; head edits stay allowed (FIX-1)', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'p1',
      questionSnapshot: 'q',
      sources: SOURCES
    })
    const [para] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b1', blockKind: 'paragraph', textSnapshot: 'p1', decision: 'supported' }
    ])
    setEvidenceLink(db, para.id, 'S1', { origin: 'reviewer', relation: null })
    const sel = createEvidenceSelection(db, review.id, { blockKey: 'b1', startOffset: 0, endOffset: 2 })
    expect(sel).not.toBeNull()
    expect(markEvidenceReviewReady(db, review.id)?.review.status).toBe('ready')

    // Item-level writes refuse through the established null/false channel — ready +
    // undecided (a state the D-7 gate can never produce) must stay unreachable.
    expect(updateEvidenceReviewItem(db, para.id, { decision: 'not_reviewed' })).toBeNull()
    expect(updateEvidenceReviewItem(db, para.id, { reviewerNote: 'late note' })).toBeNull()
    expect(setEvidenceLink(db, para.id, 'S2', { origin: 'reviewer', relation: null })).toBeNull()
    expect(removeEvidenceLink(db, para.id, 'S1')).toBe(false)
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b1', startOffset: 0, endOffset: 1 })).toBeNull()
    expect(deleteEvidenceSelection(db, sel!.id)).toBe(false)
    // Nothing moved: decision, note, links, and both items are byte-intact.
    const frozen = getEvidenceReview(db, review.id)!
    expect(frozen.status).toBe('ready')
    const frozenPara = frozen.items.find((i) => i.id === para.id)!
    expect(frozenPara.decision).toBe('supported')
    expect(frozenPara.reviewerNote).toBeNull()
    expect(frozenPara.links.map((l) => l.evidenceKey)).toEqual(['S1'])
    expect(frozen.items).toHaveLength(2)

    // HEAD edits stay allowed (D-6 renameable; reviewer label + general note are not decisions).
    const renamed = updateEvidenceReview(db, review.id, {
      title: 'Renamed while ready',
      reviewerLabel: 'QA',
      generalNote: 'overall fine'
    })
    expect(renamed?.title).toBe('Renamed while ready')
    expect(renamed?.status).toBe('ready')

    // Reopen restores item-level editability.
    expect(reopenEvidenceReview(db, review.id)?.status).toBe('draft')
    expect(updateEvidenceReviewItem(db, para.id, { decision: 'follow_up' })?.decision).toBe('follow_up')
    expect(removeEvidenceLink(db, para.id, 'S1')).toBe(true)
    expect(deleteEvidenceSelection(db, sel!.id)).toBe(true)
  })

  it('a heading left not_reviewed never blocks readiness; a selection never blocks either', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: '# H\n\np1',
      questionSnapshot: 'q'
    })
    const [, para] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'heading', textSnapshot: '# H' }, // not_reviewed
      { kind: 'block', blockKey: 'b1', blockKind: 'paragraph', textSnapshot: 'p1', decision: 'follow_up' }
    ])
    createEvidenceSelection(db, review.id, { blockKey: para.blockKey, startOffset: 0, endOffset: 2 })
    const marked = markEvidenceReviewReady(db, review.id)
    expect(marked?.gate).toEqual({ eligible: true, requiredTotal: 1, decidedTotal: 1 })
    expect(marked?.review.status).toBe('ready')
  })

  it('selection guards: unknown block key and out-of-range offsets are refused, never clamped', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'p1',
      questionSnapshot: 'q'
    })
    createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: 'p1' }
    ])
    expect(createEvidenceSelection(db, review.id, { blockKey: 'nope', startOffset: 0, endOffset: 1 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 3 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 1, endOffset: 1 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: -1, endOffset: 1 })).toBeNull()
    // Offsets are UTF-16 indexes: a fraction is refused, never rounded (#839 S2; IPC passes any number).
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0.5, endOffset: 2 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 1.5 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 2 })).not.toBeNull()
  })

  it('selection offsets inside a surrogate pair are refused — a lone surrogate never persists (F-15)', () => {
    const db = freshWorkspaceDb('epreviews').db
    const { messageId } = seedAssistantAnswer(db, { content: ANSWER })
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'ok 😀 done',
      questionSnapshot: 'q'
    })
    // '😀' (U+1F600) is astral: UTF-16 units [3]=high surrogate, [4]=low surrogate.
    const text = 'ok 😀 done'
    createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: text }
    ])
    // A boundary INSIDE the pair (unit 4) is refused on either side — refuse, never clamp.
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 4 })).toBeNull()
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 4, endOffset: 8 })).toBeNull()
    // Aligned boundaries around/after the pair work, and the snapshot keeps the char whole.
    const whole = createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 5 })
    expect(whole?.textSnapshot).toBe('ok 😀')
    const after = createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 5, endOffset: 10 })
    expect(after?.textSnapshot).toBe(' done')
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const item of getEvidenceReview(db, review.id)!.items) {
      expect(loneSurrogate.test(item.textSnapshot)).toBe(false)
    }
  })
})

describe('citation enrichment (plan §5 item 2 — additive documentId/chunkId)', () => {
  /** One page per chunk, as a PDF has: the citation dedup and the whole read's segment check both read the page. */
  const paged = (texts: string[]): Array<{ text: string; page: number }> => texts.map((text, i) => ({ text, page: i + 1 }))

  it('relevance retrieval citations now carry documentId + chunkId', async () => {
    const db = freshWorkspaceDb('epreviews').db
    const embedder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, embedder, 'science.pdf', paged([
      'photosynthesis converts sunlight into chemical energy in plants',
      'the stock market rallied on strong earnings reports today'
    ]))
    const { citations } = await retrieve(
      db,
      embedder,
      'photosynthesis converts sunlight into chemical energy in plants',
      ragSettingsFrom(DEFAULT_SETTINGS)
    )
    expect(citations[0]).toMatchObject({
      label: 'S1',
      sourceTitle: 'science.pdf',
      documentId: docId,
      chunkId: chunkIdsOf(db, docId)[0]
    })
  })

  it('whole-document read citations carry them too', async () => {
    const db = freshWorkspaceDb('epreviews').db
    const embedder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, embedder, 'doc.txt', paged([
      'first section text here',
      'second section text here'
    ]))
    const result = retrieveWholeDocument(db, docId, 100000)
    expect(result.citations).toHaveLength(2)
    expect(result.citations.map((c) => c.chunkId)).toEqual(chunkIdsOf(db, docId))
    expect(result.citations.every((c) => c.documentId === docId)).toBe(true)
  })

  it('deep-index leaf provenance citations carry them too', async () => {
    const db = freshWorkspaceDb('epreviews').db
    const embedder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, embedder, 'tree.txt', paged([
      'leaf one text',
      'leaf two text'
    ]))
    const chunkIds = chunkIdsOf(db, docId)
    seedReadyTree(db, docId, chunkIds)
    const provenance = documentLeafProvenance(db, docId, 'tree.txt')
    expect(provenance).toHaveLength(2)
    expect(provenance.map((c) => c.chunkId)).toEqual(chunkIds)
    expect(provenance.every((c) => c.documentId === docId)).toBe(true)
  })

  it('chunk map-reduce rep citations (answerWholeDocFromChunks) carry them too', async () => {
    const db = freshWorkspaceDb('epreviews').db
    const embedder = new MockEmbedder()
    const docId = await seedEmbeddedDoc(db, embedder, 'big.txt', paged([
      'alpha section body text here',
      'beta section body text here'
    ]))
    const chunkIds = chunkIdsOf(db, docId)
    const conv = createConversation(db, { mode: 'documents' })
    // Minimal mock runtime (the recordingRuntime idiom): one reduce reply, no model process.
    const runtime = {
      modelId: 'mock',
      contextWindow: () => 4096,
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: null }),
      async *chatStream() {
        yield 'Zusammenfassung.'
      }
    } as unknown as ModelRuntime
    const msg = await answerWholeDocFromChunks({
      db,
      runtime,
      conversationId: conv.id,
      documentId: docId,
      question: 'summarize the document',
      contextTokens: 4096
    })
    expect(msg).not.toBeNull()
    expect(msg!.citations!.length).toBeGreaterThan(0)
    for (const c of msg!.citations!) {
      expect(c.documentId).toBe(docId)
      expect(chunkIds).toContain(c.chunkId)
    }
  })

  it('compare-diff citations (retrieveCompareDiff) carry them too', () => {
    const db = freshWorkspaceDb('epreviews').db
    // The rag-compare-diff-truncation seeding idiom: one chunk per doc; three shared 'keep'
    // words per changed token keep the changed fraction under the precise-diff usefulness bar.
    const now = new Date().toISOString()
    const seedDoc = (id: string, prefix: string): void => {
      const text = [0, 1, 2].map((i) => `${prefix}${i}`).join(' keep keep keep ')
      db.prepare(
        `INSERT INTO documents (id, title, status, origin_json, created_at, updated_at)
         VALUES (?, ?, 'indexed', NULL, ?, ?)`
      ).run(id, `${id}.txt`, now, now)
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
         VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, ?)`
      ).run(`${id}-c0`, id, text, `${id}.txt`, now)
    }
    seedDoc('docA', 'A')
    seedDoc('docB', 'B')
    const result = retrieveCompareDiff(db, ['docA', 'docB'], 1_000_000)
    expect(result).not.toBeNull()
    expect(result!.citations.length).toBeGreaterThan(0)
    for (const c of result!.citations) {
      expect(['docA', 'docB']).toContain(c.documentId)
      expect(c.chunkId).toBe(`${c.documentId}-c0`)
    }
  })

  it('enriched citations round-trip through messages.citations_json', () => {
    const db = freshWorkspaceDb('epreviews').db
    const conv = createConversation(db, { title: 'c' })
    appendMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: 'answer [S1]',
      citations: [
        {
          label: 'S1',
          sourceTitle: 'a.pdf',
          pageNumber: 2,
          section: null,
          snippet: 'text',
          documentId: 'doc-1',
          chunkId: 'chunk-1'
        }
      ]
    })
    const msg = listMessages(db, conv.id).at(-1)!
    expect(msg.citations?.[0]).toMatchObject({ documentId: 'doc-1', chunkId: 'chunk-1' })
  })

  it('LEGACY rows (no documentId) still parse byte-identically — and malformed identity fields drop the element, not the message', () => {
    const db = freshWorkspaceDb('epreviews').db
    const conv = createConversation(db, { title: 'c' })
    const now = new Date().toISOString()
    const legacyJson = JSON.stringify([
      { label: 'S1', sourceTitle: 'old.pdf', pageNumber: 2, section: null, snippet: 'legacy text' }
    ])
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, citations_json)
       VALUES ('m-legacy', ?, 'assistant', 'old answer [S1]', ?, ?)`
    ).run(conv.id, now, legacyJson)
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, citations_json)
       VALUES ('m-bad', ?, 'assistant', 'tampered', ?, ?)`
    ).run(
      conv.id,
      now,
      JSON.stringify([
        { label: 'S1', sourceTitle: 'ok.pdf' },
        { label: 'S2', sourceTitle: 'bad.pdf', documentId: 42 },
        { label: 'S3', sourceTitle: 'bad2.pdf', chunkId: { nested: true } }
      ])
    )

    const messages = listMessages(db, conv.id)
    const legacy = messages.find((m) => m.id === 'm-legacy')
    // Byte-identical legacy view: same fields, and the new optional fields are ABSENT, not null.
    expect(legacy?.citations).toEqual([
      { label: 'S1', sourceTitle: 'old.pdf', pageNumber: 2, section: null, snippet: 'legacy text' }
    ])
    expect(Object.keys(legacy!.citations![0])).not.toContain('documentId')
    // Element-level tolerance: mistyped identity fields reject THAT element only.
    const tampered = messages.find((m) => m.id === 'm-bad')
    expect(tampered?.citations).toEqual([{ label: 'S1', sourceTitle: 'ok.pdf' }])
    expect(tampered?.content).toBe('tampered')
  })
})
