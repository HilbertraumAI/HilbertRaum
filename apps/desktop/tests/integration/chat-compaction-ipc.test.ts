import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer test for the STREAM.compaction notice (context-compaction plan §5.2): the one-shot
// ephemeral "summarizing…" event must fire EXACTLY once, only when the compaction pre-pass actually
// summarizes for the turn — wired through `withChatStream`'s `sendCompaction` notifier. Only the
// Electron IPC transport is faked (tests/helpers/ipc.ts); the real chat service + a temp DB run
// underneath.

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
import { openDatabase, type Db } from '../../src/main/services/db'
import { appendMessage, createConversation } from '../../src/main/services/chat'
import { selfSummaryPrompt } from '../../src/main/services/chat/compaction'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A runtime with a small window that summarizes on the §4.8 prompt and otherwise answers. */
function compactingRuntime(window: number): ModelRuntime {
  return {
    modelId: 'rt',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    contextWindow: () => window,
    async *chatStream(messages: ChatMessage[], _options?: RuntimeChatOptions) {
      if (messages[0]?.content === selfSummaryPrompt) {
        yield 'Goal: testing. Facts: value 42.'
        return
      }
      yield 'answer'
    }
  }
}

function makeCtx(db: Db, runtime: ModelRuntime): AppContext {
  return {
    db,
    workspace: { isUnlocked: () => true },
    runtime: { active: () => runtime, activeModelId: () => runtime.modelId }
  } as unknown as AppContext
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-compaction-ipc-')), 'test.sqlite'))
}

const words = (n: number): string => Array(n).fill('word').join(' ')

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('registerChatIpc — STREAM.compaction notice (§5.2)', () => {
  it('fires the compaction notice exactly once when a turn summarizes', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    // A long history (14 turns × 90 words) over 0.85 × 2000, with ≥6 compactable turns.
    for (let i = 0; i < 14; i++) {
      appendMessage(db, { conversationId: conv.id, role: i % 2 === 0 ? 'user' : 'assistant', content: words(90) })
    }
    registerChatIpc(makeCtx(db, compactingRuntime(2000)))

    const { event } = await invoke(handlers, IPC.sendChatMessage, conv.id, 'the next question')

    const compactionSends = event.sender.send.mock.calls.filter(
      (c) => c[0] === STREAM.compaction(conv.id)
    )
    expect(compactionSends).toHaveLength(1)
    expect(compactionSends[0][1]).toEqual({ phase: 'start' })
  })

  it('does NOT fire the compaction notice on a short conversation (below threshold)', async () => {
    const db = freshDb()
    const conv = createConversation(db, { modelId: 'm' })
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(makeCtx(db, compactingRuntime(8000)))

    const { event } = await invoke(handlers, IPC.sendChatMessage, conv.id, 'another short one')

    const compactionSends = event.sender.send.mock.calls.filter(
      (c) => c[0] === STREAM.compaction(conv.id)
    )
    expect(compactionSends).toHaveLength(0)
  })
})
