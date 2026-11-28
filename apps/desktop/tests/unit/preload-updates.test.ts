import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Preload surface of the four update channels callable while locked (app-update T6.3; F-14; docs/app-updates.md §3.5
// "The types"): `window.api.updatesImportFile`, `updatesStatus`, `updatesCancel` and `updatesDiscardStaged` each invoke
// their own channel with exactly the renderer's argument, untouched. `PreloadApi` is derived from the object literal, so
// TypeScript catches neither a channel swap nor a dropped argument. The channel each binding must name is read from
// F-14's golden list (tests/fixtures/updates/import/f14-locked-channels.json), not from the shared registry, so a typo in
// `IPC` is caught here too (main's side: updates-ipc.test.ts). Same capture trick as preload-skills.test.ts.

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

import type { PreloadApi } from '../../src/preload/index'
import { DESKTOP_ROOT } from '../helpers/repo-files'

const F14 = JSON.parse(
  readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'updates', 'import', 'f14-locked-channels.json'), 'utf8')
) as { pr6a: string[] }

/** F-14's channel for one of the four methods (record §3.5 "The list (PR-6a)"). */
function golden(name: string): string {
  const channel = F14.pr6a.find((c) => c === `updates:${name}`)
  if (channel === undefined) throw new Error(`updates:${name} is not in F-14's list`)
  return channel
}

async function loadApi(): Promise<PreloadApi> {
  await import('../../src/preload/index')
  return bridge.api as PreloadApi
}

beforeEach(() => {
  vi.clearAllMocks()
})

const rows: Array<[keyof PreloadApi, string, unknown[]]> = [
  ['updatesImportFile', golden('importFile'), [{ confirmToken: 'a-token' }]],
  ['updatesStatus', golden('status'), []],
  ['updatesCancel', golden('cancel'), []],
  ['updatesDiscardStaged', golden('discardStaged'), [{ version: '1.2.0' }]]
]

describe('preload: the update channels callable while locked (F-14, T6.3)', () => {
  it.each(rows)('%s invokes its own channel with exactly its argument, untouched', async (method, channel, args) => {
    const api = await loadApi()
    await (api[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke.mock.calls[0]).toEqual([channel, ...args])
    // By identity: the binding neither copies nor rebuilds what the renderer handed it.
    args.forEach((arg, i) => expect((ipc.invoke.mock.calls[0] as unknown[])[i + 1]).toBe(arg))
  })

  it('updatesImportFile with no argument invokes its channel with none (the call that opens main\u{2019}s file dialog)', async () => {
    const api = await loadApi()
    await api.updatesImportFile()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke.mock.calls[0]).toEqual([golden('importFile'), undefined])
  })
})
