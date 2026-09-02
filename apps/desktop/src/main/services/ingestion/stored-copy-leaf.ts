// The leaf rule for a document's stored copy — dependency-free so both the resolver
// (`stored-copy.ts`) and the vault rekey (`workspace-vault.ts`, #241) share ONE definition
// without an import cycle (the resolver imports the vault module for its suffix).

/** The `documents` columns the leaf rule reads. */
export interface StoredCopyLeafRow {
  id: string
  stored_path: string | null
  stored_name?: string | null
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
export function canonicalLeafFor(row: StoredCopyLeafRow): string | null {
  const raw = row.stored_name ?? (row.stored_path ? storedCopyLeaf(row.stored_path) : null)
  if (!raw) return null
  // Bare name only: no separators (a stored_name from a corrupted row), no traversal.
  if (raw !== storedCopyLeaf(raw)) return null
  if (raw === '.' || raw === '..' || raw.length === 0) return null
  // Belongs to THIS document. `<id>` is a UUID; the rest is `<ext>[.enc]`.
  if (!raw.startsWith(row.id)) return null
  return raw
}
