import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildDriveStatus,
  ensureWorkspaceDirs,
  findPreparedDriveRoot,
  locateDriveRoot,
  resolvePaths
} from '../../src/main/services/workspace'
import { tempRoot } from '../helpers/db-fixtures'

// #858: main/index.ts hands `locateDriveRoot` the override and the app's real location; its result goes to
// `resolvePaths`. An empty or blank override is "not set", and each launch shape must find the drive it runs from.
describe('locateDriveRoot', () => {
  /** A prepared drive (`config/drive.json`) with the app somewhere below it. */
  function kit(): { drive: string; app: string } {
    const drive = tempRoot('drive-locate')
    mkdirSync(join(drive, 'config'), { recursive: true })
    writeFileSync(join(drive, 'config', 'drive.json'), '{}')
    const app = join(drive, 'app', 'linux')
    mkdirSync(app, { recursive: true })
    return { drive, app }
  }
  const nowhere = (): string => join(tempRoot('drive-none'), 'bin', 'hilbertraum')

  it.each([
    ['no override', undefined],
    ['an empty override (VAR= ./app)', ''],
    ['a blank override', '   ']
  ])('%s: the drive the executable sits on wins', (_label, envOverride) => {
    const { drive, app } = kit()
    expect(locateDriveRoot({ envOverride, exePath: join(app, 'hilbertraum') })).toEqual({ root: drive, fromOverride: false })
  })

  it('a real override wins, trimmed, over a detected drive', () => {
    const { app } = kit()
    expect(locateDriveRoot({ envOverride: '  /mnt/kit  ', exePath: join(app, 'hilbertraum') })).toEqual({
      root: '/mnt/kit',
      fromOverride: true
    })
  })

  it("a Linux AppImage is found from $APPIMAGE, not from its FUSE mount's executable", () => {
    const { drive, app } = kit()
    const fuseExe = nowhere() // the executable inside /tmp/.mount_XXXX: no drive above it
    const appImageDir = dirname(dirname(fuseExe)) // $APPDIR: the mount that holds the executable
    expect(
      locateDriveRoot({ appImagePath: join(app, 'HilbertRaum.AppImage'), appImageDir, exePath: fuseExe })
    ).toEqual({ root: drive, fromOverride: false })
  })

  it("an $APPIMAGE inherited from ANOTHER AppImage is ignored: the executable's own drive wins", () => {
    const own = kit()
    const other = kit() // a second Kit, holding the AppImage whose child this process is
    const otherMount = tempRoot('drive-other-mount') // that AppImage's $APPDIR; our executable is not in it
    expect(
      locateDriveRoot({
        appImagePath: join(other.app, 'Other.AppImage'),
        appImageDir: otherMount,
        exePath: join(own.app, 'hilbertraum')
      })
    ).toEqual({ root: own.drive, fromOverride: false })
  })

  it('an $APPIMAGE that sits on no drive falls through to the executable', () => {
    const { drive, app } = kit()
    const exePath = join(app, 'hilbertraum')
    expect(
      locateDriveRoot({ appImagePath: nowhere(), appImageDir: dirname(dirname(exePath)), exePath })
    ).toEqual({ root: drive, fromOverride: false })
  })

  it('the Windows portable exe is found from PORTABLE_EXECUTABLE_DIR, not from its temp extraction', () => {
    const { drive, app } = kit()
    expect(locateDriveRoot({ portableExeDir: app, exePath: nowhere() })).toEqual({ root: drive, fromOverride: false })
  })

  it('nothing set and no drive above the app → undefined (app-data)', () => {
    expect(locateDriveRoot({ envOverride: '', appImagePath: '', exePath: nowhere() })).toEqual({
      root: undefined,
      fromOverride: false
    })
  })
})

describe('resolvePaths', () => {
  // The drive layout (docs/drive-layout.md): the vault's `.enc` is `<dbPath>.enc`, so a database
  // moved out of `workspace/` would move the encrypted workspace with it.
  it('uses the fallback root when no env override is set', () => {
    const root = join(tmpdir(), 'appdata')
    const r = resolvePaths({ fallbackRoot: root })
    expect(r.rootPath).toBe(root)
    expect(r.workspacePath).toBe(join(root, 'workspace'))
    expect(r.modelsPath).toBe(join(root, 'models'))
    expect(r.logsPath).toBe(join(root, 'logs'))
    expect(r.configPath).toBe(join(root, 'config'))
    expect(r.dbPath).toBe(join(root, 'workspace', 'hilbertraum.sqlite'))
    expect(r.isPreparedDrive).toBe(false)
  })

  it('an envRoot (main passes HILBERTRAUM_DRIVE_ROOT) wins over the fallback root', () => {
    const r = resolvePaths({ envRoot: join(tmpdir(), 'drive'), fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.rootPath).toBe(join(tmpdir(), 'drive'))
  })

  it('detects a prepared drive via config/drive.json', () => {
    const root = tempRoot('drive')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    const r = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.isPreparedDrive).toBe(true)
  })

  it('treats a root without the marker as not-prepared', () => {
    const root = tempRoot('plain')
    const r = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.isPreparedDrive).toBe(false)
  })
})

// M16 (audit round 4): a buyer who double-clicks the portable .exe / .app directly
// (no launcher → no HILBERTRAUM_DRIVE_ROOT) must still land on the DRIVE workspace.
describe('findPreparedDriveRoot', () => {
  it('finds the marker by walking up from a nested app location', () => {
    const root = tempRoot('exe-drive')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    // macOS-style nesting: <drive>/HilbertRaum.app/Contents/MacOS/
    const deep = join(root, 'HilbertRaum.app', 'Contents', 'MacOS')
    mkdirSync(deep, { recursive: true })
    expect(findPreparedDriveRoot(deep)).toBe(root)
    // The exe directly at the drive root (Windows portable) also resolves.
    expect(findPreparedDriveRoot(root)).toBe(root)
  })

  it('returns null without a marker — an exe in Downloads must not create a workspace there', () => {
    const downloads = tempRoot('downloads')
    expect(findPreparedDriveRoot(downloads)).toBeNull()
    expect(findPreparedDriveRoot(undefined)).toBeNull()
    expect(findPreparedDriveRoot('')).toBeNull()
  })
})

// End-to-end Phase 1 init (without the Electron app object): resolve → create dirs → report
// status. Mirrors what main/index.ts initBackend() does.
describe('workspace initialization', () => {
  it('creates the required directory layout and reports a usable DriveStatus', async () => {
    const root = tempRoot('init')
    const paths = resolvePaths({ envRoot: root, fallbackRoot: root })

    ensureWorkspaceDirs(paths)
    expect(existsSync(paths.workspacePath)).toBe(true)
    expect(existsSync(paths.modelsPath)).toBe(true)
    expect(existsSync(paths.logsPath)).toBe(true)
    expect(existsSync(paths.configPath)).toBe(true)

    const status = await buildDriveStatus(paths)
    expect(status.rootPath).toBe(root)
    expect(status.writable).toBe(true)
    expect(status.platform).toBe(process.platform)
    expect(status.isPreparedDrive).toBe(false)
    // #122 (#860 W1): no saved image history yet reads 0, not "unknown"; then it is the sum of the stored files.
    expect(status.imagesBytes).toBe(0)
    mkdirSync(join(paths.workspacePath, 'images'))
    writeFileSync(join(paths.workspacePath, 'images', 'a.png.enc'), Buffer.alloc(300))
    writeFileSync(join(paths.workspacePath, 'images', 'b.jpg.enc'), Buffer.alloc(45))
    expect((await buildDriveStatus(paths)).imagesBytes).toBe(345)
  })

  // #1024 review M-1: Node's recursive mkdir reports only EACCES, ENOSPC, ENOTDIR and EPERM as they are. Any other
  // refusal of a missing folder (EROFS from a write-protected card or a read-only mount, EIO, EINVAL) it replaces with
  // the ENOENT of the stat it makes next, so the start-failure card showed the general text and "ENOENT" for a
  // lock-switched card. A dangling link at the folder's name masks the same way on every OS (mkdir says EEXIST, the stat
  // ENOENT), so it stands in for the card: the folder's own error must come through.
  it('reports a folder’s own error, never the ENOENT Node’s recursive mkdir masks it with (#1024)', () => {
    const root = tempRoot('init-masked')
    const paths = resolvePaths({ envRoot: root, fallbackRoot: root })
    symlinkSync(join(root, 'nowhere'), paths.workspacePath, process.platform === 'win32' ? 'junction' : 'dir')
    let thrown: unknown
    try {
      ensureWorkspaceDirs(paths)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'EEXIST', syscall: 'mkdir' })
  })
})
