import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDriveStatus,
  ensureWorkspaceDirs,
  findPreparedDriveRoot,
  resolvePaths
} from '../../src/main/services/workspace'
import { tempRoot } from '../helpers/db-fixtures'

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
  })
})
