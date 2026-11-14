import { describe, it, expect } from 'vitest'
import { fmtDiskGb, fmtDiskSize, fmtPackSize, unitJoin } from '../../src/shared/format'
import { t, UI_LANGUAGE_CODES, type UiLanguage } from '../../src/shared/i18n'

// The space a size built in code puts before its unit symbol (#804, G-3): a plain space in English
// and German, whose output stays what it was, and U+00A0 in every other registered language, the
// space each of those catalogs writes there (the figure-unit typography rule in i18n.test.ts). The
// tiers and their rounding are documents-format.test.ts's rows (`formatSize`); these rows own the join.

const NBSP = String.fromCharCode(0xa0)
/** `s` with each U+00A0 spelled out, so a row compares code points and a failure names the space. */
const shown = (s: string): string => s.split(NBSP).join('<nbsp>')

/** One size from each formatter and each of its tiers, as shown. */
const sizes = (lang: UiLanguage): string[] =>
  [
    fmtDiskGb(2_500_000_000, lang),
    fmtDiskSize(512, lang),
    fmtDiskSize(2_048, lang),
    fmtDiskSize(4_285_975, lang),
    fmtPackSize(18_000_000, lang),
    fmtPackSize(2_500_000_000, lang)
  ].map(shown)

const JOINS: ReadonlyArray<readonly [UiLanguage, string]> = [
  ['en', ' '],
  ['de', ' '],
  ['es', '<nbsp>'],
  ['fr', '<nbsp>'],
  ['it', '<nbsp>'],
  ['nl', '<nbsp>'],
  ['pl', '<nbsp>'],
  ['tr', '<nbsp>'],
  ['ru', '<nbsp>'],
  ['uk', '<nbsp>']
]

describe('unitJoin and the size formatters — the space before a unit (#804)', () => {
  it('has a row for every registered language', () => {
    expect(JOINS.map(([lang]) => lang).sort()).toEqual([...UI_LANGUAGE_CODES].sort())
  })

  it.each(JOINS)('%s joins a figure and its unit with %j, as its catalog does', (lang, join) => {
    expect(shown(unitJoin(lang))).toBe(join)
    // The Performance row's catalog size ("{model} · {size} GB") sits beside the formatters' sizes.
    expect(shown(t(lang, 'perf.models.row', { model: 'M', size: '1' }))).toBe(`M · 1${join}GB`)
    for (const size of sizes(lang)) expect(size).toMatch(new RegExp(`^[\\d.,]+${join}(?:GB|MB|KB|B)$`))
  })

  // English and German print exactly what they printed before the join existed.
  it.each([
    ['en', ['2.5 GB', '512 B', '2.0 KB', '4.3 MB', '18 MB', '2.5 GB']],
    ['de', ['2,5 GB', '512 B', '2,0 KB', '4,3 MB', '18 MB', '2,5 GB']]
  ] as const)('%s output is unchanged', (lang, expected) => {
    expect(sizes(lang)).toEqual(expected)
  })
})
