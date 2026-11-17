import { describe, it, expect } from 'vitest'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
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
    // destroyed vault of #208. The guard must refuse instead; with nothing newer than `.enc`
    // left (noise on Windows, no file on POSIX) the lock then finishes at the last good
    // snapshot (#855). The quit goes through `shutdown()`, the call main/shutdown.ts makes:
    // modelling it with `lock()` hid #853 on POSIX, where the refused lock's re-open created
    // an empty database that shutdown then left at rest and the next unlock rolled forward
    // over `.enc`.
    expect(() => a.shutdown()).not.toThrow()
    expect(a.isUnlocked()).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false)

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

  // #853 / #855 — something outside the app removes the live working file, or overwrites it in
  // place with something that is not a database. Either way nothing newer than `.enc` is left. The
  // lock must never create a database at the path (#853: a retry or the quit then encrypted an
  // empty one over `.enc`), and it FINISHES at the last good snapshot instead of keeping a closed
  // handle that reported `unlocked`, refused every later lock and kept the key until quit (#855).
  it.each([
    [
      'removed',
      (ctrl: WorkspaceController, vp: VaultPaths): void => {
        // POSIX unlinks the open file, and SQLite then leaves its `-wal`/`-shm` behind. Windows
        // refuses the unlink while SQLite holds the file, so the handle is closed first there
        // (which removes the sidecars) and the leftovers POSIX leaves are planted. Both reach the
        // lock-failure recovery with no main file and its orphaned sidecars on disk.
        if (process.platform === 'win32') ctrl.requireDb().close()
        rmSync(vp.dbPath)
        if (process.platform === 'win32') {
          for (const suffix of ['-wal', '-shm']) writeFileSync(`${vp.dbPath}${suffix}`, randomBytes(4096))
        }
      }
    ],
    [
      'overwritten with noise',
      (ctrl: WorkspaceController, vp: VaultPaths): void => {
        // #208's shred survivor, in place (an r+ write passes SQLite's share modes on Windows
        // too). Checkpointed first, so the lock's own checkpoint has no page to write back.
        ctrl.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);')
        const size = statSync(vp.dbPath).size
        const fd = openSync(vp.dbPath, 'r+')
        try {
          writeSync(fd, randomBytes(size), 0, size, 0)
        } finally {
          closeSync(fd)
        }
      }
    ]
  ])('a lock whose working file was %s finishes at the last good snapshot: nothing left at rest, the key dropped, and the same session unlocks again (#853, #855)', (_how, loseWorkingFile) => {
    const vp = freshVaultPaths('vault-208')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    updateSettings(ctrl.requireDb(), { contextTokens: 7171 }) // not the default (4096)
    ctrl.lock() // the good snapshot now holds the marker
    ctrl.unlock('correct horse battery')
    updateSettings(ctrl.requireDb(), { contextTokens: 8282 }) // this session's change, lost below
    const encBefore = readFileSync(vp.encPath)
    const key = ctrl.encryptionKey()!

    loseWorkingFile(ctrl, vp)

    expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    expect(ctrl.isUnlocked()).toBe(false)
    expect(ctrl.encryptionKey()).toBeNull()
    expect(key.equals(Buffer.alloc(key.length))).toBe(true) // the key bytes zeroed, not only dropped
    // Nothing at rest but `.enc`, byte for byte: no database created at the path, no noise, and
    // no orphaned `-wal`/`-shm` (plaintext pages no main file can replay).
    for (const leftover of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) {
      expect(existsSync(leftover)).toBe(false)
    }
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    // "Lock now" again is a plain lock of a locked workspace.
    expect(ctrl.lock()).not.toHaveProperty('lockNotice')

    // The same session, no relaunch: the right password opens the last good snapshot.
    ctrl.unlock('correct horse battery')
    const settings = getSettings(ctrl.requireDb())
    expect(settings.contextTokens).toBe(7171)
    expect(settings.workspaceMode).toBe('encrypted')
    expect(ctrl.lock()).not.toHaveProperty('lockNotice')
  })

  // #855's boundary: only a file that is provably gone or provably not a database is judged lost.
  // One the probe cannot READ (a Windows antivirus hold, a permission error) may still be the only
  // fresh copy of the session, so the refused lock keeps it, and an unlock in this session must not
  // decrypt the stale `.enc` over it. A directory under the file's name stands in for the
  // unreadable file on every OS (opening or reading it fails with something other than ENOENT).
  it('a refused lock never judges an unreadable working file lost: it stays, and so does the refusal to unlock over it (#855)', () => {
    const vp = freshVaultPaths('vault-208')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    const encBefore = readFileSync(vp.encPath)

    ctrl.requireDb().close()
    rmSync(vp.dbPath)
    mkdirSync(vp.dbPath)

    expect(() => ctrl.lock()).toThrowError(VaultLockError)
    expect(statSync(vp.dbPath).isDirectory()).toBe(true)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    // The early return of an unlock on a workspace that is still open: nothing decrypted.
    expect(ctrl.unlock('correct horse battery').state).toBe('unlocked')
    expect(statSync(vp.dbPath).isDirectory()).toBe(true)
  })

  // #855's other boundary: `.enc` must still be there. It sits beside the working file, so a drive or
  // workspace folder that vanished (a USB stick dropping out) reads as missing for both, and the
  // working file may come back newer than `.enc`. Moving the folder away stands in for the dropout.
  it('a refused lock never judges the working file lost while its .enc is missing too: a vanished workspace folder comes back untouched (#855)', () => {
    const vp = freshVaultPaths('vault-208')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    const workspaceDir = dirname(vp.dbPath)
    // Windows cannot move a folder that holds an open file, so the handle is closed first there.
    if (process.platform === 'win32') ctrl.requireDb().close()
    renameSync(workspaceDir, `${workspaceDir}-away`)

    expect(() => ctrl.lock()).toThrowError(VaultLockError)

    // The drive is back: the working file is still there and still a database…
    renameSync(`${workspaceDir}-away`, workspaceDir)
    const workingFile = readFileSync(vp.dbPath)
    expect(workingFile.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
    expect(existsSync(vp.encPath)).toBe(true)
    // …and an unlock in this session does not decrypt the older `.enc` over it.
    expect(ctrl.unlock('correct horse battery').state).toBe('unlocked')
    expect(readFileSync(vp.dbPath).equals(workingFile)).toBe(true)
  })

  // …but a main file that is gone still has its orphaned sidecars shredded there (#853): plaintext
  // pages no main file can replay. (Windows plants them, as in the "removed" row above.)
  it('a refused lock with the working file and its .enc both gone still shreds the orphaned -wal/-shm (#853)', () => {
    const vp = freshVaultPaths('vault-208')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    if (process.platform === 'win32') ctrl.requireDb().close()
    rmSync(vp.dbPath)
    if (process.platform === 'win32') {
      for (const suffix of ['-wal', '-shm']) writeFileSync(`${vp.dbPath}${suffix}`, randomBytes(4096))
    }
    rmSync(vp.encPath)

    expect(() => ctrl.lock()).toThrowError(VaultLockError)
    for (const leftover of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) {
      expect(existsSync(leftover)).toBe(false)
    }
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
  /** What the unlock threw. The rows read its name: the IPC layer matches on it too (the bundle-duplication quirk). */
  function unlockError(vp: VaultPaths): Error | undefined {
    try {
      unlockEncryptedVault(vp, 'pw')
    } catch (err) {
      return err as Error
    }
    return undefined
  }

  it('an open that cannot finish on a healthy database throws VaultOpenFailedError and leaves .enc as it was', () => {
    // The abort text stands in for stored text a failing backfill's error could quote.
    const quote = 'page text the backfill was reading'
    const vp = upgradeBlockedVault(lockedVault('vault-844', 'pw'), 'pw', { abortMessage: quote })
    const enc = readFileSync(vp.encPath)
    const err = unlockError(vp)
    expect(err?.name).toBe('VaultOpenFailedError')
    // Whoever prints this error, its cause and stack included, prints none of that text.
    expect(inspect(err, { depth: 10 })).not.toContain(quote)
    expect(readFileSync(vp.encPath).equals(enc)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('a settings write the unlock makes after the open reads the same way', () => {
    const vp = upgradeBlockedVault(lockedVault('vault-844', 'pw'), 'pw', { at: 'settings' })
    expect(unlockError(vp)?.name).toBe('VaultOpenFailedError')
    expect(existsSync(vp.dbPath)).toBe(false)
  })

  it('a real database whose schema page is corrupt still throws VaultDamagedError', () => {
    const vp = corruptVault(lockedVault('vault-844', 'pw'), 'pw')
    expect(unlockError(vp)?.name).toBe('VaultDamagedError')
  })
})
