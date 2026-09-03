import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
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
  VaultLockError,
  VaultRecoveryBlockedError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { IPC } from '../../src/shared/ipc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import type { PrivacyPolicy } from '../../src/shared/types'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'

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
  /** How often each armed wrapper actually refused — an injection that was never reached
   *  proves nothing, so the tests assert these. */
  hits: { renameSync: 0, openSync: 0, rmSync: 0, writeSync: 0 }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const errnoError = (code: string, msg: string): NodeJS.ErrnoException => {
    const err = new Error(msg) as NodeJS.ErrnoException
    err.code = code
    return err
  }
  const isRecovery = (p: unknown): boolean => String(p).endsWith('.recovery')
  const mocked = {
    ...actual,
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
  failures.hits = { renameSync: 0, openSync: 0, rmSync: 0, writeSync: 0 }
  ipcState.handlers.clear()
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

/** The minimal AppContext the unlock handler's failure path reads. */
function ctxWith(ctrl: WorkspaceController): AppContext {
  return {
    workspace: ctrl,
    runtime: { stop: async () => {}, activeModelId: () => null },
    embedder: { stop: async () => {} }
  } as unknown as AppContext
}

/** The exact disk state a failed lock leaves behind: a checkpointed, cleanly CLOSED plaintext
 *  working file (no -wal/-shm) holding `marker`, newer than the stale `.enc` (the
 *  workspace-vault.test.ts helper). */
function failedLockState(vp: VaultPaths, marker = 7171): void {
  const { db } = unlockEncryptedVault(vp, 'pw')
  updateSettings(db, { contextTokens: marker })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  const past = new Date(Date.now() - 60_000)
  utimesSync(vp.encPath, past, past)
}

/** The spent leftover of an earlier salvage whose best-effort unlink failed (Windows hold),
 *  still sitting on the rename target at the next launch. Backdated like `.enc`. */
const LEFTOVER = 'spent leftover that outlived its unlink'
function plantLeftover(vp: VaultPaths): string {
  const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
  writeFileSync(recoveryPath, LEFTOVER)
  const past = new Date(Date.now() - 60_000)
  utimesSync(recoveryPath, past, past)
  return recoveryPath
}

describe('`.recovery` guards (full-audit 2026-07-12 REL-1/REL-2)', () => {
  it('REL-1: a spent .recovery blocking the rename no longer costs the only fresh copy', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
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
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 6161 })
    lockEncryptedVault(vp, db, key) // `.enc` holds 6161 (mtime ~now)

    // A SPENT `.recovery` leftover, OLDER than `.enc` (a consumed roll-forward whose unlink
    // failed); the AV hold means the probe cannot even OPEN it. `.enc` is demonstrably newer,
    // so unlocking into it loses nothing — the leftover is left for a later probe to shred.
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    writeFileSync(recoveryPath, 'held leftover the probe cannot read')
    const past = new Date(Date.now() - 60_000)
    utimesSync(recoveryPath, past, past)

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
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    failedLockState(vp, 4242) // working file (4242) newer than the stale `.enc` (3072)

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
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    failedLockState(vp, 7171) // the working file (7171) is the only fresh copy
    const recoveryPath = plantLeftover(vp)
    const leftoverSize = statSync(recoveryPath).size
    const workingBytes = readFileSync(vp.dbPath)
    const encBefore = readFileSync(vp.encPath) // the stale snapshot (3072, the seeded default)
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
      registerWorkspaceIpc(ctxWith(ctl))
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
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    failedLockState(vp, 7171)
    const recoveryPath = plantLeftover(vp)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(failures.hits).toEqual({ renameSync: 0, openSync: 0, rmSync: 0, writeSync: 0 })
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
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
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
    const past = new Date(Date.now() - 60_000)
    utimesSync(vp.encPath, past, past)
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
