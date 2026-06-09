import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
import { seedSettings, updateSettings } from '../../src/main/services/settings'
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
  // Model handlers resolve the drive policy from `paths.configPath` (M10); a missing
  // config dir means "no policy file" → developer-friendly defaults.
  const noWeightPaths = (): { rootPath: string; configPath: string } => ({
    rootPath: join(tmpdir(), 'paid-no-weights'),
    configPath: bogusConfigDir()
  })

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
      paths: noWeightPaths(),
      isDev: false,
      runtime: { activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    const { result } = await invoke(handlers, IPC.listModels)
    const models = result as ModelInfo[]
    // The committed manifests are discovered; with no weights on disk they are 'missing'.
    expect(models.length).toBeGreaterThanOrEqual(4)
    expect(models.every((m) => typeof m.id === 'string')).toBe(true)
    // Not a developer (toggle off, packaged build) → no mock-start affordance (M10).
    expect(models.every((m) => m.startableAsMock !== true)).toBe(true)
  })

  it('startRuntime throws on an unknown model id', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'definitely-not-a-real-model')).rejects.toThrow(
      /Unknown model id/
    )
  })

  // H6 (audit round 4): the zero-weights first-run journey — a MISSING chat model may be
  // started by a developer (toggle or dev build; the selecting factory then yields the
  // mock runtime), so a fresh clone can actually chat. Everything else is gated in MAIN.
  it('startRuntime allows a missing chat model for a developer (mock fallback)', async () => {
    let startedWith: unknown = null
    const db = seededDb()
    updateSettings(db, { developerMode: true }) // explicit opt-in (default is now false, M10)
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: {
        start: async (o: unknown) => {
          startedWith = o
          return { running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }
        },
        activeModelId: () => null
      }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')
    expect(startedWith).not.toBeNull()
  })

  it('a dev build counts as developer even with the toggle off (isDev)', async () => {
    let started = false
    const ctx = {
      db: seededDb(), // developerMode defaults to FALSE (M10)
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: {
        start: async () => {
          started = true
          return { running: true, modelId: 'qwen3-4b-instruct-q4', port: null, healthy: true, message: 'ok' }
        },
        activeModelId: () => null
      }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')
    expect(started).toBe(true)
  })

  it('startRuntime refuses a missing model for a non-developer', async () => {
    const ctx = {
      db: seededDb(), // developerMode defaults to false
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: false,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')).rejects.toThrow(
      /cannot be started/
    )
  })

  // M10: the drive POLICY is authoritative — a commercial policy.json disables developer
  // leniency (and thus the mock fallback) even when the toggle/dev build says developer.
  it('a commercial policy vetoes developer leniency (no mock fallback)', async () => {
    const configPath = mkdtempSync(join(tmpdir(), 'paid-policy-'))
    writeFileSync(
      join(configPath, 'policy.json'),
      JSON.stringify({
        models: { allow_unverified_models: false, require_sha256_match: true }
      }),
      'utf8'
    )
    const db = seededDb()
    updateSettings(db, { developerMode: true })
    const ctx = {
      db,
      manifestsDir: REPO_MANIFESTS,
      paths: { rootPath: join(tmpdir(), 'paid-no-weights'), configPath },
      isDev: true,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'qwen3-4b-instruct-q4')).rejects.toThrow(
      /cannot be started/
    )
  })

  it('startRuntime rejects an embeddings model (the chat runtime loads chat models only)', async () => {
    const ctx = {
      db: seededDb(),
      manifestsDir: REPO_MANIFESTS,
      paths: noWeightPaths(),
      isDev: true,
      runtime: { start: async () => ({}), activeModelId: () => null }
    } as unknown as AppContext
    registerModelIpc(ctx)
    await expect(invoke(handlers, IPC.startRuntime, 'multilingual-e5-small-q8')).rejects.toThrow(
      /not a chat model/
    )
  })
})
