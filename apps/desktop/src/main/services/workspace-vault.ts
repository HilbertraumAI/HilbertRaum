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
import { open as openFileAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tMain } from './i18n'
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
  /** `workspace/hilbertraum.sqlite.enc` — the encrypted-at-rest database. */
  encPath: string
  /** `workspace/hilbertraum.sqlite` — the decrypted working file (present only while unlocked). */
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
 * Thrown by `WorkspaceController.lock()` when re-encrypting the vault fails (realistically
 * ENOSPC: during lock the plaintext DB + old `.enc` + new `.enc.tmp` coexist, so each lock
 * needs ~DB-size free space — plausible on a nearly-full USB stick). Content-free ON
 * PURPOSE: the IPC layer maps it to friendly localized copy (`main.workspace.lockFailed`).
 * When this is thrown the controller has already restored itself to a consistent UNLOCKED
 * state (plaintext DB re-opened, key kept), so retrying lock after freeing space is safe.
 * full-audit 2026-07-11 CODE-1a.
 */
export class VaultLockError extends Error {
  constructor() {
    super('Could not lock the workspace')
    this.name = 'VaultLockError'
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
//
// SYNC vs ASYNC (PERF-1, full-audit-2026-06-29 follow-up, Phase 3). Two flavours exist;
// both produce/consume the IDENTICAL on-disk frame (cross-verified by the vault tests), so a
// file written by either decrypts with either:
//   • `encryptFile`/`decryptFile` (SYNC) — the original `readSync`/`writeSync` loop. Used by the
//     DB-`.enc` lifecycle (create/unlock/lock/checkpoint/rekey) and the crash-only lock, which
//     must run to completion BEFORE `process.exit` in the `uncaughtException` handler (an async
//     lock can't finish before exit → committed in-session data would be lost), and by the
//     bounded, user-triggered image-history / text-export paths reached through SYNCHRONOUS
//     callers (the vision streaming emitter; the export reader). These are NOT the per-import freeze.
//   • `encryptFileAsync`/`decryptFileAsync` (ASYNC) — the same loop on `fs.promises` FileHandles,
//     awaiting each chunk so it YIELDS to the event loop between chunks (AES-GCM `update` on an
//     8 MiB chunk is sub-ms). Used by the document-CACHE import/re-index/preview/OCR path — the
//     "freeze on every import" PERF-1 targets (a large scanned PDF over USB, paid twice in an
//     encrypted workspace). DIVERGENCE from the audit's "convert the vault loop" wording: rather
//     than make the shared functions async-in-place (which cascades into the DB lock/unlock/rekey
//     lifecycle + the synchronous crash-lock + the synchronous vision emitter — the highest-stakes,
//     most-tested code, with a real vault-corruption blast radius the audit itself flagged), we
//     ADDED async siblings used by the actual per-import harm and left the session-boundary DB
//     lifecycle + bounded sync paths on the sync functions. See architecture.md §35.

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
 * normal flow. Reads the byte-identical frame the sync path writes (and vice versa).
 */
export async function decryptFileAsync(srcPath: string, destPath: string, key: Buffer): Promise<void> {
  const tmp = `${destPath}.tmp`
  const src = await openFileAsync(srcPath, 'r')
  let out: Awaited<ReturnType<typeof openFileAsync>> | null = null
  try {
    const headerLen = BLOB_MAGIC.length + BLOB_IV_BYTES + BLOB_TAG_BYTES
    const header = Buffer.alloc(headerLen)
    const { bytesRead: got } = await src.read(header, 0, headerLen, null)
    if (got < headerLen) throw new Error('Encrypted blob is too short or corrupt')
    if (!header.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) {
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

/** Remove (shredding first) the WAL/SHM sidecars that can hold plaintext pages. */
export function cleanSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    shredFile(`${dbPath}${suffix}`)
  }
}

/** Suffix of a preserved newer-than-`.enc` working file awaiting roll-forward at unlock
 *  (full-audit 2026-07-11 CODE-1b — see `preserveNewerPlaintext`). Deliberately matches
 *  none of `shredStalePlaintext`'s transient patterns (`.tmp` / `.parse` / `-wal` / `-shm`). */
export const RECOVERY_SUFFIX = '.recovery'

/**
 * Crash recovery for an encrypted vault: shred every leftover plaintext artifact a
 * killed run can leave behind — the working DB, its WAL/SHM sidecars, the atomic-write
 * `.tmp` files of encrypt/decryptFile, and transient decrypted document/image copies
 * (`*.parse*`/`*.tmp` under `workspace/documents/` and `workspace/images/`, written while
 * re-indexing or decrypting an encrypted copy). For an encrypted vault these are derived
 * from the `.enc` artifacts (the source of truth), so shredding loses nothing — with ONE
 * exception (full-audit 2026-07-11 CODE-1): after a FAILED lock (e.g. disk-full during the
 * re-encrypt) the cleanly-closed working file is NEWER than `.enc` and is the only fresh
 * copy of the session's data. Callers must run `preserveNewerPlaintext` FIRST (init() does),
 * which moves that one case aside as a `.recovery` snapshot this sweep never matches.
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
  for (const sub of ['documents', 'images']) {
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

/** A real SQLite database file starts with this 16-byte header. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000')

/** True when the file begins with the SQLite header (guards the CODE-1b roll-forward
 *  against garbage — e.g. a failed shred's random-overwrite whose unlink also failed). */
function fileHasSqliteHeader(path: string): boolean {
  const buf = Buffer.alloc(SQLITE_HEADER.length)
  const fd = openSync(path, 'r')
  try {
    const got = readSync(fd, buf, 0, buf.length, 0)
    return got === buf.length && buf.equals(SQLITE_HEADER)
  } finally {
    closeSync(fd)
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
 * failed-lock signature is deliberately narrow — every check must hold, else fall through
 * to the shred (today's behavior):
 *   • the working file is strictly NEWER than `.enc` (mtime) — else it is derived data;
 *   • NO live `-wal`/`-shm` sidecars — lock's checkpoint + close flushed and removed them.
 *     Live sidecars are the MID-SESSION crash state instead: the main file can be
 *     mid-checkpoint (torn), so rolling it forward could replace the intact stale `.enc`
 *     with garbage. That state stays shredded — the documented power-cut trade-off
 *     (docs/security-model.md "Lock failure & durability");
 *   • the file starts with the SQLite header — a failed shred's random-overwrite must
 *     never be re-encrypted over the good `.enc`.
 */
export function preserveNewerPlaintext(vaultPaths: VaultPaths): void {
  try {
    if (!existsSync(vaultPaths.dbPath) || !existsSync(vaultPaths.encPath)) return
    if (existsSync(`${vaultPaths.dbPath}-wal`) || existsSync(`${vaultPaths.dbPath}-shm`)) return
    if (statSync(vaultPaths.dbPath).mtimeMs <= statSync(vaultPaths.encPath).mtimeMs) return
    if (!fileHasSqliteHeader(vaultPaths.dbPath)) return
    renameSync(vaultPaths.dbPath, `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`)
  } catch {
    /* best-effort: on any doubt fall through to the sweep (today's behavior) */
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
  const swapOne = (staged: string): void => {
    const target = staged.slice(0, -REKEY_SUFFIX.length)
    shredFile(target)
    renameSync(staged, target)
  }
  let pending = stagedRekeyFiles(vaultPaths)
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
  // file, never mixed within a file).
  if (pending.length > 0) {
    throw lastErr instanceof Error ? lastErr : new Error('applyPendingRekey: incomplete swap')
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
  /** Encrypt the plaintext file at `srcPath` → framed ciphertext at `destPath`. SYNCHRONOUS —
   *  for the bounded, sync-reached paths (image-history via the vision emitter; text export). */
  encryptFile(srcPath: string, destPath: string): void
  /** Decrypt the framed ciphertext at `srcPath` → plaintext at `destPath`. SYNCHRONOUS. */
  decryptFile(srcPath: string, destPath: string): void
  /** Async encrypt (PERF-1): yields to the event loop between chunks. Use on the document-cache
   *  import/re-index path so a large import never freezes the main process. */
  encryptFileAsync(srcPath: string, destPath: string): Promise<void>
  /** Async decrypt (PERF-1): yields between chunks. Use on the import/preview/OCR read path. */
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

  // full-audit 2026-07-11 CODE-14 — crash-safe creation with the rekey-journal ordering:
  // build + seed + checkpoint the database, encrypt it STAGED as `.enc.new` (the rekey
  // journal's own suffix), and only then write the descriptor — the single atomic COMMIT
  // POINT (writeVaultDescriptor is fsync + rename). A crash BEFORE it leaves neither a
  // descriptor nor an `.enc`, so init() still reports `uninitialized` and onboarding
  // retries cleanly (the stray staged file is simply overwritten by the retry). A crash
  // AFTER it is the committed-rekey crash state: `recoverPendingRekey` rolls the staged
  // file forward on the next init()/unlock. The descriptor used to be written FIRST — a
  // crash mid-create then bricked onboarding behind the misleading "restore
  // workspace.json" hint (the actual repair was deleting it). NB the `legacyV1` fixture
  // path shares this ordering but not the roll-forward (recovery is v2-gated); it exists
  // only so tests can build migration fixtures — the app never passes it.
  const staged = `${vaultPaths.encPath}${REKEY_SUFFIX}`
  const db = openDatabase(vaultPaths.dbPath)
  seedSettings(db)
  updateSettings(db, { workspaceMode: 'encrypted' })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  encryptFile(vaultPaths.dbPath, staged, fileKey)
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
  writeVaultDescriptor(vaultPaths.descriptorPath, descriptor) // COMMIT POINT
  renameSync(staged, vaultPaths.encPath)
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
    // L-6: zero the KDF-derived key before throwing, for symmetry with the data-key paths
    // (which zero the KEK/old data keys after use). A wrong-password attempt should not
    // leave the derived key sitting in the heap.
    key.fill(0)
    throw new WrongPasswordError()
  }
  // v2 envelope: the derived key is only the KEK — unwrap the data key, drop the KEK.
  let fileKey = key
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
  // freshest data: a real SQLite file (header) strictly NEWER than `.enc` (mtime; a
  // missing `.enc` counts as older — restoring an unlockable vault beats none). Anything
  // else is a spent or corrupt leftover: shred it (retrying the failed unlink) and
  // unlock normally.
  const recoveryPath = `${vaultPaths.dbPath}${RECOVERY_SUFFIX}`
  if (existsSync(recoveryPath)) {
    const fresher =
      fileHasSqliteHeader(recoveryPath) &&
      (!existsSync(vaultPaths.encPath) ||
        statSync(recoveryPath).mtimeMs > statSync(vaultPaths.encPath).mtimeMs)
    if (fresher) encryptFile(recoveryPath, vaultPaths.encPath, fileKey)
    shredFile(recoveryPath)
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
export function lockEncryptedVault(
  vaultPaths: VaultPaths,
  db: Db,
  key: Buffer,
  /** Test seam (full-audit 2026-07-11 CODE-1): the lock path's re-encrypt boundary.
   *  Production callers omit it; tests inject a throwing impl to drive the lock-failure
   *  recovery without needing a genuinely full disk. */
  encryptFileImpl: typeof encryptFile = encryptFile
): void {
  // Flush WAL into the main file so the encrypted snapshot is complete, then close.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  } catch {
    /* checkpoint is best-effort; close still flushes */
  }
  db.close()
  encryptFileImpl(vaultPaths.dbPath, vaultPaths.encPath, key)
  shredFile(vaultPaths.dbPath)
  cleanSidecars(vaultPaths.dbPath)
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
    private readonly isDev: boolean,
    /** Test seam (full-audit 2026-07-11 CODE-1): the lock path's re-encrypt boundary,
     *  forwarded to `lockEncryptedVault`. Production callers omit it. */
    private readonly encryptFileImpl: typeof encryptFile = encryptFile
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
    return plaintextAllowed(this.policy, { isDev: this.isDev })
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
      // decrypted database (+ WAL/SHM) never lingers on disk. Safe — see shredStalePlaintext
      // — EXCEPT the failed-lock state (full-audit 2026-07-11 CODE-1b): a cleanly-closed
      // working file NEWER than `.enc` is the only fresh copy of the last session's data,
      // so it is moved aside FIRST and rolled forward at unlock instead of shredded.
      preserveNewerPlaintext(this.vaultPaths)
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
   * A `DocumentCipher` bound to the unlocked vault key, or null in plaintext mode /
   * while locked. Ingestion uses it to keep the imported-document cache encrypted at
   * rest (the cipher captures the key; it stops working only at process exit).
   */
  documentCipher(): DocumentCipher | null {
    const key = this.key
    if (!key || this._mode !== 'encrypted') return null
    return {
      encryptFile: (src, dest) => encryptFile(src, dest, key),
      decryptFile: (src, dest) => decryptFile(src, dest, key),
      encryptFileAsync: (src, dest) => encryptFileAsync(src, dest, key),
      decryptFileAsync: (src, dest) => decryptFileAsync(src, dest, key)
    }
  }

  /**
   * Lock the encrypted vault: re-encrypt the working file → `.enc` and shred the
   * plaintext. A no-op for `plaintext_dev` (nothing to protect, and closing it would
   * wedge the app back into onboarding) — the DB simply stays open until process exit.
   */
  lock(): WorkspaceStateInfo {
    if (this._db && this.key && this.descriptor?.mode === 'encrypted') {
      try {
        lockEncryptedVault(this.vaultPaths, this._db, this.key, this.encryptFileImpl)
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
        try {
          this._db = openDatabase(this.vaultPaths.dbPath)
        } catch {
          // Re-open is best-effort: if the disk is too broken even for that, keep the
          // closed handle — isUnlocked() stays true, so no unlock can decrypt the STALE
          // `.enc` over the newer working file this session, and the init() salvage
          // (CODE-1b) preserves + rolls the file forward on the next launch.
        }
        throw new VaultLockError()
      }
      // Zero the key bytes before dropping the reference — otherwise the 32-byte key
      // lingers in the heap until GC and could surface in a dump/swap.
      this.key.fill(0)
      this._db = null
      this.key = null
    }
    return this.getState()
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
