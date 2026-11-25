// Strict SemVer 2.0.0 (semver.org §2, §9, §10, §11): the grammar and the precedence order release 1 uses for
// `updates.max_version` for ever (F-8, docs/app-updates.md §8.1; the app-update wave's P3 entry decision 7). P4 extends this
// file with the update version rule (newer than the running app, not below `app_version`), and its release tools load it
// through Node's own type stripping: so this file imports nothing and holds only TypeScript that stripping can erase (no
// `enum`, no namespace, no parameter property). tests/unit/updates-version.test.ts loads it that way.
//
// What it accepts (O-10 of the T3.1 sheet; fail closed): exactly `MAJOR.MINOR.PATCH`, each `0` or a digit string without
// a leading zero; an optional `-` pre-release of dot-separated identifiers, each ASCII `[0-9A-Za-z-]`, a numeric one
// without a leading zero; an optional `+` build of such identifiers (a leading zero allowed). No `v`, no blank, no range,
// nothing outside ASCII, at most 256 characters. Numbers are compared as digit strings, never through `Number()`, which
// cannot tell 9007199254740993 from 9007199254740992 (O-11).

/** A parsed SemVer 2.0.0 version. The numbers stay digit strings, so any length compares exactly. */
export interface Semver {
  /** The text it was parsed from, exactly as written. */
  readonly text: string
  readonly major: string
  readonly minor: string
  readonly patch: string
  /** The pre-release identifiers, in order; empty for a release. */
  readonly prerelease: readonly string[]
  /** The build metadata identifiers; they take no part in the order (§10). */
  readonly build: readonly string[]
}

/** The longest version text accepted (npm's semver limit; semver.org's FAQ calls 255 "probably overkill"). */
export const SEMVER_MAX_LENGTH = 256

const IDENTIFIER = /^[0-9A-Za-z-]+$/
const DIGITS = /^[0-9]+$/

/** `0`, or digits without a leading zero. */
function isNumber(s: string): boolean {
  return DIGITS.test(s) && (s === '0' || s[0] !== '0')
}

/** A pre-release identifier: alphanumeric (holds a letter or `-`), or a number without a leading zero. */
function isPrereleaseIdentifier(s: string): boolean {
  return IDENTIFIER.test(s) && (!DIGITS.test(s) || isNumber(s))
}

/** Parse a SemVer 2.0.0 version, or `null` for anything else (a value that is not a string included). */
export function parseSemver(text: unknown): Semver | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > SEMVER_MAX_LENGTH) return null
  const plus = text.indexOf('+')
  const main = plus < 0 ? text : text.slice(0, plus)
  const dash = main.indexOf('-')
  const core = (dash < 0 ? main : main.slice(0, dash)).split('.')
  if (core.length !== 3 || !core.every(isNumber)) return null
  const prerelease = dash < 0 ? [] : main.slice(dash + 1).split('.')
  if (!prerelease.every(isPrereleaseIdentifier)) return null
  const build = plus < 0 ? [] : text.slice(plus + 1).split('.')
  if (!build.every((id) => IDENTIFIER.test(id))) return null
  return { text, major: core[0], minor: core[1], patch: core[2], prerelease, build }
}

/** Two digit strings without leading zeros, as numbers: the longer is larger, then digit by digit. */
function compareNumbers(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Two pre-release identifiers (§11.4): numbers as numbers, below any alphanumeric one; those in ASCII order. */
function compareIdentifiers(a: string, b: string): number {
  const aNumber = DIGITS.test(a)
  const bNumber = DIGITS.test(b)
  if (aNumber && bNumber) return compareNumbers(a, b)
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer 2.0.0 precedence: -1 when `a` is below `b`, 1 when above, 0 when equal (build metadata ignored). */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  const core = compareNumbers(a.major, b.major) || compareNumbers(a.minor, b.minor) || compareNumbers(a.patch, b.patch)
  if (core !== 0) return core < 0 ? -1 : 1
  // A release is above every pre-release of itself (§11.3).
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < shared; i++) {
    const order = compareIdentifiers(a.prerelease[i], b.prerelease[i])
    if (order !== 0) return order < 0 ? -1 : 1
  }
  // Every shared identifier equal: the longer set is above (§11.4.4).
  return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length < b.prerelease.length ? -1 : 1
}
