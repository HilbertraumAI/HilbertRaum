import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerWorkspaceIpc — the exception→result mapping the unlock gate
// depends on (a wrong password / policy refusal / weak password must be a NORMAL
// `{ ok:false, reason }` result, not a thrown error) and the MIN_PASSWORD_LENGTH floor.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { registerWorkspaceIpc } from '../../src/main/ipc/registerWorkspaceIpc'
import { IPC } from '../../src/shared/ipc'
import { DEFAULT_POLICY } from '../../src/main/services/policy'
import type { PrivacyPolicy, WorkspaceActionResult } from '../../src/shared/types'
import {
  WorkspaceController,
  vaultPathsFrom,
  createEncryptedVaultOnDisk,
  type VaultPaths
} from '../../src/main/services/workspace-vault'
import type { KdfParams } from '../../src/main/services/security/crypto'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const FAST_KDF: KdfParams = { algo: 'scrypt', N: 1024, r: 8, p: 1, keyLen: 32 }
const ENCRYPTION_REQUIRED: PrivacyPolicy = {
  ...DEFAULT_POLICY,
  workspace: { encryptionRequired: true, allowPlaintextDevMode: false }
}

function freshVault(): VaultPaths {
  const root = mkdtempSync(join(tmpdir(), 'paid-wsipc-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'workspace'), { recursive: true })
  return vaultPathsFrom({ configPath: join(root, 'config'), dbPath: join(root, 'workspace', 'paid.sqlite') })
}

function ctxWith(
  ctrl: WorkspaceController,
  sidecars?: { stopRuntime?: () => Promise<void>; stopEmbedder?: () => Promise<void> }
): AppContext {
  return {
    workspace: ctrl,
    runtime: { stop: sidecars?.stopRuntime ?? (async () => {}), activeModelId: () => null },
    embedder: { stop: sidecars?.stopEmbedder ?? (async () => {}) }
  } as unknown as AppContext
}

beforeEach(() => ipcState.handlers.clear())

describe('registerWorkspaceIpc', () => {
  it('refuses a too-short encrypted password as a normal result (no throw, no KDF)', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'short', 'encrypted')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ reason: 'refused' })
    expect((r as { message: string }).message).toMatch(/at least 8/)
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('creates an encrypted workspace with a long-enough password', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, false)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'longenough', 'encrypted')
    const r = result as WorkspaceActionResult
    expect(r.ok).toBe(true)
    expect(r.ok && r.state.state).toBe('unlocked')
    expect(r.ok && r.state.mode).toBe('encrypted')
    ctrl.lock()
  })

  it('maps a wrong password to { ok:false, reason:"wrong_password" } instead of throwing', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF) // descriptor uses FAST params
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    expect(ctrl.getState().state).toBe('locked')
    registerWorkspaceIpc(ctxWith(ctrl))

    const { result } = await invoke(handlers, IPC.unlockWorkspace, 'wrong-password')
    expect(result).toMatchObject({ ok: false, reason: 'wrong_password' })
    expect(ctrl.isUnlocked()).toBe(false)
  })

  it('maps a policy-forbidden plaintext create to { ok:false, reason:"refused" }', async () => {
    const ctrl = new WorkspaceController(freshVault(), ENCRYPTION_REQUIRED, true)
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.createWorkspace, 'whatever8', 'plaintext_dev')
    expect(result).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('returns the current workspace state', async () => {
    const ctrl = new WorkspaceController(freshVault(), DEFAULT_POLICY, true) // dev → plaintext opens
    ctrl.init()
    registerWorkspaceIpc(ctxWith(ctrl))
    const { result } = await invoke(handlers, IPC.getWorkspaceState)
    expect(result).toMatchObject({ state: 'unlocked', mode: 'plaintext_dev' })
  })

  it('lockWorkspace stops both sidecars before re-encrypting (Lock now)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    const order: string[] = []
    const stopRuntime = vi.fn(async () => {
      order.push('runtime')
    })
    const stopEmbedder = vi.fn(async () => {
      order.push('embedder')
    })
    registerWorkspaceIpc(ctxWith(ctrl, { stopRuntime, stopEmbedder }))

    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
    expect(stopRuntime).toHaveBeenCalledTimes(1)
    expect(stopEmbedder).toHaveBeenCalledTimes(1)
    // Both sidecars were stopped (order between them doesn't matter, but both ran).
    expect(order.sort()).toEqual(['embedder', 'runtime'])
  })

  it('lockWorkspace still locks when a sidecar stop fails (allSettled)', async () => {
    const vp = freshVault()
    createEncryptedVaultOnDisk(vp, 'right-password', FAST_KDF)
    const ctrl = new WorkspaceController(vp, ENCRYPTION_REQUIRED, false)
    ctrl.init()
    ctrl.unlock('right-password')
    registerWorkspaceIpc(
      ctxWith(ctrl, {
        stopRuntime: async () => {
          throw new Error('sidecar wedged')
        }
      })
    )
    const { result } = await invoke(handlers, IPC.lockWorkspace)
    expect(result).toMatchObject({ state: 'locked' })
    expect(ctrl.isUnlocked()).toBe(false)
  })
})
