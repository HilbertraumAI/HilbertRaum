import { describe, expect, it } from 'vitest'
import {
  REF_SUP_CLASS_RE,
  SUB_MARK,
  SUP_MARK,
  foldSupSub,
  lastCharOf,
  shouldMark
} from '../../src/main/services/zim/supsub'

// The sup/sub convention shared by the converter (`html.ts` prose + headings, `tables.ts`
// cells) and the retrieval matchers (`arm.ts`, `admit.ts`) — issue #488, revised after the
// first census (949 cached German Wikipedia articles + 488 from seven other archives).
//
// Two rules, tested here: `shouldMark` decides WHERE a marker is written — only between two
// alphanumerics, which is what keeps the reference back-links (`↑ a b c`) and the
// paragraph-initial `<sup>` sentences the census found out of the text — and `foldSupSub`
// removes a `^` OR `_` in exactly that position. The invariant the matchers need is not
// "the same text as before" but the substring form: both compare by `includes`, so removing
// characters is always safe and only a SURVIVING marker between two alphanumerics could split
// an alphanumeric run in two. None is emitted, bar the sign-suffixed exponents below.

describe('shouldMark — where a marker is written at all', () => {
  it('marks between two alphanumerics, in either script or case', () => {
    expect(shouldMark('m', '2')).toBe(true) // m<sup>2</sup>
    expect(shouldMark('0', '6')).toBe(true) // 10<sup>6</sup>
    expect(shouldMark('O', 'x')).toBe(true) // NO<sub>x</sub>
    expect(shouldMark('0', 'th')).toBe(true) // 20<sup>th</sup> — only the first char is read
    expect(shouldMark('K', 'S')).toBe(true) // pK<sub>S</sub>
    expect(shouldMark('ä', 'ß')).toBe(true) // non-ASCII letters are letters
  })

  it('marks before a sign: the exponent reads right and the sign has split the run already', () => {
    expect(shouldMark('0', '−6')).toBe(true) // U+2212, the `&minus;` entity decodes to it
    expect(shouldMark('a', '+')).toBe(true) // Na<sup>+</sup>
    expect(shouldMark('0', '-3')).toBe(true) // ASCII hyphen-minus
    expect(shouldMark('0', '±3')).toBe(true)
  })

  it('does not mark where the marker would not sit between alphanumerics', () => {
    expect(shouldMark(' ', 'a')).toBe(false) // `↑ <sup>a</sup>` — the census’s 63 % case
    expect(shouldMark('', 'a')).toBe(false) // a block boundary: nothing precedes the element
    expect(shouldMark('e', '[')).toBe(false) // `<sup>[note 1]</sup>`
    expect(shouldMark(')', '2')).toBe(false) // `(a+b)<sup>2</sup>` — documented residual
    expect(shouldMark('e', 'ⓘ')).toBe(false) // `Aussprache<sup>ⓘ</sup>`: ⓘ is a symbol
    expect(shouldMark('m', '')).toBe(false) // an empty `<sup></sup>`
    expect(shouldMark('m', ' 2')).toBe(false) // the element’s text starts with a space
    expect(shouldMark('.', '2')).toBe(false)
    expect(shouldMark('', '')).toBe(false)
  })
})

describe('lastCharOf — the `prev` the converter hands shouldMark', () => {
  it('is the last code point, and empty for empty text', () => {
    expect(lastCharOf('25 m')).toBe('m')
    expect(lastCharOf('')).toBe('')
    expect(lastCharOf('\n')).toBe('\n')
  })

  it('keeps an astral letter whole, so it is not mistaken for a lone surrogate', () => {
    const astral = '\u{1D400}' // MATHEMATICAL BOLD CAPITAL A — \p{L}, two UTF-16 code units
    expect(lastCharOf(`x${astral}`)).toBe(astral)
    expect(shouldMark(lastCharOf(`x${astral}`), '2')).toBe(true)
  })
})

describe('foldSupSub — the shapes the converter emits', () => {
  it('folds a superscript marker back out from between a base and its exponent', () => {
    expect(foldSupSub('25 m^2 gemessen')).toBe('25 m2 gemessen')
    expect(foldSupSub('10^6')).toBe('106')
    expect(foldSupSub('19,32 g/cm^3')).toBe('19,32 g/cm3')
  })

  it('folds a subscript marker back out symmetrically — before a letter as well as a digit', () => {
    // The first cut folded `_` only before a DIGIT. The census measured that rule's cost: 86
    // real match terms in 36 articles were split by the surviving marker, so a question typing
    // `NOx` stopped matching the article that writes `NO<sub>x</sub>`.
    expect(foldSupSub('H_2O')).toBe('H2O')
    expect(foldSupSub('CO_2')).toBe('CO2')
    expect(foldSupSub('Fe_2O_3')).toBe('Fe2O3')
    expect(foldSupSub('NO_x')).toBe('NOx')
    expect(foldSupSub('SO_x und NO_x')).toBe('SOx und NOx')
    expect(foldSupSub('pK_S')).toBe('pKS')
    expect(foldSupSub('MW_therm')).toBe('MWtherm')
    expect(foldSupSub('x_i')).toBe('xi')
  })

  it('folds a letter exponent too — `^` is not restricted to digits', () => {
    // A real corpus shape (ordinals, `20<sup>th</sup>`): the pre-#488 text was `20th`, so that
    // is what the matchers must still see.
    expect(foldSupSub('20^th')).toBe('20th')
  })

  it('folds a typed identifier the same way on both sides — the accepted price of the 86 terms', () => {
    // Documented consequence of dropping the digit-only clause: `snake_case` yields ONE term
    // now, on the question side and the article side alike, so an identifier still matches
    // itself; what it no longer matches is an article writing it as `snake case`.
    expect(foldSupSub('snake_case')).toBe('snakecase')
    expect(foldSupSub('MAX_SAFE_INTEGER')).toBe('MAXSAFEINTEGER')
  })

  it('folds both markers in one pass, anywhere in the text', () => {
    expect(foldSupSub('Die Fläche ist 25 m^2 und 10^6 Einheiten CO_2')).toBe(
      'Die Fläche ist 25 m2 und 106 Einheiten CO2'
    )
  })
})

describe('foldSupSub — what it deliberately leaves alone', () => {
  it('keeps a sign-suffixed exponent: the sign already splits the run, so no term moves', () => {
    expect(foldSupSub('10^−6')).toBe('10^−6') // U+2212
    expect(foldSupSub('Na^+')).toBe('Na^+')
    expect(foldSupSub('10^±3')).toBe('10^±3')
  })

  it('keeps a marker that starts a run — nothing precedes it to fuse with', () => {
    expect(foldSupSub('_foo')).toBe('_foo')
    expect(foldSupSub('_2')).toBe('_2')
    expect(foldSupSub('^[note 1]')).toBe('^[note 1]')
  })

  it('keeps a marker the converter cannot have written in that position', () => {
    expect(foldSupSub('a ^ b')).toBe('a ^ b') // spaced: an operator, not a marker
    expect(foldSupSub('a^®')).toBe('a^®') // `®` is neither \p{L} nor \p{N}
    expect(foldSupSub('Rest^')).toBe('Rest^') // a caret at the very end of the text
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

  it('folds every shape `shouldMark` admits, except the sign-suffixed ones', () => {
    // The emitted shapes are a subset of the folded shapes by construction — this pins that
    // relation rather than trusting the two regexes to be read together.
    for (const [prev, next] of [
      ['m', '2'],
      ['0', '6'],
      ['O', 'x'],
      ['K', 'S']
    ] as const) {
      expect(shouldMark(prev, next)).toBe(true)
      expect(foldSupSub(`${prev}${SUP_MARK}${next}`)).toBe(`${prev}${next}`)
      expect(foldSupSub(`${prev}${SUB_MARK}${next}`)).toBe(`${prev}${next}`)
    }
    // The one exception, and why it is harmless: the sign has split the alphanumeric run
    // already, so the surviving marker can move no term.
    expect(shouldMark('0', '−')).toBe(true)
    expect(foldSupSub(`10${SUP_MARK}−6`)).toBe('10^−6')
  })

  it('shares one predicate for the <sup> kind both converter paths drop', () => {
    expect(REF_SUP_CLASS_RE.test('mw-ref reference')).toBe(true)
    expect(REF_SUP_CLASS_RE.test('reference')).toBe(true)
    expect(REF_SUP_CLASS_RE.test('noref')).toBe(false)
    expect(REF_SUP_CLASS_RE.global).toBe(false) // stateless: no lastIndex to carry between tags
  })
})
