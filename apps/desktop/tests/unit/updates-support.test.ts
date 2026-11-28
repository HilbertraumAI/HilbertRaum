import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { supportNotice, type SupportInput, type SupportNotice } from '../../src/shared/updates/support'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// F-12, the support-end and age-reminder computation (app-update T6.4a; docs/app-updates.md §8.4 "The support
// computation"; the owner's rule A1, 2026-11-27): release 1 answers these dates for ever. The expected answers are the
// golden tests/fixtures/updates/import/f12-support-dates.json (T6.0b), written by hand from the record's table before the
// function existed, and locked by the golden manifest; this file only runs them. A case that looks wrong is an owner
// call, never an edit here (record §1.5).

interface Vector {
  readonly id: string
  readonly why: string
  readonly input: unknown
  readonly expect: SupportNotice | null
}

const GOLDEN = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'import', 'f12-support-dates.json')
const { vectors } = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { vectors: Vector[] }

describe('supportNotice: the F-12 golden dates (record §8.4)', () => {
  // The golden's own count (PROVENANCE.md: 97 dates) and unique ids, so a vector cannot drop out of the run unseen.
  it('runs every vector of the golden once: 97, each id once', () => {
    expect(vectors).toHaveLength(97)
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length)
  })

  // An input that does not read is part of the contract (the golden's last rows hand null, a string, a number and an
  // array as `dismissed`), so the vector's input goes in as it is written.
  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(supportNotice(v.input as SupportInput), v.why).toEqual(v.expect)
  })
})

describe('supportNotice: what does not read is no notice, never an error (record §8.4, rows "The function", "Inputs")', () => {
  const good = { buildDate: '2027-03-15T09:30:00Z', supportMonth: null, today: { year: 2028, month: 6, day: 20 }, dismissed: {} }
  it.each<[string, unknown]>([
    ['no input at all', undefined],
    ['a null input', null],
    ['a today that is null', { ...good, today: null }],
    // Text that would read once turned into a string is still no string.
    ['a buildDate that is an array holding a good date', { ...good, buildDate: ['2027-03-15T09:30:00Z'] }]
  ])('%s: null, and no throw', (_label, input) => {
    expect(supportNotice(input as SupportInput)).toBeNull()
  })

  it('a supportMonth that is an array holding a good month counts as no stamp: the age reminder, not the end notice', () => {
    expect(supportNotice({ ...good, supportMonth: ['2027-06'] } as unknown as SupportInput)).toEqual({ code: 'UPD-AGE-REMINDER', params: { ageMonths: 15 } })
  })

  it('the same input with each part readable: the age reminder (the rows above fail on the part they change)', () => {
    expect(supportNotice(good)).toEqual({ code: 'UPD-AGE-REMINDER', params: { ageMonths: 15 } })
  })
})

// Record §8.4 "The function": pure and importing nothing, so the renderer (PR-6b's Home and Settings notices) and main
// may both call it. Read from the syntax tree: an import declaration, a re-export from a module, an import() call or a
// require() anywhere in the file breaks the rule.
describe('support.ts imports nothing (record §8.4, "The function")', () => {
  it('holds no import, no export from a module, no import() and no require()', () => {
    const file = join(DESKTOP_ROOT, 'src', 'shared', 'updates', 'support.ts')
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) found.push(n.getText(source))
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) found.push(n.getText(source))
      else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
        found.push(n.getText(source))
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
    expect(found).toEqual([])
  })
})
