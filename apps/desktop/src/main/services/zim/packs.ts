import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { KnowledgePack, KnowledgePackOutcome } from '../../../shared/types'
import { MAX_SELECTED_PACKS } from '../../../shared/types'
import { type Db, prepareCached } from '../db'
import { log } from '../logging'
import { ftIndexHint, parseLibraryXml, type KiwixBook } from './client'
import { ZimHeaderError, readZimHeader } from './identity'
import { KiwixManageError } from './tools'

// Knowledge-pack registry (ZIM wave): CRUD + disk reconciliation over the
// `knowledge_packs` table. The DB is the truth for REGISTRATION (which archives the user
// added, enabled state, tombstones) and — since #301 P3b — also for AVAILABILITY as the
// LIST sees it: `listPacks` is a pure read of the table (finding L7), and the one place
// that looks at the disk is the serialized `reconcile` (session start + explicit Refresh).
//
// IDENTITY (finding M5, plan §9.17 (d)). A pack IS its archive UUID, and every resolve
// verifies that UUID against the file's 80-byte header (`identity.ts`) instead of trusting a
// basename. The old `resolvePackFile` took the first candidate that EXISTED, so a different
// archive with the same basename in the drive's `zim/` folder permanently hid the correctly
// registered external file — available in the panel, zero hits on every ask.
//
// OWNERSHIP SPLIT (plan §9.17 (d)4, audit A07) — what may write which columns:
//   - the RECONCILE owns { leaf, recorded_path, size_bytes, unavailable_at,
//     unavailable_reason, updated_at } and the INSERT of a genuinely unknown UUID
//     (`ON CONFLICT(id) DO NOTHING`). It NEVER writes `enabled` or `removed_at`.
//   - the USER owns { enabled, removed_at } through `packs:remove` / `packs:setEnabled`.
//   - an EXPLICIT `packs:add` owns everything (the UPSERT clears the tombstone and enables).
// Hence a 30 s manager spawn that finishes after the user removed or disabled a pack can no
// longer undo that decision, and mutations never have to queue behind discovery.
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
  /**
   * The kiwix-serve binary's identity as `"<size>:<mtimeMs>"` (#301 P4, finding M7, plan §9.21
   * (d)3) — the TOOL half of the searchability cache key, so a swapped tools bundle re-probes
   * every pack. Null when the binary cannot be stat'ed; absent ⇒ no tools revision is mixed in
   * (tests, partial contexts). The service computes it from `resolveToolPaths().serve`.
   */
  toolsFingerprint?: () => string | null
}

/** Why a registered pack is not usable right now. Stored `'identity_mismatch'`, surfaced
 *  `'identity-mismatch'` (the shared-type spelling). */
export type UnavailableReason = 'missing' | 'identity-mismatch'

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
  unavailable_reason: string | null
  searchable: string | null
  searchable_key: string | null
  ftindex_hint: string | null
  removed_at: string | null
  added_at: string
  updated_at: string
}

const toStoredReason = (reason: UnavailableReason): string =>
  reason === 'identity-mismatch' ? 'identity_mismatch' : 'missing'

const fromStoredReason = (stored: string | null): UnavailableReason | null => {
  if (stored === 'identity_mismatch') return 'identity-mismatch'
  if (stored === 'missing') return 'missing'
  return null
}

/** The stored capability verdict as the shared type spells it: NULL reads as `'unknown'`
 *  (#301 P4, finding M7 — only a validated probe ever writes `'yes'`/`'no'`). */
const toSearchable = (stored: string | null): 'yes' | 'no' | 'unknown' =>
  stored === 'yes' || stored === 'no' ? stored : 'unknown'

/** The stored `_ftindex` hint. Anything unexpected reads as "no tag", never as a verdict. */
const toHint = (stored: string | null): 'yes' | 'no' | null =>
  stored === 'yes' || stored === 'no' ? stored : null

function rowToPack(row: PackRow, available: boolean, unavailableReason: UnavailableReason | null): KnowledgePack {
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
    // Available packs never carry a reason, even if a stale one is still in the column.
    unavailableReason: available ? null : unavailableReason,
    searchable: toSearchable(row.searchable),
    searchableHint: toHint(row.ftindex_hint),
    addedAt: row.added_at
  }
}

/** What a resolve found: the file that really IS this pack, or why nothing does. */
export type PackResolution =
  | { path: string; uuid: string }
  | { path: null; reason: UnavailableReason }

/**
 * Resolve a pack's FILE BY IDENTITY (finding M5, plan §9.17 (d)2). Candidates, in order:
 * the drive-relative `zim/<leaf>` (survives a remount under a new drive letter) and the
 * recorded path (deduped when they are the same file). The FIRST existing candidate whose
 * header UUID equals the row id wins — so a wrong-UUID on-drive leaf no longer hides a
 * correct external file; it is simply skipped.
 *
 * A short / bad-magic / unreadable header counts as "does not match", never as a match and
 * never as a crash: one warn with the pack id and a reason CODE, and NEVER the path (the
 * sentinel rule — a path names what the user reads).
 *
 * No candidate existed at all ⇒ `'missing'`. One existed but none carried this identity ⇒
 * `'identity-mismatch'`, which is a materially different state for the user: the file is
 * there, it is simply not their archive any more.
 */
export function resolvePack(
  zimDir: string,
  row: Pick<PackRow, 'id' | 'leaf' | 'recorded_path'>
): PackResolution {
  const candidates: string[] = [join(zimDir, row.leaf)]
  if (row.recorded_path && row.recorded_path !== candidates[0]) candidates.push(row.recorded_path)
  let sawCandidate = false
  let unreadable: string | null = null
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    sawCandidate = true
    try {
      const { uuid } = readZimHeader(candidate)
      if (uuid === row.id) return { path: candidate, uuid }
    } catch (err) {
      unreadable = err instanceof ZimHeaderError ? err.reason : 'unreadable'
    }
  }
  if (unreadable !== null) {
    log.warn('Knowledge-pack file could not be identified from its header', {
      packId: row.id,
      reason: unreadable
    })
  }
  return { path: null, reason: sawCandidate ? 'identity-mismatch' : 'missing' }
}

const nowIso = (): string => new Date().toISOString()

/**
 * List all registered packs. DATABASE-ONLY (finding L7, plan §9.17 (e)1): no `existsSync`,
 * no header read, no availability UPDATE and no `kiwix-manage` spawn — `packs:list` used to
 * run a full drive discovery (a 30 s-timeout manager spawn per unknown file) on Chat mount
 * and after every toggle. Availability is `unavailable_at IS NULL`, written by the serialized
 * `reconcile` at session start and on explicit Refresh.
 */
export function listPacks(db: Db): KnowledgePack[] {
  const rows = prepareCached(
    db,
    'SELECT * FROM knowledge_packs WHERE removed_at IS NULL ORDER BY title COLLATE NOCASE, id'
  ).all() as unknown as PackRow[]
  return rows.map((row) =>
    rowToPack(row, row.unavailable_at === null, fromStoredReason(row.unavailable_reason))
  )
}

/**
 * The packs the retrieval arm should query: requested ∩ enabled ∩ identity-resolved, with each
 * pack's resolved absolute file path.
 *
 * ORDERED `title COLLATE NOCASE, id` (#301 P4, finding M8, plan §9.21 (c)2) — the same order
 * `listPacks` shows and the arm's quota/round-robin allocation is defined over, so which pack
 * gets the odd candidate of a division is a property of the LIBRARY, not of the row order
 * SQLite happened to return or of which pack answered first.
 */
export function retrievablePacks(
  db: Db,
  zimDir: string,
  packIds: readonly string[]
): Array<KnowledgePack & { filePath: string }> {
  if (packIds.length === 0) return []
  const wanted = new Set(packIds)
  const rows = prepareCached(
    db,
    `SELECT * FROM knowledge_packs WHERE enabled = 1 AND removed_at IS NULL
      ORDER BY title COLLATE NOCASE, id`
  ).all() as unknown as PackRow[]
  const out: Array<KnowledgePack & { filePath: string }> = []
  for (const row of rows) {
    if (!wanted.has(row.id)) continue
    const resolved = resolvePack(zimDir, row)
    if (resolved.path === null) continue
    out.push({ ...rowToPack(row, true, null), filePath: resolved.path })
  }
  return out
}

/**
 * The stored titles of a set of pack ids — a DB-ONLY read (no disk, no sidecar, no identity
 * check) used by the answer paths that never query packs but still owe the user one honest
 * outcome per selected pack (#301 P4, finding M6; plan §9.21 (e)5: the whole-document, compare
 * and grounded-data `skipped / mode` outcomes).
 *
 * TOMBSTONED rows are included deliberately: a pack removed between the ask and the render still
 * has a title the notice can name. The "a removed pack" fallback is reserved for an id with NO
 * row at all, which maps to `null` here — exactly what `classifyPackSelection` reports for it.
 */
export function packTitles(db: Db, ids: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const id of ids) out.set(id, null)
  if (out.size === 0) return out
  const rows = prepareCached(db, 'SELECT id, title FROM knowledge_packs').all() as unknown as Array<{
    id: string
    title: string
  }>
  for (const row of rows) if (out.has(row.id)) out.set(row.id, row.title)
  return out
}

/** What one ask's pack selection resolved to (#301 P4, findings M6/M7/M8; plan §9.21 (e)2). */
export interface PackSelectionClassification {
  /** The packs the arm may search, in `title COLLATE NOCASE, id` order, with their files. */
  eligible: Array<KnowledgePack & { filePath: string }>
  /** ONE outcome per selected id that is NOT eligible. The arm appends the eligible ones' own. */
  outcomes: KnowledgePackOutcome[]
}

const notSearchedOutcome = (
  packId: string,
  title: string | null,
  reason: KnowledgePackOutcome['reason']
): KnowledgePackOutcome => ({ packId, title, status: 'skipped', reason, found: 0, admitted: 0 })

/**
 * Classify one ask's selected pack ids BEFORE any eligibility filter (#301 P4, findings
 * M6/M7/M8; plan §9.21 (e)2). Every id the scope carries gets an answer — that is the whole
 * point: "makeArm returned null" and "the candidate list was empty" can no longer erase a pack
 * the user ticked.
 *
 * In order: the selection is DEDUPED; an id with no row at all is `removed` with a null title
 * (the renderer says "a removed pack"); the rows are ordered `title COLLATE NOCASE, id` and
 * everything beyond `MAX_SELECTED_PACKS` is `selection-limit` (the owner's over-cap rule, §7 —
 * a persisted 13-pack selection from older data or a hand-edited setting is trimmed
 * deterministically and TOLD SO, never silently); then, per remaining row, a tombstone is
 * `removed`, `enabled = 0` is `disabled`, an unavailable row is `file-missing` /
 * `identity-mismatch` from its stored reason, and a CONFIRMED `searchable = 'no'` is
 * `not-searchable` (unknown and `'yes'` are both searched — nothing is filtered out before its
 * capability is established, §2.5 item 4).
 *
 * Only the survivors have their file resolved (one 80-byte header read each): a trimmed or
 * disabled pack costs no filesystem work at all. A survivor whose file no longer resolves is
 * reported with the same `file-missing` / `identity-mismatch` codes the reconcile would use.
 */
export function classifyPackSelection(
  db: Db,
  zimDir: string,
  packIds: readonly string[]
): PackSelectionClassification {
  const ids = [...new Set(packIds)]
  if (ids.length === 0) return { eligible: [], outcomes: [] }
  const wanted = new Set(ids)
  const rows = (
    prepareCached(
      db,
      'SELECT * FROM knowledge_packs ORDER BY title COLLATE NOCASE, id'
    ).all() as unknown as PackRow[]
  ).filter((row) => wanted.has(row.id))
  const known = new Set(rows.map((row) => row.id))

  const eligible: Array<KnowledgePack & { filePath: string }> = []
  const outcomes: KnowledgePackOutcome[] = []
  // An id the registry has never heard of (or whose row was deleted outright): the ask still
  // owes the user a line about it.
  for (const id of ids) if (!known.has(id)) outcomes.push(notSearchedOutcome(id, null, 'removed'))

  rows.forEach((row, position) => {
    if (position >= MAX_SELECTED_PACKS) {
      outcomes.push(notSearchedOutcome(row.id, row.title, 'selection-limit'))
      return
    }
    if (row.removed_at !== null) {
      outcomes.push(notSearchedOutcome(row.id, row.title, 'removed'))
      return
    }
    if (row.enabled !== 1) {
      outcomes.push(notSearchedOutcome(row.id, row.title, 'disabled'))
      return
    }
    if (row.unavailable_at !== null) {
      const reason = fromStoredReason(row.unavailable_reason) ?? 'missing'
      outcomes.push(
        notSearchedOutcome(row.id, row.title, reason === 'missing' ? 'file-missing' : 'identity-mismatch')
      )
      return
    }
    if (toSearchable(row.searchable) === 'no') {
      outcomes.push(notSearchedOutcome(row.id, row.title, 'not-searchable'))
      return
    }
    const resolved = resolvePack(zimDir, row)
    if (resolved.path === null) {
      outcomes.push(
        notSearchedOutcome(
          row.id,
          row.title,
          resolved.reason === 'missing' ? 'file-missing' : 'identity-mismatch'
        )
      )
      return
    }
    eligible.push({ ...rowToPack(row, true, null), filePath: resolved.path })
  })
  return { eligible, outcomes }
}

/**
 * Every enabled, non-tombstoned pack whose file resolves BY IDENTITY, as `{ id, path }`.
 * This is the input to the serving-name map (`computeServedSet`) and, after the collision
 * losers are dropped, to `writeLibraryXml` — so the library the sidecar serves is built from
 * one identity-checked list rather than re-queried per consumer.
 */
export function servedCandidates(db: Db, zimDir: string): Array<{ id: string; path: string }> {
  const rows = prepareCached(
    db,
    'SELECT * FROM knowledge_packs WHERE enabled = 1 AND removed_at IS NULL'
  ).all() as unknown as PackRow[]
  const out: Array<{ id: string; path: string }> = []
  for (const row of rows) {
    const resolved = resolvePack(zimDir, row)
    if (resolved.path !== null) out.push({ id: row.id, path: resolved.path })
  }
  return out
}

/**
 * Register (or re-register) one ZIM archive — the EXPLICIT `packs:add` path, which owns every
 * column (plan §9.17 (d)4).
 *
 * Order matters (plan §9.17 (d)5): the HEADER is read FIRST. A file that is not a readable
 * ZIM archive throws a `ZimHeaderError` carrying a reason CODE and no path, and no
 * kiwix-manage child is ever spawned for it. Only then does the manager produce the metadata —
 * and its `id` must EQUAL the header UUID, or the registration fails: a manager that disagrees
 * with the header is not trusted to name the archive we just identified.
 */
export async function registerPack(db: Db, deps: PackDeps, zimPath: string): Promise<KnowledgePack> {
  const { uuid } = readZimHeader(zimPath)
  const book = await readZimMetadata(deps, zimPath)
  if (book.id !== uuid) {
    throw new Error('kiwix-manage reported a different archive identity than the ZIM header')
  }
  // H4: the manager work above is an await. Recheck the owning operation's admission, epoch
  // and cancellation before the UPSERT — a registration that straddled a lock must not write
  // into the session's database (nor into the NEXT session's, after a lock + unlock).
  deps.assert?.()
  const leaf = basename(zimPath)
  const now = nowIso()
  const existing = prepareCached(db, 'SELECT added_at FROM knowledge_packs WHERE id = ?').get(uuid) as
    | { added_at: string }
    | undefined
  prepareCached(
    db,
    `INSERT INTO knowledge_packs
       (id, title, description, language, zim_date, article_count, media_count, size_bytes,
        leaf, recorded_path, enabled, unavailable_at, unavailable_reason, ftindex_hint,
        removed_at, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, description = excluded.description,
       language = excluded.language, zim_date = excluded.zim_date,
       article_count = excluded.article_count, media_count = excluded.media_count,
       size_bytes = excluded.size_bytes, leaf = excluded.leaf,
       recorded_path = excluded.recorded_path, unavailable_at = NULL,
       unavailable_reason = NULL, ftindex_hint = excluded.ftindex_hint,
       removed_at = NULL, enabled = 1,
       updated_at = excluded.updated_at`
  ).run(
    uuid,
    book.title ?? leaf.replace(/\.zim$/i, ''),
    book.description,
    book.language,
    book.date,
    book.articleCount,
    book.mediaCount,
    fileSize(zimPath),
    leaf,
    zimPath,
    // The archive's own `_ftindex` tag — a HINT, never a verdict (#301 P4, M7). `searchable`
    // and `searchable_key` are deliberately NOT written here: only the reconcile's key pass and
    // the /suggest probe touch them, so a re-add can never invent a capability.
    ftIndexHint(book.tags),
    existing?.added_at ?? now,
    now
  )
  const row = prepareCached(db, 'SELECT * FROM knowledge_packs WHERE id = ?').get(uuid) as unknown as PackRow
  return rowToPack(row, true, null)
}

/**
 * Remove a registration (the archive FILE is never touched). A TOMBSTONE, not a DELETE: the
 * reconcile keys "already known" by UUID, so a deleted row for a file still sitting in `zim/`
 * would resurrect on the next pass — and a rename or a copy must not resurrect it either.
 * Only an explicit re-add (`packs:add`) clears the tombstone.
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

/** What one reconciliation pass did. `changed` drives the single `invalidateLibrary()`. */
export interface ReconcileReport {
  /** The effective served set `{ id → path }` of enabled ∧ available rows moved. */
  changed: boolean
  /** Genuinely unknown UUIDs inserted (disabled/tombstoned rows are never re-inserted). */
  registered: number
  /** Rows whose path/size was healed, or whose availability came back. */
  healed: number
  /** Rows marked `missing` or `identity_mismatch` by this pass. */
  unavailable: number
}

export interface ReconcileOptions {
  /** The owning operation's recheck. Called before EVERY write; throws the #159 `AbortError`. */
  assert?: () => void
}

/**
 * Reconcile the registry against the drive — the ONE place that touches the filesystem
 * (findings M5, L7, A07; plan §9.17 (d)4–5). Replaces `discoverDrivePacks`, whose
 * unconditional UPSERT is gone.
 *
 * Two halves:
 *   (i) every `zim/*.zim` is identified from its header. An invalid header is warned about
 *       (reason code, no path) and skipped — never registered. A KNOWN UUID — including a
 *       tombstoned or disabled one — only heals its path: a rename or a copy can never clear a
 *       tombstone or re-enable a pack. An UNKNOWN UUID is inserted with
 *       `ON CONFLICT(id) DO NOTHING`.
 *  (ii) every non-tombstoned row is then resolved BY IDENTITY: a match heals `leaf`/
 *       `recorded_path`/`size_bytes` and clears the unavailability stamp; no match sets
 *       `unavailable_at` + `unavailable_reason` (`missing` when no candidate file existed,
 *       `identity_mismatch` when one did but carried another UUID).
 *
 * The DRIVE half runs first on purpose: a renamed archive is healed by its UUID before the row
 * half looks at it, so an ordinary rename is ONE write, not a spurious "unavailable" stamp
 * immediately undone (which would also churn the served revision).
 *
 * The replacement case falls out of the two halves: when a known leaf now carries a DIFFERENT
 * UUID, (i) registers the new UUID as a NEW pack and (ii) marks the old row `identity_mismatch`
 * (old citations still point at it and the viewer says unavailable). Splicing the two is the
 * user's explicit decision, never ours.
 *
 * `assert()` runs before EVERY write, so a pass that straddles a lock stops instead of writing
 * into a closing — or an already re-opened — session.
 */
export async function reconcile(
  db: Db,
  deps: PackDeps,
  opts: ReconcileOptions = {}
): Promise<ReconcileReport> {
  const assert = opts.assert ?? deps.assert ?? ((): void => undefined)
  const before = servedSignature(db)
  let registered = 0
  let healed = 0
  let unavailable = 0

  // ---- (i) every archive on the drive: heal a known UUID, insert an unknown one ---------
  let files: string[]
  try {
    files = readdirSync(deps.zimDir).filter((f) => f.toLowerCase().endsWith('.zim'))
  } catch {
    files = [] // absent zim/ dir — the row half below still runs
  }
  for (const leaf of files) {
    assert()
    const filePath = join(deps.zimDir, leaf)
    let uuid: string
    try {
      uuid = readZimHeader(filePath).uuid
    } catch (err) {
      // Never registered, never fatal: one corrupt download must not block the folder.
      log.warn('Knowledge-pack reconcile skipped a file with an unreadable ZIM header', {
        reason: err instanceof ZimHeaderError ? err.reason : 'unreadable'
      })
      continue
    }
    const known = prepareCached(db, 'SELECT * FROM knowledge_packs WHERE id = ?').get(uuid) as unknown as
      | PackRow
      | undefined
    if (known) {
      // Path healing ONLY — never `enabled`, never `removed_at`. A tombstoned UUID that was
      // renamed stays removed; a disabled UUID that was copied stays disabled (audit A07).
      assert()
      if (healRow(db, known, filePath)) healed++
      continue
    }
    try {
      if (await insertDiscoveredPack(db, deps, filePath, uuid, assert)) registered++
    } catch (err) {
      if (isCancellation(err)) throw err
      // Reason class only — the manager's message can carry the absolute path (the L1 class,
      // P5 scrubs the UI surface; a log line must not leak it either — the sentinel rule).
      log.warn('Knowledge-pack reconcile skipped one file', { uuid, error: errorClass(err) })
    }
  }

  // ---- (ii) every live row: heal or mark ----------------------------------------------
  const rows = prepareCached(
    db,
    'SELECT * FROM knowledge_packs WHERE removed_at IS NULL'
  ).all() as unknown as PackRow[]
  for (const row of rows) {
    assert()
    const resolved = resolvePack(deps.zimDir, row)
    if (resolved.path !== null) {
      if (healRow(db, row, resolved.path)) healed++
    } else if (
      row.unavailable_at === null ||
      row.unavailable_reason !== toStoredReason(resolved.reason)
    ) {
      assert()
      prepareCached(
        db,
        `UPDATE knowledge_packs SET unavailable_at = COALESCE(unavailable_at, ?),
           unavailable_reason = ?, updated_at = ? WHERE id = ?`
      ).run(nowIso(), toStoredReason(resolved.reason), nowIso(), row.id)
      unavailable++
    }
  }

  // ---- (iii) the searchability cache key: reset a verdict whose ground moved -------------
  resetStaleSearchability(db, deps, assert)

  return { changed: !sameSignature(before, servedSignature(db)), registered, healed, unavailable }
}

/**
 * The fingerprint a searchability verdict is cached against (#301 P4, finding M7, plan §9.21
 * (d)3): the ARCHIVE's size and mtime plus the kiwix-serve BINARY's size and mtime. A replaced
 * or truncated file, a healed path that turned out to be a different copy, and a swapped tools
 * bundle each move it — and the reconcile then resets `searchable` to unknown so the pack is
 * probed again instead of carrying a stale "no" forever.
 *
 * Null when the archive cannot be stat'ed at all (nothing to key a verdict to).
 */
function searchableKeyFor(filePath: string, toolsFingerprint: string | null): string | null {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return null
  }
  return `${stat.size}:${stat.mtimeMs}:${toolsFingerprint ?? 'no-tools'}`
}

/**
 * Recompute the key for every enabled ∧ available row and RESET the verdict whose key moved
 * (the reconcile is the ONE write path for capability state — plan §9.17 (d)/§9.21 (d)3).
 * A row whose key is unchanged is not touched at all, so a no-op Refresh writes nothing.
 */
function resetStaleSearchability(db: Db, deps: PackDeps, assert: () => void): void {
  const fingerprint = deps.toolsFingerprint?.() ?? null
  const rows = prepareCached(
    db,
    `SELECT id, recorded_path, searchable, searchable_key FROM knowledge_packs
      WHERE enabled = 1 AND removed_at IS NULL AND unavailable_at IS NULL`
  ).all() as unknown as Array<{
    id: string
    recorded_path: string
    searchable: string | null
    searchable_key: string | null
  }>
  for (const row of rows) {
    const key = searchableKeyFor(row.recorded_path, fingerprint)
    if (key === null || key === row.searchable_key) continue
    assert()
    prepareCached(
      db,
      'UPDATE knowledge_packs SET searchable = NULL, searchable_key = ? WHERE id = ?'
    ).run(key, row.id)
  }
}

/** One pack whose full-text capability is still unknown, with the key its verdict must be
 *  stored under (the key the reconcile just computed — never one recomputed after the probe,
 *  which could attribute this verdict to a file that changed meanwhile). */
export interface UnknownSearchablePack {
  id: string
  searchableKey: string | null
}

/**
 * The enabled ∧ available packs whose searchability is UNKNOWN (#301 P4, plan §9.21 (d)5) —
 * the probe list `ZimService.reconcileOnce` runs at the end of a reconciliation. Empty ⇒ the
 * session never wakes the sidecar for a probe.
 */
export function unknownSearchablePacks(db: Db): UnknownSearchablePack[] {
  const rows = prepareCached(
    db,
    `SELECT id, searchable_key FROM knowledge_packs
      WHERE enabled = 1 AND removed_at IS NULL AND unavailable_at IS NULL AND searchable IS NULL
      ORDER BY title COLLATE NOCASE, id`
  ).all() as unknown as Array<{ id: string; searchable_key: string | null }>
  return rows.map((row) => ({ id: row.id, searchableKey: row.searchable_key }))
}

/**
 * Persist confirmed verdicts (#301 P4, plan §9.21 (d)5). Called ONLY after the request guard
 * ACCEPTED the probe batch and the owning operation asserted again, so a verdict observed
 * across a server change or a lock is never written. Each verdict is stored together with the
 * key it was taken under; the write is conditional on that key still being the row's, so a
 * reconcile that moved the ground while the probe ran wins.
 */
export function writeSearchableVerdicts(
  db: Db,
  verdicts: ReadonlyArray<{ id: string; verdict: 'yes' | 'no'; searchableKey: string | null }>
): number {
  let written = 0
  for (const entry of verdicts) {
    const res = prepareCached(
      db,
      // `IS` (not `=`) so a row whose key is NULL — a workspace written before the column
      // existed, probed before the next reconcile keyed it — matches instead of silently
      // dropping the verdict.
      `UPDATE knowledge_packs SET searchable = ?
        WHERE id = ? AND searchable IS NULL AND searchable_key IS ?`
    ).run(entry.verdict, entry.id, entry.searchableKey)
    written += Number(res.changes)
  }
  return written
}

/**
 * The effective served set as the DB records it: `id → recorded_path` over enabled ∧ available
 * ∧ non-tombstoned rows. Cheap and exact, because the reconcile always writes the RESOLVED
 * winner into `recorded_path` — so comparing this before and after a pass answers "would the
 * sidecar serve a different library?" without a second round of header reads.
 */
function servedSignature(db: Db): Map<string, string> {
  const rows = prepareCached(
    db,
    `SELECT id, recorded_path FROM knowledge_packs
      WHERE enabled = 1 AND removed_at IS NULL AND unavailable_at IS NULL`
  ).all() as unknown as Array<{ id: string; recorded_path: string }>
  return new Map(rows.map((r) => [r.id, r.recorded_path]))
}

function sameSignature(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [id, path] of a) if (b.get(id) !== path) return false
  return true
}

/** Heal one row's path columns / size / availability. Returns true when anything moved — a
 *  no-op pass must not churn `updated_at` (and therefore must not look like a change). */
function healRow(db: Db, row: PackRow, filePath: string): boolean {
  const leaf = basename(filePath)
  const size = fileSize(filePath)
  const same =
    row.leaf === leaf &&
    row.recorded_path === filePath &&
    row.size_bytes === size &&
    row.unavailable_at === null &&
    row.unavailable_reason === null
  if (same) return false
  prepareCached(
    db,
    `UPDATE knowledge_packs SET leaf = ?, recorded_path = ?, size_bytes = ?,
       unavailable_at = NULL, unavailable_reason = NULL, updated_at = ? WHERE id = ?`
  ).run(leaf, filePath, size, nowIso(), row.id)
  return true
}

/**
 * Insert a genuinely unknown archive. INSERT-ONLY (`ON CONFLICT(id) DO NOTHING`) so a late
 * manager completion can never overwrite a row the user changed while it was running, and the
 * manager's `id` must agree with the header UUID we identified the file by.
 */
async function insertDiscoveredPack(
  db: Db,
  deps: PackDeps,
  zimPath: string,
  uuid: string,
  assert: () => void
): Promise<boolean> {
  const book = await readZimMetadata(deps, zimPath)
  if (book.id !== uuid) {
    log.warn('Knowledge-pack reconcile skipped a file whose manager metadata disagreed with its header')
    return false
  }
  assert()
  const leaf = basename(zimPath)
  const now = nowIso()
  const res = prepareCached(
    db,
    `INSERT INTO knowledge_packs
       (id, title, description, language, zim_date, article_count, media_count, size_bytes,
        leaf, recorded_path, enabled, unavailable_at, unavailable_reason, ftindex_hint,
        removed_at, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    uuid,
    book.title ?? leaf.replace(/\.zim$/i, ''),
    book.description,
    book.language,
    book.date,
    book.articleCount,
    book.mediaCount,
    fileSize(zimPath),
    leaf,
    zimPath,
    ftIndexHint(book.tags), // the `_ftindex` HINT only — never `searchable` (#301 P4, M7)
    now,
    now
  )
  return Number(res.changes) > 0
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null // registration is still valid; the size is cosmetic
  }
}

/** A path-free classification of a registration/build failure for the log (sentinel rule). */
function errorClass(err: unknown): string {
  if (err instanceof KiwixManageError) return `manage:${err.kind}`
  return err instanceof Error ? err.name : 'unknown'
}

/** The #159 `AbortError` convention, or a manager child cancelled by the caller's signal. */
function isCancellation(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return err instanceof KiwixManageError && err.kind === 'abort'
}

/**
 * (Re)build the library.xml the sidecar serves from the pre-computed SERVED SET — winners of
 * the serving-name map only (plan §9.17 (d)6). It no longer re-queries the rows: the caller
 * resolved every candidate by identity and dropped the collision losers, so the server can
 * never be handed two books that map to one name and quietly answer for the wrong one.
 * Returns the number of books included (0 ⇒ the caller should not start the sidecar).
 *
 * `signal` (P3a/M9) is forwarded to every `manageAdd` call. An ordinary per-pack failure
 * (a corrupt archive) is still skipped with a warn — one bad pack must not block the others.
 * But a `KiwixManageError` with `childState === 'uncertain'`, or `kind === 'abort'`, or the
 * signal already being aborted STOPS the build and RETHROWS: a shared library.xml with an
 * unconfirmed writer (the kiwix-manage child may still be appending to it) is not a
 * publishable build.
 */
export async function writeLibraryXml(
  deps: Pick<PackDeps, 'manageAdd'>,
  libraryXmlPath: string,
  served: ReadonlyArray<{ id: string; path: string }>,
  signal?: AbortSignal
): Promise<number> {
  try {
    rmSync(libraryXmlPath, { force: true })
  } catch {
    /* a stale file that cannot be removed will surface via kiwix-manage below */
  }
  let count = 0
  for (const book of served) {
    if (signal?.aborted) throw new DOMException('writeLibraryXml aborted', 'AbortError')
    try {
      await deps.manageAdd(libraryXmlPath, book.path, signal)
      count++
    } catch (err) {
      if (err instanceof KiwixManageError && (err.childState === 'uncertain' || err.kind === 'abort')) {
        throw err
      }
      // Ids + the error class only: the manager's message can carry the absolute path.
      log.warn('Knowledge pack skipped from library.xml', { packId: book.id, error: errorClass(err) })
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
