import { describe, it, expect } from 'vitest'
import {
  clusterRows,
  reconstructLine,
  reconstructPage,
  resolvePageYear,
  toFullDate,
  type LayoutWord
} from '../../src/main/services/ingestion/parsers/pdf-layout'
import { parseDate } from '../../src/main/services/skills/tools/money'

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

describe('reconstructLine', () => {
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
      // Header band carries the year.
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
    expect(text.split('\n')).toEqual([
      '05.01.2024 Gehalt ACME 2.500,00 3.500,00',
      '06.01.2024 Miete -900,00 2.600,00'
    ])
    // Every emitted lead date is one the UNCHANGED parseDate accepts.
    for (const line of text.split('\n')) {
      const lead = line.split(' ')[0]
      expect(parseDate(lead)).not.toBeNull()
    }
  })

  it('uses the document-level fallback year for a page whose header carries none', () => {
    const words: LayoutWord[] = [word('07.02.', 50, 700), word('Kaffee', 140, 700), word('-3,50', 420, 700)]
    const { text } = reconstructPage(words, { fallbackYear: 2023 })
    expect(text).toBe('07.02.2023 Kaffee -3,50')
  })

  it('drops bare-date rows when no year is resolvable anywhere (honesty)', () => {
    const words: LayoutWord[] = [word('07.02.', 50, 700), word('Kaffee', 140, 700), word('-3,50', 420, 700)]
    expect(reconstructPage(words).text).toBe('')
  })
})
