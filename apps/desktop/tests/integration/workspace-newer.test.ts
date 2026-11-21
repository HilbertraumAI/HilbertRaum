import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { WorkspaceController, WrongPasswordError } from '../../src/main/services/workspace-vault'
import { WorkspaceNewerError } from '../../src/main/services/db'
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
  workspaceIpcCtx
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
