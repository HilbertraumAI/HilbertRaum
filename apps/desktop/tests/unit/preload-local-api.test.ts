import { describe, it, expect, vi, beforeEach } from 'vitest'

// Preload-surface pins for the local API's three access-key channels (local-api wave P4).
// The preload calls `contextBridge.exposeInMainWorld('api', api)` at import, so electron is
// mocked to CAPTURE the exposed object. What matters here is that the bridge exposes ONLY
// these three (the toggles + live status ride settings:update / app:getAppStatus) and that
// each one routes to the channel the main-process handler is registered on — a rename on
// either side would otherwise fail silently at runtime.

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

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload — local API surface', () => {
  it('exposes the three key methods and routes each to its channel', async () => {
    const api = await loadApi()
    await api.getLocalApiConnectionInfo()
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.localApiConnectionInfo)
    await api.copyLocalApiKey()
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.localApiCopyKey)
    await api.regenerateLocalApiToken()
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.localApiRegenerateToken)
  })

  it('exposes NO method that could carry the full access key to the renderer', async () => {
    const api = await loadApi()
    const localApiMethods = Object.keys(api).filter((k) => /localapi/i.test(k))
    // An added name here is a deliberate decision, not an accident: anything shaped like
    // "get the key" belongs main-side (the copy/rotate flows), never on this bridge.
    expect(localApiMethods.sort()).toEqual([
      'copyLocalApiKey',
      'getLocalApiConnectionInfo',
      'regenerateLocalApiToken'
    ])
  })
})
