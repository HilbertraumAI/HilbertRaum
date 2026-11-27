// The codes of an update import that P6 adds, and the verdicts of the update file container (app-update P6; F-16's
// reader side, F-5; docs/app-updates.md §3.5 "The types", §4.5, §4.7, §5.8): a reference code of §5.8 with its
// parameters, never copy and never an address, beside P4's union in ./types, which stays as it is. P6's channels add
// their argument and answer shapes here (T6.3). Types only: the reader (main/services/updates/bundle.ts) is loaded by
// the release tools through Node's own type stripping, which erases a type-only use of this file and could not resolve
// a value taken from it.
//
// Every parameter is a number or text the reader or the service computed or the payload wrote, never a path and never
// user text.

import type { AcceptedFile, AcceptedPayload, EnvelopeRefusal, NoParams, PayloadRefusal, UpdateRefusal } from './types'

/**
 * P6's twelve refusal codes (§3.5 "The types"; table B.9). `UPD-DRIVE-FULL` carries the bytes the free-space check
 * needed and the free bytes it counted (integers from 0 to 2^53 - 1), both null after an ENOSPC; `UPD-NOT-A-DRIVE` the
 * running version, for the address. The other ten have none.
 */
export type ImportOnlyRefusal =
  | { readonly code: 'UPD-DOWNLOAD-INCOMPLETE'; readonly params: NoParams }
  | { readonly code: 'UPD-NO-HELPER'; readonly params: NoParams }
  | { readonly code: 'UPD-PATH-TOO-LONG'; readonly params: NoParams }
  | { readonly code: 'UPD-DRIVE-READ-ONLY'; readonly params: NoParams }
  | { readonly code: 'UPD-FILE-TOO-BIG-FOR-DRIVE'; readonly params: NoParams }
  | { readonly code: 'UPD-CANT-READ-FILE'; readonly params: NoParams }
  | { readonly code: 'UPD-CANT-WRITE-DRIVE'; readonly params: NoParams }
  | { readonly code: 'UPD-IN-PROGRESS'; readonly params: NoParams }
  | { readonly code: 'UPD-POLICY-MANAGED'; readonly params: NoParams }
  | { readonly code: 'UPD-POLICY-INVALID'; readonly params: NoParams }
  | { readonly code: 'UPD-DRIVE-FULL'; readonly params: { readonly requiredBytes: number | null; readonly freeBytes: number | null } }
  | { readonly code: 'UPD-NOT-A-DRIVE'; readonly params: { readonly runningVersion: string } }

export type ImportOnlyRefusalCode = ImportOnlyRefusal['code']

/** Every refusal an import answers: P4's of the envelope, the payload and the version rule, and P6's twelve. */
export type ImportRefusal = UpdateRefusal | ImportOnlyRefusal

export type ImportRefusalCode = ImportRefusal['code']

/** The start-up sweep's notice (§3.5 "The sweep's notice, once"): a staged update it found damaged on the drive. */
export interface DamagedOnDriveNotice {
  readonly code: 'UPD-FILE-DAMAGED-ON-DRIVE'
  readonly params: NoParams
}

/**
 * The thrown error behind a refusal an I/O error gave, for `update.log`'s `err` and `syscall` (§4.5, the events of an
 * update import): the error's own `code` and `syscall`, each null when it is no string. The log's formatter checks each value
 * against its token rule; nothing here is a message or a path.
 */
export interface ImportIoCause {
  readonly code: string | null
  readonly syscall: string | null
}

/**
 * The update file's refusals up to the data pass (§4.5's order from the file's open to this system's apply script):
 * the open, the `HRUPDATE` prefix, member 0's header, the envelope (§2.3), the payload and the version rule (§2.4,
 * §2.5), the header walk (§4.3) and the apply script (§4.4).
 */
export type ContainerRefusal =
  | EnvelopeRefusal
  | PayloadRefusal
  | Extract<ImportOnlyRefusal, { code: 'UPD-DOWNLOAD-INCOMPLETE' | 'UPD-NO-HELPER' | 'UPD-CANT-READ-FILE' }>

/** The data pass's refusals (§4.5 "Where a member is written", "Errors while staging"; §4.3 "Then the data pass"). */
export type StagingRefusal = Extract<
  ImportRefusal,
  { code: 'UPD-FILE-DAMAGED' | 'UPD-DRIVE-FULL' | 'UPD-FILE-TOO-BIG-FOR-DRIVE' | 'UPD-CANT-READ-FILE' | 'UPD-CANT-WRITE-DRIVE' }
>

/**
 * What a read of the update file had learned when it ended, for the run's `update.log` line (§4.5's events):
 * `payload` once the payload check accepted it (the line's `version`), `staleDriveVersion` once the payload check ran,
 * either arm (`stale_drive_version`, CF-44); null before.
 */
export interface ContainerFacts {
  readonly payload: AcceptedPayload | null
  readonly staleDriveVersion: boolean | null
}

/** A read of the update file that ended before the data pass: refused at the first failing check, or cancelled. */
export type ContainerEnd = (
  | { readonly kind: 'refused'; readonly refusal: ContainerRefusal; readonly cause: ImportIoCause | null }
  | { readonly kind: 'cancelled' }
) &
  ContainerFacts

/**
 * The data pass's answer: every member present staged under `<v>/files/` (`files`: their `files[]` entries, in
 * `files[]` order, each hashed as written and equal to its `sha256`), or refused, or cancelled. A refusal and a cancel
 * leave whatever was written in the two folders the caller named, for the caller to remove (§4.5 "A refusal or a cancel
 * from the data pass on").
 */
export type StagingEnd =
  | { readonly kind: 'staged'; readonly files: readonly AcceptedFile[] }
  | { readonly kind: 'refused'; readonly refusal: StagingRefusal; readonly cause: ImportIoCause | null }
  | { readonly kind: 'cancelled' }
