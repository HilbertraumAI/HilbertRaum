import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { supportNotice, type SupportInput, type SupportNotice } from '../../src/shared/updates/support'
import { parseIssued } from '../../src/main/services/updates/payload'
import { isSupportMonth } from '../../src/main/services/updates/kit-support'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// F-12, the support-end and age-reminder computation (app-update T6.4a; docs/app-updates.md §8.4 "The support
// computation"; the owner's rule A1, 2026-11-27): release 1 answers these dates for ever. The expected answers are the
// golden tests/fixtures/updates/import/f12-support-dates.json (T6.0b), written by hand from the record's table before the
// function existed, and locked by the golden manifest; this file only runs them. A case that looks wrong is an owner
// call, never an edit here (record §1.5). The rows after the golden hold rules a mutation of support.ts could break with
// the golden still green (T6.4a review A): their answers are the record's, written here by hand.

interface Vector {
  readonly id: string
  readonly why: string
  readonly input: unknown
  readonly expect: SupportNotice | null
}

const GOLDEN = join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'import', 'f12-support-dates.json')
const { vectors } = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { vectors: Vector[] }

/** An input with every part readable: the age reminder at 15 months (the rows below each change one part). */
const good = { buildDate: '2027-03-15T09:30:00Z', supportMonth: null, today: { year: 2028, month: 6, day: 20 }, dismissed: {} }
const age = (ageMonths: number): SupportNotice => ({ code: 'UPD-AGE-REMINDER', params: { ageMonths } })
const ended = (supportEnd: string): SupportNotice => ({ code: 'UPD-SUPPORT-ENDED', params: { supportEnd } })
const longAgo = (supportEnd: string, ageMonths: number): SupportNotice => ({ code: 'UPD-SUPPORT-ENDED-LONG-AGO', params: { supportEnd, ageMonths } })
const AGE_15 = age(15)

describe('supportNotice: the F-12 golden dates (record §8.4)', () => {
  // The golden's own count (PROVENANCE.md: 97 dates) and unique ids, so a vector cannot drop out of the run unseen.
  it('runs every vector of the golden once: 97, each id once', () => {
    expect(vectors).toHaveLength(97)
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length)
  })

  // An input that does not read is part of the contract (the golden's last rows hand null, a string, a number and an
  // array as `dismissed`), so the vector's input goes in as it is written. Strict: an extra key (one whose value is
  // undefined included) is another answer (T6.4a review A m4).
  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(supportNotice(v.input as SupportInput), v.why).toStrictEqual(v.expect)
  })
})

describe('supportNotice: what does not read is no notice, never an error (record §8.4, rows "The function", "Inputs")', () => {
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

// T6.4a review A M1: each row holds a rule of record §8.4 that a mutation of support.ts broke while the 97 golden rows
// stayed green (review A's `extra` table), plus the review's "worth adding" list. Answers from the record, by hand.
describe('supportNotice: the rules beyond the golden dates (record §8.4, rows "Inputs", "Dates", "The answer")', () => {
  /** An object whose fields are all inherited: no own field (record §8.4 "Inputs": an inherited one counts as absent). */
  const inherited = (fields: object): object => Object.create(fields) as object
  const on = (year: number, month: number, day: number): { year: number; month: number; day: number } => ({ year, month, day })
  const last = on(9999, 12, 31)
  it.each<[string, unknown, SupportNotice | null]>([
    // The build date: §2.4's `issued` grammar (a real time, minute and second 00-59, ASCII digits, upper-case T and Z,
    // the text alone on its line) from the year 2000 to 9999; else no build date, so no notice.
    ['a build date with minute 60', { ...good, buildDate: '2027-03-15T09:60:00Z' }, null],
    ['a build date with second 60', { ...good, buildDate: '2027-03-15T09:30:60Z' }, null],
    ['a build date in month 00', { ...good, buildDate: '2027-00-15T09:30:00Z' }, null],
    ['a build date on day 00', { ...good, buildDate: '2027-03-00T09:30:00Z' }, null],
    ['a build date on 31 April', { ...good, buildDate: '2027-04-31T09:30:00Z' }, null],
    ['a build date with a lower-case t', { ...good, buildDate: '2027-03-15t09:30:00Z' }, null],
    ['a build date with a lower-case z', { ...good, buildDate: '2027-03-15T09:30:00z' }, null],
    ['a build date with a trailing LF', { ...good, buildDate: '2027-03-15T09:30:00Z\n' }, null],
    ['a build date after a space', { ...good, buildDate: ' 2027-03-15T09:30:00Z' }, null],
    ['a build date on the line after another', { ...good, buildDate: 'x\n2027-03-15T09:30:00Z' }, null],
    ['a build date with a line after it', { ...good, buildDate: '2027-03-15T09:30:00Z\nx' }, null],
    ['a build date with an Arabic-Indic digit', { ...good, buildDate: '2027-03-1\u{0665}T09:30:00Z' }, null],
    ['a build date with a full-width digit', { ...good, buildDate: '2027-03-1\u{FF15}T09:30:00Z' }, null],
    ['a build date whose month lacks its zero', { ...good, buildDate: '2027-3-15T09:30:00Z' }, null],
    ['a build date of 2100-02-29 (2100 is no leap year)', { ...good, buildDate: '2100-02-29T00:00:00Z', today: on(2101, 6, 1) }, null],
    ['a build date of 2000-02-29 reads (2000 is a leap year): 6 months on 2000-08-29', { ...good, buildDate: '2000-02-29T00:00:00Z', today: on(2000, 8, 29) }, age(6)],
    ['a build date of 9999-12-31T23:59:59Z on its own day: age 0, none', { ...good, buildDate: '9999-12-31T23:59:59Z', today: last }, null],
    ['a build date of 9999-01-31 and today 9999-07-31: 6 months', { ...good, buildDate: '9999-01-31T00:00:00Z', today: on(9999, 7, 31) }, age(6)],
    // today: three integers (JavaScript numbers), a year from 1 to 9999, own fields of a plain object; else no notice.
    ['today in 9999-12-31: the age counts on', { ...good, today: last }, age(95673)],
    ['today in the year 1, with a stamp of 0000-01 already ended: before the build day, none', { ...good, supportMonth: '0000-01', today: on(1, 1, 1) }, null],
    ['today 1999-12-31 and a build date of 2000-01-01: before the build day, none', { ...good, buildDate: '2000-01-01T00:00:00Z', today: on(1999, 12, 31) }, null],
    ['today.year a string', { ...good, today: { year: '2028', month: 6, day: 20 } }, null],
    ['today.month a string', { ...good, today: { year: 2028, month: '6', day: 20 } }, null],
    ['today.year a fraction', { ...good, today: { year: 2028.5, month: 6, day: 20 } }, null],
    ['today.month a fraction', { ...good, today: { year: 2028, month: 6.5, day: 20 } }, null],
    ['today.year NaN', { ...good, today: { year: Number.NaN, month: 6, day: 20 } }, null],
    ['today.day Infinity', { ...good, today: { year: 2028, month: 6, day: Number.POSITIVE_INFINITY } }, null],
    // A string, a Number object or a BigInt is no integer here (record §8.4 "Dates"; T6.4a re-check minor 2).
    ['today.day a string', { ...good, today: { year: 2028, month: 6, day: '20' } }, null],
    ['today.year a Number object', { ...good, today: { year: Object(2028) as unknown, month: 6, day: 20 } }, null],
    ['today.year a BigInt', { ...good, today: { year: 2028n, month: 6, day: 20 } }, null],
    ['today an array carrying year, month and day', { ...good, today: Object.assign([], on(2028, 6, 20)) }, null],
    ["today's fields inherited", { ...good, today: inherited(on(2028, 6, 20)) }, null],
    // One field inherited, every other own: each field is read as an own property on its own (record §8.4 "Inputs";
    // T6.4a re-check minor 2).
    ['today with only its month inherited', { ...good, today: Object.assign(inherited({ month: 6 }), { year: 2028, day: 20 }) }, null],
    ['today with only its day inherited', { ...good, today: Object.assign(inherited({ day: 20 }), { year: 2028, month: 6 }) }, null],
    // The input: a plain object with own fields; else no notice.
    ['every field of the input inherited', inherited(good), null],
    ['only today inherited, the other fields own', Object.assign(inherited({ today: good.today }), { buildDate: good.buildDate, supportMonth: null, dismissed: {} }), null],
    ['only buildDate inherited, the other fields own', Object.assign(inherited({ buildDate: good.buildDate }), { supportMonth: null, today: good.today, dismissed: {} }), null],
    [
      'only supportMonth inherited, a month long ended (2000-01): no stamp, so the age reminder, not the end notice',
      Object.assign(inherited({ supportMonth: '2000-01' }), { buildDate: good.buildDate, today: good.today, dismissed: {} }),
      AGE_15
    ],
    [
      'only dismissed inherited, holding a dismissal of the age reminder that would hide it: no dismissal, so the age reminder',
      Object.assign(inherited({ dismissed: { 'UPD-AGE-REMINDER': on(2028, 6, 19) } }), { buildDate: good.buildDate, supportMonth: null, today: good.today }),
      AGE_15
    ],
    ['the input an array carrying the fields', Object.assign([], good), null],
    // dismissed: a plain object with an own entry under the notice's code, a real date; else that dismissal is none.
    ['the dismissal entry inherited', { ...good, dismissed: inherited({ 'UPD-AGE-REMINDER': on(2028, 6, 19) }) }, AGE_15],
    ["the dismissal entry's fields inherited", { ...good, dismissed: { 'UPD-AGE-REMINDER': inherited(on(2028, 6, 19)) } }, AGE_15],
    ['dismissed an array carrying the code', { ...good, dismissed: Object.assign([], { 'UPD-AGE-REMINDER': on(2028, 6, 19) }) }, AGE_15],
    ['a dismissal entry that is a date string', { ...good, dismissed: { 'UPD-AGE-REMINDER': '2028-06-19' } }, AGE_15],
    ['a dismissal entry in the year 10000', { ...good, dismissed: { 'UPD-AGE-REMINDER': on(10000, 1, 1) } }, AGE_15],
    // The stamp: four ASCII digits, a hyphen, a month 01-12, nothing before or after; else no stamp (the age reminder,
    // not the end notice).
    ['a stamp with a trailing LF', { ...good, supportMonth: '2027-06\n' }, AGE_15],
    ['a stamp after a space', { ...good, supportMonth: ' 2027-06' }, AGE_15],
    ['a stamp on the line after another', { ...good, supportMonth: 'x\n2027-06' }, AGE_15],
    ['a stamp with a line after it', { ...good, supportMonth: '2027-06\nx' }, AGE_15],
    ['a stamp after a byte-order mark', { ...good, supportMonth: '\u{FEFF}2027-06' }, AGE_15],
    ['a stamp with a full-width digit', { ...good, supportMonth: '2027-0\u{FF16}' }, AGE_15],
    ['a stamp with an Arabic-Indic digit', { ...good, supportMonth: '2027-0\u{0666}' }, AGE_15],
    ['a stamp with a five-digit year', { ...good, supportMonth: '12027-06' }, AGE_15],
    ['a stamp of 0000-01 reads (no year bound): ended on the build day', { ...good, supportMonth: '0000-01', today: on(2027, 3, 15) }, ended('0000-01')],
    ['a stamp of 9999-12 never ends: on 9999-12-31 still the age reminder', { ...good, supportMonth: '9999-12', today: last }, age(95673)],
    // The bounds across a year end: 36 months after the later day, 6 months after the build day and the dismissal.
    ['stamp 2027-12: on 2030-12-31, 36 months after its end, still ended', { ...good, supportMonth: '2027-12', today: on(2030, 12, 31) }, ended('2027-12')],
    ['stamp 2027-12: on 2031-01-01, long ago (the age from the build day)', { ...good, supportMonth: '2027-12', today: on(2031, 1, 1) }, longAgo('2027-12', 45)],
    ['a build day that is the support end, on that day: age 0, none', { ...good, buildDate: '2027-06-30T00:00:00Z', supportMonth: '2027-06', today: on(2027, 6, 30) }, null],
    ['a build day after the support end: 36 months after the build day, still ended', { ...good, buildDate: '2027-07-01T00:00:00Z', supportMonth: '2027-06', today: on(2030, 7, 1) }, ended('2027-06')],
    ['a build day after the support end: the day after that bound, long ago', { ...good, buildDate: '2027-07-01T00:00:00Z', supportMonth: '2027-06', today: on(2030, 7, 2) }, longAgo('2027-06', 36)],
    ['built on 30 November: 6 months on 30 May', { ...good, buildDate: '2027-11-30T00:00:00Z', today: on(2028, 5, 30) }, age(6)],
    ['built on 31 December: on 29 June, 5 months, none', { ...good, buildDate: '2027-12-31T00:00:00Z', today: on(2028, 6, 29) }, null],
    ['built on 31 December: on 30 June, 6 months', { ...good, buildDate: '2027-12-31T00:00:00Z', today: on(2028, 6, 30) }, age(6)],
    ['dismissed on 15 December: shown again on 15 June', { ...good, today: on(2029, 6, 15), dismissed: { 'UPD-AGE-REMINDER': on(2028, 12, 15) } }, age(27)],
    ['dismissed on 15 December: still hidden on 14 June', { ...good, today: on(2029, 6, 14), dismissed: { 'UPD-AGE-REMINDER': on(2028, 12, 15) } }, null]
  ])('%s', (_label, input, expected) => {
    expect(supportNotice(input as SupportInput)).toStrictEqual(expected)
  })
})

// Record §8.4 "The function": never throws, for any argument at all; an argument whose reading throws gives no notice
// (T6.4a review A m1, G1). Each input below otherwise gives the age reminder, so the reading it breaks is reached.
describe('supportNotice: an argument whose reading throws gives no notice, never an error (record §8.4, "The function")', () => {
  const thrower = (): never => {
    throw new Error('a reading that throws')
  }
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return proxy
  }
  it.each<[string, () => unknown]>([
    ['a getter on the input (buildDate) that throws', () => ({ ...good, get buildDate() { return thrower() } })],
    ['a getter for today that throws', () => ({ ...good, get today() { return thrower() } })],
    ['a getter for today.year that throws', () => ({ ...good, today: { month: 6, day: 20, get year() { return thrower() } } })],
    ['a getter for dismissed that throws (the notice found reads it)', () => ({ ...good, get dismissed() { return thrower() } })],
    ['a revoked Proxy as the input', revoked],
    ['a revoked Proxy as today', () => ({ ...good, today: revoked() })],
    ['a revoked Proxy as dismissed', () => ({ ...good, dismissed: revoked() })],
    ['a Proxy as the input whose getOwnPropertyDescriptor and has traps throw', () => new Proxy({ ...good }, { getOwnPropertyDescriptor: thrower, has: thrower })]
  ])('%s: null', (_label, make) => {
    expect(supportNotice(make() as SupportInput)).toBeNull()
  })
})

// Record §8.4 "Inputs": support.ts imports nothing, so it repeats payload.ts's `issued` check (§2.4) and kit-support.ts's
// month check; one fixed list of texts holds each copy to its twin (T6.4a review A m3). This test imports main's
// modules; support.ts never does (the syntax-tree row below).
describe("support.ts's two grammar checks answer as their twins in main (record §8.4, \"Inputs\")", () => {
  const TEXTS: readonly string[] = [
    // `issued`-shaped
    '2027-03-15T09:30:00Z', '2000-01-01T00:00:00Z', '9999-12-31T23:59:59Z', '2027-03-15T23:59:59Z', '2027-04-30T09:30:00Z',
    '2028-02-29T09:30:00Z', '2000-02-29T00:00:00Z', '2400-02-29T00:00:00Z', '2027-02-29T09:30:00Z', '2100-02-29T00:00:00Z',
    '1999-12-31T23:59:59Z', '0000-01-01T00:00:00Z', '2027-03-15T24:00:00Z', '2027-03-15T09:60:00Z', '2027-03-15T09:30:60Z',
    '2027-00-15T09:30:00Z', '2027-13-15T09:30:00Z', '2027-03-00T09:30:00Z', '2027-03-32T09:30:00Z', '2027-04-31T09:30:00Z',
    '2027-03-15t09:30:00Z', '2027-03-15T09:30:00z', '2027-03-15T09:30:00.000Z', '2027-03-15T10:30:00+01:00', '2027-03-15T09:30:00',
    '2027-03-15', '2027-3-15T09:30:00Z', '12027-03-15T09:30:00Z', ' 2027-03-15T09:30:00Z', '2027-03-15T09:30:00Z ',
    '2027-03-15T09:30:00Z\n', '2027-03-15T09:30:00Z\r\n', 'x\n2027-03-15T09:30:00Z', '2027-03-15T09:30:00Z\nx',
    '\u{FEFF}2027-03-15T09:30:00Z', '2027-03-1\u{0665}T09:30:00Z', '2027-03-1\u{FF15}T09:30:00Z', '',
    // stamp-shaped (no 9999-12: that stamp never ends, so whether it reads shows in no answer)
    '2027-06', '2027-01', '2027-12', '0000-01', '9999-11', '2027-00', '2027-13', '2027-6', '202-06', '12027-06',
    ' 2027-06', '2027-06 ', '2027-06\n', '2027-06\r\n', 'x\n2027-06', '2027-06\nx', '\u{FEFF}2027-06', '2027-0\u{FF16}',
    '2027-0\u{0666}', '2027/06', '2027-06-01'
  ]
  const lastDay = { year: 9999, month: 12, day: 31 }
  /** With a stamp long ended and today the last real day, every build date that reads gives a notice; one that does not gives none. */
  const buildDateReads = (text: string): boolean => supportNotice({ buildDate: text, supportMonth: '2000-01', today: lastDay, dismissed: null }) !== null
  /** With a build date in 2000 and today the last real day, a stamp that reads replaces the age reminder; one that does not leaves it. */
  const stampReads = (text: string): boolean =>
    supportNotice({ buildDate: '2000-01-01T00:00:00Z', supportMonth: text, today: lastDay, dismissed: null })?.code !== 'UPD-AGE-REMINDER'

  it("the build date reads exactly when payload.ts's parseIssued reads the text", () => {
    expect(TEXTS.map((t) => [t, buildDateReads(t)])).toStrictEqual(TEXTS.map((t) => [t, parseIssued(t) !== null]))
  })

  it("the stamp reads exactly when kit-support.ts's isSupportMonth reads the text", () => {
    expect(TEXTS.map((t) => [t, stampReads(t)])).toStrictEqual(TEXTS.map((t) => [t, isSupportMonth(t)]))
  })
})

// Record §8.4 "The function": pure, importing nothing, reading no clock, no file and no storage, so the renderer (PR-6b's
// Home and Settings notices) and main may both call it. Read from the syntax tree: an import declaration, a re-export
// from a module, an import() call, a require() or import.meta anywhere in the file breaks the rule (T6.4a review A m2).
// So does any free name (a name the file uses as a value or a type without declaring it) outside a short allowed list:
// a clock, the host, its storage or the network can only be reached by such a name (Date, Temporal, process, document,
// fetch, globalThis, ...), so the row needs no list of them to keep current (T6.4a re-check minor 3). eval and Function
// run text as code, so they fail whatever the allowed list says. What no name can show: Math.random(), state kept at
// module level between calls, a constructor reached through a value (the re-check's limits; the file is reviewed on
// every change).
describe('support.ts imports nothing and reads no clock, host or storage (record §8.4, "The function")', () => {
  /** The free names support.ts uses as committed: four standard objects, `undefined`, and three standard types. */
  const ALLOWED: ReadonlySet<string> = new Set(['Array', 'Math', 'Number', 'Object', 'undefined', 'Partial', 'Readonly', 'Record'])
  /** Text run as code: never allowed. */
  const NEVER: ReadonlySet<string> = new Set(['eval', 'Function'])

  /** The file's free names, each once: resolved by TypeScript's checker over this file alone (no lib, no import), so a
   *  name the file declares (in any scope it is used in) is bound and every other one is free. A member's name after a
   *  dot is no free name; a shorthand property is the value it names. */
  const freeNames = (source: ts.SourceFile): string[] => {
    const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = () => source
    const checker = ts.createProgram({ rootNames: [source.fileName], options, host }).getTypeChecker()
    const free = new Set<string>()
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isQualifiedName(n.parent) && n.parent.right === n) && !ts.isMetaProperty(n.parent)) {
        const symbol = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n)
        if (!(symbol?.declarations ?? []).some((d) => d.getSourceFile() === source)) free.add(n.text)
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
    return [...free].sort()
  }

  it('holds no import, no export from a module, no import(), no require(), no import.meta, no free name but Array, Math, Number, Object, undefined, Partial, Readonly and Record, and never eval or Function', () => {
    const file = join(DESKTOP_ROOT, 'src', 'shared', 'updates', 'support.ts')
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const found: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) found.push(n.getText(source))
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) found.push(n.getText(source))
      else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
        found.push(n.getText(source))
      } else if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) found.push(n.getText(source))
      ts.forEachChild(n, visit)
    }
    visit(source)
    for (const name of freeNames(source)) if (!ALLOWED.has(name) || NEVER.has(name)) found.push(`free name ${name}`)
    expect(found).toEqual([])
  })
})
