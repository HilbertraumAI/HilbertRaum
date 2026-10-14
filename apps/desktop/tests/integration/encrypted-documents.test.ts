import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  reindexDocument,
  documentsDir,
  extractDocumentPreview,
  readStoredDocumentBytes,
  readStoredDocumentText,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  WorkspaceController
} from '../../src/main/services/workspace-vault'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { recordingCipher, testCipher } from '../helpers/test-cipher'
import { openFreshDb, tempRoot } from '../helpers/db-fixtures'

// H1 (audit round 4): spec §3.5 requires encrypting the workspace database AND the
// document cache. The vault used to cover only the DB — every imported file's raw bytes
// rested in plaintext under workspace/documents/. With a DocumentCipher supplied, the
// stored copy is `<id><ext>.enc` and any transient decrypted working copy is shredded.
// DB-2/DB-7: concurrent reads of one copy each decrypt into their own `.parse` transient.

const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const SECRET_TEXT = 'wholly confidential contract clause 7: severance of unicorns'

let srcDir: string
function writeSource(name: string, data: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, data)
  return p
}

beforeEach(() => {
  srcDir = tempRoot('encdoc-src')
})

function freshDb(): Db {
  return openFreshDb('encdoc-db')
}

function freshStore(): string {
  return documentsDir(tempRoot('encdoc-ws'))
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

  it("re-indexes from the encrypted copy (not the user's original) and shreds the transient decrypted file", async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })

    // The user's original changed after the import. Re-index must read the stored .enc (D5: the
    // workspace copy first), never the file that happens to sit at original_path.
    writeFileSync(file, 'an unrelated edit made after the import')
    const reinfo = await reindexDocument(db, store, doc.id, { cipher })
    expect(reinfo.status).toBe('indexed')
    expect(reinfo.chunkCount).toBeGreaterThan(0)
    const texts = (db.prepare('SELECT text FROM chunks WHERE document_id = ?').all(doc.id) as Array<{ text: string }>)
      .map((r) => r.text)
      .join('\n')
    expect(texts).toContain('severance of unicorns')
    expect(texts).not.toContain('unrelated edit')

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
})

// DB-2 / DB-7: concurrent reads of ONE encrypted copy each decrypt into their own `.parse`
// transient (the crash sweep matches `.parse`), asynchronously (PERF-1), and read the plaintext.
describe('concurrent reads of one encrypted copy (DB-2 / DB-7)', () => {
  // A single-macrotask hop with no observable to gate on: it parks each decrypt so the second
  // read starts before the first finishes — the interleave both rows are about.
  const hop = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const inStoreParse = (store: string, dests: string[]): void => {
    for (const d of dests) {
      expect(dirname(d)).toBe(store)
      expect(basename(d)).toContain('.parse')
    }
  }

  it('DB-2: concurrent same-doc previews decrypt into distinct .parse transients, each reads the plaintext, and only the .enc remains', async () => {
    const db = freshDb()
    const store = freshStore()
    const rec = recordingCipher({ beforeDecryptAsync: hop })
    const doc = createQueuedDocument(db, writeSource('contract.txt', SECRET_TEXT))
    await processDocument(db, store, doc.id, { cipher: rec.cipher })
    const before = rec.asyncDecrypts.length
    const [a, b] = await Promise.all([
      extractDocumentPreview(db, store, doc.id, { cipher: rec.cipher }),
      extractDocumentPreview(db, store, doc.id, { cipher: rec.cipher })
    ])
    for (const p of [a, b]) expect(p.segments.map((s) => s.text).join('\n')).toContain('severance of unicorns')
    const dests = rec.asyncDecrypts.slice(before)
    expect(dests).toHaveLength(2)
    expect(new Set(dests).size).toBe(2) // TEETH: a shared `${id}.parse-preview.txt` collapses this to 1
    inStoreParse(store, dests)
    expect(readdirSync(store)).toEqual([`${doc.id}.txt${ENCRYPTED_DOC_SUFFIX}`])
    expect(plaintextLeaks(store)).toEqual([])
  })

  it('DB-7: concurrent text exports decrypt asynchronously (never the sync decryptFile) into distinct transients and return the plaintext', async () => {
    const db = freshDb()
    const store = freshStore()
    const rec = recordingCipher({ beforeDecryptAsync: hop })
    const doc = createQueuedDocument(db, writeSource('contract.txt', SECRET_TEXT))
    await processDocument(db, store, doc.id, { cipher: rec.cipher })
    const before = rec.asyncDecrypts.length
    const [a, b] = await Promise.all([
      readStoredDocumentText(db, store, doc.id, { cipher: rec.cipher }),
      readStoredDocumentText(db, store, doc.id, { cipher: rec.cipher })
    ])
    expect(a.text).toBe(SECRET_TEXT)
    expect(b.text).toBe(SECRET_TEXT)
    expect(rec.syncDecrypts).toBe(0) // TEETH (PERF-1): the sync decryptFile blocks the main process
    const dests = rec.asyncDecrypts.slice(before)
    expect(dests).toHaveLength(2)
    expect(new Set(dests).size).toBe(2)
    inStoreParse(store, dests)
    expect(readdirSync(store)).toEqual([`${doc.id}.txt${ENCRYPTED_DOC_SUFFIX}`])
    expect(plaintextLeaks(store)).toEqual([])
  })
})

describe('WorkspaceController.documentCipher()', () => {
  function freshVaultRoot(): { vp: ReturnType<typeof vaultPathsFrom> } {
    const root = tempRoot('encdoc-vault')
    const configPath = join(root, 'config')
    const workspacePath = join(root, 'workspace')
    mkdirSync(configPath, { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
    return { vp: vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') }) }
  }

  it('is null while locked; round-trips files when unlocked', () => {
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

// ---- Issue #90: the original-bytes export reader against a REAL encrypted store ----------
// `readStoredDocumentBytes` (the D77 reader the new `docs:exportOriginal` channel reuses) must
// return the imported file's exact bytes from the `.enc` copy under real AES-256-GCM, shred its
// decrypt transient, and refuse without a cipher — the H1 plaintext-leak rules apply throughout.
describe('original-bytes export from an encrypted store (#90)', () => {
  it('returns the ORIGINAL bytes from the .enc copy (real cipher) and leaks no plaintext', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const file = writeSource('contract.txt', SECRET_TEXT)
    const original = readFileSync(file)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    // Self-contained drive posture: the import source is gone; only the `.enc` copy serves.
    rmSync(file)

    const { title, bytes } = await readStoredDocumentBytes(db, store, doc.id, { cipher })
    expect(title).toBe('contract.txt')
    expect(bytes.equals(original)).toBe(true)

    // The `.parse-export-bin-*` decrypt transient was shredded on the way out: the store
    // holds exactly the `.enc` artifact and no plaintext SECRET_TEXT anywhere.
    const stored = readdirSync(store)
    expect(stored).toHaveLength(1)
    expect(stored[0].endsWith(ENCRYPTED_DOC_SUFFIX)).toBe(true)
    expect(plaintextLeaks(store)).toEqual([])
  })

  it('refuses without a cipher (locked workspace) instead of serving ciphertext', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher = testCipher()
    const file = writeSource('contract.txt', SECRET_TEXT)
    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)

    await expect(readStoredDocumentBytes(db, store, doc.id)).rejects.toThrow(
      /unlock the workspace/i
    )
  })
})
