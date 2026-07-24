import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { createEvidenceReviewFromMessage } from '../../src/main/services/evidence-pack/snapshot'
import { getEvidenceSourceContext } from '../../src/main/services/evidence-pack/source-context'
import { chunkSegments, type DocumentChunk } from '../../src/main/services/ingestion/chunker'
import { truncateSnippet } from '../../src/main/services/rag'
import type { Citation } from '../../src/shared/types'

// AUD-08 — "Open source in context" must not print the chunker's overlap twice.
//
// The chunker deliberately re-includes the tail of the previous window at the head of the
// next one (~80 tokens on the shipped 500/80 configuration) so retrieval never splits a
// fact across a boundary. The source-context reader joins the located chunk with its
// stored neighbours to build the surrounding text, so a naive join prints that shared run
// ONCE at the end of the previous chunk and AGAIN at the start of the located chunk — a
// byte-exact several-hundred-character block, duplicated, in a modal whose whole job is to
// show the reviewer what the document actually says.
//
// These tests drive the REAL chunker (not hand-written "overlapping" fixtures) so the run
// they assert on is the one production actually produces, and they assert on the DUPLICATED
// SUBSTRING itself, never merely on a length.

function freshDb(): Db {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-epctx-'))
  return openDatabase(join(root, 'test.sqlite'))
}

function seedDocument(db: Db, title: string): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO documents (id, title, mime_type, sha256, status, created_at, updated_at)
     VALUES (?, ?, 'application/pdf', ?, 'indexed', ?, ?)`
  ).run(id, title, 'ab'.repeat(32), now, now)
  return id
}

function seedChunk(
  db: Db,
  opts: {
    documentId: string
    index: number
    text: string
    page?: number | null
    section?: string | null
  }
): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.documentId,
    opts.index,
    opts.text,
    `S${opts.index + 1}`,
    opts.page ?? null,
    opts.section ?? null,
    new Date().toISOString()
  )
  return id
}

function seedReviewForCitation(db: Db, citation: Citation): string {
  const conv = createConversation(db, { title: 'Overlap chat', modelId: 'm1' })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'Question?' })
  const msg = appendMessage(db, {
    conversationId: conv.id,
    role: 'assistant',
    content: 'Claim. [S1]',
    citations: [citation],
    coverage: { mode: 'relevance', chunksCovered: 1, chunksTotal: 3 }
  })
  return createEvidenceReviewFromMessage(db, msg.id, {}).id
}

/**
 * Deterministic prose with realistic word lengths. Every word carries its own index so the
 * text is NON-repeating: the only run shared between two windows is the one the chunker
 * itself duplicated. (Cyclic filler would make far longer "shared" runs appear by accident
 * and the assertions would measure the fixture instead of the code.)
 */
function prose(words: number): string {
  const vocabulary = [
    'either',
    'party',
    'may',
    'terminate',
    'this',
    'agreement',
    'upon',
    'thirty',
    'days',
    'written',
    'notice',
    'delivered',
    'to',
    'the',
    'registered',
    'address'
  ]
  return Array.from({ length: words }, (_, i) => `${vocabulary[i % vocabulary.length]}${i}`).join(
    ' '
  )
}

/**
 * The byte-exact run the chunker duplicated across one boundary: the longest suffix of
 * `prev` that is also a prefix of `next`. Computed here by brute force — deliberately NOT
 * the implementation's algorithm, so the test cannot agree with a broken de-overlap by
 * sharing its mistake.
 */
function duplicatedRun(prev: string, next: string): string {
  for (let len = Math.min(prev.length, next.length); len > 0; len -= 1) {
    if (prev.endsWith(next.slice(0, len))) return next.slice(0, len)
  }
  return ''
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + 1
  }
}

/** Seed `chunks` from real chunker output and open the context for the chunk at `located`. */
function contextForChunkedDocument(
  db: Db,
  chunks: DocumentChunk[],
  located: number,
  labels: { page: number | null; section: string | null }
): ReturnType<typeof getEvidenceSourceContext> {
  const docId = seedDocument(db, 'contract.pdf')
  const ids = chunks.map((c) =>
    seedChunk(db, {
      documentId: docId,
      index: c.chunkIndex,
      text: c.text,
      page: labels.page,
      section: labels.section
    })
  )
  const reviewId = seedReviewForCitation(db, {
    label: 'S1',
    sourceTitle: 'contract.pdf',
    documentId: docId,
    chunkId: ids[located],
    snippet: truncateSnippet(chunks[located]!.text)
  })
  return getEvidenceSourceContext(db, reviewId, 'S1')
}

describe('source-in-context — chunk overlap is stripped on join (AUD-08)', () => {
  it('the shipped 500/80 chunker: the run shared with the previous chunk appears ONCE', () => {
    const db = freshDb()
    // Production configuration — no options passed, so CHUNK_DEFAULTS (500 tokens, 80
    // overlap) apply, exactly as ingestion runs it.
    const chunks = chunkSegments([
      { text: prose(1400), pageNumber: 12, sectionLabel: 'Termination' }
    ])
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    const dup = duplicatedRun(chunks[0]!.text, chunks[1]!.text)
    // Sanity: the chunker really did duplicate a substantial run at this boundary — the
    // premise of the whole finding. (Hundreds of characters at the shipped settings.)
    expect(dup.length).toBeGreaterThan(200)

    const ctx = contextForChunkedDocument(db, chunks, 1, { page: 12, section: 'Termination' })!
    expect(ctx.located).toBe(true)
    const rendered = `${ctx.before ?? ''}${ctx.match ?? ''}${ctx.after ?? ''}`

    // The duplicated run must be printed exactly once across the whole rendered context.
    expect(occurrences(rendered, dup)).toBe(1)
    // And specifically: the copy that goes is the trailing one in `before`. The surviving
    // copy starts exactly where the located chunk starts — the excerpt is a PREFIX of that
    // chunk, so removing THIS copy instead would have eaten the highlighted text.
    expect(rendered.indexOf(dup)).toBe(ctx.before!.length)
    expect(ctx.before!.endsWith(dup)).toBe(false)
  })

  it('both boundaries de-overlap: neither neighbour repeats the located chunk (real chunker, tight windows)', () => {
    const db = freshDb()
    // The same real chunker at a window small enough that BOTH stored neighbours fit
    // inside the fixed ±1200-character context window, so the following-chunk boundary is
    // observable too (at 500-token windows the located chunk alone fills the window).
    const chunks = chunkSegments([{ text: prose(200), pageNumber: 3, sectionLabel: 'Clause 5' }], {
      chunkSizeTokens: 60,
      chunkOverlapTokens: 20
    })
    expect(chunks.length).toBeGreaterThanOrEqual(3)

    const dupBefore = duplicatedRun(chunks[0]!.text, chunks[1]!.text)
    const dupAfter = duplicatedRun(chunks[1]!.text, chunks[2]!.text)
    expect(dupBefore.length).toBeGreaterThan(50)
    expect(dupAfter.length).toBeGreaterThan(50)

    const ctx = contextForChunkedDocument(db, chunks, 1, { page: 3, section: 'Clause 5' })!
    expect(ctx.located).toBe(true)
    const rendered = `${ctx.before ?? ''}${ctx.match ?? ''}${ctx.after ?? ''}`

    expect(occurrences(rendered, dupBefore)).toBe(1)
    expect(occurrences(rendered, dupAfter)).toBe(1)
    // The located chunk's own text is never trimmed — the highlighted excerpt must stay
    // byte-exact, and the reader's offsets are anchored in it.
    expect(rendered).toContain(chunks[1]!.text)
  })

  it('neighbours from a DIFFERENT segment are never trimmed (only same-segment windows overlap)', () => {
    const db = freshDb()
    const docId = seedDocument(db, 'mixed.pdf')
    // Two separate pages that happen to share a long run of text. The chunker only
    // introduces overlap WITHIN a segment, so a shared run across a page boundary is
    // genuine repeated content in the document and must survive verbatim.
    const shared = prose(40)
    const first = `Page one opener. ${shared}`
    const second = `${shared} Page two closer.`
    const firstId = seedChunk(db, { documentId: docId, index: 0, text: first, page: 1 })
    seedChunk(db, { documentId: docId, index: 1, text: second, page: 2 })
    const reviewId = seedReviewForCitation(db, {
      label: 'S1',
      sourceTitle: 'mixed.pdf',
      documentId: docId,
      chunkId: firstId,
      snippet: truncateSnippet(first)
    })

    const ctx = getEvidenceSourceContext(db, reviewId, 'S1')!
    expect(ctx.located).toBe(true)
    // Nothing was stripped: the following page's chunk is rendered in full.
    expect(ctx.after).toContain(second)
  })
})
