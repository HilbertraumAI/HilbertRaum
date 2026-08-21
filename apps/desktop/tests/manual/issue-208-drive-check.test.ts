import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  vaultPathsFrom,
  VaultLockError,
  WorkspaceController
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'

// MANUAL issue-#208 drive check — NOT CI.
//
// Re-runs the two-instance vault-destruction scenario (the CI pin is
// `tests/integration/workspace-vault-destruction.test.ts`) against a REAL drive's
// filesystem, because the incident mechanism is filesystem-semantic: the second instance's
// startup sweep overwrites the live working DB through SQLite's Windows share modes while
// the unlink fails without FILE_SHARE_DELETE, and NTFS vs exFAT vs FAT32 behave
// differently around open-handle deletes. CI proves the guards on the dev box's temp dir;
// this proves them where the product actually lives.
//
// SAFE BY CONSTRUCTION: everything happens inside a fresh `_issue208-check/` scratch
// directory at the given root, created here and removed at the end. The drive's real
// `config/` + `workspace/` are never read or written.
//
// RUN IT — from `apps/desktop/` (the `.cmd` form; `npx` is blocked on this machine):
//   $env:HILBERTRAUM_ISSUE208_DRIVE = "K:\"
//   ..\..\node_modules\.bin\vitest.cmd run tests/manual/issue-208-drive-check.test.ts

const root = process.env.HILBERTRAUM_ISSUE208_DRIVE
const gate = root ? describe : describe.skip

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

gate('issue #208 on the real drive — two-instance overlap must not destroy the vault', () => {
  it('create → second-instance init → lock refused → vault still unlocks', () => {
    const scratch = join(root!, '_issue208-check')
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(join(scratch, 'config'), { recursive: true })
    mkdirSync(join(scratch, 'workspace'), { recursive: true })
    const vp = vaultPathsFrom({
      configPath: join(scratch, 'config'),
      dbPath: join(scratch, 'workspace', 'hilbertraum.sqlite')
    })
    try {
      // Instance A: live unlocked session with a working file + WAL on the drive.
      const a = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      a.init()
      a.create('issue-208-check', 'encrypted')
      updateSettings(a.requireDb(), { contextTokens: 4096 })
      const encBefore = readFileSync(vp.encPath)

      // Instance B: full startup init() over the same paths — the incident's second exe.
      new WorkspaceController(vp, ENCRYPTION_REQUIRED, false).init()
      const dbShredded = !existsSync(vp.dbPath) || !readFileSync(vp.dbPath).subarray(0, 16).toString('latin1').startsWith('SQLite format 3')
      console.log(
        `[208-drive] after second-instance sweep: working file ${existsSync(vp.dbPath) ? 'SURVIVES as noise (Windows-style hold)' : 'unlinked (POSIX-style)'}; shredded=${dbShredded}`
      )

      // Instance A quits: the guard must refuse to encrypt garbage over `.enc`.
      expect(() => a.lock()).toThrowError(VaultLockError)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)

      // Relaunch: the vault still opens with the original password.
      const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      c.init()
      c.unlock('issue-208-check')
      expect(c.getState().state).toBe('unlocked')
      expect(getSettings(c.requireDb()).workspaceMode).toBe('encrypted')
      c.lock()
      console.log('[208-drive] PASS: lock refused over garbage, .enc byte-identical, vault unlocks after relaunch')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
