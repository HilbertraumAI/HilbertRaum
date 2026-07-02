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
  WHAT_CHANGED_INSTALL_ID,
  contractBriefAnalysisHandler,
  deadlineObligationAnalysisHandler,
  meetingProtocolAnalysisHandler,
  shareSafeReviewAnalysisHandler,
  whatChangedAnalysisHandler
} from '../../src/main/services/skills/analysis/whole-doc-skills'
import {
  clearSkillAnalysisHandlers,
  getSkillAnalysisHandler
} from '../../src/main/services/skills/analysis/registry'
import { registerBuiltinSkillAnalysisHandlers } from '../../src/main/services/skills/analysis'
import {
  retrieveWholeDocument,
  retrieveCompareWholeDocuments,
  splitCompareBudget
} from '../../src/main/services/rag'

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

describe('whole-doc analysis handlers — intends() (W2 doc-count-agnostic intent)', () => {
  for (const { name, h, shaped, deShaped } of HANDLERS) {
    it(`${name}: intends() is TRUE on a shaped question (EN+DE) regardless of the doc count`, () => {
      const db = freshDb()
      const a = seedDoc(db, ['a'])
      const b = seedDoc(db, ['b'])
      // Two docs → applies() is false (Wave 2 is single-doc), but the intent is still shaped, so W2
      // narrows/routes instead of falling through silently.
      expect(h.applies!({ db, scope: { documentIds: [a, b] }, question: shaped })).toBe(false)
      expect(h.intends!({ db, scope: { documentIds: [a, b] }, question: shaped })).toBe(true)
      expect(h.intends!({ db, scope: { documentIds: [a, b] }, question: deShaped })).toBe(true)
    })

    it(`${name}: intends() is FALSE on an off-topic question (keeps the relevance path)`, () => {
      const db = freshDb()
      const a = seedDoc(db, ['a'])
      const b = seedDoc(db, ['b'])
      expect(h.intends!({ db, scope: { documentIds: [a, b] }, question: 'what colour is the sky?' })).toBe(false)
    })
  }

  it('what-changed: intends() is TRUE for a compare-shaped question at 1 or 3 docs (applies is false)', () => {
    const db = freshDb()
    const a = seedDoc(db, ['a'])
    const b = seedDoc(db, ['b'])
    const c = seedDoc(db, ['c'])
    const h = whatChangedAnalysisHandler
    for (const ids of [[a], [a, b, c]]) {
      expect(h.applies!({ db, scope: { documentIds: ids }, question: 'what changed?' })).toBe(false)
      expect(h.intends!({ db, scope: { documentIds: ids }, question: 'what changed?' })).toBe(true)
    }
    // Off-topic stays false at any count.
    expect(h.intends!({ db, scope: { documentIds: [a] }, question: 'what colour is the sky?' })).toBe(false)
  })
})

describe('analysis-handler registry — whole-doc skills', () => {
  it('registerBuiltinSkillAnalysisHandlers wires all four whole-doc handlers + what-changed compare', () => {
    clearSkillAnalysisHandlers()
    registerBuiltinSkillAnalysisHandlers()
    expect(getSkillAnalysisHandler(MEETING_PROTOCOL_INSTALL_ID)).toBe(meetingProtocolAnalysisHandler)
    expect(getSkillAnalysisHandler(CONTRACT_BRIEF_INSTALL_ID)).toBe(contractBriefAnalysisHandler)
    expect(getSkillAnalysisHandler(SHARE_SAFE_REVIEW_INSTALL_ID)).toBe(shareSafeReviewAnalysisHandler)
    expect(getSkillAnalysisHandler(DEADLINE_OBLIGATION_INSTALL_ID)).toBe(deadlineObligationAnalysisHandler)
    expect(getSkillAnalysisHandler(WHAT_CHANGED_INSTALL_ID)).toBe(whatChangedAnalysisHandler)
  })
})

describe('what-changed compare handler (Follow-up B) — shape + applies()', () => {
  it('is a grounded-whole-doc-compare handler with NO run() (chat path streams directly)', () => {
    expect(whatChangedAnalysisHandler.mode).toBe('grounded-whole-doc-compare')
    expect(whatChangedAnalysisHandler.run).toBeUndefined()
  })

  it('applies on a compare-shaped question (EN + DE) over EXACTLY two in-scope docs', () => {
    const db = freshDb()
    const a = seedDoc(db, ['a'])
    const b = seedDoc(db, ['b'])
    const scope = { documentIds: [a, b] }
    expect(whatChangedAnalysisHandler.applies({ db, scope, question: 'what changed between these?' })).toBe(true)
    expect(whatChangedAnalysisHandler.applies({ db, scope, question: 'was hat sich geändert?' })).toBe(true)
  })

  it('does NOT apply with only one in-scope doc, three docs, or an off-topic question', () => {
    const db = freshDb()
    const a = seedDoc(db, ['a'])
    const b = seedDoc(db, ['b'])
    const c = seedDoc(db, ['c'])
    expect(whatChangedAnalysisHandler.applies({ db, scope: { documentIds: [a] }, question: 'what changed?' })).toBe(false)
    expect(whatChangedAnalysisHandler.applies({ db, scope: { documentIds: [a, b, c] }, question: 'what changed?' })).toBe(false)
    expect(whatChangedAnalysisHandler.applies({ db, scope: { documentIds: [a, b] }, question: 'what colour is the sky?' })).toBe(false)
  })
})

describe('splitCompareBudget (Follow-up B) — size-aware with redistribution', () => {
  it('reads both whole when they jointly fit (each gets its full size)', () => {
    expect(splitCompareBudget(100, 100, 1000)).toEqual([100, 100])
  })
  it('splits evenly when both are large (each gets ~half)', () => {
    expect(splitCompareBudget(1000, 1000, 400)).toEqual([200, 200])
  })
  it('donates a small doc’s unused half to the larger doc', () => {
    // half=200; small doc takes 50, the large doc gets the 150 leftover on top of its 200.
    const [a, b] = splitCompareBudget(1000, 50, 400)
    expect(b).toBe(50)
    expect(a).toBe(350)
    expect(a + b).toBeLessThanOrEqual(400)
  })
  it('never returns below 1 (each doc keeps its first chunk)', () => {
    expect(splitCompareBudget(0, 0, 0)).toEqual([1, 1])
  })
})

describe('retrieveCompareWholeDocuments (Follow-up B)', () => {
  it('reads BOTH docs in order with continuous [Sn] labels and combined coverage (not truncated)', () => {
    const db = freshDb()
    const a = seedDoc(db, ['a-one', 'a-two'])
    const b = seedDoc(db, ['b-one', 'b-two', 'b-three'])
    const res = retrieveCompareWholeDocuments(db, [a, b], 100_000)
    // Continuous labels across the two documents (M2 — unique source labels).
    expect(res.chunks.map((c) => c.label)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'])
    expect(res.groups).toHaveLength(2)
    expect(res.groups[0].chunks.map((c) => c.text)).toEqual(['a-one', 'a-two'])
    expect(res.groups[1].chunks.map((c) => c.label)).toEqual(['S3', 'S4', 'S5'])
    expect(res.chunksCovered).toBe(5)
    expect(res.chunksTotal).toBe(5)
    expect(res.truncated).toBe(false)
    expect(res.citations.map((c) => c.label)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5'])
  })

  it('reports truncated when EITHER document overflows its budget share', () => {
    const db = freshDb()
    const a = seedDoc(db, Array.from({ length: 20 }, (_v, i) => `doc a chunk number ${i} text`))
    const b = seedDoc(db, ['b-one'])
    const res = retrieveCompareWholeDocuments(db, [a, b], 12)
    expect(res.truncated).toBe(true)
    expect(res.chunksCovered).toBeLessThan(res.chunksTotal)
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
