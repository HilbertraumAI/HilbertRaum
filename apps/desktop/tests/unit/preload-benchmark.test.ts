import { describe, it, expect, vi, beforeEach } from 'vitest'

// The hardware check's half of the typed `window.api` bridge (the preload-vision idiom): each
// method reaches its own channel, and a subscription hands over what main sent and removes the same
// handler it added. A renderer suite stubs this whole bridge, so nothing else sees these lines.

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

import { EVENTS, IPC } from '../../src/shared/ipc'
import type { PreloadApi } from '../../src/preload/index'

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload: the hardware check', () => {
  it.each([
    ['runBenchmark', IPC.runBenchmark],
    ['getPerformance', IPC.getPerformance],
    ['getMovedDriveNotice', IPC.getMovedDriveNotice],
    ['tryGpuAgain', IPC.tryGpuAgain]
  ] as const)('%s invokes its own channel', async (method, channel) => {
    const api = await loadApi()
    await api[method]()
    expect(ipc.invoke.mock.calls).toEqual([[channel]])
  })

  it('onBenchmarkProgress delivers the step, and its unsubscribe removes that same handler', async () => {
    const api = await loadApi()
    const cb = vi.fn()
    const off = api.onBenchmarkProgress(cb)
    expect(ipc.on).toHaveBeenCalledWith(EVENTS.benchmarkProgress, expect.any(Function))
    const handler = ipc.on.mock.calls[0][1]
    handler({}, 'drive')
    expect(cb).toHaveBeenCalledWith('drive')
    off()
    expect(ipc.removeListener).toHaveBeenCalledWith(EVENTS.benchmarkProgress, handler)
  })

  it('onPerformanceChanged hands the renderer nothing, and its unsubscribe removes that same handler', async () => {
    const api = await loadApi()
    const cb = vi.fn()
    const off = api.onPerformanceChanged(cb)
    expect(ipc.on).toHaveBeenCalledWith(EVENTS.performanceChanged, expect.any(Function))
    const handler = ipc.on.mock.calls[0][1]
    handler({ sender: 'main' })
    expect(cb).toHaveBeenCalledWith()
    off()
    expect(ipc.removeListener).toHaveBeenCalledWith(EVENTS.performanceChanged, handler)
  })
})
