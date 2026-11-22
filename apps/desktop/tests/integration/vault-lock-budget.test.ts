import { describe, it, expect, vi, beforeEach } from 'vitest'
import { closeSync, existsSync, linkSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { emergencyLock } from '../../src/main/shutdown'
import type { AppContext } from '../../src/main/services/context'
import { FILE_CHUNK_BYTES, WorkspaceController, encryptFile, type VaultPaths } from '../../src/main/services/workspace-vault'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import { ENCRYPTION_REQUIRED, lockedVault, unlockedController } from '../helpers/vault-fixtures'

// #982 (follow-ups wave 7, G-12 option a2): on Linux a log-out usually reaches the app as a lost session, which ends it
// with only Electron's `quit`, inside a fixed 10 s watchdog (measured: a 9.95 s lock exits 0, a 10.05 s one crashes with
// status 133 and leaves the working file in plaintext). The lock there re-encrypts the working file and then overwrote
// all of it, about twice the database's size in writes. The `quit` leg now passes a budget (`QUIT_LOCK_BUDGET_MS`, which
// shutdown.test.ts pins to that leg), and the overwrite stops at its deadline and unlinks the file: `.enc` is complete
// by then. These rows run the real chain (`emergencyLock` → `WorkspaceController.shutdown` → `lockEncryptedVault` → the
// budgeted overwrite) on a real vault, with a budget of their own (8.5 s), so their arithmetic is theirs.
//
// The witness is a hard link to the working file: it shares the file's blocks, so it shows what the overwrite wrote in
// place, and it keeps them readable after the lock unlinked the working file's name. The drive's time is modelled where
// a stick spends it: each `fdatasync` of the budgeted overwrite moves the test clock on by `drive.syncMs` (everything
// else in `node:fs` is the real module); the re-encrypt seam sets the clock to the moment the encrypt ended.
//
// What these rows do NOT prove: the real cost of a chunk's sync on a USB stick (owed: the D: measurement), nor
// Electron's watchdog itself (the WSL Electron kit of follow-ups wave 7, S).

const drive = vi.hoisted(() => ({
  /** The test clock, in ms: the clock the lock's budget is on. */
  t: 0,
  /** What one `fdatasync` costs on this drive: the clock moves on by this much per call. */
  syncMs: 0,
  /** `fdatasync` calls since the row began (only the budgeted overwrite makes them). */
  datasyncs: 0,
  /** While above 0, a positional write of a buffer writes at most this many bytes and returns that count (a short
   *  write); 0 = off. Armed by the re-encrypt seam from `shortWritesAfterEncrypt`, so only the overwrite meets it. */
  shortWriteMax: 0,
  shortWritesAfterEncrypt: 0
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const mocked = {
    ...actual,
    fdatasyncSync: vi.fn((fd: number) => {
      actual.fdatasyncSync(fd)
      drive.datasyncs += 1
      drive.t += drive.syncMs
    }),
    writeSync: vi.fn((...args: unknown[]): number => {
      const [fd, buffer, offset, length, position] = args
      if (drive.shortWriteMax > 0 && typeof buffer !== 'string' && typeof length === 'number') {
        const view = buffer as NodeJS.ArrayBufferView
        return actual.writeSync(fd as number, view, offset as number, Math.min(length, drive.shortWriteMax), position as number)
      }
      return (actual.writeSync as (...a: unknown[]) => number)(...args)
    })
  }
  return { ...mocked, default: mocked }
})

beforeEach(() => {
  drive.t = 0
  drive.syncMs = 0
  drive.datasyncs = 0
  drive.shortWriteMax = 0
  drive.shortWritesAfterEncrypt = 0
})

const PW = 'pw'
/** The budget these rows lock under (the value of `QUIT_LOCK_BUDGET_MS` today). */
const BUDGET_MS = 8_500
const CHUNK = FILE_CHUNK_BYTES
/** Plaintext the session wrote, recognisable in the working file's pages. */
const MARKER = Buffer.from('HR-982-PLAINTEXT ')
/** A working file of two whole overwrite chunks and a part of a third. */
const THREE_CHUNKS = 2 * CHUNK + 512 * 1024
const PAGE = 4096

interface Session {
  vp: VaultPaths
  ctl: WorkspaceController
  /** The hard link to the working file. */
  witness: string
  /** The working file as the lock had it when it encrypted it (the bytes the overwrite then meets). */
  encrypted: () => Buffer
}

/**
 * An unlocked session on a fresh vault: a table holding `bytes` of {@link MARKER}, `contextTokens: 4242`, and the
 * witness. Its re-encrypt is the real one; afterwards it keeps a copy of what it encrypted and sets the clock to
 * `clockAfterEncrypt` (the lock started at 0, so the encrypt took that long on this drive: the rate the overwrite's
 * first chunk is judged by).
 */
function session(bytes: number, clockAfterEncrypt = 0): Session {
  const vp = lockedVault('lock-budget', PW)
  const seen: { file: Buffer | null } = { file: null }
  const encrypt = (src: string, dest: string, key: Buffer): void => {
    encryptFile(src, dest, key)
    seen.file = readFileSync(src)
    drive.t = clockAfterEncrypt
    drive.shortWriteMax = drive.shortWritesAfterEncrypt
  }
  const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false, encrypt)
  ctl.init()
  ctl.unlock(PW)
  const db = ctl.requireDb()
  db.exec('CREATE TABLE hr982 (b BLOB)')
  db.prepare('INSERT INTO hr982 (b) VALUES (?)').run(Buffer.alloc(bytes, MARKER))
  updateSettings(db, { contextTokens: 4242 })
  const witness = join(vp.root, 'witness')
  linkSync(vp.dbPath, witness)
  return {
    vp,
    ctl,
    witness,
    encrypted: () => {
      if (!seen.file) throw new Error('the lock never encrypted the working file')
      return seen.file
    }
  }
}

/** The `quit` leg's kind of lock (`emergencyLock` with a budget, on the test clock unless `now` is given); returns its
 *  duration line's meta. */
function quitLegLock(ctl: WorkspaceController, now: () => number = () => drive.t): unknown {
  const lines: Array<[string, unknown]> = []
  const log = { error: (m: string, meta?: unknown) => void lines.push([m, meta]), info: (m: string, meta?: unknown) => void lines.push([m, meta]) }
  emergencyLock(
    { workspace: ctl } as unknown as AppContext,
    { now, detachVaultKey: () => undefined, killSidecarChildren: () => undefined, log },
    { budgetMs: BUDGET_MS }
  )
  return lines.find(([m]) => m === 'emergency lock: finished')?.[1]
}

/** #208's shred survivor in place: the whole file overwritten with noise through another handle. */
function noiseInPlace(path: string): void {
  const size = statSync(path).size
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, randomBytes(size), 0, size, 0)
  } finally {
    closeSync(fd)
  }
}

/** How many 4 KiB pages of `after` still hold `before`'s bytes (an overwritten page does not: the overwrite is random). */
function pagesLeft(before: Buffer, after: Buffer): number {
  let left = 0
  for (let at = 0; at < before.length; at += PAGE) {
    if (after.subarray(at, at + PAGE).equals(before.subarray(at, at + PAGE))) left++
  }
  return left
}

describe('the Linux quit leg’s lock overwrites the working file only as far as its budget lets it (#982)', () => {
  it('a deadline already past when the encrypt ends: nothing is overwritten, the file is unlinked, and .enc opens with the session in a fresh start', () => {
    const s = session(1024 * 1024, BUDGET_MS + 500) // the steps up to the encrypt's end ran past the deadline
    expect(quitLegLock(s.ctl)).toEqual({ durationMs: BUDGET_MS + 500, lockFailed: false, shredCut: true })
    expect(existsSync(s.vp.dbPath)).toBe(false)
    expect(drive.datasyncs).toBe(0)
    expect(readFileSync(s.witness).equals(s.encrypted())).toBe(true) // not one byte written over
    const next = unlockedController(s.vp, PW)
    expect(getSettings(next.requireDb()).contextTokens).toBe(4242)
    next.lock()
  })

  it('a clock that passes the deadline after two chunks: exactly two chunks are overwritten, then the file is unlinked', () => {
    drive.syncMs = 1_500 // one 8 MiB chunk's sync on this drive
    const s = session(THREE_CHUNKS, 4_000)
    // The encrypt ends at 4.0 s; by its rate a chunk takes under 2 s, so the first starts (4.0 + 1.5 × 1.9 < 8.5) and
    // ends at 5.5 s; the second fits (5.5 + 1.5 × 1.5 = 7.75) and ends at 7.0 s; the third would not (7.0 + 2.25).
    expect(quitLegLock(s.ctl)).toMatchObject({ lockFailed: false, shredCut: true })
    expect(drive.datasyncs).toBe(2)
    expect(existsSync(s.vp.dbPath)).toBe(false)
    const before = s.encrypted()
    const after = readFileSync(s.witness)
    expect(pagesLeft(before.subarray(0, 2 * CHUNK), after.subarray(0, 2 * CHUNK))).toBe(0)
    expect(after.subarray(0, 2 * CHUNK).includes(MARKER)).toBe(false)
    // The rest held the session's plaintext and was left as it was: freed blocks of an unlinked file, not a readable one.
    expect(before.subarray(2 * CHUNK).includes(MARKER)).toBe(true)
    expect(after.subarray(2 * CHUNK).equals(before.subarray(2 * CHUNK))).toBe(true)
  })

  // The first chunk has no time of its own: started on no estimate right before the deadline, it would run past it by a
  // whole chunk (0.8 s at 10 MB/s in the WSL kit; more on a USB 2 stick), the margin the watchdog leaves. The encrypt
  // that just wrote the same bytes to the same drive is the estimate.
  it('the first chunk is judged by the encrypt’s rate: after a slow encrypt that leaves less than a chunk’s time, none starts', () => {
    drive.syncMs = 160
    const s = session(THREE_CHUNKS, 6_000) // the encrypt took 6 s: about 2.9 s per 8 MiB on this drive
    // 6.0 + 1.5 × 2.9 > 8.5: the overwrite stops before its first chunk, though the deadline itself has not passed.
    expect(quitLegLock(s.ctl)).toMatchObject({ lockFailed: false, shredCut: true })
    expect(drive.datasyncs).toBe(0)
    expect(existsSync(s.vp.dbPath)).toBe(false)
    expect(readFileSync(s.witness).equals(s.encrypted())).toBe(true)
  })

  // A write may write less than it was asked to (a full page cache, a signal): the overwrite writes on from where it
  // stopped, so it counts only what reached the file and `shredCut` stays honest.
  it('short writes: the overwrite writes on until each chunk is whole, so every byte is overwritten and nothing is reported cut', () => {
    drive.shortWritesAfterEncrypt = 1024 * 1024 // every write of the overwrite lands at most 1 MiB
    const s = session(THREE_CHUNKS)
    expect(quitLegLock(s.ctl)).toMatchObject({ lockFailed: false, shredCut: false })
    expect(drive.datasyncs).toBe(3) // still one sync per whole chunk
    expect(pagesLeft(s.encrypted(), readFileSync(s.witness))).toBe(0)
    expect(existsSync(s.vp.dbPath)).toBe(false)
  })

  // #855: a working file gone or no longer a database holds nothing newer than `.enc`, so the lock finishes at the last
  // snapshot and shreds what is left. Under the budget that overwrite stops at the deadline too.
  it('a working file that is no database any more (#855), past the deadline: not overwritten, unlinked, the lock finishes at the last snapshot', () => {
    const s = session(1024 * 1024)
    s.ctl.requireDb().exec('PRAGMA wal_checkpoint(TRUNCATE);')
    noiseInPlace(s.vp.dbPath)
    const noise = readFileSync(s.vp.dbPath)
    let reads = 0
    // The lock starts at 0; by the time it reaches the shred its steps (the checkpoint, the probe) ran past the deadline.
    const finished = quitLegLock(s.ctl, () => (reads++ === 0 ? 0 : BUDGET_MS + 500))
    expect(finished).toMatchObject({ lockFailed: false, shredCut: true })
    expect(existsSync(s.vp.dbPath)).toBe(false)
    expect(readFileSync(s.witness).equals(noise)).toBe(true) // not one byte written over
    expect(s.ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
  })

  it('a far deadline: every byte is overwritten, a sync per chunk, and nothing is reported cut', () => {
    drive.syncMs = 160
    const s = session(THREE_CHUNKS)
    expect(quitLegLock(s.ctl)).toMatchObject({ lockFailed: false, shredCut: false })
    expect(drive.datasyncs).toBe(3)
    const before = s.encrypted()
    const after = readFileSync(s.witness)
    expect(after.length).toBe(before.length)
    expect(pagesLeft(before, after)).toBe(0)
    expect(after.includes(MARKER)).toBe(false)
  })

  // No budget: Lock now (the lock IPC) and every lock but the `quit` leg's. The whole file is overwritten as before,
  // with the one sync at its end: a sync per chunk costs more on a USB stick, and these locks have no deadline to keep.
  it.each<[string, (ctl: WorkspaceController) => void]>([
    ['Lock now', (ctl) => void ctl.lock()],
    [
      'the emergency lock of a session end, a signal or a crash',
      (ctl) =>
        emergencyLock({ workspace: ctl } as unknown as AppContext, {
          now: () => drive.t,
          detachVaultKey: () => undefined,
          killSidecarChildren: () => undefined,
          log: { error: () => undefined, info: () => undefined }
        })
    ]
  ])('no budget (%s): the whole file is overwritten as before, with no per-chunk sync', (_lock, lock) => {
    const s = session(1024 * 1024, BUDGET_MS + 500) // a clock past any deadline: none may apply here
    lock(s.ctl)
    expect(existsSync(s.vp.dbPath)).toBe(false)
    expect(pagesLeft(s.encrypted(), readFileSync(s.witness))).toBe(0)
    expect(drive.datasyncs).toBe(0)
  })
})
