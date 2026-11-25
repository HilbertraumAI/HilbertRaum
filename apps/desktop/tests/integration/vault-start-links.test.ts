import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import {
  REKEY_JOURNAL_NAME,
  REKEY_SUFFIX,
  ROTATED_ENCRYPTED_LOG_NAME,
  VaultRecoveryBlockedError,
  WorkspaceController,
  encryptFile
} from '../../src/main/services/workspace-vault'
import {
  ENCRYPTION_REQUIRED,
  endedUnlocked,
  freshVaultPaths,
  lockedVault,
  thrownBy,
  unlockedController,
  type FreshVaultPaths
} from '../helpers/vault-fixtures'
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
