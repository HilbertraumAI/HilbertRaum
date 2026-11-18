import { describe, it, expect } from 'vitest'
import {
  chmodSync,
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
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import {
  decryptFile,
  type encryptFile,
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
import { openRawDb } from '../helpers/db-fixtures'
import {
  ENCRYPTION_REQUIRED,
  FAST_KDF,
  corruptVault,
  damagedVault,
  editDescriptor,
  freshVaultPaths,
  lockedVault,
  noisePastPageOne,
  oversizedFirstCell,
  plantProbeTrap,
  thrownBy,
  unlockedController,
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

/** A stub whose checkpoint/close are irrelevant to the guard under test; a query finds no rows (so a guard that lets
 *  the file through reaches the write it exists to stop, instead of failing on the stub). */
const closedDbStub = { exec: () => {}, close: () => {}, prepare: () => ({ all: () => [] }) } as unknown as Db

/** Overwrite the whole file at `path` in place with random bytes (an r+ write, as #208's second instance did). */
function noiseInPlace(path: string): void {
  const size = statSync(path).size
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, randomBytes(size), 0, size, 0)
  } finally {
    closeSync(fd)
  }
}

/** Where the controller records a lock that finished at the last snapshot (#875; `drive-layout.md`). */
const markerPath = (vp: VaultPaths): string => join(dirname(vp.descriptorPath), 'working-copy-lost.json')

/** Commits that allocate pages, so page 1 (its in-header page count) is written to the WAL and not yet back in the
 *  main file: the state an import leaves behind. */
function growInTheWal(db: Db): void {
  const insert = db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
  for (let i = 0; i < 200; i++) insert.run(`w3-876-${i}`, JSON.stringify('x'.repeat(1000)), new Date().toISOString())
}

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
    // #875: and its lock screen says so. The quit had no screen to say it on, so the controller left a marker beside
    // the descriptor, and the next start reads it.
    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    c.unlock('correct horse battery')
    expect(c.getState().state).toBe('unlocked')
    expect(getSettings(c.requireDb()).workspaceMode).toBe('encrypted')
    // The unlock consumed the notice: gone from disk, and the next lock is a plain one.
    expect(existsSync(markerPath(vp))).toBe(false)
    expect(c.lock()).not.toHaveProperty('lockNotice')
    const d = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    d.init()
    expect(d.getState()).not.toHaveProperty('lockNotice')
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
        noiseInPlace(vp.dbPath)
      }
    ],
    [
      // #876: the same overwrite while the session's last commits, page 1 among them, still sit in the WAL. The
      // lock's own checkpoint then writes page 1 back over the noise, so the file starts with a valid SQLite header
      // again (the row below shows it) and only a probe of its structure can tell it is no database.
      'overwritten with noise while page 1 sat in the WAL (#876)',
      (ctrl: WorkspaceController, vp: VaultPaths): void => {
        growInTheWal(ctrl.requireDb())
        noiseInPlace(vp.dbPath)
      }
    ],
    [
      // #208's full sweep shreds the `-wal` and `-shm` in place too. A `-wal` that is noise holds no commits (no WAL
      // header), so it must not stand in the way of the lock that finishes at the last snapshot (#876 round 1: only a
      // `-wal` with a valid header means the checkpoint did not finish). The handle is closed first, so SQLite does not
      // own the planted sidecars.
      'overwritten with noise, its -wal and -shm too (#208 full sweep)',
      (ctrl: WorkspaceController, vp: VaultPaths): void => {
        ctrl.requireDb().close()
        noiseInPlace(vp.dbPath)
        for (const suffix of ['-wal', '-shm']) writeFileSync(`${vp.dbPath}${suffix}`, randomBytes(64 * 1024))
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
    // #875: the notice stands until the next unlock, whatever asks: "Lock now" again, the state the gate fetches.
    expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    expect(ctrl.getState()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })

    // The same session, no relaunch: the right password opens the last good snapshot.
    ctrl.unlock('correct horse battery')
    const settings = getSettings(ctrl.requireDb())
    expect(settings.contextTokens).toBe(7171)
    expect(settings.workspaceMode).toBe('encrypted')
    expect(ctrl.lock()).not.toHaveProperty('lockNotice')
  })

  // #876's precondition, so the row above cannot pass through the old guard: after that overwrite, a checkpoint like
  // the lock's own writes page 1 back from the WAL, and the file starts with the 16-byte SQLite header the guard used
  // to check, although every page past it is noise.
  it('after an in-place overwrite, a checkpoint writes page 1 back: the header reads as SQLite again over noise (#876)', () => {
    const vp = freshVaultPaths('vault-876')
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.create('correct horse battery', 'encrypted')
    const db = ctrl.requireDb()
    growInTheWal(db)
    noiseInPlace(vp.dbPath)
    expect(readFileSync(vp.dbPath).subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\u0000')

    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    expect(readFileSync(vp.dbPath).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\u0000')
    ctrl.lock()
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

  it.each<[string, (vp: VaultPaths, key: Buffer) => void]>([
    ['non-SQLite', (vp) => writeFileSync(vp.dbPath, randomBytes(4096))],
    [
      // #876: the header reads, the pages past it do not.
      'header-bearing but structurally broken',
      (vp, key) => {
        decryptFile(vp.encPath, vp.dbPath, key)
        noisePastPageOne(vp.dbPath)
      }
    ]
  ])('stageRekey refuses a %s working file (the rekey journal must not stage garbage)', (_what, plant) => {
    const vp = lockedVault('vault-208', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    lockEncryptedVault(vp, db, key)

    plant(vp, key)
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

// #876 (review round 1) — the structural probe reads the main file alone (`immutable=1`), so it is right only when the
// lock's checkpoint has copied every commit into it. When that checkpoint cannot finish (a full drive: commits still
// land in the WAL's allocated space, and the copy back fails where the main file has to grow), the close leaves a
// `-wal` that holds commits the main file lacks. The main file alone is then stale, or torn where the checkpoint
// stopped; the session itself is intact. The lock must refuse ("free some space and try again") and keep the session
// open, never judge it lost, and never encrypt the stale main file over `.enc` (which master did, then shredded the
// WAL). The app holds one connection to the workspace database; here a second one holding a read transaction from
// before the session's commits stands in for the full drive: the checkpoint cannot pass it, and the first close is not
// the last, so the `-wal` really survives (no patched handle).
describe('issue #876 — a lock whose checkpoint could not finish keeps the session', () => {
  const PW = 'pw'
  const enospc: typeof encryptFile = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  }

  /** A second connection's read transaction from before the session's commits (released by the returned function):
   *  no checkpoint can copy those commits past it, and the session's close is not the last one. */
  function holdTheWal(dbPath: string): () => void {
    const reader = openRawDb(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) AS n FROM settings').get() // the read transaction starts here
    return () => {
      try {
        reader.exec('COMMIT')
      } finally {
        reader.close()
      }
    }
  }

  /** The session's commits: 200 rows that allocate pages past the old end of the file, and one setting. */
  function writeTheSession(db: Db): void {
    growInTheWal(db)
    updateSettings(db, { contextTokens: 4242 })
  }

  it('a stale but consistent main file beside a -wal that holds the commits: refused, .enc untouched, the session kept', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    ctrl.requireDb().exec('PRAGMA busy_timeout = 0;') // the lock's checkpoint gives up at once instead of after 5 s
    const release = holdTheWal(vp.dbPath)
    writeTheSession(ctrl.requireDb())
    const encBefore = readFileSync(vp.encPath)
    try {
      expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
      expect(ctrl.isUnlocked()).toBe(true)
      expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    } finally {
      release()
    }
    // Once nothing holds the WAL back, the lock goes through, with the session in `.enc`.
    expect(ctrl.lock()).not.toHaveProperty('lockNotice')
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })

  // The v1 rekey stages the working file the same way the lock encrypts it, so it carries the same guard (#876 review
  // round 2): a staged copy of a stale main file would replace `.enc` at the commit.
  it('a password change (v1 vault) whose checkpoint could not finish is refused before anything is staged', () => {
    const vp = lockedVault('vault-876', PW, { legacyV1: true })
    const ctrl = unlockedController(vp, PW)
    ctrl.requireDb().exec('PRAGMA busy_timeout = 0;') // the stage's checkpoint gives up at once instead of after 5 s
    const release = holdTheWal(vp.dbPath)
    writeTheSession(ctrl.requireDb())
    const descriptor = readFileSync(vp.descriptorPath)
    try {
      expect(() => ctrl.changePassword(PW, 'a-new-password', FAST_KDF)).toThrow(/checkpoint did not finish/)
      expect(readFileSync(vp.descriptorPath).equals(descriptor)).toBe(true)
      expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
    } finally {
      release()
    }
    // Once nothing holds the WAL back, the change goes through, with the session.
    ctrl.changePassword(PW, 'a-new-password', FAST_KDF)
    ctrl.lock()
    ctrl.unlock('a-new-password')
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })

  // #876 review round 3 (R2-S2): the branch a real full drive takes through the retry. The retry's checkpoint cannot
  // write the main file, so it FAILS (not busy, not damage); the WAL still holds the session, and the lock must refuse.
  // A read-only main file stands in for the full drive: the close leaves a stale main file and the session's `-wal`.
  // (Not as root on POSIX, which writes through a read-only mode.)
  it.skipIf(process.getuid?.() === 0)('a retry that cannot write the main file (the full-drive branch) still refuses: .enc untouched, the session back once it is writable', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    const db = ctrl.requireDb()
    writeTheSession(db)
    const staleMain = readFileSync(vp.dbPath) // before the lock's checkpoint: the commits are only in the WAL
    const sessionWal = readFileSync(`${vp.dbPath}-wal`)
    const close = db.close.bind(db)
    ;(db as unknown as { close: () => void }).close = () => {
      close()
      writeFileSync(vp.dbPath, staleMain)
      writeFileSync(`${vp.dbPath}-wal`, sessionWal)
      chmodSync(vp.dbPath, 0o444)
    }
    const encBefore = readFileSync(vp.encPath)
    try {
      expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    } finally {
      if (existsSync(vp.dbPath)) chmodSync(vp.dbPath, 0o666) // a lock that went through shredded it
    }
    // Writable again, and the session was never lost.
    expect(ctrl.isUnlocked()).toBe(true)
    if (process.platform === 'win32') {
      // The refused lock's re-open of the read-only file could not finish (best effort, CODE-1a: the closed handle
      // stays and the session reports unlocked), so the next lock fails on that handle and re-opens it (the open
      // replays the WAL); the one after goes through with the session.
      expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
      expect(ctrl.lock()).not.toHaveProperty('lockNotice')
      ctrl.unlock(PW)
      expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
      ctrl.lock()
    } else {
      // On POSIX, SQLite opens a read-only file READ-ONLY instead of failing, so the refused lock's re-open keeps a
      // read-only connection, which can never checkpoint: an artifact of this stand-in (a full drive does not make the
      // file read-only). What holds everywhere: the session is still on disk, in the -wal beside the stale main file.
      const reader = openRawDb(vp.dbPath, { readOnly: true })
      try {
        expect(getSettings(reader as unknown as Db).contextTokens).toBe(4242)
      } finally {
        reader.close()
      }
    }
  })

  // When the WAL refuses the lock before the probe ran, the controller's catch probes the file itself; a structure it
  // cannot read (not damage) is noted there too, once (#876 review round 2).
  it('a refused lock whose probe ran in the catch notes the header fallback there, once', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    plantProbeTrap(ctrl.requireDb())
    ctrl.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA busy_timeout = 0;') // the trap in the main file
    const release = holdTheWal(vp.dbPath)
    writeTheSession(ctrl.requireDb())
    try {
      expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
      expect(ctrl.takeProbeFallbacks()).toEqual([{ site: 'lock', code: expect.stringMatching(/^sqlite 1\b/) }])
    } finally {
      release()
    }
  })

  it('a main file torn where a full drive stopped the checkpoint, beside a -wal that holds the commits: refused, the session kept, nothing discarded', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false, enospc) // the drive is full for the encrypt too
    ctrl.init()
    ctrl.unlock(PW)
    ctrl.requireDb().exec('PRAGMA busy_timeout = 0;') // the lock's checkpoint gives up at once instead of after 5 s
    const release = holdTheWal(vp.dbPath)
    writeTheSession(ctrl.requireDb())
    // What that checkpoint leaves: the latest WAL copy of every page that fits in the old file written back (page 1
    // first, so the header claims pages the file does not have), nothing past the old end.
    const wal = readFileSync(`${vp.dbPath}-wal`)
    const pageSize = wal.readUInt32BE(8)
    const oldPages = statSync(vp.dbPath).size / pageSize
    const latest = new Map<number, Buffer>()
    for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
      latest.set(wal.readUInt32BE(off), wal.subarray(off + 24, off + 24 + pageSize))
    }
    const fd = openSync(vp.dbPath, 'r+')
    try {
      for (const [page, bytes] of latest) if (page <= oldPages) writeSync(fd, bytes, 0, pageSize, (page - 1) * pageSize)
    } finally {
      closeSync(fd)
    }
    expect([...latest.keys()].some((page) => page > oldPages)).toBe(true) // the session grew the file
    const encBefore = readFileSync(vp.encPath)
    try {
      expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
      expect(ctrl.isUnlocked()).toBe(true)
      const db = ctrl.requireDb()
      expect(getSettings(db).contextTokens).toBe(4242)
      expect((db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'w3-876-%'").get() as { n: number }).n).toBe(200)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    } finally {
      release()
    }
  })
})

// #876 review round 2 — a `-wal` that is there after the close but holds nothing the main file lacks (SQLite has
// already copied it in and its delete failed, or its frames belong to no checkpoint of this file) must not refuse the
// lock: one retry lets SQLite's own WAL recovery decide, and only a WAL that still holds commits refuses. And the probe
// may only ADD a refusal or a discard for proven damage: when its SQLite stage cannot run for another reason (here a
// table only the session's own connection can read, `plantProbeTrap`), each site judges the file by its header, as it
// did before the probe existed, and says so for the log.
describe('issue #876 — a -wal that holds nothing, and a structure the probe cannot read', () => {
  const PW = 'pw'
  const enospc: typeof encryptFile = () => {
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  }

  /** The session's own `-wal` (every frame valid), captured while it is live, and the session's close patched to put
   *  it back after the real close: what SQLite leaves when its delete of the WAL fails. `mangle` changes the copy;
   *  `thenAlso` runs between the close and the planting. */
  function walLeftAfterTheClose(ctrl: WorkspaceController, vp: VaultPaths, mangle?: (wal: Buffer) => Buffer, thenAlso?: () => void): void {
    const db = ctrl.requireDb()
    const captured = readFileSync(`${vp.dbPath}-wal`)
    const leftover = mangle ? mangle(captured) : captured
    const close = db.close.bind(db)
    ;(db as unknown as { close: () => void }).close = () => {
      close()
      thenAlso?.()
      writeFileSync(`${vp.dbPath}-wal`, leftover)
    }
  }

  it.each<[string, ((wal: Buffer) => Buffer) | undefined]>([
    ['the session’s own -wal, already copied in (its delete failed)', undefined],
    [
      'a -wal whose header salt is foreign (its frames belong to no checkpoint of this file)',
      (wal) => {
        const foreign = Buffer.from(wal)
        foreign.writeUInt32BE((foreign.readUInt32BE(16) ^ 0xffffffff) >>> 0, 16)
        return foreign
      }
    ]
  ])('a lock after which the close leaves %s finishes at once, the session in .enc', (_what, mangle) => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    growInTheWal(ctrl.requireDb())
    updateSettings(ctrl.requireDb(), { contextTokens: 4242 })
    walLeftAfterTheClose(ctrl, vp, mangle)

    expect(ctrl.lock()).not.toHaveProperty('lockNotice')
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })

  // With page 1 in the `-wal`, the retry's checkpoint can run and copies what the WAL has over the noise; without it,
  // SQLite calls the noise NOTADB, so the WAL cannot be replayed and must not refuse the lock. Either way the probe then
  // finds noise and the lock finishes at the last snapshot.
  it.each<[string, boolean]>([
    ['page 1 in the -wal', true],
    ['no page 1 in the -wal (SQLite calls the main file no database)', false]
  ])('a noise main file beside a valid -wal the close leaves (#208 between the two files), %s, finishes at the last snapshot with the notice', (_what, grow) => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    updateSettings(ctrl.requireDb(), { contextTokens: 7171 })
    ctrl.lock() // the last good snapshot holds 7171
    ctrl.unlock(PW)
    ctrl.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);') // the unlock's own writes out of the WAL
    if (grow) growInTheWal(ctrl.requireDb())
    updateSettings(ctrl.requireDb(), { contextTokens: 8282 })
    const wal = readFileSync(`${vp.dbPath}-wal`)
    const pageSize = wal.readUInt32BE(8)
    const pages: number[] = []
    for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) pages.push(wal.readUInt32BE(off))
    expect(pages.includes(1)).toBe(grow) // the shape this row is about
    walLeftAfterTheClose(ctrl, vp, undefined, () => noiseInPlace(vp.dbPath))
    const encBefore = readFileSync(vp.encPath)

    expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    for (const leftover of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) expect(existsSync(leftover)).toBe(false)
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(7171)
    ctrl.lock()
  })

  // The retry's close (the last connection) usually clears such a `-wal` even when its own checkpoint fails. When another
  // connection keeps the WAL open (here a reader's transaction), it stays, and SQLite's NOTADB is what says the WAL
  // cannot be replayed into this file: it must not refuse the lock, which would leave a closed handle the re-open cannot
  // replace (the state #855 fixed).
  it('a noise main file beside a -wal another connection holds, SQLite calling the file no database: the lock finishes at the last snapshot', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    updateSettings(ctrl.requireDb(), { contextTokens: 7171 })
    ctrl.lock() // the last good snapshot holds 7171
    ctrl.unlock(PW)
    const db = ctrl.requireDb()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);') // the unlock's own writes out of the WAL
    db.exec('PRAGMA busy_timeout = 0;')
    const reader = openRawDb(vp.dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) AS n FROM settings').get()
    updateSettings(db, { contextTokens: 8282 })
    const wal = readFileSync(`${vp.dbPath}-wal`)
    const pageSize = wal.readUInt32BE(8)
    const pages: number[] = []
    for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) pages.push(wal.readUInt32BE(off))
    expect(pages.includes(1)).toBe(false) // the shape this row is about
    noiseInPlace(vp.dbPath)
    const encBefore = readFileSync(vp.encPath)
    try {
      expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    } finally {
      try {
        reader.exec('COMMIT')
      } catch {
        /* its files were shredded under it */
      }
      reader.close()
    }
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(7171)
    ctrl.lock()
  })

  // #876 review round 3 (R2-S1): two shapes of noise that SQLite reports with a code other than CORRUPT/NOTADB. The
  // round-2 header fallback encrypted both over `.enc`; they are damage, so the lock finishes at the last snapshot.
  it.each<[string, (path: string, collectionsRoot: number) => void]>([
    ['the schema-format byte (offset 47) is noise, the rest of the header intact', (path) => {
      const fd = openSync(path, 'r+')
      try {
        writeSync(fd, Buffer.from([9]), 0, 1, 47)
      } finally {
        closeSync(fd)
      }
    }],
    ['a cell claims a value longer than SQLite allows (SQLITE_TOOBIG)', (path, collectionsRoot) => oversizedFirstCell(path, collectionsRoot)]
  ])('a working file in which %s finishes at the last snapshot with the notice, .enc untouched', (_what, spoil) => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    updateSettings(ctrl.requireDb(), { contextTokens: 7171 })
    ctrl.lock() // the last good snapshot holds 7171
    ctrl.unlock(PW)
    const db = ctrl.requireDb()
    const collectionsRoot = (db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'collections'").get() as { rootpage: number })
      .rootpage
    updateSettings(db, { contextTokens: 8282 })
    const close = db.close.bind(db)
    ;(db as unknown as { close: () => void }).close = () => {
      close()
      spoil(vp.dbPath, collectionsRoot)
    }
    const encBefore = readFileSync(vp.encPath)

    expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(7171)
    ctrl.lock()
  })

  it('a lock whose probe cannot read the structure for a reason that is not damage judges by the header, as before: it locks, the session in .enc', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = unlockedController(vp, PW)
    plantProbeTrap(ctrl.requireDb())
    updateSettings(ctrl.requireDb(), { contextTokens: 4242 })

    expect(ctrl.lock()).not.toHaveProperty('lockNotice')
    expect(ctrl.takeProbeFallbacks()).toEqual([{ site: 'lock', code: expect.stringMatching(/^sqlite 1\b/) }])
    ctrl.unlock(PW)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })

  // The encrypt failing after that judgement (a full drive) re-opens the session as before, from the one probe the
  // lock made: the controller reads the verdict the lock carried instead of probing again (one note, not two).
  it('…and when the encrypt then fails, the session is re-opened from the one probe the lock made', () => {
    const vp = lockedVault('vault-876', PW)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false, enospc)
    ctrl.init()
    ctrl.unlock(PW)
    plantProbeTrap(ctrl.requireDb())
    updateSettings(ctrl.requireDb(), { contextTokens: 4242 })

    expect(thrownBy(() => ctrl.lock()).name).toBe('VaultLockError')
    expect(ctrl.isUnlocked()).toBe(true)
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    expect(ctrl.takeProbeFallbacks()).toEqual([{ site: 'lock', code: expect.stringMatching(/^sqlite 1\b/) }])
  })

  it('a password change (v1 vault) whose probe cannot read the structure stages it by the header, as before', () => {
    const vp = lockedVault('vault-876', PW, { legacyV1: true })
    const ctrl = unlockedController(vp, PW)
    plantProbeTrap(ctrl.requireDb())
    updateSettings(ctrl.requireDb(), { contextTokens: 4242 })

    ctrl.changePassword(PW, 'a-new-password', FAST_KDF)
    expect(ctrl.takeProbeFallbacks()).toEqual([{ site: 'rekey', code: expect.stringMatching(/^sqlite 1\b/) }])
    ctrl.lock()
    ctrl.unlock('a-new-password')
    expect(getSettings(ctrl.requireDb()).contextTokens).toBe(4242)
    ctrl.lock()
  })
})

// Issue #875 — a lock that finished at the last snapshot (#855) at QUIT had no lock screen to say so, and nothing
// survived the process: the next start showed a plain lock screen and the user unlocked into older data with no
// explanation. The controller now leaves `config/working-copy-lost.json`, bound to the IV of the `.enc` it fell back
// to, reads it at startup and reports the notice while the workspace is locked, and the next unlock consumes it. The
// rows below are about the marker's lifetime when other builds share the drive (a Kit carries several OSes' apps).
describe('issue #875 — the notice of a lock that finished at the last snapshot survives a restart', () => {
  const PW = 'pw'

  /** A session whose working file is overwritten in place, then the app quits: the #855 lock at quit. */
  function loseWorkingCopyAtQuit(vp: VaultPaths): void {
    const a = unlockedController(vp, PW)
    updateSettings(a.requireDb(), { contextTokens: 8282 })
    a.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);')
    noiseInPlace(vp.dbPath)
    a.shutdown()
    expect(existsSync(markerPath(vp))).toBe(true)
  }

  it('a marker an older build left behind after it locked again (another snapshot now) is stale: no notice, and removed', () => {
    const vp = lockedVault('vault-875', PW)
    loseWorkingCopyAtQuit(vp)
    const leftByThisLoss = readFileSync(markerPath(vp))
    // An older build knows no marker: it unlocks and locks (a new `.enc`) and leaves the file where it was.
    const b = unlockedController(vp, PW)
    b.lock()
    writeFileSync(markerPath(vp), leftByThisLoss)

    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState().state).toBe('locked')
    expect(c.getState()).not.toHaveProperty('lockNotice')
    expect(existsSync(markerPath(vp))).toBe(false)
  })

  it('a marker of a format a newer build wrote is neither shown nor removed, even when it names the current snapshot', () => {
    const vp = lockedVault('vault-875', PW)
    loseWorkingCopyAtQuit(vp)
    const marker = JSON.parse(readFileSync(markerPath(vp), 'utf8')) as Record<string, unknown>
    writeFileSync(markerPath(vp), JSON.stringify({ ...marker, v: 2 }))
    const newer = readFileSync(markerPath(vp))

    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState()).not.toHaveProperty('lockNotice')
    c.unlock(PW)
    c.lock()
    expect(readFileSync(markerPath(vp)).equals(newer)).toBe(true)
  })

  // #845: a vault format a newer build wrote leaves the whole workspace as it is: startup reads nothing past the
  // verdict, so the marker is neither read nor removed, and the lock screen shows the version problem, not a loss.
  it('under a newer vault format the marker is neither read nor removed; once that format is gone, the next unlock consumes it', () => {
    const vp = lockedVault('vault-875', PW)
    loseWorkingCopyAtQuit(vp)
    const marker = readFileSync(markerPath(vp))
    const descriptor = readFileSync(vp.descriptorPath)
    editDescriptor(vp, (d) => {
      d.version = 3
    })

    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState()).not.toHaveProperty('lockNotice')
    expect(thrownBy(() => c.unlock(PW)).name).toBe('VaultNewerError')
    expect(readFileSync(markerPath(vp)).equals(marker)).toBe(true)

    writeFileSync(vp.descriptorPath, descriptor) // the newer copy rolled back
    expect(c.unlock(PW).state).toBe('unlocked')
    expect(existsSync(markerPath(vp))).toBe(false)
  })

  // The marker is best-effort: a write that fails (here its name is taken by a folder, so the rename cannot land) must
  // not fail the lock, must still show the notice in this run, and must leave no half-written temp file in `config/`.
  it('a marker that cannot be written leaves no temp file behind, and the lock still finishes with the notice', () => {
    const vp = lockedVault('vault-875', PW)
    mkdirSync(join(markerPath(vp), 'blocker'), { recursive: true })
    const ctrl = unlockedController(vp, PW)
    ctrl.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);')
    noiseInPlace(vp.dbPath)

    expect(ctrl.lock()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
    expect(existsSync(`${markerPath(vp)}.tmp`)).toBe(false)
    expect(statSync(markerPath(vp)).isDirectory()).toBe(true)
  })

  // A workspace wiped by hand (its `.enc` and descriptor deleted, say to reset a Kit) leaves `config/` with the marker
  // of a vault that is gone. With no vault, startup never reads it; the workspace created there removes it, so it does
  // not outlive the vault it was about (and a reset drive does not carry the old loss's time).
  it('a workspace created where a wiped one left its marker removes the marker', () => {
    const vp = lockedVault('vault-875', PW)
    loseWorkingCopyAtQuit(vp)
    rmSync(vp.encPath)
    rmSync(vp.descriptorPath)
    const c = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    c.init()
    expect(c.getState().state).toBe('uninitialized')
    expect(existsSync(markerPath(vp))).toBe(true)
    c.create('correct horse battery', 'encrypted')
    expect(existsSync(markerPath(vp))).toBe(false)
    c.lock()
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
