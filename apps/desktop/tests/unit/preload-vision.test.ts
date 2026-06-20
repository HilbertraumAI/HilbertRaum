import { describe, it, expect, vi, beforeEach } from 'vitest'

// Preload-surface test (image-understanding plan §17): the vision methods are exposed on the
// typed `window.api` bridge and route to the right IPC channels. The preload calls
// `contextBridge.exposeInMainWorld('api', api)` at import, so we mock electron to CAPTURE the
// exposed object, then assert the methods exist and forward correctly.

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
  ipcRenderer: ipc
}))

import { IPC, STREAM } from '../../src/shared/ipc'
import type { PreloadApi } from '../../src/preload/index'

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload — vision surface', () => {
  it('exposes the images:* methods as functions', async () => {
    const api = await loadApi()
    for (const name of [
      'imageGetStatus',
      'imageChooseImage',
      'imageReadBytes',
      'imageAnalyze',
      'imageGetJob',
      'imageCancel',
      'onImageToken',
      'onImageDone',
      'onImageError'
    ] as const) {
      expect(typeof api[name]).toBe('function')
    }
  })

  it('imageAnalyze forwards to IPC.imageAnalyze with the request', async () => {
    const api = await loadApi()
    const req = { imageBytes: new Uint8Array([1]), mimeType: 'image/png' as const, question: 'q' }
    await api.imageAnalyze(req)
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.imageAnalyze, req)
  })

  it('imageGetStatus forwards to IPC.imageGetStatus', async () => {
    const api = await loadApi()
    await api.imageGetStatus()
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.imageGetStatus)
  })

  it('onImageToken subscribes to the per-job STREAM channel and unsubscribes', async () => {
    const api = await loadApi()
    const cb = vi.fn()
    const off = api.onImageToken('job-1', cb)
    expect(ipc.on).toHaveBeenCalledWith(STREAM.imgToken('job-1'), expect.any(Function))
    off()
    expect(ipc.removeListener).toHaveBeenCalledWith(STREAM.imgToken('job-1'), expect.any(Function))
  })
})
