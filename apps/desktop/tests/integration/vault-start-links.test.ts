import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import {
  REKEY_JOURNAL_NAME,
  REKEY_SUFFIX,
  QUARANTINE_SUFFIX,
  ROTATED_ENCRYPTED_LOG_NAME,
  VaultRecoveryBlockedError,
  WORKING_COPY_LOST_MARKER,
  WorkspaceController,
  createEncryptedVaultOnDisk,
  encryptFile
} from '../../src/main/services/workspace-vault'
import {
  ENCRYPTION_REQUIRED,
  FAST_KDF,
  endedUnlocked,
  freshVaultPaths,
  lockedVault,
  thrownBy,
  unlockedController,
  type FreshVaultPaths
} from '../helpers/vault-fixtures'
import { openRawDb, tempRoot } from '../helpers/db-fixtures'
import { FOLDER_LINKS, UNSEEN_JUNCTIONS, unlinkFolder, type FolderLink } from '../helpers/folder-links'

// T2.16 fix round (W-83, frozen F-9; G-43 (b)): the start of an encrypted workspace runs at every launch, before any
// password, and a file a drive carries must never make it act on a file outside the workspace. These rows put a link
// where the start meets a folder, and require every file behind it byte for byte.
//   - R1 B-1: a Windows junction whose target is not of the form `\??\X:\…` (a volume GUID path, or a
//     `\\?\GLOBALROOT\Device\HarddiskVolumeN\…` path) reads as a plain folder to Node's `lstat` and to the JS
//     `realpathSync`, so "no link on the way" let it through, for a journal entry and for the store folders the sweep and
//     the stage scan read. The links are made by `tests/helpers/folder-links.ts`.
//   - R2 B2 (owner 2026-11-24: fix): the workspace folder itself, or the logs folder, a link to a folder elsewhere. The
//     start skips the sweep, the stage scan and the rekey recovery behind a linked workspace folder, and the removal of
//     the rotated log behind a linked logs folder, and says so (content-free) for the log. Round 2: the unlock skips its
//     own rekey recovery (before the password check) behind a linked workspace folder too, and the start no longer
//     removes a create's orphaned stage there; the unlock otherwise reads and writes through the link as before.
//   - R1 B-2, beside it: the #911 salvage's WAL replay never runs into a working file behind a linked workspace folder.
// The `\??\X:\…` junction and the symbolic link at a store folder are T2.9's rows (workspace-vault-format-guard).

const PW = 'right-password'
const isWindows = process.platform === 'win32'
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
/** A path as Windows compares it (case-blind there), as it is elsewhere. */
const folded = (path: string): string => (isWindows ? path.toLowerCase() : path)

/** sha256 of every file below `dir`, by its path under `dir` (folders listed as `dir`), never through a link below it. */
function filesBelow(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      const rel = relative(dir, full).split('\\').join('/')
      if (lstatSync(full).isDirectory()) {
        out[`${rel}/`] = 'dir'
        walk(full)
      } else out[rel] = sha(full)
    }
  }
  walk(dir)
  return out
}

/** A plaintext file at `path` (its folder created). */
function plant(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('a junction Node reads as a plain folder is still a link to the start (T2.16, R1 B-1)', () => {
  for (const [label, make, can] of UNSEEN_JUNCTIONS) {
    // The R2-3 rows of workspace-vault-format-guard, for the two forms `lstat` cannot see: both store folders such a
    // junction to a folder elsewhere. Before, the start's sweep overwrote and removed the `*.tmp` and `*.parse*` files
    // behind them, the stage scan had the rekey recovery rename the `*.enc.new` files there into place, and the unlock
    // removed the one beside its stored copy.
    it.skipIf(!can)(`both store folders ${label}: the start, the unlock and the lock shred, rename and delete nothing behind them`, () => {
      const vp = lockedVault('start-links-b1', PW)
      const ws = dirname(vp.dbPath)
      const behind = { documents: join(vp.root, 'elsewhere-documents'), images: join(vp.root, 'elsewhere-images') }
      for (const store of ['documents', 'images'] as const) {
        mkdirSync(behind[store])
        make(behind[store], join(ws, store))
      }
      try {
        plant(join(behind.documents, 'x.parse.pdf'), '%PDF-1.7 behind the link')
        plant(join(behind.documents, 'x.pdf.enc.tmp'), 'a write temp behind the link')
        plant(join(behind.documents, 'a.pdf.enc.new'), 'a stage behind the link, no stored copy')
        plant(join(behind.documents, 'b.pdf.enc'), 'a stored copy behind the link')
        plant(join(behind.documents, 'b.pdf.enc.new'), 'a stage beside it')
        plant(join(behind.images, 'i.read-42.tmp'), 'an image temp behind the link')
        plant(join(behind.images, 'c.png.enc.new'), 'an image stage behind the link, no stored copy')
        const stateOf = (): unknown => ({ documents: filesBelow(behind.documents), images: filesBelow(behind.images) })
        const before = stateOf()
        expect(lstatSync(join(ws, 'documents')).isSymbolicLink(), 'Node reads the junction as a folder').toBe(false)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(stateOf(), 'after the start').toEqual(before)
          expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
          expect(ctl.unlock(PW).state).toBe('unlocked')
          expect(ctl.takeSidecarStageOutcome()).toBeNull() // no stage behind the link judged
          expect(stateOf(), 'after the unlock').toEqual(before)
          ctl.lock()
          expect(stateOf(), 'after the lock').toEqual(before)
        } finally {
          ctl.shutdown()
        }
      } finally {
        for (const store of ['documents', 'images']) unlinkFolder(join(ws, store))
      }
    })

    // password-change's junction row (#1014 round 3), for the two forms: a journal entry whose path runs through
    // `documents/J`, `J` such a junction to a folder elsewhere. Before, the entry read as inside the workspace, and the
    // start shredded the file behind the link and renamed the stage over it.
    it.skipIf(!can)(`a journal entry whose path runs through ${label} inside the workspace: the files behind it stay byte for byte`, () => {
      const vp = lockedVault('start-links-b1', PW)
      const away = join(vp.root, 'away')
      const victim = plant(join(away, 'letter.pdf.enc'), 'outside: letter')
      plant(`${victim}${REKEY_SUFFIX}`, 'outside: stage')
      const docs = join(dirname(vp.dbPath), 'documents')
      mkdirSync(docs, { recursive: true })
      const link = join(docs, 'J')
      make(away, link)
      try {
        const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
        writeFileSync(journal, JSON.stringify({ version: 1, staged: [join(link, `letter.pdf.enc${REKEY_SUFFIX}`)], remove: [] }))
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(readFileSync(victim, 'utf8')).toBe('outside: letter')
          expect(readFileSync(`${victim}${REKEY_SUFFIX}`, 'utf8')).toBe('outside: stage')
          expect(ctl.takeJournalRefusals(), 'the start: the entry waits for the database').toBe(0)
          expect(ctl.unlock(PW).state).toBe('unlocked')
          expect(readFileSync(victim, 'utf8')).toBe('outside: letter')
          expect(readFileSync(`${victim}${REKEY_SUFFIX}`, 'utf8')).toBe('outside: stage')
          expect(ctl.takeJournalRefusals()).toBe(1) // no document lists its stored copy: dropped once counted
          expect(existsSync(journal)).toBe(false)
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(link)
      }
    })
  }
})

/** The locked vault at `vp` with its workspace folder moved to `<root>/ws-elsewhere` and `make` linked in its place;
 *  returns the folder behind the link. */
function linkedWorkspace(vp: FreshVaultPaths, make: FolderLink): string {
  const ws = dirname(vp.dbPath)
  const elsewhere = join(vp.root, 'ws-elsewhere')
  renameSync(ws, elsewhere)
  make(elsewhere, ws)
  return elsewhere
}

describe('the workspace folder or the logs folder itself a link (T2.16, R2 B2)', () => {
  for (const [label, make, can] of FOLDER_LINKS) {
    // Review 2's probe P3: with `<drive>/workspace` a link, every test measured from the folder behind it, so all of it
    // was "inside": the sweep shredded `documents/*.tmp` and `images/*.parse*` there, the stage scan had a stage there
    // renamed into place, and a journal entry spelled through the link had a file there shredded and replaced.
    it.skipIf(!can)(`the workspace folder ${label} to a folder elsewhere: the start shreds, renames and deletes nothing behind it, and notes it`, () => {
      const vp = lockedVault('start-links-ws', PW)
      const ws = dirname(vp.dbPath)
      const elsewhere = linkedWorkspace(vp, make)
      try {
        plant(join(elsewhere, 'hilbertraum.sqlite.tmp'), 'USER FILE: a name the sweep shreds')
        plant(join(elsewhere, 'documents', 'thesis.tmp'), 'USER FILE 1')
        plant(join(elsewhere, 'images', 'holiday.parse.jpg'), 'USER FILE 2')
        plant(join(elsewhere, 'documents', 'a.pdf.enc.new'), 'USER FILE: a stage with no stored copy')
        plant(join(elsewhere, 'sub', 'x.enc'), 'USER FILE 3')
        plant(join(elsewhere, 'sub', 'x.enc.new'), 'PLANTED')
        writeFileSync(
          join(elsewhere, REKEY_JOURNAL_NAME),
          JSON.stringify({ version: 1, staged: [join(ws, 'sub', 'x.enc.new')], remove: [] })
        )
        const before = filesBelow(elsewhere)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(filesBelow(elsewhere), 'after the start').toEqual(before)
          expect(ctl.linkedStartFolders()).toEqual(['workspace'])
          expect(ctl.isRecoveryBlocked()).toBe(false)
          expect(ctl.getState().state).toBe('locked')
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(ws)
      }
    })
  }

  // Round 2 (S-1, the owner's B2 decision applied to the unlock): the unlock runs the rekey recovery again before it
  // checks the password, so one keystroke into the lock screen had the journal swap a file behind the link after all.
  // Behind a linked workspace folder that recovery is skipped too, for every password: what a password change cut short
  // left there waits, and only the unlock's own reads and writes (the working file it decrypts) go through the link.
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`the workspace folder ${label}, a password change's journal pending behind it: neither a wrong password nor the right one has the unlock act on it`, () => {
      const vp = lockedVault('start-links-unlock', PW)
      const ws = dirname(vp.dbPath)
      const elsewhere = linkedWorkspace(vp, make)
      try {
        plant(join(elsewhere, 'documents', 'a.pdf.enc.new'), 'USER FILE: a stage with no stored copy')
        plant(join(elsewhere, 'sub', 'x.enc'), 'USER FILE 3')
        plant(join(elsewhere, 'sub', 'x.enc.new'), 'PLANTED')
        writeFileSync(
          join(elsewhere, REKEY_JOURNAL_NAME),
          JSON.stringify({ version: 1, staged: [join(ws, 'sub', 'x.enc.new')], remove: [] })
        )
        const before = filesBelow(elsewhere)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(thrownBy(() => ctl.unlock('wrong-password')).name).toBe('WrongPasswordError')
          expect(filesBelow(elsewhere), 'after a wrong password').toEqual(before)
          expect(ctl.unlock(PW).state).toBe('unlocked')
          const opened = filesBelow(elsewhere)
          const asBefore = Object.fromEntries(Object.keys(before).map((name) => [name, opened[name]]))
          expect(asBefore, 'after the right password: every file that was there').toEqual(before)
          expect(ctl.lock().state).toBe('locked')
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(ws)
      }
    })
  }

  // Round 2 (S-6): with no key file, no `.enc` and no journal the start removes a create's orphaned `.enc.new` and its
  // write temp (#973); behind a linked workspace folder those names lie elsewhere, so they are left.
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`the workspace folder ${label} with no workspace in it: the start removes no orphaned stage behind it`, () => {
      const vp = freshVaultPaths('start-links-orphan')
      const ws = dirname(vp.dbPath)
      const elsewhere = linkedWorkspace(vp, make)
      try {
        // A frame of this build's (as a create's stage is), under a key nothing holds, and its write temp.
        const src = plant(join(vp.root, 'stage-src.bin'), 'a create cut short before its commit')
        encryptFile(src, join(elsewhere, `hilbertraum.sqlite.enc${REKEY_SUFFIX}`), randomBytes(32))
        plant(join(elsewhere, `hilbertraum.sqlite.enc${REKEY_SUFFIX}.tmp`), 'USER FILE: its write temp')
        const before = filesBelow(elsewhere)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(filesBelow(elsewhere), 'after the start').toEqual(before)
          expect(ctl.getState().state).toBe('uninitialized')
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(ws)
      }
    })
  }

  // The other side of the owner's call: a workspace a user keeps behind a link of their own still opens, saves and
  // locks through it (the unlock reads and writes through the normal paths); only the start's clean-up waits.
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`a workspace folder that is ${label} of the user's own opens, keeps what the session wrote and locks`, () => {
      const vp = lockedVault('start-links-own', PW)
      const ws = dirname(vp.dbPath)
      const elsewhere = linkedWorkspace(vp, make)
      try {
        const encBefore = sha(join(elsewhere, 'hilbertraum.sqlite.enc'))
        const ctl = unlockedController(vp, PW)
        try {
          updateSettings(ctl.requireDb(), { contextTokens: 6262 })
          expect(ctl.lock().state).toBe('locked')
          expect(sha(join(elsewhere, 'hilbertraum.sqlite.enc')), 'the lock wrote `.enc` behind the link').not.toBe(encBefore)
          expect(ctl.unlock(PW).state).toBe('unlocked')
          expect(getSettings(ctl.requireDb()).contextTokens).toBe(6262)
          ctl.lock()
        } finally {
          ctl.shutdown()
        }
        expect(folded(realpathSync.native(ws)), 'the workspace folder is still the link').toBe(folded(realpathSync.native(elsewhere)))
      } finally {
        unlinkFolder(ws)
      }
    })
  }

  // R1 B-5 = R2 B2 (logs): the rotated log is removed at the path the app computes, `logs/app.1.log.enc`. With `logs/` a
  // link, the file of that name in the folder it reaches was deleted (probe P3: `logs: []`).
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`the logs folder ${label} to a folder elsewhere: a journal that flags the rotated log leaves the file there, and the start notes it`, () => {
      const vp = lockedVault('start-links-logs', PW, { logs: true })
      const logs = vp.logsPath!
      const logsElsewhere = join(vp.root, 'logs-elsewhere')
      rmSync(logs, { recursive: true, force: true })
      const victim = plant(join(logsElsewhere, ROTATED_ENCRYPTED_LOG_NAME), 'USER FILE 4')
      make(logsElsewhere, logs)
      try {
        const journal = join(dirname(vp.dbPath), REKEY_JOURNAL_NAME)
        writeFileSync(journal, JSON.stringify({ version: 1, staged: [], remove: [ROTATED_ENCRYPTED_LOG_NAME] }))
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(readFileSync(victim, 'utf8')).toBe('USER FILE 4')
          expect(ctl.linkedStartFolders()).toEqual(['logs'])
          expect(existsSync(journal), 'nothing else waits: the journal is settled').toBe(false)
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(logs)
      }
    })
  }

  // R1 B-2, through the workspace folder: with `.enc` missing the #911 salvage replays the `-wal` into the working file
  // before any password. Behind a linked workspace folder that file is elsewhere, so the replay is not made and the start
  // blocks with every file left (as #242 blocks), until the link is gone.
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`the workspace folder ${label}, with .enc missing after a session ended unlocked: no replay, the start blocks, every file stays`, () => {
      const vp = lockedVault('start-links-911', PW)
      endedUnlocked(vp, 9119, PW)
      rmSync(vp.encPath)
      const ws = dirname(vp.dbPath)
      const elsewhere = linkedWorkspace(vp, make)
      try {
        const before = filesBelow(elsewhere)
        expect(Object.keys(before)).toEqual(expect.arrayContaining(['hilbertraum.sqlite', 'hilbertraum.sqlite-wal']))
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(filesBelow(elsewhere), 'after the start').toEqual(before)
          expect(ctl.isRecoveryBlocked()).toBe(true)
          expect(() => ctl.unlock(PW)).toThrow(VaultRecoveryBlockedError)
          expect(filesBelow(elsewhere), 'after the unlock').toEqual(before)
        } finally {
          ctl.shutdown()
        }
        expect(statSync(join(elsewhere, 'hilbertraum.sqlite')).isFile()).toBe(true)
      } finally {
        unlinkFolder(ws)
      }
    })
  }
})

// T2.7 security fix round (F-1, F-2; frozen F-9): the vault writes every file it replaces through a temp at a fixed name
// beside it and renames that temp into place. A drive formatted NTFS, APFS or ext4 can carry a link at such a name (a
// Kit's exFAT cannot), and opening the temp with 'w' wrote through it into the file it reaches. Each write temp is now
// removed by its name first (`lstat`, never followed) and created anew ('wx'). Each row puts a link at one name, to a
// file outside the workspace, and requires that file byte for byte; the vault's own file then is a regular file.

/** A file link at `link` to the file `target`. */
type FileLink = (target: string, link: string) => void
const fileSymlink: FileLink = (target, link) => symlinkSync(target, link, 'file')
/** Can this account make a symbolic link to a file? (On Windows only with Developer Mode or the privilege.) */
function canLinkFiles(make: FileLink): boolean {
  const root = tempRoot('file-links-can')
  try {
    writeFileSync(join(root, 'target'), '')
    make(join(root, 'target'), join(root, 'link'))
    return true
  } catch {
    return false
  }
}
/** The file links a drive can carry: a hard link needs no privilege; a symbolic link to a file is made where this
 *  account may (here, on Windows, it may not: the macOS and Ubuntu CI legs run it). */
const FILE_LINKS: Array<[string, FileLink, boolean]> = [
  ['a hard link', (target, link) => linkSync(target, link), true],
  ['a symbolic link', fileSymlink, canLinkFiles(fileSymlink)]
]

/** A file outside `config/` and `workspace/` (under `<root>/elsewhere/`), with `text` in it. */
const victimOf = (vp: FreshVaultPaths, name: string, text: string): string => plant(join(vp.root, 'elsewhere', name), text)

/** `path` is a regular file no other name shares, as the app writes its own files. */
const ownFile = (path: string): boolean => {
  const named = lstatSync(path)
  return named.isFile() && named.nlink <= 1
}

describe('a link at one of the vault’s fixed write-temp names is never written through (T2.7, F-1, F-2)', () => {
  // F-1: the unlock decrypts the database into `hilbertraum.sqlite.tmp` and renames it into place. On a drive with no
  // workspace yet the start runs no sweep, and the create's unlock met the link there: the whole database was written
  // into the file it reached, the session wrote into it under the database's name, and the lock only unlinked that name.
  for (const [label, make, can] of FILE_LINKS) {
    it.skipIf(!can)(`${label} at the decrypt's temp name before a create: the file it reaches never gets the workspace (F-1)`, () => {
      const vp = freshVaultPaths('start-links-f1')
      const victim = victimOf(vp, 'notes.txt', 'USER FILE: notes')
      make(victim, `${vp.dbPath}.tmp`)
      const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
      ctl.init()
      try {
        expect(ctl.create(PW, 'encrypted').state).toBe('unlocked')
        expect(ownFile(vp.dbPath), 'the working file is the decrypt’s own').toBe(true)
        updateSettings(ctl.requireDb(), { contextTokens: 7373 })
        expect(readFileSync(victim, 'utf8'), 'after the create and a write').toBe('USER FILE: notes')
        ctl.lock()
        expect(readFileSync(victim, 'utf8'), 'after the lock').toBe('USER FILE: notes')
        expect(ctl.unlock(PW).state).toBe('unlocked')
        expect(getSettings(ctl.requireDb()).contextTokens).toBe(7373)
      } finally {
        ctl.shutdown()
      }
    })
  }

  // F-1, the async twin: a document or image copy is decrypted into `<dest>.tmp` and renamed into place.
  it('a hard link at a copy’s decrypt temp name: decryptFileAsync writes the plaintext only to its own file (F-1)', async () => {
    const vp = lockedVault('start-links-f1-async', PW)
    const ctl = unlockedController(vp, PW)
    try {
      const src = plant(join(vp.root, 'src.txt'), 'the document text')
      const stored = join(dirname(vp.dbPath), 'documents', 'doc.txt.enc')
      mkdirSync(dirname(stored), { recursive: true })
      await ctl.documentCipher()!.encryptFileAsync(src, stored)
      const dest = join(dirname(vp.dbPath), 'documents', 'doc.parse.txt')
      const victim = victimOf(vp, 'letter.txt', 'USER FILE: letter')
      linkSync(victim, `${dest}.tmp`)
      await ctl.documentCipher()!.decryptFileAsync(stored, dest)
      expect(readFileSync(victim, 'utf8')).toBe('USER FILE: letter')
      expect(readFileSync(dest, 'utf8')).toBe('the document text')
      expect(ownFile(dest)).toBe(true)
    } finally {
      ctl.shutdown()
    }
  })

  // F-2: the lock re-encrypts the working file into `hilbertraum.sqlite.enc.tmp` (no start removes that name).
  it('a hard link at the lock’s encrypt temp name: the file it reaches is not overwritten with ciphertext (F-2)', () => {
    const vp = lockedVault('start-links-f2-enc', PW)
    const victim = victimOf(vp, 'workspace.json', 'USER FILE: another drive’s key file')
    const ctl = unlockedController(vp, PW)
    try {
      linkSync(victim, `${vp.encPath}.tmp`)
      updateSettings(ctl.requireDb(), { contextTokens: 6464 })
      expect(ctl.lock().state).toBe('locked')
      expect(readFileSync(victim, 'utf8')).toBe('USER FILE: another drive’s key file')
      expect(ownFile(vp.encPath)).toBe(true)
      expect(ctl.unlock(PW).state).toBe('unlocked')
      expect(getSettings(ctl.requireDb()).contextTokens).toBe(6464)
    } finally {
      ctl.shutdown()
    }
  })

  // F-2, the async twin: an imported document or image is encrypted into `<dest>.tmp` and renamed into place.
  it('a hard link at a copy’s encrypt temp name: encryptFileAsync writes only its own file (F-2)', async () => {
    const vp = lockedVault('start-links-f2-async', PW)
    const ctl = unlockedController(vp, PW)
    try {
      const src = plant(join(vp.root, 'src.txt'), 'the document text')
      const stored = join(dirname(vp.dbPath), 'documents', 'doc.txt.enc')
      mkdirSync(dirname(stored), { recursive: true })
      const victim = victimOf(vp, 'letter.txt', 'USER FILE: letter')
      linkSync(victim, `${stored}.tmp`)
      await ctl.documentCipher()!.encryptFileAsync(src, stored)
      expect(readFileSync(victim, 'utf8')).toBe('USER FILE: letter')
      expect(ownFile(stored)).toBe(true)
    } finally {
      ctl.shutdown()
    }
  })

  // F-2: the create and every password change write the descriptor into `config/workspace.json.tmp` (no start step
  // looks in `config/`).
  it('a hard link at the descriptor’s temp name before a create: the file it reaches is not overwritten (F-2)', () => {
    const vp = freshVaultPaths('start-links-f2-desc')
    const victim = victimOf(vp, 'other-kit-workspace.json', 'USER FILE: another workspace’s key file')
    linkSync(victim, `${vp.descriptorPath}.tmp`)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      expect(ctl.create(PW, 'encrypted').state).toBe('unlocked')
      expect(readFileSync(victim, 'utf8')).toBe('USER FILE: another workspace’s key file')
      expect(ownFile(vp.descriptorPath)).toBe(true)
      ctl.lock()
      expect(ctl.unlock(PW).state).toBe('unlocked')
    } finally {
      ctl.shutdown()
    }
  })

  // F-2: the create opens `hilbertraum.sqlite` with SQLite, which opens it, its `-wal` and its `-shm` by their names and
  // writes through a link at any of them (T2.16 R1 B-2 measured it for the replay). Before that open, each of the three
  // must be absent or a regular file no other name shares, as the replay requires (`replayMayWrite`); otherwise the
  // create is refused, with nothing written. (The controller's create moves a leftover at these names aside first on a
  // build that allows no plaintext, F-3: these rows call the create's on-disk step itself.)
  it.each<[string, (path: string) => void]>([
    // The database of another program: SQLite would open it and run the app's migrations in it.
    [
      'hilbertraum.sqlite',
      (path) => {
        const raw = openRawDb(path)
        try {
          raw.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('USER ROW');")
        } finally {
          raw.close()
        }
      }
    ],
    ['hilbertraum.sqlite-wal', (path) => writeFileSync(path, 'USER FILE: a write-ahead log’s name')],
    ['hilbertraum.sqlite-shm', (path) => writeFileSync(path, 'USER FILE: a shared-memory file’s name')]
  ])('a hard link at %s before the create opens the database: the create is refused, the file it reaches stays (F-2)', (name, makeVictim) => {
    const vp = freshVaultPaths('start-links-f2-sqlite')
    const victim = join(vp.root, 'elsewhere', 'victim')
    mkdirSync(dirname(victim), { recursive: true })
    makeVictim(victim)
    const before = sha(victim)
    linkSync(victim, join(dirname(vp.dbPath), name))
    expect(thrownBy(() => createEncryptedVaultOnDisk(vp, PW, FAST_KDF)).name).toBe('Error')
    expect(sha(victim)).toBe(before)
    expect(existsSync(vp.descriptorPath), 'nothing committed').toBe(false)
    expect(existsSync(vp.encPath)).toBe(false)
  })
})

// T2.7 security re-check 1 (N-1; the owner's "keep the set-aside files"): a create sets a leftover database aside under
// `hilbertraum.sqlite.quarantine`. A create that failed after it opened its own fresh database left that file, and a retry
// moved it over the copy set aside before, which was lost. A failed create now removes its own fresh database, and a
// set-aside goes to the first free name (`.quarantine`, then `.quarantine-<n>`), so nothing set aside is replaced.
describe('a create never replaces what an earlier create set aside (T2.7 re-check, N-1)', () => {
  it('two creates that fail after their open, a leftover before each: both set-aside copies stay byte for byte, and neither leaves its own database', () => {
    const vp = freshVaultPaths('start-links-n1')
    const leftover = (text: string): string => {
      const raw = openRawDb(vp.dbPath)
      try {
        raw.exec(`CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('${text}');`)
      } finally {
        raw.close()
      }
      return sha(vp.dbPath)
    }
    // A folder at the staged encrypt's temp name fails each create after it opened and wrote its fresh database.
    mkdirSync(`${vp.encPath}${REKEY_SUFFIX}.tmp`)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    try {
      const first = leftover('USER COPY A')
      expect(() => ctl.create(PW, 'encrypted')).toThrow(/EEXIST/)
      expect(existsSync(vp.dbPath), 'the failed create removed its own database').toBe(false)
      const second = leftover('USER COPY B')
      expect(() => ctl.create(PW, 'encrypted')).toThrow(/EEXIST/)
      expect(existsSync(vp.dbPath)).toBe(false)
      const aside = `${vp.dbPath}${QUARANTINE_SUFFIX}`
      expect(sha(aside), 'the first copy set aside').toBe(first)
      expect(sha(`${aside}-1`), 'the second, at the next free name').toBe(second)
    } finally {
      ctl.shutdown()
    }
  })
})

// T2.7 security fix round (L-2): the start writes and removes the #875 marker in `config/`, before any password. With
// `config/` a link to a folder elsewhere, a file of that name was created, replaced or removed there. Now, as behind a
// linked workspace or logs folder (T2.16 R2 B2), the marker is neither written nor removed behind it (this run still
// shows the notice), and the start notes the folder for its log line.
describe('the config folder a link (T2.7, L-2)', () => {
  for (const [label, make, can] of FOLDER_LINKS) {
    it.skipIf(!can)(`the config folder ${label} to a folder elsewhere: the start and the unlock neither write nor remove the #875 marker there, and the start notes it`, () => {
      const vp = lockedVault('start-links-config', PW)
      endedUnlocked(vp, 8282, PW) // an unclean end: the start's sweep records it in a marker
      const config = dirname(vp.descriptorPath)
      const elsewhere = join(vp.root, 'config-elsewhere')
      renameSync(config, elsewhere)
      make(elsewhere, config)
      try {
        // A marker of this build's format naming another snapshot: the start would remove it as stale.
        const marker = plant(join(elsewhere, WORKING_COPY_LOST_MARKER), JSON.stringify({ v: 1, enc: 'AAAAAAAAAAAAAAAA', cause: 'lock' }))
        const before = filesBelow(elsewhere)
        const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
        ctl.init()
        try {
          expect(filesBelow(elsewhere), 'after the start').toEqual(before)
          expect(ctl.linkedStartFolders()).toEqual(['config'])
          expect(ctl.getState()).toMatchObject({ state: 'locked', lockNotice: 'session_not_closed' })
          expect(ctl.unlock(PW).state).toBe('unlocked')
          expect(readFileSync(marker, 'utf8'), 'after the unlock').toBe(JSON.stringify({ v: 1, enc: 'AAAAAAAAAAAAAAAA', cause: 'lock' }))
        } finally {
          ctl.shutdown()
        }
      } finally {
        unlinkFolder(config)
      }
    })
  }
})
