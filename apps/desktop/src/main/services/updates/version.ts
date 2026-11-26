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

// ---- The update version rule (app-update F-4, G-19 (b); docs/app-updates.md §2.5; T4.2). Release 1 applies it to every
// update for ever. It stays here, beside the order it uses, and keeps this file free of value imports: the release tools
// and the no-hook load row of updates-version.test.ts load it as it is. Its refusal is declared below in the shape of
// shared/updates/types.ts's UPD-SAME-OR-OLDER (payload.ts hands it on as that type, so the typecheck holds the two).

/** A root app as the version rule reads it: `rootApps`' RootApp (drive-release.ts) fits. */
export interface VersionRuleApp {
  readonly kind: 'file' | 'folder' | 'other'
  /** The version its name carries byte for byte, or null (a root `*.app` folder, a name of no known version). */
  readonly version: string | null
}

/** UPD-SAME-OR-OLDER with §2.10's parameters, each the text as written. */
export interface VersionRuleRefusal {
  readonly code: 'UPD-SAME-OR-OLDER'
  /** `driveVersion`: the drive's `app_version` that counted, or null when none counted (a stale one included). */
  readonly params: { readonly version: string; readonly runningVersion: string; readonly driveVersion: string | null }
}

/** The rule's answer, with `staleDriveVersion` (a flag for `update.log`, P6, CF-44) on both arms. */
export type VersionRuleResult =
  | { readonly accepted: true; readonly staleDriveVersion: boolean }
  | { readonly accepted: false; readonly refusal: VersionRuleRefusal; readonly staleDriveVersion: boolean }

/**
 * F-4 (record §2.5, "The version rule's values"): `version` is accepted when it is above `running` in SemVer 2.0.0 order
 * and, where the drive's `app_version` counts, not below it (equal passes); else UPD-SAME-OR-OLDER. `driveAppVersion` is
 * `driveAppVersion(readDriveRelease(root))`; a value that does not parse counts as null (F-13: invalid is absent). It
 * counts when a root app carries it byte for byte, when a root `*.app` folder exists (its version is unknown), or when
 * `rootApps` is null (the root could not be listed: without the evidence the floor stays). Otherwise it is stale:
 * treated as absent, and `staleDriveVersion` is set. A root file of no known version keeps nothing. `highest_version_seen`
 * is no input. Pure; never throws.
 */
export function checkVersionRule(
  version: Semver,
  running: Semver,
  driveAppVersion: string | null,
  rootApps: readonly VersionRuleApp[] | null
): VersionRuleResult {
  const drive = parseSemver(driveAppVersion)
  const counts = drive !== null && (rootApps === null || rootApps.some((app) => app.version === drive.text || app.kind === 'folder'))
  const floor = counts ? drive : null
  const staleDriveVersion = drive !== null && !counts
  if (compareSemver(version, running) > 0 && (floor === null || compareSemver(version, floor) >= 0)) {
    return { accepted: true, staleDriveVersion }
  }
  const params = { version: version.text, runningVersion: running.text, driveVersion: floor === null ? null : floor.text }
  return { accepted: false, refusal: { code: 'UPD-SAME-OR-OLDER', params }, staleDriveVersion }
}

// ---- The OS floors (app-update G-24; record §2.4, "A floor's grammar", "Comparing"; T4.2)

/** A floor, or a host value read as one, is at most this many bytes. */
export const FLOOR_MAX_BYTES = 64

/** One or more components joined by single dots, each 1 to 9 ASCII digits (nine keep every integer exact). */
const FLOOR = /^[0-9]{1,9}(?:\.[0-9]{1,9})*$/

/**
 * A floor's components as integers (a leading zero means nothing: `07` is 7), or null for anything outside the grammar:
 * no space, sign, letter or empty component, at most 64 bytes, a string only. The payload's `win32`, `darwin` and
 * `linux` values and the host's own values (the system version, the runtime glibc) are read alike. Never throws.
 */
export function parseFloor(text: unknown): readonly number[] | null {
  if (typeof text !== 'string' || text.length > FLOOR_MAX_BYTES || !FLOOR.test(text)) return null
  return text.split('.').map(Number)
}

/** Component by component as integers, a missing component counting 0, the first difference deciding: true when `host` equals or exceeds `floor`. */
export function meetsFloor(host: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < Math.max(host.length, floor.length); i++) {
    const h = host[i] ?? 0
    const f = floor[i] ?? 0
    if (h !== f) return h > f
  }
  return true
}
