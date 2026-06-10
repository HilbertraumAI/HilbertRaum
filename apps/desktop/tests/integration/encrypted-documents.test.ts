import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  reindexDocument,
  deleteDocument,
  documentsDir,
  extractDocumentPreview,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import {
  encryptFile,
  decryptFile,
  shredStalePlaintext,
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  WorkspaceController,
  type DocumentCipher
} from '../../src/main/services/workspace-vault'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { KdfParams } from '../../src/main/services/security/crypto'

// H1 (audit round 4): spec §3.5 requires encrypting the workspace database AND the
// document cache. The vault used to cover only the DB — every imported file's raw bytes
// rested in plaintext under workspace/documents/. With a DocumentCipher supplied, the
// stored copy is `<id><ext>.enc` and any transient decrypted working copy is shredded.

const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const SECRET_TEXT = 'wholly confidential contract clause 7: severance of unicorns'

let srcDir: string
function writeSource(name: string, data: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, data)
  return p
}

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'paid-encdoc-src-'))
})

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-encdoc-db-')), 'test.sqlite'))
}

function freshStore(): string {
  return documentsDir(mkdtempSync(join(tmpdir(), 'paid-encdoc-ws-')))
}

/** A cipher equivalent to the unlocked vault's (same encryptFile/decryptFile, fixed key). */
function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFile: (src, dest) => encryptFile(src, dest, key),
    decryptFile: (src, dest) => decryptFile(src, dest, key)
  }
}

/** Every plaintext occurrence of SECRET_TEXT under `dir` (the store) is a leak. */
function plaintextLeaks(dir: string): string[] {
  return readdirSync(dir).filter((name) => {
    const data = readFileSync(join(dir, name))
    return data.includes(Buffer.from(SECRET_TEXT))
  })
}

describe('encrypted document cache (H1)', () => {
  it('stores the imported copy ENCRYPTED and still indexes the content', async () => {
    const db = freshDb()
    const store = freshStore()
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    const info = await processDocument(db, store, doc.id, { cipher: testCipher() })

    expect(info.status).toBe('indexed')
    expect(info.chunkCount).toBeGreaterThan(0)

    // The stored copy is the .enc artifact; nothing in the store leaks the plaintext.
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(plaintextLeaks(store)).toEqual([])

    // The chunk text (inside the - possibly encrypted - DB) still carries the content.
    const row = db
      .prepare('SELECT text FROM chunks WHERE document_id = ?')
      .get(doc.id) as unknown as { text: string }
    expect(row.text).toContain('severance of unicorns')
  })

  it('re-indexes from the encrypted copy and shreds the transient decrypted file', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })

    // Re-index must work even when the ORIGINAL is gone (self-contained drive): it
    // decrypts the stored .enc to a transient working file and parses that.
    const reinfo = await reindexDocument(db, store, doc.id, { cipher })
    expect(reinfo.status).toBe('indexed')
    expect(reinfo.chunkCount).toBeGreaterThan(0)

    // After the run: only the .enc remains — the `.parse` transient was shredded.
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(plaintextLeaks(store)).toEqual([])
  })

  it('previews from the encrypted copy without leaving plaintext behind (post-MVP)', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file) // original gone — preview must come from the self-contained .enc copy

    const preview = await extractDocumentPreview(db, store, doc.id, { cipher })
    expect(preview.segments.map((s) => s.text).join('\n')).toContain('severance of unicorns')

    // Only the .enc remains; the transient decrypted working file was shredded.
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(plaintextLeaks(store)).toEqual([])

    // Without the cipher (locked/plaintext context) the .enc is refused, not garbled.
    await expect(extractDocumentPreview(db, store, doc.id, {})).rejects.toThrow(/encrypted/)
  })

  it('migrates a legacy plaintext stored copy to .enc on re-index', async () => {
    const db = freshDb()
    const store = freshStore()
    const file = writeSource('contract.txt', SECRET_TEXT)

    // Imported WITHOUT a cipher (pre-H1 / plaintext mode): plaintext stored copy.
    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, {})
    expect(plaintextLeaks(store)).toHaveLength(1)

    // Re-index WITH a cipher (encrypted workspace): upgraded in place.
    const info = await reindexDocument(db, store, doc.id, { cipher: testCipher() })
    expect(info.status).toBe('indexed')
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(plaintextLeaks(store)).toEqual([])

    const row = db
      .prepare('SELECT stored_path FROM documents WHERE id = ?')
      .get(doc.id) as unknown as { stored_path: string }
    expect(row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
  })

  it('deleteDocument removes the encrypted stored copy', async () => {
    const db = freshDb()
    const store = freshStore()
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher: testCipher() })
    expect(readdirSync(store)).toHaveLength(1)

    deleteDocument(db, doc.id)
    expect(readdirSync(store)).toHaveLength(0)
  })
})

describe('WorkspaceController.documentCipher()', () => {
  function freshVaultRoot(): { vp: ReturnType<typeof vaultPathsFrom> } {
    const root = mkdtempSync(join(tmpdir(), 'paid-encdoc-vault-'))
    const configPath = join(root, 'config')
    const workspacePath = join(root, 'workspace')
    mkdirSync(configPath, { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
    return { vp: vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'paid.sqlite') }) }
  }

  it('is null while locked and in plaintext mode; round-trips files when unlocked', () => {
    const { vp } = freshVaultRoot()
    createEncryptedVaultOnDisk(vp, 'password', FAST_KDF)
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init()
    expect(ctl.documentCipher()).toBeNull() // locked

    ctl.unlock('password')
    const cipher = ctl.documentCipher()
    expect(cipher).not.toBeNull()

    const plain = join(srcDir, 'note.txt')
    writeFileSync(plain, SECRET_TEXT)
    const enc = join(srcDir, 'note.txt.enc')
    const back = join(srcDir, 'note-back.txt')
    cipher!.encryptFile(plain, enc)
    expect(readFileSync(enc).includes(Buffer.from(SECRET_TEXT))).toBe(false)
    cipher!.decryptFile(enc, back)
    expect(readFileSync(back, 'utf8')).toBe(SECRET_TEXT)
    ctl.lock()
  })

  it('is null for a plaintext_dev workspace', () => {
    const { vp } = freshVaultRoot()
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true)
    ctl.init() // dev + default policy → plaintext opens
    expect(ctl.isUnlocked()).toBe(true)
    expect(ctl.documentCipher()).toBeNull()
  })
})

describe('shredStalePlaintext — transient sweep (H1/M9)', () => {
  it('shreds the DB .tmp and stray .parse document transients, sparing stored copies', () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-encdoc-shred-'))
    const configPath = join(root, 'config')
    const workspacePath = join(root, 'workspace')
    mkdirSync(configPath, { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
    const vp = vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'paid.sqlite') })
    const docs = join(workspacePath, 'documents')
    mkdirSync(docs, { recursive: true })

    // Crash leftovers: decrypt temp of the DB + a transient decrypted document copy.
    writeFileSync(`${vp.dbPath}.tmp`, 'decrypted database bytes')
    writeFileSync(join(docs, 'abc.parse.pdf'), SECRET_TEXT)
    writeFileSync(join(docs, 'abc.pdf.enc.tmp'), 'partial encrypt')
    // A real stored copy that must survive the sweep.
    writeFileSync(join(docs, 'abc.pdf.enc'), 'ciphertext')

    shredStalePlaintext(vp)

    expect(existsSync(`${vp.dbPath}.tmp`)).toBe(false)
    expect(existsSync(join(docs, 'abc.parse.pdf'))).toBe(false)
    expect(existsSync(join(docs, 'abc.pdf.enc.tmp'))).toBe(false)
    expect(existsSync(join(docs, 'abc.pdf.enc'))).toBe(true)
  })
})
