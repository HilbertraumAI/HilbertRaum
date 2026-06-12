import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fsyncSync
} from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Db } from './db'
import { openDatabase } from './db'
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
  BLOB_MAGIC,
  BLOB_IV_BYTES,
  BLOB_TAG_BYTES
} from './security/crypto'

// Workspace vault: the lock/unlock lifecycle for the encrypted workspace (spec §7.9).
//
// `node:sqlite` has no SQLCipher, so we encrypt the WHOLE database FILE at rest: the
// at-rest artifact is `paid.sqlite.enc`. On unlock we derive the key, verify
// the password against a small authenticated verifier, decrypt the blob to the working
// file `paid.sqlite` ON THE DRIVE, and open it normally. On lock/quit we checkpoint +
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
 * Envelope format: a random 32-byte DATA key encrypts the DB +
 * document sidecars; the password-derived key (KEK) only WRAPS it in the descriptor.
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
    if (!raw || raw.mode !== 'encrypted' || !raw.kdf || !raw.saltB64 || !raw.verifier) return null
    // A v2 (envelope) descriptor without its wrapped data key is corrupt, not unlockable.
    if (raw.version >= VAULT_VERSION_ENVELOPE && !raw.dataKey) return null
    return raw
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

/** Chunk size for streaming crypto + shredding. Bounds memory regardless of file size. */
const FILE_CHUNK_BYTES = 8 * 1024 * 1024

/** Encrypt `srcPath` → `destPath` (atomic) with `key`. Streams; constant memory. */
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
    rmSync(tmp, { force: true })
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
 * Decrypt `srcPath` → `destPath` (atomic) with `key`. Streams; constant memory. Throws
 * on a wrong key/tamper (GCM auth failure in `final()`); on failure the partial output
 * is shredded — note that callers verify the password against the descriptor verifier
 * BEFORE decrypting, so a wrong-key decrypt of the DB never happens in normal flow.
 */
export function decryptFile(srcPath: string, destPath: string, key: Buffer): void {
  const tmp = `${destPath}.tmp`
  const src = openSync(srcPath, 'r')
  let out: number | null = null
  try {
    const headerLen = BLOB_MAGIC.length + BLOB_IV_BYTES + BLOB_TAG_BYTES
    const header = Buffer.alloc(headerLen)
    const got = readSync(src, header, 0, headerLen, null)
    if (got < headerLen) throw new Error('Encrypted blob is too short or corrupt')
    if (!header.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
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
    const fin = decipher.final() // throws here on wrong key / tampered ciphertext
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

// ---- password change: envelope rekey + journaled v1→v2 migration ------------------
//
// Two-phase swap, composed ONLY from the existing atomic primitives: every re-encrypted
// file is STAGED as `<file>.new` (encryptFile's own `.tmp`-then-rename inside) and
// fsynced; the atomic descriptor replace is the SINGLE commit point; the staged files
// are then swapped in (shred old, rename `.new`). A crash at any step recovers to a
// consistent vault: descriptor still v1 → the staged files are discarded and the OLD
// password+files win; descriptor already v2 → the staged files are rolled forward and
// the NEW password wins. Never a mix.

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

/** Every encrypted document sidecar (`<id><ext>.enc`) under `workspace/documents/`. */
function listEncryptedDocSidecars(vaultPaths: VaultPaths): string[] {
  const docsDir = join(dirname(vaultPaths.dbPath), 'documents')
  try {
    return readdirSync(docsDir)
      .filter((n) => n.endsWith(ENCRYPTED_DOC_SUFFIX))
      .map((n) => join(docsDir, n))
  } catch {
    return [] // no documents dir yet
  }
}

/** Every staged `<file>.new` of an (interrupted or in-progress) rekey: DB + documents. */
function stagedRekeyFiles(vaultPaths: VaultPaths): string[] {
  const out: string[] = []
  if (existsSync(`${vaultPaths.encPath}${REKEY_SUFFIX}`)) {
    out.push(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  }
  const docsDir = join(dirname(vaultPaths.dbPath), 'documents')
  try {
    for (const n of readdirSync(docsDir)) {
      if (n.endsWith(`${ENCRYPTED_DOC_SUFFIX}${REKEY_SUFFIX}`)) out.push(join(docsDir, n))
    }
  } catch {
    /* no documents dir yet */
  }
  return out
}

/**
 * Phase 1 of the v1→v2 migration: re-encrypt the database + every document sidecar
 * under `dataKey`, STAGED next to the originals as `<file>.new`, fsynced. Nothing the
 * current password unlocks is touched. The DB snapshot comes from the live working file
 * (WAL checkpointed first), so it is CURRENT — fresher than the at-rest `.enc` from the
 * last lock. Document sidecars round-trip through a transient plaintext file that is
 * shredded immediately (and covered by the startup sweep on a crash).
 */
export function stageRekey(vaultPaths: VaultPaths, db: Db, oldKey: Buffer, dataKey: Buffer): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  encryptFile(vaultPaths.dbPath, `${vaultPaths.encPath}${REKEY_SUFFIX}`, dataKey)
  fsyncPath(`${vaultPaths.encPath}${REKEY_SUFFIX}`)
  for (const enc of listEncryptedDocSidecars(vaultPaths)) {
    const plain = `${enc}${REKEY_PLAINTEXT_SUFFIX}`
    try {
      decryptFile(enc, plain, oldKey)
      encryptFile(plain, `${enc}${REKEY_SUFFIX}`, dataKey)
      fsyncPath(`${enc}${REKEY_SUFFIX}`)
    } finally {
      shredFile(plain)
    }
  }
}

/**
 * Phase 2 (after the descriptor commit): swap every staged file in — shred the old
 * ciphertext (its key may be a compromised password's), rename `.new` into place.
 * Idempotent: already-swapped files have no `.new` left, so crash-and-rerun completes.
 */
export function applyPendingRekey(vaultPaths: VaultPaths): void {
  for (const staged of stagedRekeyFiles(vaultPaths)) {
    const target = staged.slice(0, -REKEY_SUFFIX.length)
    shredFile(target)
    renameSync(staged, target)
  }
}

/** Roll back an uncommitted rekey: delete the staged files. Plain delete is enough —
 *  they are ciphertext under a data key that was never persisted anywhere. */
export function discardPendingRekey(vaultPaths: VaultPaths): void {
  for (const staged of stagedRekeyFiles(vaultPaths)) {
    rmSync(staged, { force: true })
  }
}

/**
 * Crash recovery for an interrupted password change. MUST run before any unlock decrypt:
 * the descriptor decides which side of the commit point the crash landed on. v2
 * descriptor + staged files ⇒ committed ⇒ roll FORWARD (the new password's files win);
 * v1 descriptor ⇒ uncommitted ⇒ roll BACK (the old password + old files stay intact).
 */
export function recoverPendingRekey(vaultPaths: VaultPaths, descriptor: VaultDescriptor | null): void {
  // encryptFile's own atomic-write temp for the staged DB (a crash mid-stage leaves it;
  // the document-dir equivalents end in `.tmp` and are swept by shredStalePlaintext).
  rmSync(`${vaultPaths.encPath}${REKEY_SUFFIX}.tmp`, { force: true })
  if (stagedRekeyFiles(vaultPaths).length === 0) return
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
  /** Encrypt the plaintext file at `srcPath` → framed ciphertext at `destPath`. */
  encryptFile(srcPath: string, destPath: string): void
  /** Decrypt the framed ciphertext at `srcPath` → plaintext at `destPath`. */
  decryptFile(srcPath: string, destPath: string): void
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
  // corrupt/missing descriptor is recoverable; a wiped `.enc` is not.
  if (existsSync(vaultPaths.encPath)) {
    throw new Error(
      'An encrypted workspace already exists here — refusing to overwrite it. ' +
        'Unlock it with its password instead. To really start fresh, move or delete ' +
        `"${vaultPaths.encPath}" (and config/workspace.json) first.`
    )
  }
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
  writeVaultDescriptor(vaultPaths.descriptorPath, descriptor)

  // Build an initial, seeded database, then encrypt the file and shred the plaintext.
  const db = openDatabase(vaultPaths.dbPath)
  seedSettings(db)
  updateSettings(db, { workspaceMode: 'encrypted' })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  encryptFile(vaultPaths.dbPath, vaultPaths.encPath, fileKey)
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
  fileKey.fill(0)
}

/** The in-memory result of a successful unlock. */
export interface UnlockedVault {
  db: Db
  /** The FILE key data is encrypted under: v2 = the unwrapped data key; v1 = the
   *  password-derived key. Lives only in memory; zeroed on lock. */
  key: Buffer
  descriptor: VaultDescriptor
}

/**
 * Unlock an encrypted vault: derive the key, verify the password against the descriptor
 * (no DB access), unwrap the data key on a v2 descriptor, decrypt `.enc` → working file,
 * and open the database. Throws `WrongPasswordError` on a bad password (the GCM verifier
 * fails, the DB is never touched).
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
  // A crash during a password change must be resolved BEFORE any decrypt: the descriptor
  // decides whether staged `.new` files roll forward (committed) or are discarded.
  recoverPendingRekey(vaultPaths, descriptor)
  const salt = Buffer.from(descriptor.saltB64, 'base64')
  const key = deriveKey(password, salt, descriptor.kdf)
  if (!verifyKey(key, blobFromJson(descriptor.verifier))) {
    throw new WrongPasswordError()
  }
  // v2 envelope: the derived key is only the KEK — unwrap the data key, drop the KEK.
  let fileKey = key
  if (descriptor.version >= VAULT_VERSION_ENVELOPE && descriptor.dataKey) {
    fileKey = decrypt(key, blobFromJson(descriptor.dataKey))
    key.fill(0)
  }
  // Verified: clean any stale WAL/SHM from a crash first (otherwise SQLite would replay
  // them onto the freshly-decrypted snapshot and corrupt it), then decrypt + open.
  cleanSidecars(vaultPaths.dbPath)
  decryptFile(vaultPaths.encPath, vaultPaths.dbPath, fileKey)
  const db = openDatabase(vaultPaths.dbPath)
  seedSettings(db)
  return { db, key: fileKey, descriptor }
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
 * Is a plaintext (developer) workspace permitted? Gated by the drive policy AND a
 * developer/env signal. `encryptionRequired` is an absolute veto; `allowPlaintextDevMode`
 * must be true; and the caller must be a developer (dev build or developer mode).
 *
 * Pre-unlock the `developerMode` setting is unavailable (it lives in the encrypted DB),
 * so callers pass `isDev` as the proxy.
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
  /** Open document-work holds (import/re-index writing `.enc` sidecars) — see the
   *  race guard on `changePassword`/`beginDocumentWork`. */
  private docWork = 0
  /** True while `changePassword` runs (defensive: it is synchronous today). */
  private changingPassword = false

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
      // And resolve any password change the crash interrupted (roll forward or back per
      // the descriptor — unlock would do this too; doing it here keeps disk state clean
      // even while the vault stays locked).
      recoverPendingRekey(this.vaultPaths, this.descriptor)
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
      throw new VaultBusyError(
        'The workspace password is being changed right now. Try again in a moment.'
      )
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
      throw new VaultBusyError(
        'Documents are still being imported or re-indexed. Wait for that to finish, then try again.'
      )
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
          stageRekey(this.vaultPaths, this._db, this.key, dataKey)
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
          // Not fatal post-commit (e.g. a transiently locked file on Windows): any
          // staged file left behind rolls forward via recoverPendingRekey on the next
          // startup/unlock — the journal guarantees old-or-new, never mixed.
        }
      }
      return this.getState()
    } finally {
      this.changingPassword = false
    }
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
      // Zero the key bytes before dropping the reference — otherwise the 32-byte key
      // lingers in the heap until GC and could surface in a dump/swap.
      this.key.fill(0)
      this._db = null
      this.key = null
    }
    return this.getState()
  }
}
