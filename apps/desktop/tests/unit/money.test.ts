import { describe, it, expect } from 'vitest'
import {
  MONEY_RE,
  parseAmount,
  detectCurrency,
  detectDocumentCurrency,
  inferDateOrder,
  parseDate,
  splitLeadingDates,
  stripDateTokens,
  wordIncludes,
  csvField
} from '../../src/main/services/skills/tools/money'

// full-audit-2026-06-30 testing gap T4 — the shared money/date/CSV primitives (`tools/money.ts`) were
// exercised only through whole-string extractor fixtures, so a regex/parser BOUNDARY cell (apostrophe +
// decimal, csvField formula-lead × quote × CRLF, wordIncludes(compound) with a repeated needle) could
// break while every integration fixture still passed. These are cheap, OFFLINE, pure-function table
// tests of those primitives in ISOLATION — they sit BESIDE the integration suite, not replace it.

describe('money.ts — parseAmount (boundary cells)', () => {
  it.each([
    ['US thousands + decimal', '1,234.56', 1234.56],
    ['German thousands + decimal', '1.234,56', 1234.56],
    ["Swiss apostrophe + decimal", "1'234.56", 1234.56], // the named T4 cell — apostrophe grouping
    ['leading minus', '-12.00', -12],
    ['glued trailing minus (de-AT debit)', '12,00-', -12],
    ['parentheses-negative', '(45.00)', -45],
    ['single sep + 3 digits ⇒ thousands', '1.000', 1000],
    ['single sep + 2 digits ⇒ decimal', '12,50', 12.5],
    ['>2-dp both-separator rounds to the cent (T5)', '1.234,567', 1234.57],
    ['apostrophe thousands, no decimal', "1'234", 1234],
    ['not a number', 'abc', null],
    ['empty', '   ', null]
  ])('parseAmount(%s)', (_label, input, expected) => {
    expect(parseAmount(input)).toBe(expected)
  })

  it('every parsed figure is exactly 2-dp (the integer-cent invariant)', () => {
    for (const raw of ['1.234,567', '0,005', '99,994', '1 234 567,89']) {
      const v = parseAmount(raw)
      if (v !== null) expect(v).toBe(Math.round(v * 100) / 100)
    }
  })
})

describe('money.ts — MONEY_RE (token boundary cells)', () => {
  // MONEY_RE can legitimately capture optional leading whitespace (the `\s{0,4}` after the empty sign
  // group) — harmless because `parseAmount` trims; trim here so the assertions pin the TOKEN boundary.
  const tokens = (s: string): string[] => (s.match(MONEY_RE) ?? []).map((t) => t.trim())

  it('matches an apostrophe-grouped decimal whole, both groups on a CHF line', () => {
    expect(tokens("Zahlung 1'234.56 9'999.00")).toEqual(["1'234.56", "9'999.00"])
  })

  it('matches a bare grouped integer (de-AT thousands) with no decimal tail', () => {
    expect(tokens('Miete 1.000 9.000')).toEqual(['1.000', '9.000'])
  })

  it('does NOT treat a plain ungrouped integer (a reference/year) as a money token', () => {
    expect(tokens('Auftrag 2026 Ref')).toEqual([]) // no separator-grouping, no 2-dp tail
  })

  it('does not start a token in the MIDDLE of a longer digit run (the continuation anchor)', () => {
    // `778899 300,00`: the space-grouped form must not fuse the 3-digit tail `899` with `300,00`.
    expect(tokens('Auftrag 778899 300,00')).toEqual(['300,00'])
  })
})

describe('money.ts — detectCurrency / detectDocumentCurrency', () => {
  it('detectCurrency reads an allowlisted code or symbol, ignores a random 3-letter word', () => {
    expect(detectCurrency('Total EUR 100,00')).toBe('EUR')
    expect(detectCurrency('Saldo €100,00')).toBe('EUR')
    expect(detectCurrency('$50.00')).toBe('USD')
    expect(detectCurrency('THE CAT SAT')).toBeNull()
  })

  it.each([
    ['figure-adjacent foreign code wins', 'Hotel -120,00 USD 880,00', 'USD'],
    ['majority over voting lines', 'A 100,00 USD\nB 50,00 USD\nNote EUR', 'USD'],
    ['tie broken by first appearance', 'Saldo 100,00 EUR\nPay in USD or CHF', 'EUR'],
    ['a code LEFT of the amount (a memo) does not vote; a header does', 'USD Memo -12,00 100,00\nWährung EUR', 'EUR'],
    ['no code in any voting region ⇒ null', 'No money here\nJust prose', null]
  ])('detectDocumentCurrency(%s)', (_label, input, expected) => {
    expect(detectDocumentCurrency(input)).toBe(expected)
  })
})

describe('money.ts — inferDateOrder / parseDate / splitLeadingDates / stripDateTokens', () => {
  it.each([
    ['leading unambiguous US date ⇒ mdy', '12/31/2026 fee -5,00 95,00', 'mdy'],
    ['leading unambiguous EU date ⇒ dmy', '31/12/2026 fee -5,00 95,00', 'dmy'],
    ['fully ambiguous ⇒ day-first default', '03/05/2026 x -1,00 9,00', 'dmy'],
    ['empty ⇒ day-first default', '', 'dmy']
  ])('inferDateOrder(%s)', (_label, input, expected) => {
    expect(inferDateOrder(input)).toBe(expected)
  })

  it('parseDate honours the order parameter and rejects 2-digit years / impossible dates', () => {
    expect(parseDate('2026-01-31')).toBe('2026-01-31')
    expect(parseDate('05/03/2026', 'dmy')).toBe('2026-03-05')
    expect(parseDate('05/03/2026', 'mdy')).toBe('2026-05-03')
    expect(parseDate('31.02.2026')).toBeNull() // Feb 31
    expect(parseDate('31.01.26')).toBeNull() // 2-digit year
  })

  it('splitLeadingDates consumes the leading date run (capped at 2), leaving the rest', () => {
    expect(splitLeadingDates('06.06.2026 07.06.2026 Supermarkt -45,90')).toEqual({
      dates: ['2026-06-06', '2026-06-07'],
      rest: 'Supermarkt -45,90'
    })
    // A single leading date, then a non-date token → stops at the description.
    expect(splitLeadingDates('2026-01-02 Coffee -3,50')).toEqual({ dates: ['2026-01-02'], rest: 'Coffee -3,50' })
    expect(splitLeadingDates('No leading date here').dates).toEqual([])
  })

  it('stripDateTokens removes a date at EITHER end, so the money scan reads the figure', () => {
    expect(stripDateTokens('Endsaldo 1.234,56 EUR per 30.06.2026')).not.toContain('30.06.2026')
    // A grouped figure is NOT a date token, so scrubbing never eats a real amount.
    expect(stripDateTokens('Kontostand 35.037,04')).toContain('35.037,04')
  })
})

describe('money.ts — wordIncludes (strict vs compound, repeated needle)', () => {
  it('STRICT requires both sides bounded — a coincidental substring does not match', () => {
    expect(wordIncludes('coffee shop', 'fee')).toBe(false) // fee ⊂ coffee
    expect(wordIncludes('a fee here', 'fee')).toBe(true) // standalone word
  })

  it('STRICT scans EVERY occurrence — a repeated needle matches only on a standalone hit', () => {
    expect(wordIncludes('feefeefee', 'fee')).toBe(false) // all internal, none standalone
    expect(wordIncludes('feefeefee fee', 'fee')).toBe(true) // the trailing standalone matches
  })

  it('COMPOUND accepts a one-sided boundary (German closed compound) but rejects a both-sides-buried needle', () => {
    expect(wordIncludes('kontoführungsgebühr', 'gebühr', true)).toBe(true) // edge on the right
    expect(wordIncludes('gebührenfrei', 'gebühr', true)).toBe(true) // edge on the left
    expect(wordIncludes('xgebührx', 'gebühr', true)).toBe(false) // letters on BOTH sides
  })
})

describe('money.ts — csvField (formula-injection neutralization × quoting)', () => {
  it.each([
    ['plain text untouched', 'hello', 'hello'],
    ['comma ⇒ quoted', 'a,b', '"a,b"'],
    ['double-quote ⇒ doubled + quoted', 'a"b', '"a""b"'],
    ['formula lead = ⇒ prefixed (no comma ⇒ unquoted)', '=cmd', "'=cmd"],
    ['formula lead @ ⇒ prefixed', '@cmd', "'@cmd"],
    ['leading-whitespace formula ⇒ prefixed before the spaces', '  =1+1', "'  =1+1"],
    ['leading tab control char ⇒ prefixed', '\t@x', "'\t@x"],
    ['formula lead WITH a comma ⇒ prefixed AND quoted', '=a,b', '"\'=a,b"']
  ])('csvField(%s)', (_label, input, expected) => {
    expect(csvField(input)).toBe(expected)
  })

  it('formula-lead × quote × CRLF together: prefixed, quotes doubled, whole field quoted', () => {
    expect(csvField('=a"b\r\nc')).toBe('"\'=a""b\r\nc"')
  })
})
