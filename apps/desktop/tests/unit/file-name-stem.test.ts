import { describe, it, expect } from 'vitest'
import { fileNameStem } from '../../src/main/services/text'

// #899: the one rule every suggested export name goes through (chat transcript, document text, original and
// summary, evidence pack). Five copies of a slug used to strip combining marks (`\p{M}` is not `\p{L}`), so a
// vowel sign, an accent typed as a separate mark or a decomposed (NFD) title lost letters, and four of them cut at
// 60 UTF-16 units and trimmed before the cut. This table owns the rule; the IPC suites only pin that each site uses
// it. Invisible or decomposed input is written as `\u` escapes so the row shows what it feeds in.
// No Indic conjunct row crosses the cut: ICU's grapheme rules for conjuncts (GB9c, Unicode 15.1) differ by version.

const A59 = 'a'.repeat(59)
const chat = (title: string): string => fileNameStem(title, { fallback: 'chat' })
const doc = (title: string): string => fileNameStem(title, { fallback: 'document', keepParens: true })

describe('fileNameStem (#899)', () => {
  it.each([
    // The issue's table: marks inside a word are kept, a decomposed title is composed (NFC) first.
    { name: 'Hindi vowel signs and virama', title: 'हिन्दी', want: 'हिन्दी' },
    { name: 'Tamil vowel signs and virama', title: 'தமிழ்', want: 'தமிழ்' },
    { name: 'Thai vowel marks', title: 'สวัสดี', want: 'สวัสดี' },
    { name: 'Hebrew vowel points', title: 'עִבְרִית', want: 'עִבְרִית' },
    { name: 'German, decomposed', title: 'Pru\u0308fung', want: 'Pr\u00fcfung' },
    { name: 'Vietnamese, decomposed (two marks on one letter)', title: 'Tie\u0302\u0301ng Vie\u0323\u0302t', want: 'Ti\u1ebfng Vi\u1ec7t' },
    { name: 'German, composed, unchanged', title: 'Pr\u00fcfung', want: 'Pr\u00fcfung' },
    { name: 'Bengali vowel signs and anusvara', title: 'বাংলা', want: 'বাংলা' },
    // Decomposed dakuten would read カキク, a different word, if only the marks went.
    { name: 'Japanese dakuten, decomposed', title: '\u30ab\u3099\u30ad\u3099\u30af\u3099', want: '\u30ac\u30ae\u30b0' }
  ])('keeps the marks of a word: $name', ({ title, want }) => {
    expect(chat(title)).toBe(want)
  })

  it('cuts at 60 code points without splitting an astral letter into a lone surrogate', () => {
    const stem = chat(`${A59}\u{20000}x`) // U+20000 (CJK Ext-B) is a letter of two UTF-16 units
    expect(stem).toBe(`${A59}\u{20000}`)
    expect(/\p{Surrogate}/u.test(stem)).toBe(false)
  })

  it('cuts only between whole characters: a vowel sign that would be the 61st code point takes its letter with it', () => {
    // KA (U+0915) + vowel sign I (U+093F) is one character at code points 60-61: keeping KA alone misspells it.
    expect(chat(`${A59}\u0915\u093fzz`)).toBe(A59)
  })

  it('leaves no space before the extension when the cut lands on a space', () => {
    expect(chat(`${A59} Clause 7`)).toBe(A59)
  })

  it.each([
    { name: 'punctuation only', title: '???', keepParens: false, want: 'chat' },
    { name: 'parentheses and spaces only (document exports)', title: ' ( ) ', keepParens: true, want: 'document' },
    { name: 'combining marks only', title: '\u0301\u0301', keepParens: false, want: 'chat' }
  ])('falls back when no letter or number is left: $name', ({ title, keepParens, want }) => {
    expect(keepParens ? doc(title) : chat(title)).toBe(want)
  })

  it('drops a mark whose letter is gone: an emoji variation selector, a leading accent', () => {
    expect(chat('\u263a\ufe0e smile')).toBe('smile') // U+FE0E is a mark; its emoji is stripped, so it goes too
    expect(chat('\u0301abc')).toBe('abc')
  })

  it('keeps the marks of a character whose base is a number or letter: a keycap, the information sign', () => {
    // 1 + VS16 + combining enclosing keycap: the base is a number, so both marks stay with it.
    expect(chat('\u0031\ufe0f\u20e3 step')).toBe('\u0031\ufe0f\u20e3 step')
    // U+2139 INFORMATION SOURCE is a letter, so its VS16 stays too.
    expect(chat('\u2139\ufe0f info')).toBe('\u2139\ufe0f info')
  })

  it('composes the finished name again: a dropped joiner can leave a letter and a mark that compose', () => {
    // e + ZWJ + combining acute is one character; the ZWJ (a format character) goes, leaving e + U+0301 = é.
    expect(chat('e\u200d\u0301')).toBe('\u00e9')
  })

  it('skips leading spaces', () => {
    expect(chat('  a')).toBe('a')
  })

  it('keeps ( and ) only when asked (the document exports)', () => {
    expect(doc('doc (Deutsch)')).toBe('doc (Deutsch)')
    expect(chat('doc (Deutsch)')).toBe('doc Deutsch')
  })

  it('stays bounded on a letter carrying more marks than the cap (one character of 81 code points)', () => {
    expect(chat(`a${'\u0301'.repeat(80)}`)).toBe('chat')
  })

  it('appends _ to a Windows device name, and leaves a longer name alone', () => {
    expect(chat('Con')).toBe('Con_')
    expect(chat('nul')).toBe('nul_') // Dutch for zero: a plausible chat title
    expect(chat('COM\u00b9')).toBe('COM\u00b9_') // a superscript digit is a number, and Windows reserves COM¹
    expect(chat('COM0')).toBe('COM0_')
    expect(chat('lpt0')).toBe('lpt0_')
    expect(doc('con (2)')).toBe('con (2)')
  })
})
