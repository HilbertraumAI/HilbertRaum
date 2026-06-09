import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerCoreIpc + registerModelIpc: the locked-workspace network
// fallback (the offline ceiling must hold pre-unlock, when allowNetwork is unreadable) and
// the model handler guards (no manifests dir → empty list; unknown model id → throw).

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { registerModelIpc } from '../../src/main/ipc/registerModelIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import type { AppStatus, ModelInfo, WorkspaceStateInfo } from '../../src/shared/types'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers
const REPO_MANIFESTS = join(process.cwd(), '..', '..', 'model-manifests')

function seededDb(): Db {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-coreipc-')), 'test.sqlite'))
  seedSettings(db)
  return db
}

function bogusConfigDir(): string {
  return join(tmpdir(), 'paid-no-such-config-dir')
}

beforeEach(() => ipcState.handlers.clear())

describe('registerCoreIpc', () => {
  it('getAppStatus keeps the offline ceiling while the workspace is locked', async () => {
    const lockedWorkspace = {
      isUnlocked: () => false,
      getState: (): WorkspaceStateInfo => ({
        state: 'locked',
        mode: null,
        plaintextAllowed: false,
        encryptionRequired: true
      })
    }
    const ctx = {
      paths: { configPath: bogusConfigDir() },
      workspace: lockedWorkspace
    } as unknown as AppContext
    registerCoreIpc(ctx)

    const { result } = await invoke(handlers, IPC.getAppStatus)
    const status = result as AppStatus
    // No policy file + locked DB → deny-by-default ceiling: offline, no network, not ready.
    expect(status.offlineMode).toBe(true)
    expect(status.networkAllowed).toBe(false)
    expect(status.workspaceReady).toBe(false)
    expect(status.activeModelId).toBeNull()
    expect(status.hardwareProfile).toBe('UNKNOWN')
  })
})

describe('registerModelIpc', () => {
  it('returns an empty model list when no manifests directory is configured', async () => {
    const ctx = { db: seededDb(), manifestsDir: null } as unknown as AppContext
    registerModelIpc(ctx)
    const { result } = await invoke(handlers, IPC.listModels)
    expect(result).toEqual([])
  })

  it('lists the committed manifests and reports their state', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: join(tmpdir(), 'paid-no-weights') },
      runtime: { activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    const { result } = await invoke(handlers, IPC.listModels)
    const models = result as ModelInfo[]
    // The four committed manifests are discovered; with no weights on disk they are 'missing'.
    expect(models.length).toBeGreaterThanOrEqual(4)
    expect(models.every((m) => typeof m.id === 'string')).toBe(true)
  })

  it('startRuntime throws on an unknown model id', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: join(tmpdir(), 'paid-no-weights') },
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'definitely-not-a-real-model')).rejects.toThrow(
      /Unknown model id/
    )
  })
})
