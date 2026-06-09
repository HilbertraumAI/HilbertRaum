import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPreparedDriveRoot, resolvePaths } from '../../src/main/services/workspace'

describe('resolvePaths', () => {
  it('uses the fallback root when no env override is set', () => {
    const r = resolvePaths({ fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.rootPath).toBe(join(tmpdir(), 'appdata'))
    expect(r.workspacePath).toContain('workspace')
    expect(r.modelsPath).toContain('models')
    expect(r.logsPath).toContain('logs')
    expect(r.dbPath).toContain('paid.sqlite')
    expect(r.isPreparedDrive).toBe(false)
  })

  it('honors the PAID_DRIVE_ROOT override', () => {
    const r = resolvePaths({ envRoot: join(tmpdir(), 'drive'), fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.rootPath).toBe(join(tmpdir(), 'drive'))
  })

  it('detects a prepared drive via config/drive.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-drive-'))
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    const r = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.isPreparedDrive).toBe(true)
  })

  it('treats a root without the marker as not-prepared', () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-plain-'))
    const r = resolvePaths({ envRoot: root, fallbackRoot: join(tmpdir(), 'appdata') })
    expect(r.isPreparedDrive).toBe(false)
  })
})

// M16 (audit round 4): a buyer who double-clicks the portable .exe / .app directly
// (no launcher → no PAID_DRIVE_ROOT) must still land on the DRIVE workspace.
describe('findPreparedDriveRoot', () => {
  it('finds the marker by walking up from a nested app location', () => {
    const root = mkdtempSync(join(tmpdir(), 'paid-exe-drive-'))
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    // macOS-style nesting: <drive>/Private AI Drive Lite.app/Contents/MacOS/
    const deep = join(root, 'Private AI Drive Lite.app', 'Contents', 'MacOS')
    mkdirSync(deep, { recursive: true })
    expect(findPreparedDriveRoot(deep)).toBe(root)
    // The exe directly at the drive root (Windows portable) also resolves.
    expect(findPreparedDriveRoot(root)).toBe(root)
  })

  it('returns null without a marker — an exe in Downloads must not create a workspace there', () => {
    const downloads = mkdtempSync(join(tmpdir(), 'paid-downloads-'))
    expect(findPreparedDriveRoot(downloads)).toBeNull()
    expect(findPreparedDriveRoot(undefined)).toBeNull()
    expect(findPreparedDriveRoot('')).toBeNull()
  })
})
