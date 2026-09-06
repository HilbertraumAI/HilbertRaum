import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { readZimHeader } from '../../src/main/services/zim/identity'
import {
  listPacks,
  reconcile,
  registerPack,
  removePack,
  resolvePack,
  retrievablePacks,
  servedCandidates,
  setPackEnabled,
  writeLibraryXml,
  type PackDeps
} from '../../src/main/services/zim/packs'
import { ZimService } from '../../src/main/services/zim'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { malformedZimFixture, packUuid, writeZimFixture } from '../helpers/zim-header'

// Registry over a REAL temp database (the collections-ipc harness precedent). The kiwix-manage
// seam is faked — but since #301 P3b the fake READS THE FIXTURE'S HEADER and emits
// `<book id="<uuid>">`, so the manager and the header agree BY CONSTRUCTION, exactly as the
// real kiwix-manage does (it reads the same 80 bytes). A fake that derived the id from the file
// NAME can no longer register anything, and one test asserts precisely that.

function makeHarness(): { db: Db; deps: PackDeps; root: string; zimDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-packs-'))
  const zimDir = join(root, 'zim')
  mkdirSync(zimDir, { recursive: true })
  const db = openDatabase(join(root, 'test.sqlite'))
  const manageAdd: PackDeps['manageAdd'] = async (libraryXmlPath, zimPath) => {
    const leaf = basename(zimPath)
    if (leaf.includes('corrupt')) throw new Error(`Cannot add ZIM ${zimPath} to the library.`)
    const { uuid } = readZimHeader(zimPath)
    appendFileSync(
      libraryXmlPath,
      `<book id="${uuid}" path="${zimPath.replace(/\\/g, '/')}" title="Title of ${leaf}" ` +
        `description="Test archive" language="deu" date="2026-07-01" articleCount="4102" mediaCount="7" />\n`
    )
  }
  return { db, deps: { zimDir, manageAdd }, root, zimDir }
}

/** A ZIM with a real 80-byte header plus a body, so the file is not header-sized. */
function addZimFile(dir: string, leaf: string, uuid: string): string {
  return writeZimFixture(join(dir, leaf), uuid, { trailing: `body of ${leaf}` })
}

const U = {
  alpha: packUuid('aaaaaaaa', 'alpha'),
  beta: packUuid('bbbbbbbb', 'beta'),
  gamma: packUuid('cccccccc', 'gamma'),
  delta: packUuid('dddddddd', 'delta'),
  intruder: packUuid('eeeeeeee', 'intruder')
}

/** Exactly the columns the ownership split says the reconcile may NEVER write. */
function userColumns(db: Db): Array<{ id: string; enabled: number; removed_at: string | null }> {
  return db
    .prepare('SELECT id, enabled, removed_at FROM knowledge_packs ORDER BY id')
    .all() as unknown as Array<{ id: string; enabled: number; removed_at: string | null }>
}

/** The Windows-GUID spelling of the same 16 bytes: the first three fields byte-swapped. */
function swapGuidFields(uuid: string): string {
  const [a, b, c, d, e] = uuid.split('-') as [string, string, string, string, string]
  const flip = (hex: string): string => (hex.match(/../g) ?? []).reverse().join('')
  return [flip(a), flip(b), flip(c), d, e].join('-')
}

describe('knowledge-pack registry', () => {
  it('registers a pack with kiwix-manage metadata and lists it as available', async () => {
    const { db, deps, zimDir } = makeHarness()
    const file = addZimFile(zimDir, 'wikipedia_de_climate.zim', U.alpha)
    const pack = await registerPack(db, deps, file)
    expect(pack).toMatchObject({
      id: U.alpha,
      title: 'Title of wikipedia_de_climate.zim',
      language: 'deu',
      zimDate: '2026-07-01',
      articleCount: 4102,
      leaf: 'wikipedia_de_climate.zim',
      enabled: true,
      available: true,
      unavailableReason: null
    })
    expect(pack.sizeBytes).toBeGreaterThan(80)
    expect(listPacks(db)).toHaveLength(1)
  })

  it('re-registering the same archive upserts (one row, addedAt preserved)', async () => {
    const { db, deps, zimDir } = makeHarness()
    const file = addZimFile(zimDir, 'a.zim', U.alpha)
    const first = await registerPack(db, deps, file)
    const second = await registerPack(db, deps, file)
    expect(second.id).toBe(first.id)
    expect(second.addedAt).toBe(first.addedAt)
    expect(listPacks(db)).toHaveLength(1)
  })

  it('registration refuses a file whose header is not a ZIM, and never spawns the manager', async () => {
    const { db, deps, zimDir } = makeHarness()
    let spawns = 0
    const counted: PackDeps = {
      ...deps,
      manageAdd: async (...args) => {
        spawns++
        return deps.manageAdd(...args)
      }
    }
    const bad = malformedZimFixture(join(zimDir, 'not-a-zim.zim'), 'magic')
    await expect(registerPack(db, counted, bad)).rejects.toMatchObject({
      name: 'ZimHeaderError',
      reason: 'magic'
    })
    expect(spawns).toBe(0) // the header is read FIRST — no 30 s manager spawn for a junk file
    expect(listPacks(db)).toHaveLength(0)
  })

  it('registration fails when the manager disagrees with the header (a name-derived fake cannot register)', async () => {
    const { db, zimDir } = makeHarness()
    // The PRE-P3b fake: it derives the book id from the FILE NAME. That is exactly the class of
    // metadata source the identity rule refuses to trust, so it must no longer be able to
    // register anything.
    const nameDerived: PackDeps = {
      zimDir,
      manageAdd: async (libraryXmlPath, zimPath) => {
        const stem = basename(zimPath).replace(/\.zim$/i, '')
        appendFileSync(libraryXmlPath, `<book id="uuid-${stem}" title="Title of ${stem}" />\n`)
      }
    }
    const file = addZimFile(zimDir, 'a.zim', U.alpha)
    await expect(registerPack(db, nameDerived, file)).rejects.toThrow(
      /different archive identity than the ZIM header/
    )
    expect(listPacks(db)).toHaveLength(0)
  })

  it('listPacks is a pure DB read: a vanished file stays listed as-is until a reconcile says otherwise', async () => {
    const { db, deps, zimDir } = makeHarness()
    const file = addZimFile(zimDir, 'a.zim', U.alpha)
    await registerPack(db, deps, file)
    const updatedAt = (): string =>
      (db.prepare('SELECT updated_at FROM knowledge_packs WHERE id = ?').get(U.alpha) as {
        updated_at: string
      }).updated_at
    const stamp = updatedAt()
    rmSync(file)
    // L7: no existsSync, no UPDATE, no spawn — the list does not even notice, and above all it
    // does not touch the row (the old implementation wrote an availability stamp per call).
    expect(listPacks(db)[0]).toMatchObject({ available: true, unavailableReason: null })
    expect(updatedAt()).toBe(stamp)

    await reconcile(db, deps)
    expect(listPacks(db)[0]).toMatchObject({ available: false, unavailableReason: 'missing' })
    addZimFile(zimDir, 'a.zim', U.alpha)
    await reconcile(db, deps)
    expect(listPacks(db)[0]).toMatchObject({ available: true, unavailableReason: null })
  })

  it('resolves by IDENTITY: the drive zim/<leaf> location first, the recorded path second', async () => {
    const { db, deps, root, zimDir } = makeHarness()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const external = addZimFile(elsewhere, 'ext.zim', U.alpha)
    await registerPack(db, deps, external)
    const row = { id: U.alpha, leaf: 'ext.zim', recorded_path: external }
    // Recorded (external) path resolves while no drive copy exists.
    expect(resolvePack(zimDir, row)).toEqual({ path: external, uuid: U.alpha })
    // A copy under zim/ wins — the drive-relative location is canonical after a remount.
    const canonical = addZimFile(zimDir, 'ext.zim', U.alpha)
    expect(resolvePack(zimDir, row)).toEqual({ path: canonical, uuid: U.alpha })
  })

  it('remove and enable/disable behave and report row existence', async () => {
    const { db, deps, zimDir } = makeHarness()
    const file = addZimFile(zimDir, 'a.zim', U.alpha)
    const pack = await registerPack(db, deps, file)
    expect(setPackEnabled(db, pack.id, false)).toBe(true)
    expect(listPacks(db)[0]).toMatchObject({ enabled: false })
    expect(removePack(db, pack.id)).toBe(true)
    expect(removePack(db, pack.id)).toBe(false)
    expect(setPackEnabled(db, pack.id, true)).toBe(false)
  })

  it('reconcile registers unknown drive archives; a corrupt one is skipped, not fatal', async () => {
    const { db, deps, zimDir } = makeHarness()
    addZimFile(zimDir, 'one.zim', U.alpha)
    addZimFile(zimDir, 'two.zim', U.beta)
    addZimFile(zimDir, 'corrupt.zim', U.gamma) // the fake manager refuses this one
    await registerPack(db, deps, join(zimDir, 'one.zim')) // already known
    const report = await reconcile(db, deps)
    expect(report.registered).toBe(1) // two.zim only: one known, corrupt skipped
    expect(report.changed).toBe(true)
    expect(listPacks(db).map((p) => p.leaf).sort()).toEqual(['one.zim', 'two.zim'])
    // A second pass over an unchanged drive changes nothing — so it must not churn the revision.
    const again = await reconcile(db, deps)
    expect(again).toMatchObject({ changed: false, registered: 0, healed: 0, unavailable: 0 })
  })

  it('retrievablePacks returns requested ∩ enabled ∩ identity-resolved with resolved paths', async () => {
    const { db, deps, zimDir } = makeHarness()
    const a = await registerPack(db, deps, addZimFile(zimDir, 'a.zim', U.alpha))
    const b = await registerPack(db, deps, addZimFile(zimDir, 'b.zim', U.beta))
    const c = await registerPack(db, deps, addZimFile(zimDir, 'c.zim', U.gamma))
    setPackEnabled(db, b.id, false)
    rmSync(join(zimDir, 'c.zim'))
    const hits = retrievablePacks(db, zimDir, [a.id, b.id, c.id])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id: a.id, filePath: join(zimDir, 'a.zim') })
    expect(retrievablePacks(db, zimDir, [])).toEqual([])
  })

  it('writeLibraryXml adds exactly the served candidates it was handed', async () => {
    const { db, deps, root, zimDir } = makeHarness()
    const a = await registerPack(db, deps, addZimFile(zimDir, 'a.zim', U.alpha))
    const b = await registerPack(db, deps, addZimFile(zimDir, 'b.zim', U.beta))
    await registerPack(db, deps, addZimFile(zimDir, 'gone.zim', U.gamma))
    setPackEnabled(db, b.id, false)
    rmSync(join(zimDir, 'gone.zim'))
    // The caller resolves + de-collides first; the writer no longer re-queries the rows.
    const served = servedCandidates(db, zimDir)
    expect(served).toEqual([{ id: a.id, path: join(zimDir, 'a.zim') }])
    const libraryPath = join(root, 'library.xml')
    await expect(writeLibraryXml(deps, libraryPath, served)).resolves.toBe(1)
    expect(a.enabled).toBe(true)
  })

  it('T11 same basename at two locations, wrong drive candidate with correct external fallback, header magic / length / UUID-order mismatches, same UUID after rename / copy: correct identity chosen, invalid headers unavailable without leaks, tombstones and disabled flags preserved', async () => {
    const { db, deps, root, zimDir } = makeHarness()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const warn = vi.spyOn(log, 'warn')

    // ---- (1) SAME BASENAME AT TWO LOCATIONS: the header decides, not the location ---------
    const external = addZimFile(elsewhere, 'wikipedia_de.zim', U.alpha)
    const pack = await registerPack(db, deps, external)
    expect(pack.id).toBe(U.alpha)
    // A DIFFERENT archive with the same basename lands in the drive folder. Pre-P3b this was
    // the M5 bug: `zim/<leaf>` was tried first and won on EXISTENCE alone, so the arm filtered
    // `books.id=<alpha>` against the intruder and got zero hits forever, while the panel said
    // "available".
    const intruder = addZimFile(zimDir, 'wikipedia_de.zim', U.intruder)
    const row = { id: U.alpha, leaf: 'wikipedia_de.zim', recorded_path: external }
    expect(resolvePack(zimDir, row)).toEqual({ path: external, uuid: U.alpha })
    expect(resolvePack(zimDir, row)).not.toMatchObject({ path: intruder })
    // …and the identical row resolves to the DRIVE copy the moment the drive copy IS the pack.
    const realOnDrive = addZimFile(zimDir, 'alpha-on-drive.zim', U.alpha)
    expect(
      resolvePack(zimDir, { id: U.alpha, leaf: 'alpha-on-drive.zim', recorded_path: external })
    ).toEqual({ path: realOnDrive, uuid: U.alpha })
    rmSync(realOnDrive)

    // ---- (2) INVALID HEADERS: not a match, no leak ---------------------------------------
    // A short / bad-magic / empty candidate is treated as "not this archive" — never as a
    // match, never as a crash — and the warn carries a reason CODE, never the path or the leaf.
    for (const kind of ['short', 'magic', 'empty'] as const) {
      warn.mockClear()
      const leaf = `broken-${kind}.zim`
      malformedZimFixture(join(zimDir, leaf), kind)
      const resolved = resolvePack(zimDir, { id: U.beta, leaf, recorded_path: '' })
      expect(resolved, kind).toEqual({ path: null, reason: 'identity-mismatch' })
      const lines = JSON.stringify(warn.mock.calls)
      expect(lines).toContain('could not be identified from its header')
      expect(lines).not.toContain(leaf)
      expect(lines).not.toContain(zimDir.replace(/\\/g, '\\\\'))
      expect(lines).not.toContain('broken-')
    }
    // A row with no candidate file anywhere is MISSING — a different user-facing state.
    expect(resolvePack(zimDir, { id: U.beta, leaf: 'never-existed.zim', recorded_path: '' })).toEqual({
      path: null,
      reason: 'missing'
    })

    // ---- (3) BYTE ORDER: a GUID-swapped spelling of the same bytes is NOT this archive ----
    const swapped = swapGuidFields(U.gamma)
    expect(swapped).not.toBe(U.gamma)
    const gammaFile = addZimFile(zimDir, 'gamma.zim', U.gamma)
    expect(resolvePack(zimDir, { id: U.gamma, leaf: 'gamma.zim', recorded_path: gammaFile })).toEqual({
      path: gammaFile,
      uuid: U.gamma
    })
    warn.mockClear()
    expect(resolvePack(zimDir, { id: swapped, leaf: 'gamma.zim', recorded_path: gammaFile })).toEqual({
      path: null,
      reason: 'identity-mismatch'
    })
    // A perfectly readable header that simply is not ours is not a "could not be identified"
    // warn at all — only unreadable ones are logged.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('could not be identified')
    rmSync(gammaFile)
    for (const kind of ['short', 'magic', 'empty']) rmSync(join(zimDir, `broken-${kind}.zim`))

    // ---- (4) A TOMBSTONE SURVIVES A RENAME -----------------------------------------------
    const tomb = addZimFile(zimDir, 'tombstoned.zim', U.beta)
    await registerPack(db, deps, tomb)
    expect(removePack(db, U.beta)).toBe(true)
    renameSync(tomb, join(zimDir, 'renamed-after-removal.zim'))
    await reconcile(db, deps)
    const tombRow = db
      .prepare('SELECT leaf, removed_at, enabled FROM knowledge_packs WHERE id = ?')
      .get(U.beta) as { leaf: string; removed_at: string | null; enabled: number }
    expect(tombRow.removed_at).not.toBeNull() // STILL removed: a rename cannot resurrect it
    expect(tombRow.leaf).toBe('renamed-after-removal.zim') // …but its path was healed
    expect(listPacks(db).map((p) => p.id)).not.toContain(U.beta)

    // ---- (5) A DISABLED UUID COPIED UNDER A NEW NAME STAYS DISABLED ----------------------
    const disabled = addZimFile(zimDir, 'disabled.zim', U.delta)
    await registerPack(db, deps, disabled)
    expect(setPackEnabled(db, U.delta, false)).toBe(true)
    rmSync(disabled)
    copyFileSync(join(zimDir, 'renamed-after-removal.zim'), join(zimDir, 'unrelated.zim'))
    const copied = addZimFile(zimDir, 'delta-copy.zim', U.delta)
    await reconcile(db, deps)
    const deltaRow = db
      .prepare(
        'SELECT leaf, recorded_path, enabled, removed_at, unavailable_at FROM knowledge_packs WHERE id = ?'
      )
      .get(U.delta) as {
      leaf: string
      recorded_path: string
      enabled: number
      removed_at: string | null
      unavailable_at: string | null
    }
    expect(deltaRow.enabled).toBe(0) // still disabled — a copy is not a user decision
    expect(deltaRow.removed_at).toBeNull()
    expect(deltaRow.leaf).toBe('delta-copy.zim')
    expect(deltaRow.recorded_path).toBe(copied)
    expect(deltaRow.unavailable_at).toBeNull() // available again, by identity

    // ---- (6) REPLACEMENT: the old row goes identity_mismatch, the new UUID is registered ---
    const alphaOnDrive = addZimFile(zimDir, 'alpha-live.zim', U.alpha)
    db.prepare('UPDATE knowledge_packs SET leaf = ?, recorded_path = ? WHERE id = ?').run(
      'alpha-live.zim',
      alphaOnDrive,
      U.alpha
    )
    rmSync(external) // the external original is gone too — this really is a replacement
    const replacement = packUuid('ffffffff', 'replacement')
    addZimFile(zimDir, 'alpha-live.zim', replacement) // overwritten in place, same name
    await reconcile(db, deps)
    const alphaRow = db
      .prepare(
        'SELECT unavailable_at, unavailable_reason, enabled, removed_at FROM knowledge_packs WHERE id = ?'
      )
      .get(U.alpha) as {
      unavailable_at: string | null
      unavailable_reason: string | null
      enabled: number
      removed_at: string | null
    }
    expect(alphaRow.unavailable_reason).toBe('identity_mismatch')
    expect(alphaRow.unavailable_at).not.toBeNull()
    expect(alphaRow.enabled).toBe(1) // never spliced away automatically — the user decides
    expect(alphaRow.removed_at).toBeNull()
    const newRow = db.prepare('SELECT enabled, leaf FROM knowledge_packs WHERE id = ?').get(replacement) as
      | { enabled: number; leaf: string }
      | undefined
    expect(newRow).toMatchObject({ enabled: 1, leaf: 'alpha-live.zim' })
    // The panel surfaces both: the old pack with its honest reason, the new pack as a new pack.
    const listed = listPacks(db)
    expect(listed.find((p) => p.id === U.alpha)).toMatchObject({
      available: false,
      unavailableReason: 'identity-mismatch'
    })
    expect(listed.find((p) => p.id === replacement)).toMatchObject({ available: true, enabled: true })

    // ---- (7) A RECONCILE THAT HEALS PATHS NEVER WRITES `enabled` OR `removed_at` ----------
    const userStateBefore = userColumns(db)
    expect(userStateBefore.length).toBeGreaterThan(3)
    for (const leaf of ['alpha-live.zim', 'delta-copy.zim', 'renamed-after-removal.zim']) {
      renameSync(join(zimDir, leaf), join(zimDir, `moved-${leaf}`))
    }
    const healing = await reconcile(db, deps)
    expect(healing.healed).toBeGreaterThan(0)
    expect(userColumns(db)).toEqual(userStateBefore) // byte-identical across the whole pass
    warn.mockRestore()
  })
})

describe('ZimService.packDeps — injected platform reaches kiwix-manage argv (#301 P5, finding L9, plan §9.19 (e))', () => {
  class FakeManageChild extends EventEmitter implements ChildProcessLike {
    pid = 4242
    killed = false
    stderr = new EventEmitter()
    kill(): boolean {
      this.killed = true
      return true
    }
  }

  /** One registration through a REAL `ZimService`, `platform` as given, a fake `manageSpawn`
   *  that records argv and answers as a successful kiwix-manage. `zimPath` is passed through
   *  a forward-slash form regardless of the test host, so a passing assertion actually proves
   *  `opts.platform` (not the host's `process.platform`) drove the normalization. */
  async function registerAndCaptureArgv(
    platform: NodeJS.Platform,
    zimPath: string
  ): Promise<{ command: string; args: string[] }> {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-svc-platform-'))
    const db = openDatabase(join(root, 'test.sqlite'))
    const calls: Array<{ command: string; args: string[] }> = []
    const manageSpawn: SpawnFn = (command, args) => {
      const child = new FakeManageChild()
      calls.push({ command, args: args as string[] })
      // Answer as a successful kiwix-manage: append the `<book>` element the real binary would
      // (the manager's `id` must equal the header uuid or registration fails).
      queueMicrotask(() => {
        const libraryXmlPath = args[0] as string
        appendFileSync(
          libraryXmlPath,
          `<book id="${U.alpha}" path="${zimPath.replace(/\\/g, '/')}" title="Title" ` +
            `description="Test" language="deu" date="2026-07-01" articleCount="1" mediaCount="0" />\n`
        )
        child.emit('exit', 0, null)
      })
      return child
    }
    const svc = new ZimService({
      rootPath: root,
      isDev: true,
      platform,
      deps: {
        resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
        manageSpawn,
        verifyBinary: async () => 'ok'
      }
    })
    const pack = await svc.registerPack(db, zimPath)
    expect(pack.id).toBe(U.alpha)
    expect(calls).toHaveLength(1)
    return calls[0]!
  }

  it('normalizes a forward-slash zim path to backslashes when the service is constructed with platform: win32', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-svc-platform-src-'))
    const zimDir = join(root, 'zim')
    mkdirSync(zimDir, { recursive: true })
    const forwardSlashFile = addZimFile(zimDir, 'platform-pin.zim', U.alpha).replace(/\\/g, '/')
    const { args } = await registerAndCaptureArgv('win32', forwardSlashFile)
    expect(args[1]).toBe('add')
    expect(args[2]).not.toContain('/')
    expect(args[2]?.includes('\\')).toBe(true)
  })

  it('leaves a forward-slash zim path unchanged when the service is constructed with platform: linux — proves opts.platform, not the host default, drives it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-svc-platform-src2-'))
    const zimDir = join(root, 'zim')
    mkdirSync(zimDir, { recursive: true })
    const forwardSlashFile = addZimFile(zimDir, 'platform-pin-2.zim', U.alpha).replace(/\\/g, '/')
    const { args } = await registerAndCaptureArgv('linux', forwardSlashFile)
    expect(args[1]).toBe('add')
    expect(args[2]).toBe(forwardSlashFile)
  })
})
