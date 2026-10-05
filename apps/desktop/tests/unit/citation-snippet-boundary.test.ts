import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../../src/main/services/db'
import { chunksToCitations, loadCitationChunks, type ChunkRow } from '../../src/main/services/skills/analysis/common'

/** True if `s` contains an unpaired UTF-16 surrogate (a half code point — renders as `�`). */
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

const row = (text: string): ChunkRow => ({
  id: 'chunk-1',
  chunk_index: 0,
  text,
  source_label: null,
  page_number: null,
  section_label: null
})

// F-15 (audit 2026-07-16): the persisted bank/invoice citation snippets were cut with a raw UTF-16
// `String.slice(0, 280)` — the exact RAG-2 class fixed in rag/index.ts truncateSnippet but missed
// here. A chunk whose 280 boundary splits a surrogate pair persisted a snippet ending in a lone
// surrogate (permanent `�` in the sources panel). Mirrors tests/unit/snippet-truncate.test.ts.
describe('chunksToCitations — surrogate-safe snippet truncation (F-15)', () => {
  it('does not split an astral character straddling the 280 boundary', () => {
    // '😀' (U+1F600) is astral: two UTF-16 code units, placed as code point index 279 so a raw
    // `.slice(0, 280)` keeps only its HIGH surrogate; padded past the cap so we truncate.
    const text = 'a'.repeat(279) + '😀' + 'b'.repeat(60)
    const snippet = chunksToCitations([row(text)], 'doc.pdf', 'doc-1')[0].snippet ?? ''
    expect(snippet.endsWith('…')).toBe(true)
    // Teeth: revert to `c.text.slice(0, 280)` → the high surrogate is kept alone → this trips.
    expect(hasLoneSurrogate(snippet)).toBe(false)
    // The astral char is kept whole as the last real char before the ellipsis.
    expect(snippet).toBe('a'.repeat(279) + '😀…')
  })

  it('returns short text unchanged and truncates plain long text with an ellipsis', () => {
    expect(chunksToCitations([row('hello world')], 't', 'doc-1')[0].snippet).toBe('hello world')
    expect(chunksToCitations([row('x'.repeat(280))], 't', 'doc-1')[0].snippet).toBe('x'.repeat(280))
    expect(chunksToCitations([row('x'.repeat(281))], 't', 'doc-1')[0].snippet).toBe('x'.repeat(280) + '…')
  })

  // The P-6 SQL head (`substr(text, 1, 281)` in `loadCitationChunks`) counts CODE POINTS in SQLite while
  // the old JS guard counted UTF-16 units. The fix compares code points on BOTH sides, so the 281st SQL
  // code point still works as the ">280 ⇒ truncated" sentinel even when the head contains astral chars.
  // Driven through the production loader over real `chunks` rows, so a change to its substr bound reddens it.
  it('loadCitationChunks → chunksToCitations: the 281-code-point SQL head still triggers the truncation, pair-safe', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-citation-')), 'test.sqlite'))
    try {
      const now = new Date().toISOString()
      const docId = randomUUID()
      db.prepare(
        `INSERT INTO documents (id, title, status, mime_type, created_at, updated_at)
         VALUES (?, 'Doc', 'indexed', 'application/pdf', ?, ?)`
      ).run(docId, now, now)
      // Astral-heavy text longer than the head (562 UTF-16 units for 281 code points), plain text over
      // the cap, and text that fits whole.
      const texts = ['😀'.repeat(400), 'x'.repeat(300), 'ä'.repeat(280)]
      texts.forEach((text, i) => {
        db.prepare(
          `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, created_at)
           VALUES (?, ?, ?, ?, 'Doc', 1, ?)`
        ).run(randomUUID(), docId, i, text, now)
      })

      const loaded = loadCitationChunks(db, docId)
      // SQLite hands back exactly 281 code points — MORE than 281 UTF-16 units for the astral chunk.
      expect([...loaded[0].text].length).toBe(281)
      expect(loaded[0].text.length).toBe(562)

      const [astral, plain, short] = chunksToCitations(loaded, 'Doc', docId).map((c) => c.snippet ?? '')
      expect(astral.endsWith('…')).toBe(true)
      expect(hasLoneSurrogate(astral)).toBe(false)
      expect([...astral].length).toBe(281) // 280 code points + the ellipsis
      expect(plain).toBe('x'.repeat(280) + '…')
      expect(short).toBe(texts[2]) // ≤ 280 code points comes back whole and untouched
    } finally {
      db.close()
    }
  })
})

// EP-1 Phase 0 (plan §5 item 2): the skill-analysis citation path (bank/invoice deterministic
// answers, persisted via rag:ask) pins source identity like the RAG/provenance builders do.
describe('chunksToCitations — additive documentId/chunkId enrichment (EP-1)', () => {
  it('stamps the documentId and each row id as chunkId', () => {
    const citations = chunksToCitations(
      [
        { ...row('first chunk'), id: 'chunk-a' },
        { ...row('second chunk'), id: 'chunk-b' }
      ],
      'statement.pdf',
      'doc-42'
    )
    expect(citations.map((c) => c.chunkId)).toEqual(['chunk-a', 'chunk-b'])
    expect(citations.every((c) => c.documentId === 'doc-42')).toBe(true)
    // The rest of the projection is untouched by the enrichment.
    expect(citations[0]).toMatchObject({ label: 'S1', sourceTitle: 'statement.pdf', snippet: 'first chunk' })
  })
})
