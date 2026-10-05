import { describe, it, expect } from 'vitest'
import {
  MONEY_RE,
  blankDateTokens,
  parseAmount,
  detectCurrency,
  detectDocumentCurrency,
  hasMoneyToken,
  lastCurrencyAdjacentInteger,
  inferDateAnchor,
  inferDateOrder,
  inferDateOrderResult,
  normalizeExtractionText,
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

// R1 (skills-remediation, audit §5.3) — the shared Unicode normalization pre-pass, tested in isolation.
// It maps three classes to ASCII (minus-like dashes → '-', no-break-space family → ' ', U+2019 → "'"),
// is a NO-OP for ASCII, and is IDEMPOTENT — every extractor entry point depends on those three properties.
describe('money.ts — normalizeExtractionText (audit §5.3)', () => {
  it.each([
    ['U+2212 MINUS SIGN \u2192 hyphen', '\u2212', '-'],
    ['U+2013 EN DASH \u2192 hyphen', '\u2013', '-'],
    ['U+2011 NON-BREAKING HYPHEN \u2192 hyphen', '\u2011', '-'],
    ['U+00A0 NBSP \u2192 space', '\u00A0', ' '],
    ['U+202F NARROW NBSP \u2192 space', '\u202F', ' '],
    ['U+2007 FIGURE SPACE \u2192 space', '\u2007', ' '],
    ['U+2019 RIGHT SINGLE QUOTE \u2192 apostrophe', '\u2019', "'"]
  ])('maps %s', (_label, input, expected) => {
    expect(normalizeExtractionText(input)).toBe(expected)
  })

  it('is a no-op for ASCII text (byte-identical — no behavior change for ASCII fixtures)', () => {
    const ascii = '2026-01-02 Grocery Store -45,90 1.954,10\nGross Total 390,00 EUR'
    expect(normalizeExtractionText(ascii)).toBe(ascii)
  })

  it('is idempotent (applying twice equals applying once)', () => {
    const dirty = 'Betrag \u22121\u00A0234,56 EUR und 1\u2019000.00 CHF' // minus + NBSP group + Swiss apostrophe
    const once = normalizeExtractionText(dirty)
    expect(normalizeExtractionText(once)).toBe(once)
    expect(once).toBe("Betrag -1 234,56 EUR und 1'000.00 CHF")
  })

  it('makes MONEY_RE / parseAmount read the normalized figure correctly (the load-bearing effect)', () => {
    // A U+2212 debit keeps its sign; an NBSP group reads its full magnitude; a Swiss U+2019 group parses.
    expect(parseAmount(normalizeExtractionText('\u221245,90'))).toBe(-45.9)
    const nbsp = normalizeExtractionText('1\u00A0234,56')
    expect(parseAmount([...nbsp.matchAll(MONEY_RE)][0][0])).toBe(1234.56)
    expect(parseAmount(normalizeExtractionText('1\u2019234.56'))).toBe(1234.56)
  })
})

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
    ['single comma + 3 digits ⇒ thousands, not decimal', '1,234', 1234],
    ['space-grouped thousands + decimal', '1 234 567,89', 1234567.89],
    ['not a number', 'abc', null],
    ['empty', '   ', null]
  ])('parseAmount(%s)', (_label, input, expected) => {
    expect(parseAmount(input)).toBe(expected)
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

// T-1 (invoice-skills-audit-2026-07-06, IA-2) — the LEADING sign is read ONLY when GLUED to the figure/
// paren, the mirror of the trailing-side BL-1 fix. A dash separated from the amount by whitespace (a
// dash-as-separator layout, or a Word en-dash the R1 pre-pass mapped to `-`) is TEXT, not a sign — so it
// no longer flips a positive figure negative on the plain path, and the plain path now agrees with the
// geometry path (which already refused a far dash as a sign). MONEY_RE is SHARED with the bank extractor.
describe('money.ts — MONEY_RE leading-sign glue gate (T-1)', () => {
  // The signed value of the FIRST money token on a (R1-normalized) line, or null.
  const firstMoney = (s: string): number | null => {
    const m = normalizeExtractionText(s).match(MONEY_RE)
    return m ? parseAmount(m[0]) : null
  }

  it('a SPACED leading dash is a separator, not a sign ⇒ POSITIVE (plain path)', () => {
    expect(firstMoney('Beratung – 1.500,00 EUR')).toBe(1500) // Word en-dash → '-' via the R1 pre-pass
    expect(firstMoney('GUTSCHRIFT - 34,39')).toBe(34.39) // an ASCII dash-separated credit reads +34,39
    // The geometry path (pdf-layout.test.ts) agrees: `LASTSCHRIFT - 3,99` stays positive there too.
    expect(firstMoney('LASTSCHRIFT - 3,99')).toBe(3.99)
  })

  it('a GLUED leading dash is still the negative sign', () => {
    expect(firstMoney('-1.500,00')).toBe(-1500)
    expect(firstMoney('Saldo -45,90')).toBe(-45.9)
  })

  it('the parens-negative form is unchanged (an open paren keeps its \\s{0,4} gap)', () => {
    expect(firstMoney('( 914,00 )')).toBe(-914)
    expect(firstMoney('(914,00)')).toBe(-914)
  })

  it('the integer fallback mirrors the gate: a spaced dash is text (+914), a glued dash signs (−914)', () => {
    // `lastCurrencyAdjacentInteger` is the bare-integer path (a round total printed with no decimal).
    // (The parens-negative form rides the MONEY_RE decimal path — `( 914,00 )` above; a bare `( 914 )`
    // has no currency ADJACENT to the integer, so the fallback correctly never reads it, old and new.)
    expect(lastCurrencyAdjacentInteger('Gesamt - 914 EUR')).toBe(914) // spaced dash → positive (was −914)
    expect(lastCurrencyAdjacentInteger('Gesamt -914 EUR')).toBe(-914) // glued → still negative
    expect(lastCurrencyAdjacentInteger('Gesamtbetrag €914')).toBe(914) // symbol-adjacent, positive
    expect(lastCurrencyAdjacentInteger('Betrag $914-')).toBe(-914) // symbol + trailing glued minus signs
  })
})

describe('money.ts — detectCurrency / detectDocumentCurrency', () => {
  it.each([
    ['an allowlisted code', 'Total EUR 100,00', 'EUR'],
    ['a currency symbol', 'Saldo €100,00', 'EUR'],
    ['a dollar sign', '$50.00', 'USD'],
    ['a random 3-letter word is not a code', 'THE CAT SAT', null],
    ['a non-currency 3-letter token does not block a later code', 'Rechnung INV-2026 Betrag EUR 100,00', 'EUR']
  ])('detectCurrency(%s)', (_label, input, expected) => {
    expect(detectCurrency(input)).toBe(expected)
  })

  it.each([
    ['figure-adjacent foreign code wins', 'Hotel -120,00 USD 880,00', 'USD'],
    ['majority over voting lines', 'A 100,00 USD\nB 50,00 USD\nNote EUR', 'USD'],
    ['tie broken by first appearance', 'Saldo 100,00 EUR\nPay in USD or CHF', 'EUR'],
    ['a code LEFT of the amount (a memo) does not vote; a header does', 'USD Memo -12,00 100,00\nWährung EUR', 'EUR'],
    [
      'a date-led memo line: the code LEFT of the amount still never votes',
      'Kontoauszug\n02.01.2026 USD Memo -12,00 100,00\nWährung EUR',
      'EUR'
    ],
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

  // `inferred` is 'default' when the day-first guess was applied with NO evidence (caveat-worthy) and
  // 'evidence' when a field > 12 (or an ISO-only document) fixed the order. Dates must LEAD their money
  // rows to vote — the booking-column scope (FIN-4).
  it.each<[string, string, { order?: string; inferred?: string }]>([
    [
      'all-ambiguous leading dates ⇒ day-first with NO evidence',
      '03.05.2026 Grocery -45,90\n04.06.2026 Salary 2.500,00',
      { order: 'dmy', inferred: 'default' }
    ],
    [
      'an unambiguous leading date (a field > 12) ⇒ evidence',
      '31.01.2026 Grocery -45,90\n15.02.2026 Salary 2.500,00',
      { inferred: 'evidence' }
    ],
    ['a US mm/dd/yyyy leading date ⇒ month-first evidence', '12/31/2026 Grocery -45,90', { order: 'mdy', inferred: 'evidence' }],
    ['ISO-only dates ⇒ the guess is moot, never a spurious caveat', '2026-03-05 Coffee -3,50 100,00', { inferred: 'evidence' }],
    [
      'ambiguous dd.mm.yy rows also drive the flag (R5)',
      '03.05.26 Grocery -45,90\n04.06.26 Salary 2.500,00',
      { inferred: 'default' }
    ],
    ['a bare de-AT day > 12 date is day-first evidence', '28.12. Miete -900,00', { order: 'dmy', inferred: 'evidence' }],
    ['a US mm/dd/yy row (second field > 12) is month-first', '12/31/26 Grocery -45,90', { order: 'mdy' }],
    // T-6 (invoice-audit-2026-07-06): raw MONEY_RE read `Datum: 05.03.2026` as a transaction row (its
    // `05.03` fragment matches) whose leading `Datum:` is not a date, so it never voted and a day-first-
    // GUESSED document silently missed the caveat. Classifying by date-scrubbed `hasMoneyToken` sends the
    // money-less date line to the header branch, where its ambiguous date votes and flags 'default'.
    ['T-6: a money-less dotted header date votes ⇒ default', 'Datum: 05.03.2026', { inferred: 'default' }],
    // A money-less DOTTED period header now VOTES (BANK_EXTRACTOR_VERSION bumped): its unambiguous 03.31
    // (second field 31) forces month-first; before T-6 it was a voteless transaction row (→ default dmy).
    ['T-6: a money-less dotted period header votes', 'Statement period 03.31.2026 - 04.15.2026', { order: 'mdy' }]
  ])('inferDateOrderResult(%s)', (_label, input, expected) => {
    expect(inferDateOrderResult(input)).toMatchObject(expected)
  })

  it.each<[string, string, string | undefined, { year: number; month: number } | undefined, string | null]>([
    ['ISO passes through', '2026-01-31', undefined, undefined, '2026-01-31'],
    ['day-first dotted is the default order', '31.01.2026', undefined, undefined, '2026-01-31'],
    ['day-first slashed is the default order', '31/01/2026', undefined, undefined, '2026-01-31'],
    ['order dmy', '05/03/2026', 'dmy', undefined, '2026-03-05'],
    ['order mdy', '05/03/2026', 'mdy', undefined, '2026-05-03'],
    ['month 13 is rejected', '2026-13-01', undefined, undefined, null],
    ['Feb 31 is rejected', '31.02.2026', undefined, undefined, null],
    ['a 2-digit year without an anchor is rejected', '31.01.26', undefined, undefined, null],
    ['garbage is rejected', 'not-a-date', undefined, undefined, null],
    // R5: anchor-gated 2-digit-year / bare completion + cross-year rollover. No anchor ⇒ dropped, never guessed.
    ['a bare dd.mm. without an anchor is dropped', '28.12.', undefined, undefined, null],
    ['2-digit year ⇒ the anchor century window', '05.01.26', 'dmy', { year: 2026, month: 1 }, '2026-01-05'],
    ['2-digit year across the century window', '05.01.99', 'dmy', { year: 1998, month: 1 }, '1999-01-05'],
    ['a bare date takes the anchor year', '15.06.', 'dmy', { year: 2026, month: 6 }, '2026-06-15'],
    ['a December row on a January statement is the PREVIOUS year', '28.12.', 'dmy', { year: 2026, month: 1 }, '2025-12-28'],
    ['a January row on a December statement is the NEXT year', '03.01.', 'dmy', { year: 2025, month: 12 }, '2026-01-03'],
    ['a 2-digit-year date is NOT rolled (its year is explicit)', '28.12.25', 'dmy', { year: 2026, month: 1 }, '2025-12-28'],
    ['a bare decimal (no second separator) is never a date', '28.12', 'dmy', { year: 2026, month: 1 }, null],
    ['mdy anchor path: US 2-digit year completes month-first', '01.05.26', 'mdy', { year: 2026, month: 1 }, '2026-01-05']
  ])('parseDate(%s)', (_label, input, order, anchor, expected) => {
    expect(parseDate(input, order as 'dmy' | 'mdy' | undefined, anchor)).toBe(expected)
  })

  it.each<[string, string, 'dmy' | 'mdy' | undefined, { year: number; month: number } | null]>([
    [
      'the first fully-printed year+month wins',
      'Kontoauszug Zeitraum 05.01.2026 - 31.01.2026\n28.12. Miete -900,00',
      undefined,
      { year: 2026, month: 1 }
    ],
    ['order-aware: a US mm/dd/yyyy anchor reads month-first', 'Invoice date 03/15/2026', 'mdy', { year: 2026, month: 3 }],
    [
      'no fully-printed 4-digit-year date ⇒ no anchor (a grouped amount is never mistaken for one)',
      '28.12. Miete -900,00 2.500,00\n05.01. Gehalt 1.234,56',
      undefined,
      null
    ]
  ])('inferDateAnchor(%s)', (_label, text, order, expected) => {
    expect(inferDateAnchor(text, order)).toEqual(expected)
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
    expect(stripDateTokens('30.06.2026 Endsaldo 1.234,56 EUR')).not.toContain('30.06.2026') // leading
    expect(stripDateTokens('30.06.2026 Endsaldo 1.234,56 EUR')).toContain('1.234,56')
    // A grouped figure is NOT a date token, so scrubbing never eats a real amount.
    expect(stripDateTokens('Kontostand 35.037,04')).toContain('35.037,04')
  })

  it('stripDateTokens scrubs a 2-digit-year dd.mm.yy date (SKA-2) — money-shaped to MONEY_RE, invisible before', () => {
    // The R5 first-class cohort: `31.03.26` reads 3103.26 through MONEY_RE, so the un-scrubbed balance/
    // totals readers took the DATE as the figure. The widened scrub removes it while the guards keep every
    // real amount intact.
    expect(stripDateTokens('Endsaldo 1.234,56 EUR per 31.03.26')).not.toContain('31.03.26')
    expect(stripDateTokens('Endsaldo 1.234,56 EUR per 31.03.26')).toContain('1.234,56')
    expect(stripDateTokens('Gesamtbetrag 390,00 EUR per 30.06.26')).toContain('390,00')
    expect(stripDateTokens('Datum: 15.03.26')).not.toContain('15.03.26')
    // The guards (SKA-2): `\b` refuses a mid-digit start, `(?![\d.,'])` refuses a "year" that continues —
    // so grouped/apostrophe/space-grouped amounts are never eaten…
    expect(stripDateTokens('Kontostand 35.037,04')).toContain('35.037,04')
    expect(stripDateTokens('Betrag 1.234,56')).toContain('1.234,56')
    expect(stripDateTokens("Saldo 1'234.56")).toContain("1'234.56")
    expect(stripDateTokens('Gruppe 1.234.567')).toContain('1.234.567')
    // …and a 4-digit-year date is consumed WHOLE (the 2-digit branch cannot bite off `01.04.20`).
    expect(stripDateTokens('per 01.04.2026 Ende')).toBe('per   Ende')
  })

  it('blankDateTokens is SAME-LENGTH (byte offsets preserved) — the SKA-1 row-scan copy', () => {
    const line = 'bis 30.04.2026 dann 31.03.26 Ende 1.234,56'
    const blanked = blankDateTokens(line)
    expect(blanked.length).toBe(line.length) // offsets into the original line stay valid
    expect(blanked).not.toContain('30.04.2026')
    expect(blanked).not.toContain('31.03.26')
    expect(blanked.indexOf('1.234,56')).toBe(line.indexOf('1.234,56')) // real figures untouched, same offset
    expect(blanked.replace(/\s+/g, ' ').trim()).toBe('bis dann Ende 1.234,56')
  })

  it('hasMoneyToken: a money-less dd.mm.yy period line is NOT money-bearing (SKA-2 droppedRowCount fix)', () => {
    expect(hasMoneyToken('01.04.26 bis 30.04.26')).toBe(false)
    expect(hasMoneyToken('15.03.26 bis 31.03.26 Zinsperiode')).toBe(false)
    expect(hasMoneyToken('Zeitraum 01.04.2026 bis 30.04.2026')).toBe(false)
    expect(hasMoneyToken('15.03.26 Zinsen 1,25')).toBe(true) // a real figure still counts
  })

  it('a PUNCTUATION-trailed dd.mm.yy still scrubs (R7 review): terminal `.`/`,` is not a continuation', () => {
    // A plain `(?![\d.,'])` lookahead treated sentence punctuation as a money continuation and left the
    // date in place — un-fixing SKA-2 on `per 31.03.26.` / mid-sentence `vom 15.03.26, …` shapes.
    expect(stripDateTokens('Endsaldo 1.234,56 EUR per 31.03.26.')).not.toContain('31.03.26')
    expect(stripDateTokens('Gesamtbetrag 390,00 EUR per 30.06.26,')).not.toContain('30.06.26')
    expect(stripDateTokens('Leistung vom 15.03.26, Pauschale 100,00')).not.toContain('15.03.26')
    // …while a separator FOLLOWED BY A DIGIT is still a continuation and stays unscrubbed:
    expect(stripDateTokens('Betrag 31.03.26,50')).toContain('31.03.26,50') // ambiguous money-ish tail
    expect(stripDateTokens("Konto 26'000 Stand 31.03.26'000")).toContain("31.03.26'000") // Swiss grouping
    expect(stripDateTokens('Version 1.2.26.5 Build')).toContain('1.2.26.5') // dotted version/section code
  })

  it('detectDocumentCurrency: a code IMMEDIATELY left of the first figure votes (R7 review — the per-row currency-cell layout)', () => {
    // The SKA-2 scrub widening removed dd.mm.yy lines' accidental vote (the date used to be the first
    // "money" match, so the region started left of the code); adjacency restores it deliberately.
    expect(detectDocumentCurrency('15.06.26 REWE Markt EUR 19,15-')).toBe('EUR')
    expect(detectDocumentCurrency('01.06.2026 Miete EUR 850,00-')).toBe('EUR') // fixes the 4-digit twin too
    // The FIN-1 memo exclusion is untouched: a code NOT adjacent to the figure still never votes.
    expect(detectDocumentCurrency('USD Memo -12,00 100,00\nWährung EUR')).toBe('EUR')
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
    ['formula lead + ⇒ prefixed', '+1+2', "'+1+2"],
    ['formula lead - WITH a comma ⇒ prefixed AND quoted', '-leading minus, with comma', `"'-leading minus, with comma"`],
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
