import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalLeafFor,
  locateStoredCopy,
  storedCopyLeaf
} from '../../src/main/services/ingestion/stored-copy'

// Issue #188 — the resolver's SAFETY guard. `deleteDocument` shreds whatever this returns, so
// "which file is this document's?" is a data-destruction question, not a lookup convenience.

const ID = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'

function store(): string {
  const d = join(mkdtempSync(join(tmpdir(), 'hilbertraum-resolver-')), 'documents')
  mkdirSync(d, { recursive: true })
  return d
}

describe('storedCopyLeaf — host-independent leaf extraction', () => {
  it('splits on BOTH separators, so a foreign-OS path still yields its file name', () => {
    // The scar this guards: host `basename` on posix returns the WHOLE Windows string, so a
    // Windows-written legacy row read on the Linux CI leg would resolve to nonsense.
    expect(storedCopyLeaf('Z:\\old\\workspace\\documents\\x.pdf.enc')).toBe('x.pdf.enc')
    expect(storedCopyLeaf('/Volumes/HR/workspace/documents/x.pdf.enc')).toBe('x.pdf.enc')
    expect(storedCopyLeaf('C:/mixed\\separators/x.pdf')).toBe('x.pdf')
    expect(storedCopyLeaf('bare.pdf')).toBe('bare.pdf')
  })
})

describe('canonicalLeafFor — the guard that keeps the shred on its own file', () => {
  it('accepts a well-formed leaf belonging to the document', () => {
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: `${ID}.pdf.enc` })).toBe(
      `${ID}.pdf.enc`
    )
  })

  it('derives the leaf from a legacy absolute stored_path', () => {
    expect(
      canonicalLeafFor({ id: ID, stored_path: `Z:\\gone\\documents\\${ID}.pdf.enc` })
    ).toBe(`${ID}.pdf.enc`)
  })

  it('REFUSES a name belonging to a different document', () => {
    // Without this the delete path would shred another document's copy — unrecoverable.
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: `${OTHER}.pdf.enc` })).toBeNull()
    expect(canonicalLeafFor({ id: ID, stored_path: `C:\\ws\\documents\\${OTHER}.pdf.enc` })).toBeNull()
  })

  it('REFUSES traversal and separator-bearing names', () => {
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: '..' })).toBeNull()
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: '.' })).toBeNull()
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: `sub/${ID}.pdf` })).toBeNull()
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: `sub\\${ID}.pdf` })).toBeNull()
    expect(canonicalLeafFor({ id: ID, stored_path: null, stored_name: '' })).toBeNull()
  })

  it('returns null when the row names nothing at all', () => {
    expect(canonicalLeafFor({ id: ID, stored_path: null })).toBeNull()
  })
})

describe('locateStoredCopy', () => {
  it('prefers the canonical location over a stale recorded path', () => {
    const dir = store()
    const leaf = `${ID}.pdf.enc`
    writeFileSync(join(dir, leaf), 'ciphertext')

    const found = locateStoredCopy(dir, {
      id: ID,
      stored_path: `Z:\\a-drive-that-is-not-here\\documents\\${leaf}`,
      stored_name: null
    })
    expect(found?.path).toBe(join(dir, leaf))
    expect(found?.encrypted).toBe(true)
    expect(found?.relocated).toBe(true)
  })

  it('falls back to the recorded absolute path when it still resolves (strict superset)', () => {
    const elsewhere = store()
    const leaf = `${ID}.pdf`
    writeFileSync(join(elsewhere, leaf), 'plaintext')
    // A DIFFERENT store dir: the canonical probe misses, the recorded path hits.
    const found = locateStoredCopy(store(), {
      id: ID,
      stored_path: join(elsewhere, leaf),
      stored_name: null
    })
    expect(found?.path).toBe(join(elsewhere, leaf))
    expect(found?.encrypted).toBe(false)
  })

  it('never returns a canonical path for a foreign leaf, even when that file exists', () => {
    const dir = store()
    const foreign = `${OTHER}.pdf.enc`
    writeFileSync(join(dir, foreign), "another document's bytes")

    // A corrupted row pointing at another document's file must resolve to NOTHING here,
    // not to the neighbour's copy. Mutate `canonicalLeafFor`'s startsWith check and this
    // goes red — which is the point of the guard.
    expect(locateStoredCopy(dir, { id: ID, stored_path: null, stored_name: foreign })).toBeNull()
  })

  it('reports nothing when the copy is genuinely absent', () => {
    expect(
      locateStoredCopy(store(), { id: ID, stored_path: null, stored_name: `${ID}.pdf.enc` })
    ).toBeNull()
  })

  it('flags a row already in its canonical place as not needing a heal', () => {
    const dir = store()
    const leaf = `${ID}.txt`
    writeFileSync(join(dir, leaf), 'x')
    const found = locateStoredCopy(dir, {
      id: ID,
      stored_path: join(dir, leaf),
      stored_name: leaf
    })
    expect(found?.relocated).toBe(false)
  })
})
