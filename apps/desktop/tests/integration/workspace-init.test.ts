import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolvePaths,
  ensureWorkspaceDirs,
  buildDriveStatus
} from '../../src/main/services/workspace'

// End-to-end Phase 1 init (without the Electron app object): resolve → create
// dirs → report status. Mirrors what main/index.ts initBackend() does.
describe('workspace initialization', () => {
  it('creates the required directory layout and reports a usable DriveStatus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-init-'))
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
