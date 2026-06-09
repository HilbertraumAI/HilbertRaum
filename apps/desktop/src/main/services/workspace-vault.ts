import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Db } from './db'
import { openDatabase } from './db'
import { seedSettings, updateSettings } from './settings'
import type { PrivacyPolicy, WorkspaceMode, WorkspaceStateInfo } from '../../shared/types'
import {
  type EncryptedBlob,
  type KdfParams,
  DEFAULT_KDF,
  deriveKey,
  encrypt,
  decrypt,
  serializeBlob,
  deserializeBlob,
  generateSalt,
  makeVerifier,
  verifyKey
} from './security/crypto'

// Workspace vault: the lock/unlock lifecycle for the encrypted workspace (spec §7.9).
//
// `node:sqlite` has no SQLCipher, so we encrypt the WHOLE database FILE at rest (plan
// §4b): the at-rest artifact is `paid.sqlite.enc`. On unlock we derive the key, verify
// the password against a small authenticated verifier, decrypt the blob to the working
// file `paid.sqlite` ON THE DRIVE, and open it normally. On lock/quit we checkpoint +
// close, re-encrypt the working file back to `.enc`, then shred the plaintext copy.
//
// The password + derived key live ONLY in memory. The on-disk descriptor
// (`config/workspace.json`, UNENCRYPTED) holds just enough to know a password is
// required, which KDF/params to use, the salt, and an authenticated verifier — never
// the password or key. This is the only thing the app can read BEFORE unlocking, since
// the settings (incl. `workspaceMode`) live inside the encrypted DB.

export const VAULT_VERSION = 1

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
}

/** Resolved file locations the vault works with. */
export interface VaultPaths {
  /** `config/workspace.json` — the unencrypted descriptor. */
  descriptorPath: string
  /** `workspace/paid.sqlite.enc` — the encrypted-at-rest database. */
  encPath: string
  /** `workspace/paid.sqlite` — the decrypted working file (present only while unlocked). */
  dbPath: string
}

/** Thrown by `unlockEncryptedVault` when the password fails the verifier. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect workspace password')
    this.name = 'WrongPasswordError'
  }
}

/** Derive the vault file locations from the resolved workspace paths. */
export function vaultPathsFrom(paths: { configPath: string; dbPath: string }): VaultPaths {
  return {
    descriptorPath: join(paths.configPath, 'workspace.json'),
    encPath: `${paths.dbPath}.enc`,
    dbPath: paths.dbPath
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

/** Read the descriptor, or null if there is no encrypted vault yet. */
export function readVaultDescriptor(descriptorPath: string): VaultDescriptor | null {
  if (!existsSync(descriptorPath)) return null
  try {
    const raw = JSON.parse(readFileSync(descriptorPath, 'utf8')) as VaultDescriptor
    if (raw && raw.mode === 'encrypted' && raw.kdf && raw.saltB64 && raw.verifier) return raw
    return null
  } catch {
    return null
  }
}

/**
 * True when a descriptor FILE exists but cannot be parsed/validated. This must be kept
 * distinct from "no vault yet": a corrupt 200-byte JSON file must NOT make the app
 * report `uninitialized` and offer the create flow, which would overwrite the intact
 * `.enc` (all user data) with a fresh empty vault.
 */
export function isDescriptorUnreadable(descriptorPath: string): boolean {
  return existsSync(descriptorPath) && readVaultDescriptor(descriptorPath) === null
}

/** Persist the descriptor atomically (write temp + rename). */
export function writeVaultDescriptor(descriptorPath: string, d: VaultDescriptor): void {
  const tmp = `${descriptorPath}.tmp`
  writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8')
  renameSync(tmp, descriptorPath)
}

// ---- file-level crypto + hygiene -------------------------------------------------

/** Encrypt `srcPath` → `destPath` (atomic) with `key`. */
export function encryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const plaintext = readFileSync(srcPath)
  const blob = serializeBlob(encrypt(key, plaintext))
  const tmp = `${destPath}.tmp`
  writeFileSync(tmp, blob)
  renameSync(tmp, destPath)
}

/** Decrypt `srcPath` → `destPath` (atomic) with `key`. Throws on a wrong key/tamper. */
export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const blob = deserializeBlob(readFileSync(srcPath))
  const plaintext = decrypt(key, blob)
  const tmp = `${destPath}.tmp`
  writeFileSync(tmp, plaintext)
  renameSync(tmp, destPath)
}

/**
 * Best-effort secure delete: overwrite the file with random bytes, then unlink. On SSDs
 * wear-levelling means the original blocks may survive — this is documented in
 * SECURITY.md and not over-promised.
 */
export function shredFile(path: string): void {
  try {
    if (!existsSync(path)) return
    const size = statSync(path).size
    if (size > 0) writeFileSync(path, randomBytes(size))
    rmSync(path, { force: true })
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

/**
 * Crash recovery for an encrypted vault: shred every leftover plaintext artifact a
 * killed run can leave behind — the working DB, its WAL/SHM sidecars, the atomic-write
 * `.tmp` files of encrypt/decryptFile, and transient decrypted document copies
 * (`*.parse*` under `workspace/documents/`, used while re-indexing an encrypted copy).
 * For an encrypted vault these are all derived from the `.enc` artifacts (the source of
 * truth), so shredding loses nothing. MUST NOT be called for `plaintext_dev`, where the
 * working file IS the database.
 */
export function shredStalePlaintext(vaultPaths: VaultPaths): void {
  shredFile(vaultPaths.dbPath)
  // decryptFile writes the FULL plaintext to `<dbPath>.tmp` before its atomic rename —
  // a crash inside that window leaves the entire decrypted database under this name.
  shredFile(`${vaultPaths.dbPath}.tmp`)
  cleanSidecars(vaultPaths.dbPath)
  // Transient plaintext document copies (encrypted-mode re-index decrypts the stored
  // `.enc` to `<id>.parse<ext>` while parsing). Never touches the stored copies
  // themselves — only the clearly-transient `.parse`/`.tmp` names.
  const docsDir = join(dirname(vaultPaths.dbPath), 'documents')
  try {
    for (const name of readdirSync(docsDir)) {
      if (name.includes('.parse') || name.endsWith('.tmp')) shredFile(join(docsDir, name))
    }
  } catch {
    /* no documents dir yet */
  }
}

// ---- encrypted document cache ------------------------------------------------------

/**
 * File-level encrypt/decrypt bound to the unlocked vault key. Used by the ingestion
 * service so imported document COPIES rest encrypted too (spec §3.5 requires encrypting
 * the "workspace database AND document cache" — the DB alone is not enough: the raw
 * bytes of every imported file would otherwise stay readable on a lost drive).
 */
export interface DocumentCipher {
  /** Encrypt the plaintext file at `srcPath` → framed ciphertext at `destPath`. */
  encryptFile(srcPath: string, destPath: string): void
  /** Decrypt the framed ciphertext at `srcPath` → plaintext at `destPath`. */
  decryptFile(srcPath: string, destPath: string): void
}

// ---- create / unlock / lock ------------------------------------------------------

/**
 * Create a brand-new encrypted vault ON DISK, leaving it LOCKED (descriptor + `.enc`,
 * no plaintext working file). Derives a key from `password`, writes the descriptor with
 * the salt + KDF params + verifier, builds an initial seeded database, encrypts it, and
 * shreds the plaintext. Call `unlockEncryptedVault` afterwards to open it.
 */
export function createEncryptedVaultOnDisk(
  vaultPaths: VaultPaths,
  password: string,
  kdf: KdfParams = DEFAULT_KDF
): void {
  // Refuse to overwrite an existing vault — `.enc` IS the user's data (chats, documents,
  // settings), and re-creating would irreversibly replace it with an empty database. A
  // corrupt/missing descriptor is recoverable; a wiped `.enc` is not.
  if (existsSync(vaultPaths.encPath)) {
    throw new Error(
      'An encrypted workspace already exists here — refusing to overwrite it. ' +
        'Unlock it with its password instead. To really start fresh, move or delete ' +
        `"${vaultPaths.encPath}" (and config/workspace.json) first.`
    )
  }
  const salt = generateSalt()
  const key = deriveKey(password, salt, kdf)
  const descriptor: VaultDescriptor = {
    version: VAULT_VERSION,
    mode: 'encrypted',
    kdf,
    saltB64: salt.toString('base64'),
    verifier: blobToJson(makeVerifier(key))
  }
  writeVaultDescriptor(vaultPaths.descriptorPath, descriptor)

  // Build an initial, seeded database, then encrypt the file and shred the plaintext.
  const db = openDatabase(vaultPaths.dbPath)
  seedSettings(db)
  updateSettings(db, { workspaceMode: 'encrypted' })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  encryptFile(vaultPaths.dbPath, vaultPaths.encPath, key)
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
}

/** The in-memory result of a successful unlock. */
export interface UnlockedVault {
  db: Db
  key: Buffer
  descriptor: VaultDescriptor
}

/**
 * Unlock an encrypted vault: derive the key, verify the password against the descriptor
 * (no DB access), decrypt `.enc` → working file, and open the database. Throws
 * `WrongPasswordError` on a bad password (the GCM verifier fails, the DB is never touched).
 */
export function unlockEncryptedVault(vaultPaths: VaultPaths, password: string): UnlockedVault {
  const descriptor = readVaultDescriptor(vaultPaths.descriptorPath)
  if (!descriptor) {
    if (existsSync(vaultPaths.encPath)) {
      throw new Error(
        'The workspace descriptor (config/workspace.json) is missing or unreadable, so ' +
          'the encrypted workspace cannot be unlocked. Restore config/workspace.json ' +
          'from a backup — do NOT create a new workspace, or the existing data is lost.'
      )
    }
    throw new Error('No encrypted workspace to unlock')
  }
  const salt = Buffer.from(descriptor.saltB64, 'base64')
  const key = deriveKey(password, salt, descriptor.kdf)
  if (!verifyKey(key, blobFromJson(descriptor.verifier))) {
    throw new WrongPasswordError()
  }
  // Verified: clean any stale WAL/SHM from a crash first (otherwise SQLite would replay
  // them onto the freshly-decrypted snapshot and corrupt it), then decrypt + open.
  cleanSidecars(vaultPaths.dbPath)
  decryptFile(vaultPaths.encPath, vaultPaths.dbPath, key)
  const db = openDatabase(vaultPaths.dbPath)
  seedSettings(db)
  return { db, key, descriptor }
}

/**
 * Lock an unlocked encrypted vault: checkpoint + close the DB (flushing WAL into the
 * main file), re-encrypt the working file → `.enc`, then shred the plaintext working
 * file and its sidecars. Idempotent-ish: safe to call once per unlock.
 */
export function lockEncryptedVault(vaultPaths: VaultPaths, db: Db, key: Buffer): void {
  // Flush WAL into the main file so the encrypted snapshot is complete, then close.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* checkpoint is best-effort; close still flushes */
  }
  db.close()
  encryptFile(vaultPaths.dbPath, vaultPaths.encPath, key)
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
}

// ---- plaintext gating ------------------------------------------------------------

/**
 * Is a plaintext (developer) workspace permitted? Gated by the Phase-8 policy AND a
 * developer/env signal. `encryptionRequired` is an absolute veto; `allowPlaintextDevMode`
 * must be true; and the caller must be a developer (dev build or developer mode).
 *
 * Pre-unlock the `developerMode` setting is unavailable (it lives in the encrypted DB),
 * so callers pass `isDev` as the proxy — documented in BUILD_STATE.
 */
export function plaintextAllowed(
  policy: PrivacyPolicy,
  opts: { isDev: boolean; developerMode: boolean }
): boolean {
  if (policy.workspace.encryptionRequired) return false
  if (!policy.workspace.allowPlaintextDevMode) return false
  return opts.isDev || opts.developerMode
}

// ---- stateful controller (used by the main process) ------------------------------

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

  constructor(
    private readonly vaultPaths: VaultPaths,
    private readonly policy: PrivacyPolicy,
    private readonly isDev: boolean
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

  private allowPlaintext(): boolean {
    return plaintextAllowed(this.policy, { isDev: this.isDev, developerMode: this.isDev })
  }

  /**
   * A vault exists on disk when there is a valid encrypted descriptor, OR the encrypted
   * database itself is present, OR a descriptor file exists but is unreadable (corrupt).
   * In every one of those cases the create flow must be refused — it would overwrite
   * the user's data with an empty vault.
   */
  private vaultExistsOnDisk(): boolean {
    return (
      this.descriptor?.mode === 'encrypted' ||
      existsSync(this.vaultPaths.encPath) ||
      isDescriptorUnreadable(this.vaultPaths.descriptorPath)
    )
  }

  private openPlaintext(): void {
    const db = openDatabase(this.vaultPaths.dbPath)
    seedSettings(db)
    updateSettings(db, { workspaceMode: 'plaintext_dev' })
    this._db = db
    this._mode = 'plaintext_dev'
  }

  /**
   * Decide the startup state. An encrypted descriptor → stay LOCKED until unlock. No
   * descriptor → open plaintext if permitted (dev), else UNINITIALIZED (await onboarding).
   */
  init(): void {
    if (this.descriptor?.mode === 'encrypted') {
      // Crash recovery: an encrypted vault must have NO plaintext working file at rest.
      // If a previous run was killed before lock-on-quit ran, shred the leftover so the
      // decrypted database (+ WAL/SHM) never lingers on disk. Safe — see shredStalePlaintext.
      shredStalePlaintext(this.vaultPaths)
      return // locked; await unlock
    }
    if (this.vaultExistsOnDisk()) {
      // An encrypted vault exists but its descriptor is missing/corrupt. Stay LOCKED:
      // do not open a plaintext DB over it, and (via getState/create) never offer the
      // create flow that would overwrite it. NOTE: do not shred here either — a stale
      // plaintext working file may be the only recoverable copy of the data.
      return
    }
    if (this.allowPlaintext()) this.openPlaintext()
    // else uninitialized → onboarding will create an encrypted workspace
  }

  getState(): WorkspaceStateInfo {
    const state = this.isUnlocked() ? 'unlocked' : this.vaultExistsOnDisk() ? 'locked' : 'uninitialized'
    return {
      state,
      mode: this._mode ?? this.descriptor?.mode ?? (this.vaultExistsOnDisk() ? 'encrypted' : null),
      plaintextAllowed: this.allowPlaintext(),
      encryptionRequired: this.policy.workspace.encryptionRequired
    }
  }

  /** Unlock an existing encrypted workspace. Throws `WrongPasswordError` on a bad password. */
  unlock(password: string): WorkspaceStateInfo {
    if (this.isUnlocked()) return this.getState()
    const { db, key, descriptor } = unlockEncryptedVault(this.vaultPaths, password)
    this._db = db
    this.key = key
    this.descriptor = descriptor
    this._mode = 'encrypted'
    return this.getState()
  }

  /** First-run create. `encrypted` builds a vault; `plaintext_dev` is gated by policy. */
  create(password: string, mode: WorkspaceMode): WorkspaceStateInfo {
    if (this.isUnlocked()) throw new Error('Workspace is already initialized.')
    if (this.vaultExistsOnDisk()) {
      // Reachable when a caller invokes createWorkspace while state is `locked`, or when
      // the descriptor is corrupt. Creating would wipe the existing `.enc` — refuse.
      throw new Error(
        'A workspace already exists on this drive — unlock it with its password instead ' +
          'of creating a new one.'
      )
    }
    if (mode === 'plaintext_dev') {
      if (!this.allowPlaintext()) {
        throw new Error('Plaintext workspace is not permitted by policy.')
      }
      this.openPlaintext()
    } else {
      createEncryptedVaultOnDisk(this.vaultPaths, password)
      const { db, key, descriptor } = unlockEncryptedVault(this.vaultPaths, password)
      this._db = db
      this.key = key
      this.descriptor = descriptor
      this._mode = 'encrypted'
    }
    return this.getState()
  }

  /**
   * A `DocumentCipher` bound to the unlocked vault key, or null in plaintext mode /
   * while locked. Ingestion uses it to keep the imported-document cache encrypted at
   * rest (the cipher captures the key; it stops working only at process exit).
   */
  documentCipher(): DocumentCipher | null {
    const key = this.key
    if (!key || this._mode !== 'encrypted') return null
    return {
      encryptFile: (src, dest) => encryptFile(src, dest, key),
      decryptFile: (src, dest) => decryptFile(src, dest, key)
    }
  }

  /**
   * Lock the encrypted vault: re-encrypt the working file → `.enc` and shred the
   * plaintext. A no-op for `plaintext_dev` (nothing to protect, and closing it would
   * wedge the app back into onboarding) — the DB simply stays open until process exit.
   */
  lock(): WorkspaceStateInfo {
    if (this._db && this.key && this.descriptor?.mode === 'encrypted') {
      lockEncryptedVault(this.vaultPaths, this._db, this.key)
      this._db = null
      this.key = null
    }
    return this.getState()
  }
}
