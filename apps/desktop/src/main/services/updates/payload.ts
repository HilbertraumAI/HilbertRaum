// The update file's signed payload (app-update W-2, W-63, W-75; F-2, F-4, F-18's names; docs/app-updates.md §2.4, §2.5,
// §2.6, §2.10, §4.3, §4.4, §4.5): what a verified envelope's payload bytes say, read as release 1 reads them for ever.
// One pure function holds §4.5's whole payload order, the first failing check deciding: the reading, `format`,
// `product`, `kind` (W-63's "for a newer HilbertRaum"), `channel`, `version`, `min_upgrade_from`, the version rule
// (version.ts), the policy's cap, `requires` (the Linux form, the Windows and macOS forms, then this system's floor),
// `issued` (never a refusal), `files[]`; then what an accepted payload shows: the date notices, W-75's `summary` and
// the other systems' floors. Unknown fields are ignored, so a later writer's file stays readable (F-2).
//
// What it does not check: the update file's container, its header walk and the members' hashes (P6, §4.3, §4.5); "each
// `group` present whole or absent whole" and this computer's apply script (P6); the path length and free space (P6).
// `install_as`, `group` and `role` are text it never uses as a path; `summary` is plain text for P6 to show as text;
// `sha256` is only lower-cased here, P6 compares it with the bytes it hashes.
//
// Its type asks for the verified arm of verifyEnvelope's result; that the bytes it is handed were verified is the
// caller's duty, since any code can build that arm (T4.4d m-3; CF-51: P6 adds one row that the code reading an update
// file hands it only verifyEnvelope's own result, in the same turn as the verification). It takes every host value as
// an argument (the running version, the policy's cap, the drive's `app_version` and root apps, the system and its
// version, glibc, the clock, the UI language): the release tools (P5's check-draft, W-53's reader snapshot) run it on
// the owner's computer, not on a Kit. They load it through Node's own type stripping with the sibling-import hook,
// so it imports only its siblings and types, and holds only TypeScript that stripping can erase.

import { readJsonObject } from './envelope'
import type { EnvelopeResult } from './envelope'
import { isReleaseVersion } from './drive-release'
import type { RootApp } from './drive-release'
import { checkVersionRule, compareSemver, meetsFloor, parseFloor, parseSemver } from './version'
import type { Semver } from './version'
import { hasFoldedDuplicate, isMemberName } from './member-name'
import type { AcceptedFile, AcceptedPayload, PayloadRefusal, SystemFloor, UpdateSystem } from '../../../shared/updates/types'

/** `format`: release 1 reads 1; a later writer writes 2 only for a payload release 1 must refuse (§2.4). */
export const PAYLOAD_FORMAT = 1

/** `product`: every HilbertRaum payload keeps it, whatever its `kind` (§2.4, §2.9: a format constant). */
export const PAYLOAD_PRODUCT = 'hilbertraum'

/** `kind`: the one kind release 1 installs; any other is a file for a newer HilbertRaum (W-63, G-30). */
export const RELEASE_KIND = 'release'

/** `channel`: the one channel release 1 accepts (G-22, §2.6). */
export const STABLE_CHANNEL = 'stable'

/** At most this many `files[]` entries (§4.3, "Member count"). */
export const FILES_MAX_ENTRIES = 4096

/** The largest member: ustar's 11 octal digits (§4.3, "Size"). */
export const MEMBER_SIZE_MAX = 8_589_934_591

/** A `summary` text counts at 1 to this many Unicode code points (§2.4; owner 2026-11-26). */
export const SUMMARY_MAX_CODE_POINTS = 400

/** `issued` more than this far ahead of the clock gives UPD-ISSUED-IN-FUTURE (24 hours, §2.4). */
export const ISSUED_FUTURE_MS = 86_400_000

/** `issued` more than this far behind the clock gives UPD-OLD-FILE (365 days, §2.4). */
export const ISSUED_OLD_MS = 31_536_000_000

/** A verified envelope (§2.10: no verdict of its own): its payload bytes as they were signed. */
export type VerifiedEnvelope = Extract<EnvelopeResult, { verified: true }>

/**
 * The host the payload is checked on (record §10.7's `host`, one to one; `now` in milliseconds). P6 reads each value
 * once per import: `runningVersion` the app's own version, parsed; `maxVersion` `readUpdatePolicy(configDir).maxVersion`;
 * `driveAppVersion` `driveAppVersion(readDriveRelease(root))`; `rootApps` `rootApps(root)`, or null when it threw;
 * `osVersion` `process.getSystemVersion()` on Windows and macOS, a string even when it is outside the floor grammar
 * (the T4.2 sheet's Q3); `glibc` `process.report.getReport().header.glibcVersionRuntime` on Linux, null when absent;
 * `now` `Date.now()`; `uiLanguage` one of release 1's ten codes.
 */
export type PayloadInput = {
  readonly runningVersion: Semver
  readonly driveAppVersion: string | null
  readonly rootApps: readonly RootApp[] | null
  readonly maxVersion: Semver | null
  readonly now: number
  readonly uiLanguage: string
} & (
  | { readonly os: 'win32' | 'darwin'; readonly osVersion: string; readonly glibc: null }
  | { readonly os: 'linux'; readonly osVersion: null; readonly glibc: string | null }
)

/** The verdict (§2.10): an accepted payload with its flags, or the first refusal with `staleDriveVersion`. */
export type PayloadResult =
  | { readonly accepted: true; readonly payload: AcceptedPayload }
  | {
      readonly accepted: false
      readonly refusal: PayloadRefusal
      /** Set from the version rule on (CF-44): false for a refusal before it. */
      readonly staleDriveVersion: boolean
    }

/** The order `requires`' forms are checked in (§2.4, "A floor that breaks it"). */
const FORM_ORDER: readonly UpdateSystem[] = ['linux', 'win32', 'darwin']

/** The order of the other systems' floors in UPD-OTHER-SYSTEM-FLOOR (§2.10). */
const NOTICE_ORDER: readonly UpdateSystem[] = ['win32', 'darwin', 'linux']

const SHA256_HEX = /^[0-9A-Fa-f]{64}$/

/** `YYYY-MM-DDTHH:MM:SSZ`, ASCII digits, upper-case `T` and `Z`, no fraction, no offset. */
const ISSUED_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/

// ---- JSON as release 1 reads it (the envelope's reader, §2.3; these two are envelope.ts's own one-liners, which it
// keeps unexported)

/** A JSON object: never an array, never null. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own key's value; a key reached through the prototype is no key (an own `__proto__` key is an unknown one). */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/** A version as the payload's `version` and `min_upgrade_from` must be: SemVer 2.0.0, at most 64 bytes (F-13's bound). */
function releaseVersion(value: unknown): Semver | null {
  return isReleaseVersion(value) ? parseSemver(value) : null
}

// ---- the advisory fields

/**
 * `issued` (§2.4) as milliseconds since 1970-01-01T00:00:00Z, or null: exactly `YYYY-MM-DDTHH:MM:SSZ`, naming a real
 * time from the year 2000 to 9999 (a day that exists in its month of the Gregorian calendar, hour 00–23, minute and
 * second 00–59, so no leap second). Anything else, a non-string included, is no date. Never throws.
 */
export function parseIssued(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const m = ISSUED_TEXT.exec(text)
  if (m === null) return null
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = month === 2 ? (leap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** A `summary` value that counts: a string of 1 to 400 code points without a lone surrogate; else null (ignored). */
function summaryValue(value: unknown): string | null {
  // More than 800 UTF-16 units is more than 400 code points, so a long value is never split.
  if (typeof value !== 'string' || value.length === 0 || value.length > 2 * SUMMARY_MAX_CODE_POINTS || !value.isWellFormed()) return null
  return [...value].length <= SUMMARY_MAX_CODE_POINTS ? value : null
}

/**
 * The `summary` text shown (§2.4, W-75): the UI language's value when it counts, else `en`'s when it counts, else
 * null. A `summary` that is no object, a key of another language and a value that does not count are ignored, never an
 * error. Only those two own keys are ever read, so no language list is needed here. Never throws.
 */
export function summaryText(summary: unknown, uiLanguage: string): string | null {
  if (!isObject(summary)) return null
  return summaryValue(own(summary, uiLanguage)) ?? summaryValue(own(summary, 'en'))
}

// ---- files[] (§2.4, §4.3, §4.4)

/**
 * `files[]` as release 1 reads it, or null for UPD-TOO-NEW: an own array of 0 to 4,096 objects, each with a `name` by
 * the member-name rule, a `size` that is a safe integer from 0 to 8,589,934,591 (the value `JSON.parse` gives, so `1e3`
 * and `1.0` pass), a `sha256` of 64 hex characters in either case (lower-cased here), a `group` absent or a string of
 * at least one character; no two names equal after the A–Z fold. `install_as` becomes `installAs` when it is a string,
 * else null, and never refuses; `role` is never read.
 */
function readFiles(payload: Record<string, unknown>): AcceptedFile[] | null {
  const files = own(payload, 'files')
  if (!Array.isArray(files) || files.length > FILES_MAX_ENTRIES) return null
  const out: AcceptedFile[] = []
  for (const entry of files as unknown[]) {
    if (!isObject(entry)) return null
    const name = own(entry, 'name')
    const size = own(entry, 'size')
    const sha256 = own(entry, 'sha256')
    if (!isMemberName(name)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MEMBER_SIZE_MAX) return null
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
    let group: string | null = null
    if (Object.hasOwn(entry, 'group')) {
      const value = entry.group
      if (typeof value !== 'string' || value.length === 0) return null
      group = value
    }
    const installAs = own(entry, 'install_as')
    out.push({ name, size, sha256: sha256.toLowerCase(), group, installAs: typeof installAs === 'string' ? installAs : null })
  }
  // Uniqueness is member-name.ts's rule (table A.3), imported, never copied (CF-45).
  return hasFoldedDuplicate(out.map((file) => file.name)) ? null : out
}

/**
 * §5.9's support details: the `files[]` of a verified envelope (the applied one, `updates/applied/<running>.dsse.json`),
 * read exactly as checkPayload reads them, without the version rule or any other check; null when the payload or its
 * `files[]` does not read (the support line then says `not checked`). Never throws.
 */
export function readPayloadFiles(envelope: VerifiedEnvelope): readonly AcceptedFile[] | null {
  const payload = readJsonObject(envelope.payload)
  return payload === null ? null : readFiles(payload)
}

// ---- the payload check

/**
 * F-2 and F-4 (record §2.4, §2.5, §2.10), in §4.5's order, the first failing check deciding: the reading (§2.3's
 * reader over the verified bytes; failure is UPD-TOO-NEW, never damage), `format` 1, `product`, `kind`, `channel`,
 * `version`, `min_upgrade_from`, the version rule, `updates.max_version` (`input.maxVersion`), `requires` (a `linux`
 * value outside the floor grammar is UPD-CANT-CHECK-LINUX-FLOOR on every system, a `win32` or `darwin` one UPD-TOO-NEW,
 * in that order, then this system's floor), `issued` (never a refusal), `files[]`. Every parameter is the text as the
 * payload, the host or the policy wrote it. Pure: no disk, no clock, no process state; never throws.
 */
export function checkPayload(envelope: VerifiedEnvelope, input: PayloadInput): PayloadResult {
  const runningVersion = input.runningVersion.text
  const refuse = (refusal: PayloadRefusal, staleDriveVersion = false): PayloadResult => ({ accepted: false, refusal, staleDriveVersion })
  const tooNew = (staleDriveVersion = false): PayloadResult => refuse({ code: 'UPD-TOO-NEW', params: { runningVersion } }, staleDriveVersion)

  const payload = readJsonObject(envelope.payload)
  if (payload === null) return tooNew()
  if (own(payload, 'format') !== PAYLOAD_FORMAT) return tooNew()
  if (own(payload, 'product') !== PAYLOAD_PRODUCT) return refuse({ code: 'UPD-NOT-AN-UPDATE', params: {} })
  if (own(payload, 'kind') !== RELEASE_KIND) return refuse({ code: 'UPD-FOR-NEWER-HILBERTRAUM', params: { runningVersion } })
  if (own(payload, 'channel') !== STABLE_CHANNEL) return refuse({ code: 'UPD-WRONG-CHANNEL', params: {} })
  const version = releaseVersion(own(payload, 'version'))
  if (version === null) return tooNew()
  if (Object.hasOwn(payload, 'min_upgrade_from')) {
    const min = releaseVersion(payload.min_upgrade_from)
    if (min === null) return tooNew()
    if (compareSemver(min, input.runningVersion) > 0) {
      return refuse({ code: 'UPD-NEEDS-IN-BETWEEN', params: { runningVersion, minUpgradeFrom: min.text } })
    }
  }

  // From the version rule on, every verdict carries its staleDriveVersion (§2.10, "The flags").
  const rule = checkVersionRule(version, input.runningVersion, input.driveAppVersion, input.rootApps)
  const stale = rule.staleDriveVersion
  if (!rule.accepted) return refuse(rule.refusal, stale)
  if (input.maxVersion !== null && compareSemver(version, input.maxVersion) > 0) {
    return refuse({ code: 'UPD-ABOVE-MAX-VERSION', params: { version: version.text, maxVersion: input.maxVersion.text } }, stale)
  }

  const floors = new Map<UpdateSystem, string>()
  if (Object.hasOwn(payload, 'requires')) {
    const requires = payload.requires
    if (!isObject(requires)) return tooNew(stale)
    for (const system of FORM_ORDER) {
      if (!Object.hasOwn(requires, system)) continue
      const floor = requires[system]
      if (parseFloor(floor) === null) {
        return system === 'linux' ? refuse({ code: 'UPD-CANT-CHECK-LINUX-FLOOR', params: { runningVersion } }, stale) : tooNew(stale)
      }
      floors.set(system, floor as string) // parseFloor reads strings only
    }
  }
  const ownFloor = floors.get(input.os)
  if (ownFloor !== undefined) {
    const hostVersion = input.os === 'linux' ? input.glibc : input.osVersion
    const host = parseFloor(hostVersion)
    // On Linux a glibc that is absent or outside the grammar cannot be checked (fail closed); on Windows and macOS a
    // host value outside the grammar meets no floor (fail closed as well), and is carried as the host gave it.
    if (host === null && input.os === 'linux') return refuse({ code: 'UPD-CANT-CHECK-LINUX-FLOOR', params: { runningVersion } }, stale)
    if (host === null || !meetsFloor(host, parseFloor(ownFloor)!)) {
      // `?? ''` only for a caller outside the type (a null osVersion on Windows or macOS): hostVersion stays a string.
      return refuse({ code: 'UPD-OS-TOO-OLD', params: { runningVersion, system: input.os, floor: ownFloor, hostVersion: hostVersion ?? '' } }, stale)
    }
  }

  const issuedText = own(payload, 'issued')
  const issuedAt = parseIssued(issuedText)

  const files = readFiles(payload)
  if (files === null) return tooNew(stale)

  const otherSystemFloors: SystemFloor[] = []
  for (const system of NOTICE_ORDER) {
    const floor = floors.get(system)
    if (system === input.os || floor === undefined) continue
    if (input.rootApps === null || input.rootApps.some((app) => app.system === system)) otherSystemFloors.push({ system, floor })
  }
  return {
    accepted: true,
    payload: {
      version: version.text,
      issued: issuedAt === null ? null : (issuedText as string),
      summary: summaryText(own(payload, 'summary'), input.uiLanguage),
      files,
      flags: {
        otherSystemFloors,
        issuedInFuture: issuedAt !== null && issuedAt - input.now > ISSUED_FUTURE_MS,
        oldFile: issuedAt !== null && input.now - issuedAt > ISSUED_OLD_MS,
        staleDriveVersion: stale
      }
    }
  }
}
