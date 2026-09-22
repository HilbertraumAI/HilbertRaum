import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Preload-surface test for the in-app OCR language-file installer (#410): the install
// channel takes NO payload — main refuses any argument since what is installed is pinned
// in code (`assertNoOcrInstallPayload`) — so the bridge method must never pass one either.
// Same capture trick as preload-engine.test.ts: mock electron to grab the exposed bridge.

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

describe('preload — OCR install surface (#410)', () => {
  it('installOcr() invokes the channel with NO payload', async () => {
    const api = await loadApi()
    await api.installOcr()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.installOcr)
    expect(ipc.invoke.mock.calls[0]).toHaveLength(1)
  })

  it('getOcrInstallStatus() invokes the channel with no payload', async () => {
    const api = await loadApi()
    await api.getOcrInstallStatus()
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.getOcrInstallStatus)
    expect(ipc.invoke.mock.calls[0]).toHaveLength(1)
  })

  it('getOcrInstallJob(id) and cancelOcrInstall(id) forward the id verbatim', async () => {
    const api = await loadApi()
    await api.getOcrInstallJob('job-1')
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.getOcrInstallJob, 'job-1')
    await api.cancelOcrInstall('job-2')
    expect(ipc.invoke).toHaveBeenCalledWith(IPC.cancelOcrInstall, 'job-2')
  })

  it('the channel strings are the expected ocr: literals, never an ocr-raster: one', () => {
    expect(IPC.getOcrInstallStatus).toBe('ocr:status')
    expect(IPC.installOcr).toBe('ocr:install')
    expect(IPC.getOcrInstallJob).toBe('ocr:getJob')
    expect(IPC.cancelOcrInstall).toBe('ocr:cancel')
    for (const ch of [IPC.getOcrInstallStatus, IPC.installOcr, IPC.getOcrInstallJob, IPC.cancelOcrInstall]) {
      expect(ch.startsWith('ocr-raster:')).toBe(false)
    }
  })

  it('the hostile-PDF rasterizer window preload never mentions the install surface (main-window only)', () => {
    const src = readFileSync(join(__dirname, '../../src/preload/ocr.ts'), 'utf8')
    expect(src).not.toContain('installOcr')
    expect(src).not.toContain('getOcrInstallStatus')
    expect(src).not.toContain('ocr:install')
  })
})
