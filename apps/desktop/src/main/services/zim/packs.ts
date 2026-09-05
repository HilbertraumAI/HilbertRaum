import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { KnowledgePack } from '../../../shared/types'
import { type Db, prepareCached } from '../db'
import { log } from '../logging'
import { parseLibraryXml, type KiwixBook } from './client'
import { KiwixManageError } from './tools'

// Knowledge-pack registry (ZIM wave): CRUD + disk reconciliation over the
// `knowledge_packs` table. Follows the skills-registry shape — disk is the truth for
// AVAILABILITY (recomputed at list time; `unavailable_at` marks a vanished file, never a
// blind delete), the DB is the truth for REGISTRATION (which archives the user added,
// enabled state). File resolution follows ingestion/stored-copy.ts: the drive-relative
// `zim/<leaf>` first (survives a drive remount under a new letter), the recorded path
// second.
//
// Registration metadata comes from `kiwix-manage add` into a throwaway library.xml —
// kiwix-manage reads only the ZIM header, so registering a 100 GB archive is fast and
// needs no libzim binding (the Windows blocker the 2026-08-22 spike established).

/** Adds one ZIM to a library.xml — bound to the real kiwix-manage in index.ts; tests fake it.
 *  `signal` (additive third param, P3a/M9) is forwarded from `writeLibraryXml` so a caller
 *  teardown can cancel an in-flight `kiwix-manage` child; every existing fake still
 *  type-checks (it simply never reads a third argument). */
export type ManageAddFn = (libraryXmlPath: string, zimPath: string, signal?: AbortSignal) => Promise<void>

export interface PackDeps {
  /** The drive's `zim/` folder (canonical pack home; may not exist). */
  zimDir: string
  manageAdd: ManageAddFn
  /**
   * Where the registration throwaway `library.xml` goes (#301 P3b, findings L3/M4). Production
   * returns a fresh `<workspacePath>/zim-transient/meta-<n>` (`<n>` from the service's ONE
   * generation allocator, so it never repeats in a process) and tracks the file on the owning
   * operation before it is written. Absent ⇒ the P3a OS-temp `hilbertraum-zim-meta-` fallback
   * (tests only; production always supplies this).
   */
  metaDir?: () => string
  /**
   * Called with the throwaway directory when the manager child could not be confirmed dead: it
   * is kept (a possibly-live child may still write into it) and the caller adds it to the set
   * the transient cleanup must leave alone until the next session start.
   */
  onUncertain?: (path: string) => void
  /**
   * The owning operation's admission / cancellation / epoch recheck (#301 P3b, finding H4).
   * Called after the manager work and immediately BEFORE the registry write, so a registration
   * whose metadata read straddled a lock (or a lock + unlock) never reaches the database.
   * Throws the `AbortError` the caller propagates. Absent ⇒ no recheck (tests, partial contexts).
   */
  assert?: () => void
}

interface PackRow {
  id: string
  title: string
  description: string | null
  language: string | null
  zim_date: string | null
  article_count: number | null
  media_count: number | null
  size_bytes: number | null
  leaf: string
  recorded_path: string
  enabled: number
  unavailable_at: string | null
  removed_at: string | null
  added_at: string
  updated_at: string
}

function rowToPack(row: PackRow, available: boolean): KnowledgePack {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    language: row.language,
    zimDate: row.zim_date,
    articleCount: row.article_count,
    sizeBytes: row.size_bytes,
    leaf: row.leaf,
    enabled: row.enabled === 1,
    available,
    addedAt: row.added_at
  }
}

/** Resolve a pack's file: drive `zim/<leaf>` first, recorded path second, else null. */
export function resolvePackFile(zimDir: string, row: Pick<PackRow, 'leaf' | 'recorded_path'>): string | null {
  const canonical = join(zimDir, row.leaf)
  if (existsSync(canonical)) return canonical
  if (row.recorded_path && existsSync(row.recorded_path)) return row.recorded_path
  return null
}

const nowIso = (): string => new Date().toISOString()

/**
 * List all registered packs, availability recomputed against disk. The
 * `unavailable_at` stamp is healed/set as a side effect (cheap: one existsSync per
 * pack; the skills mark-unavailable rule).
 */
export function listPacks(db: Db, zimDir: string): KnowledgePack[] {
  const rows = prepareCached(
    db,
    'SELECT * FROM knowledge_packs WHERE removed_at IS NULL ORDER BY title COLLATE NOCASE, id'
  ).all() as unknown as PackRow[]
  const out: KnowledgePack[] = []
  for (const row of rows) {
    const available = resolvePackFile(zimDir, row) !== null
    if (available && row.unavailable_at !== null) {
      prepareCached(db, 'UPDATE knowledge_packs SET unavailable_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso(),
        row.id
      )
    } else if (!available && row.unavailable_at === null) {
      prepareCached(db, 'UPDATE knowledge_packs SET unavailable_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso(),
        nowIso(),
        row.id
      )
    }
    out.push(rowToPack(row, available))
  }
  return out
}

/** The packs the retrieval arm should query: requested ∩ enabled ∩ available, with
 *  each pack's resolved absolute file path. */
export function retrievablePacks(
  db: Db,
  zimDir: string,
  packIds: readonly string[]
): Array<KnowledgePack & { filePath: string }> {
  if (packIds.length === 0) return []
  const wanted = new Set(packIds)
  const rows = prepareCached(db, 'SELECT * FROM knowledge_packs WHERE enabled = 1 AND removed_at IS NULL').all() as unknown as PackRow[]
  const out: Array<KnowledgePack & { filePath: string }> = []
  for (const row of rows) {
    if (!wanted.has(row.id)) continue
    const filePath = resolvePackFile(zimDir, row)
    if (!filePath) continue
    out.push({ ...rowToPack(row, true), filePath })
  }
  return out
}

/**
 * Register (or re-register) one ZIM archive. Runs kiwix-manage into a throwaway
 * library.xml, parses the book element, and UPSERTs by archive UUID. Throws with the
 * kiwix-manage stderr on an unreadable/non-ZIM file.
 */
export async function registerPack(db: Db, deps: PackDeps, zimPath: string): Promise<KnowledgePack> {
  const book = await readZimMetadata(deps, zimPath)
  // H4: the manager work above is an await. Recheck the owning operation's admission, epoch
  // and cancellation before the UPSERT — a registration that straddled a lock must not write
  // into the session's database (nor into the NEXT session's, after a lock + unlock).
  deps.assert?.()
  const leaf = basename(zimPath)
  let sizeBytes: number | null = null
  try {
    sizeBytes = statSync(zimPath).size
  } catch {
    /* registration still valid; size is cosmetic */
  }
  const now = nowIso()
  const existing = prepareCached(db, 'SELECT added_at FROM knowledge_packs WHERE id = ?').get(book.id) as
    | { added_at: string }
    | undefined
  prepareCached(
    db,
    `INSERT INTO knowledge_packs
       (id, title, description, language, zim_date, article_count, media_count, size_bytes,
        leaf, recorded_path, enabled, unavailable_at, removed_at, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, description = excluded.description,
       language = excluded.language, zim_date = excluded.zim_date,
       article_count = excluded.article_count, media_count = excluded.media_count,
       size_bytes = excluded.size_bytes, leaf = excluded.leaf,
       recorded_path = excluded.recorded_path, unavailable_at = NULL,
       removed_at = NULL, enabled = 1,
       updated_at = excluded.updated_at`
  ).run(
    book.id,
    book.title ?? leaf.replace(/\.zim$/i, ''),
    book.description,
    book.language,
    book.date,
    book.articleCount,
    book.mediaCount,
    sizeBytes,
    leaf,
    zimPath,
    existing?.added_at ?? now,
    now
  )
  const row = prepareCached(db, 'SELECT * FROM knowledge_packs WHERE id = ?').get(book.id) as unknown as PackRow
  return rowToPack(row, true)
}

/**
 * Remove a registration (the archive FILE is never touched). A TOMBSTONE, not a DELETE:
 * drive auto-discovery keys "already known" by leaf, so a deleted row for a file still
 * sitting in zim/ would resurrect on the next list. True when a live row existed.
 */
export function removePack(db: Db, id: string): boolean {
  const res = prepareCached(
    db,
    'UPDATE knowledge_packs SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL'
  ).run(nowIso(), nowIso(), id)
  return Number(res.changes) > 0
}

/** Flip a pack's enabled flag. True when the row existed. */
export function setPackEnabled(db: Db, id: string, enabled: boolean): boolean {
  const res = prepareCached(
    db,
    'UPDATE knowledge_packs SET enabled = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL'
  ).run(enabled ? 1 : 0, nowIso(), id)
  return Number(res.changes) > 0
}

/**
 * Register every `*.zim` in the drive's `zim/` folder that no row points at yet
 * (matched by leaf — the UUID is only knowable by reading the file, which registration
 * does anyway). A file that fails to register is skipped with a warn, never fatal —
 * one corrupt download must not block the others (the ingestion error posture).
 */
export async function discoverDrivePacks(db: Db, deps: PackDeps): Promise<number> {
  let files: string[]
  try {
    files = readdirSync(deps.zimDir).filter((f) => f.toLowerCase().endsWith('.zim'))
  } catch {
    return 0 // absent zim/ dir — nothing to discover
  }
  const known = new Set(
    (prepareCached(db, 'SELECT leaf FROM knowledge_packs').all() as unknown as Array<{ leaf: string }>).map(
      (r) => r.leaf
    )
  )
  let added = 0
  for (const leaf of files) {
    if (known.has(leaf)) continue
    // H4: recheck before each file — a discovery pass that straddles a lock stops here rather
    // than registering the rest of the folder into a locking (or already re-locked) session.
    deps.assert?.()
    try {
      await registerPack(db, deps, join(deps.zimDir, leaf))
      added++
    } catch (err) {
      // A cancellation is NOT an ordinary per-file failure: it must stop the pass, not be
      // swallowed as "one corrupt archive skipped".
      if (isCancellation(err)) throw err
      log.warn(
        `Knowledge-pack auto-discovery skipped one file: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return added
}

/** The #159 `AbortError` convention, or a manager child cancelled by the caller's signal. */
function isCancellation(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return err instanceof KiwixManageError && err.kind === 'abort'
}

/**
 * (Re)build the library.xml the sidecar serves from: every enabled pack whose file
 * resolves, added via kiwix-manage into a FRESH file at `libraryXmlPath`. Returns the
 * number of books included (0 ⇒ the caller should not start the sidecar).
 *
 * `signal` (P3a/M9) is forwarded to every `manageAdd` call. An ordinary per-pack failure
 * (a corrupt archive, a missing file) is still skipped with a warn — one bad pack must
 * not block the others. But a `KiwixManageError` with `childState === 'uncertain'`, or
 * `kind === 'abort'`, or the signal already being aborted STOPS the build and RETHROWS:
 * a shared library.xml with an unconfirmed writer (the kiwix-manage child may still be
 * appending to it) is not a publishable build.
 */
export async function writeLibraryXml(
  db: Db,
  deps: PackDeps,
  libraryXmlPath: string,
  signal?: AbortSignal
): Promise<number> {
  try {
    rmSync(libraryXmlPath, { force: true })
  } catch {
    /* a stale file that cannot be removed will surface via kiwix-manage below */
  }
  const rows = prepareCached(db, 'SELECT * FROM knowledge_packs WHERE enabled = 1 AND removed_at IS NULL').all() as unknown as PackRow[]
  let count = 0
  for (const row of rows) {
    if (signal?.aborted) throw new DOMException('writeLibraryXml aborted', 'AbortError')
    const filePath = resolvePackFile(deps.zimDir, row)
    if (!filePath) continue
    try {
      await deps.manageAdd(libraryXmlPath, filePath, signal)
      count++
    } catch (err) {
      if (err instanceof KiwixManageError && (err.childState === 'uncertain' || err.kind === 'abort')) {
        throw err
      }
      log.warn(
        `Knowledge pack ${row.id} skipped from library.xml: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return count
}

/**
 * Read one archive's metadata via a throwaway kiwix-manage library.xml. The meta dir is
 * `<workspacePath>/zim-transient/meta-<n>` when the service supplies `deps.metaDir` (always in
 * production, #301 P3b) and an OS-temp `hilbertraum-zim-meta-` directory otherwise (tests).
 *
 * It is normally removed in `finally` — EXCEPT when the manager settled `'uncertain'` (the
 * SIGKILLed child may still be writing into it): removing it then would race a child that might
 * still be alive, so the dir is KEPT, reported through `deps.onUncertain` and removed by the
 * next session-start cleanup (R-7).
 */
async function readZimMetadata(deps: PackDeps, zimPath: string): Promise<KiwixBook> {
  const dir = deps.metaDir
    ? deps.metaDir()
    : mkdtempSync(join(tmpdir(), 'hilbertraum-zim-meta-'))
  if (deps.metaDir) mkdirSync(dir, { recursive: true })
  const tempLibrary = join(dir, 'library.xml')
  let manageErr: unknown
  try {
    await deps.manageAdd(tempLibrary, zimPath)
    const books = parseLibraryXml(readFileSync(tempLibrary, 'utf8'))
    const book = books[0]
    if (!book) throw new Error('kiwix-manage produced no book entry for the archive')
    return book
  } catch (err) {
    manageErr = err
    throw err
  } finally {
    if (manageErr instanceof KiwixManageError && manageErr.childState === 'uncertain') {
      log.warn('kiwix-manage cleanup not confirmed — leaving the throwaway metadata dir for the startup sweep (R-7)')
      // The caller keeps this path out of the transient cleanup until the next session start.
      deps.onUncertain?.(dir)
    } else {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* temp dir — best-effort */
      }
    }
  }
}
