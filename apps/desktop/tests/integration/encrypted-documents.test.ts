import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  deleteDocument,
  processDocument,
  reindexDocument,
  documentsDir,
  extractDocumentPreview,
  readStoredDocumentBytes,
  readStoredDocumentText,
  ENCRYPTED_DOC_SUFFIX
} from '../../src/main/services/ingestion'
import { createPlaintextOps, type PlaintextOpsRegistry } from '../../src/main/services/ingestion/plaintext-ops'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  shredStalePlaintext,
  WorkspaceController,
  type DocumentCipher
} from '../../src/main/services/workspace-vault'
import type { Transcriber } from '../../src/main/services/transcriber'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { KdfParams } from '../../src/main/services/security/crypto'
import { recordingCipher, testCipher } from '../helpers/test-cipher'
import { openFreshDb, tempRoot } from '../helpers/db-fixtures'
import { until, within } from '../helpers/hang-budget'

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

  it('DB-7: concurrent text exports decrypt into distinct transients and return the plaintext', async () => {
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

  it('is null while locked; round-trips files when unlocked', async () => {
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
    await cipher!.encryptFileAsync(plain, enc)
    expect(readFileSync(enc).includes(Buffer.from(SECRET_TEXT))).toBe(false)
    await cipher!.decryptFileAsync(enc, back)
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

// #918 item 3: the import title drops a trailing space or dot from the file name ("people.tsv " imports as
// "people.tsv"), but the first parse of an encrypted import used to read the user's original, whose own name still
// carries them: the TSV was split by commas, and the voice engine would get a name Windows strips to another file.
// That parse now reads a decrypted copy named after the title: the re-index transient `<id>.parse<ext>` in the store,
// tracked for the lock/quit sweep, under the startup sweep's `.parse` match, shredded in prepare's `finally`.
describe('an encrypted import of a name that ends in a space or a dot (#918)', () => {
  const TSV = `name\tnote\nLovelace, Ada\t${SECRET_TEXT}\n`

  it('parses a decrypted copy named after the title, as the same file without the space, and shreds it', async () => {
    const db = freshDb()
    const store = freshStore()
    const rec = recordingCipher()
    const ops = createPlaintextOps()
    const odd = createQueuedDocument(db, writeSource('people.tsv ', TSV))
    const info = await processDocument(db, store, odd.id, { cipher: rec.cipher, plaintextOps: ops })
    expect(info.status).toBe('indexed')
    expect(info.title).toBe('people.tsv')

    // Split by tabs, exactly as the same file without the space (whose first parse reads the original: no decrypt).
    const plain = createQueuedDocument(db, writeSource('people.tsv', TSV))
    await processDocument(db, store, plain.id, { cipher: rec.cipher })
    const text = (id: string): string =>
      (db.prepare('SELECT text FROM chunks WHERE document_id = ?').get(id) as { text: string }).text
    expect(text(odd.id)).toContain('name: Lovelace, Ada')
    expect(text(odd.id)).toBe(text(plain.id))
    // Only the odd name was decrypted, into the store's `.parse` transient.
    expect(rec.asyncDecrypts).toEqual([join(store, `${odd.id}.parse.tsv`)])

    expect(readdirSync(store).sort()).toEqual([`${odd.id}.tsv${ENCRYPTED_DOC_SUFFIX}`, `${plain.id}.tsv${ENCRYPTED_DOC_SUFFIX}`].sort())
    expect(plaintextLeaks(store)).toEqual([])
    expect(ops.size()).toBe(0)
  })

  it('a parse that fails shreds the copy too, failing as the same file without the dot', async () => {
    const db = freshDb()
    const store = freshStore()
    const rec = recordingCipher()
    const broken = `not a pdf at all: ${SECRET_TEXT}`
    const doc = createQueuedDocument(db, writeSource('broken.pdf ', broken))
    const info = await processDocument(db, store, doc.id, { cipher: rec.cipher })
    expect(info.status).toBe('failed')
    expect(rec.asyncDecrypts).toEqual([join(store, `${doc.id}.parse.pdf`)])
    expect(readdirSync(store)).toEqual([`${doc.id}.pdf${ENCRYPTED_DOC_SUFFIX}`])
    expect(plaintextLeaks(store)).toEqual([])
    const control = createQueuedDocument(db, writeSource('broken.pdf', broken))
    expect((await processDocument(db, store, control.id, { cipher: rec.cipher })).errorMessage).toBe(info.errorMessage)
  })

  // #918 review: the row records the stored copy before that decrypt, so a decrypt that fails (a full drive, a lock
  // shredding its `.tmp`) leaves a `.enc` the row names, and removing the document deletes it.
  it('a decrypt that fails leaves the row naming its encrypted copy, and removing the document deletes it', async () => {
    const db = freshDb()
    const store = freshStore()
    const cipher: DocumentCipher = {
      ...testCipher(),
      decryptFileAsync: async () => {
        throw new Error('ENOSPC: no space left on device, write')
      }
    }
    const doc = createQueuedDocument(db, writeSource('people.tsv ', TSV))
    expect((await processDocument(db, store, doc.id, { cipher })).status).toBe('failed')
    const row = db.prepare('SELECT stored_name, sha256 FROM documents WHERE id = ?').get(doc.id) as {
      stored_name: string | null
      sha256: string | null
    }
    expect(row.stored_name).toBe(`${doc.id}.tsv${ENCRYPTED_DOC_SUFFIX}`)
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readdirSync(store)).toEqual([row.stored_name]) // no transient either
    deleteDocument(db, store, doc.id)
    expect(readdirSync(store)).toEqual([])
  })

  it('an unsupported type is refused without a decrypted copy', async () => {
    const db = freshDb()
    const store = freshStore()
    const rec = recordingCipher()
    const doc = createQueuedDocument(db, writeSource('photo.heic ', SECRET_TEXT))
    const info = await processDocument(db, store, doc.id, { cipher: rec.cipher })
    expect(info.status).toBe('failed')
    expect(info.errorMessage).toContain("isn't supported (.heic)")
    expect(rec.asyncDecrypts).toEqual([])
    expect(plaintextLeaks(store)).toEqual([])
  })

  it('a cancelled import ends the transcription of "memo.mp3 ", whose voice engine got the named copy, and shreds it', async () => {
    const db = freshDb()
    const store = freshStore()
    const ops = createPlaintextOps()
    const source = writeSource('memo.mp3 ', SECRET_TEXT)
    let handed: string | null = null
    let bytes: Buffer | null = null
    const parked: Transcriber = {
      id: 'parked',
      transcribe: (filePath, opts) =>
        new Promise<never>((_resolve, reject) => {
          handed = filePath
          bytes = readFileSync(filePath)
          const cancelled = (): void => reject(new Error('Transcription was cancelled.'))
          if (opts.signal?.aborted) cancelled()
          else opts.signal?.addEventListener('abort', cancelled, { once: true })
        })
    }
    const job = new AbortController()
    const doc = createQueuedDocument(db, source)
    const run = processDocument(db, store, doc.id, {
      cipher: testCipher(),
      transcriber: parked,
      plaintextOps: ops,
      signal: job.signal
    })
    await until(() => handed !== null, 'the import reaching the voice engine')
    expect(handed).toBe(join(store, `${doc.id}.parse.mp3`))
    expect(bytes!.equals(readFileSync(source))).toBe(true)

    job.abort()
    expect((await within(run, 'the cancelled import settling')).status).toBe('failed')
    expect(existsSync(handed!)).toBe(false)
    expect(readdirSync(store)).toEqual([`${doc.id}.mp3${ENCRYPTED_DOC_SUFFIX}`])
    expect(ops.size()).toBe(0)
  })

  // The copy is decrypted for real, then the parse is held while it sits on the drive: the state a parse that
  // outlives the lock's settle bound leaves, or a crash leaves. The crash case pins the copy's name: the startup
  // sweep matched `.parse` before #918 too.
  it.each([
    ['the lock and quit sweep of the registry', false],
    ['the startup crash sweep', true]
  ])('while the parse holds the copy, %s shreds it', async (_sweep, crash) => {
    const db = freshDb()
    const root = tempRoot('encdoc-ws')
    const store = documentsDir(root)
    const inner = testCipher()
    let copy: string | null = null
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const cipher: DocumentCipher = {
      ...inner,
      decryptFileAsync: async (src, dest) => {
        await inner.decryptFileAsync(src, dest)
        copy = dest
        await gate
      }
    }
    const ops = createPlaintextOps()
    const doc = createQueuedDocument(db, writeSource('people.tsv ', TSV))
    const run = processDocument(db, store, doc.id, { cipher, plaintextOps: ops })
    await until(() => copy !== null, 'the import decrypting its copy')
    expect(copy).toBe(join(store, `${doc.id}.parse.tsv`))
    expect(plaintextLeaks(store)).toEqual([`${doc.id}.parse.tsv`])

    if (crash) {
      // The next start sweeps the workspace's documents folder by the `.parse` infix (the vault DB itself is absent here).
      shredStalePlaintext(vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'hilbertraum.sqlite') }))
    } else {
      ops.abortAll()
      expect(ops.sweepRegistered()).toBe(1)
    }
    expect(existsSync(copy!)).toBe(false)

    release()
    expect((await within(run, 'the held import settling')).status).toBe('failed')
    expect(ops.size()).toBe(0)
    expect(readdirSync(store)).toEqual([`${doc.id}.tsv${ENCRYPTED_DOC_SUFFIX}`])
  })
})

// #918 review: with the stored copy gone the preview (and the segment readers and doc tasks that read through it)
// falls back to the user's original, whose name still ends in the space. It now reads a copy named after the title,
// in both modes, under the preview's own transient name: tracked for the lock/quit sweep, shredded on the way out.
describe('the preview of a name that ends in a space, without its stored copy (#918)', () => {
  const TSV = `name\tnote\nLovelace, Ada\t${SECRET_TEXT}\n`

  it.each([
    ['a plaintext', false],
    ['an encrypted', true]
  ])('in %s workspace, the preview reads a copy of the original named after the title', async (_mode, encrypted) => {
    const db = freshDb()
    const store = freshStore()
    const cipher = encrypted ? testCipher() : null
    const doc = createQueuedDocument(db, writeSource('people.tsv ', TSV))
    expect((await processDocument(db, store, doc.id, { cipher })).status).toBe('indexed')
    for (const name of readdirSync(store)) rmSync(join(store, name)) // the stored copy is gone, the original is not

    const ops = createPlaintextOps()
    const tracked: string[] = []
    const recording: PlaintextOpsRegistry = {
      ...ops,
      register: (kind, parent) => {
        const op = ops.register(kind, parent)
        return {
          ...op,
          track: (path) => {
            tracked.push(path)
            op.track(path)
          }
        }
      }
    }
    const preview = await extractDocumentPreview(db, store, doc.id, { cipher, plaintextOps: recording })
    expect(preview.segments.map((s) => s.text).join('\n')).toContain('name: Lovelace, Ada')
    expect(tracked).toHaveLength(1)
    expect(dirname(tracked[0]!)).toBe(store)
    expect(basename(tracked[0]!)).toMatch(new RegExp(`^${doc.id}\\.parse-preview-[0-9a-f-]+\\.tsv$`))
    expect(readdirSync(store)).toEqual([])
    expect(ops.size()).toBe(0)
  })
})
