import { describe, it, expect } from 'vitest'
import { closeSync, constants, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  SCHEMA_VERSION,
  openDatabase,
  probeDatabaseFile,
  sqliteJudgedDamaged,
  sqliteSchemaUnreadable,
  walAwaitsCheckpoint
} from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { openRawDb, tempRoot } from '../helpers/db-fixtures'
import { oversizedFirstCell, plantProbeTrap, writeNewerSchema } from '../helpers/vault-fixtures'

// #876: the lock's guard, the #855 lost-copy verdict, the init() salvage, the `.recovery` roll-forward and the v1 rekey
// stage all decide "is this file a database?" before they encrypt it over `.enc` or shred it. A 16-byte header check
// passes on noise whose page 1 a checkpoint wrote back from the WAL; `probeDatabaseFile` reads the structure: the
// schema, the first row of every table, and the root page of every index. These rows pin its verdicts on the real
// app schema and its two traps (A1 §2.5): a plain read-only open of a WAL-mode file leaves `-wal`/`-shm` behind (the
// salvage reads live sidecars as a mid-session crash and shreds), and `INDEXED BY` throws on the app's partial index.

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A closed, checkpointed workspace database with the real schema (its partial index included), and the root page of
 *  each named b-tree, read while it was open. */
function appDatabase(...names: string[]): { path: string; pageSize: number; roots: Record<string, number> } {
  const path = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
  const db = openDatabase(path)
  seedSettings(db)
  const roots: Record<string, number> = {}
  for (const name of names) {
    roots[name] = (db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(name) as { rootpage: number }).rootpage
  }
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  return { path, pageSize, roots }
}

/** Overwrite one page in place with a fixed non-b-tree byte (0xA5 is no page type), so the row is deterministic. */
function overwritePage(path: string, page: number, pageSize: number): void {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (page - 1) * pageSize)
  } finally {
    closeSync(fd)
  }
}

describe('probeDatabaseFile (#876)', () => {
  it('reads the app schema, partial index included, as a database, and leaves the file byte-identical with no -wal/-shm', () => {
    const { path } = appDatabase()
    const before = sha(path)
    expect(probeDatabaseFile(path).verdict).toBe('database')
    expect(sha(path)).toBe(before)
    expect(readdirSync(dirname(path))).toEqual(['hilbertraum.sqlite'])
  })

  // The two b-tree kinds the probe reads two different ways: an index root by its page header (the partial index
  // cannot be read through SQL by name), a table root through a first-row read.
  // A WITHOUT ROWID table (FTS5's `_config`) has no rowid to read the last row by, so only the first-row read reaches it.
  it.each([
    ['the partial index idx_documents_pending_dest', 'idx_documents_pending_dest'],
    ['the settings table', 'settings'],
    ['the WITHOUT ROWID table chunks_fts_config', 'chunks_fts_config']
  ])('a database whose root page of %s is noise is damaged', (_what, name) => {
    const { path, pageSize, roots } = appDatabase(name)
    overwritePage(path, roots[name], pageSize)
    expect(probeDatabaseFile(path).verdict).toBe('damaged')
    expect(readdirSync(dirname(path))).toEqual(['hilbertraum.sqlite'])
  })

  // An index root is judged by its page header, read through node:fs. Noise rarely starts with a b-tree page type; one
  // that does must still fail the rest of the header. Each crafted header breaks one rule and keeps the others; the
  // first row, a plausible empty leaf, shows the rules reject nothing a real page can hold.
  it.each<[string, number[], 'database' | 'damaged']>([
    ['a plausible empty leaf', [0x0a, 0, 0, 0, 0, 0x10, 0x00, 0], 'database'],
    ['a leaf whose cell pointers run past its content area', [0x0a, 0, 0, 0, 100, 0, 100, 0], 'damaged'],
    ['a leaf whose content area starts past the page (0 = 65,536)', [0x0a, 0, 0, 0, 0, 0, 0, 0], 'damaged'],
    ['a leaf whose first freeblock sits before its content area', [0x0a, 0, 9, 0, 1, 0x0f, 0xa0, 0], 'damaged'],
    ['a leaf with more than 60 fragmented bytes', [0x0a, 0, 0, 0, 0, 0x10, 0x00, 61], 'damaged'],
    ['an interior page whose right child is no page', [0x02, 0, 0, 0, 0, 0x10, 0x00, 0, 0, 0, 0, 0], 'damaged'],
    ['an interior page whose right child is past the end of the file', [0x02, 0, 0, 0, 0, 0x10, 0x00, 0, 0x7f, 0xff, 0xff, 0xff], 'damaged']
  ])('an index root page that starts like a b-tree page: %s', (_what, header, verdict) => {
    const { path, pageSize, roots } = appDatabase('idx_documents_pending_dest')
    expect(pageSize).toBe(4096) // the crafted content-area offsets assume it
    const page = Buffer.alloc(pageSize)
    Buffer.from(header).copy(page)
    const fd = openSync(path, 'r+')
    try {
      writeSync(fd, page, 0, pageSize, (roots.idx_documents_pending_dest - 1) * pageSize)
    } finally {
      closeSync(fd)
    }
    expect(probeDatabaseFile(path).verdict).toBe(verdict)
  })

  // The probe reads the path down to the FIRST row of every table, and that path sits near the start of the file. An
  // overwrite that runs to the END of the file (a cut-off copy written back, a failing stick's last blocks) leaves
  // those pages alone, so the probe reads the path down to the last row of every rowid table too.
  it('a database whose last pages are noise is damaged', () => {
    const path = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    const db = openDatabase(path)
    seedSettings(db)
    const now = new Date().toISOString()
    db.prepare("INSERT INTO documents (id, title, status, created_at, updated_at) VALUES ('d', 't', 'ready', ?, ?)").run(now, now)
    const insert = db.prepare(
      "INSERT INTO chunks (id, document_id, chunk_index, text, source_label, created_at) VALUES (?, 'd', ?, ?, 'p. 1', ?)"
    )
    db.exec('BEGIN')
    for (let i = 0; i < 600; i++) insert.run(`c${i}`, i, `chunk ${i} `.repeat(120), now)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    const size = statSync(path).size
    const tail = 32 * 4096
    const fd = openSync(path, 'r+')
    try {
      writeSync(fd, randomBytes(tail), 0, tail, size - tail)
    } finally {
      closeSync(fd)
    }
    expect(probeDatabaseFile(path).verdict).toBe('damaged')
  })

  // SQLite cannot open a Windows path of 260 characters or more unless it is written in the `\\?\` long form; node:fs
  // can. A probe that answered `unknown` there would refuse to roll a `.recovery` forward that the old header read
  // took (a 251-character working file has a 260-character `.recovery`).
  it('a database at a path past Windows MAX_PATH is a database', () => {
    const { path } = appDatabase()
    let dir = dirname(path)
    while (dir.length < 280) dir = join(dir, 'p'.repeat(60))
    mkdirSync(dir, { recursive: true })
    const long = join(dir, 'hilbertraum.sqlite.recovery')
    writeFileSync(long, readFileSync(path))
    expect(long.length).toBeGreaterThan(300)
    expect(probeDatabaseFile(long).verdict).toBe('database')
    expect(readdirSync(dir)).toEqual(['hilbertraum.sqlite.recovery'])
  })

  it.each<[string, (path: string) => void]>([
    ['an empty file (a valid empty database to SQLite itself)', (path) => writeFileSync(path, '')],
    ['noise', (path) => writeFileSync(path, randomBytes(64 * 1024))],
    ['the SQLite magic and nothing after it', (path) => writeFileSync(path, 'SQLite format 3\u0000')]
  ])('%s is not a database', (_what, write) => {
    const path = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    write(path)
    expect(probeDatabaseFile(path).verdict).toBe('not-database')
  })

  it('a missing file is gone, and one that cannot be read is unknown', () => {
    const root = tempRoot('db-probe')
    expect(probeDatabaseFile(join(root, 'hilbertraum.sqlite')).verdict).toBe('gone')
    // A directory under the file's name stands in for an unreadable file on every OS (a hold, a permission error).
    const dir = join(root, 'held.sqlite')
    mkdirSync(dir)
    expect(probeDatabaseFile(dir).verdict).toBe('unknown')
  })

  // A drive started from a network share has a UNC workspace path. SQLite refuses a URI whose authority is a host, so
  // the probe must spell it `file:////host/share/…`; a `pathToFileURL` URI would make every probe `unknown` there and
  // refuse every lock. Reached through this computer's own administrative share, where this account can open it.
  const local = appDatabase().path
  const unc = `\\\\localhost\\${local[0]}$${local.slice(2)}`
  const uncReachable = process.platform === 'win32' && (() => {
    try {
      return statSync(unc).isFile()
    } catch {
      return false
    }
  })()
  it.runIf(uncReachable)('a database on a UNC path is a database', () => {
    expect(probeDatabaseFile(unc).verdict).toBe('database')
    expect(readdirSync(dirname(local))).toEqual(['hilbertraum.sqlite'])
  })

  // #876 review round 3: two shapes of noise that SQLite reports with a code other than CORRUPT/NOTADB, so the round-2
  // fallback encrypted them: the schema-format number (header offset 44; SQLite reads its low byte, offset 47) above 4
  // ("unsupported file format", SQLITE_ERROR) with the rest of the header intact, and a cell whose record claims a value
  // longer than SQLite allows (SQLITE_TOOBIG). Both are proven damage.
  it.each<[string, (path: string, roots: Record<string, number>) => void]>([
    ['the schema-format byte (offset 47) above 4, the rest of the header intact', (path) => {
      const fd = openSync(path, 'r+')
      try {
        writeSync(fd, Buffer.from([9]), 0, 1, 47)
      } finally {
        closeSync(fd)
      }
    }],
    ['a first cell claiming a value longer than SQLite allows (SQLITE_TOOBIG)', (path, roots) => oversizedFirstCell(path, roots.collections)]
  ])('%s is damaged', (_what, spoil) => {
    const { path, roots } = appDatabase('collections')
    spoil(path, roots)
    expect(probeDatabaseFile(path).verdict).toBe('damaged')
  })

  // #876 review round 2: the probe may only ADD a refusal or a discard for proven damage. When its SQLite stage fails
  // for another reason, the file is `unchecked` (with the code, for the log), and every caller judges it by its header,
  // as before the probe existed. A table only its creating connection can read stands in for that failure.
  it('a database whose structure SQLite cannot read for a reason that is not damage is unchecked, with the code', () => {
    const path = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    const db = openDatabase(path)
    plantProbeTrap(db)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    expect(probeDatabaseFile(path)).toEqual({ verdict: 'unchecked', code: expect.stringMatching(/^sqlite 1\b/) })
    expect(readdirSync(dirname(path))).toEqual(['hilbertraum.sqlite'])
  })

  // #985 (W-66): a newer build's schema can hold text this SQLite cannot parse, which fails every schema read with
  // SQLITE_CORRUPT, so the probe called such a file damaged and three callers discarded it. The header's schema stamp
  // (`user_version`, offset 60, signed) above this build's is `newer`, read before SQLite opens the file. The same
  // unparseable row under this build's own stamp stays damage: a later release that ships such text must bump the stamp.
  it.each<[string, { userVersion: number; unparseable: boolean }, object]>([
    ['stamped one above this build, over a schema row this SQLite cannot parse, is newer', { userVersion: SCHEMA_VERSION + 1, unparseable: true }, { verdict: 'newer', found: SCHEMA_VERSION + 1 }],
    ['stamped one above this build, over the app schema, is newer', { userVersion: SCHEMA_VERSION + 1, unparseable: false }, { verdict: 'newer', found: SCHEMA_VERSION + 1 }],
    ['stamped with the version of this build, over a schema row this SQLite cannot parse, is damaged',{ userVersion: SCHEMA_VERSION, unparseable: true }, { verdict: 'damaged' }],
    ['stamped -1 (the stamp is signed), over the app schema, is a database', { userVersion: -1, unparseable: false }, { verdict: 'database' }]
  ])('a database %s (#985), and stays byte-identical', (_what, stamp, verdict) => {
    const { path } = appDatabase()
    writeNewerSchema(path, stamp)
    const before = sha(path)
    expect(probeDatabaseFile(path)).toEqual(verdict)
    expect(sha(path)).toBe(before)
    expect(readdirSync(dirname(path))).toEqual(['hilbertraum.sqlite'])
  })

  // App-update F-27 ("three header fields no stamp excuses", T2.11 S-2): the magic, the page size and the schema format
  // number are judged BEFORE the stamp. A file stamped above this build that breaks one of them is "no database" or
  // damaged, never newer, so no stamp makes release 1 keep noise as a newer version's copy, or refuse a workspace over
  // it. The first row, the stamp alone over an intact header, shows that the stamp this row writes is read.
  it.each<[string, (header: Buffer) => void, object]>([
    ['nothing else broken', () => {}, { verdict: 'newer', found: SCHEMA_VERSION + 1 }],
    ['the SQLite magic broken', (header) => void (header[0] = 0x73), { verdict: 'not-database' }],
    ['a page size that is no power of two (1,000)', (header) => void header.writeUInt16BE(1000, 16), { verdict: 'damaged' }],
    ['a schema format number above 4', (header) => void (header[47] = 9), { verdict: 'damaged' }]
  ])('a file stamped above this build with %s: the header is judged before the stamp (F-27)', (_what, spoil, verdict) => {
    const { path } = appDatabase()
    const fd = openSync(path, 'r+')
    try {
      const header = Buffer.alloc(100)
      expect(readSync(fd, header, 0, header.length, 0)).toBe(header.length)
      header.writeInt32BE(SCHEMA_VERSION + 1, 60) // the stamp (`PRAGMA user_version`)
      spoil(header)
      writeSync(fd, header, 0, header.length, 0)
    } finally {
      closeSync(fd)
    }
    expect(probeDatabaseFile(path)).toEqual(verdict)
  })
})

// W-68 (app-update wave, T2.14): an unlock whose open fails because SQLite cannot parse the schema ("malformed database
// schema", what a newer version's schema text does to this SQLite, and also damage inside `sqlite_schema` itself) gets
// its own copy instead of "restore from a backup". Told apart from other damage by SQLite's message prefix only, on a
// SQLITE_CORRUPT error; the damage verdict itself (`sqliteJudgedDamaged`) is unchanged and calls both damaged.
describe('sqliteSchemaUnreadable (W-68)', () => {
  /** What `run` threw (a row whose step does not throw fails here). */
  const thrown = (run: () => unknown): unknown => {
    try {
      run()
    } catch (err) {
      return err
    }
    throw new Error('expected the step to throw')
  }

  it('is true for a schema this SQLite cannot parse, and false for a damaged table page, noise and a look-alike', () => {
    const schema = appDatabase().path
    writeNewerSchema(schema, { userVersion: SCHEMA_VERSION }) // this build's stamp, so the open reads the schema
    const schemaErr = thrown(() => openDatabase(schema))

    const { path: page, pageSize, roots } = appDatabase('settings')
    overwritePage(page, roots.settings, pageSize)
    const raw = openRawDb(page, { readOnly: true })
    const pageErr = thrown(() => raw.prepare('SELECT * FROM settings').all())
    raw.close()

    const noise = join(tempRoot('db-probe'), 'noise.sqlite')
    writeFileSync(noise, randomBytes(8192))
    const rawNoise = openRawDb(noise, { readOnly: true })
    const noiseErr = thrown(() => rawNoise.prepare('SELECT * FROM sqlite_schema').all())
    rawNoise.close()

    // Both SQLite errors are damage to the existing verdict; only the schema one is "unreadable schema".
    expect(sqliteJudgedDamaged(schemaErr)).toBe(true)
    expect(sqliteSchemaUnreadable(schemaErr)).toBe(true)
    expect(sqliteJudgedDamaged(pageErr)).toBe(true)
    expect(sqliteSchemaUnreadable(pageErr)).toBe(false)
    expect(sqliteSchemaUnreadable(noiseErr)).toBe(false)
    // The words alone are not enough: SQLite's CORRUPT code has to be on the error too.
    expect(sqliteSchemaUnreadable(new Error('malformed database schema (w985_future)'))).toBe(false)
    expect(sqliteSchemaUnreadable(null)).toBe(false)
  })
})

// #876 (review rounds 1 and 2): the lock refuses while the `-wal` still holds commits the main file lacks. Only a WAL
// header (either of SQLite's two magic numbers) with something after it counts; a header alone holds no frame, and
// noise is no WAL. A `-wal` with frames that cannot be read (a hold) counts too: refusing is the safe answer there.
describe('walAwaitsCheckpoint (#876)', () => {
  const UV_FS_O_EXLOCK = 0x10000000
  const header = (magic: number): Buffer => {
    const b = Buffer.alloc(32)
    b.writeUInt32BE(magic, 0)
    b.writeUInt32BE(3007000, 4)
    b.writeUInt32BE(4096, 8)
    return b
  }
  it.each<[string, Buffer | null, boolean]>([
    ['no -wal', null, false],
    ['a WAL header and nothing after it', header(0x377f0682), false],
    ['a WAL header (magic 0x377f0682) with a frame', Buffer.concat([header(0x377f0682), randomBytes(24 + 4096)]), true],
    ['a WAL header (magic 0x377f0683) with a frame', Buffer.concat([header(0x377f0683), randomBytes(24 + 4096)]), true],
    ['noise', randomBytes(64 * 1024), false]
  ])('%s → %s', (_what, wal, pending) => {
    const dbPath = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    if (wal) writeFileSync(`${dbPath}-wal`, wal)
    expect(walAwaitsCheckpoint(dbPath)).toBe(pending)
  })

  // A real hold: on Windows a handle opened with libuv's UV_FS_O_EXLOCK (0x10000000; node:fs passes it through but does not
  // export it) shares nothing, so the check's own open fails with EBUSY while a stat still works.
  it.runIf(process.platform === 'win32')('a -wal with frames that another program holds exclusively counts as holding commits', () => {
    const dbPath = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    writeFileSync(`${dbPath}-wal`, Buffer.concat([header(0x377f0682), randomBytes(24 + 4096)]))
    const hold = openSync(`${dbPath}-wal`, constants.O_RDONLY | UV_FS_O_EXLOCK)
    try {
      expect(() => closeSync(openSync(`${dbPath}-wal`, 'r'))).toThrow(/EBUSY/)
      expect(walAwaitsCheckpoint(dbPath)).toBe(true)
    } finally {
      closeSync(hold)
    }
  })
})
