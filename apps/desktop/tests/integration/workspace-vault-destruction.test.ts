import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  unlockEncryptedVault,
  lockEncryptedVault,
  encryptFile,
  stageRekey,
  VaultDamagedError,
  VaultLockError,
  WorkspaceController,
  WrongPasswordError,
  REKEY_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy } from '../../src/shared/types'
import type { Db } from '../../src/main/services/db'
import type { KdfParams } from '../../src/main/services/security/crypto'

// Issue #208 — an encrypted workspace was destroyed ON DISK: `.enc` ended up holding the
// app's own encryption of a 483 kB random-noise file (a shred survivor), so every unlock
// decrypted — valid GCM tag — to noise and died in openDatabase, presenting as a wrong
// password. Root cause: a SECOND app instance's startup crash-sweep random-overwrote the
// first instance's live plaintext working DB in place (on Windows the overwrite passes
// SQLite's share modes while the unlink fails without FILE_SHARE_DELETE, so the noise
// keeps the file's name; the first instance keeps reading from its page cache and notices
// NOTHING), and the first instance's lock-on-quit then encrypted the noise over the only
// good `.enc`. These tests pin the three guards that close the loss:
//   • lock/stage NEVER encrypt a non-SQLite source over the vault (the stale `.enc` is a
//     recoverable workspace; authenticated noise is not);
//   • an unlock that decrypts fine but cannot OPEN the result throws the typed
//     `VaultDamagedError` (not the wrong-password shape) and shreds the leftover;
//   • the whole two-instance scenario, end to end: the vault must survive it.
// (The fourth guard — app.requestSingleInstanceLock in main/index.ts — is Electron-level
// and covered by the release smoke, not unit-testable here.)

const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-vault-208-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return vaultPathsFrom({
    configPath: join(root, 'config'),
    dbPath: join(root, 'workspace', 'hilbertraum.sqlite')
  })
}

/** A stub whose checkpoint/close are irrelevant to the guard under test. */
const closedDbStub = { exec: () => {}, close: () => {} } as unknown as Db

describe('issue #208 — the vault must never be overwritten with authenticated garbage', () => {
  it('end to end: a second instance startup sweep + first instance lock-on-quit must not destroy the vault', () => {
    const vp = freshVault()

    // Instance A: create + unlock the workspace and write session data (stays open, like
    // a user-visible session — WAL sidecars live on disk).
    const a = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    a.init()
    a.create('correct horse battery', 'encrypted')
    updateSettings(a.requireDb(), { contextTokens: 4096 })
    const encBefore = readFileSync(vp.encPath)

    // Instance B: the incident's 0.1.58 first run — same paths, full startup init() while
    // A is live. Its crash-sweep shreds A's working file (on Windows the overwrite lands
    // and the unlink fails, leaving noise under the DB's name; on POSIX the unlink wins
    // and the file is simply gone).
    const b = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    b.init()

    // Instance A quits: lock-on-quit re-encrypts the working file over `.enc`. Pre-fix
    // (Windows) this SUCCEEDED silently and `.enc` became authenticated noise — the
    // destroyed vault of #208. The guard must refuse instead (mapped to VaultLockError
    // by the controller, like any failed lock).
    expect(() => a.lock()).toThrowError(VaultLockError)

    // The at-rest snapshot survived, byte for byte.
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)

    // "Next launch": a fresh controller sweeps the garbage and the ORIGINAL password
    // still opens the workspace — the session delta is lost (it was destroyed in place,
    // nothing can save it), but everything up to the last good lock is intact.
    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState().state).toBe('locked')
    c.unlock('correct horse battery')
    expect(c.getState().state).toBe('unlocked')
    expect(getSettings(c.requireDb()).workspaceMode).toBe('encrypted')
    c.lock()
  })

  it('lockEncryptedVault refuses to encrypt a non-SQLite working file over .enc (guard pin)', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key) // a good lock; `.enc` is the reference snapshot
    const encBefore = readFileSync(vp.encPath)

    // A shred survivor: the working file exists under its real name but is pure noise.
    writeFileSync(vp.dbPath, randomBytes(64 * 1024))
    expect(() => lockEncryptedVault(vp, closedDbStub, key)).toThrowError(/not a SQLite database/)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)

    // A MISSING working file (the POSIX arm of the same incident: the sweep's unlink
    // WINS there) is refused through the same guard — the header probe cannot read it,
    // and un-probe-able is never the safe branch to encrypt over the vault.
    rmSync(vp.dbPath, { force: true })
    expect(() => lockEncryptedVault(vp, closedDbStub, key)).toThrowError(/not a SQLite database/)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
  })

  it('stageRekey refuses a non-SQLite working file (the rekey journal must not stage garbage)', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key)

    writeFileSync(vp.dbPath, randomBytes(4096))
    const dataKey = randomBytes(32)
    expect(() => stageRekey(vp, closedDbStub, key, dataKey)).toThrowError(/not a SQLite database/)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
  })

  it('unlocking a destroyed vault throws VaultDamagedError (not wrong-password) and shreds the leftover', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key)

    // Reproduce the reporter's exact on-disk state: `.enc` = the app's own encryption of
    // random noise under the REAL data key (valid tag, decrypts fine, not a database).
    const noise = `${vp.dbPath}.noise-src`
    writeFileSync(noise, randomBytes(483_328))
    encryptFile(noise, vp.encPath, key)

    // A wrong password is still rejected by the verifier FIRST — the two failures must
    // stay distinguishable (that is the whole point of the typed error).
    expect(() => unlockEncryptedVault(vp, 'not-the-password')).toThrowError(WrongPasswordError)

    // The correct password reaches the decrypt, authenticates, cannot open — and the
    // failure says "damaged", not "wrong password".
    expect(() => unlockEncryptedVault(vp, 'pw')).toThrowError(VaultDamagedError)

    // The decrypted noise must NOT stay on disk (for a merely-corrupt REAL database those
    // bytes would be authentic plaintext user data resting beside a "locked" workspace).
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}.tmp`)).toBe(false)

    // And the damaged `.enc` is left untouched as evidence/recovery material.
    expect(statSync(vp.encPath).size).toBeGreaterThan(483_328)
  })
})
