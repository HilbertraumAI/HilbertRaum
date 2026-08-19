import { describe, it, expect, beforeEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createEncryptedVaultOnDisk,
  encryptFile,
  lockEncryptedVault,
  shredFile,
  unlockEncryptedVault,
  vaultPathsFrom,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { runStoredCopyAudit, isUnder, AuditWrongPasswordError } from '../helpers/stored-copy-audit-run'
import { fingerprintTree, treeUnchanged } from '../helpers/read-only-witness'

// Issue #190 — end-to-end CI proof for the stored-copy diagnostic against a SYNTHETIC vault.
//
// The unit suite proves the classifier's arithmetic on hand-built inputs. This proves the part
// that actually touches a drive: copy → decrypt the copy → open read-only → probe the schema →
// query → walk `workspace/documents/` → classify → shred the scratch. It plants a known
// population — healthy rows, stale rows, healable rows, genuine orphans, and ONE OF EACH
// transient class — and asserts exact counts.
//
// It also asserts the safety contract itself, which is the reason this file exists rather than
// leaving the collector exercised only by the hardware-gated manual harness: the drive tree is
// fingerprinted before and after the run (path + size + mtime of every entry) and must come back
// IDENTICAL. That is what would catch an accidental `openDatabase` (schema + ~20 `ensureColumn`
// writes), an `unlockEncryptedVault` (decrypts a plaintext DB onto the drive and can roll a
// `.recovery` forward over the `.enc`), or a scratch path that landed inside the drive.

const PASSWORD = 'correct-horse-battery-staple-190'

/** A secret that must never reach the report — the titles and content of the planted documents. */
const SECRET_TITLE = 'Scheidungsvereinbarung-Muster-vertraulich.pdf'
const SECRET_TEXT = 'clause 7: the unicorn stable remains with the petitioner'

let root: string
let scratchRoot: string
let vaultPaths: VaultPaths
let storeDir: string

function paths(r: string): VaultPaths {
  return vaultPathsFrom({
    configPath: join(r, 'config'),
    dbPath: join(r, 'workspace', 'hilbertraum.sqlite')
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hr-190-drive-'))
  scratchRoot = mkdtempSync(join(tmpdir(), 'hr-190-scratch-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  vaultPaths = paths(root)
  storeDir = join(root, 'workspace', 'documents')
  mkdirSync(storeDir, { recursive: true })
})

/** Write a plaintext file into the store dir and return its leaf. */
function plantPlain(leaf: string, content: string): string {
  writeFileSync(join(storeDir, leaf), content)
  return leaf
}

/** Encrypt `content` into the store dir under `leaf` with the vault's file key. */
function plantEncrypted(leaf: string, content: string, key: Buffer): string {
  const tmp = join(scratchRoot, `plant-${randomUUID()}`)
  writeFileSync(tmp, content)
  try {
    encryptFile(tmp, join(storeDir, leaf), key)
  } finally {
    shredFile(tmp)
  }
  return leaf
}

interface PlantedRow {
  id: string
  title: string
  storedPath: string | null
  storedName?: string | null
  originalPath?: string | null
  mime?: string | null
  status?: string
}

function insertRows(db: Db, rows: PlantedRow[]): void {
  const now = new Date().toISOString()
  for (const r of rows) {
    db.prepare(
      `INSERT INTO documents (id, title, original_path, stored_path, stored_name, mime_type,
         size_bytes, sha256, status, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      r.id,
      r.title,
      r.originalPath ?? null,
      r.storedPath,
      r.storedName ?? null,
      r.mime ?? null,
      null,
      null,
      r.status ?? 'indexed',
      null,
      now,
      now
    )
  }
}

describe('#190 stored-copy diagnostic — an encrypted vault with a known population', () => {
  // The planted population, fixed so the expected counts below are exact.
  const healthy = randomUUID() // resolves exactly where the row says
  const stale = randomUUID() // recorded under the OLD mount point, copy still canonical
  const gone = randomUUID() // recorded, and the copy is nowhere
  const queued = randomUUID() // never stored a copy
  const audio = randomUUID() // healthy audio — the checkbox-3 hypothesis
  const orphanA = randomUUID() // a copy left by the pre-#189 delete no-op
  const orphanB = randomUUID() // ditto
  const staged = randomUUID() // a live document mid-password-change
  const transient = randomUUID() // an in-flight import

  function buildVault(): void {
    createEncryptedVaultOnDisk(vaultPaths, PASSWORD)
    const vault = unlockEncryptedVault(vaultPaths, PASSWORD)
    try {
      insertRows(vault.db, [
        {
          id: healthy,
          title: SECRET_TITLE,
          storedPath: join(storeDir, `${healthy}.pdf.enc`),
          storedName: `${healthy}.pdf.enc`,
          originalPath: join(root, 'nowhere', SECRET_TITLE)
        },
        // The #188 signature: the row still names `H:\…`, the bytes are in the CURRENT store dir.
        {
          id: stale,
          title: SECRET_TITLE,
          storedPath: `H:\\workspace\\documents\\${stale}.docx.enc`
        },
        { id: gone, title: SECRET_TITLE, storedPath: `H:\\workspace\\documents\\${gone}.txt.enc` },
        { id: queued, title: SECRET_TITLE, storedPath: null, status: 'queued', mime: 'application/pdf' },
        {
          id: audio,
          title: SECRET_TITLE,
          storedPath: join(storeDir, `${audio}.wav.enc`),
          storedName: `${audio}.wav.enc`
        },
        // The document whose rekey is staged — it has a row, so its `.enc` is NOT an orphan and
        // its `.enc.new` must not be counted as one either.
        {
          id: staged,
          title: SECRET_TITLE,
          storedPath: join(storeDir, `${staged}.pdf.enc`),
          storedName: `${staged}.pdf.enc`
        }
      ])
      // Store copies, encrypted under the real vault file key.
      plantEncrypted(`${healthy}.pdf.enc`, SECRET_TEXT, vault.key)
      plantEncrypted(`${stale}.docx.enc`, SECRET_TEXT, vault.key)
      plantEncrypted(`${audio}.wav.enc`, SECRET_TEXT, vault.key)
      plantEncrypted(`${staged}.pdf.enc`, SECRET_TEXT, vault.key)
      // The orphans: `.enc` files whose rows were committed-deleted while the shred no-opped.
      plantEncrypted(`${orphanA}.pdf.enc`, SECRET_TEXT, vault.key)
      plantEncrypted(`${orphanB}.wav.enc`, SECRET_TEXT, vault.key)
      // One of each transient class.
      plantEncrypted(`${staged}.pdf.enc.new`, SECRET_TEXT, vault.key) // stageRekey
      plantPlain(`${transient}.parse-preview-${randomUUID()}.pdf`, SECRET_TEXT) // preview
      plantPlain(`${randomUUID()}.parse-dictation.wav`, SECRET_TEXT) // dictation
      plantPlain(`${transient}.parse-ocr.pdf`, SECRET_TEXT) // doc task
      plantPlain(`${transient}.pdf.enc.tmp`, SECRET_TEXT) // encryptFile temp
      plantPlain('stray-note.txt', SECRET_TEXT) // an unknown writer
    } finally {
      lockEncryptedVault(vaultPaths, vault.db, vault.key)
    }
  }

  it('reports the exact stale / healable / missing / orphan counts', () => {
    buildVault()
    const { report } = runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })

    expect(report.documents.total).toBe(6)
    expect(report.documents.byStatus).toEqual({ indexed: 5, queued: 1 })

    // (2)/(3) — the staleness verdict. `stale` and `gone` both name `H:\…`; only `stale` has its
    // bytes at the canonical location, which is exactly the question the reporting drive poses.
    expect(report.rows.stale).toBe(2)
    expect(report.rows.healable).toBe(1)
    expect(report.rows.missingEverywhere).toBe(1)
    expect(report.rows.neverStored).toBe(1)
    expect(report.rows.resolvedAsRecorded).toBe(3)

    // (5) — the orphan count, the number issue #190 checkbox 2 is waiting on.
    expect(report.orphans.count).toBe(2)
    expect(report.orphans.bytes).toBeGreaterThan(0)
    expect(report.orphans.tokens.map((t) => t.split(' ')[0]).sort()).toEqual(
      [orphanA.slice(0, 8), orphanB.slice(0, 8)].sort()
    )

    // (6) — file classes. 6 stored copies on disk (4 owned + 2 orphaned), one of each transient.
    expect(report.fileClasses['stored-copy'].count).toBe(6)
    expect(report.fileClasses['rekey-staged'].count).toBe(1)
    expect(report.fileClasses['write-temp'].count).toBe(1)
    expect(report.fileClasses['parse-transient'].count).toBe(3)
    expect(report.fileClasses.unknown.count).toBe(1)

    // (7) — the extension histogram, and the one audio row that settles the #188 contradiction.
    expect(report.extensions).toEqual({ pdf: 3, docx: 1, txt: 1, wav: 1 })
    expect(report.audioRows).toBe(1)

    // (8)/(9)
    expect(report.storedName).toEqual({ column: true, populated: 3 })
    expect(report.vault).toEqual({ descriptorVersion: 2, mode: 'encrypted' })
    expect(report.atRest).toEqual({ recovery: false, wal: false, shm: false, dbRekeyStaged: false })
  })

  it('does not write a single byte to the drive', () => {
    buildVault()
    const before = fingerprintTree(root)
    runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })
    const after = fingerprintTree(root)
    expect(treeUnchanged(before, after), 'the diagnostic must leave the drive untouched').toBe(true)
    // Specifically: no plaintext working DB, and the `.enc` is byte-identical.
    expect(existsSync(vaultPaths.dbPath)).toBe(false)
    expect(existsSync(`${vaultPaths.dbPath}-wal`)).toBe(false)
  })

  it('leaves no scratch artifact behind', () => {
    buildVault()
    runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })
    expect(readdirSync(scratchRoot)).toEqual([])
  })

  it('the rendered report contains no title and no document content', () => {
    buildVault()
    const { text } = runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })
    expect(text).not.toContain(SECRET_TITLE)
    expect(text).not.toContain('Scheidungsvereinbarung')
    expect(text).not.toContain(SECRET_TEXT)
    expect(text).not.toContain('unicorn')
    expect(text).not.toContain(root) // no user paths
    expect(text).not.toContain('H:\\')
    expect(text).not.toContain(healthy) // full ids never appear
    expect(text).toContain(healthy.slice(0, 8)) // 8-char shape prefixes do
  })

  it('refuses a wrong password without touching the drive', () => {
    buildVault()
    const before = fingerprintTree(root)
    expect(() => runStoredCopyAudit({ root, password: 'wrong', scratchRoot })).toThrow(
      AuditWrongPasswordError
    )
    expect(treeUnchanged(before, fingerprintTree(root))).toBe(true)
  })

  it('refuses a scratch directory inside the drive root', () => {
    // The one mistake that would defeat every other guard: the decrypted copy would land on the
    // very medium the tool exists to leave alone.
    buildVault()
    expect(() =>
      runStoredCopyAudit({ root, password: PASSWORD, scratchRoot: join(root, 'scratch') })
    ).toThrow(/must not be inside the drive root/)
    expect(existsSync(join(root, 'scratch'))).toBe(false)
  })

  it('reports an interrupted password change and an unclean session as separate findings', () => {
    buildVault()
    // A staged DB rekey and a `.recovery` snapshot, each its own finding (report item 10).
    writeFileSync(`${vaultPaths.encPath}.new`, 'staged')
    writeFileSync(`${vaultPaths.dbPath}.recovery`, 'preserved')
    writeFileSync(`${vaultPaths.dbPath}-wal`, 'wal')
    const { report, text } = runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })
    expect(report.atRest).toEqual({ recovery: true, wal: true, shm: false, dbRekeyStaged: true })
    expect(text).toContain('interrupted password change')
    // And crucially it did NOT act on any of them — `recoverPendingRekey` was never invoked.
    expect(readFileSync(`${vaultPaths.encPath}.new`, 'utf8')).toBe('staged')
    expect(readFileSync(`${vaultPaths.dbPath}.recovery`, 'utf8')).toBe('preserved')
  })
})

describe('#190 stored-copy diagnostic — a v1 vault and a plaintext_dev workspace', () => {
  it('unwraps a legacy v1 descriptor (direct key, no envelope)', () => {
    // v1 vs v2 is report item 9 because it decides the password-change blast radius: a v1 vault's
    // first password change re-encrypts the whole corpus, so every orphan is re-encrypted too.
    createEncryptedVaultOnDisk(vaultPaths, PASSWORD, undefined, { legacyV1: true })
    const vault = unlockEncryptedVault(vaultPaths, PASSWORD)
    const id = randomUUID()
    try {
      insertRows(vault.db, [
        { id, title: SECRET_TITLE, storedPath: join(storeDir, `${id}.pdf.enc`), storedName: `${id}.pdf.enc` }
      ])
      plantEncrypted(`${id}.pdf.enc`, SECRET_TEXT, vault.key)
    } finally {
      lockEncryptedVault(vaultPaths, vault.db, vault.key)
    }
    const before = fingerprintTree(root)
    const { report } = runStoredCopyAudit({ root, password: PASSWORD, scratchRoot })
    expect(treeUnchanged(before, fingerprintTree(root))).toBe(true)
    expect(report.vault).toEqual({ descriptorVersion: 1, mode: 'encrypted' })
    expect(report.documents.total).toBe(1)
    expect(report.orphans.count).toBe(0)
  })

  it('audits a plaintext_dev workspace with no password at all', () => {
    const db = openDatabase(vaultPaths.dbPath)
    const id = randomUUID()
    const orphan = randomUUID()
    insertRows(db, [
      { id, title: SECRET_TITLE, storedPath: join(storeDir, `${id}.pdf`), storedName: `${id}.pdf` }
    ])
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    plantPlain(`${id}.pdf`, SECRET_TEXT)
    plantPlain(`${orphan}.pdf`, SECRET_TEXT) // a plaintext orphan — no `.enc` suffix to key on
    const before = fingerprintTree(root)
    const { report, text } = runStoredCopyAudit({ root, scratchRoot })
    // The plaintext branch has its OWN witness: it copies the LIVE working DB, so an accidental
    // `openDatabase` there would rewrite the schema of the user's actual database.
    expect(treeUnchanged(before, fingerprintTree(root))).toBe(true)
    expect(report.vault).toEqual({ descriptorVersion: null, mode: 'plaintext_dev' })
    expect(report.orphans.count).toBe(1)
    expect(report.orphans.tokens[0].startsWith(orphan.slice(0, 8))).toBe(true)
    expect(text).not.toContain(SECRET_TEXT)
  })

  it('handles a DB with no stored_name column at all (the pre-#189 schema)', () => {
    // The reporting drive predates #189. `stored_name` is added by `ensureColumn` AT OPEN, which
    // the diagnostic must never trigger — so a naive `SELECT ... stored_name` throws on the one
    // machine that matters. Reproduced by dropping the column from a built schema.
    const db = openDatabase(vaultPaths.dbPath)
    const id = randomUUID()
    insertRows(db, [{ id, title: SECRET_TITLE, storedPath: join(storeDir, `${id}.pdf`) }])
    db.exec('ALTER TABLE documents DROP COLUMN stored_name')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    plantPlain(`${id}.pdf`, SECRET_TEXT)

    const { report, text } = runStoredCopyAudit({ root, scratchRoot })
    expect(report.storedName).toEqual({ column: false, populated: 0 })
    expect(report.documents.total).toBe(1)
    expect(report.rows.resolvedAsRecorded).toBe(1)
    expect(text).toContain('ABSENT (pre-#189 schema)')
  })
})

describe('#190 stored-copy diagnostic — scratch containment', () => {
  it('isUnder recognises the drive root, a child, and a sibling with a shared prefix', () => {
    const base = mkdtempSync(join(tmpdir(), 'hr-190-under-'))
    try {
      expect(isUnder(base, base)).toBe(true)
      expect(isUnder(base, join(base, 'a', 'b'))).toBe(true)
      // `H:\driveX` must not count as inside `H:\drive` — a plain `startsWith` says it does.
      expect(isUnder(base, `${base}-sibling`)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
