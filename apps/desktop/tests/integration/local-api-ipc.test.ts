import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Local-API wave P4 — the three access-key IPC channels + the AppStatus surface.
// What these pin: the FULL key never crosses IPC (only a mask), copying happens
// main-side, rotation also aborts the streams the old key let in (SEC-F6), the advertised
// server address follows the RUNNING port, and every handler refuses a locked workspace.

const clipboardState = vi.hoisted(() => ({ text: '', cleared: 0 }))
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  app: { getVersion: () => '0.0.0-test' },
  clipboard: {
    writeText: (t: string) => {
      clipboardState.text = t
    },
    readText: () => clipboardState.text,
    clear: () => {
      clipboardState.cleared++
      clipboardState.text = ''
    }
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))

import { registerLocalApiIpc } from '../../src/main/ipc/registerLocalApiIpc'
import { registerCoreIpc } from '../../src/main/ipc/registerCoreIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase } from '../../src/main/services/db'
import { seedSettings, updateSettings } from '../../src/main/services/settings'
import { readToken } from '../../src/main/services/local-api/token'
import type { AppContext } from '../../src/main/services/context'
import type { AppStatus, LocalApiConnectionInfo, LocalApiStatus } from '../../src/shared/types'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

interface Harness {
  ctx: AppContext
  db: ReturnType<typeof openDatabase>
  aborted: string[]
  status: LocalApiStatus
}

function localApiStatus(over: Partial<LocalApiStatus> = {}): LocalApiStatus {
  return {
    running: true,
    port: 4980,
    tokenRequired: true,
    requestsServed: 2,
    rejectedCount: 1,
    lastError: null,
    externalActive: false,
    lastPreemptedAt: null,
    ...over
  }
}

function makeHarness(opts: { unlocked?: boolean; localApi?: boolean } = {}): Harness {
  const rootPath = mkdtempSync(join(tmpdir(), 'hilbertraum-localapi-ipc-'))
  const workspacePath = join(rootPath, 'workspace')
  const configPath = join(rootPath, 'config')
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(configPath, { recursive: true })
  const db = openDatabase(join(workspacePath, 'test.sqlite'))
  seedSettings(db)
  const aborted: string[] = []
  const status = localApiStatus()
  const unlocked = opts.unlocked ?? true
  const ctx = {
    trustedSenders: ANY_SENDER,
    paths: { rootPath, workspacePath, configPath },
    db,
    isDev: true,
    workspace: {
      isUnlocked: () => unlocked,
      isLocking: () => false,
      getState: () => ({ state: unlocked ? 'unlocked' : 'locked', mode: 'plaintext_dev' }),
      documentCipher: () => null
    },
    runtime: { active: () => null, activeModelId: () => null, status: () => ({ running: false }) },
    localApi:
      opts.localApi === false
        ? undefined
        : {
            status: () => status,
            abortExternalRequests: (reason: string) => aborted.push(reason)
          }
  } as unknown as AppContext
  return { ctx, db, aborted, status }
}

beforeEach(() => {
  ipcState.handlers.clear()
  clipboardState.text = ''
  clipboardState.cleared = 0
  vi.useRealTimers()
})

describe('local API — connection info', () => {
  it('returns the pasteable address + a MASKED key, never the full value', async () => {
    const { ctx, db } = makeHarness()
    registerLocalApiIpc(ctx)
    const info = (await invoke(handlers, IPC.localApiConnectionInfo)).result as LocalApiConnectionInfo
    expect(info.serverAddress).toBe('http://127.0.0.1:4980/v1')
    const full = readToken(db)
    expect(full).toMatch(/^hr-/)
    expect(info.maskedKey).toBe(`hr-…${full!.slice(-4)}`)
    // The whole point of the mask: the renderer payload cannot contain the credential.
    expect(JSON.stringify(info)).not.toContain(full)
  })

  it('advertises the RUNNING port, not the saved setting, when they differ', async () => {
    const { ctx, db, status } = makeHarness()
    updateSettings(db, { localApiPort: 4990 })
    status.port = 4980 // still bound on the old port until a restart
    registerLocalApiIpc(ctx)
    const info = (await invoke(handlers, IPC.localApiConnectionInfo)).result as LocalApiConnectionInfo
    expect(info.serverAddress).toBe('http://127.0.0.1:4980/v1')
  })

  it('falls back to the saved port when nothing is bound (the pre-start card)', async () => {
    const { ctx, db } = makeHarness({ localApi: false })
    updateSettings(db, { localApiPort: 4990 })
    registerLocalApiIpc(ctx)
    const info = (await invoke(handlers, IPC.localApiConnectionInfo)).result as LocalApiConnectionInfo
    expect(info.serverAddress).toBe('http://127.0.0.1:4990/v1')
  })

  it('mints NO key while the key requirement is off', async () => {
    const { ctx, db } = makeHarness()
    updateSettings(db, { localApiTokenRequired: false })
    registerLocalApiIpc(ctx)
    const info = (await invoke(handlers, IPC.localApiConnectionInfo)).result as LocalApiConnectionInfo
    expect(info.maskedKey).toBeNull()
    expect(readToken(db)).toBeNull()
  })
})

describe('local API — copy + rotate', () => {
  it('copies the FULL key main-side and clears the clipboard later if it still holds it', async () => {
    vi.useFakeTimers()
    const { ctx, db } = makeHarness()
    registerLocalApiIpc(ctx)
    expect((await invoke(handlers, IPC.localApiCopyKey)).result).toBe(true)
    const full = readToken(db)!
    expect(clipboardState.text).toBe(full)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clipboardState.cleared).toBe(1)
    expect(clipboardState.text).toBe('')
  })

  it('leaves a clipboard the user has since overwritten alone', async () => {
    vi.useFakeTimers()
    const { ctx } = makeHarness()
    registerLocalApiIpc(ctx)
    await invoke(handlers, IPC.localApiCopyKey)
    clipboardState.text = 'something the user copied afterwards'
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clipboardState.cleared).toBe(0)
    expect(clipboardState.text).toBe('something the user copied afterwards')
  })

  it('rotation replaces the key AND aborts the streams the old key let in (SEC-F6)', async () => {
    const { ctx, db, aborted } = makeHarness()
    registerLocalApiIpc(ctx)
    await invoke(handlers, IPC.localApiConnectionInfo)
    const before = readToken(db)!
    const info = (await invoke(handlers, IPC.localApiRegenerateToken)).result as LocalApiConnectionInfo
    const after = readToken(db)!
    expect(after).not.toBe(before)
    expect(info.maskedKey).toBe(`hr-…${after.slice(-4)}`)
    // Auth is checked once at admission — without this the "apps stop working" promise
    // would be false for a stream already in flight.
    expect(aborted).toHaveLength(1)
  })
})

describe('local API — locked workspace', () => {
  it('every key channel refuses while the workspace does not admit work (AUD-02)', async () => {
    const { ctx } = makeHarness({ unlocked: false })
    registerLocalApiIpc(ctx)
    for (const channel of [
      IPC.localApiConnectionInfo,
      IPC.localApiCopyKey,
      IPC.localApiRegenerateToken
    ]) {
      await expect(invoke(handlers, channel)).rejects.toThrow()
    }
    expect(clipboardState.text).toBe('')
  })
})

describe('local API — AppStatus surface', () => {
  it('getAppStatus carries the live counters, and null when there is no server', async () => {
    const { ctx, status } = makeHarness()
    registerCoreIpc(ctx)
    const withServer = (await invoke(handlers, IPC.getAppStatus)).result as AppStatus
    expect(withServer.localApi).toEqual(status)
    // Counts and flags only — nothing that could describe a caller or a prompt (D1).
    expect(Object.keys(withServer.localApi!).sort()).toEqual([
      'externalActive',
      'lastError',
      'lastPreemptedAt',
      'port',
      'rejectedCount',
      'requestsServed',
      'running',
      'tokenRequired'
    ])

    ipcState.handlers.clear()
    const bare = makeHarness({ localApi: false })
    registerCoreIpc(bare.ctx)
    expect(((await invoke(handlers, IPC.getAppStatus)).result as AppStatus).localApi).toBeNull()
  })
})
