import { describe, it, expect } from 'vitest'
import { truncateSnippet, SNIPPET_MAX_CHARS } from '../../src/main/services/rag'

/** True if `s` contains an unpaired UTF-16 surrogate (a half code point — renders as `�`). */
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

// RAG-2 (full-audit-2026-06-29): a citation snippet is capped to SNIPPET_MAX_CHARS, and the cut
// must land on a code-point boundary — never inside a surrogate pair, which would leave the
// snippet ending in a lone surrogate that renders as `�`. Display-only, but a real defect.
describe('truncateSnippet — surrogate-safe truncation (RAG-2)', () => {
  it('does not split an astral character that straddles the SNIPPET_MAX_CHARS boundary', () => {
    // '𝟙' (U+1D7D9) is astral: two UTF-16 code units. Placed so a raw `.slice(0, MAX)` keeps only
    // its HIGH surrogate (the cut falls between the two units); padded past the cap so we truncate.
    const astral = '𝟙'
    expect(astral.length).toBe(2)
    const text = 'a'.repeat(SNIPPET_MAX_CHARS - 1) + astral + 'b'.repeat(50)
    const snippet = truncateSnippet(text)

    expect(snippet.endsWith('…')).toBe(true)
    // No lone surrogate survived the cut — the whole point of the fix.
    // Teeth: revert to `trimmed.slice(0, MAX)` → the high surrogate is kept alone → this trips.
    expect(hasLoneSurrogate(snippet)).toBe(false)
    // The astral char is kept whole rather than halved, and is the last real char before the ellipsis.
    expect(snippet).toContain(astral)
    expect(snippet).toBe('a'.repeat(SNIPPET_MAX_CHARS - 1) + astral + '…')
  })

  it('returns short text unchanged (trimmed, no ellipsis) and respects the cap for plain text', () => {
    expect(truncateSnippet('  hello world  ')).toBe('hello world')
    expect(truncateSnippet('x'.repeat(SNIPPET_MAX_CHARS))).toBe('x'.repeat(SNIPPET_MAX_CHARS))
    expect(truncateSnippet('x'.repeat(SNIPPET_MAX_CHARS + 5))).toBe('x'.repeat(SNIPPET_MAX_CHARS) + '…')
  })
})
