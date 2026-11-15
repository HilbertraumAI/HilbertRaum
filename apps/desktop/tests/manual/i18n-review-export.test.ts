import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { UI_LANGUAGES } from '../../src/shared/i18n'
import { pluralCsv, pluralSheetFor, reviewCsv, reviewTableFor } from '../helpers/i18n-review-export'

// MANUAL native-review export (#813) — NOT CI. Writes the review kit for a native speaker:
//
//   HILBERTRAUM_I18N_REVIEW_EXPORT=<dir> npx vitest run tests/manual/i18n-review-export.test.ts
//
// (from apps/desktop; a relative <dir> is taken from there). Skipped, and writes nothing, unless
// the variable is set. For every registered language except English (the source text, which is a
// column of every file) it writes two UTF-8 CSV files that a spreadsheet app opens:
//
//   <code>-review.csv   one row per key of the language's catalog: the privacy, security,
//                       password, lock and offline text first, then the review screen, then the
//                       rest; English, the translation, whether the code reads the key by its exact
//                       text (and why), and the code comments above the key in en.ts and in the
//                       language's own file.
//   <code>-plurals.csv  every plural base rendered through the real tCount at 0, 1, 2, 5, 21, 22,
//                       25, 101 and 1000000 (plus a fraction for a form none of them takes), with
//                       the plural category the language's rule picks and the English text.
//
// The builder is tests/helpers/i18n-review-export.ts; tests/unit/i18n-review-export.test.ts checks it.

const OUT = process.env.HILBERTRAUM_I18N_REVIEW_EXPORT?.trim() ?? ''

describe.skipIf(OUT === '')('HILBERTRAUM_I18N_REVIEW_EXPORT — the native-review kit', () => {
  it('writes <code>-review.csv and <code>-plurals.csv for every language but English', () => {
    // Never write without the variable, also if the skip above is lost (resolve('') is the cwd).
    if (OUT === '') throw new Error('HILBERTRAUM_I18N_REVIEW_EXPORT is not set: the export writes nowhere')
    const dir = resolve(OUT)
    mkdirSync(dir, { recursive: true })
    const written: string[] = []
    for (const { code } of UI_LANGUAGES.filter((info) => info.code !== 'en')) {
      const table = reviewTableFor(code)
      const plurals = pluralSheetFor(code)
      expect(table.length).toBeGreaterThan(0)
      expect(plurals.length).toBeGreaterThan(0)
      writeFileSync(join(dir, `${code}-review.csv`), reviewCsv(table), 'utf8')
      writeFileSync(join(dir, `${code}-plurals.csv`), pluralCsv(plurals), 'utf8')
      const exact = table.filter((row) => row.exactMatch.length > 0).length
      const security = table.filter((row) => row.group === 'security').length
      written.push(`${code}: ${table.length} keys (${security} security, ${exact} exact match), ${plurals.length} plural rows`)
    }
    console.log(`[i18n review export] ${dir}\n  ${written.join('\n  ')}`)
  })
})
