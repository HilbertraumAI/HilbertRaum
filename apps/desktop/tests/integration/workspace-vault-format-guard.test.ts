import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { SCHEMA_VERSION, openDatabase } from '../../src/main/services/db'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import { decrypt, deriveKey, generateDataKey, verifyKey } from '../../src/main/services/security/crypto'
import {
  RECOVERY_SUFFIX,
  REKEY_JOURNAL_NAME,
  REKEY_SUFFIX,
  VaultDescriptorMissingError,
  WORKING_COPY_LOST_MARKER,
  WorkspaceController,
  WorkspaceExistsError,
  cleanSidecars,
  encryptFile,
  readVaultDescriptorChecked,
  rewrapVaultKey,
  shredFile,
  stageRekey,
  unlockEncryptedVault,
  vaultFormatVerdict
} from '../../src/main/services/workspace-vault'
import {
  ENCRYPTION_REQUIRED,
  FAST_KDF,
  backdate,
  editDescriptor,
  failedLockState,
  freshVaultPaths,
  lockedVault,
  setFrameMagic,
  thrownBy,
  unlockedController,
  writeNewerSchema,
  type FreshVaultPaths
} from '../helpers/vault-fixtures'

// #845 — the vault format guard. Every build shipped before it reads only an upper-bound-free descriptor and an
// equality-checked `.enc` magic, so a workspace a NEWER build wrote (a multi-OS Kit where one OS's app was updated,
// a rollback) was misread: a v3 descriptor that keeps `dataKey` passed for v2 (and a password change rewrote it as
// v2), and the startup sweep, the pending-rekey recovery and the `.recovery` roll-forward ran over it. This build
// classifies the descriptor, its KDF, the `.enc` / `.enc.new` frames and the rekey journal BEFORE anything is
// written, at startup (`init()`) and at the head of every unlock, and refuses with `VaultNewerError`.
//
// Every row hashes every file under `config/` and `workspace/` before and after and requires them byte-identical;
// every row that plants an artifact first checks it is there, so the refusal is reached with it present.

const PW = 'right-password'

/** sha256 of every file under `config/` and `workspace/` (directories listed too), keyed by path under `root`. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = relative(root, full).split('\\').join('/')
      if (statSync(full).isDirectory()) {
        out[`${rel}/`] = 'dir'
        walk(full)
      } else {
        out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
      }
    }
  }
  for (const top of ['config', 'workspace']) {
    if (existsSync(join(root, top))) walk(join(root, top))
  }
  return out
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A staged `.enc.new` in this build's frame (`HRAUMEN1`), but under a key no descriptor wraps: if it were ever
 *  swapped in, `.enc` would change, and the vault would be lost. Its plaintext source lies outside the hashed tree. */
function stagedFrame(vp: FreshVaultPaths): string {
  const src = join(vp.root, 'staged-src.bin')
  writeFileSync(src, randomBytes(4096))
  const staged = `${vp.encPath}${REKEY_SUFFIX}`
  encryptFile(src, staged, randomBytes(32))
  return staged
}

/** A rekey journal of `version` naming `staged`. */
function rekeyJournal(vp: FreshVaultPaths, version: unknown, staged: string[]): string {
  const path = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
  writeFileSync(path, JSON.stringify({ version, staged, remove: [] }, null, 2), 'utf8')
  return path
}

/** The three bytes of a UTF-8 byte-order mark (U+FEFF), which some editors and tools put in front of a file (#974). */
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** The file at `path` with a byte-order mark put in front of it, the rest byte for byte (#974). */
function prependBom(path: string): string {
  writeFileSync(path, Buffer.concat([BOM, readFileSync(path)]))
  return path
}

/** A descriptor of version 3, keeping or dropping its `dataKey`. */
const version3 =
  (keepDataKey: boolean) =>
  (d: Record<string, unknown>): void => {
    d.version = 3
    if (!keepDataKey) delete d.dataKey
  }

/** A plaintext file at `path` (its folder created). */
function plant(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

interface NewerCase {
  /** Plants the newer artifact (and any crash leftovers) on a locked vault under `PW`; returns every path planted. */
  arrange: (vp: FreshVaultPaths) => string[]
  what: 'descriptor' | 'kdf' | 'frame' | 'journal'
  found: string | number
}

describe('a vault a newer build wrote is refused at startup and at unlock, and left byte for byte (#845)', () => {
  it.each<[string, NewerCase]>([
    [
      'a descriptor of version 3 that keeps its dataKey (before: read as v2 and unlocked)',
      { arrange: (vp) => [editDescriptor(vp, version3(true)).descriptorPath], what: 'descriptor', found: 3 }
    ],
    [
      'a descriptor of version 3 without a dataKey (before: "missing or unreadable")',
      { arrange: (vp) => [editDescriptor(vp, version3(false)).descriptorPath], what: 'descriptor', found: 3 }
    ],
    // Any number above 2 is newer, integer or not, and so is a numeric string: each passed for v2 before (it keeps
    // `dataKey`), unlocked, and its next lock rewrote `.enc` (W2 review finding 1).
    ...([3.5, 2.5, '3'] as const).map((version): [string, NewerCase] => [
      `a descriptor of version ${JSON.stringify(version)} that keeps its dataKey (before: read as v2 and unlocked)`,
      {
        arrange: (vp) => [
          editDescriptor(vp, (d) => {
            d.version = version
          }).descriptorPath
        ],
        what: 'descriptor',
        found: version
      }
    ]),
    [
      'a v2 descriptor naming a KDF this build does not know (before: "Unsupported KDF")',
      {
        arrange: (vp) => [
          editDescriptor(vp, (d) => {
            ;(d.kdf as Record<string, unknown>).algo = 'balloon'
          }).descriptorPath
        ],
        what: 'kdf',
        found: 'balloon'
      }
    ],
    [
      'an .enc in a newer frame, HRAUMEN2 (before: "unrecognised header")',
      {
        arrange: (vp) => {
          setFrameMagic(vp.encPath, 'HRAUMEN2')
          return [vp.encPath]
        },
        what: 'frame',
        found: '2'
      }
    ],
    [
      'a staged .enc.new in a newer frame beside a v2 descriptor (before: swapped in over .enc at startup)',
      {
        arrange: (vp) => {
          const staged = stagedFrame(vp)
          setFrameMagic(staged, 'HRAUMEN2')
          return [staged]
        },
        what: 'frame',
        found: '2'
      }
    ],
    [
      'a rekey journal of version 2 and a staged .enc.new beside a v2 descriptor (before: swapped in, journal quarantined)',
      {
        arrange: (vp) => {
          const staged = stagedFrame(vp)
          return [staged, rekeyJournal(vp, 2, [staged])]
        },
        what: 'journal',
        found: 2
      }
    ],
    [
      // #974: Node keeps a byte-order mark when it decodes UTF-8, and `JSON.parse` refuses it, so the format verdict
      // read no version, and the recovery swapped the stage in and quarantined the journal as unreadable.
      'a rekey journal of version 2 saved with a byte-order mark, and a staged .enc.new beside a v2 descriptor (before: read as no journal, swapped in)',
      {
        arrange: (vp) => {
          const staged = stagedFrame(vp)
          return [staged, prependBom(rekeyJournal(vp, 2, [staged]))]
        },
        what: 'journal',
        found: 2
      }
    ],
    [
      'a rekey journal of version 2.5 and a staged .enc.new beside a v2 descriptor (before: quarantined as corrupt, swapped in)',
      {
        arrange: (vp) => {
          const staged = stagedFrame(vp)
          return [staged, rekeyJournal(vp, 2.5, [staged])]
        },
        what: 'journal',
        found: 2.5
      }
    ],
    [
      'a staged document copy in a newer frame beside a v2 descriptor, no journal (before: swapped over the stored copy)',
      {
        arrange: (vp) => {
          // The scan finds `documents/*.enc.new` without any journal; under a v2 descriptor every shipped build
          // swaps it over the stored copy (W2 review finding 3).
          const docs = join(dirname(vp.dbPath), 'documents')
          const stored = plant(join(docs, 'a.pdf.enc'), 'stored copy')
          const staged = plant(join(docs, 'a.pdf.enc.new'), 'staged copy, a newer build')
          setFrameMagic(staged, 'HRAUMEN2')
          return [stored, staged]
        },
        what: 'frame',
        found: '2'
      }
    ],
    [
      'a rekey journal of version 2 and its stage with no descriptor and no .enc (before: "no workspace", create offered over it)',
      {
        arrange: (vp) => {
          // A newer build's stage alone: what remains is still its vault, so it is never offered the create flow
          // (the create would swap its own `.enc.new` in and leave the journal behind it).
          rmSync(vp.descriptorPath)
          rmSync(vp.encPath)
          const staged = stagedFrame(vp)
          return [staged, rekeyJournal(vp, 2, [staged])]
        },
        what: 'journal',
        found: 2
      }
    ],
    [
      'a failed lock’s leftovers beside a version 3 descriptor that keeps its dataKey (before: salvaged, swept, rolled forward)',
      {
        arrange: (vp) => {
          // A cleanly closed working database newer than `.enc` (the salvage signature), the decrypt temp, transient
          // document and image copies, and a committed-looking password-change stage with its journal.
          const { db } = unlockEncryptedVault(vp, PW)
          db.close()
          backdate(vp.encPath)
          const ws = dirname(vp.dbPath)
          const planted = [
            vp.dbPath,
            plant(`${vp.dbPath}.tmp`, 'decrypt temp'),
            plant(join(ws, 'documents', 'x.parse.pdf'), '%PDF-1.7'),
            plant(join(ws, 'images', 'y.tmp'), 'image temp')
          ]
          const staged = stagedFrame(vp)
          planted.push(staged, rekeyJournal(vp, 1, [staged]))
          editDescriptor(vp, version3(true))
          return planted
        },
        what: 'descriptor',
        found: 3
      }
    ],
    [
      'a mid-session crash’s working file and -wal beside a version 3 descriptor that keeps its dataKey (before: shredded)',
      {
        arrange: (vp) => {
          const { db } = unlockEncryptedVault(vp, PW)
          db.close()
          const planted = [vp.dbPath, plant(`${vp.dbPath}-wal`, 'wal pages'), plant(`${vp.dbPath}-shm`, 'shm')]
          editDescriptor(vp, version3(true))
          return planted
        },
        what: 'descriptor',
        found: 3
      }
    ],
    [
      'a .recovery newer than .enc beside a version 3 descriptor that keeps its dataKey (before: rolled forward over .enc)',
      {
        arrange: (vp) => {
          const { db } = unlockEncryptedVault(vp, PW)
          db.close()
          const recovery = `${vp.dbPath}${RECOVERY_SUFFIX}`
          renameSync(vp.dbPath, recovery)
          backdate(vp.encPath)
          editDescriptor(vp, version3(true))
          return [recovery]
        },
        what: 'descriptor',
        found: 3
      }
    ]
  ])('%s', (_case, c) => {
    const vp = lockedVault('fmtguard', PW)
    const planted = c.arrange(vp)
    for (const path of planted) expect(existsSync(path), path).toBe(true)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).toMatchObject({ state: 'locked', mode: 'encrypted' })
      // Refused before the password is checked: the newer format's verifier may differ, so the right and a wrong
      // password get the same answer.
      for (const password of [PW, 'wrong-password']) {
        expect(thrownBy(() => ctl.unlock(password)), password).toEqual({
          name: 'VaultNewerError',
          what: c.what,
          found: c.found
        })
      }
      // Still a vault: the create flow is refused.
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(WorkspaceExistsError)
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })
})

// #985 (W-66): a working copy or `.recovery` a NEWER build left, stamped above this build's schema version, whose schema
// this SQLite cannot parse: every schema read fails with SQLITE_CORRUPT, so the probe called it damaged, and the start's
// salvage, the start with `.enc` missing and the unlock's roll-forward shredded it (the newer build's last session, or
// the whole workspace). Each is now kept byte for byte, and the unlock refuses it as the open refuses a newer database
// (`WorkspaceNewerError` → `workspace_newer`, "written by a newer HilbertRaum") before anything is written. No #875 marker
// and no loss notice: nothing was lost.
describe('a working copy or .recovery a newer build stamped is kept, never discarded (#985)', () => {
  const recoveryOf = (vp: FreshVaultPaths): string => `${vp.dbPath}${RECOVERY_SUFFIX}`
  const NEWER = { name: 'WorkspaceNewerError', found: SCHEMA_VERSION + 1 }

  it('a failed lock’s working copy: the start keeps it as .recovery, the unlock refuses it, both files byte for byte', () => {
    const vp = lockedVault('fmtguard-985', PW)
    failedLockState(vp, 7171, PW) // closed, newer than `.enc` (backdated): the salvage signature
    writeNewerSchema(vp.dbPath)
    const working = sha(vp.dbPath)
    const enc = sha(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(vp.dbPath)).toBe(false)
      expect(sha(recoveryOf(vp))).toBe(working)
      expect(ctl.getState()).toEqual({ state: 'locked', mode: 'encrypted', plaintextAllowed: false, encryptionRequired: true })
      expect(existsSync(join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER))).toBe(false)
      expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
      expect(thrownBy(() => ctl.unlock(PW))).toEqual(NEWER)
      expect(sha(recoveryOf(vp))).toBe(working)
      expect(sha(vp.encPath)).toBe(enc)
      expect(existsSync(vp.dbPath)).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  it('the only copy, with .enc missing: the start keeps it as .recovery, the unlock refuses it, the copy byte for byte', () => {
    const vp = lockedVault('fmtguard-985', PW)
    failedLockState(vp, 7171, PW)
    writeNewerSchema(vp.dbPath)
    rmSync(vp.encPath)
    const working = sha(vp.dbPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(sha(recoveryOf(vp))).toBe(working)
      expect(ctl.discardedOnlyCopy()).toBe(false)
      expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'encrypted_file_missing' })
      expect(thrownBy(() => ctl.unlock(PW))).toEqual(NEWER)
      expect(sha(recoveryOf(vp))).toBe(working)
      expect(existsSync(vp.encPath)).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  // Whatever its age: one older than `.enc` looks like a spent leftover, which the roll-forward shreds, and this build
  // cannot tell a newer build's copy from one.
  it.each<[string, number]>([
    ['newer than .enc', 0],
    ['older than .enc', 120_000]
  ])('a .recovery %s: the unlock refuses it before anything is written, every file byte for byte', (_age, olderBy) => {
    const vp = lockedVault('fmtguard-985', PW)
    failedLockState(vp, 7171, PW) // `.enc` backdated 60 s
    writeNewerSchema(vp.dbPath)
    renameSync(vp.dbPath, recoveryOf(vp))
    if (olderBy > 0) backdate(recoveryOf(vp), olderBy)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      const before = snapshot(vp.root)
      expect(before['workspace/hilbertraum.sqlite.recovery']).toBeDefined()
      expect(thrownBy(() => ctl.unlock(PW))).toEqual(NEWER)
      expect(ctl.isUnlocked()).toBe(false)
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })
})

// Startup's verdict must not outlive the files it judged (W2 review finding 2): once the newer artifact is gone while
// the app runs, the next unlock or create re-judges the disk, and startup's skipped work (the failed-lock salvage)
// runs before anything is decrypted.
describe('a newer verdict is re-checked once the newer artifact is gone (#845)', () => {
  it('a failed lock’s newer working file survives an unlock after the descriptor is repaired mid-session', () => {
    const vp = lockedVault('fmtguard', PW)
    const MARKER = 6144
    failedLockState(vp, MARKER, PW) // a closed working file holding MARKER, newer than `.enc` (backdated)
    const descriptor = readFileSync(vp.descriptorPath)
    editDescriptor(vp, version3(true))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(thrownBy(() => ctl.unlock(PW)).name).toBe('VaultNewerError')
      expect(existsSync(vp.dbPath)).toBe(true) // startup left the fresh working file alone
      writeFileSync(vp.descriptorPath, descriptor) // repaired (the newer copy rolled back) while the app runs
      expect(ctl.unlock(PW).state).toBe('unlocked')
      // The salvage ran first and rolled the fresh file forward: the stale `.enc` was not decrypted over it.
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(MARKER)
      expect(ctl.newerVaultFormat()).toBeNull()
    } finally {
      ctl.shutdown()
    }
  })

  // W2 review 2: a startup whose failed-lock salvage was BLOCKED (a held `.recovery`, #242), then a newer descriptor:
  // the unlock re-runs init(), which must re-decide every per-start flag, so the answer is "newer", not the stale
  // "recovery blocked". A non-empty directory on the `.recovery` name makes the salvage fail on every OS.
  it('a blocked salvage followed by a newer descriptor answers newer at unlock, and touches nothing', () => {
    const vp = lockedVault('fmtguard', PW)
    failedLockState(vp, 7171, PW)
    plant(join(`${vp.dbPath}${RECOVERY_SUFFIX}`, 'held.bin'), 'a hold')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.isRecoveryBlocked()).toBe(true)
      editDescriptor(vp, version3(true))
      const before = snapshot(vp.root)
      expect(thrownBy(() => ctl.unlock(PW))).toEqual({ name: 'VaultNewerError', what: 'descriptor', found: 3 })
      expect(ctl.isRecoveryBlocked()).toBe(false)
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })

  it('the create flow opens again once a newer build’s lone leftovers are gone', () => {
    const vp = freshVaultPaths('fmtguard')
    const staged = stagedFrame(vp)
    const journal = rekeyJournal(vp, 2, [staged])
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(WorkspaceExistsError)
      rmSync(journal)
      rmSync(staged)
      expect(ctl.create('another-password', 'encrypted').state).toBe('unlocked')
    } finally {
      ctl.shutdown()
    }
  })
})

describe('a password change re-reads the descriptor on disk before it writes (#845)', () => {
  it('refuses when the descriptor on disk became version 3 mid-session, and does not downgrade it', () => {
    const vp = lockedVault('fmtguard', PW)
    const ctl = unlockedController(vp, PW)
    try {
      editDescriptor(vp, version3(true))
      const before = snapshot(vp.root)
      expect(thrownBy(() => ctl.changePassword(PW, 'next-password-1', FAST_KDF))).toEqual({
        name: 'VaultNewerError',
        what: 'descriptor',
        found: 3
      })
      expect(snapshot(vp.root)).toEqual(before)
      expect(ctl.isUnlocked()).toBe(true)
    } finally {
      ctl.shutdown()
    }
  })

  it('refuses when the descriptor on disk is no longer the one this session unlocked, and changes once it is again', () => {
    const vp = lockedVault('fmtguard', PW)
    const own = readFileSync(vp.descriptorPath)
    const other = lockedVault('fmtguard', PW) // another vault, same password: its descriptor verifies too
    const ctl = unlockedController(vp, PW)
    try {
      copyFileSync(other.descriptorPath, vp.descriptorPath)
      const before = snapshot(vp.root)
      expect(thrownBy(() => ctl.changePassword(PW, 'next-password-1', FAST_KDF)).name).toBe('Error')
      expect(snapshot(vp.root)).toEqual(before)
      // The session's own descriptor back: the change goes through, and so does a second one in the same session
      // (the descriptor in memory is then the one the first change built).
      writeFileSync(vp.descriptorPath, own)
      ctl.changePassword(PW, 'next-password-1', FAST_KDF)
      ctl.changePassword('next-password-1', 'next-password-2', FAST_KDF)
      ctl.lock()
      const reopened = unlockedController(vp, 'next-password-2')
      expect(reopened.isUnlocked()).toBe(true)
      reopened.shutdown()
    } finally {
      ctl.shutdown()
    }
  })
})

// #974: Node keeps a UTF-8 byte-order mark when it decodes a file, and `JSON.parse` refuses it, so each of the vault's
// small JSON state files read as unreadable with one in front (the descriptor: the golden table above; the format
// verdict's read of the rekey journal: the newer-journal row of the first table). One mark is removed before the
// parse, by all four readers; the app writes none.
describe('the vault state files read past one byte-order mark (#974)', () => {
  it('a password change cut short after its commit, its journal saved with a byte-order mark: the start rolls it forward and quarantines nothing', () => {
    const vp = lockedVault('fmtguard-974', PW, { legacyV1: true })
    const { db, key } = unlockEncryptedVault(vp, PW)
    updateSettings(db, { contextTokens: 7474 })
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'next-password', FAST_KDF) // the COMMIT; the crash comes before the swap
    db.close()
    key.fill(0)
    dataKey.fill(0)
    shredFile(vp.dbPath) // the session the crash left, as the start's sweep removes it
    cleanSidecars(vp.dbPath)
    const journal = prependBom(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
      expect(existsSync(journal)).toBe(false)
      expect(existsSync(`${journal}.corrupt`)).toBe(false)
      ctl.unlock('next-password')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(7474)
    } finally {
      ctl.shutdown()
    }
  })

  it('the #875 marker saved with a byte-order mark is still this build’s: the lock screen shows its notice, the unlock consumes it', () => {
    const vp = lockedVault('fmtguard-974', PW)
    const enc = readFileSync(vp.encPath).subarray(8, 20).toString('base64') // the IV of `.enc`'s frame, which a marker names
    const marker = join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER)
    writeFileSync(marker, Buffer.concat([BOM, Buffer.from(JSON.stringify({ v: 1, enc, cause: 'lock' }), 'utf8')]))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'working_copy_lost' })
      ctl.unlock(PW)
      expect(ctl.takeWorkingCopyLost()).toEqual({ cause: 'lock', lostAt: expect.any(String) })
      expect(existsSync(marker)).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  // One mark only: the mark alone, or two marks in front of the JSON, is no file any build wrote.
  it.each<[string, (json: Buffer) => Buffer]>([
    ['the mark alone', () => BOM],
    ['two marks in front of the JSON', (json) => Buffer.concat([BOM, BOM, json])]
  ])('a key file holding %s still reads as unreadable', (_case, bytes) => {
    const vp = lockedVault('fmtguard-974', PW)
    writeFileSync(vp.descriptorPath, bytes(readFileSync(vp.descriptorPath)))
    expect(readVaultDescriptorChecked(vp.descriptorPath)).toEqual({ kind: 'unreadable' })
  })
})

// The over-broadening guards: what is NOT newer must go on as before.
describe('what is not newer (#845)', () => {
  // `isDescriptorUnreadable` counts a newer descriptor as "a vault exists", so a v3 whose data file moved away is
  // still never offered the create flow that would write a fresh vault beside the documents only it can open.
  it.each([
    ['keeps its dataKey', true],
    ['has no dataKey', false]
  ])('a version 3 descriptor that %s still counts as a vault when .enc is gone: no create over it', (_case, keep) => {
    const vp = editDescriptor(lockedVault('fmtguard', PW), version3(keep))
    rmSync(vp.encPath)
    plant(join(dirname(vp.dbPath), 'documents', 'doc.txt.enc'), 'stored copy')
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).toMatchObject({ state: 'locked', mode: 'encrypted' })
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(WorkspaceExistsError)
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })

  // A descriptor no build wrote reads as unreadable, not as v1: a `version` string holding no number ("3.0.0", W2
  // review 1), or a wrapped data key under a version that is not a v2's (missing, null, 0, 1; review 2: no v1 ever had
  // `dataKey`). Read as v1, startup discarded any staged password change, and the unlock's tag failure told the user
  // to restore the DATA from a backup, when only `config/workspace.json` needs restoring. Unreadable: startup sweeps
  // and recovers nothing over it, the unlock asks for the descriptor's backup, and create stays refused.
  it.each<[string, (d: Record<string, unknown>) => void, boolean]>([
    ['a version string holding no number ("3.0.0"), beside its dataKey', (d) => void (d.version = '3.0.0'), true],
    [
      'a version string holding no number ("3.0.0"), without a dataKey',
      (d) => {
        d.version = '3.0.0'
        delete d.dataKey
      },
      false
    ],
    ['no version, beside its dataKey', (d) => void delete d.version, true],
    ['version null, beside its dataKey', (d) => void (d.version = null), true],
    ['version 0, beside its dataKey', (d) => void (d.version = 0), true],
    ['version 1, beside its dataKey', (d) => void (d.version = 1), true]
  ])('a descriptor with %s reads as unreadable: startup touches nothing', (_case, edit, hasDataKey) => {
    const vp = editDescriptor(lockedVault('fmtguard', PW), edit)
    expect(Boolean(JSON.parse(readFileSync(vp.descriptorPath, 'utf8')).dataKey)).toBe(hasDataKey)
    const planted = [
      plant(join(dirname(vp.dbPath), 'documents', 'x.parse.pdf'), '%PDF-1.7'),
      stagedFrame(vp)
    ]
    planted.push(rekeyJournal(vp, 1, [planted[1]]))
    for (const path of planted) expect(existsSync(path), path).toBe(true)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).toMatchObject({ state: 'locked', mode: 'encrypted' })
      expect(() => ctl.unlock(PW)).toThrow(VaultDescriptorMissingError)
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(WorkspaceExistsError)
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })

  // Only an ASCII digit 2–9 after `HRAUMEN` is a newer frame (W2 review 2): one flipped bit in the version byte (`1` →
  // `0`, or to a letter) is damage, and reading it as "newer" would tell the user to update the app forever.
  it.each([
    ['HRAUMEN0', 'the digit 0'],
    ['HRAUMENq', 'a letter']
  ])('an .enc framed %s (%s after the family) is not newer: startup still sweeps, unlock names the header', (magic) => {
    const vp = lockedVault('fmtguard', PW)
    setFrameMagic(vp.encPath, magic)
    const transient = plant(join(dirname(vp.dbPath), 'documents', 'x.parse.pdf'), '%PDF-1.7')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(transient)).toBe(false)
      expect(ctl.newerVaultFormat()).toBeNull()
      expect(thrownBy(() => ctl.unlock(PW)).name).toBe('Error')
      expect(() => ctl.unlock(PW)).toThrow(/unrecognised header/)
    } finally {
      ctl.shutdown()
    }
  })

  // A foreign magic that is not of this family (`PAIDENC1`, written before the 0.1.10 rebrand) is an OLD format, not a
  // newer one: the startup sweep still runs, and the unlock still names an unrecognised header.
  it('an .enc of the pre-0.1.10 frame (PAIDENC1) is not newer: startup still sweeps, unlock names the header', () => {
    const vp = lockedVault('fmtguard', PW)
    setFrameMagic(vp.encPath, 'PAIDENC1')
    const transient = plant(join(dirname(vp.dbPath), 'documents', 'x.parse.pdf'), '%PDF-1.7')
    const enc = readFileSync(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(transient)).toBe(false)
      expect(thrownBy(() => ctl.unlock(PW)).name).toBe('Error')
      expect(() => ctl.unlock(PW)).toThrow(/unrecognised header/)
      expect(readFileSync(vp.encPath).equals(enc)).toBe(true)
    } finally {
      ctl.shutdown()
    }
  })

  // The golden descriptors (tests/fixtures/vault-golden/PROVENANCE.md): written by the released v0.1.65 and v0.1.50
  // code itself, on a scratch root, with a throwaway password. The release's key schedule must hold (derive, verify,
  // unwrap), a vault built around its data key must unlock and lock, and the descriptor must stay byte for byte.
  // #974: so must one an editor saved again with a UTF-8 byte-order mark in front (Windows PowerShell 5.1
  // `Set-Content -Encoding utf8`, older Notepad): it read as unreadable, and the unlock said the key file was missing.
  it.each([
    ['v0.1.65', 'v0.1.65', 'golden-throwaway-v0.1.65', 'eace4d6f3982e42992f5e3757133bedbdc505d0e544101c89437fb28825848f4', false],
    ['v0.1.50', 'v0.1.50', 'golden-throwaway-v0.1.50', '1d524326f2f0721c282a2c26fddb1b22518b66929aabd9d3932ddf25a41a0a4c', false],
    [
      'v0.1.65, saved again with a byte-order mark (#974),',
      'v0.1.65',
      'golden-throwaway-v0.1.65',
      'eace4d6f3982e42992f5e3757133bedbdc505d0e544101c89437fb28825848f4',
      true
    ]
  ])('the descriptor %s wrote reads as current, unlocks and stays byte for byte', (_label, tag, password, sha256, bom) => {
    const golden = readFileSync(join(__dirname, '..', 'fixtures', 'vault-golden', `${tag}-workspace.json`))
    expect(createHash('sha256').update(golden).digest('hex')).toBe(sha256) // the bytes PROVENANCE.md records
    const fixture = bom ? Buffer.concat([BOM, golden]) : golden
    const vp = freshVaultPaths('fmtguard-golden')
    writeFileSync(vp.descriptorPath, fixture)
    const read = readVaultDescriptorChecked(vp.descriptorPath)
    if (read.kind !== 'ok') throw new Error(`the ${tag} descriptor read as ${read.kind}`)
    const d = read.descriptor
    expect(d.version).toBe(2)
    const blob = (s: { ivB64: string; tagB64: string; ciphertextB64: string }) => ({
      iv: Buffer.from(s.ivB64, 'base64'),
      tag: Buffer.from(s.tagB64, 'base64'),
      ciphertext: Buffer.from(s.ciphertextB64, 'base64')
    })
    const kek = deriveKey(password, Buffer.from(d.saltB64, 'base64'), d.kdf)
    expect(verifyKey(kek, blob(d.verifier))).toBe(true)
    const dataKey = decrypt(kek, blob(d.dataKey!))
    kek.fill(0)
    // A vault around the release's data key: a fresh database encrypted under it, as that release's create leaves it.
    const db = openDatabase(vp.dbPath)
    seedSettings(db)
    updateSettings(db, { workspaceMode: 'encrypted', contextTokens: 8192 })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    encryptFile(vp.dbPath, vp.encPath, dataKey)
    dataKey.fill(0)
    shredFile(vp.dbPath)
    cleanSidecars(vp.dbPath)
    expect(vaultFormatVerdict(vp)).toEqual({ kind: 'ok' })
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).toMatchObject({ state: 'locked', mode: 'encrypted' })
      expect(thrownBy(() => ctl.unlock('not-the-password')).name).toBe('WrongPasswordError')
      expect(ctl.unlock(password).state).toBe('unlocked')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(8192)
      ctl.lock()
      expect(readFileSync(vp.descriptorPath).equals(fixture)).toBe(true)
    } finally {
      ctl.shutdown()
    }
  })
})

// #973: a create stages its database as `.enc.new` (the rekey suffix) with no journal, before its commit (the key file).
// A crash between the two leaves that file. Under a v2 descriptor every build rolled ANY `.enc.new` forward at the start,
// so a workspace put back into the same folder (troubleshooting's "go back" steps, #807, #931) had its `.enc` shredded
// and replaced by an empty database under a key nothing holds, and every unlock then said "damaged". Now a staged
// database no journal lists, beside an `.enc` that is there, waits for the unlock, which keeps it only when it
// authenticates under the data key; and a start with no key file, no `.enc` and no journal removes it.
describe('a staged database no rekey journal vouches for (#973)', () => {
  const stagedOf = (vp: FreshVaultPaths): string => `${vp.encPath}${REKEY_SUFFIX}`

  /** A locked workspace under `PW` that holds `contextTokens: 5151`. */
  function workspaceWithMarker(label: string): FreshVaultPaths {
    const vp = lockedVault(label, PW)
    const ctl = unlockedController(vp, PW)
    updateSettings(ctl.requireDb(), { contextTokens: 5151 })
    ctl.lock()
    return vp
  }

  /** What a create cut short between its stage and its commit leaves at `.enc.new`: a seeded database under a random
   *  data key that no key file wraps (another workspace's `.enc` has exactly that shape). */
  const leftoverStage = (): Buffer => readFileSync(lockedVault('fmtguard-973-leftover', 'other-password').encPath)

  it.each<[string, () => { vp: FreshVaultPaths; ctl: WorkspaceController; before: Record<string, string> }]>([
    [
      'put back while the app was closed',
      () => {
        const vp = workspaceWithMarker('fmtguard-973')
        writeFileSync(stagedOf(vp), leftoverStage())
        const before = snapshot(vp.root)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init() // the next start
        return { vp, ctl, before }
      }
    ],
    [
      'put back under the create form while the app runs',
      () => {
        const vp = freshVaultPaths('fmtguard-973')
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        expect(ctl.getState().state).toBe('uninitialized')
        const src = workspaceWithMarker('fmtguard-973-src')
        copyFileSync(src.descriptorPath, vp.descriptorPath)
        copyFileSync(src.encPath, vp.encPath)
        writeFileSync(stagedOf(vp), leftoverStage())
        return { vp, ctl, before: snapshot(vp.root) }
      }
    ]
  ])('a crash leftover beside a workspace %s: the start and a wrong password leave both, the password opens the workspace', (_when, arrange) => {
    const { vp, ctl, before } = arrange()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      expect(ctl.getState()).toMatchObject({ state: 'locked', mode: 'encrypted' })
      expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(stagedOf(vp))).toBe(false) // removed: it does not open under this workspace's key
      expect(ctl.takeRemovedForeignStage()).toBe(true)
      expect(sha(vp.encPath)).toBe(before['workspace/hilbertraum.sqlite.enc'])
      ctl.lock()
      const reopened = unlockedController(vp, PW)
      expect(getSettings(reopened.requireDb()).contextTokens).toBe(5151)
      reopened.shutdown()
    } finally {
      ctl.shutdown()
    }
  })

  // The control: a password change of a build before #241 (which wrote no journal), cut short after its commit, left the
  // staged database under the new data key beside the old `.enc`. It authenticates under that key, so the unlock rolls
  // it forward, as every start did before.
  it('a journal-less stage that opens under the data key (a password change before #241, cut short after its commit) rolls forward', () => {
    const vp = lockedVault('fmtguard-973', PW, { legacyV1: true })
    const { db, key } = unlockEncryptedVault(vp, PW)
    updateSettings(db, { contextTokens: 6262 })
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'next-password', FAST_KDF) // the COMMIT; the crash comes before the swap
    db.close()
    key.fill(0)
    dataKey.fill(0)
    shredFile(vp.dbPath) // the session the crash left, as the start's sweep removes it
    cleanSidecars(vp.dbPath)
    rmSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)) // a build before #241 wrote none
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      ctl.unlock('next-password')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6262)
      expect(existsSync(stagedOf(vp))).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  it('a create cut short leaves its stage on an empty drive: the start removes it, and a workspace put back later opens', () => {
    const vp = freshVaultPaths('fmtguard-973')
    // 1. A create killed between its stage and its commit: the staged database, and a write temp of an encrypt.
    writeFileSync(stagedOf(vp), leftoverStage())
    writeFileSync(`${stagedOf(vp)}.tmp`, 'the write temp of an encrypt cut short')
    // 2. The restart: the create form, and nothing left of the stage.
    const first = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    first.init()
    expect(first.getState().state).toBe('uninitialized')
    expect(existsSync(stagedOf(vp))).toBe(false)
    expect(existsSync(`${stagedOf(vp)}.tmp`)).toBe(false)
    // 3. A workspace put back while the app is closed. 4. The next start, and the unlock.
    const src = workspaceWithMarker('fmtguard-973-src')
    copyFileSync(src.descriptorPath, vp.descriptorPath)
    copyFileSync(src.encPath, vp.encPath)
    const ctl = unlockedController(vp, PW)
    try {
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
    } finally {
      ctl.shutdown()
    }
  })

  // The removal is narrow: with a key file, an `.enc` or a rekey journal there, the stage may be that workspace's, and
  // the start leaves it byte for byte.
  it.each<[string, (vp: FreshVaultPaths) => void]>([
    ['a key file that cannot be read', (vp) => writeFileSync(vp.descriptorPath, '{ not json', 'utf8')],
    ['an .enc without its key file', (vp) => writeFileSync(vp.encPath, leftoverStage())],
    ['a rekey journal that lists it', (vp) => void rekeyJournal(vp, 1, [stagedOf(vp)])]
  ])('the start leaves a stage beside %s', (_case, plantOne) => {
    const vp = freshVaultPaths('fmtguard-973')
    writeFileSync(stagedOf(vp), leftoverStage())
    plantOne(vp)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(snapshot(vp.root)).toEqual(before)
  })

  // A file at the staged name that is no frame of this build's at all cannot be a staged copy of this workspace: the
  // unlock removes it as it removes one that fails its tag, and opens `.enc`. (A newer frame is refused earlier, #845;
  // one the unlock cannot read refuses as "try again": vault-recovery-guards.test.ts.)
  it.each<[string, (staged: string) => void]>([
    [
      'a file in another frame (PAIDENC1)',
      (staged) => {
        writeFileSync(staged, leftoverStage())
        setFrameMagic(staged, 'PAIDENC1')
      }
    ],
    ['a frame cut short inside its header', (staged) => writeFileSync(staged, Buffer.from('HRAUMEN1cut', 'latin1'))]
  ])('beside a workspace, %s at the staged name: the start leaves it, the unlock removes it and opens the workspace', (_case, plantStage) => {
    const vp = workspaceWithMarker('fmtguard-973')
    plantStage(stagedOf(vp))
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(stagedOf(vp))).toBe(false)
      expect(sha(vp.encPath)).toBe(before['workspace/hilbertraum.sqlite.enc'])
      expect(ctl.takeRemovedForeignStage()).toBe(true) // for the unlock's one log line, once
      expect(ctl.takeRemovedForeignStage()).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })
})
