import { describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  discoverDrivePacks,
  listPacks,
  registerPack,
  removePack,
  resolvePackFile,
  retrievablePacks,
  setPackEnabled,
  writeLibraryXml,
  type PackDeps
} from '../../src/main/services/zim/packs'

// Registry over a REAL temp database (the collections-ipc harness precedent). The
// kiwix-manage seam is faked: it appends a <book> element derived from the file name,
// with a deterministic uuid — registration itself never needs the binary in tests.

function makeHarness(): { db: Db; deps: PackDeps; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-packs-'))
  const zimDir = join(root, 'zim')
  mkdirSync(zimDir, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
    const leaf = basename(zimPath)
    if (leaf.includes('corrupt')) throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
    const id = `uuid-${leaf.replace(/\.zim$/i, '')}`
    appendFileSync(
      libraryXmlPath,
      `<book id="${id}" path="${zimPath.replace(/\\/g, '/')}" title="Title of ${leaf}" ` +
        `description="Test archive" language="deu" date="2026-07-01" articleCount="4102" mediaCount="7" />\n`
    )
  }
  return { db, deps: { zimDir, manageAdd }, root }
}

function addZimFile(dir: string, leaf: string): string {
  const p = join(dir, leaf)
  writeFileSync(p, 'ZIM')
  return p
}

describe('knowledge-pack registry', () => {
  it('registers a pack with kiwix-manage metadata and lists it as available', async () => {
    const { db, deps } = makeHarness()
    const file = addZimFile(deps.zimDir, 'wikipedia_de_climate.zim')
    const pack = await registerPack(db, deps, file)
    expect(pack).toMatchObject({
      id: 'uuid-wikipedia_de_climate',
      title: 'Title of wikipedia_de_climate.zim',
      language: 'deu',
      zimDate: '2026-07-01',
      articleCount: 4102,
      leaf: 'wikipedia_de_climate.zim',
      enabled: true,
      available: true
    })
    expect(pack.sizeBytes).toBe(3)
    expect(listPacks(db, deps.zimDir)).toHaveLength(1)
  })

  it('re-registering the same archive upserts (one row, addedAt preserved)', async () => {
    const { db, deps } = makeHarness()
    const file = addZimFile(deps.zimDir, 'a.zim')
    const first = await registerPack(db, deps, file)
    const second = await registerPack(db, deps, file)
    expect(second.id).toBe(first.id)
    expect(second.addedAt).toBe(first.addedAt)
    expect(listPacks(db, deps.zimDir)).toHaveLength(1)
  })

  it('marks a vanished file unavailable at list time and heals when it returns', async () => {
    const { db, deps } = makeHarness()
    const file = addZimFile(deps.zimDir, 'a.zim')
    await registerPack(db, deps, file)
    rmSync(file)
    expect(listPacks(db, deps.zimDir)[0]).toMatchObject({ available: false })
    addZimFile(deps.zimDir, 'a.zim')
    expect(listPacks(db, deps.zimDir)[0]).toMatchObject({ available: true })
  })

  it('resolves the drive zim/<leaf> location first, the recorded path second', async () => {
    const { db, deps, root } = makeHarness()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const external = addZimFile(elsewhere, 'ext.zim')
    await registerPack(db, deps, external)
    // Recorded (external) path resolves while no drive copy exists.
    expect(resolvePackFile(deps.zimDir, { leaf: 'ext.zim', recorded_path: external })).toBe(external)
    // A copy under zim/ wins — the drive-relative location is canonical after a remount.
    const canonical = addZimFile(deps.zimDir, 'ext.zim')
    expect(resolvePackFile(deps.zimDir, { leaf: 'ext.zim', recorded_path: external })).toBe(canonical)
  })

  it('remove and enable/disable behave and report row existence', async () => {
    const { db, deps } = makeHarness()
    const file = addZimFile(deps.zimDir, 'a.zim')
    const pack = await registerPack(db, deps, file)
    expect(setPackEnabled(db, pack.id, false)).toBe(true)
    expect(listPacks(db, deps.zimDir)[0]).toMatchObject({ enabled: false })
    expect(removePack(db, pack.id)).toBe(true)
    expect(removePack(db, pack.id)).toBe(false)
    expect(setPackEnabled(db, pack.id, true)).toBe(false)
  })

  it('auto-discovers unknown drive archives; a corrupt one is skipped, not fatal', async () => {
    const { db, deps } = makeHarness()
    addZimFile(deps.zimDir, 'one.zim')
    addZimFile(deps.zimDir, 'two.zim')
    addZimFile(deps.zimDir, 'corrupt.zim')
    await registerPack(db, deps, join(deps.zimDir, 'one.zim')) // already known
    const added = await discoverDrivePacks(db, deps)
    expect(added).toBe(1) // two.zim only: one known, corrupt skipped
    expect(listPacks(db, deps.zimDir).map((p) => p.leaf).sort()).toEqual(['one.zim', 'two.zim'])
  })

  it('retrievablePacks returns requested ∩ enabled ∩ available with resolved paths', async () => {
    const { db, deps } = makeHarness()
    const a = await registerPack(db, deps, addZimFile(deps.zimDir, 'a.zim'))
    const b = await registerPack(db, deps, addZimFile(deps.zimDir, 'b.zim'))
    const c = await registerPack(db, deps, addZimFile(deps.zimDir, 'c.zim'))
    setPackEnabled(db, b.id, false)
    rmSync(join(deps.zimDir, 'c.zim'))
    const hits = retrievablePacks(db, deps.zimDir, [a.id, b.id, c.id])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id: a.id, filePath: join(deps.zimDir, 'a.zim') })
    expect(retrievablePacks(db, deps.zimDir, [])).toEqual([])
  })

  it('writeLibraryXml includes only enabled packs whose file resolves', async () => {
    const { db, deps, root } = makeHarness()
    const a = await registerPack(db, deps, addZimFile(deps.zimDir, 'a.zim'))
    const b = await registerPack(db, deps, addZimFile(deps.zimDir, 'b.zim'))
    await registerPack(db, deps, addZimFile(deps.zimDir, 'gone.zim'))
    setPackEnabled(db, b.id, false)
    rmSync(join(deps.zimDir, 'gone.zim'))
    const libraryPath = join(root, 'library.xml')
    await expect(writeLibraryXml(db, deps, libraryPath)).resolves.toBe(1)
    expect(a.enabled).toBe(true)
  })
})
