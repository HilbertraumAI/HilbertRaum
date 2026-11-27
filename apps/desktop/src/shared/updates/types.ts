// The typed verdicts of an update file's envelope, payload and version rule (app-update F-1–F-4; docs/app-updates.md
// §2.10; Δ-75 row 17): a reference code of §5.8 with its parameters, never copy and never an address. P6 joins the
// address to the running version where the copy lives, and adds the catalog keys in the pull request whose code reads
// them. Types only: the modules that use them (envelope.ts, and T4.2's payload check) are loaded by the release tools
// through Node's own type stripping, which erases an `import type` and could not resolve a value import from here.
//
// Every parameter is text exactly as the payload, the host or the policy wrote it, never normalised (a floor `07.1`
// stays `07.1`), and holds no path and no user text.

/** A system as Node's `process.platform` spells it. */
export type UpdateSystem = 'win32' | 'darwin' | 'linux'

/** The parameters of a code that has none. */
export type NoParams = Readonly<Record<string, never>>

/** A refusal. The first failing check in §4.5's order decides. */
export type UpdateRefusal =
  | { readonly code: 'UPD-NOT-AVAILABLE'; readonly params: NoParams }
  | { readonly code: 'UPD-TOO-NEW'; readonly params: { readonly runningVersion: string } }
  | { readonly code: 'UPD-FILE-DAMAGED'; readonly params: NoParams }
  | { readonly code: 'UPD-NOT-GENUINE'; readonly params: NoParams }
  | { readonly code: 'UPD-UNKNOWN-SIGNER'; readonly params: { readonly runningVersion: string } }
  | { readonly code: 'UPD-FOR-NEWER-HILBERTRAUM'; readonly params: { readonly runningVersion: string } }
  | { readonly code: 'UPD-NOT-AN-UPDATE'; readonly params: NoParams }
  | { readonly code: 'UPD-WRONG-CHANNEL'; readonly params: NoParams }
  | { readonly code: 'UPD-NEEDS-IN-BETWEEN'; readonly params: { readonly runningVersion: string; readonly minUpgradeFrom: string } }
  | {
      readonly code: 'UPD-SAME-OR-OLDER'
      /** `driveVersion`: the drive's `app_version` that counted, or null when none counted (a stale one included). */
      readonly params: { readonly version: string; readonly runningVersion: string; readonly driveVersion: string | null }
    }
  | {
      readonly code: 'UPD-ABOVE-MAX-VERSION'
      /** `maxVersion`: the parsed cap's `text`. */
      readonly params: { readonly version: string; readonly maxVersion: string }
    }
  | { readonly code: 'UPD-CANT-CHECK-LINUX-FLOOR'; readonly params: { readonly runningVersion: string } }
  | {
      readonly code: 'UPD-OS-TOO-OLD'
      /** `hostVersion`: as the host gave it. */
      readonly params: { readonly runningVersion: string; readonly system: UpdateSystem; readonly floor: string; readonly hostVersion: string }
    }

export type UpdateRefusalCode = UpdateRefusal['code']

/** The envelope's refusals (§2.3); a verified envelope is no verdict of its own, it hands its payload bytes on. */
export type EnvelopeRefusal = Extract<
  UpdateRefusal,
  {
    code:
      | 'UPD-NOT-AVAILABLE'
      | 'UPD-TOO-NEW'
      | 'UPD-FILE-DAMAGED'
      | 'UPD-NOT-GENUINE'
      | 'UPD-UNKNOWN-SIGNER'
      | 'UPD-FOR-NEWER-HILBERTRAUM'
      | 'UPD-NOT-AN-UPDATE'
  }
>

/** The address set (Δ-75 row 7): each carries `runningVersion`, from which P6 builds `<address>/from/<running version>`. */
export type AddressSetCode =
  | 'UPD-TOO-NEW'
  | 'UPD-NEEDS-IN-BETWEEN'
  | 'UPD-UNKNOWN-SIGNER'
  | 'UPD-OS-TOO-OLD'
  | 'UPD-CANT-CHECK-LINUX-FLOOR'
  | 'UPD-FOR-NEWER-HILBERTRAUM'

/** One system's floor, as the payload wrote it. */
export interface SystemFloor {
  readonly system: UpdateSystem
  readonly floor: string
}

/** The warnings and the confirmation, with an accepted payload only. */
export type UpdateNotice =
  /** `floors`: one per system, in the order `win32`, `darwin`, `linux`. */
  | { readonly code: 'UPD-OTHER-SYSTEM-FLOOR'; readonly params: { readonly floors: readonly SystemFloor[] } }
  | { readonly code: 'UPD-ISSUED-IN-FUTURE'; readonly params: { readonly issued: string } }
  /** The confirmation: one explicit answer before staging. */
  | { readonly code: 'UPD-OLD-FILE'; readonly params: { readonly issued: string } }

/**
 * The four flags. The three user-visible ones are set with an accepted payload only; `staleDriveVersion` (no code: a
 * flag for `update.log`, P6, CF-44) with every verdict from the version rule on, accepted or refused.
 */
export interface UpdateFlags {
  /** Empty for none. */
  readonly otherSystemFloors: readonly SystemFloor[]
  readonly issuedInFuture: boolean
  readonly oldFile: boolean
  readonly staleDriveVersion: boolean
}

/** A `files[]` entry of an accepted payload. */
export interface AcceptedFile {
  readonly name: string
  readonly size: number
  /** Lower-cased. */
  readonly sha256: string
  readonly group: string | null
  readonly installAs: string | null
}

/** An accepted payload. */
export interface AcceptedPayload {
  readonly version: string
  readonly issued: string | null
  /** The `summary` text shown (the UI language's, else `en`'s), or null. */
  readonly summary: string | null
  /** In payload order. */
  readonly files: readonly AcceptedFile[]
  readonly flags: UpdateFlags
}

/**
 * The payload check's refusals (§2.4, §2.5, §2.6), the version rule's included: the first failing check in §4.5's order
 * decides (format, product, kind, channel, version, min_upgrade_from, the version rule, updates.max_version, requires,
 * files[]).
 */
export type PayloadRefusal = Extract<
  UpdateRefusal,
  {
    code:
      | 'UPD-TOO-NEW'
      | 'UPD-NOT-AN-UPDATE'
      | 'UPD-FOR-NEWER-HILBERTRAUM'
      | 'UPD-WRONG-CHANNEL'
      | 'UPD-NEEDS-IN-BETWEEN'
      | 'UPD-SAME-OR-OLDER'
      | 'UPD-ABOVE-MAX-VERSION'
      | 'UPD-CANT-CHECK-LINUX-FLOOR'
      | 'UPD-OS-TOO-OLD'
  }
>
