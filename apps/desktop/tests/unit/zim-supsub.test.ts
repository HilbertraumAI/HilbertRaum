import { describe, expect, it } from 'vitest'
import {
  REF_SUP_CLASS_RE,
  SUB_MARK,
  SUP_MARK,
  foldSupSub
} from '../../src/main/services/zim/supsub'

// The sup/sub convention shared by the converter (`html.ts` prose + headings, `tables.ts`
// cells) and the retrieval matchers (`arm.ts`, `admit.ts`) — issue #488. `foldSupSub` must
// remove EXACTLY the shapes the converter emits and nothing else: the invariant is that a
// matcher sees the same flattened text it saw before the markers existed, so no question that
// matched an article before #488 stops matching it now.

describe('foldSupSub — the shapes the converter emits', () => {
  it('folds a superscript marker back out from between a base and its exponent', () => {
    expect(foldSupSub('25 m^2 gemessen')).toBe('25 m2 gemessen')
    expect(foldSupSub('10^6')).toBe('106')
    expect(foldSupSub('19,32 g/cm^3')).toBe('19,32 g/cm3')
  })

  it('folds a subscript marker back out when what follows it is a digit', () => {
    expect(foldSupSub('H_2O')).toBe('H2O')
    expect(foldSupSub('CO_2')).toBe('CO2')
    expect(foldSupSub('Fe_2O_3')).toBe('Fe2O3')
  })

  it('folds a letter exponent too — `^` is not restricted to digits', () => {
    // A real corpus shape (ordinals, `20<sup>th</sup>`): the pre-#488 text was `20th`, so that
    // is what the matchers must still see.
    expect(foldSupSub('20^th')).toBe('20th')
  })

  it('folds both markers in one pass, anywhere in the text', () => {
    expect(foldSupSub('Die Fläche ist 25 m^2 und 10^6 Einheiten CO_2')).toBe(
      'Die Fläche ist 25 m2 und 106 Einheiten CO2'
    )
  })
})

describe('foldSupSub — what it deliberately leaves alone', () => {
  it('keeps an underscore before a LETTER: identifiers in code-oriented packs tokenise as today', () => {
    // devdocs/gobyexample articles are full of these; folding them would change the tokens
    // those articles have always produced, for no gain (a chemical subscript is a digit).
    expect(foldSupSub('snake_case')).toBe('snake_case')
    expect(foldSupSub('MAX_SAFE_INTEGER')).toBe('MAX_SAFE_INTEGER')
    expect(foldSupSub('x_i')).toBe('x_i') // a letter subscript: both halves are under the term floor anyway
  })

  it('keeps an underscore that starts a run — nothing precedes it to fuse with', () => {
    expect(foldSupSub('_foo')).toBe('_foo')
    expect(foldSupSub('_2')).toBe('_2')
  })

  it('keeps a caret the converter cannot have written in that position', () => {
    expect(foldSupSub('a ^ b')).toBe('a ^ b') // spaced: an operator, not a marker
    expect(foldSupSub('^[note 1]')).toBe('^[note 1]') // sup text starting with a non-alphanumeric
    expect(foldSupSub('a^®')).toBe('a^®') // `®` is neither \p{L} nor \p{N}
    expect(foldSupSub('Rest^')).toBe('Rest^') // the empty-<sup> shape html.ts accepts
  })

  it('returns text with no marker unchanged, and is idempotent', () => {
    const plain = 'Wasserstoff und Sauerstoff, 25 m2'
    expect(foldSupSub(plain)).toBe(plain)
    expect(foldSupSub('')).toBe('')
    expect(foldSupSub(foldSupSub('H_2O und 10^6'))).toBe(foldSupSub('H_2O und 10^6'))
  })
})

describe('the emitting side and the folding side cannot drift', () => {
  it('exports the literals the converter writes', () => {
    expect(SUP_MARK).toBe('^')
    expect(SUB_MARK).toBe('_')
  })

  it('shares one predicate for the <sup> kind both converter paths drop', () => {
    expect(REF_SUP_CLASS_RE.test('mw-ref reference')).toBe(true)
    expect(REF_SUP_CLASS_RE.test('reference')).toBe(true)
    expect(REF_SUP_CLASS_RE.test('noref')).toBe(false)
    expect(REF_SUP_CLASS_RE.global).toBe(false) // stateless: no lastIndex to carry between tags
  })
})
