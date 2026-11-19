import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EVENTS, IPC } from '../../src/shared/ipc'
import type { PreloadApi } from '../../src/preload/index'
import type { SaveBeforeCloseResult } from '../../src/shared/types'
import { deferred } from '../helpers/deferred'

// #888: the preload answers main's "save before the window closes" itself, once the renderer's
// callback settles, so the renderer cannot forget to answer, and a callback that fails reads as
// "unsaved" (main then asks the user instead of closing over it). Same capture trick as
// preload-engine.test.ts: mock electron to grab the exposed bridge object and the listener.

const bridge = vi.hoisted(() => ({ api: undefined as unknown }))
const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  send: vi.fn(),
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

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

/** Lets every pending promise reaction run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Subscribe `cb`, then deliver main's request `requestId` the way `ipcRenderer.on` does. */
async function requestSave(cb: () => Promise<SaveBeforeCloseResult>, requestId: number): Promise<void> {
  const api = await loadApi()
  api.onSaveBeforeClose(cb)
  const [channel, handler] = ipc.on.mock.calls.at(-1) as [string, (event: unknown, id: unknown) => void]
  expect(channel).toBe(EVENTS.saveBeforeClose)
  handler({}, requestId)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload — onSaveBeforeClose (#888)', () => {
  it('answers main with the request id only after the renderer’s save has settled', async () => {
    const save = deferred<SaveBeforeCloseResult>()
    const cb = vi.fn(() => save.promise)
    await requestSave(cb, 7)
    expect(cb).toHaveBeenCalledTimes(1)
    await settle()
    expect(ipc.send).not.toHaveBeenCalled() // still saving
    save.resolve({ unsaved: false })
    await settle()
    expect(ipc.send.mock.calls).toEqual([[IPC.saveBeforeCloseDone, { requestId: 7, unsaved: false }]])
  })

  it.each<[string, () => Promise<SaveBeforeCloseResult>]>([
    ['rejects', () => Promise.reject(new Error('the store threw'))],
    ['throws', () => {
      throw new Error('the store threw')
    }],
    ['answers nothing', () => Promise.resolve(undefined as unknown as SaveBeforeCloseResult)]
  ])('a save that %s still answers, as unsaved', async (_what, cb) => {
    await requestSave(cb, 3)
    await settle()
    expect(ipc.send.mock.calls).toEqual([[IPC.saveBeforeCloseDone, { requestId: 3, unsaved: true }]])
  })
})
