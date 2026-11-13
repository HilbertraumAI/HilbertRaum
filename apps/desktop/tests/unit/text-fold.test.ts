import { describe, expect, it } from 'vitest'
import { foldCase } from '../../src/renderer/lib/textFold'

// The shared case fold of the text filters (Documents name filter, AI Model search, review evidence
// filter; second UI-languages wave owner call G-5, 2026-11-13). The Turkish letters are built from code
// points so no editor or shell can swap them for their ASCII look-alikes.
const DOTLESS_I = String.fromCharCode(0x0131) // ı
const DOTTED_CAPITAL_I = String.fromCharCode(0x0130) // İ

/** The filters' match: a substring of the folded text, both sides folded. */
const finds = (text: string, query: string): boolean => foldCase(text).includes(foldCase(query))

describe('foldCase — the shared fold of the text filters', () => {
  // All four fold to the same letter, so each matches each of the others in both directions.
  it.each(['I', 'i', DOTLESS_I, DOTTED_CAPITAL_I])('%s folds to a plain "i"', (letter) => {
    expect(foldCase(letter)).toBe('i')
  })

  it.each([
    ['Invoice 2026-03.pdf', 'inv'],
    ['ISI raporu.pdf', `${DOTLESS_I}s${DOTLESS_I}`],
    [`${DOTTED_CAPITAL_I}STANBUL ofisi`, 'istanbul'],
    ['istanbul ofisi', `${DOTTED_CAPITAL_I}STANBUL`],
    // "İ" lowers to "i" + U+0307 without the fold, so a prefix of a mixed-case word missed.
    [`${DOTTED_CAPITAL_I}stanbul ofisi`, 'ist']
  ])('"%s" is found by a typed "%s"', (text, query) => {
    expect(finds(text, query)).toBe(true)
  })

  it('folds English and German text exactly as before (no accent stripping)', () => {
    expect(foldCase('Q3 Audit Notes.DOCX')).toBe('q3 audit notes.docx')
    expect(foldCase('Mietvertrag ÜBER Straße – Größe')).toBe('mietvertrag über straße – größe')
    expect(finds('Größe.pdf', 'grosse')).toBe(false)
  })

  it('returns text with no I letter and no capital unchanged', () => {
    const text = 'café-crème, résumé 2026.txt'
    expect(foldCase(text)).toBe(text)
  })
})
