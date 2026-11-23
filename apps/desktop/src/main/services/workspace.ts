import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DriveStatus } from '../../shared/types'
import { freeBytes } from './disk-space'
import { IMAGES_DIR_NAME } from './workspace-vault'

// Workspace / drive manager (spec §7.2 drive detector + §7.9 workspace manager).
// Resolves where models + the workspace live, supporting three layouts:
//   1. Prepared external drive (a `config/drive.json` marker at the root)
//   2. Explicit override via the HILBERTRAUM_DRIVE_ROOT environment variable
//   3. App-data fallback (normal install / dev)
// Detection order in main (`locateDriveRoot`): HILBERTRAUM_DRIVE_ROOT (the launchers) → walk-up
// from the app's real location (`findPreparedDriveRoot` from the portable exe's folder, the
// AppImage's file or the executable — a buyer who starts the app directly, bypassing the
// launcher, must still land on the DRIVE workspace, not a silent fresh app-data one) →
// app-data fallback.

/** Where the running app really is, for {@link locateDriveRoot}. */
export interface AppLocation {
  /** `HILBERTRAUM_DRIVE_ROOT` (the launchers set it to the drive). */
  envOverride?: string
  /** `PORTABLE_EXECUTABLE_DIR`: the Windows portable exe extracts itself to a temp dir and names its real folder here. */
  portableExeDir?: string
  /** `APPIMAGE`: a Linux AppImage runs from a FUSE mount under /tmp and names the real .AppImage file here. */
  appImagePath?: string
  /** `APPDIR`: that FUSE mount. `APPIMAGE` counts only while the executable sits inside it: every child of
   *  ANY AppImage inherits both, so a value leaked from another app's AppImage must not pick the drive. */
  appImageDir?: string
  /** `app.getPath('exe')`: an unpacked macOS .app or Linux build run in place. */
  exePath: string
}

/**
 * The workspace root to hand `resolvePaths`. The `HILBERTRAUM_DRIVE_ROOT` override wins when it names a
 * path; an EMPTY or blank one counts as unset (#858). `VAR= ./app` from a shell used to keep `''`, which
 * `resolvePaths` trims away, so the app fell back to app-data although it ran from a prepared drive.
 * Without an override, the drive is found by walking up from where the app really is (see
 * {@link AppLocation}; #858: an AppImage's executable sits in its FUSE mount, so only `$APPIMAGE` reaches
 * the drive). Not found → `undefined` (app-data). `fromOverride` says which source won, for the startup log.
 */
export function locateDriveRoot(loc: AppLocation): { root: string | undefined; fromOverride: boolean } {
  const override = loc.envOverride?.trim()
  if (override) return { root: override, fromOverride: true }
  const appImage = loc.appImagePath?.trim()
  const appDir = loc.appImageDir?.trim()
  const ownAppImage = appImage && appDir && loc.exePath.startsWith(appDir) ? appImage : undefined
  const detected =
    findPreparedDriveRoot(loc.portableExeDir) ??
    findPreparedDriveRoot(ownAppImage ? dirname(ownAppImage) : undefined) ??
    findPreparedDriveRoot(dirname(loc.exePath))
  return { root: detected ?? undefined, fromOverride: false }
}

/**
 * Walk up from `startDir` looking for the prepared-drive marker (`config/drive.json`).
 * Returns the drive root, or null. Used when the app is launched WITHOUT the launcher:
 * the Windows portable exe exposes its real location via PORTABLE_EXECUTABLE_DIR (the
 * exe itself extracts to a temp dir), a Linux AppImage via APPIMAGE (it runs from a FUSE
 * mount), and an unpacked macOS .app or Linux build is found by walking up from the
 * executable (a .app that Gatekeeper translocates runs from elsewhere and is not found:
 * the drive's launcher covers that). At most `maxLevels` folders up. Only a marker hit counts — an exe sitting in
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
  /** The root `locateDriveRoot` picked: the HILBERTRAUM_DRIVE_ROOT override or the detected drive. */
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
    dbPath: join(rootPath, 'workspace', 'hilbertraum.sqlite'),
    isPreparedDrive
  }
}

/** Create the required directory layout. Idempotent. */
export function ensureWorkspaceDirs(paths: ResolvedPaths): void {
  for (const dir of [paths.workspacePath, paths.modelsPath, paths.logsPath, paths.configPath]) {
    createFolder(dir)
  }
}

/**
 * `mkdir -p` that reports the folder's own error (#1024 review M-1). Node's recursive mkdir passes on only EACCES,
 * ENOSPC, ENOTDIR and EPERM as they are; any other refusal of a missing folder (EROFS from a write-protected card or a
 * read-only mount, EIO, EINVAL) it replaces with the ENOENT of the `stat` it makes next. The start-failure card words
 * that as "something else" with "ENOENT", so a lock-switched card did not read as one. So one plain mkdir of the
 * highest missing folder, right under the deepest one that exists (CR-3: the drive root and its parent may both be
 * missing), reads the real error. When nothing above exists (a drive that is gone), the ENOENT is the real answer. A
 * folder made meanwhile (a second start) is fine: then the rest is made as before.
 */
function createFolder(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
    const missing = highestMissingFolder(dir)
    if (missing === null) throw err
    try {
      mkdirSync(missing)
    } catch (real) {
      if (!isFolder(missing)) throw real
    }
    mkdirSync(dir, { recursive: true })
  }
}

/** The highest folder on `dir`'s path that is missing, right under the deepest one that exists; null when no folder
 *  above `dir` exists. A dangling link counts as missing (`existsSync` follows it). */
function highestMissingFolder(dir: string): string | null {
  let missing = dir
  let parent = dirname(dir)
  while (parent !== missing) {
    if (existsSync(parent)) return missing
    missing = parent
    parent = dirname(parent)
  }
  return null
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
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

/**
 * On-disk footprint of `workspace/images/` — the saved image-analysis history (#122). The dir
 * is flat (one stored file per session) and its `.enc` sidecars stat fine while locked, so this
 * is a cheap sum of file sizes. `0` when the dir doesn't exist yet; `null` only when unreadable.
 */
async function imagesFootprintBytes(workspacePath: string): Promise<number | null> {
  const dir = join(workspacePath, IMAGES_DIR_NAME)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    let total = 0
    for (const e of entries) {
      if (!e.isFile()) continue
      total += (await stat(join(dir, e.name))).size
    }
    return total
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 0 : null
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
    imagesBytes: await imagesFootprintBytes(paths.workspacePath),
    platform: process.platform,
    arch: process.arch
  }
}
