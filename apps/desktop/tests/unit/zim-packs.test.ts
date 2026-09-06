import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { openDatabase, type Db } from '../../src/main/services/db'
import { log } from '../../src/main/services/logging'
import { readZimHeader, servingNameFor } from '../../src/main/services/zim/identity'
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
import { ZimService, type ZimAdmission } from '../../src/main/services/zim'
import type { ChildProcessLike, SpawnFn } from '../../src/main/services/runtime/sidecar'
import { malformedZimFixture, packUuid, writeZimFixture } from '../helpers/zim-header'
import { ServeFakeChild, serveGate } from '../helpers/zim-fakes'

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
        // argv[0] is the PLATFORM-normalised spelling (`\tmp\…` when platform is win32 on a POSIX
        // host); the real temp library lives at the host-separator spelling, which is where the
        // service reads the metadata back from. A real kiwix-manage on Windows sees the same file
        // either way; the fake has to map it back explicitly.
        const libraryXmlPath = (args[0] as string).split("\\").join(sep)
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

// ---- T14 — refreshable searchability (#301 P4, finding M7, plan §2.5 / §9.21 (d)) --------
//
// A REAL loopback kiwix-serve stand-in (real sockets — the transport is load-bearing) plus a
// REAL `ZimService` with fake children, so the probe runs where it really runs: at the end of a
// reconciliation, through the P5 request guard, under the `zim-reconcile` operation. The verdict
// matrix is driven by the SERVING NAME the service resolved (never by a name the test invented),
// which is also what proves the probe asks about the book it thinks it is asking about.

/** A `/suggest` body carrying libkiwix's synthetic `kind:"pattern"` entry — an INDEXED book. */
const SUGGEST_WITH_PATTERN = JSON.stringify([
  { value: 'Alpha', label: 'Alpha', kind: 'path', path: 'A/Alpha' },
  { value: 'the', label: 'containing "the"...', kind: 'pattern' }
])
/** A valid suggestion array WITHOUT it — the only shape that may become a persisted "no". */
const SUGGEST_WITHOUT_PATTERN = JSON.stringify([
  { value: 'Alpha', label: 'Alpha', kind: 'path', path: 'A/Alpha' }
])
const T14_ARTICLE_HTML =
  '<!DOCTYPE html><html lang="de"><head><title>Alpha</title></head><body><h1>Alpha</h1>' +
  '<section data-mw-section-id="0"><p>Alpha Artikel über Treibhausgas in der Landwirtschaft.</p></section>' +
  '</body></html>'

type SuggestAnswer = 'pattern' | 'no-pattern' | 'four-oh-four' | 'bad-json' | 'not-json-array' | 'park'

describe('T14 — refreshable searchability (#301 P4, finding M7)', () => {
  let server: http.Server
  let port = 0
  /** The `content` (serving name) of every `/suggest` the fixture served, in order. */
  let suggested: string[] = []
  /** The `books.id` of every `/search` it served. */
  let searchedBooks: string[] = []
  /** What one serving name gets back. Keyed by the name the SERVICE resolved. */
  let suggestAnswers = new Map<string, SuggestAnswer>()
  /** Per-book `/search` status (404 = the index-less answer the review reproduced). */
  let searchStatus = new Map<string, number>()
  /** Serving name per book id, so a search hit's link names the book the arm expects. */
  const bookNames = new Map<string, string>()
  /** Runs INSIDE the `/suggest` handler, before the response goes out. */
  let onSuggest: (() => void) | null = null
  /** Parks a `/suggest` response until released — the controlled-promise seam (§10.1). */
  let suggestGate: ReturnType<typeof serveGate<void>> | null = null

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/suggest') {
        const name = url.searchParams.get('content') ?? ''
        suggested.push(name)
        onSuggest?.()
        const answer = suggestAnswers.get(name) ?? 'four-oh-four'
        const send = (): void => {
          if (answer === 'park') return
          if (answer === 'four-oh-four') {
            res.writeHead(404)
            res.end('not found')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            answer === 'pattern'
              ? SUGGEST_WITH_PATTERN
              : answer === 'no-pattern'
                ? SUGGEST_WITHOUT_PATTERN
                : answer === 'bad-json'
                  ? '{ not json'
                  : JSON.stringify({ kind: 'pattern' })
          )
        }
        if (suggestGate) void suggestGate.wait().then(send)
        else send()
        return
      }
      if (url.pathname === '/search') {
        const book = url.searchParams.get('books.id') ?? ''
        searchedBooks.push(book)
        const status = searchStatus.get(book) ?? 200
        if (status !== 200) {
          res.writeHead(status)
          res.end('not found')
          return
        }
        const urlId = bookNames.get(book) ?? 'unknown'
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Search</title>` +
            `<item><title>Alpha</title><link>/content/${urlId}/A/Alpha</link><wordCount>900</wordCount></item>` +
            `</channel></rss>`
        )
        return
      }
      if (url.pathname.startsWith('/raw/')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(T14_ARTICLE_HTML)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  interface SearchableHarness {
    db: Db
    root: string
    zimDir: string
    svc: ZimService
    serveChildren: ServeFakeChild[]
    liveChild(): ServeFakeChild
    /** Write a fixture, register it through the REAL service, and remember its serving name. */
    addPack(leaf: string, uuid: string, tags?: string | null): Promise<string>
    /** The injected kiwix-serve binary fingerprint (a bundle swap moves it). */
    fingerprint: { value: string | null }
    /** The workspace admission seam — flipped to prove no post-lock capability write. */
    admits: { value: boolean }
    close(): Promise<void>
  }

  function searchableHarness(opts: { probeTimeoutMs?: number } = {}): SearchableHarness {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-searchable-'))
    const zimDir = join(root, 'zim')
    mkdirSync(zimDir, { recursive: true })
    const libraryDir = join(root, 'library')
    mkdirSync(libraryDir, { recursive: true })
    const db = openDatabase(join(root, 'test.sqlite'))
    const serveChildren: ServeFakeChild[] = []
    const tagsByLeaf = new Map<string, string | null>()
    let pid = 5100
    const fingerprint: { value: string | null } = { value: 'serve:1000:111' }
    const admits = { value: true }

    const spawn: SpawnFn = () => {
      const child = new ServeFakeChild(pid++, 'exit-on-sigterm')
      serveChildren.push(child)
      return child
    }
    // A fake kiwix-manage that echoes the FILE'S OWN header uuid and the tags the test chose
    // for that leaf — the same construction the registry suite uses, so the manager and the
    // header can never disagree by accident.
    const manageSpawn: SpawnFn = (_command, args) => {
      const libraryXmlPath = args[0] as string
      const zimPath = args[2] as string
      const child = new ServeFakeChild(pid++, 'exit-on-sigterm')
      queueMicrotask(() => {
        if (child.killed) return
        const leaf = basename(zimPath)
        const tags = tagsByLeaf.get(leaf) ?? null
        appendFileSync(
          libraryXmlPath,
          `<book id="${readZimHeader(zimPath).uuid}" path="${zimPath.replace(/\\/g, '/')}" ` +
            `title="Title of ${leaf}" description="Test archive" language="deu" date="2026-07-01" ` +
            (tags === null ? '' : `tags="${tags}" `) +
            `articleCount="41" mediaCount="7" />\n`
        )
        child.emit('exit', 0, null)
      })
      return child
    }

    const svc = new ZimService({
      rootPath: root,
      isDev: true,
      admission: { admitsWork: () => admits.value, epoch: () => 1 } satisfies ZimAdmission,
      deps: {
        resolveTools: () => ({ serve: '/bin/kiwix-serve', manage: '/bin/kiwix-manage' }),
        spawn,
        manageSpawn,
        findPort: async () => port,
        probe: async () => true,
        verifyBinary: async () => 'ok',
        healthTimeoutMs: 1_000,
        healthIntervalMs: 1,
        killGraceMs: 5,
        forceKillWaitMs: 5,
        libraryDir,
        toolsFingerprint: () => fingerprint.value,
        probeTimeoutMs: opts.probeTimeoutMs ?? 5_000
      }
    })

    return {
      db,
      root,
      zimDir,
      svc,
      serveChildren,
      fingerprint,
      admits,
      liveChild: () => {
        const last = serveChildren[serveChildren.length - 1]
        if (!last) throw new Error('no kiwix-serve child has been spawned')
        return last
      },
      addPack: async (leaf, uuid, tags = null) => {
        tagsByLeaf.set(leaf, tags)
        const file = addZimFile(zimDir, leaf, uuid)
        const pack = await svc.registerPack(db, file)
        bookNames.set(pack.id, servingNameFor(file))
        return pack.id
      },
      close: async () => {
        await svc.stop()
      }
    }
  }

  const searchableOf = (db: Db, id: string): string | null =>
    (db.prepare('SELECT searchable FROM knowledge_packs WHERE id = ?').get(id) as {
      searchable: string | null
    }).searchable

  const keyOf = (db: Db, id: string): string | null =>
    (db.prepare('SELECT searchable_key FROM knowledge_packs WHERE id = ?').get(id) as {
      searchable_key: string | null
    }).searchable_key

  it('T14 searchable column migration on an existing table and a fresh DB, NULL / tag variants, probe 200-no-hits vs 404 / timeout / bad JSON, tool or file revision change: correct unknown / yes / no, no false persistent no, reprobe possible, no post-lock capability write, index-less article still readable', async () => {
    // ---- (1) MIGRATION of an EXISTING table, and a fresh one ---------------------------
    {
      const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-migrate-'))
      const dbPath = join(root, 'legacy.sqlite')
      // The PRE-P4 table, replayed verbatim through node:sqlite: no `searchable`,
      // no `searchable_key`, no `ftindex_hint`. `CREATE TABLE IF NOT EXISTS` would never
      // alter it, so only `ensureColumn` can rescue this workspace.
      const legacy = new DatabaseSync(dbPath)
      legacy.exec(
        `CREATE TABLE knowledge_packs (
           id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, language TEXT,
           zim_date TEXT, article_count INTEGER, media_count INTEGER, size_bytes INTEGER,
           leaf TEXT NOT NULL, recorded_path TEXT NOT NULL, enabled INTEGER NOT NULL,
           unavailable_at TEXT, unavailable_reason TEXT, removed_at TEXT,
           added_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );`
      )
      legacy
        .prepare(
          `INSERT INTO knowledge_packs (id, title, leaf, recorded_path, enabled, added_at, updated_at)
           VALUES ('legacy-pack', 'Legacy pack', 'legacy.zim', 'legacy.zim', 1, 'then', 'then')`
        )
        .run()
      legacy.close()

      const migrated = openDatabase(dbPath)
      const columns = (migrated.prepare('PRAGMA table_info(knowledge_packs)').all() as Array<{
        name: string
      }>).map((c) => c.name)
      expect(columns).toEqual(expect.arrayContaining(['searchable', 'searchable_key', 'ftindex_hint']))
      // The row survived and reads as UNKNOWN — never as "no", which is the whole point: a
      // workspace that predates the column has not been probed, it has not been refused.
      expect(listPacks(migrated)[0]).toMatchObject({
        id: 'legacy-pack',
        searchable: 'unknown',
        searchableHint: null
      })

      // A FRESH database gets the columns from `CREATE TABLE` itself.
      const fresh = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-zim-fresh-')), 'db.sqlite'))
      const freshColumns = (fresh.prepare('PRAGMA table_info(knowledge_packs)').all() as Array<{
        name: string
      }>).map((c) => c.name)
      expect(freshColumns).toEqual(expect.arrayContaining(['searchable', 'searchable_key', 'ftindex_hint']))
    }

    // ---- (2) TAG VARIANTS are HINTS: they never set `searchable` ------------------------
    {
      const h = searchableHarness()
      try {
        const variants: Array<[string, string, string | null, 'yes' | 'no' | null]> = [
          ['tag-yes.zim', packUuid('11111111', 'tagy'), 'wikipedia;_ftindex:yes', 'yes'],
          ['tag-no.zim', packUuid('22222222', 'tagn'), 'wikipedia;_ftindex:no', 'no'],
          ['tag-bare.zim', packUuid('33333333', 'tagb'), 'wikipedia;_ftindex', 'yes'],
          ['tag-absent.zim', packUuid('44444444', 'taga'), 'wikipedia;_pictures:no', null],
          ['tag-null.zim', packUuid('55555555', 'tagx'), null, null]
        ]
        const ids: string[] = []
        for (const [leaf, uuid, tags] of variants) ids.push(await h.addPack(leaf, uuid, tags))
        const listed = listPacks(h.db)
        variants.forEach(([leaf, , , hint], i) => {
          const pack = listed.find((p) => p.id === ids[i])!
          expect(pack.searchableHint, leaf).toBe(hint)
          // A hint is NEVER a verdict (plan §9.21 (d)2): every one of them is still unknown.
          expect(pack.searchable, leaf).toBe('unknown')
        })
      } finally {
        await h.close()
      }
    }

    // ---- (3) THE PROBE MATRIX through a real service, at the reconcile's end ------------
    const h = searchableHarness({ probeTimeoutMs: 150 })
    let yesPack = ''
    let noPack = ''
    let unknownPack = ''
    try {
      suggested = []
      searchedBooks = []
      yesPack = await h.addPack('indexed.zim', packUuid('aaaa1111', 'idx'), '_ftindex:no')
      noPack = await h.addPack('indexless.zim', packUuid('bbbb2222', 'nidx'), '_ftindex:yes')
      unknownPack = await h.addPack('ambiguous.zim', packUuid('cccc3333', 'amb'), null)
      const parkedPack = await h.addPack('parked.zim', packUuid('dddd4444', 'prk'), null)
      const junkPack = await h.addPack('junkjson.zim', packUuid('eeee5555', 'jnk'), null)
      const objectPack = await h.addPack('objectjson.zim', packUuid('ffff6666', 'obj'), null)
      suggestAnswers = new Map([
        [bookNames.get(yesPack)!, 'pattern'],
        [bookNames.get(noPack)!, 'no-pattern'],
        [bookNames.get(unknownPack)!, 'four-oh-four'],
        [bookNames.get(parkedPack)!, 'park'],
        [bookNames.get(junkPack)!, 'bad-json'],
        [bookNames.get(objectPack)!, 'not-json-array']
      ])

      await h.svc.reconcile(h.db)

      // The verdicts: only a 200 with the pattern entry is "yes", only a 200 array without one
      // is "no", and a 404, a timeout, a malformed body and a non-array body ALL stay unknown.
      expect(searchableOf(h.db, yesPack)).toBe('yes')
      expect(searchableOf(h.db, noPack)).toBe('no')
      expect(searchableOf(h.db, unknownPack)).toBeNull()
      expect(searchableOf(h.db, parkedPack)).toBeNull()
      expect(searchableOf(h.db, junkPack)).toBeNull()
      expect(searchableOf(h.db, objectPack)).toBeNull()
      // The archive's own tag said the opposite for both confirmed packs — the LIVE probe wins,
      // and the hint is still recorded beside it, unchanged.
      const listed = listPacks(h.db)
      expect(listed.find((p) => p.id === yesPack)).toMatchObject({
        searchable: 'yes',
        searchableHint: 'no'
      })
      expect(listed.find((p) => p.id === noPack)).toMatchObject({
        searchable: 'no',
        searchableHint: 'yes'
      })
      // Every pack was probed under the name the SERVICE serves it as, exactly once.
      expect(suggested).toEqual(
        expect.arrayContaining([bookNames.get(yesPack)!, bookNames.get(noPack)!])
      )
      expect(suggested.filter((n) => n === bookNames.get(yesPack)!)).toHaveLength(1)

      // A SECOND reconcile probes only what is still unknown — a confirmed verdict is cached.
      const before = suggested.length
      await h.svc.reconcile(h.db)
      expect(suggested.slice(before)).not.toContain(bookNames.get(yesPack)!)
      expect(suggested.slice(before)).not.toContain(bookNames.get(noPack)!)
      expect(suggested.length).toBeGreaterThan(before) // …the unknown ones ARE asked again

      // ---- (4) A CONFIRMED-NO PACK IS STILL READABLE ---------------------------------
      // "Not searchable" is a statement about the Xapian index, never about the archive: the
      // viewer must still open its articles (plan §9.21 (d)6).
      const article = await h.svc.getArticle(h.db, noPack, 'A/Alpha')
      expect(article?.title).toBe('Alpha')
      expect(JSON.stringify(article?.sections)).toContain('Treibhausgas')
      // …and the ask SKIPS it without a request, with an honest outcome.
      searchedBooks = []
      const skipped = await h.svc.runArm(h.db, [noPack], 'Alpha Treibhausgas')
      expect(skipped.candidates).toEqual([])
      expect(skipped.outcomes).toEqual([
        expect.objectContaining({ packId: noPack, status: 'skipped', reason: 'not-searchable' })
      ])
      expect(searchedBooks).toEqual([])

      // ---- (5) A /search 404 DURING AN ASK WRITES NOTHING ----------------------------
      // The review's M7 starting point: kiwix-serve answers 404 on an index-less book. It is
      // AMBIGUOUS (§2.2), so it is this ask's failure and never a persisted capability.
      searchStatus.set(unknownPack, 404)
      searchedBooks = []
      const askOutcome = await h.svc.runArm(h.db, [unknownPack], 'Alpha Treibhausgas')
      expect(askOutcome.candidates).toEqual([])
      expect(askOutcome.outcomes).toEqual([
        expect.objectContaining({ packId: unknownPack, status: 'failed', reason: 'search-failed' })
      ])
      expect(searchedBooks).toEqual([unknownPack]) // it really was searched
      expect(searchableOf(h.db, unknownPack)).toBeNull() // …and nothing was written
      searchStatus.delete(unknownPack)

      // ---- (6) THE FILE CHANGES: the verdict is reset and re-taken -------------------
      // The cached verdict belongs to a FILE, not to a uuid: a replaced archive with the same
      // identity must be probed again instead of inheriting "yes".
      const keyBefore = keyOf(h.db, yesPack)
      expect(keyBefore).not.toBeNull()
      appendFileSync(join(h.zimDir, 'indexed.zim'), 'more bytes make a different archive')
      suggestAnswers.set(bookNames.get(yesPack)!, 'no-pattern') // the new file has no index
      const probesBeforeFileChange = suggested.length
      await h.svc.reconcile(h.db)
      expect(keyOf(h.db, yesPack)).not.toBe(keyBefore)
      expect(suggested.slice(probesBeforeFileChange)).toContain(bookNames.get(yesPack)!)
      expect(searchableOf(h.db, yesPack)).toBe('no') // re-probed, not remembered

      // ---- (7) THE TOOLS CHANGE: same file, new binary, re-probe --------------------
      const keyAfterFile = keyOf(h.db, yesPack)
      h.fingerprint.value = 'serve:2000:222' // a swapped kiwix-tools bundle
      suggestAnswers.set(bookNames.get(yesPack)!, 'pattern') // the new build CAN search it
      const probesBeforeToolChange = suggested.length
      await h.svc.reconcile(h.db)
      expect(keyOf(h.db, yesPack)).not.toBe(keyAfterFile)
      expect(suggested.slice(probesBeforeToolChange)).toContain(bookNames.get(yesPack)!)
      expect(searchableOf(h.db, yesPack)).toBe('yes')
    } finally {
      await h.close()
    }

    // ---- (8) A PROBE OBSERVED ACROSS A CHILD DEATH WRITES NOTHING ---------------------
    // The response may not have come from our child at all (the P5 guard, plan §9.19 (a)3):
    // both attempts are discarded, the batch is dropped, and the pack stays unknown.
    {
      const death = searchableHarness()
      try {
        suggested = []
        const pack = await death.addPack('dies.zim', packUuid('a1a1a1a1', 'die'), null)
        suggestAnswers.set(bookNames.get(pack)!, 'pattern') // it WOULD have said "yes"
        onSuggest = () => {
          // The child dies while our response is in flight — on both the attempt and its one
          // admitted retry, so the guard discards the batch twice (StaleServerError).
          const child = death.liveChild()
          if (!child.exited) child.emit('exit', 0, null)
        }
        await death.svc.reconcile(death.db)
        onSuggest = null
        expect(suggested.length).toBe(2) // the attempt plus EXACTLY one retry
        expect(searchableOf(death.db, pack)).toBeNull() // …and not a single write
      } finally {
        onSuggest = null
        await death.close()
      }
    }

    // ---- (9) NO POST-LOCK CAPABILITY WRITE -------------------------------------------
    // The admission seam is flipped WHILE the probe response is parked (a controlled promise,
    // never a sleep): the operation's recheck after the request turns it into the #159
    // AbortError, the reconcile rejects, and the verdict is never written.
    {
      const locked = searchableHarness()
      try {
        suggested = []
        const pack = await locked.addPack('locks.zim', packUuid('b2b2b2b2', 'lck'), null)
        suggestAnswers.set(bookNames.get(pack)!, 'pattern')
        const gate = serveGate<void>()
        suggestGate = gate
        const pass = locked.svc.reconcile(locked.db)
        await gate.entered
        locked.admits.value = false // the workspace locked mid-probe
        suggestGate = null
        gate.release()
        await expect(pass).rejects.toMatchObject({ name: 'AbortError' })
        expect(searchableOf(locked.db, pack)).toBeNull()
        expect(suggested).toHaveLength(1) // no retry into a session that stopped admitting it
      } finally {
        suggestGate = null
        await locked.close()
      }
    }

    // ---- (10) NO UNKNOWN PACK ⇒ NO SIDECAR AT ALL ------------------------------------
    // The recorded cost of putting the probe in the reconcile: a session whose packs are all
    // confirmed must not start a server just to find that out.
    {
      const quiet = searchableHarness()
      try {
        const pack = await quiet.addPack('quiet.zim', packUuid('c3c3c3c3', 'qui'), null)
        suggestAnswers.set(bookNames.get(pack)!, 'pattern')
        await quiet.svc.reconcile(quiet.db)
        expect(searchableOf(quiet.db, pack)).toBe('yes')
        const spawnsAfterFirst = quiet.serveChildren.length
        expect(spawnsAfterFirst).toBeGreaterThan(0)
        await quiet.svc.stop()
        suggested = []
        // A fresh reconcile with nothing unknown left: no probe, and no child for one.
        await quiet.svc.reconcile(quiet.db).catch(() => undefined)
        expect(suggested).toEqual([])
      } finally {
        await quiet.close()
      }
    }
  }, 30_000)
})
