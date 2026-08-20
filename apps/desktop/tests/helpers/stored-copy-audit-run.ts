import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve, sep } from 'node:path'
import { resolvePaths } from '../../src/main/services/workspace'
import {
  readVaultDescriptor,
  decryptFile,
  shredFile,
  RECOVERY_SUFFIX,
  REKEY_SUFFIX,
  type VaultDescriptor
} from '../../src/main/services/workspace-vault'
import { deriveKey, verifyKey, decrypt } from '../../src/main/services/security/crypto'
import {
  auditStoredCopies,
  formatStoredCopyAuditReport,
  type AuditDirEntry,
  type AuditRow,
  type StoredCopyAuditReport
} from './stored-copy-audit'

// Issue #190 — the READ-ONLY collector behind the stored-copy diagnostic.
//
// It gathers everything `auditStoredCopies` needs from a real (or synthetic) drive and hands it to
// the pure classifier. It is a test helper, not app code, on purpose: it must never ship in the
// bundle as dead code, and `tsconfig.web.json` already includes `tests/` so it stays typechecked.
//
// ============================ SAFETY CONTRACT ============================
// This may run against the ONLY copy of a user's data. Every rule below is load-bearing:
//
//  • NOTHING under `root` is ever opened for writing. The drive is touched with `existsSync`,
//    `statSync`, `readdirSync` and `copyFileSync`-as-SOURCE only.
//  • The vault lifecycle functions are NEVER called against the drive. `unlockEncryptedVault`
//    MUTATES: it runs `recoverPendingRekey` (which commits or discards staged rekeys and can roll
//    a `.recovery` forward OVER the `.enc`), and it decrypts a plaintext working DB onto the
//    drive. `openDatabase` runs `db.exec(SCHEMA)` plus ~20 `ensureColumn` calls, so merely opening
//    the database writes to it — which is also why `stored_name` may not exist here and is probed
//    with `PRAGMA table_info` instead of assumed.
//  • `config/workspace.json` and `workspace/hilbertraum.sqlite.enc` are COPIED to a scratch
//    directory outside the drive; the COPY is what gets decrypted and opened.
//  • The copy is opened `new DatabaseSync(path, { readOnly: true })` — supported on the repo's
//    Node floor (`engines.node >= 22.12`), which `stored-copy-audit.test.ts` proves in CI on the
//    22.x leg rather than taking on trust.
//  • The unlock is re-implemented over the copy by REUSING the shipped primitives
//    (`readVaultDescriptor`, `deriveKey`, `verifyKey`, `decrypt` for the v2 envelope unwrap,
//    `decryptFile`). No hand-rolled crypto.
//  • The scratch plaintext is shredded in a `finally`, and every key buffer is zeroed.
//
// `read-only-witness.ts` turns "never writes to the drive" from a claim into a CI assertion: the
// integration test fingerprints the whole drive tree before and after a run and requires it
// byte-identical.

/** Thrown when the supplied password does not open the vault. Content-free by design. */
export class AuditWrongPasswordError extends Error {
  constructor() {
    super('The workspace password did not open this vault')
    this.name = 'AuditWrongPasswordError'
  }
}

export interface AuditRunOptions {
  /** The drive root — the directory holding `config/` and `workspace/`. Never written to. */
  root: string
  /** Workspace password. Omit for a `plaintext_dev` workspace (no descriptor on disk). */
  password?: string
  /**
   * Where the scratch copy is made. MUST NOT be under `root` — a scratch inside the drive would
   * write the decrypted database onto the very medium this tool exists to leave untouched.
   */
  scratchRoot: string
}

export interface AuditRunResult {
  report: StoredCopyAuditReport
  /** The rendered, public-issue-safe text. */
  text: string
  /** Operational notes about the RUN itself (never about the data). */
  notes: string[]
}

/** True when `child` is `parent` or lives under it. Both are resolved first. */
export function isUnder(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  if (p === c) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** Read the descriptor's KDF salt + params and hand back the FILE key (v2: the unwrapped data
 *  key; v1: the password-derived key). The KEK is zeroed before returning. */
function fileKeyFor(descriptor: VaultDescriptor, password: string): Buffer {
  const salt = Buffer.from(descriptor.saltB64, 'base64')
  const kek = deriveKey(password, salt, descriptor.kdf)
  const verifier = {
    iv: Buffer.from(descriptor.verifier.ivB64, 'base64'),
    tag: Buffer.from(descriptor.verifier.tagB64, 'base64'),
    ciphertext: Buffer.from(descriptor.verifier.ciphertextB64, 'base64')
  }
  if (!verifyKey(kek, verifier)) {
    kek.fill(0)
    throw new AuditWrongPasswordError()
  }
  if (descriptor.dataKey) {
    const dataKey = decrypt(kek, {
      iv: Buffer.from(descriptor.dataKey.ivB64, 'base64'),
      tag: Buffer.from(descriptor.dataKey.tagB64, 'base64'),
      ciphertext: Buffer.from(descriptor.dataKey.ciphertextB64, 'base64')
    })
    kek.fill(0)
    return dataKey
  }
  return kek
}

/** Files (never directories) in `dir`, as leaf name + size. Missing dir ⇒ empty. */
function listFiles(dir: string): AuditDirEntry[] {
  const out: AuditDirEntry[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // no documents/ dir on this drive yet
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    let bytes = 0
    try {
      bytes = statSync(join(dir, e.name)).size
    } catch {
      /* raced or unreadable — count it, size unknown */
    }
    out.push({ name: e.name, bytes })
  }
  return out
}

/** Column names of `documents`, via a read-only PRAGMA (never `ensureColumn`). */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

/**
 * Collect + classify. Read-only with respect to `root`; everything it writes lives under a
 * freshly-made subdirectory of `scratchRoot`, which is shredded and removed before returning.
 */
export function runStoredCopyAudit(opts: AuditRunOptions): AuditRunResult {
  const notes: string[] = []
  if (!existsSync(opts.root)) throw new Error('The drive root does not exist')
  if (isUnder(opts.root, opts.scratchRoot)) {
    // The one mistake that would defeat every other guard in this file.
    throw new Error('The scratch directory must not be inside the drive root')
  }
  mkdirSync(opts.scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(opts.scratchRoot, 'hr-audit-'))

  // `resolvePaths` is pure (no mkdir) — `ensureWorkspaceDirs`/`documentsDir` are the ones that
  // create directories, and neither is called here.
  const paths = resolvePaths({ envRoot: opts.root, fallbackRoot: opts.root })
  const descriptorPath = join(paths.configPath, 'workspace.json')
  const encPath = `${paths.dbPath}.enc`
  const storeDir = join(paths.workspacePath, 'documents')

  const atRest = {
    recovery: existsSync(`${paths.dbPath}${RECOVERY_SUFFIX}`),
    wal: existsSync(`${paths.dbPath}-wal`),
    shm: existsSync(`${paths.dbPath}-shm`),
    dbRekeyStaged: existsSync(`${encPath}${REKEY_SUFFIX}`)
  }

  const descriptor = readVaultDescriptor(descriptorPath)
  const scratchDb = join(scratch, 'audit.sqlite')
  let fileKey: Buffer | null = null
  let db: DatabaseSync | null = null

  try {
    if (descriptor) {
      if (!existsSync(encPath)) {
        throw new Error('This workspace has a vault descriptor but no encrypted database')
      }
      if (!opts.password) throw new Error('This workspace is encrypted — a password is required')
      // Copy FIRST, decrypt the copy. `config/workspace.json` is copied too so the run is
      // reproducible from the scratch bundle alone if it ever needs re-examination.
      copyFileSync(descriptorPath, join(scratch, 'workspace.json'))
      const scratchEnc = join(scratch, 'audit.sqlite.enc')
      copyFileSync(encPath, scratchEnc)
      fileKey = fileKeyFor(descriptor, opts.password)
      decryptFile(scratchEnc, scratchDb, fileKey)
      notes.push(`decrypted a ${String(statSync(scratchEnc).size)}-byte copy in scratch`)
    } else {
      if (!existsSync(paths.dbPath)) {
        throw new Error('No workspace database found at this root (neither .enc nor plaintext)')
      }
      copyFileSync(paths.dbPath, scratchDb)
      // A plaintext_dev workspace can be at rest WITH a live WAL. Bring its sidecars along so the
      // copy is the same database the app would see; an encrypted vault never needs this (lock
      // checkpoints before it re-encrypts).
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${paths.dbPath}${suffix}`)) {
          copyFileSync(`${paths.dbPath}${suffix}`, `${scratchDb}${suffix}`)
        }
      }
      notes.push('plaintext_dev workspace — no password needed')
    }

    try {
      db = new DatabaseSync(scratchDb, { readOnly: true })
      db.prepare('SELECT 1').get()
    } catch (err) {
      // SQLite cannot replay a WAL through a read-only handle. Recover ON THE SCRATCH COPY —
      // writing there is explicitly allowed and the drive is not involved — then re-open
      // read-only so the query path keeps its guarantee.
      db?.close()
      db = null
      if (!existsSync(`${scratchDb}-wal`)) throw err
      const rw = new DatabaseSync(scratchDb)
      rw.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      rw.close()
      db = new DatabaseSync(scratchDb, { readOnly: true })
      notes.push('a live -wal was checkpointed ON THE SCRATCH COPY before the read-only open')
    }

    const cols = columnsOf(db, 'documents')
    const hasStoredName = cols.has('stored_name')
    // The reporting drive predates #189, where `stored_name` is added by `ensureColumn` at open —
    // which this tool must not trigger. A naive `SELECT ... stored_name` throws there.
    const select = [
      'id',
      'status',
      'stored_path',
      hasStoredName ? 'stored_name' : "NULL AS stored_name",
      'original_path',
      'mime_type'
    ].join(', ')
    const raw = db.prepare(`SELECT ${select} FROM documents`).all() as Array<
      Record<string, string | null>
    >
    const rows: AuditRow[] = raw.map((r) => ({
      id: String(r.id),
      status: String(r.status ?? ''),
      stored_path: r.stored_path ?? null,
      // `undefined` (column absent) and `null` (column present, row unhealed) are different
      // findings and the report distinguishes them.
      stored_name: hasStoredName ? (r.stored_name ?? null) : undefined,
      original_path: r.original_path ?? null,
      mime_type: r.mime_type ?? null
    }))

    const dirEntries = listFiles(storeDir)
    const existingRecordedPaths = rows
      .map((r) => r.stored_path)
      .filter((p): p is string => Boolean(p))
      .filter((p) => {
        try {
          return existsSync(p)
        } catch {
          return false
        }
      })

    const report = auditStoredCopies({
      rows,
      dirEntries,
      existingRecordedPaths,
      storedNameColumn: hasStoredName,
      descriptorVersion: descriptor ? descriptor.version : null,
      atRest
    })
    return { report, text: formatStoredCopyAuditReport(report), notes }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
    if (fileKey) fileKey.fill(0)
    // Shred every scratch artifact that could hold plaintext, then drop the directory. The shred
    // is the same overwrite-then-unlink the app uses; `rmSync` alone would leave the bytes.
    for (const name of ['audit.sqlite', 'audit.sqlite-wal', 'audit.sqlite-shm', 'audit.sqlite.enc', 'audit.sqlite.tmp', 'workspace.json']) {
      try {
        shredFile(join(scratch, name))
      } catch {
        /* best-effort */
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
