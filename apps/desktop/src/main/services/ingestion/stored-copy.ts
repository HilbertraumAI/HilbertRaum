import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ENCRYPTED_DOC_SUFFIX } from '../workspace-vault'
import { sha256File } from '../models'
import { log } from '../logging'
import type { Db } from '../db'

// Issue #188 — the ONE place a document's bytes are located on disk.
//
// `documents.stored_path` was persisted ABSOLUTE (`H:\workspace\documents\<id><ext>.enc`) and
// consumed with a bare `existsSync`. On a product whose premise is "keep the workspace on an
// external drive and move between laptops", that means a drive returning under a different mount
// point takes EVERY stored copy stale at once: the row is intact, the bytes are intact, only the
// recorded string is wrong — and the app tells the user the file "is no longer present".
//
// The stored copy is named DETERMINISTICALLY, `<documentId><ext>[.enc]` inside the CURRENT store
// dir, so the recorded path is redundant: the canonical location can always be recomputed. This
// module is the single resolver every consumer goes through — the read paths (export, preview,
// re-index, OCR, skills) AND `deleteDocument`'s shred, which is the reason this is a privacy fix
// and not a convenience one: keyed on the stale path, the shred silently no-opped and left the
// user's encrypted content on the drive with no row left to ever reference it again.
//
// This mirrors what the rest of the drive already does — `image_sessions.stored_name` (relative
// by design), `skills.path` (folder basename), the model checksum cache (`driveRelKey`, CODE-15),
// the runtime install marker (`markerBinaryKey`), `documents.source_relative_path` (CODE-1) — and
// what the vault layer already assumed: password-change re-encryption enumerates
// `workspace/documents/` by DIRECTORY WALK, never by `stored_path`.

/** The columns this module needs. Every reader's row shape is a superset. */
export interface StoredCopyRow {
  id: string
  stored_path: string | null
  stored_name?: string | null
  original_path?: string | null
  sha256?: string | null
}

/** A located stored copy: an absolute path plus whether it rests encrypted. */
export interface LocatedStoredCopy {
  /** Absolute path to the file on disk, right now. */
  path: string
  /** Leaf name relative to the store dir (`<id><ext>[.enc]`). */
  name: string
  /** True when the file is a `.enc` sidecar and needs the DocumentCipher. */
  encrypted: boolean
  /** True when `path` differs from what the row recorded — the row wants healing. */
  relocated: boolean
}

/**
 * The user's own copy of the file, used only when the workspace copy cannot be found.
 * `contentMatchesImport` is null when it could not be decided (no recorded sha256, or the
 * hash failed) — never silently "true".
 */
export interface LocatedOriginal {
  path: string
  contentMatchesImport: boolean | null
}

/**
 * Leaf name of `p`, split on BOTH separators.
 *
 * NOT `basename`: a legacy row can carry a path written on ANOTHER OS (a Windows
 * `Z:\old\documents\<id>.pdf.enc` row read on macOS/Linux, or the reverse), and the host
 * `basename` only understands the host separator — on posix it would return the whole
 * Windows string. Same scar as `markerBinaryKey` / `resolveTarBinary` (the cross-platform
 * path bugs that failed the Ubuntu CI leg): never use host path helpers on a stored string
 * that may have been written by a different host.
 */
export function storedCopyLeaf(p: string): string {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return cut >= 0 ? p.slice(cut + 1) : p
}

/**
 * The canonical leaf for a row, or null when it cannot be trusted.
 *
 * SAFETY (this is the guard the shred rests on): the leaf is used to build a path INSIDE the
 * store dir that `deleteDocument` will overwrite-and-unlink. So it must be a bare file name
 * belonging to THIS document — it must start with the row's own id, which is a UUID primary
 * key that is never reused. A name failing any check yields null, and the caller falls back to
 * the recorded absolute path verbatim (today's behaviour), never to a guess. Without this
 * guard a malformed/foreign `stored_name` could make the shred destroy ANOTHER document's copy.
 */
export function canonicalLeafFor(row: StoredCopyRow): string | null {
  const raw = row.stored_name ?? (row.stored_path ? storedCopyLeaf(row.stored_path) : null)
  if (!raw) return null
  // Bare name only: no separators (a stored_name from a corrupted row), no traversal.
  if (raw !== storedCopyLeaf(raw)) return null
  if (raw === '.' || raw === '..' || raw.length === 0) return null
  // Belongs to THIS document. `<id>` is a UUID; the rest is `<ext>[.enc]`.
  if (!raw.startsWith(row.id)) return null
  return raw
}

/**
 * Locate a document's workspace copy, or null when there is none on disk.
 *
 * Order, most-portable first:
 *   1. the CANONICAL location — `join(storeDir, <id><ext>[.enc])` — which is mount-independent
 *      and therefore the only one that survives the drive moving;
 *   2. the recorded absolute `stored_path`, verbatim, if it happens to exist. Keeping this makes
 *      the resolver a strict superset of the previous behaviour: nothing that resolved before
 *      stops resolving now.
 *
 * Pure and synchronous: `deleteDocument` needs it inside a sync path, and the read paths want it
 * before they decide whether to decrypt.
 */
export function locateStoredCopy(storeDir: string, row: StoredCopyRow): LocatedStoredCopy | null {
  const leaf = canonicalLeafFor(row)
  if (leaf) {
    const canonical = join(storeDir, leaf)
    if (existsSync(canonical)) {
      return {
        path: canonical,
        name: leaf,
        encrypted: leaf.endsWith(ENCRYPTED_DOC_SUFFIX),
        relocated: canonical !== row.stored_path || row.stored_name !== leaf
      }
    }
  }
  if (row.stored_path && existsSync(row.stored_path)) {
    return {
      path: row.stored_path,
      name: leaf ?? storedCopyLeaf(row.stored_path),
      encrypted: row.stored_path.endsWith(ENCRYPTED_DOC_SUFFIX),
      // A row whose file lives OUTSIDE the store keeps resolving, but it is not "relocated" —
      // there is nothing better to heal it to. And when `leaf` is null the guard refused the
      // name, so writing it back would only persist a name the guard will refuse again (worse:
      // a name belonging to another document). Never heal on this branch.
      relocated: false
    }
  }
  return null
}

/**
 * D3 — heal the row in place once the copy has been found somewhere other than where the row
 * said. Lazy and opportunistic, never a startup migration: an encrypted workspace on USB is the
 * worst possible medium for a bulk write burst, and the migration could not run before unlock
 * anyway. Same shape as `createSettingsHashStore`'s lazy adoption of legacy absolute keys
 * (CODE-15).
 *
 * BEST-EFFORT by contract: a locked/closed/read-only database must never fail a read that has
 * already succeeded. The next read simply heals again.
 */
export function healStoredCopy(db: Db, row: StoredCopyRow, found: LocatedStoredCopy): void {
  if (!found.relocated) return
  try {
    db.prepare('UPDATE documents SET stored_path = ?, stored_name = ? WHERE id = ?').run(
      found.path,
      found.name,
      row.id
    )
  } catch {
    /* the read already succeeded — a heal failure must never surface to the caller */
  }
}

/** Locate + heal in one call: what every read path wants. */
export function resolveStoredCopy(
  db: Db,
  storeDir: string,
  row: StoredCopyRow
): LocatedStoredCopy | null {
  const found = locateStoredCopy(storeDir, row)
  if (found) healStoredCopy(db, row, found)
  return found
}

/**
 * The LAST-RESORT fallback: the user's own file at `original_path`.
 *
 * Deliberately demoted below the workspace copy (#188 analysis §4). On a portable drive
 * `original_path` names a location on the OTHER machine, so it is the least durable of the two;
 * it is nulled outright for generated documents (`setDocumentOrigin`); and — the reason for the
 * hash — nothing used to re-check it, so a source file edited since import was handed back as
 * though it were "the original as imported".
 *
 * The hash is advisory here: this function REPORTS the mismatch and lets each caller decide.
 * Export refuses (its promise is the bytes as imported); the parse paths proceed with a warning
 * (their promise is readable content, and re-reading a changed file is what re-index is for).
 */
export async function locateOriginal(row: StoredCopyRow): Promise<LocatedOriginal | null> {
  const path = row.original_path
  if (!path || !existsSync(path)) return null
  if (!row.sha256) return { path, contentMatchesImport: null }
  try {
    return { path, contentMatchesImport: (await sha256File(path)) === row.sha256 }
  } catch {
    // Unreadable/racing file: undecided, never optimistically "matches".
    return { path, contentMatchesImport: null }
  }
}

/** Log line for the parse paths, which proceed on a changed original rather than refuse. */
export function warnOriginalChanged(documentId: string): void {
  log.warn('Reading the user original instead of the workspace copy; its content no longer matches what was imported', {
    documentId
  })
}
