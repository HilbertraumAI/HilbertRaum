import { describe, it, expect } from 'vitest'
import {
  clusterRows,
  detectDatumColumn,
  reconstructLine,
  reconstructPage,
  resolvePageYear,
  toFullDate,
  DEFAULT_ROW_TOLERANCE,
  DEFAULT_COLUMN_GAP,
  type LayoutWord
} from '../../src/main/services/ingestion/parsers/pdf-layout'
import { parseDate } from '../../src/main/services/skills/tools/money'
import { extractTransactionRows } from '../../src/main/services/skills/tools/bank-statement'

// PDF geometry-extraction plan §3.1 / §6, Stage 1 — the deterministic geometry reconstruction proven on
// positioned word boxes (no real PDF needed here; the integration test drives a real PDF). The central
// guarantees: visual rows rebuilt from y, columns separated by token class, the page-header YEAR emitted
// as a full DD.MM.YYYY date the UNCHANGED `parseDate` already accepts (§3.2), and a value-date column
// never mistaken for the amount.

function word(str: string, x: number, y: number, w = 10): LayoutWord {
  return { str, x, y, w }
}

describe('clusterRows', () => {
  it('groups words by baseline y (within tolerance), top-to-bottom, each row left-to-right', () => {
    const words: LayoutWord[] = [
      word('amount', 400, 700),
      word('Date', 50, 750),
      word('desc', 130, 700.5), // same row as amount (within tolerance)
      word('Header', 50, 800),
      word('date', 50, 700)
    ]
    const rows = clusterRows(words, 3)
    // Three visual rows, ordered by descending y (800, 750, 700-band).
    expect(rows.map((r) => r.map((w) => w.str))).toEqual([
      ['Header'],
      ['Date'],
      ['date', 'desc', 'amount'] // left-to-right by x within the 700-band
    ])
  })

  it('splits rows that differ by more than the tolerance', () => {
    const rows = clusterRows([word('a', 0, 700), word('b', 0, 690)], 3)
    expect(rows).toHaveLength(2)
  })

  it('skips words with non-finite coordinates', () => {
    const rows = clusterRows([word('a', 0, 700), word('bad', Number.NaN, 700)], 3)
    expect(rows.flat().map((w) => w.str)).toEqual(['a'])
  })
})

describe('toFullDate (year resolution → full DD.MM.YYYY that parseDate accepts)', () => {
  it('completes a bare day.month with the page year', () => {
    const full = toFullDate('31.12.', 2024)
    expect(full).toBe('31.12.2024')
    expect(parseDate(full!)).toBe('2024-12-31') // parseDate is UNCHANGED and accepts it
  })

  it('keeps an already-full 4-digit year', () => {
    expect(toFullDate('05.01.2023', 2024)).toBe('05.01.2023')
  })

  it('expands a 2-digit year into the page year century', () => {
    expect(toFullDate('05.01.24', 2024)).toBe('05.01.2024')
  })

  it('returns null for a bare date with no page year (drop, never guess)', () => {
    expect(toFullDate('31.12.', null)).toBeNull()
  })

  it('rejects an implausible month/day (so a dot-decimal amount is not read as a date)', () => {
    expect(toFullDate('12.50.', 2024)).toBeNull()
  })
})

describe('resolvePageYear', () => {
  it('prefers the year of the first fully-printed date on the page', () => {
    const words = [word('Statement period 01.01.2022 - 31.12.2022', 50, 800), word('31.05.', 50, 700)]
    expect(resolvePageYear(words)).toBe(2022)
  })

  it('falls back to a standalone year token in the top header band', () => {
    const words = [
      word('Kontoauszug 2024', 50, 800), // header band
      word('31.12.', 50, 700), // bare row date, lower on the page
      word('1.234,56', 400, 700)
    ]
    expect(resolvePageYear(words)).toBe(2024)
  })

  it('returns null when no year is anywhere on the page', () => {
    expect(resolvePageYear([word('31.12.', 50, 700)])).toBeNull()
  })
})

describe('detectDatumColumn (the booking-date column model §3.1.3)', () => {
  it('picks the densest, leftmost date column (booking column over Valuta)', () => {
    // Two booking rows (date at x=50) and two Valuta-only continuation rows (date at x=110).
    const rows = [
      [word('05.04.', 50, 700)],
      [word('07.04.', 110, 688)],
      [word('12.04.', 50, 668)],
      [word('14.04.', 110, 656)]
    ]
    expect(detectDatumColumn(rows)).toEqual({ min: 50, max: 50 })
  })

  it('a stray header date further left than the booking column does not steal the column (density wins)', () => {
    const rows = [
      [word('01.01.', 20, 800)], // a single stray date at the far left
      [word('05.04.', 50, 700)],
      [word('12.04.', 50, 680)],
      [word('20.04.', 50, 660)]
    ]
    // Density (three booking dates at 50) beats the lone leftmost date at 20.
    expect(detectDatumColumn(rows)).toEqual({ min: 50, max: 50 })
  })

  it('returns null when the page has no date tokens', () => {
    expect(detectDatumColumn([[word('Kontostand', 50, 700)]])).toBeNull()
  })
})

describe('reconstructLine', () => {
  it('rejects a row whose only date is OUTSIDE the booking-date column (Valuta line)', () => {
    // The Valuta date (x=110) is out of the Datum band {50}; the FX amount must not make it a row.
    const row: LayoutWord[] = [word('07.04.', 110, 688), word('Zahlungsreferenz 39,00 USD', 170, 688)]
    expect(reconstructLine(row, 2025, { min: 50, max: 50 })).toBeNull()
  })

  it('accepts a row whose lead date IS in the booking-date column', () => {
    const row: LayoutWord[] = [word('05.04.', 50, 700), word('Gehalt', 170, 700), word('1.000,00', 440, 700)]
    expect(reconstructLine(row, 2025, { min: 50, max: 50 })).toBe('05.04.2025 Gehalt 1.000,00')
  })

  it('emits <full date> <description> <amount> <balance>; drops the value-date column', () => {
    // A real HVB-shaped row: booking date · value date · description · amount · running balance.
    const row: LayoutWord[] = [
      word('31.12.', 50, 700),
      word('31.12.', 95, 700), // value-date column — MUST be dropped, not read as the amount
      word('SEPA-Überweisung', 140, 700),
      word('Müller', 250, 700),
      word('-1.234,56', 420, 700),
      word('9.999,99', 500, 700)
    ]
    const line = reconstructLine(row, 2024)
    expect(line).toBe('31.12.2024 SEPA-Überweisung Müller -1.234,56 9.999,99')
    // The dropped value date is gone — only ONE date token leads the line.
    expect(line!.match(/\d{1,2}\.\d{1,2}\./g)).toHaveLength(1)
  })

  it('returns null when the row has no resolvable date', () => {
    expect(reconstructLine([word('Zwischensumme', 50, 700), word('1.000,00', 400, 700)], 2024)).toBeNull()
  })

  it('returns null when the row has a date but no amount (a header/section line)', () => {
    expect(reconstructLine([word('31.12.', 50, 700), word('Kontostand', 140, 700)], 2024)).toBeNull()
  })

  it('returns null when the description would be empty', () => {
    expect(reconstructLine([word('31.12.', 50, 700), word('1.234,56', 400, 700)], 2024)).toBeNull()
  })
})

describe('reconstructPage (end-to-end on word boxes)', () => {
  it('rebuilds every transaction row as a clean parseable line, year from the header', () => {
    const words: LayoutWord[] = [
      // Header band carries the year (preserved RAW — no date, so it stays a header line).
      word('Kontoauszug', 50, 800),
      word('2024', 200, 800),
      // Row 1
      word('05.01.', 50, 700),
      word('Gehalt ACME', 140, 700),
      word('2.500,00', 420, 700),
      word('3.500,00', 500, 700),
      // Row 2
      word('06.01.', 50, 680),
      word('Miete', 140, 680),
      word('-900,00', 420, 680),
      word('2.600,00', 500, 680)
    ]
    const { text, year } = reconstructPage(words)
    expect(year).toBe(2024)
    const lines = text.split('\n')
    // The header survives as a raw line (needed for currency/balance/period context)…
    expect(lines).toContain('Kontoauszug 2024')
    // …and each transaction row is a clean, year-resolved, parseable line.
    expect(lines).toContain('05.01.2024 Gehalt ACME 2.500,00 3.500,00')
    expect(lines).toContain('06.01.2024 Miete -900,00 2.600,00')
    // Every emitted TRANSACTION lead date is one the UNCHANGED parseDate accepts.
    for (const line of ['05.01.2024 Gehalt ACME 2.500,00 3.500,00', '06.01.2024 Miete -900,00 2.600,00']) {
      expect(parseDate(line.split(' ')[0])).not.toBeNull()
    }
  })

  it('preserves opening/closing balance label lines (no date) for the completeness gate', () => {
    const words: LayoutWord[] = [
      word('Anfangssaldo', 50, 720),
      word('2.000,00', 420, 720),
      word('05.01.', 50, 700),
      word('Gehalt', 140, 700),
      word('2.000,00', 420, 700),
      word('Endsaldo', 50, 680),
      word('4.000,00', 420, 680)
    ]
    const lines = reconstructPage(words, { fallbackYear: 2024 }).text.split('\n')
    expect(lines).toContain('Anfangssaldo 2.000,00')
    expect(lines).toContain('Endsaldo 4.000,00')
  })

  it('drops a Valuta second-baseline row and strips its out-of-column date from the raw text', () => {
    const words: LayoutWord[] = [
      // Booking baseline (date in the Datum column at x=50).
      word('05.04.', 50, 700),
      word('Gehalt ACME', 170, 700),
      word('1.000,00', 440, 700),
      // Second baseline 12 pt lower: Valuta date (x=110, out of column) + an FX reference amount.
      word('07.04.', 110, 688),
      word('Zahlungsreferenz ePAYMENT 39,00 USD', 170, 688)
    ]
    const lines = reconstructPage(words, { fallbackYear: 2025 }).text.split('\n')
    // The booking row is a clean transaction…
    expect(lines).toContain('05.04.2025 Gehalt ACME 1.000,00')
    // …and the continuation row survives as raw text WITHOUT its leading Valuta date, so the
    // date-leading line parser can never re-extract it as a spurious transaction.
    expect(lines).toContain('Zahlungsreferenz ePAYMENT 39,00 USD')
    expect(lines.some((l) => /^\d{1,2}\.\d{1,2}\./.test(l) && l.includes('39,00'))).toBe(false)
  })

  it('uses the document-level fallback year for a page whose header carries none', () => {
    const words: LayoutWord[] = [word('07.02.', 50, 700), word('Kaffee', 140, 700), word('-3,50', 420, 700)]
    const { text } = reconstructPage(words, { fallbackYear: 2023 })
    expect(text).toBe('07.02.2023 Kaffee -3,50')
  })

  it('emits a bare-date row RAW when no year is resolvable — extraction still drops it (honesty)', () => {
    const words: LayoutWord[] = [word('07.02.', 50, 700), word('Kaffee', 140, 700), word('-3,50', 420, 700)]
    const { text } = reconstructPage(words)
    // Preserved as raw text (no year was resolved, so it was NOT promoted to a year-resolved row)…
    expect(text).toBe('07.02. Kaffee -3,50')
    // …and its bare lead date is one parseDate REJECTS, so the bank extractor drops it, never guesses.
    expect(parseDate(text.split(' ')[0])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------
// Stage-1 geometry EDGE boundaries (audit 2026-06-24, M3). The committed PDF fixtures encode IDEAL
// geometry (each cell its own pdf.js item, identical baselines, wide column gaps); these unit tests pin
// the two load-bearing tuning constants AND the split-amount behaviour at their boundaries, so a real
// statement that violates the idealizations has its (currently-safe) outcome documented, not silent. The
// gold-set harness (local-only) is still the real-PDF gate; these pin the geometry CONTRACT against a
// regression. None of these is a wrong total — see §21 "boundaries" + known-limitations.
describe('Stage-1 geometry edge boundaries (audit M3)', () => {
  it('clusterRows anchors on the cluster’s first y, so spread is from the TOP, not pairwise', () => {
    // Two cells within tolerance of the row’s first (highest) baseline group; a cell that drifts past
    // DEFAULT_ROW_TOLERANCE from that anchor splits — even if it is within tolerance of its neighbour.
    const grouped = clusterRows(
      [word('05.01.', 50, 700), word('Gehalt', 160, 702), word('1.000,00', 420, 699)],
      DEFAULT_ROW_TOLERANCE
    )
    // y’s sorted desc = 702,700,699; anchor 702: 700 (Δ2 ≤ 3) joins, 699 (Δ3 ≤ 3) joins → one row.
    expect(grouped).toHaveLength(1)
    // A 4-pt drop from the anchor exceeds the 3-pt tolerance → the amount lands on its OWN visual row,
    // so that transaction would lose its amount (the jitter failure real pdf.js baselines can cause).
    const split = clusterRows(
      [word('05.01.', 50, 702), word('Gehalt', 160, 702), word('1.000,00', 420, 698)],
      DEFAULT_ROW_TOLERANCE
    )
    expect(split).toHaveLength(2)
  })

  it('detectDatumColumn MERGES a Datum/Valuta pair closer than the column gap (over-extraction risk)', () => {
    // Datum x=50, Valuta x=58 → gap 8 < DEFAULT_COLUMN_GAP (12) → ONE band spanning both columns.
    const tight = [
      [word('05.04.', 50, 700)],
      [word('07.04.', 58, 688)],
      [word('12.04.', 50, 668)],
      [word('14.04.', 58, 656)]
    ]
    expect(DEFAULT_COLUMN_GAP).toBe(12)
    expect(detectDatumColumn(tight)).toEqual({ min: 50, max: 58 })
    // Consequence: a Valuta-only second-baseline row (date at x=58, now INSIDE the merged band) + a money
    // token qualifies as a transaction — a spurious row. SAFE via the completeness gate (it inflates the
    // count / breaks the tie → downgrade, never a wrong total), but it is the boundary the gap guards.
    const valutaRowInMergedBand = reconstructLine(
      [word('07.04.', 58, 688), word('FX-Referenz', 170, 688), word('39,00', 440, 688)],
      2025,
      { min: 50, max: 58 }
    )
    expect(valutaRowInMergedBand).toBe('07.04.2025 FX-Referenz 39,00') // would be null with a clean gap
    // A well-separated layout keeps the booking column narrow, so the same Valuta row is rejected.
    const wide = [[word('05.04.', 50, 700)], [word('07.04.', 110, 688)], [word('12.04.', 50, 668)]]
    expect(detectDatumColumn(wide)).toEqual({ min: 50, max: 50 })
  })

  it('a pdf.js-SPLIT amount is never reassembled → the row is dropped (recall loss, gate-safe)', () => {
    // When a producer splits "2.000,00" into two adjacent items "2.000" + ",00" (a kerning/positioning
    // gap pdf.js surfaces as two TextItems), neither fragment classifies as money — "2.000" is text and
    // ",00" is text — so the row carries NO amount and reconstructLine drops it. The real transaction
    // silently vanishes (a recall loss), but it is never mis-totalled. The fix (an x-adjacency money
    // re-merge) is deferred with the money-column model.
    const split = reconstructLine(
      [word('05.01.', 50, 700), word('Gehalt', 160, 700), word('2.000', 420, 700), word(',00', 445, 700)],
      2024,
      { min: 50, max: 50 }
    )
    expect(split).toBeNull()
    // The same row with the amount as ONE token reconstructs cleanly — proving the split is the cause.
    const whole = reconstructLine(
      [word('05.01.', 50, 700), word('Gehalt', 160, 700), word('2.000,00', 420, 700)],
      2024,
      { min: 50, max: 50 }
    )
    expect(whole).toBe('05.01.2024 Gehalt 2.000,00')
  })

  it('a bare <date> <CUR> <balance> running-balance row is DROPPED (currency-class kills the phantom)', () => {
    // The gold-set HVB "Umsätze" over-extraction (former boundary 1): each transaction prints a booking
    // row (`<date> <desc> <amount>`) AND a per-row running-balance row (`<date> EUR <balance>`), and the
    // amount and balance share ONE right-aligned numeric column so a "money-column model" can't separate
    // them (these MEASURED gold-set x's all fall inside one DEFAULT_COLUMN_GAP band). The fix is NOT a
    // money-column model: the per-row CURRENCY token is now its own class, so the balance row's ONLY
    // non-date/non-money token (the bare `EUR`) no longer becomes a description → the row has an EMPTY
    // description → reconstructLine drops it. A genuine row whose payee wrapped to another baseline is
    // RESCUED by multi-baseline association (next test), so the two are now distinguishable.
    const moneyXs = [493, 495, 499, 505, 508, 510]
    const sorted = [...moneyXs].sort((a, b) => a - b)
    const maxConsecutiveGap = Math.max(...sorted.slice(1).map((x, i) => x - sorted[i]))
    expect(maxConsecutiveGap).toBeLessThanOrEqual(DEFAULT_COLUMN_GAP) // amount & balance share one band
    const phantom = reconstructLine(
      [word('07.02.', 50, 700), word('EUR', 470, 700), word('1.234,56', 493, 700)],
      2024,
      { min: 50, max: 50 }
    )
    expect(phantom).toBeNull() // dropped: the bare currency code is no longer a description
  })
})

// ---------------------------------------------------------------------------------------------------
// HVB "Umsätze" multi-baseline recovery (D56-R follow-up, 2026-06-25). The online "Umsätze" export
// prints each transaction across MULTIPLE baselines: a booking baseline (`<date> <type> <CUR> <amount>`,
// the sign sometimes in a separate cell) and continuation baselines below it carrying the payee/purpose.
// Before this fix reconstructLine emitted only the booking-line fragment (`… EUR …`, payee lost, sign
// unreliable) and the payee rows were orphaned/dropped. These pin: the currency token kept out of the
// description (A2), the payee continuation merged in (A1), and a sign-column marker folded into the
// amount (A3). SYNTHETIC (positioned word boxes), never a real statement (D57).
describe('HVB multi-baseline recovery (A1 association + A2 currency + A3 sign)', () => {
  it('strips a per-row currency code out of the description and re-emits it after the amount (A2)', () => {
    const line = reconstructLine(
      [word('29.01.', 50, 700), word('SEPA-GUTSCHRIFT', 140, 700), word('EUR', 300, 700), word('34,39', 490, 700)],
      2025,
      { min: 50, max: 50 }
    )
    // "EUR" is no longer part of the description; it trails the amount where parseLine reads it as currency.
    expect(line).toBe('29.01.2025 SEPA-GUTSCHRIFT 34,39 EUR')
  })

  it('folds a separate sign-column marker into the amount (A3: a Soll/debit reads negative)', () => {
    // The booking baseline carries the figure unsigned plus a standalone "-" in the amount/sign column.
    const debit = reconstructLine(
      [word('14.01.', 50, 700), word('LASTSCHRIFT', 140, 700), word('3,99', 490, 700), word('-', 512, 700)],
      2025,
      { min: 50, max: 50 }
    )
    expect(debit).toBe('14.01.2025 LASTSCHRIFT -3,99')
    // A German Soll/Haben "H" in the sign column marks a credit (stays positive); "S" marks a debit.
    const credit = reconstructLine(
      [word('29.01.', 50, 680), word('GUTSCHRIFT', 140, 680), word('34,39', 490, 680), word('H', 512, 680)],
      2025,
      { min: 50, max: 50 }
    )
    expect(credit).toBe('29.01.2025 GUTSCHRIFT 34,39')
  })

  it('does NOT treat a dash far from the money column as a sign (a description dash stays positive)', () => {
    // A "-" at x=200 (in the description zone, far left of the amount at 490) is NEVER folded into the
    // amount — guessing the sign there would risk a wrong total. It stays as description text (a
    // non-folded sign marker is content, not silently dropped), and the amount stays positive.
    const line = reconstructLine(
      [word('14.01.', 50, 700), word('LASTSCHRIFT', 140, 700), word('-', 200, 700), word('3,99', 490, 700)],
      2025,
      { min: 50, max: 50 }
    )
    expect(line).toBe('14.01.2025 LASTSCHRIFT - 3,99') // positive: the far dash is not read as a sign
  })

  it('does NOT let a sign printed beside the running BALANCE flip the amount (S3 — separate columns)', () => {
    // A row with both an amount (x=490) and a running balance (x=620), plus a "-" sitting by the
    // BALANCE column (x=632). The marker is nearer the balance than the amount, so it must NOT negate
    // the amount — it would invert a credit into a debit and corrupt the (unverified) total.
    const line = reconstructLine(
      [
        word('14.01.', 50, 700),
        word('GUTSCHRIFT', 140, 700),
        word('34,39', 490, 700),
        word('1.234,56', 620, 700),
        word('-', 632, 700)
      ],
      2025,
      { min: 50, max: 50 }
    )
    expect(line).toBe('14.01.2025 GUTSCHRIFT - 34,39 1.234,56') // amount stays positive; the dash is text
  })

  it('merges payee/purpose continuation baselines into the booking row, and drops the phantom balance row', () => {
    const words: LayoutWord[] = [
      word('Kontoumsaetze', 50, 800),
      word('2025', 300, 800),
      // Transaction: booking baseline (type + currency + amount + sign), then two payee continuations.
      word('14.01.', 50, 700),
      word('LASTSCHRIFT', 140, 700),
      word('EUR', 300, 700),
      word('3,99', 490, 700),
      word('-', 512, 700),
      word('Telekom Deutschland GmbH', 140, 688), // continuation 1: payee (no date, no money)
      word('Mandatsref 9988', 140, 676), // continuation 2: purpose
      // A bare per-row running-balance row (date + currency + balance, NO payee below it).
      word('14.01.', 50, 664),
      word('EUR', 300, 664),
      word('1.234,56', 490, 664)
    ]
    const lines = reconstructPage(words).text.split('\n')
    // The payee + purpose are merged into the booking line; "EUR" trails; the debit reads negative.
    expect(lines).toContain('14.01.2025 LASTSCHRIFT Telekom Deutschland GmbH Mandatsref 9988 -3,99 EUR')
    // The phantom balance row (no payee continuation) is dropped — never a transaction line.
    expect(lines.some((l) => l.includes('1.234,56'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------
// FIN-3 (full-audit-2026-06-29 follow-up Phase 1). The geometry classifier's DATE_TOKEN_RE used to
// BACKTRACK a bare-thousands amount like `2.500` into a date (day 2 / month 5 / "year" 00). Out of the
// booking-date column, that "date" was DROPPED, so the row lost its movement amount and the line parser
// read the running BALANCE as the amount — a confidently-wrong figure via a path the F1 guard doesn't
// cover. The fix tightens DATE_TOKEN_RE (a year must be preceded by its own dot, so `2.500` is un-date-
// able) so the token is NOT dropped: it rides the reconstructed line as text and the line parser's
// authoritative MONEY_RE (which reads bare-thousands / apostrophe) parses it. Driven through the REAL
// reconstructLine → extractTransactionRows path with whole rows.
describe('FIN-3: bare-thousands / apostrophe amounts are no longer mis-read as dates (geometry)', () => {
  const seg = (text: string): { text: string; page: number; index: number } => ({ text, page: 1, index: 0 })

  it('a bare-thousands `2.500` survives reconstruction → amount 2500, balance 1000 (not balance-as-amount)', () => {
    const line = reconstructLine(
      [word('07.02.', 50, 700), word('EINKAUF', 160, 700), word('2.500', 420, 700), word('1.000,00', 500, 700)],
      2024,
      { min: 50, max: 50 }
    )
    // BEFORE: '07.02.2024 EINKAUF 1.000,00' (2.500 backtracked into a date and dropped).
    expect(line).toBe('07.02.2024 EINKAUF 2.500 1.000,00')
    const rows = extractTransactionRows([seg(line!)], 'EUR')
    // BEFORE: amount 1000 (the running balance read as the movement amount — the cardinal wrong-money harm).
    expect(rows[0]).toMatchObject({ amount: 2500, balanceAfter: 1000 })
  })

  it('an apostrophe-grouped `1\'234.56` likewise survives when a cents figure anchors the row', () => {
    const line = reconstructLine(
      [word('05.01.', 50, 700), word('Zahlung', 160, 700), word("1'234.56", 420, 700), word('9.999,99', 500, 700)],
      2024,
      { min: 50, max: 50 }
    )
    expect(line).toBe("05.01.2024 Zahlung 1'234.56 9.999,99")
    expect(extractTransactionRows([seg(line!)], 'EUR')[0]).toMatchObject({ amount: 1234.56, balanceAfter: 9999.99 })
  })

  it('boundary: a SOLE no-cents `10.000` stays a gate-safe DROP (MONEY_TOKEN_RE deliberately not widened)', () => {
    // The classifier keeps the 2-dp requirement, so a row whose ONLY figure is a no-cents bare-thousands
    // carries no money TOKEN and is dropped — a recall loss, never a wrong figure. Widening to accept it
    // would re-introduce the M3 split-amount wrong-figure risk (`2.000` + `,00` → amount 2000, cents lost).
    // This is the documented FIN-3 divergence (architecture.md §8).
    expect(reconstructLine([word('05.01.', 50, 700), word('Bonus', 160, 700), word('10.000', 420, 700)], 2024, { min: 50, max: 50 })).toBeNull()
  })
})
