import { describe, it, expect } from 'vitest'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
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
  readStoredCopy,
  setFrameMagic,
  staleDatabaseStage,
  storeCopy,
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

/** A journal entry spelled for the same workspace under another drive root (a Kit that came back under another letter
 *  or mount point), or any other workspace's: the same folder and file names, another absolute path. */
const underOtherRoot = (vp: FreshVaultPaths, path: string): string =>
  join(process.platform === 'win32' ? 'Q:\\Kit' : '/media/other/Kit', relative(vp.root, path))

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
      // Review round 2 R8: no "the encrypted file is missing, your password brings it back" notice: this unlock answers
      // "written by a newer HilbertRaum" for this copy instead.
      expect(ctl.getState()).toEqual({ state: 'locked', mode: 'encrypted', plaintextAllowed: false, encryptionRequired: true })
      expect(thrownBy(() => ctl.unlock(PW))).toEqual(NEWER)
      expect(sha(recoveryOf(vp))).toBe(working)
      expect(existsSync(vp.encPath)).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  /** A `.recovery` a newer build stamped, `olderBy` ms older than the (backdated) `.enc` when positive, else newer. */
  function newerRecovery(olderBy: number): FreshVaultPaths {
    const vp = lockedVault('fmtguard-985', PW)
    failedLockState(vp, 7171, PW) // `.enc` backdated 60 s
    writeNewerSchema(vp.dbPath)
    renameSync(vp.dbPath, recoveryOf(vp))
    if (olderBy > 0) backdate(recoveryOf(vp), olderBy)
    return vp
  }

  // One that may hold the freshest data (newer than `.enc`) is refused before anything is written.
  it('a .recovery newer than .enc: the unlock refuses it before anything is written, every file byte for byte', () => {
    const vp = newerRecovery(0)
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

  // Review round 2 R6: one older than a present `.enc` is a spent leftover (the newer build's own unlock consumed it and
  // a later lock made `.enc` newer). Refusing it would block every unlock for good; shredding it is not this build's to
  // judge. It is left as it is, and the workspace opens at `.enc`.
  it('a .recovery older than .enc (a spent leftover): the unlock opens the workspace and leaves the copy byte for byte', () => {
    const vp = newerRecovery(120_000)
    const copy = sha(recoveryOf(vp))
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.unlock(PW).state).toBe('unlocked')
      expect(sha(recoveryOf(vp))).toBe(copy)
      ctl.lock()
      expect(sha(recoveryOf(vp))).toBe(copy)
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2 F3 (FU-V1): with only a newer build's `.recovery` on the drive (its key file and `.enc` gone), the
  // state reads `uninitialized`. A create used to commit a new workspace and then answer "newer", and every unlock of it
  // refused on that copy. It is refused before anything is written.
  it('a create over a drive that holds only a newer build’s .recovery is refused, nothing written', () => {
    const vp = newerRecovery(0)
    rmSync(vp.descriptorPath)
    rmSync(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState().state).toBe('uninitialized')
      const before = snapshot(vp.root)
      expect(thrownBy(() => ctl.create('brand-new-password', 'encrypted'))).toEqual(NEWER)
      expect(snapshot(vp.root)).toEqual(before)
      expect(ctl.isUnlocked()).toBe(false)
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
      expect(ctl.takeStageOutcome()).toBe('removed')
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

  // #1027 (owner, 2026-11-22: G-1 refined): a stage that opens under the data key rolls forward only while `.enc` does not
  // open under that key too. Nothing writes `.enc` under a data key before the stage made under it, so an `.enc` that opens
  // was written after the stage (here a lock, as after a password change that could not move its stage into place) and
  // holds the newer data: the unlock removes the stage and opens `.enc`. So it is for a journal that names the stage under
  // another drive root (a Kit back under another letter), which vouches for nothing (review round 3 F1).
  it.each<[string, (vp: FreshVaultPaths, staged: string) => void]>([
    ['no journal', () => {}],
    ['a journal that names it under another drive root', (vp, staged) => void rekeyJournal(vp, 1, [underOtherRoot(vp, staged)])]
  ])('a staged copy of this workspace older than .enc, %s: the start leaves both, the unlock removes the stage and opens .enc', (_case, plantJournal) => {
    const vp = lockedVault('fmtguard-1027', PW)
    const staged = staleDatabaseStage(vp, PW, { staged: 3131, current: 6262 })
    plantJournal(vp, staged)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6262)
      expect(existsSync(staged)).toBe(false)
      expect(ctl.takeStageOutcome()).toBe('superseded')
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
  // one a hold keeps from being read refuses as "try again", and one that cannot be read otherwise is left as it is:
  // vault-recovery-guards.test.ts and the directory row below.)
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
      expect(ctl.takeStageOutcome()).toBe('removed') // for the unlock's one log line, once
      expect(ctl.takeStageOutcome()).toBeNull()
    } finally {
      ctl.shutdown()
    }
  })

  /** A v1 workspace whose password change (to `next-password`) committed and then stopped before its swap, with the
   *  session holding `contextTokens: marker` staged and the working file shredded; the journal as this build writes it. */
  function committedMigration(marker: number, opts: { backdateEnc?: boolean } = {}): FreshVaultPaths {
    const vp = lockedVault('fmtguard-973', PW, { legacyV1: true })
    if (opts.backdateEnc) backdate(vp.encPath)
    const { db, key } = unlockEncryptedVault(vp, PW)
    updateSettings(db, { contextTokens: marker })
    const dataKey = generateDataKey()
    stageRekey(vp, db, key, dataKey)
    rewrapVaultKey(vp, dataKey, 'next-password', FAST_KDF) // the COMMIT; the crash comes before the swap
    db.close()
    key.fill(0)
    dataKey.fill(0)
    return vp
  }

  // Review round 3 F1: a journal vouches for the staged database only by its full path. With the exact path the start
  // rolls the committed change forward as before. An entry under another drive root (the Kit came back under another
  // letter after the change was cut short) leaves the stage in doubt: the unlock authenticates it under the data key and
  // rolls it forward, the same outcome, one read slower. (Round 2 matched by the folder and file names, which every
  // workspace shares: see the stale-journal row below.)
  it.each<[string, boolean]>([
    ['the exact path: the start rolls it forward as before', false],
    ['another drive root: the start leaves it, the unlock authenticates it and rolls it forward', true]
  ])('a committed password change whose journal names its stage by %s', (_case, otherRoot) => {
    const vp = committedMigration(6363)
    shredFile(vp.dbPath)
    cleanSidecars(vp.dbPath)
    if (otherRoot) {
      const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
      const written = JSON.parse(readFileSync(journal, 'utf8')) as { staged: string[] }
      const staged = written.staged.map((path) => underOtherRoot(vp, path))
      expect(staged.some((path) => path.endsWith('hilbertraum.sqlite.enc.new'))).toBe(true)
      writeFileSync(journal, JSON.stringify({ ...written, staged }, null, 2), 'utf8')
    }
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(stagedOf(vp))).toBe(otherRoot) // rolled forward at the start, or left for the unlock
      ctl.unlock('next-password')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6363)
      expect(existsSync(stagedOf(vp))).toBe(false)
      expect(ctl.takeStageOutcome()).toBeNull()
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 3 F1 (the regression round 2 brought): a stale journal (one `applyPendingRekey` keeps for good because
  // its entries look unreachable, or one a restored folder brings back) names `…/workspace/hilbertraum.sqlite.enc.new`
  // under another drive root, as every workspace's journal does. It must not vouch for a foreign stage beside a real
  // `.enc`: the start leaves `.enc` byte for byte, and the unlock removes the stage.
  it('a stale journal that names a stage under another drive root never vouches for a crash leftover', () => {
    const vp = workspaceWithMarker('fmtguard-973')
    writeFileSync(stagedOf(vp), leftoverStage())
    rekeyJournal(vp, 1, [underOtherRoot(vp, stagedOf(vp)), underOtherRoot(vp, join(dirname(vp.dbPath), 'elsewhere', 'legacy.pdf.enc.new'))])
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(stagedOf(vp))).toBe(false)
      expect(sha(vp.encPath)).toBe(before['workspace/hilbertraum.sqlite.enc'])
      expect(ctl.takeStageOutcome()).toBe('removed')
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2 R2: the start judges an unclean end (#892, a crash with the session's sidecars live) against the
  // `.enc` that is there. With a stage in doubt it cannot know yet which snapshot the unlock opens, so it holds the loss
  // instead of recording it: the unlock records it when it opens `.enc` as it is (the stage foreign), and drops it when
  // the stage rolls forward (the stage holds that session). #1027: a stale staged copy of this workspace's own database
  // beside an `.enc` that opens under the same key is removed too (`superseded`), so `.enc` opens as it is and the loss is
  // recorded the same way; it used to roll the stale copy forward and drop the loss.
  it.each<[string, (vp: FreshVaultPaths, opened: ReturnType<typeof unlockEncryptedVault>) => Buffer]>([
    ['a crash leftover', () => leftoverStage()],
    [
      'a staged copy of this workspace older than .enc (#1027)',
      (vp, { db, key }) => {
        updateSettings(db, { contextTokens: 4040 }) // the stage's copy, neither `.enc`'s 5151 nor the session's 9191
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
        const out = join(vp.root, 'stale-stage.bin')
        encryptFile(vp.dbPath, out, key)
        const bytes = readFileSync(out)
        rmSync(out)
        return bytes
      }
    ]
  ])('an unclean end beside %s: the loss is held at the start, and recorded when the unlock removes it', (_case, stageOf) => {
    const vp = workspaceWithMarker('fmtguard-973')
    backdate(vp.encPath)
    const opened = unlockEncryptedVault(vp, PW)
    const { db, key } = opened
    const stage = stageOf(vp, opened)
    updateSettings(db, { contextTokens: 9191 })
    db.close()
    key.fill(0)
    writeFileSync(`${vp.dbPath}-wal`, 'wal') // the open session's sidecars, left by the crash
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    writeFileSync(stagedOf(vp), stage)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(vp.dbPath)).toBe(false) // swept, as before
      expect(ctl.getState()).not.toHaveProperty('lockNotice') // held, not shown
      expect(existsSync(join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER))).toBe(false)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151) // `.enc` as it was: the session is lost
      expect(['unclean', 'unclean-full']).toContain(ctl.takeWorkingCopyLost()?.cause)
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 3 F2: the unlock settles the hold whatever it finds. Here the leftover is gone before the unlock (a
  // tidy tool, by hand), so the unlock judges no stage; `.enc` is still the snapshot the loss was judged against, so the
  // loss is recorded, once. The hold is not carried on: a later clean session beside another leftover reports nothing.
  it('an unclean end beside a crash leftover that is gone before the unlock: the loss is recorded once, and never again', () => {
    const vp = workspaceWithMarker('fmtguard-973')
    backdate(vp.encPath)
    const { db, key } = unlockEncryptedVault(vp, PW)
    updateSettings(db, { contextTokens: 9191 })
    db.close()
    key.fill(0)
    writeFileSync(`${vp.dbPath}-wal`, 'wal') // the open session's sidecars, left by the crash
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    writeFileSync(stagedOf(vp), leftoverStage())
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.getState()).not.toHaveProperty('lockNotice') // held
      rmSync(stagedOf(vp)) // gone before the unlock
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(['unclean', 'unclean-full']).toContain(ctl.takeWorkingCopyLost()?.cause)
      expect(ctl.takeWorkingCopyLost()).toBeNull()
      updateSettings(ctl.requireDb(), { contextTokens: 4242 })
      ctl.lock() // a clean session
      writeFileSync(stagedOf(vp), leftoverStage()) // another leftover turns up
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(4242)
      expect(ctl.takeStageOutcome()).toBe('removed')
      expect(ctl.takeWorkingCopyLost()).toBeNull() // no notice for a session that lost nothing
      expect(existsSync(join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER))).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  it('an unclean end beside a journal-less stage that opens under the data key: the unlock rolls it forward and records no loss', () => {
    const vp = committedMigration(6464, { backdateEnc: true })
    rmSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)) // a build before #241 wrote none
    writeFileSync(`${vp.dbPath}-wal`, 'wal') // the open session's sidecars, left by the crash
    writeFileSync(`${vp.dbPath}-shm`, 'shm')
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(vp.dbPath)).toBe(false) // swept, as before
      expect(ctl.getState()).not.toHaveProperty('lockNotice')
      ctl.unlock('next-password')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6464) // the stage held the session
      expect(ctl.takeWorkingCopyLost()).toBeNull()
      expect(existsSync(join(dirname(vp.descriptorPath), WORKING_COPY_LOST_MARKER))).toBe(false)
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2 R7: the #985 refusal of a `.recovery` a newer build stamped comes before the staged-file check, so a
  // stage in doubt beside it stays as it was: a `workspace_newer` unlock writes nothing.
  it('a .recovery newer than .enc beside a staged leftover: the refusal writes nothing, the stage included', () => {
    const vp = lockedVault('fmtguard-973', PW)
    failedLockState(vp, 7171, PW) // `.enc` backdated 60 s
    writeNewerSchema(vp.dbPath)
    renameSync(vp.dbPath, `${vp.dbPath}${RECOVERY_SUFFIX}`)
    writeFileSync(stagedOf(vp), leftoverStage())
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      const before = snapshot(vp.root)
      expect(before['workspace/hilbertraum.sqlite.enc.new']).toBeDefined()
      expect(thrownBy(() => ctl.unlock(PW))).toEqual({ name: 'WorkspaceNewerError', found: SCHEMA_VERSION + 1 })
      expect(snapshot(vp.root)).toEqual(before)
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2 R4: a staged name that can be neither read as a frame nor removed (a directory there: EISDIR on every
  // OS) is left exactly as it is, and the unlock opens `.enc`. It never blocks every unlock with "try again".
  it('a directory at the staged name beside a workspace: the unlock leaves it as it is and opens the workspace', () => {
    const vp = workspaceWithMarker('fmtguard-973')
    mkdirSync(stagedOf(vp))
    writeFileSync(join(stagedOf(vp), 'held'), 'x')
    const enc = sha(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(sha(vp.encPath)).toBe(enc)
      expect(readdirSync(stagedOf(vp))).toEqual(['held'])
      expect(readFileSync(join(stagedOf(vp), 'held'), 'utf8')).toBe('x')
      expect(ctl.takeStageOutcome()).toBe('left')
    } finally {
      ctl.shutdown()
    }
  })

  // #1014 (folded in): the same directory, with a rekey journal that lists the staged name, as every journal a password
  // change writes does. The start counted the staged database by the name's existence, so it shredded `.enc` and renamed
  // the directory into its place: the workspace was gone. A staged name counts only when it is a file (the #1001 review
  // round 2 rule for journal entries), so `.enc` and the directory stay as they are, and the unlock opens the workspace.
  it('a directory at the staged name that the journal lists: the start and the unlock leave .enc and the directory as they are', () => {
    const vp = workspaceWithMarker('fmtguard-973')
    mkdirSync(stagedOf(vp))
    writeFileSync(join(stagedOf(vp), 'held'), 'x')
    rekeyJournal(vp, 1, [stagedOf(vp)])
    const enc = sha(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(statSync(vp.encPath).isFile(), '.enc is still a file').toBe(true)
      expect(sha(vp.encPath)).toBe(enc)
      expect(readdirSync(stagedOf(vp))).toEqual(['held'])
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(sha(vp.encPath)).toBe(enc)
      expect(readdirSync(stagedOf(vp))).toEqual(['held'])
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2 R5: once the unlock has removed a foreign staged database, the rest of the staged set gets what the
  // start's recovery would have given it with that file gone (master's start rolled all of it forward together with the
  // leftover): the document twin is swapped in, the journal cleared or, unreadable, quarantined. While the database
  // stage is in doubt, the start leaves all of it, the journal that does not list the database stage included.
  // #1001: a journal that cannot be read vouches for no staged file, so there the twin is a real copy under the data
  // key, which the unlock swaps in once it authenticates (a twin that does not open is removed: the #1001 rows below),
  // beside a stored copy of the same length under the retired key, as a password change cut short leaves them.
  it.each<[string, (vp: FreshVaultPaths, docStage: string) => void, boolean, 'plain text' | 'a copy under the data key']>([
    ['a journal that lists only the document twin', (vp, docStage) => void rekeyJournal(vp, 1, [docStage]), false, 'plain text'],
    [
      'a journal that cannot be read',
      (vp) => writeFileSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME), '{ not json', 'utf8'),
      true,
      'a copy under the data key'
    ]
  ])('a crash leftover beside %s and a staged document twin: the unlock removes the leftover, then swaps the document in', async (_case, journalOf, quarantined, twin) => {
    const vp = workspaceWithMarker('fmtguard-973')
    const doc = plant(join(dirname(vp.dbPath), 'documents', 'a.pdf.enc'), 'stored copy')
    const docStage = `${doc}${REKEY_SUFFIX}`
    if (twin === 'plain text') plant(docStage, 'staged copy')
    else {
      const seed = unlockedController(vp, PW)
      await storeCopy(seed, vp.root, docStage, 'staged copy')
      seed.lock()
      const src = join(vp.root, 'retired-src.txt')
      writeFileSync(src, 'stored copy')
      encryptFile(src, doc, randomBytes(32)) // the retired key, which nothing holds any more
      rmSync(src)
    }
    journalOf(vp, docStage)
    writeFileSync(stagedOf(vp), leftoverStage())
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before) // in doubt: the staged set, the journal and the document as they were
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(stagedOf(vp))).toBe(false)
      expect(twin === 'plain text' ? readFileSync(doc, 'utf8') : await readStoredCopy(ctl, vp.root, doc)).toBe('staged copy')
      expect(existsSync(docStage)).toBe(false)
      const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
      expect(existsSync(journal)).toBe(false)
      expect(existsSync(`${journal}.corrupt`)).toBe(quarantined)
    } finally {
      ctl.shutdown()
    }
  })
})

// #1001: a document or image copy is stored once, as `documents/<id><ext>.enc` or `images/<id><ext>.enc` under the data
// key, and a password change stages its new copy beside it as `.enc.new`. Every start swapped in ANY such stage under a
// v2 key file, with no key at hand and whether or not a rekey journal listed it: a copy from another workspace, a file
// planted at the name or a folder there shredded the stored copy and took its place, and that document never opened
// again. Now a stage no journal lists by its full path, beside a stored copy that is there, waits for the unlock, which
// swaps it in only when it opens under the data key, removes it when it does not (or is no frame of this build's), and
// leaves it when it can be neither read nor swapped in. Each row stores its copies with the import's own writer.
describe('staged document and image copies no rekey journal vouches for (#1001)', () => {
  type Store = 'documents' | 'images'
  const LEAF: Record<Store, string> = { documents: 'd1.pdf.enc', images: 'i1.png.enc' }
  const textOf = (store: Store, label: string): string => `the ${store} copy of ${label}`
  /** `path` as a key of `snapshot()`. */
  const keyOf = (vp: FreshVaultPaths, path: string): string => relative(vp.root, path).split('\\').join('/')

  /** A locked workspace under `password` that holds `contextTokens: 5151`, a stored document copy and a stored image
   *  copy (`textOf(store, label)`). */
  async function workspaceWithCopies(label: string, password = PW): Promise<{ vp: FreshVaultPaths; copies: Record<Store, string> }> {
    const vp = lockedVault(label, password)
    const ctl = unlockedController(vp, password)
    try {
      updateSettings(ctl.requireDb(), { contextTokens: 5151 })
      const ws = dirname(vp.dbPath)
      const copies: Record<Store, string> = {
        documents: await storeCopy(ctl, vp.root, join(ws, 'documents', LEAF.documents), textOf('documents', label)),
        images: await storeCopy(ctl, vp.root, join(ws, 'images', LEAF.images), textOf('images', label))
      }
      return { vp, copies }
    } finally {
      ctl.lock()
    }
  }

  /** The same stored copy of another workspace (another password, so another data key): what a copied or restored
   *  folder brings to the staged name. */
  const foreignCopy = async (store: Store): Promise<Buffer> =>
    readFileSync((await workspaceWithCopies('fmtguard-1001-other', 'other-password')).copies[store])

  /** Runs `write` with `vp` unlocked under `PW` (for what only its data key can write), and locks it again. */
  async function whileUnlocked<T>(vp: FreshVaultPaths, write: (ctl: WorkspaceController) => Promise<T>): Promise<T> {
    const ctl = unlockedController(vp, PW)
    try {
      return await write(ctl)
    } finally {
      ctl.lock()
    }
  }

  /** What a password change of a build before 0.1.60 left when it was cut short after its commit: the stored copy at
   *  `store/leaf` still under the retired key, which nothing holds any more, and its new copy of `text` staged beside it
   *  under the data key, by the unlocked `ctl`. */
  async function retiredCopyAndStage(
    ctl: WorkspaceController,
    vp: FreshVaultPaths,
    store: Store,
    leaf: string,
    text: string
  ): Promise<{ target: string; staged: string }> {
    const target = retiredCopy(vp, store, leaf, text)
    return { target, staged: await storeCopy(ctl, vp.root, `${target}${REKEY_SUFFIX}`, text) }
  }

  /** A stored copy of `text` at `store/leaf` under a retired key, which nothing holds any more. */
  function retiredCopy(vp: FreshVaultPaths, store: Store, leaf: string, text: string): string {
    const target = join(dirname(vp.dbPath), store, leaf)
    const src = join(vp.root, 'retired-src.txt')
    writeFileSync(src, text)
    mkdirSync(dirname(target), { recursive: true })
    encryptFile(src, target, randomBytes(32))
    rmSync(src)
    return target
  }

  it.each<[Store]>([['documents'], ['images']])(
    'a copy from another workspace at the staged name of a stored copy in %s, no journal: the start and a wrong password leave both, the unlock removes the stage',
    async (store) => {
      const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
      const target = copies[store]
      const staged = `${target}${REKEY_SUFFIX}`
      writeFileSync(staged, await foreignCopy(store))
      const before = snapshot(vp.root)
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      try {
        expect(snapshot(vp.root)).toEqual(before) // the start: the stage and the stored copy as they were
        expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
        expect(snapshot(vp.root)).toEqual(before) // a wrong password writes nothing
        ctl.unlock(PW)
        expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
        expect(existsSync(staged)).toBe(false) // removed: it does not open under this workspace's key
        expect(sha(target)).toBe(before[keyOf(vp, target)])
        expect(await readStoredCopy(ctl, vp.root, target)).toBe(textOf(store, 'fmtguard-1001'))
        expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
        expect(ctl.takeSidecarStageOutcome()).toBeNull() // once, for the unlock's one log line
      } finally {
        ctl.shutdown()
      }
    }
  )

  // A file at the staged name that is no frame of this build's cannot be a staged copy under any key here: the unlock
  // removes it as it removes one that fails its tag. (A newer build's frame is refused before anything is written, #845.)
  it.each<[string, (staged: string, target: string) => void]>([
    [
      'the stored copy itself in another frame (PAIDENC1)',
      (staged, target) => {
        copyFileSync(target, staged)
        setFrameMagic(staged, 'PAIDENC1')
      }
    ],
    ['a frame cut short inside its header', (staged) => writeFileSync(staged, Buffer.from('HRAUMEN1cut', 'latin1'))],
    ['plain text', (staged) => writeFileSync(staged, 'not a staged copy', 'utf8')]
  ])('beside a stored document copy, %s at the staged name: the start leaves both, the unlock removes the stage', async (_case, plantStage) => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const staged = `${copies.documents}${REKEY_SUFFIX}`
    plantStage(staged, copies.documents)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(existsSync(staged)).toBe(false)
      expect(sha(copies.documents)).toBe(before[keyOf(vp, copies.documents)])
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // A folder at the staged name is no data at all. The start used to shred the stored copy and rename the folder into
  // its place. Now it is no stage (review round 1): the start and every unlock leave both as they are and count nothing,
  // so no line about it repeats at each unlock, and the workspace opens.
  it('a folder at the staged name of a stored document copy is no stage: the start and two unlocks leave both and count nothing', async () => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const staged = `${copies.documents}${REKEY_SUFFIX}`
    mkdirSync(staged)
    writeFileSync(join(staged, 'held'), 'x')
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      for (let unlock = 0; unlock < 2; unlock++) {
        ctl.unlock(PW)
        expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
        expect(readdirSync(staged)).toEqual(['held'])
        expect(readFileSync(join(staged, 'held'), 'utf8')).toBe('x')
        expect(sha(copies.documents)).toBe(before[keyOf(vp, copies.documents)])
        expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
        expect(ctl.takeSidecarStageOutcome()).toBeNull()
        ctl.lock()
      }
    } finally {
      ctl.shutdown()
    }
  })

  // Review rounds 1 and 2: a stage that opens under the data key is swapped in only when its stored copy does not (a
  // legitimate stage only ever sits beside a stored copy under the retired key). The stored copy itself under the
  // staged name (a hard link: one file, two names) authenticates too, and the swap's shred of the old copy would
  // overwrite that one file; another stored copy of this workspace copied to the name authenticates as well, of the same
  // length or not. Each time the stored copy opens under the data key: only the staged name is removed, and the stored
  // copy keeps its own text.
  it.each<[string, (vp: FreshVaultPaths, copies: Record<Store, string>) => Promise<void>]>([
    ['a hard link of the stored copy', async (_vp, copies) => linkSync(copies.documents, `${copies.documents}${REKEY_SUFFIX}`)],
    [
      'a copy of another document of this workspace of the same length',
      async (vp, copies) => {
        const text = textOf('documents', 'fmtguard-1002')
        expect(text).toHaveLength(textOf('documents', 'fmtguard-1001').length)
        const d2 = await whileUnlocked(vp, (ctl) => storeCopy(ctl, vp.root, join(dirname(vp.dbPath), 'documents', 'd2.pdf.enc'), text))
        copyFileSync(d2, `${copies.documents}${REKEY_SUFFIX}`)
      }
    ],
    [
      'a copy of another, longer document of this workspace',
      async (vp, copies) => {
        const d2 = await whileUnlocked(vp, (ctl) =>
          storeCopy(ctl, vp.root, join(dirname(vp.dbPath), 'documents', 'd2.pdf.enc'), 'a second, longer document of this workspace')
        )
        copyFileSync(d2, `${copies.documents}${REKEY_SUFFIX}`)
      }
    ]
  ])('%s at the staged name opens under the data key: the unlock removes only the staged name, the stored copy keeps its text', async (_case, plantStage) => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    await plantStage(vp, copies)
    const staged = `${copies.documents}${REKEY_SUFFIX}`
    const stored = sha(copies.documents)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(sha(copies.documents)).toBe(stored) // the start leaves both
      expect(existsSync(staged)).toBe(true)
      ctl.unlock(PW)
      expect(existsSync(staged)).toBe(false)
      expect(sha(copies.documents)).toBe(stored)
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // Beside a stored copy still under the retired key (where a legitimate stage would sit), only a stage that opens under
  // the data key AND has the stored copy's length is swapped in. A copy from another workspace of the same length fails
  // its tag; another document of this workspace of another length is no new copy of this one. Both are removed, and the
  // stored copy stays byte for byte (still unreadable, as before: its key is gone).
  it.each<[string, (vp: FreshVaultPaths, staged: string, length: number) => Promise<void>]>([
    [
      'a copy from another workspace of the same length',
      async (_vp, staged, length) => {
        const other = lockedVault('fmtguard-1001-other', 'other-password')
        const ctl = unlockedController(other, 'other-password')
        try {
          const copy = await storeCopy(ctl, other.root, join(dirname(other.dbPath), 'documents', 'x.pdf.enc'), 'y'.repeat(length))
          copyFileSync(copy, staged)
        } finally {
          ctl.lock()
        }
      }
    ],
    [
      'a copy of another, longer document of this workspace',
      async (vp, staged, length) => {
        const d3 = await whileUnlocked(vp, (ctl) =>
          storeCopy(ctl, vp.root, join(dirname(vp.dbPath), 'documents', 'd3.pdf.enc'), 'z'.repeat(length + 7))
        )
        copyFileSync(d3, staged)
      }
    ],
    // Review round 3: a stage with more than one link is no new copy of anything (a password change writes each stage
    // as a new file): here a hard link to another document's stored copy of the same length, which opens under the
    // data key. Only the staged name goes; the other document keeps its file.
    [
      'a hard link to another document of this workspace of the same length',
      async (vp, staged, length) => {
        const d3 = await whileUnlocked(vp, (ctl) =>
          storeCopy(ctl, vp.root, join(dirname(vp.dbPath), 'documents', 'd3.pdf.enc'), 'w'.repeat(length))
        )
        const d3Bytes = sha(d3)
        linkSync(d3, staged)
        expect(sha(d3)).toBe(d3Bytes)
      }
    ]
  ])('beside a stored copy still under the retired key, %s at the staged name: the unlock removes it, the stored copy byte for byte', async (_case, plantStage) => {
    const vp = lockedVault('fmtguard-1001', PW)
    const text = 'the copy under the retired key'
    const target = retiredCopy(vp, 'documents', 'd2.pdf.enc', text)
    const staged = `${target}${REKEY_SUFFIX}`
    await plantStage(vp, staged, text.length)
    const stored = sha(target)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(sha(target)).toBe(stored)
      ctl.unlock(PW)
      expect(existsSync(staged)).toBe(false)
      expect(sha(target)).toBe(stored)
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // Review round 2: a journal entry vouches only for a FILE at the name, as the scan does. A folder at a name the
  // journal lists used to pass (`existsSync` is true for a folder): the start shredded the stored copy and renamed the
  // folder into its place.
  it('a journal that lists a folder at the staged name of a stored document copy: the start and the unlock leave both, and the copy reads as before', async () => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const staged = `${copies.documents}${REKEY_SUFFIX}`
    mkdirSync(staged)
    writeFileSync(join(staged, 'held'), 'x')
    rekeyJournal(vp, 1, [staged])
    const stored = sha(copies.documents)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(statSync(copies.documents).isFile(), 'the stored copy is still a file').toBe(true)
      expect(sha(copies.documents)).toBe(stored)
      expect(readdirSync(staged)).toEqual(['held'])
      ctl.unlock(PW)
      expect(sha(copies.documents)).toBe(stored)
      expect(readdirSync(staged)).toEqual(['held'])
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
    } finally {
      ctl.shutdown()
    }
  })

  // A journal vouches for a stage only by its full path (#973 review round 3 F1): one that cannot be read lists nothing,
  // and one written under another drive root lists other paths. Either leaves the stage in doubt.
  it.each<[string, (vp: FreshVaultPaths, staged: string) => void]>([
    ['a journal that cannot be read', (vp) => writeFileSync(join(dirname(vp.dbPath), REKEY_JOURNAL_NAME), '{ not json', 'utf8')],
    ['a journal that names the stage under another drive root', (vp, staged) => void rekeyJournal(vp, 1, [underOtherRoot(vp, staged)])]
  ])('a copy from another workspace at the staged name of a stored document copy, beside %s: the start leaves the stored copy, the unlock removes the stage', async (_case, journalOf) => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const staged = `${copies.documents}${REKEY_SUFFIX}`
    writeFileSync(staged, await foreignCopy('documents'))
    journalOf(vp, staged)
    const stored = sha(copies.documents)
    const stage = sha(staged)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(sha(copies.documents)).toBe(stored) // the start (an unreadable journal is quarantined, as before)
      expect(sha(staged)).toBe(stage)
      ctl.unlock(PW)
      expect(existsSync(staged)).toBe(false)
      expect(sha(copies.documents)).toBe(stored)
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // #1014 round 4: a journal entry the start refuses vouches for nothing. Here `documents/` itself is a junction (no
  // privilege needed on Windows) to a folder elsewhere, and the journal lists the stage by its path through it. The
  // containment refuses that entry, but the scan, whose `readdir` follows the link, still finds the stage; listed by the
  // journal as written, it was no doubt, and the start shredded the stored copy behind the link and renamed the stage
  // over it. Now the stage is a #1001 doubt: the start leaves both files, and the unlock judges the stage under the data
  // key. A stage under another key fails its tag and is removed; one that opens under the data key (a store the user
  // keeps behind a link of their own) still rolls forward, which is why the scan does not skip a linked folder.
  // Round 5: the entry through the link waits for the unlock (as an out-of-store copy's does), whose pass acts only on a
  // stored copy the database lists outside `documents/`, which this one is not: the unlock counts it and drops it, so
  // the count moved from the start to the unlock.
  it.each<[string, (vp: FreshVaultPaths, target: string, text: string) => Promise<string>, 'removed' | 'rolledForward']>([
    ['a stage under another key', async (vp, target, text) => retiredCopy(vp, 'documents', `${basename(target)}${REKEY_SUFFIX}`, text), 'removed'],
    [
      'a stage that opens under the data key',
      async (vp, target, text) => whileUnlocked(vp, (ctl) => storeCopy(ctl, vp.root, `${target}${REKEY_SUFFIX}`, text)),
      'rolledForward'
    ]
  ])('`documents/` a junction to a folder elsewhere, the journal listing %s through it: the start leaves both files, the unlock judges the stage', async (_case, plantStage, verdict) => {
    const vp = lockedVault('fmtguard-1001', PW)
    const elsewhere = join(vp.root, 'store-elsewhere')
    mkdirSync(elsewhere)
    const docs = join(dirname(vp.dbPath), 'documents')
    rmSync(docs, { recursive: true, force: true })
    symlinkSync(elsewhere, docs, 'junction')
    const text = 'the copy behind the link'
    const target = retiredCopy(vp, 'documents', 'x.pdf.enc', text) // the stored copy, still under a retired key
    const staged = await plantStage(vp, target, text)
    const journal = rekeyJournal(vp, 1, [staged])
    const behind = join(elsewhere, 'x.pdf.enc') // the same file, by its own path
    const before = { stored: sha(behind), stage: sha(staged) }
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(sha(behind), 'the stored copy behind the link, after the start').toBe(before.stored)
      expect(sha(staged), 'its stage, after the start').toBe(before.stage)
      expect(ctl.takeJournalRefusals(), 'the start: the entry waits for the database').toBe(0)
      ctl.unlock(PW)
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 0, left: 0, setAside: 0, [verdict]: 1 })
      expect(ctl.takeJournalRefusals()).toBe(1) // the entry through the link, dropped once counted
      expect(existsSync(journal)).toBe(false)
      expect(existsSync(staged)).toBe(false)
      if (verdict === 'removed') expect(sha(behind)).toBe(before.stored)
      else expect(await readStoredCopy(ctl, vp.root, behind)).toBe(text)
    } finally {
      ctl.shutdown()
    }
  })

  // #973 review round 2 R5 swapped the rest of the staged set in as soon as the unlock had removed a foreign staged
  // database, journal or not, so a foreign document stage beside it was lost in that same unlock. Now each document or
  // image stage in doubt is judged on its own, after the database's decision.
  it('beside a staged database from another workspace: the unlock removes it and the foreign document stage, and swaps in the document stage that opens', async () => {
    const other = await workspaceWithCopies('fmtguard-1001-other', 'other-password')
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const d2 = await whileUnlocked(vp, (ctl) => retiredCopyAndStage(ctl, vp, 'documents', 'd2.pdf.enc', 'the new copy of d2'))
    const foreignStage = `${copies.documents}${REKEY_SUFFIX}`
    copyFileSync(other.copies.documents, foreignStage)
    copyFileSync(other.vp.encPath, `${vp.encPath}${REKEY_SUFFIX}`) // a staged database under the other workspace's key
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before) // the staged database in doubt: the start leaves the whole set
      expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
      expect(ctl.takeStageOutcome()).toBe('removed')
      expect(existsSync(foreignStage)).toBe(false)
      expect(sha(copies.documents)).toBe(before[keyOf(vp, copies.documents)])
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
      expect(existsSync(d2.staged)).toBe(false)
      expect(await readStoredCopy(ctl, vp.root, d2.target)).toBe('the new copy of d2')
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 1, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // A staged database that opens under the data key (a password change of a build before 0.1.60, cut short after its
  // commit) rolls the staged set forward at the unlock (#973). The document and image stages no journal lists are still
  // judged one by one: the foreign document stage is removed, the image stage that opens is swapped in.
  it('beside a staged database that opens under the data key: the unlock rolls it forward, removes the foreign document stage and swaps in the image stage that opens', async () => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const i2 = await whileUnlocked(vp, (ctl) => retiredCopyAndStage(ctl, vp, 'images', 'i2.png.enc', 'the new copy of i2'))
    const foreignStage = `${copies.documents}${REKEY_SUFFIX}`
    writeFileSync(foreignStage, await foreignCopy('documents'))
    renameSync(vp.encPath, `${vp.encPath}${REKEY_SUFFIX}`) // the database staged under this workspace's own key
    // #1027: beside it the old `.enc`, still under the retired key that nothing holds any more, as a change cut short
    // before its database swap leaves it. (A copy of `.enc` here opens under the data key too: no pending change, but a
    // stale stage the unlock removes.)
    const retiredSrc = join(vp.root, 'retired-db.bin')
    writeFileSync(retiredSrc, 'the database under the retired key')
    encryptFile(retiredSrc, vp.encPath, randomBytes(32))
    rmSync(retiredSrc)
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(snapshot(vp.root)).toEqual(before)
      ctl.unlock(PW)
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(5151)
      expect(existsSync(`${vp.encPath}${REKEY_SUFFIX}`)).toBe(false)
      expect(ctl.takeStageOutcome()).toBeNull() // rolled forward: nothing to log
      expect(existsSync(foreignStage)).toBe(false)
      expect(sha(copies.documents)).toBe(before[keyOf(vp, copies.documents)])
      expect(await readStoredCopy(ctl, vp.root, copies.documents)).toBe(textOf('documents', 'fmtguard-1001'))
      expect(existsSync(i2.staged)).toBe(false)
      expect(await readStoredCopy(ctl, vp.root, i2.target)).toBe('the new copy of i2')
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 1, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // The rule never touches a stage a journal lists by its full path: the start swaps that one in and clears the journal
  // as before (#241), and leaves only the image stage no journal lists, which the unlock removes.
  it('a journal that lists a document stage, and a copy from another workspace at the staged name of a stored image copy: the start swaps the listed one in, the unlock removes the other', async () => {
    const { vp, copies } = await workspaceWithCopies('fmtguard-1001')
    const d2 = await whileUnlocked(vp, (ctl) => retiredCopyAndStage(ctl, vp, 'documents', 'd2.pdf.enc', 'the new copy of d2'))
    const journal = rekeyJournal(vp, 1, [d2.staged])
    const foreignStage = `${copies.images}${REKEY_SUFFIX}`
    writeFileSync(foreignStage, await foreignCopy('images'))
    const before = snapshot(vp.root)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(d2.staged)).toBe(false) // the start swaps the listed stage in, as before
      expect(sha(d2.target)).toBe(before[keyOf(vp, d2.staged)])
      expect(existsSync(journal)).toBe(false)
      expect(sha(copies.images)).toBe(before[keyOf(vp, copies.images)]) // and leaves the one no journal lists
      expect(sha(foreignStage)).toBe(before[keyOf(vp, foreignStage)])
      ctl.unlock(PW)
      expect(existsSync(foreignStage)).toBe(false)
      expect(await readStoredCopy(ctl, vp.root, copies.images)).toBe(textOf('images', 'fmtguard-1001'))
      expect(await readStoredCopy(ctl, vp.root, d2.target)).toBe('the new copy of d2')
      expect(ctl.takeSidecarStageOutcome()).toEqual({ rolledForward: 0, removed: 1, left: 0, setAside: 0 })
    } finally {
      ctl.shutdown()
    }
  })

  // Controls, green before and after: a stage that opens under the data key beside a stored copy under the retired key
  // ends swapped in (only the moment moves, from the start to the unlock), and a stage whose stored copy is gone (a swap
  // cut short between its shred and its rename) is the only copy left, which the start renames into place as before.
  it('a stage that opens under the data key beside a stored copy under the retired key: after the unlock the document reads the staged copy', async () => {
    const vp = lockedVault('fmtguard-1001', PW)
    const d2 = await whileUnlocked(vp, (ctl) => retiredCopyAndStage(ctl, vp, 'documents', 'd2.pdf.enc', 'the new copy of d2'))
    const ctl = unlockedController(vp, PW)
    try {
      expect(existsSync(d2.staged)).toBe(false)
      expect(await readStoredCopy(ctl, vp.root, d2.target)).toBe('the new copy of d2')
    } finally {
      ctl.shutdown()
    }
  })

  it('a stage whose stored copy is gone: the start renames it into place, as before', async () => {
    const vp = lockedVault('fmtguard-1001', PW)
    const d2 = await whileUnlocked(vp, (ctl) => retiredCopyAndStage(ctl, vp, 'documents', 'd2.pdf.enc', 'the new copy of d2'))
    rmSync(d2.target)
    const stage = sha(d2.staged)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(existsSync(d2.staged)).toBe(false)
      expect(sha(d2.target)).toBe(stage)
      ctl.unlock(PW)
      expect(await readStoredCopy(ctl, vp.root, d2.target)).toBe('the new copy of d2')
    } finally {
      ctl.shutdown()
    }
  })
})
