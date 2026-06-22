import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  CONTRACT_BRIEF_INSTALL_ID,
  DEADLINE_OBLIGATION_INSTALL_ID,
  MEETING_PROTOCOL_INSTALL_ID,
  SHARE_SAFE_REVIEW_INSTALL_ID,
  contractBriefAnalysisHandler,
  deadlineObligationAnalysisHandler,
  meetingProtocolAnalysisHandler,
  shareSafeReviewAnalysisHandler
} from '../../src/main/services/skills/analysis/whole-doc-skills'
import {
  clearSkillAnalysisHandlers,
  getSkillAnalysisHandler
} from '../../src/main/services/skills/analysis/registry'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import { retrieveWholeDocument } from '../../src/main/services/rag'

// Skill-aware WHOLE-DOCUMENT handlers (skill-whole-doc engine, Wave 2). Two contracts pinned here:
//   1. the per-skill `applies()` gate — analysis-shaped intent (EN+DE) over a SINGLE in-scope doc,
//      `mode: 'grounded-whole-doc'`, no `run()` (the chat path streams the model answer directly);
//   2. `retrieveWholeDocument` — loads a document's chunks IN ORDER (not top-k), capped to a token
//      budget, with the honest `truncated` flag that drives the `capped`/"covers the beginning" badge.

function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-wholedoc-'))
  return openDatabase(join(dir, 'test.sqlite'))
}

/** Seed an indexed document with one chunk per line (chunk_index ordered; token_count left NULL). */
function seedDoc(db: Db, lines: string[]): string {
  const now = new Date().toISOString()
  const docId = randomUUID()
  db.prepare(
    `INSERT INTO documents (id, title, status, mime_type, fully_chunked, created_at, updated_at)
     VALUES (?, 'Doc', 'indexed', 'text/plain', ?, ?, ?)`
  ).run(docId, now, now, now)
  lines.forEach((line, i) => {
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
       VALUES (?, ?, ?, ?, 'Doc', NULL, ?)`
    ).run(randomUUID(), docId, i, line, now)
  })
  return docId
}

const HANDLERS = [
  { name: 'meeting-protocol', h: meetingProtocolAnalysisHandler, shaped: 'write the meeting minutes', deShaped: 'erstelle das Besprechungsprotokoll' },
  { name: 'contract-brief', h: contractBriefAnalysisHandler, shaped: 'summarize this contract', deShaped: 'vertrag zusammenfassen' },
  { name: 'share-safe-review', h: shareSafeReviewAnalysisHandler, shaped: 'is this safe to share?', deShaped: 'vor dem teilen prüfen' },
  { name: 'deadline-obligation-finder', h: deadlineObligationAnalysisHandler, shaped: 'what are the deadlines and obligations?', deShaped: 'welche fristen und pflichten gibt es?' }
] as const

describe('whole-doc analysis handlers — shape', () => {
  for (const { name, h } of HANDLERS) {
    it(`${name}: is a grounded-whole-doc handler with NO run() (chat path streams directly)`, () => {
      expect(h.mode).toBe('grounded-whole-doc')
      expect(h.run).toBeUndefined()
    })
  }
})

describe('whole-doc analysis handlers — applies() pre-flight', () => {
  for (const { name, h, shaped, deShaped } of HANDLERS) {
    it(`${name}: applies on an analysis-shaped question (EN + DE) over a single in-scope doc`, () => {
      const db = freshDb()
      const id = seedDoc(db, ['line one', 'line two'])
      expect(h.applies({ db, scope: { documentIds: [id] }, question: shaped })).toBe(true)
      expect(h.applies({ db, scope: { documentIds: [id] }, question: deShaped })).toBe(true)
    })

    it(`${name}: does not apply on an off-topic question (keeps the relevance path)`, () => {
      const db = freshDb()
      const id = seedDoc(db, ['line one'])
      expect(h.applies({ db, scope: { documentIds: [id] }, question: 'what colour is the sky?' })).toBe(false)
    })

    it(`${name}: does not apply over a multi-document scope (Wave 2 is single-doc)`, () => {
      const db = freshDb()
      const a = seedDoc(db, ['a'])
      const b = seedDoc(db, ['b'])
      expect(h.applies({ db, scope: { documentIds: [a, b] }, question: shaped })).toBe(false)
    })

    it(`${name}: does not apply when no document is in scope`, () => {
      const db = freshDb()
      seedDoc(db, ['a'])
      expect(h.applies({ db, scope: { documentIds: ['nope'] }, question: shaped })).toBe(false)
    })
  }
})

describe('analysis-handler registry — whole-doc skills', () => {
  it('registerBuiltinSkillAnalysisHandlers wires all four whole-doc handlers', () => {
    clearSkillAnalysisHandlers()
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(MEETING_PROTOCOL_INSTALL_ID)).toBe(meetingProtocolAnalysisHandler)
    expect(getSkillAnalysisHandler(CONTRACT_BRIEF_INSTALL_ID)).toBe(contractBriefAnalysisHandler)
    expect(getSkillAnalysisHandler(SHARE_SAFE_REVIEW_INSTALL_ID)).toBe(shareSafeReviewAnalysisHandler)
    expect(getSkillAnalysisHandler(DEADLINE_OBLIGATION_INSTALL_ID)).toBe(deadlineObligationAnalysisHandler)
  })
})

describe('retrieveWholeDocument', () => {
  it('reads ALL chunks in order, labelled S1…Sn, when they fit the budget (not truncated)', () => {
    const db = freshDb()
    const id = seedDoc(db, ['alpha', 'bravo', 'charlie'])
    const res = retrieveWholeDocument(db, id, 100_000)
    expect(res.chunks.map((c) => c.label)).toEqual(['S1', 'S2', 'S3'])
    expect(res.chunks.map((c) => c.text)).toEqual(['alpha', 'bravo', 'charlie']) // chunk_index order
    expect(res.chunksCovered).toBe(3)
    expect(res.chunksTotal).toBe(3)
    expect(res.truncated).toBe(false)
    expect(res.citations).toHaveLength(3)
  })

  it('caps to the budget from the BEGINNING and reports truncated when the document overflows', () => {
    const db = freshDb()
    // Each line ~4 words → with TOKENS_PER_WORD≈1.3, ~5 tokens/chunk. A tiny budget keeps only the head.
    const id = seedDoc(db, Array.from({ length: 20 }, (_v, i) => `chunk number ${i} text`))
    const res = retrieveWholeDocument(db, id, 12)
    expect(res.chunksTotal).toBe(20)
    expect(res.chunksCovered).toBeLessThan(20)
    expect(res.chunksCovered).toBeGreaterThan(0)
    expect(res.truncated).toBe(true)
    // The kept chunks are the document's BEGINNING, in order.
    expect(res.chunks[0].text).toBe('chunk number 0 text')
  })

  it('always includes the first chunk even if it alone exceeds the budget (never "no context")', () => {
    const db = freshDb()
    const id = seedDoc(db, ['this single chunk is quite a lot longer than the tiny budget allows here'])
    const res = retrieveWholeDocument(db, id, 1)
    expect(res.chunksCovered).toBe(1)
    expect(res.chunksTotal).toBe(1)
    expect(res.truncated).toBe(false)
  })
})
