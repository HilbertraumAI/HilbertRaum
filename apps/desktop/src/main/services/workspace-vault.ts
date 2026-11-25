import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fsyncSync,
  fdatasyncSync,
  fstatSync,
  unlinkSync,
  realpathSync,
  type BigIntStats,
  type Stats
} from 'node:fs'
import { lstat as lstatAsync, open as openFileAsync, rename as renameAsync, rm as rmAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { freeBytesSync } from './disk-space'
import { causeFailure, isFileError, type CauseFailure } from './failure-for-log'
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
  sqliteSchemaUnreadable,
  stampLastWriter,
  walAwaitsCheckpoint,
  SCHEMA_VERSION,
  STAMP_NO_APP_VERSION,
  WorkspaceNewerError,
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
  kdfParamAboveBounds,
  newerFrameError,
  VaultNewerError,
  isVaultNewerError,
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

/**
 * W-68 (app-update wave, T2.14): thrown by `unlockEncryptedVault` when the password is CORRECT and SQLite cannot parse the
 * decrypted database's schema ({@link sqliteSchemaUnreadable}: "malformed database schema") under a stamp this build
 * reads. A newer version's schema text does that (one that also raised the stamp is `WorkspaceNewerError`), and so does
 * damage inside `sqlite_schema`. The IPC layer maps it to `workspace_schema_unreadable`, whose copy (C01) names the newer
 * version and keeps the safety instruction for real damage ("keep the files as they are"), instead of
 * `vault_damaged`'s "restore from a backup". The decrypted copy is shredded like after any failure past the decrypt, and
 * `.enc` is untouched. Content-free: nothing of SQLite's message, which quotes the schema, is kept.
 */
export class VaultSchemaUnreadableError extends Error {
  constructor() {
    super('The workspace decrypted to a database whose schema this version cannot read')
    this.name = 'VaultSchemaUnreadableError'
  }
}

/** What a failure of the unlock's open, or of its own settings writes, is thrown as (#208, #247,
 *  #844): a newer build's database as itself, SQLite's damage verdict as `VaultDamagedError`, and
 *  anything else as `VaultOpenFailedError`. W-68 (T2.14): within the damage verdict, a schema SQLite
 *  cannot parse is `VaultSchemaUnreadableError`, after the probe's `newer`.
 *  T2.9 fix round (R1-1): SQLite's damage verdict on the decrypted file at `dbPath` is checked against
 *  {@link probeDatabaseFile} first: a file it calls `newer` (its header's stamp above this build's) is a newer build's
 *  database, thrown as `WorkspaceNewerError`. A file format this SQLite refuses (header byte 19, the read version, above
 *  2) fails the open's first statement with SQLITE_NOTADB before the open reads the stamp, and was called damaged. */
function openFailure(err: unknown, dbPath: string): unknown {
  if (isWorkspaceNewerError(err)) return err
  if (!sqliteJudgedDamaged(err)) return new VaultOpenFailedError(err)
  const probe = probeDatabaseFile(dbPath)
  if (probe.verdict === 'newer') return new WorkspaceNewerError(probe.found)
  return sqliteSchemaUnreadable(err) ? new VaultSchemaUnreadableError() : new VaultDamagedError()
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
 * #973: also thrown by `unlockEncryptedVault` when it cannot read a staged `.enc.new` it must
 * judge (a hold on the file): nothing is changed, and the next unlock checks it again.
 * #1015: and by the rekey recovery (`recoverPendingRekey`) when it cannot finish a password change's swap or remove its
 * temps (a held file, a folder at the name): the journal stays, so the next start or unlock finishes it. `code` is that
 * file error's code (content-free, for the log), or null.
 */
export class VaultRecoveryBlockedError extends Error {
  readonly code: string | null
  constructor(code: string | null = null) {
    super('A recovery file is held by another program; the workspace cannot be opened safely yet')
    this.name = 'VaultRecoveryBlockedError'
    this.code = code
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
 * Thrown by `unlockEncryptedVault` when `config/workspace.json` is on the drive but cannot be read (not JSON, or a field
 * missing; #974: one UTF-8 byte-order mark in front of it no longer counts) and the encrypted workspace file is NOT
 * beside it (#955 item 1):
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
 * #974: `JSON.parse` of a small state file's text after ONE leading U+FEFF is removed. Node's `utf8` decoding keeps a
 * UTF-8 byte-order mark, and `JSON.parse` refuses it, so a file an editor or a tool saved with one (Windows PowerShell
 * 5.1 `Set-Content -Encoding utf8`, older Notepad, some sync and backup tools) read as unreadable although its JSON was
 * intact. The readers of the descriptor, the rekey journal and the #875 marker use it; the app writes none of them with
 * a BOM. A second mark, or a file holding only the mark, still throws.
 */
function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
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
 * fail), and (T2.9, R1-6) so is one whose KDF parameters are above this build's bounds under a KDF it knows. Anything
 * else keeps the shape rules every shipped build applied, so a descriptor a published release wrote
 * reads `ok` exactly as before (tests/fixtures/vault-golden).
 */
export function readVaultDescriptorChecked(descriptorPath: string): VaultDescriptorRead {
  if (!existsSync(descriptorPath)) return { kind: 'absent' }
  let raw: unknown
  try {
    raw = parseJsonText(readFileSync(descriptorPath, 'utf8'))
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
  // T2.9 fix round (R1-6): so was a parameter above this build's bounds under a KDF it knows (`kdfParamAboveBounds`).
  // Read here, by the format verdict at the head of `init()` and of the unlock, so it is refused before the start's
  // salvage, sweep and rekey recovery and before the unlock's `recoverPendingRekey`, as an unknown `kdf.algo` is.
  const above = kdfParamAboveBounds(d.kdf)
  if (above !== null) return { kind: 'newer', what: 'kdf', found: above.slice(0, 40) }
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
    return (parseJsonText(readFileSync(path, 'utf8')) as { version?: unknown } | null)?.version
  } catch {
    return undefined
  }
}

/** The vault format verdict (#845): `ok`, or the first artifact a newer build wrote. */
export type VaultFormatVerdict = { kind: 'ok' } | { kind: 'newer'; what: VaultNewerWhat; found: string | number }

/**
 * Is any vault artifact in a format a NEWER build wrote (#845)? Read-only, and independent of the password: the
 * descriptor (a numeric `version` above 2, an unknown `kdf.algo`, or, T2.9 R1-6, KDF parameters above this build's
 * bounds), the rekey journal (a numeric `version` above 1,
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
 *  first — a descriptor must never land half-written after a power cut.
 *  T2.7 security fix round (F-2): the temp is opened by {@link openWriteTemp}, never through a link at its name. */
export function writeVaultDescriptor(descriptorPath: string, d: VaultDescriptor): void {
  const tmp = `${descriptorPath}.tmp`
  const fd = openWriteTemp(tmp)
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
 * T2.7 security fix round (F-1, F-2): open a write temp at a fixed name (`<file>.tmp`, renamed into place once written)
 * as a new file, never through a link. 'w' followed one: a drive formatted NTFS, APFS or ext4 can carry a hard or
 * symbolic link at such a name (a Kit's exFAT cannot), and the file it reaches, elsewhere on the drive or on another, was
 * truncated and given what this write holds (the decrypted database, among others). Whatever is at the name is removed
 * by its name first ({@link removeTempName}: a link by `unlink`, never followed), and the temp is created anew ('wx'), so
 * one planted in between fails the write. A folder at the name is left, and the write fails. The pattern of the rekey
 * journal's and the #875 marker's temps (#1014 round 6, T2.16 R1 B-3); `logging.ts` opens the encrypted log's temp here.
 */
export function openWriteTemp(path: string): number {
  removeTempName(path)
  return openSync(path, 'wx')
}

/**
 * Encrypt `srcPath` → `destPath` (atomic) with `key`. Streams; constant memory. SYNCHRONOUS —
 * blocks until done; see the section header for when to prefer {@link encryptFileAsync}.
 * T2.7 (F-2): the temp is opened by {@link openWriteTemp}, never through a link at its name.
 */
export function encryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const tmp = `${destPath}.tmp`
  const iv = randomBytes(BLOB_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const src = openSync(srcPath, 'r')
  let out: number | null = null
  try {
    out = openWriteTemp(tmp)
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
 * T2.7 security fix round (F-1): the temp is opened by {@link openWriteTemp}, never through a link at its name: the
 * unlock decrypts the whole database into `hilbertraum.sqlite.tmp`, and a link there put the plaintext into the file it
 * reached, renamed the link into place for SQLite to write every session through, and left the plaintext there when the
 * lock's shred unlinked the name. As a belt, before the rename the temp must still be the file this decrypt wrote, a
 * regular file with one name (`lstat`, never followed, against the open file), or the decrypt fails and its output
 * never takes `destPath`'s name (the unlock then opens no database).
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

    out = openWriteTemp(tmp)
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
    const written = fstatSync(out, { bigint: true })
    closeSync(out)
    out = null
    // F-1's belt: the name still holds the file written above, and no other name shares it.
    const named = lstatOrNull(tmp)
    if (named === null || shredNameOf(named).kind !== 'file' || !sameShreddableFile(named, written)) {
      throw new Error('The decrypted file is no longer the one this decrypt wrote')
    }
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
 * #973: does the frame at `path` authenticate under `key`? The same streaming AES-256-GCM pass as {@link decryptFile},
 * with nothing written: each chunk of plaintext is zeroed and dropped, and only the tag check at the end decides. A
 * vault frame is one GCM stream with one tag, so this proves the whole file is ciphertext under that key. False when
 * the tag fails (another key, or bytes that changed), and when the file is no frame of this build's at all (too short for
 * a frame header, or a magic other than `HRAUMEN1`): neither can be a staged copy under any key here. A frame a newer
 * build wrote throws its `VaultNewerError` (the unlock's format verdict refuses one before this runs), and an I/O error
 * throws as it is: a file that cannot be read is never judged. SYNCHRONOUS, like the unlock that calls it.
 */
function authenticatesUnder(path: string, key: Buffer): boolean {
  const fd = openSync(path, 'r')
  try {
    const headerLen = BLOB_MAGIC.length + BLOB_IV_BYTES + BLOB_TAG_BYTES
    const header = Buffer.alloc(headerLen)
    const got = readSync(fd, header, 0, headerLen, null)
    const magic = classifyFrameMagic(header.subarray(0, got))
    if (magic === 'newer') throw newerFrameError(header)
    if (got < headerLen || magic !== 'current') return false
    const iv = header.subarray(BLOB_MAGIC.length, BLOB_MAGIC.length + BLOB_IV_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(header.subarray(BLOB_MAGIC.length + BLOB_IV_BYTES, headerLen))
    const buf = Buffer.alloc(FILE_CHUNK_BYTES)
    let bytes: number
    while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) decipher.update(buf.subarray(0, bytes)).fill(0)
    try {
      decipher.final().fill(0) // throws here when the tag does not verify
    } catch {
      return false
    }
    return true
  } finally {
    closeSync(fd)
  }
}

/**
 * ASYNC twin of {@link encryptFile} (PERF-1): the SAME streaming AES-256-GCM loop on a
 * `fs.promises` FileHandle, awaiting each chunk read/write so it yields to the event loop
 * between chunks — a large document import no longer freezes the Electron main process/IPC.
 * Writes the byte-IDENTICAL frame (`MAGIC | iv | tag-placeholder | ciphertext`, with the GCM
 * tag patched into its reserved slot at `tagPos` AFTER `final()` via a positional write), so a
 * file written here decrypts via the sync path / in-memory blob path and vice versa.
 * T2.7 (F-2): the temp is opened as {@link openWriteTemp} opens it (removed by its name first, then 'wx').
 */
export async function encryptFileAsync(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  const tmp = `${destPath}.tmp`
  const iv = randomBytes(BLOB_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const src = await openFileAsync(srcPath, 'r')
  let out: Awaited<ReturnType<typeof openFileAsync>> | null = null
  try {
    removeTempName(tmp)
    out = await openFileAsync(tmp, 'wx')
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
 * T2.7 (F-1): the temp is opened as {@link openWriteTemp} opens it (removed by its name first, then 'wx').
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

    removeTempName(tmp)
    out = await openFileAsync(tmp, 'wx')
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
 * #1014: what the secure delete finds at a NAME, by `lstat`, which never follows a link: nothing (`absent`: a stat that
 * fails for any reason, as `existsSync` read it); a folder (`directory`: left as it is); a regular file no other name
 * shares (`file`, with its stats: the only kind that is overwritten); or anything else (`name-only`: a symbolic link, a
 * junction, another kind of file, or a file with more than one link). A `name-only` name is unlinked, never opened: an
 * overwrite would land in the file the link reaches, or under the other name, which may lie outside the workspace. The
 * app makes no links of its own, so every file it writes and shreds is a `file`.
 * Round 3: a link count of 0 counts as one (some drivers report 0 for every regular file; refusing the overwrite there
 * would only unlink the plaintext and leave it whole on the drive). Only a count above one says another name shares it.
 */
type ShredName =
  | { kind: 'absent' }
  | { kind: 'directory' }
  | { kind: 'name-only' }
  | { kind: 'file'; stats: BigIntStats }

function shredNameOf(stats: BigIntStats | null): ShredName {
  if (stats === null) return { kind: 'absent' }
  if (stats.isDirectory()) return { kind: 'directory' }
  return stats.isFile() && stats.nlink <= 1n ? { kind: 'file', stats } : { kind: 'name-only' }
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
  } catch {
    return null
  }
}

/** #1014 round 4: `lstat` where only ENOENT proves a name is not there (the #911 rule, as {@link statSaysAbsent} reads
 *  it): `null` then, and any other failure (a hold, a permission, an I/O error) throws, so the caller leaves what it was
 *  judging as it is. The secure delete keeps {@link lstatOrNull}, for which a name it cannot stat is nothing to shred. */
function lstatOrAbsent(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw err
  }
}

/** #1014: the file a descriptor opened on a `file` name is still the file `lstat` saw (the same device and file id, a
 *  regular file, no second link): the name was not swapped for a link between the two calls. */
export function sameShreddableFile(named: BigIntStats, opened: BigIntStats): boolean {
  return opened.isFile() && opened.nlink <= 1n && opened.ino === named.ino && opened.dev === named.dev
}

/**
 * Best-effort secure delete: overwrite the file with random bytes (in bounded chunks —
 * a single `randomBytes(size)` throws past 2 GiB), then unlink. The unlink runs even if
 * the overwrite fails. On flash (SSDs and USB sticks) wear-levelling means
 * the original blocks may survive — documented in SECURITY.md and not over-promised.
 * #1014: only a regular file no other name shares is overwritten ({@link ShredName}); a link or a file with another name
 * is unlinked by its name alone, and a folder is left.
 */
export function shredFile(path: string): void {
  const name = shredNameOf(lstatOrNull(path))
  if (name.kind === 'absent' || name.kind === 'directory') return
  if (name.kind === 'file') {
    try {
      const fd = openSync(path, 'r+')
      try {
        const opened = fstatSync(fd, { bigint: true })
        const size = Number(opened.size)
        if (sameShreddableFile(name.stats, opened) && size > 0) {
          const chunk = randomBytes(Math.min(size, FILE_CHUNK_BYTES))
          let pos = 0
          while (pos < size) {
            const n = Math.min(chunk.length, size - pos)
            writeSync(fd, chunk, 0, n, pos)
            pos += n
          }
          fsyncSync(fd)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      /* best-effort overwrite; still unlink below */
    }
  }
  removeShredName(path, name)
}

/**
 * #1014: the unlink that ends every shred, by the name only. A link goes by `unlink`, which removes the link itself, a
 * Windows junction included (review R3: `rm` refuses a junction as a folder, so it stayed, and a swap onto that name
 * then blocked every start); never a recursive remove. A file goes by `rm`, as before. Best-effort.
 */
function removeShredName(path: string, name: ShredName): void {
  try {
    if (name.kind === 'name-only') unlinkSync(path)
    else rmSync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * #982 (G-12 option a2): a deadline for a lock's overwrite of the plaintext working file. Only the Linux `quit` leg
 * passes one (`emergencyLock` with `QUIT_LOCK_BUDGET_MS`, `main/shutdown.ts`): that leg runs inside Electron's fixed
 * 10 s session-loss watchdog, which crashes the process (status 133) when the lock is still running, with the working
 * file left in plaintext. Lock now and the quit teardown pass none and keep {@link shredFile}.
 */
export interface LockBudget {
  /** When the overwrite must have stopped, in milliseconds on {@link LockBudget.now}'s clock. */
  deadline: number
  /** The clock the deadline is on (`emergencyLock`'s, `performance.now`). */
  now: () => number
  /** Told once when the lock's overwrite stopped before the file's end (the deadline, or an overwrite error); the file
   *  is unlinked either way. */
  onShredCut?: () => void
}

/** What a lock may be given (#982): the overwrite's deadline, on the Linux `quit` leg only. */
export interface LockOptions {
  budget?: LockBudget
}

/** #982: a chunk of the budgeted overwrite starts only while this many times the last chunk's time still fits. */
const SHRED_CHUNK_MARGIN = 1.5

/**
 * #982 (G-12 option a2): {@link shredFile} against a deadline, for the lock on Linux's `quit` leg. The same random
 * overwrite in {@link FILE_CHUNK_BYTES} chunks, but each chunk is made durable (`fdatasync`) before the next one, so its
 * time is the drive's real cost and not the page cache's, and a chunk starts only while `now + 1.5 × the last chunk's
 * time` still fits the deadline. The first chunk has no time of its own yet: it is judged by `msPerByte`, the rate the
 * lock's encrypt of the same file to the same drive just ran at (a chunk started on no estimate right before the
 * deadline would run past it by a whole chunk, 0.8 s at 10 MB/s, measured in the WSL kit). Past that the overwrite stops
 * and the file is unlinked: the `.enc` is complete and durable by then, so what is left of the plaintext is the freed
 * blocks of an unlinked file, not a readable one, and the lock ends inside the watchdog instead of crashing with the
 * whole working file on the drive. Where the whole overwrite fits, the bytes written are {@link shredFile}'s; only the
 * syncs differ. Best-effort like it: an error stops the overwrite (reported as cut), and the unlink still runs.
 */
export function shredFileWithin(
  path: string,
  budget: LockBudget,
  msPerByte = 0
): { overwrittenBytes: number; cut: boolean } {
  let overwrittenBytes = 0
  let complete = true
  // #1014: the name is judged as `shredFile` judges it. Only a regular file no other name shares is overwritten; anything
  // else there is unlinked by its name alone (a folder is left) and counts as cut, since none of it was overwritten.
  const name = shredNameOf(lstatOrNull(path))
  if (name.kind === 'absent') return { overwrittenBytes, cut: false }
  try {
    complete = false
    if (name.kind !== 'file') throw new Error('Not a file the overwrite may write')
    const fd = openSync(path, 'r+')
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (!sameShreddableFile(name.stats, opened)) throw new Error('The name changed before the overwrite')
      const size = Number(opened.size)
      if (size > 0) {
        const chunk = randomBytes(Math.min(size, FILE_CHUNK_BYTES))
        let lastChunkMs = msPerByte * chunk.length
        while (overwrittenBytes < size) {
          const startedAt = budget.now()
          if (startedAt + SHRED_CHUNK_MARGIN * lastChunkMs > budget.deadline) break
          const n = Math.min(chunk.length, size - overwrittenBytes)
          // The bytes written, not the bytes asked for: a short write is written on, so `cut` stays honest.
          let written = 0
          while (written < n) {
            const w = writeSync(fd, chunk, written, n - written, overwrittenBytes + written)
            if (w <= 0) throw new Error('The overwrite wrote nothing')
            written += w
          }
          fdatasyncSync(fd)
          overwrittenBytes += written
          lastChunkMs = budget.now() - startedAt
        }
      }
      complete = overwrittenBytes >= size
    } finally {
      closeSync(fd)
    }
  } catch {
    /* best-effort overwrite; still unlink below */
  }
  removeShredName(path, name)
  return { overwrittenBytes, cut: !complete }
}

/**
 * ASYNC twin of {@link shredFile} (audit 2026-07-16 F-12): the SAME best-effort secure delete
 * (overwrite with random bytes in bounded chunks, then unlink), on an `fs.promises` FileHandle so it
 * YIELDS to the event loop between chunks. Additive — the ~25 sync `shredFile` callers (vault/crash-lock
 * lifecycle, ingestion, dictation, doctasks, transcriber) stay sync; only the async image-history path
 * uses this twin so a ~20 MiB image store/open/delete on an encrypted USB workspace no longer freezes
 * the main process. Same caveat as the sync twin (SSD wear-levelling may leave original blocks).
 * #1014: the name is judged as `shredFile` judges it ({@link ShredName}): a link or a file with another name is unlinked
 * by its name alone, never written through, and a folder is left.
 */
export async function shredFileAsync(path: string): Promise<void> {
  let named: BigIntStats | null = null
  try {
    named = await lstatAsync(path, { bigint: true })
  } catch {
    /* missing or unstatable: the unlink below is still tried, as before */
  }
  const name = shredNameOf(named)
  if (name.kind === 'directory') return
  try {
    if (name.kind === 'file') {
      const fd = await openFileAsync(path, 'r+')
      try {
        const opened = await fd.stat({ bigint: true })
        const size = Number(opened.size)
        if (sameShreddableFile(name.stats, opened) && size > 0) {
          const chunk = randomBytes(Math.min(size, FILE_CHUNK_BYTES))
          let pos = 0
          while (pos < size) {
            const n = Math.min(chunk.length, size - pos)
            await fd.write(chunk, 0, n, pos)
            pos += n
          }
          await fd.sync()
        }
      } finally {
        await fd.close().catch(() => {})
      }
    }
  } catch {
    /* best-effort overwrite; still unlink below */
  }
  try {
    // #1014: a link by `unlink`, never followed and never removed recursively, as `removeShredName` does.
    if (name.kind === 'name-only') await unlinkAsync(path)
    else await rmAsync(path, { force: true })
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
  // T2.9 (R2-3): only in a store folder that is a real folder inside the workspace ({@link storeFolderInside}).
  for (const sub of [DOCUMENTS_DIR_NAME, IMAGES_DIR_NAME]) {
    const dir = storeFolderInside(vaultPaths, sub)
    if (dir === null) continue
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
 *     never be re-encrypted over the good `.enc`. #985: a file a NEWER build stamped (its
 *     `user_version` above this build's, `newer`) is kept the same way, whatever its schema
 *     holds: this build cannot judge it, so it is never `'discarded'`. The unlock refuses
 *     to roll it forward (`WorkspaceNewerError`), and a newer build's unlock rolls it forward.
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
 *     mid-checkpoint. That is exactly when {@link probeDatabaseFile} answers `database`, `damaged`, `unchecked` or
 *     (#985) `newer`, the
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
 *  `database`, `damaged`, `unchecked` or (#985) `newer`. Throws when the file cannot be read (the caller's doubt). */
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

/** #985 (review round 2 R8): the schema stamp (`user_version`: header offset 60, a big-endian signed 32-bit integer) in
 *  the 100-byte database header at `path`, or 0 for a file shorter than the header. Throws when the file cannot be read. */
function headerSchemaStamp(path: string): number {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(SQLITE_DATABASE_HEADER_BYTES)
    if (readSync(fd, header, 0, header.length, 0) < header.length) return 0
    return header.readInt32BE(60)
  } finally {
    closeSync(fd)
  }
}

/** #911: what one stat of `.enc` says: `present` (with its mtime); `missing` (ENOENT, the one answer that proves no
 *  snapshot is there); or `unknown`, any other failure (a delete-pending file on Windows, a permission or I/O error),
 *  which proves neither. */
/** `unknown` carries the failed stat's code (content-free, for a blocked answer's log line; round 5, review V7-5). */
type EncryptedFileStat =
  | { state: 'present'; mtimeMs: number }
  | { state: 'missing' }
  | { state: 'unknown'; code: string | null }

function statEncryptedFile(vaultPaths: VaultPaths): EncryptedFileStat {
  try {
    return { state: 'present', mtimeMs: statSync(vaultPaths.encPath).mtimeMs }
  } catch (err) {
    const code = causeFailure(err).code
    return code === 'ENOENT' ? { state: 'missing' } : { state: 'unknown', code }
  }
}

/** {@link statEncryptedFile}'s answer alone. */
function encryptedFileState(vaultPaths: VaultPaths): EncryptedFileStat['state'] {
  return statEncryptedFile(vaultPaths).state
}

/**
 * #911: the start's salvage when `.enc` is missing (a stat says ENOENT) and the working file is there. The app never
 * leaves `.enc` missing itself (a lock and a create replace it by rename; the v1 → v2 password change shreds it right
 * before it renames its staged copy into place, and since #1027 saves it again when that rename fails; until then the
 * staged copy is a snapshot, below), so with no staged copy beside it something outside the app removed it: a
 * person tidying the drive, a sync tool, a disk check. The working file is then the only copy of the workspace, and the
 * sweep, which assumes `.enc` is the source of truth, would shred all of it. So:
 *   - a staged `.enc.new` is a snapshot too (a create or a v1 to v2 password change cut short after its commit), which
 *     `recoverPendingRekey` rolls forward: `'not-needed'`, as before. Adopting the session over it would be the
 *     full-drive roll-forward over a snapshot that this start never does (security-model.md "Encrypted file
 *     missing");
 *   - the `-wal` is replayed into the main file first ({@link checkpointLeftoverWal}): after an unclean end the
 *     session's last commits sit there, and the main file alone lacks them. A `-wal` that still holds commits after
 *     the replay (a full drive, another connection reading it) blocks the start, all three files kept (`'failed'`, as
 *     #242), whatever the replay answered. T2.9 fix round (R1-3 = R2-1): also after a replay SQLite answers with
 *     `damaged`. A newer build's copy whose schema this SQLite cannot parse answers so (SQLITE_CORRUPT) although it is
 *     intact; SQLite's close usually copies its `-wal` in anyway, and when that copy cannot finish the main file alone
 *     is stale, so it was kept (or discarded) without the commits the sweep then shredded with the `-wal`. A replay
 *     whose `-wal` is gone afterwards goes on to the probe;
 *   - a file that reads as a database (`database`, `unchecked` judged by its header, or, #985, `newer`: a newer
 *     build's copy, kept whatever its schema holds) is moved to `<db>.recovery`, which the next unlock with the right
 *     password rolls forward over the missing `.enc` (every build since 0.1.47 does; this build's unlock refuses a
 *     `newer` one, which a newer build's unlock rolls forward): `'kept-only-copy'`. One whose structure is `damaged`
 *     (a real copy: its header reads) is
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
  // #1014 round 3: a staged snapshot is a FILE, as `stagedRekeyFiles` reads it. A folder at the name counted by its
  // existence, and the sweep then shredded the working file, the only copy of the workspace.
  if (isFileAt(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) return 'not-needed'
  if (walAwaitsCheckpoint(vaultPaths.dbPath)) {
    // T2.16 fix round (R1 B-2): the replay writes whatever the three names lead to ({@link replayMayWrite}); where it may
    // not, it is not made, and the start blocks with all three files left, as for a replay that cannot finish.
    if (!replayMayWrite(vaultPaths)) return 'failed'
    checkpointLeftoverWal(vaultPaths.dbPath)
    // T2.9 (R1-3 = R2-1): re-checked whatever the replay answered, `damaged` included (see above).
    if (walAwaitsCheckpoint(vaultPaths.dbPath)) return 'failed'
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

/**
 * T2.16 fix round (R1 B-2): may the #911 replay ({@link checkpointLeftoverWal}) write here? It opens the working file
 * with SQLite before any password, and SQLite writes through whatever the names lead to: review 1's probe had a second
 * hard link of a text file elsewhere at the working file's name overwritten with the pages of a `-wal` planted beside
 * it, and on Windows SQLite opens the `-wal` and the `-shm` by their names too (a TRUNCATE checkpoint empties the one,
 * the WAL index is written into the other). So: the working file and its `-wal` are regular files no other name shares
 * (`lstat`, never followed: a symbolic link, a junction or a second hard link is not), the `-shm` is one or is not
 * there, and the workspace folder itself is no link to a folder elsewhere ({@link folderAtItsName}; a stat that proves
 * nothing there is read as before, #1014's `unknown` rule). The app never makes a link, so its own files always pass.
 */
function replayMayWrite(vaultPaths: VaultPaths): boolean {
  if (folderAtItsName(workspaceDirOf(vaultPaths)) === 'outside') return false
  const plain = (path: string): boolean => shredNameOf(lstatOrNull(path)).kind === 'file'
  const shm = `${vaultPaths.dbPath}-shm`
  return plain(vaultPaths.dbPath) && plain(`${vaultPaths.dbPath}-wal`) && (lstatOrNull(shm) === null || plain(shm))
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

/** T2.7 security fix round (L-2): is the marker's folder (`config/`) a link to a folder elsewhere ({@link folderAtItsName})?
 *  Then the marker is neither written nor removed (the start, the unlock and the create write and remove it before any
 *  password or right after it): a file of that name was created, replaced or removed in the folder the link reaches, a
 *  network path included. The notice of this run is kept in memory as before; a stat that proves nothing reads as
 *  before (#1014's `unknown` rule). The start notes the folder ({@link WorkspaceController.linkedStartFolders}). */
function configFolderLinked(vaultPaths: VaultPaths): boolean {
  return folderAtItsName(dirname(vaultPaths.descriptorPath)) === 'outside'
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
    const m = parseJsonText(text) as { v?: unknown; enc?: unknown; cause?: unknown } | null
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
 *  snapshot to name). `enc`: that frame's IV when the caller has just read it (`init()`), else read here.
 *  T2.16 fix round (R1 B-3): never through a link at the temp's name, as the rekey journal's own temp since #1014 round 6
 *  ({@link writeRekeyJournal}): 'w' followed one, so a hard or symbolic link there had the file it reaches truncated and
 *  given the marker's bytes, at a start before any password. Whatever is at that name is removed by its name first
 *  ({@link removeTempName}) and the temp is created anew ('wx'); a folder there (or one planted in between) fails the
 *  write, which is best-effort. */
function writeWorkingCopyLostMarker(
  vaultPaths: VaultPaths,
  cause: MarkedLossCause,
  enc: string | null = frameIvOf(vaultPaths.encPath)
): void {
  if (enc === null) return
  if (configFolderLinked(vaultPaths)) return // T2.7 (L-2)
  const path = workingCopyLostPath(vaultPaths)
  const tmp = `${path}.tmp`
  try {
    removeTempName(tmp)
    const fd = openSync(tmp, 'wx')
    try {
      writeSync(fd, Buffer.from(JSON.stringify({ v: WORKING_COPY_LOST_VERSION, enc, cause }), 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    // Best-effort, as `encryptFile`'s (#975 review nit): a temp this cannot remove (a directory at its name, a hold)
    // threw from `rm` here and replaced the error being reported.
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the write's own failure is the one that propagates */
    }
    throw err
  }
}

/** Remove this build's marker (best-effort); one of another version stays. T2.7 (L-2): so does any marker behind a
 *  `config/` that is a link ({@link configFolderLinked}). */
function removeWorkingCopyLostMarker(vaultPaths: VaultPaths): void {
  if (configFolderLinked(vaultPaths)) return
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
  return outOfStoreRowPaths(vaultPaths, db).filter((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false // gone or unreachable → nothing to rekey
    }
  })
}

/** The `stored_path` of every row whose copy the resolver reads OUTSIDE the store ({@link listOutOfStoreCopies}' rule
 *  without its "a file there now" test), each once. */
function outOfStoreRowPaths(vaultPaths: VaultPaths, db: Db): string[] {
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
    out.add(path)
  }
  return [...out]
}

/**
 * #1014: the out-of-store stored copies the open database lists, as folded paths ({@link pathKey}): what a rekey journal's
 * stage outside the workspace folder must name (with `.new`) before it is acted on. Without "a file there now", so a swap
 * cut short between its shred and its rename still finishes.
 */
function outOfStoreTargets(vaultPaths: VaultPaths, db: Db): ReadonlySet<string> {
  return new Set(outOfStoreRowPaths(vaultPaths, db).map(pathKey))
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
  try {
    return parseRekeyJournal(readFileSync(path, 'utf8'))
  } catch {
    // Unreadable: the directory scans still resolve the in-store classes; the file itself is
    // quarantined (never deleted) by clearRekeyJournal so its out-of-store entries are not lost.
    return { version: REKEY_JOURNAL_VERSION, staged: [], remove: [], corrupt: true }
  }
}

/** The rekey journal's text, judged: `corrupt` when it does not parse or names another version. */
function parseRekeyJournal(text: string): RekeyJournalRead {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  try {
    const parsed = parseJsonText(text) as Partial<RekeyJournal>
    if (parsed.version !== REKEY_JOURNAL_VERSION) {
      return { version: REKEY_JOURNAL_VERSION, staged: [], remove: [], corrupt: true }
    }
    return {
      version: REKEY_JOURNAL_VERSION,
      // Every entry as written: what a recovery may act on is {@link planRekeyJournal}'s to judge. #1014 round 4: an
      // entry that names no stage (no `.new`) was dropped here, before anything could count it; the plan refuses it
      // and counts it, as it does every other entry it cannot vouch for.
      staged: strings(parsed.staged),
      remove: strings(parsed.remove),
      corrupt: false
    }
  } catch {
    return { version: REKEY_JOURNAL_VERSION, staged: [], remove: [], corrupt: true }
  }
}

/** A path key that folds spelling differences (`..` segments, drive-letter case on Windows)
 *  so one physical staged file is never listed — and swapped — twice (#241). */
function pathKey(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Atomic (temp + fsync + rename), like the descriptor: recovery must never read half a journal.
 *  #1014 round 6 (review V8-6): never through a link at the temp name. 'w' followed one: a hard or symbolic link there
 *  had the journal written into the file it reaches, elsewhere on the drive, and a junction failed every rewrite. Now
 *  whatever is at that name is removed first ({@link removeTempName}: a link by `unlink`) and the temp is created anew
 *  ('wx'), so one planted in between makes the write fail instead. A folder there is left, and the write fails. */
function writeRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournal): void {
  const path = rekeyJournalPath(vaultPaths)
  const tmp = `${path}.tmp`
  removeTempName(tmp)
  const fd = openSync(tmp, 'wx')
  try {
    writeSync(fd, Buffer.from(JSON.stringify(journal, null, 2), 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Remove the journal — or, when it could not be parsed, quarantine it as `.corrupt` beside
 *  the vault so the out-of-store paths it may name are never destroyed with it.
 *  T2.16 fix round (R2 A1 = R1 B-6): only a regular file at `.corrupt` (an earlier quarantine) is replaced, as before. A
 *  folder there made the `rmSync` throw (a file error), so every start and unlock answered "try again" for good, and a
 *  link there was removed: anything but a file at that name is now left as it is, judged by `lstat` (never followed), and
 *  the journal goes to the next free name instead ({@link quarantineName}). With none free it stays where it is: a
 *  journal that does not parse lists nothing a pass could act on, so nothing is lost and nothing blocks. */
function clearRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournalRead | null): void {
  const path = rekeyJournalPath(vaultPaths)
  removeTempName(`${path}.tmp`)
  if (journal?.corrupt && existsSync(path)) {
    const aside = quarantineName(path)
    if (aside === null) return
    if (aside === `${path}.corrupt`) rmSync(aside, { force: true })
    renameSync(path, aside)
    return
  }
  rmSync(path, { force: true })
}

/** T2.16: at most this many `.corrupt-<n>` names are tried before a quarantine gives up (and leaves the journal). */
const QUARANTINE_NAMES = 64

/** T2.16 (R2 A1): where {@link clearRekeyJournal} sets a journal that does not parse aside: `.corrupt` while nothing is
 *  there or a regular file is (`lstat`, as before), else the first `.corrupt-<n>` (n from 1) that an `lstat` proves free
 *  (ENOENT); null when none of those is. */
function quarantineName(path: string): string | null {
  const named = lstatOrNull(`${path}.corrupt`)
  if (named === null || named.isFile()) return `${path}.corrupt`
  for (let n = 1; n <= QUARANTINE_NAMES; n++) {
    try {
      lstatSync(`${path}.corrupt-${n}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return `${path}.corrupt-${n}`
    }
  }
  return null
}

/**
 * #1014 round 3: settle the journal once a pass has done what it can. With nothing it lists still waiting it is cleared
 * (or quarantined, unreadable); otherwise it is rewritten, atomically as `stageRekey` writes it, to list only what still
 * waits. A journal kept as written went on vouching for the staged database and every in-store stage it had already
 * swapped in, so a stray `.enc.new` that turned up later was "listed" and rolled over `.enc` without the #973 key check.
 * Left as it is when it already lists exactly that; a rewrite that cannot be made (a folder at the journal's temp name)
 * leaves it as it was, which loses nothing.
 * Round 6 (review V8-1): a rewrite keeps the rotated log's flag (its file name, as {@link planRekeyJournal} reads it)
 * while that log is still at the path the app computes for it. Rewritten with `remove: []`, a journal kept for a stage
 * held at the commit dropped it, and a log the swap could not remove (held too) stayed under the retired key for good.
 * A journal with nothing left waiting is cleared as before.
 */
function settleRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournalRead | null, waiting: readonly string[]): void {
  if (waiting.length === 0) {
    clearRekeyJournal(vaultPaths, journal)
    return
  }
  if (journal === null || journal.corrupt) return // nothing it lists can be judged: kept (or quarantined) as it is
  const logsPath = vaultPaths.logsPath
  // T2.16 fix round (R2 B2): behind a logs folder that is a link the log is neither removed nor stat'ed (the stat reached
  // the folder elsewhere, a network path included), so the flag stays: it may still be there.
  const logStays =
    logsPath !== undefined &&
    logsPath !== '' &&
    journal.remove.some(namesRotatedLog) &&
    (folderAtItsName(logsPath) === 'outside' || !statSaysAbsent(join(logsPath, ROTATED_ENCRYPTED_LOG_NAME)))
  const remove = logStays ? [ROTATED_ENCRYPTED_LOG_NAME] : []
  const keys = (list: readonly string[]): string => [...new Set(list.map(pathKey))].sort().join('\n')
  const sameRemove = journal.remove.length === remove.length && journal.remove.every((entry, i) => entry === remove[i])
  if (sameRemove && keys(journal.staged) === keys(waiting)) return
  try {
    writeRekeyJournal(vaultPaths, { version: REKEY_JOURNAL_VERSION, staged: [...waiting], remove })
  } catch {
    /* the journal as it was: it still lists everything that waits */
  }
}

/** #1015 round 3: remove a write temp of the rekey recovery (the staged database's `.enc.new.tmp`, the journal's, a
 *  stage's `<file>.new.tmp`). A FOLDER at the name holds no data and does not go away by waiting, so it is left as it is
 *  (`true`: the caller counts it) instead of failing the recovery into "try again" for good. A link goes by `unlink`; a
 *  file by `rm`, and one another program holds still throws (the transient "try again"). Decided by `lstat`, not by an
 *  error code: Windows answers EPERM for a held file and for a folder alike. */
function removeTempName(path: string): boolean {
  const named = lstatOrNull(path)
  if (named === null) return false
  if (named.isDirectory()) return true
  if (named.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { force: true })
  return false
}

/** #1014 round 4: where {@link insideWorkspace} finds a journal entry: inside the workspace folder on the disk; not
 *  inside (outside it by its text, or inside by its text but through a link); or not known, because a stat on the way
 *  failed for a reason that proves nothing (a hold, a permission, an I/O error: anything but ENOENT, the #911 rule). */
export type Containment = 'inside' | 'outside' | 'unknown'

/** #1014 round 5 (review V7-3): what one plan has learned of the disk, so the entries of one folder (most share
 *  `documents/`) cost one walk and one `realpath` between them: the base folder's realpath (the workspace folder for a
 *  journal entry; null: it failed), and each entry folder's answer, keyed by its folded path. */
interface ContainmentMemo {
  realBase?: string | null
  folders: Map<string, Containment>
}

/**
 * #1014 round 3: does `entry` lie inside the workspace folder on the disk, not only by its text? Its text must, no folder
 * between the workspace folder and the entry may be a link (`lstat`, which never follows one; a Windows junction reads as
 * a link), and the entry's folder, resolved, must still be the workspace folder or inside it. An entry under
 * `documents/J/`, `J` a junction to a folder elsewhere, passed the text test, and the start's swap shredded and replaced
 * the file behind the link. A folder that is not there ends the walk: nothing below it exists to act on.
 * Round 4: a stat that fails otherwise (`lstat` on the way, or either `realpath`) answers `unknown`, never "not inside".
 * Read as "not inside", the entry was refused and dropped from the rewritten journal, and a transient hold at the start
 * left an out-of-store copy under the workspace folder (which no scan finds) under the retired key for good.
 * Round 5: everything after the text test depends on the entry's folder alone, so `memo` answers each folder once.
 */
function insideWorkspace(ws: string, entry: string, memo: ContainmentMemo): Containment {
  if (outsideByText(ws, entry)) return 'outside'
  const folder = dirname(resolve(entry))
  let found = memo.folders.get(pathKey(folder))
  if (found === undefined) {
    found = folderContainment(ws, folder, memo)
    memo.folders.set(pathKey(folder), found)
  }
  return found
}

/** #1014: an entry that lies outside the workspace folder `ws` by its text alone (no file-system call). T2.16 fix round
 *  (R1 B-4 = R2 B1): such an entry is never touched on disk at all, not even by a stat, so one that names a network path
 *  (`\\host\share\…`) can never make the start open a connection ({@link applyPendingRekey}). */
function outsideByText(ws: string, entry: string): boolean {
  return !isInsideDir(ws, resolve(entry))
}

/**
 * {@link insideWorkspace}'s answer for an entry folder that lies inside `ws` by its text; and (T2.16 fix round) the one
 * test every caller applies to a folder the start would act in: a store folder ({@link storeFolderInside}), the
 * workspace folder and the logs folder themselves ({@link folderAtItsName}), the working file's folder before the #911
 * replay ({@link replayMayWrite}); and (round 2, S-6) the knowledge-pack transient folder its own sweep empties
 * (`zim/transients.ts`, which refuses on `unknown` as it always refused a folder it could not resolve). `folder` is
 * `base` or lies below it by its text, and it is `inside` only when it is,
 * on the disk, where its path says: no folder below `base` on the way is a link (`lstat`, which never follows one), and
 * the OS's own resolution of `folder` is `base`'s resolution with the same names below it. `outside` is anything else
 * there (a link, a junction, a file at a folder's name, a folder that resolves elsewhere); `unknown` a stat that failed
 * for a reason that proves nothing (#1014 round 4: never acted on as a journal entry; T2.9: a store folder is read as
 * before). The three answers mean the same for every caller.
 * T2.16 fix round (R1 B-1): Node's `lstat` reports a Windows junction as a link only when its target is a `\??\X:\…`
 * path; a junction to a volume GUID path (`\\?\Volume{…}\…`) or to a device path (`\\?\GLOBALROOT\Device\
 * HarddiskVolumeN\…`) reads as a plain folder to it and to the JS `realpathSync`, which then resolves nothing, so the
 * old test (`realpathSync`, "inside the workspace's realpath") answered `inside` for an entry or a store folder behind
 * one. `realpathSync.native` asks the OS, which resolves every reparse point, so such a junction resolves elsewhere and
 * answers `outside`; and the resolution must be exactly the expected path (folded as {@link pathKey} folds it), not
 * merely inside `base`, so a link that leads elsewhere inside the workspace answers `outside` too. Both sides go through
 * the same resolution, so a link or a short (8.3) name above `base`, a `subst` drive or a network drive letter changes
 * nothing.
 */
export function folderContainment(base: string, folder: string, memo: ContainmentMemo = { folders: new Map() }): Containment {
  const rel = relative(base, folder)
  let dir = base
  for (const part of rel === '' ? [] : rel.split(sep)) {
    dir = join(dir, part)
    let named: Stats
    try {
      named = lstatSync(dir)
    } catch (err) {
      return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'inside' : 'unknown'
    }
    if (!named.isDirectory()) return 'outside' // a link (a `\??\X:\` junction too), or a file at a folder's name
  }
  if (memo.realBase === undefined) {
    try {
      memo.realBase = realpathSync.native(base)
    } catch {
      memo.realBase = null
    }
  }
  if (memo.realBase === null) return 'unknown'
  try {
    return pathKey(realpathSync.native(folder)) === pathKey(join(memo.realBase, rel)) ? 'inside' : 'outside'
  } catch {
    return 'unknown'
  }
}

/** T2.16 fix round (R2 B2, owner 2026-11-24: fix): is `dir` (the workspace folder, the logs folder) on the disk where its
 *  path says, judged from its parent by {@link folderContainment}? `outside` when it is a link to a folder elsewhere (any
 *  junction, a symbolic link), or no folder; `unknown` when a stat proves nothing. */
function folderAtItsName(dir: string): Containment {
  return folderContainment(dirname(dir), dir)
}

/**
 * T2.7 security fix round (F-3; FU-P2-6 in P2): may a delete a database row asks for shred `path` as a file of the store
 * at `storeDir` (`workspace/documents/`, `workspace/images/`)? Only when it lies inside that folder by its text and the
 * folder holding it is, on the disk, where its path says ({@link folderContainment}: `inside`; a link on the way, a
 * folder that resolves elsewhere, or a stat that proves nothing answers no). A row names its file by a recorded path or
 * name, which a later version, a cloned drive or a database the app did not make can point at any file: such a file is
 * left as it is, and only the row goes. The app writes every stored copy into its store, so its own always pass.
 * Re-check 1 (N-2): the folders are judged from the workspace folder that holds the store (`storeDir`'s parent), as the
 * start's sweep judges a store ({@link storeFolderInside}, T2.9 R2-3): judged from the store itself, the store folder
 * always matched its own resolution, so behind a `documents/` or `images/` that is a link to a folder elsewhere every
 * file passed. Behind such a link nothing is shredded now; the cost, recorded: a store a user keeps behind a link of
 * their own keeps a deleted document's or image's encrypted copy, as it already gets no sweep.
 */
export function storeHoldsFile(storeDir: string, path: string): boolean {
  const store = resolve(storeDir)
  const full = resolve(path)
  if (!isInsideDir(store, full)) return false
  return folderContainment(dirname(store), dirname(full)) === 'inside'
}

/** #1014 round 3: the staged database's or an in-store stage's entry (`documents/`, `images/`), which the start settles:
 *  never kept in a rewritten journal, except one still staged ({@link settleRekeyJournal}). */
function isStoreOrDatabaseStage(vaultPaths: VaultPaths, staged: string): boolean {
  if (pathKey(staged) === pathKey(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) return true
  const dir = pathKey(dirname(resolve(staged)))
  const ws = workspaceDirOf(vaultPaths)
  return [DOCUMENTS_DIR_NAME, IMAGES_DIR_NAME].some((sub) => pathKey(join(ws, sub)) === dir)
}

/** #1014 round 3: an admitted entry that still waits after a pass: still staged (a stage left beside a folder at its
 *  stored copy's name, or one a pass did not reach), or an out-of-store stage on a location that is unreachable now
 *  (neither file there: a detached drive), which a later recovery finishes when it returns. */
function stillWaiting(vaultPaths: VaultPaths, staged: string): boolean {
  if (isFileAt(staged)) return true
  return (
    !isStoreOrDatabaseStage(vaultPaths, staged) &&
    !existsSync(staged) &&
    !existsSync(staged.slice(0, -REKEY_SUFFIX.length))
  )
}

/** #1014 round 6 (review V8-2): does an entry a pass did not admit (`unknown`, or deferred to the unlock) still wait?
 *  As {@link stillWaiting} reads an admitted one, and also while a stat of its stage cannot tell (anything but ENOENT).
 *  Kept unfiltered, such an entry stayed after the pass had swapped its stage in (the staged database and the scanned
 *  in-store stages are found without the journal), and the next pass, judging the entry inside again, read a stray
 *  `.enc.new` at that name as listed and rolled it over its stored copy with no key check (#973, #1001). */
function notAdmittedStillWaits(vaultPaths: VaultPaths, staged: string): boolean {
  return stillWaiting(vaultPaths, staged) || !statSaysAbsent(staged)
}

/**
 * #1014: what a recovery may act on in a rekey journal. The journal is plain JSON in the workspace folder, read at every
 * start before any password, and its entries are absolute paths: nothing proves the app wrote them, or wrote them for
 * this folder. So no entry is used as a path to act on unless one of these holds:
 *   - `staged`: an entry that ends `.enc.new` (every stage a password change writes does: the database, the `documents/`
 *     and `images/` copies, an out-of-store copy, whose stored path ends `.enc`) and lies inside the workspace folder.
 *     The recoveries act on it as before;
 *   - `deferred`: such an entry outside the workspace folder (round 5: or inside it by its text but through a link), the
 *     stage of an out-of-store stored copy (issue #188's
 *     absolute `stored_path`: elsewhere on the drive, or on another drive). Nothing at the start can tell it from any other
 *     path, so it waits for the unlock, which acts on it only when the open database lists its stored copy
 *     ({@link finishOutOfStoreStages});
 *   - `removeRotatedLog`: the `remove` list is read as a flag, never as paths. The only file a password change removes is
 *     the rotated diagnostics log, so an entry named like it asks for THE rotated log, at the path the app computes from
 *     its own `logsPath`, wherever the journal was written (another drive letter or mount point included).
 * Every other entry (another suffix, any other `remove` path) is left as it is and counted (`refused`), for the log.
 * Round 3: "inside" is judged on the disk ({@link insideWorkspace}): an entry inside the folder by its text whose path runs
 * through a link (a junction to a folder elsewhere) is not `staged`. Round 5 (review V7-1): it is `deferred`, acted on
 * only as an out-of-store copy the open database lists. Round 3 refused it, and a stored copy in a folder of the
 * workspace reached through a junction (`<ws>/legacy/J/x.enc`), which a password change stages (its stat follows the
 * link), was then never swapped in: that document stayed under the retired key for good.
 * Round 4: `unknown` holds the entries inside the folder by their text whose containment a failed stat left open. One is
 * neither acted on nor dropped: every pass leaves it as it is, counts it, and keeps it in the journal it settles, so the
 * next pass judges it again.
 * An entry under another drive root of this workspace fails the containment too. That loses nothing: the scan still finds
 * the in-store stages, and, listed by their full path no more, they are the doubts the unlock judges under the data key
 * (#973, #1001); rebasing the entry instead would let a journal vouch for a stage by its relative name, which review
 * round 3 F1 closed.
 */
interface JournalPlan {
  staged: string[]
  deferred: string[]
  unknown: string[]
  removeRotatedLog: boolean
  refused: number
}

function planRekeyJournal(vaultPaths: VaultPaths, journal: RekeyJournalRead | null): JournalPlan {
  const plan: JournalPlan = { staged: [], deferred: [], unknown: [], removeRotatedLog: false, refused: 0 }
  const ws = workspaceDirOf(vaultPaths)
  const memo: ContainmentMemo = { folders: new Map() }
  for (const entry of journal?.staged ?? []) {
    if (!entry.endsWith(`${ENCRYPTED_DOC_SUFFIX}${REKEY_SUFFIX}`)) {
      plan.refused += 1
      continue
    }
    // T2.7 security fix round (L-5): an entry that is no full path on this system resolves against the app's working
    // folder (the drive root, as the launchers start it), so `workspace/hilbertraum.sqlite.enc.new` vouched. It never
    // does now: it is judged as an entry outside the workspace ({@link fullPathEntry}).
    const where = fullPathEntry(entry) ? insideWorkspace(ws, entry, memo) : 'outside'
    if (where === 'inside') plan.staged.push(entry)
    else if (where === 'unknown') plan.unknown.push(entry) // round 4: judged again by the next pass
    else plan.deferred.push(entry) // outside it, or (round 5) inside by its text but through a link
  }
  for (const entry of journal?.remove ?? []) {
    if (vaultPaths.logsPath && namesRotatedLog(entry)) plan.removeRotatedLog = true
    else plan.refused += 1
  }
  return plan
}

/**
 * T2.7 security fix round (L-5): is the journal entry a full path on this system, one whose meaning no working folder
 * changes? On Windows a drive letter with its separator (`E:\…`) or a `\\` share or device path; elsewhere a path from
 * `/`. Not `isAbsolute` alone: on Windows that admits `\workspace\…`, which resolves on the working folder's drive, the
 * Kit's own drive when the launcher starts the app at its root. Every journal a release wrote names its entries by full
 * path (built from the drive root the launcher passes, `%~dp0` or `pwd`). An entry that is not one is judged as an entry
 * outside the workspace (`deferred`), as before for an entry another system wrote (a Windows journal read on Linux, or
 * the reverse): it never vouches for a stage, and is acted on only as an out-of-store stage the open database lists.
 */
function fullPathEntry(entry: string): boolean {
  if (!isAbsolute(entry)) return false
  return process.platform !== 'win32' || /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(entry)
}

/** #1014: does a `remove` entry name the rotated log? By its file name alone: `win32.basename` splits at `\` and `/`
 *  alike, so a journal a Kit's Windows app wrote names the log for its Linux or macOS app too. */
function namesRotatedLog(entry: string): boolean {
  const fold = (name: string): string => (process.platform === 'win32' ? name.toLowerCase() : name)
  return fold(win32.basename(entry)) === fold(ROTATED_ENCRYPTED_LOG_NAME)
}

/** #1014: the rotated diagnostics log, at the path the app computes for it (best-effort, idempotent: nothing reads it).
 *  T2.16 fix round (R1 B-5 = R2 B2): not behind a logs folder that is a link ({@link folderAtItsName}): the file of that
 *  name in the folder it reaches was deleted. That log then stays under the retired key, which nothing reads. */
function removeRotatedLog(vaultPaths: VaultPaths): void {
  if (!vaultPaths.logsPath || folderAtItsName(vaultPaths.logsPath) === 'outside') return
  try {
    rmSync(join(vaultPaths.logsPath, ROTATED_ENCRYPTED_LOG_NAME), { force: true })
  } catch {
    /* locked: stays under the retired key; nothing reads it */
  }
}

/** Every staged `<file>.new` of an (interrupted or in-progress) rekey: the DB, the in-store
 *  sidecars (`documents/`, `images/` — by scan, so a journal-less stage still resolves) and
 *  the journal's entries inside the workspace folder (#1014: {@link planRekeyJournal}'s `staged`, `admitted`), plus
 *  `outOfStore`: the deferred out-of-store stages the open database lists, for the callers that hold it. #1001: a
 *  journal-less in-store sidecar stage beside its stored copy resolves at the unlock, under the data key
 *  ({@link sidecarStagesInDoubt}); the recoveries before the password skip it. Round 5 (review V7-3): a pass that holds
 *  its plan passes `admitted`, so the journal is not judged twice. */
function stagedRekeyFiles(
  vaultPaths: VaultPaths,
  admitted: readonly string[] = planRekeyJournal(vaultPaths, readRekeyJournal(vaultPaths)).staged,
  outOfStore: readonly string[] = []
): string[] {
  // Keyed on the folded path: the scan and the journal may spell one file two ways, and a
  // file listed twice would be shredded by its own second swap.
  const out = new Map<string, string>()
  const add = (p: string): void => {
    if (!out.has(pathKey(p))) out.set(pathKey(p), p)
  }
  // #1014: a file only, as for every journal entry (#1001 review round 2). A folder at this name, which every journal
  // lists, was counted by its existence: `.enc` was shredded and the folder renamed into its place.
  if (isFileAt(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) add(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  for (const staged of scannedSidecarStages(vaultPaths)) add(staged)
  // #1001 (review round 2): a journal entry counts only when it names a file, as the scan does. `existsSync` is true for
  // a folder too, and a folder at a listed name was renamed over its stored copy, which was shredded first.
  // T2.16 fix round (R2 B4): a regular file no other name shares, judged by `lstat` ({@link linkedStage}), as the unlock
  // judges an outside stage. A stat follows a link, so a symbolic link or a second hard link at a listed name counted, and
  // the swap shredded the stored copy and renamed the link onto its name. Such an entry is no stage of this pass, however
  // the scan or the staged database's name found it: it is left as it is, with its journal ({@link applyPendingRekey}).
  const linked = new Set<string>()
  for (const staged of [...admitted, ...outOfStore]) {
    if (linkedStage(staged)) linked.add(pathKey(staged))
    else if (isFileAt(staged)) add(staged)
  }
  return [...out.entries()].filter(([key]) => !linked.has(key)).map(([, staged]) => staged)
}

/** T2.16 (R2 B4): is the name `staged` a link to a file, or a file another name shares (`lstat`: `name-only`)? */
function linkedStage(staged: string): boolean {
  return shredNameOf(lstatOrNull(staged)).kind === 'name-only'
}

/** #1014: the deferred out-of-store stages whose stored copy the open database lists ({@link outOfStoreTargets}). */
function listedOutOfStoreStages(plan: JournalPlan, targets: ReadonlySet<string>): string[] {
  return plan.deferred.filter((staged) => targets.has(pathKey(staged.slice(0, -REKEY_SUFFIX.length))))
}

/** Is there a regular file at `path`? False for a folder, and for a stat that fails for any reason (as `existsSync`). */
function isFileAt(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * T2.9 fix round (R2-3, owner 2026-11-24): `workspace/<sub>` (`documents/`, `images/`) as the start may read it, or null
 * when it is not a real folder inside the workspace folder: `lstat` says it is a link (a Windows junction reads as one)
 * or no folder, or it resolves elsewhere. That is the test #1014's journal containment applies to an entry's folder
 * ({@link folderContainment}: `outside`), and the one the knowledge-pack transient sweep refuses a linked folder by
 * (`zim/transients.ts`: no link, a folder, resolving to its own name under the workspace), so the three agree. Every start
 * of an encrypted workspace, before any password, read such a link as a folder of its own: the sweep overwrote and
 * removed the `*.tmp` and `*.parse*` files behind it, and the stage scan had the rekey recovery rename `*.enc.new` files
 * there over stored copies that were gone (delete them all, under a v1 descriptor) and the unlock remove or swap in the
 * rest. Now nothing behind the link is shredded, renamed or deleted. A store a user keeps behind a link of their own gets
 * no sweep of its transients and no recovery of its stages (only a v1 → v2 password change writes stages there, and no
 * published release wrote a v1 descriptor). A folder not there passes (nothing below it to act on: the caller's `readdir`
 * fails), and so does one a stat that proves nothing leaves open (`unknown`: a hold or an I/O error on `lstat` or
 * `realpath`): it is read as before, where every stage beside a stored copy is still judged under the data key at the
 * unlock, since the journal vouches for none of its entries while their containment is unknown (#1014 round 4).
 */
function storeFolderInside(vaultPaths: VaultPaths, sub: string): string | null {
  const ws = workspaceDirOf(vaultPaths)
  const dir = join(ws, sub)
  return folderContainment(ws, dir, { folders: new Map() }) === 'outside' ? null : dir
}

/** The in-store sidecar stages, by scan: every file in `documents/` and `images/` named `*.enc.new`. #1001 (review round
 *  1): a file only. A folder at such a name is no stage, and nothing here touches it: before, the start shredded the
 *  stored copy and renamed the folder into its place. T2.9 (R2-3): only in a store folder that is a real folder inside
 *  the workspace ({@link storeFolderInside}); the format verdict, both recoveries and the unlock's #1001 pass read this. */
function scannedSidecarStages(vaultPaths: VaultPaths): string[] {
  const out: string[] = []
  for (const sub of [DOCUMENTS_DIR_NAME, IMAGES_DIR_NAME]) {
    const dir = storeFolderInside(vaultPaths, sub)
    if (dir === null) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(`${ENCRYPTED_DOC_SUFFIX}${REKEY_SUFFIX}`)) out.push(join(dir, entry.name))
      }
    } catch {
      /* dir not created yet */
    }
  }
  return out
}

/**
 * Checkpoint the open working database so that the main file alone holds the session, and judge it, before the password
 * change encrypts that file with the connection still open: its stage ({@link stageRekey}) and, #1027, its `.enc` after a
 * database swap that failed ({@link saveOpenDatabase}). `refusal` opens the message of a refusal; nothing is encrypted.
 */
function checkpointOpenDatabase(vaultPaths: VaultPaths, db: Db, refusal: string, onProbeFallback?: ProbeFallbackNote): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  // #876 review round 2 — the lock's WAL guard: a checkpoint that could not finish (it does not
  // throw; it answers "busy") leaves the main file stale while the session's commits sit in the
  // `-wal`, and the staged copy of that stale file would replace `.enc` at the commit. The
  // connection is open, so a TRUNCATE that finished left the `-wal` empty. Refused; nothing is
  // staged, and the user tries the change again.
  if (walAwaitsCheckpoint(vaultPaths.dbPath)) {
    throw new Error(
      `${refusal}: the checkpoint did not finish, so the working ` +
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
      `${refusal}: the working database file is not a SQLite ` +
        'database (it may have been overwritten).'
    )
  }
}

/**
 * #1027 (B): a password change whose staged database could not be moved into place writes `.enc` from the open database
 * under the new data key, with the stage's own guards ({@link checkpointOpenDatabase}). Nothing has written to the
 * database since the stage, so `.enc` then holds what the stage holds, and the session ends as any other does from here
 * on: a failed lock's working file is kept (CODE-1b), a kill is reported (#892). `encryptFile` replaces whatever is at the
 * name by its atomic rename: nothing (the swap shredded it), noise (the shred overwrote a held file it could not unlink),
 * or the old v1 file (another program held it through the swap, so its shred could not touch it). Code review CR1-1: that
 * old file is under the retired, password-derived key, which the swap shreds before its rename, so a regular file at
 * `.enc` that does not open under the new data key is shredded first here too, as the swap does (the same window: `.enc`
 * missing while the stage, the snapshot of the change, is still there). One that opens under the key is never shredded,
 * and one that cannot be read just now (still held) is not judged: the rename below (or, when that fails too, the next
 * lock's) replaces it unshredded, its blocks freed rather than overwritten, as every lock frees the previous `.enc`.
 * Code review N1 (#845): a frame a newer build wrote at `.enc` is never written over: its `VaultNewerError` passes, so
 * nothing is saved (the change stays committed, the save counts as not done).
 */
function saveOpenDatabase(vaultPaths: VaultPaths, db: Db, key: Buffer, onProbeFallback?: ProbeFallbackNote): void {
  checkpointOpenDatabase(vaultPaths, db, 'Refusing to save the workspace after the password change', onProbeFallback)
  let retired = false
  try {
    retired = shredNameOf(lstatOrNull(vaultPaths.encPath)).kind === 'file' && !authenticatesUnder(vaultPaths.encPath, key)
  } catch (err) {
    if (isVaultNewerError(err)) throw err
    /* cannot be read now (a hold, an I/O error): never shredded unjudged (see above) */
  }
  if (retired) shredFile(vaultPaths.encPath)
  encryptFile(vaultPaths.dbPath, vaultPaths.encPath, key)
}

/**
 * #1027 (J): drop the staged database from the rekey journal, the rest as written (atomically, as `stageRekey` writes it;
 * cleared when nothing is left). The open session holds the workspace from now on, and a journal that listed the stage
 * had every start roll it over the newer `.enc` with no key check. Unlisted, a stage beside a missing `.enc` still rolls
 * forward at a start (it is the only snapshot), and one beside an `.enc` is a #973 doubt the unlock judges under the data
 * key ({@link resolveStageInDoubt}). No journal (ENOENT) lists nothing, nor does one that does not parse or names
 * another version, which is left as it is. Review F1: a journal that cannot be read just now (another program holds it
 * with no read sharing, a permission, an I/O error) is not judged: this throws, as it does when the journal cannot be
 * rewritten, and the caller retries at the lock. ({@link readRekeyJournal} reads such a journal as one that does not
 * parse, which here read as "the stage is unlisted", so the lock never tried again and the next start rolled the stage.)
 */
function unlistStagedDatabase(vaultPaths: VaultPaths): void {
  let text: string
  try {
    text = readFileSync(rekeyJournalPath(vaultPaths), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    throw err
  }
  const journal = parseRekeyJournal(text)
  if (journal.corrupt) return
  const stagedDb = pathKey(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  const staged = journal.staged.filter((entry) => pathKey(entry) !== stagedDb)
  if (staged.length === journal.staged.length) return
  if (staged.length === 0 && journal.remove.length === 0) clearRekeyJournal(vaultPaths, journal)
  else writeRekeyJournal(vaultPaths, { version: REKEY_JOURNAL_VERSION, staged, remove: journal.remove })
}

/** #1027: run a best-effort step; true when it finished. */
function bestEffort(step: () => void): boolean {
  try {
    step()
    return true
  } catch {
    return false
  }
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
  checkpointOpenDatabase(vaultPaths, db, 'Refusing to stage the password change', onProbeFallback)
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
 *
 * #1001: `skip` holds the folded paths ({@link pathKey}) of staged files this pass leaves as they are: the recoveries
 * pass the journal-less sidecar stages in doubt ({@link sidecarStagesInDoubt}), which the unlock judges under the data
 * key ({@link resolveSidecarStagesInDoubt}). A password change passes none: every stage it swaps is its own, journal'd.
 *
 * #1014: only what {@link planRekeyJournal} admits. `outOfStore` is the set the open database lists
 * ({@link outOfStoreTargets}), from a caller that holds it (a password change): the journal's stages outside the
 * workspace folder (round 5: or inside it through a link) whose stored copy it lists are swapped too, and the others
 * refused. Without it (the recoveries before the password) such a stage waits, and the journal with it, for the unlock
 * ({@link finishOutOfStoreStages}).
 * `onRefused` hears what this pass left as it is (a count, for the log), once it has settled the journal: the entries it
 * refused (each dropped from the journal, so no later pass counts it again), round 3's folders, and round 4's entries a
 * failed stat left unjudged (kept in the journal, and counted by each pass that meets them, as a folder is).
 *
 * Round 3: a folder at a write temp's name is left ({@link removeTempName}), and so is a stage whose stored copy's name a
 * FOLDER holds (a document's or an image's, judged by `lstat`): that one stage stays, listed, and the rest of the change
 * goes on, where the folder used to fail the whole recovery into "try again" for good. A folder at the database's `.enc`
 * is the workspace itself: its swap still fails into the blocked recovery. The journal is then settled
 * ({@link settleRekeyJournal}): rewritten to what still waits, or cleared.
 */
export function applyPendingRekey(
  vaultPaths: VaultPaths,
  skip: ReadonlySet<string> = new Set(),
  outOfStore?: ReadonlySet<string>,
  onRefused?: (refused: number) => void
): void {
  const journal = readRekeyJournal(vaultPaths)
  const plan = planRekeyJournal(vaultPaths, journal)
  const listed = outOfStore ? listedOutOfStoreStages(plan, outOfStore) : []
  let left = plan.refused + plan.unknown.length + (outOfStore ? plan.deferred.length - listed.length : 0)
  // Committed, so the files the migration retires go first (idempotent, best-effort): a
  // later crash can then never skip them. Today that is the rotated log (#241), at its own path (#1014).
  if (plan.removeRotatedLog) removeRotatedLog(vaultPaths)
  // encryptFile's write temp beside an out-of-store target (the in-store ones are swept). The staged database's own
  // temp is the recovery's to remove (`recoverPendingRekey`), before this pass.
  const stagedDb = pathKey(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  const accepted = [...plan.staged, ...listed]
  for (const staged of accepted) {
    if (pathKey(staged) !== stagedDb && removeTempName(`${staged}.tmp`)) left += 1
    if (linkedStage(staged)) left += 1 // T2.16 (R2 B4): a link at the stage's name is left, and still waits (kept)
  }
  const swapOne = (staged: string): void => {
    // Already swapped (or listed under two spellings): shredding the target now would
    // destroy the NEW ciphertext.
    if (!existsSync(staged)) return
    const target = staged.slice(0, -REKEY_SUFFIX.length)
    if (pathKey(staged) !== stagedDb && lstatOrNull(target)?.isDirectory()) {
      left += 1 // round 3: a folder at a stored copy's name: that stage stays as it is, and the rest goes on
      return
    }
    shredFile(target)
    renameSync(staged, target)
  }
  let pending = stagedRekeyFiles(vaultPaths, plan.staged, listed).filter((staged) => !skip.has(pathKey(staged)))
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
  // A journal entry with neither its `.new` nor its target on disk sits on a location that
  // is unreachable right now (a detached legacy drive) — keep the journal so a later
  // recovery can still finish that swap; clear it once every entry is accounted for.
  // #1014: the entries this pass admitted; a stage still waiting for the database keeps it too. Round 3: and the journal
  // is rewritten to list only those ({@link stillWaiting}), so it vouches for nothing this pass settled. Round 4: and the
  // entries a failed stat left unjudged, for the next pass. Round 6: those and the deferred ones only while their stage
  // may still be there ({@link notAdmittedStillWaits}). T2.16 fix round (R1 B-4 = R2 B1): except a deferred entry outside
  // the workspace folder by its text, which is kept as it is with no file-system call at all: the stat that judged it
  // reached any path a journal names (a network path made every start, before any password, open a connection to a host
  // the drive chose). Round 6's reason for the stat (an entry kept after its stage was swapped in, which a later pass
  // judging it inside read as listing a stray stage) cannot hold for it: no pass ever judges it inside, and the unlock
  // acts on it only when the open database lists its stored copy ({@link finishOutOfStoreStages}), and drops it otherwise.
  const ws = workspaceDirOf(vaultPaths)
  const waiting = [
    ...accepted.filter((staged) => stillWaiting(vaultPaths, staged)),
    ...plan.unknown.filter((staged) => notAdmittedStillWaits(vaultPaths, staged)),
    ...(outOfStore ? [] : plan.deferred).filter(
      (staged) => outsideByText(ws, staged) || notAdmittedStillWaits(vaultPaths, staged)
    )
  ]
  // Anything still unswapped (a persistently locked file) is left staged for recoverPendingRekey
  // on the next unlock; surface the failure so the caller logs it (the swap is old-or-new per
  // file, never mixed within a file). The journal stays with it.
  // #1014 round 5 (review V7-2): settled and counted first, then thrown. Thrown before the settle, the journal went on
  // listing the staged database and every stage this pass had already swapped in, so a stray `.enc.new` that turned up
  // later was "listed" and the next start rolled it over `.enc` with no #973 key check. A stage that failed is still a
  // file, so it still waits. A settle that cannot be made then leaves the journal as it was, and the swap's error wins.
  if (pending.length > 0) {
    try {
      settleRekeyJournal(vaultPaths, journal, waiting)
    } catch {
      /* the journal as it was: it still lists everything that waits */
    }
    onRefused?.(left)
    throw lastErr instanceof Error ? lastErr : new Error('applyPendingRekey: incomplete swap')
  }
  // Round 6 (review V8-8): the count is reported however the settle ends; a journal another program holds threw out of
  // the clear before it was heard.
  try {
    settleRekeyJournal(vaultPaths, journal, waiting)
  } finally {
    onRefused?.(left)
  }
}

/** Roll back an uncommitted rekey: delete the staged files and the journal. Plain delete
 *  is enough — they are ciphertext under a data key that was never persisted anywhere.
 *  #1014: only what {@link planRekeyJournal} admits, and outside the workspace folder only the stages whose stored copy
 *  `outOfStore` (the open database, from a password change) lists. A stage the start cannot judge is left: ciphertext
 *  under a key nothing holds, which no build reads again once the journal is gone. `onRefused` hears the count.
 *  #1014 round 4: an entry a failed stat left unjudged is left too, and the journal is kept to list only those, so the
 *  next pass judges them again and removes the stage; with none, the journal is cleared as before.
 *  Round 5 (review V7-2): a delete that throws leaves the journal as written. It lists a change that never committed,
 *  which every recovery under that descriptor discards again, and a new change writes its own journal first. */
export function discardPendingRekey(
  vaultPaths: VaultPaths,
  outOfStore?: ReadonlySet<string>,
  onRefused?: (refused: number) => void
): void {
  const journal = readRekeyJournal(vaultPaths)
  const plan = planRekeyJournal(vaultPaths, journal)
  const listed = outOfStore ? listedOutOfStoreStages(plan, outOfStore) : []
  let left = plan.refused + plan.unknown.length + plan.deferred.length - listed.length
  for (const staged of stagedRekeyFiles(vaultPaths, plan.staged, listed)) {
    rmSync(staged, { force: true })
  }
  // Round 3: a folder at a write temp's name is left and counted; the staged database's temp is the recovery's.
  const stagedDb = pathKey(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  for (const staged of [...plan.staged, ...listed]) {
    if (pathKey(staged) !== stagedDb && removeTempName(`${staged}.tmp`)) left += 1
  }
  // Round 6: an unjudged entry only while its stage may still be there (review V8-2), and the count reported however
  // the settle ends (review V8-8: a journal another program holds threw out of the clear before the count was heard).
  try {
    settleRekeyJournal(vaultPaths, journal, plan.unknown.filter((staged) => notAdmittedStillWaits(vaultPaths, staged)))
  } finally {
    onRefused?.(left)
  }
}

/**
 * Crash recovery for an interrupted password change. MUST run before any unlock decrypt:
 * the descriptor decides which side of the commit point the crash landed on. v2
 * descriptor + staged files ⇒ committed ⇒ roll FORWARD (the new password's files win);
 * v1 descriptor ⇒ uncommitted ⇒ roll BACK (the old password + old files stay intact).
 * A journal with nothing left staged still needs the roll-forward's deletions (#241).
 *
 * #973: except a staged database the descriptor cannot vouch for ({@link stageInDoubt}): a journal-less `.enc.new`
 * beside an `.enc` that is there, under a v2 descriptor. A create stages its database under this suffix with no
 * journal, so a create cut short by a crash leaves one, and a workspace put back into the same folder later had its
 * `.enc` shredded and replaced by it: an empty database under a key nothing holds. This recovery holds no key, so it
 * leaves the whole staged set (and any journal) as it is; the unlock decides once it has the data key
 * ({@link resolveStageInDoubt}). Journal'd stages, a v1 descriptor and a staged file with `.enc` gone (a create or a
 * swap cut short after the commit) go on as before.
 *
 * #1001: the same rule per stored copy. A `documents/` or `images/` stage no journal lists, beside a stored copy that is
 * not proven gone ({@link sidecarStagesInDoubt}), may be a copy from another workspace or a file planted at the name,
 * and swapping it in would shred the only copy of that document with no key to tell. So the swap skips it, and the
 * unlock judges it under the data key ({@link resolveSidecarStagesInDoubt}). The rest of the set rolls as before.
 *
 * #1014: of the journal, only what {@link planRekeyJournal} admits; `onRefused` hears what each pass left as it is.
 *
 * #1015: a step it cannot finish because a file is held (a swap or a temp removal refused by another program, an I/O
 * error) throws `VaultRecoveryBlockedError` with that error's code, the #242 "try again" answer, instead of the raw error:
 * at the start the controller reports blocked recovery and keeps the app's back end, and at an unlock the user is told to
 * try again. What it finished stays finished, and the journal stays, so the next start or unlock finishes the rest.
 * Round 3: a folder holds no data and does not go away by waiting, so a folder at a write temp's name or at a stored
 * copy's name is left and counted, never "try again" for good (only one at the database's `.enc` still blocks).
 */
export function recoverPendingRekey(
  vaultPaths: VaultPaths,
  descriptor: VaultDescriptor | null,
  onRefused?: (refused: number) => void
): void {
  blockedOnFailure(() => {
    // encryptFile's own atomic-write temp for the staged DB (a crash mid-stage leaves it;
    // the document-dir equivalents end in `.tmp` and are swept by shredStalePlaintext), and
    // the journal's own write temp. Round 3: a folder at either name is left and counted.
    let left = 0
    for (const temp of [`${vaultPaths.encPath}${REKEY_SUFFIX}.tmp`, `${rekeyJournalPath(vaultPaths)}.tmp`]) {
      if (removeTempName(temp)) left += 1
    }
    if (left > 0) onRefused?.(left)
    if (stagedRekeyFiles(vaultPaths).length === 0 && !existsSync(rekeyJournalPath(vaultPaths))) return
    if (descriptor && descriptor.version >= VAULT_VERSION_ENVELOPE && descriptor.dataKey) {
      if (stageInDoubt(vaultPaths)) return // #973: the unlock resolves it under the data key
      applyPendingRekey(vaultPaths, sidecarDoubtKeys(vaultPaths), undefined, onRefused) // #1001: and these, one by one
    } else {
      discardPendingRekey(vaultPaths, undefined, onRefused)
    }
  })
}

/** #1015: run a step of the rekey recovery. One that cannot finish for a file error (a held file, a folder at a name, an
 *  I/O error: an error from `node:fs`, by its code or system call) is the "try again" answer
 *  ({@link VaultRecoveryBlockedError}) with that error's code alone, never its message, which names the drive's paths.
 *  Review R4: any other throw (a fault of the app) passes as it is, as before, never hidden behind "try again"; so do a
 *  newer format's refusal and a blocked answer from within. */
function blockedOnFailure(step: () => void): void {
  try {
    step()
  } catch (err) {
    if (!isFileError(err) || err instanceof VaultRecoveryBlockedError) throw err
    throw new VaultRecoveryBlockedError(causeFailure(err).code)
  }
}

/**
 * #1014: the unlock's half of the rekey recovery, once the database is open and `dataKey` is the workspace's data key.
 * A stage the journal lists outside the workspace folder, or (round 5) inside it by its text but through a link
 * ({@link planRekeyJournal}'s `deferred`), is the stage of an out-of-store stored copy, which the start, holding neither
 * key nor database, left as it was. Each is swapped in here
 * only when all of these hold: the open database lists its stored copy ({@link outOfStoreTargets}); the stage is a
 * regular file no other name shares (`lstat`, never following a link) that opens under the data key; and the stored copy
 * does not (a pending change leaves it under the retired key; one that opens is current, and is never swapped over).
 * With the stored copy gone (a swap cut short between its shred and its rename) the stage is renamed into place. Under a
 * v1 descriptor there is nothing to roll forward: the start's rollback cleared the journal.
 * A stage whose stored copy no document lists is refused, counted (`onRefused`). Review R1: the journal is the only
 * record of an outside stage, so it is cleared only once every listed stage is settled: swapped in here, already in place
 * (the stage gone, its stored copy there), or proven foreign (it does not open under the data key: left as it is). Any
 * other stage is left as it is AND keeps the journal for the next unlock: one that is no plain file of one link, or
 * beside a stored copy that is none (a link, a folder, a second hard link) or that already opens; one that cannot be read
 * or swapped in now (a hold, an I/O error), or, round 4, one where an `lstat` of the stage or of its stored copy fails for
 * any reason but ENOENT; one in a frame a newer build wrote (review R2: that build's to finish); one whose location is
 * unreachable (neither file there). Best-effort: it never fails the unlock.
 * Round 5 (review V7-6): `onRefused` hears every stage this pass left as it is: refused, proven foreign (left on the
 * drive and dropped from the journal), or kept unsettled (counted by each unlock that meets it, as a folder is).
 */
function finishOutOfStoreStages(
  vaultPaths: VaultPaths,
  descriptor: VaultDescriptor,
  db: Db,
  dataKey: Buffer,
  onRefused?: (refused: number) => void
): void {
  if (!(descriptor.version >= VAULT_VERSION_ENVELOPE && descriptor.dataKey)) return
  const journal = readRekeyJournal(vaultPaths)
  const plan = planRekeyJournal(vaultPaths, journal)
  if (plan.deferred.length === 0) return
  const listed = listedOutOfStoreStages(plan, outOfStoreTargets(vaultPaths, db))
  let left = plan.deferred.length - listed.length
  const unsettled: string[] = []
  for (const staged of listed) {
    const target = staged.slice(0, -REKEY_SUFFIX.length)
    try {
      if (removeTempName(`${staged}.tmp`)) left += 1 // round 3: a folder at the temp's name is left
      // Round 4: only ENOENT proves either file is not there ({@link lstatOrAbsent}). Any other failed `lstat` throws to
      // the catch below: a stage it could not stat counted as already in place, and the journal was cleared; a stored
      // copy it could not stat counted as gone, and the stage was renamed over it.
      const stage = shredNameOf(lstatOrAbsent(staged))
      if (stage.kind === 'absent') {
        if (lstatOrNull(target) === null) unsettled.push(staged) // neither file there (or not known): kept
        continue
      }
      if (stage.kind !== 'file') {
        unsettled.push(staged) // a link, a folder or a second name: not judged yet
        continue
      }
      if (!authenticatesUnder(staged, dataKey)) {
        left += 1 // foreign: left as it is, and settled (round 5: counted)
        continue
      }
      const stored = shredNameOf(lstatOrAbsent(target))
      if (stored.kind === 'absent') {
        renameSync(staged, target)
        continue
      }
      if (stored.kind !== 'file' || authenticatesUnder(target, dataKey)) {
        unsettled.push(staged) // never swapped over a link, a folder, a second name or a current copy
        continue
      }
      shredFile(target)
      renameSync(staged, target)
    } catch {
      unsettled.push(staged) // a hold, an I/O error, or a frame a newer build wrote: nothing written, the journal stays
    }
  }
  // Round 3: rewritten to what still waits (an in-workspace entry still staged or unreachable, an outside stage not
  // settled), or cleared; the refused outside stages are dropped, so no later pass counts them again. Round 4: an
  // in-workspace entry a failed stat left unjudged stays too, for the next pass; round 6, only while its stage may still
  // be there (review V8-2), and the count is reported however the settle ends (review V8-8).
  try {
    settleRekeyJournal(vaultPaths, journal, [
      ...plan.staged.filter((staged) => stillWaiting(vaultPaths, staged)),
      ...plan.unknown.filter((staged) => notAdmittedStillWaits(vaultPaths, staged)),
      ...unsettled
    ])
  } finally {
    onRefused?.(left + unsettled.length) // round 5: and the stages kept unsettled
  }
}

/**
 * #973: is the staged database `.enc.new` one the descriptor cannot vouch for? It is, when no rekey journal lists it (no
 * journal, or one that names other files or cannot be read) and `.enc` is not proven gone (a stat that says anything
 * but ENOENT, the #911 rule: only ENOENT proves it is not there). A v1 → v2 password change journals its stage since
 * #241; a create stages with no journal, as builds before #241 did for a password change, so the file alone does not
 * tell a committed change from a create's leftover. With `.enc` gone it is no doubt: a create or a swap cut short after
 * its commit left the staged file as the only snapshot, and it rolls forward at the start as before.
 * A journal entry lists the stage only by its full path, folded as {@link pathKey} folds it (review round 3 F1). The
 * file and folder names are the same in every workspace this app writes, so a match by name alone would let any
 * journal vouch for any stage: a stale one (kept for good when its entries look unreachable, or brought back with a
 * restored folder) rolled a foreign stage over `.enc` with no key. An entry written under another drive letter or mount
 * point therefore leaves the stage in doubt, and the unlock authenticates it and rolls it forward when it opens: the
 * same outcome, one read slower.
 * The database stage only: its answer decides which snapshot opens, and the loss hold reads it. The `documents/` and
 * `images/` stages are judged one by one, by the same rule ({@link sidecarStagesInDoubt}, #1001).
 * #1014 round 4: only an entry {@link planRekeyJournal} admits lists it, never the journal as written: an entry the plan
 * refuses or cannot judge vouches for nothing (see {@link sidecarStagesInDoubt}).
 */
function stageInDoubt(vaultPaths: VaultPaths): boolean {
  const staged = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  if (!existsSync(staged)) return false
  if (encryptedFileState(vaultPaths) === 'missing') return false
  const admitted = planRekeyJournal(vaultPaths, readRekeyJournal(vaultPaths)).staged
  return !admitted.some((entry) => pathKey(entry) === pathKey(staged))
}

/** #973: what the unlock did with a staged database in doubt ({@link resolveStageInDoubt}): rolled it forward (it
 *  authenticates), removed it (it does not, or is no frame of this build's), or left it (it could not be judged or
 *  removed; the unlock opens `.enc` as it is). #1027: `superseded`, removed because `.enc` opens under the data key too,
 *  so `.enc` holds the newer data (the unlock opens it as it is). */
export type StageInDoubtOutcome = 'rolled-forward' | 'removed' | 'superseded' | 'left'

/**
 * #973: the unlock's answer to {@link stageInDoubt}, once the password verified and the v2 data key is unwrapped. A
 * staged database that authenticates under that key ({@link authenticatesUnder}) is this workspace's (a password change
 * of a build before #241, cut short after its commit), and the staged set rolls forward exactly as the start's recovery
 * would have. One that fails its tag is ciphertext under a key nothing holds (a create's leftover, a copy from another
 * workspace), and one that is no frame of this build's (cut short, another magic) is no staged copy at all: either is
 * removed (a plain delete, as {@link discardPendingRekey} does), and the unlock opens `.enc` as it is. The rest of the
 * staged set then gets what the start's recovery would have given it with that file gone (review round 2 R5: the
 * journal's entries and its deletions, the in-store twins by scan). Both swaps skip the `documents/` and `images/`
 * stages in doubt (#1001): the unlock judges each of them next ({@link resolveSidecarStagesInDoubt}), whatever the
 * database stage turned out to be. A read the check cannot make splits by its code
 * (review round 2 R4, round 3 F4): ENOENT, the file gone since the check, is no stage; EISDIR or ENOTDIR, a folder at
 * the name, is no data at all, so it is left exactly as it is and the unlock opens `.enc` (never blocked for good);
 * any other code (a hold: EBUSY, EPERM, EACCES; an I/O error: EIO) may be a stage this workspace needs, so it changes
 * nothing and refuses the unlock with `VaultRecoveryBlockedError`, the #242 "try again" answer, before the `.recovery`
 * block can roll anything over `.enc`. A delete that fails leaves the file too: it stays a doubt, which no start rolls
 * forward and the next unlock checks again. `note` hears the outcome as soon as it is true (before a later step of the unlock can fail), for the
 * held loss (R2) and the IPC's one log line (F4). The pass is timed as `vault_stage_check` (R9).
 * #1027 (owner, 2026-11-22: G-1 refined): a stage that authenticates rolls forward only while `.enc` does not authenticate
 * under the same key ({@link encOpensUnder}). The invariant this rests on: no build writes `.enc` under a data key before
 * the stage made under that key. A password change stages under a data key it has just generated, before the commit
 * that wraps it (`stageRekey`, then `rewrapVaultKey`), and a create writes `.enc` only by renaming its stage after its
 * own commit; every other writer of `.enc` (a lock, the `.recovery` roll-forward, a change's {@link saveOpenDatabase})
 * runs after that commit, from data at least as new as the stage. So a stage pending a swap always sits beside an
 * `.enc` under the retired key, which does not open, and one beside an `.enc` that opens is stale: a lock of the session
 * whose password change could not move it into place wrote that `.enc`, and rolling the stage over it lost the session's
 * work since the change. Such a stage is deleted (`superseded`) and the unlock opens `.enc`; the rest of the staged set
 * gets what the start would have given it. A delete that fails (another program holds the stage) leaves it (`left`) and
 * swaps in the rest with the stage skipped; the lock of that session deletes it once it can. A read of `.enc` that fails
 * splits as the stage's does: gone (ENOENT) or a folder (EISDIR, ENOTDIR) is no `.enc` that opens, so the stage rolls
 * forward as before (a folder at `.enc` blocks the swap, as it did); any other failure refuses as "try again".
 */
function resolveStageInDoubt(
  vaultPaths: VaultPaths,
  descriptor: VaultDescriptor,
  dataKey: Buffer,
  note?: (outcome: StageInDoubtOutcome) => void,
  /** #1014: hears how many rekey journal entries the roll-forward below refused. */
  onRefused?: (refused: number) => void
): void {
  if (!stageInDoubt(vaultPaths)) return
  const staged = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  const checkT0 = performance.now()
  let authentic: boolean
  try {
    authentic = authenticatesUnder(staged, dataKey)
  } catch (err) {
    if (isVaultNewerError(err)) throw err
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return // gone since the check: no stage
    // A hold or an I/O error. Round 5 (review V7-5): with its code, for the log, as the other blocked answers carry it.
    if (code !== 'EISDIR' && code !== 'ENOTDIR') throw new VaultRecoveryBlockedError(causeFailure(err).code)
    note?.('left') // a folder at the name: no data
    return
  } finally {
    perfMark('vault_stage_check', { checkMs: perfMs(checkT0), stageBytes: fileSizeOrNull(staged) })
  }
  if (authentic && encOpensUnder(vaultPaths, dataKey)) {
    // #1027: `.enc` is the newer copy (see above). The stage goes; one another program holds stays, skipped.
    try {
      rmSync(staged, { force: true })
    } catch {
      note?.('left')
      const skip = new Set([...sidecarDoubtKeys(vaultPaths), pathKey(staged)])
      blockedOnFailure(() => applyPendingRekey(vaultPaths, skip, undefined, onRefused))
      return
    }
    note?.('superseded')
    recoverPendingRekey(vaultPaths, descriptor, onRefused) // no longer in doubt: what the start would have done
    return
  }
  if (authentic) {
    // #1001: the sidecars in doubt are judged next. #1015: a swap this cannot finish answers "try again".
    blockedOnFailure(() => applyPendingRekey(vaultPaths, sidecarDoubtKeys(vaultPaths), undefined, onRefused))
    note?.('rolled-forward')
    return
  }
  try {
    rmSync(staged, { force: true })
  } catch {
    /* best-effort: see above */
    note?.('left')
    return
  }
  note?.('removed')
  recoverPendingRekey(vaultPaths, descriptor, onRefused) // R5: no longer in doubt, so what the start would have done
}

/**
 * #1027: does `.enc` authenticate under `dataKey` ({@link authenticatesUnder}, one more read, only for a staged database
 * in doubt that authenticates)? Gone (ENOENT) or a folder (EISDIR, ENOTDIR): no. A newer build's frame throws its
 * `VaultNewerError` (the unlock's format verdict refuses one first). Any other failure (a hold, an I/O error) proves
 * nothing either way, and `.enc` may be the newer copy: `VaultRecoveryBlockedError`, the #242 "try again", with nothing
 * written.
 */
function encOpensUnder(vaultPaths: VaultPaths, dataKey: Buffer): boolean {
  try {
    return authenticatesUnder(vaultPaths.encPath, dataKey)
  } catch (err) {
    if (isVaultNewerError(err)) throw err
    const code = (err as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return false
    throw new VaultRecoveryBlockedError(causeFailure(err).code)
  }
}

/** Is `path` proven gone? Only a stat that says ENOENT proves it (the #911 rule): `existsSync` reads any failure (a
 *  delete-pending file on Windows, EPERM, EBUSY, EIO) as "not there". */
function statSaysAbsent(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
  }
}

/**
 * #1001: the `documents/` and `images/` stages ({@link scannedSidecarStages}) that no rekey journal lists by their full
 * path, folded as {@link pathKey} folds it (no journal, one that cannot be read, or one that names other files or
 * another drive root, as {@link stageInDoubt} reads it), beside a stored copy that is not proven gone
 * ({@link statSaysAbsent}). Swapped in with no key at hand, such a stage would shred that stored copy, often the only
 * copy of the document, and the file at the name may be a copy from another workspace, or a file planted there. A
 * legitimate one is rare: since #241 a password change lists every stage it writes, so it takes a change of a
 * build before 0.1.60 (which wrote no journal and never staged `images/`) cut short after its commit, or a journal of
 * #241 or later that cannot be read or names the files under another drive root. With the stored copy gone the stage
 * is no doubt: it is the only copy left (a swap cut short between its shred and its rename), and the start renames it
 * into place as before, the mirror of #973's "`.enc` gone".
 * #1014 round 4: "lists" means an entry {@link planRekeyJournal} admits, never the journal as written. With `documents/`
 * itself a junction to a folder elsewhere, the plan refuses an entry through it, but the scan still finds the stage there
 * (`readdir` follows the link); vouched for by the journal as written, it was no doubt, and the start shredded the stored
 * copy behind the link and renamed the stage over it. Round 4 made it a doubt for the unlock to judge under the data key.
 * T2.9 fix round (R2-3, owner 2026-11-24): the scan skips a linked `documents/` or `images/` folder altogether
 * ({@link storeFolderInside}), so no stage behind such a link is a doubt either: neither the start nor the unlock touches
 * it (round 4 kept the link in the scan so that a legitimate stage in a store a user keeps behind a link of their own
 * would still roll forward; only a v1 → v2 password change writes one, and no published release wrote a v1 descriptor).
 * An entry the plan cannot judge (a failed stat) vouches for nothing either.
 */
function sidecarStagesInDoubt(vaultPaths: VaultPaths): string[] {
  const listed = new Set(planRekeyJournal(vaultPaths, readRekeyJournal(vaultPaths)).staged.map(pathKey))
  return scannedSidecarStages(vaultPaths).filter(
    (staged) => !listed.has(pathKey(staged)) && !statSaysAbsent(staged.slice(0, -REKEY_SUFFIX.length))
  )
}

/** #1001: {@link sidecarStagesInDoubt} as the `skip` set of {@link applyPendingRekey}. */
function sidecarDoubtKeys(vaultPaths: VaultPaths): ReadonlySet<string> {
  return new Set(sidecarStagesInDoubt(vaultPaths).map(pathKey))
}

/** #1001: what the unlock did with the `documents/` and `images/` stages in doubt ({@link resolveSidecarStagesInDoubt}):
 *  how many it swapped in (they open under the data key and their stored copy does not), removed (they do not open, or
 *  are no frame of this build's, or their stored copy is current, or they are of another length), left as they were (a
 *  read, a delete or a swap that failed; judged again at the next unlock), and set aside: the stage could not be moved
 *  in and the stored copy not moved back, so it waits at `<stored copy>.tmp` until the next start shreds it and renames
 *  the stage into place. Counts only: no path, no file name. */
export interface SidecarStageOutcome {
  rolledForward: number
  removed: number
  left: number
  setAside: number
}

/**
 * #1001: the unlock's answer to {@link sidecarStagesInDoubt}, once the password verified, the v2 data key is unwrapped
 * and the staged database is decided ({@link resolveStageInDoubt}). Each stage is judged on its own
 * ({@link judgeSidecarStage}): swapped in only when it opens under the data key and its stored copy does not (a v1 → v2
 * password change cut short after its commit left that copy under the retired key); removed when it does not open, is
 * no frame of this build's (owner decision D-2, the same plain delete as #973's), or cannot be a new copy of that
 * document; nothing when it is gone since the scan; left as it is when a read, a delete or a swap fails (owner decision
 * D-1), and judged again at the next unlock. (A folder at the name is no stage: {@link scannedSidecarStages}.)
 * Unlike the staged database, whose answer decides which snapshot the session opens (so a read it cannot make refuses
 * the unlock), a stored copy is written once and read only for its own document: a stage left loses nothing, and one
 * file is never worth locking the user out of the whole workspace. A frame a newer build wrote at the stage throws its
 * `VaultNewerError` (the unlock's format verdict refuses one before this runs). `note` hears the counts when the pass
 * ends, also when it throws, for the IPC's one log line. The pass is timed as `vault_sidecar_stage_check`.
 */
function resolveSidecarStagesInDoubt(
  vaultPaths: VaultPaths,
  dataKey: Buffer,
  note?: (outcome: SidecarStageOutcome) => void
): void {
  const doubtful = sidecarStagesInDoubt(vaultPaths)
  if (doubtful.length === 0) return
  const outcome: SidecarStageOutcome = { rolledForward: 0, removed: 0, left: 0, setAside: 0 }
  const checkT0 = performance.now()
  let stageBytes = 0
  try {
    for (const staged of doubtful) {
      stageBytes += fileSizeOrNull(staged) ?? 0
      try {
        const verdict = judgeSidecarStage(staged, staged.slice(0, -REKEY_SUFFIX.length), dataKey)
        if (verdict !== null) outcome[verdict] += 1
      } catch (err) {
        if (isVaultNewerError(err)) throw err
        outcome.left += 1 // a read, a delete or a swap that failed: judged again at the next unlock
      }
    }
  } finally {
    perfMark('vault_sidecar_stage_check', { files: doubtful.length, stageBytes, checkMs: perfMs(checkT0) })
    note?.(outcome)
  }
}

/**
 * #1001 (review rounds 1 to 3): one stage in doubt, beside its stored copy `target`, cheapest checks first.
 *   1. Two `lstat` calls, which never follow a link, and no read of either file yet:
 *      - the stage gone since the scan: nothing (`null`);
 *      - either one no regular file (a symbolic link, a junction or another reparse point, a folder): `left`. A swap
 *        would shred the old copy THROUGH a link at the stored copy's name, into a file outside the workspace;
 *      - the stage with more than one link (where the filesystem counts them: a hard link of the stored copy itself or
 *        of another document's copy), or of another length than the stored copy (a password change re-encrypts the
 *        same plaintext, and a frame is its plaintext's length plus a fixed header): no new copy of that document, so
 *        only the staged name is removed (`removed`). A planted file of another length therefore costs a stat, never a
 *        read.
 *   2. The stage, read under the data key ({@link authenticatesUnder}): it fails its tag or is no frame of this
 *      build's: removed. A read that fails throws to the caller (`left`); ENOENT is `null`.
 *   3. The stored copy, read under the data key. A legitimate pending stage only ever sits beside a stored copy under
 *      the RETIRED key: only a v1 → v2 password change stages copies (a v2 change re-wraps the data key and writes no
 *      file), and its commit leaves the stored copies under the v1 key until each swap. A stored copy that opens is
 *      current, and the stage at most a second copy (another document of this workspace copied to the name; a hard
 *      link on a mount that counts no links): removed. One that cannot be read: `left`. One that fails its tag or is
 *      no frame: the swap, unless another name shares its file (more than one link): `left`, so the shred of the old
 *      copy never reaches that other name.
 *   4. The swap never destroys the stored copy before the stage is in its place: the stored copy moves aside to
 *      `<target>.tmp` (a stale file there is shredded first), the stage is renamed into place, and only then is the old
 *      copy shredded. A rename of the stage that fails (a hold that refuses a delete: an antivirus, an indexer) moves
 *      the stored copy back and rethrows, so the caller counts `left` and the stage stays a doubt. When the move back
 *      fails too, the stored copy stays at `<target>.tmp` for this session (`setAside`): the next start's sweep shreds
 *      it, and that start renames the stage into place (its stored copy is gone, so it is no doubt). Nothing is lost:
 *      the stage authenticates, and the copy set aside opened under no key this workspace holds. `<target>.tmp` is a
 *      name the start's sweep shreds ({@link shredStalePlaintext}), and no writer uses it during an unlock
 *      (`encryptFileAsync` writes `<new copy>.tmp` only for a new id, with the workspace unlocked), so a crash between
 *      two steps leaves nothing the start does not resolve: with the stored copy aside and the stage not yet renamed,
 *      the start shreds the aside copy and renames the stage into place; with the stage in place, it shreds the aside
 *      copy.
 */
function judgeSidecarStage(staged: string, target: string, dataKey: Buffer): keyof SidecarStageOutcome | null {
  let stage: BigIntStats
  try {
    stage = lstatSync(staged, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null // gone since the scan
    throw err
  }
  const stored = lstatSync(target, { bigint: true })
  if (!stage.isFile() || !stored.isFile()) return 'left'
  if (stage.nlink > 1n || stage.size !== stored.size) {
    rmSync(staged, { force: true })
    return 'removed'
  }
  let authentic: boolean
  try {
    authentic = authenticatesUnder(staged, dataKey)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null // gone since the scan
    throw err
  }
  if (!authentic) {
    rmSync(staged, { force: true })
    return 'removed'
  }
  let current: boolean
  try {
    current = authenticatesUnder(target, dataKey)
  } catch {
    return 'left' // the stored copy cannot be judged: never swapped over
  }
  if (current) {
    rmSync(staged, { force: true })
    return 'removed'
  }
  if (stored.nlink > 1n) return 'left' // another name shares the stored copy's file: never shredded through it
  const aside = `${target}.tmp`
  shredFile(aside)
  renameSync(target, aside)
  try {
    renameSync(staged, target)
  } catch (err) {
    try {
      renameSync(aside, target) // the stored copy back
    } catch {
      return 'setAside' // it waits at `<target>.tmp`; the next start puts the stage in its place (see above)
    }
    throw err
  }
  shredFile(aside)
  return 'rolledForward'
}

/**
 * #973 (narrow): a create cut short before its commit (a crash or power loss between its stage and its key file) leaves
 * a `.enc.new` with no key file, no `.enc` and no rekey journal beside it. The start reports that state as
 * `uninitialized`, and the next create overwrites the file anyway. Removed here with its write temp, so a workspace put
 * back into the same folder later can meet it under neither this build's start nor an older build's, which rolls any
 * `.enc.new` forward under a v2 descriptor. Each of the three is proven absent by a stat that says ENOENT. Best-effort:
 * a file that stays is overwritten by the next create, and the unlock checks it ({@link resolveStageInDoubt}) if a
 * workspace comes back first. Nothing else is touched.
 * Residual (review round 2 R3, owner decision: the discard stays): the same state is left by a create that committed
 * and then lost its key file before the rename, and that stage only ever holds the fresh, empty workspace the create
 * built. The one double fault that loses data: a v1 → v2 password change by a build before #241 (a build before 0.1.60:
 * v0.1.6–v0.1.59, the public ones 0.1.50–0.1.59, which wrote no journal) cut short between the shred of `.enc` and the
 * rename of its stage, and then the key file removed before the next start: the stage was the only copy of that
 * workspace.
 */
function discardOrphanedStage(vaultPaths: VaultPaths): void {
  // T2.16 fix round 2 (S-6): not behind a workspace folder that is a link to a folder elsewhere (R2 B2's test,
  // {@link folderAtItsName}): the two names lie in the folder it reaches, and the file of that name there was removed.
  if (folderAtItsName(workspaceDirOf(vaultPaths)) === 'outside') return
  if (
    !statSaysAbsent(vaultPaths.descriptorPath) ||
    !statSaysAbsent(vaultPaths.encPath) ||
    !statSaysAbsent(rekeyJournalPath(vaultPaths))
  ) {
    return
  }
  const staged = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  for (const leftover of [staged, `${staged}.tmp`]) {
    try {
      rmSync(leftover, { force: true })
    } catch {
      /* best-effort: see above */
    }
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
  /** T2.2: `onStampFailed` hears the content-free code when the new database's `last_writer` stamp was not written. */
  opts: { legacyV1?: boolean; onStampFailed?: (code: string) => void } = {}
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
  // retries. The crash leaves the staged file behind (#973, the crash variant of #954's
  // S-1): the next start removes it (`discardOrphanedStage`: no key file, no `.enc`, no
  // journal), and one a workspace put back first meets is never rolled over that `.enc`
  // unchecked: the start leaves it (`stageInDoubt`), and the unlock keeps it only when it
  // authenticates under the put-back workspace's data key (`resolveStageInDoubt`). A crash
  // AFTER the commit is the committed-rekey crash state with `.enc` absent:
  // `recoverPendingRekey` rolls the staged file forward on the next init()/unlock. The
  // descriptor used to be written FIRST — a crash mid-create then
  // bricked onboarding behind the misleading "restore workspace.json" hint (the actual
  // repair was deleting it). NB the `legacyV1` fixture path shares this ordering but not
  // the roll-forward (recovery is v2-gated); it exists only so tests can build migration
  // fixtures — the app never passes it.
  //
  // #954 S-1: a create that FAILS before the commit (the descriptor's temp cannot be written
  // or renamed, a full drive, the re-check below) removes what it staged before it rethrows:
  // `.enc.new` is ciphertext under a key nothing holds, and every build before #973 rolls ANY
  // `.enc.new` forward under a v2 descriptor at its start, so a workspace put back later into
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
  /** T2.7 re-check 1 (N-1): the open below makes the database files itself (none of the three names held anything), so
   *  they are this create's own: a failure before the commit shreds them (seeded settings only), and a retry finds no
   *  leftover of this create's to set aside. A database the create adopts (a dev build's) is never removed. */
  let ownDatabase = false
  try {
    // T2.7 security fix round (F-2): SQLite opens the three names below and writes through a link at any of them
    // ({@link createMayOpenDatabase}); with one there the create is refused before anything is written.
    if (!createMayOpenDatabase(vaultPaths.dbPath)) {
      throw new Error('A workspace database file is a link or has a second name; nothing was created')
    }
    ownDatabase = ['', '-wal', '-shm'].every((tail) => lstatOrAbsent(`${vaultPaths.dbPath}${tail}`) === null)
    // #247: a leftover plaintext file at `dbPath` stamped by a NEWER build makes this open
    // throw (handled: the create IPC reports `workspace_newer`) — the key is zeroed either way.
    // T2.7 (L-4): any other failure of the open or of its first writes is thrown as the unlock's open throws one, a
    // `VaultOpenFailedError` that keeps the kind and codes only: SQLite's message for a working file it found quotes that
    // file's schema, which W-68 keeps out of the log. The handle is closed on the way out.
    let db: Db | null = null
    try {
      db = openDatabase(vaultPaths.dbPath, { onStampFailed: opts.onStampFailed })
      seedSettings(db)
      updateSettings(db, { workspaceMode: 'encrypted' })
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      db.close()
      db = null
    } catch (err) {
      try {
        db?.close()
      } catch {
        /* the open's own failure is the one reported */
      }
      throw isWorkspaceNewerError(err) ? err : new VaultOpenFailedError(err)
    }
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
      // T2.7 re-check 1 (N-1): and its own fresh database (best-effort, as `shredFile` is; the open closed its handle).
      if (ownDatabase) {
        shredFile(vaultPaths.dbPath)
        cleanSidecars(vaultPaths.dbPath)
      }
    }
    throw err
  } finally {
    fileKey.fill(0)
  }
}

/**
 * T2.7 security fix round (F-2): may the create open its database at `dbPath`? SQLite opens the file, its `-wal` and its
 * `-shm` by their names and writes through a link at any of them ({@link replayMayWrite} for the start's replay): each
 * must be absent or a regular file no other name shares (`lstat`, never followed). Unlike the replay's test, the
 * workspace folder itself may be a link: the create, like the unlock, reads and writes through a workspace folder a user
 * keeps behind one (T2.16 R2 B2). The app never makes a link, so a working file it left always passes.
 */
function createMayOpenDatabase(dbPath: string): boolean {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every((path) => {
    const named = lstatOrNull(path)
    return named === null || shredNameOf(named).kind === 'file'
  })
}

/**
 * T2.7 security fix round (F-3; FU-P2-6 in P2): the suffix a create sets a leftover aside under, on a build that allows no
 * plaintext workspace ({@link setLeftoversAside}): `hilbertraum.sqlite.quarantine` with its `-wal`, `-shm` and `-journal`
 * as `hilbertraum.sqlite.quarantine-wal`, `-shm` and `-journal` (so they stay a set a person can open), and
 * `hilbertraum.sqlite.recovery.quarantine`; (re-check 1, N-1) then `.quarantine-<n>` (n from 1) while those are taken,
 * so nothing set aside is ever replaced. Chosen so that nothing reads, shreds or vouches for them: the start's sweep
 * removes exact names (the working file, its `.tmp`, `-wal` and `-shm`), the salvage reads the working file and
 * `.recovery` only, the stage scan and the rekey journal admit only `.enc.new` names, and the orphaned-stage removal only
 * `.enc.new` and its temps.
 */
export const QUARANTINE_SUFFIX = '.quarantine'

/**
 * T2.7 security fix round (F-3): a create on a build that allows no plaintext workspace never adopts what it finds. With
 * no key file and no `.enc`, a working file at `hilbertraum.sqlite` (and its `-wal` and `-shm`) was opened as the new
 * workspace, its settings kept, and the create's unlock rolled a `.recovery` forward over the new `.enc` when that copy's
 * time was later: a drive could so hand the user a database the app did not make (rows naming files to shred, settings)
 * under the user's new key. Each of those names that holds anything is moved, by its name (a link moves as the link), to
 * a {@link QUARANTINE_SUFFIX} name; none is opened. T2.7 re-check 1 (N-1; the owner: set-aside files are kept): never
 * over one set aside before. The working file with its `-wal`, `-shm` and `-journal` goes to the first suffix (`.quarantine`,
 * then `.quarantine-1` … `-64`, as {@link quarantineName} names the journal's) that is free for all four, and `.recovery` to
 * the first free `.recovery.quarantine[-<n>]`; free means an `lstat` that says ENOENT. With none free, or a move that
 * fails (a hold; the set's files moved before it are moved back first), it throws, and the create fails with nothing of
 * its own written. A newer build's copy never gets here:
 * the create refuses it first (#985).
 */
function setLeftoversAside(vaultPaths: VaultPaths): void {
  const db = vaultPaths.dbPath
  const present = (path: string): boolean => lstatOrAbsent(path) !== null
  /** The first `<base>.quarantine[-<n>]` at which every one of `tails` is free. */
  const freeAside = (base: string, tails: readonly string[]): string => {
    for (let n = 0; n <= QUARANTINE_NAMES; n++) {
      const aside = `${base}${QUARANTINE_SUFFIX}${n === 0 ? '' : `-${n}`}`
      if (tails.every((tail) => !present(`${aside}${tail}`))) return aside
    }
    throw new Error('No free name to set a leftover workspace file aside; nothing was created')
  }
  // T2.D round 3 (S-b): and a rollback journal (`-journal`, a later version's session in a rollback mode), which keeps
  // the set together: left behind, SQLite deleted it unshredded when the create opened its new database at the name.
  const sqliteTails = ['', '-wal', '-shm', '-journal']
  if (sqliteTails.some((tail) => present(`${db}${tail}`))) {
    const aside = freeAside(db, sqliteTails)
    // P2 exit (CR-1): the side files first and the working file last, and a move that fails (a hold) first moves back
    // what this call moved, so the set is never split. It was: the working file at `.quarantine`, a held `-wal` left
    // behind, and the retry, finding `.quarantine` taken, moved that `-wal` to `.quarantine-1-wal`. A move back that
    // fails too leaves that file aside (kept, never removed); the hold's error is thrown either way.
    const moved: string[] = []
    try {
      for (const tail of ['-wal', '-shm', '-journal', '']) {
        if (!present(`${db}${tail}`)) continue
        renameSync(`${db}${tail}`, `${aside}${tail}`)
        moved.push(tail)
      }
    } catch (err) {
      for (const tail of moved.reverse()) {
        try {
          if (!present(`${db}${tail}`)) renameSync(`${aside}${tail}`, `${db}${tail}`)
        } catch {
          // Left aside, never removed.
        }
      }
      throw err
    }
  }
  const recovery = `${db}${RECOVERY_SUFFIX}`
  if (present(recovery)) renameSync(recovery, freeAside(recovery, ['']))
}

/** #985: the probe of the `.recovery` copy, or null when there is none. */
function probeRecoveryCopy(vaultPaths: VaultPaths): DatabaseFileProbe | null {
  const recoveryPath = `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`
  return existsSync(recoveryPath) ? probeDatabaseFile(recoveryPath) : null
}

/**
 * #985 (review round 2 R6): may the `.recovery` copy hold fresher data than `.enc`? Not when `.enc` is there and strictly
 * newer by mtime: that is a spent leftover, as the CODE-1b roll-forward judges one. Yes in every other case (`.enc`
 * missing or not judged, the copy as new or newer, its own age unreadable): any doubt keeps the copy.
 */
function recoveryMayBeFreshest(vaultPaths: VaultPaths): boolean {
  const enc = statEncryptedFile(vaultPaths)
  if (enc.state !== 'present') return true
  try {
    return statSync(`${vaultPaths.dbPath}${RECOVERY_SUFFIX}`).mtimeMs >= enc.mtimeMs
  } catch {
    return true
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
  /** #985 (review round 3 F3): a `.recovery` copy a newer build stamped, older than `.enc` (a spent leftover), was left
   *  in place, unencrypted. */
  newerRecoveryLeft: boolean
}

/**
 * Unlock an encrypted vault: derive the key, verify the password against the descriptor
 * (no DB access), unwrap the data key on a v2 descriptor, decrypt `.enc` → working file,
 * and open the database. Throws `WrongPasswordError` on a bad password (the GCM verifier
 * fails, the DB is never touched). Before the password is even checked: `VaultNewerError` when a
 * vault artifact is in a format a newer build wrote (#845). After the password verified:
 * `VaultRecoveryBlockedError` (#242), `WorkspaceNewerError` (#247; #985: also for a `.recovery` copy a newer build
 * stamped that may hold the freshest data, before the staged-file check, the roll-forward or any shred; T2.9 R1-1: and
 * for a decrypted database SQLite cannot open whose header stamp is above this build's), `VaultDamagedError` when `.enc`
 * fails its tag (#860 V5b) or SQLite finds no database or a corrupt one (#208),
 * `VaultOpenFailedError` when the open could not finish otherwise (#844), and `VaultMissingError` when there is no `.enc`
 * and no `.recovery` copy to roll forward over it (#911).
 */
export function unlockEncryptedVault(
  vaultPaths: VaultPaths,
  password: string,
  onProbeFallback?: ProbeFallbackNote,
  /** #973: hears what this unlock did with a staged database in doubt, as soon as it did it (also when a later step
   *  fails). */
  onStageInDoubt?: (outcome: StageInDoubtOutcome) => void,
  /** #1001: hears what this unlock did with the `documents/` and `images/` stages in doubt, once it judged them (also
   *  when a later step fails). */
  onSidecarStages?: (outcome: SidecarStageOutcome) => void,
  /** #1014: hears what this unlock's passes left as they are. Round 4: the recovery before the password too (it counted
   *  nothing, so an entry it refused in a journal that turned up after the start was dropped with no trace), and the
   *  passes once it holds the data key. */
  onJournalRefusals?: (refused: number) => void,
  /** T2.2 (W-9): hears the content-free code when the open's `last_writer` stamp was not written. The unlock goes on:
   *  a stamp never reaches `openFailure`. */
  onStampFailed?: (code: string) => void
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
  // decides whether staged `.new` files roll forward (committed) or are discarded. #973: a staged
  // database it cannot vouch for waits for the data key below, so a wrong password leaves it as it is;
  // #1001: so does a staged document or image copy it cannot vouch for. #1014 round 4: what it leaves is counted.
  // T2.16 fix round 2 (S-1; the owner's B2 decision, 2026-11-24, applied to the unlock): not behind a workspace folder
  // that is a link to a folder elsewhere ({@link folderAtItsName}), as the start skips it there. This pass runs before
  // the password check, so any password typed into the lock screen, a wrong one included, had the journal shred and
  // replace files behind the link after all. What a password change cut short left there waits (the owner accepted that
  // a linked workspace folder loses the start's tidy-up and this recovery); the unlock's own reads and writes go on.
  if (folderAtItsName(workspaceDirOf(vaultPaths)) !== 'outside') recoverPendingRekey(vaultPaths, descriptor, onJournalRefusals)
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
  // #985 (W-66; review round 2 R6, R7): a `.recovery` copy a NEWER build stamped is judged now, after the password
  // verified and before anything below can write (the staged-file check, the roll-forward, a shred). One that may hold
  // the freshest data refuses the unlock, as the open refuses a newer database (#247); one older than a present `.enc`
  // is a spent leftover, left as it is by the roll-forward below. The probe is kept for that block.
  const recoveryProbe = probeRecoveryCopy(vaultPaths)
  if (recoveryProbe?.verdict === 'newer' && recoveryMayBeFreshest(vaultPaths)) {
    key.fill(0)
    throw new WorkspaceNewerError(recoveryProbe.found)
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
      // #973: a staged `.enc.new` no journal vouches for, which the rekey recovery above left as it was: rolled
      // forward when it authenticates under the data key, removed when it does not (or is no frame of this build's),
      // refused as "try again" when a hold keeps it from being read, left when it can be neither read nor removed.
      // Before the `.recovery` block, so that block judges the `.enc` this unlock opens.
      resolveStageInDoubt(vaultPaths, descriptor, fileKey, onStageInDoubt, onJournalRefusals)
      // #1001: then each staged document or image copy no journal vouches for, beside a stored copy that is there:
      // swapped in when it authenticates under the data key, removed when it does not (or is no frame of this build's),
      // left when it can be neither read nor swapped in or removed (judged again at the next unlock).
      resolveSidecarStagesInDoubt(vaultPaths, fileKey, onSidecarStages)
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
    let newerRecoveryLeft = false
    /** F-27 review 1 M-2: this unlock encrypted the `.recovery` copy over `.enc`, so the copy decrypted below is it. */
    let rolledForward = false
    // #911 (code review): `.enc` is judged ONCE, by the start's rule: only ENOENT is missing. `existsSync` read any other
    // stat failure (a delete-pending file on Windows, EPERM, EBUSY) as "missing", so a spent `.recovery` could be
    // encrypted over a good `.enc`.
    const enc = statEncryptedFile(vaultPaths)
    let encMissing = enc.state === 'missing'
    if (existsSync(recoveryPath)) {
      // #911: an `.enc` that cannot be judged is doubt, as at the start (#242): never roll forward over it, and never
      // shred a copy that may be the freshest data. Refuse; the next unlock retries.
      if (enc.state === 'unknown') throw new VaultRecoveryBlockedError(enc.code) // round 5: with the stat's code
      // full-audit 2026-07-12 REL-2 — the freshness PROBE is exception-guarded: a Windows
      // AV/indexer hold without FILE_SHARE_READ (or the file vanishing between existsSync and
      // openSync) throws EBUSY/EPERM/ENOENT here, which used to fail the whole unlock raw
      // (generic openFailed) until the hold cleared. Only the probe is wrapped: a roll-forward
      // encryptFile failure (e.g. disk still full) keeps failing the unlock so the snapshot
      // survives untouched.
      let fresher: boolean | null = null
      try {
        // A probe that cannot decide (a hold, the file vanishing) is the probe error handled below.
        const probe = recoveryProbe ?? probeDatabaseFile(recoveryPath)
        if (probe.verdict === 'unknown' || probe.verdict === 'gone') {
          throw new Error(`The .recovery probe could not decide (${probe.verdict})`)
        }
        // #985 (W-66): this unlock never rolls forward or shreds a copy a NEWER build stamped: it cannot judge its
        // schema. One that may be the freshest data was refused before the key was used (above); one that gets here
        // is a spent leftover older than `.enc` (review round 2 R6), kept as it is, and the unlock goes on. It stays the
        // workspace's data unencrypted until a later failed lock's salvage replaces it (REL-1's pre-shred) or a newer
        // build's unlock shreds it as spent (review round 3 F3), so the IPC logs that it was left.
        const spentNewer = probe.verdict === 'newer'
        newerRecoveryLeft = spentNewer
        const newer =
          !spentNewer &&
          probe.verdict !== 'not-database' &&
          (enc.state === 'missing' || statSync(recoveryPath).mtimeMs > enc.mtimeMs)
        // A structure SQLite cannot read for a reason that is not damage: judged by the header, as
        // before (#876 review round 2).
        fresher = spentNewer ? null : readsAsDatabase(probe, 'recovery', onProbeFallback) && newer
        // #875: our own shred never leaves a header, so a newer copy whose header reads but whose
        // structure does not was the failed lock's session, and shredding it loses that session.
        recoveryDiscarded = probe.verdict === 'damaged' && newer
      } catch (err) {
        // #242 — a probe error means we cannot read the header. If `.recovery` could still be
        // the fresh failed-lock delta — newer than `.enc`, `.enc` missing, or the mtime
        // unreadable too — we must NOT unlock into the stale `.enc` and leave the snapshot to
        // be shredded once a later lock makes `.enc` newer: refuse exactly as the init()
        // salvage does, and let the next unlock retry once the hold clears. Only when `.enc`
        // is demonstrably newer (a spent leftover) is it safe to proceed and unlock normally.
        // Round 5 (review V7-5): the refusal carries a failed stat's code; the probe's "could not decide" has none.
        let code = causeFailure(err).code
        let encStrictlyNewer = false
        try {
          encStrictlyNewer = enc.state === 'present' && enc.mtimeMs > statSync(recoveryPath).mtimeMs
        } catch (statErr) {
          /* even the stat failed → treat as possibly fresh → refuse */
          if (code === null) code = causeFailure(statErr).code
        }
        if (!encStrictlyNewer) throw new VaultRecoveryBlockedError(code)
        /* `.enc` newer → spent leftover → leave it in place, unlock normally */
      }
      if (fresher !== null) {
        if (fresher) {
          // #911: over a missing `.enc` this is the only copy of the workspace (the start kept it, or a failed lock's
          // copy outlived the `.enc` it was newer than), for the IPC's log line.
          restoredMissingEnc = encMissing
          encryptFile(recoveryPath, vaultPaths.encPath, fileKey)
          encMissing = false
          rolledForward = true
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
    // F-27 review 1 M-2: and a rollback journal, which SQLite plays back into the file at the open's first read just the
    // same. Every build runs the workspace database in WAL mode (since before v0.1.50), so a hot
    // `hilbertraum.sqlite-journal` is a session's that ended mid-transaction in a rollback mode, a later version's: it
    // holds pages of the working file that session wrote, which the start swept or kept as `.recovery`, never of the
    // `.enc` decrypted below, and played into that copy it mixes the two or reads as damage on an intact `.enc`. Except
    // after a roll-forward: the copy decrypted below is then that kept working file, whose journal stays for SQLite to
    // play back, as before. Not in the start's sweep, which would take it from a working file kept as `.recovery`.
    if (!rolledForward) shredFile(`${vaultPaths.dbPath}-journal`)
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
      db = openDatabase(vaultPaths.dbPath, { onStampFailed })
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
      // forward first, so nothing is lost) and the IPC layer names the remedy: install the newer version.
      // #844: damage only when SQLite says so. Any other failure of the open or of the unlock's
      // own settings writes is a step that could not finish on a database that is fine, and the
      // open does not rewrite `.enc`: not "restore a backup". T2.9 (R1-1): and not when the
      // file's header says a newer build wrote it, whatever SQLite made of it.
      throw openFailure(err, vaultPaths.dbPath)
    }
    // #1014: the out-of-store stages the start left for the database, which lists their stored copies. Best-effort: one
    // it cannot finish waits for the next unlock, and the unlock goes on.
    try {
      finishOutOfStoreStages(vaultPaths, descriptor, db, fileKey, onJournalRefusals)
    } catch {
      /* the journal stays: the next unlock tries again */
    }
    if (recoveryDiscarded) shredFile(recoveryPath)
    return { db, key: fileKey, descriptor, recoveryDiscarded, restoredMissingEnc, newerRecoveryLeft }
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
 * fallback is reported. #985: so does `newer`, a file a newer build stamped: the salvage keeps it (`preserved`,
 * `kept-only-copy`), and the lock and the rekey stage encrypt it as before (the session's own file cannot be newer:
 * `openDatabase` refuses one). The unlock's `.recovery` roll-forward refuses it before it gets here. Everything else
 * does not.
 */
function readsAsDatabase(probe: DatabaseFileProbe, site: ProbeFallbackSite, onProbeFallback?: ProbeFallbackNote): boolean {
  if (probe.verdict === 'unchecked') {
    onProbeFallback?.(site, probe.code ?? 'unknown')
    return true
  }
  return probe.verdict === 'database' || probe.verdict === 'newer'
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
  onProbeFallback?: ProbeFallbackNote,
  /** #982: the overwrite's deadline (the Linux `quit` leg only); without one the working file is shredded as always. */
  budget?: LockBudget
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
  const budgetEncryptT0 = budget?.now() ?? 0
  try {
    encryptFileImpl(vaultPaths.dbPath, vaultPaths.encPath, key)
  } catch (err) {
    throw new LockStoppedError('encrypt', verdict, 'The lock could not re-encrypt the working file', { cause: err })
  }
  const encryptMs = perfMs(encryptT0)
  const shredT0 = performance.now()
  // #982: on the Linux `quit` leg the overwrite stops at its deadline (`shredFileWithin`) and the file is unlinked; the
  // `.enc` above is already complete and durable. Its first chunk is judged by the rate this encrypt ran at, on the
  // budget's clock. Every other lock overwrites the whole file, as before.
  const msPerByte = budget && dbBytes ? (budget.now() - budgetEncryptT0) / dbBytes : 0
  const shred = budget ? shredFileWithin(vaultPaths.dbPath, budget, msPerByte) : null
  if (!budget) shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
  // Covers BOTH lock paths (the explicit lock IPC and the quit teardown); the mark is an
  // appendFileSync, so it lands before app.exit(). checkpointMs includes db.close().
  // #982: `overwrittenBytes` is the budgeted overwrite's count (null for the full `shredFile`, whose overwrite is
  // best-effort and silent), `shredCut` whether it stopped before the file's end.
  perfMark('vault_lock_done', {
    checkpointMs,
    probeMs,
    encryptMs,
    shredMs: perfMs(shredT0),
    dbBytes,
    overwrittenBytes: shred?.overwrittenBytes ?? null,
    shredCut: shred?.cut ?? false
  })
  if (shred?.cut) budget?.onShredCut?.()
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
   * #1015: also when the pending-rekey recovery could not finish a password change's swap (a held file, a folder at the
   * name); the steps after it wait, and the unlock re-runs them.
   */
  private _recoveryBlocked = false
  /** #1015: the file error code that blocked the rekey recovery (content-free, for the log), or null (#242's salvage). */
  private _recoveryBlockedCode: string | null = null
  /** #1014: how many rekey journal entries the recoveries refused since the last {@link takeJournalRefusals}. */
  private _journalRefusals = 0
  private readonly noteJournalRefusals = (refused: number): void => {
    this._journalRefusals += refused
  }
  private _newerWorkspace = false
  /** #845: what {@link init} found a newer build wrote (the vault format verdict), or null. While set, `init()` has
   *  written nothing, the workspace reports locked, and every unlock refuses with `VaultNewerError`. */
  private _vaultNewer: { what: VaultNewerWhat; found: string | number } | null = null
  /** Review V F-2: the last {@link init} ran its steps to their end (false before the first, after one that threw
   *  part-way, and, security review V S-1, after one that stopped at a newer-format verdict or a blocked salvage; and,
   *  follow-ups wave 7 S-1, after a {@link shutdown} whose lock failed, which leaves a working file newer than `.enc`).
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
  /** #973: what the last unlock did with a staged `.enc.new` in doubt, when it removed or left it (not when it rolled it
   *  forward), for the IPC to log once ({@link takeStageOutcome}), whether the unlock then succeeded or not. */
  private _stageOutcome: Exclude<StageInDoubtOutcome, 'rolled-forward'> | null = null
  /** #1001: what the last unlock did with the staged document and image copies in doubt (counts), for the IPC to log
   *  once ({@link takeSidecarStageOutcome}), whether the unlock then succeeded or not. */
  private _sidecarStageOutcome: SidecarStageOutcome | null = null
  private readonly noteSidecarStages = (outcome: SidecarStageOutcome): void => {
    this._sidecarStageOutcome = outcome
  }
  /**
   * #973 (review round 2 R2): a loss {@link init} judged (it then shredded that session) while a staged database was in
   * doubt. The recovery swapped nothing, so the unlock decides which snapshot opens: held here, not marked, until it
   * does ({@link noteStageInDoubt}). In memory only: a restart before that unlock forgets it.
   */
  private _heldStageLoss: { cause: MarkedLossCause; enc: string | null } | null = null
  /** #973: told by the unlock what it did with the staged database in doubt. `.enc` opens as it is (the stage removed
   *  or left): the held loss is the one it was judged against, recorded as the start would have. It rolled forward:
   *  the stage holds that session's copy, so no loss is proven, and the hold is dropped. */
  private readonly noteStageInDoubt = (outcome: StageInDoubtOutcome): void => {
    const held = this._heldStageLoss
    this._heldStageLoss = null
    this._stageLeftByUnlock = outcome === 'left'
    if (outcome === 'rolled-forward') return
    this._stageOutcome = outcome
    if (held !== null) this.markWorkingCopyLost(held.cause, held.enc)
  }
  /** #1027: the unlock under way left the staged database in doubt where it was (`left`), for {@link unlock}. */
  private _stageLeftByUnlock = false
  /**
   * #1027: a staged database that a password change of this session decided to retire and has not yet: `unlisted`, the
   * rekey journal no longer lists it; `encCurrent`, `.enc` is this session's, written under the current key after the
   * stage, so the stage may be deleted. Set by {@link supersedeDatabaseStage}, and by an unlock that decided to delete a
   * staged database and could not ({@link unlock}). Every lock retries ({@link retireStaleDatabaseStage}). In memory only:
   * what is left after the process ends is judged by the next unlock under the data key (#973, #1027).
   */
  private _staleDatabaseStage: { unlisted: boolean; encCurrent: boolean } | null = null
  /** #1027: the last password change could not move its staged database into place: the code of the swap pass's last
   *  error, and whether the change saved `.enc` itself, for the IPC's one log line ({@link takeDatabaseSwapFailure}). */
  private _databaseSwapFailure: { code: string | null; saved: boolean } | null = null
  /** #973 (review round 3 F2): a successful unlock settles a loss still held, because this unlock did not judge the stage
   *  (it was gone by then, or a journal now lists it). Recorded while `.enc` is still the snapshot it was judged against
   *  (the same frame IV), dropped otherwise (a roll-forward replaced `.enc`); never carried past this unlock, so a later
   *  stage cannot bring it back as a notice about a session that lost nothing. */
  private settleHeldStageLoss(): void {
    const held = this._heldStageLoss
    this._heldStageLoss = null
    if (held !== null && (held.enc === null || frameIvOf(this.vaultPaths.encPath) === held.enc)) {
      this.markWorkingCopyLost(held.cause, held.enc)
    }
  }
  /** #911: the disk state behind {@link _encMissingKept}: `.enc` absent (ENOENT) and a `.recovery` copy waiting that
   *  starts like a database (the #892 header read, 100 bytes: cheap, and read only at {@link init} and after a failed
   *  unlock, never per {@link getState}). One that does not is no copy to keep: the unlock shreds it and says the file
   *  is missing, so no notice promises it; one whose header cannot be read shows none either (code review). */
  private encMissingKeptOnDisk(): boolean {
    if (encryptedFileState(this.vaultPaths) !== 'missing') return false
    try {
      const kept = `${this.vaultPaths.dbPath}${RECOVERY_SUFFIX}`
      // #985 (review round 2 R8): a copy a newer build stamped is not one this unlock encrypts again: it answers
      // `workspace_newer` ("last used with a newer version of HilbertRaum") instead, so no notice promises it.
      return startsLikeDatabase(kept) && headerSchemaStamp(kept) <= SCHEMA_VERSION
    } catch {
      return false // absent, or unreadable
    }
  }
  /** #911: this start found the only copy with `.enc` missing and its structure damaged, and swept it
   *  ({@link discardedOnlyCopy}). */
  private _discardedOnlyCopy = false
  /** T2.16 (R2 B2): the folders the last {@link init} found to be links to a folder elsewhere ({@link linkedStartFolders}). */
  private _linkedStartFolders: Array<'workspace' | 'logs' | 'config'> = []
  /** #985 (review round 3 F3): the last successful unlock left a spent `.recovery` a newer build stamped in place, for the
   *  IPC to log once ({@link takeNewerRecoveryLeft}). */
  private _newerRecoveryLeft = false
  /** #875: what the last successful unlock consumed, for the IPC to record once ({@link takeWorkingCopyLost}). */
  private _lostAtPreviousLock: { cause: WorkingCopyLossCause; lostAt: string | null } | null = null
  /** #876 review round 2: sites that judged a file by its header because the probe could not read its structure (not
   *  damage), for the IPC to log ({@link takeProbeFallbacks}). Bounded. */
  private _probeFallbacks: Array<{ site: ProbeFallbackSite; code: string }> = []
  private readonly noteProbeFallback: ProbeFallbackNote = (site, code) => {
    if (this._probeFallbacks.length < 20) this._probeFallbacks.push({ site, code })
  }
  /** T2.2 (W-9): the content-free codes of the `last_writer` stamps an open could not write, for the log
   *  ({@link takeStampFailures}). Bounded. */
  private _stampFailures: string[] = []
  /** T2.2 fix round (review 2, major 1): this session's open could not write the stamp for a reason a retry may get past
   *  (not an unset version), so the lock tries once more ({@link retryStampOnce}). Cleared when a session opens. */
  private _stampPending = false
  private readonly noteStampFailed = (code: string): void => {
    if (this._stampFailures.length < 20) this._stampFailures.push(code)
    if (code !== STAMP_NO_APP_VERSION) this._stampPending = true
  }
  /**
   * T2.2 fix round (review 2, major 1): a stamp the open could not write leaves the last writer's value standing while
   * this session writes, and a later build would read it as "no older version wrote since". So, once, before the lock
   * re-encrypts (Lock now and the exit lock) and before the exit closes a plaintext workspace, the stamp is tried again on
   * the open handle. Best effort like the open's: a retry that fails too is one more code for the log, never a failed lock.
   */
  private retryStampOnce(): void {
    if (!this._stampPending || this._db === null) return
    this._stampPending = false
    stampLastWriter(this._db, { onStampFailed: this.noteStampFailed })
    this._stampPending = false // once per open: a retry that failed again is logged, not repeated
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

  /** True while the startup salvage is blocked by a held `.recovery` (#242), or the rekey recovery by a swap it could not
   *  make (#1015) — see {@link _recoveryBlocked}. */
  isRecoveryBlocked(): boolean {
    return this._recoveryBlocked
  }

  /** #1015: while {@link isRecoveryBlocked}, the file error code that blocked the rekey recovery (content-free), or null
   *  (the salvage, #242, or no code). For `main/index.ts`'s one log line. */
  recoveryBlockedCode(): string | null {
    return this._recoveryBlocked ? this._recoveryBlockedCode : null
  }

  /** #1014: what the recovery passes left as they are since the last call: the rekey journal entries they refused
   *  (outside the workspace or through a link and not listed by the open database, or not a stage or the rotated log),
   *  round 5, the listed out-of-store stages the unlock leaves (one that does not open under the data key, one it may
   *  not judge yet) and, round 3, the folders they left in place (at a write temp's name, at a stored copy's name). A
   *  pass counts once it has settled the journal, and a refused entry is dropped from it then, so it is counted once
   *  (review R5, round 3); a folder is counted by each pass that meets it, and so, round 4, is an entry a failed stat
   *  left unjudged, and, round 5, a stage the unlock keeps unsettled (the journal keeps both). Round 4: the unlock's
   *  recovery before the password and a password change's passes count too; nothing
   *  logs right after a change, so its count goes with the next unlock's line. Returns the sum once, for one
   *  content-free log line (no path, no file name). */
  takeJournalRefusals(): number {
    const refused = this._journalRefusals
    this._journalRefusals = 0
    return refused
  }

  /** #876 review round 2: the sites that judged a file by its SQLite header since the last call, because the probe could
   *  not read its structure for a reason that is not damage (site + content-free code). Returns them once, for the IPC
   *  to log; a quit's notes go with the process. */
  takeProbeFallbacks(): Array<{ site: ProbeFallbackSite; code: string }> {
    const notes = this._probeFallbacks
    this._probeFallbacks = []
    return notes
  }

  /** T2.2 (W-9): the codes of the `last_writer` stamps the opens since the last call could not write (SQLite's result
   *  code and fixed description, a Node error code, `no-app-version` or `stamp-ignored`; never a message, a path or a
   *  value). The lock's one retry adds its own code when it fails too. The open
   *  went on each time (the stamp is best effort). Returns them once, for one log line each. */
  takeStampFailures(): string[] {
    const notes = this._stampFailures
    this._stampFailures = []
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
    this._stampPending = false // T2.2: this open decides whether the exit retries the stamp
    const db = openDatabase(this.vaultPaths.dbPath, { onStampFailed: this.noteStampFailed })
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
    // workspace as it is. It stays locked, the create flow is refused, and every unlock answers `workspace_newer`
    // ("install the newer version").
    // Every per-start flag is re-decided from the disk first: unlock() re-runs init(), and a flag a previous run set
    // (a blocked salvage, #242) must not outlive it, or it would answer instead of the newer format (W2 review 2).
    this._recoveryBlocked = false
    this._recoveryBlockedCode = null
    this._newerWorkspace = false
    this._encMissingKept = false
    this._discardedOnlyCopy = false
    this._linkedStartFolders = []
    if (this.readFormat()) return
    if (this.descriptor?.mode === 'encrypted') {
      // T2.16 fix round (R2 B2, owner 2026-11-24: fix): the workspace folder itself, or the logs folder, a link to a
      // folder elsewhere (any junction, a symbolic link: {@link folderAtItsName}). Every test below measured from the
      // folder behind such a link, so all of it read as "inside": the sweep shredded `*.tmp` and `*.parse*` files there,
      // the stage scan and the rekey journal had files there shredded and replaced, and the rotated log of that name was
      // deleted. Behind a linked workspace folder the start now runs no sweep and no rekey recovery (which holds the
      // stage scan and the rotated log's removal); behind a linked logs folder the log is not removed
      // ({@link removeRotatedLog}). Both are noted for the log ({@link linkedStartFolders}). The salvage still runs (it
      // keeps a failed lock's newer copy from the unlock, which reads and writes through the link as before), but its
      // #911 replay does not ({@link replayMayWrite}). A stat that proves nothing reads as before (#1014's rule). Round 2:
      // the unlock's own rekey recovery, before its password check, is skipped there too ({@link unlockEncryptedVault}).
      const linkedWorkspace = folderAtItsName(workspaceDirOf(this.vaultPaths)) === 'outside'
      const logsPath = this.vaultPaths.logsPath
      if (linkedWorkspace) this._linkedStartFolders.push('workspace')
      if (logsPath && folderAtItsName(logsPath) === 'outside') this._linkedStartFolders.push('logs')
      // T2.7 (L-2): and `config/`, behind which the #875 marker is neither written nor removed ({@link configFolderLinked}).
      if (configFolderLinked(this.vaultPaths)) this._linkedStartFolders.push('config')
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
      this._discardedOnlyCopy = salvage === 'discarded-only-copy' && !linkedWorkspace
      if (this._recoveryBlocked) return // locked AND blocked; unlock() re-runs this salvage
      if (linkedWorkspace) {
        // T2.16 (R2 B2): no sweep, so no loss to record; the reads below are the unlock's own (`.enc`, the marker).
        this._encMissingKept = this.encMissingKeptOnDisk()
        this.adoptWorkingCopyLostMarker(frameIvOf(this.vaultPaths.encPath))
        return // locked; await unlock
      }
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
      // #1015: a swap it cannot make (a held file, a folder at the name) blocks the recovery, as #242's salvage does:
      // locked AND blocked, the steps below wait (the loss held above included), and unlock() re-runs them.
      try {
        recoverPendingRekey(this.vaultPaths, this.descriptor, this.noteJournalRefusals)
      } catch (err) {
        if (!(err instanceof VaultRecoveryBlockedError)) throw err
        this._recoveryBlocked = true
        this._recoveryBlockedCode = err.code
        return
      }
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
      // #973 (review round 2 R2): a staged database still in doubt means the recovery swapped nothing, and the unlock
      // decides which snapshot opens. The loss is proven only when that is `.enc` as it is, so it is held for the
      // unlock (`noteStageInDoubt`) instead of marked.
      const inDoubt = stageInDoubt(this.vaultPaths)
      const mark = (cause: MarkedLossCause, iv: string | null): void => {
        if (inDoubt) this._heldStageLoss = { cause, enc: iv }
        else this.markWorkingCopyLost(cause, iv)
      }
      if (salvage === 'discarded') mark('startup', enc)
      else if (unclean !== null && unclean.enc !== null && enc === unclean.enc) {
        mark(unclean.cause, enc)
      } else if (unclean === null && heldLoss !== null && heldLoss.enc !== null && enc === heldLoss.enc) {
        // Review V F-2: what an earlier run judged and shredded, then stopped before recording (see above).
        mark(heldLoss.cause, enc)
      }
      this._unrecordedStartLoss = null
      this.adoptWorkingCopyLostMarker(enc)
      return // locked; await unlock
    }
    // #973 (narrow): a create's staged `.enc.new` that a crash left with no key file, no `.enc` and no rekey journal.
    // `vaultExistsOnDisk` reads neither file it removes, so the state is `uninitialized` before and after.
    discardOrphanedStage(this.vaultPaths)
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

  /** T2.16 fix round (R2 B2): the folders this start found to be links to a folder elsewhere, and acted through none of:
   *  `workspace` (no sweep, no rekey recovery), `logs` (the rotated log not removed), and (T2.7, L-2) `config` (the #875
   *  marker neither written nor removed). For `main/index.ts`'s one content-free log line: the folder's role only, never
   *  a path. */
  linkedStartFolders(): ReadonlyArray<'workspace' | 'logs' | 'config'> {
    return this._linkedStartFolders
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

  /** #985 (review round 3 F3): whether the last successful unlock left a `.recovery` copy a newer build stamped, older
   *  than `.enc` (a spent leftover), in place: the workspace's data unencrypted on the drive. Returns it once, for the
   *  IPC's one content-free log line (no audit type). */
  takeNewerRecoveryLeft(): boolean {
    const left = this._newerRecoveryLeft
    this._newerRecoveryLeft = false
    return left
  }

  /** #911: whether the last successful unlock encrypted the copy a start kept over a missing `.enc` as the new `.enc`.
   *  Returns it once, for the IPC to log now that there is a log key (owner decision D5: a log line, no audit type). */
  takeRestoredMissingEnc(): boolean {
    const restored = this._restoredMissingEnc
    this._restoredMissingEnc = false
    return restored
  }

  /** #973: whether the last unlock removed a staged `.enc.new` that does not open under this workspace's key (a create
   *  cut short by a crash left it, or it came from another workspace), or left one it could neither judge nor remove;
   *  null otherwise. Returns it once, for the IPC's one content-free log line (no audit type, as #911's), on the
   *  unlock's success and failure paths alike (review round 2 F4). */
  takeStageOutcome(): Exclude<StageInDoubtOutcome, 'rolled-forward'> | null {
    const outcome = this._stageOutcome
    this._stageOutcome = null
    return outcome
  }

  /** #1027: whether the last password change could not move its staged database into place (`code`: the code of the
   *  last error the swap pass met, no path; code review CR1-4: not necessarily the database's own, another file's step
   *  may have failed after it; `saved`: the change wrote `.enc` from the open database itself, else the next lock does).
   *  Returns it once, for the IPC's one content-free log line after the change; null otherwise. */
  takeDatabaseSwapFailure(): { code: string | null; saved: boolean } | null {
    const failure = this._databaseSwapFailure
    this._databaseSwapFailure = null
    return failure
  }

  /** #1001: how many staged document and image copies no journal vouched for the last unlock swapped in, removed (no
   *  newer copy of their stored document: another key or file, or the stored copy is already current) and left (they
   *  could be neither read nor swapped in or removed); null when
   *  it found none. Returns it once, for the IPC's one content-free log line, on the unlock's success and failure paths
   *  alike, as {@link takeStageOutcome}. */
  takeSidecarStageOutcome(): SidecarStageOutcome | null {
    const outcome = this._sidecarStageOutcome
    this._sidecarStageOutcome = null
    return outcome
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
    this.settleHeldStageLoss() // #973 (review round 3 F2): first, so a loss it records is consumed here once
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
      if (this._recoveryBlocked) throw new VaultRecoveryBlockedError(this._recoveryBlockedCode) // #1015: and its code
    }
    let unlocked: UnlockedVault
    this._stageLeftByUnlock = false
    this._stampPending = false // T2.2: this session's open decides whether the lock retries the stamp
    try {
      unlocked = unlockEncryptedVault(
        this.vaultPaths,
        password,
        this.noteProbeFallback,
        this.noteStageInDoubt,
        this.noteSidecarStages,
        this.noteJournalRefusals,
        this.noteStampFailed
      )
    } catch (err) {
      // #911: a failed unlock can end the state the notice is about (a damaged kept copy shredded; a roll-forward that
      // wrote `.enc` before the open failed, #844), never start it, so a notice shown is re-read from the disk.
      if (this._encMissingKept) this._encMissingKept = this.encMissingKeptOnDisk()
      throw err
    }
    const { db, key, descriptor, recoveryDiscarded, restoredMissingEnc, newerRecoveryLeft } = unlocked
    this._db = db
    this.key = key
    this.descriptor = descriptor
    this._mode = 'encrypted'
    this.consumeWorkingCopyLost() // #875: the lock screen's notice has been seen
    // #911: the kept copy is `.enc` again (or there was none to keep), so the notice is over.
    this._encMissingKept = false
    this._restoredMissingEnc = restoredMissingEnc
    this._newerRecoveryLeft = newerRecoveryLeft
    // #875: a loss this unlock made itself (a broken `.recovery` shredded) is recorded the same way.
    if (recoveryDiscarded && this._lostAtPreviousLock === null) this._lostAtPreviousLock = { cause: 'recovery', lostAt: null }
    // #1027: a staged database this unlock decided to delete (it does not open under the data key, #973, or `.enc` holds
    // the newer data) and could not, because another program holds it: the lock of this session deletes it once it can,
    // so no later start meets it (a build before #973 rolls any such file forward). `.enc` is what this unlock opened.
    // (A folder at the name is left too, and no file to delete.) Review F2: not marked unlisted. A stage in doubt is one
    // no admitted entry names, but the journal may still name it in an entry a failed stat left unjudged; the lock drops
    // that too (J finds nothing to do when nothing names it), or a later start that can judge the entry rolls the stage.
    // Code review CR1-2: "still there" unless a stat says ENOENT (one that fails otherwise proves nothing); a folder at
    // the name is no file to delete.
    const leftStage = `${this.vaultPaths.encPath}${REKEY_SUFFIX}`
    if (this._stageLeftByUnlock && !statSaysAbsent(leftStage) && lstatOrNull(leftStage)?.isDirectory() !== true) {
      this._staleDatabaseStage = { unlisted: false, encCurrent: true }
    }
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
    // #985 (review round 2 F3): a working file or `.recovery` a NEWER build stamped is that build's data (its last
    // session, or with its key file and `.enc` gone, the whole workspace). A create here would commit a new workspace
    // whose every unlock then refuses on that copy, so it is refused first, before anything is written (the create IPC
    // answers `workspace_newer`).
    for (const path of [this.vaultPaths.dbPath, `${this.vaultPaths.dbPath}${RECOVERY_SUFFIX}`]) {
      const probe = probeDatabaseFile(path)
      if (probe.verdict === 'newer') throw new WorkspaceNewerError(probe.found)
    }
    // #875: no vault is here, so a marker a wiped one left names no snapshot of the workspace about to be created.
    // Startup reads the marker only beside a vault, so nothing else would remove it, and a reset drive would carry it.
    // The record in memory goes with it (review round 2), so the new workspace's first lock shows no notice of the old.
    removeWorkingCopyLostMarker(this.vaultPaths)
    this._workingCopyLost = null
    this._lostAtPreviousLock = null
    this._heldStageLoss = null // #973: nor a loss a start held for a stage beside the wiped one
    this._staleDatabaseStage = null // #1027: nor a stage the wiped one's session meant to delete
    this._databaseSwapFailure = null
    if (mode === 'plaintext_dev') {
      if (!this.allowPlaintext()) throw new PlaintextNotAllowedError()
      this.openPlaintext()
    } else {
      // T2.7 (F-3): where no plaintext workspace is allowed, nothing found here is adopted; where one is (a dev build),
      // the working file is taken into the new workspace as before (the dev → encrypted path).
      if (!this.allowPlaintext()) setLeftoversAside(this.vaultPaths)
      createEncryptedVaultOnDisk(this.vaultPaths, password, DEFAULT_KDF, { onStampFailed: this.noteStampFailed })
      this._stampPending = false // T2.2: the unlock's open below decides whether the lock retries the stamp
      const { db, key, descriptor } = unlockEncryptedVault(
        this.vaultPaths,
        password,
        undefined,
        undefined,
        undefined,
        undefined,
        this.noteStampFailed
      )
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
        // #1014: the database is open, so the journal's stages outside the workspace folder (round 5: or inside it through
        // a link) are acted on when it lists their stored copy (the out-of-store copies this change stages itself), in one
        // call as before. Round 4: what
        // each pass leaves is counted into the sum `takeJournalRefusals` hands out (logged with the next unlock's line).
        const outOfStore = outOfStoreTargets(this.vaultPaths, this._db)
        // Defensive: drop strays from an old abort.
        discardPendingRekey(this.vaultPaths, outOfStore, this.noteJournalRefusals)
        const dataKey = generateDataKey()
        try {
          stageRekey(this.vaultPaths, this._db, this.key, dataKey, this.noteProbeFallback)
          // COMMIT POINT: the atomic descriptor replace. Before it the old password +
          // old files win; from here on the new ones do.
          this.descriptor = rewrapVaultKey(this.vaultPaths, dataKey, nextPassword, kdf)
        } catch (err) {
          // #1027: the rollback is best-effort, the new key is zeroed and the change's own error surfaces, whatever the
          // rollback does. A stage or a journal it cannot remove (another program holds it) lists a change that never
          // committed: every recovery under this (v1) key file discards it again, and the next change's own discard
          // (above) runs first. The rollback's error used to replace this one and skip the zeroing.
          try {
            discardPendingRekey(this.vaultPaths, outOfStore, this.noteJournalRefusals)
          } catch {
            /* see above */
          } finally {
            dataKey.fill(0)
          }
          throw err
        }
        // Committed: the new password + data key are authoritative from here on, so the
        // in-memory key is swapped BEFORE the file swap — lock()/documentCipher() must
        // never use the retired key once the descriptor wraps the new one.
        // #1027: and nothing below may throw: an error would tell the user the current password still works.
        this.key.fill(0)
        this.key = dataKey
        try {
          applyPendingRekey(this.vaultPaths, undefined, outOfStore, this.noteJournalRefusals)
        } catch (err) {
          // Not fatal post-commit: applyPendingRekey is now best-effort + retry, so it throws
          // only when a file stays persistently locked (e.g. on Windows) AFTER swapping every
          // other sidecar. A document's or an image's stage is written once, so that lone file
          // rolls forward exactly via recoverPendingRekey on the next startup/unlock (#1014: one
          // outside the workspace folder, at the next unlock) — the journal guarantees old-or-new
          // per file, never mixed.
          // #1027: the staged database is not written once: the open session goes on changing the database, so the
          // session, not the stage, holds the workspace from here on. Whatever made the pass throw (a held stage; a held
          // `.enc` the shred could neither overwrite nor remove, which leaves the old v1 file in place; a temp the pass
          // could not remove before it reached the database), a staged database still there means the database's swap
          // did not happen, so the trigger is the stage alone, never "`.enc` is missing" (review F4).
          // Code review CR1-2: only a stat that says ENOENT proves the stage went into place; one that fails otherwise
          // (EIO, EACCES, a hold) is no proof, and the stage may still be there.
          if (!statSaysAbsent(`${this.vaultPaths.encPath}${REKEY_SUFFIX}`)) this.supersedeDatabaseStage(err)
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
   * reporting, across a restart too, until the next unlock (#875). `opts.budget` (#982): the overwrite's deadline,
   * passed by the Linux `quit` leg only ({@link shutdown}); Lock now passes none.
   */
  lock(opts: LockOptions = {}): WorkspaceStateInfo {
    if (this._db && this.key && this.descriptor?.mode === 'encrypted') {
      // #1027: a staged database a password change of this session could not retire leaves the journal before `.enc`
      // is written below, so no start finds it listed beside a newer `.enc`. Before, never after (review F4): the lock
      // shreds the working file after its encrypt (seconds on a USB stick), and a crash between the encrypt's rename and
      // an entry dropped only then would leave the stale stage listed beside the newer `.enc`, and the next start would
      // shred that `.enc` and roll the stage over it. Dropped first, the stage either rolls forward at a start because `.enc` is still missing
      // (it is then the newest snapshot on the drive) or is judged under the key at the unlock.
      this.retireStaleDatabaseStage(false)
      // T2.2: a stamp the open could not write, tried once more before `.enc` is written from this file.
      this.retryStampOnce()
      try {
        lockEncryptedVault(this.vaultPaths, this._db, this.key, this.encryptFileImpl, this.noteProbeFallback, opts.budget)
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
        // #985: a file a newer build stamped (`newer`) is never lost either: it is kept as it is, with
        // the closed handle (the re-open below would refuse it), and the next start's salvage keeps it.
        const judged = err instanceof LockStoppedError ? err.verdict : null
        const probe = judged?.probe ?? probeDatabaseFile(dbPath)
        if (!judged?.probe && probe.verdict === 'unchecked') this.noteProbeFallback('lock', probe.code ?? 'unknown')
        const workingCopy = probe.verdict
        const walPending = workingCopy !== 'gone' && (judged ? judged.walPending : walAwaitsCheckpoint(dbPath))
        const lost =
          workingCopy === 'gone' || (!walPending && (workingCopy === 'not-database' || workingCopy === 'damaged'))
        if (lost && existsSync(this.vaultPaths.encPath)) {
          // #982: under the `quit` leg's budget this overwrite stops at its deadline too (the file is unlinked either way).
          if (!opts.budget) shredFile(dbPath)
          else if (shredFileWithin(dbPath, opts.budget).cut) opts.budget.onShredCut?.()
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
          // T2.2: the stamp is this open's one write attempt on what is often a full drive; it fails into the note and
          // the connection is kept.
          if (workingCopy === 'database' || workingCopy === 'unchecked' || replayable) {
            this._db = openDatabase(dbPath, { onStampFailed: this.noteStampFailed })
          } else if (workingCopy === 'gone') cleanSidecars(dbPath)
        } catch {
          // Re-open is best-effort: if the disk is too broken even for that, keep the
          // closed handle — isUnlocked() stays true, so no unlock can decrypt the STALE
          // `.enc` over the newer working file this session, and the init() salvage
          // (CODE-1b) preserves + rolls the file forward on the next launch.
        }
        throw new VaultLockError(err) // #956 (S-5): what failed, content-free, for the log
      }
      this.retireStaleDatabaseStage(true) // #1027: `.enc` is this session's now
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
   * #1027: the post-commit swap of a v1 → v2 password change could not move the staged database into place (another
   * program holds the fresh stage, and both renames failed). The swap shreds `.enc` before its rename, so `.enc` is gone,
   * and the stage holds the database as staged; but the open session goes on under the new key and changes it. Left as
   * it was, the stage stayed listed in the journal, the next lock wrote a newer `.enc`, and the next start (or the next
   * unlock of the same run) shredded it and renamed the stale stage over it: the session's work since the change was lost,
   * with no notice. So the session wins, each step best-effort and none thrown (the change has committed):
   *   1. the stage leaves the journal ({@link unlistStagedDatabase});
   *   2. `.enc` is written from the open database under the new key ({@link saveOpenDatabase});
   *   3. the stage is deleted, once `.enc` is back.
   * What is left (the hold that refused two renames usually outlasts these milliseconds) every lock of the session
   * retries ({@link retireStaleDatabaseStage}), and a stage still there at the next unlock is removed there: it opens
   * under the data key beside an `.enc` that opens too (`superseded`, {@link resolveStageInDoubt}).
   */
  private supersedeDatabaseStage(swapError: unknown): void {
    const db = this._db
    const key = this.key
    const pending = { unlisted: false, encCurrent: false }
    this._staleDatabaseStage = pending
    pending.unlisted = bestEffort(() => unlistStagedDatabase(this.vaultPaths))
    pending.encCurrent =
      db !== null && key !== null && bestEffort(() => saveOpenDatabase(this.vaultPaths, db, key, this.noteProbeFallback))
    this._databaseSwapFailure = { code: causeFailure(swapError).code, saved: pending.encCurrent }
    this.retireStaleDatabaseStage(false)
  }

  /**
   * #1027: retry what {@link supersedeDatabaseStage} (or an unlock that could not delete a staged database) left: the
   * journal entry, then the stage itself, once `.enc` is this session's (`encWritten`: a lock has just written it). Never
   * deletes the stage while `.enc` may still be missing (a change that could not save it, a lock that failed): the stage
   * is then the only snapshot. Clears the record once the stage is gone (ENOENT) and unlisted. Never throws: the lock legs
   * that call it include the crash and session-end locks.
   */
  private retireStaleDatabaseStage(encWritten: boolean): void {
    const pending = this._staleDatabaseStage
    if (pending === null) return
    if (encWritten) pending.encCurrent = true
    if (!pending.unlisted) pending.unlisted = bestEffort(() => unlistStagedDatabase(this.vaultPaths))
    const staged = `${this.vaultPaths.encPath}${REKEY_SUFFIX}`
    // Never while `.enc` may be missing (review F3: pinned by the full-drive row).
    if (pending.encCurrent && isFileAt(staged)) bestEffort(() => rmSync(staged, { force: true }))
    if (pending.unlisted && statSaysAbsent(staged)) this._staleDatabaseStage = null
  }

  /**
   * Process-exit teardown (issue #51). For an unlocked encrypted vault this is `lock()`
   * (checkpoint + close + re-encrypt + shred — the existing path). For `plaintext_dev` —
   * where `lock()` is a deliberate no-op — it checkpoints and CLOSES the DB, so a clean
   * quit leaves a bare `hilbertraum.sqlite` with no `-wal`/`-shm` sidecars at rest on the
   * drive: on a non-journaling exFAT stick, at-rest WAL sidecars mean the last session
   * never closed cleanly, and they make the next hard unplug likelier to corrupt. ONLY
   * for callers that are about to exit the process — a closed plaintext DB has no reopen
   * path short of relaunch (`requireDb` throws afterwards). `opts` goes to {@link lock} (#982: the Linux `quit` leg's
   * overwrite deadline; the quit teardown passes none).
   */
  shutdown(opts: LockOptions = {}): void {
    try {
      this.lock(opts)
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
      // S-1 (follow-ups wave 7, #1002): the process does not always end after this. A macOS shutdown another app
      // cancelled leaves it running, locked, and offers the unlock again; that unlock skipped `init()` (the start's
      // steps had run) and decrypted `.enc`, the last good lock, over the newer working file: the session since then
      // was lost, and the key stayed in memory on a "locked" controller. So mark the start's steps as not done (the
      // next unlock runs them first: the salvage moves the working file aside and the unlock rolls it forward, as the
      // next launch would) and zero and drop the key (`documentCipher()` is null until then).
      this._startStepsDone = false
      this.key?.fill(0)
      this.key = null
      throw err
    }
    if (this._db) {
      // plaintext_dev: flush the WAL into the main file, then close — SQLite removes the
      // -wal/-shm sidecars on the last clean connection close. T2.2: first, a stamp the open could not write, once more.
      this.retryStampOnce()
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
