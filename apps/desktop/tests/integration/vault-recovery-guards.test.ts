import { describe, it, expect, vi, beforeEach } from 'vitest'
import { closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import {
  unlockEncryptedVault,
  lockEncryptedVault,
  decryptFile,
  encryptFile,
  WorkspaceController,
  RECOVERY_SUFFIX,
  REKEY_JOURNAL_NAME,
  REKEY_SUFFIX,
  VaultLockError,
  VaultRecoveryBlockedError,
  applyPendingRekey,
  shredFile,
  shredFileWithin,
  stageRekey,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { IPC } from '../../src/shared/ipc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { tMain } from '../../src/main/services/i18n'
import { readLogTail } from '../../src/main/services/logging'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import {
  ENCRYPTION_REQUIRED,
  FAST_ARGON,
  backdate,
  endedUnlocked,
  failedLockState,
  freshVaultPaths,
  lockedVault,
  readStoredCopy,
  storeCopy,
  unlockedController,
  workspaceIpcCtx,
  type FreshVaultPaths
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
  /** #807 (C S-1): renameSync throws Node's own EPERM, with its absolute paths, for the create's last step (the staged
   *  `.enc.new` onto `.sqlite.enc`): an antivirus or indexer holding the new file on Windows. */
  renameThrowOnStagedEnc: false,
  /** #954: right after the create's stage lands (`encryptFile`'s rename of `.enc.new.tmp` onto `.enc.new`), these bytes
   *  are written at `path`: a workspace's key file copied back while the create derives its key and stages its
   *  database, after the checks at its start and before its commit. */
  putBackDescriptorOnStage: null as { path: string; bytes: Buffer } | null,
  /** #973: openSync throws this error code for the staged database (`…/hilbertraum.sqlite.enc.new`) while set: `EBUSY`
   *  for an antivirus or indexer hold on the file the unlock must read under the data key, `ENOENT` for a file gone since
   *  the check, `EIO` for a failing drive. Its existence still reads true. */
  openThrowOnStagedEnc: null as string | null,
  /** #1001: openSync throws this error code for a staged document or image copy (a `documents/` or `images/`
   *  `….enc.new`) while set: `EBUSY` for an antivirus or indexer hold on the file the unlock must read under the data
   *  key, `EIO` for a failing drive. */
  openThrowOnStagedSidecar: null as string | null,
  /** #1001: this stored copy reads as a delete-pending file on Windows while set: `statSync` throws EPERM for it and
   *  `existsSync`, which swallows the error, answers false. */
  sidecarTargetDeletePending: null as string | null,
  /** #1001 review round 1: renameSync throws this error code for a staged document or image copy renamed onto its stored
   *  copy's name while set: a stage an antivirus or indexer holds without delete sharing (it reads, it cannot move). */
  renameThrowOnStagedSidecar: null as string | null,
  /** #1015 review R4: renameSync throws a plain `TypeError` (no `code`, no `syscall`: no file error) for a staged document
   *  or image copy renamed onto its stored copy's name while set: the stand-in for a programming error in the swap. */
  renameThrowsPlainErrorOnStagedSidecar: false,
  /** #1015 round 3: renameSync throws EBUSY for exactly this staged file while set: one stuck file among several. */
  renameThrowForStage: null as string | null,
  /** #1001 review round 2: renameSync throws this error code for a stored copy the unlock moved aside (`….enc.tmp` under
   *  `documents/` or `images/`) moved back onto its own name while set: the move back after a failed swap fails too. */
  renameThrowOnAsideRestore: null as string | null,
  /** #1001 review round 2: statSync (and, round 3, lstatSync) reports inode 0 and one link for every path under
   *  `documents/` or `images/` while set, as some network (SMB) and FUSE mounts do: a hard link is then not told from two
   *  files by its ids. */
  statReportsNoInode: false,
  /** #1001 review round 3: lstatSync reports a symbolic link for exactly this path while set: the stand-in for a link at
   *  the stored copy's name where this machine may not create one (a Windows account without the symlink privilege). */
  lstatReportsSymlink: null as string | null,
  /** #1014 round 3: lstatSync reports a link count of 0 for exactly this path while set, as some drivers do for a
   *  regular file (the file itself and its other stats as they are). */
  lstatReportsNoLinkCount: null as string | null,
  /** #1014 round 4: lstatSync throws this error code for exactly this path while set: a hold, a permission or an I/O
   *  error on a folder the journal's containment walks, or on a file the unlock judges, that proves nothing. */
  lstatThrow: null as { path: string; code: string } | null,
  /** #1014 round 4: realpathSync throws this error code for exactly this path while set. */
  realpathThrow: null as { path: string; code: string } | null,
  /** #1014 round 6: rmSync throws this error code for exactly this path while set: a file another program holds without
   *  delete sharing (the rotated log, the journal itself). */
  rmThrowFor: null as { path: string; code: string } | null,
  /** #1001 review round 3: the descriptors opened on a staged document or image copy, and the bytes read through them:
   *  what the unlock's pass actually reads of a stage. */
  stagedSidecarFds: new Set<number>(),
  stageBytesRead: 0,
  /** #1001 review round 2: openSync throws EBUSY for exactly this stored copy while set: a hold on the stored copy the
   *  unlock reads before it swaps a stage in. */
  openThrowOnSidecarTarget: null as string | null,
  /** How often each armed wrapper actually refused — an injection that was never reached
   *  proves nothing, so the tests assert these. */
  hits: {
    renameSync: 0,
    openSync: 0,
    rmSync: 0,
    writeSync: 0,
    openSyncWal: 0,
    statSync: 0,
    encStat: 0,
    openSyncWorking: 0,
    renameStagedEnc: 0,
    putBackOnStage: 0,
    openSyncStaged: 0,
    openSyncStagedSidecar: 0,
    sidecarTargetStat: 0,
    renameStagedSidecar: 0,
    renameAsideRestore: 0,
    statNoInode: 0,
    openSyncSidecarTarget: 0,
    statThrow: 0
  }
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
  const isStagedSidecar = (p: unknown): boolean => /[\\/](documents|images)[\\/][^\\/]+\.enc\.new$/.test(String(p))
  const isAsideCopy = (p: unknown): boolean => /[\\/](documents|images)[\\/][^\\/]+\.enc\.tmp$/.test(String(p))
  const inStore = (p: unknown): boolean => /[\\/](documents|images)[\\/]/.test(String(p))
  const isPendingSidecarTarget = (p: unknown): boolean =>
    failures.sidecarTargetDeletePending !== null && String(p) === failures.sidecarTargetDeletePending
  const mocked = {
    ...actual,
    existsSync: vi.fn((path: Parameters<typeof actual.existsSync>[0]) => {
      if (failures.encDeletePending && isEnc(path)) {
        failures.hits.encStat += 1
        return false
      }
      if (isPendingSidecarTarget(path)) {
        failures.hits.sidecarTargetStat += 1
        return false
      }
      return actual.existsSync(path)
    }),
    renameSync: vi.fn((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (failures.renameThrowOnExistingRecoveryTarget && isRecovery(to) && actual.existsSync(to)) {
        failures.hits.renameSync += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, rename (held .recovery target)')
      }
      const heldStage = failures.renameThrowOnStagedSidecar
      if (heldStage !== null && isStagedSidecar(from) && String(to) === String(from).slice(0, -'.new'.length)) {
        failures.hits.renameStagedSidecar += 1
        throw errnoError(heldStage, `${heldStage}: rename (a held staged document copy)`)
      }
      if (failures.renameThrowForStage !== null && String(from) === failures.renameThrowForStage) {
        failures.hits.renameStagedSidecar += 1
        throw errnoError('EBUSY', 'EBUSY: rename (one held staged file)')
      }
      if (failures.renameThrowsPlainErrorOnStagedSidecar && isStagedSidecar(from)) {
        failures.hits.renameStagedSidecar += 1
        throw new TypeError('a programming error in the swap')
      }
      const heldAside = failures.renameThrowOnAsideRestore
      if (heldAside !== null && isAsideCopy(from) && String(to) === String(from).slice(0, -'.tmp'.length)) {
        failures.hits.renameAsideRestore += 1
        throw errnoError(heldAside, `${heldAside}: rename (a stored copy moved aside)`)
      }
      if (failures.renameThrowOnStagedEnc && String(from).endsWith('.enc.new') && isEnc(to)) {
        failures.hits.renameStagedEnc += 1
        // What Node throws: the message and `path`/`dest` carry both absolute paths.
        throw Object.assign(
          errnoError('EPERM', `EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`),
          { errno: -4048, syscall: 'rename', path: String(from), dest: String(to) }
        )
      }
      const putBack = failures.putBackDescriptorOnStage
      if (putBack && String(from).endsWith('.enc.new.tmp') && String(to).endsWith('.enc.new')) {
        actual.renameSync(from, to)
        actual.writeFileSync(putBack.path, putBack.bytes)
        failures.hits.putBackOnStage += 1
        return
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
      const stagedCode = failures.openThrowOnStagedEnc
      if (stagedCode !== null && String(path).endsWith('.sqlite.enc.new')) {
        failures.hits.openSyncStaged += 1
        throw errnoError(stagedCode, `${stagedCode}: open (the staged database)`)
      }
      if (failures.openThrowOnSidecarTarget !== null && String(path) === failures.openThrowOnSidecarTarget) {
        failures.hits.openSyncSidecarTarget += 1
        throw errnoError('EBUSY', 'EBUSY: open (a held stored copy)')
      }
      const sidecarCode = failures.openThrowOnStagedSidecar
      if (sidecarCode !== null && isStagedSidecar(path)) {
        failures.hits.openSyncStagedSidecar += 1
        throw errnoError(sidecarCode, `${sidecarCode}: open (a staged document copy)`)
      }
      const fd = actual.openSync(path, flags, mode)
      if (failures.enospcOnEncTmpWrite && String(path).endsWith('.enc.tmp')) failures.encTmpFds.add(fd)
      if (isStagedSidecar(path)) failures.stagedSidecarFds.add(fd)
      return fd
    }),
    rmSync: vi.fn((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (failures.rmThrowOnRecoveryPath && isRecovery(path)) {
        failures.hits.rmSync += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, unlink (held .recovery)')
      }
      if (failures.rmThrowFor !== null && String(path) === failures.rmThrowFor.path) {
        failures.hits.rmSync += 1
        throw errnoError(failures.rmThrowFor.code, `${failures.rmThrowFor.code}: unlink (a held file)`)
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
      failures.stagedSidecarFds.delete(fd)
      return actual.closeSync(fd)
    }),
    readSync: vi.fn((fd: number, ...rest: unknown[]) => {
      const read = (actual.readSync as unknown as (...args: unknown[]) => number)(fd, ...rest)
      if (failures.stagedSidecarFds.has(fd)) failures.stageBytesRead += read
      return read
    }),
    lstatSync: vi.fn((...args: unknown[]) => {
      if (failures.lstatThrow !== null && String(args[0]) === failures.lstatThrow.path) {
        failures.hits.statThrow += 1
        throw errnoError(failures.lstatThrow.code, `${failures.lstatThrow.code}: lstat (a stat that proves nothing)`)
      }
      const stats = (actual.lstatSync as unknown as (...a: unknown[]) => unknown)(...args)
      if (stats === undefined) return stats
      if (failures.lstatReportsNoLinkCount !== null && String(args[0]) === failures.lstatReportsNoLinkCount) {
        const real = stats as { nlink: number | bigint }
        const none = typeof real.nlink === 'bigint' ? { nlink: 0n } : { nlink: 0 }
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as object, stats, none)
      }
      if (failures.lstatReportsSymlink !== null && String(args[0]) === failures.lstatReportsSymlink) {
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as object, stats, {
          isFile: () => false,
          isSymbolicLink: () => true
        })
      }
      if (failures.statReportsNoInode && inStore(args[0])) {
        failures.hits.statNoInode += 1
        const real = stats as { ino: number | bigint }
        const blank = typeof real.ino === 'bigint' ? { ino: 0n, nlink: 1n } : { ino: 0, nlink: 1 }
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as object, stats, blank)
      }
      return stats
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
      if (isPendingSidecarTarget(args[0])) {
        failures.hits.sidecarTargetStat += 1
        throw errnoError('EPERM', 'EPERM: operation not permitted, stat (a delete-pending stored copy)')
      }
      const stats = (actual.statSync as unknown as (...a: unknown[]) => unknown)(...args)
      if (failures.statReportsNoInode && inStore(args[0]) && stats !== undefined) {
        failures.hits.statNoInode += 1
        const real = stats as { ino: number | bigint }
        const blank = typeof real.ino === 'bigint' ? { ino: 0n, nlink: 1n } : { ino: 0, nlink: 1 }
        return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as object, stats, blank)
      }
      return stats
    }),
    realpathSync: Object.assign(
      vi.fn((...args: unknown[]) => {
        if (failures.realpathThrow !== null && String(args[0]) === failures.realpathThrow.path) {
          failures.hits.statThrow += 1
          throw errnoError(failures.realpathThrow.code, `${failures.realpathThrow.code}: realpath (a stat that proves nothing)`)
        }
        return (actual.realpathSync as unknown as (...a: unknown[]) => unknown)(...args)
      }),
      { native: actual.realpathSync.native }
    )
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
  failures.renameThrowOnStagedEnc = false
  failures.putBackDescriptorOnStage = null
  failures.openThrowOnStagedEnc = null
  failures.openThrowOnStagedSidecar = null
  failures.sidecarTargetDeletePending = null
  failures.renameThrowOnStagedSidecar = null
  failures.renameThrowsPlainErrorOnStagedSidecar = false
  failures.renameThrowForStage = null
  failures.renameThrowOnAsideRestore = null
  failures.statReportsNoInode = false
  failures.openThrowOnSidecarTarget = null
  failures.lstatReportsSymlink = null
  failures.lstatReportsNoLinkCount = null
  failures.lstatThrow = null
  failures.realpathThrow = null
  failures.rmThrowFor = null
  failures.stagedSidecarFds.clear()
  failures.stageBytesRead = 0
  failures.hits = {
    renameSync: 0,
    openSync: 0,
    rmSync: 0,
    writeSync: 0,
    openSyncWal: 0,
    statSync: 0,
    encStat: 0,
    openSyncWorking: 0,
    renameStagedEnc: 0,
    putBackOnStage: 0,
    openSyncStaged: 0,
    openSyncStagedSidecar: 0,
    sidecarTargetStat: 0,
    renameStagedSidecar: 0,
    renameAsideRestore: 0,
    statNoInode: 0,
    openSyncSidecarTarget: 0,
    statThrow: 0
  }
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
      openSyncWorking: 0,
      renameStagedEnc: 0,
      putBackOnStage: 0,
      openSyncStaged: 0,
      openSyncStagedSidecar: 0,
      sidecarTargetStat: 0,
      renameStagedSidecar: 0,
      renameAsideRestore: 0,
      statNoInode: 0,
      openSyncSidecarTarget: 0,
      statThrow: 0
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

// S-1 (follow-ups wave 7, with #1002): the exit-bound lock (`shutdown()`: the quit teardown's, and the emergency lock of
// a session end or a signal) used to be followed by the process's end, so a failed one was left to the next launch's
// salvage. A macOS shutdown another app cancels leaves the process running, locked, and #1002 offers the unlock again in
// it. That unlock skipped the start's steps and decrypted `.enc`, the last good lock, over the newer working file: the
// session since that lock was gone, and the controller kept the key in memory while it reported "locked".
describe('a failed exit lock in a process that lives on (S-1)', () => {
  /** A good lock (`.enc` holds 3333), a session delta since (4444), then the emergency lock's two steps (the latch,
   *  `shutdown()`) on a full drive at the lock write; `.enc` backdated for a deterministic mtime order. */
  function failedExitLock(): { vp: VaultPaths; ctl: WorkspaceController; key: Buffer } {
    const vp = lockedVault('recovery-guards', 'pw')
    const ctl = unlockedController(vp, 'pw')
    updateSettings(ctl.requireDb(), { contextTokens: 3333 })
    ctl.lock()
    ctl.unlock('pw')
    updateSettings(ctl.requireDb(), { contextTokens: 4444 })
    const key = ctl.encryptionKey()
    if (!key) throw new Error('an unlocked encrypted workspace has a key')
    ctl.beginLock()
    failures.enospcOnEncTmpWrite = true
    try {
      expect(() => ctl.shutdown()).toThrow(VaultLockError)
      expect(failures.hits.writeSync).toBeGreaterThan(0)
    } finally {
      failures.enospcOnEncTmpWrite = false
      failures.encTmpFds.clear()
    }
    expect(ctl.getState().state).toBe('locked')
    backdate(vp.encPath)
    return { vp, ctl, key }
  }

  it('the next unlock in the same controller rolls the working file forward: the session since the last good lock is kept', () => {
    const { vp, ctl } = failedExitLock()
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(4444)
    expect(existsSync(`${vp.dbPath}${RECOVERY_SUFFIX}`)).toBe(false) // salvaged and rolled forward, as a start does
    ctl.lock()
  })

  it('and until then the controller holds no key: the key is zeroed, documentCipher() and encryptionKey() are null', () => {
    const { ctl, key } = failedExitLock()
    expect(key.every((b) => b === 0)).toBe(true)
    expect(ctl.documentCipher()).toBeNull()
    expect(ctl.encryptionKey()).toBeNull()
    ctl.unlock('pw') // the password derives it again
    expect(ctl.documentCipher()).not.toBeNull()
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

  // Code review: the unlock's roll-forward judged `.enc` with `existsSync`, which reads an EPERM (a delete-pending file
  // on Windows) as "missing", so it encrypted a SPENT `.recovery` (an older snapshot that outlived its shred) over the
  // good `.enc`: a silent rollback. It now judges `.enc` once by the start's rule: doubt refuses, nothing is written,
  // and the retry once `.enc` reads again finds the leftover spent and shreds it.
  it('a stat of .enc that fails with EPERM at the unlock never lets a .recovery be encrypted over it', () => {
    const vp = lockedVault('recovery-guards', 'pw')
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    updateSettings(db, { contextTokens: 4242 })
    lockEncryptedVault(vp, db, key)
    const spentCopy = join(vp.root, 'spent.sqlite')
    decryptFile(vp.encPath, spentCopy, key) // a database holding the older 4242
    const later = unlockedController(vp, 'pw')
    updateSettings(later.requireDb(), { contextTokens: 6161 })
    later.lock() // `.enc` holds 6161
    const recoveryPath = `${vp.dbPath}${RECOVERY_SUFFIX}`
    writeFileSync(recoveryPath, readFileSync(spentCopy))
    backdate(recoveryPath) // spent: older than `.enc`
    const encBefore = readFileSync(vp.encPath)
    const recoveryBefore = readFileSync(recoveryPath)

    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    failures.encDeletePending = true
    try {
      let blocked: unknown = null
      try {
        ctl.unlock('pw')
      } catch (err) {
        blocked = err
      }
      expect(blocked).toBeInstanceOf(VaultRecoveryBlockedError)
      expect((blocked as VaultRecoveryBlockedError).code, 'the stat\'s code, round 5').toBe('EPERM')
      expect(failures.hits.encStat).toBeGreaterThan(0)
      expect(readFileSync(vp.encPath).equals(encBefore)).toBe(true)
      expect(readFileSync(recoveryPath).equals(recoveryBefore)).toBe(true)
      expect(ctl.isUnlocked()).toBe(false)
    } finally {
      failures.encDeletePending = false
    }
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(6161)
    expect(existsSync(recoveryPath)).toBe(false)
    ctl.lock()
  })

  // Review V F-4: "the encrypted workspace file isn't on the drive" (`vault_descriptor_unreadable`) needs a stat that
  // says ENOENT. Beside an unreadable key file, a delete-pending `.enc` (EPERM on a stat, false from `existsSync`) proves
  // neither: the unlock fails as before ("Could not open the workspace."), and the create is refused as a workspace on
  // the drive, never with that copy.
  it('a stat of .enc that fails with EPERM beside an unreadable key file never says the encrypted file is missing', async () => {
    const vp = lockedVault('recovery-guards', 'pw')
    writeFileSync(vp.descriptorPath, '{ not json', 'utf8')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    failures.encDeletePending = true
    let unlocked: unknown
    let created: unknown
    try {
      unlocked = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
      created = (await invoke(handlers, IPC.createWorkspace, 'long-enough-pw', 'encrypted')).result
    } finally {
      failures.encDeletePending = false
    }
    expect(failures.hits.encStat).toBeGreaterThan(0)
    expect(unlocked).toEqual({ ok: false, reason: 'error', message: tMain('main.workspace.openFailed') })
    expect(created).toEqual({ ok: false, reason: 'workspace_exists', message: tMain('main.workspace.exists') })
    ctl.shutdown()
  })
})

// #807 (C S-1): the create IPC used to recognise its two refusals by their English wording, `/not permitted|already
// exists/`, which also matched Node's own file errors. An `EPERM: operation not permitted, rename …` at the create's
// last step (an antivirus or indexer holding the new file) then reached the lock screen as a "refusal": raw English
// with the drive's absolute paths, and with no log line. Since the refusals are typed, such an error is a failed create:
// the generic copy, and a log line that names the error's code and system call, never its paths.
describe('a file error while a workspace is created (#807)', () => {
  it('an EPERM on the last rename answers "could not create", with no path in the answer or the log line', async () => {
    const vp = freshVaultPaths('recovery-guards-create')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    const linesBefore = readLogTail(100_000).length
    failures.renameThrowOnStagedEnc = true
    let result: unknown
    try {
      result = (await invoke(handlers, IPC.createWorkspace, 'long-enough-pw', 'encrypted')).result
    } finally {
      failures.renameThrowOnStagedEnc = false
    }
    expect(failures.hits.renameStagedEnc).toBe(1)
    expect(result).toEqual({ ok: false, reason: 'error', message: tMain('main.workspace.createFailed') })
    // Neither the root nor a vault file name, raw or as JSON escapes a Windows path, reaches the log. `readLogTail`
    // redacts what it hands out (#975), which hides a Windows profile's account segment: the root's own folder name,
    // which it keeps, still shows a path.
    const logged = readLogTail(100_000).slice(linesBefore)
    const failure = logged.filter((line) => line.includes('Workspace create failed'))
    expect(failure).toHaveLength(1)
    expect(failure[0]).toContain('"code":"EPERM"')
    expect(failure[0]).toContain('"syscall":"rename"')
    const escapedRoot = JSON.stringify(vp.root).slice(1, -1)
    for (const line of logged) {
      expect(line).not.toContain(vp.root)
      expect(line).not.toContain(escapedRoot)
      expect(line).not.toContain(basename(vp.root))
      expect(line).not.toContain('hilbertraum.sqlite')
    }
    // The create did not finish, but it committed its key file: nothing is open, and the state reads `locked` (#954: a
    // key file is on the drive), so a retry is refused and the lock screen shows its unlock form, where the password
    // just chosen opens the workspace once the start's steps roll the staged file into place (#955 item 2; a restart
    // does the same). Before #954 the state read `uninitialized` and the retry rewrote the key file just committed.
    expect(ctl.isUnlocked()).toBe(false)
    expect(ctl.getState().state).toBe('locked')
    ctl.shutdown()
  })

  // #954 (owner call G-7 A): the commit replaces whatever is at the descriptor's name, and the key derivation and the
  // stage before it take about half a second. A key file copied back inside that window passes the checks at the
  // create's start; the re-check right before the commit refuses it, and the staged file goes too (S-1: left, the next
  // start would roll it over the `.enc` of that workspace once it is back). The copy lands as the stage's last rename
  // finishes, between the two checks.
  it('a key file put back while the create stages its database is refused at the commit, nothing staged left (#954)', async () => {
    const vp = freshVaultPaths('recovery-guards-create')
    const putBack = readFileSync(lockedVault('recovery-guards-src', 'pw').descriptorPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    failures.putBackDescriptorOnStage = { path: vp.descriptorPath, bytes: putBack }
    let result: unknown
    try {
      result = (await invoke(handlers, IPC.createWorkspace, 'long-enough-pw', 'encrypted')).result
    } finally {
      failures.putBackDescriptorOnStage = null
    }
    expect(failures.hits.putBackOnStage).toBe(1)
    expect(result).toEqual({ ok: false, reason: 'workspace_exists', message: tMain('main.workspace.exists') })
    expect(readFileSync(vp.descriptorPath).equals(putBack)).toBe(true)
    expect(existsSync(`${vp.encPath}.new`)).toBe(false)
    expect(existsSync(vp.encPath)).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(ctl.getState().state).toBe('locked')
    ctl.shutdown()
  })
})

// #973: the unlock judges a staged `.enc.new` that no journal lists (a create's leftover beside a workspace put back
// into its folder) by reading it under the data key. A read it cannot make (an antivirus or indexer hold) changes
// nothing and answers "try again" (`vault_recovery_blocked`, the #242 answer), never the generic open failure; once the
// hold is gone, the next unlock removes the leftover and opens the workspace.
describe('a staged database the unlock cannot read (#973)', () => {
  it('a held staged copy beside a workspace answers vault_recovery_blocked, every file byte for byte; the retry opens it', async () => {
    const vp = lockedVault('recovery-guards-973', 'pw')
    const seed = unlockedController(vp, 'pw')
    updateSettings(seed.requireDb(), { contextTokens: 5151 })
    seed.lock()
    const staged = `${vp.encPath}.new`
    writeFileSync(staged, readFileSync(lockedVault('recovery-guards-973-leftover', 'other-pw').encPath))
    const files = [vp.descriptorPath, vp.encPath, staged]
    const before = files.map((path) => readFileSync(path))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true)) // the start leaves it
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    failures.openThrowOnStagedEnc = 'EBUSY'
    let blocked: unknown
    try {
      blocked = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
    } finally {
      failures.openThrowOnStagedEnc = null
    }
    expect(failures.hits.openSyncStaged).toBeGreaterThan(0)
    expect(blocked).toEqual({ ok: false, reason: 'vault_recovery_blocked', message: tMain('main.workspace.recoveryBlocked') })
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
    expect(existsSync(vp.dbPath)).toBe(false)
    expect(ctl.isUnlocked()).toBe(false)
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    expect(existsSync(staged)).toBe(false)
    ctl.shutdown()
  })

  /** A locked workspace under `pw` holding `contextTokens: 5151`, with another workspace's `.enc` (a create's leftover)
   *  at the staged name, and the bytes of its key file, `.enc` and stage. */
  function workspaceBesideLeftover(): { vp: VaultPaths; staged: string; files: string[]; before: Buffer[] } {
    const vp = lockedVault('recovery-guards-973', 'pw')
    const seed = unlockedController(vp, 'pw')
    updateSettings(seed.requireDb(), { contextTokens: 5151 })
    seed.lock()
    const staged = `${vp.encPath}.new`
    writeFileSync(staged, readFileSync(lockedVault('recovery-guards-973-leftover', 'other-pw').encPath))
    const files = [vp.descriptorPath, vp.encPath, staged]
    return { vp, staged, files, before: files.map((path) => readFileSync(path)) }
  }

  // Review round 2 R4, round 3 F4: the read failure splits by its code. A file gone since the check (ENOENT) is no stage:
  // nothing to judge, the workspace opens. A folder at the name (EISDIR) is no data: left, and `.enc` opens
  // (workspace-vault-format-guard.test.ts). Every other failure, a hold or an I/O error, may hide a stage this workspace
  // needs: the unlock refuses as "try again" and changes nothing.
  it('a staged copy gone between the check and the read (ENOENT) is no stage: the unlock opens the workspace, nothing logged', () => {
    const { vp, files, before } = workspaceBesideLeftover()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    failures.openThrowOnStagedEnc = 'ENOENT'
    try {
      expect(ctl.unlock('pw').state).toBe('unlocked')
    } finally {
      failures.openThrowOnStagedEnc = null
    }
    expect(failures.hits.openSyncStaged).toBeGreaterThan(0)
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    expect(ctl.takeStageOutcome()).toBeNull()
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
    ctl.shutdown()
  })

  // Round 2 left such a stage and went on; with a failed lock's `.recovery` waiting, that roll-forward ran first, and an
  // authenticating stage could later roll over the session it had restored (Fable round 2, P6). Now the refusal comes
  // before the `.recovery` block: nothing is written, and the retry restores the session.
  it('a staged copy that fails to read with EIO answers vault_recovery_blocked; a waiting .recovery and every file byte for byte', async () => {
    const vp = lockedVault('recovery-guards-973', 'pw')
    failedLockState(vp, 7171, 'pw') // a closed working file newer than `.enc`: the start keeps it as `.recovery`
    const staged = `${vp.encPath}.new`
    writeFileSync(staged, readFileSync(lockedVault('recovery-guards-973-leftover', 'other-pw').encPath))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    const files = [vp.descriptorPath, vp.encPath, staged, `${vp.dbPath}${RECOVERY_SUFFIX}`]
    const before = files.map((path) => readFileSync(path))
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    failures.openThrowOnStagedEnc = 'EIO'
    let result: unknown
    let logged: string[] = []
    try {
      const linesBefore = readLogTail(100_000).length
      result = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
      logged = readLogTail(100_000)
        .slice(linesBefore)
        .filter((line) => line.includes('the startup recovery is blocked'))
    } finally {
      failures.openThrowOnStagedEnc = null
    }
    expect(failures.hits.openSyncStaged).toBeGreaterThan(0)
    expect(result).toEqual({ ok: false, reason: 'vault_recovery_blocked', message: tMain('main.workspace.recoveryBlocked') })
    // Round 5: the refusal's one log line carries the read's code, as the other blocked answers' do (no path).
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('EIO')
    expect(logged[0]).not.toContain(basename(vp.root))
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
    expect(existsSync(vp.dbPath)).toBe(false)
    ctl.unlock('pw') // the read works again: the leftover is removed, then the failed lock's session rolls forward
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(7171)
    expect(existsSync(staged)).toBe(false)
    ctl.shutdown()
  })

  // The doubt needs `.enc` proven present only by a stat that does not say ENOENT (the #911 rule): one that fails
  // otherwise (a delete-pending file on Windows) is doubt too, and the start rolls nothing over it.
  it('a stat of .enc that fails with EPERM at the start: the staged leftover is left, and the unlock removes it once .enc reads again', () => {
    const { vp, staged, files, before } = workspaceBesideLeftover()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.encDeletePending = true
    try {
      ctl.init()
    } finally {
      failures.encDeletePending = false
    }
    expect(failures.hits.encStat).toBeGreaterThan(0)
    files.forEach((path, i) => expect(readFileSync(path).equals(before[i]), path).toBe(true))
    ctl.unlock('pw')
    expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    expect(existsSync(staged)).toBe(false)
    ctl.shutdown()
  })
})

// #1001: the unlock judges a staged document or image copy that no journal lists, beside a stored copy that is there,
// by reading it under the data key. A read it cannot make (an antivirus or indexer hold, a failing drive) leaves the
// stage and the stored copy as they are and opens the workspace (owner decision D-1): a stored copy is written once, so
// a stage left loses nothing, and one file never locks the user out of the whole workspace. The next unlock judges it
// again.
describe('a staged document copy the unlock cannot read (#1001)', () => {
  /** A stored document copy in `vp`, written while it is unlocked under `password`; its text names the password. */
  async function storedDocument(vp: FreshVaultPaths, password: string): Promise<string> {
    const ctl = unlockedController(vp, password)
    try {
      return await storeCopy(ctl, vp.root, join(dirname(vp.dbPath), 'documents', 'd1.pdf.enc'), `the copy under ${password}`)
    } finally {
      ctl.lock()
    }
  }

  /** A locked workspace under `pw` with a stored document copy, and the same copy of another workspace at its staged
   *  name; the bytes of both. The other workspace's password (`qq`) has the length of `pw`, so the two copies have the
   *  same length and the unlock reads the stage (one of another length is removed after a stat, round 3). */
  async function documentBesideForeignStage(): Promise<{ vp: FreshVaultPaths; target: string; staged: string; before: Buffer[] }> {
    const vp = lockedVault('recovery-guards-1001', 'pw')
    const target = await storedDocument(vp, 'pw')
    const staged = `${target}.new`
    writeFileSync(staged, readFileSync(await storedDocument(lockedVault('recovery-guards-1001-other', 'qq'), 'qq')))
    return { vp, target, staged, before: [readFileSync(target), readFileSync(staged)] }
  }

  it.each<[string]>([['EBUSY'], ['EIO']])(
    'a staged document copy that fails to read with %s: the workspace opens, both files byte for byte, one line logged; the next unlock removes it',
    async (code) => {
      const { vp, target, staged, before } = await documentBesideForeignStage()
      const unchanged = (): void => {
        expect(readFileSync(target).equals(before[0]), 'the stored copy').toBe(true)
        expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
      }
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      unchanged() // the start leaves both
      registerWorkspaceIpc(workspaceIpcCtx(ctl))
      const linesBefore = readLogTail(100_000).length
      failures.openThrowOnStagedSidecar = code
      let result: unknown
      try {
        result = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
      } finally {
        failures.openThrowOnStagedSidecar = null
      }
      expect(failures.hits.openSyncStagedSidecar).toBeGreaterThan(0)
      expect(result).toMatchObject({ ok: true })
      unchanged()
      expect(await readStoredCopy(ctl, vp.root, target)).toBe('the copy under pw')
      const logged = readLogTail(100_000)
        .slice(linesBefore)
        .filter((line) => line.includes('(#1001)'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain('"left":1')
      ctl.lock()
      ctl.unlock('pw') // the hold is gone: judged again, and removed
      expect(existsSync(staged)).toBe(false)
      expect(readFileSync(target).equals(before[0])).toBe(true)
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
      ctl.shutdown()
    }
  )

  // The doubt needs the stored copy proven present only by a stat that does not say ENOENT (the #911 rule, as #973's for
  // `.enc`): one that fails otherwise (a delete-pending file on Windows, which `existsSync` reads as gone) is doubt too,
  // and the start swaps nothing over it.
  it('a stat of the stored copy that fails with EPERM at the start: the stage beside it is left, and the unlock removes it once the copy reads again', async () => {
    const { vp, target, staged, before } = await documentBesideForeignStage()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.sidecarTargetDeletePending = target
    try {
      ctl.init()
    } finally {
      failures.sidecarTargetDeletePending = null
    }
    expect(failures.hits.sidecarTargetStat).toBeGreaterThan(0)
    expect(readFileSync(target).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
    ctl.unlock('pw')
    expect(existsSync(staged)).toBe(false)
    expect(await readStoredCopy(ctl, vp.root, target)).toBe('the copy under pw')
    ctl.shutdown()
  })

  // Review round 1: the swap never destroys the stored copy before the stage is in its place. A stage that opens under
  // the data key but cannot be moved (a hold that lets it be read and refuses a delete) used to cost the stored copy,
  // shredded first; the stage then counted as the only copy left, and every later start and unlock threw the raw rename
  // error. Now the stored copy goes back to its name, the workspace opens, and later starts and unlocks leave the stage
  // for an unlock that can move it. (`retiredCopyBesideStage` is below the describes: #1015 uses it too.)
  it('a stage that opens under the data key but cannot be renamed into place: the stored copy stays, nothing throws later, and the retry swaps it in', async () => {
    const { vp, target, staged, before } = await retiredCopyBesideStage()
    const unchanged = (): void => {
      expect(existsSync(target), 'the stored copy is there').toBe(true)
      expect(readFileSync(target).equals(before[0]), 'the stored copy').toBe(true)
      expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
      expect(existsSync(`${target}.tmp`), 'nothing left aside').toBe(false)
    }
    failures.renameThrowOnStagedSidecar = 'EBUSY'
    try {
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      expect(ctl.unlock('pw').state).toBe('unlocked')
      expect(failures.hits.renameStagedSidecar).toBeGreaterThan(0)
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 0, left: 1, setAside: 0 })
      unchanged()
      ctl.lock()
      expect(ctl.unlock('pw').state).toBe('unlocked') // the next unlock, the hold still there
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 0, left: 1, setAside: 0 })
      unchanged()
      ctl.shutdown()
      const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      next.init() // a fresh start, the hold still there
      unchanged()
      next.shutdown()
    } finally {
      failures.renameThrowOnStagedSidecar = null
    }
    const again = unlockedController(vp, 'pw') // the hold is gone
    try {
      expect(existsSync(staged)).toBe(false)
      expect(await readStoredCopy(again, vp.root, target)).toBe('the new copy')
      expect(again.takeSidecarStageOutcome()).toEqual({ rolledForward: 1, removed: 0, left: 0, setAside: 0 })
    } finally {
      again.shutdown()
    }
  })

  // Review round 2: before a swap the unlock also reads the stored copy under the data key (one that opens is current,
  // and is never swapped over). A stored copy it cannot read (a hold, an I/O error) is never swapped over either: the
  // stage stays a doubt, both stay byte for byte, and the retry swaps it in.
  it('a stage that opens under the data key beside a stored copy that cannot be read: both left as they are, the retry swaps it in', async () => {
    const { vp, target, staged, before } = await retiredCopyBesideStage()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    failures.openThrowOnSidecarTarget = target
    try {
      expect(ctl.unlock('pw').state).toBe('unlocked')
    } finally {
      failures.openThrowOnSidecarTarget = null
    }
    expect(readFileSync(target).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
    expect(failures.hits.openSyncSidecarTarget).toBeGreaterThan(0)
    expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 0, left: 1, setAside: 0 })
    ctl.lock()
    ctl.unlock('pw') // the hold is gone
    expect(existsSync(staged)).toBe(false)
    expect(await readStoredCopy(ctl, vp.root, target)).toBe('the new copy')
    ctl.shutdown()
  })

  // Review round 2: when the stage cannot be moved in AND the stored copy cannot be moved back, the stored copy waits at
  // `<stored copy>.tmp` for the session. That is no "left, judged again": the next start's sweep shreds it and renames
  // the stage into place, which loses nothing (the stage opens under the data key, and the copy set aside opened under
  // no key this workspace holds). It is counted apart, and the one log line says what the next start does.
  it('a stage that cannot be moved in, beside a stored copy that cannot be moved back: set aside, said in one line, finished by the next start', async () => {
    const { vp, target, staged, before } = await retiredCopyBesideStage()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    const linesBefore = readLogTail(100_000).length
    failures.renameThrowOnStagedSidecar = 'EBUSY'
    failures.renameThrowOnAsideRestore = 'EBUSY'
    let result: unknown
    try {
      result = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
    } finally {
      failures.renameThrowOnStagedSidecar = null
      failures.renameThrowOnAsideRestore = null
    }
    expect(failures.hits.renameAsideRestore).toBeGreaterThan(0)
    expect(result).toMatchObject({ ok: true })
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(`${target}.tmp`).equals(before[0]), 'the stored copy, set aside').toBe(true)
    expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
    const logged = readLogTail(100_000)
      .slice(linesBefore)
      .filter((line) => line.includes('(#1001)'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('"setAside":1')
    expect(logged[0]).toContain('the next start')
    ctl.shutdown()
    const next = unlockedController(vp, 'pw') // the next start: the copy set aside is shredded, the stage put in place
    try {
      expect(existsSync(`${target}.tmp`)).toBe(false)
      expect(existsSync(staged)).toBe(false)
      expect(readFileSync(target).equals(before[1])).toBe(true)
      expect(await readStoredCopy(next, vp.root, target)).toBe('the new copy')
    } finally {
      next.shutdown()
    }
  })

  // Review round 2: some network (SMB) and FUSE mounts report inode 0 and one link for every file, so a hard link of the
  // stored copy at the staged name is not told from two files by its ids. Its stored copy opens under the data key,
  // which a legitimate stage's never does (that one is under the retired key): only the staged name is removed.
  it('a hard link of the stored copy at the staged name, on a mount that reports no inode numbers: the document survives', async () => {
    const vp = lockedVault('recovery-guards-1001', 'pw')
    const target = await storedDocument(vp, 'pw')
    const staged = `${target}.new`
    linkSync(target, staged)
    const before = readFileSync(target)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.statReportsNoInode = true
    try {
      ctl.init()
      ctl.unlock('pw')
    } finally {
      failures.statReportsNoInode = false
    }
    expect(failures.hits.statNoInode).toBeGreaterThan(0)
    expect(existsSync(staged)).toBe(false)
    expect(readFileSync(target).equals(before), 'the stored copy').toBe(true)
    expect(await readStoredCopy(ctl, vp.root, target)).toBe('the copy under pw')
    expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    ctl.shutdown()
  })

  // Review round 3: the stored copy is judged by `lstat`, which never follows a link. A link at the stored copy's name
  // whose file sits outside the workspace used to pass as a regular file; the swap then moved the link aside and shred
  // it, writing random bytes THROUGH it into that outside file. A hard link to such a file does the same through its
  // other name. Now a stored copy that is no regular file, or whose file another name shares, is never swapped over: the
  // stage is left, and the outside file stays byte for byte. (A symbolic link needs a privilege some Windows accounts
  // lack; there the row stands the link in with `lstatSync` reporting one.)
  it.each<[string]>([['a symbolic link'], ['a hard link']])(
    "%s at the stored copy's name, to a file outside the workspace: the stage is left, the outside file byte for byte",
    async (kind) => {
      const { vp, target, staged, before } = await retiredCopyBesideStage()
      const outside = join(vp.root, 'outside.bin')
      writeFileSync(outside, before[0])
      rmSync(target)
      let standIn = false
      if (kind === 'a hard link') linkSync(outside, target)
      else {
        try {
          symlinkSync(outside, target, 'file')
        } catch {
          standIn = true
          writeFileSync(target, before[0])
          failures.lstatReportsSymlink = target
        }
      }
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      try {
        ctl.init()
        expect(ctl.unlock('pw').state).toBe('unlocked')
      } finally {
        failures.lstatReportsSymlink = null
      }
      expect(readFileSync(outside).equals(before[0]), 'the outside file').toBe(true)
      expect(readFileSync(target).equals(before[0]), "what the stored copy's name reads").toBe(true)
      expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
      if (kind === 'a symbolic link' && !standIn) expect(lstatSync(target).isSymbolicLink()).toBe(true)
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 0, left: 1, setAside: 0 })
      ctl.shutdown()
    }
  )

  // Review round 3: the cheap checks run before the stage is read. A planted stage of another length than the stored
  // copy (here a large frame from another workspace, which a read would stream through the decipher to its end) is
  // removed after a stat: the pass reads none of it (the format verdict at the unlock's head reads its 8-byte magic).
  it('a planted stage of another length is removed without being read', async () => {
    const vp = lockedVault('recovery-guards-1001', 'pw')
    const target = await storedDocument(vp, 'pw')
    const staged = `${target}.new`
    const other = lockedVault('recovery-guards-1001-other', 'other-pw')
    const seed = unlockedController(other, 'other-pw')
    const large = await storeCopy(seed, other.root, join(dirname(other.dbPath), 'documents', 'big.pdf.enc'), 'x'.repeat(256 * 1024))
    seed.lock()
    writeFileSync(staged, readFileSync(large))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    failures.stageBytesRead = 0
    ctl.unlock('pw')
    expect(existsSync(staged)).toBe(false)
    expect(failures.stageBytesRead).toBeLessThanOrEqual(8) // the format verdict's magic, and nothing of the frame
    expect(await readStoredCopy(ctl, vp.root, target)).toBe('the copy under pw')
    expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    ctl.shutdown()
  })
})

/** A locked workspace under `pw` whose stored copy `documents/d2.pdf.enc` is still under a retired key, with its new
 *  copy ('the new copy') staged beside it under the data key: a v1 → v2 password change cut short after its commit.
 *  With the bytes of both. (Function declarations are hoisted: the #1001 rows above use it too.) `logs` gives the paths
 *  a `logs/` folder, for the rotated log. */
async function retiredCopyBesideStage(
  opts: { logs?: boolean } = {}
): Promise<{ vp: FreshVaultPaths; target: string; staged: string; before: Buffer[] }> {
  const vp = lockedVault('recovery-guards-1001', 'pw', opts)
  const target = join(dirname(vp.dbPath), 'documents', 'd2.pdf.enc')
  const seed = unlockedController(vp, 'pw')
  const staged = await storeCopy(seed, vp.root, `${target}.new`, 'the new copy') // under the data key
  seed.lock()
  const src = join(vp.root, 'retired-src.txt')
  writeFileSync(src, 'the new copy')
  encryptFile(src, target, randomBytes(32)) // the stored copy, still under the retired key
  rmSync(src)
  return { vp, target, staged, before: [readFileSync(target), readFileSync(staged)] }
}

// #1015: a stage the rekey journal lists is swapped in by the start, with no key at hand. A swap the start cannot make
// (here a held stage: an antivirus or indexer that lets it be read and refuses a delete) threw out of `init()`, and in the
// app out of the backend start, before any IPC was registered; in a process that lives on, each unlock answered the raw
// error as "Could not open". Now the start reports its recovery as blocked, the unlock answers "try again" (the #242
// answer) with the error code in its log line and no path, and the retry finishes the swap once the hold is gone.
describe("a staged copy the journal lists that the start cannot swap in (#1015)", () => {
  it('a held stage: the start is blocked, the unlock answers vault_recovery_blocked with the code and no path, and the retry swaps it in', async () => {
    const { vp, target, staged, before } = await retiredCopyBesideStage()
    const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
    writeFileSync(journal, JSON.stringify({ version: 1, staged: [staged], remove: [] }))
    const journalBytes = readFileSync(journal)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    let result: unknown
    let logged: string[] = []
    failures.renameThrowOnStagedSidecar = 'EBUSY'
    try {
      expect(() => ctl.init()).not.toThrow()
      expect(ctl.isRecoveryBlocked()).toBe(true)
      expect(ctl.getState().state).toBe('locked')
      const linesBefore = readLogTail(100_000).length
      result = (await invoke(handlers, IPC.unlockWorkspace, 'pw')).result
      logged = readLogTail(100_000)
        .slice(linesBefore)
        .filter((line) => line.includes('the startup recovery is blocked'))
    } finally {
      failures.renameThrowOnStagedSidecar = null
    }
    expect(failures.hits.renameStagedSidecar).toBeGreaterThan(0)
    expect(result).toEqual({ ok: false, reason: 'vault_recovery_blocked', message: tMain('main.workspace.recoveryBlocked') })
    expect(readFileSync(staged).equals(before[1]), 'the stage').toBe(true)
    expect(readFileSync(journal).equals(journalBytes), 'the journal').toBe(true)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('EBUSY')
    expect(logged[0]).not.toContain(basename(vp.root))
    expect(ctl.unlock('pw').state).toBe('unlocked') // the hold is gone: the unlock finishes the swap first
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(journal)).toBe(false)
    expect(await readStoredCopy(ctl, vp.root, target)).toBe('the new copy')
    ctl.shutdown()
  })

  // Review R4: only a file error (a hold, a folder at the name, an I/O error) is the "try again" answer. Any other throw
  // in the recovery is a fault of the app, and it surfaces as it did, never as a permanent "try again" with no trace.
  it('an error that is no file error is not turned into "try again": it surfaces from the start as before', async () => {
    const { vp, staged } = await retiredCopyBesideStage()
    writeFileSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME), JSON.stringify({ version: 1, staged: [staged], remove: [] }))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.renameThrowsPlainErrorOnStagedSidecar = true
    try {
      expect(() => ctl.init()).toThrow(TypeError)
    } finally {
      failures.renameThrowsPlainErrorOnStagedSidecar = false
    }
    expect(failures.hits.renameStagedSidecar).toBeGreaterThan(0)
    expect(ctl.isRecoveryBlocked()).toBe(false)
  })

  // BUG vuln-scan-2026-06-21, moved here from workspace-vault.test.ts (#1015 round 3: its stand-in for a stuck file was a
  // folder at the target's name, which the swap now leaves aside without failing; a held file stands in here): a swap
  // that fails for ONE staged sidecar must not abandon the others, which would leave them under the retired key while the
  // controller already holds the new one.
  it('applyPendingRekey swaps every swappable sidecar even when one is stuck (BUG vuln-scan-2026-06-21)', () => {
    const vp = freshVaultPaths('recovery-guards-vuln-scan')
    const docsDir = join(dirname(vp.dbPath), 'documents')
    mkdirSync(docsDir, { recursive: true })
    // Two normal staged sidecars: target = old ciphertext, `.new` = the freshly re-keyed one.
    writeFileSync(join(docsDir, `a.enc`), 'OLD-A')
    writeFileSync(join(docsDir, `a.enc.new`), 'NEW-A')
    writeFileSync(join(docsDir, `c.enc`), 'OLD-C')
    writeFileSync(join(docsDir, `c.enc.new`), 'NEW-C')
    // A staged sidecar another program holds: its rename fails, for THIS file only, on both attempts.
    writeFileSync(join(docsDir, `bad.enc`), 'OLD-BAD')
    writeFileSync(join(docsDir, `bad.enc.new`), 'NEW-BAD')
    failures.renameThrowForStage = join(docsDir, `bad.enc.new`)
    try {
      // It surfaces the incomplete swap (the caller logs/recovers) …
      expect(() => applyPendingRekey(vp)).toThrow()
    } finally {
      failures.renameThrowForStage = null
    }
    expect(failures.hits.renameStagedSidecar).toBe(2) // the swap and its one retry
    // … but the swappable sidecars completed — the old code abandoned them after the first
    // failure, leaving them under the retired key (transiently undecryptable mid-session).
    expect(readFileSync(join(docsDir, `a.enc`), 'utf8')).toBe('NEW-A')
    expect(existsSync(join(docsDir, `a.enc.new`))).toBe(false)
    expect(readFileSync(join(docsDir, `c.enc`), 'utf8')).toBe('NEW-C')
    expect(existsSync(join(docsDir, `c.enc.new`))).toBe(false)
    // The stuck file stays staged for recoverPendingRekey on the next unlock (old-or-new, never mixed).
    expect(existsSync(join(docsDir, `bad.enc.new`))).toBe(true)
  })

  // Round 5: a pass that throws (one held stage) still settles the journal first. It used to throw before the settle, so
  // the journal went on listing the staged database it had just swapped in, and a stray `.enc.new` that turned up later
  // (here another workspace's) was "listed": the next start rolled it over `.enc` with no #973 key check. Now the journal
  // lists only the held stage, and the stray is a doubt the unlock removes.
  it('a swap that throws for one held stage after the staged database went in: the journal lists only that stage, and a stray staged database later is a doubt', async () => {
    const { vp, target, staged } = await retiredCopyBesideStage()
    const stagedDb = `${vp.encPath}${REKEY_SUFFIX}`
    copyFileSync(vp.encPath, stagedDb) // the database, staged under this workspace's own key
    const journal = journalListing(vp, [stagedDb, staged])
    const first = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.renameThrowForStage = staged
    try {
      expect(() => first.init()).not.toThrow()
    } finally {
      failures.renameThrowForStage = null
    }
    expect(failures.hits.renameStagedSidecar).toBe(2) // the swap and its one retry
    expect(first.isRecoveryBlocked()).toBe(true)
    expect(existsSync(stagedDb), 'the staged database, swapped in').toBe(false)
    expect(journalStaged(journal), 'the journal lists only the stage still waiting').toEqual([staged])
    writeFileSync(stagedDb, readFileSync(lockedVault('recovery-guards-stray', 'other-password').encPath))
    const enc = readFileSync(vp.encPath)
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(readFileSync(vp.encPath).equals(enc), '.enc after the next start').toBe(true)
    next.unlock('pw')
    expect(next.takeStageOutcome()).toBe('removed')
    expect(existsSync(stagedDb)).toBe(false)
    expect(await readStoredCopy(next, vp.root, target)).toBe('the new copy')
    next.shutdown()
  })

  // Round 6: the rewritten journal used to drop the `remove` list (`remove: []`). When the swap could not remove the
  // rotated log (another program held it), that was the last record of it, and the log stayed on the drive under the
  // retired key for good. Now the rewrite keeps asking for it while it is still there, and the next start removes it.
  it('a rotated log the swap could not remove, beside a held stage: the rewritten journal still asks for it, and the next start removes it', async () => {
    const { vp, target, staged } = await retiredCopyBesideStage({ logs: true })
    const rotated = join(vp.logsPath!, 'app.1.log.enc')
    writeFileSync(rotated, 'a log under the retired key')
    const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
    writeFileSync(journal, JSON.stringify({ version: 1, staged: [staged], remove: [rotated] }))
    const first = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.rmThrowFor = { path: rotated, code: 'EBUSY' }
    failures.renameThrowForStage = staged
    try {
      expect(() => first.init()).not.toThrow()
    } finally {
      failures.rmThrowFor = null
      failures.renameThrowForStage = null
    }
    expect(failures.hits.rmSync).toBeGreaterThan(0)
    expect(first.isRecoveryBlocked()).toBe(true)
    expect(readFileSync(rotated, 'utf8'), 'the held log').toBe('a log under the retired key')
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual({ version: 1, staged: [staged], remove: ['app.1.log.enc'] })
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(existsSync(rotated), 'the log, once it is free').toBe(false)
    expect(existsSync(journal)).toBe(false)
    next.unlock('pw')
    expect(await readStoredCopy(next, vp.root, target)).toBe('the new copy')
    next.shutdown()
  })

  // Round 6: what a pass counted reaches the log however the pass ends. A journal the pass could not remove (another
  // program held it) threw out of the settle before the count was reported, so the refused entry left no trace.
  it.each<[string, boolean]>([
    ['the roll-forward (a v2 descriptor)', false],
    ['the rollback (a v1 descriptor)', true]
  ])('a journal %s cannot remove: the start is blocked, and the entry it refused is still counted', (_pass, legacyV1) => {
    const vp = lockedVault('recovery-guards-1014', 'pw', { legacyV1 })
    const journal = journalListing(vp, [join(vp.root, 'notes.txt')]) // no stage at all: refused
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.rmThrowFor = { path: journal, code: 'EBUSY' }
    try {
      expect(() => ctl.init()).not.toThrow()
    } finally {
      failures.rmThrowFor = null
    }
    expect(failures.hits.rmSync).toBeGreaterThan(0)
    expect(ctl.isRecoveryBlocked()).toBe(true)
    expect(ctl.takeJournalRefusals()).toBe(1)
  })

  // Review V F-2 (probe P1, on the unlock path), moved here from workspace-vault.test.ts: the start's steps judge the
  // session an unclean end left, sweep it, and record the loss at their end. A hold the rekey recovery waits on (a staged
  // document copy an antivirus holds) stops them after the sweep, so the first unlock is refused; once the hold clears,
  // the retry must run the steps again (the descriptor was adopted, so "appeared" alone no longer said so) and record the
  // loss the first run judged. (The row used a folder at `.enc.new.tmp` before; since #1015 round 3 a folder at a temp
  // name holds no data and no longer stops the start.)
  it('an unclean end put back under the create form: the unlock records the lost session after a first unlock whose start steps stopped after the sweep', () => {
    const vp = freshVaultPaths('recovery-guards-f2')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(ctl.getState().state).toBe('uninitialized')
    const src = lockedVault('recovery-guards-f2-src', 'pw')
    backdate(src.encPath)
    endedUnlocked(src, 4242, 'pw')
    copyFileSync(src.descriptorPath, vp.descriptorPath)
    copyFileSync(src.encPath, vp.encPath)
    backdate(vp.encPath)
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(`${src.dbPath}${suffix}`, `${vp.dbPath}${suffix}`)
    // A password change cut short after its commit, with one document stage left to swap in.
    const docs = join(dirname(vp.dbPath), 'documents')
    mkdirSync(docs, { recursive: true })
    const staged = join(docs, 'd3.pdf.enc.new')
    writeFileSync(join(docs, 'd3.pdf.enc'), 'the old copy')
    writeFileSync(staged, 'the new copy')
    writeFileSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME), JSON.stringify({ version: 1, staged: [staged], remove: [] }))
    failures.renameThrowOnStagedSidecar = 'EBUSY'
    try {
      expect(() => ctl.unlock('pw')).toThrow(VaultRecoveryBlockedError)
      expect(ctl.isUnlocked()).toBe(false)
      expect(existsSync(vp.dbPath)).toBe(false) // the first run's sweep shredded the session
    } finally {
      failures.renameThrowOnStagedSidecar = null
    }
    expect(failures.hits.renameStagedSidecar).toBeGreaterThan(0)
    ctl.unlock('pw')
    expect(['unclean', 'unclean-full']).toContain(ctl.takeWorkingCopyLost()?.cause)
    ctl.lock()
  })
})

const OUT_OF_STORE_TEXT = 'the out-of-store copy'

/** A document row whose `stored_path` names `target`, outside `documents/` (issue #188's absolute paths). */
function outOfStoreRow(ctl: WorkspaceController, target: string): void {
  const now = new Date().toISOString()
  ctl
    .requireDb()
    .prepare(
      `INSERT INTO documents (id, title, stored_path, status, mime_type, created_at, updated_at)
       VALUES (?, ?, ?, 'indexed', 'text/plain', ?, ?)`
    )
    .run(`doc-${basename(target)}`, basename(target), target, now, now)
}

/** By the unlocked `seed` of `vp`: an out-of-store stored copy at `<dir>/<name>` (a row names it) still under a retired
 *  key, and its new copy (`OUT_OF_STORE_TEXT`) staged beside it under the data key: what a v1 → v2 password change cut
 *  short after its commit leaves. */
async function retiredOutOfStoreCopy(
  seed: WorkspaceController,
  vp: FreshVaultPaths,
  dir: string,
  name: string
): Promise<{ target: string; staged: string }> {
  const target = join(dir, name)
  const staged = await storeCopy(seed, vp.root, `${target}${REKEY_SUFFIX}`, OUT_OF_STORE_TEXT) // under the data key
  outOfStoreRow(seed, target)
  const src = join(vp.root, 'retired-src.txt')
  writeFileSync(src, OUT_OF_STORE_TEXT)
  encryptFile(src, target, randomBytes(32)) // the stored copy, still under the retired key
  rmSync(src)
  return { target, staged }
}

/** A rekey journal of `vp` that lists `staged`; returns its path. */
function journalListing(vp: FreshVaultPaths, staged: string[]): string {
  const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
  writeFileSync(journal, JSON.stringify({ version: 1, staged, remove: [] }))
  return journal
}

/** A locked workspace under `pw` with one {@link retiredOutOfStoreCopy} at `<dirOf>/outside.txt.enc` and a rekey journal
 *  that lists its stage. With the bytes of both files. */
async function outOfStoreCopyBesideStage(
  dirOf: (vp: FreshVaultPaths) => string
): Promise<{ vp: FreshVaultPaths; target: string; staged: string; journal: string; before: Buffer[] }> {
  const vp = lockedVault('recovery-guards-1014', 'pw')
  const seed = unlockedController(vp, 'pw')
  const { target, staged } = await retiredOutOfStoreCopy(seed, vp, dirOf(vp), 'outside.txt.enc')
  seed.lock()
  const journal = journalListing(vp, [staged])
  return { vp, target, staged, journal, before: [readFileSync(target), readFileSync(staged)] }
}

/** The `staged` list of the rekey journal at `journal`. */
const journalStaged = (journal: string): unknown => (JSON.parse(readFileSync(journal, 'utf8')) as { staged: unknown }).staged

// #1014 round 4: a stat that fails for a reason that proves nothing (a hold, a permission, an I/O error: anything but
// ENOENT, the #911 rule) read as "not inside the workspace folder" or as "not there". An out-of-store copy's journal
// entry was then refused and dropped from the rewritten journal, and that copy, which no scan finds, stayed under the
// retired key for good; at the unlock a stage it could not stat counted as already in place. Now such an entry is
// neither acted on nor dropped: the journal keeps it, and the next pass judges it again.
describe('a rekey journal entry a failed stat cannot judge (#1014 round 4)', () => {
  const inWorkspace = (vp: FreshVaultPaths): string => join(dirname(vp.dbPath), 'legacy-store')

  it.each<[string, (dir: string) => void]>([
    ['an lstat of its folder fails with EPERM', (dir) => void (failures.lstatThrow = { path: dir, code: 'EPERM' })],
    ['the realpath of its folder fails with EBUSY', (dir) => void (failures.realpathThrow = { path: dir, code: 'EBUSY' })]
  ])('an out-of-store copy inside the workspace folder where %s at the start: both files stay, the journal keeps the stage, the start counts it, and the unlock swaps it in', async (_case, arm) => {
    const { vp, target, staged, journal, before } = await outOfStoreCopyBesideStage(inWorkspace)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    arm(inWorkspace(vp))
    try {
      ctl.init()
    } finally {
      failures.lstatThrow = null
      failures.realpathThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(ctl.isRecoveryBlocked()).toBe(false)
    expect(readFileSync(target).equals(before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(staged).equals(before[1]), 'its stage').toBe(true)
    expect(journalStaged(journal), 'the journal keeps the stage').toEqual([staged])
    expect(ctl.takeJournalRefusals()).toBe(1)
    ctl.unlock('pw') // the recovery before the password judges it again
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(journal)).toBe(false)
    expect(await readStoredCopy(ctl, vp.root, target)).toBe(OUT_OF_STORE_TEXT)
    ctl.shutdown()
  })

  // A change rolled back before its commit (the descriptor still v1): the stage is neither removed nor dropped, and the
  // next start, which can judge it, removes it. The old password opens the copy as it was.
  it('a stage of a change rolled back before its commit, inside the workspace folder, where an lstat of its folder fails at the start: it stays, the journal keeps it, and the next start removes it', async () => {
    const vp = lockedVault('recovery-guards-1014', 'pw', { legacyV1: true })
    const seed = unlockedController(vp, 'pw')
    const target = await storeCopy(seed, vp.root, join(inWorkspace(vp), 'outside.txt.enc'), OUT_OF_STORE_TEXT) // the v1 key
    outOfStoreRow(seed, target)
    seed.lock()
    const { db, key } = unlockEncryptedVault(vp, 'pw')
    stageRekey(vp, db, key, randomBytes(32)) // staged, never committed
    db.close()
    const staged = `${target}${REKEY_SUFFIX}`
    const stage = readFileSync(staged)
    const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.lstatThrow = { path: inWorkspace(vp), code: 'EPERM' }
    try {
      ctl.init()
    } finally {
      failures.lstatThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(readFileSync(staged).equals(stage), 'the stage').toBe(true)
    expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`), 'the staged database').toBe(false)
    expect(journalStaged(journal), 'the journal keeps the stage').toEqual([staged])
    expect(ctl.takeJournalRefusals()).toBe(1)
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(journal)).toBe(false)
    next.unlock('pw')
    expect(await readStoredCopy(next, vp.root, target)).toBe(OUT_OF_STORE_TEXT)
    next.shutdown()
  })

  // At the unlock, only ENOENT proves a stage or its stored copy is not there. A stage it could not stat counted as
  // already in place, and the journal, its only record, was cleared; a stored copy it could not stat counted as gone, and
  // the stage was renamed over it with no shred and no check that the copy is not current.
  it.each<[string, (f: { target: string; staged: string }) => void]>([
    ["its stage's lstat fails with EPERM", (f) => void (failures.lstatThrow = { path: f.staged, code: 'EPERM' })],
    ["its stored copy's lstat fails with EACCES", (f) => void (failures.lstatThrow = { path: f.target, code: 'EACCES' })]
  ])('an out-of-store copy outside the workspace folder where %s at the unlock: both files stay, the journal keeps the stage, and the next unlock swaps it in', async (_case, arm) => {
    const f = await outOfStoreCopyBesideStage((vp) => join(vp.root, 'legacy-store'))
    const ctl = new WorkspaceController(f.vp, ENCRYPTION_REQUIRED, false)
    ctl.init() // the stage outside the workspace folder waits for the database
    arm(f)
    try {
      ctl.unlock('pw')
    } finally {
      failures.lstatThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(readFileSync(f.target).equals(f.before[0]), 'the stored copy').toBe(true)
    expect(readFileSync(f.staged).equals(f.before[1]), 'its stage').toBe(true)
    expect(journalStaged(f.journal), 'the journal keeps the stage').toEqual([f.staged])
    ctl.lock()
    ctl.unlock('pw')
    expect(existsSync(f.staged)).toBe(false)
    expect(existsSync(f.journal)).toBe(false)
    expect(await readStoredCopy(ctl, f.vp.root, f.target)).toBe(OUT_OF_STORE_TEXT)
    ctl.shutdown()
  })

  // A failure that lasts through a start and an unlock: the unlock's own pass, which settles the stages outside the
  // workspace folder and rewrites the journal, keeps the unjudged entry inside it too, and the next start swaps it in.
  it('an out-of-store copy inside the workspace folder left unjudged through a start and an unlock: the unlock swaps in the copy outside it and keeps this one, and the next start swaps it in', async () => {
    const vp = lockedVault('recovery-guards-1014', 'pw')
    const seed = unlockedController(vp, 'pw')
    const inside = await retiredOutOfStoreCopy(seed, vp, inWorkspace(vp), 'inside.txt.enc')
    const outside = await retiredOutOfStoreCopy(seed, vp, join(vp.root, 'legacy-store'), 'outside.txt.enc')
    seed.lock()
    const journal = journalListing(vp, [inside.staged, outside.staged])
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.lstatThrow = { path: inWorkspace(vp), code: 'EPERM' }
    try {
      ctl.init()
      ctl.unlock('pw')
    } finally {
      failures.lstatThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(existsSync(outside.staged), 'the stage outside the workspace folder').toBe(false)
    expect(await readStoredCopy(ctl, vp.root, outside.target)).toBe(OUT_OF_STORE_TEXT)
    expect(existsSync(inside.staged), 'the stage it could not judge').toBe(true)
    expect(journalStaged(journal), 'the journal keeps that stage only').toEqual([inside.staged])
    ctl.shutdown()
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(existsSync(inside.staged)).toBe(false)
    expect(existsSync(journal)).toBe(false)
    next.unlock('pw')
    expect(await readStoredCopy(next, vp.root, inside.target)).toBe(OUT_OF_STORE_TEXT)
    next.shutdown()
  })

  // A password change's own swap meets the same: the stage and its journal entry stay, the change counts it into the sum
  // the next unlock logs, and the next start, which can judge it, swaps it in.
  it('a password change whose swap cannot judge an out-of-store copy inside the workspace folder: the stage and the journal stay, the change counts it, and the next start swaps it in', async () => {
    const vp = lockedVault('recovery-guards-1014', 'pw', { legacyV1: true })
    const ctl = unlockedController(vp, 'pw')
    const target = await storeCopy(ctl, vp.root, join(inWorkspace(vp), 'outside.txt.enc'), OUT_OF_STORE_TEXT) // the v1 key
    outOfStoreRow(ctl, target)
    const staged = `${target}${REKEY_SUFFIX}`
    const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
    failures.lstatThrow = { path: inWorkspace(vp), code: 'EBUSY' }
    try {
      expect(ctl.changePassword('pw', 'next-password', FAST_ARGON).state).toBe('unlocked')
    } finally {
      failures.lstatThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(existsSync(staged), 'the stage').toBe(true)
    expect(journalStaged(journal), 'the journal keeps the stage').toEqual([staged])
    expect(ctl.takeJournalRefusals()).toBe(1)
    ctl.shutdown()
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(existsSync(staged)).toBe(false)
    expect(existsSync(journal)).toBe(false)
    next.unlock('next-password')
    expect(await readStoredCopy(next, vp.root, target)).toBe(OUT_OF_STORE_TEXT)
    next.shutdown()
  })

  // Round 6: an entry a pass could not judge stayed in the journal even after that pass swapped its stage in (the
  // staged database and the scanned in-store stages are found without the journal). The next start judged the entry
  // inside again, so a stray `.enc.new` at that name was "listed" and rolled over `.enc` with no #973 key check. Now an
  // entry a pass did not admit stays only while its stage is still there, or while a stat cannot tell.
  it('a staged database swapped in while a failed realpath left its entry unjudged: the journal no longer names it, and a stray staged database later is a doubt', () => {
    const vp = lockedVault('recovery-guards-1014', 'pw')
    const stagedDb = `${vp.encPath}${REKEY_SUFFIX}`
    copyFileSync(vp.encPath, stagedDb) // the database, staged under this workspace's own key
    const journal = journalListing(vp, [stagedDb])
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.realpathThrow = { path: dirname(vp.dbPath), code: 'EBUSY' }
    try {
      ctl.init() // a doubt while its entry cannot be judged: left for the unlock
      ctl.unlock('pw') // it opens under the data key: rolled forward by a pass that still cannot judge the entry
    } finally {
      failures.realpathThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(existsSync(stagedDb), 'the staged database, swapped in').toBe(false)
    expect(existsSync(journal), 'the journal').toBe(false)
    ctl.lock()
    writeFileSync(stagedDb, readFileSync(lockedVault('recovery-guards-stray', 'other-password').encPath))
    const enc = readFileSync(vp.encPath)
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(readFileSync(vp.encPath).equals(enc), '.enc after the next start').toBe(true)
    next.unlock('pw')
    expect(next.takeStageOutcome()).toBe('removed')
    next.shutdown()
  })

  // The same at the unlock's out-of-store pass, which settles the journal after the #1001 pass has judged the document
  // stages: one it swapped in while its entry was unjudged is no longer named, so a stray copy at that name later is a
  // doubt again, and the unlock removes it instead of the start rolling it over the stored copy.
  it('a document stage the unlock swapped in while a failed realpath left its entry unjudged: the journal no longer names it, and a stray copy there later is a doubt', async () => {
    const { vp, target, staged } = await retiredCopyBesideStage()
    const outside = join(vp.root, 'elsewhere', `x.txt.enc${REKEY_SUFFIX}`) // deferred: keeps the out-of-store pass running
    const journal = journalListing(vp, [staged, outside])
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    failures.realpathThrow = { path: dirname(vp.dbPath), code: 'EBUSY' }
    try {
      ctl.init()
      ctl.unlock('pw')
    } finally {
      failures.realpathThrow = null
    }
    expect(failures.hits.statThrow).toBeGreaterThan(0)
    expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 1, removed: 0, left: 0, setAside: 0 })
    expect(existsSync(journal), 'the journal').toBe(false)
    ctl.lock()
    const stray = await (async () => {
      const other = lockedVault('recovery-guards-stray', 'other-password')
      const seed = unlockedController(other, 'other-password')
      try {
        return readFileSync(await storeCopy(seed, other.root, join(dirname(other.dbPath), 'documents', 'd2.pdf.enc'), 'the new copy'))
      } finally {
        seed.lock()
      }
    })()
    writeFileSync(staged, stray)
    const stored = readFileSync(target)
    const next = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    next.init()
    expect(readFileSync(target).equals(stored), 'the stored copy after the next start').toBe(true)
    next.unlock('pw')
    expect(next.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    expect(await readStoredCopy(next, vp.root, target)).toBe('the new copy')
    next.shutdown()
  })
})

// #1014 round 3: the secure delete overwrites a regular file whose link count reads 0 as one of one link. Some drivers
// report 0 for every regular file, and treating that as "another name shares it" left the plaintext unlinked but whole
// on the drive. A descriptor held across the shred shows what was written in place.
describe('the secure delete where the drive reports no link count (#1014)', () => {
  it.each<[string, (path: string) => unknown]>([
    ['shredFile', (path) => shredFile(path)],
    ['shredFileWithin', (path) => shredFileWithin(path, { deadline: Number.MAX_SAFE_INTEGER, now: () => 0 })]
  ])('%s overwrites a file whose link count reads 0, then unlinks it', (_name, shred) => {
    const path = join(freshVaultPaths('recovery-guards-nlink').root, 'plain.bin')
    const plain = Buffer.alloc(64 * 1024, 0xa5)
    writeFileSync(path, plain)
    const view = openSync(path, 'r')
    try {
      failures.lstatReportsNoLinkCount = path
      try {
        shred(path)
      } finally {
        failures.lstatReportsNoLinkCount = null
      }
      expect(existsSync(path)).toBe(false)
      const after = Buffer.alloc(plain.length)
      expect(readSync(view, after, 0, after.length, 0)).toBe(plain.length)
      expect(after.equals(plain)).toBe(false)
    } finally {
      closeSync(view)
    }
  })
})
