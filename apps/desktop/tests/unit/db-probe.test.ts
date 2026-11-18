import { describe, it, expect } from 'vitest'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { openDatabase, probeDatabaseFile } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { tempRoot } from '../helpers/db-fixtures'

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
    expect(probeDatabaseFile(path)).toBe('database')
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
    expect(probeDatabaseFile(path)).toBe('damaged')
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
    expect(probeDatabaseFile(path)).toBe(verdict)
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
    expect(probeDatabaseFile(path)).toBe('damaged')
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
    expect(probeDatabaseFile(long)).toBe('database')
    expect(readdirSync(dir)).toEqual(['hilbertraum.sqlite.recovery'])
  })

  it.each<[string, (path: string) => void]>([
    ['an empty file (a valid empty database to SQLite itself)', (path) => writeFileSync(path, '')],
    ['noise', (path) => writeFileSync(path, randomBytes(64 * 1024))],
    ['the SQLite magic and nothing after it', (path) => writeFileSync(path, 'SQLite format 3\u0000')]
  ])('%s is not a database', (_what, write) => {
    const path = join(tempRoot('db-probe'), 'hilbertraum.sqlite')
    write(path)
    expect(probeDatabaseFile(path)).toBe('not-database')
  })

  it('a missing file is gone, and one that cannot be read is unknown', () => {
    const root = tempRoot('db-probe')
    expect(probeDatabaseFile(join(root, 'hilbertraum.sqlite'))).toBe('gone')
    // A directory under the file's name stands in for an unreadable file on every OS (a hold, a permission error).
    const dir = join(root, 'held.sqlite')
    mkdirSync(dir)
    expect(probeDatabaseFile(dir)).toBe('unknown')
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
    expect(probeDatabaseFile(unc)).toBe('database')
    expect(readdirSync(dirname(local))).toEqual(['hilbertraum.sqlite'])
  })
})
