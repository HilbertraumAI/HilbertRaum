import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  unlockEncryptedVault,
  lockEncryptedVault,
  stageRekey,
  VaultDamagedError,
  VaultLockError,
  WorkspaceController,
  WrongPasswordError,
  REKEY_SUFFIX,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { Db } from '../../src/main/services/db'
import {
  ENCRYPTION_REQUIRED,
  corruptVault,
  damagedVault,
  freshVaultPaths,
  lockedVault,
  upgradeBlockedVault
} from '../helpers/vault-fixtures'

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

/** A stub whose checkpoint/close are irrelevant to the guard under test. */
const closedDbStub = { exec: () => {}, close: () => {} } as unknown as Db

describe('issue #208 — the vault must never be overwritten with authenticated garbage', () => {
  it('end to end: a second instance startup sweep + first instance lock-on-quit must not destroy the vault', () => {
    const vp = freshVaultPaths('vault-208')

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
    // by the controller, like any failed lock). The quit goes through `shutdown()`, the
    // call main/shutdown.ts makes: modelling it with `lock()` hid #853 on POSIX, where the
    // refused lock's re-open created an empty database that shutdown then left at rest
    // and the next unlock rolled forward over `.enc`.
    expect(() => a.shutdown()).toThrowError(VaultLockError)

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

  it('a lock refused because the working file vanished never creates a database there: a retry and the quit keep the last good snapshot (#853)', () => {
    const vp = freshVaultPaths('vault-208')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    updateSettings(ctrl.requireDb(), { contextTokens: 7171 }) // not the default (4096)
    ctrl.lock() // the good snapshot now holds the marker
    ctrl.unlock('correct horse battery')
    const encBefore = readFileSync(vp.encPath)

    // Something outside the app removes the live working file. POSIX unlinks the open file;
    // Windows refuses that while SQLite holds it, so the handle is closed first there. Both
    // reach the controller's lock-failure recovery with no working file on disk.
    if (process.platform === 'win32') ctrl.requireDb().close()
    rmSync(vp.dbPath)

    expect(() => ctrl.lock()).toThrowError(VaultLockError)
    // The recovery must not re-open (and so create) a database at the vanished path, and
    // the orphaned WAL sidecars (plaintext pages) must not stay on the drive.
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(() => ctrl.lock()).toThrowError(VaultLockError) // "Lock now" again
    expect(() => ctrl.shutdown()).toThrowError(VaultLockError) // the quit
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)

    // Next launch: the right password opens the last good snapshot, marker included.
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    next.unlock('correct horse battery')
    const settings = getSettings(next.requireDb())
    expect(settings.contextTokens).toBe(7171)
    expect(settings.workspaceMode).toBe('encrypted')
    next.lock()
  })

  it('lockEncryptedVault refuses to encrypt a non-SQLite working file over .enc (guard pin)', () => {
    const vp = lockedVault('vault-208', 'pw')
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
    const vp = lockedVault('vault-208', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key)

    writeFileSync(vp.dbPath, randomBytes(4096))
    const dataKey = randomBytes(32)
    expect(() => stageRekey(vp, closedDbStub, key, dataKey)).toThrowError(/not a SQLite database/)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
  })

  it('unlocking a destroyed vault throws VaultDamagedError (not wrong-password) and shreds the leftover', () => {
    // Reproduce the reporter's exact on-disk state: `.enc` = the app's own encryption of
    // 483,328 bytes of random noise under the REAL data key (valid tag, decrypts fine, not a
    // database).
    const vp = damagedVault(lockedVault('vault-208', 'pw'), 'pw', 483_328)
    const damagedEnc = readFileSync(vp.encPath)

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

    // And the damaged `.enc` is left untouched, byte for byte, as evidence/recovery material.
    expect(readFileSync(vp.encPath).equals(damagedEnc)).toBe(true)
  })
})

// Issue #844 — an unlock whose open fails is damage only when SQLite says so. A healthy database
// whose open cannot finish (here a backfill write that a trigger aborts; a full drive or a bug in a
// new upgrade step looks the same from here) read as "damaged … restore from a backup", though
// `.enc` is never touched on that path.
describe('issue #844 — only SQLite’s own verdict reads as a damaged vault', () => {
  /** The name of what the unlock threw: the IPC layer matches on it too (the bundle-duplication quirk). */
  function unlockFailure(vp: VaultPaths): string {
    try {
      unlockEncryptedVault(vp, 'pw')
    } catch (err) {
      return (err as Error).name
    }
    return 'nothing thrown'
  }

  it('an open that cannot finish on a healthy database throws VaultOpenFailedError and leaves .enc as it was', () => {
    const vp = upgradeBlockedVault(lockedVault('vault-844', 'pw'), 'pw')
    const enc = readFileSync(vp.encPath)
    expect(unlockFailure(vp)).toBe('VaultOpenFailedError')
    expect(readFileSync(vp.encPath).equals(enc)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('a real database whose schema page is corrupt still throws VaultDamagedError', () => {
    const vp = corruptVault(lockedVault('vault-844', 'pw'), 'pw')
    expect(unlockFailure(vp)).toBe('VaultDamagedError')
  })
})
