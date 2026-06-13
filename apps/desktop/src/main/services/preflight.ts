import { resolvePaths, buildDriveStatus } from './workspace'
import { measureDriveSpeed, buildWarnings, type DriveSpeed } from './benchmark'
import { tMain } from './i18n'
import type { PreflightResult } from '../../shared/types'

export type { PreflightResult }

// Launch preflight (spec §11.4 — non-technical first-run polish).
//
// On a commercial drive the buyer is non-technical. Before the app lands on the
// encrypted-workspace gate we run a friendly, NON-BLOCKING check: is the drive writable,
// is there free space, and is it a known-slow drive? Every message follows the spec §11.4
// tone — encouraging, never "your hardware is bad". This REUSES the drive status
// (`buildDriveStatus`) + the benchmark probe (`measureDriveSpeed`/`buildWarnings`); it
// does not add a second probe. STRICTLY LOCAL: only fs (no network) — the drive-speed
// function is injectable so the test suite stays deterministic + makes zero I/O surprises.

/** Below this free space we surface a gentle low-space note (not a hard block). */
export const LOW_FREE_SPACE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

export interface PreflightDeps {
  /** The drive root (the launcher's resolved `PAID_DRIVE_ROOT`). */
  rootPath: string
  /**
   * Injectable drive-speed probe (defaults to the real `measureDriveSpeed`). Tests pass a
   * fake so the suite never does real disk I/O and the no-network guarantee is obvious.
   */
  measureSpeed?: (workspacePath: string) => Promise<DriveSpeed>
  /** Free-space floor for the low-space note (defaults to LOW_FREE_SPACE_BYTES). */
  minFreeBytes?: number
}

/**
 * Run the launch preflight for a drive root. Reuses `buildDriveStatus` (writable + free
 * space) and `measureDriveSpeed`/`buildWarnings` (slow-drive note). Resilient: a failing
 * probe degrades to a friendly note, never a throw — a first run is never blocked by the
 * preflight itself.
 */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const minFree = deps.minFreeBytes ?? LOW_FREE_SPACE_BYTES
  const measure = deps.measureSpeed ?? measureDriveSpeed

  // Reuse the workspace path resolution + drive status (writable + free space + OS/arch).
  const paths = resolvePaths({ envRoot: deps.rootPath, fallbackRoot: deps.rootPath })
  const status = await buildDriveStatus(paths)

  // Reuse the benchmark drive-speed probe + warning copy. Passing the neutral 'BALANCED'
  // profile skips `buildWarnings`' TINY/UNKNOWN (hardware) branches, so today it can only
  // emit a drive note — but select it by content rather than by index, so a future
  // BALANCED-profile warning cannot be misreported as the slow-drive note.
  const speed = await measure(paths.workspacePath)
  const driveWarnings = buildWarnings({
    profile: 'BALANCED',
    driveReadMbps: speed.readMbps,
    driveWriteMbps: speed.writeMbps,
    driveError: speed.error
  })
  const slowDriveWarning = driveWarnings.find((w) => /drive/i.test(w)) ?? null

  // Problems are ephemeral (IPC response only) — localized at emission via tMain
  // (i18n-plan §3.3 rule 2). slowDriveWarning above stays canonical English: it comes
  // from buildWarnings, whose copy is persisted with benchmark results, so the
  // renderer display map translates it at display instead (D-L4).
  const problems: string[] = []
  if (!status.writable) {
    problems.push(tMain('main.preflight.readOnly'))
  }
  if (status.freeBytes != null && status.freeBytes < minFree) {
    problems.push(tMain('main.preflight.lowSpace'))
  }

  return {
    rootPath: status.rootPath,
    writable: status.writable,
    freeBytes: status.freeBytes,
    slowDriveWarning,
    problems
  }
}
