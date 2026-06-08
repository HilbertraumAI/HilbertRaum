import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../../src/main/services/workspace'

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
