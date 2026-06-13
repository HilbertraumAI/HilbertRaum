import { win32, posix } from 'node:path'

// Launcher root resolution (spec §6 — plug-and-play distribution).
//
// A commercial drive ships an obvious, double-clickable launcher at the DRIVE ROOT
// (`Start HilbertRaum.cmd` / `.command` / `start-hilbertraum.sh`). The launcher
// sets `HILBERTRAUM_DRIVE_ROOT` and spawns the portable app. CRITICAL RULE (CLAUDE.md / spec):
// drive letters + mount points change per machine (E:\ on one laptop, F:\ on the next,
// /Volumes/HILBERTRAUM on a Mac), so the launcher MUST derive the drive root from its OWN
// location at launch — never a hardcoded path. This module is the canonical, unit-tested
// reference for that resolution; the launcher scripts mirror it natively
// (`%~dp0` on Windows, `dirname "$0"` on POSIX).

/** Which path grammar a launcher path uses. `auto` sniffs Windows vs POSIX from the string. */
export type PathFlavor = 'win32' | 'posix' | 'auto'

/** Heuristic: a backslash or a `C:`-style drive prefix means a Windows path. */
function detectFlavor(p: string): 'win32' | 'posix' {
  if (p.includes('\\')) return 'win32'
  if (/^[A-Za-z]:/.test(p)) return 'win32'
  return 'posix'
}

/**
 * Resolve the drive root (the value a launcher exports as `HILBERTRAUM_DRIVE_ROOT`) from the
 * launcher's OWN absolute path. The launcher sits AT the drive root, so the root is the
 * directory that contains it. Pure (path math only, no fs) so both Windows and POSIX
 * inputs are unit-testable on any host. There is NO hardcoded path: the result is always
 * derived from the input, so the same drive on a second laptop resolves to that laptop's
 * mount automatically (success criterion #10).
 *
 * @throws if the path is empty or has no parent directory (a bare filename).
 */
export function resolveDriveRootFromLauncher(launcherPath: string, flavor: PathFlavor = 'auto'): string {
  const trimmed = (launcherPath ?? '').trim()
  if (!trimmed) {
    throw new Error('resolveDriveRootFromLauncher: launcher path is empty')
  }
  const kind = flavor === 'auto' ? detectFlavor(trimmed) : flavor
  const impl = kind === 'win32' ? win32 : posix

  const normalized = impl.normalize(trimmed)
  const root = impl.dirname(normalized)

  // `dirname` of a bare filename is '.', and of a relative path it may stay relative —
  // a launcher must be invoked by its absolute location, so a non-absolute result means
  // we cannot trust it as the drive root.
  if (root === '.' || root === '' || !impl.isAbsolute(root)) {
    throw new Error(
      `resolveDriveRootFromLauncher: cannot derive an absolute drive root from "${launcherPath}" ` +
        '(the launcher must be invoked by its full path — %~dp0 / "$(dirname "$0")")'
    )
  }
  return root
}
