import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// IPC-layer tests for registerChatIpc — the handler glue that the service-level chat
// tests don't reach: the in-flight concurrency guard (H3), the abort→done streaming
// mapping (C1), the regenerate-with-nothing guard, and the no-runtime/empty-message
// errors. Only the Electron IPC transport is faked (see tests/helpers/ipc.ts); the real
// chat service + a real temp DB run underneath.

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
import { createConversation, listConversations, listMessages, appendMessage } from '../../src/main/services/chat'
import type { ModelRuntime, RuntimeChatOptions, ChatMessage } from '../../src/main/services/runtime'
import type { AppContext } from '../../src/main/services/context'
import { invoke, invokeWithEvent, makeEvent, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

/** A runtime whose chatStream parks on a released-by-the-test promise, so a stream can be
 *  held open while a second request races it. */
function gatedRuntime(): { runtime: ModelRuntime; release: () => void; started: Promise<void> } {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let signalStarted!: () => void
  const started = new Promise<void>((r) => (signalStarted = r))
  const runtime: ModelRuntime = {
    modelId: 'gated',
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: 1 }),
    async *chatStream(_m: ChatMessage[], opts?: RuntimeChatOptions) {
      yield 'first '
      signalStarted()
      await gate
      if (opts?.signal?.aborted) return
      yield 'second'
    }
  }
  return { runtime, release, started }
}

function makeCtx(db: Db, runtime: ModelRuntime | null): AppContext {
  return {
    db,
    runtime: { active: () => runtime, activeModelId: () => runtime?.modelId ?? null }
  } as unknown as AppContext
}

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-chatipc-')), 'test.sqlite'))
}

beforeEach(() => {
  ipcState.handlers.clear()
  inFlightStreams.clear()
})

describe('registerChatIpc', () => {
  it('throws a clear error when no model runtime is active', async () => {
    const db = freshDb()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, null))
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, 'hi')).rejects.toThrow(/No AI model is running/)
  })

  it('rejects an empty message and an unknown conversation', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, '   ')).rejects.toThrow(/empty message/)
    await expect(invoke(handlers, IPC.sendChatMessage, 'nope', 'hi')).rejects.toThrow(/Unknown conversation/)
  })

  it('streams tokens over the per-conversation channel and resolves with the persisted reply', async () => {
    const db = freshDb()
    const { runtime, release } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const p = invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi') as Promise<unknown>
    release()
    const msg = (await p) as { role: string; content: string }

    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('first second')
    // A token channel carried the deltas and a done channel carried the final message.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.token(conv.id), 'first ')
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.done(conv.id), expect.objectContaining({ role: 'assistant' }))
    // The user turn + the assistant reply are persisted; nothing left in the in-flight map.
    expect(listMessages(db, conv.id).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })

  it('rejects a second concurrent stream on the same conversation without clobbering the first (H3)', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    // First stream is parked mid-generation (its controller is in the in-flight map).
    const first = invoke(handlers, IPC.sendChatMessage, conv.id, 'one')
    await started
    expect(inFlightStreams.has(conv.id)).toBe(true)
    const firstController = inFlightStreams.get(conv.id)

    // A second concurrent send for the same conversation is refused…
    await expect(invoke(handlers, IPC.sendChatMessage, conv.id, 'two')).rejects.toThrow(/already being generated/)
    // …and it did NOT overwrite the first stream's canceller.
    expect(inFlightStreams.get(conv.id)).toBe(firstController)

    release()
    await first
    // Only ONE assistant reply exists; the transcript is not corrupted by interleaving.
    expect(listMessages(db, conv.id).filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(inFlightStreams.has(conv.id)).toBe(false)
  })

  it('stopGeneration aborts the stream and the invoke resolves via done, not error (C1)', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const p = invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi') as Promise<unknown>
    await started
    invokeWithEvent(handlers, IPC.stopGeneration, makeEvent(), conv.id)
    release()
    const msg = (await p) as { content: string }

    // Aborted after the first token → partial persisted, resolves normally.
    expect(msg.content).toBe('first ')
    const channels = event.sender.send.mock.calls.map((c) => String(c[0]))
    expect(channels).toContain(STREAM.done(conv.id))
    expect(channels).not.toContain(STREAM.error(conv.id))
  })

  it('refuses to regenerate when there is no prior assistant message', async () => {
    const db = freshDb()
    const { runtime } = gatedRuntime()
    const conv = createConversation(db, {})
    appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
    registerChatIpc(makeCtx(db, runtime))
    await expect(
      invoke(handlers, IPC.sendChatMessage, conv.id, '', { regenerate: true })
    ).rejects.toThrow(/Nothing to regenerate/)
  })

  it('deletes a conversation and its messages (chat and documents mode alike)', async () => {
    const db = freshDb()
    registerChatIpc(makeCtx(db, null))
    const chat = createConversation(db, {})
    const docs = createConversation(db, { mode: 'documents' })
    appendMessage(db, { conversationId: chat.id, role: 'user', content: 'hi' })
    appendMessage(db, { conversationId: chat.id, role: 'assistant', content: 'hello' })
    appendMessage(db, { conversationId: docs.id, role: 'user', content: 'what does it say?' })

    await invoke(handlers, IPC.deleteConversation, chat.id)
    expect(listConversations(db).map((c) => c.id)).toEqual([docs.id])
    expect(listMessages(db, chat.id)).toHaveLength(0)
    // The other conversation is untouched.
    expect(listMessages(db, docs.id)).toHaveLength(1)

    await invoke(handlers, IPC.deleteConversation, docs.id)
    expect(listConversations(db)).toHaveLength(0)
  })

  it('refuses to delete a conversation while a response is streaming into it', async () => {
    const db = freshDb()
    const { runtime, release, started } = gatedRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const p = invoke(handlers, IPC.sendChatMessage, conv.id, 'hi')
    await started
    await expect(invoke(handlers, IPC.deleteConversation, conv.id)).rejects.toThrow(
      /still being generated/
    )
    release()
    await p
    // After the stream finishes the delete goes through.
    await invoke(handlers, IPC.deleteConversation, conv.id)
    expect(listConversations(db)).toHaveLength(0)
  })

  // ---- "Ask selected documents" scope (Phase 17, plan §5.3) ----------------------

  it('createConversation accepts a documents scope and updateConversationScope edits it', async () => {
    const db = freshDb()
    registerChatIpc(makeCtx(db, null))

    const conv = (
      await invoke(handlers, IPC.createConversation, {
        mode: 'documents',
        scopeDocumentIds: ['d1', 'd2']
      })
    ).result as { id: string; scopeDocumentIds: string[] | null }
    expect(conv.scopeDocumentIds).toEqual(['d1', 'd2'])

    // Chip removal: replace with a subset, then clear back to the whole corpus.
    const narrowed = (await invoke(handlers, IPC.updateConversationScope, conv.id, ['d2'])).result as {
      scopeDocumentIds: string[] | null
    }
    expect(narrowed.scopeDocumentIds).toEqual(['d2'])
    const cleared = (await invoke(handlers, IPC.updateConversationScope, conv.id, null)).result as {
      scopeDocumentIds: string[] | null
    }
    expect(cleared.scopeDocumentIds).toBeNull()
    expect(listConversations(db)[0].scopeDocumentIds).toBeNull()

    await expect(invoke(handlers, IPC.updateConversationScope, 'nope', ['d1'])).rejects.toThrow(
      /Unknown conversation/
    )
  })

  // ---- Answer-depth modes (Phase 20, architecture.md "Chat & streaming") ------------------------------------

  /** A runtime that records chatStream options and emits reasoning then answer text. */
  function depthRuntime(): { runtime: ModelRuntime; seen: { options?: RuntimeChatOptions } } {
    const seen: { options?: RuntimeChatOptions } = {}
    const runtime: ModelRuntime = {
      modelId: 'depth',
      start: async () => {},
      stop: async () => {},
      health: async () => ({ healthy: true, message: 'ok', port: 1 }),
      async *chatStream(_m: ChatMessage[], options?: RuntimeChatOptions) {
        seen.options = options
        options?.onReasoning?.('pondering ')
        options?.onReasoning?.('deeply')
        yield '<think>leaked inline reasoning</think>'
        yield 'The answer.'
      }
    }
    return { runtime, seen }
  }

  it('forwards the mode and streams reasoning on chat:reasoning:<id>, never on the token channel', async () => {
    const db = freshDb()
    const { runtime, seen } = depthRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    const event = makeEvent()
    const msg = (await invokeWithEvent(handlers, IPC.sendChatMessage, event, conv.id, 'hi', {
      mode: 'deep'
    })) as { content: string }

    expect(seen.options?.mode).toBe('deep')
    // Reasoning deltas travel ONLY on the additive reasoning channel; the locked
    // Phase-3 token channel carries answer tokens only.
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.reasoning(conv.id), 'pondering ')
    expect(event.sender.send).toHaveBeenCalledWith(STREAM.reasoning(conv.id), 'deeply')
    const tokenPayloads = event.sender.send.mock.calls
      .filter((c) => String(c[0]) === STREAM.token(conv.id))
      .map((c) => String(c[1]))
    expect(tokenPayloads.join('')).not.toContain('pondering')
    // The persisted reply is stripped of any inline think block (D6).
    expect(msg.content).toBe('The answer.')
    expect(listMessages(db, conv.id).at(-1)?.content).toBe('The answer.')
  })

  it('degrades a junk mode from a non-UI caller to the balanced default', async () => {
    const db = freshDb()
    const { runtime, seen } = depthRuntime()
    const conv = createConversation(db, {})
    registerChatIpc(makeCtx(db, runtime))

    await invoke(handlers, IPC.sendChatMessage, conv.id, 'hi', { mode: 'TURBO' })
    expect(seen.options?.mode).toBeUndefined()
  })
})
