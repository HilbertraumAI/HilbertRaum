import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import {
  buildEvidenceSourceSnapshots,
  createEvidenceReviewFromMessage,
  sourceKindForMode
} from '../../src/main/services/evidence-pack/snapshot'
import { deleteEvidenceReview } from '../../src/main/services/evidence-reviews'
import type { Citation, CoverageInfo } from '../../src/shared/types'

// EP-1 Phase 1 (plan §6.3) — the snapshot builder: a complete, honest, deterministic draft
// review per answer class, from PERSISTED data only. Classes: relevance (auto-links land),
// whole-doc tree (ZERO auto-links — spec §13.3 hard rule), extract, legacy no-citation,
// unresolved-title legacy, deleted-source. Everything runs against a real SQLite workspace;
// documents are seeded as rows (ingestion is out of scope here).

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-epsnap-')), 'test.sqlite'))
}

function seedDocument(
  db: Db,
  opts: { title: string; sha256?: string; mime?: string }
): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'indexed', ?, ?)`
  ).run(id, opts.title, opts.mime ?? 'application/pdf', opts.sha256 ?? 'ab'.repeat(32), now, now)
  return id
}

interface SeededAnswer {
  conversationId: string
  messageId: string
}

function seedAnswer(
  db: Db,
  opts: {
    content: string
    citations?: Citation[] | null
    coverage?: CoverageInfo | null
    question?: string | null
    title?: string
    modelId?: string | null
    truncated?: boolean
  }
): SeededAnswer {
  const conv = createConversation(db, {
    title: opts.title ?? 'Contract questions',
    // `null` must pass through as an explicit "no model recorded" (?? would swallow it).
    modelId: opts.modelId !== undefined ? opts.modelId : 'test-model-q4'
  })
  if (opts.question !== null) {
    appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      content: opts.question ?? 'What about termination?'
    })
  }
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: opts.content,
    citations: opts.citations ?? null,
    coverage: opts.coverage ?? null,
    truncated: opts.truncated
  })
  return { conversationId: conv.id, messageId: msg.id }
}

const RELEVANCE_ANSWER = [
  '# Findings',
  '',
  'Termination requires 30 days notice. [S1]',
  '',
  'The fee is fixed. [S2] It is confirmed twice. [S2]',
  '',
  'No marker in this closing paragraph.'
].join('\n')

describe('createEvidenceReviewFromMessage — relevance answers (auto-links land)', () => {
  it('builds resolved sources, block items with kinds, heading N/A default, and answer_marker links', () => {
    const db = freshDb()
    const docA = seedDocument(db, { title: 'Vertrag.pdf', sha256: 'aa'.repeat(32), mime: 'application/pdf' })
    const docB = seedDocument(db, { title: 'Anhang.pdf', sha256: 'bb'.repeat(32), mime: 'application/pdf' })
    const { conversationId, messageId } = seedAnswer(db, {
      content: RELEVANCE_ANSWER,
      citations: [
        { label: 'S1', sourceTitle: 'Vertrag.pdf', documentId: docA, chunkId: 'chunk-1', pageNumber: 5, section: '§5', snippet: '30 Tage' },
        { label: 'S2', sourceTitle: 'Anhang.pdf', documentId: docB, chunkId: 'chunk-2', snippet: 'fixed fee' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 2, chunksTotal: 10 },
      truncated: true
    })

    const detail = createEvidenceReviewFromMessage(db, messageId, {
      appVersion: '9.9.9-test',
      modelDisplayName: (id) => (id === 'test-model-q4' ? 'Test Model Q4' : null)
    })

    // Head + frozen snapshots.
    expect(detail.conversationId).toBe(conversationId)
    expect(detail.messageId).toBe(messageId)
    expect(detail.status).toBe('draft')
    expect(detail.title).toBe('Contract questions')
    expect(detail.answerSnapshot).toBe(RELEVANCE_ANSWER)
    expect(detail.questionSnapshot).toBe('What about termination?')
    expect(detail.questionMessageId).toBeTruthy()
    expect(detail.coverageSnapshot).toMatchObject({ mode: 'relevance', chunksCovered: 2, chunksTotal: 10 })

    // Generation snapshot (plan §1.3): synthesized, never invented.
    expect(detail.generationSnapshot).toMatchObject({
      modelId: 'test-model-q4',
      modelDisplayName: 'Test Model Q4',
      appVersion: '9.9.9-test',
      answerTruncated: true,
      answerMode: 'relevance'
    })
    expect(detail.generationSnapshot?.generatedAt).toBeTruthy()

    // Sources: resolved by documentId, direct excerpts with machine labels + doc hashes.
    expect(detail.sources.map((s) => s.key)).toEqual(['S1', 'S2'])
    for (const s of detail.sources) {
      expect(s.kind).toBe('direct_excerpt')
      expect(s.identity).toBe('resolved')
      expect(s.availabilityAtCreation).toBe('available')
    }
    expect(detail.sources[0]).toMatchObject({
      machineLabel: 'S1',
      documentId: docA,
      documentTitle: 'Vertrag.pdf',
      documentSha256: 'aa'.repeat(32),
      mimeType: 'application/pdf',
      pageNumber: 5,
      sectionLabel: '§5',
      snippet: '30 Tage',
      sourceChunkId: 'chunk-1'
    })

    // Items: one per deterministic block, block_kind persisted on EVERY item, headings N/A.
    expect(detail.items.map((i) => i.blockKind)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph'])
    expect(detail.items.every((i) => i.kind === 'block' && i.blockKind != null)).toBe(true)
    expect(detail.items[0]!.decision).toBe('not_applicable') // heading default (spec §12.2)
    expect(detail.items.slice(1).every((i) => i.decision === 'not_reviewed')).toBe(true)

    // Auto-links: marker → citation by machine label, origin answer_marker; the repeated
    // [S2] links ONCE (upsert per item+key); the unmarked paragraph gets none.
    expect(detail.items[1]!.links).toEqual([{ evidenceKey: 'S1', origin: 'answer_marker', relation: null }])
    expect(detail.items[2]!.links).toEqual([{ evidenceKey: 'S2', origin: 'answer_marker', relation: null }])
    expect(detail.items[3]!.links).toEqual([])
    expect(detail.items[0]!.links).toEqual([])

    // D-7 gate: the heading is exempt; three prose blocks required, none decided yet.
    expect(detail.gate).toEqual({ eligible: false, requiredTotal: 3, decidedTotal: 0 })
  })

  it('is deterministic: recreating the review yields identical block keys and links', () => {
    const db = freshDb()
    const doc = seedDocument(db, { title: 'Doc.pdf' })
    const { messageId } = seedAnswer(db, {
      content: RELEVANCE_ANSWER,
      citations: [{ label: 'S1', sourceTitle: 'Doc.pdf', documentId: doc }],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 4 }
    })
    const first = createEvidenceReviewFromMessage(db, messageId)
    const firstKeys = first.items.map((i) => i.blockKey)
    const firstLinks = first.items.map((i) => i.links)
    deleteEvidenceReview(db, first.id)
    const second = createEvidenceReviewFromMessage(db, messageId)
    expect(second.items.map((i) => i.blockKey)).toEqual(firstKeys)
    expect(second.items.map((i) => i.links)).toEqual(firstLinks)
  })

  it('a second create for the same message throws (one active review per message, ids-only error)', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, { content: 'Answer. [S1]' })
    createEvidenceReviewFromMessage(db, messageId)
    expect(() => createEvidenceReviewFromMessage(db, messageId)).toThrow(messageId)
  })
})

describe('whole-document and extract answers (spec §13.3 hard rule)', () => {
  it("mode:'tree' → whole_document_provenance sources, NULL machine labels, ZERO auto-links", () => {
    const db = freshDb()
    const doc = seedDocument(db, { title: 'Report.pdf', sha256: 'cc'.repeat(32) })
    // The answer TEXT deliberately contains a literal [S1]: even then, a whole-doc answer
    // must get zero auto-links — provenance is never a citation (rag-design §14.4 M2).
    const { messageId } = seedAnswer(db, {
      content: '# Summary\n\nThe report concludes X. [S1]\n\n- point one\n- point two',
      citations: [
        { label: 'S1', sourceTitle: 'Report.pdf', documentId: doc, chunkId: 'leaf-1', snippet: 'leaf a' },
        { label: 'S2', sourceTitle: 'Report.pdf', documentId: doc, chunkId: 'leaf-2', snippet: 'leaf b' }
      ],
      coverage: { mode: 'tree', chunksCovered: 40, chunksTotal: 40 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId)

    expect(detail.sources).toHaveLength(2)
    for (const s of detail.sources) {
      expect(s.kind).toBe('whole_document_provenance')
      expect(s.machineLabel).toBeNull() // provenance-only sources carry no citation label
      expect(s.identity).toBe('resolved')
    }
    // The HARD RULE: zero auto-links across every item.
    expect(detail.items.length).toBeGreaterThan(0)
    expect(detail.items.every((i) => i.links.length === 0)).toBe(true)
    expect(detail.generationSnapshot?.answerMode).toBe('tree')
  })

  it("mode:'capped' also maps to whole_document_provenance with zero links", () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, {
      content: 'Partial summary. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'Nowhere.pdf' }],
      coverage: { mode: 'capped', chunksCovered: 10, chunksTotal: 80, truncated: true }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.sources[0]!.kind).toBe('whole_document_provenance')
    expect(detail.items.every((i) => i.links.length === 0)).toBe(true)
  })

  it("mode:'extract' → structured_record sources, zero auto-links", () => {
    const db = freshDb()
    const doc = seedDocument(db, { title: 'Invoices.pdf' })
    const { messageId } = seedAnswer(db, {
      content: 'Found 3 amounts. [S1]',
      citations: [{ label: 'S1', sourceTitle: 'Invoices.pdf', documentId: doc, chunkId: 'c1' }],
      coverage: { mode: 'extract', chunksCovered: 12, chunksTotal: 12 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.sources[0]!.kind).toBe('structured_record')
    expect(detail.items.every((i) => i.links.length === 0)).toBe(true)
    expect(detail.generationSnapshot?.answerMode).toBe('extract')
  })

  it('sourceKindForMode maps every mode (and its absence) honestly', () => {
    expect(sourceKindForMode('relevance')).toBe('direct_excerpt')
    expect(sourceKindForMode('tree')).toBe('whole_document_provenance')
    expect(sourceKindForMode('capped')).toBe('whole_document_provenance')
    expect(sourceKindForMode('extract')).toBe('structured_record')
    // No stamp = the pre-D72 relevance path (the renderer's own fallback) — its persisted
    // citations ARE labeled excerpts; calling them whole-doc analysis would be invented.
    expect(sourceKindForMode(undefined)).toBe('direct_excerpt')
  })
})

describe('legacy and degraded answers (spec §25.5 — never invent)', () => {
  it('a no-citation legacy answer reviews with zero sources, zero links, honest generation gaps', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, {
      content: 'A plain grounded-sounding answer with no persisted sources.',
      citations: null,
      coverage: null,
      modelId: null
    })
    const detail = createEvidenceReviewFromMessage(db, messageId) // no deps: appVersion unknown
    expect(detail.sources).toEqual([])
    expect(detail.items).toHaveLength(1)
    expect(detail.items[0]!.links).toEqual([])
    expect(detail.generationSnapshot).toMatchObject({
      modelId: null,
      modelDisplayName: null,
      appVersion: null,
      answerTruncated: null,
      answerMode: 'unknown'
    })
    expect(detail.coverageSnapshot).toBeNull()
  })

  it('legacy title-resolution: a unique title match resolves; zero or multiple matches stay unresolved', () => {
    const db = freshDb()
    seedDocument(db, { title: 'Unique.pdf', sha256: 'dd'.repeat(32), mime: 'text/plain' })
    seedDocument(db, { title: 'Twin.pdf' })
    seedDocument(db, { title: 'Twin.pdf' })
    const { messageId } = seedAnswer(db, {
      content: 'Cites three ways. [S1] [S2] [S3]',
      citations: [
        { label: 'S1', sourceTitle: 'Unique.pdf', snippet: 'unique snippet' },
        { label: 'S2', sourceTitle: 'Twin.pdf' },
        { label: 'S3', sourceTitle: 'Vanished.pdf' }
      ]
      // No coverage stamp: an answer persisted before D72 — the title-resolution path.
    })
    const detail = createEvidenceReviewFromMessage(db, messageId)

    const [unique, twin, vanished] = detail.sources
    expect(unique).toMatchObject({
      identity: 'resolved',
      availabilityAtCreation: 'available',
      documentSha256: 'dd'.repeat(32),
      mimeType: 'text/plain'
    })
    expect(unique!.documentId).toBeTruthy()
    // >1 exact title match: NEVER guess which one was meant.
    expect(twin).toMatchObject({ identity: 'unresolved', documentId: null, documentSha256: null })
    expect(twin!.availabilityAtCreation).toBeNull() // unresolved ≠ missing
    // 0 matches: unresolved too — NOT 'missing' (identity was never established).
    expect(vanished).toMatchObject({ identity: 'unresolved', documentId: null })
    expect(vanished!.availabilityAtCreation).toBeNull()

    // Legacy relevance answers keep the marker→citation truth: the answer really cited
    // [S1]/[S2]/[S3], so answer_marker links land even while identity is unresolved.
    expect(detail.items[0]!.links.map((l) => l.evidenceKey).sort()).toEqual(['S1', 'S2', 'S3'])
    expect(detail.items[0]!.links.every((l) => l.origin === 'answer_marker')).toBe(true)
  })

  it('a deleted source (documentId no longer present) is RESOLVED identity + missing availability', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, {
      content: 'Cites a shredded doc. [S1]',
      citations: [
        { label: 'S1', sourceTitle: 'Shredded.pdf', documentId: 'doc-gone', chunkId: 'c9', snippet: 'kept snippet' }
      ],
      coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 1 }
    })
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.sources[0]).toMatchObject({
      identity: 'resolved',
      documentId: 'doc-gone',
      availabilityAtCreation: 'missing',
      documentSha256: null,
      mimeType: null,
      documentTitle: 'Shredded.pdf', // the citation's title survives — spec §25.2
      snippet: 'kept snippet'
    })
  })

  it('an empty answer yields an item-less review (nothing to decide; gate vacuously eligible)', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, { content: '' })
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.items).toEqual([])
    expect(detail.gate).toEqual({ eligible: true, requiredTotal: 0, decidedTotal: 0 })
  })

  it('falls back to the persist-canonical default title when the conversation title trims empty', () => {
    const db = freshDb()
    const { conversationId, messageId } = seedAnswer(db, { content: 'Answer.' })
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run('   ', conversationId)
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.title).toBe('Evidence review')
  })

  it('a first-turn answer with no preceding user message snapshots an empty question, honestly', () => {
    const db = freshDb()
    const { messageId } = seedAnswer(db, { content: 'Orphan answer.', question: null })
    const detail = createEvidenceReviewFromMessage(db, messageId)
    expect(detail.questionMessageId).toBeNull()
    expect(detail.questionSnapshot).toBe('')
  })

  it('refuses a non-assistant message and an unknown message with ids-only errors', () => {
    const db = freshDb()
    const conv = createConversation(db, { title: 'T' })
    const user = appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Question?' })
    expect(() => createEvidenceReviewFromMessage(db, user.id)).toThrow(user.id)
    expect(() => createEvidenceReviewFromMessage(db, 'missing-id')).toThrow('missing-id')
  })
})

describe('buildEvidenceSourceSnapshots — key uniqueness (defensive)', () => {
  it('uniquifies duplicate citation labels so links can never merge two sources', () => {
    const db = freshDb()
    const sources = buildEvidenceSourceSnapshots(
      db,
      [
        { label: 'S1', sourceTitle: 'A.pdf' },
        { label: 'S1', sourceTitle: 'B.pdf' },
        { label: '', sourceTitle: 'C.pdf' }
      ],
      'direct_excerpt'
    )
    expect(sources.map((s) => s.key)).toEqual(['S1', 'S1.2', 'src3'])
    expect(new Set(sources.map((s) => s.key)).size).toBe(3)
  })
})
