import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import {
  unlockEncryptedVault,
  lockEncryptedVault,
  WorkspaceController,
  RECOVERY_SUFFIX,
  VaultLockError,
  VaultRecoveryBlockedError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { IPC } from '../../src/shared/ipc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import {
  ENCRYPTION_REQUIRED,
  backdate,
  endedUnlocked,
  failedLockState,
  lockedVault,
  unlockedController,
  workspaceIpcCtx
} from '../helpers/vault-fixtures'

// full-audit 2026-07-12 REL-1 / REL-2 — forced-failure guards on the `.recovery` salvage path,
// plus the held-recovery-file and full-drive cases of #242.
// The findings are Windows-hold edges (AV/search indexer holding a spent `.recovery` without
// FILE_SHARE_DELETE / FILE_SHARE_READ) and a full drive at the exact lock write — neither is
// reproducible portably with a real hold or a real full disk, so this file uses the
// workspace-vault-durability.test.ts idiom: `vi.mock('node:fs')` with pass-through wrappers
// that fail ONLY the targeted operation — everything else hits the real filesystem. Kept
// separate so the module mock cannot leak into the behavioral vault suites. Every armed
// wrapper counts its refusals, so a test can PROVE its injection was reached instead of
// inferring it (a successful pre-shred used to make the rename target vanish, after which the
// rename wrapper saw nothing and the case silently proved nothing — #242).
//
// REL-1: `preserveNewerPlaintext`'s rename onto a pre-existing (held) `.recovery` used to
// throw into the swallowing catch, after which `shredStalePlaintext` destroyed the working
// file — the ONLY fresh copy of the session's data. The first fix pre-shreds the spent
// leftover; #242 covers the hold the pre-shred cannot beat (the salvage now refuses to sweep).
// REL-2: unlock's roll-forward freshness probe (`fileHasSqliteHeader` + `statSync`) was not
// exception-guarded — an EBUSY on the held file failed the whole unlock raw. The fix treats a
// probe error as "can't decide": leave `.recovery` in place, unlock normally, retry next time.
//
// What these injections do NOT prove: that a real AV/indexer hold produces exactly this fault
// set (which of open / unlink / rename a given hold refuses is the holder's share mode).

const failures = vi.hoisted(() => ({
  /** renameSync throws EPERM iff the TARGET ends with `.recovery` and already exists (the
   *  held-target semantics; a successful pre-shred makes the target vanish → real rename). */
  renameThrowOnExistingRecoveryTarget: false,
  /** openSync throws EBUSY for any `.recovery` path (an AV hold without FILE_SHARE_READ):
   *  `fileHasSqliteHeader`'s probe throws, and so does `shredFile`'s overwrite open. */
  openThrowOnRecoveryPath: false,
  /** rmSync throws EPERM for any `.recovery` path (a hold without FILE_SHARE_DELETE). `shredFile`
   *  swallows a failed overwrite AND a failed unlink, so this is the wrapper that actually keeps
   *  a spent leftover sitting on the rename target (#242). */
  rmThrowOnRecoveryPath: false,
  /** writeSync throws ENOSPC on every descriptor opened for an `.enc.tmp` while armed — a full
   *  drive at the exact lock write, inside the real `encryptFile` (#242). */
  enospcOnEncTmpWrite: false,
  /** Descriptors opened on an `.enc.tmp` while `enospcOnEncTmpWrite` was armed. */
  encTmpFds: new Set<number>(),
  /** openSync throws EBUSY ONCE for the next `-wal` path while armed (an antivirus hold on the WAL at the lock's first
   *  look, gone by its retry; #876 review round 2), then disarms itself. */
  openThrowOnWalPathOnce: false,
  /** statSync throws EIO for the working file itself (`…/hilbertraum.sqlite`, not its sidecars or temps) while armed:
   *  a failing drive under the #892 check at startup. */
  statThrowOnWorkingFile: false,
  /** #911: `.enc` reads as a delete-pending file on Windows (deleted by another program while a handle stays open):
   *  `statSync` throws EPERM for it and `existsSync`, which swallows the error, answers false. */
  encDeletePending: false,
  /** #911 review SF-3: openSync throws EBUSY for the working file itself (`…/hilbertraum.sqlite`, not its sidecars or
   *  temps) while armed: an antivirus hold the probe's header read hits. SQLite's own replay does not go through it. */
  openThrowOnWorkingFile: false,
  /** How often each armed wrapper actually refused — an injection that was never reached
   *  proves nothing, so the tests assert these. */
  hits: { renameSync: 0, openSync: 0, rmSync: 0, writeSync: 0, openSyncWal: 0, statSync: 0, encStat: 0, openSyncWorking: 0 }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const errnoError = (code: string, msg: string): NodeJS.ErrnoException => {
    const err = new Error(msg) as NodeJS.ErrnoException
    err.code = code
    return err
  }
  const isRecovery = (p: unknown): boolean => String(p).endsWith('.recovery')
  const isEnc = (p: unknown): boolean => String(p).endsWith('.sqlite.enc')
  const mocked = {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
      if (failures.encDeletePending && isEnc(path)) {
        failures.hits.encStat += 1
        return false
      }
      return actual.existsSync(path)
    }),
    renameSync: vi.fn((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (failures.renameThrowOnExistingRecoveryTarget && isRecovery(to) && actual.existsSync(to)) {
        failures.hits.renameSync += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, rename (held .recovery target)')
      }
      return actual.renameSync(from, to)
    }),
    openSync: vi.fn((path: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      if (failures.openThrowOnRecoveryPath && isRecovery(path)) {
        failures.hits.openSync += 1
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, open (held .recovery)')
      }
      if (failures.openThrowOnWalPathOnce && String(path).endsWith('-wal')) {
        failures.openThrowOnWalPathOnce = false
        failures.hits.openSyncWal += 1
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, open (held -wal)')
      }
      if (failures.openThrowOnWorkingFile && String(path).endsWith('hilbertraum.sqlite')) {
        failures.hits.openSyncWorking += 1
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked, open (held working file)')
      }
      const fd = actual.openSync(path, flags, mode)
      if (failures.enospcOnEncTmpWrite && String(path).endsWith('.enc.tmp')) failures.encTmpFds.add(fd)
      return fd
    }),
    rmSync: vi.fn((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (failures.rmThrowOnRecoveryPath && isRecovery(path)) {
        failures.hits.rmSync += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, unlink (held .recovery)')
      }
      return actual.rmSync(path, options)
    }),
    writeSync: vi.fn((fd: number, ...rest: unknown[]) => {
      if (failures.encTmpFds.has(fd)) {
        failures.hits.writeSync += 1
        throw errnoError('ENOSPC', 'ENOSPC: no space left on device, write')
      }
      return (actual.writeSync as unknown as (...args: unknown[]) => number)(fd, ...rest)
    }),
    closeSync: vi.fn((fd: number) => {
      failures.encTmpFds.delete(fd)
      return actual.closeSync(fd)
    }),
    statSync: vi.fn((...args: unknown[]) => {
      if (failures.statThrowOnWorkingFile && String(args[0]).endsWith('hilbertraum.sqlite')) {
        failures.hits.statSync += 1
        throw errnoError('EIO', 'EIO: i/o error, stat (the working file)')
      }
      if (failures.encDeletePending && isEnc(args[0])) {
        failures.hits.encStat += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, stat (a delete-pending .enc)')
      }
      return (actual.statSync as unknown as (...a: unknown[]) => unknown)(...args)
    })
  }
  return { ...mocked, default: mocked }
})

// The unlock IPC over a genuinely blocked controller: only `ipcMain.handle` is needed.
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))
const handlers = ipcState.handlers as unknown as IpcHandlers

/** A hold that refuses the overwrite, the unlink AND the rename onto the `.recovery` — the
 *  conjunction the pre-shred alone cannot beat (#242). */
function holdRecovery(on: boolean): void {
  failures.openThrowOnRecoveryPath = on
  failures.rmThrowOnRecoveryPath = on
  failures.renameThrowOnExistingRecoveryTarget = on
}

beforeEach(() => {
  holdRecovery(false)
  failures.enospcOnEncTmpWrite = false
  failures.encTmpFds.clear()
  failures.openThrowOnWalPathOnce = false
  failures.statThrowOnWorkingFile = false
  failures.encDeletePending = false
  failures.openThrowOnWorkingFile = false
  failures.hits = { renameSync: 0, openSync: 0, rmSync: 0, writeSync: 0, openSyncWal: 0, statSync: 0, encStat: 0, openSyncWorking: 0 }
  ipcState.handlers.clear()
})

// The vault fixtures (tests/helpers/vault-fixtures.ts) go through this file's mocked `node:fs`
// too: every wrapper is pass-through until armed, so each row builds its vault state before
// arming a failure.

/** The spent leftover of an earlier salvage whose best-effort unlink failed (Windows hold),
 *  still sitting on the rename target at the next launch. Backdated like `.enc`. */
const LEFTOVER = 'spent leftover that outlived its unlink'
function plantLeftover(vp: VaultPaths): string {
  const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
  writeFileSync(recoveryPath, LEFTOVER)
  backdate(recoveryPath)
  return recoveryPath
}

describe('`.recovery` guards (full-audit 2026-07-12 REL-1/REL-2)', () => {
  it('REL-1: a spent .recovery blocking the rename no longer costs the only fresh copy', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp) // the working file (7171) is the only fresh copy
    const recoveryPath = plantLeftover(vp)

    // A hold WITHOUT delete sharing but WITH write sharing: the pre-shred's random overwrite
    // goes through, its unlink fails, and the rename onto the still-present target fails —
    // the conjunction the pre-shred alone cannot beat. (This case used to arm only the rename
    // failure: the real pre-shred removed the leftover first, the rename target was gone, and
    // the injection was never reached — the case proved nothing about the conjunction. #242)
    failures.rmThrowOnRecoveryPath = true
    failures.renameThrowOnExistingRecoveryTarget = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      // Both injections were reached.
      expect(failures.hits.rmSync).toBeGreaterThan(0)
      expect(failures.hits.renameSync).toBeGreaterThan(0)

      // Before #242: the rename threw into the swallowing catch and `shredStalePlaintext`
      // destroyed the fresh working file — 7171 unrecoverable. Now: the salvage reports
      // failure, the sweep is skipped, the working file stays in place, and the overwritten
      // leftover (shred garbage, never unlinked) is neither rolled forward nor mistaken for
      // the fresh copy.
      expect(existsSync(vp.dbPath)).toBe(true)
      expect(existsSync(recoveryPath)).toBe(true)
      expect(readFileSync(recoveryPath).includes(Buffer.from('spent leftover'))).toBe(false)
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)

      // Hold cleared → the retry's pre-shred removes the garbage, the rename lands, and the
      // roll-forward consumes the salvage: nothing since the failed lock was lost.
      failures.rmThrowOnRecoveryPath = false
      failures.renameThrowOnExistingRecoveryTarget = false
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
      expect(existsSync(recoveryPath)).toBe(false)
      ctl.lock()
    } finally {
      failures.rmThrowOnRecoveryPath = false
      failures.renameThrowOnExistingRecoveryTarget = false
    }
  })

  it('REL-2: a probe error on a SPENT (older) .recovery no longer fails the unlock; the snapshot is preserved for retry', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key) // `.enc` holds 6161 (mtime ~now)

    // A SPENT `.recovery` leftover, OLDER than `.enc` (a consumed roll-forward whose unlink
    // failed); the AV hold means the probe cannot even OPEN it. `.enc` is demonstrably newer,
    // so unlocking into it loses nothing — the leftover is left for a later probe to shred.
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    writeFileSync(recoveryPath, 'held leftover the probe cannot read')
    backdate(recoveryPath)

    failures.openThrowOnRecoveryPath = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      // Pre-fix: fileHasSqliteHeader's openSync threw EBUSY raw out of unlockEncryptedVault
      // → generic openFailed; the user could not unlock until the hold cleared. Now: `.enc`
      // is strictly newer, so the probe error is safe to ignore and the unlock proceeds.
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

  it('a hold on a FRESH .recovery at unlock refuses instead of opening the stale snapshot and later shredding the fresh copy (#242)', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp, 4242) // working file (4242) newer than the stale `.enc` (the seeded default)

    // No hold at init → the working file is preserved as `.recovery` (newer than `.enc`).
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    expect(existsSync(recoveryPath)).toBe(true)
    expect(existsSync(vp.dbPath)).toBe(false)
    const recoveryBytes = readFileSync(recoveryPath)
    const encBefore = readFileSync(vp.encPath)

    // Now a hold denies the header read at unlock. Before #242 the unlock proceeded into the
    // stale `.enc`, and the user's next lock made `.enc` newer, so the following unlock
    // shredded this never-rolled-forward fresh copy — 4242 silently lost. Now the unlock is
    // REFUSED (the snapshot could be fresh and cannot be judged) and the copy stays intact.
    failures.openThrowOnRecoveryPath = true
    try {
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)
      expect(readFileSync(recoveryPath).equals(recoveryBytes)).toBe(true)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
      expect(ctl.isUnlocked()).toBe(false)
    } finally {
      failures.openThrowOnRecoveryPath = false
    }

    // Hold cleared → the probe reads the header, sees a fresh newer snapshot, rolls it
    // forward, and the unlock yields 4242. Nothing lost.
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(4242)
    expect(existsSync(recoveryPath)).toBe(false)
    ctl.lock()
  })
})

describe('a held .recovery: the startup salvage refuses to sweep instead of losing the fresh copy (#242)', () => {
  it('a hold defeating the pre-shred AND the rename leaves the working file in place and blocks the unlock until it clears', async () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp, 7171) // the working file (7171) is the only fresh copy
    const recoveryPath = plantLeftover(vp)
    const leftoverSize = statSync(recoveryPath).size
    const workingBytes = readFileSync(vp.dbPath)
    const encBefore = readFileSync(vp.encPath) // the stale snapshot (the seeded default)
    expect(existsSync(vp.dbPath)).toBe(true)

    holdRecovery(true)
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      // All three injections were reached: the overwrite open, the unlink, the rename.
      expect(failures.hits.openSync).toBeGreaterThan(0)
      expect(failures.hits.rmSync).toBeGreaterThan(0)
      expect(failures.hits.renameSync).toBeGreaterThan(0)

      // Before #242 the working file was gone here (shredded by the sweep) and the unlock
      // below opened the stale snapshot — everything since the failed lock silently lost.
      expect(existsSync(vp.dbPath)).toBe(true)
      expect(readFileSync(vp.dbPath).equals(workingBytes)).toBe(true)
      // The held leftover is untouched (the overwrite was refused too), and so is `.enc`.
      expect(readFileSync(recoveryPath, 'utf8')).toBe(LEFTOVER)
      expect(statSync(recoveryPath).size).toBe(leftoverSize)
      expect(existsSync(vp.encPath)).toBe(true)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
      // The controller reports the blocked state and stays locked.
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(ctl.getState().state).toBe('locked')

      // A subsequent unlock is REFUSED — the typed error at the controller, its own reason
      // and copy at the IPC — rather than decrypting the stale `.enc` over the fresh file.
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)
      registerWorkspaceIpc(workspaceIpcCtx(ctl))
      const { result } = await invoke(handlers, IPC.unlockWorkspace, 'pw')
      expect(result).toMatchObject({ ok: false, reason: 'vault_recovery_blocked' })
      expect((result as { message: string }).message).toMatch(/recovery file/i)
      expect(ctl.isUnlocked()).toBe(false)
      expect(readFileSync(vp.dbPath).equals(workingBytes)).toBe(true)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)

      // Hold released → the retry (an unlock re-runs the startup salvage) preserves the
      // working file and the roll-forward yields the fresh data.
      holdRecovery(false)
      ctl.unlock('pw')
      expect(ctl.isRecoveryBlocked()).toBe(false)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
      expect(existsSync(recoveryPath)).toBe(false)
      ctl.lock()
      // Durable: a later plain unlock still has the salvaged data.
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
      ctl.lock()
    } finally {
      holdRecovery(false)
    }
  })

  it('control: without the hold the salvage preserves the working file and the roll-forward yields the fresh data', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp, 7171)
    const recoveryPath = plantLeftover(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(failures.hits).toEqual({
      renameSync: 0,
      openSync: 0,
      rmSync: 0,
      writeSync: 0,
      openSyncWal: 0,
      statSync: 0,
      encStat: 0,
      openSyncWorking: 0
    })
    // The spent leftover was pre-shredded and the working file moved onto its name.
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(recoveryPath)).toBe(true)
    expect(readFileSync(recoveryPath).includes(Buffer.from('spent leftover'))).toBe(false)
    expect(ctl.isRecoveryBlocked()).toBe(false)

    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(existsSync(recoveryPath)).toBe(false)
    ctl.lock()
  })

  it('a full drive at the lock write: the failed lock is reported, the stale snapshot and the plaintext working file survive, and the next launch salvages it', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('pw')
    updateSettings(ctl.requireDb(), { contextTokens: 8181 })
    const encBefore = readFileSync(vp.encPath)

    // ENOSPC inside the REAL encryptFile, at its first write to `.enc.tmp` (the controller's
    // encryptFileImpl seam is not used: the point is the write itself failing).
    failures.enospcOnEncTmpWrite = true
    try {
      expect(() => ctl.lock()).toThrow(VaultLockError)
      expect(failures.hits.writeSync).toBeGreaterThan(0)
      // The stale snapshot is intact, the partial temp is gone, nothing was shredded …
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
      expect(existsSync(`${vp.encPath}.tmp`)).toBe(false)
      expect(existsSync(vp.dbPath)).toBe(true)
      // … and the controller is consistently unlocked and usable with the session's data.
      expect(ctl.getState().state).toBe('unlocked')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(8181)

      // Quit while the drive is still full: the failed lock rethrows out of shutdown() and
      // the working file rests cleanly closed (no -wal/-shm), newer than `.enc`.
      expect(() => ctl.shutdown()).toThrow(VaultLockError)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
      expect(existsSync(vp.dbPath)).toBe(true)
      expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
      expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    } finally {
      failures.enospcOnEncTmpWrite = false
      failures.encTmpFds.clear()
    }

    // Next launch (space freed): the salvage preserves the working file and the unlock rolls
    // it forward — nothing since the failed lock is lost. (`.enc` backdated for a
    // deterministic mtime order on coarse-timestamp filesystems, as in failedLockState.)
    backdate(vp.encPath)
    const ctl2 = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl2.init()
    expect(ctl2.isRecoveryBlocked()).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(true)
    ctl2.unlock('pw')
    expect(getSettings(ctl2.requireDb()).contextTokens).toBe(8181)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
    ctl2.lock()
  })
})

describe('a full drive at the lock write, in the same session (full-audit 2026-07-11 CODE-1a)', () => {
  // The interactive half of the full-drive row above: after the refused lock the session is
  // not only readable but WRITABLE (the re-opened working file), and once space is freed a
  // retry in the same session locks under the key the failure kept: nothing is lost.
  it('CODE-1a: after a full-drive lock failure the session keeps writing, and a retry once space is freed locks with the kept key and loses nothing', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    const ctl = unlockedController(vp, 'pw')
    updateSettings(ctl.requireDb(), { contextTokens: 5150 })
    const encBefore = readFileSync(vp.encPath)

    failures.enospcOnEncTmpWrite = true
    try {
      expect(() => ctl.lock()).toThrow(VaultLockError)
      expect(failures.hits.writeSync).toBeGreaterThan(0)
    } finally {
      failures.enospcOnEncTmpWrite = false
      failures.encTmpFds.clear()
    }
    expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
    // The controller is consistently UNLOCKED and usable: reads AND writes.
    expect(ctl.getState().state).toBe('unlocked')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5150)
    updateSettings(ctl.requireDb(), { contextTokens: 5151 }) // the session writes on

    // Space freed: the retry locks cleanly in the same session …
    expect(ctl.lock().state).toBe('locked')
    expect(existsSync(vp.dbPath)).toBe(false)
    // … and the next unlock reads the write made after the failure.
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    ctl.lock()
  })
})

// #876 review round 2 — the lock refuses while the `-wal` still holds commits, and a `-wal` with frames that its check
// cannot open (an antivirus hold) counts as holding them (refusing is the safe answer there). So the lock retries once:
// it re-opens the database, SQLite's own WAL recovery decides what the WAL holds, and a checkpoint copies it in. Here the
// close leaves the session's own WAL behind (already copied in; its delete failed), and a hold refuses the check's first
// open of it; the retry clears it, and the lock goes through at the first try.
describe('a -wal held at the lock’s first look (#876)', () => {
  it('is cleared by the lock’s one retry: the lock finishes, the session in .enc', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    const ctl = unlockedController(vp, 'pw')
    const db = ctl.requireDb()
    updateSettings(db, { contextTokens: 4343 })
    const leftover = readFileSync(`${vp.dbPath}-wal`)
    const close = db.close.bind(db)
    ;(db as unknown as { close: () => void }).close = () => {
      close()
      writeFileSync(`${vp.dbPath}-wal`, leftover)
      failures.openThrowOnWalPathOnce = true
    }

    expect(ctl.lock()).not.toHaveProperty('lockNotice')
    expect(failures.hits.openSyncWal).toBe(1)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(4343)
    ctl.lock()
  })
})

// #892: the start's check for a session an unclean end left (live sidecars) only REPORTS, so any doubt is no evidence:
// a working file it cannot even stat (a failing drive) raises no notice, and the start goes on to sweep as before.
describe('the unclean-end check at startup, on a drive that fails a stat (#892)', () => {
  it('reports nothing and changes nothing: swept, not blocked, no notice', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp) // a real working copy, newer than `.enc`
    writeFileSync(`${vp.dbPath}-wal`, 'wal')
    writeFileSync(`${vp.dbPath}-shm`, 'shm')

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.statThrowOnWorkingFile = true
    try {
      ctl.init()
    } finally {
      failures.statThrowOnWorkingFile = false
    }
    expect(failures.hits.statSync).toBeGreaterThan(0)
    expect(ctl.isRecoveryBlocked()).toBe(false)
    for (const leftover of [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]) expect(existsSync(leftover)).toBe(false)
    expect(ctl.getState()).toMatchObject({ state: 'locked' })
    expect(ctl.getState()).not.toHaveProperty('lockNotice')
  })
})

// #911: with no encrypted snapshot on the drive the start keeps the working file as `.recovery` (the only copy of the
// workspace), and whatever it cannot judge or move it leaves alone, as #242 does.
describe('the start over an encrypted file that is missing or cannot be read (#911)', () => {
  // Only ENOENT proves `.enc` is gone. A delete-pending `.enc` on Windows fails a stat with EPERM, which `existsSync`
  // read as "missing": the start then swept the working file (newer than `.enc`: the only fresh copy) as if no snapshot
  // needed it. That doubt now refuses the sweep and the unlock until a retry can read `.enc`.
  it('a stat of .enc that fails with EPERM blocks the start: the working file is neither moved nor shredded', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp, 7171)
    const workingBytes = readFileSync(vp.dbPath)

    failures.encDeletePending = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(failures.hits.encStat).toBeGreaterThan(0)
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(readFileSync(vp.dbPath).equals(workingBytes)).toBe(true)
      expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)

      // `.enc` readable again: the retry finds the failed lock's signature and rolls the session forward (CODE-1b).
      failures.encDeletePending = false
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
      ctl.lock()
    } finally {
      failures.encDeletePending = false
    }
  })

  // #242's hold, in the #911 branch: a spent `.recovery` that another program holds sits on the name the only copy must
  // move to. The start refuses to sweep it and the unlock to open; once the hold clears, the retry keeps it and the right
  // password restores it.
  it('a held .recovery on the name the only copy must move to blocks the start, and the retry restores the copy', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    failedLockState(vp, 9119)
    rmSync(vp.encPath)
    const recoveryPath = plantLeftover(vp)
    const workingBytes = readFileSync(vp.dbPath)

    holdRecovery(true)
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(failures.hits.renameSync).toBeGreaterThan(0)
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(readFileSync(vp.dbPath).equals(workingBytes)).toBe(true)
      expect(readFileSync(recoveryPath, 'utf8')).toBe(LEFTOVER)
      expect(existsSync(vp.encPath)).toBe(false)
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)

      holdRecovery(false)
      ctl.unlock('pw')
      expect(ctl.isRecoveryBlocked()).toBe(false)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
      expect(existsSync(vp.encPath)).toBe(true)
      expect(existsSync(recoveryPath)).toBe(false)
      ctl.lock()
    } finally {
      holdRecovery(false)
    }
  })

  // Review SF-3 (a): with `.enc` removed, a working file the probe cannot read (an antivirus hold on its header read)
  // may be the only copy of the workspace. The start must neither move nor sweep it; the retry once the hold clears
  // keeps it and restores the session. (The replay itself runs through SQLite, which the hold here does not reach.)
  it('with .enc removed after a session ended unlocked, a working file the probe cannot read blocks the start until the retry', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    endedUnlocked(vp, 9119)
    rmSync(vp.encPath)

    failures.openThrowOnWorkingFile = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(failures.hits.openSyncWorking).toBeGreaterThan(0)
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(existsSync(vp.dbPath)).toBe(true)
      expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false)
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)

      failures.openThrowOnWorkingFile = false
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(9119)
      expect(existsSync(vp.encPath)).toBe(true)
      ctl.lock()
    } finally {
      failures.openThrowOnWorkingFile = false
    }
  })

  // Review SF-3 (b): the same EPERM stat of `.enc` beside a session the app ended without locking (live sidecars).
  // There the CODE-1b checks never stat `.enc` in a way that blocks (the #892 check swallows the error), so only the
  // #911 doubt rule stands between it and the sweep: all three files stay as they are. Once `.enc` reads again the
  // retry is the start as before: the mid-session crash is swept (the power-cut trade-off) and the loss recorded.
  it('a stat of .enc that fails with EPERM beside a session ended unlocked blocks the start: all three files kept', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    endedUnlocked(vp, 9119)
    const files = [vp.dbPath, `${vp.dbPath}-wal`, `${vp.dbPath}-shm`]
    const before = files.map((path) => readFileSync(path))

    failures.encDeletePending = true
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(failures.hits.encStat).toBeGreaterThan(0)
      expect(ctl.isRecoveryBlocked()).toBe(true)
      files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)

      failures.encDeletePending = false
      ctl.unlock('pw')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(DEFAULT_SETTINGS.contextTokens)
      expect(['unclean', 'unclean-full']).toContain(ctl.takeWorkingCopyLost()?.cause)
      ctl.lock()
    } finally {
      failures.encDeletePending = false
    }
  })
})
