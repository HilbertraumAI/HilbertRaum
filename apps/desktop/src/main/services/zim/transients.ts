import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type Dirent
} from 'node:fs'
import { join, sep } from 'node:path'
import { log } from '../logging'
import { shredFile } from '../workspace-vault'

// The knowledge-pack transient directory and its dedicated cleanup (#301, findings L3 / M4;
// residual R-7).
//
// The ONLY files the pack feature writes outside the workspace database are
//
//     <workspacePath>/zim-transient/library.<build>.xml      (a served library build)
//     <workspacePath>/zim-transient/meta-<n>/library.xml      (a registration throwaway)
//
// Both are PLAINTEXT while they exist — the XML names every enabled pack's title and absolute
// path — in BOTH workspace modes (an encrypted vault and plaintext_dev alike). Before this
// they lived in the host's temp directory and survived a lock, which is exactly what M4/L3
// reported. They are removed at lock, at quit and at every session start.
//
// This is a DEDICATED entry point, not a case in `shredStalePlaintext`'s documents/images
// loop: that loop visits only `documents/` and `images/`, its predicate matches neither name,
// `shredFile` is file-only (so `meta-<n>/` needs a recursive walk), and it runs for encrypted
// vaults only while this cleanup must also run in plaintext_dev.
//
// Containment comes FIRST and the walk never follows a link: the directory must be a real
// directory (never a symlink or a Windows junction) whose resolved path is exactly
// `<realpath(workspacePath)>/zim-transient`. Anything else is REFUSED with one warning and a
// report that says so — a recursive remover pointed at a redirected path is the failure mode
// worth refusing over. Only the two known name shapes are ever removed; any other entry is
// left in place and counted, so an unexpected file can never be deleted silently and can never
// be reported as a clean sweep either.
//
// Sentinel rule: nothing logged here carries a pack title or an absolute path — counts only.

/** The one directory name. Never configurable: the containment check is written against it. */
export const ZIM_TRANSIENT_DIR_NAME = 'zim-transient'

/** `<workspacePath>/zim-transient` — the production transient location (created lazily). */
export function zimTransientDir(workspacePath: string): string {
  return join(workspacePath, ZIM_TRANSIENT_DIR_NAME)
}

/**
 * What one cleanup pass did. `confirmed` is deliberately narrow: it is false whenever anything
 * was left behind for ANY reason (a refusal, a kept file of a child that could not be confirmed
 * dead, an unknown entry, an operation still running, a removal that failed because a stray
 * process holds the file open). The lock/quit log says "NOT confirmed" then, never "complete".
 */
export interface ZimCleanupReport {
  /** Top-level entries actually removed (a `meta-<n>/` directory counts as one). */
  removed: number
  /** Entries deliberately left because they belong to a child whose death is unconfirmed. */
  kept: number
  /** Entries left because their name is neither `library.<n>.xml` nor `meta-<n>/`. */
  unknownEntries: number
  /** Live operations at cleanup time (the caller supplies it; 0 for the standalone sweep). */
  unsettledOps: number
  /** Children this service could never confirm dead (the caller supplies it). */
  unconfirmedChildren: number
  /** Nothing was refused, kept, unknown, unsettled or left behind by a failed removal. */
  confirmed: boolean
}

export interface ZimCleanupOptions {
  /**
   * Paths that must NOT be removed: the library file of a serve child, or the meta dir of a
   * manager child, whose teardown could not be confirmed (plan §9.15 item 6 — a possibly-live
   * process may still be writing them). A kept entry is reported and removed by the next
   * session-start pass, when its process is gone or has been reaped.
   */
  keep?: ReadonlySet<string>
  /** Case-folding rule for the containment compare (#301 P5, finding L9): injected so both
   *  branches are testable on any host; production passes the service's `platform`. */
  platform?: NodeJS.Platform
}

const LIBRARY_BUILD_NAME = /^library\.\d+\.xml$/
const META_DIR_NAME = /^meta-\d+$/

function emptyReport(confirmed: boolean): ZimCleanupReport {
  return {
    removed: 0,
    kept: 0,
    unknownEntries: 0,
    unsettledOps: 0,
    unconfirmedChildren: 0,
    confirmed
  }
}

/** Windows paths differ only in case; every other platform compares exactly. `platform` is
 *  injected (#301 P5, finding L9) so the two branches are pinned independently of the host. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** True when `keep` names this entry itself or anything inside it (a meta dir may be kept
 *  either as the directory or through the `meta-<n>/library.xml` an operation tracked). */
function isKept(keep: ReadonlySet<string>, entryPath: string): boolean {
  if (keep.size === 0) return false
  if (keep.has(entryPath)) return true
  const prefix = entryPath + sep
  for (const kept of keep) {
    if (kept.startsWith(prefix)) return true
  }
  return false
}

/** `readdirSync(withFileTypes)` — link entries report as links (it never follows them). */
function readEntries(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[]
  } catch {
    return null
  }
}

/**
 * Remove a LINK entry — the link itself, never what it points at. Windows needs `rmdir` for a
 * directory symlink or junction (`unlink` refuses with EPERM) and `unlink` for a file link, so
 * both are tried; POSIX takes the first.
 */
function unlinkLink(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    /* a directory link on Windows */
  }
  try {
    rmdirSync(path)
    return true
  } catch {
    return false
  }
}

/** Recursively empty and remove one `meta-<n>/` directory. Links are unlinked, never followed;
 *  regular files are shredded. Returns false when anything survived. */
function removeMetaDir(dir: string): boolean {
  let ok = true
  const entries = readEntries(dir)
  if (entries === null) return false
  for (const entry of entries) {
    const child = join(dir, entry.name)
    try {
      if (entry.isSymbolicLink()) {
        if (!unlinkLink(child)) ok = false
      } else if (entry.isDirectory()) {
        if (!removeMetaDir(child)) ok = false
      } else {
        shredFile(child)
        if (existsSync(child)) ok = false
      }
    } catch {
      ok = false
    }
  }
  try {
    rmdirSync(dir)
  } catch {
    ok = false
  }
  return ok
}

interface SweepCounts {
  removed: number
  kept: number
  unknownEntries: number
  /** Entries whose removal was attempted and did not take (a file still held open). */
  failed: number
}

/** Classify and remove the directory's contents. Assumes containment was already established. */
function sweepEntries(dir: string, keep: ReadonlySet<string>): SweepCounts {
  const counts: SweepCounts = { removed: 0, kept: 0, unknownEntries: 0, failed: 0 }
  const entries = readEntries(dir)
  if (entries === null) {
    counts.failed++
    return counts
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    // A link INSIDE the directory is removed as the link itself and never followed — its
    // target is not ours to touch.
    if (entry.isSymbolicLink()) {
      if (unlinkLink(path)) counts.removed++
      else counts.failed++
      continue
    }
    if (entry.isFile() && LIBRARY_BUILD_NAME.test(entry.name)) {
      if (isKept(keep, path)) {
        counts.kept++
        continue
      }
      try {
        shredFile(path)
        if (existsSync(path)) counts.failed++
        else counts.removed++
      } catch {
        counts.failed++
      }
      continue
    }
    if (entry.isDirectory() && META_DIR_NAME.test(entry.name)) {
      if (isKept(keep, path)) {
        counts.kept++
        continue
      }
      if (removeMetaDir(path)) counts.removed++
      else counts.failed++
      continue
    }
    // Anything else: left exactly where it is, and counted — a cleanup that met something it
    // does not own is not a confirmed cleanup.
    counts.unknownEntries++
  }
  return counts
}

function toReport(counts: SweepCounts): ZimCleanupReport {
  return {
    removed: counts.removed,
    kept: counts.kept,
    unknownEntries: counts.unknownEntries,
    unsettledOps: 0,
    unconfirmedChildren: 0,
    confirmed: counts.kept === 0 && counts.unknownEntries === 0 && counts.failed === 0
  }
}

/**
 * The contained cleanup of `<workspacePath>/zim-transient/`. Absent directory ⇒ nothing to do
 * (confirmed). A symlink/junction, a non-directory, or a resolved path that is not exactly
 * `<realpath(workspacePath)>/zim-transient` ⇒ REFUSED: nothing is removed, one warning is
 * logged and the report is `confirmed: false`.
 *
 * Called at startup with an empty keep set (the crash sweep), and by `ZimService` at lock,
 * quit and session start with the paths of children whose death could not be confirmed.
 */
export function cleanupZimTransients(
  transientDir: string,
  workspacePath: string,
  opts: ZimCleanupOptions = {}
): ZimCleanupReport {
  const keep = opts.keep ?? new Set<string>()
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(transientDir)
  } catch {
    return emptyReport(true) // never created, or already gone
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    log.warn('ZIM transient cleanup refused: the transient path is not a real directory')
    return emptyReport(false)
  }
  try {
    const resolved = realpathSync(transientDir)
    const expected = join(realpathSync(workspacePath), ZIM_TRANSIENT_DIR_NAME)
    if (!samePath(resolved, expected, opts.platform)) {
      log.warn('ZIM transient cleanup refused: the transient directory resolves outside the workspace')
      return emptyReport(false)
    }
  } catch {
    log.warn('ZIM transient cleanup refused: the transient directory could not be resolved')
    return emptyReport(false)
  }
  const counts = sweepEntries(transientDir, keep)
  if (counts.failed > 0) {
    log.warn('ZIM transient cleanup left entries behind', { failed: counts.failed })
  }
  return toReport(counts)
}

/**
 * The same classification WITHOUT the workspace containment gate, for a service whose library
 * directory is a test seam (`ZimServiceDeps.libraryDir`) or the pre-P3b OS-temp fallback —
 * neither sits under a workspace, so there is nothing to contain it against. Still removes
 * only `library.<n>.xml` files and `meta-<n>/` directories, still never follows a link.
 * Production always goes through {@link cleanupZimTransients}.
 */
export function sweepZimTransientDir(dir: string, opts: ZimCleanupOptions = {}): ZimCleanupReport {
  const keep = opts.keep ?? new Set<string>()
  try {
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return emptyReport(false)
  } catch {
    return emptyReport(true)
  }
  return toReport(sweepEntries(dir, keep))
}
