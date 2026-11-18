import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { openDatabase } from '../../src/main/services/db'
import { getSettings, seedSettings, updateSettings } from '../../src/main/services/settings'
import { decrypt, deriveKey, verifyKey } from '../../src/main/services/security/crypto'
import {
  RECOVERY_SUFFIX,
  REKEY_JOURNAL_NAME,
  REKEY_SUFFIX,
  WorkspaceController,
  cleanSidecars,
  encryptFile,
  readVaultDescriptorChecked,
  shredFile,
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
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(/already exists/)
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
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(/already exists/)
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
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(/already exists/)
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
      expect(() => ctl.unlock(PW)).toThrow(/missing or unreadable/)
      expect(() => ctl.create('another-password', 'encrypted')).toThrow(/already exists/)
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
  it.each([
    ['v0.1.65', 'golden-throwaway-v0.1.65', 'eace4d6f3982e42992f5e3757133bedbdc505d0e544101c89437fb28825848f4'],
    ['v0.1.50', 'golden-throwaway-v0.1.50', '1d524326f2f0721c282a2c26fddb1b22518b66929aabd9d3932ddf25a41a0a4c']
  ])('the descriptor %s wrote reads as current, unlocks and stays byte for byte', (tag, password, sha256) => {
    const fixture = readFileSync(join(__dirname, '..', 'fixtures', 'vault-golden', `${tag}-workspace.json`))
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(sha256) // the bytes PROVENANCE.md records
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
