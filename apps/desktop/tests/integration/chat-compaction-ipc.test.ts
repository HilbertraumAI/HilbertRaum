import { describe, it, expect, vi, beforeEach } from 'vitest'

// IPC-layer test for the STREAM.compaction notice (context-compaction plan §5.2): the one-shot
// ephemeral "summarizing…" event must fire EXACTLY once, only when the compaction pre-pass actually
// summarizes for the turn — wired through `withChatStream`'s `sendCompaction` notifier. Its sibling,
// the STREAM.usage meter reading, is pinned here too (#737), and so is the resting meter read's window with no
// model running (#779). Only the Electron IPC transport is faked (tests/helpers/ipc.ts); the real chat service + a
// temp DB run underneath.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { registerChatIpc } from '../../src/main/ipc/registerChatIpc'
import { inFlightStreams } from '../../src/main/ipc/inflight'
import { IPC, STREAM } from '../../src/shared/ipc'
import type { Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { updateSettings } from '../../src/main/services/settings'
import type { ModelRuntime } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import { ANY_SENDER, invoke, type IpcHandlers } from '../helpers/ipc'
import { openFreshDb } from '../helpers/db-fixtures'
import { appendTurns, compactionRuntime } from '../helpers/compaction-fixtures'
import { manifestsDirWith, rawManifest } from '../helpers/manifest-fixtures'

const handlers = ipcState.handlers as unknown as IpcHandlers

function makeCtx(db: Db, runtime: ModelRuntime | null, manifestsDir: string | null = null): AppContext {
  return {
    trustedSenders: ANY_SENDER,
    db,
    manifestsDir,
    workspace: { isUnlocked: () => true },
    runtime: { active: () => runtime, activeModelId: () => runtime?.modelId ?? null }
  } as unknown as AppContext
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('registerChatIpc — STREAM.compaction notice (§5.2)', () => {
  it('fires the compaction notice exactly once when a turn summarizes', async () => {
    const db = openFreshDb('compaction-ipc')
    const conv = createConversation(db, { modelId: 'm' })
    // A long history (14 turns × 90 words) over 0.85 × 2000, with ≥6 compactable turns.
    appendTurns(db, conv.id, 14, 90)
    registerChatIpc(makeCtx(db, compactionRuntime({ window: 2000 })))

    const { event } = await invoke(handlers, IPC.sendChatMessage, conv.id, 'the next question')

    const compactionSends = event.sender.send.mock.calls.filter(
      (c) => c[0] === STREAM.compaction(conv.id)
    )
    expect(compactionSends).toHaveLength(1)
    expect(compactionSends[0][1]).toEqual({ phase: 'start' })
  })

  it('does NOT fire the compaction notice on a short conversation (below threshold)', async () => {
    const db = openFreshDb('compaction-ipc')
    const conv = createConversation(db, { modelId: 'm' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(makeCtx(db, compactionRuntime({ window: 8000 })))

    const { event } = await invoke(handlers, IPC.sendChatMessage, conv.id, 'another short one')

    const compactionSends = event.sender.send.mock.calls.filter(
      (c) => c[0] === STREAM.compaction(conv.id)
    )
    expect(compactionSends).toHaveLength(0)
  })
})

// #737: the live meter's reading of the turn's real assembled prompt rides the sibling one-shot notice,
// `chat:usage` — wired through `withChatStream`'s `sendUsage` — once per turn, before the answer streams.
describe('registerChatIpc — STREAM.usage meter reading (§5.1)', () => {
  it('sends the assembled-prompt usage exactly once, before the first token (#737)', async () => {
    const db = openFreshDb('compaction-ipc')
    const conv = createConversation(db, { modelId: 'm' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(makeCtx(db, compactionRuntime({ window: 8000 })))

    const { event } = await invoke(handlers, IPC.sendChatMessage, conv.id, 'another short one')

    const channels = event.sender.send.mock.calls.map((c) => c[0])
    const usageSends = event.sender.send.mock.calls.filter((c) => c[0] === STREAM.usage(conv.id))
    expect(usageSends).toHaveLength(1)
    expect(usageSends[0][1]).toMatchObject({ window: 8000 }) // the launched window
    expect(usageSends[0][1].usedTokens).toBeGreaterThan(0)
    expect(channels.indexOf(STREAM.token(conv.id))).toBeGreaterThan(channels.indexOf(STREAM.usage(conv.id)))
  })
})

// #779: the resting read (`getConversationContextUsage`) with no model running reaches the manifests through the
// handler's context, so the meter shows the window the next start launches with. The window rule itself is owned by
// chat-compaction-ux.test.ts; this row pins the wiring.
describe('registerChatIpc — the resting meter read (§5.1)', () => {
  it("with no model running, reads the active model's recommended window (#779)", async () => {
    const db = openFreshDb('compaction-ipc')
    const manifestsDir = manifestsDirWith(rawManifest({ id: 'recommends-16k', recommended_context_tokens: 16384 }))
    updateSettings(db, { activeModelId: 'recommends-16k' })
    const conv = createConversation(db, { modelId: 'm' })
    registerChatIpc(makeCtx(db, null, manifestsDir))

    const { result } = await invoke(handlers, IPC.getConversationContextUsage, conv.id)

    expect(result).toMatchObject({ window: 16384 })
  })
})
