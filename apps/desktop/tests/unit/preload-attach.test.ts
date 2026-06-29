import { describe, it, expect, vi, beforeEach } from 'vitest'

// Preload-surface contract test (full-audit-2026-06-29 follow-up, Phase 2 / FE-A): the drag-drop
// path resolver that replaced the removed `File.path` is exposed on the typed `window.api` bridge
// and forwards to `webUtils.getPathForFile`. `webUtils` is only callable in the (sandboxed)
// PRELOAD — never the renderer — so the resolver MUST live here. The preload calls
// `contextBridge.exposeInMainWorld('api', api)` at import; we mock electron to CAPTURE the exposed
// object (and a fake `webUtils`), then assert the method exists and forwards correctly.

const bridge = vi.hoisted(() => ({ api: undefined as unknown }))
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn()
}))
const webUtils = vi.hoisted(() => ({
  getPathForFile: vi.fn((_file: unknown) => '/abs/dropped/path.pdf')
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      bridge.api = api
    }
  },
  ipcRenderer: ipc,
  webUtils
}))

import type { PreloadApi } from '../../src/preload/index'

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload — drag-drop path resolver surface (FE-A)', () => {
  it('exposes getDroppedFilePath as a function', async () => {
    const api = await loadApi()
    expect(typeof api.getDroppedFilePath).toBe('function')
  })

  it('getDroppedFilePath forwards the File to webUtils.getPathForFile and returns its path', async () => {
    const api = await loadApi()
    const file = { name: 'statement.pdf' } as unknown as File
    const path = api.getDroppedFilePath(file)
    expect(webUtils.getPathForFile).toHaveBeenCalledWith(file)
    expect(path).toBe('/abs/dropped/path.pdf')
  })
})
