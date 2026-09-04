import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createEncryptedVaultOnDisk,
  lockEncryptedVault,
  unlockEncryptedVault,
  vaultPathsFrom,
  WorkspaceController,
  WrongPasswordError,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import { SCHEMA_VERSION, WorkspaceNewerError } from '../../src/main/services/db'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import { IPC } from '../../src/shared/ipc'
import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import type { PrivacyPolicy, WorkspaceActionResult } from '../../src/shared/types'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'

// #247 (owner decision #225 — "ratify"): a workspace database stamped by a NEWER build is
// refused by this build — the vault controller throws the typed `WorkspaceNewerError`, the
// unlock/create IPC answers `{ ok: false, reason: 'workspace_newer', message }` ("update the
// app"), and nothing is written or left at rest: on the encrypted flavour the decrypted
// working file is shredded again and `.enc` is byte-identical; on the plaintext flavour the
// file is untouched. Before this the same database opened and the app degraded silently.
// Scratch vaults only (never a real workspace).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))
const handlers = ipcState.handlers as unknown as IpcHandlers

beforeEach(() => ipcState.handlers.clear())

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as typeof import('node:sqlite')

// Fast KDF so the suite stays quick (the workspace-vault.test.ts fixture).
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }

const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-workspace-newer-'))
  const configPath = join(root, 'config')
  const workspacePath = join(root, 'workspace')
  mkdirSync(configPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })
  return vaultPathsFrom({ configPath, dbPath: join(workspacePath, 'hilbertraum.sqlite') })
}

/** The minimal AppContext the unlock/create handlers' failure paths read. */
function ctxWith(ctrl: WorkspaceController): AppContext {
  return {
    trustedSenders: ANY_SENDER,
    workspace: ctrl,
    runtime: { stop: async () => {}, activeModelId: () => null },
    embedder: { stop: async () => {} }
  } as unknown as AppContext
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** An encrypted vault whose database a NEWER build has stamped (`user_version` above ours). */
function newerEncryptedVault(): VaultPaths {
  const vp = freshVault()
  createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
  const { db, key } = unlockEncryptedVault(vp, 'pw')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
  lockEncryptedVault(vp, db, key)
  return vp
}

describe('a workspace written by a newer build is refused (#247)', () => {
  it('encrypted: unlock throws WorkspaceNewerError, leaves no plaintext at rest and does not touch .enc', () => {
    const vp = newerEncryptedVault()
    const encBefore = sha(vp.encPath)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    expect(() => ctl.unlock('pw')).toThrow(WorkspaceNewerError)
    expect(ctl.isUnlocked()).toBe(false)
    expect(existsSync(vp.dbPath)).toBe(false) // the decrypted working file was shredded again
    expect(existsSync(`${vp.dbPath}-wal`)).toBe(false)
    expect(sha(vp.encPath)).toBe(encBefore) // the vault itself is untouched
    // A wrong password is still a wrong password — the version is read only after the
    // password verified (the stamp never leaks through the password gate).
    expect(() => ctl.unlock('nope')).toThrow(WrongPasswordError)
  })

  it('encrypted: the unlock IPC answers reason "workspace_newer" with the update-the-app copy', async () => {
    const vp = newerEncryptedVault()
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    registerWorkspaceIpc(ctxWith(ctl))
    const { result } = await invoke(handlers, IPC.unlockWorkspace, 'pw')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('workspace_newer')
    expect(r.message).toMatch(/newer/i)
    expect(r.message).toMatch(/update/i)
    expect(ctl.getState().state).toBe('locked')
  })

  it('plaintext_dev: startup does not crash, the file is untouched, and create answers "workspace_newer"', async () => {
    const vp = freshVault()
    const raw = new DatabaseSync(vp.dbPath)
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`)
    raw.close()
    const before = sha(vp.dbPath)
    const ctl = new WorkspaceController(vp, DEFAULT_POLICY, true) // dev: plaintext allowed
    expect(() => ctl.init()).not.toThrow()
    expect(ctl.isUnlocked()).toBe(false)
    expect(sha(vp.dbPath)).toBe(before)
    registerWorkspaceIpc(ctxWith(ctl))
    const { result } = await invoke(handlers, IPC.createWorkspace, '', 'plaintext_dev')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('workspace_newer')
    expect(sha(vp.dbPath)).toBe(before)
  })

  it('control: a vault at the current version unlocks and is stamped', () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'pw', FAST_KDF)
    const ctl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctl.init()
    ctl.unlock('pw')
    expect(ctl.isUnlocked()).toBe(true)
    const row = ctl.requireDb().prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(SCHEMA_VERSION)
    ctl.lock()
  })
})
