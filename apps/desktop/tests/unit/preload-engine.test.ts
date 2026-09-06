import { describe, it, expect, vi, beforeEach } from 'vitest'

// Preload-surface test for the engine downloader's `downloadEngine` payload (#339 P8-2): the
// channel is unchanged, its payload is new. The argument-less call must keep invoking the
// channel with NO payload (the main handler's default install — required families only), and
// the consent dialog's per-family request must reach the channel verbatim. Same capture trick
// as preload-vision.test.ts: mock electron to grab the exposed bridge object.

const bridge = vi.hoisted(() => ({ api: undefined as unknown }))
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      bridge.api = api
    }
  },
  ipcRenderer: ipc,
  webUtils: { getPathForFile: () => '' }
}))

import { IPC } from '../../src/shared/ipc'
import type { PreloadApi } from '../../src/preload/index'
import type { EngineDownloadRequest } from '../../src/shared/types'

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload — engine downloader surface (#339 P8-2)', () => {
  it('downloadEngine() with no argument invokes the channel with no payload (the default install)', async () => {
    const api = await loadApi()
    await api.downloadEngine()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.downloadEngine)
    expect(ipc.invoke.mock.calls[0]).toHaveLength(1)
  })

  it('downloadEngine({ families }) forwards the request object verbatim on the same channel', async () => {
    const api = await loadApi()
    const request: EngineDownloadRequest = { families: ['kiwix_tools'] }
    await api.downloadEngine(request)
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.downloadEngine, request)
    expect(IPC.downloadEngine).toBe('engine:download')
  })
})
