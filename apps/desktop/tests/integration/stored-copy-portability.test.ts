import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  processDocument,
  reindexDocument,
  deleteDocument,
  documentsDir,
  extractDocumentPreview,
  readStoredDocumentBytes,
  readStoredDocumentText,
  listDocuments,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import {
  encryptFile,
  decryptFile,
  encryptFileAsync,
  decryptFileAsync,
  type DocumentCipher
} from '../../src/main/services/workspace-vault'

// Issue #188 — `documents.stored_path` was persisted ABSOLUTE, so a portable drive that came
// back under a different mount point (H: → E:, or a Windows letter ↔ /Volumes/…) had EVERY
// stored copy go stale at once: the row is fine, the bytes are fine, only the recorded string
// is wrong. The stored copy is named DETERMINISTICALLY (`<id><ext>[.enc]`) inside the CURRENT
// store dir, so it is always recoverable — the resolver recomputes it and heals the row.
//
// A "relocated drive" is reproduced here by physically MOVING the store directory and calling
// the readers with the new path, which is exactly what a different drive letter looks like to
// the code: same bytes, same names, a `stored_path` that no longer resolves.

const SECRET_TEXT = 'wholly confidential contract clause 7: severance of unicorns'

let srcDir: string

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'hilbertraum-portability-src-'))
})

function writeSource(name: string, data: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, data)
  return p
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-portability-db-')), 'test.sqlite'))
}

/** A workspace root; `documentsDir` makes the `documents/` child under it. */
function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-portability-ws-'))
}

function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFile: (src, dest) => encryptFile(src, dest, key),
    decryptFile: (src, dest) => decryptFile(src, dest, key),
    encryptFileAsync: (src, dest) => encryptFileAsync(src, dest, key),
    decryptFileAsync: (src, dest) => decryptFileAsync(src, dest, key)
  }
}

/**
 * Simulate the drive coming back under a different mount point: move `workspace/documents/`
 * to a brand-new workspace root and return the NEW store dir. The DB is untouched, so every
 * `stored_path` in it now names a directory that no longer exists — the #188 condition.
 */
function relocateStore(oldStore: string): string {
  const newWorkspace = freshWorkspace()
  const newStore = join(newWorkspace, 'documents')
  renameSync(oldStore, newStore)
  expect(existsSync(oldStore)).toBe(false)
  return newStore
}

function storedPathOf(db: Db, id: string): string | null {
  const row = db.prepare('SELECT stored_path FROM documents WHERE id = ?').get(id) as unknown as
    | { stored_path: string | null }
    | undefined
  return row?.stored_path ?? null
}

describe('#188 — a relocated drive must not lose its stored copies (encrypted)', () => {
  it('T1: exports the ORIGINAL bytes after the store dir moved', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file) // the ORIGINAL is on the other laptop — only the stored copy remains

    const moved = relocateStore(store)

    const { bytes } = await readStoredDocumentBytes(db, moved, doc.id, { cipher })
    expect(bytes.toString('utf8')).toContain('severance of unicorns')
  })

  it('T1b: exports the stored TEXT and previews after the store dir moved', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)
    const moved = relocateStore(store)

    const { text } = await readStoredDocumentText(db, moved, doc.id, { cipher })
    expect(text).toContain('severance of unicorns')

    const preview = await extractDocumentPreview(db, moved, doc.id, { cipher })
    expect(preview.segments.map((s) => s.text).join('\n')).toContain('severance of unicorns')

    // No transient decrypted plaintext survives the relocated reads.
    expect(readdirSync(moved).filter((n) => n.includes('.parse'))).toEqual([])
  })

  it('T6: re-index after the move succeeds and does NOT flip the row to failed', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)
    const moved = relocateStore(store)

    const info = await reindexDocument(db, moved, doc.id, { cipher })
    expect(info.errorMessage).toBeNull()
    expect(info.status).toBe('indexed')
    expect(info.chunkCount).toBeGreaterThan(0)
  })
})

describe('#188 — a relocated drive must not lose its stored copies (plaintext)', () => {
  it('T2: exports the ORIGINAL bytes after the store dir moved, no cipher', async () => {
    const db = freshDb()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, {})
    rmSync(file)
    const moved = relocateStore(store)

    const { bytes } = await readStoredDocumentBytes(db, moved, doc.id, {})
    expect(bytes.toString('utf8')).toContain('severance of unicorns')
  })
})

describe('#188 — DELETE must actually delete on a relocated drive', () => {
  it('T3: shreds the stored copy after the store dir moved (privacy, not disk space)', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)
    const moved = relocateStore(store)
    expect(readdirSync(moved)).toHaveLength(1) // the .enc copy is right there

    deleteDocument(db, moved, doc.id)

    // The DB rows are gone AND the encrypted bytes are gone. Before the fix the shred
    // silently no-opped and left the user's content on the drive forever, with no row
    // left to ever reference it again.
    expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(doc.id)).toBeUndefined()
    expect(readdirSync(moved)).toEqual([])
  })

  it('T3b: still deletes cleanly when the stored copy really is gone', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    for (const n of readdirSync(store)) rmSync(join(store, n))

    expect(() => deleteDocument(db, store, doc.id)).not.toThrow()
    expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(doc.id)).toBeUndefined()
  })

  it('T3c: never shreds a file belonging to a DIFFERENT document', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())

    const a = createQueuedDocument(db, writeSource('a.txt', 'alpha content here'))
    await processDocument(db, store, a.id, { cipher })
    const b = createQueuedDocument(db, writeSource('b.txt', 'beta content here'))
    await processDocument(db, store, b.id, { cipher })

    const moved = relocateStore(store)
    expect(readdirSync(moved)).toHaveLength(2)

    deleteDocument(db, moved, a.id)

    const left = readdirSync(moved)
    expect(left).toHaveLength(1)
    expect(left[0].startsWith(b.id)).toBe(true)
  })
})

describe('#188 — legacy rows carrying a foreign absolute path', () => {
  it('T4: resolves a row whose stored_path names a drive that does not exist, and heals it', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)

    // Rewrite the row the way a drive imported on ANOTHER machine looks: a plausible,
    // well-formed absolute path under a mount point that is not here. The file itself
    // stays exactly where it is.
    const realName = basename(storedPathOf(db, doc.id) as string)
    const foreign = join('Z:', 'old-drive', 'workspace', 'documents', realName)
    db.prepare('UPDATE documents SET stored_path = ? WHERE id = ?').run(foreign, doc.id)

    const { bytes } = await readStoredDocumentBytes(db, store, doc.id, { cipher })
    expect(bytes.toString('utf8')).toContain('severance of unicorns')

    // D3: the row is HEALED in place, so the next read costs nothing extra.
    expect(storedPathOf(db, doc.id)).toBe(join(store, realName))
  })

  it('T5: a genuinely absent stored copy still fails loudly, and delete does not throw', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)
    for (const n of readdirSync(store)) rmSync(join(store, n))

    await expect(readStoredDocumentBytes(db, store, doc.id, { cipher })).rejects.toThrow()
    expect(listDocuments(db, null, store).find((d) => d.id === doc.id)?.storedCopy).toBe('missing')
  })

  it('T5b: listDocuments reports a present stored copy on a relocated drive', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    rmSync(file)
    const moved = relocateStore(store)

    expect(listDocuments(db, null, moved).find((d) => d.id === doc.id)?.storedCopy).toBe('present')
    // Without a store dir the field stays absent — callers that never pass one are unchanged.
    expect(listDocuments(db, null).find((d) => d.id === doc.id)?.storedCopy).toBeUndefined()
  })
})

describe('#188 — the original is a LAST resort, and it must still be the original', () => {
  it('T9: refuses to export a fallback original whose content changed since import', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    // The workspace copy is gone, so only the user's own file is left...
    for (const n of readdirSync(store)) rmSync(join(store, n))
    // ...and it has been edited since import, so it is no longer "the original".
    writeFileSync(file, 'a completely different contract, edited after the import')

    await expect(readStoredDocumentBytes(db, store, doc.id, { cipher })).rejects.toThrow(
      /no longer the original/i
    )
  })

  it('T9b: still exports an UNCHANGED fallback original', async () => {
    const db = freshDb()
    const cipher = testCipher()
    const store = documentsDir(freshWorkspace())
    const file = writeSource('contract.txt', SECRET_TEXT)

    const doc = createQueuedDocument(db, file)
    await processDocument(db, store, doc.id, { cipher })
    for (const n of readdirSync(store)) rmSync(join(store, n))

    const { bytes } = await readStoredDocumentBytes(db, store, doc.id, { cipher })
    expect(bytes.toString('utf8')).toContain('severance of unicorns')
  })
})
