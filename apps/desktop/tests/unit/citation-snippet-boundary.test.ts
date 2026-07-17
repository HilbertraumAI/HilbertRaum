import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { chunksToCitations, type ChunkRow } from '../../src/main/services/skills/analysis/common'

// node:sqlite is not in module.builtinModules, so Vite tries to resolve a "sqlite" package —
// load it through createRequire like src/main/services/db.ts does (the repo's established shim).
const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as typeof import('node:sqlite')

/** True if `s` contains an unpaired UTF-16 surrogate (a half code point — renders as `�`). */
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

const row = (text: string): ChunkRow => ({
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
    const snippet = chunksToCitations([row(text)], 'doc.pdf')[0].snippet ?? ''
    expect(snippet.endsWith('…')).toBe(true)
    // Teeth: revert to `c.text.slice(0, 280)` → the high surrogate is kept alone → this trips.
    expect(hasLoneSurrogate(snippet)).toBe(false)
    // The astral char is kept whole as the last real char before the ellipsis.
    expect(snippet).toBe('a'.repeat(279) + '😀…')
  })

  it('returns short text unchanged and truncates plain long text with an ellipsis', () => {
    expect(chunksToCitations([row('hello world')], 't')[0].snippet).toBe('hello world')
    expect(chunksToCitations([row('x'.repeat(280))], 't')[0].snippet).toBe('x'.repeat(280))
    expect(chunksToCitations([row('x'.repeat(281))], 't')[0].snippet).toBe('x'.repeat(280) + '…')
  })

  // The P-6 SQL head (`substr(text, 1, 281)`) counts CODE POINTS in SQLite while the old JS guard
  // counted UTF-16 units. The fix compares code points on BOTH sides, so the 281st SQL code point
  // still works as the ">280 ⇒ truncated" sentinel even when the head contains astral chars.
  it('the substr(text,1,281) sentinel still triggers through real SQLite semantics', () => {
    const db = new DatabaseSync(':memory:')
    const head = (full: string): string =>
      (db.prepare('SELECT substr(?, 1, 281) AS t').get(full) as { t: string }).t

    // Astral-heavy text longer than the head: SQLite hands back exactly 281 code points (which is
    // MORE than 281 UTF-16 units here) — the truncation branch must still fire, pair-safe.
    const astralFull = '😀'.repeat(400)
    const astralHead = head(astralFull)
    expect([...astralHead].length).toBe(281)
    expect(astralHead.length).toBe(562) // > 281 UTF-16 units — the unit-vs-point mismatch is real
    const snippet = chunksToCitations([row(astralHead)], 't')[0].snippet ?? ''
    expect(snippet.endsWith('…')).toBe(true)
    expect(hasLoneSurrogate(snippet)).toBe(false)
    expect([...snippet].length).toBe(281) // 280 code points + the ellipsis

    // A text that fits (≤ 280 code points) comes back whole and untouched.
    const short = 'ä'.repeat(280)
    expect(head(short)).toBe(short)
    expect(chunksToCitations([row(head(short))], 't')[0].snippet).toBe(short)
  })
})
