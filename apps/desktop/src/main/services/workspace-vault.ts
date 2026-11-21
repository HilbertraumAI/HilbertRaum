import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fsyncSync
} from 'node:fs'
import { open as openFileAsync, rename as renameAsync, rm as rmAsync, stat as statAsync } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { freeBytesSync } from './disk-space'
import { causeFailure, type CauseFailure } from './failure-for-log'
import { tMain } from './i18n'
import { canonicalLeafFor } from './ingestion/stored-copy-leaf'
import { perfMark, perfMs } from './perf'
import type { Db } from './db'
import {
  checkpointLeftoverWal,
  isWorkspaceNewerError,
  openDatabase,
  probeDatabaseFile,
  sqliteJudgedDamaged,
  walAwaitsCheckpoint,
  type DatabaseFileProbe,
  type WalCheckpointRetry
} from './db'
import { seedSettings, updateSettings } from './settings'
import type { PrivacyPolicy, WorkspaceMode, WorkspaceStateInfo } from '../../shared/types'
import {
  type EncryptedBlob,
  type KdfParams,
  DEFAULT_KDF,
  decrypt,
  deriveKey,
  encrypt,
  generateDataKey,
  generateSalt,
  makeVerifier,
  verifyKey,
  classifyFrameMagic,
  isKnownKdfAlgo,
  newerFrameError,
  VaultNewerError,
  type VaultNewerWhat,
  BLOB_MAGIC,
  BLOB_IV_BYTES,
  BLOB_TAG_BYTES
} from './security/crypto'

// The vault-format refusal (#845) lives beside the frame reader in security/crypto.ts (deserializeBlob throws it);
// the vault's callers import it from here, with the other vault errors.
export { VaultNewerError, isVaultNewerError, type VaultNewerWhat } from './security/crypto'

// Workspace vault: the lock/unlock lifecycle for the encrypted workspace (spec §7.9).
//
// `node:sqlite` has no SQLCipher, so we encrypt the WHOLE database FILE at rest: the
// at-rest artifact is `hilbertraum.sqlite.enc`. On unlock we derive the key, verify
// the password against a small authenticated verifier, decrypt the blob to the working
// file `hilbertraum.sqlite` ON THE DRIVE, and open it normally. On lock/quit we checkpoint +
// close, re-encrypt the working file back to `.enc`, then shred the plaintext copy.
//
// The password + derived key live ONLY in memory. The on-disk descriptor
// (`config/workspace.json`, UNENCRYPTED) holds just enough to know a password is
// required, which KDF/params to use, the salt, and an authenticated verifier — never
// the password or key. This is the only thing the app can read BEFORE unlocking, since
// the settings (incl. `workspaceMode`) live inside the encrypted DB.

/** Legacy descriptor format: data encrypted directly under the password-derived key. */
export const VAULT_VERSION = 1
/**
 * Envelope format: a random 32-byte DATA key encrypts the DB + every sidecar class
 * (documents, image history, legacy out-of-store copies, the rotated log — see
 * `listVaultKeyCiphertexts`); the password-derived key (KEK) only WRAPS it in the descriptor.
 * A password change then re-wraps one blob (O(1)) instead of re-encrypting the corpus.
 * New vaults are created v2; v1 vaults migrate on their FIRST password change (never on
 * unlock — a vault that never changes its password is never touched).
 */
export const VAULT_VERSION_ENVELOPE = 2

/** Suffix marking an encrypted stored document copy under `workspace/documents/`. */
export const ENCRYPTED_DOC_SUFFIX = '.enc'

/** Serialized form of an EncryptedBlob in the descriptor JSON. */
interface SerializedBlob {
  ivB64: string
  tagB64: string
  ciphertextB64: string
}

/** Unencrypted vault descriptor persisted at `config/workspace.json`. */
export interface VaultDescriptor {
  version: number
  mode: 'encrypted'
  kdf: KdfParams
  saltB64: string
  /** AES-256-GCM verifier: a known plaintext under the derived key (password check). */
  verifier: SerializedBlob
  /**
   * v2 envelope only: the random DATA key wrapped (AES-256-GCM) by the password-derived
   * KEK. Like the verifier this is ciphertext — the data key itself never touches disk.
   */
  dataKey?: SerializedBlob
}

/** Resolved file locations the vault works with. */
export interface VaultPaths {
  /** `config/workspace.json` — the unencrypted descriptor. */
  descriptorPath: string
  /** `workspace/hilbertraum.sqlite.enc` — the encrypted-at-rest database. */
  encPath: string
  /** `workspace/hilbertraum.sqlite` — the decrypted working file (present only while unlocked). */
  dbPath: string
  /** `logs/` — where the encrypted diagnostics log rotates its previous generation; optional
   *  so the v1→v2 rekey can account for that ciphertext too (#241). Absent in older callers. */
  logsPath?: string
}

/** Thrown by `unlockEncryptedVault` when the password fails the verifier. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect workspace password')
    this.name = 'WrongPasswordError'
  }
}

/**
 * Thrown by `WorkspaceController.lock()` when re-encrypting the vault fails (realistically
 * ENOSPC: during lock the plaintext DB + old `.enc` + new `.enc.tmp` coexist, so each lock
 * needs ~DB-size free space — plausible on a nearly-full USB stick). Content-free ON
 * PURPOSE: the IPC layer maps it to friendly localized copy (`main.workspace.lockFailed`).
 * When this is thrown the controller has already restored itself to a consistent UNLOCKED
 * state (plaintext DB re-opened, key kept), so retrying lock after freeing space is safe.
 * full-audit 2026-07-11 CODE-1a.
 *
 * #956 (S-5): it keeps WHAT caused it (`failure`: where a lock that judged the working file stopped, and the cause's
 * kind, Node code, bare system call and SQLite's fixed description), never the cause's message, which names the
 * drive's paths. Before, the log line said only "Could not lock the workspace", and the `ENOSPC` support needs was lost.
 */
export class VaultLockError extends Error {
  /** What caused the refused lock, content-free, for the log (`failureForLog` spreads it into the line). */
  readonly failure: CauseFailure & { stopped: LockStoppedError['reason'] | null }
  constructor(cause?: unknown) {
    super('Could not lock the workspace')
    this.name = 'VaultLockError'
    // A lock that judged the working file wraps what failed in a `LockStoppedError`: its stage, then the error inside.
    const stopped = cause instanceof LockStoppedError ? cause : null
    const inner = stopped !== null && stopped.cause !== undefined ? stopped.cause : cause
    this.failure = { stopped: stopped?.reason ?? null, ...causeFailure(inner) }
  }
}

/**
 * Thrown by `unlockEncryptedVault` when the password is CORRECT (verifier passed) but `.enc`
 * fails its GCM tag (#860 V5b: only changed bytes can fail it then — bit rot, a cut-short
 * copy, tampering; the lock writes `.enc` by temp + rename, so it is never torn by us), or
 * when its tag authenticated but SQLite finds the decrypted bytes are not a database, or a
 * corrupt one (#844: any other open failure is `VaultOpenFailedError`) —
 * the vault ciphertext itself is damaged (issue #208: the app had re-encrypted a
 * shred-survivor of random noise over the good `.enc`, so every layer of crypto verified
 * and only `openDatabase` could tell). Structurally NOT a password problem: the IPC layer
 * must surface it as its own `vault_damaged` result (backup/recovery guidance), never as
 * the wrong-password copy — three releases telling the reporter "check your password" is
 * what nearly buried the forensic evidence. The decrypted non-database working file is
 * shredded before this is thrown (the shred-on-failure in `decryptFile` covers only TAG
 * failures; without this, noise — or, for a merely-corrupt real database, authentic
 * plaintext user data — stayed on disk while the workspace reported locked).
 */
export class VaultDamagedError extends Error {
  /** Which damage (content-free, for the log; the user copy is `vault_damaged`'s either way): `.enc` failed its
   *  authentication after the password verified (#860 V5b), or it decrypted to something SQLite calls not a database
   *  or corrupt (#208). */
  readonly damage: 'failed-authentication' | 'not-a-database'
  constructor(damage: 'failed-authentication' | 'not-a-database' = 'not-a-database') {
    super(
      damage === 'failed-authentication'
        ? 'The workspace data failed its authentication check after the password verified — the vault is damaged'
        : 'The workspace decrypted but is not a database — the vault is damaged'
    )
    this.name = 'VaultDamagedError'
    this.damage = damage
  }
}

/**
 * Thrown by `unlockEncryptedVault` when the password is CORRECT and the decrypted file is a
 * database SQLite does not call damaged, yet opening it failed (#844): one of the open's
 * upgrade steps (the schema, an `ensureColumn`, a backfill) or the unlock's own settings writes
 * could not finish, through a full drive, an I/O error or a bug in a new step. The failed open
 * never rewrites `.enc` (the working copy is shredded like any failure after the decrypt; a
 * `.recovery` roll-forward earlier in the same unlock may already have replaced it with that
 * fresher snapshot, in the same format), so this is not damage,
 * and the IPC layer must not show `vault_damaged`'s "restore from a backup": it maps this to
 * `vault_open_failed` (free space and retry; after an update, the previous version still opens
 * the vault).
 *
 * It keeps only WHAT failed (`failure`), never the cause itself: a backfill's error can quote what
 * it was reading (a JSON parse error quotes its input), and app.log never carries document text.
 */
export class VaultOpenFailedError extends Error {
  /** The cause's kind and Node error code (`ERR_SQLITE_ERROR`, `ENOSPC`, …), and SQLite's own
   *  result code and fixed description: content-free, for the log. */
  readonly failure: { kind: string; code: string | null; sqliteCode: number | null; sqlite: string | null }
  constructor(cause: unknown) {
    super('The workspace decrypted to a database, but opening it failed')
    this.name = 'VaultOpenFailedError'
    const c = cause as { name?: unknown; code?: unknown; errcode?: unknown; errstr?: unknown } | null | undefined
    this.failure = {
      kind: typeof c?.name === 'string' ? c.name : typeof cause,
      code: typeof c?.code === 'string' ? c.code : null,
      sqliteCode: typeof c?.errcode === 'number' ? c.errcode : null,
      sqlite: typeof c?.errstr === 'string' ? c.errstr : null
    }
  }
}

/** What a failure of the unlock's open, or of its own settings writes, is thrown as (#208, #247,
 *  #844): a newer build's database as itself, SQLite's damage verdict as `VaultDamagedError`, and
 *  anything else as `VaultOpenFailedError`. */
function openFailure(err: unknown): unknown {
  if (isWorkspaceNewerError(err)) return err
  return sqliteJudgedDamaged(err) ? new VaultDamagedError() : new VaultOpenFailedError(err)
}

/**
 * Thrown by `WorkspaceController.unlock()` while the startup salvage is BLOCKED (#242): a
 * working file newer than `.enc` — the only fresh copy of the last session's data — could
 * not be moved aside as `.recovery`, because another program holds the spent `.recovery`
 * already sitting on that name (a Windows AV/indexer hold refusing the overwrite, the
 * unlink and the rename). `init()` then skips the crash sweep, and an unlock must not
 * proceed either: decrypting the stale `.enc` would land on top of that fresh file.
 * Content-free ON PURPOSE (like `VaultLockError`): the IPC layer maps it to the
 * `vault_recovery_blocked` result + `main.workspace.recoveryBlocked`. The retry is simply
 * the next unlock — `unlock()` re-runs the salvage first, so it clears once the hold is gone.
 */
export class VaultRecoveryBlockedError extends Error {
  constructor() {
    super('A recovery file is held by another program; the workspace cannot be opened safely yet')
    this.name = 'VaultRecoveryBlockedError'
  }
}

/**
 * Thrown by `unlockEncryptedVault` when the password is CORRECT (the verifier is in the descriptor, so it is checked
 * without `.enc`) but the encrypted workspace file is gone (#911: a stat of it says ENOENT) and no `.recovery` copy was
 * rolled forward over it. Something outside the app removed it (a person tidying the drive, a sync tool, a disk check
 * that moved it to `FOUND.000`); the app itself never does. Neither `.enc` nor the working file is written (a spent or
 * damaged `.recovery` the unlock found is shredded first: with no `.enc`, no unlock could use it). Content-free ON PURPOSE (like
 * `VaultLockError`): the IPC layer maps it to `vault_missing` + `main.workspace.vaultMissing` (put the file back or
 * restore the workspace folder from a backup; never create a new workspace). Before #911 this was the raw ENOENT of the
 * decrypt, which read "Could not open the workspace." on every try.
 */
export class VaultMissingError extends Error {
  /** The unlock shredded a kept `.recovery` that could not be restored (its structure is damaged), for the log. */
  readonly keptCopyDiscarded: boolean
  constructor(keptCopyDiscarded = false) {
    super('The password verified, but the encrypted workspace file is missing')
    this.name = 'VaultMissingError'
    this.keptCopyDiscarded = keptCopyDiscarded
  }
}

/**
 * Thrown by a `DocumentCipher` closure invoked AFTER `lock()` zeroed the vault key
 * (full-audit 2026-07-12 SEC-1). The closures re-read the live key per invocation, so a
 * cipher captured by an in-flight import fails CLOSED when "Lock now" lands mid-job —
 * previously it kept "working" against the in-place-zeroed key Buffer and encrypted the
 * document sidecar under 32 zero bytes. Content-free ON PURPOSE (like `VaultLockError`):
 * every consumer already treats a cipher failure as that document/task failing, so this
 * surfaces as the ordinary failed-row path, never raw to the user.
 */
export class VaultLockedError extends Error {
  constructor() {
    super('The workspace is locked')
    this.name = 'VaultLockedError'
  }
}

/**
 * Thrown when a password change and document work (import/re-index, which writes `.enc`
 * sidecars) would overlap — either operation refuses to START while the other runs, so
 * a sidecar is never written under a key that is being swapped out.
 * The message is user-facing (shown verbatim in the UI).
 */
export class VaultBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultBusyError'
  }
}

/**
 * Thrown by `WorkspaceController.create()` when a workspace is already on the drive (a vault descriptor, the `.enc`, an
 * unreadable descriptor beside an `.enc`, or a newer build's artifact; #954: any `config/workspace.json` file, read live,
 * so one put back while the lock screen was open counts too; an unreadable one with no `.enc` is
 * `VaultDescriptorUnreadableError` instead), and by `createEncryptedVaultOnDisk` when `.enc` or a descriptor file is
 * there, at its start and again right before its commit: a new vault would replace the user's data, or the key file
 * that opens it, with an empty one. `create()`'s refusal writes nothing (review V F-1). Content-free ON PURPOSE (like
 * `VaultLockError`): the IPC
 * layer maps it to `workspace_exists` + `main.workspace.exists`, and the lock screen renders that reason in its own
 * language (#807; before, the IPC matched this English text and the gate showed it as it was).
 */
export class WorkspaceExistsError extends Error {
  constructor() {
    super('A workspace already exists on this drive; refusing to create a new one over it')
    this.name = 'WorkspaceExistsError'
  }
}

/**
 * Thrown by `WorkspaceController.create()` for a `plaintext_dev` create that the policy or the build does not allow
 * (`plaintextAllowed`). Content-free ON PURPOSE: the IPC layer maps it to `plaintext_not_allowed` +
 * `main.workspace.plaintextNotAllowed` (#807). The gate offers the plaintext switch only when it is allowed, so only a
 * direct IPC call reaches it.
 */
export class PlaintextNotAllowedError extends Error {
  constructor() {
    super('A plaintext workspace is not permitted by policy')
    this.name = 'PlaintextNotAllowedError'
  }
}

/**
 * Thrown by `unlockEncryptedVault` when the encrypted workspace file is on the drive but its descriptor
 * (`config/workspace.json`: the salt, the KDF parameters, the verifier and the wrapped data key) is missing or cannot be
 * read, so no password can open it. Thrown before any password check (the verifier is in that file) and before anything
 * is written. Content-free ON PURPOSE: the IPC layer maps it to `vault_descriptor_missing` +
 * `main.workspace.descriptorMissing` (put the file back or restore it from a backup; never create a new workspace).
 * Before #807 (C-S2) this was a plain English `Error`, which read "Could not open the workspace." on every try.
 */
export class VaultDescriptorMissingError extends Error {
  constructor() {
    super(
      'The workspace descriptor (config/workspace.json) is missing or unreadable, so the encrypted workspace cannot be ' +
        'unlocked'
    )
    this.name = 'VaultDescriptorMissingError'
  }
}

/**
 * Thrown by `unlockEncryptedVault` when `config/workspace.json` is on the drive but cannot be read (not JSON, a field
 * missing, or a UTF-8 byte-order mark in front of it) and the encrypted workspace file is NOT beside it (#955 item 1):
 * no password can open anything here, yet the drive is not empty of a workspace either (a `.recovery` copy, a staged
 * `.enc.new` or stored documents may be under the key that file holds), so the create flow stays refused too.
 * Thrown before any password check and before anything is written. Content-free ON PURPOSE: the IPC layer maps it to
 * `vault_descriptor_unreadable` + `main.workspace.descriptorUnreadable` (don't delete the key file; restore both files
 * from a backup). Before #955 this was a plain English `Error`, which read "Could not open the workspace." on every
 * try. With `.enc` present the same file is `VaultDescriptorMissingError`'s; with a stat of `.enc` that fails other
 * than ENOENT, neither is proven, and the unlock fails as before (review V F-4). `WorkspaceController.create()` throws
 * it too, for such a file that appeared under its create form (review V F-3): the create answers what the unlock would.
 */
export class VaultDescriptorUnreadableError extends Error {
  constructor() {
    super(
      'The workspace descriptor (config/workspace.json) cannot be read and no encrypted workspace file is beside it, ' +
        'so nothing can be unlocked'
    )
    this.name = 'VaultDescriptorUnreadableError'
  }
}

/** Derive the vault file locations from the resolved workspace paths. */
export function vaultPathsFrom(paths: { configPath: string; dbPath: string; logsPath?: string }): VaultPaths {
  return {
    descriptorPath: join(paths.configPath, 'workspace.json'),
    encPath: `${paths.dbPath}.enc`,
    dbPath: paths.dbPath,
    ...(paths.logsPath ? { logsPath: paths.logsPath } : {})
  }
}

function blobToJson(b: EncryptedBlob): SerializedBlob {
  return {
    ivB64: b.iv.toString('base64'),
    tagB64: b.tag.toString('base64'),
    ciphertextB64: b.ciphertext.toString('base64')
  }
}

function blobFromJson(s: SerializedBlob): EncryptedBlob {
  return {
    iv: Buffer.from(s.ivB64, 'base64'),
    tag: Buffer.from(s.tagB64, 'base64'),
    ciphertext: Buffer.from(s.ciphertextB64, 'base64')
  }
}

/**
 * The value of a `version` field as a number (#845): a finite number, or a string holding a decimal number (`"3"`,
 * `"2.5"`); null for anything else. Shipped builds compare `version` with `>=`, which JavaScript applies to such a
 * string and to a fraction alike, so every numeric value above a known version must count as newer, integer or not.
 */
function numericVersion(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v)
  return null
}

/**
 * What `config/workspace.json` holds (#845): no file (`absent`), a file that does not parse or lacks a field this
 * build needs (`unreadable`, e.g. a v2 without its wrapped data key), a format a NEWER build wrote (`newer`), or a
 * descriptor this build reads (`ok`).
 */
export type VaultDescriptorRead =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'newer'; what: Extract<VaultNewerWhat, 'descriptor' | 'kdf'>; found: string | number }
  | { kind: 'ok'; descriptor: VaultDescriptor }

/**
 * Read and classify the descriptor (#845). A numeric `version` above the highest this build knows (a number, integer
 * or not, or a numeric string) is `newer` BEFORE any shape check: shipped builds read a v3 without `dataKey` as
 * unreadable and one with `dataKey` as v2, and a password change then rewrote it as v2. A `version` that is a string
 * holding no number (`"3.0.0"`) is `unreadable`: no build wrote one, and read as v1 it had a staged password change
 * discarded. A descriptor of a known version naming a KDF this build does not know is `newer` too (its derive would
 * fail). Anything else keeps the shape rules every shipped build applied, so a descriptor a published release wrote
 * reads `ok` exactly as before (tests/fixtures/vault-golden).
 */
export function readVaultDescriptorChecked(descriptorPath: string): VaultDescriptorRead {
  if (!existsSync(descriptorPath)) return { kind: 'absent' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch {
    return { kind: 'unreadable' }
  }
  if (!raw || typeof raw !== 'object') return { kind: 'unreadable' }
  const d = raw as VaultDescriptor
  const rawVersion: unknown = d.version
  const version = numericVersion(rawVersion)
  if (version !== null && version > VAULT_VERSION_ENVELOPE) {
    return { kind: 'newer', what: 'descriptor', found: typeof rawVersion === 'string' ? rawVersion.slice(0, 40) : version }
  }
  if (typeof rawVersion === 'string' && version === null) return { kind: 'unreadable' }
  if (d.mode !== 'encrypted' || !d.kdf || !d.saltB64 || !d.verifier) return { kind: 'unreadable' }
  // A v2 (envelope) descriptor without its wrapped data key is corrupt, not unlockable.
  if (d.version >= VAULT_VERSION_ENVELOPE && !d.dataKey) return { kind: 'unreadable' }
  // So is a wrapped data key under a version that is not a v2's (missing, null, 0, 1): no build ever wrote a v1 with
  // `dataKey`, and read as v1 the password's key opens no data, so the unlock would call the DATA damaged when only
  // this file needs restoring (W2 review 2).
  if (d.dataKey && !(version !== null && version >= VAULT_VERSION_ENVELOPE)) return { kind: 'unreadable' }
  // Any `kdf.algo` this build cannot derive with (`KDF_ALGOS`) was written by a newer build.
  const algo: unknown = d.kdf.algo
  if (typeof algo === 'string' && !isKnownKdfAlgo(algo)) {
    return { kind: 'newer', what: 'kdf', found: algo.slice(0, 40) }
  }
  return { kind: 'ok', descriptor: d }
}

/** Read the descriptor, or null if there is none this build can unlock (absent, unreadable or newer). The
 *  back-compat face of `readVaultDescriptorChecked` for callers that only need the descriptor. */
export function readVaultDescriptor(descriptorPath: string): VaultDescriptor | null {
  const read = readVaultDescriptorChecked(descriptorPath)
  return read.kind === 'ok' ? read.descriptor : null
}

/**
 * True when a descriptor FILE exists but cannot be parsed/validated. This must be kept
 * distinct from "no vault yet": a corrupt 200-byte JSON file must NOT make the app
 * report `uninitialized` and offer the create flow, which would overwrite the intact
 * `.enc` (all user data) with a fresh empty vault. A descriptor a NEWER build wrote (#845)
 * counts too: it is a vault, just not one this build can open.
 */
export function isDescriptorUnreadable(descriptorPath: string): boolean {
  return existsSync(descriptorPath) && readVaultDescriptor(descriptorPath) === null
}

/** The rekey journal version every shipped build writes (`RekeyJournal.version`). */
const REKEY_JOURNAL_VERSION = 1

/**
 * The version digit of the frame at `path` when its first 8 bytes are a frame a newer build wrote (#845), else null
 * (another frame, absent, or unreadable: then it is not judged newer, and whatever reads it next fails on it as it
 * always did). Reads 8 bytes. Shared by the vault format verdict and the diagnostics log (`logging.ts`); the frame
 * rules themselves live in security/crypto.ts, which stays free of file I/O.
 */
export function newerFrameAt(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const head = Buffer.alloc(BLOB_MAGIC.length)
    const fd = openSync(path, 'r')
    try {
      const got = head.subarray(0, readSync(fd, head, 0, head.length, 0))
      return classifyFrameMagic(got) === 'newer' ? String(newerFrameError(got).found) : null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** The rekey journal's `version` field as written, or undefined (no journal, or one that does not parse). */
function rekeyJournalVersion(vaultPaths: VaultPaths): unknown {
  const path = rekeyJournalPath(vaultPaths)
  if (!existsSync(path)) return undefined
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown } | null)?.version
  } catch {
    return undefined
  }
}

/** The vault format verdict (#845): `ok`, or the first artifact a newer build wrote. */
export type VaultFormatVerdict = { kind: 'ok' } | { kind: 'newer'; what: VaultNewerWhat; found: string | number }

/**
 * Is any vault artifact in a format a NEWER build wrote (#845)? Read-only, and independent of the password: the
 * descriptor (a numeric `version` above 2, or an unknown `kdf.algo`), the rekey journal (a numeric `version` above 1,
 * whatever the descriptor says: shipped builds roll staged files forward under any v2 descriptor, so a newer build's
 * uncommitted stage would be swapped in under a key that exists nowhere), and the frames of `.enc` and of every staged
 * file a recovery would swap in (`stagedRekeyFiles`: `.enc.new`, `documents/` and `images/` `*.enc.new` by scan, and
 * the journal's entries; `HRAUMEN` + a digit 2–9, read from the first 8 bytes of each: a staged
 * file is swapped in before any decrypt would notice). A foreign magic of another family (`PAIDENC1`) is not newer.
 * Runs before ANY write: at the head of `WorkspaceController.init()` (the startup salvage, sweep and rekey recovery)
 * and of `unlockEncryptedVault`.
 */
export function vaultFormatVerdict(vaultPaths: VaultPaths): VaultFormatVerdict {
  const descriptor = readVaultDescriptorChecked(vaultPaths.descriptorPath)
  if (descriptor.kind === 'newer') return { kind: 'newer', what: descriptor.what, found: descriptor.found }
  const journal = rekeyJournalVersion(vaultPaths)
  const journalVersion = numericVersion(journal)
  if (journalVersion !== null && journalVersion > REKEY_JOURNAL_VERSION) {
    return { kind: 'newer', what: 'journal', found: typeof journal === 'string' ? journal.slice(0, 40) : journalVersion }
  }
  for (const path of [vaultPaths.encPath, ...stagedRekeyFiles(vaultPaths)]) {
    const found = newerFrameAt(path)
    if (found !== null) return { kind: 'newer', what: 'frame', found }
  }
  return { kind: 'ok' }
}

/** Persist the descriptor atomically (write temp + fsync + rename). The rename is the
 *  single commit point of the password-change journal, so the temp is fsynced
 *  first — a descriptor must never land half-written after a power cut. */
export function writeVaultDescriptor(descriptorPath: string, d: VaultDescriptor): void {
  const tmp = `${descriptorPath}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, Buffer.from(JSON.stringify(d, null, 2), 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, descriptorPath)
}

// ---- file-level crypto + hygiene -------------------------------------------------
//
// These MUST stream in bounded chunks: reading the whole file into one Buffer hits
// Node's ~2 GiB Buffer/IO ceilings — a workspace DB past that size could no longer be
// locked (shutdown would silently leave plaintext on disk) or re-opened. The streaming
// versions write the EXACT same on-disk frame (`MAGIC | iv | tag | ciphertext`), so
// existing vaults are unaffected.
//
// SYNC vs ASYNC (PERF-1, full-audit-2026-06-29 follow-up, Phase 3). Two flavours exist;
// both produce/consume the IDENTICAL on-disk frame (cross-verified by the vault tests), so a
// file written by either decrypts with either:
//   • `encryptFile`/`decryptFile` (SYNC) — the original `readSync`/`writeSync` loop. Used by the
//     DB-`.enc` lifecycle (create/unlock/lock/checkpoint/rekey) and the crash-only lock, which
//     must run to completion BEFORE `process.exit` in the `uncaughtException` handler (an async
//     lock can't finish before exit → committed in-session data would be lost). They take a raw
//     key; the vault's `DocumentCipher` no longer exposes them (#687). NOT the per-import freeze.
//   • `encryptFileAsync`/`decryptFileAsync` (ASYNC) — the same loop on `fs.promises` FileHandles,
//     awaiting each chunk so it YIELDS to the event loop between chunks (AES-GCM `update` on an
//     8 MiB chunk is sub-ms). Used by the document-CACHE import/re-index/preview/OCR path — the
//     "freeze on every import" PERF-1 targets (a large scanned PDF over USB, paid twice in an
//     encrypted workspace) — AND, since audit 2026-07-16 F-12, the image-history store/open path
//     (see below), AND, since DB-7, the text/original export readers. They are the only pair the
//     vault's `DocumentCipher` exposes (#687). DIVERGENCE from the audit's "convert the vault loop"
//     wording: rather than make the shared functions async-in-place (which cascades into the DB
//     lock/unlock/rekey lifecycle + the synchronous crash-lock — the highest-stakes, most-tested code,
//     with a real vault-corruption blast radius the audit itself flagged), we ADDED async siblings used
//     by the actual per-import harm and left the session-boundary DB lifecycle on the sync functions.
//     See architecture.md §35.
//
//   SUPERSEDE (audit 2026-07-16 F-12, 2026-07-17): the "image-history via the vision emitter stays on
//   the SYNC path" carve-out above is RETIRED. On an encrypted workspace, storing/opening/deleting a
//   ~20 MiB image ran ~60 MiB of sync fs+crypto+shred on the main thread AT the answer-complete moment
//   (freezing all IPC on the USB medium the product targets). The vision history now uses the async
//   cipher twins + `fs.promises` + `shredFileAsync` (below), and the analyze handler awaits the
//   persistence before firing `done` (so sessionId still rides the event). The sync `shredFile` stays
//   for the export readers' transients (and the other temp-file cleanups); the sync cipher stays for
//   the crash-lock / vault-lifecycle / rekey callers. See architecture.md §35.

/** Chunk size for streaming crypto + shredding. Bounds memory regardless of file size. */
export const FILE_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * Encrypt `srcPath` → `destPath` (atomic) with `key`. Streams; constant memory. SYNCHRONOUS —
 * blocks until done; see the section header for when to prefer {@link encryptFileAsync}.
 */
export function encryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const tmp = `${destPath}.tmp`
  const iv = randomBytes(BLOB_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const src = openSync(srcPath, 'r')
  let out: number | null = null
  try {
    out = openSync(tmp, 'w')
    // Header: MAGIC | iv | tag placeholder. GCM's tag is only known after the whole
    // stream is processed, so reserve its slot and patch it in at the end.
    writeSync(out, BLOB_MAGIC)
    writeSync(out, iv)
    const tagPos = BLOB_MAGIC.length + BLOB_IV_BYTES
    writeSync(out, Buffer.alloc(BLOB_TAG_BYTES))

    const buf = Buffer.alloc(FILE_CHUNK_BYTES)
    let bytes: number
    while ((bytes = readSync(src, buf, 0, buf.length, null)) > 0) {
      const ct = cipher.update(buf.subarray(0, bytes))
      if (ct.length > 0) writeSync(out, ct)
    }
    const fin = cipher.final()
    if (fin.length > 0) writeSync(out, fin)
    const tag = cipher.getAuthTag()
    writeSync(out, tag, 0, tag.length, tagPos)
    // full-audit 2026-07-11 CODE-10 — fsync BEFORE the atomic rename (the
    // writeVaultDescriptor idiom): without it, quit → unplug-without-eject on a
    // non-write-through mount can land the rename while the ciphertext blocks are still
    // in the OS cache, leaving `.enc` truncated AFTER the plaintext was already durably
    // shredded — GCM fails at the next unlock and the workspace is unrecoverable. One
    // fsync per whole-file encrypt (lock/create/rekey-stage/sidecar write) is cheap next
    // to the streaming encrypt itself.
    fsyncSync(out)
    closeSync(out)
    out = null
    renameSync(tmp, destPath)
  } catch (err) {
    if (out !== null) {
      try {
        closeSync(out)
      } catch {
        /* already closed */
      }
      out = null
    }
    // Walk round: best-effort, as `encryptFileAsync`'s is. A temp this cannot remove (a directory at its name, a hold)
    // threw `ERR_FS_EISDIR` from `rm` here and replaced the error being reported (an `open` EISDIR, an ENOSPC).
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the encrypt's own failure is the one that propagates */
    }
    throw err
  } finally {
    try {
      closeSync(src)
    } catch {
      /* already closed */
    }
    if (out !== null) closeSync(out)
  }
}

/**
 * Thrown by {@link decryptFile} when the frame's GCM tag does not verify under the key: a wrong key,
 * or bytes that changed after the frame was written. The unlock decrypts `.enc` only after the
 * password verified, so there it means damage (#860 V5b).
 */
export class FrameAuthError extends Error {
  constructor(cause: unknown) {
    super('The encrypted file failed its authentication check (wrong key, or its bytes changed)', { cause })
    this.name = 'FrameAuthError'
  }
}

/** instanceof PLUS the name — the production bundle can hold a second copy of this module. */
function isFrameAuthError(err: unknown): boolean {
  return err instanceof FrameAuthError || (err instanceof Error && err.name === 'FrameAuthError')
}

/**
 * Decrypt `srcPath` → `destPath` (atomic) with `key`. Streams; constant memory. Throws
 * `FrameAuthError` on a wrong key/tamper (GCM auth failure in `final()`); on failure the partial output
 * is shredded — note that callers verify the password against the descriptor verifier
 * BEFORE decrypting, so a wrong-key decrypt of the DB never happens in normal flow. A frame
 * a newer build wrote throws `VaultNewerError` before the output is opened (#845).
 */
export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const tmp = `${destPath}.tmp`
  const src = openSync(srcPath, 'r')
  let out: number | null = null
  try {
    const headerLen = BLOB_MAGIC.length + BLOB_IV_BYTES + BLOB_TAG_BYTES
    const header = Buffer.alloc(headerLen)
    const got = readSync(src, header, 0, headerLen, null)
    const magic = classifyFrameMagic(header.subarray(0, got))
    if (magic === 'newer') throw newerFrameError(header)
    if (got < headerLen) throw new Error('Encrypted blob is too short or corrupt')
    if (magic !== 'current') {
      throw new Error('Encrypted blob has an unrecognised header')
    }
    const iv = header.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + BLOB_IV_BYTES)
    const tag = header.subarray(BLOB_MAGIC.length + BLOB_IV_BYTES, headerLen)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    out = openSync(tmp, 'w')
    const buf = Buffer.alloc(FILE_CHUNK_BYTES)
    let bytes: number
    while ((bytes = readSync(src, buf, 0, buf.length, null)) > 0) {
      const pt = decipher.update(buf.subarray(0, bytes))
      if (pt.length > 0) writeSync(out, pt)
    }
    let fin: Buffer
    try {
      fin = decipher.final() // throws here on wrong key / tampered ciphertext
    } catch (err) {
      throw new FrameAuthError(err)
    }
    if (fin.length > 0) writeSync(out, fin)
    closeSync(out)
    out = null
    renameSync(tmp, destPath)
  } catch (err) {
    if (out !== null) {
      try {
        closeSync(out)
      } catch {
        /* already closed */
      }
      out = null
    }
    shredFile(tmp) // unauthenticated partial plaintext must not linger
    throw err
  } finally {
    try {
      closeSync(src)
    } catch {
      /* already closed */
    }
    if (out !== null) closeSync(out)
  }
}

/**
 * ASYNC twin of {@link encryptFile} (PERF-1): the SAME streaming AES-256-GCM loop on a
 * `fs.promises` FileHandle, awaiting each chunk read/write so it yields to the event loop
 * between chunks — a large document import no longer freezes the Electron main process/IPC.
 * Writes the byte-IDENTICAL frame (`MAGIC | iv | tag-placeholder | ciphertext`, with the GCM
 * tag patched into its reserved slot at `tagPos` AFTER `final()` via a positional write), so a
 * file written here decrypts via the sync path / in-memory blob path and vice versa.
 */
export async function encryptFileAsync(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  const tmp = `${destPath}.tmp`
  const iv = randomBytes(BLOB_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const src = await openFileAsync(srcPath, 'r')
  let out: Awaited<ReturnType<typeof openFileAsync>> | null = null
  try {
    out = await openFileAsync(tmp, 'w')
    // Header: MAGIC | iv | tag placeholder. GCM's tag is only known after the whole stream is
    // processed, so reserve its slot and patch it in at the end (same as the sync path).
    await out.write(BLOB_MAGIC, 0, BLOB_MAGIC.length, null)
    await out.write(iv, 0, iv.length, null)
    const tagPos = BLOB_MAGIC.length + BLOB_IV_BYTES
    await out.write(Buffer.alloc(BLOB_TAG_BYTES), 0, BLOB_TAG_BYTES, null)

    const buf = Buffer.alloc(FILE_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null)
      if (bytesRead <= 0) break
      const ct = cipher.update(buf.subarray(0, bytesRead))
      if (ct.length > 0) await out.write(ct, 0, ct.length, null)
    }
    const fin = cipher.final()
    if (fin.length > 0) await out.write(fin, 0, fin.length, null)
    const tag = cipher.getAuthTag()
    await out.write(tag, 0, tag.length, tagPos)
    // full-audit 2026-07-11 CODE-10 — fsync before the atomic rename, mirroring the sync
    // twin (see encryptFile): the frame must be durable before it lands under its final name.
    await out.sync()
    await out.close()
    out = null
    await renameAsync(tmp, destPath)
  } catch (err) {
    if (out !== null) {
      await out.close().catch(() => {})
      out = null
    }
    await rmAsync(tmp, { force: true }).catch(() => {})
    throw err
  } finally {
    await src.close().catch(() => {})
    if (out !== null) await out.close().catch(() => {})
  }
}

/**
 * ASYNC twin of {@link decryptFile} (PERF-1): the SAME streaming loop on `fs.promises`
 * FileHandles, yielding between chunks. Throws on a wrong key/tamper (GCM auth failure in
 * `final()`); on failure the partial output is shredded — note callers verify the password
 * against the descriptor verifier BEFORE decrypting, so a wrong-key decrypt never happens in
 * normal flow. Reads the byte-identical frame the sync path writes (and vice versa), and
 * throws `VaultNewerError` on a newer build's frame before the output is opened (#845). Its
 * tag failure stays Node's own error: no caller of this twin tells it apart.
 */
export async function decryptFileAsync(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  const tmp = `${destPath}.tmp`
  const src = await openFileAsync(srcPath, 'r')
  let out: Awaited<ReturnType<typeof openFileAsync>> | null = null
  try {
    const headerLen = BLOB_MAGIC.length + BLOB_IV_BYTES + BLOB_TAG_BYTES
    const header = Buffer.alloc(headerLen)
    const { bytesRead: got } = await src.read(header, 0, headerLen, null)
    const magic = classifyFrameMagic(header.subarray(0, got))
    if (magic === 'newer') throw newerFrameError(header)
    if (got < headerLen) throw new Error('Encrypted blob is too short or corrupt')
    if (magic !== 'current') {
      throw new Error('Encrypted blob has an unrecognised header')
    }
    const iv = header.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + BLOB_IV_BYTES)
    const tag = header.subarray(BLOB_MAGIC.length + BLOB_IV_BYTES, headerLen)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    out = await openFileAsync(tmp, 'w')
    const buf = Buffer.alloc(FILE_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null)
      if (bytesRead <= 0) break
      const pt = decipher.update(buf.subarray(0, bytesRead))
      if (pt.length > 0) await out.write(pt, 0, pt.length, null)
    }
    const fin = decipher.final() // throws here on wrong key / tampered ciphertext
    if (fin.length > 0) await out.write(fin, 0, fin.length, null)
    await out.close()
    out = null
    await renameAsync(tmp, destPath)
  } catch (err) {
    if (out !== null) {
      await out.close().catch(() => {})
      out = null
    }
    shredFile(tmp) // unauthenticated partial plaintext must not linger
    throw err
  } finally {
    await src.close().catch(() => {})
    if (out !== null) await out.close().catch(() => {})
  }
}

/**
 * Best-effort secure delete: overwrite the file with random bytes (in bounded chunks —
 * a single `randomBytes(size)` throws past 2 GiB), then unlink. The unlink runs even if
 * the overwrite fails. On SSDs wear-levelling means
 * the original blocks may survive — documented in SECURITY.md and not over-promised.
 */
export function shredFile(path: string): void {
  try {
    if (!existsSync(path)) return
    const size = statSync(path).size
    if (size > 0) {
      const fd = openSync(path, 'r+')
      try {
        const chunk = randomBytes(Math.min(size, FILE_CHUNK_BYTES))
        let pos = 0
        while (pos < size) {
          const n = Math.min(chunk.length, size - pos)
          writeSync(fd, chunk, 0, n, pos)
          pos += n
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
  } catch {
    /* best-effort overwrite; still unlink below */
  }
  try {
    rmSync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * ASYNC twin of {@link shredFile} (audit 2026-07-16 F-12): the SAME best-effort secure delete
 * (overwrite with random bytes in bounded chunks, then unlink), on an `fs.promises` FileHandle so it
 * YIELDS to the event loop between chunks. Additive — the ~25 sync `shredFile` callers (vault/crash-lock
 * lifecycle, ingestion, dictation, doctasks, transcriber) stay sync; only the async image-history path
 * uses this twin so a ~20 MiB image store/open/delete on an encrypted USB workspace no longer freezes
 * the main process. Same caveat as the sync twin (SSD wear-levelling may leave original blocks).
 */
export async function shredFileAsync(path: string): Promise<void> {
  try {
    const size = (await statAsync(path)).size
    if (size > 0) {
      const fd = await openFileAsync(path, 'r+')
      try {
        const chunk = randomBytes(Math.min(size, FILE_CHUNK_BYTES))
        let pos = 0
        while (pos < size) {
          const n = Math.min(chunk.length, size - pos)
          await fd.write(chunk, 0, n, pos)
          pos += n
        }
        await fd.sync()
      } finally {
        await fd.close().catch(() => {})
      }
    }
  } catch {
    /* best-effort overwrite (missing/unstatable file too); still unlink below */
  }
  try {
    await rmAsync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

/** Remove (shredding first) the WAL/SHM sidecars that can hold plaintext pages. */
export function cleanSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    shredFile(`${dbPath}${suffix}`)
  }
}

/** Suffix of a working file set aside at startup to be rolled forward at unlock (see `preserveNewerPlaintext`): a
 *  failed lock's newer copy (full-audit 2026-07-11 CODE-1b), or, with `.enc` missing, the only copy of the workspace
 *  (#911). Deliberately matches none of `shredStalePlaintext`'s transient patterns (`.tmp` / `.parse` / `-wal` /
 *  `-shm`); every build since 0.1.47 leaves it at startup and rolls it forward over a missing `.enc` at unlock. */
export const RECOVERY_SUFFIX = '.recovery'

/**
 * Crash recovery for an encrypted vault: shred every leftover plaintext artifact a killed run can leave behind: the
 * working DB, its WAL/SHM sidecars, the atomic-write `.tmp` files of encrypt/decryptFile, and transient decrypted
 * document/image copies (`*.parse*`/`*.tmp` under `workspace/documents/` and `workspace/images/`, written while
 * re-indexing or decrypting an encrypted copy). For an encrypted vault these are derived from the `.enc` artifacts (the
 * source of truth), so shredding loses nothing, with TWO exceptions that `preserveNewerPlaintext` moves aside FIRST
 * (init() runs it before this sweep), as a `.recovery` snapshot this sweep never matches: after a FAILED lock (e.g.
 * disk-full during the re-encrypt) the cleanly-closed working file is NEWER than `.enc` and is the only fresh copy of
 * the session's data (full-audit 2026-07-11 CODE-1); and with `.enc` itself missing (#911) the working file is the
 * only copy of the workspace.
 * MUST NOT be called for `plaintext_dev`, where the working file IS the database.
 */
export function shredStalePlaintext(vaultPaths: VaultPaths): void {
  shredFile(vaultPaths.dbPath)
  // decryptFile writes the FULL plaintext to `<dbPath>.tmp` before its atomic rename —
  // a crash inside that window leaves the entire decrypted database under this name.
  shredFile(`${vaultPaths.dbPath}.tmp`)
  cleanSidecars(vaultPaths.dbPath)
  // Transient plaintext copies derived from encrypted `.enc` stores: documents/ holds
  // re-index `<id>.parse<ext>` copies; images/ holds the image-history encrypt/decrypt temps
  // (`<id>.tmp` on write, `<id>.read-<pid>.tmp` on read — vision/history.ts). Never touches
  // the stored copies themselves — only the clearly-transient `.parse`/`.tmp` names (the
  // stored image is `<id><ext>.enc`, which matches neither).
  const workspaceDir = dirname(vaultPaths.dbPath)
  for (const sub of [DOCUMENTS_DIR_NAME, IMAGES_DIR_NAME]) {
    const dir = join(workspaceDir, sub)
    try {
      for (const name of readdirSync(dir)) {
        if (name.includes('.parse') || name.endsWith('.tmp')) shredFile(join(dir, name))
      }
    } catch {
      /* dir not created yet */
    }
  }
}

/**
 * full-audit 2026-07-11 CODE-1b — the salvage half of the startup crash sweep. A FAILED
 * lock (encryptFile threw after checkpoint + close — ENOSPC is realistic on a nearly-full
 * stick) leaves the plaintext working file as the ONLY fresh copy of the session's data,
 * with the `.enc` still the stale snapshot of the previous successful lock. Shredding it
 * (what `shredStalePlaintext` would do next) silently loses everything since that lock.
 *
 * Detect exactly that state and move the file aside as `<db>.recovery`, which the sweep
 * never matches; `unlockEncryptedVault` rolls it FORWARD once the key exists. The
 * failed-lock signature is deliberately narrow — every check must hold, else the file is
 * derived data and the sweep may shred it (`'not-needed'`):
 *   • the working file is strictly NEWER than `.enc` (mtime) — else it is derived data;
 *   • NO live `-wal`/`-shm` sidecars — lock's checkpoint + close flushed and removed them.
 *     Live sidecars are the MID-SESSION crash state instead: the main file can be
 *     mid-checkpoint (torn), so rolling it forward could replace the intact stale `.enc`
 *     with garbage. That state stays shredded — the documented power-cut trade-off
 *     (docs/security-model.md "Lock failure & durability");
 *   • the file is a database SQLite can read (`probeDatabaseFile`, #876): a failed shred's
 *     random-overwrite, or a file whose header survived but whose structure did not, must
 *     never be re-encrypted over the good `.enc`.
 *
 * Returns what happened, because the caller's next step depends on it (#242): `'preserved'`
 * (moved aside; sweep safe), `'not-needed'` (no such file; sweep safe), `'swept-unclean'` (#892:
 * sweep safe exactly like `'not-needed'`, the mid-session crash state above, but the working file
 * is a real copy of a session that changed something since the last lock, see
 * {@link uncleanEndLeftWorkingCopy}: the sweep shreds it as it always has, and the caller reports
 * the loss), `'discarded'` (#875:
 * the signature held up to the probe, but the file starts with the SQLite header and its
 * structure is `damaged`: the sweep shreds it, and since our own shred never leaves a header,
 * that was the last session's only fresh copy, lost, which the caller reports), or `'failed'` — the
 * signature held (or could not even be probed) but the move did NOT land: the working file
 * is still the only fresh copy, so the caller must refuse to sweep and refuse to open.
 * Before #242 that last case fell through to the sweep, which shredded the fresh copy.
 *
 * #911: all of the above assumes an `.enc` to protect. With NO encrypted snapshot on the drive (`.enc` absent, no
 * staged `.enc.new`) the working file is the only copy of the workspace, and {@link keepOnlyCopy} decides instead: the
 * new outcome `'kept-only-copy'` (moved aside as `.recovery`, like `'preserved'`; sweep safe), `'discarded-only-copy'`
 * (a copy whose structure is damaged: sweep safe like `'not-needed'`; with no snapshot to name there is no notice, only
 * a log line), `'not-needed'` (nothing to keep) or `'failed'`. Only a stat that says ENOENT proves `.enc` is gone: any other stat failure is doubt, `'failed'`, where
 * `existsSync` used to read it as "no `.enc`" and the sweep ran.
 */
export type PreserveOutcome =
  | 'preserved'
  | 'kept-only-copy'
  | 'discarded-only-copy'
  | 'not-needed'
  | 'swept-unclean'
  | 'discarded'
  | 'failed'

export function preserveNewerPlaintext(vaultPaths: VaultPaths, onProbeFallback?: ProbeFallbackNote): PreserveOutcome {
  try {
    if (!existsSync(vaultPaths.dbPath)) return 'not-needed'
    const enc = encryptedFileState(vaultPaths)
    if (enc === 'unknown') return 'failed'
    if (enc === 'missing') return keepOnlyCopy(vaultPaths, onProbeFallback)
    if (existsSync(`${vaultPaths.dbPath}-wal`) || existsSync(`${vaultPaths.dbPath}-shm`)) {
      return uncleanEndLeftWorkingCopy(vaultPaths) ? 'swept-unclean' : 'not-needed'
    }
    if (statSync(vaultPaths.dbPath).mtimeMs <= statSync(vaultPaths.encPath).mtimeMs) return 'not-needed'
    // #876: the structure, not only the header. A header read that fails (a hold, the file
    // vanishing) refuses the sweep, as any other doubt here does (#242); a structure SQLite cannot
    // read for a reason that is not damage is judged by the header, as before (review round 2).
    const probe = probeDatabaseFile(vaultPaths.dbPath)
    if (probe.verdict === 'not-database') return 'not-needed' // a shred survivor of a lock that succeeded
    if (probe.verdict === 'damaged') return 'discarded'
    if (!readsAsDatabase(probe, 'salvage', onProbeFallback)) return 'failed'
    const recoveryPath = `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`
    // full-audit 2026-07-12 REL-1 — shred a pre-existing `.recovery` BEFORE the rename. Any
    // `.recovery` coexisting with a working dbPath is spent or garbage (an intervening unlock
    // consumed or out-dated it; this runs only from init(), single-threaded, before any IPC).
    // On success the rename would overwrite it anyway; the pre-shred covers the case where the
    // target is HELD (Windows AV/indexer without FILE_SHARE_DELETE; likelier on exFAT/FAT32) —
    // a merely-lingering spent leftover no longer makes this rename fail. A target the hold
    // keeps through the overwrite, the unlink AND the rename still fails the rename into the
    // catch below, which now reports `'failed'` instead of handing the ONLY fresh copy of the
    // session's data to shredStalePlaintext (#242).
    shredFile(recoveryPath)
    renameSync(vaultPaths.dbPath, recoveryPath)
    return 'preserved'
  } catch {
    // On any doubt refuse the sweep (#242) — the caller blocks and the next unlock retries.
    return 'failed'
  }
}

/**
 * #892 — is the working file beside live `-wal`/`-shm` sidecars (the mid-session crash state, which the sweep shreds:
 * the documented power-cut trade-off) a real copy of a session that changed something after the last lock? Then the
 * app ended without locking it (a power cut, the drive pulled out, a kill, or a quit on a full drive whose lock #876
 * refused) and the changes since that lock are lost. Only REPORTS: the sweep runs either way, so any doubt (an error,
 * a verdict that proves nothing) answers false, and the check can only add a notice, never change a verdict.
 *   • the working file or its `-wal` is strictly NEWER than `.enc`: every unlock decrypts the working file after the
 *     lock that wrote `.enc`, so a session that ended unlocked always is; older is derived data;
 *   • the working file starts like a database ({@link startsLikeDatabase}): the session's own file, whole or torn
 *     mid-checkpoint. That is exactly when {@link probeDatabaseFile} answers `database`, `damaged` or `unchecked`, the
 *     answers this check needs, at a fraction of the cost (one 100-byte read instead of the structural walk: 0.13 ms
 *     against 3.6 ms on a warm 28 MB working file, far more on a cold stick), and with no probe fallback to note for a
 *     check that salvages nothing. A shred survivor (no header: our shred never leaves one), a file that cannot be
 *     read, or one gone meanwhile proves nothing.
 */
function uncleanEndLeftWorkingCopy(vaultPaths: VaultPaths): boolean {
  try {
    let newest = statSync(vaultPaths.dbPath).mtimeMs
    try {
      newest = Math.max(newest, statSync(`${vaultPaths.dbPath}-wal`).mtimeMs)
    } catch {
      /* only a -shm: the working file's own time */
    }
    if (newest <= statSync(vaultPaths.encPath).mtimeMs) return false
    return startsLikeDatabase(vaultPaths.dbPath)
  } catch {
    return false
  }
}

/** The 16 bytes every SQLite database file starts with ("SQLite format 3" and a NUL). */
const SQLITE_FILE_MAGIC = Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.alloc(1)])
/** The SQLite database header's size: a file shorter than it is no database to {@link probeDatabaseFile} either. */
const SQLITE_DATABASE_HEADER_BYTES = 100

/** #892: does the file at `path` start like a database: a whole 100-byte database header that begins with the SQLite
 *  magic? The first step of {@link probeDatabaseFile}, alone: every file it lets through, the probe answers
 *  `database`, `damaged` or `unchecked`. Throws when the file cannot be read (the caller's doubt). */
function startsLikeDatabase(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(SQLITE_DATABASE_HEADER_BYTES)
    if (readSync(fd, header, 0, header.length, 0) < header.length) return false
    return header.subarray(0, SQLITE_FILE_MAGIC.length).equals(SQLITE_FILE_MAGIC)
  } finally {
    closeSync(fd)
  }
}

/** #911: what one stat of `.enc` says: `present` (with its mtime); `missing` (ENOENT, the one answer that proves no
 *  snapshot is there); or `unknown`, any other failure (a delete-pending file on Windows, a permission or I/O error),
 *  which proves neither. */
type EncryptedFileStat = { state: 'present'; mtimeMs: number } | { state: 'missing' } | { state: 'unknown' }

function statEncryptedFile(vaultPaths: VaultPaths): EncryptedFileStat {
  try {
    return { state: 'present', mtimeMs: statSync(vaultPaths.encPath).mtimeMs }
  } catch (err) {
    return { state: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unknown' } as EncryptedFileStat
  }
}

/** {@link statEncryptedFile}'s answer alone. */
function encryptedFileState(vaultPaths: VaultPaths): EncryptedFileStat['state'] {
  return statEncryptedFile(vaultPaths).state
}

/**
 * #911: the start's salvage when `.enc` is missing (a stat says ENOENT) and the working file is there. The app never
 * removes `.enc` itself (a lock, a create and a password change replace it by rename), so something outside it did: a
 * person tidying the drive, a sync tool, a disk check. The working file is then the only copy of the workspace, and the
 * sweep, which assumes `.enc` is the source of truth, would shred all of it. So:
 *   - a staged `.enc.new` is a snapshot too (a create or a v1 to v2 password change cut short after its commit), which
 *     `recoverPendingRekey` rolls forward: `'not-needed'`, as before. Adopting the session over it would be the
 *     full-drive roll-forward over a snapshot that this start never does (security-model.md "Encrypted file
 *     missing");
 *   - the `-wal` is replayed into the main file first ({@link checkpointLeftoverWal}): after an unclean end the
 *     session's last commits sit there, and the main file alone lacks them. A `-wal` that still holds commits after
 *     the replay (a full drive, another connection reading it) blocks the start, all three files kept (`'failed'`, as
 *     #242). A database SQLite calls damaged goes on to the probe;
 *   - a file that reads as a database (`database`, or `unchecked` judged by its header) is moved to `<db>.recovery`,
 *     which the next unlock with the right password rolls forward over the missing `.enc` (every build since 0.1.47
 *     does): `'kept-only-copy'`. One whose structure is `damaged` (a real copy: its header reads) is
 *     `'discarded-only-copy'`: the sweep shreds it, the start reports it for one log line, and the unlock then says
 *     the file is missing. A shred survivor or a file gone meanwhile is nothing to keep (`'not-needed'`). One the
 *     probe cannot read blocks, with nothing removed.
 * The sidecars are left to the sweep that follows every path that does not block (review N-2): named after the
 * working file, they never pair with the `.recovery`, and a start that blocks must remove nothing.
 * No marker is written: the #875 marker names a snapshot, and there is none (its format stays as it is).
 * This start never replaces a snapshot. An `.enc` that comes back before the unlock (a sync tool restoring it, a user
 * putting it back) is judged there by the CODE-1b roll-forward rule, which cannot tell this copy from a failed lock's:
 * the kept copy wins unless the returned `.enc` is newer by mtime (security-model.md "Encrypted file missing").
 */
function keepOnlyCopy(vaultPaths: VaultPaths, onProbeFallback?: ProbeFallbackNote): PreserveOutcome {
  if (existsSync(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) return 'not-needed'
  if (walAwaitsCheckpoint(vaultPaths.dbPath)) {
    const replay = checkpointLeftoverWal(vaultPaths.dbPath)
    if (replay.outcome !== 'damaged' && walAwaitsCheckpoint(vaultPaths.dbPath)) return 'failed'
  }
  const probe = probeDatabaseFile(vaultPaths.dbPath)
  if (probe.verdict === 'damaged') return 'discarded-only-copy'
  if (probe.verdict === 'not-database' || probe.verdict === 'gone') return 'not-needed'
  if (!readsAsDatabase(probe, 'salvage', onProbeFallback)) return 'failed'
  const recoveryPath = `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`
  // REL-1's pre-shred, as in preserveNewerPlaintext: any file at the `.recovery` name is replaced. Nothing in the app
  // leaves one beside a working file while `.enc` is missing (an unlock consumes a kept copy before any session writes
  // a working file), so one there is a spent leftover or garbage, or a kept copy beside a working file something else
  // wrote, which whoever wrote it could as well have deleted (review N-7). A target a hold keeps through the overwrite,
  // the unlink and the rename fails the rename into the caller's catch.
  shredFile(recoveryPath)
  renameSync(vaultPaths.dbPath, recoveryPath)
  return 'kept-only-copy'
}

// ---- #875: the record of a lock that finished at the last snapshot ----------------
//
// A lock that finds the working file gone or no longer a database finishes at the last good `.enc`
// (#855). "Lock now" can say so on the lock screen it returns to, but a lock at quit (or at a crash
// or the end of a Windows session) has no screen, and nothing logged after the key is dropped
// survives the process. So the controller leaves a content-free marker beside the descriptor,
// reads it at the next start, reports the notice while the workspace is locked, and consumes it at
// the next unlock (where the IPC can record it in the audit log and app.log). A start whose salvage
// or sweep shredded the last session's changes records the same way (#875 `startup`; #892 `unclean`
// and `unclean-full`, the session an app that ended without a lock left behind).
//
// The marker names the snapshot it is about: the IV of `.enc`'s frame, random per encrypt and
// already public in `.enc` itself. A later lock by ANY build re-encrypts `.enc` with a new IV, so a
// marker an older build ignored (a Kit carries several OSes' apps) expires there instead of telling
// a lie after the user has worked and locked elsewhere. `config/workspace.json` stays untouched, so
// older builds read the descriptor exactly as before. A marker of another version (a newer build's)
// is neither shown nor removed (#845's rule: what this build cannot read, it leaves alone).

/** File name of the #875 marker, in the descriptor's folder (`config/`). */
export const WORKING_COPY_LOST_MARKER = 'working-copy-lost.json'
/** The only marker format this build writes and reads: `{ "v": 1, "enc": "<base64 IV of .enc>", "cause": "lock" }`
 *  (or `"startup"`, `"unclean"`, `"unclean-full"`). */
const WORKING_COPY_LOST_VERSION = 1

/**
 * Which loss of the last session's changes the #875 record is about (content-free; the log line and the audit metadata
 * carry it): a lock that finished at the last snapshot (#855), a start whose salvage swept the last session's working
 * file because it was no longer a database, a start whose sweep shredded the session an app that ended without a lock
 * left behind (#892: `unclean`; `unclean-full` when the drive had too little free space for a lock), or an unlock that
 * discarded a `.recovery` copy that was no longer a database. All but the last go into the marker; that one happens at
 * the unlock that records it.
 */
export type WorkingCopyLossCause = 'lock' | 'startup' | 'unclean' | 'unclean-full' | 'recovery'
/** The causes the marker carries (#892): every one but `recovery`. */
type MarkedLossCause = Exclude<WorkingCopyLossCause, 'recovery'>
const MARKED_LOSS_CAUSES: readonly MarkedLossCause[] = ['lock', 'startup', 'unclean', 'unclean-full']

/**
 * #892: the cause a marker of this version names. One this build writes maps 1:1; any other (a cause a later build
 * added, or none) still means the changes since the last lock are lost, so it reads as the generic `unclean`: the
 * notice that the app did not lock the workspace at its last close, whose reasons are only examples. Never as `lock`:
 * that notice says something removed or damaged the working file.
 */
function markedLossCause(cause: unknown): MarkedLossCause {
  return MARKED_LOSS_CAUSES.find((known) => known === cause) ?? 'unclean'
}

/** #892: the lock screen's notice for each cause the controller holds (`WorkspaceStateInfo.lockNotice`). */
const LOCK_NOTICE: Record<MarkedLossCause, NonNullable<WorkspaceStateInfo['lockNotice']>> = {
  lock: 'working_copy_lost',
  startup: 'working_copy_lost',
  unclean: 'session_not_closed',
  'unclean-full': 'session_not_closed_full'
}

function workingCopyLostPath(vaultPaths: VaultPaths): string {
  return join(dirname(vaultPaths.descriptorPath), WORKING_COPY_LOST_MARKER)
}

/** The IV of the `HRAUMEN1` frame at `path`, base64, or null (unreadable, cut short, another frame). */
function frameIvOf(path: string): string | null {
  try {
    const head = Buffer.alloc(BLOB_MAGIC.length + BLOB_IV_BYTES)
    const fd = openSync(path, 'r')
    try {
      if (readSync(fd, head, 0, head.length, 0) < head.length) return null
    } finally {
      closeSync(fd)
    }
    if (classifyFrameMagic(head.subarray(0, BLOB_MAGIC.length)) !== 'current') return null
    return head.subarray(BLOB_MAGIC.length).toString('base64')
  } catch {
    return null
  }
}

/** The marker on disk: none, one of this build's (with the snapshot it names), or anything else (another version,
 *  unreadable, not JSON), which is left as it is. */
type WorkingCopyLostMarker =
  | { kind: 'absent' }
  | { kind: 'current'; enc: string; cause: MarkedLossCause }
  | { kind: 'other' }

function readWorkingCopyLostMarker(vaultPaths: VaultPaths): WorkingCopyLostMarker {
  let text: string
  try {
    text = readFileSync(workingCopyLostPath(vaultPaths), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'other' }
  }
  try {
    const m = JSON.parse(text) as { v?: unknown; enc?: unknown; cause?: unknown } | null
    if (m?.v === WORKING_COPY_LOST_VERSION && typeof m.enc === 'string') {
      return { kind: 'current', enc: m.enc, cause: markedLossCause(m.cause) }
    }
  } catch {
    /* not JSON: not ours to judge */
  }
  return { kind: 'other' }
}

/** Write the marker for the `.enc` that is there now (temp + fsync + rename, so it is whole or absent; a temp a failed
 *  write leaves behind is removed). Throws on an I/O failure; nothing is written when `.enc` has no readable frame (no
 *  snapshot to name). `enc`: that frame's IV when the caller has just read it (`init()`), else read here. */
function writeWorkingCopyLostMarker(
  vaultPaths: VaultPaths,
  cause: MarkedLossCause,
  enc: string | null = frameIvOf(vaultPaths.encPath)
): void {
  if (enc === null) return
  const path = workingCopyLostPath(vaultPaths)
  const tmp = `${path}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, Buffer.from(JSON.stringify({ v: WORKING_COPY_LOST_VERSION, enc, cause }), 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Remove this build's marker (best-effort); one of another version stays. */
function removeWorkingCopyLostMarker(vaultPaths: VaultPaths): void {
  if (readWorkingCopyLostMarker(vaultPaths).kind !== 'current') return
  try {
    rmSync(workingCopyLostPath(vaultPaths), { force: true })
  } catch {
    /* best-effort: a marker left behind names a snapshot the next lock replaces, so it expires there */
  }
}

// ---- password change: envelope rekey + journaled v1→v2 migration ------------------
//
// Two-phase swap, composed ONLY from the existing atomic primitives: every re-encrypted
// file is STAGED as `<file>.new` (encryptFile's own `.tmp`-then-rename inside) and
// fsynced; the atomic descriptor replace is the SINGLE commit point; the staged files
// are then swapped in (shred old, rename `.new`). A crash at any step recovers to a
// consistent vault: descriptor still v1 → the staged files are discarded and the OLD
// password+files win; descriptor already v2 → the staged files are rolled forward and
// the NEW password wins. Never a mix.
//
// What is staged (#241): every file encrypted under the vault data key outside the DB —
// `listVaultKeyCiphertexts` enumerates the four classes (document sidecars, image-history
// sidecars, legacy out-of-store stored copies, the rotated diagnostics log). The staged
// paths are written to `workspace/rekey-journal.json` BEFORE staging, because an
// out-of-store copy lies where no directory scan finds it at recovery time (the DB is
// closed then). A build older than #241 does not read the journal: it rolls the DB and
// `documents/` forward and leaves the other classes staged — see security-model.md.

/** Suffix of a staged (re-encrypted, not yet swapped-in) file during a rekey. */
export const REKEY_SUFFIX = '.new'

/** Transient plaintext infix used while re-encrypting a document sidecar. Ends in
 *  `.tmp` so the `shredStalePlaintext` startup sweep covers a crash mid-stage. */
const REKEY_PLAINTEXT_SUFFIX = '.rekey.tmp'

/** fsync a finished file so it is durable BEFORE the descriptor commit point. */
function fsyncPath(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Directory name of the document store under `workspace/`. */
export const DOCUMENTS_DIR_NAME = 'documents'
/** Directory name of the image-history store under `workspace/` (vision/history.ts writes
 *  there; the drive-status footprint and the rekey read it — one constant, #241). */
export const IMAGES_DIR_NAME = 'images'
/** The rotated (previous-generation) encrypted diagnostics log under `logs/`, written by
 *  logging.ts and sealed under the vault data key. Deleted by the v1→v2 rekey: nothing reads
 *  it, and it would otherwise stay under the retired key (#241). */
export const ROTATED_ENCRYPTED_LOG_NAME = 'app.1.log.enc'
/** The rekey journal under `workspace/`: every `<file>.new` a v1→v2 migration stages plus
 *  the files it removes at commit. Needed because a legacy stored copy can lie OUTSIDE the
 *  store, where no directory scan finds its staged twin at recovery (#241). */
export const REKEY_JOURNAL_NAME = 'rekey-journal.json'

/** The classes of file encrypted under the vault data key, outside the database itself. */
export type VaultKeyCiphertextKind = 'document' | 'image' | 'out-of-store' | 'rotated-log'

export interface VaultKeyCiphertext {
  path: string
  kind: VaultKeyCiphertextKind
  /** `rekey`: re-encrypt under the new key (staged, then swapped in). `delete`: removed once
   *  the descriptor commit has happened. */
  action: 'rekey' | 'delete'
}

interface RekeyJournal {
  version: typeof REKEY_JOURNAL_VERSION
  /** Absolute `<file>.new` paths the stage writes (in-store and out-of-store). */
  staged: string[]
  /** Absolute paths deleted after the commit point. */
  remove: string[]
}

function workspaceDirOf(vaultPaths: VaultPaths): string {
  return dirname(vaultPaths.dbPath)
}

function rekeyJournalPath(vaultPaths: VaultPaths): string {
  return join(workspaceDirOf(vaultPaths), REKEY_JOURNAL_NAME)
}

/** Every `<name>.enc` directly under `dir` (`[]` when the dir does not exist yet). */
function listEncryptedSidecars(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(ENCRYPTED_DOC_SUFFIX))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** True when `path` lies strictly inside `dir` (both absolute). */
function isInsideDir(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Legacy stored copies that resolve OUTSIDE `workspace/documents/` (issue #188 rows keep an
 * absolute `stored_path`). The rule is `locateStoredCopy`'s fallback order (ingestion/
 * stored-copy.ts): a row counts only when its canonical `documents/<leaf>` (the shared
 * `canonicalLeafFor` rule) is absent and `stored_path` names an existing regular file
 * outside the store — i.e. exactly the file the read paths would decrypt at this moment.
 * Limits: a copy on a drive that is detached NOW is not seen and stays under the old key if
 * it returns later; the guard is name presence, not ownership — a row pointing into another
 * vault's store is rekeyed like any other file it names.
 */
function listOutOfStoreCopies(vaultPaths: VaultPaths, db: Db): string[] {
  const docsDir = join(workspaceDirOf(vaultPaths), DOCUMENTS_DIR_NAME)
  const rows = db
    .prepare('SELECT id, stored_path, stored_name FROM documents WHERE stored_path IS NOT NULL')
    .all() as Array<{ id: string; stored_path: string; stored_name: string | null }>
  const out = new Set<string>()
  for (const row of rows) {
    const path = row.stored_path
    if (typeof path !== 'string' || !path.endsWith(ENCRYPTED_DOC_SUFFIX) || out.has(path)) continue
    const leaf = canonicalLeafFor(row)
    if (leaf && existsSync(join(docsDir, leaf))) continue // the canonical copy wins
    if (isInsideDir(docsDir, path)) continue
    let isFile = false
    try {
      isFile = statSync(path).isFile()
    } catch {
      /* gone or unreachable → nothing to rekey */
    }
    if (isFile) out.add(path)
  }
  return [...out]
}

/**
 * Every file outside the database that is encrypted under the vault data key — what a
 * v1→v2 password change must carry to the new key (#241). Four classes: document sidecars,
 * image-history sidecars, legacy out-of-store stored copies (read from the open DB) and the
 * rotated diagnostics log (action `delete` — nothing reads it). `db` must be open.
 */
export function listVaultKeyCiphertexts(vaultPaths: VaultPaths, db: Db): VaultKeyCiphertext[] {
  const ws = workspaceDirOf(vaultPaths)
  const out: VaultKeyCiphertext[] = []
  for (const path of listEncryptedSidecars(join(ws, DOCUMENTS_DIR_NAME))) {
    out.push({ path, kind: 'document', action: 'rekey' })
  }
  for (const path of listEncryptedSidecars(join(ws, IMAGES_DIR_NAME))) {
    out.push({ path, kind: 'image', action: 'rekey' })
  }
  for (const path of listOutOfStoreCopies(vaultPaths, db)) {
    out.push({ path, kind: 'out-of-store', action: 'rekey' })
  }
  if (vaultPaths.logsPath) {
    const rotated = join(vaultPaths.logsPath, ROTATED_ENCRYPTED_LOG_NAME)
    if (existsSync(rotated)) out.push({ path: rotated, kind: 'rotated-log', action: 'delete' })
  }
  return out
}

/** A journal read back from disk; `corrupt` = unparseable or an unknown version. */
type RekeyJournalRead = RekeyJournal & { corrupt: boolean }

function readRekeyJournal(vaultPaths: VaultPaths): RekeyJournalRead | null {
  const path = rekeyJournalPath(vaultPaths)
  if (!existsSync(path)) return null
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RekeyJournal>
    if (parsed.version !== REKEY_JOURNAL_VERSION) {
      return { version: REKEY_JOURNAL_VERSION, staged: [], remove: [], corrupt: true }
    }
    return {
      version: REKEY_JOURNAL_VERSION,
      // Only `<file>.new` entries can be swapped; anything else would be shredded by name.
      staged: strings(parsed.staged).filter((s) => s.endsWith(REKEY_SUFFIX)),
      remove: strings(parsed.remove),
      corrupt: false
    }
  } catch {
    // Unreadable: the directory scans still resolve the in-store classes; the file itself is
    // quarantined (never deleted) by clearRekeyJournal so its out-of-store entries are not lost.
    return { version: REKEY_JOURNAL_VERSION, staged: [], remove: [], corrupt: true }
  }
}

/** A path key that folds spelling differences (`..` segments, drive-letter case on Windows)
 *  so one physical staged file is never listed — and swapped — twice (#241). */
function pathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Atomic (temp + fsync + rename), like the descriptor: recovery must never read half a journal. */
function writeRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournal): void {
  const path = rekeyJournalPath(vaultPaths)
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, Buffer.from(JSON.stringify(journal, null, 2), 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Remove the journal — or, when it could not be parsed, quarantine it as `.corrupt` beside
 *  the vault so the out-of-store paths it may name are never destroyed with it. */
function clearRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournalRead | null): void {
  const path = rekeyJournalPath(vaultPaths)
  rmSync(`${path}.tmp`, { force: true })
  if (journal?.corrupt && existsSync(path)) {
    rmSync(`${path}.corrupt`, { force: true })
    renameSync(path, `${path}.corrupt`)
    return
  }
  rmSync(path, { force: true })
}

/** Every staged `<file>.new` of an (interrupted or in-progress) rekey: the DB, the in-store
 *  sidecars (`documents/`, `images/` — by scan, so a journal-less stage still resolves) and
 *  the journal's entries (the only way to find an out-of-store one). */
function stagedRekeyFiles(vaultPaths: VaultPaths, journal = readRekeyJournal(vaultPaths)): string[] {
  const ws = workspaceDirOf(vaultPaths)
  // Keyed on the folded path: the scan and the journal may spell one file two ways, and a
  // file listed twice would be shredded by its own second swap.
  const out = new Map<string, string>()
  const add = (p: string): void => {
    if (!out.has(pathKey(p))) out.set(pathKey(p), p)
  }
  if (existsSync(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) add(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  for (const sub of [DOCUMENTS_DIR_NAME, IMAGES_DIR_NAME]) {
    const dir = join(ws, sub)
    try {
      for (const n of readdirSync(dir)) {
        if (n.endsWith(`${ENCRYPTED_DOC_SUFFIX}${REKEY_SUFFIX}`)) add(join(dir, n))
      }
    } catch {
      /* dir not created yet */
    }
  }
  for (const staged of journal?.staged ?? []) {
    if (existsSync(staged)) add(staged)
  }
  return [...out.values()]
}

/**
 * Phase 1 of the v1→v2 migration: re-encrypt the database + every vault-key ciphertext
 * (`listVaultKeyCiphertexts`) under `dataKey`, STAGED next to the originals as `<file>.new`,
 * fsynced. Nothing the current password unlocks is touched. The DB snapshot comes from the
 * live working file (WAL checkpointed first), so it is CURRENT — fresher than the at-rest
 * `.enc` from the last lock. Sidecars round-trip through a transient plaintext file that is
 * shredded immediately; it always lands under the store (`documents/` for an out-of-store
 * copy) and ends in `.tmp`, so the startup sweep covers a crash. The journal is written
 * FIRST — recovery must know every staged path before any of them exists.
 */
export function stageRekey(
  vaultPaths: VaultPaths,
  db: Db,
  oldKey: Buffer,
  dataKey: Buffer,
  onProbeFallback?: ProbeFallbackNote
): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  // #876 review round 2 — the lock's WAL guard: a checkpoint that could not finish (it does not
  // throw; it answers "busy") leaves the main file stale while the session's commits sit in the
  // `-wal`, and the staged copy of that stale file would replace `.enc` at the commit. The
  // connection is open, so a TRUNCATE that finished left the `-wal` empty. Refused; nothing is
  // staged, and the user tries the change again.
  if (walAwaitsCheckpoint(vaultPaths.dbPath)) {
    throw new Error(
      'Refusing to stage the password change: the checkpoint did not finish, so the working ' +
        'database file lacks commits the -wal still holds.'
    )
  }
  // #208 — same guard as the lock path: the staged file replaces `.enc` right after the
  // descriptor commit, so encrypting a shred-survivor (or anything else that is not the
  // checkpointed database) here would destroy the vault through the rekey journal instead.
  // #876: the structure, not only the header; an unreadable working file is refused too. The
  // probe reads the main file the checkpoint above completed, beside the open connection.
  if (!readsAsDatabase(probeDatabaseFile(vaultPaths.dbPath), 'rekey', onProbeFallback)) {
    throw new Error(
      'Refusing to stage the password change: the working database file is not a SQLite ' +
        'database (it may have been overwritten).'
    )
  }
  const targets = listVaultKeyCiphertexts(vaultPaths, db)
  const stagedDb = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  writeRekeyJournal(vaultPaths, {
    version: REKEY_JOURNAL_VERSION,
    staged: [stagedDb, ...targets.filter((t) => t.action === 'rekey').map((t) => `${t.path}${REKEY_SUFFIX}`)],
    remove: targets.filter((t) => t.action === 'delete').map((t) => t.path)
  })
  encryptFile(vaultPaths.dbPath, stagedDb, dataKey)
  fsyncPath(stagedDb)
  const docsDir = join(workspaceDirOf(vaultPaths), DOCUMENTS_DIR_NAME)
  for (const target of targets) {
    if (target.action !== 'rekey') continue
    let plain = `${target.path}${REKEY_PLAINTEXT_SUFFIX}`
    if (target.kind === 'out-of-store') {
      mkdirSync(docsDir, { recursive: true })
      plain = join(docsDir, `${basename(target.path)}${REKEY_PLAINTEXT_SUFFIX}`)
    }
    try {
      decryptFile(target.path, plain, oldKey)
      encryptFile(plain, `${target.path}${REKEY_SUFFIX}`, dataKey)
      fsyncPath(`${target.path}${REKEY_SUFFIX}`)
    } finally {
      shredFile(plain)
    }
  }
}

/**
 * Phase 2 (after the descriptor commit): swap every staged file in — shred the old
 * ciphertext (its key may be a compromised password's), rename `.new` into place.
 * Idempotent: already-swapped files have no `.new` left, so crash-and-rerun completes.
 *
 * Best-effort + one retry pass (BUG vuln-scan-2026-06-21): a transient failure on ONE sidecar
 * (e.g. a momentarily locked file on Windows) must NOT abandon the remaining swaps. The old
 * code threw on the first failure, leaving every later sidecar under the RETIRED key while the
 * controller had already swapped the in-memory key to the new one — so many documents (not just
 * the locked one) decrypted to a GCM-tag failure until `recoverPendingRekey` finished them on the
 * next unlock. We now attempt all files, retry the stragglers once, and only then throw — so at
 * most a genuinely-stuck file is deferred to recovery, never the whole tail of the list.
 */
export function applyPendingRekey(vaultPaths: VaultPaths): void {
  const journal = readRekeyJournal(vaultPaths)
  // Committed, so the files the migration retires go first (idempotent, best-effort): a
  // later crash can then never skip them. Today that is the rotated log (#241).
  for (const doomed of journal?.remove ?? []) {
    try {
      rmSync(doomed, { force: true })
    } catch {
      /* locked: stays under the retired key; nothing reads it */
    }
  }
  // encryptFile's write temp beside an out-of-store target (the in-store ones are swept).
  for (const staged of journal?.staged ?? []) rmSync(`${staged}.tmp`, { force: true })
  const swapOne = (staged: string): void => {
    // Already swapped (or listed under two spellings): shredding the target now would
    // destroy the NEW ciphertext.
    if (!existsSync(staged)) return
    const target = staged.slice(0, -REKEY_SUFFIX.length)
    shredFile(target)
    renameSync(staged, target)
  }
  let pending = stagedRekeyFiles(vaultPaths, journal)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const failed: string[] = []
    for (const staged of pending) {
      try {
        swapOne(staged)
      } catch (err) {
        lastErr = err
        failed.push(staged)
      }
    }
    pending = failed
  }
  // Anything still unswapped (a persistently locked file) is left staged for recoverPendingRekey
  // on the next unlock; surface the failure so the caller logs it (the swap is old-or-new per
  // file, never mixed within a file). The journal stays with it.
  if (pending.length > 0) {
    throw lastErr instanceof Error ? lastErr : new Error('applyPendingRekey: incomplete swap')
  }
  // A journal entry with neither its `.new` nor its target on disk sits on a location that
  // is unreachable right now (a detached legacy drive) — keep the journal so a later
  // recovery can still finish that swap; clear it once every entry is accounted for.
  const unreachable = (journal?.staged ?? []).some(
    (staged) => !existsSync(staged) && !existsSync(staged.slice(0, -REKEY_SUFFIX.length))
  )
  if (!unreachable) clearRekeyJournal(vaultPaths, journal)
}

/** Roll back an uncommitted rekey: delete the staged files and the journal. Plain delete
 *  is enough — they are ciphertext under a data key that was never persisted anywhere. */
export function discardPendingRekey(vaultPaths: VaultPaths): void {
  const journal = readRekeyJournal(vaultPaths)
  for (const staged of stagedRekeyFiles(vaultPaths, journal)) {
    rmSync(staged, { force: true })
  }
  for (const staged of journal?.staged ?? []) rmSync(`${staged}.tmp`, { force: true })
  clearRekeyJournal(vaultPaths, journal)
}

/**
 * Crash recovery for an interrupted password change. MUST run before any unlock decrypt:
 * the descriptor decides which side of the commit point the crash landed on. v2
 * descriptor + staged files ⇒ committed ⇒ roll FORWARD (the new password's files win);
 * v1 descriptor ⇒ uncommitted ⇒ roll BACK (the old password + old files stay intact).
 * A journal with nothing left staged still needs the roll-forward's deletions (#241).
 */
export function recoverPendingRekey(vaultPaths: VaultPaths, descriptor: VaultDescriptor | null): void {
  // encryptFile's own atomic-write temp for the staged DB (a crash mid-stage leaves it;
  // the document-dir equivalents end in `.tmp` and are swept by shredStalePlaintext), and
  // the journal's own write temp.
  rmSync(`${vaultPaths.encPath}${REKEY_SUFFIX}.tmp`, { force: true })
  rmSync(`${rekeyJournalPath(vaultPaths)}.tmp`, { force: true })
  if (stagedRekeyFiles(vaultPaths).length === 0 && !existsSync(rekeyJournalPath(vaultPaths))) return
  if (descriptor && descriptor.version >= VAULT_VERSION_ENVELOPE && descriptor.dataKey) {
    applyPendingRekey(vaultPaths)
  } else {
    discardPendingRekey(vaultPaths)
  }
}

/**
 * Build a fresh v2 (envelope) descriptor: new salt, KEK derived from `password` under
 * `kdf`, new verifier, `dataKey` wrapped by the KEK. The KEK is zeroed before returning.
 */
function buildEnvelopeDescriptor(password: string, dataKey: Buffer, kdf: KdfParams): VaultDescriptor {
  const salt = generateSalt()
  const kek = deriveKey(password, salt, kdf)
  const descriptor: VaultDescriptor = {
    version: VAULT_VERSION_ENVELOPE,
    mode: 'encrypted',
    kdf,
    saltB64: salt.toString('base64'),
    verifier: blobToJson(makeVerifier(kek)),
    dataKey: blobToJson(encrypt(kek, dataKey))
  }
  kek.fill(0)
  return descriptor
}

/**
 * The O(1) password change of a v2 vault (and the commit step of the v1→v2 migration):
 * atomically replace the descriptor with a fresh envelope — new salt, new KDF params
 * (`DEFAULT_KDF` by default, so a legacy scrypt vault silently upgrades to Argon2id),
 * new verifier, the SAME data key re-wrapped under the new password's KEK. No data file
 * is touched.
 */
export function rewrapVaultKey(
  vaultPaths: VaultPaths,
  dataKey: Buffer,
  newPassword: string,
  kdf: KdfParams = DEFAULT_KDF
): VaultDescriptor {
  const descriptor = buildEnvelopeDescriptor(newPassword, dataKey, kdf)
  writeVaultDescriptor(vaultPaths.descriptorPath, descriptor)
  return descriptor
}

// ---- encrypted document cache ------------------------------------------------------

/**
 * File-level encrypt/decrypt bound to the unlocked vault key. Used by the ingestion
 * service so imported document COPIES rest encrypted too (spec §3.5 requires encrypting
 * the "workspace database AND document cache" — the DB alone is not enough: the raw
 * bytes of every imported file would otherwise stay readable on a lost drive).
 */
export interface DocumentCipher {
  // ASYNC only (#687): every consumer (document-cache import/re-index/preview/OCR, the text and
  // original export readers, the image history) awaits these, so a large file never freezes the
  // main process. The sync module functions stay for the raw-key DB lifecycle, crash-lock and rekey.
  /** Async encrypt (PERF-1): plaintext at `srcPath` → framed ciphertext at `destPath`, yielding to
   *  the event loop between chunks. */
  encryptFileAsync(srcPath: string, destPath: string): Promise<void>
  /** Async decrypt (PERF-1): framed ciphertext at `srcPath` → plaintext at `destPath`, yielding
   *  between chunks. */
  decryptFileAsync(srcPath: string, destPath: string): Promise<void>
}

// ---- create / unlock / lock ------------------------------------------------------

/**
 * Create a brand-new encrypted vault ON DISK, leaving it LOCKED (descriptor + `.enc`,
 * no plaintext working file). New vaults are v2 (envelope): a random data key
 * encrypts the database; the password-derived KEK wraps it in the descriptor — so their
 * very first password change is already the O(1) re-wrap. Call `unlockEncryptedVault`
 * afterwards to open it. `opts.legacyV1` builds the legacy v1 direct-key format and
 * exists ONLY so tests can create migration fixtures — the app never passes it.
 */
export function createEncryptedVaultOnDisk(
  vaultPaths: VaultPaths,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
  opts: { legacyV1?: boolean } = {}
): void {
  // Refuse to overwrite an existing vault — `.enc` IS the user's data (chats, documents,
  // settings), and re-creating would irreversibly replace it with an empty database. A
  // corrupt/missing descriptor is recoverable; a wiped `.enc` is not. #954: nor a descriptor
  // file without its `.enc` (put back while the app was open, its `.enc` still elsewhere):
  // it holds the only wrapped copy of that workspace's data key, which the commit below would
  // replace. (A belt behind `WorkspaceController.create()`'s own check, which runs first, and
  // re-checked right before the commit.)
  if (existsSync(vaultPaths.encPath) || existsSync(vaultPaths.descriptorPath)) throw new WorkspaceExistsError()
  let descriptor: VaultDescriptor
  /** The key the database FILE is encrypted under (v2: data key; v1: password key). */
  let fileKey: Buffer
  if (opts.legacyV1) {
    const salt = generateSalt()
    fileKey = deriveKey(password, salt, kdf)
    descriptor = {
      version: VAULT_VERSION,
      mode: 'encrypted',
      kdf,
      saltB64: salt.toString('base64'),
      verifier: blobToJson(makeVerifier(fileKey))
    }
  } else {
    fileKey = generateDataKey()
    descriptor = buildEnvelopeDescriptor(password, fileKey, kdf)
  }

  // full-audit 2026-07-11 CODE-14 — crash-safe creation with the rekey-journal ordering:
  // build + seed + checkpoint the database, encrypt it STAGED as `.enc.new` (the rekey
  // journal's own suffix), and only then write the descriptor — the single atomic COMMIT
  // POINT (writeVaultDescriptor is fsync + rename). A crash BEFORE it leaves neither a
  // descriptor nor an `.enc`, so init() still reports `uninitialized` and onboarding
  // retries (a crash leaves the staged file behind: the retry overwrites it, but a
  // workspace put back into the same folder first would have it rolled over its `.enc` —
  // the crash variant of #954's S-1, open as its own issue). A crash AFTER it is the
  // committed-rekey crash state: `recoverPendingRekey` rolls the staged file forward on the
  // next init()/unlock. The descriptor used to be written FIRST — a crash mid-create then
  // bricked onboarding behind the misleading "restore workspace.json" hint (the actual
  // repair was deleting it). NB the `legacyV1` fixture path shares this ordering but not
  // the roll-forward (recovery is v2-gated); it exists only so tests can build migration
  // fixtures — the app never passes it.
  //
  // #954 S-1: a create that FAILS before the commit (the descriptor's temp cannot be written
  // or renamed, a full drive, the re-check below) removes what it staged before it rethrows:
  // `.enc.new` is ciphertext under a key nothing holds, and the next start's rekey recovery
  // rolls ANY `.enc.new` forward under a v2 descriptor, so a workspace put back later into
  // the same folder would have its `.enc` shredded and replaced by this empty one. Removed:
  // the staged file and the two write temps (`.enc.new.tmp`, `workspace.json.tmp`: temps
  // nothing reads), once the encrypt has returned. A failure before that (the open, #247, or
  // the encrypt itself, which replaces `.enc.new` only at its last step) leaves a staged file
  // already there alone, as it is not this create's (review V F-5); an encrypt that fails
  // removes only its own temp. After the commit nothing is removed: the workspace exists, and
  // a retry is refused.
  const staged = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  /** The encrypt began: its write temp `.enc.new.tmp` may be this create's. */
  let encrypting = false
  /** The encrypt returned: `.enc.new` is this create's. */
  let stagedHere = false
  let committed = false
  try {
    // #247: a leftover plaintext file at `dbPath` stamped by a NEWER build makes this open
    // throw (handled: the create IPC reports `workspace_newer`) — the key is zeroed either way.
    const db = openDatabase(vaultPaths.dbPath)
    seedSettings(db)
    updateSettings(db, { workspaceMode: 'encrypted' })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    encrypting = true
    encryptFile(vaultPaths.dbPath, staged, fileKey)
    stagedHere = true
    shredFile(vaultPaths.dbPath)
    cleanSidecars(vaultPaths.dbPath)
    // #954: the commit replaces whatever is at the descriptor's name, and the key derivation and
    // the stage above take a while (about half a second): a key file or `.enc` that appeared in
    // that window (copied back while the lock screen was open) is refused here, as at the start.
    if (existsSync(vaultPaths.descriptorPath) || existsSync(vaultPaths.encPath)) throw new WorkspaceExistsError()
    writeVaultDescriptor(vaultPaths.descriptorPath, descriptor) // COMMIT POINT
    committed = true
    renameSync(staged, vaultPaths.encPath)
  } catch (err) {
    if (!committed) {
      // Once the encrypt returned, `.enc.new` is this create's and goes with the two write temps. An encrypt that
      // throws replaced nothing at `.enc.new` (it writes `.enc.new.tmp` and renames it only at its end), so only its
      // temp goes (`encryptFile` removes it itself, which a directory or a hold there can defeat).
      const leftovers = stagedHere
        ? [staged, `${staged}.tmp`, `${vaultPaths.descriptorPath}.tmp`]
        : encrypting
          ? [`${staged}.tmp`]
          : []
      for (const leftover of leftovers) {
        try {
          rmSync(leftover, { force: true })
        } catch {
          /* best-effort: the failure being reported is the create's own */
        }
      }
    }
    throw err
  } finally {
    fileKey.fill(0)
  }
}

/** The in-memory result of a successful unlock. */
export interface UnlockedVault {
  db: Db
  /** The FILE key data is encrypted under: v2 = the unwrapped data key; v1 = the
   *  password-derived key. Lives only in memory; zeroed on lock. */
  key: Buffer
  descriptor: VaultDescriptor
  /** #875: this unlock shredded a `.recovery` newer than `.enc` that was no longer a database (its header reads, its
   *  structure does not): the failed lock's session it held is lost. */
  recoveryDiscarded: boolean
  /** #911: `.enc` was missing, and this unlock encrypted the `.recovery` copy the start kept as the new `.enc`. */
  restoredMissingEnc: boolean
}

/**
 * Unlock an encrypted vault: derive the key, verify the password against the descriptor
 * (no DB access), unwrap the data key on a v2 descriptor, decrypt `.enc` → working file,
 * and open the database. Throws `WrongPasswordError` on a bad password (the GCM verifier
 * fails, the DB is never touched). Before the password is even checked: `VaultNewerError` when a
 * vault artifact is in a format a newer build wrote (#845). After the password verified:
 * `VaultRecoveryBlockedError` (#242), `WorkspaceNewerError` (#247), `VaultDamagedError` when `.enc`
 * fails its tag (#860 V5b) or SQLite finds no database or a corrupt one (#208),
 * `VaultOpenFailedError` when the open could not finish otherwise (#844), and `VaultMissingError` when there is no `.enc`
 * and no `.recovery` copy to roll forward over it (#911).
 */
export function unlockEncryptedVault(
  vaultPaths: VaultPaths,
  password: string,
  onProbeFallback?: ProbeFallbackNote
): UnlockedVault {
  // #845: FIRST, before the rekey recovery, the `.recovery` roll-forward, the sidecar clean or the decrypt can write
  // anything, and independent of the password (a newer format's verifier may differ): a vault a newer build wrote is
  // refused as it is.
  const verdict = vaultFormatVerdict(vaultPaths)
  if (verdict.kind === 'newer') throw new VaultNewerError(verdict.what, verdict.found)
  const descriptor = readVaultDescriptor(vaultPaths.descriptorPath)
  if (!descriptor) {
    // One stat of `.enc`, judged as #911 does: only ENOENT proves it is not there (`existsSync` reads any failure, a
    // delete-pending file or a permission error, as "missing").
    const enc = encryptedFileState(vaultPaths)
    // C-S2 (#807): the data is there but nothing can open it; restore the descriptor, never create a new workspace.
    if (enc === 'present') throw new VaultDescriptorMissingError()
    // #955 item 1: a descriptor FILE that cannot be read, and no `.enc`: its own refusal (a newer one was refused above).
    // Review V F-4: not on a stat that proves nothing, where the copy's "isn't on the drive" could be untrue.
    if (enc === 'missing' && existsSync(vaultPaths.descriptorPath)) throw new VaultDescriptorUnreadableError()
    throw new Error('No encrypted workspace to unlock')
  }
  // A crash during a password change must be resolved BEFORE any decrypt: the descriptor
  // decides whether staged `.new` files roll forward (committed) or are discarded.
  recoverPendingRekey(vaultPaths, descriptor)
  const salt = Buffer.from(descriptor.saltB64, 'base64')
  const kdfT0 = performance.now()
  const key = deriveKey(password, salt, descriptor.kdf)
  const kdfMs = perfMs(kdfT0)
  if (!verifyKey(key, blobFromJson(descriptor.verifier))) {
    // L-6: zero the KDF-derived key before throwing, for symmetry with the data-key paths
    // (which zero the KEK/old data keys after use). A wrong-password attempt should not
    // leave the derived key sitting in the heap.
    key.fill(0)
    throw new WrongPasswordError()
  }
  // #858: from here on, EVERY failure zeroes the file key (the catch below), not only the named
  // ones. A corrupt wrapped data key used to leave the KEK in the heap; a tag-failing `.enc`, a
  // roll-forward that cannot write, or a throw after the decrypt left the data key, and a throw
  // after the open also left the plaintext working file on disk and its handle open. Once
  // plaintext exists on disk, the way out closes the database and shreds it.
  // v2 envelope: the derived key is only the KEK — unwrap the data key, then drop the KEK at once
  // (if the unwrap throws, `fileKey` is still the KEK and the catch zeroes it). v1: the derived key
  // IS the file key, returned on success.
  let fileKey = key
  let plaintextOnDisk = false
  // Declared wide: it is assigned inside the open's own try below, which the outer catch's
  // narrowing does not follow (it would read `openedDb` as always null there).
  let openedDb = null as Db | null
  try {
    if (descriptor.version >= VAULT_VERSION_ENVELOPE && descriptor.dataKey) {
      fileKey = decrypt(key, blobFromJson(descriptor.dataKey))
      key.fill(0)
    }
    // full-audit 2026-07-11 CODE-1b — roll a preserved newer working file FORWARD now that
    // the key exists: re-encrypt it over the stale `.enc` (encryptFile is atomic tmp→rename
    // and fsyncs — CODE-10), shred it, and continue with the normal unlock, which decrypts
    // the freshly written `.enc` right back. If the re-encrypt fails (e.g. the disk is
    // still full) the snapshot survives under `.recovery` for the next attempt.
    //
    // The roll-forward is GUARDED like the init() salvage (CODE-1 review follow-up F1):
    // shredFile is best-effort, so a CONSUMED `.recovery` can outlive its unlink (Windows:
    // AV/search indexer holding the file without FILE_SHARE_DELETE). Unguarded, that
    // leftover would (a) if still intact, re-encrypt a now-STALE snapshot over the fresh
    // `.enc` on every later unlock — a silent recurring rollback of everything since the
    // failed lock — or (b) if the shred's random-overwrite ran but the unlink failed,
    // encrypt GARBAGE over the good `.enc` (GCM verifies fine — it is our own ciphertext)
    // and destroy the workspace. So roll forward only a snapshot that is still the
    // freshest data: a database SQLite can read (`probeDatabaseFile`: the structure, not only
    // the header, #876) strictly NEWER than `.enc` (mtime; a
    // missing `.enc` counts as older — restoring an unlockable vault beats none). Anything
    // else is a spent or corrupt leftover: shred it (retrying the failed unlink) and
    // unlock normally.
    const recoveryPath = `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`
    let recoveryDiscarded = false
    let restoredMissingEnc = false
    // #911 (code review): `.enc` is judged ONCE, by the start's rule: only ENOENT is missing. `existsSync` read any other
    // stat failure (a delete-pending file on Windows, EPERM, EBUSY) as "missing", so a spent `.recovery` could be
    // encrypted over a good `.enc`.
    const enc = statEncryptedFile(vaultPaths)
    let encMissing = enc.state === 'missing'
    if (existsSync(recoveryPath)) {
      // #911: an `.enc` that cannot be judged is doubt, as at the start (#242): never roll forward over it, and never
      // shred a copy that may be the freshest data. Refuse; the next unlock retries.
      if (enc.state === 'unknown') throw new VaultRecoveryBlockedError()
      // full-audit 2026-07-12 REL-2 — the freshness PROBE is exception-guarded: a Windows
      // AV/indexer hold without FILE_SHARE_READ (or the file vanishing between existsSync and
      // openSync) throws EBUSY/EPERM/ENOENT here, which used to fail the whole unlock raw
      // (generic openFailed) until the hold cleared. Only the probe is wrapped: a roll-forward
      // encryptFile failure (e.g. disk still full) keeps failing the unlock so the snapshot
      // survives untouched.
      let fresher: boolean | null = null
      try {
        // A probe that cannot decide (a hold, the file vanishing) is the probe error handled below.
        const probe = probeDatabaseFile(recoveryPath)
        if (probe.verdict === 'unknown' || probe.verdict === 'gone') {
          throw new Error(`The .recovery probe could not decide (${probe.verdict})`)
        }
        const newer =
          probe.verdict !== 'not-database' &&
          (enc.state === 'missing' || statSync(recoveryPath).mtimeMs > enc.mtimeMs)
        // A structure SQLite cannot read for a reason that is not damage: judged by the header, as
        // before (#876 review round 2).
        fresher = readsAsDatabase(probe, 'recovery', onProbeFallback) && newer
        // #875: our own shred never leaves a header, so a newer copy whose header reads but whose
        // structure does not was the failed lock's session, and shredding it loses that session.
        recoveryDiscarded = probe.verdict === 'damaged' && newer
      } catch {
        // #242 — a probe error means we cannot read the header. If `.recovery` could still be
        // the fresh failed-lock delta — newer than `.enc`, `.enc` missing, or the mtime
        // unreadable too — we must NOT unlock into the stale `.enc` and leave the snapshot to
        // be shredded once a later lock makes `.enc` newer: refuse exactly as the init()
        // salvage does, and let the next unlock retry once the hold clears. Only when `.enc`
        // is demonstrably newer (a spent leftover) is it safe to proceed and unlock normally.
        let encStrictlyNewer = false
        try {
          encStrictlyNewer = enc.state === 'present' && enc.mtimeMs > statSync(recoveryPath).mtimeMs
        } catch {
          /* even the stat failed → treat as possibly fresh → refuse */
        }
        if (!encStrictlyNewer) throw new VaultRecoveryBlockedError()
        /* `.enc` newer → spent leftover → leave it in place, unlock normally */
      }
      if (fresher !== null) {
        if (fresher) {
          // #911: over a missing `.enc` this is the only copy of the workspace (the start kept it, or a failed lock's
          // copy outlived the `.enc` it was newer than), for the IPC's log line.
          restoredMissingEnc = encMissing
          encryptFile(recoveryPath, vaultPaths.encPath, fileKey)
          encMissing = false
        }
        // #875 review round 2: a broken copy that held the failed lock's session is the evidence of
        // that loss, so it is shredded only once this unlock has succeeded (below): an unlock that
        // fails after this point keeps it, and the one that succeeds records the loss. (#911: with no
        // `.enc` no unlock can succeed, so it is shredded just below instead.)
        if (!recoveryDiscarded) shredFile(recoveryPath)
      }
    }
    // #911: the password verified, but there is no encrypted file to open and no `.recovery` was rolled forward over it.
    // A copy the block above found damaged is shredded now (owner decision D3): #875 keeps such a copy as evidence
    // until an unlock succeeds, and with no `.enc` none can, so it would rest in plaintext for ever. Only the right
    // password gets here. `.enc` and the working file are not written; the catch below zeroes the key.
    if (encMissing) {
      if (recoveryDiscarded) shredFile(recoveryPath)
      throw new VaultMissingError(recoveryDiscarded)
    }
    // Verified: clean any stale WAL/SHM from a crash first (otherwise SQLite would replay
    // them onto the freshly-decrypted snapshot and corrupt it), then decrypt + open.
    cleanSidecars(vaultPaths.dbPath)
    const decryptT0 = performance.now()
    try {
      decryptFile(vaultPaths.encPath, vaultPaths.dbPath, fileKey)
    } catch (err) {
      // #860 V5b: the password verified (and a v2 data key unwrapped under its own tag), so a tag failure here means
      // the `.enc` bytes changed: damage, with the restore-from-a-backup copy, never "Could not open". (A descriptor
      // that lost its `version` but kept `dataKey` never gets here: it reads unreadable.) Anything else (a header of
      // another format, an I/O error) goes on as it was.
      throw isFrameAuthError(err) ? new VaultDamagedError('failed-authentication') : err
    }
    plaintextOnDisk = true
    perfMark('vault_unlocked', {
      kdfMs,
      decryptMs: perfMs(decryptT0),
      dbBytes: fileSizeOrNull(vaultPaths.dbPath)
    })
    // #208: the decrypt above verified the GCM tag, so when SQLite finds no database (or a
    // corrupt one) in what came out, the vault ciphertext itself is damaged (it authenticates —
    // it is our own ciphertext — but its plaintext is not a database). Distinguish that from a
    // wrong password, and from an upgrade step that could not finish (#844), and never leave the
    // decrypted output at rest: for a damaged-but-real database those bytes are authentic
    // plaintext user data sitting on disk while the workspace reports locked.
    let db: Db
    try {
      db = openDatabase(vaultPaths.dbPath)
      openedDb = db
      seedSettings(db)
      // #858: re-stamp the mode Settings and Privacy read (create and a plaintext open stamp it
      // too), inside this guard so a failed write cannot leave the keys or the open database behind.
      updateSettings(db, { workspaceMode: 'encrypted' })
    } catch (err) {
      // The plaintext is shredded on the way out (the outer catch), exactly like any failure
      // after the decrypt.
      // #247: a database a NEWER build stamped is not damage — the password verified and the
      // file is a database; it is refused as such (the plaintext is shredded exactly like the
      // damaged case; `.enc` is not rewritten here — a pending `.recovery` above still rolls
      // forward first, so nothing is lost) and the IPC layer names the remedy: update the app.
      // #844: damage only when SQLite says so. Any other failure of the open or of the unlock's
      // own settings writes is a step that could not finish on a database that is fine, and the
      // open does not rewrite `.enc`: not "restore a backup".
      throw openFailure(err)
    }
    if (recoveryDiscarded) shredFile(recoveryPath)
    return { db, key: fileKey, descriptor, recoveryDiscarded, restoredMissingEnc }
  } catch (err) {
    if (openedDb) {
      try {
        openedDb.close()
      } catch {
        // Best-effort. If the handle stays open, Windows cannot unlink the file: the shred still
        // overwrites the plaintext in place, and the next launch's sweep removes the remains.
      }
    }
    if (plaintextOnDisk) {
      shredFile(vaultPaths.dbPath)
      cleanSidecars(vaultPaths.dbPath)
    }
    fileKey.fill(0)
    throw err
  }
}

/** The sites that judge a working file with {@link probeDatabaseFile} (#876), for the log. */
export type ProbeFallbackSite = 'lock' | 'salvage' | 'recovery' | 'rekey'
/** Told when a site judged a file by its SQLite header because the probe could not read its structure for a reason
 *  that is not damage (`unchecked`, with the code): the controller keeps these for the IPC to log. */
export type ProbeFallbackNote = (site: ProbeFallbackSite, code: string) => void

/**
 * #876: does a site treat the file as a database? `database` does; `unchecked` (review round 2) does too, exactly as
 * the header check before the probe did (the probe read the header, only its structural read could not run), and the
 * fallback is reported. Everything else does not.
 */
function readsAsDatabase(probe: DatabaseFileProbe, site: ProbeFallbackSite, onProbeFallback?: ProbeFallbackNote): boolean {
  if (probe.verdict === 'unchecked') {
    onProbeFallback?.(site, probe.code ?? 'unknown')
    return true
  }
  return probe.verdict === 'database'
}

/** What a lock found at the working file after the close (#876): whether the `-wal` still holds commits after the one
 *  retry, and the probe's answer (null when the WAL refused the lock before the probe ran). */
export interface WorkingFileVerdict {
  walPending: boolean
  probe: DatabaseFileProbe | null
}

/**
 * Thrown by {@link lockEncryptedVault} once it has judged the working file (#876 review round 2): it refused because
 * the `-wal` still holds commits (`wal`) or the file is no database (`probe`), or the encrypt failed after a passing
 * judgement (`encrypt`, the cause attached). The controller reads the verdict instead of probing the file again.
 */
export class LockStoppedError extends Error {
  constructor(
    readonly reason: 'wal' | 'probe' | 'encrypt',
    readonly verdict: WorkingFileVerdict,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'LockStoppedError'
  }
}

/**
 * Lock an unlocked encrypted vault: checkpoint + close the DB (flushing WAL into the
 * main file), re-encrypt the working file → `.enc`, then shred the plaintext working
 * file and its sidecars. Idempotent-ish: safe to call once per unlock. Once it has judged the
 * working file, any failure is a {@link LockStoppedError} carrying that judgement.
 */
export function lockEncryptedVault(
  vaultPaths: VaultPaths,
  db: Db,
  key: Buffer,
  /** Test seam (full-audit 2026-07-11 CODE-1): the lock path's re-encrypt boundary.
   *  Production callers omit it; tests inject a throwing impl to drive the lock-failure
   *  recovery without needing a genuinely full disk. */
  encryptFileImpl: typeof encryptFile = encryptFile,
  /** Told when the probe fell back to the header (`unchecked`). */
  onProbeFallback?: ProbeFallbackNote
): void {
  // Flush WAL into the main file so the encrypted snapshot is complete, then close.
  const checkpointT0 = performance.now()
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* checkpoint is best-effort; close still flushes */
  }
  db.close()
  const checkpointMs = perfMs(checkpointT0)
  const dbBytes = fileSizeOrNull(vaultPaths.dbPath)
  // #208 — NEVER encrypt a non-database over `.enc`. The CODE-1b roll-forward has carried
  // this guard since 2026-07-11; the plain lock path did not, and that is exactly how a
  // real vault died: a second app instance's startup sweep random-overwrote this session's
  // working file in place (Windows lets the overwrite through SQLite's share modes while
  // the unlink fails without FILE_SHARE_DELETE, so the noise keeps the original name), the
  // session noticed nothing (reads ride the page cache), and lock-on-quit encrypted the
  // noise over the only good snapshot — GCM verifying fine forever after, because it is
  // our own ciphertext. Whatever put garbage under dbPath, refusing here keeps the stale
  // `.enc` (a recoverable vault) instead of replacing it with authenticated noise; the
  // session's unsaved delta is already lost either way. An UNREADABLE source is refused
  // too — encrypting bytes we cannot even probe over the vault is never the safe branch.
  // The controller maps the throw like any lock failure (CODE-1a); since #855 it finishes the
  // lock at the last snapshot when its own probe judges the file gone or no database.
  // #876 — "a database" is SQLite's verdict on the STRUCTURE (`probeDatabaseFile`), not the
  // 16-byte header: the checkpoint above writes page 1 back from the WAL, so a file overwritten
  // in place while the session's last commits sat there starts with a valid header over noise.
  // #876 review round 1 — a `-wal` that still holds commits after the close means the checkpoint
  // did not finish (a full drive: commits still land in the WAL's allocated space, the copy back
  // fails where the main file has to grow). The main file alone is then stale, or torn where the
  // copy stopped, while the session is intact in it plus the WAL. Encrypting that main file would
  // lose the session's commits once the WAL is shredded below (which happened before); judging it
  // with the probe would call a good session damaged. So refuse first: the controller re-opens the
  // session (the open replays the WAL) and the user frees space and locks again (CODE-1a).
  // Review round 2: a `-wal` can also be there holding nothing the main file lacks (SQLite already
  // copied it in and its delete failed; its frames belong to no checkpoint of this file), or be one
  // the check cannot open (a hold). So the lock retries once, through SQLite: a plain open lets
  // SQLite's own WAL recovery decide, a TRUNCATE checkpoint copies in what is real, and only a WAL
  // that still holds commits afterwards refuses. When SQLite calls the database itself corrupt, the
  // WAL cannot be replayed into it and protects nothing: the probe below judges the file.
  let walRetry: WalCheckpointRetry | null = null
  let walPending = walAwaitsCheckpoint(vaultPaths.dbPath)
  if (walPending) {
    walRetry = checkpointLeftoverWal(vaultPaths.dbPath)
    walPending = walRetry.outcome !== 'damaged' && walAwaitsCheckpoint(vaultPaths.dbPath)
  }
  if (walPending) {
    throw new LockStoppedError(
      'wal',
      { walPending: true, probe: null },
      'Refusing to lock: the checkpoint did not finish, so the -wal still holds commits the working ' +
        `database file lacks (retry: ${walRetry?.outcome}). Keeping the session open and the previous encrypted snapshot.`
    )
  }
  const probeT0 = performance.now()
  const probe = probeDatabaseFile(vaultPaths.dbPath)
  const probeMs = perfMs(probeT0)
  const verdict: WorkingFileVerdict = { walPending: false, probe }
  // Review round 2: the probe only adds a refusal for proven damage; a structure it could not read
  // for another reason is judged by the header, which it read, as the lock did before (and noted).
  if (!readsAsDatabase(probe, 'lock', onProbeFallback)) {
    throw new LockStoppedError(
      'probe',
      verdict,
      'Refusing to lock: the working database file is not a SQLite database (it may have ' +
        `been overwritten; probe: ${probe.verdict}). Keeping the previous encrypted snapshot.`
    )
  }
  const encryptT0 = performance.now()
  try {
    encryptFileImpl(vaultPaths.dbPath, vaultPaths.encPath, key)
  } catch (err) {
    throw new LockStoppedError('encrypt', verdict, 'The lock could not re-encrypt the working file', { cause: err })
  }
  const encryptMs = perfMs(encryptT0)
  const shredT0 = performance.now()
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
  // Covers BOTH lock paths (the explicit lock IPC and the quit teardown); the mark is an
  // appendFileSync, so it lands before app.exit(). checkpointMs includes db.close().
  perfMark('vault_lock_done', {
    checkpointMs,
    probeMs,
    encryptMs,
    shredMs: perfMs(shredT0),
    dbBytes
  })
}

/** Size of a file for a perf mark, or null; a stat failure must never break lock/unlock. */
function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

// ---- plaintext gating ------------------------------------------------------------

/**
 * Is a plaintext (developer) workspace permitted? Gated by the drive policy AND a
 * developer signal. `encryptionRequired` is an absolute veto; `allowPlaintextDevMode`
 * must be true; and the caller must be a developer.
 *
 * Proxy rule: the `developerMode` *setting* lives in the (possibly still locked,
 * encrypted) workspace DB, so it cannot gate the decision of whether that DB opens
 * at all — the dev-build flag (`isDev`) is the developer signal here.
 */
export function plaintextAllowed(policy: PrivacyPolicy, opts: { isDev: boolean }): boolean {
  if (policy.workspace.encryptionRequired) return false
  if (!policy.workspace.allowPlaintextDevMode) return false
  return opts.isDev
}

// ---- stateful controller (used by the main process) ------------------------------

/**
 * The narrow shape {@link workspaceAdmitsWork} reads: exactly its two members. Structural (not the
 * class) so a partial test context can supply a stand-in (every product caller passes the
 * controller).
 */
export interface WorkspaceAdmission {
  isUnlocked(): boolean
  isLocking(): boolean
}

/**
 * AUD-02 — the single admission predicate every CONTENT-bearing surface must use instead of a
 * bare `isUnlocked()`.
 *
 * `isUnlocked()` is literally "the DB handle is non-null", and the DB is nulled only by the very
 * LAST step of the lock path. "Lock now" first runs a multi-second AWAITED teardown (sidecar
 * suspends, in-flight-stream settles, the doc-task settle, the resident-vector purge), and an
 * async `ipcMain.handle` yields the main thread at each of those awaits — so an invoke landing
 * seconds after the user clicked Lock now used to be DISPATCHED and ADMITTED with `isUnlocked()`
 * still true. Because `suspend()`/`stop()` are deliberately NON-latching (the sidecars must come
 * back lazily after the next unlock), that admitted work then lazily RESPAWNED the sidecar the
 * teardown had just killed — a multi-GB child holding document/image-derived text in its KV cache,
 * still running after the workspace reports locked. Adding `!isLocking()` closes exactly that
 * window: during the teardown "the workspace is locked" is the honest answer, and the renderer
 * swaps to the lock gate the moment the handler resolves anyway.
 *
 * Fail-CLOSED on a missing controller.
 */
export function workspaceAdmitsWork(workspace: WorkspaceAdmission | null | undefined): boolean {
  if (!workspace) return false
  return workspace.isUnlocked() && !workspace.isLocking()
}

/**
 * Owns the workspace DB lifecycle for the running app. In `plaintext_dev` mode the DB
 * opens immediately at startup (zero-friction dev, current behavior). In `encrypted`
 * mode the DB stays closed until `unlock`/`create`, and `requireDb` throws meanwhile —
 * but the app shell gates UI behind `getState()` so DB-backed IPC is not reached.
 */
export class WorkspaceController {
  private _db: Db | null = null
  private key: Buffer | null = null
  private descriptor: VaultDescriptor | null
  private _mode: WorkspaceMode | null = null
  /** Open document-work holds (import/re-index writing `.enc` sidecars) — see the
   *  race guard on `changePassword`/`beginDocumentWork`. */
  private docWork = 0
  /** True while `changePassword` runs (defensive: it is synchronous today). */
  private changingPassword = false
  /**
   * #242 — set by {@link init} when the startup salvage FAILED: a working file newer than
   * `.enc` (the only fresh copy of the last session's data) could not be moved aside because
   * a held `.recovery` sits on the target. While set, the crash sweep and the pending-rekey
   * recovery are skipped and {@link unlock} is refused — it re-runs the salvage first, so the
   * user's next unlock clears the state once the hold is gone.
   */
  private _recoveryBlocked = false
  private _newerWorkspace = false
  /** #845: what {@link init} found a newer build wrote (the vault format verdict), or null. While set, `init()` has
   *  written nothing, the workspace reports locked, and every unlock refuses with `VaultNewerError`. */
  private _vaultNewer: { what: VaultNewerWhat; found: string | number } | null = null
  /** Review V F-2: the last {@link init} ran its steps to their end (false before the first, after one that threw
   *  part-way, and, security review V S-1, after one that stopped at a newer-format verdict or a blocked salvage).
   *  Read by {@link vaultAppearedSinceStart} only. */
  private _startStepsDone = false
  /** Review V F-2: a loss {@link init} judged (it then shredded that session) and has not recorded yet: an `init()` that
   *  stops between the sweep and the record leaves it for the next one (`enc`: the frame IV it was judged against). */
  private _unrecordedStartLoss: { cause: MarkedLossCause; enc: string | null } | null = null
  /**
   * #875: a lock finished at the last snapshot (#855), here or, by the marker {@link init} read, in an earlier run
   * (or the startup salvage shredded the last session's only fresh copy, or, #892, the session an unclean end left
   * behind). While set and the workspace is locked, {@link getState} reports the cause's `lockNotice`
   * ({@link LOCK_NOTICE}); the next successful unlock clears it.
   */
  private _workingCopyLost: MarkedLossCause | null = null
  /**
   * #911: {@link init} found the encrypted descriptor with `.enc` missing and a `.recovery` copy waiting (kept by this
   * start or an earlier one, by any build): the only copy of the workspace, unencrypted until the next unlock. Read
   * from the disk on every start, so it needs no marker and survives a restart; while set and the workspace is locked,
   * {@link getState} reports `lockNotice: 'encrypted_file_missing'`. A successful unlock clears it; a failed one
   * re-reads it, so it goes once no copy is kept any more (review SF-2).
   */
  private _encMissingKept = false
  /** #911: the last successful unlock encrypted the kept copy as the new `.enc`, for the IPC to log once
   *  ({@link takeRestoredMissingEnc}). */
  private _restoredMissingEnc = false
  /** #911: the disk state behind {@link _encMissingKept}: `.enc` absent (ENOENT) and a `.recovery` copy waiting that
   *  starts like a database (the #892 header read, 100 bytes: cheap, and read only at {@link init} and after a failed
   *  unlock, never per {@link getState}). One that does not is no copy to keep: the unlock shreds it and says the file
   *  is missing, so no notice promises it; one whose header cannot be read shows none either (code review). */
  private encMissingKeptOnDisk(): boolean {
    if (encryptedFileState(this.vaultPaths) !== 'missing') return false
    try {
      return startsLikeDatabase(`${this.vaultPaths.dbPath}${RECOVERY_SUFFIX}`)
    } catch {
      return false // absent, or unreadable
    }
  }
  /** #911: this start found the only copy with `.enc` missing and its structure damaged, and swept it
   *  ({@link discardedOnlyCopy}). */
  private _discardedOnlyCopy = false
  /** #875: what the last successful unlock consumed, for the IPC to record once ({@link takeWorkingCopyLost}). */
  private _lostAtPreviousLock: { cause: WorkingCopyLossCause; lostAt: string | null } | null = null
  /** #876 review round 2: sites that judged a file by its header because the probe could not read its structure (not
   *  damage), for the IPC to log ({@link takeProbeFallbacks}). Bounded. */
  private _probeFallbacks: Array<{ site: ProbeFallbackSite; code: string }> = []
  private readonly noteProbeFallback: ProbeFallbackNote = (site, code) => {
    if (this._probeFallbacks.length < 20) this._probeFallbacks.push({ site, code })
  }
  /**
   * AUD-02 — armed by {@link beginLock} as the FIRST act of the interactive lock path, before
   * any await, and read by {@link workspaceAdmitsWork}. See that function for why `isUnlocked()`
   * alone cannot express "a lock is under way": the DB stays open for the whole teardown.
   */
  private _locking = false
  /**
   * AUD-03 — a monotonically increasing SESSION counter, bumped every time the DB transitions
   * closed → open (unlock / create / the plaintext open at startup). It identifies WHICH unlocked
   * session a long-running piece of work was admitted into: a model start can spend minutes
   * hashing a multi-GB GGUF before it spawns anything, and a lock plus a subsequent unlock can
   * both complete inside that window — leaving `isUnlocked()` true and `isLocking()` false again,
   * so neither flag can tell the stale start apart from a fresh one. Comparing the epoch can.
   */
  private _epoch = 0

  constructor(
    private readonly vaultPaths: VaultPaths,
    private readonly policy: PrivacyPolicy,
    private readonly isDev: boolean,
    /** Test seam (full-audit 2026-07-11 CODE-1): the lock path's re-encrypt boundary,
     *  forwarded to `lockEncryptedVault`. Production callers omit it. */
    private readonly encryptFileImpl: typeof encryptFile = encryptFile,
    /** #892: the free space on the drive at `path`, in bytes, or null when the drive cannot say. {@link init} reads it
     *  to tell an unclean end on a drive too full to lock from any other. The OS's own figure (`disk-space.ts`, the one
     *  the drive status and the downloader read) unless the caller hands in another drive: a test cannot fill one. */
    private readonly freeBytes: (path: string) => number | null = freeBytesSync
  ) {
    this.descriptor = readVaultDescriptor(vaultPaths.descriptorPath)
  }

  /** The live database; throws when the workspace is locked/uninitialized. */
  requireDb(): Db {
    if (!this._db) throw new Error('Workspace is locked — unlock it first.')
    return this._db
  }

  isUnlocked(): boolean {
    return this._db !== null
  }

  /** True while the startup salvage is blocked by a held `.recovery` (#242) — see {@link _recoveryBlocked}. */
  isRecoveryBlocked(): boolean {
    return this._recoveryBlocked
  }

  /** #876 review round 2: the sites that judged a file by its SQLite header since the last call, because the probe could
   *  not read its structure for a reason that is not damage (site + content-free code). Returns them once, for the IPC
   *  to log; a quit's notes go with the process. */
  takeProbeFallbacks(): Array<{ site: ProbeFallbackSite; code: string }> {
    const notes = this._probeFallbacks
    this._probeFallbacks = []
    return notes
  }

  /**
   * AUD-02 — arm the lock latch. The interactive lock path calls this as its FIRST act, before
   * the awaited sidecar/stream/task teardown, so every admission guard reports "locked" for the
   * whole teardown instead of only after the final `lock()`. Latch-only and synchronous: it
   * changes nothing about the DB, so the teardown itself (which still reads `ctx.db` to persist
   * partial replies, purge vectors and write the audit event) is unaffected — `requireDb()`
   * deliberately does NOT consult it.
   *
   * Cleared by {@link cancelLock} when the lock FAILS (the controller restores itself to a
   * consistently unlocked state there, so the session must keep working) and by the next
   * `unlock`/`create`. A COMPLETED lock deliberately leaves it armed: `isUnlocked()` already
   * reports locked, and the next unlock clears it.
   *
   * The quit path arms it too — `performShutdown` (main/shutdown.ts) calls this as ITS first
   * act, before the quit teardown's own awaited windows (see the rationale there: vision
   * rebuilds its runtime per analyze, an admitted import strands a plaintext transient at
   * `app.exit(0)`). Nothing on that path clears it and the process exits, so on quit the latch
   * is terminal by construction; only the controller's own `shutdown()` METHOD skips arming,
   * because its callers have already armed.
   */
  beginLock(): void {
    this._locking = true
  }

  /** True from {@link beginLock} until the lock fails or the next unlock. See {@link workspaceAdmitsWork}. */
  isLocking(): boolean {
    return this._locking
  }

  /**
   * Disarm the lock latch after a FAILED lock. `lock()` restores the controller to a consistently
   * UNLOCKED state on failure (plaintext DB re-opened, key kept for the retry), so leaving the
   * latch armed would strand the still-open workspace behind a permanent "locked" refusal that
   * nothing could clear short of a relaunch.
   */
  cancelLock(): void {
    this._locking = false
  }

  /** The current session counter (AUD-03) — see {@link _epoch}. 0 before the first open. */
  unlockEpoch(): number {
    return this._epoch
  }

  /** Record a closed → open DB transition: new session id, latch cleared. */
  private beginSession(): void {
    this._locking = false
    this._epoch += 1
  }

  private allowPlaintext(): boolean {
    return plaintextAllowed(this.policy, { isDev: this.isDev })
  }

  /**
   * A vault exists on disk when there is a valid encrypted descriptor, OR the encrypted
   * database itself is present, OR a descriptor file exists but is unreadable (corrupt, or
   * a newer build's), OR startup found any other artifact a newer build wrote (#845).
   * In every one of those cases the create flow must be refused — it would overwrite
   * the user's data with an empty vault.
   *
   * #954: the descriptor FILE is read live too, so a valid `config/workspace.json` put back
   * after the start (while the lock screen's create form was open) counts, and `getState()`
   * reports `locked` for it. The descriptor read at the start still counts on its own: a
   * vault seen then stays a vault for the session, so a drive that drops out never turns
   * the lock screen into the create form.
   */
  private vaultExistsOnDisk(): boolean {
    return (
      this.descriptor?.mode === 'encrypted' ||
      existsSync(this.vaultPaths.descriptorPath) ||
      existsSync(this.vaultPaths.encPath) ||
      isDescriptorUnreadable(this.vaultPaths.descriptorPath) ||
      this._vaultNewer !== null
    )
  }

  /**
   * #954, #955 item 3 (S-2): a descriptor file is on the drive that the last {@link init} did not adopt: put back after
   * the start (the #807 "put the file back" step, a whole workspace copied back, a create that failed after its
   * commit), or one it could not read; or (review V F-2) one it adopted but whose steps did not run to their end. The
   * start's decisions over a vault (the salvage of a newer working file, the sweep, the rekey recovery, the lock
   * notices) were skipped for it, so `unlock()` runs them now, before anything is decrypted (a refused `create()` writes
   * nothing, review V F-1). For a file that still cannot be read, `init()` writes nothing.
   */
  private vaultAppearedSinceStart(): boolean {
    return existsSync(this.vaultPaths.descriptorPath) && (this.descriptor === null || !this._startStepsDone)
  }

  private openPlaintext(): void {
    const db = openDatabase(this.vaultPaths.dbPath)
    seedSettings(db)
    updateSettings(db, { workspaceMode: 'plaintext_dev' })
    this._db = db
    this._mode = 'plaintext_dev'
    this.beginSession()
  }

  /**
   * Decide the startup state. An encrypted descriptor → stay LOCKED until unlock. No
   * descriptor → open plaintext if permitted (dev), else UNINITIALIZED (await onboarding).
   *
   * Review V F-2: whether the steps ran to their end is recorded ({@link _startStepsDone}), on every return path: a
   * throw part-way (a held `.enc.new.tmp` in the rekey recovery) leaves it false, and the next unlock runs them again
   * instead of decrypting after a start that stopped half-way. Running them again is what the next start would do on
   * the same disk (a start cut short by a crash leaves exactly that), so every step is safe on what an earlier,
   * interrupted run left.
   */
  init(): void {
    this._startStepsDone = false
    this.runStartSteps()
    // Security review V S-1: a run that stopped at a newer-format verdict or a blocked salvage skipped the steps and
    // wrote nothing, so it is not "done" (a create's `readFormat()` can clear that verdict later without running them).
    this._startStepsDone = this._vaultNewer === null && !this._recoveryBlocked
  }

  /** The steps of {@link init}. */
  private runStartSteps(): void {
    // #845: FIRST, before anything below can rename, shred or roll forward a file: a vault artifact in a format a
    // NEWER build wrote (the descriptor, its KDF, the `.enc` and staged frames, the rekey journal) leaves the whole
    // workspace as it is. It stays locked, the create flow is refused, and every unlock answers "update the app".
    // Every per-start flag is re-decided from the disk first: unlock() re-runs init(), and a flag a previous run set
    // (a blocked salvage, #242) must not outlive it, or it would answer instead of the newer format (W2 review 2).
    this._recoveryBlocked = false
    this._newerWorkspace = false
    this._encMissingKept = false
    this._discardedOnlyCopy = false
    if (this.readFormat()) return
    if (this.descriptor?.mode === 'encrypted') {
      // Crash recovery: an encrypted vault must have NO plaintext working file at rest.
      // If a previous run was killed before lock-on-quit ran, shred the leftover so the
      // decrypted database (+ WAL/SHM) never lingers on disk. Safe (see shredStalePlaintext)
      // EXCEPT in two states, whose working file is moved aside FIRST and rolled forward at
      // unlock instead of shredded: the failed-lock state (full-audit 2026-07-11 CODE-1b), a
      // cleanly-closed working file NEWER than `.enc`, the only fresh copy of the last
      // session's data; and (#911) a working file with `.enc` itself missing, the only copy of
      // the workspace (`'kept-only-copy'`, sweep safe like `'preserved'`).
      // #242: when that move FAILS (a held `.recovery` on the target), or a check cannot
      // decide (#911: a stat of `.enc` that fails other than ENOENT, a `-wal` the replay
      // cannot empty), refuse to sweep (the working file is still the only fresh copy) and
      // refuse to open until a retry lands it; the pending-rekey recovery waits as well
      // (unlock runs it once admitted).
      const salvage = preserveNewerPlaintext(this.vaultPaths, this.noteProbeFallback)
      this._recoveryBlocked = salvage === 'failed'
      this._discardedOnlyCopy = salvage === 'discarded-only-copy'
      if (this._recoveryBlocked) return // locked AND blocked; unlock() re-runs this salvage
      // #892: the app ended without locking, and the sweep below shreds that session. Was the drive too full for a
      // lock (the quit #876 refuses)? Read before the sweep frees the working copy's room, while the drive is as the
      // app left it; and the snapshot the working copy was judged against, for after the rekey recovery.
      const unclean =
        salvage === 'swept-unclean' ? { cause: this.uncleanEndCause(), enc: frameIvOf(this.vaultPaths.encPath) } : null
      // Review V F-2: the loss this run is about to make (the sweep below shreds the session it judged) is held until
      // it is recorded at the end. A run that stops between the two (a throw in the rekey recovery) left nothing for
      // the next one to judge, so that run records the held one instead, against the same `.enc`.
      const heldLoss = this._unrecordedStartLoss
      if (salvage === 'discarded') {
        this._unrecordedStartLoss = { cause: 'startup', enc: frameIvOf(this.vaultPaths.encPath) }
      } else if (unclean !== null) this._unrecordedStartLoss = unclean
      shredStalePlaintext(this.vaultPaths)
      // And resolve any password change the crash interrupted (roll forward or back per
      // the descriptor — unlock would do this too; doing it here keeps disk state clean
      // even while the vault stays locked).
      recoverPendingRekey(this.vaultPaths, this.descriptor)
      // #911: from the disk, after the rekey recovery (which may have rolled a staged `.enc.new` into place), not from
      // this start's outcome: a copy an earlier start kept, by this build or another, is the same state.
      this._encMissingKept = this.encMissingKeptOnDisk()
      // #875: the sweep just shredded the last session's only fresh copy (a header over a broken
      // structure, which no shred of ours leaves), so the workspace opens at `.enc`: the same loss
      // as a lock that finished at the last snapshot, reported the same way. #892: so did a sweep of
      // the session an unclean end left, reported in its own words; recorded after the sweep, which on
      // a full drive frees the room the marker needs, and only while `.enc` is the snapshot the working
      // copy was found newer than: a recovery that swapped it (a password change cut short after its
      // commit) opens the staged copy of that session, so no loss is proven; nor is one against an
      // `.enc` with no readable frame, which names no snapshot to open as it was. Then the marker a
      // lock left (here or in an earlier run, against the `.enc` that is there now) — after the
      // rekey recovery, which may have swapped `.enc`.
      // `.enc`'s frame is read once here, after the recovery, for the comparison, the marker and the adopt.
      const enc = frameIvOf(this.vaultPaths.encPath)
      if (salvage === 'discarded') this.markWorkingCopyLost('startup', enc)
      else if (unclean !== null && unclean.enc !== null && enc === unclean.enc) {
        this.markWorkingCopyLost(unclean.cause, enc)
      } else if (unclean === null && heldLoss !== null && heldLoss.enc !== null && enc === heldLoss.enc) {
        // Review V F-2: what an earlier run judged and shredded, then stopped before recording (see above).
        this.markWorkingCopyLost(heldLoss.cause, enc)
      }
      this._unrecordedStartLoss = null
      this.adoptWorkingCopyLostMarker(enc)
      return // locked; await unlock
    }
    if (this.vaultExistsOnDisk()) {
      // An encrypted vault exists but its descriptor is missing/corrupt. Stay LOCKED:
      // do not open a plaintext DB over it, and (via getState/create) never offer the
      // create flow that would overwrite it. NOTE: do not shred here either — a stale
      // plaintext working file may be the only recoverable copy of the data.
      return
    }
    if (this.allowPlaintext()) {
      try {
        this.openPlaintext()
      } catch (err) {
        // #247: the plaintext database on disk was written by a NEWER build. `openDatabase`
        // closed it before any write; stay uninitialized so startup completes (the gate's
        // create then reaches the same refusal and reports `workspace_newer`).
        if (!isWorkspaceNewerError(err)) throw err
        this._newerWorkspace = true
      }
    }
    // else uninitialized → onboarding will create an encrypted workspace
  }

  /** #247: startup found a database written by a newer build and left it closed. */
  isNewerWorkspace(): boolean {
    return this._newerWorkspace
  }

  /** #911 (code review): this start found `.enc` missing and the working file, the only copy, no longer read as a
   *  workspace (its structure damaged), and swept it (owner decision D3). For `main/index.ts`'s one content-free log line;
   *  no marker, no notice (there is no snapshot to name), and the unlock says the file is missing. */
  discardedOnlyCopy(): boolean {
    return this._discardedOnlyCopy
  }

  /**
   * #845: (re-)read the descriptor and judge the vault format: true while an artifact a newer build wrote is on disk.
   * Startup runs it first; `unlock()` and `create()` run it again while a newer verdict stands, because the newer
   * artifact may be gone by then (the newer copy rolled back, a backup restored) and a stale verdict would skip
   * startup's salvage on an unlock, or keep refusing a create.
   */
  private readFormat(): boolean {
    this.descriptor = readVaultDescriptor(this.vaultPaths.descriptorPath)
    const verdict = vaultFormatVerdict(this.vaultPaths)
    this._vaultNewer = verdict.kind === 'newer' ? { what: verdict.what, found: verdict.found } : null
    return this._vaultNewer !== null
  }

  /** #845: what startup found a newer build wrote in the vault's own format (left untouched), or null. */
  newerVaultFormat(): { what: VaultNewerWhat; found: string | number } | null {
    return this._vaultNewer
  }

  getState(): WorkspaceStateInfo {
    const state = this.isUnlocked() ? 'unlocked' : this.vaultExistsOnDisk() ? 'locked' : 'uninitialized'
    return {
      state,
      mode: this._mode ?? this.descriptor?.mode ?? (this.vaultExistsOnDisk() ? 'encrypted' : null),
      plaintextAllowed: this.allowPlaintext(),
      encryptionRequired: this.policy.workspace.encryptionRequired,
      // #875: until the next unlock, in the words of its cause (#892). (Under a newer vault format, #845, startup never
      // reads the marker.)
      // #911: the start kept the only copy of the workspace over a missing `.enc`, until the unlock encrypts it again.
      ...(state === 'locked' && this._workingCopyLost !== null
        ? { lockNotice: LOCK_NOTICE[this._workingCopyLost] }
        : state === 'locked' && this._encMissingKept
          ? { lockNotice: 'encrypted_file_missing' as const }
          : {})
    }
  }

  /**
   * #892: which unclean end the startup sweep is about to report. `unclean-full` when the drive has less free space
   * than the working file and its `-wal` together, both as the app left them (read before the sweep frees them): the
   * session's lock needed room for its checkpoint (the main file grows by what the `-wal` holds) and for its encrypt (a
   * new snapshot the size of the working file), so there was none, which is how a quit on a full drive ends without a
   * lock. (The last `.enc`'s size says nothing about a session that grew past it.) A drive that cannot say, or any
   * other doubt, is the generic case.
   */
  private uncleanEndCause(): 'unclean' | 'unclean-full' {
    try {
      const free = this.freeBytes(dirname(this.vaultPaths.encPath))
      if (free === null) return 'unclean'
      let needed = statSync(this.vaultPaths.dbPath).size
      try {
        needed += statSync(`${this.vaultPaths.dbPath}-wal`).size
      } catch {
        /* only a -shm: nothing to checkpoint */
      }
      return free < needed ? 'unclean-full' : 'unclean'
    } catch {
      return 'unclean'
    }
  }

  /**
   * #875: what the last successful unlock consumed: a lock that had finished at the last snapshot (with the time its
   * marker was written, when there was one), or null. Returns it once, for the IPC to record in the audit log and
   * app.log now that there is a database and a log key again.
   */
  takeWorkingCopyLost(): { cause: WorkingCopyLossCause; lostAt: string | null } | null {
    const lost = this._lostAtPreviousLock
    this._lostAtPreviousLock = null
    return lost
  }

  /** #911: whether the last successful unlock encrypted the copy a start kept over a missing `.enc` as the new `.enc`.
   *  Returns it once, for the IPC to log now that there is a log key (owner decision D5: a log line, no audit type). */
  takeRestoredMissingEnc(): boolean {
    const restored = this._restoredMissingEnc
    this._restoredMissingEnc = false
    return restored
  }

  /** #875: a lock finished at the last snapshot, or a start swept the last session's broken working file (or, #892, the
   *  session an unclean end left): report it until the next unlock, in this run and (best-effort, the marker) the next. */
  private markWorkingCopyLost(cause: MarkedLossCause, enc?: string | null): void {
    this._workingCopyLost = cause
    try {
      writeWorkingCopyLostMarker(this.vaultPaths, cause, enc)
    } catch {
      // Best-effort: this run still shows the notice; only a restart before the next unlock loses it.
    }
  }

  /** #875: adopt the marker a lock left for the `.enc` that is there now (`enc`: its frame's IV, which `init()` has
   *  just read); one a later lock (by any build) made stale is removed; one of another version, or with no readable
   *  `.enc` to judge it by, is left alone. */
  private adoptWorkingCopyLostMarker(enc: string | null): void {
    const marker = readWorkingCopyLostMarker(this.vaultPaths)
    if (marker.kind !== 'current') return
    if (enc === null) return
    if (marker.enc === enc) this._workingCopyLost = marker.cause
    else removeWorkingCopyLostMarker(this.vaultPaths)
  }

  /** #875: a successful unlock opened `.enc`: the notice has been seen, and this build's marker, which can name no
   *  other snapshot now, is removed. Records what was consumed for {@link takeWorkingCopyLost}. */
  private consumeWorkingCopyLost(): void {
    if (this._workingCopyLost !== null) {
      let lostAt: string | null = null
      try {
        if (readWorkingCopyLostMarker(this.vaultPaths).kind === 'current') {
          lostAt = statSync(workingCopyLostPath(this.vaultPaths)).mtime.toISOString()
        }
      } catch {
        /* no time to report */
      }
      this._lostAtPreviousLock = { cause: this._workingCopyLost, lostAt }
      this._workingCopyLost = null
    }
    removeWorkingCopyLostMarker(this.vaultPaths)
  }

  /** Unlock an existing encrypted workspace. Throws `WrongPasswordError` on a bad password. */
  unlock(password: string): WorkspaceStateInfo {
    // Deliberately BEFORE `beginSession()` (AUD-02): an `unlockWorkspace` landing while a lock
    // teardown is in flight must NOT disarm the latch or advance the session epoch. The
    // workspace is still open at that point, so this early return is the only thing standing
    // between a mid-teardown unlock and a re-opened admission window; only the lock handler
    // (via `cancelLock()`) and a genuine closed → open transition may clear the latch.
    if (this.isUnlocked()) return this.getState()
    // #242: a blocked salvage is retried here — the hold may have cleared since init(). Still
    // blocked → refuse: unlockEncryptedVault would decrypt the stale `.enc` over the fresh file.
    // #845: likewise a newer-format verdict: startup skipped the salvage, sweep and rekey recovery
    // for it, so when the newer artifact is gone they run now, before anything is decrypted (still
    // newer → init() writes nothing and unlockEncryptedVault refuses).
    // #955 item 3 (S-2): and a vault that appeared after the start (`vaultAppearedSinceStart`): its
    // working file may be newer than its `.enc` (a failed lock's session), and unlocking without the
    // start's salvage would decrypt the `.enc` over it. Review V F-2: likewise after an init() that
    // threw part-way (here or at the start), so a retry runs the rest of its steps first.
    if (this._recoveryBlocked || this._vaultNewer || this.vaultAppearedSinceStart()) {
      this.init()
      if (this._recoveryBlocked) throw new VaultRecoveryBlockedError()
    }
    let unlocked: UnlockedVault
    try {
      unlocked = unlockEncryptedVault(this.vaultPaths, password, this.noteProbeFallback)
    } catch (err) {
      // #911: a failed unlock can end the state the notice is about (a damaged kept copy shredded; a roll-forward that
      // wrote `.enc` before the open failed, #844), never start it, so a notice shown is re-read from the disk.
      if (this._encMissingKept) this._encMissingKept = this.encMissingKeptOnDisk()
      throw err
    }
    const { db, key, descriptor, recoveryDiscarded, restoredMissingEnc } = unlocked
    this._db = db
    this.key = key
    this.descriptor = descriptor
    this._mode = 'encrypted'
    this.consumeWorkingCopyLost() // #875: the lock screen's notice has been seen
    // #911: the kept copy is `.enc` again (or there was none to keep), so the notice is over.
    this._encMissingKept = false
    this._restoredMissingEnc = restoredMissingEnc
    // #875: a loss this unlock made itself (a broken `.recovery` shredded) is recorded the same way.
    if (recoveryDiscarded && this._lostAtPreviousLock === null) this._lostAtPreviousLock = { cause: 'recovery', lostAt: null }
    // (#858: `unlockEncryptedVault` re-stamped `workspaceMode`, inside its failure guard.)
    // A new session: disarm any latch a completed lock left behind, and bump the epoch so a
    // model start still hashing weights from the PREVIOUS session refuses instead of spawning
    // into this one (AUD-02/AUD-03).
    this.beginSession()
    return this.getState()
  }

  /** First-run create. `encrypted` builds a vault; `plaintext_dev` is gated by policy. */
  create(password: string, mode: WorkspaceMode): WorkspaceStateInfo {
    if (this.isUnlocked()) throw new Error('Workspace is already initialized.')
    if (this._vaultNewer) this.readFormat() // #845: re-judge a newer verdict startup left (see readFormat)
    if (this.vaultExistsOnDisk()) {
      // Reachable when a caller invokes createWorkspace while state is `locked`, or when
      // the descriptor is corrupt. Creating would wipe the existing `.enc` — refuse.
      // #954, #955 item 3: or when a key file was put back after the start, under a create form
      // the lock screen still shows. The state now reads `locked` and the gate switches to its
      // unlock form. The refusal writes nothing (review V F-1: it ran the start's steps once,
      // whose rekey recovery could roll a leftover `.enc.new` over a put-back `.enc` inside a
      // call the user is told changed nothing); the unlock runs them (`vaultAppearedSinceStart`).
      // Review V F-3: a key file that cannot be read with no `.enc` beside it (stat says ENOENT)
      // is answered as the unlock answers it: no password opens anything here, so sending the
      // lock screen to an unlock form would only lead to that message on every try.
      if (
        readVaultDescriptorChecked(this.vaultPaths.descriptorPath).kind === 'unreadable' &&
        encryptedFileState(this.vaultPaths) === 'missing'
      ) {
        throw new VaultDescriptorUnreadableError()
      }
      throw new WorkspaceExistsError()
    }
    // #875: no vault is here, so a marker a wiped one left names no snapshot of the workspace about to be created.
    // Startup reads the marker only beside a vault, so nothing else would remove it, and a reset drive would carry it.
    // The record in memory goes with it (review round 2), so the new workspace's first lock shows no notice of the old.
    removeWorkingCopyLostMarker(this.vaultPaths)
    this._workingCopyLost = null
    this._lostAtPreviousLock = null
    if (mode === 'plaintext_dev') {
      if (!this.allowPlaintext()) throw new PlaintextNotAllowedError()
      this.openPlaintext()
    } else {
      createEncryptedVaultOnDisk(this.vaultPaths, password)
      const { db, key, descriptor } = unlockEncryptedVault(this.vaultPaths, password)
      this._db = db
      this.key = key
      this.descriptor = descriptor
      this._mode = 'encrypted'
      this.beginSession() // a new session, exactly like unlock()
    }
    return this.getState()
  }

  /**
   * Register a unit of document work (an import job or a re-index) that will WRITE
   * `.enc` sidecars. Returns a release function (idempotent; call it in `finally`).
   * Refused while a password change is in progress — and `changePassword` symmetrically
   * refuses while any hold is open — so a sidecar is never encrypted under a key that
   * the change is about to retire (docs/security-model.md). No-op-ish for plaintext
   * vaults: holds are counted but nothing conflicts (changePassword is unreachable
   * there).
   */
  beginDocumentWork(): () => void {
    if (this.changingPassword) {
      // Emission (i18n record §3.3 rule 2): user-facing, transient — localized via tMain.
      throw new VaultBusyError(tMain('main.workspace.busyPasswordChange'))
    }
    this.docWork += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        this.docWork -= 1
      }
    }
  }

  /**
   * Change the vault password. Runs UNLOCKED only. Verifies
   * `currentPassword` against the existing verifier FIRST (a wrong one throws
   * `WrongPasswordError` — the same failure class as a wrong unlock). On a v2 vault the
   * change is O(1): re-wrap the data key in a fresh envelope descriptor (atomic
   * single-file replace). On a v1 vault this is the one-time journaled migration to v2:
   * stage every re-encrypted file as `.new`, commit by swapping the descriptor, then
   * swap the staged files in — a crash at any step recovers to old-or-new, never mixed.
   * The in-memory key is replaced in place; no re-lock is needed. `kdf` parameterizes
   * the NEW envelope (tests use cheap params); callers default to `DEFAULT_KDF`, which
   * silently upgrades legacy scrypt vaults to Argon2id.
   */
  changePassword(currentPassword: string, nextPassword: string, kdf: KdfParams = DEFAULT_KDF): WorkspaceStateInfo {
    if (!this._db || !this.key || this._mode !== 'encrypted' || this.descriptor?.mode !== 'encrypted') {
      throw new Error('The workspace must be unlocked to change its password.')
    }
    if (this.docWork > 0) {
      // Emission (i18n record §3.3 rule 2), like `beginDocumentWork`'s twin above: user-facing, localized via tMain (#807).
      throw new VaultBusyError(tMain('main.workspace.busyDocumentWork'))
    }
    // #845 belt: the unlock refused any newer format, so the descriptor in memory is one this build knows. The one on
    // disk is re-read before anything is derived or written: a newer build (another OS's app on a shared Kit) may
    // have rewritten it since, and a re-wrap would replace it with a v2 and drop whatever its format added. One that
    // is not the descriptor this session unlocked is refused too: re-wrapping the data key over it would leave the
    // vault under a descriptor nobody chose.
    const onDisk = readVaultDescriptorChecked(this.vaultPaths.descriptorPath)
    if (onDisk.kind === 'newer') throw new VaultNewerError(onDisk.what, onDisk.found)
    if (onDisk.kind !== 'ok' || !isDeepStrictEqual(onDisk.descriptor, JSON.parse(JSON.stringify(this.descriptor)))) {
      throw new Error(
        'Refusing to change the password: the workspace descriptor on disk is not the one this session unlocked.'
      )
    }
    if ((numericVersion(this.descriptor.version) ?? 0) > VAULT_VERSION_ENVELOPE) {
      // Unreachable today: the descriptor in memory equals the one just re-read, which would have been refused as
      // newer above. Kept as the last check before a re-wrap writes a v2, in case either check changes. No test can
      // reach it without reaching into the controller.
      throw new VaultNewerError('descriptor', this.descriptor.version)
    }
    // Verify the CURRENT password against the existing verifier before touching anything.
    const salt = Buffer.from(this.descriptor.saltB64, 'base64')
    const currentKek = deriveKey(currentPassword, salt, this.descriptor.kdf)
    const currentOk = verifyKey(currentKek, blobFromJson(this.descriptor.verifier))
    currentKek.fill(0)
    if (!currentOk) throw new WrongPasswordError()

    this.changingPassword = true
    try {
      if (this.descriptor.version >= VAULT_VERSION_ENVELOPE && this.descriptor.dataKey) {
        // v2: O(1) — re-wrap the unchanged data key under the new password's KEK.
        this.descriptor = rewrapVaultKey(this.vaultPaths, this.key, nextPassword, kdf)
      } else {
        // v1: the one-time journaled migration to the envelope format.
        discardPendingRekey(this.vaultPaths) // defensive: drop strays from an old abort
        const dataKey = generateDataKey()
        try {
          stageRekey(this.vaultPaths, this._db, this.key, dataKey, this.noteProbeFallback)
          // COMMIT POINT: the atomic descriptor replace. Before it the old password +
          // old files win; from here on the new ones do.
          this.descriptor = rewrapVaultKey(this.vaultPaths, dataKey, nextPassword, kdf)
        } catch (err) {
          discardPendingRekey(this.vaultPaths)
          dataKey.fill(0)
          throw err
        }
        // Committed: the new password + data key are authoritative from here on, so the
        // in-memory key is swapped BEFORE the file swap — lock()/documentCipher() must
        // never use the retired key once the descriptor wraps the new one.
        this.key.fill(0)
        this.key = dataKey
        try {
          applyPendingRekey(this.vaultPaths)
        } catch {
          // Not fatal post-commit: applyPendingRekey is now best-effort + retry, so it throws
          // only when a file stays persistently locked (e.g. on Windows) AFTER swapping every
          // other sidecar. That lone file rolls forward via recoverPendingRekey on the next
          // startup/unlock — the journal guarantees old-or-new per file, never mixed.
        }
      }
      return this.getState()
    } finally {
      this.changingPassword = false
    }
  }

  /**
   * The unlocked vault DATA key, or null in plaintext mode / while locked. Exposed ONLY for
   * the local diagnostics log, which encrypts `app.log.enc` under the same key as the DB and
   * document cache (one at-rest key for the whole workspace). Like `documentCipher`, the
   * caller must not retain it past a lock — the controller zeroes its copy on `lock()`.
   */
  encryptionKey(): Buffer | null {
    if (this._mode !== 'encrypted') return null
    return this.key
  }

  /**
   * A `DocumentCipher` bound to the unlocked vault, or null in plaintext mode / while
   * locked. Ingestion uses it to keep the imported-document cache encrypted at rest.
   *
   * full-audit 2026-07-12 SEC-1 — each closure re-reads `this.key` PER INVOCATION and
   * throws a typed `VaultLockedError` once `lock()` has zeroed it. The old closures
   * captured the key Buffer OBJECT, which `lock()` fills with zeros in place, so a cipher
   * captured by an in-flight import kept "working" after "Lock now" — encrypting the
   * document sidecar under 32 zero bytes (a GCM-valid `.enc` anyone can decrypt). The
   * check-then-encrypt cannot race `lock()`: both are synchronous, and the encrypt paths
   * call `createCipheriv` (which copies the key into the cipher context) before their
   * first await — an encrypt already past that point when a lock lands finishes under
   * the real key (harmless ciphertext). A cipher held across a lock → unlock cycle (or
   * the v1→v2 password-change key swap) picks up the LIVE key instead of the retired
   * one — strictly more correct; no consumer holds one that long by design (fresh
   * capture per IPC call / import job).
   */
  documentCipher(): DocumentCipher | null {
    if (!this.key || this._mode !== 'encrypted') return null
    const requireKey = (): Buffer => {
      if (!this.key) throw new VaultLockedError()
      return this.key
    }
    return {
      encryptFileAsync: (src, dest) => encryptFileAsync(src, dest, requireKey()),
      decryptFileAsync: (src, dest) => decryptFileAsync(src, dest, requireKey())
    }
  }

  /**
   * Lock the encrypted vault: re-encrypt the working file → `.enc` and shred the
   * plaintext. A no-op for `plaintext_dev` (nothing to protect, and closing it would
   * wedge the app back into onboarding) — the DB simply stays open until process exit.
   * A refused re-encrypt throws `VaultLockError` with the workspace open again, except when
   * the working file is gone or no longer a database (#855): the lock then finishes at the
   * last good `.enc` and returns `lockNotice: 'working_copy_lost'`, which `getState()` keeps
   * reporting, across a restart too, until the next unlock (#875).
   */
  lock(): WorkspaceStateInfo {
    if (this._db && this.key && this.descriptor?.mode === 'encrypted') {
      try {
        lockEncryptedVault(this.vaultPaths, this._db, this.key, this.encryptFileImpl, this.noteProbeFallback)
      } catch (err) {
        // full-audit 2026-07-11 CODE-1a — a failed re-encrypt (realistically ENOSPC)
        // must never strand the controller half-locked. `lockEncryptedVault` had already
        // closed the DB, so `_db` held a CLOSED handle while getState() kept reporting
        // `unlocked`: every later DB IPC failed raw and a lock retry re-closed a closed
        // DB. Worse, the plaintext working file was now the ONLY fresh copy of the
        // session's data (encryptFile is atomic tmp→rename, so the stale `.enc`
        // survives) and the next launch's crash sweep shredded it. Recovery: re-open the
        // plaintext DB — the file is intact and quiescent after the checkpoint + close —
        // and restore `_db` so the controller stays consistently UNLOCKED and usable;
        // keep the key so a retry (after freeing space) can succeed; surface a typed,
        // content-free error for the IPC layer to map to friendly copy.
        //
        // #853 — re-open ONLY a working file that is still there and still a database.
        // `openDatabase` CREATES a missing file: if something outside the app removed the live
        // working file (POSIX lets an open file be unlinked), the re-open would leave the
        // controller holding a fresh, EMPTY database, and the next lock (a retry, or
        // `shutdown()` at quit) would pass the header guard and encrypt it over the good
        // `.enc`.
        //
        // #855 — and a working file that is GONE, or there but no longer a database (#208's
        // noise, a truncation, and since #876 a header over noise: `probeDatabaseFile` judges
        // the structure, the same probe the guard above refused on), holds nothing newer than
        // `.enc`: the session's changes since the last lock are lost either way, and `.enc` is the
        // last good snapshot. So the lock
        // FINISHES instead of keeping a closed handle (which left the session reporting
        // `unlocked` on a database that no call could use, refused every later lock and kept
        // the key in memory until quit): shred what is left — the noise itself, and the
        // `-wal`/`-shm` a vanished main file leaves behind (SQLite sees the database moved and
        // skips the delete on close), plaintext pages no main file can replay — zero the key,
        // and report `locked` with a notice the lock screen shows. That is what the next
        // launch's sweep would do (`preserveNewerPlaintext` keeps only a database SQLite can read
        // with no live sidecars), done now, so an unlock in this session opens `.enc` at once.
        // A file the probe cannot READ (a hold, a permission error) is not judged lost: it may
        // be the only fresh copy, so it keeps the closed handle, and with it the refusal of any
        // unlock that would decrypt the stale `.enc` over it this session. Nor is a working file
        // whose `.enc` is gone too: `.enc` sits beside it, so a drive or workspace folder that
        // vanished (a USB stick dropping out, a folder moved away) reads as ENOENT for both, and
        // the working file may come back newer than `.enc`.
        const dbPath = this.vaultPaths.dbPath
        // #876 review round 1: a `-wal` that still holds commits beside a working file that is there
        // means the checkpoint did not finish (a full drive), not that the session is lost: the probe
        // reads the main file alone, which is then stale or torn while the session is intact in it
        // plus the WAL. Never discarded; re-opened below (the open replays the WAL). A `-wal` that is
        // noise holds nothing, and a WAL whose main file is gone cannot be replayed: both are judged as
        // before.
        // Review round 2: the lock carried what it found (its one probe, and the WAL after its retry),
        // so the file is judged once; only a failure before that judgement (the close itself) probes
        // here. A structure the probe could not read (not damage) is a database, as the header said.
        const judged = err instanceof LockStoppedError ? err.verdict : null
        const probe = judged?.probe ?? probeDatabaseFile(dbPath)
        if (!judged?.probe && probe.verdict === 'unchecked') this.noteProbeFallback('lock', probe.code ?? 'unknown')
        const workingCopy = probe.verdict
        const walPending = workingCopy !== 'gone' && (judged ? judged.walPending : walAwaitsCheckpoint(dbPath))
        const lost =
          workingCopy === 'gone' || (!walPending && (workingCopy === 'not-database' || workingCopy === 'damaged'))
        if (lost && existsSync(this.vaultPaths.encPath)) {
          shredFile(dbPath)
          cleanSidecars(dbPath)
          // #875: recorded, not only returned: a quit, a crash or a session end has no lock screen
          // to return the notice to, so it stands (and, by the marker, survives a restart) until
          // the next unlock.
          this.markWorkingCopyLost('lock')
          this.dropKeyAndHandle()
          return this.getState()
        }
        // Not judged lost, but a main file that is gone still leaves its `-wal`/`-shm` behind
        // (#853): plaintext pages no main file can replay, shredded now rather than left on the
        // drive until the next launch. Only then: beside an existing file, an un-checkpointed WAL
        // (a checkpoint that hit the full disk) holds the session: the re-open replays it, whatever the
        // main file alone looks like.
        try {
          const replayable = walPending && (workingCopy === 'damaged' || workingCopy === 'not-database')
          if (workingCopy === 'database' || workingCopy === 'unchecked' || replayable) this._db = openDatabase(dbPath)
          else if (workingCopy === 'gone') cleanSidecars(dbPath)
        } catch {
          // Re-open is best-effort: if the disk is too broken even for that, keep the
          // closed handle — isUnlocked() stays true, so no unlock can decrypt the STALE
          // `.enc` over the newer working file this session, and the init() salvage
          // (CODE-1b) preserves + rolls the file forward on the next launch.
        }
        throw new VaultLockError(err) // #956 (S-5): what failed, content-free, for the log
      }
      this.dropKeyAndHandle()
    }
    // AUD-02: the branch above is skipped for a `plaintext_dev` workspace — there is no vault to
    // re-encrypt, so `lock()` is a deliberate no-op and the DB stays OPEN. Disarm the latch in
    // that case (and in any other path that leaves the DB open). The UI offers no Lock now on a
    // dev workspace, but a direct `workspace:lock` call arms the latch, and left armed it would
    // refuse every content surface for good: only an unlock clears the latch, and a plaintext
    // workspace never unlocks again.
    if (this._db !== null) this._locking = false
    return this.getState()
  }

  /**
   * The end of a lock that finished (re-encrypted, or #855 at the last snapshot): zero the key
   * bytes before dropping the reference — otherwise the 32-byte key lingers in the heap until
   * GC and could surface in a dump/swap — and drop the handle `lockEncryptedVault` closed.
   */
  private dropKeyAndHandle(): void {
    this.key?.fill(0)
    this._db = null
    this.key = null
  }

  /**
   * Process-exit teardown (issue #51). For an unlocked encrypted vault this is `lock()`
   * (checkpoint + close + re-encrypt + shred — the existing path). For `plaintext_dev` —
   * where `lock()` is a deliberate no-op — it checkpoints and CLOSES the DB, so a clean
   * quit leaves a bare `hilbertraum.sqlite` with no `-wal`/`-shm` sidecars at rest on the
   * drive: on a non-journaling exFAT stick, at-rest WAL sidecars mean the last session
   * never closed cleanly, and they make the next hard unplug likelier to corrupt. ONLY
   * for callers that are about to exit the process — a closed plaintext DB has no reopen
   * path short of relaunch (`requireDb` throws afterwards).
   */
  shutdown(): void {
    try {
      this.lock()
    } catch (err) {
      // full-audit 2026-07-11 CODE-1 — the failed lock re-opened the plaintext DB so an
      // INTERACTIVE session stays usable, but this caller is exiting the process. Close
      // the re-opened handle cleanly (checkpoint + close removes -wal/-shm), so the
      // working file rests bare and newer than `.enc` — exactly the salvage signature
      // init() (CODE-1b) preserves and rolls forward on the next launch instead of
      // shredding. Then rethrow: the quit paths catch + log ("Failed to lock workspace
      // on quit"), and the process still exits.
      if (this._db) {
        try {
          this._db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        } catch {
          /* best-effort; close still flushes */
        }
        try {
          this._db.close()
        } catch {
          /* the reopen may have failed — the handle is already closed */
        }
        this._db = null
      }
      throw err
    }
    if (this._db) {
      // plaintext_dev: flush the WAL into the main file, then close — SQLite removes the
      // -wal/-shm sidecars on the last clean connection close.
      try {
        this._db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      } catch {
        /* best-effort; close still flushes */
      }
      this._db.close()
      this._db = null
    }
  }
}
