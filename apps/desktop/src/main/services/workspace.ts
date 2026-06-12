import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DriveStatus } from '../../shared/types'

// Workspace / drive manager (spec §7.2 drive detector + §7.9 workspace manager).
// Resolves where models + the workspace live, supporting three layouts:
//   1. Prepared external drive (a `config/drive.json` marker at the root)
//   2. Explicit override via the PAID_DRIVE_ROOT environment variable
//   3. App-data fallback (normal install / dev)
// Detection order in main: PAID_DRIVE_ROOT (the launchers) → walk-up from the app's own
// location (`findPreparedDriveRoot` — a buyer who double-clicks the portable .exe /
// .app directly, bypassing the launcher, must still land on the DRIVE workspace, not a
// silent fresh app-data one) → app-data fallback.

/**
 * Walk up from `startDir` looking for the prepared-drive marker (`config/drive.json`).
 * Returns the drive root, or null. Used when the app is launched WITHOUT the launcher:
 * the Windows portable exe exposes its real location via PORTABLE_EXECUTABLE_DIR (the
 * exe itself extracts to a temp dir), and a macOS .app/Linux AppImage on the drive is
 * found by walking up from the executable. Only a marker hit counts — an exe sitting in
 * Downloads must NOT turn Downloads into a workspace root.
 */
export function findPreparedDriveRoot(startDir: string | undefined, maxLevels = 6): string | null {
  let dir = startDir?.trim()
  if (!dir) return null
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, 'config', 'drive.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export interface ResolvedPaths {
  rootPath: string
  workspacePath: string
  modelsPath: string
  logsPath: string
  configPath: string
  dbPath: string
  isPreparedDrive: boolean
}

export interface ResolveOptions {
  /** Value of PAID_DRIVE_ROOT, if set. */
  envRoot?: string
  /** Fallback root (e.g. Electron app.getPath('userData')). */
  fallbackRoot: string
}

/** Pure path resolution — no side effects, so it is easy to unit-test. */
export function resolvePaths(opts: ResolveOptions): ResolvedPaths {
  const envRoot = opts.envRoot?.trim()
  let rootPath: string
  let isPreparedDrive = false

  if (envRoot) {
    rootPath = envRoot
    isPreparedDrive = existsSync(join(envRoot, 'config', 'drive.json'))
  } else {
    rootPath = opts.fallbackRoot
    isPreparedDrive = false
  }

  return {
    rootPath,
    workspacePath: join(rootPath, 'workspace'),
    modelsPath: join(rootPath, 'models'),
    logsPath: join(rootPath, 'logs'),
    configPath: join(rootPath, 'config'),
    dbPath: join(rootPath, 'workspace', 'paid.sqlite'),
    isPreparedDrive
  }
}

/** Create the required directory layout. Idempotent. */
export function ensureWorkspaceDirs(paths: ResolvedPaths): void {
  for (const dir of [paths.workspacePath, paths.modelsPath, paths.logsPath, paths.configPath]) {
    mkdirSync(dir, { recursive: true })
  }
}

function isWritable(dir: string): boolean {
  const probe = join(dir, `.write-test-${process.pid}`)
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe)
    return true
  } catch {
    return false
  }
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Build the DriveStatus shown in the UI (spec §7.2). */
export async function buildDriveStatus(paths: ResolvedPaths): Promise<DriveStatus> {
  return {
    rootPath: paths.rootPath,
    workspacePath: paths.workspacePath,
    modelsPath: paths.modelsPath,
    logsPath: paths.logsPath,
    isPreparedDrive: paths.isPreparedDrive,
    writable: isWritable(paths.workspacePath),
    freeBytes: await freeBytes(paths.rootPath),
    platform: process.platform,
    arch: process.arch
  }
}
