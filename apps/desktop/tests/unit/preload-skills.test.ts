import { describe, it, expect, vi, beforeEach } from 'vitest'

// Preload-surface test for the skills bridge (#583): every skills method must reach its own
// IPC channel with exactly its own arguments. `PreloadApi` is derived from the object literal,
// so TypeScript catches neither a channel swap nor a dropped optional argument, and the
// renderer tests fake `window.api` while the integration tests call handlers by channel.
// Same capture trick as preload-ocr-install.test.ts.

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

const runRequest = {
  skillInstallId: 'user:sentinel-skill',
  toolName: 'sentinel_tool',
  conversationId: 'sentinel-conv'
}

const rows: Array<[keyof PreloadApi, string, unknown[]]> = [
  ['listSkills', IPC.listSkills, []],
  ['getSkill', IPC.getSkill, ['user:get-1']],
  ['pickSkillPackage', IPC.pickSkillPackage, ['folder']],
  ['previewSkillPackage', IPC.previewSkillPackage, ['token-preview']],
  ['importSkill', IPC.importSkill, ['token-import']],
  ['exportSkill', IPC.exportSkill, ['user:export-1']],
  ['deleteSkill', IPC.deleteSkill, ['user:delete-1']],
  ['enableSkill', IPC.enableSkill, ['user:enable-1']],
  ['disableSkill', IPC.disableSkill, ['user:disable-1']],
  ['acknowledgeSkillWarning', IPC.acknowledgeSkillWarning, ['user:ack-1']],
  ['getSkillReconcileStatus', IPC.skillReconcileStatus, []],
  ['suggestSkills', IPC.suggestSkills, ['c1', 'draft text']],
  ['listRunnableTools', IPC.listRunnableTools, ['user:tools-1', 'c-tools']],
  ['startSkillRun', IPC.startSkillRun, [runRequest]],
  ['getSkillRun', IPC.getSkillRun, ['run-get']],
  ['listSkillRuns', IPC.listSkillRuns, []],
  ['cancelSkillRun', IPC.cancelSkillRun, ['run-cancel']],
  ['clearSkillRun', IPC.clearSkillRun, ['run-clear']],
  ['setConversationDefaultSkill', IPC.setConversationDefaultSkill, ['c-default', 'user:default-1']]
]

describe('preload — skills surface (#583)', () => {
  it.each(rows)('%s invokes its own channel with exactly its arguments', async (method, channel, args) => {
    const api = await loadApi()
    await (api[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).toHaveBeenCalledWith(channel, ...args)
    expect(ipc.invoke.mock.calls[0]).toHaveLength(1 + args.length)
  })
})
