import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  WorkspaceController,
  WrongPasswordError,
  cleanSidecars,
  encryptFile,
  shredFile,
  unlockEncryptedVault,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { SCHEMA_VERSION, WorkspaceNewerError, openDatabase } from '../../src/main/services/db'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { IPC } from '../../src/shared/ipc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import {
  ENCRYPTION_REQUIRED,
  freshVaultPaths,
  lockedVault,
  newerPlaintext,
  newerVault,
  thrownBy,
  workspaceIpcCtx,
  writeNewerSchema
} from '../helpers/vault-fixtures'
import type { WorkspaceActionResult } from '../../src/shared/types'

// #247 (owner decision #225 — "ratify"): a workspace database stamped by a NEWER build is
// refused by this build — the vault controller throws the typed `WorkspaceNewerError`, the
// unlock/create IPC answers `{ ok: false, reason: 'workspace_newer', message }` ("update the
// app"), and nothing is written or left at rest: on the encrypted flavour the decrypted
// working file is shredded again and `.enc` is byte-identical; on the plaintext flavour the
// file is untouched. Before this the same database opened and the app degraded silently.
// The unlock IPC's reason and its copy in every language: workspace-ipc.test.ts (the D-17
// table, "unlock workspace_newer"); the stamp itself: db-user-version.test.ts.
// Scratch vaults only (never a real workspace).

const ipcState = vi.hoisted(() => ({ handlers: new Map() as IpcHandlers }))
vi.mock('electron', async () => ({
  ipcMain: (await import('../helpers/ipc')).fakeIpcMain(ipcState.handlers)
}))
const handlers = ipcState.handlers

beforeEach(() => ipcState.handlers.clear())

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/**
 * The locked vault at `vp` (created under `password`) with `.enc` written again around its own database after `edit`
 * changed that file (the database checkpointed and closed first): what a newer build's lock leaves when its database is
 * one this build's SQLite cannot read as it reads its own. Encrypted under the vault's real data key, so the unlock
 * authenticates it and only SQLite can tell. The working file and its sidecars are removed again: the vault stays locked.
 */
function reencryptedAround(vp: VaultPaths, password: string, edit: (dbPath: string) => void): void {
  const { db, key } = unlockEncryptedVault(vp, password)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()
    edit(vp.dbPath)
    encryptFile(vp.dbPath, vp.encPath, key)
  } finally {
    key.fill(0)
    shredFile(vp.dbPath)
    cleanSidecars(vp.dbPath)
  }
}

/** What a refusal must leave: the bytes of `.enc` and of the key file, and the names in the workspace folder. */
function filesOf(vp: VaultPaths): { enc: string; descriptor: string; workspace: string[] } {
  return { enc: sha(vp.encPath), descriptor: sha(vp.descriptorPath), workspace: readdirSync(dirname(vp.dbPath)).sort() }
}

describe('a workspace written by a newer build is refused (#247)', () => {
  it('encrypted: unlock throws WorkspaceNewerError, leaves no plaintext at rest and does not touch .enc', () => {
    const vp = newerVault(lockedVault('workspace-newer', 'pw'), 'pw')
    const encBefore = sha(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(() => ctl.unlock('pw')).toThrow(WorkspaceNewerError)
    expect(ctl.isUnlocked()).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false) // the decrypted working file was shredded again
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${vp.dbPath}-shm`)).toBe(false)
    expect(sha(vp.encPath)).toBe(encBefore) // the vault itself is untouched
    // A wrong password is still a wrong password — the version is read only after the
    // password verified (the stamp never leaks through the password gate).
    expect(() => ctl.unlock('nope')).toThrow(WrongPasswordError)
  })

  // T2.9 fix round, R1-2: what a newer build realistically leaves in `.enc` (#985): the stamp raised AND schema text this
  // SQLite cannot parse, so every schema read fails SQLITE_CORRUPT, which the unlock maps to "damaged, restore a backup".
  // It answers "newer" because the open reads the stamp before its first statement that reads the schema (`PRAGMA
  // journal_mode`). The unlock alone no longer shows that order (since R1-1 it asks the probe after a damage verdict), so
  // the row also opens the same database with `openDatabase` itself: an open that read the schema first fails there.
  it('encrypted: a newer database whose schema this SQLite cannot parse is refused as newer, never damaged; every file byte for byte', () => {
    const vp = lockedVault('workspace-newer', 'pw')
    const plaintext = join(vp.root, 'newer-unparseable.sqlite') // outside config/ and workspace/
    reencryptedAround(vp, 'pw', (dbPath) => {
      writeNewerSchema(dbPath)
      copyFileSync(dbPath, plaintext)
    })
    const before = filesOf(vp)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(thrownBy(() => ctl.unlock('pw'))).toEqual({ name: 'WorkspaceNewerError', found: SCHEMA_VERSION + 1 })
    expect(ctl.isUnlocked()).toBe(false)
    expect(filesOf(vp)).toEqual(before) // no working file or sidecar left, `.enc` and the key file as they were
    const copy = sha(plaintext)
    expect(thrownBy(() => openDatabase(plaintext))).toEqual({ name: 'WorkspaceNewerError', found: SCHEMA_VERSION + 1 })
    expect(sha(plaintext)).toBe(copy)
    expect(existsSync(`${plaintext}-wal`)).toBe(false)
    expect(existsSync(`${plaintext}-shm`)).toBe(false)
  })

  // T2.9 fix round, R1-1: a newer build's database in a file format this SQLite refuses (header bytes 18 and 19, the
  // write and read versions, above 2) fails the open's first statement with SQLITE_NOTADB, before the stamp is read, and
  // the unlock called that intact workspace damaged. The same file as a working copy or `.recovery` reads `newer`
  // (`probeDatabaseFile` reads the stamp from the header), so the unlock now asks the probe after such a failure.
  it('encrypted: a newer database in a file format this SQLite refuses (header byte 19 above 2) is refused as newer, never damaged', () => {
    const vp = lockedVault('workspace-newer', 'pw')
    reencryptedAround(vp, 'pw', (dbPath) => {
      const bytes = readFileSync(dbPath)
      bytes.writeInt32BE(SCHEMA_VERSION + 1, 60) // the stamp (`user_version`)
      bytes[18] = 3
      bytes[19] = 3
      writeFileSync(dbPath, bytes)
    })
    const before = filesOf(vp)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(thrownBy(() => ctl.unlock('nope')).name).toBe('WrongPasswordError')
    expect(thrownBy(() => ctl.unlock('pw'))).toEqual({ name: 'WorkspaceNewerError', found: SCHEMA_VERSION + 1 })
    expect(ctl.isUnlocked()).toBe(false)
    expect(filesOf(vp)).toEqual(before)
  })

  it('plaintext_dev: startup does not crash, the file is untouched, and create answers "workspace_newer"', async () => {
    const vp = newerPlaintext(freshVaultPaths('workspace-newer'))
    const before = sha(vp.dbPath)
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true) // dev: plaintext allowed
    expect(() => ctl.init()).not.toThrow()
    expect(ctl.isUnlocked()).toBe(false)
    expect(sha(vp.dbPath)).toBe(before)
    registerWorkspaceIpc(workspaceIpcCtx(ctl))
    const { result } = await invoke(handlers, IPC.createWorkspace, '', 'plaintext_dev')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('workspace_newer')
    expect(sha(vp.dbPath)).toBe(before)
  })
})
