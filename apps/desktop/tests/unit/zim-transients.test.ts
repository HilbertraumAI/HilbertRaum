import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ZIM_TRANSIENT_DIR_NAME,
  cleanupZimTransients,
  zimTransientDir
} from '../../src/main/services/zim/transients'

// The knowledge-pack transient cleanup on its own (#301 P3b, findings L3/M4, residual R-7).
//
// This is the piece that DELETES things inside a user's workspace, so it is exercised with the
// ACTUAL filenames the service writes (`library.<n>.xml`, `meta-<n>/library.xml`) against a
// workspace laid out like a real one — an encrypted vault with its `.enc` database, a
// `.recovery` snapshot and encrypted document/image sidecars, and the plaintext_dev shape with
// an open `hilbertraum.sqlite`. Every one of those neighbours must come out byte-identical.
//
// The containment gate is tested by pointing the transient path at a LINK (a junction on
// win32): the cleanup must refuse rather than follow it, because a recursive remover aimed at
// a redirected path is the failure mode worth refusing over.

/** SHA-256 of every file under `dir`, keyed by its workspace-relative path. */
function digestTree(dir: string, base = dir): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [k, v] of digestTree(p, base)) out.set(k, v)
    } else if (entry.isFile()) {
      out.set(p.slice(base.length + 1), createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  return out
}

/**
 * A workspace directory in one of the two modes, with the neighbours that must survive:
 * the database, a `.recovery` snapshot, an encrypted document and an encrypted image, plus an
 * unrelated sibling directory nothing in this feature owns.
 */
function makeWorkspace(mode: 'encrypted' | 'plaintext_dev'): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zimtrans-'))
  const ws = join(root, 'workspace')
  mkdirSync(join(ws, 'documents'), { recursive: true })
  mkdirSync(join(ws, 'images'), { recursive: true })
  mkdirSync(join(ws, 'unrelated'), { recursive: true })
  if (mode === 'encrypted') {
    writeFileSync(join(ws, 'hilbertraum.sqlite.enc'), 'ENCRYPTED-DB-BYTES')
    writeFileSync(join(ws, 'hilbertraum.sqlite.recovery'), 'RECOVERY-SNAPSHOT-BYTES')
  } else {
    writeFileSync(join(ws, 'hilbertraum.sqlite'), 'PLAINTEXT-DEV-DB-BYTES')
  }
  writeFileSync(join(ws, 'documents', 'a1b2.enc'), 'DOCUMENT-CIPHERTEXT')
  writeFileSync(join(ws, 'images', 'c3d4.enc'), 'IMAGE-CIPHERTEXT')
  writeFileSync(join(ws, 'unrelated', 'keepme.txt'), 'not ours')
  return ws
}

/** Plant what a crashed session leaves behind: one served build and one registration dir. */
function plantTransients(ws: string): { build: string; meta: string } {
  const dir = zimTransientDir(ws)
  mkdirSync(join(dir, 'meta-3'), { recursive: true })
  const build = join(dir, 'library.7.xml')
  const meta = join(dir, 'meta-3')
  writeFileSync(build, '<library><book id="uuid-a" path="D:/zim/wikipedia.zim" title="Wikipedia" /></library>')
  writeFileSync(join(meta, 'library.xml'), '<library><book id="uuid-b" title="Private notes" /></library>')
  return { build, meta }
}

describe('cleanupZimTransients — the contained ZIM transient sweep (#301 P3b, L3/M4, R-7)', () => {
  it('removes the actual library build and meta dir in BOTH workspace modes and leaves every neighbour byte-identical', () => {
    for (const mode of ['encrypted', 'plaintext_dev'] as const) {
      const ws = makeWorkspace(mode)
      const { build, meta } = plantTransients(ws)
      // The digest is taken with the transients EXCLUDED, so "unchanged" cannot be satisfied
      // by a cleanup that did nothing.
      const before = digestTree(ws)
      for (const key of [...before.keys()]) {
        if (key.startsWith(ZIM_TRANSIENT_DIR_NAME)) before.delete(key)
      }

      const report = cleanupZimTransients(zimTransientDir(ws), ws, { keep: new Set<string>() })

      expect(report, `${mode}: both entries removed, nothing kept or unknown`).toMatchObject({
        removed: 2,
        kept: 0,
        unknownEntries: 0,
        confirmed: true
      })
      expect(existsSync(build)).toBe(false)
      expect(existsSync(meta)).toBe(false)
      // The directory itself stays (it is recreated lazily either way) but is empty.
      expect(readdirSync(zimTransientDir(ws))).toEqual([])

      const after = digestTree(ws)
      for (const key of [...after.keys()]) {
        if (key.startsWith(ZIM_TRANSIENT_DIR_NAME)) after.delete(key)
      }
      expect(after, `${mode}: the database, .recovery, .enc sidecars and the unrelated dir survive`).toEqual(
        before
      )
    }
  })

  it('is a no-op (confirmed) when the directory was never created, and idempotent when run twice', () => {
    const ws = makeWorkspace('encrypted')
    expect(cleanupZimTransients(zimTransientDir(ws), ws, {})).toMatchObject({
      removed: 0,
      confirmed: true
    })
    plantTransients(ws)
    expect(cleanupZimTransients(zimTransientDir(ws), ws, {}).removed).toBe(2)
    expect(cleanupZimTransients(zimTransientDir(ws), ws, {})).toMatchObject({
      removed: 0,
      kept: 0,
      unknownEntries: 0,
      confirmed: true
    })
  })

  it('keeps exactly the entries in the keep set — by file path or by meta directory — and reports them, never confirmed', () => {
    const ws = makeWorkspace('plaintext_dev')
    const { build, meta } = plantTransients(ws)
    // A second build that nothing keeps, so the pass is not vacuously "kept everything".
    const otherBuild = join(zimTransientDir(ws), 'library.8.xml')
    writeFileSync(otherBuild, '<library/>')

    // The serve child's file is kept by its own path; the manager's dir is kept through the
    // `meta-<n>/library.xml` an operation tracked — both spellings must hold the entry.
    const keep = new Set([build, join(meta, 'library.xml')])
    const report = cleanupZimTransients(zimTransientDir(ws), ws, { keep })

    expect(report).toMatchObject({ removed: 1, kept: 2, unknownEntries: 0, confirmed: false })
    expect(existsSync(build)).toBe(true)
    expect(existsSync(join(meta, 'library.xml'))).toBe(true)
    expect(existsSync(otherBuild)).toBe(false)

    // The next session start (nothing kept any more) finally removes them.
    const later = cleanupZimTransients(zimTransientDir(ws), ws, { keep: new Set<string>() })
    expect(later).toMatchObject({ removed: 2, kept: 0, confirmed: true })
    expect(readdirSync(zimTransientDir(ws))).toEqual([])
  })

  it('leaves an entry it does not own in place, counts it, and refuses to call the pass confirmed', () => {
    const ws = makeWorkspace('encrypted')
    plantTransients(ws)
    const stranger = join(zimTransientDir(ws), 'something-else.txt')
    const strangerDir = join(zimTransientDir(ws), 'not-meta')
    // Deliberately close to the real names, but not them: only `library.<digits>.xml` and
    // `meta-<digits>` are ours.
    const nearMiss = join(zimTransientDir(ws), 'library.xml')
    writeFileSync(stranger, 'unknown')
    mkdirSync(strangerDir)
    writeFileSync(nearMiss, 'unknown')

    const report = cleanupZimTransients(zimTransientDir(ws), ws, {})

    expect(report).toMatchObject({ removed: 2, kept: 0, unknownEntries: 3, confirmed: false })
    expect(existsSync(stranger)).toBe(true)
    expect(existsSync(strangerDir)).toBe(true)
    expect(existsSync(nearMiss)).toBe(true)
    expect(readFileSync(stranger, 'utf8')).toBe('unknown')
  })

  it('REFUSES a linked transient directory: nothing is removed, the link target is untouched', () => {
    const ws = makeWorkspace('encrypted')
    // The target holds a file with one of OUR names, so a cleanup that followed the link would
    // delete real data and the assertion below would catch it.
    const elsewhere = join(ws, '..', 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const decoy = join(elsewhere, 'library.7.xml')
    writeFileSync(decoy, 'MUST SURVIVE')
    // 'junction' is the only link type a non-elevated Windows process can create for a dir;
    // 'dir' is the POSIX equivalent. Both are what `lstat` reports as a link.
    symlinkSync(elsewhere, zimTransientDir(ws), process.platform === 'win32' ? 'junction' : 'dir')

    const report = cleanupZimTransients(zimTransientDir(ws), ws, {})

    expect(report).toMatchObject({ removed: 0, kept: 0, unknownEntries: 0, confirmed: false })
    expect(existsSync(decoy)).toBe(true)
    expect(readFileSync(decoy, 'utf8')).toBe('MUST SURVIVE')
  })

  it('REFUSES a transient path that is a file, and a directory that is not the workspace child it claims to be', () => {
    const ws = makeWorkspace('encrypted')
    // (a) a FILE where the directory belongs.
    writeFileSync(zimTransientDir(ws), 'not a directory')
    expect(cleanupZimTransients(zimTransientDir(ws), ws, {})).toMatchObject({
      removed: 0,
      confirmed: false
    })
    rmSync(zimTransientDir(ws))

    // (b) a real directory with the right contents but sitting somewhere else entirely: the
    // resolved path is not `<realpath(workspace)>/zim-transient`, so it is refused. This is the
    // check that stops a mis-wired `transientDir` from sweeping an arbitrary folder.
    const foreign = join(ws, '..', 'foreign-transient')
    mkdirSync(foreign, { recursive: true })
    const build = join(foreign, 'library.7.xml')
    writeFileSync(build, 'MUST SURVIVE')
    expect(cleanupZimTransients(foreign, ws, {})).toMatchObject({ removed: 0, confirmed: false })
    expect(readFileSync(build, 'utf8')).toBe('MUST SURVIVE')
  })

  it('removes a link INSIDE the directory as the link itself, without following it', () => {
    const ws = makeWorkspace('encrypted')
    plantTransients(ws)
    // A DIRECTORY link (junction on win32 — the only kind a non-elevated Windows process can
    // create) named exactly like a meta dir, pointing at the encrypted documents folder. A
    // cleanup that followed it would shred the user's `.enc` sidecars.
    const target = join(ws, 'documents')
    const linkPath = join(zimTransientDir(ws), 'meta-9')
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    const doc = join(target, 'a1b2.enc')
    const docBefore = statSync(doc).size

    const report = cleanupZimTransients(zimTransientDir(ws), ws, {})

    expect(report.removed).toBe(3) // the build, the real meta dir and the link
    expect(existsSync(linkPath)).toBe(false)
    // The encrypted document the link pointed at is untouched — it was never followed.
    expect(existsSync(doc)).toBe(true)
    expect(statSync(doc).size).toBe(docBefore)
    expect(readFileSync(doc, 'utf8')).toBe('DOCUMENT-CIPHERTEXT')
    expect(readdirSync(target)).toEqual(['a1b2.enc'])
  })
})
