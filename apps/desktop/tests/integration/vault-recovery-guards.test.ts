import { describe, it, expect, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  WorkspaceController,
  RECOVERY_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import type { KdfParams } from '../../src/main/services/security/crypto'

// full-audit 2026-07-12 REL-1 / REL-2 — forced-failure guards on the `.recovery` salvage path.
// Both findings are Windows-hold edges (AV/search indexer holding a spent `.recovery` without
// FILE_SHARE_DELETE / FILE_SHARE_READ), impossible to reproduce portably with a real hold, so
// this file uses the workspace-vault-durability.test.ts idiom: `vi.mock('node:fs')` with
// pass-through wrappers that fail ONLY the targeted `.recovery` operation — everything else
// hits the real filesystem. Kept separate so the module mock cannot leak into the behavioral
// vault suites.
//
// REL-1: `preserveNewerPlaintext`'s rename onto a pre-existing (held) `.recovery` used to
// throw into the swallowing catch, after which `shredStalePlaintext` destroyed the working
// file — the ONLY fresh copy of the session's data. The fix pre-shreds the spent leftover.
// REL-2: unlock's roll-forward freshness probe (`fileHasSqliteHeader` + `statSync`) was not
// exception-guarded — an EBUSY on the held file failed the whole unlock raw. The fix treats a
// probe error as "can't decide": leave `.recovery` in place, unlock normally, retry next time.

const failures = vi.hoisted(() => ({
  /** REL-1: renameSync throws EPERM iff the TARGET ends with `.recovery` and already exists
   *  (the held-target semantics; a successful pre-shred makes the target vanish → real rename). */
  renameThrowOnExistingRecoveryTarget: false,
  /** REL-2: openSync throws EBUSY for any `.recovery` path (an AV hold without FILE_SHARE_READ),
   *  which makes `fileHasSqliteHeader`'s probe throw. */
  openThrowOnRecoveryPath: false
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const errnoError = (code: string, msg: string): NodeJS.ErrnoException => {
    const err = new Error(msg) as NodeJS.ErrnoException
    err.code = code
    return err
  }
  const mocked = {
    ...actual,
    renameSync: vi.fn((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (
        failures.renameThrowOnExistingRecoveryTarget &&
        String(to).endsWith('.recovery') &&
        actual.existsSync(to)
      ) {
        throw errnoError('EPERM', 'EPERM: operation not permitted, rename (held .recovery target)')
      }
      return actual.renameSync(from, to)
    }),
    openSync: vi.fn((path: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      if (failures.openThrowOnRecoveryPath && String(path).endsWith('.recovery')) {
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, open (held .recovery)')
      }
      return actual.openSync(path, flags, mode)
    })
  }
  return { ...mocked, default: mocked }
})

// Fast KDF so the suite stays quick (the workspace-vault.test.ts fixture).
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

/** Build a fresh temp workspace layout + its vault paths. */
function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-recovery-guards-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') })
}

/** The exact disk state a failed lock leaves behind: a checkpointed, cleanly CLOSED plaintext
 *  working file (no -wal/-shm) newer than the stale `.enc` (the workspace-vault.test.ts helper). */
function failedLockState(vp: VaultPaths): void {
  const { db } = unlockEncryptedVault(vp, 'pw')
  updateSettings(db, { contextTokens: 7171 })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  const past = new Date(Date.now() - 60_000)
  utimesSync(vp.encPath, past, past)
}

describe('`.recovery` guards (full-audit 2026-07-12 REL-1/REL-2)', () => {
  it('REL-1: a spent .recovery blocking the rename no longer costs the only fresh copy', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    failedLockState(vp) // the working file (7171) is the only fresh copy

    // The spent leftover of an earlier salvage whose best-effort unlink failed (Windows hold),
    // still sitting on the rename target at the next launch.
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    writeFileSync(recoveryPath, 'spent leftover that outlived its unlink')
    const past = new Date(Date.now() - 60_000)
    utimesSync(recoveryPath, past, past)

    failures.renameThrowOnExistingRecoveryTarget = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()

      // Pre-fix: the rename threw into the swallowing catch and `shredStalePlaintext`
      // destroyed the fresh working file — 7171 unrecoverable. Post-fix: the pre-shred
      // removed the spent leftover, the rename landed, and the salvage snapshot is the
      // FRESH data (not the leftover bytes).
      expect(existsSync(recoveryPath)).toBe(true)
      expect(readFileSync(recoveryPath).includes(Buffer.from('spent leftover'))).toBe(false)

      // The roll-forward consumes it: nothing since the failed lock was lost.
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
      expect(existsSync(recoveryPath)).toBe(false)
      ctl.lock()
    } finally {
      failures.renameThrowOnExistingRecoveryTarget = false
    }
  })

  it('REL-2: a probe error on .recovery no longer fails the unlock; the snapshot is preserved for retry', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key) // `.enc` holds 6161

    // A `.recovery` leftover exists; the AV hold means the probe cannot even OPEN it.
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    writeFileSync(recoveryPath, 'held leftover the probe cannot read')

    failures.openThrowOnRecoveryPath = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      // Pre-fix: fileHasSqliteHeader's openSync threw EBUSY raw out of unlockEncryptedVault
      // → generic openFailed; the user could not unlock until the hold cleared.
      const state = ctl.unlock('pw')
      expect(state.state).toBe('unlocked')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6161)
      // Can't decide → don't touch: NOT shredded on a probe error, NOT rolled forward.
      expect(existsSync(recoveryPath)).toBe(true)
      ctl.lock()
    } finally {
      failures.openThrowOnRecoveryPath = false
    }

    // Hold cleared → the next unlock's probe decides normally: the garbage leftover fails
    // the header guard, is shredded as spent, and the vault data is untouched.
    const ctl2 = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl2.init()
    ctl2.unlock('pw')
    expect(getSettings(ctl2.requireDb()).contextTokens).toBe(6161)
    expect(existsSync(recoveryPath)).toBe(false)
    ctl2.lock()
  })
})
