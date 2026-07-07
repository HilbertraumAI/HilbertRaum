import { describe, it, expect } from 'vitest'
import {
  applySpans,
  replacementText,
  locateOccurrences,
  PER_CHAR_MASK,
  type TransformSpan
} from '../../src/main/services/skills/tools/span-transform'
import { detectionShadow, redactText } from '../../src/main/services/skills/tools/redaction'

// architecture.md "Skills — design record" §20 — the span-transform engine (Phase 6, D74), the shared
// substrate the C-wave phases (LLM-located redaction #22, targeted edits #23) locate spans for and
// splice through. The two load-bearing invariants: byte-identity OUTSIDE applied spans by
// construction (D58), and non-overlapping/validated/single-pass splicing with skipped-span reporting.
// Plus the two D74 replacement strategies (token / per-char) and the D75/D76 occurrence-anchored find.

describe('applySpans — the generalized splice core', () => {
  it('splices a single span and copies everything else through byte-identical', () => {
    const text = 'Reach jane.doe@example.com today'
    const start = text.indexOf('jane.doe@example.com')
    const r = applySpans(text, [{ start, length: 'jane.doe@example.com'.length, replacement: '[EMAIL]' }])
    expect(r.text).toBe('Reach [EMAIL] today')
    expect(r.applied).toHaveLength(1)
    expect(r.skipped).toHaveLength(0)
  })

  it('byte-identity outside spans: only the applied ranges differ from the input', () => {
    const text = 'aaa BBB ccc DDD eee'
    // Replace "BBB" and "DDD".
    const spans: TransformSpan[] = [
      { start: 4, length: 3, replacement: 'X' },
      { start: 12, length: 3, replacement: 'YY' }
    ]
    const r = applySpans(text, spans)
    expect(r.text).toBe('aaa X ccc YY eee')
    // Everything OUTSIDE the two spans is preserved verbatim (prefix, the interleaved " ccc ", suffix).
    expect(r.text.startsWith('aaa ')).toBe(true)
    expect(r.text.endsWith(' eee')).toBe(true)
    expect(r.text).toContain(' ccc ')
  })

  it('is a single pass in ascending-start order regardless of input order', () => {
    const text = '0123456789'
    // Deliberately out of order — the engine sorts by start.
    const spans: TransformSpan[] = [
      { start: 6, length: 2, replacement: 'G' },
      { start: 0, length: 2, replacement: 'A' },
      { start: 3, length: 1, replacement: 'D' }
    ]
    const r = applySpans(text, spans)
    expect(r.text).toBe('A2D45G89')
    expect(r.applied.map((s) => s.start)).toEqual([0, 3, 6]) // reported in applied (ascending) order
  })

  it('drops and REPORTS an out-of-bounds / non-positive-length span, applying the valid ones', () => {
    const text = 'hello world'
    const spans: TransformSpan[] = [
      { start: 0, length: 5, replacement: 'HI' }, // valid
      { start: 6, length: 0, replacement: 'x' }, // zero length → skipped
      { start: 9, length: 10, replacement: 'y' }, // runs past the end → skipped
      { start: -1, length: 2, replacement: 'z' } // negative start → skipped
    ]
    const r = applySpans(text, spans)
    expect(r.text).toBe('HI world')
    expect(r.applied).toHaveLength(1)
    expect(r.skipped).toHaveLength(3)
  })

  it('drops the OVERLAPPING span (keeps the first, reports the second)', () => {
    const text = 'abcdefgh'
    const spans: TransformSpan[] = [
      { start: 1, length: 4, replacement: 'X' }, // covers bcde
      { start: 3, length: 3, replacement: 'Y' } // overlaps (starts inside the first) → skipped
    ]
    const r = applySpans(text, spans)
    expect(r.text).toBe('aXfgh')
    expect(r.applied).toHaveLength(1)
    expect(r.applied[0].start).toBe(1)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].start).toBe(3)
  })

  it('an empty span list returns the text unchanged (a faithful copy)', () => {
    expect(applySpans('unchanged', []).text).toBe('unchanged')
  })

  it('two abutting (non-overlapping) spans both apply', () => {
    const text = 'ABCD'
    const r = applySpans(text, [
      { start: 0, length: 2, replacement: 'x' },
      { start: 2, length: 2, replacement: 'y' }
    ])
    expect(r.text).toBe('xy')
    expect(r.applied).toHaveLength(2)
  })
})

describe('replacementText — the D74 strategies', () => {
  it('token returns the fixed token; perChar returns █ of the span length', () => {
    expect(replacementText('token', '[EMAIL]', 20)).toBe('[EMAIL]')
    expect(replacementText('perChar', '[EMAIL]', 5)).toBe('█████')
    expect(replacementText('perChar', '[EMAIL]', 5).length).toBe(5)
    expect(PER_CHAR_MASK).toBe('█')
  })
})

describe('redactText perChar strategy (D74) — length- and layout-preserving masks', () => {
  const PII = [
    'Reach Jane at jane.doe@example.com or call +43 660 1234567.',
    'Account IBAN AT61 1904 3002 3457 3201, opened on 2026-03-15.',
    'More at https://example.com/profile.'
  ].join('\n')

  it('token strategy reproduces the current [EMAIL]-style masks exactly (default is token)', () => {
    const def = redactText(PII)
    const tok = redactText(PII, 'token')
    expect(tok.text).toBe(def.text)
    expect(tok.text).toContain('[EMAIL]')
    expect(tok.text).toContain('[IBAN]')
    expect(tok.counts).toEqual({ email: 1, phone: 1, iban: 1, card: 0, date: 1, url: 1 })
  })

  it('perChar preserves total length AND the line count, and leaks no original', () => {
    const per = redactText(PII, 'perChar')
    expect(per.text.length).toBe(PII.length) // every mask is same-length as what it replaced
    expect(per.text.split('\n')).toHaveLength(3) // newlines (layout) survive
    expect(PII.split('\n')[0].length).toBe(per.text.split('\n')[0].length) // per-line lengths hold
    for (const secret of [
      'jane.doe@example.com',
      '+43 660 1234567',
      'AT61 1904 3002 3457 3201',
      '2026-03-15',
      'https://example.com/profile'
    ]) {
      expect(per.text).not.toContain(secret)
    }
    expect(per.text).toContain(PER_CHAR_MASK)
    // Counts are strategy-independent — identical to a token run.
    expect(per.counts).toEqual(redactText(PII, 'token').counts)
  })

  it('perChar is idempotent — re-running masks nothing more (█ carries no detectable pattern)', () => {
    const once = redactText(PII, 'perChar')
    const twice = redactText(once.text, 'perChar')
    expect(twice.totalRedactions).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  it('perChar holds the SKA-3 same-length shadow invariant on a Unicode-set document', () => {
    // The masked output must still satisfy shadow === detectionShadow(text): a █ run maps to itself
    // (not a shadow separator), and the surrounding NBSP/narrow-NBSP survive verbatim (byte-identity).
    const input =
      'Zahlung fällig. IBAN AT61 1904 3002 3457 3201. Danke sehr.'
    const per = redactText(input, 'perChar')
    expect(per.text.length).toBe(input.length)
    expect(detectionShadow(per.text).length).toBe(per.text.length)
    // The IBAN span became █; the NBSP prose separators are untouched.
    expect(per.text).toContain('Zahlung fällig.')
    expect(per.text).toContain('Danke sehr.')
    expect(per.text).not.toContain('AT61')
    expect(per.text).toContain(PER_CHAR_MASK)
  })
})

describe('locateOccurrences — verbatim, occurrence-anchored find (D75/D76)', () => {
  const TEXT = ['der Vollmachtgeber A', 'der Vollmachtgeber B', 'kein Treffer', 'der Vollmachtgeber C'].join(
    '\n'
  )

  it('finds every verbatim occurrence with its start, length, line, and 1-based index', () => {
    const hits = locateOccurrences(TEXT, 'Vollmachtgeber')
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.line)).toEqual([1, 2, 4]) // 1-based lines, skipping the miss on line 3
    expect(hits.map((h) => h.index)).toEqual([1, 2, 3])
    expect(hits[0].length).toBe('Vollmachtgeber'.length)
    // The reported offset is exact (verbatim slice round-trips).
    expect(TEXT.slice(hits[0].start, hits[0].start + hits[0].length)).toBe('Vollmachtgeber')
  })

  it('anchors to a line (only occurrences that start on that line)', () => {
    const hits = locateOccurrences(TEXT, 'Vollmachtgeber', { line: 2 })
    expect(hits).toHaveLength(1)
    expect(hits[0].line).toBe(2)
    expect(hits[0].index).toBe(2) // the GLOBAL index is preserved through the line filter
  })

  it('anchors to the nth occurrence (1-based, within the line-filtered set)', () => {
    expect(locateOccurrences(TEXT, 'Vollmachtgeber', { nth: 3 })[0].line).toBe(4)
    // line + nth compose: the 1st occurrence ON line 4.
    const onLine4 = locateOccurrences(TEXT, 'Vollmachtgeber', { line: 4, nth: 1 })
    expect(onLine4).toHaveLength(1)
    expect(onLine4[0].line).toBe(4)
  })

  it('drops on mismatch: an absent needle, a wrong line, or an out-of-range nth all return []', () => {
    expect(locateOccurrences(TEXT, 'Bevollmächtigter')).toEqual([]) // not present verbatim
    expect(locateOccurrences(TEXT, 'Vollmachtgeber', { line: 3 })).toEqual([]) // line 3 is the miss line
    expect(locateOccurrences(TEXT, 'Vollmachtgeber', { nth: 4 })).toEqual([]) // only 3 exist
    expect(locateOccurrences(TEXT, '')).toEqual([]) // empty needle finds nothing
  })

  it('matches non-overlapping (advances past each match)', () => {
    expect(locateOccurrences('aaaa', 'aa')).toHaveLength(2) // positions 0 and 2, not 0/1/2
  })

  it('composes with applySpans: locate → build spans → splice (the C-wave pipeline shape)', () => {
    const spans: TransformSpan[] = locateOccurrences(TEXT, 'Vollmachtgeber').map((h) => ({
      start: h.start,
      length: h.length,
      replacement: 'Vollmachtgeberin'
    }))
    const r = applySpans(TEXT, spans)
    expect(r.applied).toHaveLength(3)
    expect(r.text).toContain('der Vollmachtgeberin A')
    expect(r.text).toContain('kein Treffer') // the untouched line is byte-identical
    expect(r.text).not.toMatch(/Vollmachtgeber(?!in)/) // no bare "Vollmachtgeber" remains
  })
})
