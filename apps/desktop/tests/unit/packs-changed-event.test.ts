import { describe, it, expect, vi } from 'vitest'

// #715 — the main-process half of `packs:changed` (#301 P3b, finding L7) and its preload hop.
// Every other test that sees this event hands the renderer a stub emitter, so nothing proved
// that what `ZimService`'s `notify` seam sends is what a renderer subscription receives. Here
// the main side's real broadcast (`ipc/packs-notify.ts`) sends through a fake window whose
// `webContents.send` delivers to the listeners the REAL preload registered on `ipcRenderer`.

const electron = vi.hoisted(() => ({
  windows: [] as unknown[],
  api: undefined as unknown,
  listeners: new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      electron.api = api
    }
  },
  ipcRenderer: {
    invoke: async () => undefined,
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      const set = electron.listeners.get(channel) ?? new Set()
      set.add(fn)
      electron.listeners.set(channel, set)
    },
    removeListener: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      electron.listeners.get(channel)?.delete(fn)
    }
  },
  webUtils: { getPathForFile: () => '' }
}))

import { notifyKnowledgePacksChanged } from '../../src/main/ipc/packs-notify'
import type { PreloadApi } from '../../src/preload/index'
import type { KnowledgePacksChangedEvent } from '../../src/shared/types'

/** A window whose `send` reaches the preload's listeners, the way Electron delivers it: the
 *  renderer-side IPC event first, then the arguments. */
function fakeWindow(
  state: 'live' | 'closed' | 'throws'
): { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } } {
  const send = vi.fn((channel: string, ...args: unknown[]) => {
    if (state === 'throws') throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    for (const fn of electron.listeners.get(channel) ?? []) fn({ sender: 'main' }, ...args)
  })
  return { isDestroyed: () => state === 'closed', webContents: { send } }
}

describe('packs:changed — main broadcast to renderer subscription (#715)', () => {
  it('a pack-set change reaches the renderer callback as sent, past a closed window and one whose send throws, and nothing after unsubscribe', async () => {
    await import('../../src/preload/index')
    const api = electron.api as PreloadApi
    const received: KnowledgePacksChangedEvent[] = []
    const unsubscribe = api.onKnowledgePacksChanged((event) => received.push(event))
    const closed = fakeWindow('closed')
    const throwing = fakeWindow('throws')
    const live = fakeWindow('live')
    electron.windows.push(closed, throwing, live)

    // `ZimService` notifies after its database write: a throwing recipient must not surface as a
    // failed pack change, nor keep the next window from hearing about it.
    const event: KnowledgePacksChangedEvent = { epoch: 3, revision: 7, refreshing: false, reason: 'mutation' }
    expect(() => notifyKnowledgePacksChanged(event)).not.toThrow()
    expect(received).toEqual([event])
    expect(closed.webContents.send).not.toHaveBeenCalled()

    unsubscribe()
    notifyKnowledgePacksChanged({ ...event, revision: 8 })
    expect(received).toEqual([event])
  })
})
