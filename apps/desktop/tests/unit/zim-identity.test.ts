import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ZimHeaderError,
  computeServedSet,
  formatZimUuid,
  readZimHeader,
  servingNameFor
} from '../../src/main/services/zim/identity'
import { malformedZimFixture, uuidBytes, writeZimFixture } from '../helpers/zim-header'

// #301 P3b — archive IDENTITY and the SERVING-NAME map (findings M5 and L4; plan §9.17 (d)).
// Focused ordinary tests for the three primitives T11 and T12 rest on; the end-to-end cases
// live in zim-packs.test.ts (T11-a) and zim-ipc-session.test.ts (T12-a).

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'hilbertraum-zim-identity-'))

describe('readZimHeader (plan §2.4)', () => {
  it('reads the UUID from bytes 8-23 in byte order, never a Windows-GUID field swap', () => {
    const dir = tempDir()
    const uuid = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
    const file = writeZimFixture(join(dir, 'a.zim'), uuid, { trailing: 'body bytes after the header' })
    expect(readZimHeader(file)).toEqual({ uuid })
    // The swapped-field spelling of the SAME bytes is a different id: a reader that byte-swapped
    // the first three fields would match no `books.id` the server ever answers to.
    const swapped = '3c2d1e0f-5a4b-7869-8796-a5b4c3d2e1f0'
    expect(readZimHeader(file).uuid).not.toBe(swapped)
    expect(formatZimUuid(uuidBytes(uuid))).toBe(uuid)
  })

  it('rejects a short file, a wrong magic and an empty file with reason codes and no path', () => {
    const dir = tempDir()
    for (const kind of ['short', 'magic', 'empty'] as const) {
      const file = malformedZimFixture(join(dir, `${kind}.zim`), kind)
      let caught: unknown
      try {
        readZimHeader(file)
      } catch (err) {
        caught = err
      }
      expect(caught, kind).toBeInstanceOf(ZimHeaderError)
      const err = caught as ZimHeaderError
      // 'empty' and 'short' are both length failures; 'magic' is a content failure.
      expect(err.reason, kind).toBe(kind === 'magic' ? 'magic' : 'short')
      // The sentinel rule: an error a handler may surface must not carry the file path.
      expect(err.message).not.toContain(dir)
      expect(err.message).not.toContain(kind === 'magic' ? 'magic.zim' : `${kind}.zim`)
    }
  })

  it('reports an absent or unreadable file as unreadable, and closes the descriptor it opened', () => {
    const dir = tempDir()
    let caught: unknown
    try {
      readZimHeader(join(dir, 'nope.zim'))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ZimHeaderError)
    expect((caught as ZimHeaderError).reason).toBe('unreadable')

    // A descriptor leak would pin a removable drive. 400 rejected reads on a REAL file (the
    // short fixture) must not exhaust the process's handles; a leak surfaces as EMFILE here.
    const short = malformedZimFixture(join(dir, 'short.zim'), 'short')
    for (let i = 0; i < 400; i++) {
      expect(() => readZimHeader(short)).toThrow(ZimHeaderError)
    }
  })

  it('a directory is unreadable, not a crash', () => {
    const dir = tempDir()
    let caught: unknown
    try {
      readZimHeader(dir)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ZimHeaderError)
    expect(['unreadable', 'short']).toContain((caught as ZimHeaderError).reason)
  })

  it('a file with a valid magic but fewer than 80 bytes is short, not magic', () => {
    const dir = tempDir()
    const file = join(dir, 'clipped.zim')
    const buf = Buffer.alloc(40)
    buf.writeUInt32LE(0x044d495a, 0)
    writeFileSync(file, buf)
    expect(() => readZimHeader(file)).toThrow(
      expect.objectContaining({ reason: 'short' }) as unknown as Error
    )
  })
})

describe('servingNameFor — libkiwix 14.1 Book::getHumanReadableIdFromPath', () => {
  it('lowercases, strips accents, drops the directory, strips the ZIM suffix, maps space and plus', () => {
    // The reference case from the pinned source walk-through: every one of the five steps fires.
    expect(servingNameFor('K:\\zim\\Wikipédia_DE Test+1.ZIM', 'win32')).toBe('wikipedia_de_testplus1')
    expect(servingNameFor('/media/drive/zim/Wikipédia_DE Test+1.ZIM', 'linux')).toBe(
      'wikipedia_de_testplus1'
    )
  })

  it('strips the directory with the PLATFORM separator, so both branches are pinned on one OS', () => {
    // win32 strips at the LAST backslash and leaves a forward slash alone…
    expect(servingNameFor('C:\\packs\\a\\b.zim', 'win32')).toBe('b')
    expect(servingNameFor('/packs/a/b.zim', 'win32')).toBe('/packs/a/b')
    // …and posix does the mirror image. (L9: the platform is injected, never read from the
    // process, so a Windows-only assertion cannot pass by accident on Linux CI.)
    expect(servingNameFor('/packs/a/b.zim', 'linux')).toBe('b')
    expect(servingNameFor('C:\\packs\\a\\b.zim', 'linux')).toBe('c:\\packs\\a\\b')
  })

  it('strips .zim and any lowercase-letter suffix after it, and only at the end', () => {
    expect(servingNameFor('/z/atlas.zim', 'linux')).toBe('atlas')
    expect(servingNameFor('/z/atlas.zimaa', 'linux')).toBe('atlas')
    expect(servingNameFor('/z/atlas.zimbb', 'linux')).toBe('atlas')
    // Not a suffix ⇒ not stripped; an uppercase suffix is already lowercased by step 1.
    expect(servingNameFor('/z/atlas.zim.bak', 'linux')).toBe('atlas.zim.bak')
    expect(servingNameFor('/z/my.zim.archive.ZIM', 'linux')).toBe('my.zim.archive')
  })

  it('maps EVERY space and EVERY plus, and normalizes composed and decomposed accents alike', () => {
    expect(servingNameFor('/z/a b c.zim', 'linux')).toBe('a_b_c')
    expect(servingNameFor('/z/a+b+c.zim', 'linux')).toBe('aplusbplusc')
    // é as one code point vs e + combining acute: the ICU pipeline collapses both to `e`.
    expect(servingNameFor('/z/Caf\u00e9.zim', 'linux')).toBe(
      servingNameFor('/z/Cafe\u0301.zim', 'linux')
    )
    expect(servingNameFor('/z/Caf\u00e9.zim', 'linux')).toBe('cafe')
    // The accent rule runs on the WHOLE path (step 1 precedes the directory strip), which is
    // observable when the directory is what carries the accent and the leaf does not.
    expect(servingNameFor('/Ü/plain.zim', 'linux')).toBe('plain')
  })
})

describe('computeServedSet — the HumanReadableNameMapper collision rule', () => {
  it('keeps the SMALLER uuid for a colliding name and reports the loser, whatever the input order', () => {
    const small = '11111111-0000-4000-8000-000000000000'
    const large = '99999999-0000-4000-8000-000000000000'
    const candidates = [
      { id: large, path: '/z/wikipedia_de.zim' },
      { id: small, path: '/z/Wikipédia DE.zim' } // slugifies to the SAME name
    ]
    for (const order of [candidates, [...candidates].reverse()]) {
      const served = computeServedSet(order, 'linux')
      expect(served.names.get(small)).toBe('wikipedia_de')
      expect(served.names.has(large)).toBe(false)
      expect(served.excluded).toEqual([{ packId: large, collidesWith: small }])
    }
  })

  it('the + → plus rule can collide two differently named files', () => {
    const first = '22222222-0000-4000-8000-000000000000'
    const second = '33333333-0000-4000-8000-000000000000'
    const served = computeServedSet(
      [
        { id: second, path: '/z/aplusb.zim' },
        { id: first, path: '/z/a+b.zim' }
      ],
      'linux'
    )
    expect(served.names.get(first)).toBe('aplusb')
    expect(served.excluded).toEqual([{ packId: second, collidesWith: first }])
  })

  it('distinct names all win, and an empty candidate list yields an empty map', () => {
    const served = computeServedSet(
      [
        { id: 'aaaa', path: '/z/one.zim' },
        { id: 'bbbb', path: '/z/two.zim' },
        { id: 'cccc', path: '/z/three.zim' }
      ],
      'linux'
    )
    expect([...served.names.values()].sort()).toEqual(['one', 'three', 'two'])
    expect(served.excluded).toEqual([])
    expect(computeServedSet([], 'linux')).toEqual({ names: new Map(), excluded: [] })
  })

  it('three books on one name exclude BOTH losers, each pointing at the single winner', () => {
    const a = '10000000-0000-4000-8000-000000000000'
    const b = '20000000-0000-4000-8000-000000000000'
    const c = '30000000-0000-4000-8000-000000000000'
    const served = computeServedSet(
      [
        { id: c, path: '/z/ATLAS.zim' },
        { id: a, path: '/z/atlas.zim' },
        { id: b, path: '/z/Átlas.zim' }
      ],
      'linux'
    )
    expect([...served.names.keys()]).toEqual([a])
    expect(served.excluded).toEqual([
      { packId: b, collidesWith: a },
      { packId: c, collidesWith: a }
    ])
  })
})
