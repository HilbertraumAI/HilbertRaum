import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, listTables, type Db } from '../../src/main/services/db'
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
import { MockEmbedder, encodeVector } from '../../src/main/services/embeddings'
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

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'hilbertraum-epreviews-')), 'test.sqlite')
}

function freshDb(): Db {
  return openDatabase(freshDbPath())
}

/** One conversation + one assistant answer, via the REAL chat service. */
function seedAnswer(db: Db, content = 'The contract allows termination. [S1]'): { conversationId: string; messageId: string } {
  const conv = createConversation(db, { title: 'Contract questions' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'What about termination?' })
  const msg = appendMessage(db, { conversationId: conv.id, role: 'assistant', content })
  return { conversationId: conv.id, messageId: msg.id }
}

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

describe('schema (plan §5 item 3)', () => {
  it('a fresh DB creates all four evidence tables', () => {
    const tables = listTables(freshDb())
    for (const t of EVIDENCE_TABLES) expect(tables).toContain(t)
  })

  it('re-opening an existing DB is idempotent and preserves review data across restarts', () => {
    const path = freshDbPath()
    let db = openDatabase(path)
    const { messageId } = seedAnswer(db)
    const review = createEvidenceReview(db, {
      messageId,
      title: HOSTILE.title,
      answerSnapshot: HOSTILE.answer,
      questionSnapshot: HOSTILE.question,
      sources: SOURCES
    })
    db.close()

    db = openDatabase(path) // the restart: migrations re-run, IF NOT EXISTS must not clobber
    const tables = listTables(db)
    for (const t of EVIDENCE_TABLES) expect(tables).toContain(t)
    const detail = getEvidenceReview(db, review.id)
    expect(detail?.title).toBe(HOSTILE.title)
    expect(detail?.answerSnapshot).toBe(HOSTILE.answer)
  })
})

describe('round-trip through SQLite (plan §5 tests — Unicode/markdown/hostile strings)', () => {
  it('review + items + links + exports round-trip byte-identically', () => {
    const db = freshDb()
    const { conversationId, messageId } = seedAnswer(db)

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
    expect(detail?.sources).toEqual(SOURCES.map((s) => expect.objectContaining({ key: s.key, documentTitle: s.documentTitle })))
    expect(detail?.sources[0]).toMatchObject({
      kind: 'direct_excerpt',
      identity: 'resolved',
      documentId: 'doc-abc',
      snippet: SOURCES[0].snippet
    })
    expect(detail?.coverageSnapshot).toMatchObject({ mode: 'relevance', chunksCovered: 3, chunksTotal: 12 })
    expect(detail?.generationSnapshot).toMatchObject({ modelId: 'qwen3-4b-instruct-q4', appVersion: '0.1.52' })
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
      format: 'html',
      schemaVersion: 1,
      fileName: 'Prüfbericht — Vertrag §5 🧾.html',
      options: { includeNotes: true, includePaths: false }
    })

    // Link removal + selection deletion behave; block items are structural (never deletable here).
    expect(removeEvidenceLink(db, para.id, 'S2')).toBe(true)
    expect(removeEvidenceLink(db, para.id, 'S2')).toBe(false)
    expect(deleteEvidenceSelection(db, selection!.id)).toBe(true)
    expect(deleteEvidenceSelection(db, para.id)).toBe(false)
  })

  it('head patch: rename (D-6) + reviewer label (D-3) + note; empty title is ignored', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    const db = freshDb()
    expect(() =>
      createEvidenceReview(db, { messageId: 'nope', title: 't', answerSnapshot: 'a', questionSnapshot: 'q' })
    ).toThrow(/message not found/)
  })

  it('the D-6 "never unnamed" invariant holds at birth: an empty/whitespace title is refused, a padded one is trimmed', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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

  it('a partially valid source array keeps the valid elements only', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db)
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'a',
      questionSnapshot: 'q'
    })
    db.prepare('UPDATE evidence_reviews SET source_snapshot_json = ? WHERE id = ?').run(
      JSON.stringify([{ key: 'S1', documentTitle: 'ok.pdf' }, 42, { documentTitle: 'no key' }]),
      review.id
    )
    const detail = getEvidenceReview(db, review.id)
    expect(detail?.sources).toHaveLength(1)
    expect(detail?.sources[0]).toMatchObject({ key: 'S1', identity: 'unresolved', kind: 'whole_document_provenance' })
  })
})

describe('cascade behavior (plan §5 tests — through the REAL deleteConversation)', () => {
  function tableCount(db: Db, table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  function seedFullReview(db: Db): { conversationId: string; reviewId: string } {
    const { conversationId, messageId } = seedAnswer(db)
    const review = createEvidenceReview(db, {
      messageId,
      title: 't',
      answerSnapshot: 'a [S1]',
      questionSnapshot: 'q',
      sources: SOURCES
    })
    const [item] = createEvidenceReviewItems(db, review.id, [
      { kind: 'block', blockKey: 'b0', blockKind: 'paragraph', textSnapshot: 'a [S1]' }
    ])
    setEvidenceLink(db, item.id, 'S1', { origin: 'answer_marker' })
    recordEvidenceExport(db, {
      reviewId: review.id,
      format: 'html',
      schemaVersion: 1,
      fileName: 'f.html',
      fileSha256: '00'.repeat(32)
    })
    return { conversationId, reviewId: review.id }
  }

  it('deleteConversation removes messages → reviews → items → links → exports; other conversations untouched', () => {
    const db = freshDb()
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
    const db = freshDb()
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
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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

  it('a heading left not_reviewed never blocks readiness; a selection never blocks either', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
    expect(createEvidenceSelection(db, review.id, { blockKey: 'b0', startOffset: 0, endOffset: 2 })).not.toBeNull()
  })

  it('selection offsets inside a surrogate pair are refused — a lone surrogate never persists (F-15)', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db)
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
  interface SeededChunk {
    id: string
    text: string
  }

  /** The rag.test.ts seeding idiom: one document + chunks + mock embeddings; returns ids. */
  async function seedDocument(
    db: Db,
    embedder: MockEmbedder,
    title: string,
    texts: string[]
  ): Promise<{ docId: string; chunks: SeededChunk[] }> {
    const now = new Date().toISOString()
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run(docId, title, now, now)
    const vectors = await embedder.embed(texts)
    const chunks: SeededChunk[] = []
    for (let i = 0; i < texts.length; i++) {
      const chunkId = randomUUID()
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(chunkId, docId, i, texts[i], title, i + 1, texts[i].split(/\s+/).length, now)
      db.prepare(
        `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
      chunks.push({ id: chunkId, text: texts[i] })
    }
    return { docId, chunks }
  }

  it('relevance retrieval citations now carry documentId + chunkId', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId, chunks } = await seedDocument(db, embedder, 'science.pdf', [
      'photosynthesis converts sunlight into chemical energy in plants',
      'the stock market rallied on strong earnings reports today'
    ])
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
      chunkId: chunks[0].id
    })
  })

  it('whole-document read citations carry them too', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId, chunks } = await seedDocument(db, embedder, 'doc.txt', [
      'first section text here',
      'second section text here'
    ])
    const result = retrieveWholeDocument(db, docId, 100000)
    expect(result.citations).toHaveLength(2)
    expect(result.citations.map((c) => c.chunkId)).toEqual(chunks.map((c) => c.id))
    expect(result.citations.every((c) => c.documentId === docId)).toBe(true)
  })

  it('deep-index leaf provenance citations carry them too', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId, chunks } = await seedDocument(db, embedder, 'tree.txt', [
      'leaf one text',
      'leaf two text'
    ])
    // Minimal ready tree: one root node whose edges point at the two leaf chunks.
    const now = new Date().toISOString()
    const rootId = randomUUID()
    db.prepare(
      `INSERT INTO tree_nodes (id, document_id, level, ordinal, is_root, summary_text, content_hash, created_at)
       VALUES (?, ?, 1, 0, 1, 'summary', 'hash', ?)`
    ).run(rootId, docId, now)
    for (let i = 0; i < chunks.length; i++) {
      db.prepare(
        `INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, 1, ?)`
      ).run(rootId, chunks[i].id, i)
    }
    const provenance = documentLeafProvenance(db, docId, 'tree.txt')
    expect(provenance).toHaveLength(2)
    expect(provenance.map((c) => c.chunkId)).toEqual(chunks.map((c) => c.id))
    expect(provenance.every((c) => c.documentId === docId)).toBe(true)
  })

  it('chunk map-reduce rep citations (answerWholeDocFromChunks) carry them too', async () => {
    const db = freshDb()
    const embedder = new MockEmbedder()
    const { docId, chunks } = await seedDocument(db, embedder, 'big.txt', [
      'alpha section body text here',
      'beta section body text here'
    ])
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
      expect(chunks.map((x) => x.id)).toContain(c.chunkId)
    }
  })

  it('compare-diff citations (retrieveCompareDiff) carry them too', () => {
    const db = freshDb()
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
    const db = freshDb()
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
    const db = freshDb()
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
